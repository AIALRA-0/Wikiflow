// js/marked-bridge.mjs
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';

window.marked = marked; // 暴露到全局，后面非 module 的脚本里也能用
