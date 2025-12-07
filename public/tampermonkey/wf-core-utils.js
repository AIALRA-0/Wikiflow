// 模块：基础工具（自动拆分自 wf.user.js）
'use strict';

/** ─────────────── 基础工具 ─────────────── */
const DEBUG = true;
let PHASE = 'boot'; // boot -> picked -> running -> final
const SID = Math.random().toString(36).slice(2) + Date.now().toString(36);
let HB_SEQ = 0;
const HB_TIMEOUT_MS = 90000; //90s
let END_MARK = '';
const log  = (...a)=> DEBUG && console.log('[WF]', ...a);
const warn = (...a)=> DEBUG && console.warn('[WF]', ...a);
const err  = (...a)=> DEBUG && console.error('[WF]', ...a);

const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
const safeLower = (x)=> String(x ?? '').toLowerCase();

// ⬇️ 新增：控制是否允许“新开窗口”的总开关（copy-only 场景会关闭）
let RELAUNCH_OK = true;

// ⬇️ 新增：HB超时后硬终止（与copy流程完全隔离）
let HB_TIMED_OUT = false;
// ⬇️ 新增：记录最近一次心跳成功时间
let __lastHbOkAt = Date.now();

// 是否要求本轮必须走“进阶思考”，由 ensureAdvancedThinking() 成功后置 true
let ADVANCED_MODE_REQUIRED = false;

// 是否在本轮生成中见过“正在思考/Thinking”提示条
let SEEN_THINKING_BANNER = false;

// 检测一次“正在思考/Thinking”条，命中则记住，之后就不再依赖 DOM 是否还在
function detectThinkingBannerOnce() {
  if (SEEN_THINKING_BANNER) return true;
  try {
    const bodyText = (document.body && document.body.innerText) || '';
    if (/正在思考/.test(bodyText) || /\bThinking\b/i.test(bodyText)) {
      SEEN_THINKING_BANNER = true;
    }
  } catch (_) {}
  return SEEN_THINKING_BANNER;
}

// 当检测到被 ChatGPT 限流时，通知父页：
//  - 把并行上限调为 0
//  - 关闭所有正在生成的窗口
//  - 把这些任务全部排到队尾并提示用户手动处理
function notifyParentThrottle(reason) {
  try {
    const target = new URL(relay).origin;
    if (window.opener && typeof window.opener.postMessage === 'function') {
      window.opener.postMessage({
        type: 'WF_THROTTLE_LIMIT',
        token,
        reason,
        relay: target
      }, target);
      return true;
    }
  } catch (_) {}
  return false;
}


// ⬇️ 新增：用“当前内部 URL”原地刷新（保留 chatgpt 分配的 /c/xxx 路径）
function refreshInPlaceKeepUrl() {
  try {
    // 用 replace 避免产生历史记录，同时确保用当前完全 URL（含 /c/xxx 内部路径）
    location.replace(location.href);
  } catch (_) {
    // 兜底：仍然尝试 reload（但大多数场景 replace 已能满足诉求）
    location.reload();
  }
}

// === 几何应用：由前端下发窗口位置/大小，子页只负责执行 ===
function applyWindowGeometry({ left, top, width, height }) {
  const w = Math.max(50, Math.floor(+width  || 100));
  const h = Math.max(50, Math.floor(+height || 200));
  const x = Math.max(0,   Math.floor(+left  || 0));
  const y = Math.max(0,   Math.floor(+top   || 0));
  try {
    // 先调尺寸再挪位置，再重复一遍，提高成功率
    window.resizeTo(w, h);
    window.moveTo(x, y);
    window.moveTo(x, y);
    window.resizeTo(w, h);
  } catch (_) {}
  // 回执（可用于父页确认）
  try { window.opener?.postMessage({ type: 'WF_GEOMETRY_ACK', token, ok: true }, PARENT_ORIGIN); } catch {}
}

