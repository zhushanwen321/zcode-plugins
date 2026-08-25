'use strict';
/**
 * review-fix-loop workflow：并行 review → 聚合 must-fix → fix → 重审，循环到 clean。
 * 对标 pi-subagent-workflow 的 review-fix-loop.js（简化版，差异见 README）：
 * - 审查者 = 视角名（非 agent .md 文件）
 * - 聚合 = JS 去重合并（pi 用 LLM aggregator）
 * - 无 autoCommit（永不提交，改动留给用户）
 * - 保留：批内循环 / clean 审查者跳过 / maxRounds / 停滞检测
 * 唯一带写操作的工作流（fix 阶段修改文件）。
 *
 * zsub 移植差异（相对 dynamic-workflow/lib/review-fix-loop.js，循环/熔断/聚合语义不变）：
 * - 模型解析：driver.resolveModelRef → ModelRouter.resolve。显式指定 model 的
 *   校验行为一致；未指定时默认值来源不同——源版返回固定 DEFAULT_MODEL 常量，
 *   zsub 跟随 v2 config 的 model.main（读不到回退 GLM-5.3），并对非
 *   builtin:bigmodel-coding-plan provider 提前报错。
 * - 隔离 HOME：源版在 workflow 入口显式 bootstrapIsolatedHome（每次运行重写配置）；
 *   zsub 由 run-phase 内 prepareRunEnv 按需 bootstrap（mtime 条件重写，幂等语义等价），
 *   本模块不再触碰 HOME 写盘。
 * - runPhase 调用补 modelRef 透传（zsub 的 per-model HOME 池按模型隔离，源版无此参数）。
 * - pool/jsonout 在 zsub 位于 lib/ 根而非 lib/workflow/，require 路径改 ../pool、../jsonout。
 * - abort（契约见 run-phase.js 头注）：opts.signal 缺省时行为完全不变。signal
 *   透传给每次 runPhase（条目级预检与运行中杀停由 run-phase 负责）；本层编排
 *   检查点：每轮 review 批启动前（轮间中止，零 spawn）、review 批完成后（本轮
 *   聚合与 fix 不再进行——部分审查者缺席时聚合结论不可信）、fix 启动前、fix
 *   完成后。整体返回增量 status（'ok'|'failed'|'aborted'）与 abortedAtPhase
 *   （仅 aborted 携带）；loop.status 同步细分出 'aborted'。
 */

const { runPhase } = require('./phases');
const { runWithLimit } = require('../pool');
const { extractJsonObject } = require('../jsonout');
const ModelRouter = require('../model-router');

// 模块级单例：resolve 无解析状态；与 run-phase.js 同一约定（见其头注）。
const modelRouter = new ModelRouter();

const DEFAULT_REVIEWERS = ['correctness', 'robustness'];
const MUST_FIX_SEVERITIES = new Set(['critical', 'major']);
const REVIEWER_DESC = {
  correctness: '正确性：逻辑错误、边界条件、错误处理缺失、与意图不符',
  robustness: '健壮性：异常路径、资源泄漏、并发问题、输入校验',
  security: '安全性：注入、越权、敏感信息泄露',
  performance: '性能：复杂度热点、冗余 IO',
  maintainability: '可维护性：重复、命名、分层、可测性',
};

function reviewerDesc(r) { return REVIEWER_DESC[r] || '按该审查焦点深入检查'; }

