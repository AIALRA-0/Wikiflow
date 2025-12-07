// 模块：填写 & 发送（自动拆分自 wf.user.js）
'use strict';

/** ─────────────── 填写 & 发送 ─────────────── */
async function fillPrompt(text) {
  const editor = await waitFor(getComposer, { label:'editor' });
  editor.focus();
  if (editor.tagName === 'TEXTAREA') {
    editor.value = text;
    editor.dispatchEvent(new Event('input', { bubbles:true }));
  } else {
    const html = '<p>' + String(text)
      .replace(/[&<>]/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))
      .replace(/\r\n/g,'\n').replace(/\r/g,'\n')
      .split('\n').map(s=>s||'&nbsp;').join('</p><p>') + '</p>';
    editor.innerHTML = html;
    try {
      editor.dispatchEvent(new InputEvent('beforeinput', { bubbles:true, cancelable:true, inputType:'insertText', data:text }));
    } catch {}
    editor.dispatchEvent(new Event('input', { bubbles:true }));
  }
}

async function clickSend() {
  const btn = await waitFor(getSendButton, { label:'send-button' }).catch(()=>null);
  if (btn) {
    btn.click();
    log('clicked send-button');
    return;
  }
  const editor = getComposer();
  if (editor) {
    editor.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', bubbles:true}));
    log('send via Enter fallback');
  } else {
    throw new Error('no composer to send');
  }
}
