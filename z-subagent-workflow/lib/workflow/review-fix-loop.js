'use strict';
/**
 * review-fix-loop workflow（v2 批次外环版）：批次 batch1..batchN 串行 × 批内循环
 * （并行 review → 聚合 must-fix → fix → 重审到 clean）。
 *
 * v2 新增（对齐 pi 质量内核，设计 docs/design/zsw-review-fix-loop-v2-design.md）：
 * - 参数面终态全集（§3.4）：targetType/target（--review-target 为 sugar；全缺省映射
 *   targetType=text、target='git 未提交改动'，D5）、batchN 批次（无 batchN 时 reviewers
 *   包装单批；同传时 batchN 优先并 WARN 一行）、batchNames、maxRounds 默认 10（clamp
 *   1-10）、stuckThreshold 默认 3（v1 硬编码 2，计数式停滞语义保留）、converge 各参、
 *   maxFixAttempts/aggregatorModel/reviewPrompt/fixPrompt/fallowScan/autoCommit
 *   （U1 只接收+校验+透传，U2/U3 接线消费）；未知参数名一律报错并列合法清单（防 batchN 拼错静默失效）。
 * - 批次外环：批间串行，前一批非 clean 即终止整个 run（前置批次失败后续审查无意义）；
 *   跨批 skip 用 vendor 纯函数（shouldSkipAgent/recordAgentClean/recordAgentDirty）
 *   维护 agentStatus——维度在某批 clean 时快照 fixCount，后续批启动时其 clean 批次更早
 *   且 fixCount 未变 → 跳过该维度（S4）。clean 集合语义统一为「维度名」。
 * - runDir（D4）：runId 由 WorkflowManager._invokeEntry 注入，建 ~/.zcode/zsw/rfl/<runId>/；
 *   state.json 原子写（tmp+rename），U1 落最小骨架（meta + batches[].rounds[] +
 *   agentStatus/fixCount），完整状态机在 U3。无 runId（直连库调用，如单测）不落盘、
 *   返回结果无 runDir 字段——行为与 v1 完全兼容。
 * - abort 检查点全集（§3.4）：批间 batch<i>（批 i 启动前）+ 批内 batch<i>-round<j>-<phase>
 *   （phase ∈ {review, aggregate, fix}）。语义与 v1 AbortSignal 契约一致：已完成条目保留、
 *   增量阶段 status 'aborted'。
 * - 聚合仍为 JS 标题归一去重（v1 语义）；LLM 聚合 phase、reviewer 输出契约扩展
 *   （reconciliation/suggestion_count）与 parseFail 语义变更（D3）在 U2。
 *
 * 保留的 v1.5 语义（skip-clean/recheck-after-fix，commit 9069acc）：
 * - skipCleanAgents 默认 true：clean 维度下轮跳过不派（批内 cleanNames + 跨批 agentStatus）。
 * - recheckAfterFix=true：fix 后重派全批，上一轮 clean 的维度走限定复检 prompt（只查
 *   fix 引入的回归）；false（默认）fix 后批内 cleanNames 不清空，clean 持续跳过。
 *
 * zsub 移植差异（相对 pi/dynamic-workflow 源版，循环/熔断/聚合语义不变）：
 * - 模型解析：driver.resolveModelRef → ModelRouter.resolve（aggregatorModel 同路校验）。
 * - 隔离 HOME：由 run-phase 内 prepareRunEnv 按需 bootstrap，本模块不触碰 HOME 写盘。
 * - pool/jsonout 在 lib/ 根而非 lib/workflow/，require 路径改 ../pool、../jsonout。
 * - abort（契约见 run-phase.js 头注）：opts.signal 缺省时行为完全不变；编排检查点全集
 *   见上。整体返回增量 status（'ok'|'failed'|'aborted'）与 abortedAtPhase（仅 aborted
 *   携带）；loop.status 细分终态（TERMINAL_STATUSES 的 U1 子集）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { runPhase } = require('./phases');
const { runWithLimit } = require('../pool');
const { extractJsonObject } = require('../jsonout');
const ModelRouter = require('../model-router');
const config = require('../config');
const { execSync } = require('node:child_process');
const {
  shouldSkipAgent,
  recordAgentClean,
  recordAgentDirty,
  updateStuckState,
  SEVERITY_RANK,
  MUST_FIX_SEVERITIES,
} = require('./review-fix-loop-utils');

// 模块级单例：resolve 无解析状态；与 run-phase.js 同一约定（见其头注）。
const modelRouter = new ModelRouter();

const DEFAULT_REVIEWERS = ['correctness', 'robustness'];
// D5：对齐 pi 缺省值（v1 为 maxRounds 5 / stuckThreshold 硬编码 2）。
const DEFAULT_MAX_ROUNDS = 10;
const DEFAULT_STUCK_THRESHOLD = 3;
// U3 消费的收敛/重设计参数缺省值（对齐 pi；U1 先接收+校验+透传）。
const DEFAULT_CONVERGE_NEW_ISSUES = 1;
const DEFAULT_CONVERGE_ROUNDS = 2;
const DEFAULT_MAX_FIX_ATTEMPTS = 2;
const TARGET_TYPES = ['git-diff', 'file', 'dir', 'text'];
const DEFAULT_TARGET_TEXT = 'git 未提交改动';

const REVIEWER_DESC = {
  correctness: '正确性：逻辑错误、边界条件、错误处理缺失、与意图不符',
  robustness: '健壮性：异常路径、资源泄漏、并发问题、输入校验',
  security: '安全性：注入、越权、敏感信息泄露',
  performance: '性能：复杂度热点、冗余 IO',
  maintainability: '可维护性：重复、命名、分层、可测性',
};

function reviewerDesc(r) { return REVIEWER_DESC[r] || '按该审查焦点深入检查'; }

/**
 * review-fix-loop 领域参数（设计 §3.4 CLI 参数面终态全集）。白名单校验的权威清单。
 */
