//  心跳 UI、生成超时、timeout-copy 恢复、HB 相关本地状态

// 把会话 URL 拼上必要的 wf/relay/copy-only 标识
function composeConvUrl(convUrl){
  const u = new URL(convUrl, 'https://chatgpt.com');
  u.searchParams.set('wf', '1');
  u.searchParams.set('relay', getRelayBase());
  u.searchParams.set('temporary-chat', 'true');
  u.searchParams.set('wf_copy_only', '1');    // 子脚本据此进入“只复制”流程
  return u.toString();
}


// 替换原来的 relaunchAtConversationForCopy：固定 200×400
async function relaunchAtConversationForCopy(token){
  const convUrl = convUrlGet(token);
  if (!convUrl) return false;
  await ensureCloseWindow(token);

  const url = composeConvUrl(convUrl);
  const { left, top } = allocPopupPos(token);
  const name = `wf_${token}_conv_${Date.now()}`;

  const w = window.open(
    url,
    name,
    `popup=yes,width=${POPUP_W},height=${POPUP_H},left=${left},top=${top}`
  );
  if (!w) return false;
  try { w.moveTo(left, top); w.resizeTo(POPUP_W, POPUP_H); } catch {}
  try { w.focus(); } catch {}
  window.__wfChildren?.set(token, w);
  window.__wfOpenTs = window.__wfOpenTs || new Map();
  const now = Date.now();
  window.__wfOpenTs.set(token, now);
  openAtSet(token, now);
  return true;
}


function resetHBLocalState(token) {
  try {
    window.__wfHandshakeOK   && window.__wfHandshakeOK.delete(token);
    window.__wfHBSamples     && window.__wfHBSamples.delete(token);
    window.__hbTimedOut      && window.__hbTimedOut.delete(token);
    window.__wfGenFreezeMs   && window.__wfGenFreezeMs.delete(token);
    window.__wfGenTimedOut   && window.__wfGenTimedOut.delete(token);
    window.__wfCopyDeadline  && window.__wfCopyDeadline.delete(token);
    window.__wfCopyErrorMarked && window.__wfCopyErrorMarked.delete(token);

    // 生成时长重新计时
    window.__wfOpenTs        && window.__wfOpenTs.delete(token);
    openAtDel(token);  // localStorage 也顺手清掉
  } catch (e) {
    console.warn('[WF][resetHBLocalState] fail for', token, e);
  }
}

// 后端心跳 → 颜色：<6s=ok, <15s=warn, 其余=err
function hbClassByAge(ageMs) {
  if (ageMs == null || !isFinite(ageMs)) return 'err';
  if (ageMs < 6000)  return 'ok';
  if (ageMs < 15000) return 'warn';
  return 'err';
}

