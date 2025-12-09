// 列表渲染 + SSE + 轮询 + 行点击事件（genList/archiveList）

let __wfLoadGenBusy = false;
let __wfLoadGenPending = false;

/**
 * @function genLedClass
 * @brief 依据状态与重试次数返回指示灯样式名
 *
 * @param status 状态标识
 * @param tries 重试次数
 * @returns 样式名字符串
 *
 * @details
 * 异常返回错误样式
 * 完成返回正常样式
 * 发生过重试优先使用重试样式
 * 运行与取出与排队使用警告样式
 * 未匹配时回退警告样式
 */
function genLedClass(status, tries = 0){
  if (status === 'error') return 'err';
  if (status === 'done')  return 'ok';

  if (status === 'waiting' || status === 'retrying') return 'queue'; // 队列态同色
  if (/^(running|picked)$/.test(status||'')) {
    return (tries > 0) ? 'retry' : 'warn'; // 仅运行态且有过重试 → 黄色“重试”
  }
  return 'warn';
}

function buildStatusText(it) {
  const base = statusMap[it.status] || it.status || '';

  const msg = it.error_msg || '';
  const isRequeueMsg = /requeue-to-end/i.test(msg) || /requeue[-→]tail/i.test(msg);

  const triesPart =
    (it.tries && it.tries > 0 && !isRequeueMsg)
      ? ` · 重试${it.tries}次`
      : '';

  const msgPart =
    (msg && !isRequeueMsg)
      ? ' · ' + esc(msg)
      : '';

  return base + triesPart + msgPart;
}

function slotRow(item, { archived = false } = {}) {
  const e = document.createElement('div');
  e.className = 'item';
  e.dataset.token = item.token;

  const title = item.title || '(未命名)';
  const inProgress = /^(waiting|picked|running|retrying)$/.test(item.status || '');
  const isDone = item.status === 'done';

  const p = /^(waiting|retrying)$/.test(item.status || '') ? 0 : Number(item.progress || 0);

  // ===== 归档按钮逻辑修正 =====
  // - 生成队列：只有 done 才显示“归档”按钮
  // - 归档区：始终显示“还原”按钮
  let archiveBtnHtml = '';
  if (archived) {
    // 归档区：还原按钮
    archiveBtnHtml = `
      <button class="btn sm ghost" data-act="restore" data-token="${item.token}">
        还原
      </button>
    `;
  } else if (isDone) {
    // 生成队列：只对 done 显示“归档”
    archiveBtnHtml = `
      <button class="btn sm ghost" data-act="archive" data-token="${item.token}">
        归档
      </button>
    `;
  }
  // ===== 归档按钮逻辑修正结束 =====

  e.innerHTML = `
    <div class="row" style="justify-content:space-between; width:100%; align-items:center;">
      <div class="row" style="gap:8px; min-width:0;">
        <div class="led ${genLedClass(item.status, item.tries || 0)} ${/^(running|picked)$/.test(item.status || '') ? 'pulse' : ''}" id="slotLed-${item.token}" title="${item.status || ''}"></div>
        <div>
          <div class="title">${esc(title)} <span class="muted">#${item.token.slice(0, 6)}</span></div>
          <div class="status muted" id="slotStatus-${item.token}">
            ${(statusMap[item.status] || item.status || '')}${(item.tries ?? 0) > 0 ? ` · 重试${item.tries}次` : ''}${item.error_msg ? ' · ' + esc(item.error_msg) : ''}
          </div>
          <div class="pp" id="pp-${item.token}">
            <span class="mono" id="pp-ppc-${item.token}">heart beat</span>
            <span class="mono" id="pp-age-${item.token}">—s idle</span>
          </div>
        </div>
      </div>
      <div class="row" style="gap:10px; flex-wrap:nowrap;">
        <div class="bar sm" style="width:180px; min-width:180px;"><i id="slotBar-${item.token}" style="width:${p}%;"></i></div>
        <button class="btn sm" data-act="preview" data-token="${item.token}" ${inProgress ? 'disabled' : ''}>
          ${inProgress ? '生成中…' : '预览'}
        </button>
        ${archiveBtnHtml}
        <button class="btn sm ghost" data-act="del" data-token="${item.token}">删除</button>
      </div>
    </div>
  `;
  return e;
}


