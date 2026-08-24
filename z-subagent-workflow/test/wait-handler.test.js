'use strict';

/**
 * wait-handler 单测（DESIGN-v4 §6.4 D4，U2）。
 *
 * 隔离原则：全 fake——手写 manager stub（pending Map 塞受控 resolve/reject
 * promise + status 返回受控 record），不依赖真 manager / 真实 ~/.zcode。
 * pollFallbackMs 注入小值（20ms），避免轮询兜底路径真等默认 2s。
 *
 * 时序对齐真 manager：执行体 promise settle 前 record 已落终态
 * （_execRound 的 transition 先于 resolve/rethrow），stub 在同一个
 * setTimeout 回调里先改 record 再 settle promise。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');

const { createWaitHandler } = require('../lib/wait-handler');

const FAST_POLL = 20;

/** 内存 fake manager：status 对不存在 id 抛真 manager 同款可操作错误。 */
function makeFakeManager() {
  const records = new Map();
  const pending = new Map();
  const manager = {
    pending,
    status(id) {
      const rec = records.get(id);
      if (!rec) {
        throw new Error(`subagent "${id}" 不存在。恢复指引：用 list 查看全部任务 id。`);
      }
      return { ...rec, outputFile: `/fake/outputs/${id}.md` };
    },
  };
  return { manager, records, pending };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** settle 一个 id：先落 record 终态再动 promise（对齐真 manager 时序）。 */
function settle(records, pending, id, status, action) {
  records.set(id, { subagentId: id, status });
  pending.delete(id); // .finally 清除条目
  action();
}

// ---------------------------------------------------------------- tests

test('全终态：立即返回，保持入参顺序', async () => {
  const { manager, records } = makeFakeManager();
  records.set('sa-1', { subagentId: 'sa-1', status: 'closed' });
  records.set('sa-2', { subagentId: 'sa-2', status: 'error' });
  records.set('sa-3', { subagentId: 'sa-3', status: 'cancelled' });
  const wait = createWaitHandler({ manager });
  const out = await wait({ action: 'wait', ids: ['sa-3', 'sa-1', 'sa-2'] });
  assert.equal(out.partial, undefined);
  assert.deepEqual(out.results.map((r) => r.subagentId), ['sa-3', 'sa-1', 'sa-2']);
  assert.deepEqual(out.results.map((r) => r.status), ['cancelled', 'closed', 'error']);
  assert.ok(out.results.every((r) => typeof r.outputFile === 'string'));
});

test('混合：1 终态 + 2 运行中，等齐后返回（顺序保持）', async () => {
  const { manager, records, pending } = makeFakeManager();
  records.set('sa-done', { subagentId: 'sa-done', status: 'closed' });
  records.set('sa-a', { subagentId: 'sa-a', status: 'running' });
  records.set('sa-b', { subagentId: 'sa-b', status: 'running' });
  const da = deferred();
  const db = deferred();
  pending.set('sa-a', da.promise);
  pending.set('sa-b', db.promise);
  const wait = createWaitHandler({ manager, pollFallbackMs: FAST_POLL });
  const p = wait({ ids: ['sa-a', 'sa-done', 'sa-b'] });
  setTimeout(() => settle(records, pending, 'sa-a', 'closed', () => da.resolve()), 5);
  setTimeout(() => settle(records, pending, 'sa-b', 'timeout', () => db.resolve()), 25);
  const out = await p;
  assert.equal(out.partial, undefined);
  assert.deepEqual(out.results.map((r) => r.subagentId), ['sa-a', 'sa-done', 'sa-b']);
  assert.deepEqual(out.results.map((r) => r.status), ['closed', 'closed', 'timeout']);
});

test('pending reject：以 error 终态收编，wait 整体成功', async () => {
  const { manager, records, pending } = makeFakeManager();
  records.set('sa-x', { subagentId: 'sa-x', status: 'running' });
  const dx = deferred();
  pending.set('sa-x', dx.promise);
  const wait = createWaitHandler({ manager, pollFallbackMs: FAST_POLL });
  const p = wait({ ids: ['sa-x'] });
  setTimeout(
    () => settle(records, pending, 'sa-x', 'error', () => dx.reject(new Error('runner 崩溃'))),
    5,
  );
  const out = await p; // 不得抛：失败原因已落 record，以 status 收编
  assert.deepEqual(out.results, [{ subagentId: 'sa-x', status: 'error', outputFile: '/fake/outputs/sa-x.md' }]);
  assert.equal(out.partial, undefined);
});

test('timeoutMs 到点：partial，pending 列表含当前 status', async () => {
  const { manager, records, pending } = makeFakeManager();
  records.set('sa-fast', { subagentId: 'sa-fast', status: 'closed' });
  records.set('sa-slow', { subagentId: 'sa-slow', status: 'running' });
  const dslow = deferred();
  pending.set('sa-slow', dslow.promise);
  const wait = createWaitHandler({ manager, pollFallbackMs: FAST_POLL });
  const out = await wait({ ids: ['sa-fast', 'sa-slow'], timeoutMs: 60 });
  assert.equal(out.partial, true);
  assert.deepEqual(out.results, [{ subagentId: 'sa-fast', status: 'closed', outputFile: '/fake/outputs/sa-fast.md' }]);
  assert.deepEqual(out.pending, [{ subagentId: 'sa-slow', status: 'running' }]);
  dslow.resolve(); // 后续正常完成，不留给 GC
});

test('不存在的 id：抛可操作错误（含 list 指引），且在任何等待之前', async () => {
  const { manager, records } = makeFakeManager();
  records.set('sa-ok', { subagentId: 'sa-ok', status: 'closed' });
  const wait = createWaitHandler({ manager });
  await assert.rejects(wait({ ids: ['sa-ok', 'sa-ghost'] }), (err) => {
    assert.match(err.message, /sa-ghost/);
    assert.match(err.message, /list/);
    return true;
  });
});

test('signal abort：handler 干净返回，后续 reject 零 unhandledRejection，listener 不泄漏', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { manager, records, pending } = makeFakeManager();
    records.set('sa-never', { subagentId: 'sa-never', status: 'running' });
    const dn = deferred();
    pending.set('sa-never', dn.promise);
    const wait = createWaitHandler({ manager, pollFallbackMs: 500 }); // 长间隔，abort 必须先到
    const ac = new AbortController();
    const p = wait({ ids: ['sa-never'] }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    const out = await p;
    assert.equal(out.partial, true);
    assert.deepEqual(out.pending, [{ subagentId: 'sa-never', status: 'running' }]);
    // abort listener 必须移除（防 signal 长寿命对象上累积监听器）
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
    // abort 之后执行体失败（reject）：衍生 promise 已带 noop handler，不得 unhandled
    settle(records, pending, 'sa-never', 'error', () => dn.reject(new Error('daemon 侧迟到失败')));
    await new Promise((r) => setTimeout(r, 30)); // flush unhandledRejection 检查点
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('进入时已 abort：非终态全部进 pending 立即返回', async () => {
  const { manager, records } = makeFakeManager();
  records.set('sa-run', { subagentId: 'sa-run', status: 'running' });
  const wait = createWaitHandler({ manager });
  const ac = new AbortController();
  ac.abort();
  const out = await wait({ ids: ['sa-run'] }, { signal: ac.signal });
  assert.equal(out.partial, true);
  assert.deepEqual(out.results, []);
  assert.deepEqual(out.pending, [{ subagentId: 'sa-run', status: 'running' }]);
});

test('pending Map 缺失但 record 已终态：status 为准兜底（轮询唤醒收编）', async () => {
  const { manager, records, pending } = makeFakeManager();
  records.set('sa-g', { subagentId: 'sa-g', status: 'running' });
  // pending 故意不放 sa-g：模拟极快完成已 .finally 清除 / daemon 接管后内存丢失
  const wait = createWaitHandler({ manager, pollFallbackMs: FAST_POLL });
  const p = wait({ ids: ['sa-g'] });
  setTimeout(() => {
    records.set('sa-g', { subagentId: 'sa-g', status: 'closed' }); // 只改 record，无 promise 可等
  }, 5);
  const out = await p; // 轮询兜底在 pollFallbackMs 后重查收编，不挂死
  assert.deepEqual(out.results, [{ subagentId: 'sa-g', status: 'closed', outputFile: '/fake/outputs/sa-g.md' }]);
  assert.equal(out.partial, undefined);
});

test('lost 状态：非硬终态不立即收编，轮询兜底等待外部推进，timeout 时 partial', async () => {
  const { manager, records } = makeFakeManager();
  records.set('sa-lost', { subagentId: 'sa-lost', status: 'lost' }); // 无 pending 条目
  const wait = createWaitHandler({ manager, pollFallbackMs: FAST_POLL });
  const out = await wait({ ids: ['sa-lost'], timeoutMs: 50 });
  assert.equal(out.partial, true);
  assert.deepEqual(out.results, []);
  assert.deepEqual(out.pending, [{ subagentId: 'sa-lost', status: 'lost' }]);
});

test('参数校验：ids 形态与 timeoutMs 非法值立即抛', async () => {
  const { manager, records } = makeFakeManager();
  records.set('sa-1', { subagentId: 'sa-1', status: 'closed' });
  const wait = createWaitHandler({ manager });
  await assert.rejects(wait({ ids: 'sa-1' }), /ids/);        // 非数组
  await assert.rejects(wait({ ids: [] }), /ids/);            // 空数组
  await assert.rejects(wait({ ids: [''] }), /ids/);          // 空字符串元素
  await assert.rejects(wait({ ids: [42] }), /ids/);          // 非字符串元素
  await assert.rejects(wait({ ids: ['sa-1'], timeoutMs: -5 }), /timeoutMs/);
  await assert.rejects(wait({ ids: ['sa-1'], timeoutMs: 'x' }), /timeoutMs/);
  await assert.rejects(wait({ ids: ['sa-1'], timeoutMs: Infinity }), /timeoutMs/);
});

test('工厂校验：manager 缺失 / pollFallbackMs 非法立即抛', () => {
  assert.throws(() => createWaitHandler({}), /manager/);
  assert.throws(() => createWaitHandler({ manager: { status() {}, pending: new Map() }, pollFallbackMs: 0 }), /pollFallbackMs/);
});

// ------------------------------------------- R5：conversation 轮完成（idle）可收

test('conversation 任务轮完成（running→idle）→ wait 以 idle 收齐，不挂起（R5）', async () => {
  const { manager, records, pending } = makeFakeManager();
  records.set('sa-chat', { subagentId: 'sa-chat', status: 'running' });
  const d = deferred();
  pending.set('sa-chat', d.promise);
  const wait = createWaitHandler({ manager, pollFallbackMs: FAST_POLL });
  const p = wait({ ids: ['sa-chat'] });
  setTimeout(() => settle(records, pending, 'sa-chat', 'idle', () => d.resolve()), 5);
  const out = await p;
  assert.equal(out.partial, undefined);
  assert.deepEqual(out.results, [{ subagentId: 'sa-chat', status: 'idle', outputFile: '/fake/outputs/sa-chat.md' }]);
});

test('初始即 idle 的 conversation 任务 → wait 立即收齐（无需等待/轮询）', async () => {
  const { manager, records } = makeFakeManager();
  records.set('sa-idle', { subagentId: 'sa-idle', status: 'idle' });
  const wait = createWaitHandler({ manager });
  const out = await wait({ ids: ['sa-idle'] });
  assert.equal(out.partial, undefined);
  assert.equal(out.results[0].status, 'idle');
});
