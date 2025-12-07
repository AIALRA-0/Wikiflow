// 模块：DOM 串联函数（保留以便将来拓展，但本版不会调用）（自动拆分自 wf.user.js）
'use strict';

/** ─────────────── DOM 串联函数（保留以便将来拓展，但本版不会调用） ─────────────── */
function codeFence(lang, code) {
  const L = (lang||'').trim();
  return '```' + L + '\n' + code.replace(/\s+$/,'') + '\n```\n';
}
function getCodeLangFromClass(el) {
  const cls = (el.getAttribute('class')||'');
  const m = cls.match(/language-([a-z0-9+#.-]+)/i);
  if (m) return (m[1]||'').toLowerCase();
  const m2 = cls.match(/lang(?:uage)?-([a-z0-9+#.-]+)/i);
  if (m2) return (m2[1]||'').toLowerCase();
  const d = (el.dataset && (el.dataset.lang || el.dataset.language)) || '';
  return (d||'').toLowerCase();
}
function escapeMdText(s) { return String(s||'').replace(/\u00A0/g,' ').replace(/\s+$/,''); }
function serializeNodeToMd(node) {
  if (!node || node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  if (['button','svg','path','menu','aside'].includes(tag)) return '';
  if (tag === 'pre') {
    const code = node.querySelector('code');
    if (code) {
      const lang = getCodeLangFromClass(code);
      const text = code.textContent || '';
      return codeFence(lang, text);
    }
  }
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]) || 1;
    return `${'#'.repeat(Math.max(1, Math.min(6, level)))} ${escapeMdText(node.textContent||'')}\n\n`;
  }
  if (tag === 'p') {
    const t = escapeMdText(node.textContent||'');
    return t ? (t + '\n\n') : '';
  }
  if (tag === 'ul' || tag === 'ol') {
    const ordered = tag === 'ol';
    let idx = 1;
    let out = '';
    node.querySelectorAll(':scope > li').forEach(li=>{
      const t = escapeMdText(li.textContent||'');
      if (!t) return;
      out += ordered ? `${idx}. ${t}\n` : `- ${t}\n`;
      idx++;
    });
    return out ? (out + '\n') : '';
  }
  if (tag === 'table') {
    const rows = Array.from(node.querySelectorAll('tr'));
    if (!rows.length) return '';
    const cells = (tr)=> Array.from(tr.children||[]).map(td=>escapeMdText(td.textContent||''));
    let out = '';
    const head = node.querySelector('thead tr') || rows[0];
    const h = cells(head);
    if (h.length) {
      out += `| ${h.join(' | ')} |\n| ${h.map(()=> '---').join(' | ')} |\n`;
    }
    rows.slice(node.querySelector('thead')?1:1).forEach(tr=>{
      const r = cells(tr);
      if (r.length) out += `| ${r.join(' | ')} |\n`;
    });
    return out ? (out + '\n') : '';
  }
  let merged = '';
  node.childNodes.forEach(ch=>{
    if (ch.nodeType === 1) merged += serializeNodeToMd(ch);
    else if (ch.nodeType === 3) merged += escapeMdText(ch.textContent||'');
  });
  if (tag === 'div' || tag === 'section' || tag === 'article') {
    if (!/\n\n$/.test(merged)) merged += '\n';
  }
  return merged;
}
function getAssistantMarkdownStrict() {
  const turn = lastAssistantTurn();
  if (!turn) return '';
  const root = turn.querySelector('[data-testid="assistant-message"]') || turn.querySelector('article') || turn;
  let out = '';
  const blocks = Array.from(root.children || []);
  if (!blocks.length) {
    return serializeNodeToMd(root).trim() + '\n';
  }
  for (const b of blocks) out += serializeNodeToMd(b);
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim() + '\n';
}
const getAssistantPlain = () => {
  const t = lastAssistantTurn();
  if (!t) return '';
  const el = t.querySelector('[data-testid="assistant-message"]') ||
             t.querySelector('.markdown, .prose, article, [class*="markdown"]') || t;
  return (el.innerText || el.textContent || '').trim();
};

function hasTailMarker() {
  if (!END_MARK) return false;               // ✅ 防御
  const t = (getAssistantPlain() || '').trim();
  if (!t) return false;
  if (t.endsWith(END_MARK)) return true;
  const tail = t.slice(-Math.max(END_MARK.length + 16, 64));
  return tail.includes(END_MARK);
}

function stripTailMarker(text) {
  if (!END_MARK) return String(text||'');    // ✅ 防御
  const m = END_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text||'').replace(new RegExp(`(?:\\r?\\n)?\\s*${m}\\s*$`), '').trimEnd();
}
