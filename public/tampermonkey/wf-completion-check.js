// 模块：完成判定（自动拆分自 wf.user.js）
'use strict';

/** ─────────────── 完成判定 ─────────────── */
function isTurnStreaming(turn) {
  if (!turn) return false;
  return !!turn.querySelector('[data-testid="stop-button"],[data-testid="turn-loader"],[data-testid="spinner"],[aria-busy="true"]');
}
function hasStrictActionToolbar(turn) {
  if (!turn) return false;
  const container = turn.closest('article,[data-turn-id],[data-testid^="conversation-turn"],.agent-turn') || turn;
  const q = (sel) => container.querySelector(sel);
  const states = {
    copy:   !!q('[data-testid="copy-turn-action-button"],[aria-label*="复制"],[aria-label*="Copy"]'),
    good:   !!q('[data-testid="good-response-turn-action-button"],[aria-label*="最佳"],[aria-label*="Good"]'),
    bad:    !!q('[data-testid="bad-response-turn-action-button"],[aria-label*="错误"],[aria-label*="Bad"]'),
    share:  !!q('[aria-label*="共享"],[aria-label*="Share"]'),
    switch: !!q('[aria-label*="切换"],[aria-label*="Switch"]'),
    more:   !!q('[aria-label*="更多"],[aria-label*="More"]'),
  };
  const missing = Object.keys(states).filter(k => !states[k]).join(',');
  if (typeof hasStrictActionToolbar._last !== 'string' || hasStrictActionToolbar._last !== missing) {
    hasStrictActionToolbar._last = missing;
    console.log('[WF] hasStrictActionToolbar', missing ? ('missing: ' + missing) : 'all found ✓',
      { scope: container.getAttribute('data-turn-id') || container.getAttribute('data-testid') || container.tagName });
  }
  return Object.values(states).filter(Boolean).length >= 2;
}
function isComposerIdleWithSpeech() {
  return true;
  // return !!document.querySelector('button[data-testid="composer-speech-button"][aria-label]');
}

let lastTurnTextLen = 0;
let lastProgressSent = -1; // 已上报的最大进度
let lastTurnChangeAt = Date.now();
const QUIET_MS = 2000;

function endGateSnapshot() {
  const turn = lastAssistantTurn();
  const txt = getAssistantPlain() || '';
  const existsTurn = !!turn;
  const hasText = !!txt;

  if (hasText && txt.length !== lastTurnTextLen) {
    lastTurnTextLen = txt.length;
    lastTurnChangeAt = Date.now();
  }

  const notStreaming  = existsTurn ? !isTurnStreaming(turn) : false;
  const hasToolbar    = existsTurn ? hasStrictActionToolbar(turn) : false;
  const composerReady = isComposerIdleWithSpeech();
  const quietMs       = Date.now() - lastTurnChangeAt;
  const quietEnough   = quietMs >= QUIET_MS;

  return { existsTurn, hasText, notStreaming, hasToolbar, composerReady, quietMs, quietEnough };
}

let _lastGateLog = '';
function logEndGateIfChanged(tag='EndGate') {
  const s = endGateSnapshot();
  const line = JSON.stringify({
    existsTurn: s.existsTurn,
    hasText: s.hasText,
    notStreaming: s.notStreaming,
    hasToolbar: s.hasToolbar,
    composerReady: s.composerReady,
    quietMs: s.quietMs,
    quietEnough: s.quietEnough
  });
  if (_lastGateLog !== line) {
    _lastGateLog = line;
    console.log('[WF]', tag, line);
  }
}

function looksEnded() {
  const s = endGateSnapshot();
  logEndGateIfChanged('EndGateTick');
  const markerSeen = hasTailMarker();
  // ✅ 关键改动：出现工具条 或 看到尾标记，均可判定结束
  return (
    s.existsTurn && s.hasText && s.notStreaming && s.composerReady && s.quietEnough &&
    (s.hasToolbar || markerSeen)
  );
}
