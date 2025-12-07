// 模块：安装关窗上报钩子（替换原来的 pagehide 监听）（自动拆分自 wf.user.js）
'use strict';

/** ─────────────── 安装关窗上报钩子（替换原来的 pagehide 监听） ─────────────── */
function installCloseReportHooks() {
  let fired = false;
  const start = Date.now();
  const fire = (why) => {
    if (fired) return;
    if (window.__wfFinalized) return; // ✅ 终态锁
    fired = true;
    try { markStateBeacon('error', { text: why }); } catch {}
  };

  // 有些浏览器会把新开的窗口/标签置为后台，先别因此关窗
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // 打点即可；3 秒内的 hidden 视作正常抢焦/后台，不处理
      if (Date.now() - start < 3000) return;
      try { markStateBeacon('running', { text: 'window-hidden' }); } catch {}
    }
  }, false);

  window.addEventListener('pagehide',     () => fire('window-closed'),        { once: true });
  window.addEventListener('beforeunload', () => fire('window-beforeunload'),  { once: true });
}

/** ─────────────── 重试：确保旧窗先自报 & 自闭 ───────────────
 * 直接替换你脚本里原有的 autoRetry(...)
 */
async function autoRetry(reason, promptText) {
  // HB 超时是唯一不重试的情况
  if (HB_TIMED_OUT) return false;

  // ① 对某些 reason 完全不重试，直接报错
  const NO_RETRY_REASONS = new Set([
    'copy-failed',
    'copy-after-marker-failed',
    // 以后你要新增“只报错不重试”的 reason 也可以继续往里加
  ]);

  if (NO_RETRY_REASONS.has(reason)) {
    // 只上报 error，不 requeue，不再启动新 worker
    await markState('error', { text: reason });

    stopHBReporter();
    window.__wfFinalized = true;

    [0, 80, 200].forEach(ms =>
      setTimeout(() => {
        try { window.close(); } catch {}
      }, ms)
    );

    // 返回 false 表示“没有触发重试”
    return false;
  }

  // ② 其他普通错误继续走“排队重试 + 关窗”的老逻辑
  if (autoRetries >= MAX_AUTO_RETRY) return false;
  if (autoReasons.has(reason)) return false;
  autoReasons.add(reason);
  autoRetries++;

  await markState('retrying', { text: 'requeue-to-end:' + reason });

  notifyParentRequeue(reason);

  stopHBReporter();
  window.__wfFinalized = true;
  [0, 80, 200].forEach(ms =>
    setTimeout(() => {
      try { window.close(); } catch {}
    }, ms)
  );

  return true;
}
