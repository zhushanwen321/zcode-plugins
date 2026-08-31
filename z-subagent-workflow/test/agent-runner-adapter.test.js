'use strict';
/**
 * agent-runner-adapter 单测（回接 2b）。
 *
 * 承接已删除的 test/workflow-apc.test.js 的核心断言面（旧 workflow 入口
 * 函数的 apc 翻转面测试随入口退役；「agent() 调用经 zsw RunnerPort」的
 * 契约现在钉在这里）：
 * - taskCtx 契约：runner.start 收到 {prompt, cwd, modelRef, timeoutMs, engine}
 *   （2c 起无 runEnv——模型校验/环境准备归 core 引擎 preparer）；
 * - 各调用 done 后 release 被调（D2 全终态释放）；
 * - 运行中 abort → handle.cancel 被调；
 * - AgentResult 映射：closed → content/parsedOutput（schema 经 jsonout 提取）
 *   /usage（snake_case → camelCase）；非 closed → error 携带；
 * - agent .md 解析链：opts.agent → resolver.resolve（D-4a：仅绝对路径，名字
 *   拒且文案与 core agent-registry 同源；缺省 → resolveDefault =
 *   general-purpose 内置角色——W6b）。
 *
 * 隔离：fake zsw RunnerPort + fake ModelRouter，零引擎零真实 HOME。
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { createAgentRunnerAdapter } = require('../lib/agent-runner-adapter');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-adapter-'));
const WORKDIR = path.join(TMP, 'workdir');
fs.mkdirSync(WORKDIR, { recursive: true });

/** fake zsw RunnerPort：可编程结果 / cancel 记录 / release 记录。 */
function makeFakeZswRunner({ result, kind = 'appserver', hold = false } = {}) {
  const state = { starts: [], cancels: 0, releases: [] };
  return {
    state,
    capabilities: () => ({ kind, steering: 'none', coldStartMs: 100 }),
    start(taskCtx) {
      state.starts.push(taskCtx);
      let cancelled = false;
      const done = hold
        ? new Promise((resolve) => {
          const onAbort = () => { cancelled = true; resolve({ status: 'cancelled', response: null }); };
          // hold 形态由 adapter 的 signal 触发 cancel 后由本 fake 自行终态化
          setImmediate(() => { /* 挂住直到 cancel */ });
          state._onCancel = onAbort;
        })
        : Promise.resolve(result || { status: 'closed', response: 'ok', usage: { input_tokens: 3, output_tokens: 5 }, sessionId: 'sess-1' });
      return {
        exec: { kind, sessionId: 'sess-1' },
        cancel: () => { state.cancels += 1; if (state._onCancel) state._onCancel(); },
        done,
      };
    },
    release(exec) {
      state.releases.push(exec);
      return Promise.resolve();
    },
  };
}

/** fake ModelRouter（2c 后执行链不再消费；保留注入形态对齐 orchestration-host 组装面）。 */
function makeFakeRouter() {
  return { resolveDefault: () => 'prov/model-x' };
}

function makeAdapter(runner, router, resolver) {
  return createAgentRunnerAdapter({
    runner: runner || makeFakeZswRunner(),
    modelRouter: router || makeFakeRouter(),
    resolver,
    fallbackCwd: WORKDIR,
  });
}

test('taskCtx 契约：start 收到 prompt/cwd/modelRef/timeoutMs/engine（无 runEnv），done 后 release', async () => {
  const runner = makeFakeZswRunner();
  const router = makeFakeRouter();
  const adapter = makeAdapter(runner, router);
  const signal = new AbortController().signal;

  const r = await adapter.run({
    prompt: '任务书',
    model: 'prov/model-y',
    timeoutMs: 65000,
    engine: 'zcode',
  }, signal);

  // 模型原始透传 + 调用参数 engine 进 core 路由三层（2c）；runEnv 已随
  // model-router 瘦身消失
  assert.equal(runner.state.starts.length, 1);
  const ctx = runner.state.starts[0];
  assert.ok(ctx.prompt.includes('任务书'));
  assert.equal(ctx.cwd, WORKDIR, 'opts.cwd 缺省回落 fallbackCwd（= run 的 workdir）');
  assert.equal(ctx.modelRef, 'prov/model-y');
  assert.equal(ctx.engine, 'zcode', 'opts.engine 透传（调用参数层最优先）');
  assert.equal(ctx.runEnv, undefined, '2c 起无环境准备产物');
  assert.equal(ctx.timeoutMs, 65000);
  // D2：done 落定后一次性会话释放（成功态也释放）
  assert.equal(runner.state.releases.length, 1);
  assert.equal(runner.state.releases[0].kind, 'appserver');
  // 结果映射
  assert.equal(r.content, 'ok');
  assert.equal(r.error, undefined);
  assert.equal(r.sessionId, 'sess-1');
  assert.deepEqual(r.usage, { input: 3, output: 5, cacheRead: undefined, cacheWrite: undefined, turns: undefined });
});

test('schema → parsedOutput（jsonout 提取）；opts.cwd 覆盖 fallback', async () => {
  const runner = makeFakeZswRunner({
    result: { status: 'closed', response: '前缀垃圾 {"insights":"i"} 尾部', usage: null },
  });
  const adapter = makeAdapter(runner);
  const r = await adapter.run({
    prompt: 'p',
    schema: { type: 'object' },
    cwd: '/custom/cwd',
  }, undefined);
  assert.deepEqual(r.parsedOutput, { insights: 'i' });
  assert.equal(runner.state.starts[0].cwd, '/custom/cwd');
  // 无 schema 不提取（core 语义：schema 提供且可解析才有 parsedOutput）
  const r2 = await adapter.run({ prompt: 'p', cwd: '/x' }, undefined);
  assert.equal(r2.parsedOutput, undefined);
});

