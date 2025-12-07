// 模块：思考时间：强制切到「进阶」（自动拆分自 wf.user.js）
'use strict';

/** ─────────────── 思考时间：强制切到「进阶」 ─────────────── */
// ✅ 替换原来的 getThinkingPillBtn
async function getThinkingPillBtn() {
  // ① 优先用你现在这套 DOM：.__composer-pill-composite 里面的 dropdown 按钮
  const composite = document.querySelector('.__composer-pill-composite');
  if (composite) {
    const btn = composite.querySelector('button.__composer-pill[aria-haspopup="menu"]');
    if (btn) return btn;
  }

  // ② 兼容老 UI：保留原来的选择器
  const nodes = Array.from(document.querySelectorAll(
    'button[aria-haspopup="menu"].__composer-pill, button[aria-haspopup="menu"][id^="radix-"]'
  ));

  // ③ 文案匹配
  const matchText = (el) => {
    const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return /思考时间|进阶思考\b/i.test(t);
  };

  return nodes.find(matchText) || null;
}


// 找到并打开“思考时间”菜单（只点外层检查按钮 → 弹出内层切换菜单）
async function openThinkingMenu(btn) {
  btn = btn || await waitFor(getThinkingPillBtn, { timeout: 15000, label: 'thinking-pill' });
  if (!btn) throw new Error('pill-not-found');

  // 确保可见再点
  try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
  await new Promise(r => requestAnimationFrame(r));

  if (btn.getAttribute('data-state') !== 'open') {
    // 更稳的点击序列（不传 view）
    const opts = { bubbles: true, cancelable: true, composed: true };
    try {
      if (typeof PointerEvent !== 'undefined') {
        btn.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 1 }));
        btn.dispatchEvent(new MouseEvent('mousedown',     { ...opts, buttons: 1 }));
        btn.focus?.();
        btn.dispatchEvent(new PointerEvent('pointerup',   { ...opts, buttons: 1 }));
        btn.dispatchEvent(new MouseEvent('mouseup',       { ...opts, buttons: 1 }));
        btn.dispatchEvent(new MouseEvent('click',         opts));
      } else {
        btn.dispatchEvent(new MouseEvent('mousedown', { ...opts, buttons: 1 }));
        btn.focus?.();
        btn.dispatchEvent(new MouseEvent('mouseup',   { ...opts, buttons: 1 }));
        btn.dispatchEvent(new MouseEvent('click',     opts));
      }
    } catch { try { btn.click(); } catch {} }
  }

  // 只等与该按钮配对（aria-labelledby）的菜单
  const selById = btn.id
    ? `[role="menu"][data-radix-menu-content][data-state="open"][aria-labelledby="${btn.id}"]`
    : null;

  const menu = await waitFor(() =>
    (selById && document.querySelector(selById)) ||
    document.querySelector('[role="menu"][data-radix-menu-content][data-state="open"]'),
    { timeout: 8000, label: 'thinking-menu' }
  );

  return { btn, menu };
}



// ========= 替换：更稳的“已是进阶”按钮判定 =========
function isAdvancedThinkingByButton() {
  const btns = document.querySelectorAll(
    'button.__composer-pill, button.group\\/pill, button[aria-haspopup="menu"]'
  );
  for (const b of btns) {
    const txt = (b.innerText || b.textContent || '').trim();
    if (/进阶思考/.test(txt)) return true;
    const span = b.querySelector('span');
    if (span && /进阶思考/.test(span.textContent || '')) return true;
  }
  return false;
}


// 切到“进阶”：只点内层菜单项，不误点外层检查按钮
async function ensureAdvancedThinking({ retries = 2 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      if (isAdvancedThinkingByButton())
      {
        return true;
      }
      const { menu } = await openThinkingMenu();
      const target = findAdvancedItem(menu);
      if (!target) throw new Error('advanced-item-not-found');

      // 已经是进阶则直接收起并返回
      if (isChecked(target)) {
        try { document.body.click(); } catch {}
        return true;
      }

      // 点击“进阶”
      const opts = { bubbles: true, cancelable: true, composed: true };
      try {
        target.dispatchEvent(new MouseEvent('mousedown', { ...opts, buttons: 1 }));
        target.dispatchEvent(new MouseEvent('mouseup',   { ...opts, buttons: 1 }));
        target.dispatchEvent(new MouseEvent('click',     opts));
      } catch { try { target.click(); } catch {} }

      // 等待该项 aria-checked=true（你的 DOM 会从 unchecked → checked）
      await waitFor(() => String(target.getAttribute('aria-checked') || '').toLowerCase() === 'true', {
        timeout: 3000, label: 'advanced-checked'
      });

      // 收起菜单（可选）
      try { document.body.click(); } catch {}
      return true;
    } catch (e) {
      // 关菜单再重试一次
      try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch {}
      await new Promise(r => setTimeout(r, 250));
      if (i === retries) throw e;
    }
  }
}

