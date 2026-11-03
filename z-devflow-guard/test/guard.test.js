'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const guard = require('../lib/guard');
const state = require('../lib/state');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeStatus(root, taskDir, name, doc) {
  const dir = path.join(root, taskDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(doc) + '\n');
}

test('status.json 含 run-terminal 事件 = 终局', () => {
  const root = tmpDir('zdg-fp-');
  try {
    writeStatus(root, 'Task-a', 'main.status.json', {
      name: 'main',
      nodes: { U1: { status: 'done', attempts: 1 } },
      events: [{ node: '-', event: 'run-terminal', detail: 'terminated=1' }],
    });
    assert.strictEqual(guard.isStatusFileTerminal(path.join(root, 'Task-a', 'main.status.json')), true);
    assert.strictEqual(guard.taskDirTerminal(root, 'Task-a'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('无 run-terminal 时全部节点终值也算终局（防御性补充）', () => {
  const root = tmpDir('zdg-fp-');
  try {
    writeStatus(root, 'Task-a', 'main.status.json', {
      nodes: { U1: { status: 'done' }, U2: { status: 'blocked' }, U3: { status: 'suspended' } },
      events: [],
    });
    assert.strictEqual(guard.isStatusFileTerminal(path.join(root, 'Task-a', 'main.status.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('存在 pending/in-progress 节点 = 非终局', () => {
  const root = tmpDir('zdg-fp-');
  try {
    writeStatus(root, 'Task-a', 'main.status.json', {
      nodes: { U1: { status: 'done' }, U2: { status: 'in-progress' } },
      events: [],
    });
    assert.strictEqual(guard.isStatusFileTerminal(path.join(root, 'Task-a', 'main.status.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('解析失败按非终态（宁可误拦）', () => {
  const root = tmpDir('zdg-fp-');
  try {
    fs.mkdirSync(path.join(root, 'Task-a'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Task-a', 'broken.status.json'), '{oops');
    assert.strictEqual(guard.isStatusFileTerminal(path.join(root, 'Task-a', 'broken.status.json')), false);
    assert.strictEqual(guard.taskDirTerminal(root, 'Task-a'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('任务目录不存在或无 status.json = 放行（D0 建档前不误杀）', () => {
  const root = tmpDir('zdg-fp-');
  try {
    assert.strictEqual(guard.taskDirTerminal(root, 'no-such-dir'), true);
    fs.mkdirSync(path.join(root, 'empty-dir'), { recursive: true });
    assert.strictEqual(guard.taskDirTerminal(root, 'empty-dir'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('decide：无标记放行 / 豁免放行 / 全终局放行 / 执行中拒绝且消息带恢复动作', () => {
  const root = tmpDir('zdg-fp-');
  const st = tmpDir('zdg-st-');
  try {
    const base = { stateDir: st, fingerprintRoot: root, sessionId: 's1' };
    assert.deepStrictEqual([guard.decide(base).allow, guard.decide(base).reason], [true, 'no-mark']);

    state.markStart(st, 's1', 'user-prompt');
    const emptyMark = guard.decide(base);
    assert.deepStrictEqual([emptyMark.allow, emptyMark.reason], [true, 'all-terminal']);

    state.addTaskDir(st, 's1', 'Task-a');
    writeStatus(root, 'Task-a', 'main.status.json', {
      nodes: { U1: { status: 'pending' } },
      events: [],
    });
    const denied = guard.decide(base);
    assert.strictEqual(denied.allow, false);
    assert.ok(denied.message.includes('CreateWorkflow'));
    assert.ok(denied.message.includes('Task-a'));
    assert.ok(denied.message.includes(state.waivePath(st, 's1')));

    state.waive(st, 's1');
    const waived = guard.decide(base);
    assert.deepStrictEqual([waived.allow, waived.reason], [true, 'waived']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(st, { recursive: true, force: true });
  }
});

test('decide：历史已终局目录不拦截，多个目录任一在途即拦', () => {
  const root = tmpDir('zdg-fp-');
  const st = tmpDir('zdg-st-');
  try {
    writeStatus(root, 'Old-done', 'main.status.json', {
      nodes: { U1: { status: 'done' } },
      events: [{ node: '-', event: 'run-terminal' }],
    });
    state.markStart(st, 's1', 'fingerprint');
    state.addTaskDir(st, 's1', 'Old-done');
    const base = { stateDir: st, fingerprintRoot: root, sessionId: 's1' };
    assert.strictEqual(guard.decide(base).allow, true);

    writeStatus(root, 'Old-done', 'second.status.json', { nodes: { U9: { status: 'pending' } }, events: [] });
    assert.strictEqual(guard.decide(base).allow, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(st, { recursive: true, force: true });
  }
});
