// review-fix-loop.js — 通用多批审查-修复循环（内置 workflow）
//
// 模式：多批（batch）串行，批内循环（round）：并行 review → aggregate → fix → 重审。
// 批次用于表达前置依赖（fallow 静态分析等前置检查必须先完成，后续审查才有意义）。
// 修复范围 = 全部等级（must-fix + suggestion/minor）；批内某 agent 已无任何等级问题
// （must-fix 与 suggestion 全 0）则后续轮跳过，优化 token 效率。终止/收敛判定仍以
// must-fix 为主驱动，但任何「成功类」终止（clean/converged/A4 全降级）都要求 suggestion 也为 0。
// stuck 检测只看 must-fix（suggestion 主观新冒不谈 stuck，由 maxRounds 硬顶兑底）。
//
// 台账守门（假 clean 防护）：state.issues 是「问题是否全部解决」的唯一权威——四个
// 成功收工点（全员 clean 早退 / all-clean / converged / A4 全降级）统一前置
// hasOpenResidue：本轮观测（reviewer 报数 / 聚合活跃条目）为 0 不蕴涵台账已清。
// 残留时重派追账（台账未结条目注入 R2+ prompt），reviewer 的 reconciliation 申报
// fixed（带 evidence）→ reconcileIssues 清账；not-fixed → openStreak 增长走 stuck；
// 无视 → maxRounds 兜底——任何路径不再产出「clean 终态 + 台账 open 残留」的自相矛盾。
//
// 身份对齐（编号+标题三级）：aggregator 编号跨轮不稳定（紧凑化重排 / 同题换号），
// 表格号不直接当台账主键——merge 时 resolveIssueIdentity 三级对齐（L1 编号+标题
// 双命中沿用 / L2 标题归一唯一命中沿用旧键 / L3 避让分配），改键条目记入
// state.idMap（本轮表格号→台账键），fix 写入与下轮对账经 translateId 翻译
// （ES3 集合比较双侧保持表格号空间不翻译）。title 随条目落 issues/dormant。
//
// 用法：
//   workflow run review-fix-loop --args targetType=git-diff target=main \
//     batch1="/path/reviewer-a.md,/path/reviewer-b.md" autoCommit=true（pi 宿主语法）
//   workflow run review-fix-loop --args targetType=file target=/path/to/doc.md \
//     batch1="/path/doc-reviewer.md" autoCommit=false（pi 宿主语法）
//   zsw workflow --workflow review-fix-loop --task "<任务书>" --workdir <绝对路径>（zsw 宿主直参语法；per-workflow 参数用 zsw 专属 flag --target-type/--target/--batch1 等，语义见 @pi-meta parameters）
//
// S4 路径统一：batch1..batchN/fixAgent 值 = agentRef（.md 绝对路径，<available_subagents> 的
// <location>）；fallowScan=true 独立参数前置插入静态分析批次（不占 batchN）。
// ⚠️ 唯一带写操作的内置 workflow：fix 阶段会修改文件（autoCommit=true 时 commit）。
// ⚠️ lintScript 约束（本脚本已遵守）：含 parallel() 入口，禁止 bare IIFE；
//    agent() 调用顺序确定（批次按配置顺序稳定排序，callId 重放安全）。
//
// ⚠️ 与 main 的 4.0.0 版分叉（merge 时 add/add 冲突，刻意决策记录）：
//    本版（feat-recursive-optimize）保留——纯函数拆到 review-fix-loop-utils.cjs（vitest 覆盖）、
//    支持 fallow-scan 前置批次、无默认批次（batch1..batchN/agents 必传）、recheckAfterFix 默认 false。
//    main 4.0.0 版自包含 677 行、缺批次参数时默认单批 ["reviewer"]、recheckAfterFix 默认 false。
//    merge 时保留本版（功能更全），详见 .changeset/tidy-waves-description-phase-lint.md。

/* @pi-meta
name: review-fix-loop
description: >-
  多批串行审查-修复循环：批内并行 review 聚合全部等级问题（must-fix + suggestion）后迭代修复直到 clean，终止判定以 must-fix 驱动且要求 suggestion 同样归零（唯一带写操作与 commit 副作用的内置 workflow，autoCommit 默认 false）
when: 用户要 review 并迭代修复至 clean
notFor: 单纯审查不改代码
phases: [Review, Fix]
parameters:
  type: object
  properties:
    targetType: { type: string, enum: [git-diff, file, dir, text] }
    target: { type: string, minLength: 1, pattern: '\S' }
    autoCommit: { type: boolean, default: false }
    maxRounds: { type: integer, default: 10, minimum: 1 }
    stuckThreshold: { type: integer, default: 3, minimum: 1 }
    skipCleanAgents: { type: boolean, default: true }
    recheckAfterFix: { type: boolean, default: false }
    fixAgent: { type: string }
    maxFixAttempts: { type: integer, default: 2, minimum: 1 }
    convergeNewIssues: { type: integer, default: 1, minimum: 1 }
    convergeRounds: { type: integer, default: 2, minimum: 1 }
    aggregatorModel: { type: string, description: cheaper model for the aggregate step (mechanical dedup/format work); route per global/project AGENTS.md, confirm with the owner before adding a new entry; defaults to the run model }
    reviewPrompt: { type: string }
    fixPrompt: { type: string }
    fallowScan: { type: boolean, default: false }
    agents: { type: string }
    batchNames: { type: string }
  patternProperties:
    "^batch\\d+$":
      type: string
      description: 任意 batchN 编号，至少一个；值为 agent .md 绝对路径（逗号分隔多 agent）
  required: [targetType, target]
usage: |
  ## 使用说明
  - batch1..batchN 与 agents 互斥（至少传一个 batchN）；值 = agentRef（.md 绝对路径，<available_subagents> 的 <location>）
  - fixAgent：fix 阶段执行者（agentRef），缺省用通用 subagent + 内联 fixPrompt
  - fallowScan=true 仅 targetType=git-diff 合法（前置静态分析批次，不占 batchN）
  - 示例（pi 宿主语法）：workflow run review-fix-loop --args targetType=git-diff target=main batch1="/path/fallow-agent.md,/path/reviewer.md" autoCommit=true
  - 示例（zsw 宿主直参语法）：zsw workflow --workflow review-fix-loop --task "<任务书>" --workdir <绝对路径>（per-workflow 参数用 zsw 专属 flag --target-type/--target/--batch1 等，语义见 @pi-meta parameters）
*/

// ── 参数解析 + 白名单校验（fail-fast） ────────────────────────────

function fail(msg) {
  throw new Error("review-fix-loop: " + msg);
}

// ── 可测纯函数模块 ────────────────────────────────────────────────
// 参数校验（白名单，类型校验由 m3 args-validator schema 接管）/批次解析/聚合结果解析/审查指令构建
// 的纯函数在 review-fix-loop-utils.cjs，
// vitest 单测见 src/__tests__/review-fix-loop-utils.test.ts。
// worker 运行时经 workerData.scriptPath 定位自身目录——内置 workflow 在 npm 包内，
// process.cwd() 是用户项目目录，不能作为锚点；scriptPath 注入是 worker 契约的显式前提
// （D1 加固），缺席即 fail-fast，不回退 cwd——消除从用户目录误加载/被植入同名
// review-fix-loop-utils.cjs 的代码加载面。
// 校验先于 $ARGS 白名单执行；fail 为函数声明（提升可用），沿用同一失败输出协议。
if (typeof workerData === "undefined" || !workerData || typeof workerData.scriptPath !== "string") {
  fail("core_module_load_failed: workerData.scriptPath 缺失，无法定位 review-fix-loop-utils.cjs。" +
    "恢复动作：worker 宿主（WorkerHost）启动 worker 时必须经 workerData 注入 scriptPath" +
    "（指向本脚本真实路径，注入点见 src/orchestration/worker-host.ts 的 workerData 组装处），" +
    "禁止依赖 process.cwd() 巧合。");
}

const {
  TARGET_TYPES,
  VALID_ARG_KEYS,
  parseBatches,
  resolveBatchNames,
  buildReviewInstruction,
  lockReviewBase,
  buildScopedRecheckPrompt,
  wrapUntrusted,
  buildFixPrompt,
  buildR1ReviewPrompt,
  buildR2ReviewPrompt,
  buildAggregatorPrompt,
  resolveReviewReportPath,
  normalizeFixResult,
  validateFixResult,
  findIssueKey,
  hasOpenResidue,
  resolveIssueIdentity,
  translateId,
  translateReconSets,
  reconcileIssues,
  normalizeReviewResult,
  computeKnownRemaining,
  checkConvergence,
  findNeedsRedesign,
  parseResult,
  normalizeAggregatorResult,
  parseAggregatedMd,
  resolveRunRoot,
  computeOrigin,
  recordDormant,
  filterActiveIds,
  filterDormantFromRecon,
  landScores,
  countMissingFields,
  backfillFixRegression,
  applyCleanRoundBackfill,
  resolveAggregatorModel,
  resolveAgentDefs,
  recordAgentClean,
  recordAgentDirty,
  shouldSkipAgent,
  updateStuckState,
  resolveBatchTerminated,
} = require(require("path").dirname(workerData.scriptPath) + "/review-fix-loop-utils.cjs");

// 白名单校验：未知参数名（防 batchX 拼错如 batchl）→ 报错
for (const key of Object.keys($ARGS)) {
  if (VALID_ARG_KEYS.has(key)) continue;
  if (/^batch\d+$/.test(key)) continue;
  fail("未知参数: " + key + "（合法参数: targetType/target/batch1..batchN/agents/batchNames/reviewPrompt/fixPrompt/autoCommit/maxRounds/stuckThreshold/skipCleanAgents/recheckAfterFix/fallowScan/fixAgent/maxFixAttempts/convergeNewIssues/convergeRounds/aggregatorModel）");
}

const targetType = $ARGS.targetType;
if (!TARGET_TYPES.includes(targetType)) {
  fail("targetType 必填且必须是枚举之一: " + TARGET_TYPES.join("/") + "（实际: " + JSON.stringify(targetType) + "）");
}
const target = typeof $ARGS.target === "string" ? $ARGS.target.trim() : "";
if (!target) fail("target 必填（git-diff 时传 base ref 如 main；file 传路径；dir 传目录；text 传描述）");

const reviewPrompt = typeof $ARGS.reviewPrompt === "string" && $ARGS.reviewPrompt.trim()
  ? $ARGS.reviewPrompt.trim()
  : "审查变更/目标是否存在：逻辑错误、边界条件、类型不安全、遗漏、回归风险、代码规范问题。发现问题分三级：critical（严重，必须修）/ major（重要，应当修）/ minor（轻微，建议修）。critical+major 计入 must_fix。";
const fixPrompt = typeof $ARGS.fixPrompt === "string" && $ARGS.fixPrompt.trim()
  ? $ARGS.fixPrompt.trim()
  : "修复全部 must-fix 问题（critical/major）。最小正确修复，不做重构、不做风格改动。";
// 字符串强制转换（m2 exec-review MAJOR-1）：LLM 可能以字符串传布尔/整数（旧 normalizeBool
// 正是为此防御——"false" ?? false 是 truthy 会误触发 commit）。m3 args-validator
// （chokepoint + coerceTypes）上线后此处为双保险，直接执行路径仍受保护。
const coerceBool = (v, fallback) =>
  typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : fallback;
const coerceInt = (v, fallback) =>
  typeof v === "number" && Number.isInteger(v)
    ? v
    : typeof v === "string" && /^\d+$/.test(v.trim())
      ? parseInt(v, 10)
      : fallback;

