// 模块：错误/掉线侦测 + 自动重试（不含 copy 失败）（自动拆分自 wf.user.js）
'use strict';

/** ─────────────── 错误/掉线侦测 + 自动重试（不含 copy 失败） ─────────────── */
const MAX_AUTO_RETRY = 2;
let autoRetries = 0;
const autoReasons = new Set();
let reported = null; // 'running'|'retrying'|'done'|'error'

const isNetworkBanner = () => {
  const text = safeLower(document.body?.innerText || '');
  return /network connection lost|attempting to reconnect/.test(text) ||
         /网络连接.*(断开|丢失)/.test(text) || /正在尝试重新连接/.test(text);
};
const hasRetryButton = () =>
  !!document.querySelector('[data-testid="regenerate-thread-error-button"]') ||
  Array.from(document.querySelectorAll('button,[role="button"]'))
    .some(b=> /^(重试|重新生成|再试一次|Regenerate|Retry)$/i.test((b.innerText||b.textContent||'').trim()));
// 新增：检测「已停止思考」状态条
const isThinkingStoppedBanner = () => {
  return !!Array.from(document.querySelectorAll('div.truncate, span.truncate, button span div'))
    .find(el => /已停止思考/.test(el.textContent || ''));
};

const isErrored = () => {
  if (document.querySelector('[data-testid="regenerate-thread-error-button"]')) return true;
  if (document.querySelector('.text-token-text-error,[data-testid="error"]')) return true;
  const txt = safeLower(getAssistantPlain());
  return /something went wrong|network error|failed to load|请重试|生成已停止/.test(txt);
};

// === 替换原 markState ===
async function markState(state, extra = {}) {
  // running 允许多次上报（用于进度），其他状态保持幂等
  if (reported === state && state !== 'running') return true;

  const body = {
    token,
    state,
    text: extra.text || '',
    // 可选数值 0~100
    progress: (typeof extra.progress === 'number')
      ? Math.max(0, Math.min(100, Math.round(extra.progress)))
      : undefined
  };

  for (let i = 0, d = 800; i < 6; i++, d = Math.min(8000, Math.round(d * 1.6))) {
    const r = await gmx('POST', `${relay}/api/wf/done`, body);
    if (r.ok) { reported = state; log('markState =>', state, { textBytes: (body.text || '').length, progress: body.progress }); return true; }
    await sleep(d);
  }
  err('markState FAIL =>', state);
  return false;
}
