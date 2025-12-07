// 批量名词提交/查重/startGptRunAndSubmit 一整套

(function(){
  window.__wfFlashTimers = window.__wfFlashTimers || new Map();
  let pendingGptSubmit = null;


  // ====== 1. 队列侧高亮：已在生成队列中的词条 ======
  function highlightQueueMatchesByTitles(titles, items, ttlMs = 10000) {
    const wanted = new Set((titles || []).map(t => String(t).trim()).filter(Boolean));
    const hitTokens = (items || [])
      .filter(it => wanted.has(String(it.title || '').trim()))
      .map(it => it.token);

    let first = null;
    for (const tok of hitTokens) {
      const el = document.querySelector(`#genList .item[data-token="${tok}"]`);
      if (!el) continue;
      el.classList.add('selected');
      if (!first) first = el;

      const old = window.__wfFlashTimers.get(tok);
      if (old) { clearTimeout(old); window.__wfFlashTimers.delete(tok); }
      const timer = setTimeout(() => {
        try { el.classList.remove('selected'); } catch {}
        window.__wfFlashTimers.delete(tok);
      }, ttlMs);
      window.__wfFlashTimers.set(tok, timer);
    }

    if (first) {
      try { first.scrollIntoView({ behavior:'smooth', block:'center' }); } catch(_) {}
    }
  }

  // ====== 2. 批量 Wiki 查重：对待生成词条逐个调 /api/wiki/check-duplicate ======
  // 增加 onProgress 回调：实时显示“正在查重第 N 个：xxx”
  async function checkTermsDuplicateRemote(terms, onProgress) {
    const results = [];
    const list = (terms || []).map(s => String(s || '').trim()).filter(Boolean);
    const total = list.length;

    for (let i = 0; i < list.length; i++) {
      const title = list[i];
      if (!title) continue;

      if (typeof onProgress === 'function') {
        try {
          onProgress({ index: i, total, term: title, done: false });
        } catch {}
      }

      try {
        const r = await api('/api/wiki/check-duplicate', 'POST', { title });
        const matches = Array.isArray(r?.dups) ? r.dups
                      : Array.isArray(r?.matches) ? r.matches
                      : Array.isArray(r?.items) ? r.items
                      : [];

        // 前端再做一层过滤 + Top N 截断，避免长列表撑爆弹窗
        const filtered = (matches || [])
          .filter(m => (m.similarity || 0) >= DUP_SIM_THRESHOLD)
          .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
          .slice(0, DUP_MAX_ITEMS_PER_TERM);

        if (filtered.length) {
          results.push({ term: title, matches: filtered });
        }
      } catch (e) {
        console.warn('[WF][checkTermsDuplicateRemote] fail for', title, e);
      }
    }

    if (typeof onProgress === 'function') {
      try {
        onProgress({ index: list.length, total, term: '', done: true });
      } catch {}
    }

    return results;
  }


  // ====== 3. 渲染“疑似重复词条”对话框里的列表 ======
  function renderTermDupList(dupInfo) {
    const list = document.getElementById('termDupList');
    if (!list) return;
    const base = (session.settings?.wiki_base_url || '').replace(/\/+$/, '');

    list.innerHTML = (dupInfo || []).map(row => {
      const term = esc(row.term || '');
      const matches = (row.matches || [])
        .slice()
        .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
        .slice(0, DUP_MAX_ITEMS_PER_TERM);

      const items = matches.map(m => {
        const title = esc(m.title || m.path || '');
        const path  = String(m.path || '').trim();
        const href  = path ? base + (path.startsWith('/') ? path : '/' + path) : '#';
        const sim   = Math.round((m.similarity || 0) * 100);
        return `
            <li>
              <a class="link" target="_blank" rel="noopener" href="${href}">
                ${title || '（未命名页面）'}
              </a>
              <span class="muted"> · 相似度 ${sim}%</span>
            </li>
          `;
      }).join('') || '<li class="muted">（后台未返回具体匹配列表）</li>';

      return `
        <div class="item">
          <div class="title">新词条：<strong>${term}</strong></div>
          <div class="muted" style="margin-top:4px;">疑似对应已有页面：</div>
          <ul class="muted" style="margin-top:2px; padding-left:18px;">
            ${items}
          </ul>
        </div>
      `;
    }).join('');
  }


  // ====== 4. pending 批次：有重复时，先存着，等用户点“继续生成”再真正入队 ======
  

  async function actuallyEnqueueBatch(batch) {
    if (!batch) return;
    const { toSubmit, keepInInput, base, payloadText } = batch;
    const termEl = $("#termInput");
    const msgEl  = $("#addMsg");

    const enqueueOne = async (term) => {
      const token = Math.random().toString(36).slice(2);
      const placeholder = { token, title: term, status: 'waiting', tries: 0, error_msg:'' };
      const list = $("#genList");
      list.prepend(slotRow(placeholder));
      const statusEl = document.querySelector(
        `#genList .item[data-token="${token}"] .status`
      );
      if (statusEl) statusEl.textContent = '准备中…';

      const templateText = payloadText || base.replaceAll('{名词}', term);
      const csrf = await fetch('/api/csrf').then(r=>r.json()).catch(()=>null);
      const csrfToken = csrf?.token || '';
      const res = await fetch('/api/wf/put', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ token, text: templateText, termId: null, title: term || '未命名条目' })
      });
      if (!res.ok && statusEl) statusEl.textContent = '保存失败：HTTP_'+res.status;
    };

    // 1) 真正入队
    for (const t of toSubmit) {
      await enqueueOne(t);
    }

    // 2) 更新输入框：只保留“队列里已有 / 本次重复”的
    termEl.value = keepInInput.join('\n');
    termEl.dispatchEvent(new Event('input', { bubbles:true }));

    // 3) 调度 & 刷新队列 + 小窗
    try {
      const r = await api('/api/slots','GET');
      ensureOrder(r.items||[]);
      await scheduleLaunches(r.items||[]);
      updateActiveWindowsIndicator(r.items||[]);
    } catch {}
    await loadGenList();

    // 4) 提示文案
    msgEl.className = 'smallmsg';
    if (toSubmit.length && keepInInput.length) {
      msgEl.classList.add('ok');
      msgEl.textContent =
        `已提交 ${toSubmit.length} 个；` +
        `发现 ${keepInInput.length} 个已在队列中或本次重复，` +
        `已保留在输入框并在列表中高亮。`;
    } else if (toSubmit.length) {
      msgEl.classList.add('ok');
      msgEl.textContent = `已提交 ${toSubmit.length} 个。`;
    } else {
      msgEl.textContent =
        `全部条目均已在队列中（或本次重复），未提交。` +
        `已在列表中高亮对应项。`;
    }
  }

  // ====== 5. 主入口：startGptRunAndSubmit —— 先队列查重，再 Wiki 查重 ======
  async function startGptRunAndSubmit(useForce=false, payloadText='') {
    const termEl = $("#termInput");
    const msgEl  = $("#addMsg");
    msgEl.className = 'smallmsg';
    msgEl.textContent = '';

    const raw = (termEl.value || '').replace(/\r/g, '');
    const terms = raw.split('\n').map(s => s.trim()).filter(Boolean);
    if (!terms.length) {
      showAlert('请先填写名词','提示');
      termEl.focus();
      return;
    }

    const base = getCurrentTemplate();
    if (!base.includes('{名词}')) {
      showAlert('当前模板不包含 {名词} 占位符，请在“编辑模板”中加入 {名词}','模板无效');
      return;
    }

    // --- 5.1 先读当前队列，做“生成队列内部查重” ---
    let curItems = [];
    try {
      const cur = await api('/api/slots','GET');
      curItems = cur.items || [];
    } catch {}
    const existingTitles = new Set(
      curItems.map(it => (it.title || '').trim()).filter(Boolean)
    );

    const keepInInput = [];   // 队列中已存在 / 本批重复 → 留在输入框
    const toSubmitRaw = [];   // 初筛后待提交

    for (const t of terms) {
      if (existingTitles.has(t)) keepInInput.push(t);
      else toSubmitRaw.push(t);
    }

    const seen = new Set();
    const toSubmit = [];
    for (const t of toSubmitRaw) {
      if (!seen.has(t)) {
        seen.add(t);
        toSubmit.push(t);
      } else {
        keepInInput.push(t);  // 同一批里的重复也保留
      }
    }

    if (keepInInput.length) {
      highlightQueueMatchesByTitles(keepInInput, curItems);
    }

    // 没有任何“新词条”要生成：直接走原有提示逻辑
    if (!toSubmit.length) {
      termEl.value = keepInInput.join('\n');
      termEl.dispatchEvent(new Event('input', { bubbles:true }));
      msgEl.textContent =
        `全部条目均已在队列中（或本次重复），未提交。已在列表中高亮对应项。`;
      return;
    }

    // --- 5.2 调后端 /api/wiki/check-duplicate 做 Wiki 层面的查重 ---
    msgEl.textContent = '正在向后端查重，检查可能已有的 Wiki 词条…';
    const dupInfo = await checkTermsDuplicateRemote(toSubmit, ({ index, total, term, done }) => {
      if (!msgEl) return;
      if (done) {
        msgEl.textContent = `查重完成，共检查 ${total} 个词条。`;
      } else {
        msgEl.textContent = `正在查重（${index + 1}/${total}）：${term}…`;
      }
    });

    // 没有疑似重复：直接真正入队
    if (!dupInfo.length || useForce) {
      msgEl.textContent = dupInfo.length
        ? '检测到疑似重复，但已选择强制继续生成，正在提交…'
        : '未检测到重复词条，正在提交…';
      await actuallyEnqueueBatch({ toSubmit, keepInInput, base, payloadText });
      return;
    }

    // 有疑似重复：先弹出确认对话框，让用户编辑本次要提交的列表
    pendingGptSubmit = { toSubmit, keepInInput, base, payloadText, dupInfo };
    renderTermDupList(dupInfo);

    const editBox = document.getElementById('termDupEditInput');
    if (editBox) {
      editBox.value = toSubmit.join('\n');      // 初始内容 = 本次“新词条”列表
      // 光标放到最后，方便继续编辑
      try {
        const len = editBox.value.length;
        editBox.selectionStart = editBox.selectionEnd = len;
      } catch {}
    }

    openModal("#dlgTermDup");
    msgEl.textContent =
      `检测到 ${dupInfo.length} 个疑似重复词条，` +
      `已弹出确认对话框，请根据需要删除或修改后再继续提交。`;
  }

  // “🤖 测试提交（ChatGPT）”
  $("#btnTestGpt").onclick = ()=> startGptRunAndSubmit(false);

  // ====== 6. 对话框按钮：取消 / 继续生成 ======
  document.getElementById('btnTermDupCancel')?.addEventListener('click', () => {
    pendingGptSubmit = null;
    closeModal("#dlgTermDup");
  });

  document.getElementById('btnTermDupConfirm')?.addEventListener('click', async () => {
    const batch = pendingGptSubmit;
    pendingGptSubmit = null;
    closeModal("#dlgTermDup");
    if (!batch) return;

    const msgEl = $("#addMsg");
    const editBox = document.getElementById('termDupEditInput');
    const editedRaw = (editBox && editBox.value) ? editBox.value.replace(/\r/g,'') : '';
    const editedTerms = editedRaw.split('\n').map(s => s.trim()).filter(Boolean);

    if (!editedTerms.length) {
      // 用户把所有条目都删光了，就不再提交
      if (msgEl) {
        msgEl.className = 'smallmsg';
        msgEl.textContent = '已取消：编辑后没有任何要生成的词条。';
      }
      return;
    }

    if (msgEl) {
      msgEl.className = 'smallmsg ok';
      msgEl.textContent = '已确认重复，正在根据你编辑后的词条重新提交生成任务…';
    }

    // 重新拉一次队列，基于“最新队列状态”对用户编辑后的列表再做一轮内部查重
    let curItems = [];
    try {
      const cur = await api('/api/slots','GET');
      curItems = cur.items || [];
    } catch {}

    const existingTitles = new Set(
      curItems.map(it => (it.title || '').trim()).filter(Boolean)
    );

    const keepInInputExtra = [];   // 编辑后新增的“其实已在队列中”的条目
    const toSubmitRaw2 = [];

    for (const t of editedTerms) {
      if (existingTitles.has(t)) keepInInputExtra.push(t);
      else toSubmitRaw2.push(t);
    }

    const seen2 = new Set();
    const finalToSubmit = [];
    const finalKeepInInput = [...batch.keepInInput];  // 原来保留的 + 新增的

    for (const t of toSubmitRaw2) {
      if (!seen2.has(t)) {
        seen2.add(t);
        finalToSubmit.push(t);
      } else {
        keepInInputExtra.push(t);  // 本次里用户又写重复的，也留在输入框
      }
    }

    for (const t of keepInInputExtra) {
      if (!finalKeepInInput.includes(t)) finalKeepInInput.push(t);
    }

    if (keepInInputExtra.length) {
      // 把“又被识别为已在队列中”的条目高亮一下
      highlightQueueMatchesByTitles(keepInInputExtra, curItems);
    }

    if (!finalToSubmit.length) {
      // 全部都被判定为已在队列中/重复 → 不真正入队，只更新输入框提示
      const termEl = $("#termInput");
      if (termEl) {
        termEl.value = finalKeepInInput.join('\n');
        termEl.dispatchEvent(new Event('input', { bubbles:true }));
      }
      if (msgEl) {
        msgEl.className = 'smallmsg';
        msgEl.textContent =
          `编辑后的全部条目均已在队列中（或本次重复），未提交。已在列表中高亮对应项。`;
      }
      return;
    }

    await actuallyEnqueueBatch({
      toSubmit: finalToSubmit,
      keepInInput: finalKeepInInput,
      base: batch.base,
      payloadText: batch.payloadText
    });
  });

})();

