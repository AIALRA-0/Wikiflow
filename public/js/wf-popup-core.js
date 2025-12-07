//  ChatGPT 弹窗打开/关闭/定位 + 与子页的 postMessage 协议

// === 级联弹窗参数（保持宽度固定；高度按槽位递减）===
const POPUP_W = 150;
const POPUP_H = 400;
const POPUP_GAP = 10;
const POPUP_BASE_X = 40;
const POPUP_BASE_Y = 40;

// 高度策略：第 0 槽 1000px，此后每个槽位 -40px；并做屏幕可视高度夹取
const POPUP_H_MAX  = 1000;
const POPUP_H_STEP = 40;
const POPUP_H_MIN  = 320;   // 给个下限，避免太小

// 方向：只下移 10px。如果想“向上”，把 DIR 改成 -1
const SLOT_DIR = 1;

// === 垂直插槽：token -> slotIndex（0..n-1）===
window.__wfSlotOf = window.__wfSlotOf || new Map();

window.__wfPos     = window.__wfPos     || new Map(); // token -> {left, top}
window.__wfOpenSeq = window.__wfOpenSeq || 0;



// === 新增：获取当前显示器边界（支持副屏负坐标）===
function getCurrentMonitorBounds(){
  const s = window.screen || {};
  // Chrome/Edge 支持 availLeft/availTop；Safari/旧版用 screenLeft/screenTop 兜底
  const left   = Number.isFinite(s.availLeft) ? s.availLeft
                : (typeof window.screenLeft === 'number' ? window.screenLeft : 0);
  const top    = Number.isFinite(s.availTop) ? s.availTop
                : (typeof window.screenTop  === 'number' ? window.screenTop  : 0);
  const width  = Number.isFinite(s.availWidth)  ? s.availWidth
                : (typeof window.outerWidth  === 'number' ? window.outerWidth  : 1280);
  const height = Number.isFinite(s.availHeight) ? s.availHeight
                : (typeof window.outerHeight === 'number' ? window.outerHeight : 800);
  return { left, top, right: left + width, bottom: top + height, width, height };
}
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// 替换原来的 heightFromSlot：固定 400 高
function heightFromSlot(/*idx*/) {
  return 400;
}


// 替换原来的 posFromSlot：网格布局（2 行 × 4 列）
function posFromSlot(idx){
  const b = getCurrentMonitorBounds();

  const W = 200;             // 固定宽
  const H = 400;             // 固定高
  const GAP = 10;

  const COLS = 4;            // 4 列
  const ROWS = 2;            // 2 行（共 8 槽）

  const i = Math.max(0, Number(idx) || 0) % (COLS * ROWS);
  const col = i % COLS;
  const row = Math.floor(i / COLS);

  let left = b.left + POPUP_BASE_X + col * (W + GAP);
  let top  = b.top  + POPUP_BASE_Y + row * (H + GAP);

  left = clamp(left, b.left,  b.right  - W - 10);
  top  = clamp(top,  b.top,   b.bottom - H - 10);

  return { left, top };
}

// 仅统计“仍然活着的弹窗”的槽位占用；避免历史映射长期占坑
function collectOccupiedSlots() {
  const occ = new Set();
  try {
    const slotOf = window.__wfSlotOf || new Map();
    // 以“分配过的槽位映射”为准；真正关闭时我们会清理该映射
    slotOf.forEach((idx) => {
      if (idx != null) occ.add(idx);
    });
  } catch {}
  return occ;
}


