'use strict';
/**
 * chain workflow：analyze → transform → synthesize 顺序三步链。
 * 对标 pi-subagent-workflow 的 chain.js。
 * 每阶段 = 一个独立 zcode 无头 session，前一阶段结论注入后一阶段 prompt。
 *
 * zsub 移植差异（相对源 dynamic-workflow/lib/chain.js，逻辑/默认值不变）：
 * - driver 入口替换：旧 driver.runHeadlessPhase + 条目包装改为本目录
 *   phases.js 的 runPhase（内部经 run-phase.js 调 zsub driver；条目新增
 *   timedOut 字段，报告「超时」标记真正生效）。
 * - 模型解析：旧 driver.resolveModelRef(model)（空输入回落硬编码默认模型）
 *   改为 ModelRouter.resolve(model)——空输入回落 v2 config 的 model.main，
 *   读不到才回退 GLM-5.3，并额外校验 provider 只支持
 *   builtin:bigmodel-coding-plan；返回值仍为全名 modelRef，行为兼容。
 * - 隔离 HOME 准备：旧版在 workflow 入口 bootstrapIsolatedHome(modelRef)
 *   一次性重写固定目录；zsub 职责移到 run-phase → prepareRunEnv（per-model
 *   HOME 池 + mtime 条件重写，首轮 bootstrap、后续阶段零开销），本文件不再
 *   显式 bootstrap。
 * - 防递归：driver 强制注入 ZSUB_NESTED=1（替代旧 DWF_NESTED=1），叠加隔离
 *   HOME 配置不含 plugins，阶段子进程物理上无法再起嵌套任务。
 */

const { runPhase } = require('./phases');
const ModelRouter = require('../model-router');

// resolve() 无解析状态；模块级单例保持与 run-phase.js 相同的实例化习惯
const modelRouter = new ModelRouter();

// 注入下阶段 prompt 的上阶段输出上限（防撑爆 argv）
const MAX_CARRYOVER_CHARS = 16000;

function clip(text, max = MAX_CARRYOVER_CHARS) {
  if (!text) return '(空)';
  return text.length <= max ? text : `${text.slice(0, max)}\n...(已截断，原文 ${text.length} 字符)`;
}

const PHASES = [
  {
    name: 'analyze', label: '分析',
    buildPrompt: ({ task }) =>
      `你是三步工作流（分析→实现→总结）的第 1 步：分析者。\n\n` +
      `## 任务\n${task}\n\n` +
      `## 你的职责\n在当前工作目录内调查与任务相关的事实：涉及哪些文件/模块、现状如何、有哪些约束与风险。\n` +
      `禁止修改任何文件（只读调查）。\n\n` +
      `## 输出格式\n以「## 分析结论」开头，包含：\n1. 关键事实（带文件路径证据）\n2. 建议的实现做法\n3. 风险与注意点\n不超过 600 字。`,
  },
  {
    name: 'transform', label: '实现',
    buildPrompt: ({ task, prev: { analyze } }) =>
      `你是三步工作流（分析→实现→总结）的第 2 步：实现者。\n\n` +
      `## 原始任务\n${task}\n\n` +
      `## 第 1 步分析结论\n${clip(analyze)}\n\n` +
      `## 你的职责\n按分析结论在当前工作目录完成实现：可修改/新建文件、运行命令验证。\n` +
      `若分析与实际不符，以实际代码为准并在结果中说明。\n\n` +
      `## 输出格式\n以「## 实现结果」开头，包含：改了什么（文件清单）、如何验证的（命令+结果）、遗留问题。\n不超过 600 字。`,
  },
  {
    name: 'synthesize', label: '总结',
    buildPrompt: ({ task, prev }) =>
      `你是三步工作流（分析→实现→总结）的第 3 步：总结者。\n\n` +
      `## 原始任务\n${task}\n\n` +
      `## 第 1 步分析结论\n${clip(prev.analyze)}\n\n` +
      `## 第 2 步实现结果\n${clip(prev.transform)}\n\n` +
      `## 你的职责\n先核对实际改动：运行 git status 与 git diff --stat（非 git 仓库则用 ls 核对涉及文件），\n` +
      `对照第 2 步的自述，发现不一致要指出。\n\n` +
      `## 输出格式\n以「## 最终报告」开头，包含：任务完成度 / 实际改动清单 / 验证情况 / 遗留风险。\n不超过 500 字。`,
  },
];

/**
 * @param {object} opts
 * @param {string} opts.task 任务描述
 * @param {string} opts.workdir 工作目录
 * @param {string} [opts.model] 模型（短名或全 ref）
 * @param {number} [opts.timeoutMsPerPhase]
 * @param {(e:{phase:string,status:string})=>void} [opts.onPhase]
 * @param {(expected:number)=>void} [opts.onPlan]
 */
async function runChain({ task, workdir, model, timeoutMsPerPhase = 600000, onPhase, onPlan }) {
  const modelRef = modelRouter.resolve(model);
  const startedAt = new Date().toISOString();
  if (onPlan) onPlan(PHASES.length);

  const prevOutputs = {};
  const phaseResults = [];

  for (let i = 0; i < PHASES.length; i++) {
    const phase = PHASES[i];
    if (onPhase) onPhase({ phase: phase.name, status: 'running' });
    const entry = await runPhase({
      name: phase.name, label: phase.label,
      prompt: phase.buildPrompt({ task, prev: prevOutputs }),
      cwd: workdir, modelRef, timeoutMs: timeoutMsPerPhase,
    });
    phaseResults.push(entry);
    if (onPhase) onPhase({ phase: phase.name, status: entry.ok ? 'done' : 'failed' });
    if (!entry.ok) {
      return {
        ok: false, workflow: 'chain', task, workdir, model: modelRef, phases: phaseResults,
        final: null, error: `阶段 ${phase.name}（${phase.label}）失败: ${entry.error}`,
        startedAt, finishedAt: new Date().toISOString(),
      };
    }
    prevOutputs[phase.name] = entry.response;
  }

  return {
    ok: true, workflow: 'chain', task, workdir, model: modelRef, phases: phaseResults,
    final: prevOutputs.synthesize,
    startedAt, finishedAt: new Date().toISOString(),
  };
}

module.exports = { runChain, PHASES };
