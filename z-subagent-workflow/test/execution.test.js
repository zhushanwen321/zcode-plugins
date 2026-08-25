'use strict';

/**
 * 执行层测试：driver / model-router / runner-spawn / slots + manager 取消
 * 竞态门卫（S-6②，计数 notifier 断言，不依赖 manager.test.js）。
 *
 * 隔离原则：禁止真跑 zcode.cjs、禁止碰真实 ~/.zcode。
 * - ZSW_ZCODE_CLI → 临时 fake CLI 脚本（读 --prompt/--resume，输出单行 JSON）
 * - ZSW_ROOT      → 临时目录（home 池落这里）
 * - HOME           → 临时目录（config.V2_CONFIG_PATH = $HOME/.zcode/v2/config.json）
 * 三者必须在 require 任何 lib 之前设置：config.js 在模块加载期冻结路径。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-exec-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsub-root');
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
process.env.ZSW_ZCODE_CLI = FAKE_CLI;

// env 隔离完成后才允许 require lib（见文件头注释）
const config = require('../lib/config');
const driver = require('../lib/driver');
const ModelRouter = require('../lib/model-router');
const SpawnRunner = require('../lib/runner-spawn');
const { createSlots } = require('../lib/slots');
const { SubagentManager } = require('../lib/manager');
const { RecordStore } = require('../lib/record-store');
const outputs = require('../lib/output-store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLAIN_HOME = path.join(TMP, 'plain-home');

/** 轮询等待条件成立（超时抛错，失败信息可定位）。 */
async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await sleep(10);
  }
}

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

