'use strict';

/**
 * review-fix-loop.js 编排层单测（MF-1 原型链键消毒，2026-08-30）：
 * safeIssueKey 原语 + updateIssuesFromAggregation 直写点。闭包内写点
 * （consumeFixResults deferred 分支、collectReconDecls prev_id 兜底）经同一
 * 原语消毒，不重复搭 LLM 桩；vendor 侧（findIssueKey/reconcileIssues）回归在
 * review-fix-loop-utils.test.js。runReviewFixLoop 全链路由 e2e 覆盖。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const loop = require('../lib/workflow/review-fix-loop');

// stderr WARN 捕获（safeIssueKey 重写必留痕，防静默丢弃回归）
function captureWarn(fn) {
  const lines = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try {
    return [fn(), lines];
  } finally {
    process.stderr.write = orig;
  }
}

test('safeIssueKey: 危险键消毒为尾下划线安全键且 WARN 留痕；普通 id 原样', () => {
  const [proto, warns] = captureWarn(() => loop.safeIssueKey('__proto__'));
  assert.equal(proto, '__proto___');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /__proto__/);

  const [ctor, ctorWarns] = captureWarn(() => loop.safeIssueKey('constructor'));
  assert.equal(ctor, 'constructor_');
  assert.equal(ctorWarns.length, 1);

  const [proto2, proto2Warns] = captureWarn(() => loop.safeIssueKey('prototype'));
  assert.equal(proto2, 'prototype_');
  assert.equal(proto2Warns.length, 1);

  assert.equal(loop.safeIssueKey('MF-1'), 'MF-1');
  assert.equal(loop.safeIssueKey('mf-1 (fixed)'), 'mf-1 (fixed)');
});

test('updateIssuesFromAggregation: "__proto__" 条目键消毒入表——无危险自有键、原型不被改写', () => {
  const state = { issues: {}, dormant: [] };
  const [, warns] = captureWarn(() => loop.updateIssuesFromAggregation(state, [
    { id: '__proto__', title: '原型链注入条目', severity: 'major', files: [], evidence: '', guidance: '' },
    { id: 'MF-1', title: '正常条目', severity: 'major', files: [], evidence: '', guidance: '' },
  ], 1));
  // 修复前：state.issues['__proto__'] = {...} 触发 setter 改写 state.issues 的原型，
  // Object.keys 为 0——条目静默脱离追踪（fix-attempted→fixed/regressed 状态链、
  // stuck/needs-redesign、residual 终报、hasOpenResidue 对该条目全部失效）
  assert.deepEqual(Object.keys(state.issues).sort(), ['MF-1', '__proto___']);
  assert.equal(state.issues['__proto___'].status, 'open');
  assert.equal(state.issues['__proto___'].severity, 'major');
  assert.equal(state.issues['MF-1'].status, 'open');
  assert.equal(Object.getPrototypeOf(state.issues), Object.prototype);
  assert.equal(warns.length, 1);
});

test('updateIssuesFromAggregation: 既有条目 upsert 语义不变（消毒对正常 id 零影响）', () => {
  const state = {
    issues: { 'MF-1': { firstSeen: 1, severity: 'major', status: 'fix-attempted', fixAttempts: 1, openStreak: 1, history: [{ round: 1, status: 'open' }] } },
    dormant: [],
  };
  loop.updateIssuesFromAggregation(state, [
    { id: 'MF-1', title: '重报条目', severity: 'major', files: ['a.js'], evidence: 'e', guidance: 'g' },
  ], 2, { reconCount: 0 });
  // reconCount===0 重报 fix-attempted 条目 → regressed + fixAttempts+1（无对账重报回归通道不受影响）
  assert.equal(state.issues['MF-1'].status, 'regressed');
  assert.equal(state.issues['MF-1'].fixAttempts, 2);
  assert.equal(Object.keys(state.issues).length, 1);
});

test('safeReviewerKey: "__proto__"/"constructor" 维度名消毒——recordAgentClean/Dirty 写侧不污染原型（MF-1 同族）', () => {
  const { recordAgentClean, recordAgentDirty } = require('../lib/workflow/review-fix-loop-utils');

  const [cleanKey, cleanWarns] = captureWarn(() => loop.safeReviewerKey('__proto__'));
  assert.equal(cleanKey, '__proto___');
  assert.equal(cleanWarns.length, 1);
  assert.match(cleanWarns[0], /reviewer 维度名/);
  assert.equal(loop.safeReviewerKey('constructor'), 'constructor_');
  assert.equal(loop.safeReviewerKey('correctness'), 'correctness'); // 普通名原样

  // recordAgentClean/Dirty 经消毒键入 skip 状态机：自有键落表、Object.prototype 无污染
  // （修复前：state.agentStatus['__proto__'] || {...} 读侧命中原型链（truthy 不走兜底），
  // s.lastCleanBatch 直写污染 Object.prototype，全进程 ({}).lastCleanBatch 泄漏）
  const state = { agentStatus: {}, fixCount: 3 };
  recordAgentClean(state, loop.safeReviewerKey('__proto__'), 1);
  recordAgentDirty(state, loop.safeReviewerKey('constructor'), 2, 1);
  assert.deepEqual(Object.keys(state.agentStatus).sort(), ['__proto___', 'constructor_']);
  assert.equal(state.agentStatus['__proto___'].lastCleanBatch, 1);
  assert.equal(state.agentStatus['__proto___'].lastCleanFixCount, 3);
  assert.equal(state.agentStatus['constructor_'].lastMustFix, 2);
  assert.equal(Object.prototype.lastCleanBatch, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});
