'use strict';

/**
 * 执行层测试：driver / model-router / runner-spawn / slots。
 *
 * 隔离原则：禁止真跑 zcode.cjs、禁止碰真实 ~/.zcode。
 * - ZSUB_ZCODE_CLI → 临时 fake CLI 脚本（读 --prompt/--resume，输出单行 JSON）
 * - ZSUB_ROOT      → 临时目录（home 池落这里）
 * - HOME           → 临时目录（config.V2_CONFIG_PATH = $HOME/.zcode/v2/config.json）
 * 三者必须在 require 任何 lib 之前设置：config.js 在模块加载期冻结路径。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-exec-'));
process.env.ZSUB_ROOT = path.join(TMP, 'zsub-root');
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

// ---- fake zcode CLI：模拟 `zcode --json` 无头单轮 ----
// FAKE_SLEEP_MS>0：先吐一行提示再挂起（超时/取消测试）；FAKE_GARBAGE=1：输出非 JSON。
const FAKE_CLI = path.join(TMP, 'fake-zcode.cjs');
fs.writeFileSync(FAKE_CLI, `'use strict';
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const prompt = flag('--prompt');
const resume = flag('--resume');
const cwd = flag('--cwd');
const sleepMs = Number(process.env.FAKE_SLEEP_MS || 0);

if (process.env.FAKE_GARBAGE === '1') {
  console.log('this is not json at all');
} else if (sleepMs > 0) {
  console.log(JSON.stringify({ note: 'sleeping before exit' }));
  setTimeout(() => process.exit(0), sleepMs);
} else {
  const sessionId = resume || 'sess_fake_' + Math.random().toString(36).slice(2, 10);
  const response = (resume ? 'resume:' + resume + '|' : '') + 'echo:' + String(prompt).slice(0, 20) + '|cwd:' + cwd;
  console.log(JSON.stringify({ sessionId, response, usage: { input_tokens: 1, output_tokens: 1 } }));
}
`);
process.env.ZSUB_ZCODE_CLI = FAKE_CLI;

// env 隔离完成后才允许 require lib（见文件头注释）
const config = require('../lib/config');
const driver = require('../lib/driver');
const ModelRouter = require('../lib/model-router');
const SpawnRunner = require('../lib/runner-spawn');
const { createSlots } = require('../lib/slots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLAIN_HOME = path.join(TMP, 'plain-home');

/** 写入测试用 v2 config（model-router / bootstrap 的数据源）。 */
function writeV2Config(patch = {}) {
  const base = {
    model: { main: 'builtin:bigmodel-coding-plan/GLM-5.3' },
    provider: {
      'builtin:bigmodel-coding-plan': {
        options: { apiKey: 'test-key' },
        models: { 'GLM-5.3': {}, 'GLM-4.7-Flash': {} },
      },
    },
  };
  const cfg = { ...base, ...patch };
  fs.mkdirSync(path.dirname(config.V2_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(config.V2_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// ---------------------------------------------------------------- driver

test('driver.runHeadless：成功返回 closed + 单 JSON 解析', async () => {
  const result = await driver.runHeadless({
    home: PLAIN_HOME, cwd: TMP, prompt: '这是一段测试提示词内容超过二十个字符',
  });
  assert.equal(result.status, 'closed');
  assert.ok(result.sessionId.startsWith('sess_fake_'));
  assert.ok(result.response.startsWith('echo:'));
  assert.ok(result.response.includes('|cwd:' + TMP));
  assert.equal(result.usage.input_tokens, 1);
});

test('driver.runHeadless：--resume 参数透传且 sessionId 保持', async () => {
  const result = await driver.runHeadless({
    home: PLAIN_HOME, cwd: TMP, prompt: '第二轮', resumeSessionId: 'sess_resume_me',
  });
  assert.equal(result.status, 'closed');
  assert.equal(result.sessionId, 'sess_resume_me');
  assert.ok(result.response.includes('resume:sess_resume_me'));
});

test('driver.runHeadless：home 缺失直接抛错（防落真实 HOME）', () => {
  assert.throws(() => driver.runHeadless({ cwd: TMP, prompt: 'x' }), /home 必填/);
});

test('driver.runHeadless：超时 SIGTERM 链，终态 timeout 带 stdout 尾部，进程已死', async () => {
  process.env.FAKE_SLEEP_MS = '600000';
  try {
    const run = driver.runHeadless({ home: PLAIN_HOME, cwd: TMP, prompt: '挂住', timeoutMs: 300 });
    assert.ok(run.pid > 0);
    const result = await run;
    assert.equal(result.status, 'timeout');
    assert.ok(result.response.includes('sleeping before exit'));
    assert.throws(() => process.kill(run.pid, 0), (e) => e.code === 'ESRCH');
  } finally {
    delete process.env.FAKE_SLEEP_MS;
  }
});

test('driver.runHeadless：非零退出码 → error 终态', async () => {
  const saved = process.env.ZSUB_ZCODE_CLI;
  process.env.ZSUB_ZCODE_CLI = path.join(TMP, 'not-exist.cjs');
  try {
    const result = await driver.runHeadless({ home: PLAIN_HOME, cwd: TMP, prompt: 'x', timeoutMs: 15000 });
    assert.equal(result.status, 'error');
    assert.match(result.error, /退出码/);
  } finally {
    process.env.ZSUB_ZCODE_CLI = saved;
  }
});

test('driver.runHeadless：输出不可解析 → error 终态', async () => {
  process.env.FAKE_GARBAGE = '1';
  try {
    const result = await driver.runHeadless({ home: PLAIN_HOME, cwd: TMP, prompt: 'x', timeoutMs: 15000 });
    assert.equal(result.status, 'error');
    assert.match(result.error, /无法解析/);
  } finally {
    delete process.env.FAKE_GARBAGE;
  }
});

test('driver.bootstrapIsolatedHome：写入 model.main + provider，且不含 plugins（D10 隔断）', () => {
  writeV2Config();
  const home = path.join(TMP, 'bs-home-1');
  const out = driver.bootstrapIsolatedHome(home, 'builtin:bigmodel-coding-plan/GLM-4.7-Flash');
  const cfg = JSON.parse(fs.readFileSync(out.configPath, 'utf8'));
  assert.equal(cfg.model.main, 'builtin:bigmodel-coding-plan/GLM-4.7-Flash');
  assert.equal(cfg.provider['builtin:bigmodel-coding-plan'].options.apiKey, 'test-key');
  assert.equal(cfg.plugins, undefined);
  // 目录里除 config.json 外无 tmp 残留
  assert.deepEqual(fs.readdirSync(path.dirname(out.configPath)), ['config.json']);
});

test('driver.bootstrapIsolatedHome：源缺 provider 配置 → 可操作错误', () => {
  writeV2Config({ provider: {} });
  assert.throws(
    () => driver.bootstrapIsolatedHome(path.join(TMP, 'bs-home-2'), 'builtin:bigmodel-coding-plan/GLM-5.3'),
    /恢复指引/
  );
});

test('driver 有界收集：头部 4KB + 尾部 64KB，中间丢弃', () => {
  const buf = driver.createBoundedLineBuffer();
  for (let i = 0; i < 2000; i++) buf.push(`line-${i}-${'x'.repeat(60)}\n`);
  buf.push('partial-no-newline');
  const text = buf.text();
  assert.ok(text.length <= 4096 + 64 * 1024 + 200);
  assert.ok(text.startsWith('line-0-'));        // 头部保留
  assert.ok(text.includes('partial-no-newline')); // 尾部保留
  assert.ok(text.includes('已丢弃'));            // 中间丢弃有标记
});

// ---------------------------------------------------------- model-router

test('model-router.resolve：短名/全名归一 + requested > agentDefault 优先级', () => {
  writeV2Config();
  const r = new ModelRouter();
  assert.equal(r.resolve('GLM-4.7-Flash'), 'builtin:bigmodel-coding-plan/GLM-4.7-Flash');
  assert.equal(r.resolve('builtin:bigmodel-coding-plan/GLM-5.3'), 'builtin:bigmodel-coding-plan/GLM-5.3');
  assert.equal(r.resolve('GLM-5.3', 'GLM-4.7-Flash'), 'builtin:bigmodel-coding-plan/GLM-5.3');
  assert.equal(r.resolve(null, 'GLM-4.7-Flash'), 'builtin:bigmodel-coding-plan/GLM-4.7-Flash');
});

test('model-router.resolve：默认链读 v2 config 主模型，读不到回退 GLM-5.3', () => {
  writeV2Config({ model: { main: 'builtin:bigmodel-coding-plan/GLM-4.7-Flash' } });
  assert.equal(new ModelRouter().resolve(), 'builtin:bigmodel-coding-plan/GLM-4.7-Flash');
  writeV2Config({ model: { main: '' } });
  assert.equal(new ModelRouter().resolve(), 'builtin:bigmodel-coding-plan/GLM-5.3');
});

test('model-router.resolve：未知模型/不支持的 provider 抛可操作错误（列清单）', () => {
  writeV2Config();
  const r = new ModelRouter();
  assert.throws(() => r.resolve('GLM-9.9'), (err) =>
    /未知模型/.test(err.message)
    && err.message.includes('GLM-5.3')
    && err.message.includes('GLM-4.7-Flash')
    && err.message.includes('恢复指引'));
  assert.throws(() => r.resolve('other-provider/SomeModel'), /不支持的模型引用/);
});

test('model-router.resolve：清单读不到——显式指定抛错，默认放行（bootstrap 再报）', () => {
  writeV2Config({ provider: {} });
  assert.throws(() => new ModelRouter().resolve('GLM-5.3'), /不能校验/);
  assert.equal(new ModelRouter().resolve(), 'builtin:bigmodel-coding-plan/GLM-5.3');
});

test('model-router.prepareRunEnv(spawn)：建 HOME 池 + mtime 条件重写', async () => {
  writeV2Config();
  const r = new ModelRouter();
  const ref = r.resolve('GLM-4.7-Flash');
  const env1 = await r.prepareRunEnv(ref, 'spawn');
  assert.equal(env1.env.HOME, config.homePoolDir('GLM-4.7-Flash'));
  assert.equal(env1.env.ZSUB_NESTED, '1');
  const poolCfg = path.join(env1.env.HOME, '.zcode', 'cli', 'config.json');
  assert.equal(JSON.parse(fs.readFileSync(poolCfg, 'utf8')).model.main, ref);

  // 源 mtime 变旧 → 跳过重写（池内 mtime 不变）
  const m1 = fs.statSync(poolCfg).mtimeMs;
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(config.V2_CONFIG_PATH, past, past);
  await r.prepareRunEnv(ref, 'spawn');
  assert.equal(fs.statSync(poolCfg).mtimeMs, m1);

  // 源更新（apiKey 刷新）→ 重写
  await sleep(20);
  writeV2Config({
    provider: { 'builtin:bigmodel-coding-plan': { options: { apiKey: 'new-key' }, models: { 'GLM-4.7-Flash': {} } } },
  });
  await r.prepareRunEnv(ref, 'spawn');
  const cfg2 = JSON.parse(fs.readFileSync(poolCfg, 'utf8'));
  assert.equal(cfg2.provider['builtin:bigmodel-coding-plan'].options.apiKey, 'new-key');
});

test('model-router.prepareRunEnv(appserver)：只给 createParams，不触发 HOME 池', async () => {
  writeV2Config();
  const out = await new ModelRouter().prepareRunEnv('builtin:bigmodel-coding-plan/GLM-5.3', 'appserver');
  assert.deepEqual(out, { createParams: { model: 'builtin:bigmodel-coding-plan/GLM-5.3' } });
  assert.equal(out.env, undefined);
});

// ----------------------------------------------------------------- slots

test('slots：并发上限（超限排队，释放补位）', async () => {
  const slots = createSlots({ limit: 3 });
  const held = [slots.acquire(), slots.acquire(), slots.acquire()];
  assert.equal(slots.running(), 3); // pump 同步递增，不等微任务

  let got4 = false;
  const p4 = slots.acquire().then((rel) => { got4 = true; return rel; });
  await sleep(30);
  assert.equal(got4, false);

  (await held[0])();
  await p4;
  assert.equal(got4, true);
  assert.equal(slots.running(), 3);

  (await held[1])(); (await held[2])(); (await p4)();
  assert.equal(slots.running(), 0);
});

test('slots：严格 FIFO 排队顺序', async () => {
  const slots = createSlots({ limit: 1 });
  const order = [];
  const h1 = await slots.acquire();
  const waits = [1, 2, 3].map(async (i) => {
    const rel = await slots.acquire();
    order.push(i);
    rel();
  });
  await sleep(30);
  assert.deepEqual(order, []);
  h1();
  await Promise.all(waits);
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(slots.running(), 0);
});

test('slots：深度分层 max(1, limit - depth)，严格 FIFO 不插队', async () => {
  const slots = createSlots({ limit: 3 });
  const top = await slots.acquire(0);
  assert.equal(slots.running(), 1);

  let deepStarted = false, midStarted = false;
  const deep = slots.acquire(2).then((rel) => { deepStarted = true; return rel; });
  const mid = slots.acquire(1).then((rel) => { midStarted = true; return rel; });
  await sleep(20);
  // 深层（effLimit=1）被占用排队；浅层（effLimit=2）本可运行，但严格 FIFO
  // 禁止越过队首插队 → 两者都在等
  assert.equal(deepStarted, false);
  assert.equal(midStarted, false);

  top(); // running=0 → 队首 deep 先获得（effLimit=1 满足）
  const deepRel = await deep;
  assert.equal(deepStarted, true);
  const midRel = await mid; // deep 获得后 mid 成为队首，effLimit=2 且 running=1 → 顺位获得（非插队）
  assert.equal(midStarted, true);
  assert.equal(slots.running(), 2);

  deepRel();
  assert.equal(slots.running(), 1);
  midRel();
  assert.equal(slots.running(), 0);
});

test('slots：depth >= limit 保底 1（嵌套只能串行）', async () => {
  const slots = createSlots({ limit: 3 });
  const top = await slots.acquire(0);
  let nestedStarted = false;
  const nested = slots.acquire(5).then((rel) => { nestedStarted = true; return rel; });
  await sleep(20);
  assert.equal(nestedStarted, false); // effLimit = max(1, 3-5) = 1，被 top 占用

  top();
  const rel = await nested;
  assert.equal(nestedStarted, true);
  rel();
  assert.equal(slots.running(), 0);
});

// ---------------------------------------------------------- runner-spawn

/** 组装完整 taskCtx（含 prepareRunEnv 产物）并启动 runner。 */
async function startFakeRunner(overrides = {}) {
  writeV2Config();
  const router = new ModelRouter();
  const modelRef = router.resolve('GLM-4.7-Flash');
  const runEnv = await router.prepareRunEnv(modelRef, 'spawn');
  const runner = new SpawnRunner();
  const taskCtx = {
    subagentId: 'sa-test', slug: 'test', prompt: '执行层集成测试提示词',
    cwd: TMP, modelRef, timeoutMs: 15000, conversation: true, runEnv,
    ...overrides,
  };
  return { runner, handle: runner.start(taskCtx), taskCtx };
}

test('SpawnRunner/ModelRouter：方法名与 ports.js 契约一致 + probe/capabilities', async () => {
  const runner = new SpawnRunner();
  for (const m of ['probe', 'start', 'resume', 'alive', 'capabilities']) {
    assert.equal(typeof runner[m], 'function', `runner.${m}`);
  }
  const router = new ModelRouter();
  for (const m of ['resolve', 'prepareRunEnv']) {
    assert.equal(typeof router[m], 'function', `router.${m}`);
  }
  assert.deepEqual(await runner.probe(), { ok: true });
  assert.deepEqual(runner.capabilities(), { kind: 'spawn', steering: 'none', coldStartMs: 1500 });
});

test('SpawnRunner：start→done→exec.sessionId 回填，退出后 alive=false', async () => {
  const { runner, handle } = await startFakeRunner();
  assert.equal(handle.exec.kind, 'spawn');
  assert.ok(handle.exec.pid > 0);
  const result = await handle.done;
  assert.equal(result.status, 'closed');
  assert.ok(result.usage);
  assert.equal(handle.exec.sessionId, result.sessionId);
  assert.ok(handle.exec.sessionId.startsWith('sess_fake_'));
  assert.equal(runner.alive(handle.exec), false);
});

test('SpawnRunner：runEnv 缺失 → 报错并指向 prepareRunEnv', () => {
  const runner = new SpawnRunner();
  assert.throws(() => runner.start({ prompt: 'x', cwd: TMP }), /prepareRunEnv/);
});

test('SpawnRunner：alive(running)=true + cancel → cancelled + 进程退出', async () => {
  process.env.FAKE_SLEEP_MS = '600000';
  try {
    const { runner, handle } = await startFakeRunner();
    assert.equal(runner.alive(handle.exec), true);
    handle.cancel();
    const result = await handle.done;
    assert.equal(result.status, 'cancelled');
    assert.equal(runner.alive(handle.exec), false);
  } finally {
    delete process.env.FAKE_SLEEP_MS;
  }
});

test('SpawnRunner：resume 透传 --resume，sessionId 保持，不重建 HOME', async () => {
  const { runner, handle } = await startFakeRunner();
  await handle.done;
  const r2 = await runner.resume(handle.exec, '第二轮消息', { timeoutMs: 15000 });
  assert.equal(r2.status, 'closed');
  assert.ok(r2.response.includes(`resume:${handle.exec.sessionId}`));
  assert.equal(r2.sessionId, handle.exec.sessionId);
  // resume 不 bootstrap：HOME 目录 mtime 不变（无重写）
  const poolCfg = path.join(handle.exec.home, '.zcode', 'cli', 'config.json');
  const before = fs.statSync(poolCfg).mtimeMs;
  await runner.resume(handle.exec, '第三轮消息', { timeoutMs: 15000 });
  assert.equal(fs.statSync(poolCfg).mtimeMs, before);
});

test('SpawnRunner：resume 拒绝非 spawn 句柄 / sessionId 未回填', async () => {
  const runner = new SpawnRunner();
  await assert.rejects(() => runner.resume({}, 'x'), /spawn/);
  await assert.rejects(() => runner.resume({ kind: 'spawn', pid: 1 }, 'x'), /sessionId/);
  await assert.rejects(() => runner.resume({ kind: 'apc', sessionId: 's' }, 'x'), /spawn/);
});
