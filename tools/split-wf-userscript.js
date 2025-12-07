#!/usr/bin/env node

/**
 * 一键拆分 /opt/wikiflow/public/wf.user.js 为多个 Tampermonkey 模块文件，
 * 并自动在 wf.user.js 里插入 @require，并生成 tree.txt。
 *
 * 设计要点：
 *   - 优先使用 /opt/wikiflow/public/wf.user.js.bak 作为“原始源码”，
 *     若不存在则退回到当前 wf.user.js。
 *   - 模块文件放在 /opt/wikiflow/public/tampermonkey 下，命名为 wf-*.js，
 *     文件名只包含 [a-z0-9-]，不带数字编号前缀，也不出现中文。
 *   - 每个 section 标题预先规划好专门的英文 slug，做到“名字即职责”；
 *     如果 slug 冲突，直接报错退出（不再自动附加 -2 之类补丁）。
 *   - 每个模块文件第一行说明用途，第二行 'use strict';
 *   - 自动生成 tree.txt，列出每个文件名及其作用（原始 section 标题）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

// --------- 常量配置，可按需调整 ---------
const ROOT_DIR    = '/opt/wikiflow/public';
const MAIN_FILE   = path.join(ROOT_DIR, 'wf.user.js');
const BACKUP_FILE = path.join(ROOT_DIR, 'wf.user.js.bak');
const OUT_DIR     = path.join(ROOT_DIR, 'tampermonkey');
const BASE_URL    = 'https://wikiflow.aialra.online';   // 对外静态域名
const DRY_RUN     = false; // 设为 true 可只打印不真正写文件
const TREE_FILE   = path.join(OUT_DIR, 'tree.txt');
// ---------------------------------------

function fail(msg) {
  console.error('[split-wf] 失败：' + msg);
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

// 读取源码：优先 .bak，找不到再用主文件
function loadSource() {
  let srcFile = null;
  if (fs.existsSync(BACKUP_FILE)) {
    srcFile = BACKUP_FILE;
    console.log('[split-wf] 使用备份源文件：', BACKUP_FILE);
  } else if (fs.existsSync(MAIN_FILE)) {
    srcFile = MAIN_FILE;
    console.log('[split-wf] 使用主源文件（当前 wf.user.js）：', MAIN_FILE);
  } else {
    fail(`找不到源文件：${BACKUP_FILE} 或 ${MAIN_FILE}`);
  }
  const code = fs.readFileSync(srcFile, 'utf8');
  return { code, srcFile };
}

/**
 * 每个 section 标题的“手工规划路由表”
 * key：标题原文（去掉两侧空格）
 * value：英文 slug，只包含 [a-z0-9-]，语义尽量清晰
 *
 * 如果你日后在脚本里新增了新的  ─── XXX ─── / section，
 * 建议到这里手动补一条映射，保证模块名也清晰。
 */
const SECTION_TITLE_MAP = {
  '基础工具': 'core-utils',
  '思考时间：强制切到「进阶」': 'thinking-advanced-mode',
  '站点与参数': 'site-and-params',
  'reload-before-resend 支持': 'reload-before-resend',
  'ChatUI probes': 'chatui-probes',
  '填写 & 发送': 'compose-and-send',
  '严格复制：必须走官方“复制整条回复”流水线': 'strict-copy-via-copy-button',
  'DOM 串联函数（保留以便将来拓展，但本版不会调用）': 'dom-to-markdown-serializer',
  '完成判定': 'completion-check',
  '严格终止：只能用复制文本；失败即报错': 'strict-finalization-copy-only',
  '错误/掉线侦测 + 自动重试（不含 copy 失败）': 'error-and-auto-retry',
  '关窗上报：sendBeacon 版': 'window-close-report-beacon',
  '统一：报告并尝试多次关闭当前窗口': 'window-close-wrapper',
  '安装关窗上报钩子（替换原来的 pagehide 监听）': 'window-close-hooks',
  '重试：确保旧窗先自报 & 自闭': 'retry-old-window-shutdown',
  '主流程': 'main-flow'
};