// === PATCH: allocPopupPos 防止“全占满”时的死循环（不改变网格布局） ===
function allocPopupPos(token){
  // 已有位置/槽位 → 直接返回
  if (window.__wfPos.has(token)) return window.__wfPos.get(token);
  if (window.__wfSlotOf.has(token)) {
    const pos = posFromSlot(window.__wfSlotOf.get(token));
    window.__wfPos.set(token, pos);
    return pos;
  }

  const rawLimit = getParallelLimit();
  // 仍沿用你把 0 夹成 1 的策略（保证网格 0..limit-1 存在），
  // 但后续加 try 次数保护 + 全满兜底，避免 while 无限自旋。
  const limit = Math.max(1, Number(rawLimit) || 1);

  const occupied = collectOccupiedSlots();   // 仍是你原先的“已分配就算占位”的策略
  let slot;

  if (occupied.size < limit) {
    // 正常路径：在有限步内找一个未占用的槽位
    slot = 0;
    let tries = 0;                           // ← 关键：最多尝试 limit 次，避免 while 死循环
    while (occupied.has(slot) && tries < limit) {
      slot = (slot + 1) % limit;
      tries++;
    }
    // 如果尝试 limit 次仍然命中占用（极小概率；比如 occupied 被外部并发扩容）
    if (occupied.has(slot)) {
      window.__wfOpenSeq = (window.__wfOpenSeq || 0) + 1;
      slot = (window.__wfOpenSeq - 1) % limit;  // 兜底复用
    }
  } else {
    // 兜底路径：所有 0..limit-1 都被标占用时，按递增序列复用槽位编号
    // 这不会改变你的网格布局，只决定落在“哪一个格子”
    window.__wfOpenSeq = (window.__wfOpenSeq || 0) + 1;
    slot = (window.__wfOpenSeq - 1) % limit;
  }

  window.__wfSlotOf.set(token, slot);
  const pos = posFromSlot(slot);
  window.__wfPos.set(token, pos);
  return pos;
}

function getRelayBase(){
  return new URL('.', location.href).toString().replace(/\/$/, '');
}

/**
 * @function withTemporaryChat
 * @brief 为受信主机追加临时会话参数
 *
 * @param urlLike 可解析的地址
 * @returns 返回处理后的地址字符串
 *
 * @details
 * 解析为统一地址对象
 * 针对受信域追加临时会话参数
 * 非受信域保持原值
 */
function withTemporaryChat(urlLike){
  if (!urlLike) return urlLike;
  // 跳过这些 scheme：保持 about:blank / data: / blob: / 扩展页原样打开
  if (/^(about:blank|javascript:|data:|blob:|chrome-extension:)/i.test(urlLike)) return urlLike;
  const u = new URL(urlLike, location.origin);
  if (u.hostname.endsWith('chatgpt.com') || u.hostname.endsWith('chat.openai.com')) {
    u.searchParams.set('temporary-chat', 'true');
  }
  return u.toString();
}

/**
 * @function buildChatUrl
 * @brief 生成聊天地址并携带桥接参数与令牌
 *
 * @param relayBase 中继基址
 * @param token 槽位令牌
 * @returns 完整地址字符串
 *
 * @details
 * 设定工作标志与目标模型
 * 携带中继来源与临时会话标志
 * 将令牌置入片段以便子页读取
 */
function buildChatUrl(relayBase, token) {
  const u = new URL('https://chatgpt.com/');
  u.searchParams.set('wf', '1');
  u.searchParams.set('model', 'gpt-5-1-thinking');
  u.searchParams.set('relay', relayBase);
  u.searchParams.set('temporary-chat', 'true');   // 关键参数
  if (token) u.hash = String(token);
  return u.toString();
}

function countAliveWindows() {
  let k = 0;
  try {
    (window.__wfChildren || new Map()).forEach(w => { if (w && !w.closed) k++; });
  } catch {}
  return k;
}


// 替换原来的 openChildForToken：固定 200×400
function openChildForToken(token) {
  if (isCoordOnly()) return null;

  try {
    const existed = window.__wfChildren?.get(token);
    if (existed && !existed.closed) { existed.focus?.(); return existed; }
  } catch {}

  const relayBase = getRelayBase();
  const url = buildChatUrl(relayBase, token);
  const name = `wf_${token}`;

  const { left, top } = allocPopupPos(token);

  const w = window.open(
    url,
    name,
    `popup=yes,width=${POPUP_W},height=${POPUP_H},left=${left},top=${top}`
  );
  if (w) {
    try { w.moveTo(left, top); w.resizeTo(POPUP_W, POPUP_H); } catch {}
    try { w.focus?.(); } catch {}
    window.__wfChildren = window.__wfChildren || new Map();
    window.__wfChildren.set(token, w);

    window.__wfOpenTs = window.__wfOpenTs || new Map();
    const now = Date.now();
    window.__wfOpenTs.set(token, now);
    openAtSet(token, now);
  }
  return w;
}


