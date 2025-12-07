// routes-wf.js - WF Relay 父子页面通信相关 API
'use strict';

const express = require('express');
const {
  BODY_LIMIT,
  WF_PIN_FOCUS_THROTTLE_MS,
} = require('../server-js/wf-server-config.js');
const { wfStore, wfGc, wfCORS } = require('./wf-store');
const { db, slotUpsert, slotSetState, slotTouchHB, slotGetByToken } = require('./db');
const { assertAuth, verifyCSRF } = require('./security');
const { sseBroadcast } = require('./sse');

function registerWfRoutes(app) {
  // 父页：提交 payload
  app.post('/api/wf/put', verifyCSRF, assertAuth, (req, res) => {
    const uid = req.session.uid;
    const { token, text } = req.body || {};
    if (!token || typeof text !== 'string') {
      return res.status(400).json({ ok: false, error: 'BAD_REQUEST' });
    }

    console.log('[wf.put]', { uid, token, chars: text.length, bytes: Buffer.byteLength(text, 'utf8') });

    wfStore.set(String(token), {
      uid,
      textIn: String(text),
      textOut: '',
      state: 'waiting',
      ts: Date.now(),
      openedAt: null,
    });

    try {
      slotUpsert({
        token: String(token),
        userId: uid,
        termId: req.body?.termId || null,
        title: req.body?.title || '',
        textIn: String(text),
      });
      slotSetState(String(token), { status: 'waiting' });
      db.prepare('UPDATE wf_slots SET pinned=0 WHERE user_id=?').run(uid);
      db.prepare('UPDATE wf_slots SET pinned=1, updated_at=CURRENT_TIMESTAMP WHERE token=? AND user_id=?')
        .run(String(token), uid);
    } catch (e) {
      console.warn('[wf.put] slot upsert failed:', e);
    }

    wfGc();
    res.json({ ok: true });
    try { sseBroadcast(uid, 'slots_changed', { token: String(token) }); } catch (_) {}
  });

  // 子页：领取 payload
  app.get('/api/wf/get', wfCORS, (req, res) => {
    const token = String(req.query.token || '');
    let it = wfStore.get(token);

    if (!it) {
      try {
        const row = slotGetByToken(token);
        if (row) {
          const terminal = (row.status === 'done' || row.status === 'error');
          if (terminal) {
            return res.status(410).json({ ok: false, error: 'ALREADY_FINISHED' });
          }
          if (row.text_in && row.user_id) {
            it = {
              uid: row.user_id,
              textIn: String(row.text_in || ''),
              textOut: String(row.text_out || ''),
              state: row.status || 'waiting',
              ts: Date.now(),
              openedAt: null,
            };
            wfStore.set(token, it);
          }
        }
      } catch (_) { }
    }

    if (!it) {
      return res.status(404).json({ ok: false, error: 'NO_TASK' });
    }

    it.state = 'picked';
    it.ts = Date.now();
    if (!it.openedAt) it.openedAt = Date.now();
    try { slotSetState(token, { status: 'picked' }); } catch { }
    try {
      db.prepare(`
        UPDATE wf_slots
        SET opened_at = COALESCE(opened_at, CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP
        WHERE token=?`).run(token);
    } catch (_) { }
    res.json({ ok: true, text: it.textIn || '' });
  });

  // 子页：结果 / 心跳
  app.post('/api/wf/done', wfCORS, express.json({ limit: BODY_LIMIT }), (req, res) => {
    const { token, text, state } = req.body || {};
    const lowText = String(text || '').toLowerCase();
    const isHB = ((state === 'picked' || state === 'running') && lowText === 'hb');
    const t = String(token || '');

    const hbMode = String(req.body?.hb_mode || '').toLowerCase();
    const sid = String(req.body?.sid || '');
    const seq = Number(req.body?.seq || 0);

    let it = wfStore.get(t);
    if (!it && isHB) {
      let rttMs = null;
      const clientTs = Number(req.body?.client_ts ?? req.body?.sent_at ?? req.body?.t);
      if (Number.isFinite(clientTs)) {
        const now = Date.now();
        const diff = now - clientTs;
        if (diff >= 0 && diff < 120000) rttMs = diff;
      }
      if (hbMode === 'tick') {
        try { slotTouchHB(t, { rttMs }); } catch (_) { }
      }
      let row = null; try { row = slotGetByToken(t); } catch (_) { }
      const terminal = !!row && (row.status === 'done' || row.status === 'error');
      return res.json({ ok: true, status: row?.status || 'running', hb: true, final: terminal, closeRequested: terminal });
    }

    if (isHB && hbMode === 'tick' && it) {
      if (sid) {
        if (!it.sid) it.sid = sid;
        if (it.sid !== sid || (it.lastSeq && seq <= it.lastSeq)) {
          const row = (() => { try { return slotGetByToken(t); } catch (_) { return null; } })();
          const terminal = !!row && (row.status === 'done' || row.status === 'error');
          return res.json({
            ok: true,
            status: row?.status || it.state || 'running',
            hb: true,
            final: terminal,
            closeRequested: terminal,
          });
        }
        it.lastSeq = seq;
      }
    }

    if (isHB) {
      let rttMs = null;
      const clientTs = Number(req.body?.client_ts ?? req.body?.sent_at ?? req.body?.t);
      if (Number.isFinite(clientTs)) {
        const now = Date.now();
        const diff = now - clientTs;
        if (diff >= 0 && diff < 120000) rttMs = diff;
      }

      if (hbMode === 'tick') {
        try { slotTouchHB(t, { rttMs }); } catch (e) { console.warn('[wf.done][hb] slotTouchHB failed:', e); }
        try { it.ts = Date.now(); } catch (_) { }
      }

      let currentStatus = it?.state || 'running';
      let terminal = false;
      try {
        const row = slotGetByToken(t);
        if (row?.status) {
          currentStatus = row.status;
          terminal = (row.status === 'done' || row.status === 'error');
        }
      } catch { }

      const flags = {};
      if (it?.kill) flags.closeRequested = true;
      if (it?.poke === 'focus') {
        try {
          const row2 = slotGetByToken(t);
          if (!terminal && row2?.pinned) {
            const now = Date.now();
            const thr = WF_PIN_FOCUS_THROTTLE_MS;
            if (!it._lastFocusAt || (now - it._lastFocusAt) >= thr) {
              flags.focusRequested = true;
              it._lastFocusAt = now;
            }
          }
        } catch { }
      }
      if (terminal) flags.closeRequested = true;

      if (hbMode === 'tick') {
        it.hb_last_at = Date.now();
        if (rttMs != null) it.hb_rtt_ms = rttMs;
      }

      return res.json({ ok: true, status: currentStatus, hb: true, final: terminal, ...flags });
    }

    if ((state === 'picked' || state === 'running') && String(text || '').toLowerCase() === 'child-opened') {
      try {
        db.prepare(`
          UPDATE wf_slots 
          SET opened_at = COALESCE(opened_at, CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP 
          WHERE token=?`).run(t);
      } catch (_) { }
    }

    const allowed = new Set(['picked', 'running', 'retrying', 'done', 'error']);
    if (!allowed.has(state)) {
      return res.status(400).json({ ok: false, error: 'BAD_STATE' });
    }

    let row = null;
    try { row = slotGetByToken(t); } catch { }
    const terminalSet = new Set(['done', 'error']);
    if (row && terminalSet.has(row.status) && !terminalSet.has(state)) {
      it.ts = Date.now();
      return res.json({ ok: true, ignored: true, status: row.status });
    }

    if (row && row.status === 'done') {
      if (state === 'error') {
        console.warn('[wf.done] ignore error-after-done', t);
        it.ts = Date.now();
        return res.json({ ok: true, ignored: 'error-after-done', status: 'done' });
      }
      if (state === 'done') {
        if (typeof text === 'string' && text.length > (row.text_out?.length || 0)) {
          try { slotSetState(t, { status: 'done', textOut: text }); } catch (e) { }
          it.textOut = text;
        }
        it.state = 'done';
        it.ts = Date.now();
        return res.json({ ok: true, idempotent: true, status: 'done' });
      }
    }

    const p = Number.isFinite(req.body?.progress)
      ? Math.max(0, Math.min(100, Math.round(Number(req.body.progress))))
      : null;

    const reason = (typeof text === 'string' ? text : '');
    let errorMsg = null;

    if (state === 'retrying' || state === 'error') {
      errorMsg = reason.slice(0, 1000);
    } else if (state === 'done') {
      errorMsg = '';
    }

    const update = {
      status: state,
      textOut: (state === 'done' || state === 'error') ? reason : null,
      errorMsg,
      incTry: (state === 'retrying'),
      progress: (state === 'done') ? 100 : p,
    };

    try { slotSetState(t, update); } catch (e) {
      console.warn('[wf.done] slot set state failed:', e);
    }

    if (state === 'done' || state === 'error') it.textOut = String(text || '');
    it.state = state;
    it.ts = Date.now();

    console.log('[wf.done]', { token: t, state, outChars: (text || '').length });
    const isTerminal = (state === 'done' || state === 'error');
    if (isTerminal) it.kill = true;
    res.json({ ok: true, status: state, final: isTerminal, closeRequested: isTerminal });
  });

  // 父页：对子页下发一次性指令
  app.post('/api/wf/poke', verifyCSRF, assertAuth, (req, res) => {
    const uid = req.session.uid;
    const { token, action } = req.body || {};
    const t = String(token || '');
    if (!t) return res.status(400).json({ ok: false, error: 'BAD_REQUEST' });

    const it = wfStore.get(t);
    if (!it) return res.status(404).json({ ok: false, error: 'NO_TASK' });
    if (it.uid !== uid) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

    if (action === 'focus') {
      it.poke = 'focus';
    } else if (action === 'close') {
      it.kill = true;
      try {
        const row = slotGetByToken(t);
        if (!row || (row.status !== 'done' && row.status !== 'error')) {
          slotSetState(t, { status: 'error', errorMsg: 'closed-by-user' });
        }
      } catch { }
    } else {
      return res.status(400).json({ ok: false, error: 'BAD_ACTION' });
    }
    it.ts = Date.now();
    return res.json({ ok: true });
  });

  // 父页：查状态
  app.get('/api/wf/state', assertAuth, (req, res) => {
    const uid = req.session.uid;
    const token = String(req.query.token || '');
    const it = wfStore.get(token);

    if (!it) return res.json({ ok: true, state: 'waiting' });
    if (it.uid !== uid) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

    res.json({ ok: true, state: it.state || 'waiting' });
  });

  // 父页：取结果
  app.get('/api/wf/result', assertAuth, (req, res) => {
    const uid = req.session.uid;
    const token = String(req.query.token || '');
    const it = wfStore.get(token);

    if (!it) return res.status(404).json({ ok: false, error: 'NO_TASK' });
    if (it.uid !== uid) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

    res.json({ ok: true, text: it.textOut || '' });
  });
}

module.exports = {
  registerWfRoutes,
};
