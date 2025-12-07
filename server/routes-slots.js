// routes-slots.js - 生成队列 slots 列表、置顶与清理相关 API
'use strict';

const { db, slotListByUser, slotGetByToken, slotDelete } = require('./db');
const { assertAuth, verifyCSRF } = require('./security');
const { wfStore } = require('./wf-store');
const { sseBroadcast } = require('./sse');

function registerSlotRoutes(app) {
  // 列出当前用户的 slots
  app.get('/api/slots', assertAuth, (req, res) => {
    const uid = req.session.uid;
    const rows = slotListByUser(uid);
    const now = Date.now();

    const items = rows.map(r => {
      const terminal = (r.status === 'done' || r.status === 'error');

      const hbTs = r.hb_last_at ? (Date.parse(r.hb_last_at) || null) : null;
      const openedTs = r.opened_at ? (Date.parse(r.opened_at) || null) : null;
      const endedTs = terminal ? (Date.parse(r.updated_at) || null) : null;

      const hb_age_ms = (terminal || !hbTs) ? null : Math.max(0, now - hbTs);

      let runtime_ms = null;
      if (openedTs) {
        const endPoint = (terminal && endedTs) ? endedTs : now;
        runtime_ms = Math.max(0, endPoint - openedTs);
      }

      return Object.assign({}, r, {
        hb_age_ms,
        opened_at: r.opened_at,
        open_age_ms: runtime_ms,
        runtime_ms,
        ended_at: terminal ? r.updated_at : null,
        terminal,
      });
    });

    res.json({ ok: true, items });
  });

  // 置顶 / 取消置顶某个 slot
  app.post('/api/slots/pin', verifyCSRF, assertAuth, (req, res) => {
    const uid = req.session.uid;
    const { token, pinned } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: 'BAD_REQUEST' });

    const row = db.prepare('SELECT user_id FROM wf_slots WHERE token=?').get(String(token));
    if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    if (row.user_id !== uid) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

    if (pinned) {
      db.prepare('UPDATE wf_slots SET pinned=0 WHERE user_id=?').run(uid);
      db.prepare('UPDATE wf_slots SET pinned=1, updated_at=CURRENT_TIMESTAMP WHERE token=? AND user_id=?')
        .run(String(token), uid);
      const it = wfStore.get(String(token));
      if (it) it.poke = 'focus';
    } else {
      db.prepare('UPDATE wf_slots SET pinned=0, updated_at=CURRENT_TIMESTAMP WHERE token=? AND user_id=?')
        .run(String(token), uid);
    }
    res.json({ ok: true });
    try { sseBroadcast(uid, 'slots_changed', { token: String(token), pinned: !!pinned }); } catch (_) {}
  });

  // 读取单个 slot 详情
  app.get('/api/slots/:token', assertAuth, (req, res) => {
    const uid = req.session.uid;
    const t = String(req.params.token || '');
    const row = slotGetByToken(t);
    if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    if (row.user_id !== uid) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    return res.json({ ok: true, slot: row });
  });

  // 高速清理 slots
  app.post('/api/slots/clear', verifyCSRF, assertAuth, (req, res) => {
    const uid = req.session.uid;
    const scope = String(req.body?.scope || 'done');

    let cond = '';
    if (scope === 'done') {
      cond = "status IN ('done','error')";
    } else if (scope === 'all') {
      cond = "status NOT IN ('picked','running')";
    } else if (scope === 'others') {
      cond = "NOT (pinned=1 OR status IN ('picked','running'))";
    } else if (scope === 'nonactive') {
      cond = "status NOT IN ('picked','running')";
    } else {
      return res.status(400).json({ ok: false, error: 'BAD_SCOPE' });
    }

    const toDel = db.prepare(
      `SELECT token FROM wf_slots WHERE user_id=? AND ${cond}`
    ).all(uid).map(r => String(r.token));

    if (toDel.length) {
      const tx = db.transaction((ids) => {
        const mark = db.prepare('DELETE FROM wf_slots WHERE user_id=? AND token=?');
        for (const t of ids) mark.run(uid, t);
      });
      tx(toDel);
    }

    for (const t of toDel) {
      const it = wfStore.get(t);
      if (it && it.uid === uid) {
        it.kill = true;
        it.state = 'error';
        it.textOut = 'deleted-by-user';
        it.ts = Date.now();
      }
    }
    res.json({ ok: true, deleted: toDel.length });
    try { sseBroadcast(uid, 'slots_changed', { scope, deleted: toDel.length }); } catch (_) {}
  });

  // 删除单个 slot（提交成功后调用）
  app.delete('/api/slots/:token', verifyCSRF, assertAuth, (req, res) => {
    const uid = req.session.uid;
    slotDelete(String(req.params.token || ''), uid);
    res.json({ ok: true });
  });
}

module.exports = {
  registerSlotRoutes,
};
