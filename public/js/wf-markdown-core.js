// Markdown 核心：纯函数、无 DOM
// 仅处理 $...$ / $$...$$ 内部内容，去除 \! \, 等间距命令，并修复常见误写
// 仅清理数学环境：修正 \! / \, 遗留导致的 "!"、",,"；
// 纠正逗号当乘号；修复 \begin{cases} 行末漏 \\；只作用于 $...$ / $$...$$ 内
// 仅处理 $...$ / $$...$$ 内部内容；去噪不做特例替换；保留阶乘/双阶乘
// 仅处理 $...$ / $$...$$ 内部内容；
//  - 去掉 \! / \, 之类的间距命令；
//  - 清理明显错误的 "!\big["、"\mathbb{E}!"、连续逗号等；
//  - 尽量保留正常的阶乘 x! 与双阶乘 x!!。
function normalizeMathInMarkdown(md) {
  if (!md) return md;

  // —— 保护所有数学块 —— //
  const holes = [];
  const HOLE = i => `\uE000MM${i}\uE001`;
  const text = String(md)
    .replace(/\$\$[\s\S]*?\$\$/g, m => { holes.push(m); return HOLE(holes.length - 1); })
    .replace(/\$(?:\\.|[^$\n])+?\$/g, m => { holes.push(m); return HOLE(holes.length - 1); });

  const fixSingleBackslashBreaks = (s) =>
    s.replace(/(^|[^\\])\\(\s*\n)/g, '$1\\\\$2');

  const cleanMath = (mathSrc) => {
    let m = mathSrc;

    // 1) 保护 \text{...}，避免里面的中文标点被误清理
    const textHoles = [];
    const TEXT_HOLE = j => `\uE000TX${j}\uE001`;
    m = m.replace(/\\text\{(?:[^{}]|\{[^{}]*\})*\}/g, t => {
      textHoles.push(t);
      return TEXT_HOLE(textHoles.length - 1);
    });

    // 2) 去掉间距命令 / 微调命令
    m = m.replace(/\\!/g, '');   // \! 本来就是“紧一点”，直接干掉
    m = m.replace(/\\,/g, ' ');  // \, 换成普通空格

    // 3) 整理逗号 / 分号
    m = m.replace(/([,，;；])\s*(?=\1)/g, '');      // 连着写好几个一样的只留一个
    m = m.replace(/([,，;；]){2,}/g, '$1');
    m = m.replace(/([,，;；])+\s*$/gm, '');        // 行尾的逗号 / 分号直接去掉

    // 4) ; 附近的关系/运算符，去掉多余的 ;
    const relCmd =
      '(?:cdot|times|propto|sim|approx|equiv|le|ge|ne|neq|pm|mp|to|rightarrow|Rightarrow|' +
      'longrightarrow|Longrightarrow|mapsto|iff|implies|land|lor|wedge|vee|subset|supset|in|notin)';

    m = m.replace(new RegExp('\\s*[;；]+\\s*(\\\\' + relCmd + ')\\s*[;；]+\\s*', 'g'), ' $1 ');
    m = m.replace(new RegExp('[;；]+\\s*(\\\\' + relCmd + ')', 'g'), ' $1');
    m = m.replace(new RegExp('(\\\\' + relCmd + ')\\s*[;；]+', 'g'), '$1 ');
    m = m.replace(/\s*[;；]+\s*([=+\-*/])\s*[;；]+\s*/g, ' $1 ');
    m = m.replace(/[;；]+\s*([=+\-*/])/g, ' $1');
    m = m.replace(/([=+\-*/])\s*[;；]+/g, '$1 ');

    // 5) 一些典型的感叹号误用场景（先做“特例”，再做通用规则）
    // 5.1 \mathbb{E}!、\mathbb{P}! 这种几乎肯定是打错
    m = m.replace(/(\\mathbb\{[EP]\})\s*!/g, '$1');

    // 5.2 像 "]!\big["、")!\left(" —— 把 "!" 看成误打
    m = m.replace(/([\]\)])\s*!\s*(?=\\(big|Big|bigg|Bigg|left|right)\b)/g, '$1 ');

    // 5.3 "!\\big" / "!\\left" / "!\\right" / "!\\sum" / "!\\int" 等统统视为误插
    m = m.replace(/!\s*(?=\\(big|Big|bigg|Bigg|left|right|sum|int|prod|lim|max|min)\b)/g, '');

    // 6) 通用感叹号规则（在上面这些特例之后）
    m = m.replace(new RegExp('!\\s*(\\\\' + relCmd + ')', 'g'), '$1');  // !\Rightarrow -> \Rightarrow
    m = m.replace(new RegExp('(\\\\' + relCmd + ')\\s*!', 'g'), '$1');  // \Rightarrow! -> \Rightarrow
    m = m.replace(/!\s*([=+\-*/<>])/g, '$1');                           // !=, !+ 等
    m = m.replace(/([=+\-*/<>])\s*!/g, '$1');                           // =!, +! 等
    m = m.replace(/\s+!\s+/g, ' ');                                     // 两边都是空格的孤立 !

    // 非“阶乘位置”的 ! 串：前一个字符不是 字母/数字/右括号/右花括号，直接删掉
    m = m.replace(/(?<![\w)\}])!+/g, '');

    // 合理阶乘位置（x!!! 这种）：收敛为 x!!
    m = m.replace(/(?<=([\w)\}]))!{3,}/g, '!!');

    // 7) cases / array 环境里行尾漏写 "\\" 的修补
    m = m.replace(/(\\begin\{(?:cases|array)\}[\s\S]*?\\end\{(?:cases|array)\})/g, s =>
      fixSingleBackslashBreaks(s).replace(/([^\\])\\(\s*\n)/g, '$1\\\\$2')
    );
    m = fixSingleBackslashBreaks(m);

    // 8) 把“变量之间误用的逗号”看成乘号：如 \gamma,\Phi -> \gamma \cdot \Phi
    m = m.replace(
      /((?:\\[A-Za-z]+|\w|\)))\s*,\s*((?:\\[A-Za-z]+|\w|\())/g,
      '$1 \\cdot $2'
    );

    // 9) 恢复 \text{...}
    m = m.replace(/\uE000TX(\d+)\uE001/g, (_, j) => textHoles[+j] || '');

    // 10) 收尾：多余空格压缩一下
    m = m.replace(/[ \t]{2,}/g, ' ');

    return m;
  };

  // —— 把所有数学块清洗后再放回 —— //
  const out = text.replace(/\uE000MM(\d+)\uE001/g, (_, i) => {
    const orig = holes[+i] || '';
    if (!orig) return orig;
    if (/^\$\$[\s\S]*\$\$$/.test(orig)) {
      return orig.replace(/^\$\$(.*)\$\$$/s, (_, inner) => `$$${cleanMath(inner)}$$`);
    } else {
      return orig.replace(/^\$(.*)\$/s,   (_, inner) => `$${cleanMath(inner)}$`);
    }
  });

  return out;
}

