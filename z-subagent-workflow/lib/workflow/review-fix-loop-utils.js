'use strict';
/**
 * review-fix-loop-utils — review-fix-loop v2 编排的可测纯函数模块（vendor 自 pi 仓）。
 *
 * 来源仓与文件：
 *   xyz-agent-workspace（dev-0.9.10）extensions/universal/subagent-workflow/
 *   workflows/review-fix-loop-utils.cjs
 * vendor 日期：2026-08-29
 * 用途：review-fix-loop v2（对齐 pi 质量内核）的编排纯函数层——对账状态机
 *   （reconcileIssues）、收敛/重设计/卡死判定（checkConvergence/findNeedsRedesign/
 *   updateStuckState）、fixer 契约归一与硬校验（normalizeFixResult/validateFixResult/
 *   findIssueKey）、dormant 落盘与消费侧过滤（recordDormant/filterActiveIds）、跨批
 *   skip 状态机（recordAgentClean/recordAgentDirty/shouldSkipAgent）、known-remaining
 *   生成（computeKnownRemaining）、防注入包裹（wrapUntrusted，设计 D10 三层防御第 1 层
 *   ——全部上游 LLM 产出嵌入下游 prompt 的唯一入口）。供 lib/workflow/review-fix-loop.js
 *   运行时 require 与 test/review-fix-loop-utils.test.js 共用；全部为纯函数，无 I/O。
 *
 * 与 pi 版的分叉点（12 个目标函数体逐字复制，含原注释；validateFixResult/
 * reconcileIssues 经质量门禁拆分，见分叉点 5）：
 * 1. 依赖闭包一并 vendor（不在 14 函数交付清单内，为保持模块内引用一致而带入）：
 *    parseResult（normalizeFixResult 的解析底座）、normIssueId（findIssueKey 的归一
 *    底座）、DORMANT_ADJUDICATIONS/toIdSet/dormantDetail（recordDormant/filterActiveIds
 *    的判定与辅助）。导出面与 pi 一致：parseResult/normIssueId 导出，其余保持私有。
 * 2. 剥离宿主耦合：14 个函数经逐个核对本就无 $ARGS/workerData/log/文件路径引用，
 *    无需改动；文件级剥离了依赖 fail 回调注入的参数解析函数（parseBatches 等，不在
 *    清单）与 require("path")（仅未 vendor 的 lockReviewBase/resolveRunRoot 使用）
 *    ——本模块零 require（验收条款：零外部依赖）。
 * 3. 新增 zsw 侧契约常量（pi 无此形态）：TERMINAL_STATUSES（设计 §3.4 终态枚举）、
 *    ISSUE_STATUSES（state.issues status 值域）、SEVERITIES/MUST_FIX_SEVERITIES/
 *    SEVERITY_RANK（severity 契约集合与排序权重）。
 * 4. 函数体与注释保持 pi 源原样（含双引号风格），最小化 vendor 分叉、便于上游 diff
 *    审计；模块壳（'use strict'/头注/导出）遵循 zsw 侧惯例。12 个函数仍逐字复制；
 *    validateFixResult/reconcileIssues 拆分后其字符串与注释仍逐字跟随移动（分叉点 5）。
 * 5. 质量门禁拆分（pr-cr-fix Gate-1 圈复杂度 ≤15，2026-08-29 授权）：validateFixResult/
 *    reconcileIssues 拆为壳函数 + 私有子函数，语义零变更（测试 100% 覆盖不变，字符串与
 *    注释逐字跟随）。上游同步时按 pi 源逻辑对齐子函数即可，或推动上游采用同款拆分
 *    恢复逐字对齐。
 */

// ── 5.10 防注入（设计 D10 对齐 pi 三层防御第 1 层）────────────────

/**
 * 5.10 三层防御第 1 层：上游 LLM 产出用不可信数据标签包裹，内容中闭合标签转义。
 * 所有嵌入 prompt 的上游产出唯一入口，禁止手写拼接（漏转义 = 标签逃逸 = 围栏失效）。
 */
function wrapUntrusted(content, tag) {
  return "<untrusted source=\"" + tag + "\">\n" +
    String(content).replace(/<\/untrusted>/gi, "&lt;/untrusted&gt;") +
    "\n</untrusted>";
}

// ── fixer 契约：结果解析与硬校验（设计 §3.4 fixer 契约，对齐 pi 5.3）──

