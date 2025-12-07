// 全局 window.__wf* 状态 + 所有配置常量

/**
 * @var RELAUNCH_COOLDOWN_MS
 * @brief 冷却间隔毫秒
 * @details
 * 限制重开频率
 * 减少窗口抖动
 */
const RELAUNCH_COOLDOWN_MS = 4000;  // 4秒冷却

const RELAUNCH_GATE_MS = 8000; // 8s 熔断窗口，防“关-开-关-开”抖动

/** ───────────── 生成超时 & copy 相关 ───────────── */
const GEN_TIMEOUT_MS = 25 * 60 * 1000;      // 生成总时长超 25 分钟 → timeout-copy
const TIMEOUT_COPY_WAIT_MS = 45 * 1000;     // timeout-copy 触发后等待复制完成的最长时间

/**
 * @var AUTO_CLOSE_WHEN_DONE
 * @brief 作业完成后自动关闭开关
 * @details
 * 提升操作流畅度
 * 可由上层策略控制
 */
const AUTO_CLOSE_WHEN_DONE = true;

// 相似度阈值 & 每个页面 / 词条最多展示的重复候选数
const DUP_SIM_THRESHOLD = 0.7;       // 原来 0.6，稍微抬一点减小误报
const DUP_MAX_ITEMS_PER_TERM = 5;    // 只展示相似度最高的前 5 条


/**
 * @var relaunchCooldown
 * @brief 令牌到上次打开时间的冷却表
 * @details
 * 用于抖动抑制
 * 控制短时内重复开窗
 */
const relaunchCooldown = new Map(); // token -> lastOpenTs



/**
 * @var window.__wfChildren
 * @brief 全局子窗口句柄表
 * @details
 * 键为令牌
 * 值为窗口引用
 * 便于复用与关闭
 */
window.__wfChildren = window.__wfChildren || new Map();

// jobId -> { token, autoClear: boolean }
window.__wfJobSourceSlot = window.__wfJobSourceSlot || new Map();

window.__wfLastDupJobId = window.__wfLastDupJobId || null;

// 所有 ChatGPT 弹窗 + 槽位/并行调度 + 心跳/超时/救援 + 归档/删除
// PATCH A: per-token 关窗状态与重开熔断
window.__wfClosingTokens       = window.__wfClosingTokens || new Set(); // 处于主动关闭过程中的 token
window.__wfRelaunchGateUntil   = window.__wfRelaunchGateUntil || new Map(); // token -> 禁止重开的截止时间戳


/** 握手/心跳采样：用于“测试几次握手后再认定稳定” */
window.__wfHandshakeOK  = window.__wfHandshakeOK  || new Set();     // token 集合（已确认握手）
window.__wfHBSamples    = window.__wfHBSamples    || new Map();     // token -> { lastAgeMs, count }
window.__wfMovedToTail  = window.__wfMovedToTail  || new Set();     // token 集合（已尾移一次）
window.__wfScheduleFreezeUntil = 0;
window.__wfPull404Rescued = window.__wfPull404Rescued || new Set();

/** 生成时间“冻结值”缓存：token -> 冻结的 ms（进入 done/error 的瞬间记录） */
window.__wfGenFreezeMs  = window.__wfGenFreezeMs  || new Map();

/** timeout-copy 的本地节流 / 观察器 */
window.__wfGenTimedOut       = window.__wfGenTimedOut       || new Set();   // 已触发过 timeout-copy 的 token
window.__wfCopyDeadline      = window.__wfCopyDeadline      || new Map();   // token -> 截止时间戳
window.__wfCopyErrorMarked   = window.__wfCopyErrorMarked   || new Set();   // 防止重复标错


// token -> chatgpt 会话 URL（https://chatgpt.com/c/xxxx）
window.__wfConvUrl = window.__wfConvUrl || new Map();

/** 完成后暂停发车（见 B 节） */
window.__wfDonePauseUntil = window.__wfDonePauseUntil || 0;
window.__wfSeenDone       = window.__wfSeenDone       || new Set();

/**
 * @function openAtKey
 * @brief 生成本地存储键名
 * @param tok 令牌
 * @returns 返回键名字符串
 * @details
 * 以令牌为后缀
 * 用于窗口时间记录
 */
const openAtKey = tok => `wf_open_at_${tok}`;

/**
 * @function openAtSet
 * @brief 写入窗口打开时间
 * @param tok 令牌
 * @param ts 时间戳
 * @details
 * 记录打开时刻
 * 供心跳与超时判定
 */
function openAtSet(tok, ts){ try{ localStorage.setItem(openAtKey(tok), String(ts||Date.now())); }catch{} }

/**
 * @function openAtGet
 * @brief 读取窗口打开时间
 * @param tok 令牌
 * @returns 返回时间戳或空
 * @details
 * 从本地存储获取
 * 失败返回空值
 */
function openAtGet(tok){ try{ const v=localStorage.getItem(openAtKey(tok)); return v?Number(v):null; }catch{ return null; } }

/**
 * @function openAtDel
 * @brief 删除窗口打开时间
 * @param tok 令牌
 * @details
 * 清理本地存储
 * 防止脏数据
 */
function openAtDel(tok){ try{ localStorage.removeItem(openAtKey(tok)); }catch{} }

const convKey = tok => `wf_conv_url_${tok}`;
function convUrlSet(tok, url){ if(!url) return; try{ localStorage.setItem(convKey(tok), url); }catch{} window.__wfConvUrl.set(tok, url); }
function convUrlGet(tok){ return window.__wfConvUrl.get(tok) || localStorage.getItem(convKey(tok)) || ''; }
function convUrlDel(tok){ try{ localStorage.removeItem(convKey(tok)); }catch{} window.__wfConvUrl.delete(tok); }


/**
 * @var genPoller
 * @brief 生成列表轮询句柄
 *
 * @details
 * 保存最近一次计划任务
 * 便于出现异常时清理与复用
 */
let genPoller = null;

/**
 * @var genInterval
 * @brief 生成列表轮询间隔毫秒
 *
 * @details
 * 正常一秒轮询
 * 异常时按指数回退至八秒
 */
let genInterval = 1000; // 正常 1s 轮询；错误时指数退避到 8s

/**
 * @var window.__autoLoadOnce
 * @brief 全局去重集合
 *
 * @details
 * 用于控制只触发一次的初始化逻辑
 * 防止重复处理
 */
window.__autoLoadOnce = window.__autoLoadOnce || new Set();
