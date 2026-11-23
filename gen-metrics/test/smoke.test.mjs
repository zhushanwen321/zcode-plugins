import test from 'node:test';
import assert from 'node:assert/strict';
import { activate } from '../extension.mjs';

function mockCtx() {
  const state = { listeners: [], updates: [], logs: [] };
  state.models = { onDidGenerate(fn) { state.listeners.push(fn); return { dispose() {} }; } };
  state.slots = { update(id, patch, scope) { state.updates.push({ id, patch, scope }); } };
  state.commands = { register(id) { state.logs.push(`register:${id}`); } };
  state.env = { onDidChange() { return { dispose() {} }; }, get: async () => ({ locale: 'zh-CN' }) };
  state.log = { info(m) { state.logs.push(m); }, warn(m) { state.logs.push(m); } };
  return state;
}

const finalMetric = (over = {}) => ({
  sessionId: 's1',
  requestId: 'r1',
  model: { providerId: 'bigmodel', modelId: 'GLM-5.3' },
  phase: 'final',
  outputTokensPerSecond: 42.3,
  outputTokens: 583,
  timeToFirstTokenMs: 1545,
  ...over,
});

// activate 里 ctx.env.get() 异步初始化语言，等一个宏任务再触发事件，保证断言确定性
const settle = () => new Promise((r) => setImmediate(r));

test('final 相位更新会话作用域插槽；streaming 相位忽略', async () => {
  const ctx = mockCtx();
  await activate(ctx);
  await settle();
  ctx.listeners[0](finalMetric({ phase: 'streaming', outputTokensPerSecond: 999 }));
  assert.equal(ctx.updates.length, 0, 'streaming 估算不上屏');
  ctx.listeners[0](finalMetric());
  assert.equal(ctx.updates.length, 1);
  assert.equal(ctx.updates[0].id, 'gen-metrics');
  assert.deepEqual(ctx.updates[0].scope, { sessionId: 's1' });
  assert.equal(ctx.updates[0].patch.text, '42 tok/s · TTFT 1.5s');
  assert.ok(ctx.updates[0].patch.tooltip.includes('输出 583 tok'), ctx.updates[0].patch.tooltip);
  assert.ok(ctx.updates[0].patch.tooltip.includes('首 token 1.5s'), ctx.updates[0].patch.tooltip);
});

test('ttft 缺失时只显示速度；低速一位小数；英文回退', async () => {
  const ctx = mockCtx();
  ctx.env.get = async () => ({ locale: 'en-US' });
  await activate(ctx);
  await settle();
  ctx.listeners[0](finalMetric({ sessionId: 's2', timeToFirstTokenMs: undefined, outputTokensPerSecond: 9.46 }));
  assert.equal(ctx.updates[0].patch.text, '9.5 tok/s');
  assert.ok(ctx.updates[0].patch.tooltip.includes('583 output tok'), ctx.updates[0].patch.tooltip);
  assert.ok(!ctx.updates[0].patch.tooltip.includes('输出'), ctx.updates[0].patch.tooltip);
});

test('不同会话互不串扰；text 超长截断保护', async () => {
  const ctx = mockCtx();
  await activate(ctx);
  await settle();
  ctx.listeners[0](finalMetric({ sessionId: 'a', outputTokensPerSecond: 12 }));
  ctx.listeners[0](finalMetric({ sessionId: 'b', outputTokensPerSecond: 34 }));
  assert.equal(ctx.updates[0].scope.sessionId, 'a');
  assert.equal(ctx.updates[1].scope.sessionId, 'b');
  assert.equal(ctx.updates[0].patch.text, '12 tok/s · TTFT 1.5s');
});
