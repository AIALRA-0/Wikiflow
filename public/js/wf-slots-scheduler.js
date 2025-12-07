// 槽位调度器：顺序/排序/并行度计算 + 救援重排队 + 状态上报

// 任务顺序登记：保证“先来先上”（FIFO）
window.__wfOrder = window.__wfOrder || new Map();      // token -> seq
window.__wfOrderSeq = window.__wfOrderSeq || 1;

function ensureOrder(items) {
  for (const it of (items||[])) {
    if (!window.__wfOrder.has(it.token)) {
      window.__wfOrder.set(it.token, window.__wfOrderSeq++);
    }
  }
}
function orderKeyOf(it) {
  return window.__wfOrder.get(it.token) || 1e12; // 未登记的放末尾
}

// 显示排序：异常最上，重试其次，进行中居中，已完成最下
function priorityOfStatus(s) {
  if (s === 'error') return 0; 
  if (s === 'picked' || s === 'running') return 1;
  if (s === 'retrying' || s === 'waiting') return 2;
  return 3; // waiting / picked / running
}
function sortItemsForDisplay(items) {
  const arr = (items||[]).slice();
  arr.sort((a,b) => {
    const pa = priorityOfStatus(a.status||'');
    const pb = priorityOfStatus(b.status||'');
    if (pa !== pb) return pa - pb;
    // 同优先级按“先来先上”
    return orderKeyOf(a) - orderKeyOf(b);
  });
  return arr;
}

// === 真实并行度：后端 picked|running ∪ 本地已开窗句柄 ===s
function computeActiveSet(items) {
  const set = new Set((items || [])
    .filter(it => /^(picked|running)$/.test(it.status || ''))
    .map(it => it.token));

  // 这里只做「句柄 GC」：把已经关闭的 window 引用清掉
  // 不要在这里删 __wfSlotOf / __wfPos，否则每次轮询都会把布局信息抹掉
  try {
    (window.__wfChildren || new Map()).forEach((w, tok) => {
      if (!w || w.closed) {
        try { window.__wfChildren.delete(tok); } catch {}
        // 槽位和坐标交给：
        //   - closeChildWindowForToken / ensureCloseWindow
        //   - loadGenList 里移除已消失的 token
        // 来回收，避免「还在生成的弹窗」被误当成垃圾清走
      }
    });
  } catch {}

  return set;
}


// （有时救援/批量后需要临时算容量）
async function computeCapacity() {
  const limit = getParallelLimit();
  try {
    const r = await api('/api/slots', 'GET');
    const active = computeActiveSet(r.items || []);
    return Math.max(0, limit - active.size);
  } catch {
    return 0;
  }
}


