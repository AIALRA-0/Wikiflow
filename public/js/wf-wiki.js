// Wiki.js 交互：路径校验、模板、查重弹窗、提交/覆盖/强制提交

let dupMatches = [];
let selectedDupId = null;

/**
 * @function normalizeSegment
 * @brief 规范化路径段
 * @param seg 原始片段
 * @returns 返回清洗后的片段
 * @details
 * 去除首尾空白与多余空格
 * 将空白替换为短横线
 * 移除非字母数字下划线短横线汉字
 */
function normalizeSegment(seg){
  return seg.trim().replace(/\s+/g,'-').replace(/[^\w\-\u4e00-\u9fa5]/g,'');
}


/**
 * @function validateAndBuildPath
 * @brief 校验标题并生成绝对路径
 * @param title 主标题
 * @returns 返回对象 包含是否通过与路径或提示
 * @details
 * 拒绝空值
 * 拒绝点与双点
 * 清洗非法字符
 * 以短横线连接
 * 前置斜杠作为根路径
 */
function validateAndBuildPath(title){
  if (!title || !title.trim()) return { ok:false, msg:'主标题不能为空' };
  const raw = title.trim().replace(/\/+/g,'/');
  const parts = raw.split('/').filter((_,i)=> !(i===0 && _===''));
  if (parts.length===0) return { ok:false, msg:'主标题无有效内容' };
  const clean = [];
  for (const p of parts){
    if (p==='.' || p==='..') return { ok:false, msg:'路径段不能为 . 或 ..' };
    const seg = normalizeSegment(p);
    if (!seg) return { ok:false, msg:'路径中存在空段或非法字符，请修改' };
    clean.push(seg);
  }
  return { ok:true, path:'/' + clean.join('/') };
}


function defaultTemplateBase() {
  return `# {名词} 概述

* **适用读者：** 初学者；研究者；工程师
* **阅读前置：** 半导体物理；器件基础
* **核心问题：** {名词} 是什么？为何重要？如何实现？应用何在？
* **结构与机理：** …
* **关键参数：** …
* **发展与前沿：** …
* **常见误区：** …
* **相关阅读：** …

> 请基于“{名词}”生成 Wiki 风格 Markdown，第一行添加“* **标签：** …；…；…；” 用中文分号或逗号分隔多个标签`;
}

function getCurrentTemplate(){
  try { return localStorage.getItem('wf_template') || defaultTemplateBase(); }
  catch(e){ return defaultTemplateBase(); }
}


function getDesc(){ return ($("#descInput").value || '').trim(); }

/** ───────────── 从 Wiki 页面同步为本地模板 ───────────── */
function isValidAbsoluteUrl(u){
  try { new URL(u); return true; } catch { return false; }
}

function sameWikiBase(u){
  try{
    const base = (session.settings?.wiki_base_url || '').replace(/\/+$/,'');
    if (!base) return true; // 未配置就不强校验 base
    const nu = new URL(u);
    const nb = new URL(base);
    return nu.origin === nb.origin;
  }catch{ return true; }
}

function defaultTemplateFilled() {
  const term = ($("#termInput").value||'').trim();
  const base = getCurrentTemplate();
  if (!base.includes('{名词}')) { showAlert('当前模板不包含 {名词} 占位符，请先在“编辑模板”中修正','模板无效'); return ''; }
  return base.replaceAll('{名词}', term||'名词');
}




function highlightTitle(title, tokens){
  let t = esc(title||'');
  (tokens||[]).forEach(tok=>{
    if (!tok) return;
    const re = new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    t = t.replace(re, m => `<mark>${m}</mark>`);
  });
  return t;
}



