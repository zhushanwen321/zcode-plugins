'use strict';
/**
 * parallel workflow：N 视角并行分析同一目标 → 聚合。
 * 对标 pi-subagent-workflow 的 parallel.js（默认 security/performance/maintainability）。
 *
 * zsub 移植差异（相对源 dynamic-workflow/lib/parallel.js，逻辑/默认值不变）：
 * - driver 入口替换：旧 driver.runHeadlessPhase + 条目包装改为本目录
 *   phases.js 的 runPhase（内部经 run-phase.js 调 zsub driver；条目新增
 *   timedOut 字段）；池编排仍用 runWithLimit，路径从 './pool' 改 '../pool'。
 * - 模型解析：旧 driver.resolveModelRef(model) 改为 ModelRouter.resolve(model)
 *   （空输入回落 v2 config 的 model.main 而非硬编码默认；额外校验 provider），
 *   返回值仍为全名 modelRef，行为兼容。
 * - 隔离 HOME 准备：旧版入口处 bootstrapIsolatedHome(modelRef) 一次性重写；
 *   zsub 移到 run-phase → prepareRunEnv（per-model HOME 池 + mtime 条件重写），
 *   并发各视角经同一 home 互斥链排队 bootstrap，本文件不再显式 bootstrap。
 * - 防递归：driver 强制注入 ZSW_NESTED=1（替代旧 DWF_NESTED=1），叠加隔离
 *   HOME 配置不含 plugins，阶段子进程物理上无法再起嵌套任务。
 * - abort（契约见 run-phase.js 头注）：opts.signal 缺省时行为完全不变。
 *   signal 透传给每次 runPhase（条目级预检与运行中杀停由 run-phase 负责）；
 *   本层编排检查点：analyze 批启动前（零 spawn 直接 aborted 返回）、批完成后
 *   （aggregate 不再启动）、aggregate 完成后。批中 abort 时已启动的视角跑到
 *   终态或被 run-phase 杀停、条目保留，未启动的由 runPhase 预检返回 aborted
 *   条目。整体返回增量 status（'ok'|'failed'|'aborted'）与 abortedAtPhase
 *   （仅 aborted 携带）。
 */

const { runPhase } = require('./phases');
const { runWithLimit } = require('../pool');
const ModelRouter = require('../model-router');

// resolve() 无解析状态；模块级单例保持与 run-phase.js 相同的实例化习惯
const modelRouter = new ModelRouter();

const DEFAULT_PERSPECTIVES = ['security', 'performance', 'maintainability'];

const PERSPECTIVE_DESC = {
  security: '安全性：注入、越权、敏感信息泄露、不安全依赖与命令',
  performance: '性能：复杂度热点、N+1、冗余 IO、内存泄漏',
  maintainability: '可维护性：重复代码、命名、分层、测试覆盖、文档',
};

function perspectiveDesc(p) { return PERSPECTIVE_DESC[p] || '按该视角深入分析'; }

/** signal 缺省（undefined）与未触发都视为未中止；编排层只认 signal.aborted 单一事实源。 */
function isAborted(signal) { return !!signal && signal.aborted === true; }

/**
 * @param {object} opts
 * @param {string} opts.task 分析目标（pi 的 target）
 * @param {string[]} [opts.perspectives]
 * @param {string} opts.workdir
 * @param {string} [opts.model]
 * @param {number} [opts.maxConcurrent=3]
 * @param {number} [opts.timeoutMsPerPhase]
 * @param {AbortSignal} [opts.signal] 中止信号（契约见 run-phase.js 头注）
 * @param {(e:{phase:string,status:string})=>void} [opts.onPhase]
 *        状态取值 'running'|'done'|'failed'|'aborted'
 * @param {(expected:number)=>void} [opts.onPlan]
 */
