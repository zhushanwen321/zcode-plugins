#!/usr/bin/env node
'use strict';

/**
 * quality-gate —— 增量质量门禁（pr-cr-fix Gate-1 执行体，零依赖纯 Node）。
 *
 * 一次测试运行同时产出三个判定（测试执行就是覆盖率的产生过程，合一避免重复跑）：
 *   1. 单测执行（排除 e2e*.test.js，与 ci.yml 完全同构）——任一失败即 fail
 *   2. 增量覆盖率——diff 新增可执行行中被执行的占比 < 阈值 → fail
 *   3. introduced 函数圈复杂度（fail）+ CRAP 靶子（warn，喂 test-coverage reviewer）
 *
 * 覆盖率来源：NODE_V8_COVERAGE 原生 JSON（node --test 每个子进程各写一份，本脚本合并）。
 * 语义要点：每个 function 的 ranges[0] 是「定义区间」（count = 调用次数，不是执行证明），
 * ranges[1..] 才是体内已执行块；program entry（functionName ''）的 ranges[0] 是 script
 * 加载标记。已执行字符 = 所有函数 ranges[1..] count>0 的并集。
 *
 * 口径声明（启发式换零依赖，方向取舍显式化）：
 * - 圈复杂度 = 清洗注释/字符串后数 decision（if/for/while/case/catch + ?: ?. ?? && ||
 *   ||= &&= ??=；do 不数——其条件 while 已数；x.catch() 属性访问不数）。正则字面量
 *   不识别（体内 | ? 会被多数，高估方向偏保守）。嵌套函数区间由 V8 区间树精确剔除。
 * - 复杂度 fail 只追溯「新增函数」（新增行占函数 ≥50%）；存量函数被改不打回重构，
 *   其复杂度经 CRAP 靶子（kind=modified）交给 review 裁决——增量门禁只管 new code
 * - 可执行行 = 落在函数定义区间内，或落在顶层已执行子区间内。顶层未被加载路径执行的
 *   行（含注释/空行）不计入分母——宽松方向：漏杀好过误杀（误杀会卡日常流程）。
 * - 分母范围 = 插件 lib/ + bin/ 的 .js；dist/（构建产物）与 test/（测试自身）不进分母。
 * - 未出现在 V8 产物中的分母文件 = 零覆盖（计入 uncovered，拉低增量覆盖率，不特判）。
 * - 增量覆盖率阈值走 ratchet：默认 40 为引入期起步值（本仓实测基线 41.2%），终态
 *   目标 80（对齐 Sonar Way「new code ≥80%」/ xyz-agent Gate-1.6 口径）；随补测试
 *   逐步上调 --min-coverage，只升不降
 *
 * exit 语义：0 = pass；1 = fail（测试/覆盖率/复杂度）；2 = 工具错误。
 * 守卫（对齐 xyz-agent coverage-gate [HISTORICAL] 假 pass 教训）：git 异常、JSON 解析失败、
 * 测试 exit 0 但 V8 产物缺失、插件无 test/ 目录——一律 exit 2，绝不静默 pass。
 *
 * 用法：node .agents/skills/pr-cr-fix/scripts/quality-gate.js [--base main]
 *         [--min-coverage 80] [--max-complexity 15] [--crap-warn 30]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { fileURLToPath } = require('url');

// ── 导出的纯函数（供 test/quality-gate.test.js；主流程在文件底部）──

/**
 * 解析 `git diff --unified=0` 输出，提取每个文件的新增行号集合。
 * 删除文件（+++ /dev/null）不入结果。
 */
function parseDiffAddedLines(diffText) {
  const files = new Map();
  let cur = null;
  for (const raw of String(diffText).split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      cur = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (cur && !files.has(cur)) files.set(cur, new Set());
      continue;
    }
    if (!cur) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (!m) continue;
    const start = parseInt(m[1], 10);
    const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
    const set = files.get(cur);
    for (let i = 0; i < count; i++) set.add(start + i);
  }
  return files;
}

