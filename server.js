/**
 * wikiflow server - 模块化入口
 * 保留原有 API 行为，只是把逻辑拆到 ./server 下多个文件
 */
'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieSession = require('cookie-session');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

const {
  PORT,
  DB_PATH,
  NODE_ENV,
  SESSION_SECRET,
  APP_KEY,
  BODY_LIMIT,
} = require('./server-js/wf-server-config.js');

// ---------- DB 目录 ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ---------- 初始化 DB（建表 + 迁移） ----------
const { db } = require('./server/db');

// ---------- CLI：添加用户 ----------
if (process.argv[2] === 'add-user') {
  (async () => {
    const username = process.argv[3];
    const password = process.argv[4];
    if (!username || !password) {
      console.log('用法: npm run add-user -- <username> <password>');
      process.exit(1);
    }
    const hash = await bcrypt.hash(password, 12);
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    console.log(`用户已创建: ${username}`);
    process.exit(0);
  })();
  return;
}

// ---------- 加载路由与工具模块 ----------
const { registerAuthRoutes }  = require('./server/routes-auth');
const { registerTermRoutes }  = require('./server/routes-terms');
const { registerWikiRoutes }  = require('./server/routes-wiki');
const { registerJobRoutes }   = require('./server/routes-jobs');
const { registerWfRoutes }    = require('./server/routes-wf');
const { registerSlotRoutes }  = require('./server/routes-slots');
const { registerSseRoute }    = require('./server/sse');
const { registerWfConfig } = require('./server/wf-config');


// ---------- 创建 App ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({ contentSecurityPolicy: false })); // 简化 CSP 以兼容内嵌脚本
app.use(express.json({ limit: BODY_LIMIT }));
app.use(cookieSession({
  name: 'wf_sess',
  keys: [SESSION_SECRET],
  sameSite: 'strict',
  httpOnly: true,
  secure: (process.env.COOKIE_SECURE !== 'false' && NODE_ENV === 'production')
}));

// API 频率限制
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 800000,          // 每分钟 800000 次（你原来就是这个值）
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiLimiter);

// 允许 chatgpt.com / chat.openai.com 从前端子页跨域访问 /api/wf/*
app.use('/api/wf', (req, res, next) => {
  const origin = req.headers.origin || '';
  const ok = /^(https:\/\/chatgpt\.com|https:\/\/chat\.openai\.com)$/.test(origin);
  if (ok) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin'); // 让 CDN/缓存按 Origin 区分
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 直接提供用户脚本（从固定路径映射到 /wf.user.js）
app.get('/wf.user.js', (req, res) => {
  const scriptPath = process.env.WF_USER_SCRIPT_PATH || '/opt/wikiflow/public/wf.user.js';
  try {
    if (!fs.existsSync(scriptPath)) {
      return res.status(404).send('userscript not found: ' + scriptPath);
    }
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    return res.sendFile(scriptPath);
  } catch (e) {
    return res.status(500).send('failed to serve userscript: ' + (e?.message || e));
  }
});

// 映射 /public 静态目录
app.use('/public', express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.user.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// 静态资源（前端页面）
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', fallthrough: true }));

// 健康检查
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- 挂载各业务路由 ----------
registerSseRoute(app);   // SSE 事件流
registerAuthRoutes(app); // 登录 / 会话 / 设置
registerTermRoutes(app); // 术语队列
registerWikiRoutes(app); // Wiki.js 相关接口
registerJobRoutes(app);  // 后台 jobs 队列
registerWfRoutes(app);   // WF Relay 父子页通信
registerSlotRoutes(app); // slots 队列管理
registerWfConfig(app);

// 兜底 404（API）
app.use('/api/', (req, res) => res.status(404).json({ ok: false, error: 'API_NOT_FOUND' }));

// 生产环境强制检查密钥
if (NODE_ENV === 'production') {
  if (SESSION_SECRET.startsWith('dev_') || APP_KEY.startsWith('dev_')) {
    console.error('FATAL: SESSION_SECRET / APP_KEY 未配置为安全值');
    process.exit(1);
  }
}

// 启动
app.listen(PORT, () => {
  console.log(`[wikiflow] listening on :${PORT}`);
});
