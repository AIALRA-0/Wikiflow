// ==UserScript==
// @name         Wikiflow ⇄ ChatGPT
// @namespace    wf.bridge
// @version      1.14.7
// @description  严格走“复制整条回复”流水线抓取 Markdown；若无法执行复制则直接报错（不触碰系统剪贴板，且不再自动刷新重试）。其余逻辑同前：自动填充并发送、掉线/错误自动重试（但不含copy失败）、二次确认严格完成判定、详细日志。
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      *
// @require      https://wikiflow.aialra.online/tampermonkey/wf-core-utils.js
// @require      https://wikiflow.aialra.online/tampermonkey/wf-thinking-advanced-mode.js
// @require      https://wikiflow.aialra.online/tampermonkey/wf-site-and-params.js
// @require      https://wikiflow.aialra.online/tampermonkey/wf-reload-before-resend.js
// @require      https://wikiflow.aialra.online/tampermonkey/wf-chatui-probes.js
// @require      https://wikiflow.aialra.online/tampermonkey/wf-compose-and-send.js
// @require      https://wikiflow.aialra.online/tampermonkey/wf-strict-copy-via-copy-button.js
// @require      https://wikiflow.aialra.online/tampermonkey/wf-dom-to-markdown-serializer.js
// @require      https://wikiflow.aialra.online/tampermonkey/wf-completion-check.js
// @require      https://wikiflow.aialra.online/tampermonkey/wf-strict-finalization-copy-only.js
// @require      https://wikiflow.aialra.online/tampermonkey/wf-error-and-auto-retry.js
// @require      https://wikiflow.aialra.online/tampermonkey/wf-window-close-report-beacon.js
// @require      https://wikiflow.aialra.online/tampermonkey/wf-window-close-wrapper.js
// @require      https://wikiflow.aialra.online/tampermonkey/wf-window-close-hooks.js
// @require      https://wikiflow.aialra.online/tampermonkey/wf-main-flow.js
// ==/UserScript==
// 所有逻辑均已拆分至 /tampermonkey 下的多个模块文件；
// 本文件仅作为 UserScript 元信息入口，请勿再在此处直接编写业务逻辑。
