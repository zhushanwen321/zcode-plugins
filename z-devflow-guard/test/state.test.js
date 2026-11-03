'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { STATE_TTL_MS } = require('../lib/config');
const state = require('../lib/state');

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zdg-state-'));
}

test('markStart 建标记且幂等：二次调用不重置、不重复记 source', () => {
  const dir = tmpStateDir();
  try {
    const first = state.markStart(dir, 's1', 'user-prompt');
    const second = state.markStart(dir, 's1', 'user-prompt');
    assert.strictEqual(state.readMark(dir, 's1').sources.length, 1);
    assert.strictEqual(state.readMark(dir, 's1').startedAt, first.startedAt);
    assert.deepStrictEqual(second.taskDirs, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('addTaskDir 去重追加；无标记时自动建立标记', () => {
  const dir = tmpStateDir();
  try {
    state.addTaskDir(dir, 's1', 'Task-a');
    state.addTaskDir(dir, 's1', 'Task-a');
    state.addTaskDir(dir, 's1', 'Task-b');
    const mark = state.readMark(dir, 's1');
    assert.deepStrictEqual(mark.taskDirs.sort(), ['Task-a', 'Task-b']);
    assert.ok(mark.sources.includes('fingerprint'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('不同会话的标记与豁免完全隔离', () => {
  const dir = tmpStateDir();
  try {
    state.markStart(dir, 's1', 'user-prompt');
    state.addTaskDir(dir, 's1', 'Task-a');
    state.waive(dir, 's1');
    assert.strictEqual(state.readMark(dir, 's2'), null);
    assert.strictEqual(state.isWaived(dir, 's2'), false);
    assert.strictEqual(state.isWaived(dir, 's1'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session id 消毒：路径不安全字符替换，空值归 default', () => {
  assert.strictEqual(state.sanitizeSessionId('sess_abc-123'), 'sess_abc-123');
  assert.match(state.sanitizeSessionId('a/b\\c:d'), /^[A-Za-z0-9._-]+$/);
  assert.strictEqual(state.sanitizeSessionId(''), 'default');
  assert.strictEqual(state.sanitizeSessionId(null), 'default');
});

test('超过保留期的标记与豁免文件被惰性清理', () => {
  const dir = tmpStateDir();
  try {
    state.markStart(dir, 'old', 'user-prompt');
    state.waive(dir, 'old');
    // utimesSync 的数字参数单位是 Unix 秒，传 Date 对象避免毫秒/秒歧义
    const past = new Date(Date.now() - STATE_TTL_MS - 1000);
    fs.utimesSync(state.statePath(dir, 'old'), past, past);
    fs.utimesSync(state.waivePath(dir, 'old'), past, past);
    state.sweepStale(dir);
    assert.strictEqual(fs.existsSync(state.statePath(dir, 'old')), false);
    assert.strictEqual(fs.existsSync(state.waivePath(dir, 'old')), false);
    state.markStart(dir, 'fresh', 'user-prompt');
    state.sweepStale(dir);
    assert.strictEqual(fs.existsSync(state.statePath(dir, 'fresh')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
