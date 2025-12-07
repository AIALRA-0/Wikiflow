#!/usr/bin/env bash
set -euo pipefail

# 自动把当前目录当成 wikiflow 根目录
cd "$(dirname "$0")"

echo "== wikiflow server 单文件 -> 多文件 拆分 =="
echo "工作目录: $(pwd)"

mkdir -p server

# 先备份原始 server.js
if [ -f server.js ] && [ ! -f server/server.monolith.js.bak ]; then
  cp server.js server/server.monolith.js.bak
  echo "已备份原始 server.js -> server/server.monolith.js.bak"
fi

################################
# 入口：server.js
################################
cat > server.js <<'__SERVER_JS__'
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
__SERVER_JS__


################################
# server/db.js
################################
cat > server/db.js <<'__DB_JS__'
// db.js - SQLite 初始化与 wf_slots / terms 等相关的数据库工具
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const {
  DB_PATH,
  DEFAULT_LOCALE,
  DEFAULT_EDITOR,
} = require('../server-js/wf-server-config.js');

const { sseBroadcast } = require('./sse');

// 确保数据目录存在
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// 初始化 DB
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY,
  wiki_base_url TEXT,
  wiki_graphql_url TEXT,
  wiki_token_cipher TEXT,
  locale TEXT DEFAULT '${DEFAULT_LOCALE}',
  editor TEXT DEFAULT '${DEFAULT_EDITOR}',
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS login_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  ts DATETIME DEFAULT CURRENT_TIMESTAMP,
  ip TEXT,
  ua TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  ts DATETIME DEFAULT CURRENT_TIMESTAMP,
  action TEXT,
  details TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS wf_slots (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  term_id INTEGER,
  title TEXT,
  text_in TEXT,
  text_out TEXT,
  status TEXT DEFAULT 'waiting',
  error_msg TEXT,
  tries INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_wf_slots_user ON wf_slots(user_id);
CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  term TEXT NOT NULL,
  term_norm TEXT,
  status TEXT DEFAULT 'new',
  title TEXT,
  tags_json TEXT,
  content TEXT,
  wiki_page_id INTEGER,
  wiki_path TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

// 迁移：为进度条增加 progress 列（如已存在则忽略）
try { db.prepare('ALTER TABLE wf_slots ADD COLUMN progress INTEGER DEFAULT 0').run(); } catch (_) {}

// 迁移：心跳字段（如已存在则忽略）
try { db.prepare('ALTER TABLE wf_slots ADD COLUMN hb_last_at DATETIME').run(); } catch (_) {}
try { db.prepare('ALTER TABLE wf_slots ADD COLUMN hb_rtt_ms INTEGER').run(); } catch (_) {}
try { db.prepare('ALTER TABLE wf_slots ADD COLUMN hb_count INTEGER DEFAULT 0').run(); } catch (_) {}
try { db.prepare('ALTER TABLE wf_slots ADD COLUMN pinned INTEGER DEFAULT 0').run(); } catch (_) {}

// 建表后面加一次性迁移
try { db.prepare('ALTER TABLE wf_slots ADD COLUMN opened_at DATETIME').run(); } catch (_) {}

// === 补列（幂等）===
try { db.prepare('ALTER TABLE wf_slots ADD COLUMN open_at_ms INTEGER').run(); } catch (_) {}
try { db.prepare('ALTER TABLE wf_slots ADD COLUMN hb_last_at INTEGER').run(); } catch (_) {}

// ✅ 迁移：terms.term_norm + 唯一索引（user_id, term_norm）
try { db.prepare('ALTER TABLE terms ADD COLUMN term_norm TEXT').run(); } catch (_) {}
try {
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '').trim();
  const rows = db.prepare('SELECT id, term FROM terms WHERE term_norm IS NULL').all();
  const up = db.prepare('UPDATE terms SET term_norm=? WHERE id=?');
  for (const r of rows) up.run(norm(r.term), r.id);
} catch (_) {}
try { db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_terms_user_norm ON terms(user_id, term_norm)').run(); } catch (_) {}

// ✅ 追加用于列表/清理的复合索引
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_wf_slots_user_status ON wf_slots(user_id, status, updated_at DESC)').run(); } catch (_) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_wf_slots_user_pinned ON wf_slots(user_id, pinned, updated_at DESC)').run(); } catch (_) {}