/**
 * @function cleanDefSectionListLines
 * @brief 在 # 定义 区块内，仅保留以 "* **" 开头的行，其余行删除
 *
 * @param md 原始 Markdown
 * @returns 处理后的 Markdown
 *
 * @details
 * 范围：从第一行 "# 定义" 开始，到下一个以 "# " 开头的一级标题（如 "# 解释"、"# XXX"）之前
 **/
function cleanDefSectionListLines(md){
  if (!md) return md;
  const lines = String(md).split(/\r?\n/);

  let inDefBlock = false;
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 进入「定义」块
    if (/^#\s*定义\s*$/.test(trimmed)) {
      inDefBlock = true;
      out.push(line);
      continue;
    }

    // 只把 "# xxx" 当作“下一个章节”，退出定义块
    if (inDefBlock && /^#\s+(?!#).+/.test(trimmed)) {
      inDefBlock = false;
      out.push(line);
      continue;
    }

    if (inDefBlock) {
      // 允许 "* **" 列表行 + "##" 小标题行
      if (/^\s*\*\s+\*\*/.test(line) || /^\s*##\s+/.test(line)) {
        out.push(line);
      }
      continue;
    }

    // 非定义块内容原样保留
    out.push(line);
  }

  return out.join('\n');
}

/**
 * @function stripDefSectionSubheadings
 * @brief 去掉 # 定义 与 # 解释 之间所有形如 `## XXXX` 的二级小标题
 * @param md 原始 Markdown 字符串
 * @returns 处理后的 Markdown 字符串
 * @details
 *  - 仅删除标题行本身（`## XXX`），不删除其后的正文内容
 *  - 范围为：遇到第一行 `# 定义` 之后，直到遇到下一行 `# 解释` 之前
 */
