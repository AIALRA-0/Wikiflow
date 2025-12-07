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