function renderDupList(matches){
  const base = (session.settings?.wiki_base_url||'').replace(/\/+$/,'');

  // 带原始下标的拷贝，方便和 dupMatches 对齐
  const indexed = (matches || []).map((m, idx) => ({ ...m, __idx: idx }));

  // 按相似度从高到低排序
  const sorted = indexed.slice().sort(
    (a, b) => (b.similarity || 0) - (a.similarity || 0)
  );

  // 过滤掉相似度过低的，只保留 Top N
  let top = sorted.filter(m => (m.similarity || 0) >= DUP_SIM_THRESHOLD);
  if (!top.length) top = sorted; // 一个都没过阈值时，至少给点东西看
  top = top.slice(0, DUP_MAX_ITEMS_PER_TERM);

  $("#dupList").innerHTML = top.map((m) => {
    const i    = m.__idx;                 // 原始下标，和 dupMatches 对齐
    const path = m.path || '';
    const href = base + (path.startsWith('/') ? path : '/'+path);
    const sim  = Math.round((m.similarity || 0) * 100);
    return `
      <div class="item" id="dup-${i}" data-dup-index="${i}">
        <div>
          <strong>${highlightTitle(m.title, m.matchedTokens)}</strong>
          <div class="muted">${esc(path)}</div>
          <div class="muted">命中词：${esc((m.matchedTokens||[]).join('、') || '—')}</div>
          <div class="muted">相似度：${sim}%</div>
        </div>
        <div class="row">
          <label class="btn sm">
            <input type="radio" name="dupSel" style="margin-right:6px;" onclick="window.selDup(${i})">选择
          </label>
          <a class="btn sm sec" target="_blank" rel="noopener" href="${href}">打开</a>
        </div>
      </div>`;
  }).join('');

  // 若尚未选择，默认选中相似度最高且超过阈值的一条
  if (!selectedDupId && top.length) {
    const best = top.find(m => (m.similarity || 0) >= DUP_SIM_THRESHOLD) || top[0];
    window.selDup(best.__idx);
  }
}





window.selDup = (i)=>{
  selectedDupId = dupMatches[i]?.id || null;
  // 先清除所有选中态
  document.querySelectorAll('#dlgDup .item').forEach(el=>el.classList.remove('selected'));
  // 高亮当前
  const row = document.getElementById('dup-'+i);
  if (row) {
    row.classList.add('selected');
    const rb = row.querySelector('input[type="radio"]');
    if (rb) rb.checked = true;
  }
  showAlert('将覆盖：'+(dupMatches[i]?.title||''),'已选择');
};


// 强制触发浏览器的拦截提示（需用户手势）
async function forceAskPopup() {
  // 连开两次更容易触发浏览器提示条
  let ok = false;
  for (let i=0;i<2;i++) {
    const w = window.open('about:blank', `wf_force_${Date.now()}_${i}`, 'popup=yes,width=320,height=200,left=300,top=260');
    ok = ok || !!w;
    try { w && w.close(); } catch {}
  }
  setPopupLED(ok ? 'ok' : 'err');
  if (!ok) openModal('#dlgPopup');
}



/**
 * 交互：输入 Wiki.js 页面链接 → 后端取正文 → 覆盖本地模板（localStorage: wf_template）
 * 说明：
 * - 通过后端 API 取内容，避免跨域与 Token 暴露（需后端提供任一接口）：
 *   1) 优先 POST /api/wiki/get-content  { url }
 *   2) 退化 POST /api/wiki/get           { url }
 *   任选其一实现即可，前端都会尝试
 */
async function promptSyncTemplate(){
  const url = (prompt('请输入要同步为模板的 Wiki.js 页面链接：') || '').trim();
  if (!url) return;
  if (!isValidAbsoluteUrl(url)) return showAlert('链接格式不合法','同步模板失败');
  if (!sameWikiBase(url)) {
    const ok = confirm('该链接与配置的 Wiki 基址不同源，仍要继续吗？');
    if (!ok) return;
  }
  const ok2 = confirm('确认将该页面的内容覆盖当前“编辑模板”的存储吗？此操作不可撤销。');
  if (!ok2) return;

  // 依次尝试两个后端端点，任选其一实现即可
  let content = '';
  for (const ep of ['/api/wiki/get-content','/api/wiki/get']) {
    try {
      const r = await api(ep, 'POST', { url });
      const cand = r?.content ?? r?.text;   // 同时兼容 JSON 与纯文本
      if (cand && String(cand).trim()) { content = String(cand); break; }
    } catch {}
  }

  if (!content) return showAlert('未能获取页面正文，请检查链接或后端接口','同步模板失败');

  try {
    localStorage.setItem('wf_template', content);
    broadcastTemplate(content);      // 🔁 模板同步到其他标签页
  } catch {}

  // 若模板编辑窗已开，顺便写入 textarea（本页）
  const t = document.getElementById('tplArea');
  if (t) t.value = content;

  showAlert('已将该 Wiki 页面内容同步为本地模板','成功');

}




