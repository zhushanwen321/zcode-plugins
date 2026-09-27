'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sanitizeSessionId, tick } = require('../lib/counter');

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zrr-counter-'));
}

test('每第 3 条命中注入轮，其余不命中', () => {
  const dir = tmpStateDir();
  try {
    const results = [1, 2, 3, 4, 5, 6].map(() => tick('s1', { stateDir: dir }).inject);
    assert.deepStrictEqual(results, [false, false, true, false, false, true]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('不同会话独立计数', () => {
  const dir = tmpStateDir();
  try {
    tick('s1', { stateDir: dir });
    tick('s1', { stateDir: dir });
    const s2 = tick('s2', { stateDir: dir });
    assert.strictEqual(s2.count, 1);
    assert.strictEqual(s2.inject, false);
    const s1 = tick('s1', { stateDir: dir });
    assert.strictEqual(s1.count, 3);
    assert.strictEqual(s1.inject, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session id 消毒：非法字符替换、空值归 default', () => {
  assert.strictEqual(sanitizeSessionId('sess_abc-123'), 'sess_abc-123');
  assert.match(sanitizeSessionId('a/b\\c:d'), /^[a-zA-Z0-9._-]+$/);
  assert.strictEqual(sanitizeSessionId(''), 'default');
  assert.strictEqual(sanitizeSessionId(null), 'default');
});

test('超过保留期的状态文件被惰性清理', () => {
  const dir = tmpStateDir();
  try {
    const stale = path.join(dir, 'old.json');
    fs.writeFileSync(stale, '{"count":99}\n');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, eightDaysAgo, eightDaysAgo);
    tick('s1', { stateDir: dir });
    assert.strictEqual(fs.existsSync(stale), false);
    // 保留期内文件不受影响
    tick('s1', { stateDir: dir });
    assert.strictEqual(fs.existsSync(path.join(dir, 's1.json')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
