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

function freshService(list = [], { usageSnapshot, hasUsageRpc = true } = {}) {
  const calls = { status: 0, use: [], usage: 0 };
  const svc = {
    calls,
    useCodingPlanReset: async (args) => { calls.use.push(args); return { used: true }; },
    getCodingPlanResetStatus: async () => {
      calls.status += 1;
      return { availableFiveHourResets: list, availableWeekResets: [] };
    },
  };
  if (hasUsageRpc) {
    svc.getCodingPlanUsageSnapshot = async (args) => {
      calls.usage += 1;
      calls.usageArgs = args;
      if (usageSnapshot === undefined) throw new Error('no usage fixture');
      return usageSnapshot;
    };
  }
  return svc;
}

function boot(h) {
  h.run(quota.watcherCode);
  assert.ok(h.sandbox.__zswQuotaAutoReset !== undefined, '观察器未安装');
  assert.equal(h.ticks.length, 1, 'setInterval 应恰好注册一次');
  assert.equal(h.ticks[0].ms, 60 * 1000, '轮询间隔应为 60s（v8：降频缓解服务端限流风险）');
}

test('观察器安装：注册 60s tick，带版本号', () => {
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

test('use 失败后进入 60s 冷却，冷却后同键重试（幂等键不换，服务端去重防双扣）', async () => {
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
  assert.equal(svc.calls.use.length, 1, '冷却期内（60s）不得重试');
  h.setNow(NOW0 + 61 * 1000); // 冷却到期（机会剩 59s，仍在 5min 窗内）
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 2, '冷却后应同键重试');
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

test('周卡第一层拦截：临期周卡不触发；无合格 5h 卡时额度再低也不触发、不拉 usage', async () => {
  const h = makeSandbox();
  const svc = freshService();
  svc.getCodingPlanResetStatus = async () => {
    svc.calls.status += 1;
    return { availableFiveHourResets: [], availableWeekResets: [{ expireAt: NOW0 + 30 * 1000 }] };
  };
  svc.getCodingPlanUsageSnapshot = async () => { svc.calls.usage += 1; return FIVE_H_LIMIT(0.01); };
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 0, '周卡即使 30 秒后过期也不得使用');
  assert.equal(svc.calls.usage, 0, '周卡对规则 2 同样不可见');
});

test('周卡与合格 5h 卡并存：只动 5h 卡，且只动一次', async () => {
  const h = makeSandbox();
  const five = NOW0 + 30 * MIN;
  const svc = freshService([{ expireAt: five }]);
  svc.getCodingPlanResetStatus = async () => {
    svc.calls.status += 1;
    return { availableFiveHourResets: [{ expireAt: five }], availableWeekResets: [{ expireAt: NOW0 + 20 * 1000 }] };
  };
  svc.getCodingPlanUsageSnapshot = async () => { svc.calls.usage += 1; return FIVE_H_LIMIT(0.01); };
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1);
  assert.equal(svc.calls.use[0].idempotencyKey, deriveUuid(five, '8'));
  assert.equal(svc.calls.use[0].resetType, 'FIVE_HOUR');
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


// ===== 规则 2：剩余 <5% =====

// 真实契约形态（UI 筛选条件 unit===3 && number===5；remaining 与 number 同单位，比例 = remaining/number）
const FIVE_H_LIMIT = (ratio) => ({
  quota: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, remaining: ratio * 5, percentage: ratio * 100 }] },
});

test('规则 2：额度 3% → 触发（4 小时后过期的卡，在 24 小时合格范围内）', async () => {
  const h = makeSandbox();
  const expireAt = NOW0 + 4 * 60 * MIN;
  const svc = freshService([{ expireAt }], { usageSnapshot: FIVE_H_LIMIT(0.03) }); // 剩余 3%
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1, '低用量 + 1h 窗应触发');
  assert.equal(svc.calls.use[0].idempotencyKey, deriveUuid(expireAt, '8'));
});

test('规则 2：剩余 40% → 不触发，且 5 分钟内不重复拉 usage（节流）', async () => {
  const h = makeSandbox();
  const svc = freshService([{ expireAt: NOW0 + 30 * MIN }], { usageSnapshot: FIVE_H_LIMIT(0.4) }); // 剩余 40%
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 0, '剩余充足不应触发');
  assert.equal(svc.calls.usage, 1);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.usage, 1, '节流期内不得重复拉 usage');
});