/** 换行位置前缀和：lineStart(1)=0，行号 1 起。 */
function buildLineIndex(source) {
  const starts = [0, 0]; // starts[line] = 行首偏移；index 0 占位
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return {
    lineStart(line) { return starts[line] !== undefined ? starts[line] : source.length; },
    lineEnd(line) {
      return starts[line + 1] !== undefined ? starts[line + 1] : source.length;
    },
    offsetToLine(offset) {
      let lo = 1, hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
      }
      return lo;
    },
  };
}

/** 排序去重合并区间（相邻/重叠合并；输入 [start,end) 数组）。 */
function unionRanges(ranges) {
  const sorted = ranges
    .filter((r) => r[1] > r[0])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** 区间集合（已合并）与单个区间是否有交集。 */
function rangesIntersect(merged, start, end) {
  let lo = 0, hi = merged.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (merged[mid][1] <= start) lo = mid + 1;
    else if (merged[mid][0] >= end) hi = mid - 1;
    else return true;
  }
  return false;
}

/**
 * 注释/字符串清洗：等长替换为空白，保留代码骨架供 decision 计数。
 * 模板字面量文本清洗，但 ${} 插值按代码处理（插值里的三元/逻辑或是真分支，
 * 应计数）；插值内花括号深度追踪，块语句/对象字面量的 } 不会误关插值。
 */
function cleanForComplexity(code) {
  const out = code.split('');
  let i = 0;
  // 栈元素：{type:'tpl'} 模板文本层 | {type:'expr',depth} 插值代码层
  const stack = [];
  const top = () => stack[stack.length - 1];
  const skipString = (quote) => {
    out[i++] = ' ';
    while (i < out.length && out[i] !== quote) {
      if (out[i] === '\\') out[i++] = ' ';
      out[i++] = ' ';
    }
    if (i < out.length) out[i++] = ' ';
  };
  while (i < out.length) {
    const c = out[i];
    const next = out[i + 1];
    const m = top();
    if (m && m.type === 'tpl') {
      if (c === '`') { stack.pop(); out[i++] = ' '; continue; }
      if (c === '$' && next === '{') { stack.push({ type: 'expr', depth: 0 }); out[i++] = ' '; out[i++] = ' '; continue; }
      if (c === '\\') { out[i++] = ' '; out[i++] = ' '; continue; }
      out[i++] = ' ';
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < out.length && out[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      out[i++] = ' '; out[i++] = ' ';
      while (i < out.length && !(out[i] === '*' && out[i + 1] === '/')) out[i++] = ' ';
      if (i < out.length) { out[i++] = ' '; out[i++] = ' '; }
      continue;
    }
    if (c === "'" || c === '"') { skipString(c); continue; }
    if (c === '`') { stack.push({ type: 'tpl' }); out[i++] = ' '; continue; }
    if (m && m.type === 'expr') {
      if (c === '{') { m.depth++; out[i++] = ' '; continue; }
      if (c === '}') {
        if (m.depth > 0) m.depth--;
        else stack.pop();
        out[i++] = ' ';
        continue;
      }
    }
    i++;
  }
  return out.join('');
}

const DECISION_WORDS = new Set(['if', 'for', 'while', 'case', 'catch']);
const IDENT = /[A-Za-z_$]/;

/** 清洗后源码的 decision-point 计数（do 不数：do-while 的 while 已计入；
 *  `x.catch(...)` 属性访问不数：前驱非空字符为 '.' 时是方法名不是 catch 子句）。 */
function countDecisions(cleaned) {
  let n = 0;
  let i = 0;
  let prev = ''; // 上一个非空字符
  const s = cleaned;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { i++; continue; }
    if (IDENT.test(c)) {
      let j = i + 1;
      while (j < s.length && (IDENT.test(s[j]) || /[0-9]/.test(s[j]))) j++;
      const word = s.slice(i, j);
      if (DECISION_WORDS.has(word) && !(word === 'catch' && prev === '.')) n++;
      prev = s[j - 1];
      i = j;
      continue;
    }
    if (c === '?') {
      const next = s[i + 1];
      if (next === '.') { i += 2; prev = '.'; continue; }       // ?.
      if (next === '?') { n++; i += s[i + 2] === '=' ? 3 : 2; prev = '='; continue; } // ?? / ??=
      n++; i++; prev = '?'; continue;                            // 三元
    }
    if (c === '&') {
      if (s[i + 1] === '&') { n++; i += s[i + 2] === '=' ? 3 : 2; prev = '='; continue; } // && / &&=
      i++; prev = '&'; continue;
    }
    if (c === '|') {
      if (s[i + 1] === '|') { n++; i += s[i + 2] === '=' ? 3 : 2; prev = '='; continue; } // || / ||=
      i++; prev = '|'; continue;
    }
    prev = c;
    i++;
  }
  return n;
}