/** 归一化 issue 标题做去重键（中文友好：仅折叠空白 + 小写拉丁）。 */
function dedupKey(title) {
  return String(title).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** signal 缺省（undefined）与未触发都视为未中止；编排层只认 signal.aborted 单一事实源。 */
function isAborted(signal) { return !!signal && signal.aborted === true; }

/** 聚合：合并多审查者的 issues，去重（标题归一化相同视为同一问题，保留最高严重度）。 */
function aggregateIssues(reviewerOutputs) {
  const map = new Map(); // key -> {id, title, severity, detail, file, reviewers:Set}
  let n = 0;
  for (const { reviewer, issues } of reviewerOutputs) {
    for (const it of issues || []) {
      const title = String(it?.title || '').trim();
      if (!title) continue;
      const key = dedupKey(title);
      const severity = String(it?.severity || 'minor').toLowerCase();
      if (!map.has(key)) {
        n++;
        map.set(key, {
          id: `R${n}`, title, severity,
          detail: String(it?.detail || '').slice(0, 500),
          file: it?.file ? String(it.file) : null,
          reviewers: new Set([reviewer]),
        });
      } else {
        const ex = map.get(key);
        ex.reviewers.add(reviewer);
        const rank = { critical: 3, major: 2, minor: 1 };
        if ((rank[severity] || 1) > (rank[ex.severity] || 1)) ex.severity = severity;
      }
    }
  }
  const all = [...map.values()];
  return { all, mustFix: all.filter((i) => MUST_FIX_SEVERITIES.has(i.severity)) };
}

function issuesJsonBlock(issues) {
  return JSON.stringify(issues.map(({ id, title, severity, detail, file }) => ({ id, title, severity, detail, file })), null, 1);
}

/**
 * @param {object} opts
 * @param {string} [opts.task] 上下文（改动的来龙去脉）
 * @param {string} [opts.reviewTarget] 审查范围描述，默认 'git 未提交改动'
 * @param {string[]} [opts.reviewers] 审查焦点，默认 correctness+robustness
 * @param {number} [opts.maxRounds=5]
 * @param {string} opts.workdir
 * @param {string} [opts.model]
 * @param {number} [opts.maxConcurrent=3]
 * @param {number} [opts.timeoutMsPerPhase] 单阶段超时（缺省 null = 无超时）
 * @param {AbortSignal} [opts.signal] 中止信号（契约见 run-phase.js 头注）
 */
async function runReviewFixLoop({
  task, reviewTarget = 'git 未提交改动', reviewers, maxRounds = 5,
  workdir, model, signal, maxConcurrent = 3, timeoutMsPerPhase = null, onPhase, onPlan,
}) {
  const modelRef = modelRouter.resolve(model);
  const startedAt = new Date().toISOString();

  const rs = (Array.isArray(reviewers) && reviewers.length ? reviewers : DEFAULT_REVIEWERS)
    .map((r) => String(r).trim()).filter(Boolean);
  if (!rs.length) throw new Error('reviewers 解析后为空');
  maxRounds = Math.max(1, Math.min(maxRounds | 0 || 5, 10));
  if (onPlan) onPlan(maxRounds * (rs.length + 1));

  const phaseResults = [];
  const roundSummaries = [];
  const cleanReviewers = new Set();
  let lastFixResponse = null;
  let lastAction = null; // 'review' | 'fix'：循环因 maxRounds 耗尽退出时用于区分 fixed-unverified
  let status = 'max-rounds';
  let abortedAtPhase = null; // status==='aborted' 时的中止检查点（如 'round2-review'）
  let remaining = [];
  let prevMustFixCount = null;
  let stagnantRounds = 0;

  for (let round = 1; round <= maxRounds; round++) {
    // 检查点（轮间）：上一轮结束后 signal 已 aborted → 本轮任何阶段不再启动
    if (isAborted(signal)) { status = 'aborted'; abortedAtPhase = `round${round}-review`; break; }

    // ── 并行 review（上一轮 clean 且其后无 fix 的审查者跳过）──
    const active = rs.filter((r) => !cleanReviewers.has(r));
    if (active.length === 0) { status = 'clean'; break; }

    if (onPhase) onPhase({ phase: `round${round}-review`, status: `running x${active.length}` });
    const reviews = await runWithLimit(active, maxConcurrent, (r) => runPhase({
      name: `review`, label: `R${round} 审查: ${r}`,
      prompt:
        `你是审查-修复循环中的审查者「${r}」（${reviewerDesc(r)}）。\n\n` +
        `## 任务背景\n${task || '(未提供)'}\n\n` +
        `## 审查范围\n${reviewTarget}\n\n` +
        `${round > 1 && lastFixResponse ? `## 上一轮修复说明\n${lastFixResponse.slice(0, 2000)}\n\n` : ''}` +
        `## 你的职责\n只从「${r}」焦点审查上述范围。禁止修改任何文件。\n\n` +
        `## 输出格式\n先 2-3 句总体印象，然后必须输出一个 \`\`\`json 围栏块：\n` +
        '```json\n' +
        '{"status":"clean","issues":[]}\n' +
        '```\n' +
        `或（发现问题时，severity 取 critical/major/minor；只有 critical 和 major 算必须修复）：\n` +
        '```json\n' +
        '{"status":"issues","issues":[{"id":"A1","severity":"major","title":"问题标题","detail":"说明与依据","file":"相对路径"}]}\n' +
        '```\n' +
        `不要报风格类 minor 问题；不要输出其他 json 块。`,
      cwd: workdir, modelRef, timeoutMs: timeoutMsPerPhase, signal,
    }));
    for (const entry of reviews) phaseResults.push(entry);

    // 检查点（review 批完成后）：aborted → 本轮聚合与 fix 不再进行，已完成
    // 审查条目随报告保留
    if (isAborted(signal)) { status = 'aborted'; abortedAtPhase = `round${round}-review`; break; }

    // ── 聚合（JS 去重合并）──
    // entry.ok=false（审查者执行失败：CLI 崩溃/超时）单列 runFail——与 parseFail
    // （执行成功但输出解析失败）分开：失败的审查者既不算 clean 也不算发现
    // 问题；全部失败时不得按 0 问题判 clean
    const parsedReviews = active.map((r, i) => {
      const entry = reviews[i];
      if (!entry.ok) return { reviewer: r, issues: [], runFail: true, entry };
      const obj = extractJsonObject(entry.response || '');
      if (!obj) return { reviewer: r, issues: [], parseFail: true, entry };
      const issues = Array.isArray(obj.issues)
        ? obj.issues.filter((x) => x && typeof x.title === 'string')
        : [];
      return { reviewer: r, issues, clean: obj.status === 'clean' || issues.length === 0, entry };
    });
    const { mustFix } = aggregateIssues(parsedReviews);
    const parseFails = parsedReviews.filter((p) => p.parseFail);
    const runFails = parsedReviews.filter((p) => p.runFail);

    roundSummaries.push({
      round,
      detail: parsedReviews.map((p) =>
        `${p.reviewer}: ${p.runFail ? '审查执行失败' : p.parseFail ? '输出解析失败' : p.clean ? 'clean' : `${p.issues.length} 个问题`}`
      ).join('；')
        + (runFails.length ? `（${runFails.length} 个审查者执行失败）` : '')
        + (parseFails.length ? `（${parseFails.length} 个审查者输出无法解析，按 clean 处理并告警）` : ''),
      mustFixCount: mustFix.length,
    });
    for (const p of parsedReviews) if (p.clean && !p.parseFail) cleanReviewers.add(p);

    if (onPhase) onPhase({ phase: `round${round}-review`, status: `done, must-fix=${mustFix.length}` });

    if (mustFix.length === 0) {
      // 零成功审查（全部执行失败/解析失败）≠ clean：无任何可信结论时失败收场
      if (runFails.length + parseFails.length === parsedReviews.length) {
        status = 'review-failed';
        lastAction = 'review';
        remaining = [];
        break;
      }
      status = 'clean'; lastAction = 'review'; remaining = []; break;
    }

    // ── 停滞检测：must-fix 数量连续 2 轮不降 → 判定卡住，保留现场 ──
    if (prevMustFixCount !== null && mustFix.length >= prevMustFixCount) {
      stagnantRounds++;
      if (stagnantRounds >= 2) { status = 'stuck'; remaining = mustFix; break; }
    } else stagnantRounds = 0;
    prevMustFixCount = mustFix.length;

    // 检查点（fix 启动前）：aborted → 本轮聚合出的 must-fix 原样保留给报告
    if (isAborted(signal)) { status = 'aborted'; abortedAtPhase = `round${round}-fix`; remaining = mustFix; break; }

    // ── fix ──
    if (onPhase) onPhase({ phase: `round${round}-fix`, status: `running (${mustFix.length} 个 must-fix)` });
    const fix = await runPhase({
      name: 'fix', label: `R${round} 修复 (${mustFix.length} 项)`,
      prompt:
        `你是审查-修复循环中的修复者。\n\n` +
        `## 审查范围\n${reviewTarget}\n\n` +
        `## 必须修复的问题（按 id 逐条处理）\n\`\`\`json\n${issuesJsonBlock(mustFix)}\n\`\`\`\n\n` +
        `## 你的职责\n逐条修复上述问题（允许修改文件、运行命令验证）。对确实不该修/修不了的要给出理由，不要为凑数做表面修改。\n\n` +
        `## 输出格式\n以「## 修复结果」开头，逐条给出：问题 id → 已修复（怎么修的）/ 拒绝修复（理由）。不超过 500 字。`,
      cwd: workdir, modelRef, timeoutMs: timeoutMsPerPhase, signal,
    });
    phaseResults.push(fix);
    if (onPhase) onPhase({ phase: `round${round}-fix`, status: fix.aborted ? 'aborted' : fix.ok ? 'done' : 'failed' });
    // 检查点（fix 完成后）：运行中 abort 时 fix 条目已被 run-phase 杀停并标记
    if (isAborted(signal)) { status = 'aborted'; abortedAtPhase = `round${round}-fix`; remaining = mustFix; break; }
    if (!fix.ok) { status = 'fix-failed'; remaining = mustFix; break; }
    lastFixResponse = fix.response;
    lastAction = 'fix';
    // 修复发生后，之前 clean 的审查者也要重审（改动可能引入新问题）
    cleanReviewers.clear();
  }

  // 轮数耗尽且最后一步是修复成功：问题可能已全修但未经复核，与“未收敛”区分
  if (status === 'max-rounds' && lastAction === 'fix' && remaining.length === 0) {
    status = 'fixed-unverified';
  }

  const roundsMd = roundSummaries.map((s) => `- **第 ${s.round} 轮**: ${s.detail} → must-fix ${s.mustFixCount} 个`).join('\n');
  const remainingMd = remaining.length
    ? remaining.map((i) => `- **${i.id} [${i.severity}]** ${i.title}${i.file ? `（${i.file}）` : ''}\n  ${i.detail}`).join('\n')
    : '';

  const finalText = status === 'aborted'
    ? `## 已中止\n\n在 ${abortedAtPhase} 检查点收到 abort，后续阶段未启动；已完成 ${roundSummaries.length} 轮，已启动阶段的条目保留在下方阶段表。${remaining.length ? `\n\n中止时剩余 must-fix ${remaining.length} 个（未处理）：\n${remainingMd}` : ''}`
    : status === 'review-failed'
      ? `## 审查阶段失败\n\n共 ${roundSummaries.length} 轮，全部审查者执行失败或输出无法解析，没有任何可信审查结论——不能按 clean 处理。恢复指引：检查模型 CLI 可用性与 timeoutMsPerPhase 后重跑。`
      : status === 'clean'
      ? `## 审查通过\n\n共 ${roundSummaries.length} 轮，所有审查者（${rs.join('、')}）均无 must-fix 问题。\n${lastFixResponse ? `\n最后一轮修复说明：\n${lastFixResponse.slice(0, 1500)}` : ''}`
      : status === 'fixed-unverified'
        ? `## 已修复，待复核\n\n共 ${roundSummaries.length} 轮，最后一轮修复已完成且未再报新 must-fix，但轮数（${maxRounds}）用尽未做复核。建议再跑一轮确认，或人工检查。\n\n最后一轮修复说明：\n${(lastFixResponse || '').slice(0, 1500)}`
        : `## ${status === 'stuck' ? '修复停滞，人工接管' : status === 'fix-failed' ? '修复阶段失败' : `达到最大轮数（${maxRounds}）`}\n\n剩余 must-fix ${remaining.length} 个：\n${remainingMd}`;

  return {
    ok: status === 'clean',
    status: status === 'clean' ? 'ok' : status === 'aborted' ? 'aborted' : 'failed',
    ...(status === 'aborted' ? { abortedAtPhase } : {}),
    workflow: 'review-fix-loop',
    task: task || reviewTarget,
    workdir, model: modelRef,
    phases: phaseResults,
    final: finalText,
    sections: [
      { title: '轮次摘要', body: roundsMd || '(未产生轮次)' },
      ...(lastFixResponse ? [{ title: '最后一轮修复说明', body: lastFixResponse, maxChars: 2500 }] : []),
      ...(remaining.length ? [{ title: '剩余 must-fix（未解决）', body: remainingMd }] : []),
    ],
    loop: { status, rounds: roundSummaries.length, reviewers: rs, remainingCount: remaining.length },
    ...(status === 'clean' ? {} : { error: status === 'aborted'
      ? `审查-修复循环已中止（aborted）: ${abortedAtPhase}（已完成 ${roundSummaries.length} 轮）`
      : status === 'review-failed'
        ? `审查阶段失败：全部审查者执行失败或输出无法解析（review-failed），无可信结论`
        : status === 'fixed-unverified'
        ? `轮数用尽：最后一轮修复已完成但未经复核（fixed-unverified），建议再跑一轮确认`
        : `审查-修复循环未收敛: ${status}（剩余 ${remaining.length} 个 must-fix）` }),
    startedAt, finishedAt: new Date().toISOString(),
  };
}

module.exports = { runReviewFixLoop, DEFAULT_REVIEWERS };
