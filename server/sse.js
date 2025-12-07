// sse.js - 负责 per-user slots 变化的 SSE 推送
'use strict';

const { assertAuth } = require('./security');

const sseClients = new Map(); // userId -> Set(res)

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sseBroadcast(uid, event, data = {}) {
  const set = sseClients.get(uid);
  if (!set || !set.size) return;
  for (const res of set) {
    try { sseSend(res, event, data); } catch (_) {}
  }
}

function registerSseRoute(app) {
  app.get('/api/slots/stream', assertAuth, (req, res) => {
    const uid = req.session.uid;

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let set = sseClients.get(uid);
    if (!set) { set = new Set(); sseClients.set(uid, set); }
    set.add(res);

    sseSend(res, 'hello', { now: Date.now() });
    const iv = setInterval(() => sseSend(res, 'ping', { now: Date.now() }), 25000);

    req.on('close', () => {
      clearInterval(iv);
      const set = sseClients.get(uid);
      if (set) {
        set.delete(res);
        if (!set.size) sseClients.delete(uid);
      }
    });
  });
}

module.exports = {
  sseClients,
  sseSend,
  sseBroadcast,
  registerSseRoute,
};