function updateArchiveUI(items) {
  const list = document.getElementById('archiveList');
  if (!list) return;

  const arch = window.__wfArchivedTokens || new Set();
  const map  = new Map((items || []).map(it => [it.token, it]));

  // ✅ 只在“仍然存在且状态不是 done”时，从归档集合里移除
  //    不再因为暂时没回到 items 里就清掉归档，避免刷新时误丢归档信息
  for (const tok of Array.from(arch)) {
    const it = map.get(tok);
    if (it && it.status !== 'done') {
      arch.delete(tok);
    }
  }
  saveArchivedToStorage();

  const archItems = Array.from(arch)
    .map(tok => map.get(tok))
    .filter(Boolean)
    .sort((a, b) => orderKeyOf(a) - orderKeyOf(b));

  list.classList.add('no-anim');

  const existing = new Map(
    Array.from(list.querySelectorAll('.item')).map(el => [el.dataset.token, el])
  );
  const seen = new Set();
  let anchor = null;

  for (const it of archItems) {
    seen.add(it.token);
    let row = existing.get(it.token);
    const needCreate = !row;

    if (!row) {
      row = slotRow(it, { archived: true });
    } else {
      // 以下保留你原来的“局部刷新”逻辑
      const led = row.querySelector('.led');
      if (led) {
        led.className = `led ${genLedClass(it.status, it.tries || 0)} ${
          /^(running|picked)$/.test(it.status || '') ? 'pulse' : ''
        }`;
        led.title = it.status || '';
      }

      const titleEl = row.querySelector('.title');
      if (titleEl) {
        titleEl.innerHTML =
          `${esc(it.title || '(未命名)')} ` +
          `<span class="muted">#${it.token.slice(0, 6)}</span>`;
      }

      const st = row.querySelector('.status');
      st.textContent = buildStatusText(it);


      const bar = row.querySelector(`#slotBar-${it.token}`);
      if (bar) {
        const pRaw =
          it.status === 'waiting' || it.status === 'retrying'
            ? 0
            : it.progress || 0;
        bar.style.width =
          Math.max(0, Math.min(100, pRaw)) + '%';
      }
    }

    if (needCreate) {
      list.insertBefore(row, anchor ? anchor.nextSibling : list.firstChild);
    } else {
      const actualPrev = row.previousElementSibling;
      if (actualPrev !== anchor) {
        list.insertBefore(row, anchor ? anchor.nextSibling : list.firstChild);
      }
    }
    anchor = row;
  }

  existing.forEach((el, token) => {
    if (!seen.has(token)) el.remove();
  });

  list.classList.remove('no-anim');
}


/**
 * @function loadGenList
 * @brief 轮询生成槽位并驱动父页行级更新与子窗维护
 *
 * @details
 * 拉取与构建
 * 调用接口获取槽位集合
 * 建立现有节点映射并记录可见条目
 * 对不存在的条目新增行
 * 对已存在的条目原地更新
 *
 * 可视与数据
 * 刷新指示灯与标题与状态文本
 * 更新进度条
 * 同步心跳信息条
 *
 * 子窗管理
 * 终态触发多轮关闭以保证回收
 * 重试态可按策略聚焦或重开并记录冷却
 * 错误态命中可救援关键字后触发一次救援式重开
 *
 * 桥接信号
 * 只要存在进行态则点亮桥接指示灯
 *
 * 垃圾回收
 * 移除后端不存在的行并尝试关闭对应子窗
 * 同步清理本地时间记录
 *
 * 轮询控制
 * 存在进行态则保持一秒轮询
 * 无进行态则停止轮询
 * 捕获异常后指数回退至上限并继续调度
 *
 * 副作用
 * 操作全局轮询句柄
 * 修改列表容器
 * 打开与关闭子窗口
 * 写入冷却表与本地存储
 */
// PATCH D: loadGenList 单飞 / 去重



