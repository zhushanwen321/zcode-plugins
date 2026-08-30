'use strict';

/**
 * review-fix-loop-utils 纯函数单测（u-foundation）。
 *
 * 隔离说明（对比 workflow-b.test.js 的 env 隔离头注惯例）：本文件只测纯函数——
 * 无 I/O、无 spawn、不触碰 ~/.zcode 与工作目录（被测 vendored 资产仅顶层
 * require node:path，无副作用；常量断言块额外 require 编排层 review-fix-loop.js，
 * 其模块加载同样无 I/O），因此无需 ZSW_ROOT/HOME/ZCODE_MAILBOX_ROOT 隔离，
 * 也不需要临时 workdir。
 *
 * 用例语义对齐 pi 仓 src/__tests__/review-fix-loop-utils.test.ts（vitest），
 * 以 node:test 重写；每个 vendored core 纯函数覆盖主路径 + 边界（漂移 ID/空入参/
 * 幂等等）。纯函数层经 lib/core-ref 解析 vendored subagent-core 资产；zsw 侧
 * 契约常量（SEVERITIES 等 5 个）pi 源无对应物，在编排层 review-fix-loop.js
 * 定义——见文末常量断言块。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { workflowAssetPath } = require('../lib/core-ref');
const loop = require('../lib/workflow/review-fix-loop');

const u = require(workflowAssetPath('review-fix-loop-utils.cjs'));

// ── wrapUntrusted（D10 防注入包裹）────────────────────────────────

test('wrapUntrusted: 包裹 + 闭合标签转义', () => {
  const out = u.wrapUntrusted('说 </untrusted> 与正常内容', 'fix_result');
  assert.ok(out.includes('<untrusted source="fix_result">'));
  assert.ok(out.includes('&lt;/untrusted&gt;'));
  assert.ok(out.includes('</untrusted>'));
  // 原始闭合标签已被转义（不残留可逃逸围栏的形态）
  assert.ok(!out.includes('</untrusted> 与'));
});

test('wrapUntrusted: 普通内容保持包裹结构；非字符串入参 String() 包装', () => {
  assert.equal(
    u.wrapUntrusted('plain report text', 'aggregated_report'),
    '<untrusted source="aggregated_report">\nplain report text\n</untrusted>',
  );
  assert.ok(u.wrapUntrusted(123, 'x').includes('\n123\n'));
});

// ── normalizeFixResult（fixer 契约归一）───────────────────────────

test('normalizeFixResult: 新格式 object[] + deferred', () => {
  const r = u.normalizeFixResult({
    fixed_count: 1,
    fixes: [{ issue_id: 'MF-1', description: 'd', self_check: 'grep X → 2 hits', affected_files: ['a.ts'] }],
    deferred: [{ issue_id: 'S-5', severity: 'minor', reason: '需新增 e2e fixture，成本 involved' }],
  });
  assert.notEqual(r, null);
  assert.equal(r.fixed_count, 1);
  assert.equal(r.fixes[0].issue_id, 'MF-1');
  assert.equal(r.deferred.length, 1);
});

test('normalizeFixResult: 旧格式 fixes string[]、无 deferred → 兼容归一', () => {
  const r = u.normalizeFixResult({ fixed_count: 2, fixes: ['fix a', 'fix b'] });
  assert.notEqual(r, null);
  assert.deepEqual(r.fixes.map((f) => f.description), ['fix a', 'fix b']);
  assert.deepEqual(r.deferred, []);
});

test('normalizeFixResult: 围栏 json 字符串可解析（parseResult 底座）', () => {
  const raw = '```json\n{"fixed_count": 1, "fixes": [{"issue_id": "MF-1"}]}\n```';
  const r = u.normalizeFixResult(raw);
  assert.notEqual(r, null);
  assert.equal(r.fixed_count, 1);
});

test('normalizeFixResult: 畸形输入 → null（缺 fixed_count / 非 JSON / 非对象）', () => {
  assert.equal(u.normalizeFixResult({ fixes: [] }), null);
  assert.equal(u.normalizeFixResult('not json'), null);
  assert.equal(u.normalizeFixResult(42), null);
});

// ── validateFixResult（ES3 硬校验）────────────────────────────────

test('validateFixResult: deferred 显式 critical/major → 违规；minor/缺省/空 → 通过', () => {
  assert.deepEqual(
    u.validateFixResult({ fixed_count: 0, fixes: [], deferred: [{ issue_id: 'MF-3', severity: 'critical' }] }),
    [{ issue_id: 'MF-3', severity: 'critical' }],
  );
  assert.deepEqual(
    u.validateFixResult({ fixed_count: 1, fixes: [], deferred: [{ issue_id: 'S-1', severity: 'minor' }] }),
    [],
  );
  assert.deepEqual(u.validateFixResult({ fixed_count: 1, fixes: [], deferred: [{ issue_id: 'S-2' }] }), []);
  assert.deepEqual(u.validateFixResult({ fixed_count: 1, fixes: [], deferred: [] }), []);
});

test('validateFixResult: must-fix ID 大小写/尾注漂移不误杀；真漏修判违规', () => {
  assert.deepEqual(u.validateFixResult({
    fixed_count: 2,
    fixes: [{ issue_id: 'mf-1' }, { issue_id: 'MF-1 (fixed)' }],
    deferred: [],
  }, ['MF-1']), []);
  assert.deepEqual(u.validateFixResult({
    fixed_count: 1,
    fixes: [{ issue_id: 'MF-2' }],
    deferred: [],
  }, ['MF-1', 'MF-2']), [{ issue_id: 'mf-1', severity: 'must-fix-not-fixed' }]);
});

test('validateFixResult: MF-4 追踪表交叉核对——自报 minor 但追踪 major → 违规', () => {
  const tracked = { 'MF-1': { firstSeen: 1, severity: 'major', status: 'open', history: [], fixAttempts: 0 } };
  assert.deepEqual(u.validateFixResult({
    fixed_count: 0,
    fixes: [],
    deferred: [{ issue_id: 'MF-1', severity: 'minor', reason: 'cannot fix in this round' }],
  }, [], tracked), [{ issue_id: 'MF-1', severity: 'major' }]);
});

test('validateFixResult: 追踪 severity=unknown 不覆盖自报（合法 minor deferral 放行）；追踪无此 ID 采信自报', () => {
  const unknownTracked = { 'MF-9': { firstSeen: 1, severity: 'unknown', status: 'open', history: [], fixAttempts: 0 } };
  assert.deepEqual(u.validateFixResult({
    fixed_count: 0,
    fixes: [],
    deferred: [{ issue_id: 'MF-9', severity: 'minor', reason: 'low priority' }],
  }, [], unknownTracked), []);

  const noEntry = { 'MF-1': { firstSeen: 1, severity: 'major', status: 'open', history: [], fixAttempts: 0 } };
  assert.deepEqual(u.validateFixResult({
    fixed_count: 0,
    fixes: [],
    deferred: [{ issue_id: 'S-1', severity: 'minor', reason: 'needs new mechanism, high cost' }],
  }, [], noEntry), []);
});

// ── findIssueKey / normIssueId（归一键空间）───────────────────────

test('findIssueKey: 精确/大小写漂移/尾注漂移命中；未命中 undefined', () => {
  const issues = { 'MF-1': { severity: 'major' } };
  assert.equal(u.findIssueKey(issues, 'MF-1'), 'MF-1');
  assert.equal(u.findIssueKey(issues, 'mf-1'), 'MF-1');
  assert.equal(u.findIssueKey(issues, 'MF-1 (fixed)'), 'MF-1');
  assert.equal(u.findIssueKey(issues, 'MF-2'), undefined);
});

test('findIssueKey: 边界——空入参/非 string/null issues → undefined；双向漂移仍命中', () => {
  const issues = { 'MF-1': { severity: 'major' } };
  assert.equal(u.findIssueKey(issues, ''), undefined);
  assert.equal(u.findIssueKey(issues, undefined), undefined);
  assert.equal(u.findIssueKey(issues, null), undefined);
  assert.equal(u.findIssueKey(issues, 123), undefined);
  assert.equal(u.findIssueKey(null, 'MF-1'), undefined);

  const drifted = { 'MF-1 (fixed)': { severity: 'major' } };
  assert.equal(u.findIssueKey(drifted, 'mf-1'), 'MF-1 (fixed)');
  assert.equal(u.findIssueKey(drifted, 'mf-1 (by design)'), 'MF-1 (fixed)');
});

test('findIssueKey: 原型链保留键不判追踪（MF-1）——修复前空表 "__proto__" 命中 Object.prototype', () => {
  // 修复前：首行 truthy 查表让 ({})['__proto__'] 命中 Object.prototype 返回 '__proto__'，
  // 未追踪条目被误判已追踪，下游 issues[key].status 写入污染原型。
  // zsw 实际调用面是编排层的消毒包装（vendored 原版仍为 truthy 查表，待上游对齐），
  // 护栏测包装出口 loop.findIssueKey
  assert.equal(loop.findIssueKey({}, '__proto__'), undefined);
  assert.equal(loop.findIssueKey({}, 'constructor'), undefined);

  const issues = { 'MF-1': { severity: 'major' } };
  assert.equal(loop.findIssueKey(issues, '__proto__'), undefined);
  assert.equal(loop.findIssueKey(issues, 'constructor'), undefined);
  assert.equal(loop.findIssueKey(issues, 'prototype'), undefined);
  // 原型链无污染、漂移容忍不受影响（"只换首行查表"的回归护栏）
  assert.equal(Object.keys(issues).length, 1);
  assert.equal(loop.findIssueKey(issues, 'mf-1'), 'MF-1');
  assert.equal(loop.findIssueKey(issues, 'MF-1 (fixed)'), 'MF-1');
});

test('normIssueId: 大小写/尾注/trim 归一；空与非字符串兜底', () => {
  assert.equal(u.normIssueId('MF-1 (fixed)'), 'mf-1');
  assert.equal(u.normIssueId('MF-1(fixed)'), 'mf-1'); // 尾注紧贴无空格
  assert.equal(u.normIssueId(' MF-1 '), 'mf-1');
  assert.equal(u.normIssueId('MF-1 (a) (b)'), 'mf-1 (a)'); // 只剥最后一个尾注
  assert.equal(u.normIssueId(''), '');
  assert.equal(u.normIssueId(null), '');
  assert.equal(u.normIssueId(undefined), '');
  assert.equal(u.normIssueId(123), '123');
});

// ── reconcileIssues（对账状态机）──────────────────────────────────

test('reconcileIssues: fix-attempted 未再现 → fixed；再现 → regressed + fixAttempts+1', () => {
  const prev = {
    'MF-1': { firstSeen: 1, status: 'fix-attempted', fixAttempts: 0, history: [] },
    'MF-2': { firstSeen: 1, status: 'fix-attempted', fixAttempts: 0, history: [] },
  };
  const r = u.reconcileIssues(prev, { seenIds: new Set(['MF-2']), round: 2, stuckThreshold: 3 });
  assert.equal(r.issues['MF-1'].status, 'fixed');
  assert.equal(r.issues['MF-2'].status, 'regressed');
  assert.equal(r.issues['MF-2'].fixAttempts, 1);
  assert.equal(r.stuck, false);
  // 首次 regressed（fixAttempts=1）不触发 needs-redesign（生产 0 起点）
  assert.deepEqual(u.findNeedsRedesign(r.issues, 2), []);
});

test('reconcileIssues: 空 seenIds 下 fix-attempted 全转 fixed（M2 门控回归）', () => {
  const prev = {
    'MF-1': { firstSeen: 1, status: 'fix-attempted', fixAttempts: 0, openStreak: 0, history: [] },
    'MF-2': { firstSeen: 1, status: 'fix-attempted', fixAttempts: 0, openStreak: 0, history: [] },
  };
  const r = u.reconcileIssues(prev, { seenIds: new Set(), escalateIds: new Set(), round: 2, stuckThreshold: 3 });
  assert.equal(r.issues['MF-1'].status, 'fixed');
  assert.equal(r.issues['MF-2'].status, 'fixed');
  assert.equal(r.issues['MF-2'].history.at(-1).status, 'fixed');
  assert.equal(r.stuck, false);
  assert.deepEqual(r.knownRemaining, []);
});

test('reconcileIssues: 同一 ID 连续 N 轮 → stuck；新 ID 首现 → open + firstSeen', () => {
  const prev = {
    'MF-1': { firstSeen: 1, status: 'regressed', fixAttempts: 2, openStreak: 2, history: [] },
  };
  const r = u.reconcileIssues(prev, { seenIds: new Set(['MF-1']), round: 3, stuckThreshold: 3 });
  assert.equal(r.stuck, true);
  assert.deepEqual(r.stuckIds, ['MF-1']);
  assert.equal(r.issues['MF-1'].openStreak, 3);

  // 计数升降但 ID 不同 → 不 stuck（churn 盲区）
  const churn = u.reconcileIssues({
    'MF-1': { firstSeen: 1, status: 'fix-attempted', fixAttempts: 1, history: [] },
    'MF-2': { firstSeen: 1, status: 'fix-attempted', fixAttempts: 1, history: [] },
  }, { seenIds: new Set(['MF-3']), round: 2, stuckThreshold: 3 });
  assert.equal(churn.stuck, false);
  assert.equal(churn.issues['MF-3'].status, 'open');
  assert.equal(churn.issues['MF-3'].firstSeen, 2);
});

test('reconcileIssues: "__proto__" 入 seenIds 不产生自有键、不改写原型（MF-1）', () => {
  // 常规路径由调用侧 safeIssueKey 入口消毒保证危险键不达此；本测试锁定 vendor 侧
  // 兜底语义——普通对象表的原型链 truthy 读会跳过危险键，不得产生写点污染
  const r = u.reconcileIssues({}, { seenIds: ['__proto__'], round: 1, stuckThreshold: 3 });
  assert.deepEqual(Object.keys(r.issues), []);
  assert.equal(Object.getPrototypeOf(r.issues), Object.prototype);
  assert.equal(r.stuck, false);
});

test('reconcileIssues: deferred 留 known-remaining；escalate 声明 → 重新 open', () => {
  const prev = {
    'S-1': { firstSeen: 1, status: 'deferred', deferredReason: '需 e2e fixture', fixAttempts: 0, history: [] },
  };
  const keep = u.reconcileIssues(prev, { seenIds: new Set(), round: 2, stuckThreshold: 3 });
  assert.deepEqual(keep.knownRemaining, ['S-1: 需 e2e fixture']);
  assert.equal(keep.issues['S-1'].status, 'deferred');
  assert.equal(keep.stuck, false);

  const escalated = u.reconcileIssues(prev, { seenIds: new Set(), escalateIds: new Set(['S-1']), round: 3, stuckThreshold: 3 });
  assert.equal(escalated.issues['S-1'].status, 'open');
  assert.equal(escalated.issues['S-1'].history.at(-1).status, 'escalated');
  assert.deepEqual(escalated.knownRemaining, []);
});

test('reconcileIssues: fixed 复发 → regressed（MF-2）；未再报保持 fixed', () => {
  const prev = {
    'MF-1': { firstSeen: 1, status: 'fixed', fixAttempts: 1, openStreak: 0, history: [{ round: 2, status: 'fixed' }] },
  };
  const relapsed = u.reconcileIssues(prev, { seenIds: new Set(['MF-1']), round: 3, stuckThreshold: 3 });
  assert.equal(relapsed.issues['MF-1'].status, 'regressed');
  assert.equal(relapsed.issues['MF-1'].fixAttempts, 2);
  assert.equal(relapsed.issues['MF-1'].openStreak, 1);
  assert.equal(relapsed.issues['MF-1'].history.at(-1).status, 'regressed');
  // 复发达 maxFixAttempts → needs-redesign 可达
  assert.deepEqual(u.findNeedsRedesign(relapsed.issues, 2).map((x) => x.issue_id), ['MF-1']);

  const kept = u.reconcileIssues(prev, { seenIds: new Set(), round: 3, stuckThreshold: 3 });
  assert.equal(kept.issues['MF-1'].status, 'fixed');
  assert.equal(kept.issues['MF-1'].fixAttempts, 1);
  assert.equal(kept.issues['MF-1'].openStreak, 0);
});

// ── checkConvergence（收敛判定）───────────────────────────────────

test('checkConvergence: 连续达阈 → converged；单轮不足 → 不收敛；超阈 → streak 重置', () => {
  assert.deepEqual(
    u.checkConvergence({ prevStreak: 1, newFindings: 1, convergeNewIssues: 1, convergeRounds: 2 }),
    { converged: true, streak: 2 },
  );
  assert.deepEqual(
    u.checkConvergence({ prevStreak: 0, newFindings: 1, convergeNewIssues: 1, convergeRounds: 2 }),
    { converged: false, streak: 1 },
  );
  assert.deepEqual(
    u.checkConvergence({ prevStreak: 1, newFindings: 3, convergeNewIssues: 1, convergeRounds: 2 }),
    { converged: false, streak: 0 },
  );
  assert.deepEqual(
    u.checkConvergence({ prevStreak: 0, newFindings: 0, convergeNewIssues: 1, convergeRounds: 1 }),
    { converged: true, streak: 1 },
  );
});

test('checkConvergence: critical 新发现 → 不收敛且 streak 重置', () => {
  assert.deepEqual(
    u.checkConvergence({ prevStreak: 1, newFindings: 1, newFindingsCritical: 1, convergeNewIssues: 1, convergeRounds: 2 }),
    { converged: false, streak: 0 },
  );
  assert.deepEqual(
    u.checkConvergence({ prevStreak: 1, newFindings: 0, newFindingsCritical: 1, convergeNewIssues: 1, convergeRounds: 2 }),
    { converged: false, streak: 0 },
  );
});

// ── findNeedsRedesign（RC-7）──────────────────────────────────────

test('findNeedsRedesign: fixAttempts >= max 且 regressed → 命中；fixed/未达阈/空集 → []', () => {
  const r = u.findNeedsRedesign({
    'MF-1': { status: 'regressed', fixAttempts: 2, history: [{ round: 1, status: 'open' }] },
    'MF-2': { status: 'regressed', fixAttempts: 1, history: [] },
    'MF-3': { status: 'fixed', fixAttempts: 2, history: [] },
  }, 2);
  assert.deepEqual(r.map((x) => x.issue_id), ['MF-1']);
  assert.deepEqual(u.findNeedsRedesign({}, 2), []);
  assert.deepEqual(u.findNeedsRedesign({ 'MF-1': { status: 'open', fixAttempts: 0 } }, 2), []);
});

// ── computeKnownRemaining（known-remaining 生成）──────────────────

test('computeKnownRemaining: deferred → "ID: reason"；无 reason 仅 ID', () => {
  const issues = {
    'S-1': { status: 'deferred', deferredReason: '需 e2e fixture' },
    'S-2': { status: 'deferred' },
    'MF-1': { status: 'open' },
    'MF-2': { status: 'fixed' },
  };
  assert.deepEqual(u.computeKnownRemaining(issues), ['S-1: 需 e2e fixture', 'S-2']);
});

test('computeKnownRemaining: 空/无 deferred → []；null 入参安全', () => {
  assert.deepEqual(u.computeKnownRemaining({}), []);
  assert.deepEqual(u.computeKnownRemaining({ 'MF-1': { status: 'open' } }), []);
  assert.deepEqual(u.computeKnownRemaining(null), []);
  assert.deepEqual(u.computeKnownRemaining(undefined), []);
});

// ── recordDormant / filterActiveIds（dormant 落盘 + 消费过滤）─────

const DORMANT_ENTRIES = [
  { id: 'MF-1', severity: 'major', adjudication: 'evidence' },
  { id: 'MF-D1', severity: 'major', adjudication: 'downgraded', note: 'no reproducible evidence', evidence: 'cited src/a.ts' },
  { id: 'MF-U1', severity: 'major', adjudication: 'unverified', evidence: 'claims test failure' },
];

test('recordDormant: 降级条目落盘（detail note 优先/evidence 兜底）；evidence 裁决不落', () => {
  const dormant = u.recordDormant([], DORMANT_ENTRIES, 1);
  assert.equal(dormant.length, 2);
  assert.deepEqual(dormant[0], {
    id: 'MF-D1', reason: 'adjudication-downgraded',
    detail: 'no reproducible evidence', round: 1, revived: false,
  });
  assert.deepEqual(dormant[1], {
    id: 'MF-U1', reason: 'adjudication-unverified',
    detail: 'claims test failure', round: 1, revived: false,
  });
});

test('recordDormant: 同 id 幂等（round/detail 更新，revived 保持）；纯函数不改入参；excludeIds 剔除活跃 id', () => {
  const first = u.recordDormant([], DORMANT_ENTRIES, 1);
  first[0].revived = true; // 模拟已复活
  const again = u.recordDormant(first, [
    { id: 'MF-D1', severity: 'major', adjudication: 'downgraded', note: 'still weak' },
  ], 3);
  assert.equal(again.length, 2);
  assert.equal(again[0].id, 'MF-D1');
  assert.equal(again[0].round, 3);
  assert.equal(again[0].detail, 'still weak');
  assert.equal(again[0].revived, true);
  // 纯函数：输入数组未被修改
  assert.equal(first[0].round, 1);
  assert.equal(first[0].detail, 'no reproducible evidence');

  // excludeIds（state.issues 活跃追踪的 id）不落 dormant
  const excluded = u.recordDormant([], DORMANT_ENTRIES, 1, new Set(['MF-D1']));
  assert.deepEqual(excluded.map((d) => d.id), ['MF-U1']);
  // 数组形态的 excludeIds 同样生效
  assert.deepEqual(u.recordDormant([], DORMANT_ENTRIES, 1, ['MF-U1']).map((d) => d.id), ['MF-D1']);
});

test('filterActiveIds: 剔除 downgraded/unverified；无 adjudication 全保留；空/undefined → []', () => {
  assert.deepEqual(u.filterActiveIds(DORMANT_ENTRIES), ['MF-1']);
  assert.deepEqual(u.filterActiveIds([{ id: 'X' }, { id: 'Y', adjudication: 'evidence' }]), ['X', 'Y']);
  assert.deepEqual(u.filterActiveIds([]), []);
  assert.deepEqual(u.filterActiveIds(undefined), []);
});

// ── recordAgentClean / recordAgentDirty / shouldSkipAgent（跨批 skip）──

function freshState() {
  return { agentStatus: {}, fixCount: 0 };
}

test('recordAgentClean: 写入 lastCleanBatch + 当时 fixCount 快照；再次 clean 覆盖旧快照', () => {
  const state = freshState();
  state.fixCount = 3;
  u.recordAgentClean(state, 'reviewer', 2);
  assert.deepEqual(state.agentStatus.reviewer, {
    lastCleanBatch: 2, lastCleanFixCount: 3, lastActiveRound: 2, lastMustFix: undefined,
  });
  state.fixCount = 5;
  u.recordAgentClean(state, 'reviewer', 4);
  assert.equal(state.agentStatus.reviewer.lastCleanFixCount, 5);
  assert.equal(state.agentStatus.reviewer.lastCleanBatch, 4);
});

test('recordAgentDirty: 写 lastActiveRound/lastMustFix，不动 clean 快照；无记录时新建', () => {
  const state = freshState();
  u.recordAgentClean(state, 'reviewer', 1);
  state.fixCount = 1;
  u.recordAgentDirty(state, 'reviewer', 4, 2);
  const s = state.agentStatus.reviewer;
  assert.equal(s.lastActiveRound, 2);
  assert.equal(s.lastMustFix, 4);
  assert.equal(s.lastCleanBatch, 1);
  assert.equal(s.lastCleanFixCount, 0); // 快照保持 clean 记录时点，不被 dirty 覆盖

  const fresh = freshState();
  u.recordAgentDirty(fresh, 'other', 0, 1);
  assert.deepEqual(fresh.agentStatus.other, {
    lastCleanBatch: 0, lastCleanFixCount: 0, lastActiveRound: 1, lastMustFix: 0,
  });
});

test('shouldSkipAgent: clean 后无 fix → 跳过（含更晚批次）；发生 fix → 不跳过', () => {
  const status = { lastCleanBatch: 1, lastCleanFixCount: 2, lastActiveRound: 1, lastMustFix: undefined };
  assert.equal(u.shouldSkipAgent(status, 2, 2), true);
  assert.equal(u.shouldSkipAgent(status, 2, 3), true);
  assert.equal(u.shouldSkipAgent(status, 3, 2), false);
});

test('shouldSkipAgent: 边界——无记录/从未 clean/同批 clean → 不跳过；生命周期协同', () => {
  assert.equal(u.shouldSkipAgent(undefined, 0, 2), false);
  assert.equal(u.shouldSkipAgent(
    { lastCleanBatch: 0, lastCleanFixCount: 0, lastActiveRound: 0, lastMustFix: undefined }, 0, 2,
  ), false);
  assert.equal(u.shouldSkipAgent(
    { lastCleanBatch: 2, lastCleanFixCount: 0, lastActiveRound: 2, lastMustFix: undefined }, 0, 2,
  ), false);

  // clean → dirty → fix → clean 生命周期：快照与跳过判定协同
  const state = freshState();
  u.recordAgentClean(state, 'r', 1); // batch1 clean，快照 fixCount=0
  state.fixCount = 1; // fix 发生
  assert.equal(u.shouldSkipAgent(state.agentStatus.r, state.fixCount, 2), false);
  u.recordAgentDirty(state, 'r', 5, 2);
  state.fixCount = 2;
  u.recordAgentClean(state, 'r', 2); // batch2 末 clean，快照 fixCount=2
  assert.equal(u.shouldSkipAgent(state.agentStatus.r, state.fixCount, 3), true);
});

// ── updateStuckState（stuck 检测）─────────────────────────────────

test('updateStuckState: must_fix 连续不降达阈值 → 第 N 轮 stuck；首轮基线不计数', () => {
  let s = u.updateStuckState(-1, 0, 5, 3);
  assert.equal(s.stuck, false);
  assert.equal(s.stuckCount, 0); // 首轮只记基线
  assert.equal(s.prevMustFix, 5);
  s = u.updateStuckState(s.prevMustFix, s.stuckCount, 5, 3);
  assert.equal(s.stuck, false);
  assert.equal(s.stuckCount, 1);
  s = u.updateStuckState(s.prevMustFix, s.stuckCount, 5, 3);
  assert.equal(s.stuck, false);
  assert.equal(s.stuckCount, 2);
  s = u.updateStuckState(s.prevMustFix, s.stuckCount, 5, 3);
  assert.equal(s.stuck, true);
  assert.equal(s.stuckCount, 3);
});

test('updateStuckState: 下降重置后重新累计（[5,4,4,4] 第 4 轮 stuck）；阈值=1 与负基线边界', () => {
  let s = u.updateStuckState(-1, 0, 5, 3);
  s = u.updateStuckState(s.prevMustFix, s.stuckCount, 4, 3); // 5→4 下降
  assert.equal(s.stuckCount, 0);
  assert.equal(s.prevMustFix, 4);
  s = u.updateStuckState(s.prevMustFix, s.stuckCount, 4, 3);
  assert.equal(s.stuckCount, 1);
  s = u.updateStuckState(s.prevMustFix, s.stuckCount, 4, 3);
  assert.equal(s.stuckCount, 2);
  s = u.updateStuckState(s.prevMustFix, s.stuckCount, 4, 3);
  assert.equal(s.stuck, true);

  assert.equal(u.updateStuckState(5, 0, 5, 1).stuck, true);
  assert.equal(u.updateStuckState(5, 0, 4, 1).stuck, false);
  // prevMustFix 负数（首轮基线）永不触发
  assert.equal(u.updateStuckState(-1, 999, 0, 1).stuck, false);
  assert.equal(u.updateStuckState(-1, 999, 0, 1).stuckCount, 0);
});

// ── zsw 侧契约常量（pi/core 源无对应物，新家在编排层 review-fix-loop.js）──

test('契约常量: TERMINAL_STATUSES 对齐设计 §3.4 十值终态枚举', () => {
  assert.deepEqual(loop.TERMINAL_STATUSES, [
    'clean', 'converged', 'stuck', 'needs-redesign', 'max-rounds',
    'fixed-unverified', 'review-failed', 'fix-failed', 'aggregator-failure', 'aborted',
  ]);
});

test('契约常量: ISSUE_STATUSES 五值；severity 集合与排序权重一致', () => {
  assert.deepEqual(loop.ISSUE_STATUSES, ['open', 'fix-attempted', 'fixed', 'regressed', 'deferred']);
  assert.deepEqual(loop.SEVERITIES, ['critical', 'major', 'minor']);
  assert.deepEqual(loop.MUST_FIX_SEVERITIES, ['critical', 'major']);
  assert.ok(loop.SEVERITY_RANK.critical > loop.SEVERITY_RANK.major);
  assert.ok(loop.SEVERITY_RANK.major > loop.SEVERITY_RANK.minor);
});
