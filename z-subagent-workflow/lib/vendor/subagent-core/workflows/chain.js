// chain.js — 顺序多步处理（通用 subagent 编排）
//
// 模式：analyze → transform → synthesize，每步 agent() 输出作下步输入。
// 适用于需要"先分析、再变换、最后综合"的多阶段任务。
//
// 用法：
//   workflow run chain --args task="把这段需求文档拆成技术任务：..."（pi 宿主语法）
//   zsw workflow --workflow chain --task "<任务书>" --workdir <绝对路径>（zsw 宿主直参语法；`zsw` 为 CLI 简写，实际执行以 SessionStart 注入段的 node "<绝对路径>/bin/zsw.js" 形态为准；per-workflow 参数用 zsw 专属 flag，语义见 @pi-meta parameters）
//
// ⚠️ lintScript 约束（本脚本已遵守）：
//   - 含 agent() 入口
//   - 禁止 bare IIFE（用 top-level await）
//   - 禁止用 result 作变量名

/* @pi-meta
name: chain
description: 通用编排：analyze → transform → synthesize 顺序三步链
phases: [analyze, transform, synthesize]
parameters:
  type: object
  properties:
    task: { type: string, minLength: 1 }
    agents: { type: string }
  required: [task]
usage: |
  ## 使用说明
  - 顺序三步链：analyze（提取要点）→ transform（产出方案）→ synthesize（合成结论）
  - agents：逗号分隔的 agent .md 绝对路径，按顺序对应三步（少于 3 个尾部用默认执行者）
  - 示例（pi 宿主语法）：workflow run chain --args task="<任务描述>" agents="/path/analyzer.md,/path/planner.md"
  - 示例（zsw 宿主直参语法；`zsw` 为 CLI 简写，实际以注入段 node "<绝对路径>/bin/zsw.js" 形态为准）：zsw workflow --workflow chain --task "<任务描述>" --workdir <绝对路径>（per-workflow 参数用 zsw 专属 flag，语义见 @pi-meta parameters）
*/

// ── 入参（$ARGS）──────────────────────────────────────────────────
const task = $ARGS.task;
if (typeof task !== "string" || task.trim() === "") {
  throw new Error("chain 缺少必需参数 task（非空字符串）。用法：workflow run chain --args task=\"<描述>\"");
}

// S4：agents 参数 = 逗号分隔的 agentRef 路径数组，按阶段顺序对应三步
// worker 沙箱为 eval 模式：require 相对路径以 cwd 为基准（非脚本目录），
// 必须用 workerData.scriptPath 锚定脚本目录（review-fix-loop 同模式）；
// scriptPath 注入是 worker 契约的显式前提（D1 加固），缺席即 fail-fast，
// 不回退 cwd——消除从用户目录误加载/被植入同名 _shared/agent-refs.cjs 的代码加载面。
if (typeof workerData === "undefined" || !workerData || typeof workerData.scriptPath !== "string") {
  throw new Error("chain: core_module_load_failed: workerData.scriptPath 缺失，无法定位 workflows/_shared/agent-refs.cjs。" +
    "恢复动作：worker 宿主（WorkerHost）启动 worker 时必须经 workerData 注入 scriptPath" +
    "（指向本脚本真实路径，注入点见 src/orchestration/worker-host.ts 的 workerData 组装处），" +
    "禁止依赖 process.cwd() 巧合。");
}
const SCRIPT_DIR = require("path").dirname(workerData.scriptPath);
const { parseAgentRefs, agentRefAt } = require(SCRIPT_DIR + "/_shared/agent-refs.cjs");
const agentRefs = parseAgentRefs($ARGS.agents);
const stepAgent = (i) => { const ref = agentRefAt(agentRefs, i); return ref ? { agent: ref } : {}; };

log("chain 开始，task=" + task + (agentRefs.length ? "，agents=" + agentRefs.join(",") : ""));

let currentPhase = "init";
let outcome;

try {
  // ── 段 1：analyze（分析任务，提取关键点）─────────────────────────
  phase("analyze");
  currentPhase = "analyze";
  const analysis = await agent({
    prompt: "分析以下任务，提取核心洞察和关键点：\n\n" + task,
    schema: {
      type: "object",
      properties: {
        insights: { type: "string", description: "对任务的核心洞察" },
        keyPoints: {
          type: "array",
          items: { type: "string" },
          description: "关键点列表",
        },
      },
      required: ["insights", "keyPoints"],
    },
    description: "chain-analyze",
    ...stepAgent(0),
  });

  // ── 段 2：transform（基于分析产出方案）───────────────────────────
  phase("transform");
  currentPhase = "transform";
  const plan = await agent({
    prompt:
      "基于以下分析结果，产出可执行方案：\n\n洞察：" + (analysis?.insights ?? "(分析无结果)") +
      "\n关键点：" + JSON.stringify(analysis?.keyPoints ?? []),
    schema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "执行方案" },
        actions: {
          type: "array",
          items: { type: "string" },
          description: "具体行动步骤",
        },
      },
      required: ["plan", "actions"],
    },
    description: "chain-transform",
    ...stepAgent(1),
  });

  // ── 段 3：synthesize（综合方案输出最终结论）─────────────────────
  phase("synthesize");
  currentPhase = "synthesize";
  const final = await agent({
    prompt:
      "综合以下方案，输出最终结论和建议：\n\n方案：" + (plan?.plan ?? "(方案无结果)") +
      "\n行动步骤：" + JSON.stringify(plan?.actions ?? []),
    schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "最终总结" },
        recommendation: { type: "string", description: "核心建议" },
      },
      required: ["summary", "recommendation"],
    },
    description: "chain-synthesize",
    ...stepAgent(2),
  });

  outcome = {
    status: "ok",
    phases_run: ["analyze", "transform", "synthesize"],
    final: { summary: (final?.summary ?? "(综合无结果)"), recommendation: (final?.recommendation ?? "(综合无结果)") },
    message: "chain 完成：analyze → transform → synthesize 全绿",
  };
} catch (err) {
  outcome = {
    status: "error",
    phase: currentPhase,
    error: err && err.message ? err.message : String(err),
    message: "chain 在 " + currentPhase + " 段失败",
  };
}

return outcome;
