// $, 416807, delay, esc, showAlert, openModal/closeModal 等通用工具
/**
 * @function $
 * @brief 查询单个元素
 * @param s 选择器字符串
 * @returns 返回匹配的元素
 * @details
 * 简化原生查询
 */
const $  = s => document.querySelector(s);

/**
 * @function $$
 * @brief 查询多个元素
 * @param s 选择器字符串
 * @returns 返回匹配的节点集合
 * @details
 * 简化批量查询
 */
const $$ = s => document.querySelectorAll(s);

/**
 * @var statusMap
 * @brief 状态到中文文案映射
 * @details
 * 统一界面文案
 * 减少硬编码
 */
const statusMap = {
  waiting: '排队中',
  picked: '已取出, 等待切换模式',
  running: '生成中',
  retrying: '排队中',
  done: '已完成',
  error: '异常'
};

/** 小延时 */
const delay = (ms)=> new Promise(r=>setTimeout(r,ms));

function openModal(id){ $(id).classList.add('show'); }
function closeModal(id){ $(id).classList.remove('show'); }

function ppStatusClass(ent){
  if (!ent) return 'err'; // 没有心跳信息
  const age = Date.now() - (ent.last || 0);
  if (age < 6000) return 'ok';   // <6s 认为健康
  if (age < 15000) return 'warn';// 6~15s 警告
  return 'err';                  // >=15s 视为断联/不可用
}