const autoCommit = coerceBool($ARGS.autoCommit, false);
const maxRounds = coerceInt($ARGS.maxRounds, 10);
const stuckThreshold = coerceInt($ARGS.stuckThreshold, 3);
const skipCleanAgents = coerceBool($ARGS.skipCleanAgents, true);
// 默认 recheckAfterFix=false：clean agent 下轮跳过（与 skipCleanAgents=true 字面语义一致），
// RC-5（fix 后全批全量重审放大 token）在默认场景消失。传 true 启用可选强回归模式：fix 后重派
// 全批，clean agent 走限定 prompt（buildScopedRecheckPrompt，只审 modifiedFiles，5.5）。
const recheckAfterFix = coerceBool($ARGS.recheckAfterFix, false);
// fixAgent（5.3）：值 = .md 绝对路径（同 batchN 的 agent 项值域）；`fallow-scan` 是
// fallowScan 参数的内部保留字，不属于 fixAgent 值域。解析复用 resolveAgentDefs 白名单与
// 加载逻辑。传入时 fix 阶段用 agent({agent: ...}) 派发（代码场景的 verify 命令写在该
// agent.md 内）；未传保持现状（通用 subagent + 内联 prompt）。
const FIX_AGENT_RAW = typeof $ARGS.fixAgent === "string" && $ARGS.fixAgent.trim()
  ? $ARGS.fixAgent.trim() : undefined;
const FIX_DEF = FIX_AGENT_RAW ? resolveAgentDefs([FIX_AGENT_RAW])[0] : null;
// 5.7 收敛终止参数：maxFixAttempts（needs-redesign 阈值，RC-7）/ convergeNewIssues +
// convergeRounds（新发现率收敛阈值）
const maxFixAttempts = coerceInt($ARGS.maxFixAttempts, 2);
const convergeNewIssues = coerceInt($ARGS.convergeNewIssues, 1);
const convergeRounds = coerceInt($ARGS.convergeRounds, 2);
const MODEL = $MODEL;
// rfl aggregator 降档（tier-1 6.4，T8）：聚合是机械去重/格式化工作，可降档到便宜
// 模型。模型路由参考全局/项目 AGENTS.md（当前用户全局有条目：
// xiaomi-token-plan-cn/mimo-v2.5-pro，thinking 开非 max）；无条目请先与主人确认
// 并写入 AGENTS.md。缺省回退主模型（行为与现状一致）。
const AGG_MODEL = resolveAggregatorModel($ARGS.aggregatorModel, MODEL);

// base 锁定（RC-6，5.6）：git-diff 场景 run 启动时锁定 base commit，全程用锁定 hash 构造
// diff 指令，防止 run 期间 base ref 被更新导致各轮 diff 范围不一致。rev-parse 失败（非 git
// 目录 / ref 不存在）降级用原 ref 并 warn，锁定结果随 state.meta.baseHash 记录。
const lockedBase = lockReviewBase(targetType, target);
if (targetType === "git-diff") {
  if (lockedBase.hash) {
    log("Locked review base: " + target + " -> " + lockedBase.hash);
  } else {
    log("WARN: git rev-parse " + target + " failed, falling back to ref for diff base: " + target);
  }
}
const reviewInstruction = buildReviewInstruction(targetType, lockedBase.base);

// 批次解析：batch1..batchN（缺号报错）/ agents 简写；无默认批次——缺批次参数时
// parseBatches 直接 fail-fast（与头注释「batch1..batchN/agents 必传」一致）
const rawBatches = parseBatches($ARGS, fail);

// S4：fallowScan 独立参数（不由 batchN 触发——batchN 值域 = agentRef 路径）。
// fallow 作为内置首批前置插入（fallow-scan 保留字在 resolveAgentDefs 内解析）。
const fallowScan = coerceBool($ARGS.fallowScan, false);
if (fallowScan && targetType !== "git-diff") {
  fail("fallowScan 只支持 targetType=git-diff（它审查 git 变更的静态分析），实际 targetType=" + targetType);
}
const BATCHES = fallowScan ? [["fallow-scan"], ...rawBatches] : rawBatches;

// batchNames（数量校验）
const rawBatchNames = typeof $ARGS.batchNames === "string" && $ARGS.batchNames.trim()
  ? $ARGS.batchNames.split(",").map((s) => s.trim()).filter(Boolean)
  : [];
const BATCH_NAMES = resolveBatchNames(rawBatchNames, BATCHES, fail);

// ── Schemas ─────────────────────────────────────────────────────────

const reviewerSchema = {
  type: "object",
  properties: {
    report_file: { type: "string", description: "Absolute path to the written review report (.md)" },
    report_content: { type: "string", description: "Full markdown report body (for schema-only agents without write tool; workflow writes it to <roundDir>/<report>.md)" },
    must_fix: { type: "number", description: "Number of must-fix (critical+major) issues found" },
    suggestion: { type: "number", description: "Number of suggestion-level (minor) issues found" },
    reconciliation: {
      type: "array",
      items: {
        type: "object",
        properties: {
          prev_id: { type: "string", description: "Issue id from the previous round (reconciliation continuation)" },
          status: { type: "string", description: "fixed / not-fixed / regressed / escalate — only fixed counts as resolved; fix result claiming fixed is NOT evidence; escalate = a DEFERRED issue whose context was changed by this round's fix (workflow re-opens it for fixing)" },
          evidence: { type: "string", description: "What was read/confirmed (file + what changed)" },
        },
        required: ["prev_id", "status"],
      },
      description: "Reconciliation table (structured): return [] on R1 (no previous round); on R2+ every previous issue_id must have a status entry",
    },
  },
  // T9 前缀稳定化（tier-1 6.9）：required 恒含 reconciliation——schema JSON 逐字嵌入
  // appendSystemPrompt，R1↔R2+ 分叉会造成 system 段字节差异（消息级缓存前缀失效）。
  // R1 的合规输出 = 空数组（prompt 动态段明示）。
  required: ["report_file", "must_fix", "suggestion", "reconciliation"],
};

const aggregatorSchema = {
  type: "object",
  properties: {
    report_file: { type: "string", description: "Absolute path to aggregated.md" },
    must_fix: { type: "number", description: "Total must-fix after dedup across all dimensions, counting adjudication=evidence entries only" },
    suggestion: { type: "number", description: "Total suggestions after dedup across all dimensions" },
    must_fix_ids: {
      type: "array",
      // M1: 支持 [{id, severity}] 对象（severity: critical/major/minor——converged 终止的
      // 「无 critical」判定数据源）+ 旧格式 string[] 兼容。ajv 权威校验两者皆放行。
      // rfl 数据链（tier-1 §7.2）：对象分支增可选 files/evidence/guidance/note/adjudication——
      // origin 归因（files）、修复指引（guidance）、裁决落盘（adjudication+note）的数据源。
      // 降级条目（adjudication ∈ {downgraded, unverified}）保留在数组中，由主循环
      // filterActiveIds 过滤出修复队列（must_fix 计数由 aggregator 按非降级条目报）。
      items: {
        oneOf: [
          { type: "string" },
          {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string" },
              // title（跨轮身份锚点）：buildAggregatorPrompt 已强制要求，schema 侧
              // 补齐保证生成/校验不丢字段——缺失时 L1/L2 身份匹配静默退化为纯编号
              //（编号撞车防护失效）。normalizeMustFixEntry 透传 title。
              title: { type: "string", description: "One-line issue title (cross-round identity anchor)" },
              // A5: severity 加 enum 约束生成侧（prompt 已列三值）；normalize 侧另有
              // 枚举回退兜底（畸形值 → major），双层防御。
              severity: { type: "string", enum: ["critical", "major", "minor"] },
              files: { type: "array", items: { type: "string" }, description: "File paths cited by the issue (regression attribution)" },
              evidence: { type: "string", description: "Cited evidence (files/lines/test results) from the sub-review" },
              guidance: { type: "string", description: "One-line fix direction for the fixer (code wins on conflict)" },
              adjudication: { type: "string", enum: ["evidence", "unverified", "downgraded"], description: "Evidence verdict; downgraded/unverified entries stay in this array but are filtered out of the fix queue" },
              note: { type: "string", description: "Adjudication reason (required when adjudication is unverified/downgraded)" },
            },
          },
        ],
      },
      description: "Issue ids of the deduplicated must-fix list (MF-1..N), matching the first column of the markdown table",
    },
    fixes_caution: {
      type: "array",
      items: { type: "string" },
      description: "Caution entries for weak-evidence or high-risk claims (passed to fix stage)",
    },
    // rfl scores（tier-1 §7.2，M2 打分 rubric 消费）：可选——M1 只透传 schema 与
    // normalize，打分 prompt 段属 M2（T7）。提前落 schema 避免二次 schema 破坏性变更。
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          round: { type: "number", description: "Round of the scored target (R2 aggregation scoring R1 fix -> round=1)" },
          targetKind: { type: "string", description: "reviewer | fix" },
          targetName: { type: "string" },
          dimensions: { type: "object", description: "Dimension name -> 0-10 score" },
          total: { type: ["number", "null"], description: "Weighted total; null = not computable (e.g. clean-round LLM dimensions missing)" },
          note: { type: "string" },
        },
      },
      description: "Optional per-round quality scores (may be omitted until the scoring rubric lands)",
    },
  },
  required: ["report_file", "must_fix", "suggestion"],
};

// fix schema（5.3）：object[]（issue_id/description/self_check/affected_files）+ deferred。
// 兼容性：normalizeFixResult 对旧格式（fixes string[]、无 deferred）兜底解析。
const fixSchema = {
  type: "object",
  properties: {
    fixed_count: { type: "number", description: "Number of issues fixed" },
    fixes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issue_id: { type: "string", description: "Issue identifier from the aggregated report" },
          description: { type: "string", description: "One-line description of the fix" },
          self_check: { type: "string", description: "grep command + hit count + sync action proving the fix is complete" },
          affected_files: { type: "array", items: { type: "string" }, description: "Files touched by this fix + files checked/synced as reference points" },
        },
        // m3: issue_id 是 ES3 交叉校验（must-fix 必须全进 fixes[]）的匹配键，必填
        required: ["issue_id"],
      },
    },
    deferred: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issue_id: { type: "string" },
          severity: { type: "string", description: "Must be minor — critical/major must not be deferred" },
          reason: { type: "string", description: "Concrete cost description: which files/mechanisms involved, why high cost, suggested follow-up" },
        },
      },
    },
  },
  required: ["fixed_count"],
};

// ── Per-run isolation: runId-scoped directories ─────────────────────

const fs = require("fs");
const path = require("path");
const os = require("os");

const RUN_ID = ($ARGS._runId && typeof $ARGS._runId === "string") ? $ARGS._runId : "run-" + Date.now();
// rfl 仪表（tier-1 §6.8/§7.5）：state 持久化迁出 $TMPDIR（系统清理即丢失）——
// ~/.review-fix-loop/<repo-slug>/<runId>/；$TMPDIR 仅作 home 不可写时的降级。
// 旧 $TMPDIR run 不迁移（易失数据不抢救），loadState 只从新位置读。
const { root: RUN_ROOT, degraded: RUN_ROOT_DEGRADED } = resolveRunRoot({ runId: RUN_ID, cwd: process.cwd() });
if (RUN_ROOT_DEGRADED) {
  log("WARN: ~/.review-fix-loop not writable, falling back to $TMPDIR: " + RUN_ROOT);
}
const STATE_FILE = RUN_ROOT + "/state.json";

log("Run directory: " + RUN_ROOT);

// ── Startup fail-fast: validate agent ref paths exist (ADR-0003 D6) ─
// 启动期校验所有 batchN/fixAgent 路径存在，不存在立即报错（带 location 恢复指引），
// 避免跑到 round 中段 agent-call 时 loadByPath 失败才暴露。FALLOW_DEF（isFallow，
// 无 path）跳过——它是内置工具标记非文件路径。
function validateAgentPaths(defs) {
  for (const def of defs) {
    if (def.isFallow || !def.path) continue;
    // MF-2：与 normalizeRef（src/shared/agent-ref.ts）对齐——~/ 前缀展开为 homedir 后再 statSync。
    // resolveAgentDefs 接受 ~/ 前缀、normalizeRef 运行时也展开，此处不展开会「先接受后拒绝」误报 ENOENT。
    const expanded = def.path.startsWith("~/")
      ? path.join(os.homedir(), def.path.slice(2))
      : def.path;
    try {
      fs.statSync(expanded);
    } catch {
      fail("Agent file not found: " + def.path + ". Check <available_subagents> <location> for valid agent refs (absolute .md path).");
    }
  }
}
const startupDefs = [];
for (const batch of BATCHES) {
  startupDefs.push(...resolveAgentDefs(batch));
}
if (FIX_DEF) startupDefs.push(FIX_DEF);
validateAgentPaths(startupDefs);

