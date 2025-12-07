// 篡改猴安装/检测、bridge LED、popup 权限检测、coord-only 开关
const leds = { login:$("#ledLogin"), wiki:$("#ledWiki") };

let session = { authenticated:false, settings:{} };

const ledBridge = $("#ledBridge");

const ledPopup = document.getElementById('ledPopup');


function browserStoreURL() {
  const ua = navigator.userAgent.toLowerCase();
  // 用稳定版（Beta 在不少地区/平台会 404）
  if (ua.includes('edg/'))     return 'https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd';
  if (ua.includes('firefox/')) return 'https://addons.mozilla.org/firefox/addon/tampermonkey/';
  if (ua.includes('chrome/'))  return 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo';
  // 其他或不识别：跳官网下载页
  return 'https://www.tampermonkey.net/?browser=unknown&locale=zh';
}

/** ───────────── 仅协调（不自动开窗）开关 ───────────── */
function isCoordOnly(){
  try {
    const v = sessionStorage.getItem('wf_coord_only');
    // v === null 代表从未设置 → 默认“仅协调”（不自动开窗）
    return v === null ? true : v === '1';
  } catch {
    return true; // 异常时也默认关闭自动开窗
  }
}
function setCoordOnly(on){
  try { sessionStorage.setItem('wf_coord_only', on ? '1' : '0'); } catch {}
  updateCoordUI();
}


// LED 辅助
function setBridgeLED(state) {
  ledBridge.classList.remove('ok','warn','err');
  if (state === 'ok')   ledBridge.classList.add('ok');
  else if (state === 'err')  ledBridge.classList.add('err');
  else ledBridge.classList.add('warn'); // unknown / testing
}


function setPopupLED(state) {
  ledPopup.classList.remove('ok','warn','err');
  if (state === 'ok') ledPopup.classList.add('ok');
  else if (state === 'err') ledPopup.classList.add('err');
  else ledPopup.classList.add('warn');
}

function updateCoordUI(){
  const b = document.getElementById('btnCoord');
  if (!b) return;
  b.textContent = isCoordOnly()
    ? '🚧 自动开窗：关'
    : '🚀 自动开窗：开';
}


async function refreshSession() {
  const csrf = await fetch('/api/csrf').then(r=>r.json()); window.__csrf = csrf.token;
  const s = await api('/api/session');
  session = s; leds.login.classList.toggle('ok', !!s.authenticated);
  if (!s.authenticated) $("#dlgLogin").classList.add('show');
  else $("#dlgLogin").classList.remove('show');
  const chip = document.getElementById('userChip');
  if (s.authenticated) {
    const name = s.user?.username || '已登录';
    chip.innerHTML = `<span class="avatar"></span><span>${name}</span>`;
    chip.style.display = 'flex';
  } else {
    chip.style.display = 'none';
  }
  if (s.authenticated) {
    try { loadGenList(); } catch(_) {}
    try { loadJobs(); } catch(_) {}
    if (s.authenticated && !window.__esSlots) connectSlotsSSE();
  }
}

async function checkWikiConnection() {
  try{ await api('/api/wiki/check-duplicate','POST',{ title:'__wf_conn_ping__' }); leds.wiki.classList.toggle('ok', true); }
  catch(e){ leds.wiki.classList.remove('ok'); }
}

// 轻量探测：尝试开一个空白小窗，能拿到句柄就立刻关
async function probePopupOnce() {
  let w = null;
  try {
    w = window.open('about:blank', `wf_probe_${Date.now()}`, 'popup=yes,width=220,height=120,left=200,top=200');
  } catch {}
  if (w && !w.closed) {
    try { w.close(); } catch {}
    return true;
  }
  return false;
}

async function oneShotPopupCheck() {
  try {
    const ok = await probePopupOnce();
    // 第一次检测不通过就保持“warn”，避免一上来就跳红灯+弹框
    setPopupLED(ok ? 'ok' : 'warn');
  } catch {
    setPopupLED('warn');
  }
}


async function probeBridge({
  openTab = true,          // 是否真的打开 ChatGPT 子页（安装自测用 true；初始化 LED 快速探测用 false）
  cleanup = true,          // 测试完是否清理该条 slot
  requireEcho = true,      // 是否做“回显标记”校验（建议测试按钮为 true）
  timeoutMs = 40_000,      // 轮询超时
} = {}) {
  // 如果不打开子页，无法完成有效自检；这里直接返回中立态，交给“测试篡改猴”按钮主动触发
  if (!openTab) return { ok:false, reason:'SKIP_NO_TAB' };

  const token = Math.random().toString(36).slice(2);
  const marker = `WF-OK-${token.slice(0,6)}`;            // 用于结果校验的唯一标记
  const payload = requireEcho
    ? `请只输出以下标记并换行：${marker}\n不要输出其他任何内容。`
    : '请仅输出 OK';

  // 取 CSRF
  let csrf = '';
  try { csrf = (await fetch('/api/csrf').then(r=>r.json())).token || ''; } catch {}

  // 写入 payload
  await fetch('/api/wf/put', {
    method: 'POST',
    headers: { 'content-type':'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ token, text: payload, title: '桥接自检' })
  });

  // 打开 ChatGPT 子页（真正触发 Tampermonkey 脚本）
  const relayBase = getRelayBase();
  const url = buildChatUrl(relayBase, token);
  const child = window.open(url, '_blank', 'noopener');
  try { child?.focus(); } catch {}

  // 轮询状态直到 done / error / 超时
  const t0 = Date.now();
  let state = 'waiting';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const s = await fetch(`/api/wf/state?token=${encodeURIComponent(token)}`).then(r=>r.json());
      if (s?.state) state = s.state;
      if (state === 'done' || state === 'error') break;
    } catch {}
    await new Promise(r=>setTimeout(r, 700));
  }

  // 读取结果用于“回显校验”
  let matched = false, text = '';
  if (state === 'done' || state === 'error') {
    try {
      const r = await fetch(`/api/wf/result?token=${encodeURIComponent(token)}`).then(r=>r.json());
      text = String(r?.text || '');
      if (requireEcho) {
        matched = state === 'done' && text.includes(marker);
      } else {
        matched = state === 'done';
      }
    } catch {}
  }

  // 清理测试槽位
  if (cleanup) {
    try {
      await fetch(`/api/slots/${token}`, {
        method: 'DELETE',
        headers: { 'x-csrf-token': csrf }
      });
    } catch {}
  }

  const ok = (state === 'done') && matched;
  return { ok, state, matched, marker, text };
}


