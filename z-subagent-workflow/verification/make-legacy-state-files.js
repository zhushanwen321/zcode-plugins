#!/usr/bin/env node
'use strict';
/**
 * V0d fixture：workflow-state 历史文件种子脚本（设计 zsw-sink-adoption-design.md
 * §4 S5② 验收场景用）。
 *
 * 用法：node verification/make-legacy-state-files.js <outDir> [--v]
 *   无 --v：在 <outDir>/workflow-state/ 生成 10 个「改造前格式」文件（无版本标记）
 *   带 --v：生成全部 25 个（10 无 v + 15 带 wf-run-v2 版本标记）
 *
 * 快照行真实字段结构（照抄核实结果，非凭空构造）：
 *   - 文件形态：<dataRoot>/workflow-state/<runId>.jsonl，JSONL append-only，
 *     每行一条完整快照（lib/orchestration-host.js 头注 + vendored core
 *     dist/index.cjs FileRunStore.save → toSnapshot）。
 *   - 行结构 = { runId, spec, state, meta }（toSnapshot 投影，budgetRef 剥离）：
 *     · runId：generateRunId 形态 `wf-<Date.now()>-<4位36进制>`
 *     · spec：buildSpec 产物 { scriptSource, args, model, budgetTimeMs,
 *       scriptName, scriptPath, description, parameters }
 *     · state：{ status, reason, budget, calls, trace, errorLogs, error,
 *       scriptResult }。status 枚举仅 'running' | 'done'——core 状态机
 *       （VALID_RUN_TRANSITIONS）没有独立 error 态，错误终态的真实形态是
 *       status:'done' + reason:'failed' + state.error 非空（任务描述中
 *       「error 终态」按此实现；若造 status:'error' 行，fromSnapshot 形状
 *       校验会拒绝整行——这正是本脚本不这么造的原因，登记为对任务描述的
 *       事实纠偏）
 *     · budget：{ maxTokens?, maxCost?, maxTimeMs?, usedTokens, usedCost,
 *       totalCallCount }（toBudgetSnapshot；maxTokens 等未配置时 undefined，
 *       JSON.stringify 后 key 缺席——真实落盘即如此，脚本按同样规律省略）
 *     · calls 元素：{ id, opts, status, attempts, result?, sessionId?,
 *       sessionFile?, traceNode }；fromSnapshot 要求 id 为 number 且
 *       traceNode.stepIndex 能在 trace 数组中找到同值节点，否则该 call
 *       被静默跳过
 *     · trace 节点：{ stepIndex, agent, task, model, status, startedAt,
 *       phase? }（trace.append 构造点；live 字段现无赋值点，真实落盘无此
 *       字段——姊妹文档 D4「strip live 属落盘字节变化：live 字段现无赋值点」）
 *     · meta：{ startedAt, completedAt? }（runWorkflow 创建点 + transition
 *       时写入 completedAt）
 *   - 读取语义（fromSnapshot 形状校验，宽容读边界）：runId 非空 string、
 *     spec/state/meta 为 object、status ∈ {running, done}、budget 为
 *     object、calls/trace 为 Array；不满足则 warn 并跳过该行。
 *
 * 版本标记（姊妹文档 subagent-core-sink-design.md §3.3 D4 裁决）：
 *   版本字符串 `wf-run-v2`（沿用 pi JsonlRunStore 现有 SNAPSHOT_VERSION，
 *   字段名为行对象顶层 `v`）。存量无 v 行按「缺版本 = 当前版本」宽容读、
 *   不迁移；guard 语义 = v 不匹配当前版本跳过该行 + warn。
 *   降级判定：HEAD 态 reader（fromSnapshot）不检查 v 字段，带 v 行的额外
 *   key 对形状校验无影响——带 v 的 15 个文件与 10 个无 v 文件同目录混排、
 *   均可被现状 reader 读取，无需「独立子目录」降级形态。
 *
 * 状态分布（25 文件，前 10 个为无 v 组、后 15 个为带 v 组，两组内各有代表性）：
 *   done/completed 10 · done/failed 6 · done/budget_limited 2 ·
 *   done/time_limited 1 · running 崩溃遗留 3 · running 执行中 3
 *   崩溃遗留 running（daemon 被杀时的存量）供 recoverOrphans 场景复用：
 *   loadAll 重水合后由宿主标终态 failed（HEAD orchestration-host.js
 *   recoverOrphans：error='daemon takeover: worker died with previous
 *   process' + transition('done','failed')）。
 *
 * 幂等：目标 workflow-state 目录已存在时先清空重建（只删
 * <outDir>/workflow-state 这一个目录，不触碰 outDir 下其他内容）。
 * 内容确定性：runId 与全部时间戳由固定基线推导，不取 Date.now()，
 * 重复生成逐字节一致，便于验收 diff。
 */

const fs = require('node:fs');
const path = require('node:path');

/** D4 裁决版本字符串（= pi JsonlRunStore SNAPSHOT_VERSION）。 */
const SNAPSHOT_VERSION = 'wf-run-v2';