// 完整替换：更新心跳/计时 UI，并在两类场景下触发处理：
// 1) HB 超时（idle>=20s 且 gen>=20s）：直接报错 hb-timeout，并尽力关闭窗口（禁止 copy-retry）
// 2) 生成总时长超时（gen>=GEN_TIMEOUT_MS）：触发 timeout-copy（优先用会话URL顶置“只复制”），失败则报错
function updateHBUIFromServer(it) {
  // 队列态（含重试中）：显示占位并用 idle-black 配色
  if (it.status === 'retrying' || it.status === 'waiting') {
    const root = document.getElementById('pp-' + it.token);
    const ppc  = document.getElementById('pp-ppc-' + it.token);
    if (ppc)  ppc.textContent = 'gen - • idle -';
    if (root) {
      root.classList.remove('ok','warn','err','idle-yellow','idle-red');
      root.classList.add('idle-black');
    }
    return;
  }

  // ── 计算心跳 ageMs ──
  let ageMs = null;
  let ts = null;
  if (typeof it.hb_age_ms === 'number') {
    ageMs = it.hb_age_ms;
  } else if (it.hb_last_at) {
    ts = (typeof it.hb_last_at === 'number') ? it.hb_last_at : Date.parse(it.hb_last_at);
  } else if (it.last_hb_at) {
    ts = (typeof it.last_hb_at === 'number') ? it.last_hb_at : Date.parse(it.last_hb_at);
  }
  if (ageMs == null && ts && isFinite(ts)) {
    ageMs = Date.now() - ts;
  }

  // ── 打开时长（生成用时）openAgeMs ──
  window.__wfOpenTs = window.__wfOpenTs || new Map();
  let openAgeMs = null;

  // 优先用前端记录的“这次开窗时间”
  const openAt = window.__wfOpenTs.get(it.token) || openAtGet(it.token) || null;
  if (openAt) {
    openAgeMs = Date.now() - openAt;
  } else if (typeof it.open_age_ms === 'number') {
    // 没有本地记录才退回后端字段
    openAgeMs = it.open_age_ms;
  }

  // ── 心跳“握手稳定”采样：回春2次才算 OK ──
  const s = window.__wfHBSamples.get(it.token) || { lastAgeMs: null, count: 0 };
  if (typeof ageMs === 'number' && isFinite(ageMs)) {
    if (s.lastAgeMs != null && ageMs < s.lastAgeMs - 500) { // 比上次年轻≥0.5s
      s.count = Math.min(5, s.count + 1);
    }
    s.lastAgeMs = ageMs;
    window.__wfHBSamples.set(it.token, s);
  }
  if (s.count >= 2) window.__wfHandshakeOK.add(it.token);

  const root  = document.getElementById('pp-' + it.token);
  const ppcEl = document.getElementById('pp-ppc-' + it.token);
  const ageEl = document.getElementById('pp-age-' + it.token);

  const terminal = (it.status === 'done' || it.status === 'error');

  // ── 生成时间“冻结值”：进入终态时冻结，复活则清除 ──
  if (!terminal && window.__wfGenFreezeMs.has(it.token)) {
    window.__wfGenFreezeMs.delete(it.token);
  }
  if (terminal && !window.__wfGenFreezeMs.has(it.token)) {
    const candidate = (typeof it.open_age_ms === 'number') ? it.open_age_ms : openAgeMs;
    if (candidate != null && isFinite(candidate)) window.__wfGenFreezeMs.set(it.token, candidate);
  }
  const genMsForDisplay =
    window.__wfGenFreezeMs.has(it.token)
      ? window.__wfGenFreezeMs.get(it.token)
      : openAgeMs;

  // ── 文案与配色 ──
  const fmtMS = (ms) => {
    if (ms==null || !isFinite(ms)) return '-';
    const m = Math.floor(ms/60000);
    const s = Math.floor((ms%60000)/1000);
    return `${m}:${String(s).padStart(2,'0')}`;
  };

  const handshakeOK = window.__wfHandshakeOK.has(it.token);
  const idleStr = (terminal || !handshakeOK || ageMs==null || !isFinite(ageMs)) ? '-' : fmtMS(ageMs);

  if (ppcEl) ppcEl.textContent = `gen ${fmtMS(genMsForDisplay)} • idle ${idleStr}`;
  if (ageEl) ageEl.textContent = '';

  if (root) {
    root.classList.remove('ok','warn','err','idle-black','idle-yellow','idle-red');
    if (terminal) {
      root.classList.add('idle-black');
    } else if (!handshakeOK) {
      root.classList.add('idle-black');
    } else {
      if (ageMs <= 5000)      root.classList.add('idle-black');
      else if (ageMs <= 8000) root.classList.add('idle-yellow');
      else                    root.classList.add('idle-red');
    }
  }

  // ── Watchdog：HB 超时（picked|running 且 gen>=20s 且 idle>=20s）→ 直接报错 hb-timeout ──
  const ACTIVE_ENFORCE = /^(picked|running)$/;
  const HB_TIMEOUT_MS  = 90 * 1000;

  const shouldHBTimeout =
    ACTIVE_ENFORCE.test(it.status || '') &&
    openAgeMs != null && isFinite(openAgeMs) && openAgeMs >= HB_TIMEOUT_MS &&
    ageMs != null && isFinite(ageMs) && ageMs >= HB_TIMEOUT_MS;

  window.__hbTimedOut = window.__hbTimedOut || new Set();
  if (!ACTIVE_ENFORCE.test(it.status || '')) {
    if (window.__hbTimedOut.has(it.token)) window.__hbTimedOut.delete(it.token);
  } else if (shouldHBTimeout && !window.__hbTimedOut.has(it.token)) {
    window.__hbTimedOut.add(it.token);
    (async () => {
      // 禁止 copy-retry：直接标错并尽力关闭子窗
      await markSlotState(it.token, 'error', { text: 'hb-timeout', progress: null });
      await ensureCloseWindow(it.token);
      try { await loadGenList(); } catch {}
      // 5 分钟后可再次触发（避免重复打点）
      setTimeout(() => { window.__hbTimedOut.delete(it.token); }, 5 * 60 * 1000);
    })();
    return; // 本轮已处理
  }

  // ── 生成总时长超时（与 HB 无关）：触发 timeout-copy ──
  if (
    ACTIVE_ENFORCE.test(it.status || '') &&
    genMsForDisplay != null && isFinite(genMsForDisplay) &&
    typeof GEN_TIMEOUT_MS === 'number' && genMsForDisplay >= GEN_TIMEOUT_MS &&
    !(window.__wfGenTimedOut && window.__wfGenTimedOut.has(it.token))
  ) {
    window.__wfGenTimedOut = window.__wfGenTimedOut || new Set();
    window.__wfGenTimedOut.add(it.token);

    (async () => {
      await markSlotState(it.token, 'retrying', { text: 'gen-timeout→copy', progress: null });

      // 优先使用“会话 URL 顶置重开只复制”，没有会话 URL 再退化为本地 copy-only 窗
      let opened = false;
      if (typeof convUrlGet === 'function' && convUrlGet(it.token)) {
        if (typeof relaunchAtConversationForCopy === 'function') {
          opened = await relaunchAtConversationForCopy(it.token);
        }
      }
      if (!opened && typeof openCopyOnlyWindow === 'function') {
        opened = openCopyOnlyWindow(it.token);
      }

      if (opened) {
        window.__wfCopyDeadline = window.__wfCopyDeadline || new Map();
        const ddl = Date.now() + (typeof TIMEOUT_COPY_WAIT_MS === 'number' ? TIMEOUT_COPY_WAIT_MS : 45000);
        window.__wfCopyDeadline.set(it.token, ddl);
      } else {
        await markSlotState(it.token, 'error', { text:'timeout-copy-open-failed', progress:null });
        await ensureCloseWindow(it.token);
      }
      try { await loadGenList(); } catch {}
    })();
  }

  // ── timeout-copy 的超时兜底：等待复制完成超时 → 报错 ──
  if (window.__wfCopyDeadline && window.__wfCopyDeadline.has(it.token)) {
    const ddl = window.__wfCopyDeadline.get(it.token);
    window.__wfCopyErrorMarked = window.__wfCopyErrorMarked || new Set();
    if (
      ddl && Date.now() > ddl &&
      !(it.status === 'done' || it.status === 'error') &&
      !window.__wfCopyErrorMarked.has(it.token)
    ) {
      window.__wfCopyErrorMarked.add(it.token);
      (async () => {
        await markSlotState(it.token, 'error', { text:'timeout-copy-failed', progress:null });
        await ensureCloseWindow(it.token);
        window.__wfCopyDeadline.delete(it.token);
        try { await loadGenList(); } catch {}
      })();
    }
  }

  // ── 终态清理：去除各类一次性标记，避免污染后续 ──
  if (terminal) {
    if (window.__wfCopyDeadline) window.__wfCopyDeadline.delete(it.token);
    if (window.__wfGenTimedOut) window.__wfGenTimedOut.delete(it.token);
    if (window.__wfCopyErrorMarked) window.__wfCopyErrorMarked.delete(it.token);
    if (typeof convUrlDel === 'function') convUrlDel(it.token);
  }
}

