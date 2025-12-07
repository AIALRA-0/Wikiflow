// 模块：严格复制：必须走官方“复制整条回复”流水线（自动拆分自 wf.user.js）
'use strict';

/** ─────────────── 严格复制：必须走官方“复制整条回复”流水线 ─────────────── */
async function getAssistantMarkdownViaCopy() {
  const turn = lastAssistantTurn();
  if (!turn) throw new Error('no-assistant-turn');

  const container = turn.closest('article,[data-turn-id],[data-testid^="conversation-turn"],.agent-turn') || turn;
  let btn = container.querySelector('[data-testid="copy-turn-action-button"],[aria-label*="复制"],[aria-label*="Copy"]');
  if (!btn) {
    // 先尽力把工具条刷出来
    btn = await surfaceToolbarForCopy(turn, {budgetMs: 2600});
  }
  if (!btn) {
    // 兜底：尝试“更多 …”菜单里的复制项
    const more = container.querySelector('[aria-label*="更多"],[aria-label*="More"]');
    if (more) {
      try { more.click(); } catch {}
      await new Promise(r => setTimeout(r, 120));
      const menuItems = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"],[data-radix-collection-item]'));
      btn = menuItems.find(el => /复制.*(回复|内容)|Copy.*(response|reply|message)/i.test(el.innerText||el.textContent||''));
    }
  }
  if (!btn) throw new Error('no-copy-button');
  const clip = navigator.clipboard;
  if (!clip) throw new Error('no-clipboard-api');

  let captured = '';
  let done = false;

  const saveWriteText = typeof clip.writeText === 'function' ? clip.writeText : null;
  const saveWrite     = typeof clip.write     === 'function' ? clip.write     : null;

  function restore() {
    try { if (saveWriteText) clip.writeText = saveWriteText; } catch {}
    try { if (saveWrite)     clip.write     = saveWrite;     } catch {}
  }

  try {
    // 拦截 writeText(text)
    if (saveWriteText) {
      clip.writeText = (txt) => {
        captured = String(txt || '');
        done = true;
        return Promise.resolve(); // 不触碰系统剪贴板
      };
    }

    // 拦截 write([ClipboardItem...])
    if (saveWrite) {
      clip.write = async (items) => {
        try {
          let text = '';
          for (const it of (items || [])) {
            if (!it || !it.types) continue;
            const types = Array.from(it.types);
            const pick =
              types.includes('text/markdown') ? 'text/markdown' :
              types.includes('text/plain')    ? 'text/plain'    :
              null;
            if (!pick) continue;
            const blob = await it.getType(pick);
            text = await blob.text();
            if (text) break;
          }
          captured = String(text || captured || '');
        } catch {}
        done = true;
        return Promise.resolve(); // 同样阻断真实写剪贴板
      };
    }

    // 触发“复制整条回复”
    btn.click();

    // 等待拦截结果（把窗口加大一点以兼容异步 blob）
    const t0 = Date.now();
    const TIMEOUT_MS = 5000; // 原来是 2000，略短
    while (!done && Date.now() - t0 < TIMEOUT_MS) {
      await sleep(25);
    }

    if (!captured.trim()) throw new Error('writeText-intercept-failed');
    return captured.trim();
  } finally {
    restore();
  }
}

async function ensureToolbar(container, {timeout=1800} = {}) {
  if (!container) return null;
  
  // 1) 滚到视口中央 + 底部（多次）以触发懒渲染
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      container.scrollIntoView({ block:'center', inline:'center' });
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
    } catch (_) {}
    await new Promise(r => requestAnimationFrame(r));
  
    // 2) 合成一套悬浮/移动事件（工具条大多依赖 hover/focus）
    const opts = { bubbles:true, cancelable:true, composed:true };
    ['pointerover','pointerenter','mouseover','mouseenter','mousemove'].forEach(type=>{
      try { container.dispatchEvent(new MouseEvent(type, opts)); } catch {}
    });
  
    // 3) 已出现就返回
    const btn = container.querySelector('[data-testid="copy-turn-action-button"],[aria-label*="复制"],[aria-label*="Copy"]');
    if (btn) return btn;
  
    // 小等一会儿再试
    await new Promise(r => setTimeout(r, 80));
  }
  return null;
}

// 更激进地“把工具条刷出来”：底部循环滚动 + 强制 reflow + 再 hover
async function surfaceToolbarForCopy(turn, {budgetMs=2600} = {}) {
  const container = turn?.closest('article,[data-turn-id],[data-testid^="conversation-turn"],.agent-turn') || turn;
  if (!container) return null;

  // 第一次尝试
  let btn = await ensureToolbar(container, {timeout: 900});
  if (btn) return btn;

  // 底部循环滚动（部分页面需要真正触发 scroll）
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    try {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
      await new Promise(r => setTimeout(r, 60));
      container.scrollIntoView({ block:'end', inline:'nearest' });
    } catch (_) {}
    btn = container.querySelector('[data-testid="copy-turn-action-button"],[aria-label*="复制"],[aria-label*="Copy"]');
    if (btn) return btn;

    // 强制 reflow 一下（resize/zoom 抖一下）
    try { window.dispatchEvent(new Event('resize')); } catch {}
    try {
      const z = document.documentElement.style.zoom;
      document.documentElement.style.zoom = '1.01';
      await new Promise(r => setTimeout(r, 32));
      document.documentElement.style.zoom = z || '1';
    } catch (_) {}

    btn = await ensureToolbar(container, {timeout: 400});
    if (btn) return btn;
  }
  return null;
}
