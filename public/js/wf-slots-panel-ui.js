// updateActiveWindowsIndicator + slotMini 小窗 + selParallel 下拉 + visibility/focus 自动刷新

/* ── 槽位占用小窗渲染（修正版） ───────────────────────────── */
// - 数字：正在运行的任务数 / 并行上限
// - 格子：按行优先（1 2 3 4 / 5 6 7 8）对应 slot index
// - 并行上限 < 8 时，只画对应数量的格子
async function renderSlotMini(items) {
  const box   = document.getElementById('slotMini');
  const cells = document.getElementById('slotMiniCells');
  const numEl = document.getElementById('slotMiniNum');
  const meta  = document.getElementById('slotMiniMeta');
  if (!box || !cells || !numEl || !meta) return;

  // 没传 items 的时候自己拉一遍，保证函数可独立工作
  if (!Array.isArray(items) || items.length === 0) {
    try {
      const r = await api('/api/slots', 'GET');
      items = r.items || [];
    } catch {
      items = [];
    }
  }

  // 并行上限（0~8）——0 视为“只协调”，UI 上当 8 处理
  const rawLimit = Math.max(0, getParallelLimit());
  const VIS_MAX  = 8;
  const slotCap  = rawLimit > 0 ? Math.min(rawLimit, VIS_MAX) : VIS_MAX;

  // GC 一下窗口句柄
  try { computeActiveSet(items); } catch {}

  const slotOf   = window.__wfSlotOf   || new Map();
  const children = window.__wfChildren || new Map();

  const ACTIVE_RE = /^(picked|running)$/;

  // 后端视角：真正“在跑”的任务数（不管本页开没开窗）
  const activeTokens = (items || []).filter(it => ACTIVE_RE.test(it.status || ''));
  const activeCount  = activeTokens.length;

  // 本页视角：有弹窗的槽位 index（0..slotCap-1）
  const occupiedSlots = new Set();
  try {
    children.forEach((w, tok) => {
      if (!w || w.closed) return;
      let idx = slotOf.get(tok);
      if (idx == null) return;
      idx = Number(idx);
      if (!Number.isFinite(idx) || idx < 0) return;
      if (idx >= slotCap) idx = slotCap - 1; // 兜底
      occupiedSlots.add(idx);
    });
  } catch {}

  // 当前页没开任何弹窗，但后端有 active 任务 → 用前 N 个槽位占位
  if (occupiedSlots.size === 0 && activeCount > 0) {
    const n = Math.min(activeCount, slotCap);
    for (let i = 0; i < n; i++) occupiedSlots.add(i);
  }

  // ===== 关键：强制 grid 按“行优先”填充 0,1,2,3 / 4,5,6,7 =====
  cells.innerHTML = '';

  const cols = Math.min(4, slotCap || 1);
  cells.style.display = 'grid';
  cells.style.gridTemplateColumns = `repeat(${cols}, 14px)`;
  cells.style.gridAutoRows = '14px';
  cells.style.gridAutoFlow = 'row';  // ★★ 强制按行填充 ★★
  cells.style.gap = '6px';

  // slotIdx = 0..slotCap-1，依次 append：
  // 0 1 2 3
  // 4 5 6 7
  for (let slotIdx = 0; slotIdx < slotCap; slotIdx++) {
    const cell = document.createElement('span');
    cell.className = 'cell' + (occupiedSlots.has(slotIdx) ? ' full' : '');
    cells.appendChild(cell);
  }

  const denom = rawLimit > 0 ? rawLimit : slotCap;
  numEl.textContent = `${activeCount}/${denom}`;

  const queued = (items || []).filter(
    it => it && (it.status === 'waiting' || it.status === 'retrying')
  ).length;
  meta.textContent = `队列 ${queued}`;

  box.style.display = 'block';
}


//  genList / archiveList 列表 UI + 归档/删除/预览按钮 + SSE + 小窗 slotMini
async function updateActiveWindowsIndicator(items) {
  try { await renderSlotMini(items); } catch {}
}

/* 覆盖占用指示入口：调度/并行上限变化时都会触发到这里 */
window.updateActiveWindowsIndicator = updateActiveWindowsIndicator;



// 下拉变化：仅更新上限，不打断当前，等待收敛后调度
document.getElementById('selParallel')?.addEventListener('change', async (e) => {
  const v = Number(e.target.value || '10');
  // setParallelLimit 内部已经写 localStorage + 广播给其他页面
  setParallelLimit(v);

  try {
    const r = await api('/api/slots','GET');
    ensureOrder(r.items||[]);
    await scheduleLaunches(r.items||[]);
    updateActiveWindowsIndicator(r.items||[]);
  } catch {}
});


// === 页面恢复可见 / 获取焦点 时自动刷新 ===
window.addEventListener('visibilitychange', ()=> {
  if (document.visibilityState === 'visible') {
    try { loadGenList(); } catch {}
  }
});

window.addEventListener('focus', ()=> {
  try { loadGenList(); } catch {}
});