/**
 * 函数圈复杂度：funcRange 为函数定义区间（相对 source 偏移），childRanges 为
 * 直接/间接嵌套函数区间（相对 source 偏移）——先挖空再清洗计数，避免把内层
 * 函数的分支计入外层。
 */
function complexityOf(source, funcRange, childRanges) {
  const chars = source.split('');
  for (const [cs, ce] of childRanges) {
    for (let k = Math.max(cs, funcRange[0]); k < Math.min(ce, funcRange[1]); k++) chars[k] = ' ';
  }
  const body = chars.slice(funcRange[0], funcRange[1]).join('');
  return 1 + countDecisions(cleanForComplexity(body));
}

/** CRAP = comp² × (1-cov)³ + comp（Bob Martin / CRAP4J）。 */
function crapScore(comp, cov) {
  const c = Math.min(1, Math.max(0, cov));
  return comp * comp * Math.pow(1 - c, 3) + comp;
}

// ── 覆盖率产物合并 ──

/**
 * 合并一个 NODE_V8_COVERAGE 目录下的全部 JSON 为按文件聚合的结构。
 * 返回 Map<absPath, { funcs: [{name, range}], execMerged: [ranges] }>
 * funcs 的 range = 定义区间（ranges[0]，用于行归属与复杂度）；execMerged =
 * 所有函数 ranges[1..] count>0 的并集（真实已执行字符）。
 */
function mergeCoverageDir(dir) {
  const byFile = new Map();
  const jsons = fs.readdirSync(dir).filter((f) => f.startsWith('coverage-') && f.endsWith('.json'));
  for (const jf of jsons) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, jf), 'utf8'));
    } catch (e) {
      toolError(`V8 覆盖 JSON 解析失败：${jf}（${e.message}）`);
    }
    for (const entry of parsed.result || []) {
      if (!entry.url || !entry.url.startsWith('file://')) continue;
      let abs;
      try { abs = fileURLToPath(entry.url); } catch { continue; }
      let agg = byFile.get(abs);
      if (!agg) { agg = { funcs: [], funcKeys: new Set(), exec: [] }; byFile.set(abs, agg); }
      for (const fn of entry.functions || []) {
        const r0 = fn.ranges && fn.ranges[0];
        if (!r0) continue;
        const key = `${r0.startOffset}-${r0.endOffset}-${fn.functionName}`;
        if (!agg.funcKeys.has(key)) {
          agg.funcKeys.add(key);
          agg.funcs.push({ name: fn.functionName, range: [r0.startOffset, r0.endOffset] });
        }
        // V8 ranges 语义（探针实证）：ranges[0] 是函数整体区间，count>0 即主体已执行；
        // 后续子区间是计数不同的嵌套块，count===0 的为未执行分支，须从主体剔除。
        // （原实现只收集 k≥1 且 count>0 的子区间——那是分支间执行次数差异区，
        //  漏记无差异的执行主体，导致增量覆盖率系统性低估）
        if (r0.count > 0) {
          const holes = [];
          for (let k = 1; k < fn.ranges.length; k++) {
            if (fn.ranges[k].count === 0) holes.push(fn.ranges[k]);
          }
          let cursor = r0.startOffset;
          for (const h of holes) {
            if (h.startOffset > cursor) agg.exec.push([cursor, h.startOffset]);
            if (h.endOffset > cursor) cursor = h.endOffset;
          }
          if (r0.endOffset > cursor) agg.exec.push([cursor, r0.endOffset]);
        }
      }
    }
  }
  for (const agg of byFile.values()) agg.execMerged = unionRanges(agg.exec);
  return byFile;
}

