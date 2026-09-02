'use strict';

/**
 * slots 单元（V7i / 设计 C5-E5，⛔B 检查点）。
 *
 * 背景：slots.js 收敛为 core ConcurrencyPool 的 strict-fifo 薄层后，本文件是
 * 排队语义的唯一显式锚（此前无专测——manager.test.js 用 fakeSlots，真实池
 * 语义只被 assemble/manager 间接覆盖）。锚定五件事：
 * 1. 并发上限与 running() 观测面；
 * 2. ⛔B FIFO：同批提交按提交序出队（strict-fifo 语义锚）；
 * 3. 深度分层（D11：effectiveLimit = max(1, limit - depth)，深层保底 1）；
 * 4. S-2 分层配额不穿透：release 不让深层队首越过仍在运行的槽位（若薄层
 *    误把 effectiveLimit 传给 core 池，core「仅 acquire 时点强制」的出队
 *    让位语义会让本断言失败——回归哨兵）；
 * 5. 释放幂等与 limit 钳制（缺省/非法值 → 1）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSlots } = require('../lib/slots');

/** 等一轮宏任务：冲刷池授予链路上的全部微任务，断言时序确定。 */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('导出契约：createSlots({limit}) → {acquire, running}，acquire 解析为释放函数', async () => {
  assert.equal(typeof createSlots, 'function');
  const s = createSlots({ limit: 1 });
  assert.equal(typeof s.acquire, 'function');
  assert.equal(typeof s.running, 'function');
  const release = await s.acquire();
  assert.equal(typeof release, 'function', 'acquire 的 resolve 值是释放函数');
  release();
  assert.equal(s.running(), 0);
});

test('并发上限：超限排队不出槽，释放后队首递补，running() 全程可见', async () => {
  const s = createSlots({ limit: 2 });
  const r1 = await s.acquire();
  assert.equal(s.running(), 1);
  const r2 = await s.acquire();
  assert.equal(s.running(), 2);

  let third = false;
  const p3 = s.acquire().then((rel) => { third = true; return rel; });
  assert.equal(third, false, '超限后必须排队（pump 同步裁决，无微任务窗口）');
  assert.equal(s.running(), 2, 'running() 不含排队者');

  r1();
  const r3 = await p3;
  assert.equal(third, true);
  assert.equal(s.running(), 2, '递补后仍顶在上限');

  r2(); r3();
  assert.equal(s.running(), 0, '全部释放后归零');
});

test('⛔B FIFO 语义锚：同批提交按提交序出队', async () => {
  const s = createSlots({ limit: 1 });
  const order = [];
  const r1 = await s.acquire();
  order.push(1);

  // 同批提交 3 个：提交序 = 排队序
  const p2 = s.acquire().then((rel) => { order.push(2); return rel; });
  const p3 = s.acquire().then((rel) => { order.push(3); return rel; });
  const p4 = s.acquire().then((rel) => { order.push(4); return rel; });
  assert.deepEqual(order, [1], '占槽的只有最先提交者');

  r1();
  const r2 = await p2; r2();
  const r3 = await p3; r3();
  const r4 = await p4; r4();

  assert.deepEqual(order, [1, 2, 3, 4], 'strict-fifo：出队序必须等于提交序，无插队无跳级');
});

test('深度分层（D11）：深层队首头部阻塞后来浅层，放行后浅层不空转', async () => {
  const s = createSlots({ limit: 3 });
  const r1 = await s.acquire(); // depth 0，effective 3
  const r2 = await s.acquire(); // depth 0，active=2

  let deep = false;
  const p3 = s.acquire(1).then((rel) => { deep = true; return rel; }); // effective 2：2<2 不成立 → 排队成队首
  let shallow = false;
  const p4 = s.acquire().then((rel) => { shallow = true; return rel; }); // effective 3：被深层队首阻塞（不跳级）
  assert.equal(deep, false);
  assert.equal(shallow, false, '严格 FIFO：浅层不得越过被阻塞的深层队首');

  r1(); // active 2→1：深层头 1<2 放行；连发 pump 让浅层 2<3 一并放行（while 语义）
  const r3 = await p3;
  const r4 = await p4;
  assert.equal(deep && shallow, true, '深层放行后浅层立即递补（头部阻塞非永久饥饿）');

  r2(); r3(); r4();
  assert.equal(s.running(), 0);
});

test('S-2 分层配额不穿透：release 不让深层队首越过仍在运行的槽位', async () => {
  const s = createSlots({ limit: 2 });
  const r1 = await s.acquire();
  const r2 = await s.acquire(); // active = 2

  let deepOn = false;
  const pDeep = s.acquire(1).then((rel) => { deepOn = true; return rel; }); // effective 1，队首
  let shallowOn = false;
  const pShallow = s.acquire().then((rel) => { shallowOn = true; return rel; });

  r1(); // active 2→1；深层头 effective=1：1<1 不成立 → 不出队
  await settle();
  assert.equal(deepOn, false, 'S-2 不穿透：单次 release 只腾出「深层可见」的空位不足额时不让位');
  assert.equal(shallowOn, false);
  assert.equal(s.running(), 1, '深层队首阻塞期间槽位计数不漂移');

  r2(); // active 0：深层头 0<1 放行（保底 1），随后浅层 1<2 放行
  const rDeep = await pDeep;
  const rShallow = await pShallow;
  assert.equal(deepOn && shallowOn, true, '全空后深层照常放行（保底 1 非饿死）');

  rDeep(); rShallow();
  assert.equal(s.running(), 0);
});

test('释放幂等：双重释放不腐化池计数', async () => {
  const s = createSlots({ limit: 1 });
  const r1 = await s.acquire();
  r1(); r1();
  assert.equal(s.running(), 0, '双重释放只算一次');

  const r2 = await s.acquire();
  assert.equal(s.running(), 1, '腐化的计数会让后继占槽读数失真——必须为 1');
  r2();
  assert.equal(s.running(), 0);
});

test('limit 钳制：缺省/0/负数/NaN 都按 1 生效（下限单源 core 池 + 本层归一）', async () => {
  for (const opts of [undefined, { limit: 0 }, { limit: -5 }, { limit: NaN }]) {
    const s = createSlots(opts);
    const r1 = await s.acquire();
    let second = false;
    let relSecond = null;
    s.acquire().then((rel) => { second = true; relSecond = rel; return rel; });
    await settle();
    assert.equal(second, false, `opts=${JSON.stringify(opts)} 时上限必须是 1`);
    assert.equal(s.running(), 1);
    r1();
    await settle();
    assert.equal(second, true, `opts=${JSON.stringify(opts)} 时释放后队首递补`);
    relSecond();
    await settle();
    assert.equal(s.running(), 0);
  }
});