// 安装篡改猴：打开扩展商店 + 打开 /wf.user.js
// 智能安装/更新：先打开 /wf.user.js 探测是否被扩展接管
async function installBridge() {
  setBridgeLED('warn');
  const w = window.open('/wf.user.js', '_blank', 'noopener');
  if (!w) {
    // 被弹窗策略拦截：高亮弹窗 LED，并强制提示
    setPopupLED('err');
    openModal('#dlgPopup');
    // showAlert('浏览器拦截了弹窗。请允许本站弹窗后再试。','需要允许弹窗');
    return;
  }

  // 600ms 后判断是否被扩展页接管：能读到 location.href 且仍是本站，说明未安装；反之视为已安装
  setTimeout(() => {
    let takenByExtension = false;
    try {
      // 可读同源脚本页 → 未被接管（大概率未安装扩展）
      const sameOrigin = w.location && w.location.origin === location.origin;
      if (!sameOrigin) takenByExtension = true; // 极端情况下跳转到扩展页
    } catch (e) {
      // 跨域不可读 → 已被扩展接管（安装/更新页）
      takenByExtension = true;
    }

    if (takenByExtension) {
      setBridgeLED('ok');
      showAlert('检测到已安装 Tampermonkey，已打开脚本的“安装 / 更新”页。完成后可点“测试篡改猴”自检。','已安装扩展');
    } else {
      try { w.close(); } catch {}
      window.open(browserStoreURL(), '_blank', 'noopener');
      showAlert('未检测到 Tampermonkey。已打开扩展商店，请先安装扩展，再点击脚本页面进行安装。','需要安装扩展');
    }
  }, 600);
}


// 测试篡改猴：发起“回显”条目→ 打开子页→ 等待 done → 校验返回文本中是否包含唯一标记
async function testBridge() {
  setBridgeLED('warn'); // 测试中
  const r = await probeBridge({ openTab:true, cleanup:true, requireEcho:true }).catch(()=>({ ok:false, state:'error' }));
  if (r.ok) {
    setBridgeLED('ok');
    showAlert(`桥接就绪：已完成回显校验\n标记：${r.marker}\n`, '测试成功');
  } else {
    setBridgeLED('err');
    const snippet = (r.text || '').slice(0, 300).replace(/\n/g,' ');
    showAlert(`桥接不可用：状态=${r.state}；匹配=${r.matched?'√':'×'}\n标记：${r.marker||'-'}\n返回片段：${snippet || '（空）'}`, '测试失败');
  }
}


async function fixBridge() {
  // 1) 打开扩展商店
  window.open(browserStoreURL(), '_blank', 'noopener');

  // 2) 打开脚本安装（你需要把脚本文件放到 /public/wf.user.js，见下文）
  setTimeout(()=> {
    window.open('/wf.user.js', '_blank', 'noopener');
  }, 300);

  // 3) 指导并自检
  showAlert('已打开扩展商店与脚本安装页面。请完成安装后返回本页，点击“好的”开始自检','安装向导');
  const ok = await probeBridge({ openTab:true });
  ledBridge.classList.remove('ok','warn','err');
  ledBridge.classList.add(ok ? 'ok' : 'err');
  showAlert(ok ? '桥接就绪' : '桥接仍不可用，请确认：已安装 Tampermonkey，且已安装 wf.user.js 脚本。');
}



document.getElementById('loginForm')?.addEventListener('submit', async (ev)=>{
  ev.preventDefault();
  try{
    await api('/api/login','POST',{ username: $("#inpUser").value.trim(), password: $("#inpPass").value.trim() });
    showAlert('登录成功','成功');
    $("#dlgLogin").classList.remove('show'); leds.login.classList.add('ok');
    Promise.all([ refreshSession(), checkWikiConnection(), loadGenList(), loadJobs() ]).catch(()=>{});
  }catch(e){
    showAlert('登录失败，请检查用户名/密码','失败');
  }
});


$("#btnLogout").onclick = async ()=>{ try{ await api('/api/logout','POST',{}); location.reload(); }catch(e){} };

document.getElementById('btnCoord')?.addEventListener('click', async ()=>{
  setCoordOnly(!isCoordOnly());
  // 变更后刷新队列一次，让调度器感知
  try { await loadGenList(); } catch {}
});


$("#btnInstallBridge").onclick = installBridge;
$("#btnTestBridge").onclick = testBridge;



// --- 全局拦截 window.open ---
(() => {
  const _open = window.open.bind(window);
  window.open = function(url, name, specs){
    try{
      if (url && !/^(about:blank|javascript:|data:|blob:|chrome-extension:)/i.test(url)) {
        url = withTemporaryChat(url);
      }
    }catch{}
    return _open(url, name, specs);
  };
})();

// --- 拦截所有链接点击（捕获阶段）---
document.addEventListener('click', (ev) => {
  const a = ev.target && ev.target.closest && ev.target.closest('a[href]');
  if (!a) return;
  try { a.href = withTemporaryChat(a.href); } catch {}
}, true);


