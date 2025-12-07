// 模块：reload-before-resend 支持（自动拆分自 wf.user.js）
'use strict';

/** ─────────────── reload-before-resend 支持 ─────────────── */
const RELOAD_CNT_KEY    = `wf_reload_count_${token}`;
const RELOAD_REASON_KEY = `wf_reload_reason_${token}`;
const MAX_RELOADS       = 2;

// —— 硬重开（relaunch）支持 —— //
const RELAUNCH_CNT_KEY = `wf_relaunch_count_${token}`;
const MAX_RELAUNCHES   = 2;

// 允许父页要求“刷新后只复制”
// 父页会先发 WF_REFRESH_COPY_ONLY；子页设置跳过发送标志并刷新
window.addEventListener('message', (ev) => {
  const d = ev.data || {};
  if (d?.type !== 'WF_REFRESH_COPY_ONLY') return;
  if (!d.token || d.token !== token) return; // 只处理当前 token
  try { sessionStorage.setItem(SKIP_SEND_KEY, '1'); } catch {}
  try { sessionStorage.setItem(RELOAD_REASON_KEY, 'parent-refresh-copy-only'); } catch {}
  RELAUNCH_OK = false;           // ⬅️ 新增
  refreshInPlaceKeepUrl();       // ⬅️ 改：用当前内部 URL 原地刷新
}, false);

// 父页重开时可加 ?wf_copy_only=1 → 子页本页只复制（不再生成）
const copyOnlyParam = u.searchParams.get('wf_copy_only');
if (copyOnlyParam === '1') {
  try { sessionStorage.setItem(SKIP_SEND_KEY, '1'); } catch {}
  RELAUNCH_OK = false; // ⬅️ 新增：copy-only 阶段禁止新开窗
}

function notifyParentRequeue(reason) {
  try {
    const target = new URL(relay).origin;
    if (window.opener && typeof window.opener.postMessage === 'function') {
      window.opener.postMessage({
        type: 'WF_REQUEUE_REQUEST',
        token,
        reason,
        relay: target
      }, target);
      return true;
    }
  } catch (_) {}
  return false;
}
// —— 新增：给父页发“重开窗口”请求 —— //
function notifyParentToRelaunch(reason) {
  try {
    // 父页域名来源于 ?relay=... 参数；脚本顶部已取到 relay
    const target = new URL(relay).origin;
    if (window.opener && typeof window.opener.postMessage === 'function') {
      window.opener.postMessage({
        type: 'WF_RELAUNCH_REQUEST', // 消息类型
        token,                       // 本次任务 token（#hash）
        reason,                      // 重试原因，用于日志/UI
        relay: target                // 反向校验：只让父页同域接收
      }, target);
      return true;
    }
  } catch (_) {}
  return false;
}

function relaunchInNewWindow(reason) {
  const n = parseInt(sessionStorage.getItem(RELAUNCH_CNT_KEY) || '0', 10);
  if (n >= MAX_RELAUNCHES) return false;
  sessionStorage.setItem(RELAUNCH_CNT_KEY, String(n + 1));
  if (reason) sessionStorage.setItem(RELOAD_REASON_KEY, 'relaunch: ' + reason);

  const cur = new URL(location.href);
  const search = cur.searchParams;
  search.set('wf', '1');
  search.set('temporary-chat', 'true'); // ← 强制临时会话
  if (!search.get('relay') && typeof relay === 'string') {
    search.set('relay', relay);
  }
  const url = `${cur.origin}${cur.pathname}?${search.toString()}#${token}`;

  const name = `wf_${token}_${Date.now()}`;
  const w = window.open(url, name, 'popup=yes,width=800,height=600');
  if (w) {
    try { w.focus(); } catch {}
    setTimeout(() => { try { window.close(); } catch {} }, 120);
    return true;
  } else {
    location.assign(url);
    return true;
  }
}

function clearRelaunchFlags() {
  try { sessionStorage.removeItem(RELAUNCH_CNT_KEY); } catch {}
}

function reloadBeforeResend(reason) {
  const n = parseInt(sessionStorage.getItem(RELOAD_CNT_KEY) || '0', 10);
  if (n >= MAX_RELOADS) return false;
  sessionStorage.setItem(RELOAD_CNT_KEY, String(n + 1));
  if (reason) sessionStorage.setItem(RELOAD_REASON_KEY, reason);
  location.reload();
  return true;
}

function clearReloadFlags() {
  try {
    sessionStorage.removeItem(RELOAD_CNT_KEY);
    sessionStorage.removeItem(RELOAD_REASON_KEY);
  } catch {}
}
