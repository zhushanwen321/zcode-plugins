'use strict';
/**
 * map-reduce workflow：对已知 items 数组并行 map → 单 agent reduce 归约。
 * 对标 pi-subagent-workflow 的 map-reduce.js。
 * 与 scatter-gather 的区别：items 已知（不需要先拆分）。
 *
 * zsub 移植差异（相对源 dynamic-workflow/lib/map-reduce.js，逻辑/默认值不变）：
 * - driver 入口替换：旧 driver.runHeadlessPhase + 条目包装改为本目录
 *   phases.js 的 runPhase（内部经 run-phase.js 调 zsub driver；条目新增
 *   timedOut 字段）；池编排仍用 runWithLimit，路径从 './pool' 改 '../pool'。
 * - 模型解析：旧 driver.resolveModelRef(model) 改为 ModelRouter.resolve(model)
 *   （空输入回落 v2 config 的 model.main 而非硬编码默认；额外校验 provider），
 *   返回值仍为全名 modelRef，行为兼容。
 * - 隔离 HOME 准备：旧版入口处 bootstrapIsolatedHome(modelRef) 一次性重写；
 *   zsub 移到 run-phase → prepareRunEnv（per-model HOME 池 + mtime 条件重写），
 *   并发各 map 经同一 home 互斥链排队 bootstrap，本文件不再显式 bootstrap。
 * - 防递归：driver 强制注入 ZSW_NESTED=1（替代旧 DWF_NESTED=1），叠加隔离
 *   HOME 配置不含 plugins，阶段子进程物理上无法再起嵌套任务。
 * - abort（契约见 run-phase.js 头注）：opts.signal 缺省时行为完全不变。
 *   signal 透传给每次 runPhase（条目级预检与运行中杀停由 run-phase 负责）；
 *   本层编排检查点：map 批启动前（零 spawn 直接 aborted 返回）、map 批完成后
 *   （reduce 不再启动）、reduce 完成后。批中 abort 时已启动的条目跑到终态或被
 *   杀停、结果保留，未启动的由 runPhase 预检返回 aborted 条目。整体返回增量
 *   status（'ok'|'failed'|'aborted'）与 abortedAtPhase（仅 aborted 携带）。
 */

const { runPhase } = require('./phases');
const { runWithLimit } = require('../pool');
const ModelRouter = require('../model-router');

// resolve() 无解析状态；模块级单例保持与 run-phase.js 相同的实例化习惯
const modelRouter = new ModelRouter();

/** signal 缺省（undefined）与未触发都视为未中止；编排层只认 signal.aborted 单一事实源。 */
function isAborted(signal) { return !!signal && signal.aborted === true; }

/**
 * @param {object} opts
 * @param {string[]} opts.items 待处理条目
 * @param {string} opts.operation 对每个 item 做什么
 * @param {string} [opts.task] 额外上下文
 * @param {string} opts.workdir
 * @param {string} [opts.model]
 * @param {number} [opts.maxConcurrent=3]
 * @param {number} [opts.timeoutMsPerPhase] 单阶段超时（缺省 null = 无超时）
 * @param {AbortSignal} [opts.signal] 中止信号（契约见 run-phase.js 头注）
 */