// 统一改成：# 定义 → 下一个 # XXX 之间，干掉所有 ## 子标题
// 只把 "# xxx" 当作下一个章节；"## xxx" 保留在块内（但会在这里被删）
// 只把 "# xxx" 当作下一个章节；"## xxx" 保留在块内（但会在这里被删）
function stripDefSectionSubheadings(md){
  if (!md) return md;
  const lines = String(md).split(/\r?\n/);
  let inDefBlock = false;
  const out = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // 进入「定义」块
    if (/^#\s*定义\s*$/.test(trimmed)) {
      inDefBlock = true;
      out.push(line);
      continue;
    }

    if (inDefBlock) {
      // 在 # 定义 区间内的二级标题 `## XXXX` → 丢弃，但不退出块
      if (/^##\s+.+/.test(trimmed)) {
        continue;
      }

      // 遇到下一个“真正的”一级标题："# 标题"（第二个字符不是 #）
      if (/^#\s+(?!#).+/.test(trimmed)) {
        inDefBlock = false;
        out.push(line);
        continue;
      }
    }

    out.push(line);
  }

  return out.join('\n');
}

function isPureAlphabet(s){ return /^[A-Za-z]+$/.test(String(s||'').trim()); }

// 保护数学片段，避免被 marked 提前吃掉
function protectMath(md){
  const holes = [];
  const HOLE = i => `\uE000M${i}\uE001`;
  const text = String(md || '')
    // 先保护块级 $$...$$
    .replace(/\$\$[\s\S]*?\$\$/g, m => { holes.push(m); return HOLE(holes.length-1); })
    // 再保护行内 $...$ （尽量避免跨行）
    .replace(/\$(?:\\.|[^$\n])+?\$/g, m => { holes.push(m); return HOLE(holes.length-1); });
  const restore = html => html.replace(/\uE000M(\d+)\uE001/g, (_,i)=>holes[+i]);
  return { text, restore };
}

function mdToHtml(md){
  md = normalizeMathInMarkdown(md);
  const { text, restore } = protectMath(md);
  marked.setOptions({
    gfm: true,
    breaks: false,
    headerIds: true,
    mangle: false,
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      try { return hljs.highlight(code, { language: lang }).value; }
      catch { try { return hljs.highlightAuto(code).value; } catch { return code; } }
    }
  });
  let html = marked.parse(text || '');
  html = restore(html);     // 把 $$...$$ 和 $...$ 放回去
  return html;
}


