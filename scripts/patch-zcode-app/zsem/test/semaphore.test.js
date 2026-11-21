'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderSemaphores } = require('../lib/semaphore');

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('fast path:limit 内立即授予,不触发 onQueued/onAdmitted', async () => {
  const sems = createProviderSemaphores();
  sems.setLimit('p', 2);
  let queued = 0;
  let admitted = 0;
  const r1 = await sems.acquire('p', { onQueued: () => queued++, onAdmitted: () => admitted++ });
  const r2 = await sems.acquire('p', { onQueued: () => queued++, onAdmitted: () => admitted++ });
  assert.equal(queued, 0);
  assert.equal(admitted, 0);
  assert.deepEqual(sems.snapshot().p, { limit: 2, active: 2, queued: 0 });
  r1();
  r2();
  assert.equal(sems.snapshot().p.active, 0);
});

test('超限排队 FIFO:release 依序授予等待者', async () => {
  const sems = createProviderSemaphores();
  sems.setLimit('p', 1);
  const order = [];
  const r1 = await sems.acquire('p');
  const p2 = sems.acquire('p').then((r) => (order.push(2), r));
  const p3 = sems.acquire('p').then((r) => (order.push(3), r));
  assert.equal(sems.snapshot().p.queued, 2);
  r1();
  const r2 = await p2;
  r2();
  const r3 = await p3;
  r3();
  assert.deepEqual(order, [2, 3]);
});

test('release 幂等:双点调用只归还一个名额', async () => {
  const sems = createProviderSemaphores();
  sems.setLimit('p', 1);
  const r1 = await sems.acquire('p');
  const waiter = sems.acquire('p');
  r1();
  r1(); // 调用方双点:重试分支 + finally
  const r2 = await waiter;
  assert.equal(sems.snapshot().p.active, 1);
  r2();
  assert.equal(sems.snapshot().p.active, 0);
});

test('排队中 abort:摘出队列并 reject(signal.reason)', async () => {
  const sems = createProviderSemaphores();
  sems.setLimit('p', 1);
  const ac = new AbortController();
  const reason = new Error('user-stop');
  const r1 = await sems.acquire('p');
  const waiter = sems.acquire('p', { signal: ac.signal });
  const failure = waiter.then(
    () => assert.fail('should reject'),
    (err) => err,
  );
  ac.abort(reason);
  const err = await failure;
  assert.equal(err, reason);
  assert.equal(sems.snapshot().p.queued, 0);
  r1();
  // 后续新请求不再被已取消的 waiter 阻塞
  const r2 = await sems.acquire('p');
  r2();
});

test('acquire 前已 abort:立即 reject(reason),不入队', async () => {
  const sems = createProviderSemaphores();
  sems.setLimit('p', 1);
  const ac = new AbortController();
  const reason = new Error('early');
  ac.abort(reason);
  const err = await sems.acquire('p', { signal: ac.signal }).then(
    () => assert.fail('should reject'),
    (e) => e,
  );
  assert.equal(err, reason);
  assert.equal(sems.snapshot().p.queued, 0);
});

test('多 provider 独立计数', async () => {
  const sems = createProviderSemaphores();
  sems.setLimit('a', 1);
  sems.setLimit('b', 2);
  await sems.acquire('a');
  const rb1 = await sems.acquire('b');
  const rb2 = await sems.acquire('b');
  assert.deepEqual(sems.snapshot().a, { limit: 1, active: 1, queued: 0 });
  assert.deepEqual(sems.snapshot().b, { limit: 2, active: 2, queued: 0 });
  rb1();
  rb2();
});

test('onQueued 同步段调用,onAdmitted 授予时带排队毫秒', async () => {
  const sems = createProviderSemaphores();
  sems.setLimit('p', 1);
  const events = [];
  const r1 = await sems.acquire('p');
  const d = deferred();
  const waiter = sems.acquire('p', {
    onQueued: () => events.push('queued'),
    onAdmitted: (ms) => events.push(['admitted', typeof ms === 'number' && ms >= 0]),
  });
  assert.deepEqual(events, ['queued']); // 入队同步段即调,不等授予
  setTimeout(() => r1(), 5);
  await waiter;
  assert.deepEqual(events, ['queued', ['admitted', true]]);
});

test('setLimit 调高即时放行队列,调低不抢占已持有者', async () => {
  const sems = createProviderSemaphores();
  sems.setLimit('p', 1);
  const r1 = await sems.acquire('p');
  const p2 = sems.acquire('p');
  assert.equal(sems.snapshot().p.queued, 1);
  sems.setLimit('p', 2);
  const r2 = await p2; // 上调即放行
  assert.equal(sems.snapshot().p.active, 2);
  sems.setLimit('p', 1); // 下调不夺走已持有名额
  assert.equal(sems.snapshot().p.active, 2);
  r1();
  r2();
});
