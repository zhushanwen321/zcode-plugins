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
 * - 防递归：driver 强制注入 ZSUB_NESTED=1（替代旧 DWF_NESTED=1），叠加隔离
 *   HOME 配置不含 plugins，阶段子进程物理上无法再起嵌套任务。
 */

const { runPhase } = require('./phases');
const { runWithLimit } = require('../pool');
const ModelRouter = require('../model-router');

// resolve() 无解析状态；模块级单例保持与 run-phase.js 相同的实例化习惯
const modelRouter = new ModelRouter();

/**
 * @param {object} opts
 * @param {string[]} opts.items 待处理条目
 * @param {string} opts.operation 对每个 item 做什么
 * @param {string} [opts.task] 额外上下文
 * @param {string} opts.workdir
 * @param {string} [opts.model]
 * @param {number} [opts.maxConcurrent=3]
 * @param {number} [opts.timeoutMsPerPhase]
 */
async function runMapReduce({
  items, operation, task, workdir, model,
  maxConcurrent = 3, timeoutMsPerPhase = 600000, onPhase, onPlan,
}) {
  const modelRef = modelRouter.resolve(model);
  const startedAt = new Date().toISOString();

  if (!Array.isArray(items) || !items.length) throw new Error('map-reduce 需要非空 items 数组');
  if (!operation || typeof operation !== 'string') throw new Error('map-reduce 需要 operation（对每个 item 做什么）');

  const phaseResults = [];
  const outputs = new Array(items.length).fill(null);
  let completed = 0;
  if (onPlan) onPlan(items.length + 1);

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
      cwd: workdir, modelRef, timeoutMs: timeoutMsPerPhase,
    });
    if (entry.ok) outputs[i] = entry.response;
    completed++;
    if (onPhase) onPhase({ phase: `map:${item.slice(0, 20)}`, status: entry.ok ? `done (${completed}/${items.length})` : 'failed' });
    return entry;
  });
  phaseResults.push(...mapEntries);

  const failedCount = outputs.filter((o) => o === null).length;
  if (failedCount === items.length) {
    return {
      ok: false, workflow: 'map-reduce', task: task || operation, workdir, model: modelRef,
      phases: phaseResults, final: null,
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
    cwd: workdir, modelRef, timeoutMs: timeoutMsPerPhase,
  });
  phaseResults.push(reduce);
  if (onPhase) onPhase({ phase: 'reduce', status: reduce.ok ? 'done' : 'failed' });

  return {
    ok: reduce.ok, workflow: 'map-reduce', task: task || operation, workdir, model: modelRef,
    phases: phaseResults, final: reduce.ok ? reduce.response : null,
    sections: [{ title: '各条目 map 结果', body: mapsMd, maxChars: 5000 }],
    ...(reduce.ok ? {} : { error: `reduce 阶段失败: ${reduce.error}` }),
    startedAt, finishedAt: new Date().toISOString(),
  };
}

module.exports = { runMapReduce };
