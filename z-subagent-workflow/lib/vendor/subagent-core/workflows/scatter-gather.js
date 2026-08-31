// scatter-gather.js — 分发-收集（通用 subagent 编排）
//
// 模式（三段）：
//   段 1 scatter: agent() 把大任务拆成 2-4 个可并行的子任务
//   段 2 process: parallel() 并行处理每个子任务
//   段 3 gather:  agent() 合并所有子任务结果
//
// 适用于"任务太大需要先拆分再并行处理"的场景。
//
// 用法：
//   workflow run scatter-gather --args task="重构认证模块，涉及 session/jwt/oauth 三块"（pi 宿主语法）
//   zsw workflow --workflow scatter-gather --task "<大任务描述>" --workdir <绝对路径>（zsw 宿主直参语法；per-workflow 参数用 zsw 专属 flag，语义见 @pi-meta parameters）
//
// ⚠️ lintScript 约束（本脚本已遵守）：含 parallel() 入口（兼 agent 嵌套），禁止 bare IIFE

/* @pi-meta
name: scatter-gather
description: 通用编排：scatter 拆分 → parallel 处理 → gather 合并 三段
phases: [scatter, process, gather]
parameters:
  type: object
  properties:
    task: { type: string }
    agents: { type: string }
  required: [task]
usage: |
  ## 使用说明
  - scatter 拆解大任务 → process 并行处理 → gather 聚合结果
  - agents：逗号分隔的 agent .md 绝对路径，按顺序对应 scatter/process/gather 三段
  - 示例（pi 宿主语法）：workflow run scatter-gather --args task="<大任务描述>" agents="/path/splitter.md,/path/processor.md"
  - 示例（zsw 宿主直参语法）：zsw workflow --workflow scatter-gather --task "<大任务描述>" --workdir <绝对路径>（per-workflow 参数用 zsw 专属 flag，语义见 @pi-meta parameters）
*/

// ── 入参（$ARGS）──────────────────────────────────────────────────
const task = $ARGS.task;
if (!task) {
  throw new Error("scatter-gather 缺少必需参数 task。用法：workflow run scatter-gather --args task=\"<大任务描述>\"");
}

// S4：agents 参数 = 逗号分隔的 agentRef 路径数组，按顺序对应 scatter/process/gather
// worker 沙箱为 eval 模式：require 相对路径以 cwd 为基准（非脚本目录），
// 必须用 workerData.scriptPath 锚定脚本目录（review-fix-loop 同模式）；
// scriptPath 注入是 worker 契约的显式前提（D1 加固），缺席即 fail-fast，
// 不回退 cwd——消除从用户目录误加载/被植入同名 _shared/agent-refs.cjs 的代码加载面。
if (typeof workerData === "undefined" || !workerData || typeof workerData.scriptPath !== "string") {
  throw new Error("scatter-gather: core_module_load_failed: workerData.scriptPath 缺失，无法定位 workflows/_shared/agent-refs.cjs。" +
    "恢复动作：worker 宿主（WorkerHost）启动 worker 时必须经 workerData 注入 scriptPath" +
    "（指向本脚本真实路径，注入点见 src/orchestration/worker-host.ts 的 workerData 组装处），" +
    "禁止依赖 process.cwd() 巧合。");
}
const SCRIPT_DIR = require("path").dirname(workerData.scriptPath);
const { parseAgentRefs, agentRefAt } = require(SCRIPT_DIR + "/_shared/agent-refs.cjs");
const agentRefs = parseAgentRefs($ARGS.agents);
const stepAgent = (i) => { const ref = agentRefAt(agentRefs, i); return ref ? { agent: ref } : {}; };

log("scatter-gather 开始，task=" + task + (agentRefs.length ? "，agents=" + agentRefs.join(",") : ""));

let currentPhase = "init";
let outcome;