// ✅ 替换原函数：把状态上报统一加上高阶调试与环形日志
async function markSlotState(token, state, { text = '', progress = null } = {}) {
  // ---- 调试：环形日志（每 token 记 100 条）----
  (function debugRing() {
    window.__wfDebug = window.__wfDebug || { ring: new Map(), seq: 0 };
    const d = window.__wfDebug;
    const now = new Date().toISOString();
    const seq = ++d.seq;
    const entry = { seq, ts: now, token, state, text: String(text || '').slice(0, 240), progress };
    if (!d.ring.has(token)) d.ring.set(token, []);
    const arr = d.ring.get(token);
    arr.push(entry);
    if (arr.length > 100) arr.shift();
    try {
      console.debug('[WF][markSlotState]', { seq, ts: now, token, state, progress, text });
      const tail = arr.slice(-5).map(e => `${e.seq}@${e.ts} ${e.state}${e.progress!=null?`(${e.progress}%)`:''} :: ${e.text}`);
      console.debug('[WF][markSlotState] tail5', tail);
    } catch (_) {}
  })();

  try {
    const payload = { token, state, text };
    if (typeof progress === 'number') {
      payload.progress = Math.max(0, Math.min(100, Math.round(progress)));
    }
    const res = await fetch('/api/wf/done', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const ok = res.ok;
    if (!ok) {
      // 404 基本意味着“后端没有该任务”——忽略
      if (res.status !== 404) {
        const body = await res.text().catch(()=>'');
        console.warn('[WF][markSlotState] HTTP_FAIL', res.status, body);
      }
      return false;
    }
    return ok;
  } catch (e) {
    console.error('[WF][markSlotState] EXCEPTION', e);
    return false;
  }
}



// 避免抖动：同一 token 在救援中就不要并发重复
window.__rescueBusy = window.__rescueBusy || new Set();

// 从一个已有 slot 生成一个“全新 token”的队列条目，并删除旧条目
async function requeueSlotAsNew(oldToken, why = 'retry') {
  let slot;
  try {
    const r = await api('/api/slots/' + oldToken, 'GET');
    slot = r.slot || {};
  } catch (e) {
    console.warn('[WF][requeueSlotAsNew] get slot failed', oldToken, e);
    return null;
  }

  const payload = String(slot.text_in || '');
  const title   = String(slot.title   || '');

  if (!payload.trim()) {
    console.warn('[WF][requeueSlotAsNew] empty payload, skip', oldToken);
    return null;
  }

  const term   = title || '未命名条目';
  const newTok = Math.random().toString(36).slice(2);

  // 1) 先尽量关掉旧弹窗
  try { await ensureCloseWindow(oldToken); } catch {}

  // 2) 标记旧条目为 error，并在后端删除
  try {
    await markSlotState(oldToken, 'error', {
      text: `${why}→requeue-as-new`,
      progress: null
    });
  } catch (e) {
    console.warn('[WF][requeueSlotAsNew] mark old error failed', e);
  }

  try {
    await api('/api/slots/' + oldToken, 'DELETE', {});
  } catch (e) {
    console.warn('[WF][requeueSlotAsNew] delete old slot failed', e);
  }

  // 3) 本地清理各种状态与 UI
  try {
    cacheDel(oldToken);
    resetHBLocalState(oldToken);
    openAtDel(oldToken);

    if (window.__wfChildren)      window.__wfChildren.delete(oldToken);
    if (window.__wfOpenTs)        window.__wfOpenTs.delete(oldToken);
    if (window.__wfSlotOf)        window.__wfSlotOf.delete(oldToken);
    if (window.__wfPos)           window.__wfPos.delete(oldToken);
    if (window.__wfOrder)         window.__wfOrder.delete(oldToken);
    if (window.__wfArchivedTokens) {
      window.__wfArchivedTokens.delete(oldToken);
      saveArchivedToStorage();
    }

    // 列表里旧行直接删掉（队列 + 归档区）
    document
      .querySelectorAll(
        `#genList .item[data-token="${oldToken}"], #archiveList .item[data-token="${oldToken}"]`
      )
      .forEach(el => el.remove());
  } catch (e) {
    console.warn('[WF][requeueSlotAsNew] local cleanup failed', e);
  }

  // 4) 在前端先画一个 placeholder，体验上像“重新加入队列”
  const list = document.getElementById('genList');
  if (list) {
    const placeholder = {
      token: newTok,
      title: term,
      status: 'waiting',
      tries: 0,
      error_msg: ''
    };
    const row = slotRow(placeholder);
    const statusEl = row.querySelector('.status');
    if (statusEl) {
      statusEl.textContent = why === 'retry'
        ? '重试排队中…'
        : '重新排队中…';
    }
    list.prepend(row);
  }

  // 记录新 token 的顺序（放队尾）
  window.__wfOrder = window.__wfOrder || new Map();
  window.__wfOrderSeq = window.__wfOrderSeq || 1;
  window.__wfOrder.set(newTok, window.__wfOrderSeq++);

  // 5) 通过 /api/wf/put 注册一个真正的新 slot
  try {
    const csrf = await fetch('/api/csrf').then(r => r.json()).catch(() => null);
    const csrfToken = csrf?.token || '';

    await fetch('/api/wf/put', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrfToken
      },
      body: JSON.stringify({
        token: newTok,
        text: payload,
        termId: null,
        title: term
      })
    });
  } catch (e) {
    console.warn('[WF][requeueSlotAsNew] wf/put new slot failed', e);
  }

  return newTok;
}