test('非 closed 终态 → AgentResult.error 携带（core 据此判 call 失败）', async () => {
  const runner = makeFakeZswRunner({ result: { status: 'error', error: '引擎崩了' } });
  const adapter = makeAdapter(runner);
  const r = await adapter.run({ prompt: 'p' }, undefined);
  assert.equal(r.content, '');
  assert.equal(r.error, '引擎崩了');
  assert.equal(r.usage, undefined);
  assert.equal(runner.state.releases.length, 1, '失败态同样释放');
});

test('运行中 abort → handle.cancel 被调 + listener 摘除；启动前 abort → AbortError', async () => {
  const runner = makeFakeZswRunner({ hold: true });
  const adapter = makeAdapter(runner);
  const ctl = new AbortController();
  const p = adapter.run({ prompt: 'p' }, ctl.signal);
  // 等 start 已发生（缺省 resolver 的 resolveDefault 走 core 异步发现链——
  // 多个 await 点；直接同步 abort 会命中启动前预检的双检查窗口，那是
  // pre-abort 语义，不是本用例对象）
  const deadline = Date.now() + 5000;
  while (runner.state.starts.length < 1 && Date.now() < deadline) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(runner.state.starts.length, 1, 'run 已进入执行段');
  ctl.abort();
  const r = await p;
  assert.equal(runner.state.cancels, 1, 'abort 传播到 handle.cancel');
  assert.equal(r.error.includes('cancelled'), true);

  // pre-abort：不做环境准备直接 AbortError（name 判定是 core 预检分支契约）
  const ctl2 = new AbortController();
  ctl2.abort();
  await assert.rejects(
    adapter.run({ prompt: 'p' }, ctl2.signal),
    (e) => e.name === 'AbortError',
  );
  assert.equal(runner.state.starts.length, 1, 'pre-abort 不触发第二次 start');
});

test('opts.agent → resolver.resolve（prompt 拼角色段）；非法引用/不可读抛 core 同源错误', async () => {
  const profile = {
    name: 'reviewer',
    body: '你是审查员',
    model: 'prov/agent-model',
    skills: ['/sk/a.md'],
    disallowedTools: ['Bash'],
  };
  const resolver = {
    resolve: (ref, cwd) => (ref === '/a/reviewer.md' ? { ...profile, filePath: '/a/reviewer.md' } : null),
    resolveDefault: () => null,
  };
  const runner = makeFakeZswRunner();
  const router = makeFakeRouter();
  const adapter = makeAdapter(runner, router, resolver);

  const r = await adapter.run({ prompt: 'p', agent: '/a/reviewer.md' }, undefined);
  assert.ok(runner.state.starts[0].prompt.includes('你是审查员'), 'agent .md 正文拼进 prompt');
  assert.equal(runner.state.starts[0].modelRef, 'prov/agent-model', '模型解析链 requested > agent frontmatter');
  assert.deepEqual(runner.state.starts[0].disallowedTools, ['Bash'], 'frontmatter 工具黑名单透传');
  assert.equal(r.content, 'ok');

  // D-4a（W6b）：名字拒——文案与 core agent-registry 同源（主句逐字一致），
  // 与 manager.start 同款断言（两消费方共用 agent-discovery 单点文案）
  await assert.rejects(
    adapter.run({ prompt: 'p', agent: 'nope' }, undefined),
    (e) => e.message.startsWith('Invalid agent ref: nope. Agent refs must be absolute paths to .md files')
      && e.message.includes('zsw agents'),
  );
  // 路径合法但不可读：Agent file not found 同款
  await assert.rejects(
    adapter.run({ prompt: 'p', agent: '/a/missing.md' }, undefined),
    (e) => e.message.startsWith('Agent file not found or unreadable: /a/missing.md.'),
  );
});

test('opts.agent 缺省 → resolveDefault 加载 general-purpose 角色（与 pi DEFAULT_AGENT_NAME 对齐）', async () => {
  const resolver = {
    resolve: () => null,
    resolveDefault: () => ({ name: 'general-purpose', body: '你是通用兜底 agent', filePath: '/a/general-purpose.md' }),
  };
  const runner = makeFakeZswRunner();
  const adapter = makeAdapter(runner, makeFakeRouter(), resolver);
  await adapter.run({ prompt: 'p' }, undefined);
  assert.ok(runner.state.starts[0].prompt.includes('通用兜底 agent'), '缺省角色正文拼进 prompt');
});

test('model 缺省链：opts.model 与 agent frontmatter 均无 → modelRef=undefined（兜底归引擎 preparer）', async () => {
  const runner = makeFakeZswRunner({ kind: 'spawn' });
  const adapter = makeAdapter(runner);
  await adapter.run({ prompt: 'p' }, undefined);
  const ctx = runner.state.starts[0];
  assert.equal(ctx.modelRef, undefined, '无显式模型时不造默认值，引擎 preparer 兜底');
  assert.equal(ctx.runEnv, undefined);
});

test('opts.prompt 必填校验（可操作错误）', async () => {
  const adapter = makeAdapter();
  await assert.rejects(adapter.run({}, undefined), /opts.prompt 必填/);
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});