try {
  // ── 段 1：scatter（拆分任务）─────────────────────────────────────
  phase("scatter");
  currentPhase = "scatter";
  const split = await agent({
    prompt:
      "把以下任务拆成 2-4 个可独立并行处理的子任务。每个子任务应有明确边界，不互相依赖：\n\n" +
      task,
    schema: {
      type: "object",
      properties: {
        subtasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "子任务名称" },
              description: { type: "string", description: "子任务详细描述" },
            },
            required: ["name", "description"],
          },
          description: "2-4 个可并行的子任务",
        },
      },
      required: ["subtasks"],
    },
    description: "scatter-split",
    ...stepAgent(0),
  });

  const subtasks = Array.isArray(split?.subtasks) ? split.subtasks : [];
  if (subtasks.length === 0) {
    throw new Error("scatter 返回的 subtasks 为空");
  }
  if (subtasks.some((s) => !s || typeof s.name !== "string")) {
    throw new Error("scatter 返回的 subtasks 每项需含 name 字符串字段");
  }
  log("scatter 出 " + subtasks.length + " 个子任务");

  // ── 段 2：process（parallel 并行处理每个子任务）──────────────────
  phase("process");
  currentPhase = "process";
  const processedRaw = await parallel(
    subtasks.map((s) =>
      agent({
        prompt:
          "处理以下子任务，输出处理结果：\n\n子任务：" + s.name + "\n描述：" + s.description,
        schema: {
          type: "object",
          properties: {
            subtask: { type: "string", description: "子任务名称" },
            result: { type: "string", description: "处理结果" },
          },
          required: ["subtask", "result"],
        },
        description: "scatter-process-" + s.name,
        ...stepAgent(1),
      })
    ),
  );

  const processed = [];
  let failedCount = 0;
  for (let i = 0; i < processedRaw.length; i++) {
    const r = processedRaw[i];
    if (!r || r.status === "failed" || r.error) {
      processed.push({
        subtask: subtasks[i].name,
        status: "failed",
        error: r ? (r.error || "agent 返回 failed 状态") : "agent 无返回",
      });
      failedCount++;
    } else {
      processed.push({
        subtask: subtasks[i].name,
        status: "ok",
        result: (typeof r.result === "string" ? r.result : "(无结果)"),
      });
    }
  }
  if (failedCount === subtasks.length) {
    throw new Error("全部子任务处理失败（" + failedCount + "/" + subtasks.length + "）");
  }
  log("process 完成：ok=" + (subtasks.length - failedCount) + " failed=" + failedCount);

  // ── 段 3：gather（agent 合并所有子任务结果）─────────────────────
  phase("gather");
  currentPhase = "gather";

  const gatheredResult = await agent({
    prompt:
      "以下是各子任务的处理结果，请合并成一个完整、一致的最终结果：\n\n" +
      JSON.stringify(processed, null, 2),
    schema: {
      type: "object",
      properties: {
        mergedResult: { type: "string", description: "合并后的最终结果" },
        completeness: { type: "string", description: "完整性评估" },
      },
      required: ["mergedResult", "completeness"],
    },
    description: "scatter-gather-merge",
    ...stepAgent(2),
  });

  outcome = {
    status: failedCount > 0 ? "partial" : "ok",
    phases_run: ["scatter", "process", "gather"],
    subtasks_total: subtasks.length,
    subtasks_processed: subtasks.length - failedCount,
    gathered: {
      mergedResult: (gatheredResult?.mergedResult ?? "(合并无结果)"),
      completeness: (gatheredResult?.completeness ?? "(合并无结果)"),
    },
    message: "scatter-gather 完成：split " + subtasks.length + " → process（失败 " + failedCount + "）→ merge",
  };
} catch (err) {
  outcome = {
    status: "error",
    phase: currentPhase,
    error: err && err.message ? err.message : String(err),
    message: "scatter-gather 在 " + currentPhase + " 段失败",
  };
}

return outcome;