async function loadGenList() {
  if (__wfLoadGenBusy) { __wfLoadGenPending = true; return; }
  __wfLoadGenBusy = true;

  const AUTO_OPEN_ON_RETRYING = true;
  try {
    const r = await api('/api/slots','GET');
    const items = (r.items || []);

    // 记录快照（供归档/还原用）
    window.__wfSlotsSnapshot = new Map(items.map(it => [it.token, it]));

    const archSet = window.__wfArchivedTokens || new Set();

    // === 队列视图：把已归档 token 过滤掉（只在归档区出现）===
    const queueItems = items.filter(it => !archSet.has(it.token));

    // 排序逻辑仍然沿用
    ensureOrder(items);
    const forRender = sortItemsForDisplay(queueItems);

    const list = $("#genList");
    list.classList.add('no-anim');

    const existing = new Map(
      Array.from(list.querySelectorAll('.item')).map(el => [el.dataset.token, el])
    );
    const seen = new Set();

    let anchor = null;
    for (const it of forRender) {
      seen.add(it.token);
      let row = existing.get(it.token);
      const needCreate = !row;
      if (!row) row = slotRow(it);

      // 刷新 UI
      const led = row.querySelector('.led');
      led.className = `led ${genLedClass(it.status, it.tries || 0)} ${/^(running|picked)$/.test(it.status || '') ? 'pulse' : ''}`;
      led.title = it.status || '';

      const titleEl = row.querySelector('.title');
      titleEl.innerHTML = `${esc(it.title || '(未命名)')} <span class="muted">#${it.token.slice(0,6)}</span>`;

      const st = row.querySelector('.status');
      st.textContent = buildStatusText(it);


      const btn = row.querySelector('button[data-act="preview"]');
      const inProgress = /^(waiting|picked|running|retrying)$/.test(it.status || '');
      btn.disabled = inProgress;
      btn.textContent = inProgress ? '生成中…' : '预览';

      const bar = row.querySelector(`#slotBar-${it.token}`);
      if (bar) {
        const pRaw = (it.status === 'waiting' || it.status === 'retrying') ? 0 : (it.progress || 0);
        bar.style.width = Math.max(0, Math.min(100, pRaw)) + '%';
      }

      // ✅ 动态补/移除“归档”按钮：状态变成 done 时立即出现
      const existingArchiveBtn = row.querySelector('button[data-act="archive"]');
      const existingRestoreBtn = row.querySelector('button[data-act="restore"]'); // 理论上队列里不会有，但防御一下
      const btnBarWrap = btn && btn.parentElement; // 右侧按钮区域容器
        
      if (it.status === 'done') {
        // 队列视图：done 且未归档 → 显示“归档”按钮
        if (!existingArchiveBtn && !existingRestoreBtn && btnBarWrap) {
          const delBtn = row.querySelector('button[data-act="del"]');
          const archBtn = document.createElement('button');
          archBtn.className = 'btn sm ghost';
          archBtn.dataset.act = 'archive';
          archBtn.dataset.token = it.token;
          archBtn.textContent = '归档';
        
          if (delBtn && delBtn.parentElement === btnBarWrap) {
            btnBarWrap.insertBefore(archBtn, delBtn);
          } else {
            btnBarWrap.appendChild(archBtn);
          }
        }
      } else {
        // 非 done 状态时，防止误留归档按钮
        if (existingArchiveBtn) {
          existingArchiveBtn.remove();
        }
      }
    

      updateHBUIFromServer(it);

      if (needCreate) {
        list.insertBefore(row, anchor ? anchor.nextSibling : list.firstChild);
      } else {
        const actualPrev = row.previousElementSibling;
        if (actualPrev !== anchor) {
          list.insertBefore(row, anchor ? anchor.nextSibling : list.firstChild);
        }
      }
      anchor = row;

      if ((it.status === 'done' || it.status === 'error')) {
        await ensureCloseWindow(it.token);
      }

      if (it.status === 'done' && !window.__wfSeenDone?.has(it.token)) {
        window.__wfSeenDone = window.__wfSeenDone || new Set();
        window.__wfSeenDone.add(it.token);
        const now = Date.now();
        window.__wfDonePauseUntil = Math.max(window.__wfDonePauseUntil || 0, now + 10_000);
      }

      if (
        it.status === 'error' &&
        /pull-payload-failed/i.test(it.error_msg || '') &&
        !window.__wfPull404Rescued?.has(it.token)
      ) {
        window.__wfPull404Rescued = window.__wfPull404Rescued || new Set();
        window.__wfPull404Rescued.add(it.token);
        await rescueLaunch(it.token, 'pull-404');
      }

      if (it.status === 'retrying' && !window.__wfMovedToTail?.has(it.token)) {
        window.__wfOrder.set(it.token, window.__wfOrderSeq++);
        window.__wfMovedToTail.add(it.token);
      }
    }

    // 渲染归档区（用全部 items）
    updateArchiveUI(items);

    // 删除队列里已不存在的 DOM 行
    existing.forEach((el, token) => {
      if (!seen.has(token)) {
        if (window.__wfChildren?.has(token)) {
          try {
            const w = window.__wfChildren.get(token);
            if (w && !w.closed) w.close();
          } catch {}
          window.__wfChildren.delete(token);
        }
        el.remove();
        openAtDel(token);
        try { window.__wfSlotOf?.delete(token); } catch {}
        try { window.__wfPos?.delete(token); } catch {}
      }
    });

    const now = Date.now();
    const freezeUntil = window.__wfScheduleFreezeUntil || 0;
    if (now >= freezeUntil) {
      await scheduleLaunches(items);
    }

    try { await updateActiveWindowsIndicator(items); } catch {}

    const hasBridgeActive = items.some(it => /^(picked|running|retrying)$/.test(it.status || ''));
    if (hasBridgeActive) setBridgeLED('ok');

    if (genPoller) { clearTimeout(genPoller); genPoller = null; }
    const hasActive = items.some(it => /^(waiting|picked|running|retrying)$/.test(it.status || ''));
    genInterval = hasActive ? 1000 : 0;
    if (hasActive) genPoller = setTimeout(loadGenList, genInterval);

  } catch(e) {
    if (genPoller) { clearTimeout(genPoller); genPoller = null; }
    genInterval = Math.min(8000, Math.round((genInterval || 1000) * 1.6));
    genPoller = setTimeout(loadGenList, genInterval);
  } finally {
    const list = $("#genList");
    list.classList.remove('no-anim');
    __wfLoadGenBusy = false;
    if (__wfLoadGenPending) { __wfLoadGenPending = false; queueMicrotask(loadGenList); }
  }
}


