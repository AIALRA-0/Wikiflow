// wf-store.js - WF Relay 内存任务存储与轮转调度 & CORS
'use strict';

const {
  WF_ALLOWED_ORIGINS,
  WF_IDLE_TTL_MS,
  WF_MAX_TTL_MS,
  WF_ROTATE,
  WF_ROTATE_INTERVAL_MS,
} = require('../server-js/wf-server-config.js');
const { db } = require('./db');

const wfStore = new Map(); // token -> { uid, textIn, textOut, state, ts }

function wfGc() {
  const now = Date.now();
  for (const [k, v] of wfStore) {
    const lastActive = Math.max(
      Number(v.hb_last_at || 0),
      Number(v.openedAt || 0),
      Number(v.ts || 0),
    );
    const idleAged = lastActive && (now - lastActive > WF_IDLE_TTL_MS);
    const hardAged = (v.ts) && (now - v.ts > WF_MAX_TTL_MS);
    const terminal = v.state === 'done' || v.state === 'error';
    if (terminal || idleAged || hardAged) {
      wfStore.delete(k);
    }
  }
}
setInterval(wfGc, 60 * 1000);

// === 轮次置顶（后端调度） ===
const rrCursor = new Map(); // userId -> 索引

if (WF_ROTATE) {
  setInterval(() => {
    try {
      const users = db.prepare(`
        SELECT DISTINCT user_id FROM wf_slots
        WHERE pinned=1 AND status IN ('picked','running')
      `).all().map(r => r.user_id);
      for (const uid of users) {
        const rows = db.prepare(`
          SELECT token FROM wf_slots
          WHERE user_id=? AND pinned=1 AND status IN ('picked','running')
          ORDER BY updated_at DESC
        `).all(uid);
        if (!rows.length) continue;
        const idx = rrCursor.get(uid) ?? 0;
        const next = rows[idx % rows.length]?.token;
        rrCursor.set(uid, (idx + 1) % rows.length);
        const it = wfStore.get(String(next));
        if (it) it.poke = 'focus';
      }
    } catch (_) { }
  }, WF_ROTATE_INTERVAL_MS);
}

// 仅 /api/wf/* 放开的 CORS（子页在 chatgpt.com 上跨域 fetch 用）
function wfCORS(req, res, next) {
  const origin = req.get('Origin');
  if (origin && WF_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

module.exports = {
  wfStore,
  wfGc,
  wfCORS,
};