/**
 * fix 结果兼容解析（5.3）：旧格式 fixes string[] / 新格式 object[]（issue_id/description/
 * self_check/affected_files）+ deferred 缺省 []。畸形输入（fixed_count 缺失/非对象）返回 null。
 */
function normalizeFixResult(raw) {
  const parsed = parseResult(raw);
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.fixed_count !== "number") return null;
  const fixes = Array.isArray(parsed.fixes) ? parsed.fixes : [];
  const normalized = fixes.map((f) =>
    typeof f === "string" ? { description: f }
      : (f && typeof f === "object" ? f : { description: String(f) })
  );
  const deferred = Array.isArray(parsed.deferred)
    ? parsed.deferred.filter((d) => d && typeof d === "object")
    : [];
  return { fixed_count: parsed.fixed_count, fixes: normalized, deferred };
}

/**
 * issue ID 归一化（ES3 校验与 fix 阶段对账共用键空间）：小写 + 剥尾部 "(...)" 尾注。
 * LLM 产出的 ID 漂移形态：大小写（"mf-1"/"MF-1"）、尾注（"MF-1 (fixed)"）。空串返回 ""。
 */
function normIssueId(s) {
  return String(s ?? "").toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/**
 * 在 issues 键空间中查找 issue_id 的归一化匹配键（不存在返回 undefined）。
 * fix 阶段（fix-attempted/deferred 标记）与 ES3 校验共用——精确键查表会把
 * "mf-1"/"MF-1 (fixed)" 等漂移 ID 判为未追踪，导致 fix-attempted → fixed/regressed
 * → needs-redesign 状态链静默失效；deferred 侧漂移则创建幽灵条目（原条目仍 open 阻塞收敛）。
 */
function findIssueKey(issues, issueId) {
  if (!issues || typeof issueId !== "string" || !issueId) return undefined;
  if (issues[issueId]) return issueId;
  const norm = normIssueId(issueId);
  if (!norm) return undefined;
  for (const key of Object.keys(issues)) {
    if (normIssueId(key) === norm) return key;
  }
  return undefined;
}

/**
 * ES3 硬校验（5.3-P1 红线）：(1) deferred 只允许 minor/trivial；(2) must-fix 必须全进
 * fixes[]——mustFixIds 中未修复且未显式处理的 ID 判 violation（漏修）。mustFixIds
 * 为 null/undefined 时仅做 (1)（无 aggregator 数据的降级路径，wave 2 限制）。
 * trackedIssues（state.issues）可选：deferred 的 severity 与追踪表交叉核对（MF-4）——
 * 追踪条目以追踪 severity 为准（must-fix 追踪皆 critical/major，defer 即违规），
 * 仅追踪无此 ID（S-x minor）时采信 fix agent 自报。
 */
function validateFixResult(result, mustFixIds, trackedIssues) {
  return [
    ...deferredSeverityViolations(result.deferred, trackedIssues),
    ...mustFixNotFixedViolations(result.fixes, mustFixIds),
  ];
}

/**
 * validateFixResult 拆分子函数（语义零变更）：单条 deferred 的有效 severity——
 * 自报 severity 经追踪表交叉核对后的最终判定值。
 */
function effectiveDeferredSeverity(d, trackedIssues) {
  const sev = typeof d.severity === "string" ? d.severity.toLowerCase() : "";
  // m9: 自报 severity 可被单边绕过（fix agent 与审核方同一 LLM，有少干活动机，
  // 把 must-fix 标 minor 塞进 deferred 即过旧校验）——与追踪表交叉核对：
  // trackedIssues 中能找到的 ID 以其追踪 severity 为准；追踪表无此 ID 采信自报。
  let effectiveSev = sev;
  if (trackedIssues && typeof d.issue_id === "string" && d.issue_id) {
    const trackedKey = findIssueKey(trackedIssues, d.issue_id);
    const trackedSev = trackedKey ? trackedIssues[trackedKey].severity : undefined;
    const ts = typeof trackedSev === "string" ? trackedSev.toLowerCase() : "";
    // 仅认真实 severity 等级（critical/major/minor/trivial）；"unknown"（reconcile 新
    // ID 默认）等非等级值不覆盖自报，避免误伤合法 minor deferral
    if (ts === "critical" || ts === "major" || ts === "minor" || ts === "trivial") {
      effectiveSev = ts;
    }
  }
  return effectiveSev;
}

/**
 * validateFixResult 拆分子函数（语义零变更）：ES3 校验 (1)——deferred 非
 * minor/trivial（有效等级）判 violation。
 */
function deferredSeverityViolations(deferred, trackedIssues) {
  const violations = [];
  for (const d of deferred || []) {
    if (!d) continue;
    const effectiveSev = effectiveDeferredSeverity(d, trackedIssues);
    if (effectiveSev && effectiveSev !== "minor" && effectiveSev !== "trivial") {
      violations.push({ issue_id: d.issue_id || "(unnamed)", severity: effectiveSev });
    }
  }
  return violations;
}

/**
 * validateFixResult 拆分子函数（语义零变更）：ES3 校验 (2)——mustFixIds 中未进
 * fixes[] 的 ID 判 violation（漏修）。mustFixIds 为 null/undefined/空时无 violation
 * （无 aggregator 数据的降级路径，wave 2 限制）。
 */
function mustFixNotFixedViolations(fixes, mustFixIds) {
  if (!Array.isArray(mustFixIds) || mustFixIds.length === 0) return [];
  // m3: ID 归一化比较——大小写 + 尾部括号尾注（如 "(fixed)"）漂移不误杀：
  // 严格 trim 比较会把 "mf-1"/"MF-1 (fixed)" 判漏修，整轮 fix-failure 误杀
  const fixedIds = new Set((fixes || [])
    .map((f) => (f && typeof f.issue_id === "string" ? normIssueId(f.issue_id) : ""))
    .filter(Boolean));
  const violations = [];
  for (const id of mustFixIds) {
    const norm = typeof id === "string" ? normIssueId(id) : (id && typeof id.id === "string" ? normIssueId(id.id) : "");
    if (norm && !fixedIds.has(norm)) {
      violations.push({ issue_id: norm, severity: "must-fix-not-fixed" });
    }
  }
  return violations;
}

/** 结果解析：object 原样返回；字符串剥 fenced json / 提取内嵌 JSON。 */
function parseResult(raw) {
  if (typeof raw === "object" && raw !== null) return raw;
  if (typeof raw === "string") {
    let s = raw.trim();
    const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i);
    if (fence) s = fence[1].trim();
    if (!s.startsWith("{") && !s.startsWith("[")) {
      const first = s.indexOf("{");
      const last = s.lastIndexOf("}");
      if (first !== -1 && last > first) s = s.slice(first, last + 1);
    }
    try { return JSON.parse(s); } catch { /* fall through */ }
  }
  return null;
}

