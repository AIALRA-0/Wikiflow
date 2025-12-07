// /api/jobs 的作业列表模块（jobRow, trackJob, loadJobs...）
/**
 * @var jobTimers
 * @brief 作业计时器表
 * @details
 * 保存每个作业的定时器句柄
 * 用于进度刷新与心跳检测
 */
const jobTimers = new Map();

/**
 * @function jobRow
 * @brief 构建作业行元素
 * @param id 作业标识
 * @param title 可选标题
 * @returns 返回已填充的元素
 * @details
 * 包含指示灯 标题 状态 与进度条
 * 采用统一类名便于样式控制
 */
function jobRow(id, title){
  const e = document.createElement('div'); e.className='item';
  e.dataset.jobId = id;
  e.innerHTML = `
    <div class="row" style="justify-content:space-between; width:100%;">
      <div class="row" style="gap:8px;">
        <div class="led" id="jobLed-${id}"></div>
        <div>
          <div class="title">${title?title+' ':''}#${id}</div>
          <div class="status muted" id="jobStatus-${id}">排队中…</div>
        </div>
      </div>
      <div class="bar" style="width:180px;"><i id="jobBar-${id}" style="width:0%"></i></div>
    </div>`;
  return e;
}

/**
 * @function setJobBar
 * @brief 设置进度条百分比
 * @param id 作业标识
 * @param p 百分比数值
 * @details
 * 自动裁剪到零到百
 * 更新样式宽度
 */
function setJobBar(id, p){ const i = $("#jobBar-"+id); if(i) i.style.width = Math.max(0,Math.min(100, p)) + '%'; }

/**
 * @function setJobStatus
 * @brief 设置作业状态文案
 * @param id 作业标识
 * @param s 状态文本
 * @details
 * 直接更新对应节点内容
 */
function setJobStatus(id, s){ const t = $("#jobStatus-"+id); if(t) t.textContent = s; }

/**
 * @function setJobLed
 * @brief 设置作业指示灯样式
 * @param id 作业标识
 * @param status 状态枚举
 * @details
 * 移除已有样式
 * 按状态添加样式
 * 排队使用警告
 * 运行使用正常与呼吸
 * 完成使用正常
 * 异常使用错误
 */
function setJobLed(id, status){
  const led = $("#jobLed-"+id); if (!led) return;
  led.classList.remove('ok','warn','err','pulse');
  switch(status){
    case 'queued': led.classList.add('warn'); break;
    case 'running': led.classList.add('ok','pulse'); break;
    case 'done': led.classList.add('ok'); break;
    case 'error': led.classList.add('err'); break;
    default: led.classList.add('warn');
  }
}


/**
 * @function trackJob
 * @brief 轮询单个作业并驱动行内状态更新
 *
 * @param id 作业标识
 *
 * @details
 * 初始化步骤
 * 确保行元素已存在
 * 清理旧定时器并移除句柄
 * 设置轮询间隔与上限
 *
 * 轮询逻辑
 * 通过接口获取作业状态
 * 更新进度条与状态文本与指示灯
 * 动态填充标题与链接
 * 检测重复条目并弹出提示
 *
 * 终止条件
 * 状态为完成或异常时停止轮询
 * 完成且存在链接时按偏好打开页面
 *
 * 回退策略
 * 正常路径按比例放大间隔至上限
 * 异常路径提示查询失败并停止该作业轮询
 *
 * 副作用
 * 修改列表项文案与样式
 * 写入与删除 jobTimers 记录
 * 触发窗口打开或聚焦
 */