function writeCliConfig(patch = {}) {
  fs.mkdirSync(path.dirname(config.CLI_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(config.CLI_CONFIG_PATH, JSON.stringify(patch, null, 2));
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

test('driver.runHeadless：不传 timeoutMs（DEFAULTS.timeoutMs=null）不建 timer，慢进程正常 closed（回归 a04db4c）', async () => {
  process.env.FAKE_SLEEP_MS = '300'; // >1ms：若 null 被强转 1ms timer 会先杀进程成 timeout
  try {
    const result = await driver.runHeadless({ home: PLAIN_HOME, cwd: TMP, prompt: '慢退出' });
    assert.equal(result.status, 'closed');
  } finally {
    delete process.env.FAKE_SLEEP_MS;
  }
});

test('driver.runHeadless：显式 timeoutMs: null 同样无超时，慢进程正常 closed', async () => {
  process.env.FAKE_SLEEP_MS = '300';
  try {
    const result = await driver.runHeadless({ home: PLAIN_HOME, cwd: TMP, prompt: '慢退出', timeoutMs: null });
    assert.equal(result.status, 'closed');
  } finally {
    delete process.env.FAKE_SLEEP_MS;
  }
});

test('driver.runHeadless：非零退出码 → error 终态', async () => {
  const saved = process.env.ZSW_ZCODE_CLI;
  process.env.ZSW_ZCODE_CLI = path.join(TMP, 'not-exist.cjs');
  try {
    const result = await driver.runHeadless({ home: PLAIN_HOME, cwd: TMP, prompt: 'x', timeoutMs: 15000 });
    assert.equal(result.status, 'error');
    assert.match(result.error, /退出码/);
  } finally {
    process.env.ZSW_ZCODE_CLI = saved;
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

test('driver.runHeadless：disallowedTools → --disallowed-tools 逗号连接；未传/空数组不加 flag（MUST_FIX-3）', async () => {
  // 专用 fake CLI：把收到的 argv 逐行写入报告文件（writeFileSync 先于
  // console.log，close 事件后读文件时序安全）
  const report = path.join(TMP, 'argv-report.txt');
  const argCli = path.join(TMP, 'fake-argv-cli.cjs');
  fs.writeFileSync(argCli, [
    "'use strict';",
    'const fs = require("fs");',
    'fs.writeFileSync(process.env.ARGV_REPORT, process.argv.slice(2).join("\\n"));',
    'console.log(JSON.stringify({ sessionId: "sess_argv", response: "ok", usage: {} }));',
    '',
  ].join('\n'));
  const savedCli = process.env.ZSW_ZCODE_CLI;
  process.env.ARGV_REPORT = report;
  try {
    process.env.ZSW_ZCODE_CLI = argCli;
    // 非法元素（非字符串）被过滤，合法项保序逗号连接
    let r = await driver.runHeadless({
      home: PLAIN_HOME, cwd: TMP, prompt: 'denylist 透传验证',
      disallowedTools: ['web-search', 'mcp__x__y', null, ''],
    });
    assert.equal(r.status, 'closed');
    let argv = fs.readFileSync(report, 'utf8');
    assert.ok(argv.includes('--disallowed-tools'));
    assert.ok(argv.includes('web-search,mcp__x__y'), '逗号连接且非法元素被过滤');

    await driver.runHeadless({ home: PLAIN_HOME, cwd: TMP, prompt: '无 denylist' });
    argv = fs.readFileSync(report, 'utf8');
    assert.ok(!argv.includes('--disallowed-tools'), '未传不加 flag');

    await driver.runHeadless({ home: PLAIN_HOME, cwd: TMP, prompt: '空数组', disallowedTools: [] });
    argv = fs.readFileSync(report, 'utf8');
    assert.ok(!argv.includes('--disallowed-tools'), '空数组不加 flag');
  } finally {
    process.env.ZSW_ZCODE_CLI = savedCli;
    delete process.env.ARGV_REPORT;
  }
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

test('model-router.resolve：默认模型优先 cli config 主模型，但仅当可被 v2 清单解析', () => {
  // cli config 可解析全名 → 采用（当前会卷模型跟随）
  writeV2Config({ model: { main: 'builtin:bigmodel-coding-plan/GLM-5.3' } });
  writeCliConfig({ model: { main: 'builtin:bigmodel-coding-plan/GLM-4.7-Flash' } });
  assert.equal(new ModelRouter().resolve(), 'builtin:bigmodel-coding-plan/GLM-4.7-Flash');
  // cli config 短名可解析 → 按默认 provider 解析采用
  writeCliConfig({ model: { main: 'GLM-4.7-Flash' } });
  assert.equal(new ModelRouter().resolve(), 'builtin:bigmodel-coding-plan/GLM-4.7-Flash');
  // 桌面端内部命名空间（router/…）不可解析 → 回退 v2.main，不抛错（真实事故：2026-08-25 review-fix-loop 入口炸）
  writeCliConfig({ model: { main: 'router/mimo-v2.5-pro' } });
  assert.equal(new ModelRouter().resolve(), 'builtin:bigmodel-coding-plan/GLM-5.3');
  // cli config 不可解析 + v2.main 空 → 内置 fallback
  writeV2Config({ model: { main: '' } });
  assert.equal(new ModelRouter().resolve(), 'builtin:bigmodel-coding-plan/GLM-5.3');
});

test('model-router.resolve：未知模型/未知 provider 抛可操作错误（列清单）', () => {
  writeV2Config();
  const r = new ModelRouter();
  assert.throws(() => r.resolve('GLM-9.9'), (err) =>
    /未知模型/.test(err.message)
    && err.message.includes('GLM-5.3')
    && err.message.includes('GLM-4.7-Flash')
    && err.message.includes('恢复指引'));
  assert.throws(() => r.resolve('other-provider/SomeModel'), (err) =>
    /未知 provider/.test(err.message)
    && err.message.includes('builtin:bigmodel-coding-plan')
    && err.message.includes('恢复指引'));
});

test('model-router.resolve：provider/model 全名精确匹配多 provider（跨 provider 同名模型不串）', () => {
  writeV2Config({
    provider: {
      'builtin:bigmodel-coding-plan': {
        options: { apiKey: 'k1' },
        models: { 'GLM-5.3': {}, 'shared-model': {} },
      },
      'openai-compatible/foo': {
        options: { apiKey: 'k2' },
        models: { 'gpt-x': {}, 'shared-model': {} },
      },
    },
  });
  const r = new ModelRouter();
  // 各 provider 各自的全名精确解析（返回保留 provider 前缀，不归一到默认）
  assert.equal(r.resolve('openai-compatible/foo/gpt-x'), 'openai-compatible/foo/gpt-x');
  // 同名模型跨 provider：解析到显式指定的那个
  assert.equal(r.resolve('openai-compatible/foo/shared-model'), 'openai-compatible/foo/shared-model');
  assert.equal(r.resolve('builtin:bigmodel-coding-plan/shared-model'), 'builtin:bigmodel-coding-plan/shared-model');
  // 短名仍走默认 provider
  assert.equal(r.resolve('GLM-5.3'), 'builtin:bigmodel-coding-plan/GLM-5.3');
  // provider 存在但模型不在该 provider 下（另一 provider 有同名）：报错只列该 provider 的模型
  assert.throws(() => r.resolve('builtin:bigmodel-coding-plan/gpt-x'), (err) =>
    err.message.includes('未知模型')
    && err.message.includes('provider builtin:bigmodel-coding-plan 下可用')
    && err.message.includes('GLM-5.3')
    && !err.message.includes('gpt-x,'));
  // 未知 provider 报错列全部有清单的 provider
  assert.throws(() => r.resolve('nope/m1'), (err) =>
    err.message.includes('未知 provider')
    && err.message.includes('builtin:bigmodel-coding-plan')
    && err.message.includes('openai-compatible/foo'));
});

test('model-router.resolve：清单读不到——显式指定抛错，默认放行（bootstrap 再报）', () => {
  writeV2Config({ provider: {} });
  assert.throws(() => new ModelRouter().resolve('GLM-5.3'), /不能校验/);
  assert.equal(new ModelRouter().resolve(), 'builtin:bigmodel-coding-plan/GLM-5.3');
});

test('model-router.listModels：读 v2 config 出结构化清单（默认标记/可选维度）；清单不可读抛可操作错误', () => {
  writeV2Config({
    provider: {
      'builtin:bigmodel-coding-plan': {
        options: { apiKey: 'k' },
        models: {
          'GLM-5.3': {
            label: 'GLM 5.3',
            limit: { context: 1000000, output: 128000 },
            reasoning: { variants: ['low', 'high', 'max'], defaultVariant: 'max' },
          },
          'GLM-4.7-Flash': {}, // 裸条目：无 label/limit/reasoning，不造默认值
        },
      },
    },
  });
  assert.deepEqual(new ModelRouter().listModels(), [
    {
      name: 'GLM-5.3',
      label: 'GLM 5.3',
      contextWindow: 1000000,
      reasoning: { variants: ['low', 'high', 'max'], defaultVariant: 'max' },
      default: true, // model.main 指向它
    },
    { name: 'GLM-4.7-Flash' },
  ]);

  writeV2Config({ provider: {} }); // 无 models：清单不可读
  assert.throws(() => new ModelRouter().listModels(), (err) =>
    /模型清单/.test(err.message) && err.message.includes('恢复指引'));
});

test('model-router.prepareRunEnv(spawn)：建 HOME 池 + mtime 条件重写', async () => {
  writeV2Config();
  const r = new ModelRouter();
  const ref = r.resolve('GLM-4.7-Flash');
  const env1 = await r.prepareRunEnv(ref, 'spawn');
  assert.equal(env1.env.HOME, config.homePoolDir('GLM-4.7-Flash'));
  assert.equal(env1.env.ZSW_NESTED, '1');
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

test('model-router.prepareRunEnv(appserver)：createParams(object model) + 单一隔离 HOME bootstrap', async () => {
  writeV2Config();
  const out = await new ModelRouter().prepareRunEnv('builtin:bigmodel-coding-plan/GLM-5.3', 'appserver');
  // model 必须是 strict 对象 {providerId, modelId}（e2e 实测 zcode.cjs schema，
  // 字符串被 -32602 拒收）
  assert.deepEqual(out, { createParams: { model: { providerId: 'builtin:bigmodel-coding-plan', modelId: 'GLM-5.3' } } });
  assert.equal(out.env, undefined); // app-server 进程 HOME 由 runner 自己注入，不走 runEnv.env
  // 单一隔离 HOME（非 per-model 池）：凭据已 bootstrap，app-server 才能调真实模型
  const homeCfg = path.join(config.appserverHomeDir(), '.zcode', 'cli', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(homeCfg, 'utf8'));
  assert.equal(cfg.model.main, 'builtin:bigmodel-coding-plan/GLM-5.3');
  assert.equal(cfg.provider['builtin:bigmodel-coding-plan'].options.apiKey, 'test-key');
  // modelRef 必填校验对 appserver 分支同样生效
  await assert.rejects(() => new ModelRouter().prepareRunEnv(null, 'appserver'), /必填/);
});

test('model-router.prepareRunEnv(spawn)：多 provider 池目录隔离 + 池内只写目标 provider 凭据', async () => {
  writeV2Config({
    provider: {
      'builtin:bigmodel-coding-plan': { options: { apiKey: 'k1' }, models: { 'GLM-5.3': {}, 'shared-model': {} } },
      'openai-compatible/foo': { options: { apiKey: 'k2' }, models: { 'gpt-x': {}, 'shared-model': {} } },
    },
  });
  const r = new ModelRouter();
  const a = await r.prepareRunEnv('builtin:bigmodel-coding-plan/shared-model', 'spawn');
  const b = await r.prepareRunEnv('openai-compatible/foo/shared-model', 'spawn');
  // 同名模型跨 provider：池目录不同（凭据/配置互不污染）
  assert.notEqual(a.env.HOME, b.env.HOME);
  assert.equal(a.env.HOME, config.homePoolDir('shared-model', 'builtin:bigmodel-coding-plan'));
  assert.equal(b.env.HOME, config.homePoolDir('shared-model', 'openai-compatible/foo'));
  // 池内 config 只含目标 provider（凭据落盘面最小）
  const cfgA = JSON.parse(fs.readFileSync(path.join(a.env.HOME, '.zcode', 'cli', 'config.json'), 'utf8'));
  const cfgB = JSON.parse(fs.readFileSync(path.join(b.env.HOME, '.zcode', 'cli', 'config.json'), 'utf8'));
  assert.deepEqual(Object.keys(cfgA.provider), ['builtin:bigmodel-coding-plan']);
  assert.deepEqual(Object.keys(cfgB.provider), ['openai-compatible/foo']);
  assert.equal(cfgB.provider['openai-compatible/foo'].options.apiKey, 'k2');
});

test('model-router.prepareRunEnv(appserver)：多 provider 下 createParams 跟随 provider，HOME 写全部凭据', async () => {
  writeV2Config({
    provider: {
      'builtin:bigmodel-coding-plan': { options: { apiKey: 'k1' }, models: { 'GLM-5.3': {} } },
      'openai-compatible/foo': { options: { apiKey: 'k2' }, models: { 'gpt-x': {} } },
    },
  });
  const out = await new ModelRouter().prepareRunEnv('openai-compatible/foo/gpt-x', 'appserver');
  // providerId 跟随 modelRef（不再硬编码默认 provider）
  assert.deepEqual(out, { createParams: { model: { providerId: 'openai-compatible/foo', modelId: 'gpt-x' } } });
  // appserver 共享 HOME：长驻进程一次性读全部带凭据 provider（任意 provider 的 session 可用）
  const homeCfg = JSON.parse(fs.readFileSync(
    path.join(config.appserverHomeDir(), '.zcode', 'cli', 'config.json'), 'utf8'));
  assert.deepEqual(Object.keys(homeCfg.provider).sort(),
    ['builtin:bigmodel-coding-plan', 'openai-compatible/foo']);
});

test('driver.bootstrapIsolatedHome：目标 provider 无凭据 → 可操作错误列带凭据清单', () => {
  writeV2Config({
    provider: {
      'builtin:bigmodel-coding-plan': { options: { apiKey: 'k1' }, models: { 'GLM-5.3': {} } },
      'openai-compatible/foo': { options: { apiKey: 'k2' }, models: { 'gpt-x': {} } },
      'no-creds/bar': { options: {}, models: { 'm1': {} } }, // 有模型清单但无 apiKey
    },
  });
  assert.throws(
    () => driver.bootstrapIsolatedHome(path.join(TMP, 'bs-home-3'), 'no-creds/bar/m1'),
    (err) => err.message.includes('no-creds/bar')
      && err.message.includes('builtin:bigmodel-coding-plan')
      && err.message.includes('openai-compatible/foo')
      && err.message.includes('恢复指引')
  );
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

test('SpawnRunner：resume 拒绝非 spawn 句柄 / sessionId 未回填', () => {
  const runner = new SpawnRunner();
  // S-6① 起 resume 是同步返回的普通函数，校验失败同步抛错（对齐 driver.runHeadless）
  assert.throws(() => runner.resume({}, 'x'), /spawn/);
  assert.throws(() => runner.resume({ kind: 'spawn', pid: 1 }, 'x'), /sessionId/);
  assert.throws(() => runner.resume({ kind: 'apc', sessionId: 's' }, 'x'), /spawn/);
});

// ------------------------------------------- S-6：resume 轮句柄与取消竞态

test('SpawnRunner：resume 暴露 pid/cancel 句柄 + onHandle 回调 + 更新 exec.pid（S-6①③）', async () => {
  const { runner, handle } = await startFakeRunner();
  await handle.done; // 首轮完成（无 sleep），exec.sessionId 已回填
  const firstPid = handle.exec.pid;

  // FAKE_SLEEP_MS 由 resume 子进程在自身启动时读取——首轮已结束才置挂起，
  // 只影响 resume 轮（本用例只验证句柄与杀进程链，不等自然完成）
  process.env.FAKE_SLEEP_MS = '600000';
  try {
    let notified = null;
    const run = runner.resume(handle.exec, 'resume 轮句柄验证', { timeoutMs: 15000 }, (h) => { notified = h; });
    // ① promise 附加句柄（driver.runHeadless 同款模式），调用方无需改 await 接法
    assert.ok(run.pid > 0);
    assert.equal(typeof run.cancel, 'function');
    // ③ exec.pid 已更新为 resume 轮进程（可变引用，同 sessionId 回填模式）——
    // 轮运行中崩溃恢复探活读到活进程而非首轮死 pid
    assert.notEqual(run.pid, firstPid);
    assert.equal(handle.exec.pid, run.pid);
    assert.equal(runner.alive(handle.exec), true);
    // ② onHandle 回调同步携带同一句柄（供 manager 在轮运行期注册 cancel）
    assert.ok(notified, 'onHandle 已同步回调');
    assert.equal(notified.pid, run.pid);
    assert.equal(typeof notified.cancel, 'function');

    notified.cancel(); // 经回调句柄杀进程（与 run.cancel 同一链）
    const r2 = await run;
    assert.equal(r2.status, 'cancelled');
    assert.throws(() => process.kill(run.pid, 0), (e) => e.code === 'ESRCH');
    assert.equal(runner.alive(handle.exec), false);
  } finally {
    delete process.env.FAKE_SLEEP_MS;
  }
});

test('S-6②：resume 轮 done 迟到时 record 已 cancelled → 通知不补发（计数 notifier）', async () => {
  // 场景（REVIEW-impl 附录 2 探针复现）：message 启动 resume 轮后 cancel 走
  // 无句柄路径只终态化 record；迟到的 done 不得再补发「完成」通知
  fs.rmSync(config.recordsPath(), { force: true }); // 共享事件日志清零（同 manager.test.js 隔离法）
  const resumeCalls = [];
  let releaseRound = null;
  const runner = {
    capabilities: () => ({ kind: 'fake', steering: 'none', coldStartMs: 0 }),
    probe: async () => ({ ok: true }),
    alive: () => false,
    start() {
      const exec = { kind: 'fake', pid: 42000, sessionId: undefined };
      const done = Promise.resolve({
        status: 'closed', response: '首轮完成', sessionId: 'sess-s6-gate',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      done.then((r) => { if (r.sessionId) exec.sessionId = r.sessionId; }); // 可变引用回填，对齐 SpawnRunner
      return { exec, cancel: () => {}, done };
    },
    resume(exec, message) {
      resumeCalls.push({ exec, message });
      return new Promise((resolve) => { releaseRound = resolve; }); // 挂起至测试放行（模拟迟到 done）
    },
  };
  const notifyCalls = [];
  const notifier = {
    capabilities: () => ({ mode: 'mailbox' }),
    notifyCompletion: async (record, summary) => {
      notifyCalls.push({ id: record.subagentId, status: record.status, summary });
      return { delivered: true };
    },
  };
  const records = new RecordStore();
  const manager = new SubagentManager({
    runner,
    modelRouter: {
      resolve: () => 'fake/default-model',
      prepareRunEnv: async () => ({ env: { HOME: '/fake/s6-home' } }),
    },
    notifier,
    resolver: { resolve: () => null },
    records,
    outputs,
    slots: createSlots({ limit: 3 }),
  });
  const closedRound = { status: 'closed', sessionId: 'sess-s6-gate', usage: { input_tokens: 1, output_tokens: 1 } };

  // ① 首轮：完成 → idle + 通知 1 次（后续断言的对照组）
  const h = await manager.start({ task: 'S-6 门卫验证任务', slug: 's6-gate', conversation: true }, { cwd: TMP });
  await waitFor(() => records.get(h.subagentId).status === 'idle');
  assert.equal(notifyCalls.length, 1);

  // ② 正常续聊轮：完成 → 回 idle + 通知 +1（门卫不得误伤正常完成路径）
  await manager.message(h.subagentId, '正常第二轮');
  await waitFor(() => resumeCalls.length === 1);
  releaseRound({ ...closedRound, response: '正常第二轮完成' });
  await waitFor(() => records.get(h.subagentId).status === 'idle' && notifyCalls.length === 2);
  assert.equal(records.get(h.subagentId).rounds, 2);

  // ③ 取消竞态：resume 轮挂起时 cancel（无句柄路径终态化 record）→ 放行迟到 done
  await manager.message(h.subagentId, '将被取消的一轮');
  await waitFor(() => resumeCalls.length === 2);
  const c = await manager.cancel(h.subagentId);
  assert.equal(c.cancelled, true);
  assert.equal(records.get(h.subagentId).status, 'cancelled');
  releaseRound({ ...closedRound, response: '迟到的完成' });
  await waitFor(() => manager.pending.size === 0); // 轮收尾完成（含通知决策）
  assert.equal(notifyCalls.length, 2, 'cancel 后迟到的 done 不补发通知');
  assert.equal(records.get(h.subagentId).status, 'cancelled', '终态不被迟到 done 覆盖');
  assert.equal(records.get(h.subagentId).rounds, 2, '取消轮不计入完成轮数');
});

test('S-6① 接线：manager resume 轮句柄入 handles，cancel 杀掉 resume 轮真进程（SpawnRunner + fake CLI）', async () => {
  writeV2Config();
  fs.rmSync(config.recordsPath(), { force: true }); // 共享事件日志清零（同 S-6② 隔离法）
  const notifyCalls = [];
  const notifier = {
    capabilities: () => ({ mode: 'mailbox' }),
    notifyCompletion: async (record, summary) => {
      notifyCalls.push({ id: record.subagentId, status: record.status, summary });
      return { delivered: true };
    },
  };
  const router = new ModelRouter();
  const manager = new SubagentManager({
    runner: new SpawnRunner(),
    modelRouter: router,
    notifier,
    resolver: { resolve: () => null },
    records: new RecordStore(),
    outputs,
    slots: createSlots({ limit: 3 }),
  });

  // 首轮（fake CLI 无 sleep）：wait 等到 idle，exec.sessionId 已回填
  const res = await manager.start(
    { task: 'resume 句柄接线首轮', slug: 's6-handle', conversation: true, wait: true },
    { cwd: TMP },
  );
  assert.equal(res.status, 'idle', 'conversation 首轮完成落 idle');
  const rec1 = manager.records.get(res.subagentId);
  const firstPid = rec1.exec.pid;
  assert.equal(typeof rec1.exec.sessionId, 'string');

  process.env.FAKE_SLEEP_MS = '600000'; // 只影响之后启动的子进程（resume 轮）
  try {
    const m = await manager.message(res.subagentId, '挂起的第二轮');
    assert.equal(m.status, 'running');
    // SpawnRunner resume 启动即更新 exec.pid（S-6③ 可变引用）——轮进程已活
    await waitFor(() => manager.records.get(res.subagentId).exec.pid !== firstPid);
    const rec2 = manager.records.get(res.subagentId);
    const resumePid = rec2.exec.pid;
    assert.notEqual(resumePid, firstPid);
    process.kill(resumePid, 0); // 不抛 = resume 轮进程在跑
    assert.ok(manager.handles.has(res.subagentId), 'resume 轮句柄已挂入 handles');

    const c = await manager.cancel(res.subagentId);
    assert.equal(c.cancelled, true);
    assert.equal(manager.records.get(res.subagentId).status, 'cancelled');
    // resume 轮进程已被 SIGTERM 链杀死（不再跑到 timeout）
    assert.throws(() => process.kill(resumePid, 0), (e) => e.code === 'ESRCH', 'resume 轮进程已死');
    assert.equal(manager.handles.has(res.subagentId), false, '收尾清理句柄');
    assert.equal(notifyCalls.length, 1, '首轮 1 封 + cancelled 不补发');
  } finally {
    delete process.env.FAKE_SLEEP_MS;
  }
});