async function runParallel({
  task, perspectives, workdir, model, signal,
  maxConcurrent = 3, timeoutMsPerPhase = 600000, onPhase, onPlan,
}) {
  const modelRef = modelRouter.resolve(model);
  const startedAt = new Date().toISOString();

  const ps = (Array.isArray(perspectives) && perspectives.length ? perspectives : DEFAULT_PERSPECTIVES)
    .map((p) => String(p).trim()).filter(Boolean);
  if (!ps.length) throw new Error('perspectives 解析后为空');

  const phaseResults = [];
  const outputs = new Array(ps.length).fill(null);
  let completed = 0;
  if (onPlan) onPlan(ps.length + 1);

  // 检查点（批启动前）：signal 已 aborted → 整批不启动、零 spawn，直接 aborted 返回
  if (isAborted(signal)) {
    return {
      ok: false, status: 'aborted', abortedAtPhase: 'analyze',
      workflow: 'parallel', task, workdir, model: modelRef,
      phases: [], final: null,
      error: '已中止（aborted）: analyze 批次启动前 signal 已 aborted，零阶段启动',
      startedAt, finishedAt: new Date().toISOString(),
    };
  }

  // 段 1：并行分析（只读）；阶段条目用池的有序返回值，表格顺序稳定
  if (onPhase) onPhase({ phase: 'analyze', status: `running x${ps.length}` });
  const analyzeEntries = await runWithLimit(ps, maxConcurrent, async (p, i) => {
    const entry = await runPhase({
      name: 'analyze', label: `视角: ${p}`,
      prompt:
        `你是多视角分析工作流中「${p}」视角的分析者（${perspectiveDesc(p)}）。\n\n` +
        `## 分析目标\n${task}\n\n` +
        `## 你的职责\n只从「${p}」这一个视角审查上述目标，其他视角（如性能 vs 安全冲突）不用管。\n` +
        `禁止修改任何文件（只读调查）。\n\n` +
        `## 输出格式\n以「## ${p} 视角分析」开头：1) 最重要的发现（按严重度排序，带文件路径证据）\n` +
        `2) 本视角下的改进建议。不超过 400 字。不要写其他视角的内容。`,
      cwd: workdir, modelRef, timeoutMs: timeoutMsPerPhase, signal,
    });
    if (entry.ok) outputs[i] = entry.response;
    if (!entry.aborted) completed++;
    if (onPhase) onPhase({ phase: `analyze:${p}`, status: entry.aborted ? 'aborted' : entry.ok ? `done (${completed}/${ps.length})` : 'failed' });
    return entry;
  });
  phaseResults.push(...analyzeEntries);

  // 检查点（批完成后）：批中/批尾发现中止 → 聚合不再启动。批内有未启动条目时
  // 中止点记为 analyze，否则记为下一个未启动阶段 aggregate
  if (isAborted(signal)) {
    return {
      ok: false, status: 'aborted',
      abortedAtPhase: analyzeEntries.some((e) => e.aborted) ? 'analyze' : 'aggregate',
      workflow: 'parallel', task, workdir, model: modelRef,
      phases: phaseResults, final: null,
      error: `已中止（aborted）: analyze 批次中止，${analyzeEntries.filter((e) => e.ok).length}/${ps.length} 个视角已完成`,
      startedAt, finishedAt: new Date().toISOString(),
    };
  }

  const failed = analyzeEntries.filter((p) => !p.ok);
  if (failed.length === ps.length) {
    return {
      ok: false, status: 'failed', workflow: 'parallel', task, workdir, model: modelRef,
      phases: phaseResults,
      final: null, error: `全部 ${ps.length} 个视角分析失败: ${failed[0].error}`,
      startedAt, finishedAt: new Date().toISOString(),
    };
  }

  // 段 2：聚合
  if (onPhase) onPhase({ phase: 'aggregate', status: 'running' });
  const perspectivesMd = ps.map((p, i) => `### ${p}\n${outputs[i] || '(该视角失败，缺结果)'}`).join('\n\n');
  const agg = await runPhase({
    name: 'aggregate', label: '聚合汇总',
    prompt:
      `你是多视角分析工作流的聚合者。以下是各视角的独立分析结果：\n\n${perspectivesMd}\n\n` +
      `## 你的职责\n横向对比各视角结论，产出统一综合判断。\n\n` +
      `## 输出格式\n以「## 综合结论」开头：1) 各视角发现汇总表（视角 | 关键发现 | 严重度）\n` +
      `2) 视角间的冲突或互补点 3) 按优先级排序的行动建议（不超过 5 条）。\n不超过 600 字。`,
    cwd: workdir, modelRef, timeoutMs: timeoutMsPerPhase, signal,
  });
  phaseResults.push(agg);
  if (onPhase) onPhase({ phase: 'aggregate', status: agg.aborted ? 'aborted' : agg.ok ? 'done' : 'failed' });

  // 检查点（聚合完成后）：运行中 abort → 聚合条目保留（终态由 run-phase 决定），
  // 整体按 aborted 返回
  if (isAborted(signal)) {
    return {
      ok: false, status: 'aborted', abortedAtPhase: 'aggregate',
      workflow: 'parallel', task, workdir, model: modelRef,
      phases: phaseResults, final: null,
      error: '已中止（aborted）: aggregate 阶段中止',
      startedAt, finishedAt: new Date().toISOString(),
    };
  }

  const ok = agg.ok;
  return {
    ok, status: ok ? 'ok' : 'failed',
    workflow: 'parallel', task, workdir, model: modelRef, phases: phaseResults,
    final: agg.ok ? agg.response : null,
    sections: [{
      title: '各视角原始结论',
      body: perspectivesMd,
      maxChars: 5000,
    }],
    ...(ok ? {} : { error: `聚合阶段失败: ${agg.error}` }),
    startedAt, finishedAt: new Date().toISOString(),
  };
}

module.exports = { runParallel, DEFAULT_PERSPECTIVES };