// === PATCH: retry 只负责关窗 + 放队尾 + 触发调度；不再开窗 ===
// 直接替换你现有的 rescueLaunch
// === PATCH: rescue = 删除旧条目 + 按新建方式重新入队 ===
async function rescueLaunch(token, why = 'hb-watchdog') {
  // hb-timeout 仍然按“报错 + 不自动重排队”的语义
  if (why === 'hb-timeout') {
    await markSlotState(token, 'error', { text: 'hb-timeout', progress: null });
    await ensureCloseWindow(token);
    return;
  }

  if (window.__rescueBusy.has(token)) return;
  window.__rescueBusy.add(token);

  try {
    const newTok = await requeueSlotAsNew(token, why);

    // requeue 成功才触发调度
    if (newTok) {
      try {
        const r = await api('/api/slots','GET');
        ensureOrder(r.items || []);
        await scheduleLaunches(r.items || []);
      } catch (e) {
        console.warn('[WF][rescueLaunch] schedule after requeue failed', e);
      }
    }
  } finally {
    window.__rescueBusy.delete(token);
  }
}


// === PATCH: retry 只负责关窗 + 放队尾 + 触发调度；不再开窗 ===
// 直接替换你现有的 rescueLaunch
// === PATCH: rescue = 删除旧条目 + 按新建方式重新入队 ===
async function rescueLaunch(token, why = 'hb-watchdog') {
  // hb-timeout 仍然按“报错 + 不自动重排队”的语义
  if (why === 'hb-timeout') {
    await markSlotState(token, 'error', { text: 'hb-timeout', progress: null });
    await ensureCloseWindow(token);
    return;
  }

  if (window.__rescueBusy.has(token)) return;
  window.__rescueBusy.add(token);

  try {
    const newTok = await requeueSlotAsNew(token, why);

    // requeue 成功才触发调度
    if (newTok) {
      try {
        const r = await api('/api/slots','GET');
        ensureOrder(r.items || []);
        await scheduleLaunches(r.items || []);
      } catch (e) {
        console.warn('[WF][rescueLaunch] schedule after requeue failed', e);
      }
    }
  } finally {
    window.__rescueBusy.delete(token);
  }
}