// ── 对账 / 收敛状态机（设计 §3.4 escalate 映射、5.1/5.7，对齐 pi）──

/**
 * known-remaining 生成（5.1/5.3-4）：issues 中 status=deferred 的条目 → "ID: reason" 清单。
 * reconcileIssues 与 fix 阶段（deferred 写入 issues 后同步更新 state）共用，避免
 * prompt 消费滞后一轮的时序缺口。
 */
function computeKnownRemaining(issues) {
  return Object.entries(issues || {})
    .filter(([, i]) => i.status === "deferred")
    .map(([id, i]) => id + (i.deferredReason ? ": " + i.deferredReason : ""));
}

/**
 * 5.1 对账驱动纯函数：基于 reviewer 的 reconciliation 声明（结构化）与上轮 state.issues 更新。
 * 判定：fix-attempted 未再现 → fixed；再现 → regressed（fixAttempts+1）；新 ID → open。
 * deferred 留 known-remaining（不参与判定）；escalate（上下文改变，5.1-5）→ 重新 open
 * （保留 history/fixAttempts 累计）。stuck：同一 ID 连续 N 轮 open/regressed。
 * 未知 ID（不在 prevIssues 中）按新发现处理；stuckThreshold 复用 stuckThreshold 参数。
 * @returns { issues, stuck, stuckIds, knownRemaining }
 */
function reconcileIssues(prevIssues, { seenIds, escalateIds, round, stuckThreshold }) {
  const issues = {};
  const seen = new Set(seenIds || []);
  const escalated = new Set(escalateIds || []);
  const stuckIds = [];
  for (const [id, issue] of Object.entries(prevIssues || {})) {
    const entry = issues[id] = { ...issue, history: [...(issue.history || [])] };
    if (entry.status === "deferred") {
      escalateDeferred(entry, id, escalated, round);
      continue;
    }
    applySeenTransition(entry, id, issue, seen, round);
    if (accumulateOpenStreak(entry, id, seen, stuckThreshold)) stuckIds.push(id);
  }
  // 新 ID（reviewer 声明的新发现）→ open
  for (const id of seen) {
    if (issues[id]) continue;
    addNewFinding(issues, id, round, stuckThreshold, stuckIds);
  }
  const knownRemaining = computeKnownRemaining(issues);
  return { issues, stuck: stuckIds.length > 0, stuckIds, knownRemaining };
}

