import test from 'node:test';
import assert from 'node:assert/strict';
import { activate, deactivate } from '../extension.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 并发轮询夹具:临时状态文件(注入 activate,隔离真实 HOME)
function makeStatusFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-smoke-'));
  const file = path.join(dir, 'status.json');
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
let statusFile;
test.before(() => { statusFile = makeStatusFile().file; });

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
  await activate(ctx, { statusFile: path.join(os.tmpdir(), 'gm-none-' + process.pid + '.json') });
  test.after(() => deactivate());
  await settle();
  ctx.listeners[0](finalMetric({ phase: 'streaming', outputTokensPerSecond: 999 }));
  const gmUpdates = () => ctx.updates.filter((u) => u.id === 'gen-metrics');
  assert.equal(gmUpdates().length, 0, 'streaming 估算不上屏');
  ctx.listeners[0](finalMetric());
  const gm = gmUpdates()[0];
  assert.deepEqual(gm.scope, { sessionId: 's1' });
  assert.equal(gm.patch.text, '42 tok/s · TTFT 1.5s');
  assert.ok(gm.patch.tooltip.includes('输出 583 tok'), gm.patch.tooltip);
  assert.ok(gm.patch.tooltip.includes('首 token 1.5s'), gm.patch.tooltip);
});

test('ttft 缺失时只显示速度；低速一位小数；英文回退', async () => {
  const ctx = mockCtx();
  ctx.env.get = async () => ({ locale: 'en-US' });
  await activate(ctx, { statusFile: path.join(os.tmpdir(), 'gm-none-' + process.pid + '.json') });
  test.after(() => deactivate());
  await settle();
  ctx.listeners[0](finalMetric({ sessionId: 's2', timeToFirstTokenMs: undefined, outputTokensPerSecond: 9.46 }));
  const gm = ctx.updates.filter((u) => u.id === 'gen-metrics')[0];
  assert.equal(gm.patch.text, '9.5 tok/s');
  assert.ok(gm.patch.tooltip.includes('583 output tok'), gm.patch.tooltip);
  assert.ok(!gm.patch.tooltip.includes('输出'), gm.patch.tooltip);
});

test('不同会话互不串扰；text 超长截断保护', async () => {
  const ctx = mockCtx();
  await activate(ctx, { statusFile: path.join(os.tmpdir(), 'gm-none-' + process.pid + '.json') });
  test.after(() => deactivate());
  await settle();
  ctx.listeners[0](finalMetric({ sessionId: 'a', outputTokensPerSecond: 12 }));
  ctx.listeners[0](finalMetric({ sessionId: 'b', outputTokensPerSecond: 34 }));
  const bySession = ctx.updates.filter((u) => u.id === 'gen-metrics').map((u) => u.scope.sessionId);
  assert.deepEqual(bySession, ['a', 'b']);
  assert.equal(ctx.updates.filter((u) => u.id === 'gen-metrics')[0].patch.text, '12 tok/s · TTFT 1.5s');
});

test('并发条目:读状态快照全局渲染,含排队;无数据隐藏', async () => {
  // 写入模拟快照(双 provider 聚合形态)
  fs.writeFileSync(
    statusFile,
    JSON.stringify({
      pids: {
        '100': { providers: { 'prov-a': { limit: 7, active: 2, queued: 1 } }, updatedAt: 'x' },
        '200': { providers: { 'prov-a': { limit: 7, active: 1, queued: 0 }, 'prov-b': { limit: 7, active: 0, queued: 0 } }, updatedAt: 'x' },
      },
    }),
    'utf8',
  );
  const ctx = mockCtx();
  await activate(ctx, { statusFile });
  test.after(() => deactivate());
  await settle();
  const upd = ctx.updates.find((u) => u.id === 'gen-concurrency');
  assert.ok(upd, '应更新并发条目');
  assert.equal(upd.scope, undefined, '全局作用域(不带 sessionId)');
  assert.equal(upd.patch.text, 'conc 3/7 · queue 1'); // 双 pid 聚合 active=3 queued=1;首 poll 先于 env.get,locale 仍 en
  assert.ok(upd.patch.tooltip.includes('prov-a: 3/7'), upd.patch.tooltip);
  assert.ok(upd.patch.tooltip.includes('prov-b: 0/7'), upd.patch.tooltip);
});

test('并发条目:状态文件缺失时隐藏(text null)', async () => {
  const ctx = mockCtx();
  await activate(ctx, { statusFile: path.join(os.tmpdir(), 'gm-no-such-file.json') });
  test.after(() => deactivate());
  await settle();
  const upd = ctx.updates.find((u) => u.id === 'gen-concurrency');
  assert.ok(upd, '应有一次隐藏更新');
  assert.equal(upd.patch.text, null);
});
