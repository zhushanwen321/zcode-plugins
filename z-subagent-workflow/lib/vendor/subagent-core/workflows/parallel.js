// parallel.js — 并行多视角分析（通用 subagent 编排）
//
// 模式：N 个 agent 从不同角度并行分析同一目标 → 汇总聚合。
// 适用于需要多维度评估（安全/性能/可维护性等）的场景。
//
// 用法：
//   workflow run parallel --args target="src/auth/login.ts"（pi 宿主语法）
//   workflow run parallel --args target="..." --args 'perspectives=["security","readability"]'（pi 宿主语法）
//   zsw workflow --workflow parallel --task "<分析目标>" --workdir <绝对路径>（zsw 宿主直参语法；per-workflow 参数用 zsw 专属 flag，语义见 @pi-meta parameters）
//
// ⚠️ 分层配额规则（来源：ADR-030 决策 3）：
//   - 全局并发上限 maxConcurrent = 6
//   - parallel() 内的 agent() 调用共享配额池，超出自动排队（不报错）
//   - 本脚本默认 3 视角并行，配额充足
//
// ⚠️ lintScript 约束（本脚本已遵守）：含 parallel() 入口，禁止 bare IIFE

/* @pi-meta
name: parallel
description: 通用编排：多视角并行分析同一目标，再聚合汇总
phases: [parallel-analyze, aggregate]
parameters:
  type: object
  properties:
    target: { type: string }
    perspectives: { type: array, items: { type: string } }
    agents: { type: string }
  required: [target]
usage: |
  ## 使用说明
  - 多视角并行分析后聚合；perspectives 缺省用 3 个默认视角
  - agents：逗号分隔的 agent .md 绝对路径；1 个应用于所有视角，N 个一一对应视角数
  - 示例（pi 宿主语法）：workflow run parallel --args target="<分析目标>" agents="/path/analyst.md"
  - 示例（zsw 宿主直参语法）：zsw workflow --workflow parallel --task "<分析目标>" --workdir <绝对路径>（per-workflow 参数用 zsw 专属 flag，语义见 @pi-meta parameters）
*/

// ── 入参（$ARGS）──────────────────────────────────────────────────
const target = $ARGS.target;
if (!target) {
  throw new Error("parallel 缺少必需参数 target。用法：workflow run parallel --args target=\"<分析目标>\"");
}
const perspectives = Array.isArray($ARGS.perspectives) && $ARGS.perspectives.length > 0
  ? $ARGS.perspectives
  : ["security", "performance", "maintainability"];
if (perspectives.some((p) => typeof p !== "string")) {
  throw new Error("parallel 参数 perspectives 必须是字符串数组，实际含非字符串元素");
}

// S4：agents 参数 = 逗号分隔的 agentRef 路径数组；1 个 = 所有视角，N 个 = 一一对应
// worker 沙箱为 eval 模式：require 相对路径以 cwd 为基准（非脚本目录），
// 必须用 workerData.scriptPath 锚定脚本目录（review-fix-loop 同模式）；
// scriptPath 注入是 worker 契约的显式前提（D1 加固），缺席即 fail-fast，
// 不回退 cwd——消除从用户目录误加载/被植入同名 _shared/agent-refs.cjs 的代码加载面。
if (typeof workerData === "undefined" || !workerData || typeof workerData.scriptPath !== "string") {
  throw new Error("parallel: core_module_load_failed: workerData.scriptPath 缺失，无法定位 workflows/_shared/agent-refs.cjs。" +
    "恢复动作：worker 宿主（WorkerHost）启动 worker 时必须经 workerData 注入 scriptPath" +
    "（指向本脚本真实路径，注入点见 src/orchestration/worker-host.ts 的 workerData 组装处），" +
    "禁止依赖 process.cwd() 巧合。");
}
const SCRIPT_DIR = require("path").dirname(workerData.scriptPath);
const { parseAgentRefs, agentRefAt } = require(SCRIPT_DIR + "/_shared/agent-refs.cjs");
const agentRefs = parseAgentRefs($ARGS.agents);
const agentFor = (i) => {
  if (agentRefs.length === 1) return { agent: agentRefs[0] };
  const ref = agentRefAt(agentRefs, i);
  return ref ? { agent: ref } : {};
};

log("parallel 开始，target=" + target + " perspectives=" + JSON.stringify(perspectives) + (agentRefs.length ? " agents=" + agentRefs.join(",") : ""));

let currentPhase = "init";
let outcome;

try {
  // ── 段 1：parallel-analyze（多视角并行分析）──────────────────────
  phase("parallel-analyze");
  currentPhase = "parallel-analyze";

  // parallel() 接受 Promise 数组；agent() 返回 Promise。allSettled 语义。
  const perPerspectiveRaw = await parallel(
    perspectives.map((p, i) =>
      agent({
        prompt:
          "从「" + p + "」角度分析以下目标，给出评分和发现的问题：\n\n" + target,
        schema: {
          type: "object",
          properties: {
            perspective: { type: "string", description: "视角名称" },
            score: { type: "number", description: "0-10 评分" },
            findings: {
              type: "array",
              items: { type: "string" },
              description: "发现的问题",
            },
          },
          required: ["perspective", "score", "findings"],
        },
        description: "parallel-" + p,
        ...agentFor(i),
      })
    ),
  );

  // 收集结果，标记成功/失败
  const perPerspective = [];
  let failedCount = 0;
  for (let i = 0; i < perPerspectiveRaw.length; i++) {
    const r = perPerspectiveRaw[i];
    if (!r || r.status === "failed" || r.error) {
      perPerspective.push({
        perspective: perspectives[i],
        status: "failed",
        error: r ? (r.error || "agent 返回 failed 状态") : "agent 无返回",
      });
      failedCount++;
    } else {
      perPerspective.push({
        perspective: perspectives[i],
        status: "ok",
        score: typeof r.score === "number" ? r.score : undefined,
        findings: Array.isArray(r.findings) ? r.findings : [],
      });
    }
  }
  if (failedCount === perspectives.length) {
    throw new Error("全部视角分析失败（" + failedCount + "/" + perspectives.length + "）");
  }
  log("parallel-analyze 完成：ok=" + (perspectives.length - failedCount) + " failed=" + failedCount);

  // ── 段 2：aggregate（汇总多视角结果）────────────────────────────
  phase("aggregate");
  currentPhase = "aggregate";

  // 纯代码合并：拼接各视角发现的问题（不调用 LLM）
  const aggregateResult = perPerspective
    .map((p) => "[" + (p.perspective || "?") + "] " + (p.findings ? p.findings.join("; ") : "(no findings)"))
    .join("\n");

  outcome = {
    status: failedCount > 0 ? "partial" : "ok",
    phases_run: ["parallel-analyze", "aggregate"],
    perspectives_analyzed: perspectives.length,
    per_perspective: perPerspective,
    aggregate: aggregateResult,
    message: "parallel 完成：" + perspectives.length + " 视角（失败 " + failedCount + "）→ 聚合",
  };
} catch (err) {
  outcome = {
    status: "error",
    phase: currentPhase,
    error: err && err.message ? err.message : String(err),
    message: "parallel 在 " + currentPhase + " 段失败",
  };
}

return outcome;