/**
 * reconcileIssues 拆分子函数（语义零变更）：5.1-5 显式升级分支——仅处理 status=deferred
 * 条目，escalate 声明转 open，其余 deferred 不动（由调用方 continue 跳过后续判定）。
 */
function escalateDeferred(entry, id, escalated, round) {
  // 5.1-5 显式升级：reconciliation 声明 escalate → 重新 open（保留历史与 fixAttempts），
  // 进入修复循环；未升级的 deferred 留 known-remaining，不参与判定。
  if (escalated.has(id)) {
    entry.status = "open";
    entry.openStreak = 0;
    entry.history.push({ round, status: "escalated" });
  }
}

/**
 * reconcileIssues 拆分子函数（语义零变更）：fix-attempted 判定（未再现 → fixed；
 * 再现 → regressed + fixAttempts+1）与 MF-2 fixed 回归（再次被报告 → regressed +
 * fixAttempts+1）。
 */
function applySeenTransition(entry, id, issue, seen, round) {
  if (issue.status === "fix-attempted") {
    if (!seen.has(id)) {
      entry.status = "fixed";
      entry.openStreak = 0;
      entry.history.push({ round, status: "fixed" });
    } else {
      entry.status = "regressed";
      // fixAttempts 语义 = 修复失败次数：初始 0，每次 regressed +1（RC-7「经 2 次修复
      // 仍未收敛」= 第 2 次 regressed 后触发，修复见 findNeedsRedesign 阈值）。
      entry.fixAttempts = (issue.fixAttempts || 0) + 1;
      entry.history.push({ round, status: "regressed" });
    }
  }
  // MF-2: fixed 条目再次被报告（seen）→ 回归：转 regressed + fixAttempts+1（已确认修复
  // 的问题复发同样计修复失败，needs-redesign 可达）；openStreak 由下方统一 if 累计
  // （首轮回归 1）。未 seen → 保持 fixed（漏报不误转）。修复前此处无转换——fixed 条目
  // 复发时 fixAttempts/openStreak 均不增长，与收敛终止组合后默认配置下 R3 即以
  // converged 提前终止而 must-fix 仍活跃（MF-2）。
  if (issue.status === "fixed" && seen.has(id)) {
    entry.status = "regressed";
    entry.fixAttempts = (issue.fixAttempts || 0) + 1;
    entry.history.push({ round, status: "regressed" });
  }
}

/**
 * reconcileIssues 拆分子函数（语义零变更）：openStreak 累计与 stuck 判定——
 * 命中累计条件且达 stuckThreshold 时返回 true（由调用方记入 stuckIds）。
 */
function accumulateOpenStreak(entry, id, seen, stuckThreshold) {
  // open/regressed 且本轮仍在（seen）→ openStreak +1（跨轮字段）；漏报（未 seen）不增长（保守）
  if (seen.has(id) && (entry.status === "open" || entry.status === "regressed")) {
    entry.openStreak = (entry.openStreak || 0) + 1;
    return entry.openStreak >= stuckThreshold;
  }
  return false;
}

/**
 * reconcileIssues 拆分子函数（语义零变更）：新 ID（reviewer 声明的新发现）→ open，
 * 首现 openStreak=1 并按统一阈值语义参与 stuck 判定。
 */
function addNewFinding(issues, id, round, stuckThreshold, stuckIds) {
  issues[id] = {
    firstSeen: round, severity: "unknown", status: "open", openStreak: 1,
    history: [{ round, status: "open" }], fixAttempts: 0,
  };
  // 新 ID 首现 openStreak=1：统一判定语义 openStreak >= stuckThreshold（与下方既有
  // 条目分支一致）。边界：stuckThreshold=1 时新 ID 首现即 stuck（语义自洽：阈值为 1
  // 表示「任何未解决条目出现即视为卡住」，属显式配置而非 bug）。
  if (issues[id].openStreak >= stuckThreshold) stuckIds.push(id);
}

/**
 * 5.7 新发现率收敛判定纯函数：连续 convergeRounds 轮新发现 ≤ convergeNewIssues 且
 * 无 critical 新发现 → converged（5.7「新 A 类 ≤1 且无 critical」）。
 * 新发现 = 本轮 reconcile 新增的 ID（firstSeen === round）；critical 新发现存在时
 * 不收敛并重置 streak。streak 由调用方持久化（state）。
 */
