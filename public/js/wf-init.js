// 入口初始化 IIFE + visibility/focus/并行度选择等全局事件


(async function init(){
  // 批量输入：自动增高 + 行数小提示
  const termEl = document.getElementById('termInput');
  if (termEl && termEl.tagName === 'TEXTAREA') {
    const autoGrow = () => {
      termEl.style.height = 'auto';
      termEl.style.height = Math.min(360, Math.max(90, termEl.scrollHeight)) + 'px';
    };
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.style.marginTop = '6px';
    termEl.insertAdjacentElement('afterend', hint);
    const updateHint = () => {
      const n = (termEl.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)).length;
      hint.textContent = n > 0 ? `将提交 ${n} 个知识点` : '';
    };
    termEl.addEventListener('input', () => { autoGrow(); updateHint(); });
    autoGrow(); updateHint();
  }
  const savedPar = getParallelLimit(); const sel = document.getElementById('selParallel'); if (sel) sel.value = String(savedPar);
  try{
    await refreshSession(); await checkWikiConnection();
    await loadJobs();
    await loadGenList();
    renderLivePreview();
    setBridgeLED('warn');      // 初始为“待测”
    oneShotPopupCheck(); // ← 启动弹窗权限轮询
  }catch(e){}

  // 首次进入未设置过时，默认关闭自动开窗（仅协调）
  if (sessionStorage.getItem('wf_coord_only') == null) {
    setCoordOnly(true);
  }
  updateCoordUI();             // 刷新“仅协调”按钮文本
  initParallelLimitSync();     // 并行上限跨标签页同步监听
})();
