// wf-server-config.js
'use strict';

const path = require('path');

// ---------- 环境变量 / 配置集中管理 ----------

// 端口 & 基础
const PORT = process.env.PORT || 4000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'wikiflow.sqlite');
const NODE_ENV = process.env.NODE_ENV || 'production';

// 会话 & 加密
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev_session_secret_change_me';
const APP_KEY = process.env.APP_KEY || 'dev_app_key_32bytes_minimum_change_me';

// Wiki.js 相关
const DEFAULT_WIKI_BASE = process.env.WIKI_BASE || 'https://wiki.aialra.online';
const DEFAULT_WIKI_GRAPHQL = process.env.WIKI_GRAPHQL || (DEFAULT_WIKI_BASE + '/graphql');
const DEFAULT_LOCALE = process.env.DEFAULT_LOCALE || 'zh';
const DEFAULT_EDITOR = process.env.DEFAULT_EDITOR || 'markdown';

// GraphQL & body 限制
const GQL_TIMEOUT_MS = Number(process.env.GQL_TIMEOUT_MS || '15000');
const BODY_LIMIT = process.env.BODY_LIMIT || '5mb';

// WF Relay 基础配置
const WF_TTL_MS = Number(process.env.WF_TTL_MS || '600000'); // 10 分钟
const WF_ALLOWED_ORIGINS = (process.env.WF_ALLOWED_ORIGINS || 'https://chatgpt.com,https://chat.openai.com')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const WF_PIN_FOCUS_THROTTLE_MS = Number(process.env.WF_PIN_FOCUS_THROTTLE_MS || '1500');

// WF Relay GC / 轮转相关
const WF_IDLE_TTL_MS = Number(process.env.WF_IDLE_TTL_MS || '720000');   // 12 分钟
const WF_MAX_TTL_MS  = Number(process.env.WF_MAX_TTL_MS  || '1800000');  // 30 分钟

const WF_ROTATE = String(process.env.WF_ROTATE || '1') !== '0';
const WF_ROTATE_INTERVAL_MS = Number(process.env.WF_ROTATE_INTERVAL_MS || '5000');

module.exports = {
  PORT,
  DB_PATH,
  NODE_ENV,
  SESSION_SECRET,
  APP_KEY,
  DEFAULT_WIKI_BASE,
  DEFAULT_WIKI_GRAPHQL,
  DEFAULT_LOCALE,
  DEFAULT_EDITOR,
  GQL_TIMEOUT_MS,
  BODY_LIMIT,
  WF_TTL_MS,
  WF_ALLOWED_ORIGINS,
  WF_PIN_FOCUS_THROTTLE_MS,
  WF_IDLE_TTL_MS,
  WF_MAX_TTL_MS,
  WF_ROTATE,
  WF_ROTATE_INTERVAL_MS,
};