// —— 完整替换：加入“仅协调模式”短路 —— //
// === 替换此函数：防止从“仅协调”切到“自动开窗”时一次性打开超量窗口 ===
async function scheduleLaunches(items) {
  // 单实例互斥，防并发重复放行
  if (window.__wfSchedLock) return;
  window.__wfSchedLock = true;

  try {
    // 先扫一遍 __wfChildren，把已关闭的句柄清掉，避免占用被高估
    try {
      (window.__wfChildren || new Map()).forEach((w, tok) => {
        try { if (!w || w.closed) window.__wfChildren.delete(tok); }
        catch { window.__wfChildren.delete(tok); }
      });
    } catch {}

    // A. 冻结/暂停场景
    if (window.__wfScheduleFreezeUntil && Date.now() < window.__wfScheduleFreezeUntil) return;
    if (window.__wfDonePauseUntil && Date.now() < window.__wfDonePauseUntil) return;

    // B. 仅协调（不自动开窗）
    if (isCoordOnly()) return;

    const limit = getParallelLimit();

    // C. 忽略致命错误条目，不要全局熔断
    const fatalTokens = new Set(
      (items || [])
        .filter(it => it.status === 'error' && /(?:closed-by-user|hb-timeout)/i.test(it.error_msg || ''))
        .map(it => it.token)
    );
    // 清理这些条目的残余窗口句柄，避免占用被高估
    try {
      (window.__wfChildren || new Map()).forEach((w, tok) => {
        if (fatalTokens.has(tok)) {
          try { w && w.close && w.close(); } catch {}
          try { window.__wfChildren.delete(tok); } catch {}
        }
      });
    } catch {}

    // D. 预留占位：跨 tick 的“准占用”，避免并发/密集触发时超放
    const reservations = (window.__wfReservations = window.__wfReservations || new Set());

    // 清理过期预留：后端已不再返回的 token 移除
    const present = new Set((items || []).map(it => it.token));
    for (const tok of Array.from(reservations)) {
      if (!present.has(tok)) reservations.delete(tok);
    }

    // E. 当前占用 = 后端 picked|running ∪ 本地已开窗句柄 ∪ 预留
    const active = computeActiveSet(items || []);
    reservations.forEach(tok => active.add(tok));

    let capacity = Math.max(0, limit - active.size);
    if (capacity <= 0) return;

    // F. 已开窗句柄（避免重复开同一 token）
    const aliveSet = new Set();
    try {
      (window.__wfChildren || new Map()).forEach((w, tok) => {
        if (w && !w.closed) aliveSet.add(tok);
      });
    } catch {}

    // PATCH C：正在关闭中的 token（由别处维护）
    const closing = window.__wfClosingTokens || new Set();

    // G. 候选队列：waiting（FIFO），排除 alive/reserved/closing
    const waiting = (items || [])
      .filter(it =>
        it &&
        it.status === 'waiting' &&
        !aliveSet.has(it.token) &&
        !reservations.has(it.token) &&
        !closing.has(it.token)
      )
      .sort((a, b) => orderKeyOf(a) - orderKeyOf(b));

    // 在文件上方某处加一个去重集合
    window.__wfRequeuedOnce = window.__wfRequeuedOnce || new Set();

    // H. status=retrying 的条目：改成“删旧建新”语义
    const retrying = [];
    for (const it of (items || [])) {
      if (
        it &&
        it.status === 'retrying' &&
        !aliveSet.has(it.token) &&
        !reservations.has(it.token) &&
        !closing.has(it.token)
      ) {
        // 每个 token 只做一次“删旧建新”，防止死循环
        if (!window.__wfRequeuedOnce.has(it.token)) {
          window.__wfRequeuedOnce.add(it.token);
          // 异步 requeue，不阻塞整个调度循环
          requeueSlotAsNew(it.token, 'server-retry').then(async (newTok) => {
            if (newTok) {
              try {
                const r2 = await api('/api/slots','GET');
                ensureOrder(r2.items || []);
                await scheduleLaunches(r2.items || []);
              } catch (e) {
                console.warn('[WF][scheduleLaunches] requeue retrying failed', e);
              }
            }
          }).catch(()=>{});
        }
        // 不再把旧条目放入 candidates
      }
    }

    const candidates = [...waiting];   // 只用 waiting，retrying 已由 requeueSlotAsNew 处理


    // I. 放行：逐个“预留→开窗→上报 picked”
    for (const it of candidates) {
      if (capacity <= 0) break;

      // 二次检查（循环内可能刚注册了新句柄）
      if (aliveSet.has(it.token) || reservations.has(it.token) || closing.has(it.token)) continue;

      // 预留占位：立刻计入占用，防止并发/连环调用超放
      reservations.add(it.token);

      // 开窗
      const w = openChildForToken(it.token);
      if (!w) {
        reservations.delete(it.token);
        continue;
      }

      try { w.focus?.(); } catch {}
      capacity--;

      // 通知后端：该 token 已被放行
      try {
        await fetch('/api/wf/done', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: it.token,
            state: 'picked',
            text: 'sched-open',
            client_ts: Date.now()
          })
        });
      } catch {}

      // 现在该 token 有窗口句柄了，预留可释放（后续通过 __wfChildren 计入占用）
      reservations.delete(it.token);

      // 轻微节流，降低密集触发时的抖动
      await delay(250);
    }
  } finally {
    window.__wfSchedLock = false;
  }
}
