// 模块：ChatUI probes（自动拆分自 wf.user.js）
'use strict';

/** ─────────────── ChatUI probes ─────────────── */
const getComposer = () =>
  document.querySelector('#prompt-textarea, .ProseMirror[contenteditable="true"], [data-testid="composer-textarea"] textarea,[contenteditable="true"][data-virtualkeyboard="true"]');

const getSendButton = () =>
  document.querySelector('button[data-testid="send-button"]:not([disabled]), form button[type="submit"]:not([disabled])');

const isStreaming = () =>
  !!document.querySelector('[data-testid="stop-button"],[data-testid="turn-loader"],[aria-label="停止"],[data-testid="spinner"]');

function lastAssistantTurn() {
  const containers = Array.from(document.querySelectorAll(
    'article[data-turn="assistant"], ' +
    '[data-testid^="conversation-turn"][data-turn="assistant"], ' +
    '[data-turn-id][data-turn="assistant"]'
  ));
  if (containers.length) return containers[containers.length - 1];

  const bubbles = Array.from(document.querySelectorAll(
    '[data-message-author-role="assistant"], [data-message-id][data-role="assistant"]'
  ));
  if (!bubbles.length) return null;
  const last = bubbles[bubbles.length - 1];
  return last.closest('article,[data-turn-id],[data-testid^="conversation-turn"],.agent-turn') || last;
}