// 用“仅复制”参数重开新窗（不二次生成）
// 替换原来的 openCopyOnlyWindow：固定 200×400
function openCopyOnlyWindow(token) {
  if (isCoordOnly()) return false;

  const base = getRelayBase();
  const u = new URL(buildChatUrl(base, token));
  u.searchParams.set('wf_copy_only', '1');
  const name = `wf_${token}_copy_${Date.now()}`;

  const { left, top } = allocPopupPos(token);

  const w = window.open(
    u.toString(),
    name,
    `popup=yes,width=${POPUP_W},height=${POPUP_H},left=${left},top=${top}`
  );
  if (w) {
    try { w.moveTo(left, top); w.resizeTo(POPUP_W, POPUP_H); } catch {}
    try { w.focus?.(); } catch {}
    window.__wfChildren?.set(token, w);
    window.__wfOpenTs = window.__wfOpenTs || new Map();
    const now = Date.now();
    window.__wfOpenTs.set(token, now);
    openAtSet(token, now);
    return true;
  }
  return false;
}

/**
 * @function pokeFocus
 * @brief 向后端发送子窗聚焦请求
 * @param token 令牌
 * @details
 * 通过接口转发
 * 驱动子窗获取焦点
 */
async function pokeFocus(token) {
  try { await api('/api/wf/poke','POST',{ token, action:'focus' }); } catch {}
}

/**
 * @function requestChildClose
 * @brief 向后端发送子窗关闭请求
 * @param token 令牌
 * @details
 * 通过接口转发
 * 驱动子窗主动关闭
 */
async function requestChildClose(token) {
  try { await api('/api/wf/poke','POST',{ token, action:'close' }); } catch {}
}





// PATCH A: 带“正在关闭”标记与清理的关窗实现
// PATCH: 只有弹窗真的关闭，才清理 __wfSlotOf/__wfPos，避免新任务顶到同一槽位造成遮挡
// ✅ 只有弹窗真的关闭，才清理 __wfSlotOf/__wfPos，避免新任务顶到同一槽位造成遮挡
async function closeChildWindowForToken(token, { timeoutMs = 800 } = {}) {
  window.__wfClosingTokens.add(token);

  const h = window.__wfChildren?.get(token);
  if (!h) {
    try { window.__wfChildren?.delete(token); } catch {}
    try { window.__wfOpenTs?.delete(token); } catch {}
    try { window.__wfSlotOf?.delete(token); } catch {}
    try { window.__wfPos?.delete(token); } catch {}
    window.__wfClosingTokens.delete(token);
    return true;
  }

  try { h.close(); } catch {}
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!h || h.closed) break;
    await new Promise(r => setTimeout(r, 60));
    try { h.close(); } catch {}
  }

  const actuallyClosed = (!h || h.closed) === true;

  if (actuallyClosed) {
    try { window.__wfChildren.delete(token); } catch {}
    try { window.__wfOpenTs?.delete(token); } catch {}
    try { window.__wfSlotOf?.delete(token); } catch {}
    try { window.__wfPos?.delete(token); } catch {}
  }

  window.__wfRelaunchGateUntil.set(token, Date.now() + RELAUNCH_GATE_MS);
  window.__wfClosingTokens.delete(token);
  return actuallyClosed;
}

async function ensureCloseWindow(token, retries = [80, 160, 360, 800, 1600]) {
  // 本地关闭句柄 + 小退避
  for (const ms of retries) {
    const closed = await closeChildWindowForToken(token, { timeoutMs: 300 });
    if (closed) return true;
    await new Promise(r => setTimeout(r, ms));
  }
  return false;
}


// 重新把 payload 写回 wfStore（清除 kill），并重开该 token 的子窗
async function reseedAndOpen(token) {
  try {
    const r = await api('/api/slots/' + token, 'GET');
    const slot = r.slot || {};
    const payload = String(slot.text_in || '');
    const title   = String(slot.title   || '');

    if (!payload.trim()) return false;

    // 重灌：置回 waiting（去掉 kill 等）
    const csrf = await fetch('/api/csrf').then(r=>r.json()).catch(()=>null);
    await fetch('/api/wf/put', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf?.token || '' },
      body: JSON.stringify({ token, text: payload, title })
    });

    // 严格限流：只有在有容量时才立即开窗；否则交给调度器稍后放行
    const cap = await computeCapacity();
    if (cap > 0) {
      const w = openChildForToken(token);
      try { w?.focus(); } catch {}
    }
    return true;
  } catch (e) {
    console.warn('[WF][reseedAndOpen] failed:', e);
    return false;
  }
}