function checkConvergence({ prevStreak, newFindings, newFindingsCritical, convergeNewIssues, convergeRounds }) {
  if ((newFindingsCritical || 0) > 0) {
    return { converged: false, streak: 0 };
  }
  const streak = newFindings <= convergeNewIssues ? (prevStreak || 0) + 1 : 0;
  return { converged: streak >= convergeRounds, streak };
}

/**
 * 5.7 needs-redesign 判定纯函数（RC-7）：fixAttempts >= maxFixAttempts 且 status === regressed
 * 的 ID → 需要重新设计而非继续补丁。返回含 history 供终止 message 输出。
 */
function findNeedsRedesign(issues, maxFixAttempts) {
  const result = [];
  for (const [id, issue] of Object.entries(issues || {})) {
    if (issue.status === "regressed" && (issue.fixAttempts || 0) >= maxFixAttempts) {
      result.push({ issue_id: id, fixAttempts: issue.fixAttempts, history: issue.history || [] });
    }
  }
  return result;
}

// ── dormant 落盘与消费侧过滤（tier-1 6.3，对齐 pi）────────────────

/** adjudication 降级标记（不占修复队列，设计 §6.3「不占 must-fix 计数」的消费侧过滤键）。 */
const DORMANT_ADJUDICATIONS = new Set(["downgraded", "unverified"]);

/** excludeIds 归一为 Set：Set 直用，数组转 Set，其余（undefined 等）空集。 */
function toIdSet(excludeIds) {
  if (excludeIds instanceof Set) return excludeIds;
  if (Array.isArray(excludeIds)) return new Set(excludeIds);
  return new Set();
}

/** dormant 条目理由文本：note 优先（非空），缺省回落 evidence（非空），均无则空串。 */
function dormantDetail(e) {
  if (typeof e.note === "string" && e.note.trim()) return e.note;
  if (typeof e.evidence === "string" && e.evidence.trim()) return e.evidence;
  return "";
}

/**
 * T6 dormant 落盘（6.3）：聚合条目中 adjudication ∈ {downgraded, unverified} 的
 * 条目落 dormant 清单（含裁决理由）。裁决本身是现实现（aggregator prompt 的
 * ADJUDICATION 段），此处只做结构化落盘 + 复活通道。
 * @param dormant 现有 dormant 数组（不修改，返回新数组）
 * @param entries normalize 后的聚合条目
 * @param round 当前轮
 * @returns 新 dormant 数组：同 id 重复裁决幂等（round/原因更新，revived 保持）
 */
function recordDormant(dormant, entries, round, excludeIds) {
  const list = Array.isArray(dormant) ? dormant.map((d) => ({ ...d })) : [];
  const exclude = toIdSet(excludeIds);
  for (const e of entries || []) {
    if (!e || !DORMANT_ADJUDICATIONS.has(e.adjudication)) continue;
    // exec-review 修复：已在 state.issues 活跃追踪的 id 不落 dormant——同一 id
    // 「活跃 issue + 待复活 dormant」双状态会让 DORMANT 段永久注入一个每轮都在
    // must-fix 表里的条目（prompt 噪声 + 复活率数据污染）。
    if (exclude.has(e.id)) continue;
    const detail = dormantDetail(e);
    const existing = list.find((d) => d.id === e.id);
    if (existing) {
      existing.reason = "adjudication-" + e.adjudication;
      existing.detail = detail;
      existing.round = round;
      // revived 保持——复活状态只由重新上报置位，不因再次降级重置
    } else {
      list.push({
        id: e.id,
        reason: "adjudication-" + e.adjudication,
        detail,
        round,
        revived: false,
      });
    }
  }
  return list;
}

/**
 * T6 消费侧过滤（6.3）：剔除降级条目的 id 列表——主循环用它过滤修复队列
 * （不建 issue、不进 ES3 must-fix 校验；fix prompt 的 must-fix 计数以非降级条目为准）。
 */
function filterActiveIds(entries) {
  return (entries || [])
    .filter((e) => e && !DORMANT_ADJUDICATIONS.has(e.adjudication))
    .map((e) => e.id)
    .filter(Boolean);
}

// ── 跨批 skip 状态机 + stuck 检测（对齐 pi）──────────────────────