/** startedAt 基线与步长（固定值保证幂等：2026-08-20T08:00:00Z 起每 run +7min）。 */
const BASE_MS = Date.UTC(2026, 7, 20, 8, 0, 0);
const STEP_MS = 7 * 60 * 1000;

/** 无 v 组（前 10）/ 带 v 组（后 15）的统一排片表。
 *  kind ∈ completed|failed|budget_limited|time_limited|running；
 *  flag：crashed = 崩溃遗留 running；active = 执行中 running；
 *  calls = 快照带非空 calls+trace。 */
const PLAN = [
  // ── 无 v 组（改造前格式，10 个）──
  { script: 'chain',           kind: 'completed' },
  { script: 'parallel',        kind: 'completed' },
  { script: 'map-reduce',      kind: 'failed' },
  { script: 'review-fix-loop', kind: 'running', flag: 'crashed' },
  { script: 'scatter-gather',  kind: 'budget_limited' },
  { script: 'chain',           kind: 'completed', flag: 'calls' },
  { script: 'parallel',        kind: 'failed' },
  { script: 'map-reduce',      kind: 'running', flag: 'active', withCalls: true },
  { script: 'review-fix-loop', kind: 'completed' },
  { script: 'scatter-gather',  kind: 'failed' },
  // ── 带 v 组（15 个）──
  { script: 'chain',           kind: 'completed' },
  { script: 'parallel',        kind: 'completed' },
  { script: 'map-reduce',      kind: 'failed' },
  { script: 'review-fix-loop', kind: 'running', flag: 'crashed' },
  { script: 'scatter-gather',  kind: 'running', flag: 'crashed' },
  { script: 'chain',           kind: 'time_limited' },
  { script: 'parallel',        kind: 'completed', flag: 'calls' },
  { script: 'map-reduce',      kind: 'running', flag: 'active', withCalls: true },
  { script: 'review-fix-loop', kind: 'completed' },
  { script: 'scatter-gather',  kind: 'failed' },
  { script: 'chain',           kind: 'completed' },
  { script: 'parallel',        kind: 'failed' },
  { script: 'map-reduce',      kind: 'running', flag: 'active' },
  { script: 'review-fix-loop', kind: 'completed', flag: 'calls' },
  { script: 'scatter-gather',  kind: 'budget_limited' },
];

const TASK_TEXTS = {
  'chain': 'V0d fixture：三段串联编排的历史 run（fixture 数据，非真实执行）',
  'parallel': 'V0d fixture：并行扇出编排的历史 run（fixture 数据，非真实执行）',
  'map-reduce': 'V0d fixture：map-reduce 历史运行（fixture 数据，非真实执行）',
  'review-fix-loop': 'V0d fixture：审查修复循环历史 run（fixture 数据，非真实执行）',
  'scatter-gather': 'V0d fixture：scatter-gather 历史运行（fixture 数据，非真实执行）',
};

/** runId 形态对齐 generateRunId：`wf-<ms>-<4位36进制>`，数值全部确定性推导。 */
function runIdAt(i) {
  const rand36 = (46656 + i * 97).toString(36); // 36^3..36^4 区间内 → 恒 4 字符
  return `wf-${BASE_MS + i * STEP_MS}-${rand36}`;
}

function isoAt(i, offsetMs) {
  return new Date(BASE_MS + i * STEP_MS + offsetMs).toISOString();
}

/** trace 节点（trace.append 构造点字段；live 字段现无赋值点故省略）。 */
function traceNode(i, callId, agent, status, startedIso) {
  return {
    stepIndex: callId,
    agent,
    task: TASK_TEXTS[agent === 'explorer' ? 'chain' : 'parallel'] || TASK_TEXTS.chain,
    model: 'default',
    status,
    startedAt: startedIso,
  };
}

/** 非空 calls+trace 样例（fromSnapshot 约束：call.id 为 number 且
 *  traceNode.stepIndex 在 trace 中有同值节点）。 */
function buildCallsAndTrace(entry, i) {
  const doneStart = isoAt(i, 30 * 1000);
  const node = traceNode(i, 1, 'explorer', entry.kind === 'running' ? 'running' : 'done', doneStart);
  const call = {
    id: 1,
    opts: { prompt: TASK_TEXTS[entry.script], model: undefined },
    status: entry.kind === 'running' ? 'running' : 'done',
    attempts: 1,
    sessionId: `fixture-session-${runIdAt(i)}`,
  };
  if (call.status === 'done') {
    call.result = { content: 'fixture: agent call completed (synthetic)' };
  }
  call.traceNode = node;
  return { calls: [call], trace: [node] };
}