const DOMAIN_PARAM_KEYS = [
  'targetType', 'target', 'reviewTarget', 'reviewers', 'batchNames', 'maxRounds', 'stuckThreshold',
  'skipCleanAgents', 'recheckAfterFix', 'convergeNewIssues', 'convergeRounds', 'maxFixAttempts',
  'aggregatorModel', 'reviewPrompt', 'fixPrompt', 'fallowScan', 'autoCommit',
];
/**
 * 基础设施注入键：WorkflowManager._invokeEntry / CLI 传入的非领域字段（不在 §3.4
 * 参数面内，但对入口可见）。白名单校验必须放行它们。
 */
const INFRA_PARAM_KEYS = [
  'task', 'workdir', 'model', 'signal', 'runId', 'onPhase', 'onPlan', 'maxConcurrent', 'timeoutMsPerPhase',
];
const KNOWN_PARAM_KEYS = new Set([...DOMAIN_PARAM_KEYS, ...INFRA_PARAM_KEYS]);
/** batchN 动态键（batch1、batch2、…；N>=1，缺号报错——设计 §3.4）。 */
const BATCH_KEY_RE = /^batch([1-9]\d*)$/;

/** 归一化 issue 标题做去重键（中文友好：仅折叠空白 + 小写拉丁）。 */
function dedupKey(title) {
  return String(title).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** signal 缺省（undefined）与未触发都视为未中止；编排层只认 signal.aborted 单一事实源。 */
function isAborted(signal) { return !!signal && signal.aborted === true; }

/**
 * 字符串强制转布尔（对齐原版 coerceBool：LLM/CLI 可能以字符串传布尔，
 * "false" 若按 truthy 处理会反转语义）。非布尔非 "true"/"false" 回退默认值。
 */
function coerceBool(v, fallback) {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

/**
 * 整数参数解析：undefined/null/'' → fallback；非整数可操作报错；clamp=true 时越界
 * 收敛进 [min,max]（maxRounds 沿用 v1 的 clamp 惯例），否则低于 min 报错。
 */
function coerceInt(v, name, { min, max, clamp = false, fallback }) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isInteger(n)) {
    throw new Error(`${name} 必须是整数（收到 ${JSON.stringify(v)}）。恢复指引：传整数值，如 --${name} 3。`);
  }
  if (clamp) return Math.max(min, Math.min(n, max));
  if (n < min) {
    throw new Error(`${name} 不能小于 ${min}（收到 ${n}）。恢复指引：传 >= ${min} 的整数。`);
  }
  return n;
}

/**
 * 维度名列表解析：数组直用、逗号分隔字符串拆分；空元素剔除。
 * 传入但解析后为空 → 可操作报错（v1「reviewers 解析后为空」语义泛化到 batchN/batchNames）。
 * 未传入（undefined/null）→ null（由调用方决定缺省）。
 */
function parseDims(v, name) {
  if (v === undefined || v === null) return null;
  const arr = (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean);
  if (arr.length === 0) {
    throw new Error(`${name} 解析后为空。恢复指引：传逗号分隔的维度名（如 "correctness,robustness"）。`);
  }
  return arr;
}

/** 非 git 目录（或 rev-parse 失败）→ null；run 起点取 baseHash（state.meta，U3 base 锁定）。 */
function gitHead(workdir) {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: workdir, timeout: 10_000 }).trim();
  } catch { return null; }
}

/**
 * recheckAfterFix 限定复检的 scope 来源：git diff 实测本轮 fix 触碰的文件
 * （对齐原版 lastModifiedFiles 通道）。prevHead 为 null（非 git 目录）时返回 []，
 * 限定复检 prompt 退化为仅基于修复说明。diff 含 fix 前已存在的未提交改动——
 * 复检范围偏大是安全方向的误差，与原版同口径。
 */
function gitModifiedSince(prevHead, workdir) {
  if (!prevHead) return [];
  try {
    const out = execSync(`git diff --name-only ${prevHead}`, { encoding: 'utf-8', cwd: workdir, timeout: 10_000 }).trim();
    return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  } catch { return []; }
}

/** 聚合（U1 仍为 JS 去重合并，U2 换 LLM 聚合 phase）：合并多维度 issues，
 * 标题归一化相同视为同一问题（保留最高严重度）。severity 集合与排序权重
 * 以 review-fix-loop-utils 的契约常量为单一权威。 */
function aggregateIssues(reviewerOutputs) {
  const map = new Map(); // key -> {id, title, severity, detail, file, reviewers:Set}
  let n = 0;
  for (const { reviewer, issues } of reviewerOutputs) {
    for (const it of issues || []) {
      const title = String(it?.title || '').trim();
      if (!title) continue;
      const key = dedupKey(title);
      const severity = String(it?.severity || 'minor').toLowerCase();
      if (!map.has(key)) {
        n++;
        map.set(key, {
          id: `R${n}`, title, severity,
          detail: String(it?.detail || '').slice(0, 500),
          file: it?.file ? String(it.file) : null,
          reviewers: new Set([reviewer]),
        });
      } else {
        const ex = map.get(key);
        ex.reviewers.add(reviewer);
        if ((SEVERITY_RANK[severity] || 1) > (SEVERITY_RANK[ex.severity] || 1)) ex.severity = severity;
      }
    }
  }
  const all = [...map.values()];
  return { all, mustFix: all.filter((i) => MUST_FIX_SEVERITIES.includes(i.severity)) };
}

