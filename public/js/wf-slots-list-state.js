// 槽位状态/归档状态 + 归档/恢复/删除 + 批量清理 + 相关按钮
/**
 * @var currentTags
 * @brief 当前筛选标签集合
 * @details
 * 控制列表过滤
 * 用于界面展示
 */
let currentTags = [];

/**
 * @var currentPreviewToken
 * @brief 当前预览所对应的生成槽位 token
 * @details
 * 点击“预览”时记录，提交成功且开启自动清理时用于删除对应槽位
 */
let currentPreviewToken = null;

/**
 * @var window.__wfArchivedTokens
 * @brief 前端 UI 级“归档”集合（只在浏览器里记，不改后端状态）
 */
window.__wfArchivedTokens = window.__wfArchivedTokens || new Set();

/**
 * @var window.__wfSlotsSnapshot
 * @brief 最近一次 /api/slots 的快照，按 token 快速查状态
 */
window.__wfSlotsSnapshot = window.__wfSlotsSnapshot || new Map();

/** 归档集合持久化（可选） */
function loadArchivedFromStorage(){
  try {
    const raw = localStorage.getItem('wf_archived_tokens');
    if (!raw) return;
    const arr = JSON.parse(raw);
    window.__wfArchivedTokens = new Set(arr);
  } catch {}
}

loadArchivedFromStorage();

function saveArchivedToStorage(){
  try {
    const arr = Array.from(window.__wfArchivedTokens || []);
    localStorage.setItem('wf_archived_tokens', JSON.stringify(arr));
  } catch {}
}

function getSlotByToken(token){
  return window.__wfSlotsSnapshot?.get(token) || null;
}


/**
 * @function archiveSlot
 * @brief 将一个“已完成”的槽位归档到归档区（仅前端）
 */
async function archiveSlot(token) {
  const it = getSlotByToken(token);
  if (!it || it.status !== 'done') {
    showAlert('只有“已完成”的条目才能归档','无法归档');
    return;
  }
  window.__wfArchivedTokens.add(token);
  saveArchivedToStorage();
  await loadGenList();   // 重新渲染队列 + 归档区
}

/**
 * @function restoreSlot
 * @brief 将归档区中的槽位还原回生成队列（仅前端）
 */
async function restoreSlot(token) {
  if (!window.__wfArchivedTokens.has(token)) return;
  window.__wfArchivedTokens.delete(token);
  saveArchivedToStorage();
  await loadGenList();
}


/**
 * @function deleteSlotByToken
 * @brief 关闭并删除指定生成槽位
 * @param token 槽位令牌
 * @returns Promise<boolean> 是否删除成功
 * @details
 * 复用单条删除逻辑，供按钮点击和提交成功后自动清理使用
 */
async function deleteSlotByToken(token) {
  // 先请求子页自闭（后端下发关闭指令），再尝试本地句柄关闭
  try { await requestChildClose(token); } catch {}
  const closed = await closeChildWindowForToken(token, { timeoutMs: 1200 });
  if (!closed) {
    showAlert('未能自动关闭生成窗口，已取消删除。请先手动关闭弹窗后再试。', '窗口未关闭');
    return false;
  }

  // 标记并删除
  try { await markSlotState(token, 'error', { text: 'deleted-by-user', progress: null }); } catch {}
  try { await api('/api/slots/' + token, 'DELETE', {}); } catch {}

  cacheDel(token);

  if (window.__wfArchivedTokens) {
    window.__wfArchivedTokens.delete(token);
    saveArchivedToStorage();
  }
  window.__wfScheduleFreezeUntil = Date.now() + 1500;
  await loadGenList();

  // 如果当前预览正好来源于该 token，则同步清空绑定
  if (currentPreviewToken === token) {
    currentPreviewToken = null;
  }
  return true;
}

async function safeBatchDelete(predicate, { scopeName = '批量清理', timeoutMs = 1200 } = {}) {
  try {
    const r = await api('/api/slots','GET');
    const items = (r.items || []).filter(predicate);
    window.__wfScheduleFreezeUntil = Date.now() + 1200 + (items.length * 200);

    let failed = 0;
    const archSet = window.__wfArchivedTokens || new Set();

    for (const it of items) {
      // 先请求子页自闭
      try { await requestChildClose(it.token); } catch {}
      // 再本地确认关闭
      const closed = await closeChildWindowForToken(it.token, { timeoutMs });
      if (!closed) {
        failed++;
        try { await markSlotState(it.token, 'error', { text:'cannot-close-on-delete', progress:null }); } catch {}
        continue;
      }

      let deleted = false;
      try {
        await api('/api/slots/' + it.token, 'DELETE', {});
        deleted = true;
      } catch (e) {
        failed++;
        console.warn('delete failed', it.token, e);
      }

      // ✅ 若删除成功，把归档集合里的对应 token 一并移除
      if (deleted) {
        archSet.delete(it.token);
      }

      cacheDel(it.token);
      await delay(120); // 留一点窗口期，避免信号混叠
    }

    // ✅ 将归档集合的变更落盘
    saveArchivedToStorage();

    window.__wfScheduleFreezeUntil = Date.now() + 1500;
    await loadGenList();

    if (failed > 0) showAlert(`${scopeName}：有 ${failed} 条未能确认关闭，已标红保留，请手动关闭对应子窗口后再清理。`, '部分未清理');
  } catch (e) {
    showAlert(`${scopeName}失败：` + (e.message||e.error||''), '失败');
  }
}

// 清除“已完成”
// 清除“已完成”
$("#btnGenClearDone").onclick = async () => {
  const ok = confirm('确认清除所有“已完成”的生成条目吗？\n该操作会尝试关闭相关弹窗，并从列表中移除，且不可撤销。');
  if (!ok) return;
  await safeBatchDelete(it => it.status === 'done', { scopeName: '清除已完成' });
};

// 清除“全部”
$("#btnGenClearAll").onclick  = async () => {
  const ok = confirm('⚠️ 确认清除“全部”生成条目吗？\n包括排队中、生成中、异常和已完成，且不可撤销。');
  if (!ok) return;
  await safeBatchDelete(_ => true, { scopeName: '清除全部' });
};

// 清除“未完成”（进行中、排队、异常；仅保留 done）
$("#btnGenClearUnfinished").onclick = async () => {
  const ok = confirm('确认清除所有“未完成”的生成条目吗？\n将保留“已完成”，其余都会尝试关闭并移除。');
  if (!ok) return;
  await safeBatchDelete(it => it.status !== 'done', { scopeName: '清除未完成' });
};

document.getElementById('btnArchiveClear')?.addEventListener('click', () => {
  if (!window.__wfArchivedTokens || !window.__wfArchivedTokens.size) return;
  const ok = confirm(`确认清空归档区中的 ${window.__wfArchivedTokens.size} 个条目吗？这只会影响前端界面，不会删除服务器中的任务。`);
  if (!ok) return;
  window.__wfArchivedTokens.clear();
  saveArchivedToStorage();
  const list = document.getElementById('archiveList');
  if (list) list.innerHTML = '';
});