/** 按排片表构造单条快照对象（withV=true 时补行顶层 v 字段）。 */
function buildSnapshot(entry, i, withV) {
  const runId = runIdAt(i);
  const started = isoAt(i, 0);
  const isRunning = entry.kind === 'running';

  const state = {
    status: isRunning ? 'running' : 'done',
    budget: {
      // maxTokens 按真实落盘规律：未配置 budgetTokens 时 key 缺席
      maxTokens: i % 2 === 0 ? 200000 : undefined,
      maxTimeMs: 600000,
      usedTokens: isRunning ? 3412 : (entry.kind === 'budget_limited' ? 200000 : 52340),
      usedCost: isRunning ? 0.021 : (entry.kind === 'budget_limited' ? 1.2 : 0.314),
      totalCallCount: entry.flag === 'calls' || entry.withCalls ? 1 : 3,
    },
    calls: [],
    trace: [],
    errorLogs: [],
  };

  if (entry.flag === 'calls' || entry.withCalls) {
    const { calls, trace } = buildCallsAndTrace(entry, i);
    state.calls = calls;
    state.trace = trace;
  }

  // 终态字段（running 快照无 reason/error/scriptResult——runWorkflow 创建形态）
  if (entry.kind === 'completed') {
    state.reason = 'completed';
    state.scriptResult = { ok: true, summary: `fixture: ${entry.script} completed (synthetic)` };
  } else if (entry.kind === 'failed') {
    state.reason = 'failed';
    // 错误终态真实形态：reason:'failed' + state.error 非空（无独立 error status）
    state.error = `fixture synthetic failure in ${entry.script}: subtask 2 exited non-zero`;
    state.errorLogs = [
      { level: 'error', args: [`[fixture] worker log: ${entry.script} subtask failed`] },
    ];
  } else if (entry.kind === 'budget_limited') {
    state.reason = 'budget_limited';
    state.error = 'Budget exceeded';
  } else if (entry.kind === 'time_limited') {
    state.reason = 'time_limited';
    state.error = 'Time budget exhausted (600000 ms wall clock) before retry rebuild';
  }

  const spec = {
    // 真实落盘为脚本源码；fixture 不执行，占位即可
    scriptSource: '// fixture: legacy workflow-state seed (synthetic, not executable)',
    args: { task: TASK_TEXTS[entry.script] },
    model: i % 2 === 0 ? 'builtin:bigmodel-coding-plan/GLM-5.3' : undefined,
    budgetTimeMs: 600000,
    scriptName: entry.script,
    // scriptPath 对齐 vendored 内置资产真实路径形态
    scriptPath: path.join(__dirname, '..', 'lib', 'vendor', 'subagent-core', 'workflows', `${entry.script}.js`),
    description: `fixture seeded legacy run of ${entry.script}`,
    parameters: undefined,
  };

  const meta = { startedAt: started };
  if (!isRunning) meta.completedAt = isoAt(i, 4 * 60 * 1000);

  const snap = { runId, spec, state, meta };
  if (withV) snap.v = SNAPSHOT_VERSION; // D4：行对象顶层 v 字段
  return snap;
}

function main() {
  const argv = process.argv.slice(2);
  const withV = argv.includes('--v');
  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length !== 1 || !positional[0]) {
    process.stderr.write(
      '用法: node verification/make-legacy-state-files.js <outDir> [--v]\n'
      + '  <outDir>  目标根目录，将在其下创建/重建 workflow-state/\n'
      + '  --v       额外生成 15 个带 wf-run-v2 版本标记的文件（共 25 个）\n'
      + '示例: node verification/make-legacy-state-files.js /tmp/v0d-check --v\n'
    );
    process.exit(2);
  }
  const outDir = path.resolve(positional[0]);
  const stateDir = path.join(outDir, 'workflow-state');

  // 幂等：只清自己创建的 workflow-state 目录，不触碰 outDir 其他内容
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const count = withV ? PLAN.length : 10;
  const written = [];
  for (let i = 0; i < count; i++) {
    const entry = PLAN[i];
    // 前 10 个恒为改造前格式（无 v）；带 v 组 = PLAN[10..24]，仅 --v 时生成
    const snap = buildSnapshot(entry, i, withV && i >= 10);
    const file = path.join(stateDir, `${snap.runId}.jsonl`);
    fs.writeFileSync(file, JSON.stringify(snap) + '\n', 'utf8');
    written.push({ i, file: path.basename(file), entry, runId: snap.runId });
  }

  // stdout 摘要（人读 CLI 输出，非 MCP 通道）
  process.stdout.write(`written ${written.length} file(s) -> ${stateDir}\n`);
  process.stdout.write(`version-tagged(v=${SNAPSHOT_VERSION}): ${withV ? 15 : 0}, legacy(no v): ${withV ? 10 : 10}\n`);
  for (const w of written) {
    const st = w.entry.kind === 'running' ? `running/${w.entry.flag}` : `done/${w.entry.kind}`;
    const v = withV && w.i >= 10 ? 'v2' : 'no-v';
    process.stdout.write(`  [${String(w.i).padStart(2, '0')}] ${w.file}  ${v}  ${st}${w.entry.withCalls ? ' +calls' : ''}\n`);
  }
}

main();