// ── State management (persistent, atomic writes) ────────────────────

// 全新初始 state 模板：catch 分支（无残留）与「读到残留 state」分支共用（A1）。
// 易变累积字段（calls/fixResults/fixCount/issues/dormant...）全部归零——
// attempt-2 重放会重新 recordCall/push，复用旧 state 必然双记。
function freshState() {
  return {
    meta: {
      runId: RUN_ID, workspace: $WORKSPACE || "", model: MODEL || "(default)",
      targetType, target, batches: BATCHES, startedAt: new Date().toISOString(),
    },
    agentStatus: {},
    fixCount: 0,
    batches: [],
    calls: [],
    dormant: [],
    fixResults: [],
    issues: undefined,
    knownRemaining: [],
    convergeStreak: 0,
    lastModifiedFiles: [],
    idMap: null,
    lastAggPath: "",
    lastAggRound: 0,
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    // A1（rebuild 双记修复）：读到既有 state = 同 _runId 上一 attempt 的残留——
    // engine 因 script-error rebuild 后同 RUN_ROOT 重跑本脚本，原样返回旧 state 会让
    // attempt-2 重放的 recordCall/fixResults/fixCount/issues 全部双记。state.json 在
    // RUN_ROOT（按 runId 隔离）内，存在即属本 run 前次 attempt，无跨 run 误判。
    // 只保留 previousAttempts 计数（观测 rebuild 次数），其余全部重置。
    const prev = (parsed && parsed.meta && parsed.meta.previousAttempts) || 0;
    log("INFO: found leftover state.json for this run (previous attempt residue after engine rebuild?) — resetting volatile accumulators (previousAttempts=" + (prev + 1) + ")");
    const s = freshState();
    s.meta.previousAttempts = prev + 1;
    return s;
  } catch {
    return freshState();
  }
}

// rfl 仪表：终止原因快照声明上移（saveState 引用；所有实际调用发生在
// 主循环初始化后，TDZ 不触发）。CLI list/stats 的终止原因数据源。
let terminated = "clean";

