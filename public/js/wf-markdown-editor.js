// Markdown 清洗/解析/预览/数学公式 + loadSlotIntoEditor

// 预览渲染 + 滚动保持（修正版：真正做到实时渲染） 
let __wfPreviewRaf = 0;
let __wfPreviewPending = '';

function renderLivePreview() {
  const html    = document.getElementById('liveHtml');
  const mdInput = document.getElementById('mdInput');
  if (!html || !mdInput) return;

  __wfPreviewPending = mdInput.value || '';

  // 已经在排队本帧渲染，就不再重复排队
  if (__wfPreviewRaf) return;
  __wfPreviewRaf = requestAnimationFrame(() => {
    const md = __wfPreviewPending || '';
    __wfPreviewPending = '';
    __wfPreviewRaf = 0;

    // 1) 结构格式化：先去掉 # 定义 区块里的二级标题
    // let safeMd = stripDefSectionSubheadings(md);
    // 2) 再做“# 定义 区块内只保留 * ** 行”的清理
    let safeMd = cleanDefSectionListLines(md);

    // 渲染前：记录滚动位置 & 是否贴底
    const prevTop = html.scrollTop;
    const prevH   = html.scrollHeight;
    const atBottom = (prevTop + html.clientHeight) >= (prevH - 4);

    // —— 渲染 ——（marked / hljs / KaTeX）
    const rawHtml = mdToHtml(safeMd);
    html.innerHTML = (window.DOMPurify ? DOMPurify.sanitize(rawHtml) : rawHtml);

    // 代码高亮类名补齐
    html.querySelectorAll('pre code').forEach(el => el.classList.add('hljs'));

    // 数学渲染
    if (window.renderMathInElement) {
      renderMathInElement(html, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$",  right: "$",  display: false }
        ],
        throwOnError: false
      });
    }

    // 图片懒加载 + 尺寸
    html.querySelectorAll('img').forEach(img => {
      img.loading = 'lazy';
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
      img.addEventListener('load', () => {
        if (atBottom) html.scrollTop = html.scrollHeight;
      });
    });

    const restoreScroll = () => {
      const newH = html.scrollHeight;
      if (atBottom) {
        html.scrollTop = newH;
      } else {
        html.scrollTop = Math.max(0, prevTop + (newH - prevH));
      }
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(restoreScroll);
    requestAnimationFrame(restoreScroll);
  });
}

// 双向滚动同步
(function syncScrollLeaderFollower() {
  const left  = document.getElementById('mdInput');
  const right = document.getElementById('liveHtml');
  if (!left || !right) return;

  let leader = null;        // 当前主导面板：left | right
  let rafId = 0;
  let idleTimer = 0;
  const IDLE_MS = 140;      // 用户停止滚动这么久后，释放主导权

  const setLeader = (el) => {
    leader = el;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { leader = null; }, IDLE_MS);
  };

  const syncOnce = () => {
    rafId = 0;
    const from = (leader === left) ? left : right;
    const to   = (from === left) ? right : left;

    const maxFrom = from.scrollHeight - from.clientHeight;
    const maxTo   = to.scrollHeight   - to.clientHeight;

    // 任一侧不可滚动则不做同步，避免把 0 同步过去造成“顶跳”
    if (maxFrom <= 0 || maxTo <= 0) return;

    const ratio = from.scrollTop / maxFrom;
    const target = Math.max(0, Math.min(maxTo, ratio * maxTo));

    // 只有差异较明显才写，避免来回抖动
    if (Math.abs(to.scrollTop - target) > 1) to.scrollTop = target;
  };

  const onScroll = (ev) => {
    if (!leader) setLeader(ev.currentTarget);
    if (leader !== ev.currentTarget) return;

    if (!rafId) rafId = requestAnimationFrame(syncOnce);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { leader = null; }, IDLE_MS);
  };

  // 用户触摸的一侧成为 leader
  ['pointerdown','touchstart','mousedown'].forEach(t => {
    left.addEventListener(t,  () => setLeader(left),  { passive: true });
    right.addEventListener(t, () => setLeader(right), { passive: true });
  });

  // 只监听滚动，不阻塞主线程
  left.addEventListener('scroll',  onScroll, { passive: true });
  right.addEventListener('scroll', onScroll, { passive: true });
})();