// === [SSE] 实时同步 slots 变更（手机提交→电脑秒刷） ===
function connectSlotsSSE() {
  if (window.__esSlots) return; // 单例
  try {
    function handleWfConfig(ev) {
      let data = {};
      try {
        data = JSON.parse(ev.data || '{}');
      } catch (e) {
        console.warn('[wf] parse wf-config failed', ev.data);
        return;
      }
    
      // 并行上限：silent = true，避免再触发广播 & POST
      if (typeof data.parallelLimit === 'number') {
        setParallelLimit(data.parallelLimit, { silent: true });
      
        // 收到新的并行上限后，重排一下队列（跟 BroadcastChannel 分支保持一致）
        (async () => {
          try {
            const r = await api('/api/slots', 'GET');
            ensureOrder(r.items || []);
            await scheduleLaunches(r.items || []);
            updateActiveWindowsIndicator(r.items || []);
          } catch (e) {
            console.warn('[wf] refresh slots after parallelLimit update failed', e);
          }
        })();
      }
    
      // 模板
      if (typeof data.template === 'string') {
        const tpl = data.template;
        try {
          localStorage.setItem('wf_template', tpl);
        } catch (_) {}
      
        const ta = document.getElementById('tplArea');
        if (ta) ta.value = tpl;
      }
    }

    const es = new EventSource('/api/slots/stream', { withCredentials: true });
    window.__esSlots = es;

    es.addEventListener('hello', () => {});
    es.addEventListener('ping',  () => {});

    es.addEventListener('slots_changed', async () => {
      try {
        await loadGenList();               // 原有逻辑：刷新列表
        await updateActiveWindowsIndicator(); // ✅ 同步刷新小窗
      } catch {}
    });

    es.addEventListener('wf-config', handleWfConfig);

    es.onerror = () => {
      try {
        if (es.readyState === EventSource.CLOSED) {
          window.__esSlots = null;
        }
      } catch {}
    };
  } catch {}
}



// 生成队列里点“删除”
async function handleSlotListClick(ev) {
  const b = ev.target.closest('button'); 
  if (!b) return;
  if (b.disabled) return;

  const token = String(b.dataset.token || '');
  const act = b.dataset.act;

  if (act === 'del') {
    const ok = confirm(
      '确认删除这个生成槽位吗？\n' +
      '将尝试关闭对应弹窗，并把该条目标记为已删除/错误，从队列中移除。'
    );
    if (!ok) return;
    await deleteSlotByToken(token);
    return;
  }

  if (act === 'preview') {
    return void loadSlotIntoEditor(token);
  }

  if (act === 'archive') {
    await archiveSlot(token);
    return;
  }

  if (act === 'restore') {
    await restoreSlot(token);
    return;
  }

  if (act === 'focus') {
    try { await pokeFocus(token); } catch {}
    const relayBase = getRelayBase();
    const url = buildChatUrl(relayBase, token);
    let w = window.__wfChildren.get(token);
    if (!w || w.closed) {
      w = openChildForToken(token);
      if (w) window.__wfChildren.set(token, w);
    }
    try { w?.focus(); } catch {}
    return;
  }
}

// 生成队列 + 归档区都用同一个 handler
document.getElementById('genList')?.addEventListener('click', handleSlotListClick);

document.getElementById('archiveList')?.addEventListener('click', handleSlotListClick);