// ---------- wf_slots 相关工具函数 ----------
function slotUpsert({ token, userId, termId = null, title = '', textIn = '' }) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const existed = db.prepare('SELECT token FROM wf_slots WHERE token=?').get(token);
  if (existed) {
    db.prepare(`UPDATE wf_slots SET title=COALESCE(?,title), text_in=COALESCE(?,text_in),
               updated_at=? WHERE token=?`)
      .run(title || null, textIn || null, now, token);
  } else {
    db.prepare(`INSERT INTO wf_slots (token, user_id, term_id, title, text_in, status, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(token, userId, termId, title, textIn, 'waiting', now, now);
  }
  try { sseBroadcast(userId, 'slots_changed', { token: String(token) }); } catch (_) {}
}

function slotGetByToken(token) {
  return db.prepare('SELECT * FROM wf_slots WHERE token=?').get(token);
}

function slotSetState(token, { status, textOut = null, errorMsg = null, incTry = false, progress = null }) {
  let cur = null;
  try {
    cur = slotGetByToken(token);
    if (cur && cur.status === 'done' && status !== 'done') {
      return;
    }
  } catch (_) {}

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const triesSql = incTry ? 'tries = tries + 1,' : '';
  const progSql = (typeof progress === 'number') ? 'progress = ?, ' : '';

  const args = [status];
  if (typeof progress === 'number') {
    args.push(Math.max(0, Math.min(100, Math.round(progress))));
  }
  args.push(textOut, errorMsg, now, token);

  db.prepare(`UPDATE wf_slots SET status=?, ${triesSql} ${progSql}
              text_out=COALESCE(?, text_out), error_msg=COALESCE(?, error_msg),
              updated_at=? WHERE token=?`).run(...args);

  try {
    const row = cur || slotGetByToken(token);
    if (row?.user_id) sseBroadcast(row.user_id, 'slots_changed', { token: String(token), status });
  } catch (_) {}
}

function slotTouchHB(token, { rttMs = null } = {}) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (typeof rttMs === 'number' && isFinite(rttMs)) {
    db.prepare(`
      UPDATE wf_slots
      SET hb_last_at=?, hb_rtt_ms=?, hb_count=COALESCE(hb_count,0)+1
      WHERE token=?
    `).run(now, Math.max(0, Math.round(rttMs)), token);
  } else {
    db.prepare(`
      UPDATE wf_slots
      SET hb_last_at=?, hb_count=COALESCE(hb_count,0)+1
      WHERE token=?
    `).run(now, token);
  }
}

function slotListByUser(userId) {
  return db.prepare(`
    SELECT token, term_id, title, status, tries, progress, error_msg,
           hb_last_at, hb_rtt_ms, hb_count, pinned, opened_at,
           created_at, updated_at
    FROM wf_slots
    WHERE user_id=?
    ORDER BY pinned DESC, updated_at DESC
    LIMIT 200
  `).all(userId);
}

function slotDelete(token, userId) {
  db.prepare('DELETE FROM wf_slots WHERE token=? AND user_id=?').run(token, userId);
  try { sseBroadcast(userId, 'slots_changed', { token: String(token), deleted: true }); } catch (_) {}
}

// ---------- 通用日志 ----------
function logAction(userId, action, detailsObj = {}) {
  db.prepare('INSERT INTO logs (user_id, action, details) VALUES (?, ?, ?)').run(
    userId || null,
    action,
    JSON.stringify(detailsObj).slice(0, 4000)
  );
}

module.exports = {
  db,
  slotUpsert,
  slotSetState,
  slotTouchHB,
  slotGetByToken,
  slotListByUser,
  slotDelete,
  logAction,
};
__DB_JS__


################################
# server/security.js
################################
cat > server/security.js <<'__SECURITY_JS__'
// security.js - 会话鉴权、CSRF 与 Wiki Token 加解密
'use strict';

const crypto = require('crypto');
const { APP_KEY } = require('../server-js/wf-server-config.js');

function enc(data) {
  const key = crypto.createHash('sha256').update(APP_KEY).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function dec(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const key = crypto.createHash('sha256').update(APP_KEY).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  return dec;
}

function assertAuth(req, res, next) {
  if (req.session && req.session.uid) return next();
  return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
}

function genCSRF(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
  return req.session.csrf;
}

function verifyCSRF(req, res, next) {
  const token = req.get('x-csrf-token');
  if (!token || token !== req.session.csrf) {
    return res.status(403).json({ ok: false, error: 'BAD_CSRF' });
  }
  next();
}

module.exports = {
  enc,
  dec,
  assertAuth,
  genCSRF,
  verifyCSRF,
};
__SECURITY_JS__


################################
# server/sse.js
################################
cat > server/sse.js <<'__SSE_JS__'
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
__SSE_JS__


################################
# server/wiki-utils.js
################################
cat > server/wiki-utils.js <<'__WIKI_UTILS_JS__'
// wiki-utils.js - Wiki.js GraphQL 相关工具与标题/path 处理
'use strict';

const {
  GQL_TIMEOUT_MS,
  DEFAULT_WIKI_GRAPHQL,
  DEFAULT_WIKI_BASE,
} = require('../server-js/wf-server-config.js');
const { db } = require('./db');
const { dec } = require('./security');

// ---------- 标题与路径小工具 ----------
function normalizeSegment(seg) {
  return (seg || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-\u4e00-\u9fa5]/g, '');
}

function pathify(input) {
  if (!input || !String(input).trim()) return null;
  const raw = String(input).trim().replace(/\/+/g, '/');
  const parts = raw.split('/').filter((p, i) => !(i === 0 && p === ''));
  const clean = [];
  for (const p of parts) {
    if (p === '.' || p === '..') return null;
    const seg = normalizeSegment(p);
    if (!seg) return null;
    clean.push(seg);
  }
  return '/' + clean.join('/');
}

function normalizeTitle(s) {
  return (s || '').toLowerCase().replace(/\s+/g, '');
}

function splitTokens(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).map(x => x.toLowerCase());
}

function tokenOverlap(main, cand) {
  const A = new Set(splitTokens(main));
  const B = new Set(splitTokens(cand));
  if (!A.size || !B.size) return { matched: [], coverage: 0, jaccard: 0 };
  const matched = [...A].filter(t => B.has(t));
  const coverage = matched.length / A.size;
  const jaccard = matched.length / new Set([...A, ...B]).size;
  return { matched, coverage, jaccard };
}

function isAbortErr(err) {
  return err?.name === 'AbortError' || /aborted|AbortError/i.test(String(err?.message || err));
}

// ---------- GraphQL 调用 ----------
async function gqlRequest(url, token, query, variables = {}, timeoutMs = GQL_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();

  let res, raw, data;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`,
        'user-agent': 'wikiflow/1.0'
      },
      body: JSON.stringify({ query, variables }),
      signal: ac.signal
    });
    raw = await res.text();
    try { data = JSON.parse(raw); } catch {
      throw new Error(`GQL_HTTP_${res.status} (${Date.now() - t0}ms): ${raw.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = data?.errors?.map(e => e.message).join(' | ') || raw.slice(0, 200);
      throw new Error(`GQL_HTTP_${res.status} (${Date.now() - t0}ms): ${msg}`);
    }
    if (Array.isArray(data.errors) && data.errors.length) {
      const msg = data.errors.map(e => e.message).join(' | ');
      const where = data.errors.map(e => (e.path || []).join('.')).filter(Boolean).join(' , ');
      throw new Error(`GQL_ERR (${Date.now() - t0}ms): ${msg}${where ? ` @${where}` : ''}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForPageByPath(gqlURL, token, pathSlug, tries = 8, interval = 800) {
  for (let i = 0; i < tries; i++) {
    try {
      const data = await gqlRequest(gqlURL, token, `
        query($limit:Int!){
          pages { list(orderBy: TITLE, orderByDirection: ASC, limit:$limit){ id path title } }
        }`, { limit: 2000 });
      const hit = data?.data?.pages?.list?.find(p => (p.path || '') === pathSlug);
      if (hit) return hit;
    } catch { }
    await new Promise(r => setTimeout(r, interval));
  }
  return null;
}

async function fetchCandidates(gqlURL, token, title) {
  try {
    const q = `
      query($q:String!, $limit:Int!) {
        pages {
          search(query:$q, limit:$limit) {
            results { id path title score }
          }
        }
      }`;
    const data = await gqlRequest(gqlURL, token, q, { q: title, limit: 200 });
    const r = data?.data?.pages?.search?.results || [];
    if (r.length) return r.map(x => ({ id: x.id, path: x.path, title: x.title }));
  } catch (_) { }

  const q2 = `
    query($limit:Int!) {
      pages {
        list(orderBy: TITLE, orderByDirection: ASC, limit: $limit) {
          id path title
        }
      }
    }`;
  const data2 = await gqlRequest(gqlURL, token, q2, { limit: 2000 });
  return data2?.data?.pages?.list || [];
}

async function wikiDeletePage(gqlURL, token, { id, path }) {
  if (!id && path) {
    const data = await gqlRequest(gqlURL, token, `
      query($limit:Int!){
        pages { list(orderBy: TITLE, orderByDirection: ASC, limit:$limit){ id path title } }
      }`, { limit: 2000 });
    const hit = data?.data?.pages?.list?.find(p => (p.path || '') === path);
    if (hit) id = hit.id;
  }
  if (!id) throw new Error('DEL_NO_ID');

  const mutation = `
    mutation($id:Int!){
      pages {
        delete(id:$id){
          responseResult { succeeded errorCode message }
        }
      }
    }`;
  const resp = await gqlRequest(gqlURL, token, mutation, { id: Number(id) });
  const rr = resp?.data?.pages?.delete?.responseResult;
  if (!rr?.succeeded) {
    throw new Error(rr?.errorCode ? `${rr.errorCode} ${rr.message || ''}` : 'DELETE_FAILED');
  }
  await new Promise(r => setTimeout(r, 400));
  return true;
}

// ---------- URL/path 与页面读取 ----------
function buildPathCandidates({ rawPath, baseURL }) {
  const norm = p => {
    if (!p) return '/';
    let s = String(p).trim();
    s = s.replace(/\/+/g, '/');
    if (!s.startsWith('/')) s = '/' + s;
    return s;
  };

  const candidates = new Set();

  if (rawPath) candidates.add(norm(rawPath));

  try {
    if (baseURL) {
      const bu = new URL(baseURL);
      const basePath = bu.pathname.replace(/\/+$/, '');
      if (basePath && rawPath && rawPath.startsWith(basePath)) {
        const stripped = rawPath.slice(basePath.length) || '/';
        candidates.add(norm(stripped));
      }
    }
  } catch (_) { }

  for (const p of [...candidates]) {
    if (p === '/' || p === '/(root)') {
      candidates.add('/');
      candidates.add('/(root)');
    }
  }
  return [...candidates];
}

function extractWikiPath({ url, path: pathFromBody, baseURL }) {
  let pagePath = pathFromBody;

  if (!pagePath) {
    if (!url) return null;
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return null;
    }
    pagePath = u.pathname || '/';
    pagePath = pagePath.split('?')[0].split('#')[0];
  }

  try {
    if (baseURL) {
      const bu = new URL(baseURL);
      let basePath = bu.pathname.replace(/\/+$/, '');
      if (basePath && basePath !== '/' && pagePath.startsWith(basePath + '/')) {
        pagePath = pagePath.slice(basePath.length) || '/';
      } else if (basePath && basePath === pagePath) {
        pagePath = '/';
      }
    }
  } catch (_) { }

  if (!pagePath) pagePath = '/';
  pagePath = pagePath.replace(/\/+/g, '/');
  if (!pagePath.startsWith('/')) pagePath = '/' + pagePath;
  return pagePath;
}

async function loadWikiPageForUser(uid, { url, path: pathFromBody }) {
  const st = db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(uid) || {};
  const gqlURL = st.wiki_graphql_url || DEFAULT_WIKI_GRAPHQL;
  const baseURL = st.wiki_base_url || DEFAULT_WIKI_BASE;
  const token = st.wiki_token_cipher ? dec(st.wiki_token_cipher) : null;

  if (!token) {
    const err = new Error('NO_TOKEN');
    err.code = 'NO_TOKEN';
    throw err;
  }

  const rawPath = extractWikiPath({ url, pathFromBody, baseURL });
  if (!rawPath) {
    const err = new Error('BAD_URL_OR_PATH');
    err.code = 'BAD_URL_OR_PATH';
    throw err;
  }
  const candidates = buildPathCandidates({ rawPath, baseURL });

  const listQuery = `
    query($limit:Int!) {
      pages {
        list(orderBy: TITLE, orderByDirection: ASC, limit:$limit) {
          id
          path
          title
        }
      }
    }`;
  const listData = await gqlRequest(gqlURL, token, listQuery, { limit: 2000 });
  const list = listData?.data?.pages?.list || [];

  let hit = null;
  for (const cand of candidates) {
    hit = list.find(p => (p.path || '') === cand);
    if (hit) break;
  }

  if (!hit) {
    return { page: null, baseURL, candidates };
  }

  const byIdQuery = `
    query($id:Int!) {
      pages {
        single(id:$id) {
          id
          path
          title
          content
        }
      }
    }`;
  const singleData = await gqlRequest(gqlURL, token, byIdQuery, { id: Number(hit.id) });
  const page = singleData?.data?.pages?.single || null;

  return { page, baseURL, candidates };
}

module.exports = {
  normalizeSegment,
  pathify,
  normalizeTitle,
  splitTokens,
  tokenOverlap,
  isAbortErr,
  waitForPageByPath,
  gqlRequest,
  fetchCandidates,
  wikiDeletePage,
  buildPathCandidates,
  extractWikiPath,
  loadWikiPageForUser,
};
__WIKI_UTILS_JS__


################################
# server/wf-store.js
################################
cat > server/wf-store.js <<'__WF_STORE_JS__'
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
__WF_STORE_JS__


################################
# server/jobs.js
################################
cat > server/jobs.js <<'__JOBS_JS__'
// jobs.js - 内存中的 Wiki 提交任务队列（重启后丢失）
'use strict';

const crypto = require('crypto');

const jobs = new Map(); // id -> { userId, status, progress, message, url }

function newJobId() {
  return crypto.randomBytes(8).toString('hex');
}

module.exports = {
  jobs,
  newJobId,
};
__JOBS_JS__


################################
# server/routes-auth.js
################################
cat > server/routes-auth.js <<'__ROUTES_AUTH_JS__'
// routes-auth.js - 登录/登出、会话信息与用户 Wiki 设置
'use strict';

const bcrypt = require('bcrypt');
const { db, logAction } = require('./db');
const { enc, dec, assertAuth, genCSRF, verifyCSRF } = require('./security');
const {
  DEFAULT_WIKI_BASE,
  DEFAULT_WIKI_GRAPHQL,
  DEFAULT_LOCALE,
  DEFAULT_EDITOR,
} = require('../server-js/wf-server-config.js');

function registerAuthRoutes(app) {
  // CSRF
  app.get('/api/csrf', (req, res) => {
    res.json({ ok: true, token: genCSRF(req) });
  });

  // 会话信息
  app.get('/api/session', (req, res) => {
    const uid = req.session.uid;
    if (!uid) return res.json({ authenticated: false });

    const u = db.prepare('SELECT username FROM users WHERE id=?').get(uid) || {};
    const st = db.prepare('SELECT wiki_base_url, wiki_graphql_url, wiki_token_cipher, locale, editor FROM user_settings WHERE user_id=?').get(uid) || {};

    res.json({
      authenticated: true,
      user: { id: uid, username: u.username || '' },
      settings: {
        wiki_base_url: st.wiki_base_url || DEFAULT_WIKI_BASE,
        wiki_graphql_url: st.wiki_graphql_url || DEFAULT_WIKI_GRAPHQL,
        locale: st.locale || DEFAULT_LOCALE,
        editor: st.editor || DEFAULT_EDITOR,
        has_token: !!st.wiki_token_cipher,
        token_preview: st.wiki_token_cipher ? ('••••' + (dec(st.wiki_token_cipher).slice(-4))) : ''
      }
    });
  });

  // 登录
  app.post('/api/login', verifyCSRF, async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok: false, error: 'MISSING' });
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (!u) return res.status(401).json({ ok: false, error: 'INVALID' });
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: 'INVALID' });
    req.session.uid = u.id;
    genCSRF(req);
    db.prepare('INSERT INTO login_events (user_id, ip, ua) VALUES (?, ?, ?)').run(
      u.id,
      (req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''),
      req.headers['user-agent'] || ''
    );
    logAction(u.id, 'login', { user: username });
    res.json({ ok: true });
  });

  // 登出
  app.post('/api/logout', verifyCSRF, assertAuth, (req, res) => {
    const uid = req.session.uid;
    req.session = null;
    logAction(uid, 'logout', {});
    res.json({ ok: true });
  });

  // 保存 Wiki 设置
  app.post('/api/settings', verifyCSRF, assertAuth, (req, res) => {
    const uid = req.session.uid;
    let { wiki_base_url, wiki_graphql_url, wiki_token, locale, editor } = req.body || {};
    if (!wiki_base_url && !wiki_graphql_url && !wiki_token && !locale && !editor) {
      return res.status(400).json({ ok: false, error: 'EMPTY' });
    }
    wiki_base_url = (wiki_base_url || DEFAULT_WIKI_BASE).trim();
    wiki_graphql_url = (wiki_graphql_url || DEFAULT_WIKI_GRAPHQL).trim();
    const encTok = wiki_token ? enc(wiki_token.trim()) : null;
    const row = db.prepare('SELECT user_id FROM user_settings WHERE user_id=?').get(uid);
    if (row) {
      const sql = `UPDATE user_settings SET wiki_base_url=COALESCE(?,wiki_base_url),
        wiki_graphql_url=COALESCE(?,wiki_graphql_url),
        wiki_token_cipher=COALESCE(?,wiki_token_cipher),
        locale=COALESCE(?,locale),
        editor=COALESCE(?,editor)
        WHERE user_id=?`;
      db.prepare(sql).run(
        wiki_base_url || null,
        wiki_graphql_url || null,
        encTok || null,
        locale || null,
        editor || null,
        uid
      );
    } else {
      db.prepare('INSERT INTO user_settings (user_id, wiki_base_url, wiki_graphql_url, wiki_token_cipher, locale, editor) VALUES (?,?,?,?,?,?)')
        .run(uid, wiki_base_url, wiki_graphql_url, encTok, locale || DEFAULT_LOCALE, editor || DEFAULT_EDITOR);
    }
    logAction(uid, 'save_settings', { wiki_base_url, wiki_graphql_url, has_token: !!wiki_token });
    res.json({ ok: true });
  });
}

