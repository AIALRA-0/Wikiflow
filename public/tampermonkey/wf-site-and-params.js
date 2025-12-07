// 模块：站点与参数（自动拆分自 wf.user.js）
'use strict';

/** ─────────────── 站点与参数 ─────────────── */
const IS_CHATGPT = /(?:^|\.)chatgpt\.com$|(?:^|\.)chat\.openai\.com$/.test(location.hostname);
const u = new URL(location.href);
const wf = /(^|[?&])wf=1(&|$)/.test(u.search);
const token = (location.hash||'').replace(/^#/, '');
const relay = u.searchParams.get('relay') || '';
const SKIP_SEND_KEY = `wf_skip_send_${token}`;
const MARKER_REFRESH_KEY = `wf_marker_refresh_${token}`;

const PARENT_ORIGIN = (() => { try { return new URL(relay).origin; } catch { return '*'; } })();

if (!IS_CHATGPT || !wf || !token || !relay) return;
END_MARK = `WF-END#${token.slice(0,6)}-${SID.slice(-4)}`;
