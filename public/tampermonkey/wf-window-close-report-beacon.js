// 模块：关窗上报：sendBeacon 版（自动拆分自 wf.user.js）
'use strict';

/** ─────────────── 关窗上报：sendBeacon 版 ─────────────── */
async function markStateBeacon(state, extra = {}) {
  // 统一用 GMX，完全绕开 host 页 CSP
  try {
    const url = `${relay}/api/wf/done`;
    const payload = {
      token,
      state: (PHASE === 'running' ? 'running' : 'picked'),
      text: 'hb',
      progress: null,
      hb_mode: 'beacon',
      client_ts: Date.now(),
      sid: SID,
      seq: ++HB_SEQ
    };
    await gmx('POST', url, payload);
    return true;
  } catch { return false; }
}

// === 基于后端的 1s 心跳 ===
let __hbTimer = null;

// === 心跳：改为总是走 GM_xmlhttpRequest（gmx），避免 sendBeacon 静默丢包 ===
async function markHeartbeat() {
  try {
    const url = `${relay}/api/wf/done`;
    const payload = {
      token,
      state: (PHASE === 'running' ? 'running' : 'picked'),
      text: 'hb',
      progress: null,
      hb_mode: 'tick',   // ← 标记为“正常心跳”
      sid: SID,          // ← 此窗口ID
      seq: ++HB_SEQ      // ← 递增序号
    };
    const r = await gmx('POST', url, payload);
    if (r.ok) {
      __lastHbOkAt = Date.now();
      // 解析后端指令
      if (r.json && r.json.closeRequested) {
        window.__wfFinalized = true;  // ✅ 终态锁，防止关闭钩子误报
        stopHBReporter();
        setTimeout(() => { try { window.close(); } catch {} }, 0);
        return false;
      }
      if (r.json && r.json.focusRequested) {
        askExtensionFocusFlash(180);
      }
    }
    return !!r.ok;
  } catch (_) {
    return false;
  }
}


// === 心跳上报器：保持 1s 间隔；页面隐藏/关闭前再补打一枪（同样用 gmx） ===
function startHBReporter() {
  stopHBReporter();

  let lastTick = Date.now();
  const tick = async () => {
    const now = Date.now();
    const drift = now - lastTick;
    lastTick = now;
  
    // 漂移>2.5s 认为被节流，立刻多打一枪
    if (drift > 2500) {
      await markHeartbeat();
    }
    await markHeartbeat();

    // ✅ HB Watchdog：超过 HB_TIMEOUT_MS 未收到OK即判定HB超时 → 直接红，绝不进入copy流程
    if (!HB_TIMED_OUT && (Date.now() - __lastHbOkAt) > HB_TIMEOUT_MS) {
      HB_TIMED_OUT = true;
      window.__wfFinalized = true;
      NO_RETRY_ON_ERROR = true;         // 不触发任何自动重试/重开
      stopHBReporter();
      await markState('error', { text: 'hb-timeout' });
      [0,120,400].forEach(ms => setTimeout(()=>{ try { window.close(); } catch {} }, ms));
      return; // 直接终止tick
    }
  
    __hbTimer = setTimeout(tick, 1000); // 用 setTimeout 便于根据 drift 自适应
  };

  // 立刻来一枪，让后端立起 hb_last_at
  markHeartbeat();
  __hbTimer = setTimeout(tick, 1000);

  // 页面进入后台/关闭前补打一枪
  const once = () => { try { markHeartbeat(); } catch {} };
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden')  { markHeartbeat(); }
    if (document.visibilityState === 'visible') { // 回到前台，立刻两连
      markHeartbeat();
      setTimeout(markHeartbeat, 250);
    }
  }, false);
  window.addEventListener('pagehide', once);
  window.addEventListener('beforeunload', once);
}
function stopHBReporter() { if (__hbTimer) { clearTimeout(__hbTimer); __hbTimer = null; } }
