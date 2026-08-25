'use strict';
/**
 * scatter-gather workflow：scatter 拆分 → parallel 处理 → gather 合并，三段。
 * 对标 pi-subagent-workflow 的 scatter-gather.js。
 * 适用于"任务太大需要先拆分再并行"的场景。process 阶段允许修改文件（各子任务边界内）。
 *
 * zsub 移植差异（相对 dynamic-workflow/lib/scatter-gather.js，workflow 逻辑/默认值不变）：
 * - 模型解析：driver.resolveModelRef → ModelRouter.resolve。显式指定 model 的
 *   校验行为一致；未指定时默认值来源不同——源版返回固定 DEFAULT_MODEL 常量，
 *   zsub 跟随 v2 config 的 model.main（读不到回退 GLM-5.3），并对非
 *   builtin:bigmodel-coding-plan provider 提前报错。
 * - 隔离 HOME：源版在 workflow 入口显式 bootstrapIsolatedHome（每次运行重写配置）；
 *   zsub 由 run-phase 内 prepareRunEnv 按需 bootstrap（mtime 条件重写，幂等语义等价），
 *   本模块不再触碰 HOME 写盘。
 * - runPhase 调用补 modelRef 透传（zsub 的 per-model HOME 池按模型隔离，源版无此参数）。
 * - pool/jsonout 在 zsub 位于 lib/ 根而非 lib/workflow/，require 路径改 ../pool、../jsonout。
 * - abort（契约见 run-phase.js 头注）：opts.signal 缺省时行为完全不变。
 *   signal 透传给每次 runPhase（条目级预检与运行中杀停由 run-phase 负责）；
 *   本层编排检查点：scatter 启动前（零 spawn 直接 aborted 返回）、scatter 完成
 *   后（process 批不启动）、process 批完成后（gather 不再启动）、gather 完成后。
 *   process 批中 abort 时已启动的子任务跑到终态或被杀停、结果保留，未启动的由
 *   runPhase 预检返回 aborted 条目。整体返回增量 status（'ok'|'failed'|'aborted'）
 *   与 abortedAtPhase（仅 aborted 携带）。
 */

const { runPhase } = require('./phases');
const { runWithLimit } = require('../pool');
const { extractJsonObject } = require('../jsonout');
const ModelRouter = require('../model-router');

// 模块级单例：resolve 无解析状态；与 run-phase.js 同一约定（见其头注）。
const modelRouter = new ModelRouter();

const MAX_SUBTASKS = 4;

/** signal 缺省（undefined）与未触发都视为未中止；编排层只认 signal.aborted 单一事实源。 */
function isAborted(signal) { return !!signal && signal.aborted === true; }

/**
 * @param {object} opts
 * @param {string} opts.task 大任务描述
 * @param {string} [opts.subtaskCount] 提示拆分数（2-4；缺省让模型自定）
 * @param {string} opts.workdir
 * @param {string} [opts.model]
 * @param {number} [opts.maxConcurrent=3]
 * @param {number} [opts.timeoutMsPerPhase] 单阶段超时（缺省 null = 无超时）
 * @param {AbortSignal} [opts.signal] 中止信号（契约见 run-phase.js 头注）
 */