(function iOSBounceGuard() {
  const el = document.getElementById('mdInput');
  if (!el) return;
  let lastY = 0;
  el.addEventListener('touchstart', (e) => { lastY = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const dy = e.touches[0].clientY - lastY;
    const atTop = el.scrollTop <= 0;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    if ((atTop && dy > 0) || (atBottom && dy < 0)) e.preventDefault();
  }, { passive: false });
})();

async function loadSlotIntoEditor(token) {
  // 每次预览前先清空当前绑定，避免残留
  currentPreviewToken = null;
  try {
    const r = await api('/api/slots/' + token, 'GET');
    const slot = r.slot || {};
    let raw = slot.text_out || '';
    raw = raw.replace(/^[ \t]*WF-END#[^\r\n]*(?:\r?\n)?/gm, '');

    // 成功内容 → 写缓存
    if ((slot.status === 'done') && raw && raw.trim()) {
      cacheSet(token, raw);
    }

    // 如果后端被覆盖成 error/空 → 用缓存回退
    if ((!raw || !raw.trim()) || (slot.status === 'error')) {
      const cached = cacheGet(token);
      if (cached && cached.trim()) {
        raw = cached; // 回退为本地最后一次成功版本
        showAlert('该条服务器内容异常，已使用本地缓存副本渲染。', '已回退');
      }
    }

    if (!raw || !raw.trim()) {
      showAlert('该条目尚无可预览内容。', '无内容');
      return;
    }

    // 走到这里说明预览内容是有效的，可以绑定当前预览 token
    currentPreviewToken = token;

    $("#mdInput").value = raw;
    const { tags, body } = extractTagsAndClean(raw);
    currentTags = tags;
    $("#mdInput").value = body;
    $("#tags").innerHTML = (tags || []).map(t => `<span class="chip">${t}</span>`).join('');

    const { zhName, enFull, enAbbr } = parseMetaFromMD(raw);
    let finalTitle = '';

    // 描述仍然写英文全称
    if (enFull) $("#descInput").value = enFull;

    if (zhName) {
      // 和「解析」按钮保持一致：中文名 + （英文全称），前面可带缩写
      let title = (enAbbr && isPureAlphabet(enAbbr)) ? `${enAbbr} ${zhName}` : zhName;
      if (enFull) title += ` ${enFull}`;
      $("#titleInput").value = title;
      finalTitle = title;
    }

    // 新增：把“生成队列 / 归档区”里的标题改成主标题形式
    if (finalTitle) {
      try {
        const htmlTitle = `${esc(finalTitle)} <span class="muted">#${token.slice(0, 6)}</span>`;

        const row = document.querySelector(`#genList .item[data-token="${token}"] .title`);
        if (row) row.innerHTML = htmlTitle;

        const archRow = document.querySelector(`#archiveList .item[data-token="${token}"] .title`);
        if (archRow) archRow.innerHTML = htmlTitle;

        // 同步内存快照，避免下一次 loadGenList 又把旧标题刷回来
        if (window.__wfSlotsSnapshot && window.__wfSlotsSnapshot.has(token)) {
          const it = window.__wfSlotsSnapshot.get(token);
          window.__wfSlotsSnapshot.set(token, { ...it, title: finalTitle });
        }
      } catch (e) {
        console.warn('[WF][loadSlotIntoEditor] rename slot title failed', e);
      }
    }

    renderLivePreview();
    document.querySelector('#mdInput')?.scrollIntoView({ behavior:'smooth', block:'center' });
  } catch (e) {
    showAlert('读取槽位失败','失败');
  }
}

// --- 缓存工具 ---
const cacheKey = tok => `wf_cache_md_${tok}`;
function cacheSet(tok, text) { try { sessionStorage.setItem(cacheKey(tok), text); } catch {} }
function cacheGet(tok)      { try { return sessionStorage.getItem(cacheKey(tok)) || ''; } catch { return ''; } }
function cacheDel(tok)      { try { sessionStorage.removeItem(cacheKey(tok)); } catch {} }
function cacheClearAll()    { try {
  Object.keys(sessionStorage).forEach(k => { if (k.startsWith('wf_cache_md_')) sessionStorage.removeItem(k); });
} catch {} }


$("#mdInput").addEventListener('input', renderLivePreview);