module.exports = {
  registerAuthRoutes,
};
__ROUTES_AUTH_JS__


################################
# server/routes-terms.js
################################
cat > server/routes-terms.js <<'__ROUTES_TERMS_JS__'
// routes-terms.js - 术语队列 terms 的增删查
'use strict';

const { db, logAction } = require('./db');
const { assertAuth, verifyCSRF } = require('./security');

function registerTermRoutes(app) {
  app.post('/api/terms', verifyCSRF, assertAuth, (req, res) => {
    const uid = req.session.uid;
    const { term } = req.body || {};
    if (!term || String(term).length > 200) {
      return res.status(400).json({ ok: false, error: 'BAD_TERM' });
    }

    const norm = String(term).toLowerCase().replace(/\s+/g, '').trim();
    try {
      const id = db.prepare('INSERT INTO terms (user_id, term, term_norm) VALUES (?,?,?)')
        .run(uid, String(term).trim(), norm).lastInsertRowid;
      logAction(uid, 'term_add', { id, term });
      return res.json({ ok: true, id });
    } catch (e) {
      if (/unique/i.test(String(e))) {
        return res.status(409).json({ ok: false, error: 'DUP_TERM' });
      }
      return res.status(500).json({ ok: false, error: 'TERM_ADD_FAIL' });
    }
  });

  app.get('/api/terms', assertAuth, (req, res) => {
    const uid = req.session.uid;
    const rows = db.prepare('SELECT id, term, status, created_at FROM terms WHERE user_id=? ORDER BY id DESC LIMIT 200').all(uid);
    res.json({ ok: true, items: rows });
  });

  app.delete('/api/terms/:id', verifyCSRF, assertAuth, (req, res) => {
    const uid = req.session.uid;
    const id = Number(req.params.id);
    db.prepare('DELETE FROM terms WHERE id=? AND user_id=?').run(id, uid);
    logAction(uid, 'term_del', { id });
    res.json({ ok: true });
  });
}