test('规则 2：无可用机会不拉 usage；规则 3 触发时也不拉 usage', async () => {
  const h = makeSandbox();
  const svc = freshService([], { usageSnapshot: FIVE_H_LIMIT(0.002) });
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.usage, 0, '无机会（列表空）不应拉 usage');
  // 规则 3 直接触发的场景不应消耗 usage 拉取
  const h2 = makeSandbox();
  const svc2 = freshService([{ expireAt: NOW0 + 173 * 1000 }], { usageSnapshot: FIVE_H_LIMIT(0.002) });
  h2.sandbox.__zswQuotaCtx = { service: svc2, scope: {} };
  boot(h2);
  h2.ticks[0].fn();
  await wait();
  assert.equal(svc2.calls.use.length, 1);
  assert.equal(svc2.calls.usage, 0, '规则 3 命中不应拉 usage');
});

test('规则 2 降级：usage RPC 缺失时不触发不崩溃，规则 3 照常', async () => {
  const h = makeSandbox();
  const svc = freshService([{ expireAt: NOW0 + 30 * MIN }], { hasUsageRpc: false });
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 0, 'usage 不可用时规则 2 静默跳过');
  // 规则 3 照常
  h.sandbox.__zswQuotaCtx.service = Object.assign({}, svc, {
    calls: svc.calls,
    useCodingPlanReset: svc.useCodingPlanReset,
    getCodingPlanResetStatus: svc.getCodingPlanResetStatus,
  });
  h.setNow(NOW0 + 27 * MIN); // 机会剩 3 分钟
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1, '规则 3 不受 usage 降级影响');
});

test('规则 2 剩余比例算法与 UI 同款：优先 remaining/number，percentage 兜底', async () => {
  const h = makeSandbox();
  const svc = freshService([{ expireAt: NOW0 + 30 * MIN }], {
    usageSnapshot: { quota: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 3 }] } }, // 无 remaining → 用 percentage（口径 0-100，3 = 剩余 3%）
  });
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1, 'percentage 0.02 < 5% 应触发');
});


test('v6：usage 调用必须带 range + timeZone（宿主 Jre 强依赖，缺参在宿主内部抛错）', async () => {
  const h = makeSandbox();
  const expireAt = NOW0 + 30 * MIN;
  const svc = freshService([{ expireAt }], { usageSnapshot: FIVE_H_LIMIT(0.03) });
  h.sandbox.__zswQuotaCtx = { service: svc, scope: { preferredProviderId: 'account:bigmodel-individual-coding-plan' } };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1);
  assert.equal(svc.calls.usage, 1);
  assert.equal(svc.calls.usageArgs.range, '7d');
  assert.equal(typeof svc.calls.usageArgs.timeZone, 'string');
  assert.equal(svc.calls.usageArgs.preferredProviderId, 'account:bigmodel-individual-coding-plan');
});


test('规则 2：use 失败冷却后同键重试（60s 冷却防队头饿死，牺牲旧 30s 立即重试）', async () => {
  const h = makeSandbox();
  const expireAt = NOW0 + 4 * 60 * MIN;
  let failing = true;
  const svc = freshService([{ expireAt }], { usageSnapshot: FIVE_H_LIMIT(0.03) });
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
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1, '冷却期内（60s）不得重试');
  failing = false;
  h.setNow(NOW0 + 61 * 1000); // 冷却到期
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 2, '冷却后应同键重试');
  assert.equal(svc.calls.use[1].idempotencyKey, deriveUuid(expireAt, '8'));
});


// ===== v8 对抗式审查加固场景 =====

test('v8 防连环扣卡：use 成功后推复查节流，快照滞后 + 第二张卡不再连烧', async () => {
  const h = makeSandbox();
  const a = NOW0 + 30 * MIN, b = NOW0 + 45 * MIN;
  const svc = freshService([a, b].map((t) => ({ expireAt: t })), { usageSnapshot: FIVE_H_LIMIT(0.03) }); // 快照恒 3%
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1, '首轮低量触发一次');
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1, '成功后已推节流：快照滞后也不得连烧第二张');
  assert.equal(svc.calls.usage, 1, '节流期内不得重复拉 usage');
});

test('v8 防队头饿死：队头卡持续失败，60s 冷却让路后续卡', async () => {
  const h = makeSandbox();
  const head = NOW0 + 2 * MIN, tail = NOW0 + 4 * MIN;
  let headFails = true;
  const svc = freshService([{ expireAt: head }, { expireAt: tail }]);
  svc.useCodingPlanReset = async (args) => {
    svc.calls.use.push(args);
    if (args.idempotencyKey === deriveUuid(head, '8') && headFails) throw new Error('head always fails');
    return { used: true };
  };
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1);
  assert.equal(svc.calls.use[0].idempotencyKey, deriveUuid(head, '8'), '首轮打队头');
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use[svc.calls.use.length - 1].idempotencyKey, deriveUuid(tail, '8'), '冷却期内队头让位，后续卡得以触发');
});

