'use strict';
// registry 单测：withLock 互斥 / stale 接管 / 纯函数行为，全部用临时目录
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  LockHeldError,
  withLock,
  loadRegistry,
  saveRegistry,
  upsertServer,
  removeServer,
} = require('../lib/registry.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ztf-reg-'));
}

test('withLock：正常获取、fn 完成后释放（锁文件删除）', () => {
  const dir = tmpDir();
  const out = withLock(dir, () => 42);
  assert.strictEqual(out, 42);
  assert.ok(!fs.existsSync(path.join(dir, 'registry.lock')));
});

test('withLock：fn 抛错也释放锁，且错误透传', () => {
  const dir = tmpDir();
  assert.throws(() => withLock(dir, () => { throw new Error('boom'); }), /boom/);
  assert.ok(!fs.existsSync(path.join(dir, 'registry.lock')));
});

test('withLock：同进程存活 PID 的锁存在时抛 LockHeldError（互斥）', () => {
  const dir = tmpDir();
  const lock = path.join(dir, 'registry.lock');
  fs.writeFileSync(lock, String(process.pid)); // PID = 当前进程，必存活
  assert.throws(() => withLock(dir, () => {}), LockHeldError);
  // 未获锁的一方不得删他人锁
  assert.ok(fs.existsSync(lock));
});

test('withLock：持锁期间嵌套二次获取抛 LockHeldError', () => {
  const dir = tmpDir();
  withLock(dir, () => {
    assert.throws(() => withLock(dir, () => {}), LockHeldError);
  });
});

test('withLock：死亡 PID 的锁被强制接管', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'registry.lock'), '99999999'); // 不可能存活的 PID
  const out = withLock(dir, () => 'ok');
  assert.strictEqual(out, 'ok');
  assert.ok(!fs.existsSync(path.join(dir, 'registry.lock')));
});

test('withLock：mtime 超时的锁若 PID 存活仍拒绝（R1：不按时间强抢存活持有者）', () => {
  const dir = tmpDir();
  const lock = path.join(dir, 'registry.lock');
  fs.writeFileSync(lock, String(process.pid));
  const old = new Date(Date.now() - 31 * 1000);
  fs.utimesSync(lock, old, old);
  assert.throws(() => withLock(dir, () => {}), LockHeldError);
  assert.ok(fs.existsSync(lock), '存活持有者的锁不得被删');
});

test('saveRegistry 原子写 + loadRegistry 往返；不存在/损坏时返回空 registry', () => {
  const dir = tmpDir();
  const reg = { servers: {}, overrides: { 's:t': 'u' }, policies: { 's:*': 'allow' } };
  saveRegistry(dir, reg);
  assert.deepStrictEqual(loadRegistry(dir), reg);

  const empty = tmpDir();
  assert.deepStrictEqual(loadRegistry(empty), { servers: {}, overrides: {}, policies: {} });
  fs.writeFileSync(path.join(empty, 'registry.json'), 'not json');
  assert.deepStrictEqual(loadRegistry(empty), { servers: {}, overrides: {}, policies: {} });
});

test('upsertServer 纯函数：返回新 reg，不 mutate 入参，保留既有 overrides/policies', () => {
  const reg = {
    servers: { existing: { scope: 'user', original: {}, wrapperEntry: {}, pinned: true, takenOverAt: 't' } },
    overrides: { 's:tool': 'when' },
    policies: { 's:*': 'deny' },
  };
  const next = upsertServer(reg, {
    key: 'browser-use',
    scope: 'plugin',
    original: { command: 'node', args: ['a'], env: {} },
    wrapperEntry: { command: 'node', args: ['w'] },
  });
  assert.ok(!('browser-use' in reg.servers), '入参不被修改');
  assert.ok('browser-use' in next.servers);
  assert.ok('existing' in next.servers, '既有记录保留');
  assert.deepStrictEqual(next.overrides, { 's:tool': 'when' });
  assert.deepStrictEqual(next.policies, { 's:*': 'deny' });
  const rec = next.servers['browser-use'];
  assert.strictEqual(rec.scope, 'plugin');
  assert.strictEqual(rec.pinned, false, '未指定时默认 false');
  assert.ok(!Number.isNaN(Date.parse(rec.takenOverAt)), '自动补 takenOverAt ISO 时间');

  // 二次 upsert 同 key 保留 pinned
  const again = upsertServer(next, {
    key: 'browser-use',
    scope: 'plugin',
    original: { command: 'node' },
    wrapperEntry: { command: 'node' },
    pinned: true,
  });
  assert.strictEqual(again.servers['browser-use'].pinned, true);
});

test('removeServer 纯函数：删除目标 key，其余保留；不存在 key 时安全', () => {
  const reg = {
    servers: {
      a: { scope: 'user', original: {}, wrapperEntry: {}, pinned: false, takenOverAt: 't1' },
      b: { scope: 'plugin', original: {}, wrapperEntry: {}, pinned: true, takenOverAt: 't2' },
    },
    overrides: {},
    policies: {},
  };
  const next = removeServer(reg, 'a');
  assert.ok('a' in reg.servers, '入参不被修改');
  assert.ok(!('a' in next.servers));
  assert.ok('b' in next.servers);
  const same = removeServer(next, 'no-such');
  assert.ok(!('no-such' in same.servers));
  assert.ok('b' in same.servers);
});