async function runScatterGather({
  task, subtaskCount, workdir, model, signal,
  maxConcurrent = 3, timeoutMsPerPhase = null, onPhase, onPlan,
}) {
  const modelRef = modelRouter.resolve(model);
  const startedAt = new Date().toISOString();

  // 检查点（scatter 启动前）：signal 已 aborted → 零 spawn 直接 aborted 返回
  if (isAborted(signal)) {
    return {
      ok: false, status: 'aborted', abortedAtPhase: 'scatter',
      workflow: 'scatter-gather', task, workdir, model: modelRef,
      phases: [], final: null,
      error: '已中止（aborted）: scatter 阶段启动前 signal 已 aborted，零阶段启动',
      startedAt, finishedAt: new Date().toISOString(),
    };
  }

  // 段 1：scatter（结构化拆分）
  if (onPhase) onPhase({ phase: 'scatter', status: 'running' });
  const hint = Number.isInteger(subtaskCount) && subtaskCount >= 2 && subtaskCount <= MAX_SUBTASKS
    ? `恰好拆成 ${subtaskCount} 个` : '2-4 个';
  const scatter = await runPhase({
    name: 'scatter', label: '任务拆分',
    prompt:
      `你是 scatter-gather 工作的 scatter 者：把大任务拆成${hint}可独立并行处理的子任务。\n\n` +
      `## 大任务\n${task}\n\n` +
      `## 约束\n每个子任务有明确边界、彼此不依赖、可由不同 agent 独立完成；先只读调查工作目录现状再拆。\n\n` +
      `## 输出格式\n先用 2-3 句说明拆分思路，然后必须输出一个 \`\`\`json 围栏块：\n` +
      '```json\n{"subtasks":[{"name":"简短名称","description":"子任务详细描述（含涉及文件/范围）"}]}\n```\n' +
      `不要输出其他 json 块。`,
    cwd: workdir, modelRef, timeoutMs: timeoutMsPerPhase, signal,
  });
  if (onPhase) onPhase({ phase: 'scatter', status: scatter.aborted ? 'aborted' : scatter.ok ? 'done' : 'failed' });
  // 检查点（scatter 完成后）：aborted → process 批不启动（含 scatter 运行中被
  // run-phase 杀停的情况，条目保留）
  if (isAborted(signal)) {
    return {
      ok: false, status: 'aborted', abortedAtPhase: 'scatter',
      workflow: 'scatter-gather', task, workdir, model: modelRef,
      phases: [scatter], final: null,
      error: '已中止（aborted）: scatter 阶段中止，子任务批未启动',
      startedAt, finishedAt: new Date().toISOString(),
    };
  }
  if (!scatter.ok) {
    return {
      ok: false, status: 'failed', workflow: 'scatter-gather', task, workdir, model: modelRef,
      phases: [scatter], final: null, error: `scatter 阶段失败: ${scatter.error}`,
      startedAt, finishedAt: new Date().toISOString(),
    };
  }

  const parsed = extractJsonObject(scatter.response || '');
  const subtasks = Array.isArray(parsed?.subtasks) ? parsed.subtasks : null;
  if (!subtasks || !subtasks.length) {
    return {
      ok: false, status: 'failed', workflow: 'scatter-gather', task, workdir, model: modelRef,
      phases: [scatter], final: null,
      error: `scatter 输出无法解析出 subtasks 数组。原始输出片段: ${(scatter.response || '').slice(0, 300)}`,
      startedAt, finishedAt: new Date().toISOString(),
    };
  }
  const norm = subtasks.slice(0, MAX_SUBTASKS).map((s, i) => ({
    name: String(s?.name || `subtask-${i + 1}`).slice(0, 60),
    description: String(s?.description || s?.name || '').slice(0, 1000),
  }));

  const phaseResults = [scatter];
  const outputs = new Array(norm.length).fill(null);
  let completed = 0;
  if (onPlan) onPlan(1 + norm.length + 1);

  // 段 2：并行 process（阶段条目用池的有序返回值，表格顺序稳定）
  if (onPhase) onPhase({ phase: 'process', status: `running x${norm.length}` });
  const processEntries = await runWithLimit(norm, maxConcurrent, async (st, i) => {
    const entry = await runPhase({
      name: 'process', label: `子任务: ${st.name}`,
      prompt:
        `你是 scatter-gather 工作的处理者，只负责一个子任务。\n\n` +
        `## 大任务背景\n${task}\n\n` +
        `## 你的子任务\n${st.name}: ${st.description}\n\n` +
        `## 约束\n只做本子任务边界内的事（允许修改/新建文件、运行命令验证），不要越界做其他子任务的事。\n\n` +
        `## 输出格式\n以「## ${st.name} 结果」开头：做了什么 / 改动清单（文件路径）/ 验证方式 / 未尽事项。不超过 400 字。`,
      cwd: workdir, modelRef, timeoutMs: timeoutMsPerPhase, signal,
    });
    if (entry.ok) outputs[i] = entry.response;
    if (!entry.aborted) completed++;
    if (onPhase) onPhase({ phase: `process:${st.name}`, status: entry.aborted ? 'aborted' : entry.ok ? `done (${completed}/${norm.length})` : 'failed' });
    return entry;
  });
  phaseResults.push(...processEntries);

  // 检查点（process 批完成后）：批中/批尾发现中止 → gather 不再启动。批内有
  // 未启动条目时中止点记为 process，否则记为下一个未启动阶段 gather
  if (isAborted(signal)) {
    return {
      ok: false, status: 'aborted',
      abortedAtPhase: processEntries.some((e) => e.aborted) ? 'process' : 'gather',
      workflow: 'scatter-gather', task, workdir, model: modelRef,
      phases: phaseResults, final: null,
      error: `已中止（aborted）: process 批次中止，${processEntries.filter((e) => e.ok).length}/${norm.length} 个子任务已完成`,
      startedAt, finishedAt: new Date().toISOString(),
    };
  }

  const failedCount = outputs.filter((o) => o === null).length;
  if (failedCount === norm.length) {
    return {
      ok: false, status: 'failed', workflow: 'scatter-gather', task, workdir, model: modelRef,
      phases: phaseResults, final: null,
      error: `全部 ${norm.length} 个子任务处理失败: ${phaseResults[1].error}`,
      startedAt, finishedAt: new Date().toISOString(),
    };
  }

  // 段 3：gather
  if (onPhase) onPhase({ phase: 'gather', status: 'running' });
  const subsMd = norm.map((st, i) => `### ${st.name}\n${outputs[i] || '(该子任务失败，缺结果)'}`).join('\n\n');
  const gather = await runPhase({
    name: 'gather', label: '合并核对',
    prompt:
      `你是 scatter-gather 工作的 gather 者。各子任务结果：\n\n${subsMd}\n\n` +
      `## 大任务（回顾）\n${task}\n\n` +
      `## 你的职责\n先核对实际状态：运行 git status 与 git diff --stat（非 git 仓库用 ls 核对），对照各子任务自述。\n\n` +
      `## 输出格式\n以「## 最终报告」开头：1) 大任务整体完成度 2) 实际改动总清单 3) 子任务间的遗漏/重复/冲突\n` +
      `4) 遗留风险与建议。不超过 500 字。`,
    cwd: workdir, modelRef, timeoutMs: timeoutMsPerPhase, signal,
  });
  phaseResults.push(gather);
  if (onPhase) onPhase({ phase: 'gather', status: gather.aborted ? 'aborted' : gather.ok ? 'done' : 'failed' });

  // 检查点（gather 完成后）：运行中 abort → 整体按 aborted 返回，条目保留
  if (isAborted(signal)) {
    return {
      ok: false, status: 'aborted', abortedAtPhase: 'gather',
      workflow: 'scatter-gather', task, workdir, model: modelRef,
      phases: phaseResults, final: null,
      error: '已中止（aborted）: gather 阶段中止',
      startedAt, finishedAt: new Date().toISOString(),
    };
  }

  return {
    ok: gather.ok, status: gather.ok ? 'ok' : 'failed',
    workflow: 'scatter-gather', task, workdir, model: modelRef,
    phases: phaseResults, final: gather.ok ? gather.response : null,
    sections: [{
      title: `子任务清单（scatter 拆出 ${norm.length} 个）`,
      body: norm.map((st, i) => `${i + 1}. **${st.name}** — ${st.description}`).join('\n'),
    }],
    ...(gather.ok ? {} : { error: `gather 阶段失败: ${gather.error}` }),
    startedAt, finishedAt: new Date().toISOString(),
  };
}

module.exports = { runScatterGather };