// ── 主流程 ──

function toolError(msg) {
  process.stderr.write(`quality-gate: 工具错误（exit 2）：${msg}\n`);
  process.exit(2);
}

function usage() {
  return [
    '用法：node quality-gate.js [--base main] [--min-coverage 40] [--max-complexity 15] [--crap-warn 30]',
    '  --base <ref>          diff base（默认 main）',
    '  --min-coverage <pct>  增量覆盖率阈值（ratchet 起步值 40，终态目标 80，只升不降）',
    '  --max-complexity <n>  新增函数圈复杂度上限（默认 15，超过 fail；存量函数只进 CRAP 靶子）',
    '  --crap-warn <n>       CRAP 靶子阈值（默认 30，达到即列入 warn 清单）',
    '产物：.review/quality.json（含 uncoveredFiles / filesWithoutCoverage /',
    '      complexityFail / highCrap——review-test-coverage agent 的消费契约）',
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const opt = { base: 'main', minCoverage: 40, maxComplexity: 15, crapWarn: 30 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base') opt.base = args[++i];
    else if (args[i] === '--min-coverage') opt.minCoverage = Number(args[++i]);
    else if (args[i] === '--max-complexity') opt.maxComplexity = Number(args[++i]);
    else if (args[i] === '--crap-warn') opt.crapWarn = Number(args[++i]);
    else toolError(`未知参数 ${args[i]}。\n${usage()}`);
  }

  const repoRoot = execGit(['rev-parse', '--show-toplevel']).trim();
  process.chdir(repoRoot);

  let mergeBase;
  try {
    mergeBase = execGit(['merge-base', opt.base, 'HEAD']).trim();
    if (!mergeBase) throw new Error('empty');
  } catch (e) {
    toolError(`取 merge-base(${opt.base}, HEAD) 失败：${e.message}。确认 base ref 存在（git rev-parse --verify ${opt.base}）后重试`);
  }

  const diffText = execGit(['diff', `${mergeBase}...HEAD`, '--unified=0', '--diff-filter=AM', '--', '*.js']);
  const addedByFile = parseDiffAddedLines(diffText);

  // 分母文件：插件 lib/ + bin/ 下的 .js（排除 dist/ 构建产物、test/ 测试自身）
  const scopeByPlugin = new Map();
  for (const [file, lines] of addedByFile) {
    const m = /^([^/]+)\/(lib|bin)\/.*\.js$/.exec(file);
    if (!m || lines.size === 0) continue;
    const plugin = m[1];
    if (!fs.existsSync(path.join(repoRoot, plugin, 'package.json'))) continue;
    if (!scopeByPlugin.has(plugin)) scopeByPlugin.set(plugin, []);
    scopeByPlugin.get(plugin).push({ file, lines: [...lines].sort((a, b) => a - b) });
  }

  const report = { base: opt.base, mergeBase, head: execGit(['rev-parse', 'HEAD']).trim(), plugins: {} };
  const reasons = [];

  if (scopeByPlugin.size === 0) {
    report.verdict = 'pass';
    report.reasons = ['no-scope：diff 无插件 lib/bin 的 .js 新增行（纯文档/测试/脚本改动），无门禁对象'];
    writeReport(report);
    process.stdout.write('quality-gate: pass（no-scope，diff 无 lib/bin 新增行）\n');
    return;
  }

  for (const [plugin, scopeFiles] of scopeByPlugin) {
    const pluginDir = path.join(repoRoot, plugin);
    const testDir = path.join(pluginDir, 'test');
    if (!fs.existsSync(testDir)) toolError(`插件 ${plugin} 无 test/ 目录，覆盖率无从产生——先补测试再跑门禁`);

    const testFiles = collectTestFiles(testDir);
    if (testFiles.length === 0) toolError(`插件 ${plugin} 的 test/ 下无 *.test.js（e2e* 排除后）`);

    const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-'));
    const env = { ...process.env, NODE_V8_COVERAGE: covDir };
    let testsPassed = true;
    process.stdout.write(`quality-gate: 跑 ${plugin} 单测（${testFiles.length} 个文件，e2e* 已排除）…\n`);
    try {
      execFileSync(process.execPath, ['--test', ...testFiles], {
        cwd: pluginDir, env, stdio: ['ignore', 'inherit', 'inherit'],
      });
    } catch (e) {
      testsPassed = false;
      reasons.push(`${plugin}: tests-failed（见上方 TAP 输出，按失败用例修复后重跑）`);
    }

    const covByFile = mergeCoverageDir(covDir);
    fs.rmSync(covDir, { recursive: true, force: true });
    if (testsPassed && covByFile.size === 0) {
      toolError(`${plugin}: 测试 exit 0 但 V8 覆盖产物为空（NODE_V8_COVERAGE 未生效？）——记账不闭合，拒绝静默 pass`);
    }
    testsPassedByPlugin.set(plugin, testsPassed);
    report.plugins[plugin] = computePluginMetrics(plugin, scopeFiles, covByFile, opt);
  }

  // 判定
  for (const [plugin, m] of Object.entries(report.plugins)) {
    if (!m.testsPassed) continue; // 已记录 reasons
    if (m.complexityFail.length) {
      reasons.push(`${plugin}: complexity-fail（${m.complexityFail.length} 个 introduced 函数圈复杂度 > ${opt.maxComplexity}：${m.complexityFail.map((f) => `${f.name || '(anonymous)'}@${f.file}:${f.line}(${f.comp})`).join(', ')}）`);
    }
    if (m.coverage.total > 0 && m.coverage.pct < opt.minCoverage) {
      reasons.push(`${plugin}: coverage-fail（增量覆盖率 ${m.coverage.pct}% < ${opt.minCoverage}%；缺口见 .review/quality.json uncoveredFiles，按 missed 降序补测试）`);
    }
  }
  report.verdict = reasons.length ? 'fail' : 'pass';
  report.reasons = reasons;
  writeReport(report);

  const summary = Object.entries(report.plugins).map(([p, m]) => {
    const cov = m.coverage.total > 0 ? `${m.coverage.pct}%（${m.coverage.covered}/${m.coverage.total} 行）` : '(无新增可执行行)';
    return `- ${p}: tests=${m.testsPassed ? 'pass' : 'FAIL'} incremental-coverage=${cov} complexity-fail=${m.complexityFail.length} crap-warn=${m.highCrap.length}`;
  }).join('\n');
  process.stdout.write(`quality-gate: ${report.verdict}\n${summary}\n`);
  if (report.verdict === 'fail') {
    process.stdout.write(`\n失败原因：\n${reasons.map((r) => `- ${r}`).join('\n')}\n`);
    process.exit(1);
  }
}

function execGit(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    toolError(`git ${args.join(' ')} 失败：${e.message.split('\n')[0]}`);
  }
}