function saveState(state) {
  // rfl 仪表：terminated 随每次落盘快照（结构化终止路径设值后即 saveState）
  if (state.meta) state.meta.terminated = terminated;
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ── rfl 仪表（tier-1 §7.3）：calls[] 采集 + phaseTimings ───────────
// 每次 agent() 调用记录资源与耗时；数据源 = returnMeta 透传的 usage/durationMs/
// sessionId（引擎 T1 透传；旧引擎缺字段时 usage 键省略（undefined）、durationMs
// 落 null——phase 级耗时由 phaseTimings 覆盖）。
function recordCall(entry) {
  if (!Array.isArray(state.calls)) state.calls = [];
  state.calls.push(entry);
}
function normUsage(meta) {
  const u = meta && typeof meta === "object" ? meta.usage : undefined;
  if (!u || typeof u !== "object") return undefined;
  return {
    input: u.input ?? 0, output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cost: u.cost ?? 0,
  };
}
// A10：引擎 T1 透传缺位（returnMeta 在但 usage 缺失 / durationMs 非数）只 WARN 一次
//（逐调用都打会淹没日志）——提示引擎版本或透传链路问题，calls[] usage 已降级。
let warnedTelemetryMissing = false;
function warnTelemetryMissingOnce() {
  if (warnedTelemetryMissing) return;
  warnedTelemetryMissing = true;
  log("WARN: returnMeta usage/durationMs missing — engine telemetry passthrough (T1) not active? calls[] usage degraded");
}
// returnMeta 对象 → calls[] 条目（十字段，设计 §7.3）。
// A11（model 字段语义）：model = 请求时参数。agent-ref 调用的实际模型由主线程按
// .md frontmatter 解析（resolveAgentOpts），此处可能记 "(default)" 而实际跑 frontmatter
// 模型——引擎侧透传实际 model 是后续工作，消费侧（§6.4 降档归因）需知此局限。
// A12（promptMode 语义）：该字段 = review prompt 模式（"full" | "scoped"），对非
// reviewer 角色（aggregator/fixer）无意义、显式传 null；仅缺省（undefined）回退
// "full"——空串/null 不再被 || 误转 "full"。
function buildCallRecord({ batch, round, role, name, model, prompt, promptMode, meta }) {
  const promptStr = typeof prompt === "string" ? prompt : "";
  const metaObj = meta && typeof meta === "object" ? meta : undefined;
  // W1：失败调用（returnMeta = {value, error}）天然无 usage/durationMs——排除
  // error 分支，否则 agent 调用失败被误诊为「引擎透传未上线」并烧掉 once 名额。
  // 三个 recordCall 调用点（review/aggregator/fixer）共用本函数，一处修复全覆盖。
  if (metaObj && !metaObj.error && (normUsage(metaObj) === undefined || typeof metaObj.durationMs !== "number")) {
    warnTelemetryMissingOnce();
  }
  return {
    batch, round, role, name: name || role,
    model: model || "(default)",
    durationMs: (metaObj && typeof metaObj.durationMs === "number")
      ? metaObj.durationMs
      : null,
    usage: normUsage(metaObj),
    promptMode: promptMode === undefined ? "full" : promptMode,
    promptBytes: Buffer.byteLength(promptStr, "utf8"),
    sessionId: (metaObj && typeof metaObj.sessionId === "string") ? metaObj.sessionId : undefined,
  };
}

// clean 记录（recordAgentClean/recordAgentDirty 与跨批跳过判定 shouldSkipAgent
// 在 review-fix-loop-utils.cjs，vitest 单测见 src/__tests__/review-fix-loop-utils.test.ts）

// A8（guidance/evidence 缺失观测）：活跃条目缺 guidance/evidence 的单行 WARN——
// 数据链断点（aggregator 未提取 / 归一化丢失）的可观测信号；fixer 免侦查降级提示。
// 仅 N+M>0 时打，不逐条刷屏。
function warnMissingFields(mustFixIds) {
  const miss = countMissingFields(mustFixIds);
  if (miss.missingGuidance > 0 || miss.missingEvidence > 0) {
    log("WARN: " + miss.missingGuidance + " active must-fix entries lack guidance (" + miss.missingEvidence + " lack evidence) — fixer self-investigation expected");
  }
}

// ── Agent defs（loadAgentMd/resolveAgentDefs 在 review-fix-loop-utils.cjs） ──

// ── Build review calls ──────────────────────────────────────────────

// 上一轮 fix 的 modifiedFiles（git diff 实测，fix 阶段写入 batchRounds）。
// recheck 限定 prompt（scoped）的 scope 来源（初版 = modifiedFiles）。
function lastModifiedFiles() {
  // M4: 批内轮次循环中 state.batches 尚未 push（仅在终止/批结束 push）——scoped 分支
  // （recheckAfterFix=true 的下轮 review）执行时读不到本批数据。fix 阶段把
  // modifiedFiles 同步写入 state.lastModifiedFiles（即时字段，批内立即可用），
  // 此处优先读它；fallback 旧路径（跨批场景）。
  if (state.lastModifiedFiles && Array.isArray(state.lastModifiedFiles)) {
    return state.lastModifiedFiles;
  }
  const b = state.batches[state.batches.length - 1];
  const r = b && b.rounds && b.rounds[b.rounds.length - 1];
  return (r && Array.isArray(r.modifiedFiles)) ? r.modifiedFiles : [];
}

// buildReviewCall 分支构造：fallow 内置工具型（无 .md，静态分析 prompt）。
function buildFallowReviewCall(base, def, header, roundDir) {
  return {
    ...base,
    prompt: [
      header,
      "",
      "Fallow static-analysis pre-scan (tool-based, NOT a git-diff review).",
      "",
      "Steps:",
      "1. Check if fallow is installed: `which fallow`",
      "2. If NOT installed: write the report with a one-line note, must_fix=0, suggestion=0.",
      "3. If installed, run: `fallow audit --base " + lockedBase.base + " --format json --quiet`",
      "4. Extract: complexity hotspots, dead code, unused exports, circular deps",
      "5. Classify findings: critical/major count into must_fix; minor into suggestion.",
      "",
      "output 路径：" + roundDir + "/" + def.report + ".md",
      "Write report to: " + roundDir + "/" + def.report + ".md",
    ].join("\n"),
  };
}

// buildReviewCall 分支构造：R2+ 三段式（5.2）——verify-first 对账 + known-remaining + 收敛 hunt。
function buildR2ReviewCall(base, def, header, round, max, roundDir, batchIndex) {
  const prevRoundDir = RUN_ROOT + "/batch-" + batchIndex + "/round-" + (round - 1);
  // 对账段引用路径：优先最近一次实际产出的聚合报告（state.lastAggPath）——
  // all-clean 轮不聚合（round-1 目录无 aggregated.md），残留 continue 后需回溯到
  // 最近存在的报告，否则 reviewer 收到必败的 read 指令。
  const aggRef = (state.lastAggPath && round > 1) ? state.lastAggPath : prevRoundDir + "/aggregated.md";
  // 台账未结条目（假 clean 防护的信息通路）：open/regressed 条目显式注入 R2+ prompt，
  // 不依赖上轮 aggregated.md——漏报条目不在报告里，reviewer 无从对账，查台账守门
  // 就成了零调用的空转。条目带 title（B 链）/severity/evidence。
  const openLedgerIssues = Object.entries(state.issues || {})
    .filter(([, i]) => i.status === "open" || i.status === "regressed")
    .map(([id, i]) => ({ id, severity: i.severity, title: i.title, evidence: i.evidence }));
  return {
    ...base,
    // T9：无 per-round spread——reviewerSchema 跨轮统一（缓存前缀稳定前提）
    prompt: buildR2ReviewPrompt({
      header, round, max, roundDir,
      reportFile: def.report,
      aggPath: aggRef,
      aggRound: aggRef === state.lastAggPath && state.lastAggRound ? state.lastAggRound : round - 1,
      fixResult: state.fixResults && state.fixResults.length
        ? state.fixResults[state.fixResults.length - 1]
        : null,
      fixRound: state.fixResults && state.fixResults.length
        ? state.fixResults[state.fixResults.length - 1].round
        : undefined,
      knownRemaining: (state.knownRemaining && Array.isArray(state.knownRemaining)) ? state.knownRemaining : [],
      // rfl dormant 复活通道（tier-1 6.3 delta ③）：降级条目注入 R2+ prompt（动态段内容）
      dormant: (state.dormant && Array.isArray(state.dormant)) ? state.dormant : [],
      openIssues: openLedgerIssues,
      reviewPrompt, reviewInstruction,
    }),
    agent: def.path,
  };
}

// buildReviewCall 分支构造：recheck 限定（5.5）——clean agent 重派时只审 fix 改动
// 文件 + 自检关联点（scope = modifiedFiles ∪ affected_files，后者来自
// state.fixImpactFiles），不诱导全量重扫。
function buildScopedReviewCall(base, def, header, round, max, roundDir, batchIndex) {
  return {
    ...base,
    prompt: buildScopedRecheckPrompt({
      header, round, max, roundDir,
      reportFile: def.report,
      modifiedFiles: lastModifiedFiles(),
      affectedFiles: (state.fixImpactFiles && Array.isArray(state.fixImpactFiles)) ? state.fixImpactFiles : [],
      aggPath: RUN_ROOT + "/batch-" + batchIndex + "/round-" + (round - 1) + "/aggregated.md",
      aggRound: round - 1,
      fixResult: state.fixResults && state.fixResults.length
        ? state.fixResults[state.fixResults.length - 1]
        : null,
      fixRound: state.fixResults && state.fixResults.length
        ? state.fixResults[state.fixResults.length - 1].round
        : undefined,
      reviewPrompt, reviewInstruction,
    }),
    agent: def.path,
  };
}

function buildReviewCall(def, round, max, batchIndex, roundDir, scoped) {
  const header = "Batch " + batchIndex + " Round " + round + "/" + max + " — " + BATCH_NAMES[batchIndex - 1];
  const prevBatchesHint = batchIndex > 1
    ? "\nPrior batch reports (optional context): " + RUN_ROOT + "/batch-*/  (use read)"
    : "";
  const base = {
    model: MODEL,
    schema: reviewerSchema,
    description: def.name,
    timeoutMs: 3_600_000, // 1h（只读审查 + retry 退避余量）
    // returnMeta: true — 失败时 resolve
    // {value, error}，raw.error 可检测（结构化终止可达）；成功时
    // value = parsedOutput ?? content，parseResult 作用于 raw.value（MF-1）。
    returnMeta: true,
  };

  // S4：agentRef = 路径（非 fallow 的 def 必有 path）——systemPrompt/model 由主线程
  // resolveAgentOpts 按 path 加载注入，脚本不再拼 md 内容。
  if (def.isFallow) {
    return buildFallowReviewCall(base, def, header, roundDir);
  }

  // R2+ 三段式分支（5.2）：round>1 且非 scoped → verify-first 对账 + known-remaining + 收敛 hunt。
  // scoped 分支（recheck 限定）在下方单独处理（含对账段）。
  if (round > 1 && !scoped) {
    return buildR2ReviewCall(base, def, header, round, max, roundDir, batchIndex);
  }

  // recheck 限定分支（5.5）
  if (scoped) {
    return buildScopedReviewCall(base, def, header, round, max, roundDir, batchIndex);
  }

  // T9：R1 函数化（三模板共享静态段，动态后置）
  return {
    ...base,
    prompt: buildR1ReviewPrompt({
      header, roundDir, reportFile: def.report, prevBatchesHint,
      reviewPrompt, reviewInstruction,
    }),
    agent: def.path,
  };
}

// S4：agentRef = 路径，主线程按路径加载（systemPrompt 注入）；无名字查找，无需前缀兜底
async function runReviewAgent(call) {
  return agent(call);
}

// ── Main loop: batches (serial) × rounds (per-batch) ────────────────

const state = loadState();
// 5.6 锁定结果落 state.meta.baseHash（commit 1 声称与实现一致化，run 后可从 state.json 追溯审查基线）
state.meta = state.meta || {};
state.meta.baseHash = lockedBase.hash || "";
let totalFixed = 0;
let finalMessage = "";

for (let batchIndex = 1; batchIndex <= BATCHES.length; batchIndex++) {
  const defs = resolveAgentDefs(BATCHES[batchIndex - 1]);
  const cleanNames = new Set();
  let round = 0;
  let prevMustFix = -1;
  let stuckCount = 0;
  let batchClean = false;
  let roundHasFix = false; // recheckAfterFix 用：上轮是否有 fix
  const batchRounds = [];

  // MF-1 批级 review 状态隔离：每批开始重置 issue 追踪 / 收敛计数 / known-remaining，
  // 防止跨批 newFindings 语义污染（firstSeen 用批内 round 号写入、convergeStreak 跨批
  // 累加会让前批收敛状态泄漏到后批，复合导致 converged 错误跳过后续批次）。
  state.issues = undefined;
  state.convergeStreak = 0;
  state.knownRemaining = [];
  // A2（dormant 跨批污染修复）：aggregator id 空间每批从 MF-1 重新编号，批 1 降级的
  // dormant MF-3 会与批 2 活跃 MF-3 冲突——filterDormantFromRecon 把它从 reconSeen
  // 剥离后，批 2 的 fix-attempted 被误反转 fixed；且批 1 dormant 持续注入批 2+ prompt。
  // dormant 必须与 issues 同点做批作用域重置。
  state.dormant = [];
  // 身份翻译层（编号+标题三级对齐）：idMap = 最近一次聚合的 {表格号→台账键}，
  // lastAggPath = 最近一次聚合报告路径（all-clean 轮 continue 后 round-1 无聚合，
  // 对账段引用需回溯到最近存在的报告）。批作用域重置防跨批残留。
  state.idMap = null;
  state.lastAggPath = "";
  state.lastAggRound = 0;

  // 跨批跳过：agent 在更早批 clean 且此后无 fix → 本批不派发
  if (batchIndex > 1) {
    for (const def of defs) {
      const s = state.agentStatus[def.name];
      if (shouldSkipAgent(s, state.fixCount, batchIndex)) {
        cleanNames.add(def.name);
        log("Cross-batch skip: " + def.name + " (clean in batch " + s.lastCleanBatch + ", no fix since)");
      }
    }
  }

  while (round < maxRounds) {
    round++;
    log("--- Batch " + batchIndex + "/" + BATCHES.length + " (" + BATCH_NAMES[batchIndex - 1] + ") Round " + round + "/" + maxRounds + " ---");

    phase("Review");
    const roundDir = RUN_ROOT + "/batch-" + batchIndex + "/round-" + round;
    fs.mkdirSync(roundDir, { recursive: true });

    let active = defs.filter((def) => !(skipCleanAgents && cleanNames.has(def.name)));
    let scopedClean = new Set(); // recheckAfterFix 重派时：上一轮 clean 的 agent 本轮走限定 prompt
    if (recheckAfterFix && round > 1 && roundHasFix) {
      scopedClean = new Set(cleanNames); // 重派前快照上一轮 clean 集合
      active = defs; // fix 后重派全批（强回归模式）
      cleanNames.clear();
    }

    if (active.length === 0) {
      // 台账守门（第四收工点）：全员 clean/skip 但台账有 open/regressed 残留时不得
      // 收工——全员已进 cleanNames、无人可派，注入的台账清单会没有消费方。清空批内
      // clean 名单强制全体重派追账（跨批 skip 状态 state.agentStatus 不动，重派后再
      // clean 会幂等刷新）。reviewer 对注入条目申报 fixed → 清账正常收工；申报
      // not-fixed → openStreak 增长走 stuck 诚实终止；无视 → maxRounds 兜底。
      if (hasOpenResidue(state.issues)) {
        log("All agents clean/skipped but ledger has unresolved issue(s) — re-dispatching all agents to reconcile.");
        cleanNames.clear();
        scopedClean.clear();
        active = defs;
      } else {
        log("All agents clean/skipped — batch " + batchIndex + " done.");
        batchClean = true;
        break;
      }
    }

    log("Review: " + active.map((d) => d.name).join(", ") + " (" + active.length + " agent(s) in parallel)...");
    const calls = active.map((def) => buildReviewCall(def, round, maxRounds, batchIndex, roundDir, scopedClean.has(def.name)));
    const phaseTimings = { review: null, aggregate: null, fix: null };
    const reviewT0 = Date.now();
    const allRaw = await parallel(calls.map(runReviewAgent));
    phaseTimings.review = [reviewT0, Date.now()];
    // rfl 仪表：本轮全部 reviewer 调用落 calls[]（allRaw 与 calls 一一对应，parallel 语义）
    for (let i = 0; i < allRaw.length; i++) {
      recordCall(buildCallRecord({
        batch: batchIndex, round, role: "reviewer",
        name: active[i].name, model: calls[i].model,
        prompt: calls[i].prompt,
        promptMode: scopedClean.has(active[i].name) ? "scoped" : "full",
        meta: allRaw[i],
      }));
    }

    // per-agent 结果区分：parallel 结果与 calls 一一对应
    const reviewResults = [];
    const agentRoundResults = [];
    const reconSeen = new Set(); // R2+ reconciliation 声明的上轮 ID（status !== fixed）——stuck ID 驱动数据源（5.1）
    const reconEscalate = new Set(); // 5.1-5 escalate 声明：deferred 条目上下文改变 → 重新 open
    const reconFixed = new Set(); // reconciliation 声明 fixed 且 evidence 非空（verify-first 申报）——open/regressed 条目的清账通道（不再丢弃）
    const reconAll = new Set(); // M2: 所有 status 条目（含 fixed）的 prev_id 去重——reconcile 门控数据源
    for (let i = 0; i < allRaw.length; i++) {
      const raw = allRaw[i];
      if (raw && typeof raw === "object" && raw.error) {
        // 审查 agent 调用失败（含 AgentRegistry not found / 超时）。不裸 throw——与
        // aggregator-failure/stuck/fix-failure 路径一致：saveState + terminated 结构化终止，
        // 保证 state.json 有记录、调用方拿到结构化结果而非裸异常（MF-3）。
        // W8：失败轮的当前轮条目也落 batchRounds（该轮 phase 时长不因结构化终止
        // 从时间线消失）；F3：聚合未发生/失败，mustFix/suggestion 是未知而非 0——
        // 落 0 会被时间线误读为 clean 轮（rfl.mjs 消费侧 `mustFix ?? "-"` 对 null
        // 显示 "-"，suggestion 无消费点，null 安全）；agents 为已收集的部分结果，
        // aggregate/fix 相位 null 是如实采集（未到达）。
        batchRounds.push({ round, mustFix: null, suggestion: null, agents: agentRoundResults, modifiedFiles: [], phaseTimings });
        state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
        saveState(state);
        terminated = "review-failure";
        finalMessage = "Batch " + batchIndex + " round " + round + ": 审查 agent 调用失败 " + active[i].name + " — " + raw.error;
        batchIndex = BATCHES.length + 1; // 终止外层循环
        break;
      }
      const parsed = normalizeReviewResult(raw.value);
      if (parsed) {
        // 5.8 通用落盘：schema-only agent（report_content 无 report_file，如 doc-reviewer）→
        // workflow 写盘到 <roundDir>/<def.report>.md 并填入 report_file（aggregator 读取路径不变）。
        const reportPath = resolveReviewReportPath(parsed, roundDir, active[i].report);
        if (reportPath && !(parsed.report_file && parsed.report_file.trim())) {
          try {
            fs.writeFileSync(reportPath, parsed.report_content || "", "utf-8");
            parsed.report_file = reportPath;
          } catch (e) {
            log("WARN: failed to write report_content to " + reportPath + " — " + e.message);
          }
        }
        // W6：report_content 已落盘（上方 resolveReviewReportPath 写盘 + report_file
        // 回填），aggregator prompt 指示其 read report_file——整份正文再随 reviewResults
        // JSON 内嵌即同一内容双份付费（实测 ~48% 重复）。push 前剥离；下游
        // （buildAggregatorPrompt 路径清单 / must_fix 计数 / all-clean 判定）只消费
        // report_file 与计数字段，无 report_content 消费。
        const parsedWithoutContent = { ...parsed };
        delete parsedWithoutContent.report_content;
        reviewResults.push(parsedWithoutContent);
        for (const r of parsed.reconciliation) {
          if (r.status === "escalate") reconEscalate.add(r.prev_id);
          else if (r.status !== "fixed") reconSeen.add(r.prev_id);
          else if (typeof r.evidence === "string" && r.evidence.trim()) reconFixed.add(r.prev_id); // 空 evidence 的口头断言不采信（reviewer 吹牛防护，与 fix-attempted 的 verify 语义对齐）
          else log("reconciliation fixed-claim without evidence ignored: " + r.prev_id); // 保守丢弃可见化（S-1）
          reconAll.add(r.prev_id); // M2: 含 fixed——全 fixed 时 reconSeen 空但 reconcile 仍需执行
        }
        const def = active[i];
        // 修复范围全等级后，agent clean = must-fix 与 suggestion 全 0（skipCleanAgents 授予变严：
        // 只剩 suggestion 的 agent 继续参与轮次直到修完，避免「must-fix 清零即跳」漏修 suggestion）
        const agentAllClean = parsed.must_fix === 0 && (parsed.suggestion ?? 0) === 0;
        if (agentAllClean) {
          recordAgentClean(state, def.name, batchIndex);
          cleanNames.add(def.name);
        } else {
          recordAgentDirty(state, def.name, parsed.must_fix, batchIndex);
        }
        agentRoundResults.push({ name: def.name, must_fix: parsed.must_fix, suggestion: parsed.suggestion ?? 0, clean: agentAllClean });
      } else {
        // tools 受限的 agent（如 tools: read）会过滤掉 structured-output → schema 失效，
        // 结果缺 must_fix。结构化终止（MF-3），raw 完整 dump 便于定位。
        // W8：同 review-failure——当前轮条目落 batchRounds（phase 时长保留在时间线）；
        // F3：聚合未发生，mustFix/suggestion 未知非 0（null，消费侧 ?? "-" 兜底）。
        batchRounds.push({ round, mustFix: null, suggestion: null, agents: agentRoundResults, modifiedFiles: [], phaseTimings });
        state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
        saveState(state);
        terminated = "review-failure";
        finalMessage = "Batch " + batchIndex + " round " + round + ": 审查 agent 结果无效（缺 must_fix） " + active[i].name + " raw=" + JSON.stringify(raw.value).slice(0, 400);
        batchIndex = BATCHES.length + 1; // 终止外层循环
        break;
      }
    }

    if (terminated === "review-failure") break; // 已结构化终止，退出 round 循环（MF-3）

    // 全等级终止：任何等级（含 suggestion）未清零都不算 clean——否则建议级问题会在
    // must-fix 清零的出口被静默漏修（与「must-fix 只是终止条件、不是修复范围」的语义对齐）
    if (reviewResults.every((r) => r.must_fix === 0 && (r.suggestion ?? 0) === 0)) {
      log("Batch " + batchIndex + " round " + round + ": all agents clean.");
      // rfl clean 轮黑洞修复（tier-1 6.6 v5，T7）：all-clean 现状在聚合/reconcile 前
      // break——末轮 fix 的对账与回归回填永不发生，eval 数据在最 canonical 的成功
      // 路径上失真。break 前用本轮已解析的 reconciliation 数据做确定性回填（不调
      // LLM）：fix-attempted 未再现 → fixed + open/regressed 申报 fixed（带 evidence）
      // → fixed + 上轮 fix 的 regression 维度回填。stuck 一并消费（不再丢弃）。
      let cleanStuck = { stuck: false, stuckIds: [] };
      if (round > 1) {
        const backfill = applyCleanRoundBackfill(state, {
          reconSeen, reconEscalate, reconFixed, round, stuckThreshold, batch: batchIndex,
        });
        cleanStuck = { stuck: backfill.stuck, stuckIds: backfill.stuckIds };
        log("Clean-round backfill applied (reconcile + regression backfill for the previous fix).");
      }
      if (cleanStuck.stuck) {
        batchRounds.push({ round, mustFix: 0, suggestion: reviewResults.reduce((a, r) => a + (r.suggestion ?? 0), 0), agents: agentRoundResults, modifiedFiles: [], phaseTimings });
        state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
        saveState(state);
        terminated = "stuck";
        finalMessage = "Batch " + batchIndex + " round " + round + ": 全员 clean 但台账问题 " + cleanStuck.stuckIds.join(", ")
          + " 连续 " + stuckThreshold + " 轮未收敛（clean 轮对账判定）。残留: "
          + (state.knownRemaining && state.knownRemaining.length ? state.knownRemaining.join("; ") : "无 deferred");
        batchIndex = BATCHES.length + 1;
        break;
      }
      // 台账守门（backfill 清账后再查——先消费本轮 fixed 申报，避免已清零的残留
      // 触发空转一轮）：仍有 open/regressed 残留时不收工——本轮全员报 0 只是观测，
      // 不蕴涵台账已清。清空批内 clean 名单重派追账（注入段给 reviewer 台账清单），
      // 下轮申报 fixed → 清账收工 / not-fixed → openStreak 增长 / 无视 → maxRounds 兜底。
      if (hasOpenResidue(state.issues)) {
        const residueIds = Object.entries(state.issues)
          .filter(([, i]) => i.status === "open" || i.status === "regressed")
          .map(([id]) => id).join(", ");
        log("All agents reported clean but ledger has unresolved issue(s): " + residueIds + " — continuing to reconcile.");
        batchRounds.push({ round, mustFix: 0, suggestion: reviewResults.reduce((a, r) => a + (r.suggestion ?? 0), 0), agents: agentRoundResults, modifiedFiles: [], phaseTimings });
        saveState(state);
        cleanNames.clear();
        continue;
      }
      batchRounds.push({ round, mustFix: 0, suggestion: reviewResults.reduce((a, r) => a + (r.suggestion ?? 0), 0), agents: agentRoundResults, modifiedFiles: [], phaseTimings });
      saveState(state);
      batchClean = true;
      break;
    }

    // ── Aggregate（内置 prompt，不依赖任何 agent.md） ─────────
    // rfl T7/T8：prevFixResult 作打分材料（R2+ 聚合给上轮 fix 打 LLM 三维度分）；
    // model 用 AGG_MODEL（可降档参数，缺省 = 主模型，行为与现状一致）。
    const aggT0 = Date.now();
    const aggPrompt = buildAggregatorPrompt({
      header: "Batch " + batchIndex + "/" + BATCHES.length + " Round " + round + "/" + maxRounds + " — AGGREGATE REVIEWS",
      round, max: maxRounds, roundDir,
      reviewResults,
      prevFixResult: round > 1 && state.fixResults && state.fixResults.length
        ? state.fixResults[state.fixResults.length - 1]
        : null,
      // S-5：上一轮标题注入——「keep the title close to the previous wording」此前无
      // 材料可依。取台账（issues + dormant）条目的 id: title 清单。
      // R3 S-1：清单截尾（最近 50 条）——长循环台账单调膨胀只造成 prompt token 膨胀。
      prevTitles: round > 1
        ? [
            ...Object.entries(state.issues || {}).map(([id, i]) => (i && typeof i.title === "string" && i.title ? id + ": " + i.title : null)),
            ...((state.dormant || []) || []).map((d) => (d && typeof d.title === "string" && d.title ? d.id + ": " + d.title : null)),
          ].filter(Boolean).slice(-50)
        : [],
    });
    let aggRaw = await agent({
      prompt: aggPrompt,
      model: AGG_MODEL,
      schema: aggregatorSchema,
      description: "aggregate",
      timeoutMs: 3_600_000, // 1h
      returnMeta: true,
    });
    phaseTimings.aggregate = [aggT0, Date.now()];
    recordCall(buildCallRecord({
      batch: batchIndex, round, role: "aggregator", name: "aggregate",
      model: AGG_MODEL, prompt: aggPrompt, promptMode: null, meta: aggRaw,
    }));

    // returnMeta 下 aggRaw = {value, error}；失败时 value 为空串、error 在 finalMessage 透出（MF-1）
    let aggValue = aggRaw?.value ?? aggRaw;
    let agg = normalizeAggregatorResult(aggValue);

    if (!agg || typeof agg.must_fix !== "number") {
      // 重试先于 md 兜底（C 修复）：聚合失败最常见形态 = md 报告已写好 + JSON 尾部
      // 格式漂移——此时 md 兜底「成功」但降级为 numeric-only（丢 must_fix_ids 整条
      // 数据链：merge 跳过 / fixed 重报转 regressed 链断 / dormant 不落 / W5 门控
      // 退化），代价高于一次重试调用。先原 prompt 重试争取完整恢复。
      log("Aggregator JSON invalid (len=" + (typeof aggValue === "string" ? aggValue.length : 0) + ") — retrying once with the same prompt.");
      aggRaw = await agent({
        prompt: aggPrompt,
        model: AGG_MODEL,
        schema: aggregatorSchema,
        description: "aggregate",
        timeoutMs: 1_200_000, // 20min：确定性失败（context overflow 等）不该在 md 兜底前再烧 1h（S-4）
        returnMeta: true,
      });
      recordCall(buildCallRecord({
        batch: batchIndex, round, role: "aggregator", name: "aggregate",
        model: AGG_MODEL, prompt: aggPrompt, promptMode: null, meta: aggRaw,
      }));
      aggValue = aggRaw?.value ?? aggRaw;
      agg = normalizeAggregatorResult(aggValue);
    }

    if (!agg || typeof agg.must_fix !== "number") {
      const rawPreview = (aggValue === undefined ? "undefined" : typeof aggValue === "string" ? aggValue : JSON.stringify(aggValue)).slice(0, 200);
      log("Aggregator retry failed (len=" + (typeof aggValue === "string" ? aggValue.length : 0) + "): " + rawPreview);
      const fallbackPath = (agg && agg.report_file) || (roundDir + "/aggregated.md");
      try {
        const content = fs.readFileSync(fallbackPath, "utf-8");
        const parsed = parseAggregatedMd(content);
        if (parsed && typeof parsed.must_fix === "number") {
          agg = { report_file: fallbackPath, must_fix: parsed.must_fix, suggestion: parsed.suggestion ?? 0 };
          log("Fallback parsed from " + fallbackPath + ": must_fix=" + agg.must_fix);
        }
      } catch { /* fallback read failed */ }

      if (!agg || typeof agg.must_fix !== "number") {
        log("Aggregator failed and fallback failed, stopping.");
        // W8：aggregator-failure 轮的当前轮条目落 batchRounds——review/aggregate 相位
        // 时长已实测（fix 相位 null 如实采集）；F3：聚合失败，mustFix/suggestion 未知
        // 非 0（null，消费侧 ?? "-" 兜底，不误读为 clean 轮）。
        batchRounds.push({ round, mustFix: null, suggestion: null, agents: agentRoundResults, modifiedFiles: [], phaseTimings });
        state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
        saveState(state);
        terminated = "aggregator-failure";
        finalMessage = "Batch " + batchIndex + " round " + round + ": aggregator 失败且 fallback 解析失败"
          + (aggRaw && typeof aggRaw === "object" && aggRaw.error ? " — " + aggRaw.error : "");
        batchIndex = BATCHES.length + 1; // 终止外层循环
        break;
      }
    }

    const mustFix = agg.must_fix;
    const suggestion = agg.suggestion ?? 0;
    log("Aggregated: " + mustFix + " must-fix + " + suggestion + " suggestion(s).");
    // 最近一次聚合报告路径（含 numeric-only fallback）：all-clean 轮不聚合（round-1
    // 目录无 aggregated.md），残留 continue 后下轮对账段需回溯到最近存在的报告。
    state.lastAggPath = (typeof agg.report_file === "string" && agg.report_file.trim()) || (roundDir + "/aggregated.md");
    state.lastAggRound = round; // S-3：对账段标注报告轮号（与 fixResult 轮号可能不同轮）

    // rfl 打分落盘（tier-1 6.6，T7）：aggregator 顺手输出的弱信号 scores（reviewer
    // 分每轮 / fix LLM 三维度 R2+）。A6：逐条形状校验（landScores 纯函数）——畸形
    // （targetKind 缺失/round 非数/dimensions 非 object）不再静默落盘，计数进 WARN。
    // 打分失败不影响循环（权威层是状态机客观回填，见 reconcileIssues + backfillFixRegression）。
    {
      const landed0 = landScores(state.scores, Array.isArray(agg.scores) ? agg.scores : [], batchIndex);
      state.scores = landed0.scores;
      if (landed0.landed === 0) {
        log("WARN: aggregator scores unusable this round (landed=0, malformed=" + landed0.malformed + ") — quality scoring degraded");
      } else if (landed0.malformed > 0) {
        log("WARN: aggregator scores partially malformed (landed=" + landed0.landed + ", malformed=" + landed0.malformed + ") — malformed entries dropped");
      }
    }

    // 5.1：R1 的 aggregator must_fix_ids 初始化 state.issues（数字 ID 起点）
    // rfl 数据链（tier-1 6.1/6.3）：降级条目（adjudication downgraded/unverified）
    // 不建 issue——消费侧过滤（filterActiveIds），修复队列/ES3 校验只含活跃条目；
    // guidance/evidence 随条目落 issues（fixer 免侦查 + 裁决可追踪）。
    // 身份对齐（编号+标题三级）：R1 时 issues/dormant 均空（批开始重置），解析恒走
    // L3 直接沿用表格号——统一入口调用保持一致性（fallow 前置批等未来变化下防御）。
    // title 随条目落储（跨轮身份锚点 + 台账注入段展示原料）。
    if (round === 1 && agg.must_fix_ids && agg.must_fix_ids.length > 0) {
      if (!state.issues) state.issues = {};
      const activeIds = new Set(filterActiveIds(agg.must_fix_ids));
      const r1IdMap = {};
      for (const entry of agg.must_fix_ids) {
        const id = typeof entry === "string" ? entry : entry && entry.id;
        // Object.hasOwn：truthy 查表会让原型链键（"__proto__"/"toString"）误判已登记
        // 而 continue 跳过真实条目（与 utils findIssueKey 同款加固；id 来自 LLM 产出）。
        if (!id || Object.hasOwn(state.issues, id)) continue;
        if (!activeIds.has(id)) continue;
        const resolved = resolveIssueIdentity(
          typeof entry === "string" ? { id } : entry,
          { issues: state.issues, dormant: state.dormant || [] },
        );
        if (resolved.mapped) r1IdMap[id] = resolved.key;
        state.issues[resolved.key] = {
          // severity 结构化（5.7）：aggregator 标注 critical/major/minor，converged 终止的
          // 「无 critical」判定依赖它；旧格式（string）默认 major（must-fix 语义）。
          firstSeen: 1,
          severity: typeof entry === "string" ? "major" : (entry.severity || "major"),
          status: "open",
          history: [{ round: 1, status: "open" }], fixAttempts: 0,
          ...(entry && typeof entry === "object" && typeof entry.title === "string" && entry.title ? { title: entry.title } : {}),
          ...(entry && typeof entry.guidance === "string" && entry.guidance ? { guidance: entry.guidance } : {}),
          ...(entry && typeof entry.evidence === "string" && entry.evidence ? { evidence: entry.evidence } : {}),
        };
      }
      state.idMap = { round: 1, map: r1IdMap };
      // A8：R1 落盘后观测 guidance/evidence 缺失（数据链断点信号）
      warnMissingFields(agg.must_fix_ids);
    }

    // dormant exclude 基准：issues 键（R1 恒等即表格号）；R2+ merge 后并入翻译命中的活跃表格号
    const dormantExcludeIds = new Set(Object.keys(state.issues || {}));
    // rfl dormant（tier-1 6.3）：adjudication 降级条目落盘（含裁决理由），R2+ prompt
    // 注入复活通道——「降级即消失」的修复。每轮聚合后统一记录（同 id 幂等）。
    // 执行点在 merge 三级对齐之后（R2+ 路径）：excludeIds 需含「翻译后仍在台账活跃的
    // 表格号」——L2/L3 改键后，活跃条目的表格号 ≠ 台账键，仅用 issues 键做 exclude
    // 会把活跃追踪中的条目误落 dormant（exec-review 修复场景的改键形态复发）。
    function recordDormantThisRound() {
      if (!(agg.must_fix_ids && agg.must_fix_ids.length > 0)) return;
      const before = (state.dormant || []).length;
      state.dormant = recordDormant(state.dormant, agg.must_fix_ids, round, dormantExcludeIds);
      if (state.dormant.length > before) {
        log("Dormant recorded: " + (state.dormant.length - before) + " adjudication-downgraded issue(s) (total " + state.dormant.length + ")");
      }
    }

    // ── Stuck detection ─────────────────────────────────────
    // 5.1 ID 驱动：R2+ 用 reconciliation 声明的 seenIds + reconcileIssues（同一 ID 连续 N 轮
    // open/regressed）；无 reconciliation 数据（R1 或 reviewer 未填）降级计数式 updateStuckState
    // （现状语义，MF-2 注释保留）。needs-redesign（fixAttempts>=2）在 wave 5 接入。
    // M2: reconCount = 所有 status 条目的 prev_id 去重计数（含 fixed）——全 fixed（最常见
    // 收敛路径）时 reconSeen 为空，但 reconciliation 有数据仍须调 reconcileIssues：
    // fix-attempted → fixed 的唯一转换点（否则 fix-attempted 永不转 fixed）
    const reconCount = reconAll.size;
    // F1: 无对账数据（doc-reviewer-only 批 reconciliation 恒空）时，fix-attempted 条目
    // 存在仍须执行 reconcile——空 seenIds 语义 = 未被重新报告 = 已修复（5.1「未出现→fixed」）
    const hasFixAttempted = state.issues
      ? Object.values(state.issues).some((i) => i.status === "fix-attempted")
      : false;

    // 5.1-2 R2+ 新发现 ID 契约（M2 移出 reconcile 分支，独立执行；F1 扩展为
    // 「重新报告 = 未修复」转换）：aggregator 的 must_fix_ids 中
    //   a) 三级身份对齐（L1 编号+标题双命中沿用 / L2 标题归一唯一命中沿用旧键 /
    //      L3 避让分配）解析出台账键——不在 issues → 创建为新条目（firstSeen=round）
    //   b) 已存在且（fix-attempted 或 fixed）且本轮无对账数据（reconCount===0，
    //      doc-reviewer 场景）→ 重新报告 = 修复失败：转 regressed + fixAttempts+1 + openStreak+1
    //      （RC-7 needs-redesign 出口在无对账配置下可达；reconciliation 场景由
    //      reconcileIssues 处理，避免双计）。fixed 重报分支（MF-2）：已确认修复的问题
    //      再次被报告同样转 regressed——否则 fixed 停留 + 收敛终止组合会在默认配置下
    //      R3 即以 converged 提前终止而 must-fix 仍活跃。
    // newFindings 统计与 needs-redesign/fixAttempts 追踪对 R2+ 新发现生效。
    // rfl 数据链（tier-1 6.1/6.3）：新发现带 origin（computeOrigin：files 与上轮 fix
    // 触碰文件相交 = regression，否则 new；无 files 不可归因 WARN）；重新上报的
    // dormant 条目 → revived=true 回修复队列；本轮降级条目不建 issue（同 R1 过滤）。
    // 身份对齐（编号+标题）：LLM 编号跨轮不稳定（紧凑化重排会把新问题排到旧号上、
    // 同题重报会换号），表格号不再直接当台账主键——resolveIssueIdentity 三级对齐后
    // 改键条目记入 state.idMap（本轮表格号→台账键），fix 写入与下轮对账经 translateId
    // 翻译（ES3 的 mustFixIds↔fixes 集合比较保持表格号空间，不翻译）。
    // 对账翻译用「上一轮」idMap 快照（MF-1）：reviewer 的 prev_id 抄自上一轮
    // aggregated.md，须用产出该报告那轮的表格号空间翻译。必须在下方 merge 块
    // （会以本轮 roundIdMap 覆盖 state.idMap）之前快照；clean 轮 merge 不执行，
    // 快照自然携带最近一次聚合的 map。
    const prevIdMap = (state.idMap && state.idMap.map) || {};
    if (round > 1 && state.issues && agg.must_fix_ids && agg.must_fix_ids.length > 0) {
      let added = 0;
      const activeIds = new Set(filterActiveIds(agg.must_fix_ids));
      const roundIdMap = {};
      for (const entry of agg.must_fix_ids) {
        const id = typeof entry === "string" ? entry : entry && entry.id;
        if (!id) continue;
        // exec-review 修复（major-2a）：本轮降级条目（不在 activeIds）对新建与已追踪
        // 转换都不生效——已追踪条目被聚合降级重报 = 聚合撤回本轮判定，不翻 regressed
        //（对账通道 reconcileIssues 才是 fix-attempted → regressed 的权威转换点），
        // 也不落 dormant（在 issues 活跃追踪，recordDormant 的 excludeIds 排除）。
        if (!activeIds.has(id)) continue;
        // 三级身份对齐：resolved.key = 台账键（mapped=true 时 ≠ 表格号，记入 idMap）
        const resolved = resolveIssueIdentity(
          typeof entry === "string" ? { id } : entry,
          { issues: state.issues, dormant: state.dormant || [] },
        );
        if (resolved.mapped) roundIdMap[id] = resolved.key;
        const tracked = state.issues[resolved.key];
        if (tracked) {
          dormantExcludeIds.add(id); // 翻译后仍在台账活跃的表格号 → dormant exclude
          if (reconCount === 0 && (tracked.status === "fix-attempted" || tracked.status === "fixed")) {
            tracked.status = "regressed";
            tracked.fixAttempts = (tracked.fixAttempts || 0) + 1;
            tracked.openStreak = (tracked.openStreak || 0) + 1;
            tracked.severity = typeof entry === "string" ? "major" : (entry.severity || "major");
            tracked.history.push({ round, status: "regressed" });
            added++;
          }
          continue;
        }
        // 复活置位（6.3 delta ③ 的闭环另一半）：dormant 条目以活跃身份重新上报 →
        // 回修复队列（下方正常建 issue），后续轮 prompt 不再注入它。判定不需要独立
        // 的标题匹配——resolveIssueIdentity 的 L2 已按标题归一查过 dormant，标题命中
        // 时 resolved.key 即 dormant 条目的 id（编号或标题命中殊途同归）。
        const dormantHit = (state.dormant || []).find((d) => d.id === resolved.key && d.revived !== true);
        if (dormantHit) {
          dormantHit.revived = true;
          log("Dormant revived: " + resolved.key + " re-reported in round " + round);
        }
        const origin = computeOrigin(entry, {
          lastModifiedFiles: state.lastModifiedFiles || [],
          fixImpactFiles: state.fixImpactFiles || [],
        });
        if (!origin) log("WARN: issue " + resolved.key + " carries no files — origin not attributable");
        state.issues[resolved.key] = {
          firstSeen: round,
          severity: typeof entry === "string" ? "major" : (entry.severity || "major"),
          status: "open", openStreak: 1,
          history: [{ round, status: "open" }], fixAttempts: 0,
          ...(typeof entry === "object" && typeof entry.title === "string" && entry.title ? { title: entry.title } : {}),
          ...(origin ? { origin } : {}),
          ...(typeof entry === "object" && typeof entry.guidance === "string" && entry.guidance ? { guidance: entry.guidance } : {}),
          ...(typeof entry === "object" && typeof entry.evidence === "string" && entry.evidence ? { evidence: entry.evidence } : {}),
        };
        added++;
      }
      state.idMap = { round, map: roundIdMap };
      // A8：R2+ merge 落盘后观测 guidance/evidence 缺失（与 R1 init 同一观测口径）
      warnMissingFields(agg.must_fix_ids);
      if (added > 0) log("New findings tracked: " + added + " new or re-reported issue(s) in round " + round);
    }
    // dormant 落盘（merge 后：excludeIds 已并入翻译命中的活跃表格号）
    recordDormantThisRound();

    let stuck = { stuck: false };
    if (round > 1 && (reconCount > 0 || hasFixAttempted || reconFixed.size > 0)) {
      // 对账 id 翻译（表格号→台账键，台账键优先——注入段清单的 id 即台账键）：
      // L2/L3 改键后 reviewer 从 aggregated.md 抄的表格号需经 prevIdMap（上一轮
      // idMap 快照，MF-1）翻译才能
      // 命中台账。冲突互斥（not-fixed/escalate 优先于 fixed，保守方向）：多 reviewer
      // 并行对同一 prev_id 申报矛盾时，采信「未修好」侧——误转 fixed 会销账真问题，
      // 误留 open 只多跑一轮，可由下轮对账纠正。
      {
        translateReconSets(reconSeen, reconEscalate, reconFixed, prevIdMap, state.issues);
      }
      // 对账通道的 dormant 分区（exec-review major-1 修复）：reviewer 对 dormant id
      // 声明 not-fixed 不经此通道建 issue（复活唯一入口 = 聚合活跃重报）
      const reconFiltered = filterDormantFromRecon(reconSeen, reconEscalate, state.dormant);
      const rec = reconcileIssues(state.issues || {}, { seenIds: reconFiltered.seen, escalateIds: reconFiltered.escalate, fixedIds: reconFixed, round, stuckThreshold });
      state.issues = rec.issues;
      state.knownRemaining = rec.knownRemaining;
      stuck = { stuck: rec.stuck, stuckIds: rec.stuckIds };
      log("Reconcile: " + Object.keys(rec.issues).length + " tracked issue(s), known-remaining: " + rec.knownRemaining.length);
      // rfl regression 维度确定性回填（tier-1 6.6，T7）：reconcile 后 regressed 数已
      // 定，为上轮 fix 的 score entry 填 regression（无 entry 时创建确定性 entry）
      if (state.fixResults && state.fixResults.length > 0) {
        state.scores = backfillFixRegression({
          scores: state.scores, fixResult: state.fixResults[state.fixResults.length - 1],
          issues: state.issues || {}, round, batch: batchIndex, cleanRound: false,
        });
      }
    } else {
      // A9（regression 回填边缘缺口）：else 分支 = reconCount===0 且无 fix-attempted
      //（aggregator numeric-only fallback 等无对账数据场景）——上轮 fix 的 regressed
      // 数本轮不可判定，此前该场景的 regression entry 永缺。以 unverifiable 模式补
      // 确定性 entry（regression=null，不诚实造 10 分）。unverifiable 为终态（W3）：
      // 回填只匹配最近一次 fix 的 entry、永不重访旧轮，该轮 regression 维度永久
      // 缺失（CLI 显示 n/a），同轮后续回填经终态 guard 不覆盖。
      if (round > 1 && state.fixResults && state.fixResults.length > 0) {
        state.scores = backfillFixRegression({
          scores: state.scores, fixResult: state.fixResults[state.fixResults.length - 1],
          issues: state.issues || {}, round, batch: batchIndex, mode: "unverifiable",
        });
      }
      const s = updateStuckState(prevMustFix, stuckCount, mustFix, stuckThreshold);
      stuckCount = s.stuckCount;
      prevMustFix = s.prevMustFix;
      stuck = { stuck: s.stuck };
    }
    if (stuck.stuck) {
      const stuckIds = (stuck.stuckIds || []).join(", ");
      log("Stuck: issue(s) not converging for " + stuckThreshold + " rounds: " + stuckIds + ". Stopping.");
      batchRounds.push({ round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles: [], phaseTimings });
      state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
      saveState(state);
      terminated = "stuck";
      finalMessage = "Batch " + batchIndex + " round " + round + ": 问题 " + stuckIds + " 连续 " + stuckThreshold + " 轮未收敛。残留: "
        + (state.knownRemaining && state.knownRemaining.length ? state.knownRemaining.join("; ") : "无 deferred");
      batchIndex = BATCHES.length + 1;
      break;
    }

    // 5.7 needs-redesign（RC-7）：fixAttempts >= maxFixAttempts 且 regressed → 终止。
    // 顺序在 stuck 之后：stuck（一直在）信息更宏观，needs-redesign（修不好）更具体，先 stuck 后 redesign。
    if (round > 1 && state.issues) {
      const redesign = findNeedsRedesign(state.issues, maxFixAttempts);
      if (redesign.length > 0) {
        const ids = redesign.map((r) => r.issue_id).join(", ");
        // 5.7 message 三要素：ID + 修复历史摘要 + 残留清单（history 全文随 state.json 落盘）
        const historySummary = redesign.map((r) => {
          const hist = (r.history || []).map((h) => "R" + h.round + ":" + h.status).join(" -> ");
          return r.issue_id + " [" + (hist || "no history") + "]";
        }).join("; ");
        log("Needs redesign: " + ids + " not converging after " + maxFixAttempts + " fix attempts. Stopping.");
        batchRounds.push({ round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles: [], phaseTimings });
        state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
        saveState(state);
        terminated = "needs-redesign";
        finalMessage = "Batch " + batchIndex + " round " + round + ": 问题 " + historySummary + " 经 " + maxFixAttempts
          + " 次修复仍未收敛，属于需要重新设计而非继续补丁的结构性问题，请人工介入。残留: "
          + (state.knownRemaining && state.knownRemaining.length ? state.knownRemaining.join("; ") : "无 deferred");
        batchIndex = BATCHES.length + 1;
        break;
      }

      // 5.7 新发现率收敛：连续 convergeRounds 轮新发现 <= convergeNewIssues → converged
      const newIssues = Object.values(state.issues).filter((i) => i.firstSeen === round);
      const newFindings = newIssues.length;
      const newFindingsCritical = newIssues.filter((i) => i.severity === "critical").length;
      const conv = checkConvergence({
        prevStreak: state.convergeStreak || 0, newFindings, newFindingsCritical,
        convergeNewIssues, convergeRounds,
      });
      state.convergeStreak = conv.streak;
      // MF-2/S-21 收敛门槛：新发现率收敛 ≠ 问题已解决——必须同时满足「无 open/regressed
      // 活跃条目」才允许 converged 终止。fixed 条目复发（reconcile/merge 已转 regressed）
      // 后活跃条目存在 → 不收敛，继续修复循环（默认配置下 R3 复发不再提前终止）。
      // issues 无追踪（aggregator 缺 must_fix_ids）时回退 mustFix===0 数字级判定，
      // 避免 must_fix>0 照常收敛掩盖未处理问题（S-21）。
      const trackedCount = Object.keys(state.issues || {}).length;
      const activeIssues = Object.values(state.issues || {})
        .filter((i) => i.status === "open" || i.status === "regressed");
      const noActiveIssues = trackedCount === 0 ? mustFix === 0 : activeIssues.length === 0;
      if (conv.converged && noActiveIssues && suggestion === 0) {
        // MF-2 ④：converged 消息列出 open issue ID（对齐 max-rounds 的 remainingIds 逻辑）。
        // 门槛保证正常路径此处为空；状态漂移时调用方仍能看到残留而非「无 deferred」误报。
        const remainingIds = Object.entries(state.issues || {})
          .filter(([, i]) => i.status !== "fixed" && i.status !== "deferred")
          .map(([id]) => id);
        log("Converged: new findings <= " + convergeNewIssues + " for " + convergeRounds + " rounds. Batch " + batchIndex + " done, proceeding to next batch.");
        batchRounds.push({ round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles: [], phaseTimings });
        saveState(state);
        terminated = "converged";
        finalMessage = "Batch " + batchIndex + " round " + round + ": 新发现率收敛（连续 " + convergeRounds
          + " 轮新问题 ≤" + convergeNewIssues + "）。残留: "
          + (remainingIds.length ? remainingIds.join(", ") : "无")
          + (state.knownRemaining && state.knownRemaining.length ? "；deferred: " + state.knownRemaining.join("; ") : "");
        batchClean = true; // MF-1: 与 clean 一致，让外层 for 推进下一批（不跳过后续批次）
        break;
      }
    }

    // A4（全降级轮不驱动 fix，设计 §6.3 省轮次的兑现）：reviewer 原始计数有 must-fix
    // 但 aggregator 裁决后全部降级（mustFix===0 且活跃条目为 0）且 suggestion 也为 0 时，
    // all-clean break（reviewer 原始计数口径，见上方 every 判定）拦不住本路径——不守卫
    // 会空转派发 fixer（fixCount++ 且无问题可修）。suggestion>0 时不得在此 break
    //（修复范围全等级，建议级问题仍需走 fix 修复），fall through 到下方 fix 阶段。
    if (mustFix === 0
      && suggestion === 0
      && reviewResults.some((r) => r.must_fix > 0)
      && (agg.must_fix_ids ? filterActiveIds(agg.must_fix_ids).length : 0) === 0) {
      // 台账守门（第三收工点）：本轮聚合活跃条目为 0 不蕴涵台账已清——上轮 open
      // 条目本轮聚合漏报时残留仍在，此时收工 = 假 clean。有残留则跳过 fix（修复
      // 队列为空，派 fixer 只会对着全降级报告乱动）继续轮追账，且不授予 W5 跨批
      // clean 补记（本轮没真正干净，clean 补记会喂大下轮全员 skip → 注入段无消费方）。
      if (hasOpenResidue(state.issues)) {
        const residueIds = Object.entries(state.issues || {})
          .filter(([, i]) => i.status === "open" || i.status === "regressed")
          .map(([id]) => id).join(", ");
        log("All downgraded this round but ledger has unresolved issue(s): " + residueIds + " — skipping fix stage, continuing to reconcile.");
        batchRounds.push({ round, mustFix: 0, suggestion: reviewResults.reduce((a, r) => a + (r.suggestion ?? 0), 0), agents: agentRoundResults, modifiedFiles: [], phaseTimings });
        saveState(state);
        continue;
      }
      log("All reviewer must-fix entries adjudicated down this round — no active fix queue, skipping fix stage.");
      // F4：此处不需要 backfillFixRegression 调用（原死防御已删）。第 3 轮探针实证
      // 其恒为逐字节 no-op：能到达 A4 的 R2+ 轮（round>1 且 fixResults 非空），上方
      // stuck 检测的 if/else 两分支已在相同门控与相同匹配键（round-1/batch）下分别
      // 回填过——reconcile 路径（reconCount>0 或有 fix-attempted）mode=normal、无对账
      // 数据路径 mode=unverifiable——regression 键必已存在（number 或 null），W3 终态
      // guard（键存在即不再处理）使任何后续同键调用直接短路。round=1 时 A4 的调用
      // 门控本就不满足。保留调用会误导维护者以为此处承担回填职责。
      // W5：A4 场景 reviewer 原始 must_fix>0 走了 recordAgentDirty，但裁决后全部降级
      // = 无真实问题（语义等价 clean）——对 active 中本轮 must_fix>0 的 reviewer 补记
      // recordAgentClean（快照语义对齐常规调用点：lastCleanBatch + 当时 fixCount），
      // 让「裁决降级=噪声」也推进跨批 skip（否则同 agent 后续批每批全价重扫）。
      // 本轮无 fix（fixCount 不变），批后快照比较成立。
      // F2：agg.must_fix_ids 缺失（aggregator JSON 无效走 parseAggregatedMd numeric
      // fallback 的 agg 无此键）时无条目级裁决证据——「must_fix=0」只是 md 里的一行
      // 数字，不能证明 reviewer 的 must-fix 是被裁决降级的噪声。此时弱证据不授予
      // 跨批 clean-skip（否则「跳一轮」被 shouldSkipAgent 放大为「跳到底」且该 agent
      // 永不再重扫），留待后续批全价复核。
      for (const a of agentRoundResults) {
        if (agg.must_fix_ids && a.must_fix > 0) recordAgentClean(state, a.name, batchIndex);
      }
      batchRounds.push({ round, mustFix: 0, suggestion: reviewResults.reduce((a, r) => a + (r.suggestion ?? 0), 0), agents: agentRoundResults, modifiedFiles: [], phaseTimings });
      saveState(state);
      batchClean = true;
      break;
    }

    // ── Fix ─────────────────────────────────────────────────
    phase("Fix");
    let reportContent;
    try {
      reportContent = fs.readFileSync(agg.report_file, "utf-8");
    } catch {
      reportContent = "(could not read aggregated report)";
    }

    let prevHead = "";
    try {
      prevHead = require("child_process").execSync(
        "git rev-parse HEAD", { encoding: "utf-8", timeout: 10_000 }
      ).trim();
    } catch {
      // 非 git 项目（如纯文档目录）：prevHead 为空，跳过 modifiedFiles 统计
    }

    const commitInstr = autoCommit
      ? "- After all fixes, stage ONLY the files you modified: `git add <file1> <file2> ...` (explicit paths).\n" +
        "- NEVER use `git add -A` or `git add .` — the workspace may contain unrelated untracked files.\n" +
        "- Commit with message: `fix: review batch " + batchIndex + " round " + round + " — " + mustFix + " must-fix + " + suggestion + " suggestion`"
      : "- Do NOT commit. Leave the fixes in the working tree (autoCommit=false).";

    // A3（guidance 链最后一跳）：活跃条目中带非空 guidance 的清单——构造确定性通道
    // 传给 fixer（reportContent 正文之外，per-issue 直达）。W2：先 filterActiveIds 过滤
    //（与修复队列/ES3 校验同口径）——降级条目（adjudication downgraded/unverified）的
    // guidance 不再以 "MUST-FIX GUIDANCE" 标题混给 fixer（口径不一致会诱导修复已裁决
    // 噪声）。normalize 后条目均为对象；string 旧格式（经 fallback 等路径）无 guidance
    // 自然跳过；must_fix_ids 为 undefined（fallback 路径）时 activeGuidanceIds 为空集
    // → fixGuidance 仍为空清单。
    const activeGuidanceIds = new Set(filterActiveIds(agg.must_fix_ids || []));
    const fixGuidance = (agg.must_fix_ids || [])
      .filter((e) => e && typeof e === "object" && typeof e.guidance === "string" && e.guidance.trim()
        && activeGuidanceIds.has(e.id))
      .map((e) => ({ id: e.id, guidance: e.guidance }));

    const fixT0 = Date.now();
    const fixPromptBuilt = buildFixPrompt({
      header: "Fix round " + round + " (batch " + batchIndex + ")",
      reportContent,
      fixPrompt,
      commitInstr,
      caution: agg.fixes_caution && agg.fixes_caution.length ? agg.fixes_caution : [],
      guidance: fixGuidance,
    });
    const fxRaw = await agent({
      prompt: fixPromptBuilt,
      schema: fixSchema,
      // S4：fixAgent = agentRef 路径（主线程按路径加载 + frontmatter model 传播）；
      // 未传保持现状（通用 subagent + 内联 fixPrompt）。
      model: MODEL,
      description: (FIX_DEF && FIX_DEF.name) || "fix",
      // fix 不设 timeoutMs = 不限时（execute-options-mapper: undefined/<=0 → 不设超时）。
      // 带写操作（改项目代码）可能很久（大重构/多文件），不应被墙钟超时打断。
      returnMeta: true,
      ...(FIX_DEF && FIX_DEF.path ? { agent: FIX_DEF.path } : {}),
    });
    phaseTimings.fix = [fixT0, Date.now()];
    recordCall(buildCallRecord({
      batch: batchIndex, round, role: "fixer",
      name: (FIX_DEF && FIX_DEF.name) || "fix", model: MODEL, prompt: fixPromptBuilt, promptMode: null, meta: fxRaw,
    }));

    // returnMeta 下 fxRaw = {value, error}：先查 error（失败分支可达，MF-1），再对 value 做 parseResult
    if (fxRaw && typeof fxRaw === "object" && fxRaw.error) {
      // fix agent 调用失败（AgentRegistry not found / 超时等）。
      // 与 review 路径（raw.error → review-failure）对齐：结构化终止而非静默当成功——
      // 否则 fixed_count 缺失被 `?? mustFix` 回退，totalFixed 虚增且 must_fix 不降白跑轮次（MF-1）。
      log("Fix agent failed, stopping.");
      batchRounds.push({ round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles: [], phaseTimings });
      state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
      saveState(state);
      terminated = "fix-failure";
      finalMessage = "Batch " + batchIndex + " round " + round + ": fix agent 调用失败 — " + fxRaw.error;
      batchIndex = BATCHES.length + 1;
      break;
    }
    const fx = parseResult(fxRaw.value);
    const fixResult = fx ? normalizeFixResult(fx) : null;
    if (!fixResult) {
      log("Fix agent failed, stopping.");
      batchRounds.push({ round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles: [], phaseTimings });
      state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
      saveState(state);
      terminated = "fix-failure";
      finalMessage = "Batch " + batchIndex + " round " + round + ": fix agent 结果无效";
      batchIndex = BATCHES.length + 1;
      break;
    }

    // ES3 硬校验（5.3 红线，恢复 mustFixIds 交叉校验——wave 3 后 agg.must_fix_ids
    // 已是标准字段）：(1) deferred 只允许 minor；(2) must-fix 必须全进 fixes[]（漏修
    // 判 violation）。任一违规 → fix-failure（结构化终止）。trackedIssues 传入
    // state.issues——deferred severity 与追踪表交叉核对（MF-4）：must-fix 被标 minor
    // 塞进 deferred 的逃逸路径在追踪表面前失效（追踪 severity 为准）。
    // rfl（tier-1 6.3）：mustFixIds 传 filterActiveIds 结果——降级条目不占修复队列
    //（must_fix 计数由 aggregator 按非降级条目报，两侧口径一致）。
    // idMap（本轮表格号→台账键）只翻译 deferred 交叉核对的查表输入；mustFixIds 与
    // fixes[].issue_id 的集合比较双侧保持表格号空间（同源 aggregated.md，翻译即误杀）。
    const fixIdMap = (state.idMap && state.idMap.round === round && state.idMap.map) || {};
    const es3Violations = validateFixResult(fixResult, filterActiveIds(agg.must_fix_ids), state.issues, fixIdMap);
    if (es3Violations.length > 0) {
      // m7: violation 分两类——deferred 非 minor / must-fix 漏修（must-fix-not-fixed），
      // finalMessage 文案区分：统一文案会把漏修误报成 defer 违规，误导修复方向
      const parts = es3Violations.map((v) =>
        v.severity === "must-fix-not-fixed"
          ? "must-fix 未在 fixes[] 中修复（漏修）— " + v.issue_id
          : "deferred 含非 minor 条目（must-fix 不得 defer）— " + v.issue_id + "(" + v.severity + ")"
      );
      log("ES3 violation: " + JSON.stringify(es3Violations));
      batchRounds.push({ round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles: [], phaseTimings });
      state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
      saveState(state);
      terminated = "fix-failure";
      finalMessage = "Batch " + batchIndex + " round " + round + ": " + parts.join("; ");
      batchIndex = BATCHES.length + 1;
      break;
    }

    // ES2 软校验（5.3 证据标准）：defer 理由过短/无实质 → warning 日志（不终止）
    for (const d of fixResult.deferred) {
      const reason = typeof d.reason === "string" ? d.reason : "";
      if (reason.trim().length < 20) {
        log("WARN: deferred reason too short / no concrete cost description: " + JSON.stringify(d));
      }
    }

    // affected_files 并入 state.fixImpactFiles（5.3/5.5）：recheck scope = modifiedFiles ∪ fixImpactFiles
    const impactFiles = [];
    for (const f of fixResult.fixes) {
      if (Array.isArray(f.affected_files)) {
        for (const af of f.affected_files) {
          if (typeof af === "string" && af.trim() && !impactFiles.includes(af.trim())) impactFiles.push(af.trim());
        }
      }
    }
    state.fixImpactFiles = impactFiles;

    // m4: 先初始化容器——aggregator JSON 无效走 parseAggregatedMd 回退时 agg 无
    // must_fix_ids → R1 初始化跳过 → state.issues undefined；此处初始化保证 deferred
    // 写入与 knownRemaining 同步链路生效（否则 knownRemaining 恒空，deferred 跨轮继承整链失效）
    if (!state.issues) state.issues = {};
    // 5.1：fix 结果标记 fix-attempted（ID 对账驱动）+ fixResults 落库（R2+ prompt 输入）
    // 归一化查表（findIssueKey，与 ES3 同键空间）：fix agent ID 漂移（"mf-1"/
    // "MF-1 (fixed)"）不再丢匹配——精确键查表时 issue 停留 open，reconcile 无
    // fix-attempted 可转 fixed/regressed，needs-redesign 出口对该类 ID 静默失效。
    // 查表前先经 idMap 翻译（fixer 申报表格号，L2/L3 改键后需翻译到台账键；翻译
    // miss 回退原值走归一化兜底 = 现状行为）。
    for (const f of fixResult.fixes) {
      if (f && typeof f.issue_id === "string") {
        const trackedKey = findIssueKey(state.issues, translateId(fixIdMap, f.issue_id, state.issues));
        if (trackedKey) {
          state.issues[trackedKey].status = "fix-attempted";
          state.issues[trackedKey].history.push({ round, status: "fix-attempted" });
        }
      }
    }
    // 5.3-4 deferred 写入 state.issues（known-remaining 跨轮继承链路）：deferred 条目
    // 以 status=deferred 入 issues，据此生成 knownRemaining 传给 R2+ prompt。
    // ID 已存在（曾被修复/降级，含大小写/尾注漂移）→ 更新状态 + reason；
    // 不存在（S-x minor）→ 新建。漂移 ID 归一化匹配防止幽灵条目（原条目仍 open 阻塞收敛）。
    for (const d of fixResult.deferred) {
      if (!d || typeof d.issue_id !== "string" || !d.issue_id) continue;
      const reason = typeof d.reason === "string" ? d.reason : "";
      const trackedKey = findIssueKey(state.issues, translateId(fixIdMap, d.issue_id, state.issues));
      if (trackedKey) {
        state.issues[trackedKey].status = "deferred";
        state.issues[trackedKey].deferredReason = reason;
        state.issues[trackedKey].history.push({ round, status: "deferred" });
      } else {
        state.issues[d.issue_id] = {
          firstSeen: round, severity: "minor", status: "deferred",
          deferredReason: reason,
          history: [{ round, status: "deferred" }], fixAttempts: 0,
        };
      }
    }
    // known-remaining 同步更新：deferred 在本轮 fix 后即生效，R2+ prompt 立即消费
    // （不依赖下轮 reconcile 才生成——否则滞后一轮，reviewer 本轮看不到 deferred 清单）
    state.knownRemaining = computeKnownRemaining(state.issues);
    if (!state.fixResults) state.fixResults = [];
    state.fixResults.push({ ...fixResult, round }); // round 供对账段标注轮号（S-3）

    const fixedCount = fixResult.fixed_count ?? mustFix;
    totalFixed += fixedCount;
    state.fixCount++;
    roundHasFix = true;

    let modifiedFiles = [];
    if (prevHead) {
      try {
        const out = require("child_process").execSync(
          "git diff --name-only " + prevHead, { encoding: "utf-8", timeout: 10_000 }
        ).trim();
        modifiedFiles = out ? out.split("\n") : [];
      } catch { /* empty */ }
    }
    batchRounds.push({ round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles, phaseTimings });
    // M4: 批内即时字段——下轮 scoped 分支（recheckAfterFix=true）从
    // state.lastModifiedFiles 读本批 fix 的真实改动文件（git 实测兜底）
    state.lastModifiedFiles = modifiedFiles;
    saveState(state);

    log("Fixed " + fixedCount + " issue(s). Total: " + totalFixed + ". Modified " + modifiedFiles.length + " file(s). Continuing...");
  }

  if (batchIndex > BATCHES.length) break; // 已终止

  state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });

  terminated = resolveBatchTerminated(batchClean, terminated);
  if (terminated === "max-rounds") {
    // 该批达到 maxRounds 仍残留 must-fix → fail-fast，不进入后续批。
    // 5.9 残留清单：未 fixed 的 issues（status != fixed/deferred）+ known-remaining。
    const remainingIds = state.issues
      ? Object.entries(state.issues)
          .filter(([, i]) => i.status !== "fixed" && i.status !== "deferred")
          .map(([id]) => id)
      : [];
    finalMessage = "Batch " + batchIndex + " (" + BATCH_NAMES[batchIndex - 1] + ") 达到 maxRounds=" + maxRounds
      + " 仍有 must-fix，终止整个 workflow。残留: "
      + (remainingIds.length ? remainingIds.join(", ") : "(issues 未追踪)")
      + (state.knownRemaining && state.knownRemaining.length ? "；deferred: " + state.knownRemaining.join("; ") : "");
    log(finalMessage);
    saveState(state);
    batchIndex = BATCHES.length + 1;
    break;
  }
  saveState(state);
  log("=== Batch " + batchIndex + " (" + BATCH_NAMES[batchIndex - 1] + ") CLEAN ===");
}

log("\n=== Loop Complete ===");
saveState(state);

return {
  batches: BATCHES.length,
  totalFixed,
  terminated,
  targetType,
  target,
  runDir: RUN_ROOT,
  // 5.9 terminated 透出：非 clean 时 message 含终止原因 + 残留 ID 清单 + deferred 理由
  // （stuck/needs-redesign/converged/max-rounds/*-failure 均由 finalMessage 承载）。
  // 渲染层特判（launcher 对 terminated 非 clean 的视觉区分）留 TODO：当前 tool 结果
  // 已含完整 message，主 agent 可直接感知差异。
  // 5.9 视觉区分：非 clean 终止加 [UNRESOLVED] 前缀（tool 结果即主 agent 可见层，
  // launcher 透传 message——无需跨模块渲染特判，W5C3 决策更新）
  message: terminated === "clean"
    ? "All batches clean. " + totalFixed + " issue(s) fixed total. State: " + STATE_FILE
    : terminated === "converged"
      ? finalMessage + " " + totalFixed + " issue(s) fixed total. State: " + STATE_FILE
      : "[UNRESOLVED] " + finalMessage + ". State: " + STATE_FILE,
};