// 统一入口：尝试“软刷新只复制”；不行再“重开只复制”
// —— 完整替换：协调模式下不重开窗 —— //
async function kickCopyOnlyRecovery(slot, why = 'hb-timeout') {
  const tok = slot.token;

  if (isCoordOnly()) {
    await markSlotState(tok, 'retrying', { text: `${why} (coord-only)`, progress: null });
    // 不开窗，交由其他页面或稍后人工处理
    return false;
  }

  await markSlotState(tok, 'retrying', { text: 'gen-timeout→copy', progress: null });

  let opened = false;
  if (typeof convUrlGet === 'function' && convUrlGet(tok)) {
    if (typeof relaunchAtConversationForCopy === 'function') {
      opened = await relaunchAtConversationForCopy(tok);
    }
  }
  if (!opened && typeof openCopyOnlyWindow === 'function') {
    opened = openCopyOnlyWindow(tok);
  }

  if (opened) {
    window.__wfCopyDeadline = window.__wfCopyDeadline || new Map();
    const ddl = Date.now() + (typeof TIMEOUT_COPY_WAIT_MS === 'number' ? TIMEOUT_COPY_WAIT_MS : 45000);
    window.__wfCopyDeadline.set(tok, ddl);
  } else {
    await markSlotState(tok, 'error', { text:'timeout-copy-open-failed', progress:null });
    await ensureCloseWindow(tok);
  }
  try { await loadGenList(); } catch {}
  return opened;
}

// 子页告知“会话 URL”
window.addEventListener('message', (ev) => {
  const okOrigin = ev.origin === 'https://chatgpt.com' || ev.origin === 'https://chat.openai.com';
  if (!okOrigin) return;
  const d = ev.data || {};
  if (d.type === 'WF_CONV_URL' && d.token && d.conv_url) {
    convUrlSet(String(d.token), String(d.conv_url));
  }
}, false);

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    try {
      (async () => {
        const r = await api('/api/slots','GET');
        const items = r.items || [];
        for (const it of items) {
          if (!/^(picked|running)$/.test(it.status||'')) continue;
          for (let i=0;i<2;i++) {
            const hbState = (it.status === 'picked') ? 'picked' : 'running';
            await fetch('/api/wf/done', {
              method:'POST',
              headers:{'content-type':'application/json'},
              body: JSON.stringify({ token: it.token, state: hbState, text:'hb', client_ts: Date.now() })
            });
            await new Promise(r=>setTimeout(r, 220));
          }
        }
      })();
    } catch {}
  }
}, false);