// ========== 重开因由收集/持久化 ==========
window.__retryReasons = window.__retryReasons || new Map();

function pushRetryReason(token, reason) {
  if (!reason) return;
  const arr = window.__retryReasons.get(token) || [];
  arr.push(String(reason));
  window.__retryReasons.set(token, arr);
  // 会话级持久化（刷新后仍在）
  try {
    const obj = {};
    window.__retryReasons.forEach((v,k)=> obj[k]=v);
    sessionStorage.setItem('wf_retry_reasons', JSON.stringify(obj));
  } catch {}
}

(function restoreRetryReasons(){
  try {
    const t = sessionStorage.getItem('wf_retry_reasons');
    if (!t) return;
    const obj = JSON.parse(t);
    window.__retryReasons = new Map(Object.entries(obj));
  } catch {}
})();

function summarizeReasons(token) {
  const arr = window.__retryReasons.get(token) || [];
  if (!arr.length) return '';
  const counter = {};
  arr.forEach(r => counter[r] = (counter[r] || 0) + 1);
  const parts = Object.entries(counter).map(([k,v]) => v>1 ? `${k}×${v}` : k);
  return ' · 重开因由：' + parts.join('、');
}


// 放在 token/relay 的旁边
function gmx(method, url, data, headers={}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    GM_xmlhttpRequest({
      method, url,
      headers: Object.assign({ 'content-type':'application/json' }, headers||{}),
      data: data != null ? (typeof data === 'string' ? data : JSON.stringify(data)) : undefined,
      onload: (res) => {
        const ms = Date.now()-t0;
        let json = null; try { json = JSON.parse(res.responseText||''); } catch {}
        log('GMX', method, url, '→', res.status, ms+'ms');
        resolve({ ok: res.status>=200 && res.status<300, status: res.status, json, text: res.responseText||'' });
      },
      onerror: (e) => {
        const ms = Date.now()-t0;
        err('GMX ERROR', method, url, e, ms+'ms');
        resolve({ ok:false, status:0, json:null, text:'' });
      }
    });
  });
}

async function waitFor(fn, { timeout=20000, interval=120, label='' }={}) {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    (function tick(){
      let v=null; try{ v=fn(); }catch{}
      if (v) return res(v);
      if (Date.now()-t0>=timeout) return rej(new Error('waitFor timeout '+label));
      setTimeout(tick, interval);
    })();
  });
}

// --- 放在工具函数区（例如 waitFor 之后、主流程之前） ---
function scrollingRoot() {
  return document.scrollingElement || document.documentElement || document.body;
}
function isAtBottom(threshold = 8) {
  const el = scrollingRoot();
  return (el.scrollHeight - el.scrollTop - el.clientHeight) <= threshold;
}
function scrollToBottomNow() {
  try {
    const el = scrollingRoot();
    el.scrollTop = el.scrollHeight; // 不用 smooth，后台也能生效
  } catch(_) {}
}

// === 额外的“保活+粘底”辅助 ===
let __wakeLock = null;
async function acquireWakeLockIfPossible() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      __wakeLock = await navigator.wakeLock.request('screen');
      __wakeLock.addEventListener?.('release', () => { __wakeLock = null; });
    }
  } catch (_) { /* 部分环境不支持 */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !__wakeLock) {
    acquireWakeLockIfPossible();
  }
}, false);

async function handleTimeoutRescue() {
  // HB 超时已经单独标红并停止，这里不再处理
  if (HB_TIMED_OUT) return;

  // 以前这里会刷新为 copy-only；在匿名模式下意义不大
  // 现在改为：直接把任务排到队伍末尾重试，由父页重新派一个新 worker
  await autoRetry('timeout-global');
}



// 固执粘底：在生成期间每隔 interval 强制把滚动条挪到底（配合你已有的 auto scroll）
function startStickyBottom({ interval = 150 } = {}) {
  let stop = false;
  (function loop() {
    if (stop) return;
    try {
      const el = document.scrollingElement || document.documentElement || document.body;
      el.scrollTop = el.scrollHeight;
    } catch(_) {}
    setTimeout(loop, interval);
  })();
  return () => { stop = true; };
}

