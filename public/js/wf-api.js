// api 封装 + deletePageById + Wiki 链接检测等
function esc(s){
  return String(s||'').replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

const api = async (url, method='GET', data=null) => {
  const headers = {};
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers['x-csrf-token'] = window.__csrf || '';
  }
  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : null,
    credentials: 'same-origin',       // 带上 cookie，保险
  });

  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch {}
    let payload;
    try { payload = JSON.parse(text || '{}'); } catch { payload = { error: `HTTP_${res.status}`, detail: text }; }
    throw payload;
  }

  // 关键：DELETE 很多返回 204，这里当成功
  if (res.status === 204) return {};

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) {
    const text = await res.text().catch(()=> '');
    return { ok: true, text };
  }
  return res.json();
};

async function deletePageById(id){
  try { await api('/api/wiki/delete','POST',{ id }); return true; }
  catch(e){ throw new Error(e.message || e.error || '删除失败'); }
}

function showAlert(msg, title='提示'){
  $("#alertTitle").textContent = title;
  $("#alertMsg").textContent = msg;
  $("#dlgAlert").classList.add('show');
}
$("#btnAlertOK").onclick = ()=> closeModal("#dlgAlert");