test('v8 防键-卡错位（最快过期优先）：乱序列表低量触发时烧最快过期卡', async () => {
  const h = makeSandbox();
  const slow = NOW0 + 4 * 60 * MIN, fast = NOW0 + 30 * MIN;
  const svc = freshService([{ expireAt: slow }, { expireAt: fast }], { usageSnapshot: FIVE_H_LIMIT(0.03) });
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1);
  assert.equal(svc.calls.use[0].idempotencyKey, deriveUuid(fast, '8'), '规则 2 必须优先烧最快过期卡（与服务端消耗假设对齐）');
});

test('v8 形态防御：expireAt 非有限数字的项被跳过，不产生垃圾键', async () => {
  const h = makeSandbox();
  const good = NOW0 + 2 * MIN;
  const svc = freshService([{ expireAt: '2026-11-22T00:00:00Z' }, { expireAt: good }]); // 队头 ISO 字符串（漂移形态）
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1, '正常卡应触发');
  assert.equal(svc.calls.use[0].idempotencyKey, deriveUuid(good, '8'), '必须只发正常卡');
  assert.ok(!/[g-wG-W]/.test(svc.calls.use[0].idempotencyKey), '键必须是纯 hex UUID');
});

test('v8 诊断：usage 无 5h 卡（筛选不命中）时静默降级不崩溃', async () => {
  const h = makeSandbox();
  const svc = freshService([{ expireAt: NOW0 + 30 * MIN }], { usageSnapshot: { quota: { limits: [{ type: 'OTHER', unit: 9, number: 9, remaining: 1 }] } } });
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 0, '读不到 5h 卡时规则 2 空闲');
  assert.equal(svc.calls.usage, 1);
});


// ===== 第一层拦截：只放行「5 小时卡且距过期 ≤1 天」=====

const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('第一层拦截：卡距过期超过 1 天 → 额度再低也不触发，且不拉 usage', async () => {
  const h = makeSandbox();
  const svc = freshService([{ expireAt: NOW0 + 25 * HOUR }], { usageSnapshot: FIVE_H_LIMIT(0.01) });
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 0, '远期卡不得被自动使用');
  assert.equal(svc.calls.usage, 0, '无合格卡时不进入规则 2（不拉 usage）');
});

test('第一层拦截边界：距过期恰好 24 小时可用，多 1 毫秒不可用', async () => {
  const h = makeSandbox();
  const exact = NOW0 + DAY;
  const svc = freshService([{ expireAt: exact + 1 }], { usageSnapshot: FIVE_H_LIMIT(0.03) });
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 0, '24 小时零 1 毫秒 = 超过 1 天，拦截');
  svc.getCodingPlanResetStatus = async () => {
    svc.calls.status += 1;
    return { availableFiveHourResets: [{ expireAt: exact }], availableWeekResets: [] };
  };
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1, '恰好 24 小时 = 不超过 1 天，放行');
  assert.equal(svc.calls.use[0].idempotencyKey, deriveUuid(exact, '8'));
});

test('第一层拦截：远期卡与近期卡并存时只用近期卡，近期卡用完后远期卡仍不动', async () => {
  const h = makeSandbox();
  const far = NOW0 + 3 * DAY;
  const near = NOW0 + 20 * HOUR;
  const svc = freshService([{ expireAt: far }, { expireAt: near }], { usageSnapshot: FIVE_H_LIMIT(0.02) });
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1);
  assert.equal(svc.calls.use[0].idempotencyKey, deriveUuid(near, '8'), '远期卡排在列表前面也不能被选中');
  h.setNow(NOW0 + 6 * MIN); // 快照仍 2%：节流过后规则 2 再次评估
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1, '近期卡已用过，远期卡不得补位');
});

test('远期卡进入 24 小时范围后，低额度下一轮即触发', async () => {
  const h = makeSandbox();
  const expireAt = NOW0 + DAY + 2 * MIN;
  const svc = freshService([{ expireAt }], { usageSnapshot: FIVE_H_LIMIT(0.03) });
  h.sandbox.__zswQuotaCtx = { service: svc, scope: {} };
  boot(h);
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 0, '距过期 24 小时 2 分：拦截');
  h.setNow(NOW0 + 3 * MIN); // 距过期 23 小时 59 分
  h.ticks[0].fn();
  await wait();
  assert.equal(svc.calls.use.length, 1, '进入 24 小时范围后放行');
  assert.equal(svc.calls.use[0].idempotencyKey, deriveUuid(expireAt, '8'));
});