// === PATCH: 仅把条目放回 waiting（不打开窗口） ===
// 放在 reseedAndOpen 之后位置，便于共用思路
async function reseedToWaiting(token) {
  try {
    const r = await api('/api/slots/' + token, 'GET');
    const slot = r.slot || {};
    const payload = String(slot.text_in || '');
    const title   = String(slot.title   || '');
    if (!payload.trim()) return false;

    const csrf = await fetch('/api/csrf').then(r=>r.json()).catch(()=>null);
    await fetch('/api/wf/put', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf?.token || '' },
      body: JSON.stringify({ token, text: payload, title })
    });
    return true;
  } catch (e) {
    console.warn('[WF][reseedToWaiting] failed:', e);
    return false;
  }
}


// === Copy-only 恢复：父页 → 子页 ===
// 发送“刷新并仅复制”的指令（子页会设置 SKIP_SEND 并自刷新）
function tellChildRefreshCopyOnly(token) {
  const w = window.__wfChildren?.get(token);
  if (!w || w.closed) return false;
  try {
    // ChatGPT 两域都投一次，谁命中谁处理
    const msg = { type: 'WF_REFRESH_COPY_ONLY', token, relay: getRelayBase() };
    w.postMessage(msg, 'https://chatgpt.com');
    w.postMessage(msg, 'https://chat.openai.com');
    return true;
  } catch (_) { return false; }
}



/**
 * @event message
 * @brief 父页接收重开请求并执行严格重开
 * @details
 * 验证来源为受信域
 * 校验令牌与回跳域
 * 应用冷却限制
 * 先尝试关闭旧窗并移除句柄
 * 构建地址并打开新窗 保存句柄与时间
 * 刷新列表并更新桥接指示灯
 */
// PATCH B: 处理 WF_RELAUNCH_REQUEST 时加“正在关闭”与熔断闸门，并避免在 coord-only / 无容量 时盲目开窗
window.addEventListener('message', async (ev) => {
  const okOrigin = ev.origin === 'https://chatgpt.com' || ev.origin === 'https://chat.openai.com';
  if (!okOrigin) return;

  const d = ev.data || {};
  if (d.type !== 'WF_RELAUNCH_REQUEST') return;
  if (!d.token || !d.relay || d.relay !== location.origin) return;

  const tok = String(d.token);

  // 1) 正在关闭 → 忽略此次重开请求
  if (window.__wfClosingTokens.has(tok)) return;

  // 2) 熔断窗口内 → 忽略
  const gateUntil = window.__wfRelaunchGateUntil.get(tok) || 0;
  if (Date.now() < gateUntil) return;

  // 3) 仅协调模式 → 不开窗（交给调度器稍后放行）
  if (isCoordOnly()) return;

  // 4) 若没有容量，不立刻开窗（避免瞬间开关导致风暴）；交给调度器
  const cap = await (async () => {
    try {
      const r = await api('/api/slots','GET');
      const active = computeActiveSet(r.items || []);
      return Math.max(0, getParallelLimit() - active.size);
    } catch { return 0; }
  })();
  if (cap <= 0) {
    // 短暂熔断，避免子页持续 spam
    window.__wfRelaunchGateUntil.set(tok, Date.now() + 1500);
    return;
  }

  // 5) 到这里才允许真正重开（并设置熔断，防止连续多次）
  window.__wfRelaunchGateUntil.set(tok, Date.now() + RELAUNCH_GATE_MS);

  // 先尽力关闭旧窗
  try { const old = window.__wfChildren?.get(tok); if (old && !old.closed) old.close(); } catch (_){}
  try { window.__wfChildren?.delete(tok); } catch (_){}

  const relayBase = new URL('.', location.href).toString().replace(/\/$/, '');
  const url = buildChatUrl(relayBase, tok);
  const name = `wf_${tok}_${Date.now()}`;
  const { left, top } = allocPopupPos(tok);
  const w = window.open(url, name, `popup=yes,width=${POPUP_W},height=${POPUP_H},left=${left},top=${top}`);
  if (w) {
    try { w.moveTo(left, top); w.resizeTo(POPUP_W, POPUP_H); w.focus?.(); } catch {}
    window.__wfChildren?.set(tok, w);
    window.__wfOpenTs = window.__wfOpenTs || new Map();
    window.__wfOpenTs.set(tok, Date.now());
  }

  // 轻量刷新一次（不要层层递归刷新）
  try { await loadGenList(); } catch {}
  setBridgeLED('ok');
}, false);