async function runMapReduce({
  items, operation, task, workdir, model, signal,
  maxConcurrent = 3, timeoutMsPerPhase = null, onPhase, onPlan,
}) {
  const modelRef = modelRouter.resolve(model);
  const startedAt = new Date().toISOString();

  if (!Array.isArray(items) || !items.length) throw new Error('map-reduce 需要非空 items 数组');
  if (!operation || typeof operation !== 'string') throw new Error('map-reduce 需要 operation（对每个 item 做什么）');

  const phaseResults = [];
  const outputs = new Array(items.length).fill(null);
  let completed = 0;
  if (onPlan) onPlan(items.length + 1);

  // 检查点（批启动前）：signal 已 aborted → 整批不启动、零 spawn，直接 aborted 返回
  if (isAborted(signal)) {
    return {
      ok: false, status: 'aborted', abortedAtPhase: 'map',
      workflow: 'map-reduce', task: task || operation, workdir, model: modelRef,
      phases: [], final: null,
      error: '已中止（aborted）: map 批次启动前 signal 已 aborted，零阶段启动',
      startedAt, finishedAt: new Date().toISOString(),
    };
  }

  // 段 1：并行 map（阶段条目用池的有序返回值，表格顺序稳定）
  if (onPhase) onPhase({ phase: 'map', status: `running x${items.length}` });
  const mapEntries = await runWithLimit(items.map(String), maxConcurrent, async (item, i) => {
    const entry = await runPhase({
      name: 'map', label: `item[${i}]: ${item.slice(0, 50)}`,
      prompt:
        `你是 map-reduce 工作的 mapper，只负责处理一个条目。\n\n` +
        `## 操作指令\n${operation}\n\n` +
        `## 本次条目\n${item}\n\n` +
        `${task ? `## 附加上下文\n${task}\n\n` : ''}` +
        `## 约束\n只处理上述单个条目；除操作指令明确要求外禁止修改文件（默认只读）。\n\n` +
        `## 输出格式\n以「## ${item.slice(0, 40)} 结果」开头的简明结论（发现/结论/异常），不超过 300 字。`,
      cwd: workdir, modelRef, timeoutMs: timeoutMsPerPhase, signal,
    });
    if (entry.ok) outputs[i] = entry.response;
    if (!entry.aborted) completed++;
    if (onPhase) onPhase({ phase: `map:${item.slice(0, 20)}`, status: entry.aborted ? 'aborted' : entry.ok ? `done (${completed}/${items.length})` : 'failed' });
    return entry;
  });
  phaseResults.push(...mapEntries);

  // 检查点（批完成后）：批中/批尾发现中止 → reduce 不再启动。批内有未启动条目
  // 时中止点记为 map，否则记为下一个未启动阶段 reduce
  if (isAborted(signal)) {
    return {
      ok: false, status: 'aborted',
      abortedAtPhase: mapEntries.some((e) => e.aborted) ? 'map' : 'reduce',
      workflow: 'map-reduce', task: task || operation, workdir, model: modelRef,
      phases: phaseResults, final: null,
      error: `已中止（aborted）: map 批次中止，${mapEntries.filter((e) => e.ok).length}/${items.length} 个条目已完成`,
      startedAt, finishedAt: new Date().toISOString(),
    };
  }

  const failedCount = outputs.filter((o) => o === null).length;
  if (failedCount === items.length) {
    return {
      ok: false, status: 'failed', workflow: 'map-reduce', task: task || operation,
      workdir, model: modelRef, phases: phaseResults, final: null,
      error: `全部 ${items.length} 个 map 失败: ${phaseResults[0].error}`,
      startedAt, finishedAt: new Date().toISOString(),
    };
  }

  // 段 2：reduce
  if (onPhase) onPhase({ phase: 'reduce', status: 'running' });
  const mapsMd = items.map((item, i) => `### item[${i}]: ${item}\n${outputs[i] || '(map 失败，缺结果)'}`).join('\n\n');
  const reduce = await runPhase({
    name: 'reduce', label: '归约汇总',
    prompt:
      `你是 map-reduce 工作的 reducer。各条目的 map 结果如下：\n\n${mapsMd}\n\n` +
      `## 操作指令（回顾）\n${operation}\n\n` +
      `## 你的职责\n把所有条目结果归约为单一结论。\n\n` +
      `## 输出格式\n以「## 归约结论」开头：1) 条目结果汇总表（item | 结论 | 是否异常）\n` +
      `2) 共性规律与离群项 3) 需要人工跟进的事项。不超过 500 字。`,
    cwd: workdir, modelRef, timeoutMs: timeoutMsPerPhase, signal,
  });
  phaseResults.push(reduce);
  if (onPhase) onPhase({ phase: 'reduce', status: reduce.aborted ? 'aborted' : reduce.ok ? 'done' : 'failed' });

  // 检查点（reduce 完成后）：运行中 abort → 整体按 aborted 返回，条目保留
  if (isAborted(signal)) {
    return {
      ok: false, status: 'aborted', abortedAtPhase: 'reduce',
      workflow: 'map-reduce', task: task || operation, workdir, model: modelRef,
      phases: phaseResults, final: null,
      error: '已中止（aborted）: reduce 阶段中止',
      startedAt, finishedAt: new Date().toISOString(),
    };
  }

  return {
    ok: reduce.ok, status: reduce.ok ? 'ok' : 'failed',
    workflow: 'map-reduce', task: task || operation, workdir, model: modelRef,
    phases: phaseResults, final: reduce.ok ? reduce.response : null,
    sections: [{ title: '各条目 map 结果', body: mapsMd, maxChars: 5000 }],
    ...(reduce.ok ? {} : { error: `reduce 阶段失败: ${reduce.error}` }),
    startedAt, finishedAt: new Date().toISOString(),
  };
}

module.exports = { runMapReduce };