(function(){
  const t = localStorage.getItem('wf_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', t);
})();
$("#btnTheme").onclick = ()=>{
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('wf_theme', next);
};

$("#btnForce").onclick = async ()=>{
  const cleaned = extractTagsAndClean($("#mdInput").value);
  const tags = (currentTags && currentTags.length) ? currentTags : cleaned.tags;
  const body = cleaned.body;
  const title = ($("#titleInput").value||'').trim();
  const v = validateAndBuildPath(title);
  if (!v.ok) return showAlert(v.msg, '主标题不合法');
  try {
    const job = await api('/api/jobs/submit','POST',{
      termId: null, title, tags, content: body, desc: getDesc(), cleanup: true, force: true
    });
    closeModal("#dlgDup");
    $("#result").textContent = '已提交“坚持提交”任务，正在处理…';

    // 把“查重失败的那个 job”上的 auto-clear 绑定迁移到新 job 上
    (function migrateAutoClearBinding(){
      const dupId = window.__wfLastDupJobId;
      const map   = window.__wfJobSourceSlot;
      if (!dupId || !map || !map.has(dupId)) return;
      const info = map.get(dupId);
      map.delete(dupId);       // 老 job 不再负责清理
      map.set(job.id, info);   // 换成由新 job 完成后清理
      window.__wfLastDupJobId = null;
    })();

    trackJob(job.id);
  } catch(e) {
    showAlert('提交失败：'+(e.message||e.error||''),'失败');
  }
};




// 绑定按钮
document.getElementById('btnSyncTpl')?.addEventListener('click', promptSyncTemplate);



// —— 事件绑定 ——
document.getElementById('btnPopupHelp')?.addEventListener('click', () => {
  openModal('#dlgPopup');
});
document.getElementById('btnPopupTest')?.addEventListener('click', forceAskPopup);

// 设置弹窗
$("#btnSettings").onclick = async ()=>{
  openModal("#dlgSettings");
  $("#inpBase").value = session.settings?.wiki_base_url || '';
  $("#inpGraphql").value = session.settings?.wiki_graphql_url || '';
  $("#inpLocale").value = session.settings?.locale || 'zh';
  $("#inpEditor").value = session.settings?.editor || 'markdown';
};
$$(".x").forEach(x=>x.onclick = ()=> closeModal('#'+x.dataset.x));
$("#btnSaveSettings").onclick = async ()=>{
  await api('/api/settings','POST',{
    wiki_base_url: $("#inpBase").value.trim(),
    wiki_graphql_url: $("#inpGraphql").value.trim(),
    wiki_token: $("#inpToken").value.trim() || undefined,
    locale: $("#inpLocale").value.trim() || undefined,
    editor: $("#inpEditor").value.trim() || undefined
  });
  closeModal("#dlgSettings");
  await refreshSession(); await checkWikiConnection();
  showAlert('已保存 Wiki.js API 配置','成功');
};

// 模板相关
$("#btnEditTpl").onclick = ()=>{
  $("#tplArea").value = getCurrentTemplate();
  openModal("#dlgTpl");
};
$("#btnSaveTpl").onclick = ()=>{
  const t = $("#tplArea").value || '';
  if (!t.includes('{名词}')) { showAlert('模板必须包含 {名词} 占位符','模板无效'); return; }
  try {
    localStorage.setItem('wf_template', t);
    broadcastTemplate(t);          // 🔁 通知所有其他页面
    showAlert('模板已保存','成功');
  } catch(e){
    showAlert('保存失败（浏览器可能禁用了本地存储）','失败');
  }
};