/** 递归收集 test/ 下 *.test.js，排除 e2e*（与 ci.yml 模式一致）。返回绝对路径。 */
function collectTestFiles(testDir) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.test\.js$/.test(name) && !/^e2e/.test(name)) out.push(full);
    }
  };
  walk(testDir);
  return out;
}

function computePluginMetrics(plugin, scopeFiles, covByFile, opt) {
  const result = {
    testsPassed: !reportHasTestsFailed(plugin),
    coverage: { covered: 0, total: 0, pct: null },
    uncoveredFiles: [],
    filesWithoutCoverage: [],
    complexityFail: [],
    highCrap: [],
  };
  for (const { file, lines } of scopeFiles) {
    const abs = path.resolve(file);
    const entry = covByFile.get(abs);
    let source = null, li = null;
    if (entry) {
      try { source = fs.readFileSync(abs, 'utf8'); } catch { source = null; }
      if (source !== null) li = buildLineIndex(source);
    }
    if (!entry || source === null) {
      result.filesWithoutCoverage.push(file);
      result.coverage.total += lines.length; // 零覆盖，全部计入缺口
      continue;
    }

    // program entry（script 本身）：name '' 且区间从文件 0 起——不算普通函数
    const funcs = entry.funcs.filter((f) => !(f.name === '' && f.range[0] === 0));
    const execMerged = entry.execMerged;
    let missed = 0;

    // 行级增量覆盖。可执行行 = 落在函数定义区间内，或（顶层）与已执行字符
    // 相交——顶层未执行路径与注释/空行天然不计入分母（宽松口径，见头部声明）
    for (const L of lines) {
      const ls = li.lineStart(L), le = li.lineEnd(L);
      if (le <= ls) continue; // 空行
      const inFunc = funcs.some((f) => f.range[0] < le && f.range[1] > ls);
      const executed = rangesIntersect(execMerged, ls, le);
      if (!inFunc && !executed) continue;
      result.coverage.total++;
      if (executed) result.coverage.covered++;
      else missed++;
    }
    if (missed > 0) result.uncoveredFiles.push({ file, missed, total: lines.length });

    // introduced 函数：定义区间与任一新增行相交。
    // fail 只追溯「新增函数」（新增行占函数字符 ≥ 50%）——存量函数被改不
    // 打回重构（追溯原罪会卡死存量流程），其复杂度经 CRAP 靶子交给 review 裁决
    const lineSpans = lines.map((L) => [li.lineStart(L), li.lineEnd(L)]);
    for (const f of funcs) {
      const len = f.range[1] - f.range[0];
      let addedChars = 0;
      for (const [ls, le] of lineSpans) {
        if (f.range[0] < le && f.range[1] > ls) addedChars += Math.min(le, f.range[1]) - Math.max(ls, f.range[0]);
      }
      if (addedChars <= 0) continue;
      const isNewFunction = addedChars / Math.max(1, len) >= 0.5;
      const children = funcs
        .filter((g) => g !== f && g.range[0] >= f.range[0] && g.range[1] <= f.range[1])
        .map((g) => g.range);
      const comp = complexityOf(source, f.range, children);
      let coveredChars = 0;
      for (const [es, ee] of execMerged) {
        coveredChars += Math.max(0, Math.min(ee, f.range[1]) - Math.max(es, f.range[0]));
      }
      const cov = len > 0 ? coveredChars / len : 1;
      const item = {
        file, line: li.offsetToLine(f.range[0]), name: f.name || '(anonymous)',
        comp, cov: Math.round(cov * 1000) / 1000,
      };
      if (isNewFunction && comp > opt.maxComplexity) result.complexityFail.push({ ...item, kind: 'new' });
      const crap = Math.round(crapScore(comp, cov) * 10) / 10;
      if (crap >= opt.crapWarn) result.highCrap.push({ ...item, crap, kind: isNewFunction ? 'new' : 'modified' });
    }
  }
  result.coverage.pct = result.coverage.total > 0
    ? Math.round((result.coverage.covered / result.coverage.total) * 1000) / 10
    : null;
  result.highCrap.sort((a, b) => b.crap - a.crap);
  result.uncoveredFiles.sort((a, b) => b.missed - a.missed);
  return result;
}

// testsPassed 的传递：main 循环里先跑测试再调本函数，用模块级临时表解耦
const testsPassedByPlugin = new Map();
function reportHasTestsFailed(plugin) { return testsPassedByPlugin.get(plugin) === false; }

function writeReport(report) {
  const dir = path.resolve('.review');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'quality.json'), JSON.stringify(report, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = {
  parseDiffAddedLines, buildLineIndex, unionRanges, rangesIntersect,
  cleanForComplexity, countDecisions, complexityOf, crapScore,
};