function issuesJsonBlock(issues) {
  return JSON.stringify(issues.map(({ id, title, severity, detail, file }) => ({ id, title, severity, detail, file })), null, 1);
}

/**
 * 参数归一与白名单校验（设计 §3.4 参数面 / D5 兼容映射 / D7 fallowScan 约束）。
 * 非法输入一律可操作报错、不静默回退；唯一例外 maxRounds 越界按 v1 惯例 clamp 1-10。
 * 新参旧参冲突不报错：新参优先 + WARN 一行（warnings 返回给调用方展示）。
 * @returns {object} P 归一化参数（含 warnings: string[]）
 */
function normalizeParams(raw) {
  const warnings = [];

  // 0) 白名单（先于一切）：拼错的参数名（如字面量 batchN、stuckThreshold 漏字母）
  //    在此拦截——静默忽略会让批次/熔断配置失效且无任何症状（设计 §3.4）
  const unknown = Object.keys(raw).filter((k) => !KNOWN_PARAM_KEYS.has(k) && !BATCH_KEY_RE.test(k));
  if (unknown.length > 0) {
    throw new Error(
      `review-fix-loop 收到未知参数: ${unknown.map((k) => `"${k}"`).join(', ')}。`
      + `合法参数: ${DOMAIN_PARAM_KEYS.join(', ')}、batch1..batchN（batch1、batch2、… 连续编号）。`
      + '恢复指引：核对参数拼写（常见误写：字面量 "batchN"、stuckThreshold 漏写字母）；未知参数一律拒绝以防静默失效。'
    );
  }

  // 1) target 系（D5）：新参（targetType/target）优先；--review-target 为等价
  //    sugar（targetType=text）；全缺省 → text + v1 缺省文案
  const hasNewTarget = raw.targetType !== undefined || raw.target !== undefined;
  const hasSugarTarget = raw.reviewTarget !== undefined;
  if (hasNewTarget && hasSugarTarget) {
    warnings.push('target 系参数与 review-target 同时传入：新参（targetType/target）优先，review-target 已忽略（设计 D5）');
  }
  const useSugar = hasSugarTarget && !hasNewTarget;
  let targetType = useSugar ? 'text' : raw.targetType;
  let target = useSugar ? raw.reviewTarget : raw.target;
  if (targetType === undefined || targetType === null || targetType === '') targetType = 'text';
  targetType = String(targetType);
  if (!TARGET_TYPES.includes(targetType)) {
    throw new Error(
      `targetType 非法: ${JSON.stringify(raw.targetType)}（合法值: ${TARGET_TYPES.join(' / ')}）。`
      + '恢复指引：--target-type git-diff|file|dir|text。'
    );
  }
  if (typeof target !== 'string' || target.trim() === '') target = DEFAULT_TARGET_TEXT;
  target = target.trim();

  // 2) 批次（D5）：batchN 优先；无 batchN 时 reviewers 包装单批（缺省 DEFAULT_REVIEWERS）
  const batchEntries = Object.keys(raw)
    .map((k) => {
      const m = BATCH_KEY_RE.exec(k);
      return m ? { n: Number(m[1]), key: k, value: raw[k] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);
  let batches;
  if (batchEntries.length > 0) {
    if (raw.reviewers !== undefined) {
      warnings.push('batchN 与 reviewers 同时传入：batchN 优先，reviewers 已忽略（设计 D5）');
    }
    for (let i = 0; i < batchEntries.length; i++) {
      if (batchEntries[i].n !== i + 1) {
        throw new Error(
          `批次编号不连续: 缺少 batch${i + 1}（收到 ${batchEntries.map((b) => b.key).join(', ')}）。`
          + '恢复指引：batchN 从 1 连续编号（batch1、batch2、…），检查是否漏传中间批或写错编号。'
        );
      }
    }
    batches = batchEntries.map((b) => parseDims(b.value, b.key));
  } else {
    const rs = parseDims(raw.reviewers, 'reviewers');
    batches = [rs || [...DEFAULT_REVIEWERS]];
  }

  // 批次命名（数量必须与批次数一致；缺省 batch-1..N）
  let batchNames = parseDims(raw.batchNames, 'batchNames');
  if (batchNames) {
    if (batchNames.length !== batches.length) {
      throw new Error(
        `batchNames 数量（${batchNames.length}）与批次数（${batches.length}）不一致。`
        + '恢复指引：batchNames 与 batchN 一一对应，或省略该参数使用缺省 batch-1..N。'
      );
    }
  } else {
    batchNames = batches.map((_, i) => `batch-${i + 1}`);
  }

  // 3) 数值参数：maxRounds 默认 10（clamp 1-10，D5）；stuckThreshold 默认 3（v1 硬编码 2，
  //    计数式停滞语义保留——连续 stuckThreshold 轮 must-fix 不降判 stuck）；收敛/重设计
  //    参数对齐 pi 缺省，U3 消费
  const maxRounds = coerceInt(raw.maxRounds, 'maxRounds', { min: 1, max: 10, clamp: true, fallback: DEFAULT_MAX_ROUNDS });
  const stuckThreshold = coerceInt(raw.stuckThreshold, 'stuckThreshold', { min: 1, fallback: DEFAULT_STUCK_THRESHOLD });
  const convergeNewIssues = coerceInt(raw.convergeNewIssues, 'convergeNewIssues', { min: 0, fallback: DEFAULT_CONVERGE_NEW_ISSUES });
  const convergeRounds = coerceInt(raw.convergeRounds, 'convergeRounds', { min: 1, fallback: DEFAULT_CONVERGE_ROUNDS });
  const maxFixAttempts = coerceInt(raw.maxFixAttempts, 'maxFixAttempts', { min: 1, fallback: DEFAULT_MAX_FIX_ATTEMPTS });

  // 4) 布尔参数（"true"/"false" 字符串兼容，见 coerceBool）
  const skipCleanAgents = coerceBool(raw.skipCleanAgents, true);
  const recheckAfterFix = coerceBool(raw.recheckAfterFix, false);
  const fallowScan = coerceBool(raw.fallowScan, false);
  const autoCommit = coerceBool(raw.autoCommit, false);
  // D7：fallowScan（fallow 静态扫描前置批）只对 git-diff 目标有意义
  if (fallowScan && targetType !== 'git-diff') {
    throw new Error(
      `fallowScan=true 仅在 targetType=git-diff 时合法（当前 ${targetType}）。`
      + '恢复指引：改传 --target-type git-diff，或去掉 --fallow-scan。'
    );
  }

  // 5) prompt 透传（reviewPrompt/fixPrompt 由 U2 嵌入 reviewer/fixer prompt；U1 只校验形态）
  for (const key of ['reviewPrompt', 'fixPrompt']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') {
      throw new Error(`${key} 必须是字符串（收到 ${typeof raw[key]}）。恢复指引：以字符串传入补充指令。`);
    }
  }

  return {
    targetType, target, batches, batchNames, maxRounds, stuckThreshold,
    convergeNewIssues, convergeRounds, maxFixAttempts,
    skipCleanAgents, recheckAfterFix, fallowScan, autoCommit,
    aggregatorModel: typeof raw.aggregatorModel === 'string' && raw.aggregatorModel.trim() !== ''
      ? raw.aggregatorModel.trim()
      : null,
    reviewPrompt: raw.reviewPrompt,
    fixPrompt: raw.fixPrompt,
    warnings,
  };
}

/**
 * 审查-修复循环（v2）。
 * @param {object} opts
 * @param {string} [opts.task] 上下文（改动的来龙去脉）
 * @param {string} [opts.targetType] 审查目标类型（§3.4；缺省 text）
 * @param {string} [opts.target] 审查目标描述（缺省 'git 未提交改动'）
 * @param {string} [opts.reviewTarget] 老参数 sugar：等价 targetType=text + target=<值>（D5）
 * @param {string[]} [opts.reviewers] 老参数 sugar：包装为单批（缺省 correctness+robustness）
 * @param {string[]} [opts.batch1] 批次维度（batch2/batch3/… 同形；缺号报错，D5）
 * @param {string[]} [opts.batchNames] 批次命名（数量须与批次数一致，缺省 batch-1..N）
 * @param {number} [opts.maxRounds=10] 每批最大轮数（clamp 1-10）
 * @param {number} [opts.stuckThreshold=3] 连续 N 轮 must-fix 不降判 stuck
 * @param {boolean} [opts.skipCleanAgents=true] clean 维度跳过不派（批内+跨批）
 * @param {boolean} [opts.recheckAfterFix=false] fix 后重派全批，clean 维度走限定复检（v1.5 语义）
 * @param {number} [opts.convergeNewIssues=1] 收敛参数（U3 消费，U1 校验+透传）
 * @param {number} [opts.convergeRounds=2] 同上
 * @param {number} [opts.maxFixAttempts=2] 同上
 * @param {string} [opts.aggregatorModel] 聚合模型（U2 消费；U1 经 ModelRouter 校验可解析）
 * @param {string} [opts.reviewPrompt] reviewer prompt 补充指令（U2 消费）
 * @param {string} [opts.fixPrompt] fixer prompt 补充指令（U2 消费）
 * @param {boolean} [opts.fallowScan=false] fallow 静态扫描前置批（仅 git-diff 合法，U3 消费）
 * @param {boolean} [opts.autoCommit=false] fixer 是否提交（U3 消费）
 * @param {string} [opts.runId] WorkflowManager 注入的 run id（D4；缺省无 runDir/state 落盘）
 * @param {string} opts.workdir
 * @param {string} [opts.model]
 * @param {number} [opts.maxConcurrent=3]
 * @param {number} [opts.timeoutMsPerPhase] 单阶段超时（缺省 null = 无超时）
 * @param {AbortSignal} [opts.signal] 中止信号（契约见 run-phase.js 头注）
 * @returns {{runDir?: string}} 结果带 runDir（仅 runId 注入时）
 */
async function runReviewFixLoop(raw = {}) {
  const P = normalizeParams(raw); // 非法参数在此可操作报错（含白名单/缺号/fallowScan 约束）
  const { task, workdir, signal, onPhase, onPlan } = raw;
  const maxConcurrent = raw.maxConcurrent === undefined ? 3 : raw.maxConcurrent; // v1 缺省 3
  const timeoutMsPerPhase = raw.timeoutMsPerPhase;
  const modelRef = modelRouter.resolve(raw.model);
  // aggregatorModel 缺省 = run model（D7，U2 消费）；U1 先做可解析性校验（传错列可用清单）
  const aggregatorModelRef = P.aggregatorModel ? modelRouter.resolve(P.aggregatorModel) : null;
  for (const w of P.warnings) process.stderr.write(`[zsw] WARN: ${w}\n`);

  const { maxRounds, stuckThreshold, skipCleanAgents, recheckAfterFix } = P;
  const batchTotal = P.batches.length;
  const startedAt = new Date().toISOString();
  if (onPlan) onPlan(P.batches.reduce((n, b) => n + maxRounds * (b.length + 1), 0));

  // ── runDir / state.json（D4）─────────────────────────────────────────
  // runId 由 WorkflowManager 注入；直连调用（单测/库消费）无 runId → 不落盘
  let runDir = null;
  let statePath = null;
  if (typeof raw.runId === 'string' && raw.runId.trim() !== '') {
    runDir = path.join(config.zswRoot(), 'rfl', raw.runId);
    fs.mkdirSync(runDir, { recursive: true });
    statePath = path.join(runDir, 'state.json');
  }
  /** U1 最小骨架（完整状态机在 U3）：meta + batches[].rounds[] + agentStatus/fixCount。
   *  字段名对齐设计 §3.4 state.json 规格；terminated 终态时快照（§3.4 权威源）。 */
  const state = {
    meta: {
      runId: raw.runId ?? null,
      workdir,
      targetType: P.targetType,
      target: P.target,
      batches: P.batches,
      batchNames: P.batchNames,
      baseHash: gitHead(workdir), // base 锁定：run 起点基线（U3 消费）
      startedAt,
      terminated: null,
    },
    agentStatus: {}, // 跨批 skip 状态机（recordAgentClean/recordAgentDirty 维护）
    fixCount: 0,
    batches: P.batches.map((_, i) => ({ index: i + 1, rounds: [] })),
    abortedAtPhase: null, // zsw 特有（AbortSignal 契约，§3.4）
  };
  // 原子写（tmp+rename）：崩溃窗口内 reader 要么看到旧整版要么新整版，无半截 JSON
  const saveState = () => {
    if (!statePath) return;
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, statePath);
  };
  saveState();

  // ── 批次外环 ─────────────────────────────────────────────────────────
  const phaseResults = [];
  const roundSummaries = [];
  const allDims = [...new Set(P.batches.flat())];
  let totalRounds = 0;
  let runFixResponse = null; // 最近一次 fix 响应（报告「最后一轮修复说明」，跨批保留最后值）
  let status = 'max-rounds';
  let abortedAtPhase = null; // status==='aborted' 时的中止检查点（§3.4 命名）
  let remaining = [];

  /**
   * 跑一个批次，返回批内终态。批内循环骨架 = v1（review 批 → JS 聚合 → stuck 检测
   * → fix），批间差异只在：跨批 skip 预过滤 + agentStatus 记录 + 检查点命名。
   * 返回 status ∈ clean | max-rounds | fixed-unverified | stuck | review-failed |
   * fix-failed | aborted（U3 再补 converged/needs-redesign/aggregator-failure）。
   */
  async function runBatch(batchIndex, dims) {
    const phases = [];
    const summaries = [];
    let rounds = 0;
    const multiBatch = batchTotal > 1;
    const phasePrefix = `batch${batchIndex}`;
    const cleanNames = new Set(); // 批内 clean 集合（维度名；v1 cleanReviewers 的批内部分）
    let prevMustFix = -1; // updateStuckState 契约：首轮 -1 基线
    let stuckCount = 0;
    let batchHasFix = false; // recheckAfterFix 用：本批是否发生 fix（v1.5 语义）
    let batchFixResponse = null;
    let lastModifiedFiles = []; // 本批最近一轮 fix 实测改动文件（限定复检 prompt scope）
    let lastAction = 'review'; // 'review' | 'fix'：批内轮数耗尽时区分 fixed-unverified
    let status = 'max-rounds';
    let abortedAtPhase = null;
    let remaining = [];

    // 跨批 skip（S4）：此前批 clean 且此后无 fix（fixCount 快照相等）的维度不派
    const crossSkipped = skipCleanAgents
      ? dims.filter((r) => shouldSkipAgent(state.agentStatus[r], state.fixCount, batchIndex))
      : [];
    const batchActive = dims.filter((r) => !crossSkipped.includes(r));

    const finish = () => ({ status, remaining, abortedAtPhase, phases, summaries, rounds, fixResponse: batchFixResponse });

    if (batchActive.length === 0) {
      // 全批跨批跳过：0 轮，视为 clean（前置批已覆盖这些维度且无后续 fix）
      summaries.push({
        batch: batchIndex, round: 0,
        detail: `全部维度跨批跳过（${crossSkipped.join('、')}——此前批 clean 且此后无 fix），0 轮`,
        mustFixCount: 0,
      });
      status = 'clean';
      return finish();
    }

    if (onPhase) onPhase({ phase: phasePrefix, status: `starting x${batchActive.length}` });

    for (let round = 1; round <= maxRounds; round++) {
      // 检查点 ①（review 批启动前）：上一轮/上一批结束后 signal 已 aborted → 不再启动
      if (isAborted(signal)) { status = 'aborted'; abortedAtPhase = `${phasePrefix}-round${round}-review`; break; }

      // v1.5 语义保留（skip-clean/recheck-after-fix）：recheckAfterFix=true 且本批有
      // fix → 重派全批，上一轮 clean 的维度本轮走限定复检 prompt；默认（false）fix 后
      // cleanNames 不清空——clean 持续跳过，即 skipCleanAgents=true 的字面语义
      let scopedClean = new Set();
      if (recheckAfterFix && round > 1 && batchHasFix) {
        scopedClean = new Set(cleanNames);
        cleanNames.clear();
      }
      const active = batchActive.filter((r) => !(skipCleanAgents && cleanNames.has(r)));
      if (active.length === 0) { status = 'clean'; break; }

      const roundStartedAt = new Date().toISOString();
      if (onPhase) onPhase({ phase: `${phasePrefix}-round${round}-review`, status: `running x${active.length}` });
      const reviews = await runWithLimit(active, maxConcurrent, (r) => runPhase({
        name: 'review', label: `R${round} 审查: ${r}`,
        prompt:
          `你是审查-修复循环中的审查者「${r}」（${reviewerDesc(r)}）。${scopedClean.has(r) ? '你上一轮结论为 clean；上一轮结束后修复者已改动代码，本轮你只做限定复检。' : ''}\n\n` +
          (multiBatch ? `## 批次\n第 ${batchIndex}/${batchTotal} 批（批间串行：本批在前一批 clean 后才启动）\n\n` : '') +
          `## 任务背景\n${task || '(未提供)'}\n\n` +
          `## 审查范围\n${P.target}\n\n` +
          `${round > 1 && batchFixResponse ? `## 上一轮修复说明\n${batchFixResponse.slice(0, 2000)}\n\n` : ''}` +
          (scopedClean.has(r)
            ? `## 本轮 fix 实测改动文件（git diff）\n${lastModifiedFiles.length ? lastModifiedFiles.map((f) => `- ${f}`).join('\n') : '（非 git 目录或 diff 为空——按修复说明涉及的改动复检）'}\n\n` +
              `## 你的职责（限定复检）\n只检查上述 fix 改动是否引入属于「${r}」焦点的新问题（回归）。禁止修改任何文件；不要全量重审，未被本轮 fix 触碰的上一轮遗留问题不要重复报告。\n\n`
            : `## 你的职责\n只从「${r}」焦点审查上述范围。禁止修改任何文件。\n\n`) +
          `## 输出格式\n先 2-3 句总体印象，然后必须输出一个 \`\`\`json 围栏块：\n` +
          '```json\n' +
          '{"status":"clean","issues":[]}\n' +
          '```\n' +
          `或（发现问题时，severity 取 critical/major/minor；只有 critical 和 major 算必须修复）：\n` +
          '```json\n' +
          '{"status":"issues","issues":[{"id":"A1","severity":"major","title":"问题标题","detail":"说明与依据","file":"相对路径"}]}\n' +
          '```\n' +
          `不要报风格类 minor 问题；不要输出其他 json 块。`,
        cwd: workdir, modelRef, timeoutMs: timeoutMsPerPhase, signal,
      }));
      for (const entry of reviews) phases.push(entry);

      // 检查点 ②（review 批完成后）：aborted → 本轮聚合与 fix 不再进行，已完成
      // 审查条目随报告保留
      if (isAborted(signal)) { status = 'aborted'; abortedAtPhase = `${phasePrefix}-round${round}-review`; break; }

      // ── 聚合（JS 去重合并；U2 换 LLM 聚合 phase + 降级链）──
      // entry.ok=false（维度执行失败：CLI 崩溃/超时）单列 runFail——与 parseFail
      // （执行成功但输出解析失败）分开：失败的维度既不算 clean 也不算发现问题；
      // 全部失败时不得按 0 问题判 clean（U2 起按 D3 收紧为结构化终止）
      const parsedReviews = active.map((r, i) => {
        const entry = reviews[i];
        if (!entry.ok) return { reviewer: r, issues: [], runFail: true, entry };
        const obj = extractJsonObject(entry.response || '');
        if (!obj) return { reviewer: r, issues: [], parseFail: true, entry };
        const issues = Array.isArray(obj.issues)
          ? obj.issues.filter((x) => x && typeof x.title === 'string')
          : [];
        return { reviewer: r, issues, clean: obj.status === 'clean' || issues.length === 0, entry };
      });
      const { mustFix } = aggregateIssues(parsedReviews);
      const parseFails = parsedReviews.filter((p) => p.parseFail);
      const runFails = parsedReviews.filter((p) => p.runFail);

      // 跨批 skip 状态机记录（维度名语义）：clean → 快照 fixCount；有 must-fix →
      // dirty。parseFail/runFail 无可信结论，不记录（v1 同款：失败不算 clean）
      for (const p of parsedReviews) {
        if (p.runFail || p.parseFail) continue;
        if (p.clean) {
          recordAgentClean(state, p.reviewer, batchIndex);
        } else {
          const mustFixCount = p.issues
            .filter((x) => MUST_FIX_SEVERITIES.includes(String(x?.severity || 'minor').toLowerCase())).length;
          recordAgentDirty(state, p.reviewer, mustFixCount, batchIndex);
        }
      }
      for (const p of parsedReviews) if (p.clean && !p.parseFail) cleanNames.add(p.reviewer);

      // 轮次摘要（v1 文案；跨批/批内跳过分列说明）
      const skippedNow = dims.filter((r) => !active.includes(r));
      const inBatchSkipped = skippedNow.filter((r) => !crossSkipped.includes(r));
      summaries.push({
        batch: batchIndex,
        round,
        detail: parsedReviews.map((p) =>
          `${p.reviewer}: ${p.runFail ? '审查执行失败' : p.parseFail ? '输出解析失败' : p.clean ? 'clean' : `${p.issues.length} 个问题`}`
        ).join('；')
          + (crossSkipped.length ? `（跨批跳过: ${crossSkipped.join('、')}——此前批 clean 且此后无 fix）` : '')
          + (inBatchSkipped.length ? `（跳过: ${inBatchSkipped.join('、')}——上轮 clean 且此后无 fix）` : '')
          + (runFails.length ? `（${runFails.length} 个审查者执行失败）` : '')
          + (parseFails.length ? `（${parseFails.length} 个审查者输出无法解析，按 clean 处理并告警）` : ''),
        mustFixCount: mustFix.length,
      });
      rounds++;

      // state 轮记录（S1 批次时序 / S4 agents 明细的数据源）：聚合后即落（abort
      // 中途也有迹可查），fix 结果在下方补 finishedAt/modifiedFiles
      const roundRecord = {
        round,
        startedAt: roundStartedAt,
        finishedAt: new Date().toISOString(),
        mustFix: mustFix.length,
        agents: active.slice(),
        skipped: skippedNow.slice(),
        modifiedFiles: [],
      };
      state.batches[batchIndex - 1].rounds.push(roundRecord);
      const closeRound = () => {
        roundRecord.finishedAt = new Date().toISOString();
        saveState();
      };

      if (onPhase) onPhase({ phase: `${phasePrefix}-round${round}-review`, status: `done, must-fix=${mustFix.length}` });

      if (mustFix.length === 0) {
        // 零成功审查（全部执行失败/解析失败）≠ clean：无任何可信结论时失败收场
        // （U2 起 D3 收紧：任一 parseFail/runFail 即结构化终止）
        if (runFails.length + parseFails.length === parsedReviews.length) {
          status = 'review-failed';
          lastAction = 'review';
          remaining = [];
          closeRound();
          break;
        }
        status = 'clean'; lastAction = 'review'; remaining = [];
        closeRound();
        break;
      }

      // ── 停滞检测（D5 参数化）：must-fix 连续 stuckThreshold 轮不降 → 判定卡住 ──
      // （v1 硬编码 2；vendor updateStuckState 同语义，首轮 -1 基线不计数）
      const stuckState = updateStuckState(prevMustFix, stuckCount, mustFix.length, stuckThreshold);
      prevMustFix = stuckState.prevMustFix;
      stuckCount = stuckState.stuckCount;
      if (stuckState.stuck) { status = 'stuck'; remaining = mustFix; closeRound(); break; }

      // 检查点 ③（聚合完成后）：aborted → fix 不进行（U2 起聚合是独立 spawn 阶段，
      // 该检查点语义为「聚合结果保留、fix 不启动」）
      if (isAborted(signal)) {
        status = 'aborted'; abortedAtPhase = `${phasePrefix}-round${round}-aggregate`;
        remaining = mustFix; closeRound(); break;
      }
      // 检查点 ④（fix 启动前）：本轮聚合出的 must-fix 原样保留给报告
      if (isAborted(signal)) {
        status = 'aborted'; abortedAtPhase = `${phasePrefix}-round${round}-fix`;
        remaining = mustFix; closeRound(); break;
      }

      // ── fix ──
      if (onPhase) onPhase({ phase: `${phasePrefix}-round${round}-fix`, status: `running (${mustFix.length} 个 must-fix)` });
      const prevHead = gitHead(workdir);
      const fix = await runPhase({
        name: 'fix', label: `R${round} 修复 (${mustFix.length} 项)`,
        prompt:
          `你是审查-修复循环中的修复者。\n\n` +
          `## 审查范围\n${P.target}\n\n` +
          `## 必须修复的问题（按 id 逐条处理）\n\`\`\`json\n${issuesJsonBlock(mustFix)}\n\`\`\`\n\n` +
          `## 你的职责\n逐条修复上述问题（允许修改文件、运行命令验证）。对确实不该修/修不了的要给出理由，不要为凑数做表面修改。\n\n` +
          `## 输出格式\n以「## 修复结果」开头，逐条给出：问题 id → 已修复（怎么修的）/ 拒绝修复（理由）。不超过 500 字。`,
        cwd: workdir, modelRef, timeoutMs: timeoutMsPerPhase, signal,
      });
      phases.push(fix);
      if (onPhase) onPhase({ phase: `${phasePrefix}-round${round}-fix`, status: fix.aborted ? 'aborted' : fix.ok ? 'done' : 'failed' });
      // 检查点 ⑤（fix 完成后）：运行中 abort 时 fix 条目已被 run-phase 杀停并标记
      if (isAborted(signal)) {
        status = 'aborted'; abortedAtPhase = `${phasePrefix}-round${round}-fix`;
        remaining = mustFix; closeRound(); break;
      }
      if (!fix.ok) { status = 'fix-failed'; remaining = mustFix; closeRound(); break; }
      batchFixResponse = fix.response;
      lastAction = 'fix';
      batchHasFix = true;
      state.fixCount++; // 跨批 skip 的 fixCount 快照基准（fix 后快照失配 → 下批重派）
      lastModifiedFiles = gitModifiedSince(prevHead, workdir);
      roundRecord.modifiedFiles = lastModifiedFiles;
      closeRound();
      // v1.5 语义：fix 后这里不动 cleanNames——默认（recheckAfterFix=false）clean 维度
      // 下轮持续跳过；recheckAfterFix=true 时由下轮轮顶统一做快照 + 清空（上一轮 clean
      // 的走限定复检 prompt）。跨批方向由 fixCount 快照兜底：本批发生过 fix，下批所有
      // 维度的 clean 快照失配、全部重派。
    }

    // 批内轮数耗尽且最后一步是修复成功：问题可能已全修但未经复核，与“未收敛”区分
    if (status === 'max-rounds' && lastAction === 'fix' && remaining.length === 0) {
      status = 'fixed-unverified';
    }
    return finish();
  }

  for (let bi = 1; bi <= batchTotal; bi++) {
    // 检查点 ⓪（批间，批 bi 启动前）：前批结束后 signal 已 aborted → 后续批不启动
    if (isAborted(signal)) { status = 'aborted'; abortedAtPhase = `batch${bi}`; break; }
    const out = await runBatch(bi, P.batches[bi - 1]);
    phaseResults.push(...out.phases);
    roundSummaries.push(...out.summaries);
    totalRounds += out.rounds;
    if (out.fixResponse) runFixResponse = out.fixResponse;
    if (out.status === 'clean') { status = 'clean'; continue; } // 批 clean → 下一批（S1：批 2 只在批 1 clean 后启动）
    // 前置批非 clean（stuck/失败/aborted/max-rounds）→ 终止整个 run：后续批的审查
    // 建立在前置批的结论之上，前置失败后继续跑只会产出误导性结论（S1 通过标准）
    status = out.status;
    remaining = out.remaining;
    abortedAtPhase = out.abortedAtPhase;
    break;
  }

  if (statePath) {
    state.meta.terminated = status; // §3.4 terminated 权威源（U3 起每次 saveState 快照）
    if (status === 'aborted') state.abortedAtPhase = abortedAtPhase;
    saveState();
  }

  const roundsMd = roundSummaries.map((s) => {
    const label = multiBatchLabel(s, batchTotal);
    return `- **${label}**: ${s.detail} → must-fix ${s.mustFixCount} 个`;
  }).join('\n');
  const remainingMd = remaining.length
    ? remaining.map((i) => `- **${i.id} [${i.severity}]** ${i.title}${i.file ? `（${i.file}）` : ''}\n  ${i.detail}`).join('\n')
    : '';
  // 多批未收敛时补充批次定位（clean 无「未收敛」语义，不加）
  const batchNote = batchTotal > 1 && status !== 'clean'
    ? `（批次 ${batchTotal}，终止于批 ${lastActiveBatch(roundSummaries, batchTotal)}）`
    : '';

  const finalText = status === 'aborted'
    ? `## 已中止\n\n在 ${abortedAtPhase} 检查点收到 abort，后续阶段未启动；已完成 ${totalRounds} 轮，已启动阶段的条目保留在下方阶段表。${remaining.length ? `\n\n中止时剩余 must-fix ${remaining.length} 个（未处理）：\n${remainingMd}` : ''}`
    : status === 'review-failed'
      ? `## 审查阶段失败\n\n共 ${totalRounds} 轮，全部审查者执行失败或输出无法解析，没有任何可信审查结论——不能按 clean 处理。恢复指引：检查模型 CLI 可用性与 timeoutMsPerPhase 后重跑。`
      : status === 'clean'
      ? `## 审查通过\n\n共 ${totalRounds} 轮，所有审查者（${allDims.join('、')}）均无 must-fix 问题。\n${runFixResponse ? `\n最后一轮修复说明：\n${runFixResponse.slice(0, 1500)}` : ''}`
      : status === 'fixed-unverified'
        ? `## 已修复，待复核\n\n共 ${totalRounds} 轮，最后一轮修复已完成且未再报新 must-fix，但轮数（${maxRounds}）用尽未做复核。建议再跑一轮确认，或人工检查。\n\n最后一轮修复说明：\n${(runFixResponse || '').slice(0, 1500)}`
        : `## ${status === 'stuck' ? '修复停滞，人工接管' : status === 'fix-failed' ? '修复阶段失败' : `达到最大轮数（${maxRounds}）`}\n\n剩余 must-fix ${remaining.length} 个：\n${remainingMd}`;

  return {
    ok: status === 'clean',
    status: status === 'clean' ? 'ok' : status === 'aborted' ? 'aborted' : 'failed',
    ...(status === 'aborted' ? { abortedAtPhase } : {}),
    workflow: 'review-fix-loop',
    task: task || P.target,
    workdir, model: modelRef,
    ...(runDir ? { runDir } : {}),
    phases: phaseResults,
    final: finalText,
    sections: [
      { title: '轮次摘要', body: roundsMd || '(未产生轮次)' },
      ...(runFixResponse ? [{ title: '最后一轮修复说明', body: runFixResponse, maxChars: 2500 }] : []),
      ...(remaining.length ? [{ title: '剩余 must-fix（未解决）', body: remainingMd }] : []),
    ],
    loop: {
      status, rounds: totalRounds, reviewers: allDims, remainingCount: remaining.length,
      targetType: P.targetType, target: P.target,
      batches: batchTotal, batchNames: P.batchNames,
      ...(P.warnings.length ? { warnings: P.warnings } : {}),
    },
    ...(status === 'clean' ? {} : { error: status === 'aborted'
      ? `审查-修复循环已中止（aborted）: ${abortedAtPhase}（已完成 ${totalRounds} 轮）`
      : status === 'review-failed'
        ? `审查阶段失败：全部审查者执行失败或输出无法解析（review-failed），无可信结论`
        : status === 'fixed-unverified'
        ? `轮数用尽：最后一轮修复已完成但未经复核（fixed-unverified），建议再跑一轮确认`
        : `审查-修复循环未收敛: ${status}${batchNote}（剩余 ${remaining.length} 个 must-fix）` }),
    startedAt, finishedAt: new Date().toISOString(),
  };
}

/** 轮次摘要行标签：单批保持 v1 形态「第 N 轮」；多批加批次前缀（含全跳批的 0 轮行）。 */
function multiBatchLabel(summary, batchTotal) {
  if (batchTotal > 1) return summary.round > 0 ? `批${summary.batch}·第 ${summary.round} 轮` : `批${summary.batch}`;
  return `第 ${summary.round} 轮`;
}

/** 多批未收敛时定位终止批号（最后一个有实际轮次的批；全跳过序列取最后批）。 */
function lastActiveBatch(summaries, batchTotal) {
  const withRounds = summaries.filter((s) => s.round > 0);
  return withRounds.length ? withRounds[withRounds.length - 1].batch : batchTotal;
}

module.exports = { runReviewFixLoop, DEFAULT_REVIEWERS };