/** clean 记录：lastCleanBatch + 当时全局 fixCount 快照（跨批跳过判定依据）。 */
function recordAgentClean(state, agentName, batchIndex) {
  const s = state.agentStatus[agentName] || { lastCleanBatch: 0, lastCleanFixCount: 0, lastActiveRound: 0, lastMustFix: undefined };
  s.lastCleanBatch = batchIndex;
  s.lastCleanFixCount = state.fixCount;
  s.lastActiveRound = batchIndex;
  state.agentStatus[agentName] = s;
}

/** dirty 记录：lastActiveRound + 最近 mustFix（不写 clean 快照，保留上次 clean 的 fixCount 基准）。 */
function recordAgentDirty(state, agentName, mustFix, batchIndex) {
  const s = state.agentStatus[agentName] || { lastCleanBatch: 0, lastCleanFixCount: 0, lastActiveRound: 0, lastMustFix: undefined };
  s.lastActiveRound = batchIndex;
  s.lastMustFix = mustFix;
  state.agentStatus[agentName] = s;
}

/**
 * 跨批跳过判定（cross-batch skip 核心状态机）：
 * agent 在更早批 clean（lastCleanBatch < batchIndex）且此后无 fix（fixCount 快照相等）→ 跳过。
 * fixCount 快照比较的相等语义决定是否跳过——clean 后发生过 fix 则不能跳过（该 agent 可能受影响）。
 */
function shouldSkipAgent(status, fixCount, batchIndex) {
  return !!(status && status.lastCleanBatch && status.lastCleanBatch < batchIndex && status.lastCleanFixCount === fixCount);
}

/**
 * Stuck 检测纯函数（MF-2 决策：只跟踪 must_fix，不跟踪 suggestion——suggestion 带 reviewer
 * 主观性，修复后仍可能新冒，计入 total 会把合法推进（must_fix 每轮在降）误判为 stuck 提前
 * 终止；fix 阶段虽已改为修复全部等级，stuck 仍以 must-fix 为准，suggestion 不收敛由
 * maxRounds 硬顶兜底）。
 *
 * @param prevMustFix 上一轮 must_fix（首轮传 -1，不计数直接记录基线）
 * @param stuckCount 当前连续不降轮数
 * @param mustFix 本轮 must_fix
 * @param stuckThreshold 连续不降多少轮判定 stuck（>= 该值）
 * @returns { stuck, stuckCount, prevMustFix } 新状态；stuck=true 时调用方应结构化终止
 */
function updateStuckState(prevMustFix, stuckCount, mustFix, stuckThreshold) {
  if (prevMustFix >= 0 && mustFix >= prevMustFix) {
    const nextCount = stuckCount + 1;
    return { stuck: nextCount >= stuckThreshold, stuckCount: nextCount, prevMustFix: mustFix };
  }
  return { stuck: false, stuckCount: 0, prevMustFix: mustFix };
}

// ── zsw 侧契约常量（v2 编排消费，pi 无此形态；分叉点 3）──────────

/** loop 终态枚举（设计 §3.4）：state.meta.terminated 与 loop.status 的值域（fixed-unverified 为 zsw 特有保留）。 */
const TERMINAL_STATUSES = [
  "clean", "converged", "stuck", "needs-redesign", "max-rounds",
  "fixed-unverified", "review-failed", "fix-failed", "aggregator-failure", "aborted",
];

/** state.issues[].status 值域（设计 §3.4 state 字段）。 */
const ISSUE_STATUSES = ["open", "fix-attempted", "fixed", "regressed", "deferred"];

/** severity 全等级集合（reviewer/聚合契约枚举，设计 §3.4）。 */
const SEVERITIES = ["critical", "major", "minor"];

/** must-fix 等级集合（聚合 must_fix 计数与 ES3 硬校验的判定面）。 */
const MUST_FIX_SEVERITIES = ["critical", "major"];

/** severity 排序权重（越大越严重；v2 编排的条目排序/最高等级归并比较用）。 */
const SEVERITY_RANK = { critical: 3, major: 2, minor: 1 };

module.exports = {
  wrapUntrusted,
  normalizeFixResult,
  normIssueId,
  findIssueKey,
  validateFixResult,
  parseResult,
  computeKnownRemaining,
  reconcileIssues,
  checkConvergence,
  findNeedsRedesign,
  recordDormant,
  filterActiveIds,
  recordAgentClean,
  recordAgentDirty,
  shouldSkipAgent,
  updateStuckState,
  TERMINAL_STATUSES,
  ISSUE_STATUSES,
  SEVERITIES,
  MUST_FIX_SEVERITIES,
  SEVERITY_RANK,
};
