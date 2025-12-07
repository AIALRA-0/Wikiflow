// 模块：统一：报告并尝试多次关闭当前窗口（自动拆分自 wf.user.js）
'use strict';

/** ─────────────── 统一：报告并尝试多次关闭当前窗口 ─────────────── */
function closeWindowAndReport(reason = 'window-closed') {
  if (closeWindowAndReport._sent) return;
  closeWindowAndReport._sent = true;
  try { markStateBeacon('error', { text: reason }); } catch {}

  // 只有旧窗让位场景才主动关，避免误杀新开的子窗
  if (/^old-window/.test(reason)) {
    [30,100,250,500].forEach(ms => setTimeout(() => { try { window.close(); } catch {} }, ms));
  }
}