async function trackJob(id) {
  const list = $("#jobList");
  if (!list.querySelector(`[data-job-id="${id}"]`)) list.prepend(jobRow(id, ''));
  if (jobTimers.has(id)) { clearTimeout(jobTimers.get(id)); jobTimers.delete(id); }
  let interval = 800, maxInterval = 3000;
  async function tick() {
    try {
      const j = await api('/api/jobs/' + id, 'GET');
      setJobBar(id, j.progress || 0);
      setJobStatus(id, j.message || '');
      setJobLed(id, j.status);
      const titleEl = list.querySelector(`[data-job-id="${id}"] .title`);
      if (titleEl && j.title && !titleEl.dataset.filled) {
        titleEl.textContent = `${j.title} #${id}`;
        titleEl.dataset.filled = '1';
      }
      if (j.status === 'error' && Array.isArray(j.dups) && j.dups.length && !titleEl?.dataset.dupShown) {
        dupMatches = j.dups;
        renderDupList(dupMatches);
        openModal("#dlgDup");
        if (titleEl) titleEl.dataset.dupShown = '1';
        // 记下这次查重是哪个 job 触发的
        window.__wfLastDupJobId = id;

      }
      if (j.status === 'done' || j.status === 'error') {
        jobTimers.delete(id);
      
        // 只有 done 时才尝试自动清理预览槽位
        if (j.status === 'done') {
          const map = window.__wfJobSourceSlot;
          if (map && map.has(id)) {
            const info = map.get(id);
            map.delete(id);
            if (info && info.autoClear && info.token) {
              try {
                await deleteSlotByToken(info.token);
              } catch (e) {
                console.warn('auto-clear slot failed for job', id, info.token, e);
              }
            }
          }
        }
      
        if (j.status === 'done' && j.url) {
          const openAfter = localStorage.getItem('wf_open_after') === '1';
          if (titleEl) {
            titleEl.textContent = `${j.title || ''} #${id} · `;
            const a = document.createElement('a');
            a.className = 'link'; a.target = '_blank'; a.rel = 'noopener'; a.href = j.url; a.textContent = '打开页面';
            titleEl.appendChild(a);
          }
          if (openAfter) window.open(j.url, '_blank', 'noopener');
        }
        return;
      }

      interval = Math.min(maxInterval, interval * 1.2);
    } catch (err) {
      setJobStatus(id, '状态查询失败'); setJobLed(id, 'error'); jobTimers.delete(id); return;
    }
    const h = setTimeout(tick, interval);
    jobTimers.set(id, h);
  }
  const h = setTimeout(tick, interval);
  jobTimers.set(id, h);
}

/**
 * @function loadJobs
 * @brief 拉取作业列表并批量渲染或续订轮询
 *
 * @details
 * 数据获取
 * 调用接口读取作业集合
 * 清空列表并重建条目
 *
 * 渲染策略
 * 新作业构建行元素
 * 已有作业原地更新
 * 同步进度与文案与指示灯
 *
 * 轮询接续
 * 进行中状态交由单作业轮询函数跟踪
 * 终态状态补充可点击链接
 *
 * 容错路径
 * 捕获异常并静默处理
 *
 * 副作用
 * 改写列表容器内容
 * 触发单作业轮询
 */
async function loadJobs(){
  try{
    const r = await api('/api/jobs','GET');
    const list = $("#jobList");
    list.innerHTML = '';
    (r.items||[]).forEach(j=>{
      const id = j.id; if (!id) return;
      if (!list.querySelector(`[data-job-id="${id}"]`)) list.appendChild(jobRow(id, j.title||'')); 
      setJobBar(id, j.progress||0);
      setJobStatus(id, j.message||'');
      setJobLed(id, j.status);
      if (j.status && j.status!=='done' && j.status!=='error'){
        trackJob(id);
      } else if (j.status === 'done' && j.url){
        const titleEl = list.querySelector(`[data-job-id="${id}"] .title`);
        if (titleEl) titleEl.innerHTML = `${j.title||''} #${id} · <a class="link" target="_blank" href="${j.url}">打开页面</a>`;
      }
    });
  }catch{}
}

/**
 * @section 自动打开偏好
 * @brief 读取并应用偏好 同步复选框
 * @details
 * 从本地存储读取偏好值
 * 初始化界面勾选状态
 * 监听变化并落盘
 */
(function(){
  const saved = localStorage.getItem('wf_open_after');
  $("#ckOpen").checked = saved === '1';
})();
$("#ckOpen").onchange = ()=> localStorage.setItem('wf_open_after', $("#ckOpen").checked ? '1' : '0');

// 提交后自动清理当前预览槽位偏好
(function(){
  const saved = localStorage.getItem('wf_autoclear_after_submit');
  const el = $("#ckAutoClearSlot");
  if (el) el.checked = saved === '1';
})();
{
  const el = $("#ckAutoClearSlot");
  if (el) {
    el.onchange = () => {
      localStorage.setItem(
        'wf_autoclear_after_submit',
        el.checked ? '1' : '0'
      );
    };
  }
}

document.getElementById('btnClearDone')?.addEventListener('click', async () => {
  try {
    // 若后端提供清理接口
    await api('/api/jobs/clear', 'POST', { scope: 'done' });
    await loadJobs();
  } catch (e) {
    showAlert('后端未提供清理接口（/api/jobs/clear）。', '未实现');
  }
});

document.getElementById('btnClearAll')?.addEventListener('click', async () => {
  try {
    // 若后端提供清理接口
    await api('/api/jobs/clear', 'POST', { scope: 'all' });
    await loadJobs();
  } catch (e) {
    showAlert('后端未提供清理接口（/api/jobs/clear）。', '未实现');
  }
});