function extractTagsAndClean(mdRaw){
  if (!mdRaw) return { tags: [], body: '' };

  const lines = String(mdRaw).split(/\r?\n/);

  // 顶部标签行：* **标签：** xxx
  let tagLine = '';
  if (lines.length && lines[0].includes('标签')) {
    tagLine = lines.shift();
  }

  let s = tagLine.replace(/^\s*\*\s*\*\*标签：\*\*\s*/,'').trim();
  let tags = s
    ? s.split(/[；;，,、/／]/).map(x => x.trim()).filter(Boolean)
    : [];

  // —— 按是否处于「# 练习题」块拆分为多个 section —— //
  const sections = [];
  let buf = [];
  let inExercise = false;

  const flush = () => {
    if (!buf.length) return;
    sections.push({
      kind: inExercise ? 'exercise' : 'normal',
      text: buf.join('\n')
    });
    buf = [];
  };

  for (const ln of lines) {
    const trimmed = ln.trim();

    // 进入/重新开始「练习题」块：# 练习题 ...
    if (/^#\s*练习题\b/.test(trimmed)) {
      flush();
      inExercise = true;
      buf.push(ln);
      continue;
    }

    // 其它顶级标题：# XXX
    if (/^#\s+(?!#).+/.test(trimmed)) {
      flush();
      inExercise = false;
      buf.push(ln);
      continue;
    }

    buf.push(ln);
  }
  flush();

  // —— 普通段落：沿用原来的“强清洗”逻辑 —— //
  const processNormal = (text) => {
    let body = String(text || '');

    // 先修复小数：6。4 → 6.4
    body = body.replace(/(\d)。(\d)/g, '$1.$2');

    // 再做句号 → 分号，以及去掉【约束说明】之类
    body = body
      .replace(/。/g, '；')
      .replace(/【[^】]*】/g, '');

    // 1) 去掉所有水平分割线行 ---
    body = body.replace(/^\s*---\s*$/gm, '');

    // 2) 合并形如：
    //    * **是什么：**
    //      当你……
    //    → * **是什么：**  当你……
    body = body.replace(
      /^(\s*(?:[*+-]\s+)?\*\*[^*\n]+?[：:]\*\*)\s*\n([ \t]*)(\S.*)$/gm,
      '$1  $3'
    );

    // 术语行去重：
    //   用户界面 用户界面（User Interface）： → 用户界面（User Interface）：
    body = body.replace(
      /^(\s*(?:[*+-]\s+)?)\*\*([\u4e00-\u9fa5A-Za-z0-9·\- ]+?)\s+\2(\s*[（(][^）)]*[）)][：:]\*\*)/gm,
      '$1**$2$3'
    );

    body = body.replace(
      /^(\s*(?:[*+-]\s+)?)\*\*([\u4e00-\u9fa5·\- ]+?)\s+([\u4e00-\u9fa5·\- ]+?)(\s*[（(][^）)]*[）)][：:]\*\*)/gm,
      '$1**$2$4'
    );

    // 数学块规范化（处理 \! / \, 等）
    body = normalizeMathInMarkdown(body);

    // 只在包含 # 定义 的块内生效，其他块等效 no-op
    body = cleanDefSectionListLines(body);

    body = body.replace(/(\d)\s*\.\s*(\d)/g, '$1.$2');

    return body;
  };

  // —— 练习题段落：只做“轻清洗”，不动排版结构 —— //
  const processExercise = (text) => {
    let body = String(text || '');

    // 同样先修复小数：6。4 → 6.4
    body = body.replace(/(\d)。(\d)/g, '$1.$2');

    // 再做句号 → 分号（保留小数点）
    body = body.replace(/。/g, '；');

    // 数学块规范化即可，其他结构保持原样
    body = normalizeMathInMarkdown(body);

    body = body.replace(/(\d)\s*\.\s*(\d)/g, '$1.$2');

    // 不删 ---，不合并 * **标题：** 下一行，不跑 cleanDefSectionListLines
    return body;
  };

  const cleanedParts = sections.map(sec =>
    sec.kind === 'exercise'
      ? processExercise(sec.text)
      : processNormal(sec.text)
  );

  const body = cleanedParts.join('\n');

  return { tags: [...new Set(tags)], body };
}

function parseMetaFromMD(mdRaw){
  const head = String(mdRaw||'').split(/\r?\n/).slice(0, 50).join('\n');
  const rxZh   = /\*\s*\*\*中文名[:：]\*\*\s*([^\n；;]+)\s*[；;]/i;
  const rxEn   = /\*\s*\*\*英文全称[:：]\*\*\s*([^\n；;]+)\s*[；;]/i;
  const rxAbbr = /\*\s*\*\*英文缩写[:：]\*\*\s*([^\n；;]+)\s*[；;]/i;
  const zhName = (head.match(rxZh)?.[1] || '').trim();
  const enFull = (head.match(rxEn)?.[1] || '').trim();
  const enAbbr = (head.match(rxAbbr)?.[1] || '').trim();
  return { zhName, enFull, enAbbr };
}