// === 自动点击“滚动到底部/Scroll to bottom”浮动按钮（全局可用）===
let __lastBottomClick = 0;

/** 精准/宽松/兜底三层查找“回到底部”浮钮 */
function findScrollToBottomBtn() {
  // 1) testid / 明确 aria-label
  const byTestId = document.querySelector(
    '[data-testid="scroll-to-bottom-button"],' +
    '[data-testid*="scroll"][data-testid*="bottom"]'
  );
  if (byTestId) return byTestId;

  const byAria = Array.from(document.querySelectorAll('button[aria-label]'))
    .find(b => /底部|最新|回到底部|Scroll to bottom|Jump to bottom|Go to bottom/i
      .test(b.getAttribute('aria-label') || ''));
  if (byAria) return byAria;

  // 2) 类名形态（8x8、小圆钮、居底中）
  const cand = Array.from(document.querySelectorAll(
    'button.cursor-pointer.absolute,' +
    'button.cursor-pointer.fixed'
  )).find(b => {
    const c = b.className || '';
    const looksSize = /\bw-8\b/.test(c) && /\bh-8\b/.test(c);
    const looksPos  = /bottom-|\bbottom-\[/.test(c) && /(end-1\/2|translate-x-1\/2)/.test(c);
    return looksSize && looksPos && b.querySelector('svg');
  });
  if (cand) return cand;

  // 3) 兜底：匹配 SVG path 片段
  const byPath = Array.from(document.querySelectorAll('button svg path'))
    .find(p => (p.getAttribute('d') || '').includes('9.33468 3.33333'))?.closest('button');
  return byPath || null;
}

/** 若未在底部且按钮可见，则点击一次（800ms 节流） */
function clickBottomPillOnce() {
  // ⬅️ 去掉“在底部就不点”的限制；只要按钮出现就点（节流保护仍保留）
  const btn = findScrollToBottomBtn();
  if (!btn) return false;

  const now = Date.now();
  if (now - __lastBottomClick < 800) return false;
  __lastBottomClick = now;

  try {
    const opts = { bubbles: true, cancelable: true, composed: true };
    btn.dispatchEvent(new MouseEvent('mousedown', { ...opts, buttons: 1 }));
    btn.dispatchEvent(new MouseEvent('mouseup',   { ...opts, buttons: 1 }));
    btn.dispatchEvent(new MouseEvent('click',     opts));
    return true;
  } catch (_) {
    try { btn.click(); return true; } catch {}
  }
  return false;
}


/** 常驻保活器：定时点击“回到底部”浮钮 */
function startBottomPillKeeper({ interval = 400 } = {}) {
  let stop = false;
  (function loop(){
    if (stop) return;
    try { clickBottomPillOnce(); } catch {}
    setTimeout(loop, interval);
  })();
  return () => { stop = true; };
}

/** 后台友好的自动滚底：DOM变更/布局变化/恢复可见 时都触发 */
function installAutoBottomScroll() {
  let lastHeight = 0;
  let stopped = false;

  const maybeScroll = (why = '') => {
    if (stopped) return;
    const el = scrollingRoot();
    const h = el.scrollHeight || 0;

    // 高度变大或当前不在底部，就推进到底
    if (h > lastHeight || !isAtBottom()) {
      lastHeight = h;
      el.scrollTop = h;
    }
    // ⬇️ 新增：无论如何尝试点一次底部浮钮（有就点，节流在 clickBottomPillOnce 内处理）
    try { clickBottomPillOnce(); } catch {}
  };

  // 1) DOM 变更
  const mo = new MutationObserver(() => maybeScroll('mutation'));
  try {
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true, // ⬅️ 新增：监听属性变化（class/style/data-state 等）
      attributeFilter: ['class','style','data-state','aria-hidden','data-testid']
    });
  } catch (_) {}

  // 2) 布局变化
  let ro = null;
  try {
    ro = new ResizeObserver(() => maybeScroll('resize'));
    ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
  } catch (_) {}

  // 3) 切回前台补两次
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      setTimeout(() => maybeScroll('vis-0'), 0);
      setTimeout(() => maybeScroll('vis-150'), 150);
    }
  }, false);

  // 首次推进并尝试点击一次
  setTimeout(() => maybeScroll('init'), 0);

  return () => {
    stopped = true;
    try { mo.disconnect(); } catch {}
    try { ro && ro.disconnect(); } catch {}
  };
}