module.exports = {
  registerTermRoutes,
};
__ROUTES_TERMS_JS__


################################
# server/routes-wiki.js
################################
cat > server/routes-wiki.js <<'__ROUTES_WIKI_JS__'
// routes-wiki.js - Wiki.js 查重/提交/读取页面相关 API
'use strict';

const { db, logAction } = require('./db');
const { assertAuth, verifyCSRF, dec } = require('./security');
const {
  DEFAULT_WIKI_BASE,
  DEFAULT_WIKI_GRAPHQL,
  DEFAULT_LOCALE,
  DEFAULT_EDITOR,
} = require('../server-js/wf-server-config.js');
const {
  pathify,
  tokenOverlap,
  fetchCandidates,
  wikiDeletePage,
  gqlRequest,
  loadWikiPageForUser,
} = require('./wiki-utils');

function registerWikiRoutes(app) {
  // 查重
  app.post('/api/wiki/check-duplicate', verifyCSRF, assertAuth, async (req, res) => {
    const uid = req.session.uid;
    const { title } = req.body || {};
    if (!title) return res.status(400).json({ ok: false, error: 'NO_TITLE' });

    const st = db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(uid) || {};
    const gqlURL = st.wiki_graphql_url || DEFAULT_WIKI_GRAPHQL;
    const token = st.wiki_token_cipher ? dec(st.wiki_token_cipher) : null;
    if (!token) return res.status(400).json({ ok: false, error: 'NO_TOKEN' });

    function norm(s) {
      return (s || '')
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[^\w\u4e00-\u9fa5]/g, '');
    }

    function similarity(a, b) {
      const x = norm(a);
      const y = norm(b);
      if (!x || !y) return 0;

      if (x === y) return 1;

      if (x.includes(y) || y.includes(x)) {
        const maxLen = Math.max(x.length, y.length) || 1;
        const minLen = Math.min(x.length, y.length) || 0;
        return minLen / maxLen;
      }

      const sa = new Set(x.split(''));
      const sb = new Set(y.split(''));
      let inter = 0;
      for (const ch of sa) {
        if (sb.has(ch)) inter++;
      }
      const uni = new Set([...sa, ...sb]).size || 1;
      return inter / uni;
    }

    function longestTokenLen(arr) {
      return (arr || []).reduce((m, t) => Math.max(m, (t || '').length), 0);
    }

    const candidates = await fetchCandidates(gqlURL, token, title);
    const queryNorm = norm(title);

    const matches = (candidates || [])
      .map((p) => {
        const candTitle = String(p.title || '').trim();
        if (!candTitle) return null;

        const ov = tokenOverlap(title, candTitle) || { matched: [], coverage: 0 };
        const matchedTokens = ov.matched || [];
        const tokenCoverage = ov.coverage || 0;
        const titleSim = similarity(title, candTitle) || 0;
        const maxTokenLen = longestTokenLen(matchedTokens);

        const candNorm = norm(candTitle);
        if (candNorm && candNorm === queryNorm) {
          return {
            id: p.id,
            path: p.path,
            title: candTitle,
            matchedTokens,
            similarity: 1,
            tokenCoverage: 1,
            titleSimilarity: 1,
            maxTokenLen,
          };
        }

        const primary = Math.max(tokenCoverage, titleSim);
        const secondary = Math.min(tokenCoverage, titleSim);
        const combined = 0.7 * primary + 0.3 * secondary;

        return {
          id: p.id,
          path: p.path,
          title: candTitle,
          matchedTokens,
          similarity: combined,
          tokenCoverage,
          titleSimilarity: titleSim,
          maxTokenLen,
        };
      })
      .filter((m) => {
        if (!m) return false;
        if (m.similarity < 0.3) return false;
        if ((!m.matchedTokens || !m.matchedTokens.length) && m.titleSimilarity < 0.85) {
          return false;
        }
        if ((m.maxTokenLen || 0) <= 1 && m.titleSimilarity < 0.85) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.similarity - a.similarity);

    res.json({ ok: true, matches });
  });

  // 删除页面
  app.post('/api/wiki/delete', verifyCSRF, assertAuth, async (req, res) => {
    const uid = req.session.uid;
    const { id, path: pagePath } = req.body || {};

    const st = db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(uid) || {};
    const gqlURL = st.wiki_graphql_url || DEFAULT_WIKI_GRAPHQL;
    const token = st.wiki_token_cipher ? dec(st.wiki_token_cipher) : null;
    if (!token) return res.status(400).json({ ok: false, error: 'NO_TOKEN' });
    if (!id && !pagePath) return res.status(400).json({ ok: false, error: 'MISS_ID_OR_PATH' });

    try {
      await wikiDeletePage(gqlURL, token, { id, path: pagePath });
      logAction(uid, 'wiki_delete_ok', { id, path: pagePath });
      res.json({ ok: true });
    } catch (e) {
      logAction(uid, 'wiki_delete_fail', { id, path: pagePath, err: String(e?.message || e) });
      res.status(500).json({ ok: false, error: 'DELETE_FAIL', message: String(e?.message || e) });
    }
  });

  // 直接提交页面（不经过内存 jobs 队列）
  app.post('/api/wiki/submit', verifyCSRF, assertAuth, async (req, res) => {
    const uid = req.session.uid;
    const { mode, existingId, title, tags, content } = req.body || {};
    const desc = String((req.body?.desc ?? req.body?.description ?? '') || '').slice(0, 500);

    if (!title || !content) {
      return res.status(400).json({ ok: false, error: 'MISS_FIELDS' });
    }

    const st = db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(uid) || {};
    const gqlURL = st.wiki_graphql_url || DEFAULT_WIKI_GRAPHQL;
    const baseURL = st.wiki_base_url || DEFAULT_WIKI_BASE;
    const token = st.wiki_token_cipher ? dec(st.wiki_token_cipher) : null;
    const locale = st.locale || DEFAULT_LOCALE;
    const editor = st.editor || DEFAULT_EDITOR;

    if (!token) {
      return res.status(400).json({ ok: false, error: 'NO_TOKEN' });
    }

    let pathSlug = pathify(title);
    if (!pathSlug) {
      return res.status(400).json({ ok: false, error: 'BAD_TITLE' });
    }

    try {
      let resp;
      const normTags = Array.isArray(tags) ? tags.filter(t => t != null).map(String) : [];

      if (mode === 'overwrite' && existingId) {
        const mutation = `
        mutation ($id:Int!, $title:String!, $path:String!, $content:String!, $tags:[String]!, $locale:String!, $editor:String!, $description:String!) {
          pages {
            update(
              id:$id, title:$title, path:$path, content:$content, tags:$tags,
              locale:$locale, isPublished:true, isPrivate:false, editor:$editor
              , description:$description
            ) {
              responseResult { succeeded errorCode slug message }
              page { id path title }
            }
          }
        }`;

        resp = await gqlRequest(gqlURL, token, mutation, {
          id: Number(existingId),
          title,
          path: pathSlug,
          content,
          tags: normTags,
          description: desc,
          locale,
          editor,
        });
      } else {
        const mutation = `
        mutation ($title:String!, $path:String!, $content:String!, $tags:[String]!, $locale:String!, $editor:String!, $description:String!) {
          pages {
            create(
              title:$title, path:$path, description:$description, content:$content, tags:$tags,
              locale:$locale, isPublished:true, isPrivate:false, editor:$editor
            )  {
              responseResult { succeeded errorCode slug message }
              page { id path title }
            }
          }
        }`;

        resp = await gqlRequest(gqlURL, token, mutation, {
          title,
          path: pathSlug,
          content,
          tags: normTags,
          locale,
          editor,
          description: desc,
        });
      }

      const rr = resp.data?.pages?.create?.responseResult || resp.data?.pages?.update?.responseResult;
      const page = resp.data?.pages?.create?.page || resp.data?.pages?.update?.page;

      if (!rr?.succeeded) {
        return res.status(409).json({
          ok: false,
          error: 'WIKI_FAIL',
          code: rr?.errorCode,
          slug: rr?.slug,
          message: rr?.message,
        });
      }

      db.prepare(`
        INSERT INTO terms (user_id, term, status, title, tags_json, content, wiki_page_id, wiki_path)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(
        uid,
        title,
        'posted',
        title,
        JSON.stringify(tags || []),
        content.slice(0, 200000),
        page.id,
        page.path
      );

      const url = baseURL.replace(/\/+$/, '') + (page.path.startsWith('/') ? page.path : '/' + page.path);
      logAction(uid, 'wiki_submit_ok', { title, url, mode: mode || 'create' });

      res.json({ ok: true, url, page });
    } catch (err) {
      logAction(uid, 'wiki_submit_fail', { title, err: String(err?.message || err) });

      return res.status(500).json({
        ok: false,
        error: 'WIKI_SUBMIT_FAIL',
        message: String(err?.message || err),
      });
    }
  });

  // 读取单个页面（新接口）
  app.post('/api/wiki/get', verifyCSRF, assertAuth, async (req, res) => {
    const uid = req.session.uid;
    const { url, path: pathFromBody } = req.body || {};

    try {
      const { page } = await loadWikiPageForUser(uid, { url, path: pathFromBody });

      if (!page) {
        return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      }

      return res.json({
        ok: true,
        page: {
          id: page.id,
          path: page.path,
          title: page.title,
          content: page.content || '',
        },
      });
    } catch (e) {
      console.error('[wiki.get] FAIL', e);

      if (e.code === 'NO_TOKEN') {
        return res.status(400).json({ ok: false, error: 'NO_TOKEN' });
      }
      if (e.code === 'BAD_URL_OR_PATH') {
        return res.status(400).json({ ok: false, error: 'BAD_URL_OR_PATH' });
      }

      return res.status(500).json({
        ok: false,
        error: 'GQL_FAIL',
        message: String(e?.message || e),
      });
    }
  });

  // 兼容老前端：只取 content + 少量 meta
  app.post('/api/wiki/get-content', verifyCSRF, assertAuth, async (req, res) => {
    const uid = req.session.uid;
    const { url, path: pathFromBody } = req.body || {};

    try {
      const { page } = await loadWikiPageForUser(uid, { url, path: pathFromBody });

      if (!page) {
        return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      }

      return res.json({
        ok: true,
        content: page.content || '',
        meta: {
          id: page.id,
          path: page.path,
          title: page.title,
        },
      });
    } catch (e) {
      console.error('[wiki.get-content] FAIL', e);

      if (e.code === 'NO_TOKEN') {
        return res.status(400).json({ ok: false, error: 'NO_TOKEN' });
      }
      if (e.code === 'BAD_URL_OR_PATH') {
        return res.status(400).json({ ok: false, error: 'BAD_URL_OR_PATH' });
      }

      return res.status(500).json({
        ok: false,
        error: 'GQL_FAIL',
        message: String(e?.message || e),
      });
    }
  });
}

module.exports = {
  registerWikiRoutes,
};
__ROUTES_WIKI_JS__


################################
# server/routes-jobs.js
################################
cat > server/routes-jobs.js <<'__ROUTES_JOBS_JS__'
// routes-jobs.js - Wiki 页面提交任务队列 jobs 相关 API
'use strict';

const { jobs, newJobId } = require('./jobs');
const { db, logAction } = require('./db');
const { assertAuth, verifyCSRF, dec } = require('./security');
const {
  DEFAULT_WIKI_BASE,
  DEFAULT_WIKI_GRAPHQL,
  DEFAULT_LOCALE,
  DEFAULT_EDITOR,
} = require('../server-js/wf-server-config.js');
const {
  pathify,
  fetchCandidates,
  tokenOverlap,
  wikiDeletePage,
  gqlRequest,
} = require('./wiki-utils');

function registerJobRoutes(app) {
  app.post('/api/jobs/submit', verifyCSRF, assertAuth, async (req, res) => {
    const uid = req.session.uid;
    const { termId, mode, existingId, title, tags, content, cleanup, force, deleteFirst } = req.body || {};
    const desc = String((req.body?.desc ?? req.body?.description ?? '') || '').slice(0, 500);
    if (!title || !content) return res.status(400).json({ ok: false, error: 'MISS_FIELDS' });

    const id = newJobId();
    jobs.set(id, { userId: uid, title, status: 'queued', progress: 0, message: '排队中…' });
    res.json({ ok: true, id });

    (async () => {
      const job = jobs.get(id); if (!job) return;
      try {
        job.status = 'running'; job.progress = 10; job.message = '准备参数…';

        const st = db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(uid) || {};
        const gqlURL = st.wiki_graphql_url || DEFAULT_WIKI_GRAPHQL;
        const baseURL = st.wiki_base_url || DEFAULT_WIKI_BASE;
        const token = st.wiki_token_cipher ? dec(st.wiki_token_cipher) : null;
        const locale = st.locale || DEFAULT_LOCALE;
        const editor = st.editor || DEFAULT_EDITOR;
        if (!token) throw new Error('NO_TOKEN');

        const pathSlug = pathify(title);
        if (!pathSlug) throw new Error('BAD_TITLE');

        job.progress = 20; job.message = '检查可能重复/相似…';
        const candidates = await fetchCandidates(gqlURL, token, title);
        const dupList = (candidates || [])
          .map(p => {
            const ov = tokenOverlap(title, p.title || '');
            return { id: p.id, path: p.path, title: p.title, matchedTokens: ov.matched, similarity: ov.coverage };
          })
          .filter(m => m.matchedTokens.length > 0)
          .sort((a, b) => b.similarity - a.similarity);

        if (dupList.length) {
          job.dups = dupList;
          if (!force) {
            job.status = 'error'; job.progress = 0;
            job.message = '检测到可能重复/相似页面（可改标题；或点“坚持提交”继续）';
            return;
          } else {
            logAction(uid, 'duplicate_override', { title, top: dupList[0] });
            job.message = '检测到可能重复，已按“坚持提交”继续…';
          }
        }

        job.progress = 35; job.message = '提交到 Wiki.js…';
        let resp;
        const normTags = Array.isArray(tags) ? tags.filter(t => t != null).map(String) : [];

        if (mode === 'overwrite' && existingId) {
          if (deleteFirst) {
            job.message = '覆盖：先删除旧页面…';
            await wikiDeletePage(gqlURL, token, { id: Number(existingId) });
            await new Promise(r => setTimeout(r, 400));

            job.message = '覆盖：创建新页面…';
            const mCreate = `
              mutation ($title:String!, $path:String!, $content:String!, $tags:[String]!,
                        $locale:String!, $editor:String!, $description:String!) {
                pages {
                  create(
                    title:$title, path:$path, description:$description, content:$content, tags:$tags,
                    locale:$locale, isPublished:true, isPrivate:false, editor:$editor
                  ) {
                    responseResult { succeeded errorCode slug message }
                    page { id path title }
                  }
                }
              }`;
            resp = await gqlRequest(gqlURL, token, mCreate, {
              title, path: pathSlug, content, tags: normTags,
              locale, editor, description: desc,
            });
          } else {
            const mUpdate = `
              mutation ($id:Int!, $title:String!, $path:String!, $content:String!, $tags:[String]!,
                        $locale:String!, $editor:String!) {
                pages {
                  update(
                    id:$id, title:$title, path:$path, content:$content, tags:$tags,
                    locale:$locale, isPublished:true, isPrivate:false, editor:$editor
                  ) {
                    responseResult { succeeded errorCode slug message }
                    page { id path title }
                  }
                }
              }`;
            resp = await gqlRequest(gqlURL, token, mUpdate, {
              id: Number(existingId), title, path: pathSlug, content,
              tags: normTags, locale, editor,
            });
          }
        } else {
          const mCreate = `
            mutation ($title:String!, $path:String!, $content:String!, $tags:[String]!,
                      $locale:String!, $editor:String!, $description:String!) {
              pages {
                create(
                  title:$title, path:$path, description:$description, content:$content, tags:$tags,
                  locale:$locale, isPublished:true, isPrivate:false, editor:$editor
                ) {
                  responseResult { succeeded errorCode slug message }
                  page { id path title }
                }
              }
            }`;
          resp = await gqlRequest(gqlURL, token, mCreate, {
            title, path: pathSlug, content, tags: normTags,
            locale, editor, description: desc,
          });
        }

        const rr = resp.data?.pages?.create?.responseResult || resp.data?.pages?.update?.responseResult;
        const page = resp.data?.pages?.create?.page || resp.data?.pages?.update?.page;
        if (!rr?.succeeded) {
          throw new Error(`WIKI_FAIL ${rr?.errorCode || ''} ${rr?.message || ''}`.trim());
        }

        if (cleanup && termId) {
          db.prepare('DELETE FROM terms WHERE id=? AND user_id=?').run(Number(termId), uid);
        }

        const url = baseURL.replace(/\/+$/, '') + (page.path.startsWith('/') ? page.path : '/' + page.path);
        logAction(uid, 'wiki_submit_ok', { title, url, mode: mode || 'create' });

        job.progress = 100; job.status = 'done'; job.url = url; job.message = '完成';
      } catch (err) {
        logAction(uid, 'wiki_submit_fail', { title, err: String(err?.message || err) });
        const job2 = jobs.get(id); if (!job2) return;
        job2.status = 'error'; job2.progress = 0; job2.message = String(err?.message || err);
      }
    })();
  });

  app.get('/api/jobs/:id', assertAuth, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.userId !== req.session.uid) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    }
    res.json({
      ok: true,
      id: req.params.id,
      title: job.title,
      status: job.status,
      progress: job.progress,
      message: job.message,
      url: job.url,
      dups: job.dups,
    });
  });

  app.get('/api/jobs', assertAuth, (req, res) => {
    const uid = req.session.uid;
    const items = [];
    for (const [id, j] of jobs.entries()) {
      if (j.userId === uid) {
        items.push({ id, title: j.title, status: j.status, progress: j.progress, message: j.message, url: j.url });
      }
    }
    items.sort((a, b) => {
      const ra = (a.status === 'done' || a.status === 'error') ? 1 : 0;
      const rb = (b.status === 'done' || b.status === 'error') ? 1 : 0;
      return ra - rb || (b.progress - a.progress);
    });
    res.json({ ok: true, items });
  });

  app.post('/api/jobs/clear', verifyCSRF, assertAuth, (req, res) => {
    const uid = req.session.uid;
    const { scope } = req.body || {};
    for (const [id, j] of [...jobs.entries()]) {
      if (j.userId !== uid) continue;
      if (scope === 'all' || (scope === 'done' && (j.status === 'done' || j.status === 'error'))) {
        jobs.delete(id);
      }
    }
    res.json({ ok: true });
  });
}

module.exports = {
  registerJobRoutes,
};
__ROUTES_JOBS_JS__


################################
# server/routes-wf.js
################################
cat > server/routes-wf.js <<'__ROUTES_WF_JS__'
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
__ROUTES_WF_JS__


################################
# server/routes-slots.js
################################
cat > server/routes-slots.js <<'__ROUTES_SLOTS_JS__'
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
__ROUTES_SLOTS_JS__


echo "✅ 拆分完成："
echo "  - 新入口：server.js"
echo "  - 模块目录：server/"
echo "  - 备份原始单文件：server/server.monolith.js.bak（如之前存在）"
echo "然后直接用原来的方式启动：node server.js / npm run start 等。"
