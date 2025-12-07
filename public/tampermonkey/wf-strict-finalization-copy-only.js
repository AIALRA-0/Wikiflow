// 模块：严格终止：只能用复制文本；失败即报错（自动拆分自 wf.user.js）
'use strict';

/** ─────────────── 严格终止：只能用复制文本；失败即报错 ─────────────── */
let NO_RETRY_ON_ERROR = false;
let stopBottomPill = null;  // 供全局收尾时停止

async function finalizeIfEnded() {
  if (!looksEnded()) return false;
  await sleep(1200);
  if (!looksEnded()) return false;

  // === 新增：限流检测（进阶模式要求下，整个过程中从未出现“正在思考”条） ===
  if (ADVANCED_MODE_REQUIRED && !detectThinkingBannerOnce()) {
    // 1) 先告诉后端：这轮被限流，需要人工干预 + 串行执行
    await markState('retrying', { text: 'throttled-no-thinking-banner' });

    // 2) 通知父页进入“全局降并发”模式（并行上限改为 0 / 提示用户等）
    try { notifyParentThrottle('no-thinking-banner'); } catch (_) {}

    // 3) 同时把当前任务本身也排到队伍末尾等待重试
    try { notifyParentRequeue('throttled-no-thinking-banner'); } catch (_) {}

    // 4) 停掉本窗口的一切活动并关闭
    window.__wfFinalized = true;
    stopHBReporter();
    try { typeof stopStickyBottom === 'function' && stopStickyBottom(); } catch (_) {}
    try { typeof stopBottomPill === 'function' && stopBottomPill(); } catch (_) {}
    [0, 120, 400].forEach(ms => setTimeout(() => { try { window.close(); } catch {} }, ms));
    return true;
  }

  try {
    const md0 = await getAssistantMarkdownViaCopy();
    const md  = stripTailMarker(md0);
    PHASE = 'final';
    await markState('done', { text: md, progress: 100 });

    window.__wfFinalized = true; // ✅ 防止自闭时上报 error
    stopHBReporter();

    try { typeof stopStickyBottom === 'function' && stopStickyBottom(); } catch(_) {}
    try { typeof stopBottomPill === 'function' && stopBottomPill(); } catch(_) {}

    setTimeout(() => { try { window.close(); } catch {} }, 120);
    [300, 800, 1800].forEach(ms => setTimeout(() => { try { window.close(); } catch {} }, ms));

    clearReloadFlags();
    clearRelaunchFlags();
    console.log('[WF] finalize done');
    return true;
  } catch (e) {
    // === 尾标记存在，但复制失败时的特殊处理 ===
    if (hasTailMarker()) {
      let alreadyRefreshed = false;
      try {
        alreadyRefreshed = sessionStorage.getItem(MARKER_REFRESH_KEY) === '1';
      } catch (_) {}

      if (alreadyRefreshed) {
        // 已经做过一次“带尾标记刷新”，说明刷新也无法让 toolbar 出来 → 直接排队重试
        console.error('[WF] copy failed after marker-refresh, requeue');
        await autoRetry('copy-after-marker-failed');
        return true;
      }

      // 第一次遇到“有尾标记但 copy 失败”：记一笔，然后原地刷新 + 只复制尝试一次
      try {
        sessionStorage.setItem(MARKER_REFRESH_KEY, '1');
        sessionStorage.setItem(SKIP_SEND_KEY, '1'); // 刷新后只做采集，不再重发
        sessionStorage.setItem(RELOAD_REASON_KEY, 'render-toolbar-after-marker');
      } catch(_) {}
      RELAUNCH_OK = false; // copy-only 禁止再新开窗
      await markState('retrying', { text: 'refresh-for-toolbar-after-marker', progress: null });
      refreshInPlaceKeepUrl(); // 保留当前 /c/xxx 内部 URL
      return true; // 刷新后由 copy-only 分支再尝试一次复制
    }

    console.error('[WF] copy failed:', e);
    // 普通 copy 失败：直接排队重试
    await autoRetry('copy-failed');
    return true;
  }
}
