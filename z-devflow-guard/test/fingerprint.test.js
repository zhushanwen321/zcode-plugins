'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { extractTaskDirs } = require('../lib/fingerprint');

test('从序列化文本提取任务目录段', () => {
  const s = JSON.stringify({
    file_path: '/Users/x/.agents/skill-data/dev-flow/Stock-df390a8b/report-domain-terminal.status.json',
  });
  assert.deepStrictEqual(extractTaskDirs(s), ['Stock-df390a8b']);
});

test('波浪线路径同样命中', () => {
  const s = JSON.stringify({ command: 'cat ~/.agents/skill-data/dev-flow/fix-chat-flow-stuck-84f23fa0/ledger.md' });
  assert.deepStrictEqual(extractTaskDirs(s), ['fix-chat-flow-stuck-84f23fa0']);
});

test('指到指纹根本身（无任务目录段）返回空数组但仍算命中场景', () => {
  const s = JSON.stringify({ command: 'ls ~/.agents/skill-data/dev-flow/' });
  assert.deepStrictEqual(extractTaskDirs(s), []);
});

test('非法目录段（路径穿越）被丢弃', () => {
  const s = JSON.stringify({ command: 'cat ~/.agents/skill-data/dev-flow/.. && ls ~/.agents/skill-data/dev-flow/.' });
  assert.deepStrictEqual(extractTaskDirs(s), []);
});

test('多个命中去重', () => {
  const s = 'skill-data/dev-flow/Task-x skill-data/dev-flow/Task-x skill-data/dev-flow/Task-y';
  assert.deepStrictEqual(extractTaskDirs(s), ['Task-x', 'Task-y']);
});

test('无指纹命中返回空数组', () => {
  assert.deepStrictEqual(extractTaskDirs(JSON.stringify({ file_path: '/tmp/other' })), []);
});
