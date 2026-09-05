'use strict';

/**
 * lib/clean-identify.js 基座单测（u1 范围：构造式解析 + 特征目录表）。
 *
 * 为什么全进程内直测：parseRecordWhiteList 是纯函数（路径入参、无全局态），
 * fixture records.jsonl 用 mkdtemp 临时文件承载；matchFeatureDirectory 是
 * 纯谓词。无需子进程/注入 env——识别正确性（仅 sessionId、嵌套层、坏行
 * 跳过、段/整串语义）全部可用直接断言锁定。u2 分治用例追加于本文件。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRecordWhiteList,
  FEATURE_DIRECTORY_SEGMENT_PREFIX,
  FEATURE_DIRECTORY_EXACT,
  matchFeatureDirectory,
} = require('../lib/clean-identify');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-clean-identify-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function writeRecords(lines) {
  const p = path.join(TMP, `records-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, `${lines.join('\n')}\n`);
  return p;
}

// ------------------------------------------------- C6 构造式解析

test('构造式只收 sessionId 键，严禁收 targetSessionId（C6-被否：调用方宿主会话=用户真实会话）', () => {
  const p = writeRecords([
    JSON.stringify({ sessionId: 'sess_a', targetSessionId: 'sess_host' }),
    JSON.stringify({ targetSessionId: 'sess_host2' }),
  ]);
  const wl = parseRecordWhiteList(p);
  assert.ok(wl.has('sess_a'));
  assert.equal(wl.size, 1, 'targetSessionId 不得入式');
  assert.equal(wl.has('sess_host'), false);
  assert.equal(wl.has('sess_host2'), false);
});

test('嵌套层提取：嵌套对象与数组内的 sessionId 均收（exec.sessionId / sessionRef.sessionId 形态）', () => {
  const p = writeRecords([
    JSON.stringify({ exec: { sessionId: 'sess_n1' }, sessionRef: { sessionId: 'sess_n2' } }),
    JSON.stringify({ list: [{ sessionId: 'sess_n3' }, { deep: [{ sessionId: 'sess_n4' }] }] }),
  ]);
  const wl = parseRecordWhiteList(p);
  assert.deepEqual([...wl].sort(), ['sess_n1', 'sess_n2', 'sess_n3', 'sess_n4']);
});

test('坏 JSON 行跳过、空行跳过、非字符串值不收、重复值去重', () => {
  const p = writeRecords([
    '{"sessionId": "sess_ok1"}, trailing garbage', // 坏行
    '', // 空行
    '{"sessionId": 123}', // 非字符串
    '{"sessionId": null}', // null
    '{"sessionId": "sess_ok1"}', // 与首合法行重复（跨行去重）
    '{"sessionId": "sess_ok2"}',
  ]);
  const wl = parseRecordWhiteList(p);
  assert.deepEqual([...wl].sort(), ['sess_ok1', 'sess_ok2']);
});

test('键名精确相等语义：targetSessionId / sessionID 等变体不入式', () => {
  const p = writeRecords([
    JSON.stringify({ targetSessionId: 'sess_t', sessionID: 'sess_c', 'SessionId': 'sess_u' }),
  ]);
  assert.equal(parseRecordWhiteList(p).size, 0);
});

test('文件不存在 → 空集（zsw 从未运行；白名单恒空 = 不误删，保守正确不抛错）', () => {
  const wl = parseRecordWhiteList(path.join(TMP, 'no-such-records.jsonl'));
  assert.ok(wl instanceof Set);
  assert.equal(wl.size, 0);
});

// ------------------------------------------------- 特征目录表（D1③ 闭集）

test('段匹配：路径中存在 zsub-e2e- 前缀段即命中（含其下子路径）', () => {
  assert.equal(matchFeatureDirectory('/tmp/x/zsub-e2e-abc/e1-proj'), true, '特征段 + 项目子路径');
  assert.equal(matchFeatureDirectory('/var/folders/xy/zsub-e2e-Qw3E/zsw-root'), true, 'os.tmpdir() 实际前缀形态（macOS /var/folders）');
  assert.equal(matchFeatureDirectory('/tmp/zsub-e2e-abc'), true, '特征段本身为末段');
});

test('整串匹配：探针目录闭集两串', () => {
  assert.ok(FEATURE_DIRECTORY_EXACT.includes('/tmp/zsw-sidebar-probe'), '闭集含 C7 探针目录一');
  assert.ok(FEATURE_DIRECTORY_EXACT.includes('/tmp/pz2-work'), '闭集含 C7 探针目录二');
  assert.equal(matchFeatureDirectory('/tmp/zsw-sidebar-probe'), true);
  assert.equal(matchFeatureDirectory('/tmp/pz2-work'), true);
  assert.equal(matchFeatureDirectory('/tmp/zsw-sidebar-probe/sub'), false, '整串语义：子路径不命中（闭集未登记）');
});

test('非特征临时目录不误伤', () => {
  assert.equal(matchFeatureDirectory('/tmp/normal-project'), false);
  assert.equal(matchFeatureDirectory('/Users/u/Code/my-project'), false);
});

test('路径段语义：目录名含 zsub-e2e- 子串但不构成独立段的不命中（防模糊匹配误伤）', () => {
  assert.equal(matchFeatureDirectory('/home/u/my-zsub-e2e-notes'), false, '段名以 my- 开头：含子串但段首不符');
  assert.equal(matchFeatureDirectory('/Users/u/Code/proj.zsub-e2e-notes'), false, '段名含子串但段首不符');
});

test('段匹配的判定单位是「段」而非父路径：zsub-e2e- 开头的段在任意父路径下均命中（D1③ 原文口径）', () => {
  // 设计 §3.3 D1③ 原文：「directory 按 / 分段后存在以 zsub-e2e- 开头的段」——
  // 不限定父路径。真实用户项目目录段名以该前缀开头的概率被设计评述覆盖
  // （「真实用户项目不可能位于 OS 临时目录的该前缀下」），语义按设计忠实实现。
  assert.equal(matchFeatureDirectory('/tmp/zsub-e2e-abc/e1-proj'), true);
  assert.equal(matchFeatureDirectory('/var/folders/zz/zsub-e2e-Qw3E/e1-proj'), true);
  assert.equal(matchFeatureDirectory('/home/u/my-zsub-e2e-notes'), false, '段名以 my- 开头：含子串但段首不符');
});

test('边界输入：空串/非字符串不命中', () => {
  assert.equal(matchFeatureDirectory(''), false);
  assert.equal(matchFeatureDirectory(undefined), false);
  assert.equal(matchFeatureDirectory(null), false);
});

test('闭集常量冻结且前缀常量为段匹配语义的单一来源', () => {
  assert.equal(Object.isFrozen(FEATURE_DIRECTORY_EXACT), true, '闭集不可运行期篡改');
  assert.equal(FEATURE_DIRECTORY_SEGMENT_PREFIX, 'zsub-e2e-', '来源：test/e2e.test.js:39 mkdtemp 前缀');
});
