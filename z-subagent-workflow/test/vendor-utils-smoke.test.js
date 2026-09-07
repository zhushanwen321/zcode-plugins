'use strict';

/**
 * vendored review-fix-loop-utils 本地冒烟锚（pr-cr-fix S-3）：
 * validateFixResult / reconcileIssues 两个纯函数此前在本仓零本地执行覆盖，
 * vendor 刷新带入回归时 sha 自检不报，最快要 e2e 才发现。此处各做黄金场景
 * 断言，作为 vendor 刷新后的本地快速回归锚（非全量行为规格——那归上游仓）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const utils = require(path.join(__dirname, '..', 'lib', 'vendor', 'subagent-core',
  'workflows', 'review-fix-loop-utils.cjs'));

// ------------------------------------------------------------ validateFixResult

test('validateFixResult：must-fix 全进 fixes[] 且无 deferred → 零违规', () => {
  const result = { fixed_count: 1, fixes: [{ issue_id: 'MF-1' }] };
  const violations = utils.validateFixResult(result, ['MF-1']);
  assert.deepEqual(violations, []);
});

test('validateFixResult：must-fix 漏修 → must-fix-not-fixed 违规', () => {
  const result = { fixed_count: 0, fixes: [] };
  const violations = utils.validateFixResult(result, ['MF-1', 'MF-2']);
  assert.equal(violations.length, 2);
  assert.ok(violations.every((v) => v.severity === 'must-fix-not-fixed'));
});

test('validateFixResult：deferred critical → 违规（deferred 只允许 minor/trivial）', () => {
  const result = {
    fixed_count: 0,
    fixes: [],
    deferred: [{ issue_id: 'MF-9', severity: 'critical', reason: 'x' }],
  };
  const violations = utils.validateFixResult(result, []);
  assert.ok(violations.some((v) => v.issue_id === 'MF-9'));
});

// ------------------------------------------------------------ reconcileIssues

test('reconcileIssues：fix-attempted 未再现 → fixed；再现 → regressed；新 ID → open', () => {
  const prev = {
    A: { firstSeen: 1, severity: 'major', status: 'fix-attempted', openStreak: 1, history: [], fixAttempts: 1 },
    B: { firstSeen: 1, severity: 'major', status: 'fix-attempted', openStreak: 1, history: [], fixAttempts: 1 },
  };
  const out = utils.reconcileIssues(prev, { seenIds: ['B', 'NEW'], fixedIds: [], round: 2, stuckThreshold: 3 });
  assert.equal(out.issues.A.status, 'fixed');
  assert.equal(out.issues.B.status, 'regressed');
  assert.equal(out.issues.B.fixAttempts, 2);
  assert.equal(out.issues.NEW.status, 'open');
  assert.equal(out.issues.NEW.firstSeen, 2);
  assert.equal(out.stuck, false);
  // knownRemaining 只列 deferred 条目（computeKnownRemaining 语义），本场景无 deferred
  assert.deepEqual(out.knownRemaining, []);
});

test('reconcileIssues：openStreak 达阈值 → stuck', () => {
  const prev = {
    X: { firstSeen: 1, severity: 'minor', status: 'open', openStreak: 2, history: [], fixAttempts: 0 },
  };
  const out = utils.reconcileIssues(prev, { seenIds: ['X'], fixedIds: [], round: 3, stuckThreshold: 3 });
  assert.equal(out.stuck, true);
  assert.deepEqual(out.stuckIds, ['X']);
});
