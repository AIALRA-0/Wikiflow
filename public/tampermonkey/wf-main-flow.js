// 模块：主流程（自动拆分自 wf.user.js）
'use strict';

/** ─────────────── 主流程 ─────────────── */
if (typeof WF_SHOULD_RUN === 'undefined' || WF_SHOULD_RUN) {
(async function main() {
  
  async function tryCopyOnlyThenFallback(payload) {
    // 只复制模式：给它 30s 尝试复制当前页面已有的回复
    const T = 30000, t0 = Date.now();
    await markState('running', { text: 'copy-only-mode' });
  
    const stopPillTmp = startBottomPillKeeper({ interval: 350 });
    try {
      while (Date.now() - t0 < T) {
        if (await finalizeIfEnded()) return true;
        await sleep(600);
      }
    } finally {
      try { stopPillTmp && stopPillTmp(); } catch {}
    }
  
    // 走到这里说明：刷新+只复制仍然拿不到内容
    // 在匿名模式下继续刷新只会反复失败，因此直接把任务排到队伍末尾重试
    await autoRetry('copy-only-timeout', payload);
    return true;
  }

  const stopIfStreaming = () => {
    const stopBtn = document.querySelector('[data-testid="stop-button"]');
    if (stopBtn) {
      console.log('[WF] Detected early streaming, stopping...');
      stopBtn.click();
    }
  };
  // 前3秒内每隔300ms检查一次，防止页面自跑
  let guardTimer = setInterval(stopIfStreaming, 300);
  setTimeout(() => clearInterval(guardTimer), 3000);
  const prevReason = sessionStorage.getItem(RELOAD_REASON_KEY);
  const skipSend = sessionStorage.getItem(SKIP_SEND_KEY) === '1';
  if (skipSend) {
    try { sessionStorage.removeItem(SKIP_SEND_KEY); } catch(_) {}
    RELAUNCH_OK = false; // ⬅️ 新增
  }
  if (skipSend) { try { sessionStorage.removeItem(SKIP_SEND_KEY); } catch(_) {} }
  if (prevReason) {
    if (/^relaunch:/i.test(prevReason)) {
      await markState('running', { text: 'after-relaunch' });
    } else {
      await markState('retrying', { text: 'after-reload: ' + prevReason });
      if (/copy-only/i.test(prevReason)) RELAUNCH_OK = false; // ⬅️ 新增：copy-only 来源
    }
    sessionStorage.removeItem(RELOAD_REASON_KEY);
  }

  // 尽早向后端宣告“已打开窗口”，并开始心跳（从窗口打开计时的配套）
  PHASE = 'picked';
  await markState('picked', { text: 'child-opened' });
  startHBReporter(); // 允许先打心跳，但心跳别把状态抬到 running（见下）


  // 尽早注册关窗钩子
  installCloseReportHooks();
  const stopAutoBottom = installAutoBottomScroll();

  // 1) 拉 payload
  let payload = '';
  try {
    const RELAY = String(relay || '').replace(/\/$/, '');
    const r = await gmx('GET', `${RELAY}/api/wf/get?token=${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error('HTTP_' + r.status);
    const data = r.json || {};
    payload = data.text || data.payload || (data.data && (data.data.text || data.data)) || '';
    payload = String(payload || '');
    payload += `

    **生成完成标记（系统指令）**
    当且仅当你已完成全部内容（包括参考文献/链接/表格等）后，请在最后一行单独输出：${END_MARK}
    不要在该行前后输出任何其他字符。不要解释这条指令。
    `;
    log('payload bytes=', payload.length);
    clearInterval(guardTimer);
    } catch (e) {
      await markState('error', { text: 'pull-payload-failed: ' + (e.message || e) });
      const didReload = reloadBeforeResend('pull-payload-failed');
      clearReloadFlags();
    
      // 如果已经没有更多 reload 机会，就把任务排到队伍末尾重试
      if (!didReload) {
        await autoRetry('payload-failed');
      }
      return;
    }

  // 2) 首发
  if (!skipSend) {
    // 2) 首发
    try {
      await ensureAdvancedThinking(); // ← 先切进阶
      ADVANCED_MODE_REQUIRED = true;  // 本轮任务应该出现“正在思考”提示
      await markState('picked', { text: 'thinking-mode=advanced' });
    } catch (e) {
      // 不再在这里直接 error，而是排到队伍末尾重试
      await autoRetry('thinking-mode-failed', payload);
      return;
    }
  
    try {
      await fillPrompt(payload);
      await markState('running');
      startHBReporter();
      await clickSend();
      PHASE = 'running';
      await markState('running', { text: 'sent' });
      // 保活 & 粘底
      try { acquireWakeLockIfPossible(); } catch(_) {}
      var stopStickyBottom = startStickyBottom({ interval: 120 });
      stopBottomPill = startBottomPillKeeper({ interval: 350 });
      } catch (e) {
        await markState('error', { text: 'first-send-failed: ' + (e.message || e) });
        const didReload = reloadBeforeResend('first-send-failed');
        clearReloadFlags();
      
        // reload 次数用完依然失败，就 requeue
        if (!didReload) {
          await autoRetry('first-send-failed');
        }
        return;
      }
  } else {
    // 刷新回来的“只采集模式”：别再发一次
    PHASE = 'running';
    startHBReporter();
    await tryCopyOnlyThenFallback(payload);
  }


  // 3) 监听
  const observer = new MutationObserver(async () => {
    // 顺手检测一次“正在思考/Thinking”条
    detectThinkingBannerOnce();
    // 进度计算并上报（每提升至少 5%）
    try { clickBottomPillOnce(); } catch {}
    const snap = endGateSnapshot();
    const steps = [
      snap.existsTurn,
      snap.hasText,
      snap.notStreaming,
      snap.hasToolbar,
      snap.composerReady,
      snap.quietEnough
    ];
    const doneCount = steps.filter(Boolean).length;
    const p = Math.floor((doneCount / steps.length) * 95);
    if (p > lastProgressSent && p < 100) {
      await markState('running', { text: 'progress', progress: p });
      lastProgressSent = p;
    }

    try {
      if (reported === 'done' || reported === 'error') return;

      if (isThinkingStoppedBanner()) {
        log('detected: thinking-stopped banner');
        await autoRetry('stopped-thinking', payload);
        return;
      }

      if (isNetworkBanner()) {
        log('detected: network banner');
        await autoRetry('network-lost', payload);
        return;
      }

      if (!isStreaming() && (isErrored() || hasRetryButton())) {
        log('detected: error card / retry button');
        await autoRetry('error-retry', payload);
        return;
      }

      if (await finalizeIfEnded()) return;
    } catch (e) {
      warn('MO handler err:', e);
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true, // ⬅️ 新增
    attributeFilter: ['class','style','data-state','aria-hidden','data-testid']
  });

  // 4) 轮询兜底（最长 25 分钟）
  const t0 = Date.now();
  while (Date.now() - t0 < 1500000) { // 25 * 60 * 1000
    if (reported === 'done' || reported === 'error') break;
  
     if (isThinkingStoppedBanner()) {
      await autoRetry('stopped-thinking', payload);
      break;
    }

    if (isNetworkBanner()) {
      await autoRetry('network-lost', payload);
    } else if (!isStreaming() && (isErrored() || hasRetryButton())) {
      await autoRetry('error-retry', payload);
    }
  
    if (await finalizeIfEnded()) break;
    await sleep(700);
  }

  // —— 到点仍未收尾：先走“刷新为 copy-only 的拯救流程” —— //
  if (reported !== 'done' && reported !== 'error') {
    await handleTimeoutRescue();
    return; // 刷新后由 copy-only 分支接手
  } else if (reported === 'error') {
    stopHBReporter(); // ✅ error 收尾
    try { typeof stopStickyBottom === 'function' && stopStickyBottom(); } catch(_) {}
    try { typeof stopBottomPill === 'function' && stopBottomPill(); } catch(_) {}
  }



  try { observer.disconnect(); } catch {}
  log('done. final =', reported);
})(); // ✅ IIFE 结束
}

// ========= 辅助：每分钟“抖前台/悬停”一遍，提升后台时的刷新概率 =========
(function installMinuteNudger(){
  const hoverOnce = ()=>{
    try {
      const turn = lastAssistantTurn();
      if (!turn) return;
      const container = turn.closest('article,[data-turn-id],[data-testid^="conversation-turn"],.agent-turn') || turn;
      const btn = container.querySelector('[data-testid="copy-turn-action-button"]') || container;
      const opts = { bubbles:true, cancelable:true, composed:true };
      ['pointerover','mouseover','mousemove'].forEach(type=>{
        try { btn.dispatchEvent(new MouseEvent(type, opts)); } catch {}
      });
    } catch (_) {}
  };
  setInterval(()=>{
    if (PHASE === 'running') {
      // 1) 请求扩展闪到前台再还原（若存在）
      askExtensionFocusFlash(180);
      // 2) 模拟一次悬停，促使工具条/懒渲染刷新
      hoverOnce();
    }
  }, 60000);
})();