$("#btnParse").onclick = ()=>{
  const msg = $("#parseMsg");
  msg.className = 'smallmsg'; msg.textContent = '';
  const raw = $("#mdInput").value;
  const { zhName, enFull, enAbbr } = parseMetaFromMD(raw);
  const { tags, body } = extractTagsAndClean(raw);
  currentTags = tags;
  $("#mdInput").value = body;

  // 描述仍然写英文全称
  if (enFull) $("#descInput").value = enFull;

  // === 这里是修改后的主标题逻辑 ===
  if (zhName) {
    let title = (enAbbr && isPureAlphabet(enAbbr)) ? `${enAbbr} ${zhName}` : zhName;
    if (enFull) title += ` ${enFull}`;
    $("#titleInput").value = title;
  }
  // === 修改结束 ===

  $("#tags").innerHTML = (tags||[]).map(t=>`<span class="chip">${t}</span>`).join('');
  const pieces = [];
  if (enFull) pieces.push('已填充描述=英文全称');
  if (zhName) pieces.push('已填充主标题');
  msg.classList.add('ok');
  msg.textContent = `识别标签 ${tags.length} 个；` + (pieces.join('，') || '已清洗正文');
  renderLivePreview();
};




$("#btnSubmit").onclick = async ()=>{
  try{
    const cleaned = extractTagsAndClean($("#mdInput").value);
    const tags = (currentTags && currentTags.length) ? currentTags : cleaned.tags;
    const body = cleaned.body;
    $("#tags").innerHTML = (tags||[]).map(t=>`<span class="chip">${t}</span>`).join('');
    if (!body.trim()) return showAlert('请先粘贴并清洗 Markdown');
    const title = ($("#titleInput").value||'').trim();
    const v = validateAndBuildPath(title);
    if (!v.ok) return showAlert(v.msg, '主标题不合法');

    const autoClearEl = document.getElementById('ckAutoClearSlot');
    const autoClearFlag = !!(autoClearEl && autoClearEl.checked && currentPreviewToken);

    const job = await api('/api/jobs/submit','POST',{
      termId: null, title, tags, content: body, desc: getDesc(), cleanup: true
    });

    $("#result").textContent = '已提交后台任务，正在处理…';
    trackJob(job.id);
    document.getElementById('jobsCard')?.scrollIntoView({ behavior:'smooth', block:'nearest' });

    // 不再马上删除，而是记到 job 映射表，等 job=done 再删
    if (autoClearFlag) {
      window.__wfJobSourceSlot = window.__wfJobSourceSlot || new Map();
      window.__wfJobSourceSlot.set(job.id, {
        token: currentPreviewToken,
        autoClear: true
      });
      // 不清空 currentPreviewToken，让你在 job 执行期间仍然知道当前预览来源
    }

  }catch(e){
    showAlert('提交失败：'+(e.message||e.error||'')); 
  }
};


$("#btnOverwrite").onclick = async ()=> {
  if(!selectedDupId) return showAlert('请先在列表中“选择”要覆盖的页面');
  const cleaned = extractTagsAndClean($("#mdInput").value);
  const tags = (currentTags && currentTags.length) ? currentTags : cleaned.tags;
  const body = cleaned.body;
  const title = ($("#titleInput").value||'').trim();
  const v = validateAndBuildPath(title);
  if (!v.ok) return showAlert(v.msg, '主标题不合法');
  const btn = $("#btnOverwrite");
  btn.disabled = true; const oldTxt = btn.textContent;
  try{
    btn.textContent = '正在删除旧页面…';
    await deletePageById(selectedDupId);
    btn.textContent = '正在提交新页面…';
    const job = await api('/api/jobs/submit','POST',{
      termId: null, title, tags, content: body, desc: getDesc(), cleanup: true, force: true
    });
    closeModal("#dlgDup");
    $("#result").textContent = '已提交后台覆盖任务，正在处理…';

    // 同样迁移 auto-clear 绑定
    (function migrateAutoClearBinding(){
      const dupId = window.__wfLastDupJobId;
      const map   = window.__wfJobSourceSlot;
      if (!dupId || !map || !map.has(dupId)) return;
      const info = map.get(dupId);
      map.delete(dupId);
      map.set(job.id, info);
      window.__wfLastDupJobId = null;
    })();

    trackJob(job.id);
  }catch(e){
    showAlert('覆盖失败：'+(e.message||e.error||'')); 
  }finally{
    btn.disabled = false; btn.textContent = oldTxt;
  }
};


$("#btnModify").onclick = ()=> closeModal("#dlgDup");
$("#btnSkip").onclick = ()=> closeModal("#dlgDup");