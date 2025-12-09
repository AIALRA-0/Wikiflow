// server/wf-config.js
'use strict';

const { assertAuth } = require('./security');
const { sseBroadcast } = require('./sse');

/**
 * 注册 wikiflow 配置同步路由：
 * 前端 POST /api/wf/config-broadcast
 * 后端通过 SSE 向当前用户的所有标签页广播 "wf-config" 事件
 */
function registerWfConfig(app) {
  app.post('/api/wf/config-broadcast', assertAuth, (req, res) => {
    const uid = req.session.uid;
    const body = req.body || {};
    const payload = {};

    if (typeof body.template === 'string') {
      payload.template = body.template;
    }

    // 并行上限同步
    if (typeof body.parallelLimit === 'number') {
      payload.parallelLimit = body.parallelLimit;
    }

    // 以后你想加别的设置，也可以继续往 payload 里塞

    if (Object.keys(payload).length > 0) {
      sseBroadcast(uid, 'wf-config', payload);
    }

    return res.json({ ok: true });
  });
}

// 和 server.js 的用法保持一致
module.exports = { registerWfConfig };
