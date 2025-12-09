/** ───────────── 并行上限跨标签页同步 ───────────── */
const __parChan = ('BroadcastChannel' in window) ? new BroadcastChannel('wf_parallel_sync') : null;


// 并行上限 & 跨页同步：管理 wf_parallel_limit + BroadcastChannel/localStorage 同步模板与归档
//  槽位并行上限、跨页同步、调度、重排队/救援、服务器状态上报
/** ─────────────── 并行上限 & 调度工具 ─────────────── */
// 替换原来的 getParallelLimit
function getParallelLimit() {
  const raw = localStorage.getItem('wf_parallel_limit');
  let v = (raw == null) ? 8 : Number(raw);
  if (!Number.isFinite(v)) v = 8;
  // 硬性夹到 0~8
  return Math.max(0, Math.min(8, v));
}

// 并行上限 & 跨页同步：管理 wf_parallel_limit + BroadcastChannel/localStorage 同步模板与归档

// 替换原来的 setParallelLimit：支持静默更新，避免跨页广播互相打架
function setParallelLimit(n, { silent = false } = {}) {
  const v = Math.max(0, Math.min(8, Number(n) || 0));
  localStorage.setItem('wf_parallel_limit', String(v));

  const sel = document.getElementById('selParallel');
  if (sel) sel.value = String(v);

  // 默认会通过 BroadcastChannel 推给其他标签页
  if (!silent) {
    broadcastParallelLimit(v);

    // ☆ 新增：通知后端做 SSE 广播（跨浏览器 / 设备）
    (async () => {
      try {
        await fetch('/api/wf/config-broadcast', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ parallelLimit: v }),
        });
      } catch (e) {
        console.warn('[wf] broadcast parallelLimit failed', e);
      }
    })();
  }
}


function broadcastParallelLimit(v){
  try { if (__parChan) __parChan.postMessage({ type:'parallel', value:Number(v)||0 }); } catch {}
}

// 新增：模板同步广播
function broadcastTemplate(tpl){
  try { if (__parChan) __parChan.postMessage({ type:'template', value:String(tpl || '') }); } catch {}
}


function initParallelLimitSync(){
  // 1) BroadcastChannel
  if (__parChan) {
    __parChan.onmessage = async (ev)=>{
      const d = ev?.data || {};
      if (!d || !d.type) return;

      // 并行上限跨标签同步
      if (d.type === 'parallel') {
        const v = Math.max(0, Math.min(20, Number(d.value)||0));
        // silent=true：只更新本页，不再广播回去
        setParallelLimit(v, { silent: true });
        try {
          const r = await api('/api/slots','GET'); 
          ensureOrder(r.items||[]);
          await scheduleLaunches(r.items||[]);
          updateActiveWindowsIndicator(r.items||[]);
        } catch {}
        return;
      }

      // 模板同步（第二节会用到）
      if (d.type === 'template') {
        const tpl = String(d.value || '');
        try { localStorage.setItem('wf_template', tpl); } catch {}
        const ta = document.getElementById('tplArea');
        if (ta) ta.value = tpl;
        return;
      }
    };
  }

  // 2) storage 兜底（跨窗口但同源）
  window.addEventListener('storage', async (e)=>{
    if (e.key === 'wf_parallel_limit') {
      const v = Math.max(0, Math.min(20, Number(e.newValue)||0));
      setParallelLimit(v, { silent: true });
      try {
        const r = await api('/api/slots','GET'); 
        ensureOrder(r.items||[]);
        await scheduleLaunches(r.items||[]);
        updateActiveWindowsIndicator(r.items||[]);
      } catch {}
      return;
    }

    // 模板存储跨页同步（第二节用）
    if (e.key === 'wf_template') {
      const tpl = e.newValue || '';
      const ta = document.getElementById('tplArea');
      if (ta) ta.value = tpl;
      return;
    }

    // ✅ 归档集合跨页同步
    if (e.key === 'wf_archived_tokens') {
      try {
        const raw = e.newValue || '[]';
        const arr = JSON.parse(raw);
        window.__wfArchivedTokens = new Set(arr);
      } catch {
        window.__wfArchivedTokens = new Set();
      }

      // 用最新的归档集合重新渲染队列 + 归档区
      try {
        await loadGenList();
      } catch {}
      return;
    }
  });

}