// 监听父页发来的几何指令（只认同源 + 同 token）
window.addEventListener('message', (ev) => {
  const d = ev.data || {};
  if (!d || ev.origin !== PARENT_ORIGIN) return;
  if (d.token !== token) return;

  // 1) 即时摆位
  if (d.type === 'WF_SET_GEOMETRY') {
    applyWindowGeometry(d);
  }

  // 2) 若需要“脚本负责开新窗”，也可让父页把几何一起传来
  if (d.type === 'WF_RELAUNCH_WITH_GEOMETRY') {
    const g = d.geometry || {};
    const cur = new URL(location.href);
    cur.searchParams.set('wf', '1');
    cur.searchParams.set('temporary-chat', 'true');
    if (!cur.searchParams.get('relay') && typeof relay === 'string') {
      cur.searchParams.set('relay', relay);
    }
    const url = `${cur.origin}${cur.pathname}?${cur.searchParams.toString()}#${token}`;
    const name = `wf_${token}_${Date.now()}`;

    const feat = [
      'popup=yes','noopener','noreferrer',
      `width=${Math.max(50, Math.floor(+g.width  || 100))}`,
      `height=${Math.max(50, Math.floor(+g.height || 200))}`,
      // 兼容不同浏览器的方位键
      `left=${Math.max(0, Math.floor(+g.left || 0))}`,
      `top=${Math.max(0, Math.floor(+g.top  || 0))}`,
      `screenX=${Math.max(0, Math.floor(+g.left || 0))}`,
      `screenY=${Math.max(0, Math.floor(+g.top  || 0))}`,
    ].join(',');

    const w = window.open(url, name, feat);
    if (w) { try { w.focus(); } catch {} }
    try { window.opener?.postMessage({ type:'WF_RELAUNCH_ACK', token, ok: !!w }, PARENT_ORIGIN); } catch {}
  }
}, false);


// 让扩展帮我“闪到前台再还原”
function askExtensionFocusFlash(flashMs = 180) {
  try {
    window.postMessage({ type: 'WF_FOCUS_FLASH', flashMs, token }, '*');
  } catch (_) {}
}
// ========= 新增：菜单项匹配辅助 =========
function normText(el) {
  return (el?.innerText || el?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
}
function isChecked(el) {
  const aria = (el.getAttribute('aria-checked') || '').toLowerCase();
  if (aria === 'true') return true;
  // radix/aria 以外的兜底
  const k = (el.getAttribute('data-state') || '').toLowerCase();
  return k === 'checked' || k === 'on' || k === 'true' || el.getAttribute('aria-current') === 'true';
}

// 兼容「思考时间/Thinking」与「思考模式」的菜单结构
function queryMenuItems(menu) {
  return Array.from(
    menu.querySelectorAll(
      '[role="menuitemradio"],[role="menuitem"],[data-radix-collection-item],button,[role="menu"] [role="menuitem"]'
    )
  );
}

// ========= 新增：查找“进阶思考/Advanced”菜单项 =========
// 在已弹出的菜单中，精确找到“进阶”项（你的 DOM 里是 role="menuitemradio" 文本=进阶）
function findAdvancedItem(menu) {
  if (!menu) return null;
  const items = Array.from(menu.querySelectorAll('[role="menuitemradio"]'));
  if (!items.length) return null;

  // 1) 文本精确等于“进阶”
  let hit = items.find(el => /^(?:\s*进阶\s*)$/.test((el.innerText || el.textContent || '').trim()));
  if (hit) return hit;

  // 2) 次优：包含“进阶”的项
  hit = items.find(el => /进阶/.test((el.innerText || el.textContent || '').trim()));
  if (hit) return hit;

  // 3) 兜底：返回最后一个未选中的单选项（常见为进阶在最后）
  const unchecked = items.filter(el => String(el.getAttribute('aria-checked') || '').toLowerCase() !== 'true');
  if (unchecked.length) return unchecked[unchecked.length - 1];

  return items[items.length - 1] || null;
}