// 根据 section 标题生成 slug：优先用上面的规划表；否则做一个 ASCII 回退，并提醒你检查
function pickSlugByTitle(title, usedSlugs) {
  title = (title || '').trim();

  let base = SECTION_TITLE_MAP[title];

  if (!base) {
    // 回退：尽量把标题转成 ASCII slug，并给出警告，提示你补规划
    let temp = title.normalize('NFKD').replace(/[^\x00-\x7F]/g, '');
    temp = temp.toLowerCase();
    temp = temp.replace(/[\/\\:*?"<>|#\s]+/g, '-');
    temp = temp.replace(/-+/g, '-');
    temp = temp.replace(/^-|-$/g, '');
    temp = temp.replace(/[^a-z0-9-]/g, '');
    base = temp || 'section';

    console.warn(
      `[split-wf] 警告：未在 SECTION_TITLE_MAP 中找到标题「${title}」，` +
      `使用回退 slug 「${base}」，建议到脚本里手动补一条映射。`
    );
  }

  if (usedSlugs.has(base)) {
    fail(
      `slug 规划冲突：slug "${base}" 已被其他 section 使用，标题为「${title}」。` +
      `请检查 SECTION_TITLE_MAP 或脚本里的 section 标题。`
    );
  }
  usedSlugs.add(base);
  return base;
}

// 将一组行的公共前导缩进去掉，使代码“顶格”
// 例如：["  const a = 1;", "  const b = 2;"] → ["const a = 1;", "const b = 2;"]
function normalizeIndent(lines) {
  let minIndent = null;

  for (const ln of lines) {
    if (!ln.trim()) continue; // 空行忽略
    const m = ln.match(/^([ \t]+)/);
    if (!m) {
      // 说明有行是完全顶格的，那整体就不需要去缩进
      minIndent = 0;
      break;
    }
    const indentLen = m[1].length;
    if (minIndent === null || indentLen < minIndent) {
      minIndent = indentLen;
    }
  }

  if (!minIndent || minIndent <= 0) return lines.slice();

  const prefix = ' '.repeat(minIndent);

  return lines.map(ln => {
    if (!ln.startsWith(prefix)) {
      // 保险起见，最多删掉 minIndent 个前导空白
      return ln.replace(/^[ \t]{1,}/, (m) => m.length > minIndent ? m.slice(minIndent) : '');
    }
    return ln.slice(minIndent);
  });
}


// 判断一个 section 是否真正包含代码（不只是标题 + 空行 + 注释）
function sectionHasRealCode(sec) {
  const bodyLines = sec.lines.filter(l => l !== sec.rawTitleLine);
  for (const ln of bodyLines) {
    const s = ln.trim();
    if (!s) continue;                  // 空行
    if (/^\/\//.test(s)) continue;     // 单行注释
    if (/^\/\*/.test(s)) continue;     // 多行注释起始
    return true;
  }
  return false;
}

// 按 /** ─── xxx ─── */ 切成若干块，并丢掉“空壳 section”
function splitBySections(innerBody) {
  const lines = innerBody.split('\n');
  const sections = [];
  let current = { title: '', rawTitleLine: '', lines: [] };

  const headingRe = /\/\*\*\s*─+([^*]+?)─+\s*\*\//;

  for (const line of lines) {
    const m = line.match(headingRe);
    if (m) {
      if (current.lines.length) {
        sections.push(current);
      }
      current = {
        title: m[1].trim(),
        rawTitleLine: line,
        lines: [line],
      };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length) sections.push(current);

  const realSections = sections.filter(sec => sectionHasRealCode(sec));

  return realSections;
}

function main() {
  const { code: src, srcFile } = loadSource();

  const metaStartIdx   = src.indexOf('// ==UserScript==');
  const metaEndMarker  = '// ==/UserScript==';
  const metaEndIdx     = src.indexOf(metaEndMarker);
  assert(metaStartIdx !== -1 && metaEndIdx !== -1, '没找到 UserScript 元信息区');

  const metaEndLineIdx = src.indexOf('\n', metaEndIdx);
  const metaBlock      = src.slice(metaStartIdx, metaEndLineIdx + 1);
  let   body           = src.slice(metaEndLineIdx + 1);

  console.log('[split-wf] 源文件：', srcFile);

  // 提取外层 IIFE 内容
  const iifeStartToken = '(() => {';
  const iifeEndToken   = '})();  // ✅ 整体闭包结束';
  const startPos = body.indexOf(iifeStartToken);
  const endPos   = body.lastIndexOf(iifeEndToken);

  assert(startPos !== -1 && endPos !== -1,
    '没找到外层 IIFE 包裹，请确认脚本版本（需要有 "(() => {" 和 "})();  // ✅ 整体闭包结束"）');

  let innerBody = body.slice(startPos + iifeStartToken.length, endPos);
  // 去掉开头第一个空行
  innerBody = innerBody.replace(/^\s*\n/, '');

  // 移除最前面的 'use strict';，改为在每个模块中单独加 strict
  innerBody = innerBody.replace(/^\s*'use strict';\s*\n/, '');

  // ---- 修改「站点与参数」里的早退逻辑：把 top-level return 改成 WF_SHOULD_RUN 开关 ----
  const guardOriginal = [
    '  const IS_CHATGPT = /(?:^|\\.)chatgpt\\.com$|(?:^|\\.)chat\\.openai\\.com$/.test(location.hostname);',
    '  const u = new URL(location.href);',
    '  const wf = /(^|[?&])wf=1(&|$)/.test(u.search);',
    '  const token = (location.hash||\'\').replace(/^#/, \'\');',
    '  const relay = u.searchParams.get(\'relay\') || \'\';',
    '  const SKIP_SEND_KEY = `wf_skip_send_${token}`;',
    '  const MARKER_REFRESH_KEY = `wf_marker_refresh_${token}`;',
    '  ',
    '  const PARENT_ORIGIN = (() => { try { return new URL(relay).origin; } catch { return \'*\'; } })();',
    '  ',
    '  if (!IS_CHATGPT || !wf || !token || !relay) return;',
    '  END_MARK = `WF-END#${token.slice(0,6)}-${SID.slice(-4)}`;'
  ].join('\n');

  const guardReplacement = [
    '  const IS_CHATGPT = /(?:^|\\.)chatgpt\\.com$|(?:^|\\.)chat\\.openai\\.com$/.test(location.hostname);',
    '  const u = new URL(location.href);',
    '  const wf = /(^|[?&])wf=1(&|$)/.test(u.search);',
    '  const token = (location.hash||\'\').replace(/^#/, \'\');',
    '  const relay = u.searchParams.get(\'relay\') || \'\';',
    '  const SKIP_SEND_KEY = `wf_skip_send_${token}`;',
    '  const MARKER_REFRESH_KEY = `wf_marker_refresh_${token}`;',
    '  ',
    '  const PARENT_ORIGIN = (() => { try { return new URL(relay).origin; } catch { return \'*\'; } })();',
    '  ',
    '  const WF_SHOULD_RUN = IS_CHATGPT && wf && token && relay;',
    '  if (!WF_SHOULD_RUN) {',
    "    log('WF skipped: invalid context', { IS_CHATGPT, wf, token, relay });",
    '  } else {',
    '    END_MARK = `WF-END#${token.slice(0,6)}-${SID.slice(-4)}`;',
    '  }'
  ].join('\n');

  if (!innerBody.includes('WF_SHOULD_RUN')) {
    if (!innerBody.includes('if (!IS_CHATGPT || !wf || !token || !relay) return;')) {
      console.warn('[split-wf] 警告：没能找到预期的早退逻辑片段，只定义 WF_SHOULD_RUN 不改写早退。');
      innerBody = innerBody.replace(
        /const PARENT_ORIGIN[\s\S]+?return '\*'; } }\)\(\);/,
        match => match + '\n\n  const WF_SHOULD_RUN = IS_CHATGPT && wf && token && relay;\n'
      );
    } else {
      innerBody = innerBody.replace(guardOriginal, guardReplacement);
      console.log('[split-wf] 已把早退 return 改写成 WF_SHOULD_RUN 开关。');
    }
  }

  // ---- 把主流程 (async function main() { ... })(); 包一层 if (WF_SHOULD_RUN) ----
  const mainSectionMarker = '/** ─────────────── 主流程';
  // ⚠️ 使用 lastIndexOf：选择“最后一个 主流程 标题”，避免像你脚本里那样双写标题时拆成两段
  const idxMainSection = innerBody.lastIndexOf(mainSectionMarker);
  if (idxMainSection === -1) {
    console.warn('[split-wf] 警告：没找到“主流程” section 标题，跳过 WF_SHOULD_RUN 包裹。');
  } else {
    const afterCommentIdx = innerBody.indexOf('\n', idxMainSection);
    const before = innerBody.slice(0, afterCommentIdx + 1);
    const after  = innerBody.slice(afterCommentIdx + 1);

    // 在“最后一个主流程标题”下面插入 if 包裹
    innerBody = before + '  if (typeof WF_SHOULD_RUN === \'undefined\' || WF_SHOULD_RUN) {\n' + after;

    const mainEndMarker = '})(); // ✅ IIFE 结束';
    const idxMainEnd = innerBody.indexOf(mainEndMarker);
    if (idxMainEnd === -1) {
      console.warn('[split-wf] 警告：没找到 main IIFE 结束标记，无法自动补全 if 包裹，请检查脚本。');
    } else {
      const afterEndLineIdx = innerBody.indexOf('\n', idxMainEnd + mainEndMarker.length);
      const beforeEnd = innerBody.slice(0, afterEndLineIdx + 1);
      const afterEnd  = innerBody.slice(afterEndLineIdx + 1);
      innerBody = beforeEnd + '  }\n' + afterEnd;
      console.log('[split-wf] 已为 main IIFE 加上 WF_SHOULD_RUN 包裹。');
    }
  }

  // ---- 按 section 切片 ----
  const sections = splitBySections(innerBody);
  assert(sections.length > 0, '未能按 section 切出任何代码块');

  console.log('[split-wf] 按 section 切出了', sections.length, '个模块片段。');

  // ---- 准备输出目录：清理旧模块 ----
  if (!fs.existsSync(OUT_DIR)) {
    if (!DRY_RUN) fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log('[split-wf] 已创建目录：', OUT_DIR);
  } else if (!DRY_RUN) {
    const files = fs.readdirSync(OUT_DIR);
    for (const f of files) {
      if (/^wf-.*\.js$/.test(f)) {
        fs.unlinkSync(path.join(OUT_DIR, f));
      }
    }
    console.log('[split-wf] 已清理旧的 wf-*.js 模块文件。');
  }

  const usedSlugs   = new Set();
  const moduleFiles = [];
  const treeLines   = [];

  sections.forEach((sec) => {
    const slug     = pickSlugByTitle(sec.title, usedSlugs); // 不带编号，不自动 -2
    const fileName = `wf-${slug}.js`;
    const outPath  = path.join(OUT_DIR, fileName);

    const headerComment =
      `// 模块：${sec.title || '未命名片段'}（自动拆分自 wf.user.js）\n` +
      `'use strict';\n\n`;

    const normalizedLines = normalizeIndent(sec.lines);
    const bodyCode  = normalizedLines.join('\n').replace(/^\s*\n/, '');
    const finalCode = headerComment + bodyCode.trimEnd() + '\n';

    moduleFiles.push({ fileName, outPath, title: sec.title || '未命名片段' });
    treeLines.push(`${fileName} - ${sec.title || '未命名片段'}`);

    if (DRY_RUN) {
      console.log('------ 模拟写出模块：', outPath);
    } else {
      fs.writeFileSync(outPath, finalCode, 'utf8');
      console.log('[split-wf] 写出模块：', outPath);
    }
  });

  // ---- 生成 tree.txt ----
  if (DRY_RUN) {
    console.log('\n------ 模拟写出 tree.txt：\n' + treeLines.join('\n'));
  } else {
    fs.writeFileSync(TREE_FILE, treeLines.join('\n') + '\n', 'utf8');
    console.log('[split-wf] 已写出模块索引：', TREE_FILE);
  }

  // ---- 重写 wf.user.js：只保留元信息 + @require ----
  let metaLines = metaBlock.split('\n');

  // 去掉旧的 @require 行，避免重复
  metaLines = metaLines.filter(l => !/^\s*\/\/\s*@require\b/.test(l));

  const endLineIndex = metaLines.findIndex(l => l.trim() === '// ==/UserScript==');
  assert(endLineIndex !== -1, 'metaBlock 内竟然没有 ==/UserScript== 行');

  const requireLines = moduleFiles.map(m =>
    `// @require      ${BASE_URL}/tampermonkey/${m.fileName}`
  );

  const newMetaLines = [
    ...metaLines.slice(0, endLineIndex),
    ...requireLines,
    metaLines[endLineIndex],
  ];

  const newMetaBlock = newMetaLines.join('\n');

  const newMainBody =
    '\n// 所有逻辑均已拆分至 /tampermonkey 下的多个模块文件；\n' +
    '// 本文件仅作为 UserScript 元信息入口，请勿再在此处直接编写业务逻辑。\n';

  const newFull = newMetaBlock + newMainBody;

  if (DRY_RUN) {
    console.log('\n------ 模拟重写 wf.user.js，新内容预览：\n');
    console.log(newFull);
  } else {
    fs.writeFileSync(MAIN_FILE, newFull, 'utf8');
    console.log('[split-wf] 已重写入口文件：', MAIN_FILE);
  }

  console.log('\n[split-wf] 完成。共生成模块：', moduleFiles.length);
  console.log('[split-wf] 请确认静态服务已能访问：', BASE_URL + '/tampermonkey/…');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('[split-wf] 运行时异常：', e && e.stack || e);
    process.exit(1);
  }
}
