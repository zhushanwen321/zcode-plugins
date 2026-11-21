'use strict';

/**
 * 观察器触发语义回归：把补丁定义里的注入代码原文放进 vm 沙箱，用纯内存假 service
 * 驱动 tick，覆盖 5 分钟窗口判定、幂等去重、失败重试、多机会串行、周额度禁用等
 * 触发链路分支。全部离线——不发任何网络请求，不触碰真实重置接口。
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const quota = require('../patches/quota-auto-reset');

const NOW0 = 1_800_000_000_000;
const MIN = 60 * 1000;
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// 与补丁注入代码同构的键派生（对照实现，用于断言）
function deriveUuid(expireAt, variant) {
  let h = Number(expireAt).toString(16);
  while (h.length < 32) h = '0' + h;
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-' + variant + h.slice(17, 20) + '-' + h.slice(20, 32);
}

function makeSandbox() {
  const ticks = [];
  const state = { now: NOW0 };
  const sandbox = {
    console: { info: () => {}, warn: () => {}, log: () => {} },
    setInterval: (fn, ms) => { ticks.push({ fn, ms }); return 1; },
    clearInterval: () => {},
    Date: { now: () => state.now },
    Math, Object, JSON, Promise, String, Number, Boolean, Array, Symbol,
  };
  vm.createContext(sandbox);
  return { sandbox, ticks, setNow: (t) => { state.now = t; }, run: (code) => vm.runInContext(code, sandbox) };
}

function freshService(list = []) {
  const calls = { status: 0, use: [] };
  return {
    calls,
    useCodingPlanReset: async (args) => { calls.use.push(args); return { used: true }; },
    getCodingPlanResetStatus: async () => {
      calls.status += 1;
      return { availableFiveHourResets: list, availableWeekResets: [] };
    },
  };
}

function boot(h) {
  h.run(quota.watcherCode);
  assert.ok(h.sandbox.__zswQuotaAutoReset !== undefined, '观察器未安装');
  assert.equal(h.ticks.length, 1, 'setInterval 应恰好注册一次');
  assert.equal(h.ticks[0].ms, 30 * 1000, '轮询间隔应为 30s');
}

test('观察器安装：注册 30s tick，带版本号', () => {
  const h = makeSandbox();
  boot(h);
  assert.equal(h.sandbox.__zswQuotaAutoReset.version, quota.version);
});

test('临期机会（2 分 53 秒，复现截图时点）触发一次 use，键与类型正确', async () => {
  const h = makeSandbox();
  const expireAt = NOW0 + 173 * 1000;
  const svc = freshService([{ expireAt }]);
  h.sandbox.__zswQuotaCtx = { service: svc, scope: { preferredProviderId: 'account:bigmodel-individual-coding-plan' } };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1);
  assert.equal(svc.calls.use[0].resetType, 'FIVE_HOUR');
  assert.equal(svc.calls.use[0].idempotencyKey, deriveUuid(expireAt, '8'), '键必须由 expireAt 派生且跨重试稳定');
  assert.match(svc.calls.use[0].idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/, '键必须是 UI 同款 UUID 形态（服务端 3001 拒绝自定义前缀键）');
});

test('>5 分钟不触发；时间推进入窗后触发', async () => {
  const h = makeSandbox();
  const svc = freshService([{ expireAt: NOW0 + 6 * MIN }]);
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 0, '剩 6 分钟不应触发');
  h.setNow(NOW0 + 1.5 * MIN);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1, '剩 4.5 分钟应触发');
});

test('ctx 缺失（面板未挂载）静默等待，不触发不崩溃', async () => {
  const h = makeSandbox();
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.ok(true);
});

test('状态接口失败不崩溃，恢复后下一轮触发', async () => {
  const h = makeSandbox();
  let failing = true;
  const svc = freshService();
  svc.getCodingPlanResetStatus = async () => {
    if (failing) throw new Error('rpc down');
    return { availableFiveHourResets: [{ expireAt: NOW0 + 60 * 1000 }], availableWeekResets: [] };
  };
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 0);
  failing = false;
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1);
});

test('use 失败后同键重试（幂等键不换，服务端去重防双扣）', async () => {
  const h = makeSandbox();
  const expireAt = NOW0 + 2 * MIN;
  let failing = true;
  const svc = freshService([{ expireAt }]);
  svc.useCodingPlanReset = async (args) => {
    svc.calls.use.push(args);
    if (failing) throw new Error('transient');
    return { used: true };
  };
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1, '首轮失败 1 次');
  failing = false;
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 2, '下一轮应同键重试');
  assert.equal(svc.calls.use[0].idempotencyKey, svc.calls.use[1].idempotencyKey, '重试必须复用同一幂等键');
});

test('同一机会成功后不再重复触发（幂等去重）', async () => {
  const h = makeSandbox();
  const svc = freshService([{ expireAt: NOW0 + 2 * MIN }]);
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  for (let i = 0; i < 5; i++) { h.ticks[0].fn(); await wait(10); }
  assert.equal(svc.calls.use.length, 1, `应只触发一次，实际 ${svc.calls.use.length}`);
});

test('多机会每轮至多触发一次（防同轮连发浪费），下一轮接续', async () => {
  const h = makeSandbox();
  const soon = NOW0 + 60 * 1000;
  const later = NOW0 + 90 * 1000;
  const svc = freshService([{ expireAt: soon }, { expireAt: later }]);
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1, '首轮只允许一次 use（v2 语义：防同轮连发）');
  assert.equal(svc.calls.use[0].idempotencyKey, deriveUuid(soon, '8'));
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 2, '下一轮接续用下一个入窗机会');
  assert.equal(svc.calls.use[1].idempotencyKey, deriveUuid(later, '8'));
});

test('周额度机会永不自动触发（方案 1 裁决）', async () => {
  const h = makeSandbox();
  const svc = freshService();
  svc.getCodingPlanResetStatus = async () => ({ availableFiveHourResets: [], availableWeekResets: [{ expireAt: NOW0 + 30 * 1000 }] });
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 0);
});

test('捕获钩子（transform 产物原文）：存的是 RPC 代理字段 e.service，不是参数包装对象', async () => {
  // 回归锚：v3 之前模板生成 service:e（包装对象），导致观察器守卫静默失败——本用例
  // 直接执行 transform 产物里提取的钩子表达式，杜绝「测试手写、模板走样」的偏差。
  const { STYLES_CHUNK_JS } = require('./helpers');
  const { content } = quota.transform(STYLES_CHUNK_JS, 'x');
  const hookExpr = content.match(/\(globalThis\.__zswQuotaCtx=\{[^}]+\},\w+\.service\.getCodingPlanResetStatus\(\w+\.scope\)\)/);
  assert.ok(hookExpr, 'transform 产物里找不到钩子表达式');

  const h = makeSandbox();
  const svc = freshService();
  svc.getCodingPlanResetStatus = async () => ({ availableFiveHourResets: [], availableWeekResets: [] });
  h.sandbox.__svc = svc;
  h.run(`
    var e = { service: __svc, scope: { a: 1 }, authSessionSeq: 7 };
    var o = ${hookExpr[0]};
    __out = o && typeof o.then === 'function';
    __same = globalThis.__zswQuotaCtx.service === __svc;
  `);
  await wait(10);
  assert.equal(h.run('__out'), true, '钩子应返回 promise');
  assert.equal(h.run('__same'), true, 'ctx.service 必须与 RPC 代理引用相等（存字段而非包装对象）');
  assert.equal(h.sandbox.__zswQuotaCtx.authSessionSeq, 7);
  assert.equal(typeof h.sandbox.__zswQuotaCtx.service.useCodingPlanReset, 'function', 'ctx.service 上必须能取到 RPC 方法');
});
