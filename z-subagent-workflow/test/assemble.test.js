'use strict';

/**
 * assemble.js 组装层测试（D1 默认翻转 + probe 门控 + 落盘缓存 + 首败失效重探）：
 *
 * - 缺省（无 ZSW_RUNNER）= appserver（D1 翻转），组装前 probe 健康检查，失败降级 spawn
 *   ——MCP 与 CLI 共用，两入口行为不漂移。
 * - ZSW_RUNNER=spawn 显式回退 / ZSW_RUNNER=appserver 显式定向 / opts.runner 注入：
 *   三种显式形态均不探（注入即接管）。
 * - probe 结论落盘 ~/.zcode/zsw/probe-cache.json（ZSW_ROOT 隔离）：键 = CLI 路径+mtime，
 *   只缓存 ok；命中跳探；损坏容错；缓存命中后首次 session/create 失败（失效类错误码）
 *   失效缓存 + 重探一次（wrapWithProbeInvalidation）。
 *
 * 探针链走 fixtures/fake-appserver.js（真跑）或 patch prototype（计数/重探控制）；
 * 降级重跑的 spawn 执行体 patch driver.runHeadless——全程绝不 spawn 真 zcode.cjs。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-asm-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsub-root');
process.env.ZCODE_MAILBOX_ROOT = path.join(TMP, 'mailbox');
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(process.env.HOME, '.zcode', 'v2'), { recursive: true });
// 探针链的 prepareRunEnv 要 bootstrap 隔离 HOME，需要源 v2 config 的 provider
// 凭据（driver.bootstrapIsolatedHome 校验 apiKey）——测试环境无真实桌面端
// 配置，手写最小形态
fs.writeFileSync(
  path.join(process.env.HOME, '.zcode', 'v2', 'config.json'),
  JSON.stringify({
    model: { main: 'builtin:bigmodel-coding-plan/GLM-5.3' },
    provider: {
      'builtin:bigmodel-coding-plan': {
        options: { apiKey: 'test-key' },
        models: { 'GLM-5.3': {}, 'GLM-4.7-Flash': {} },
      },
    },
  }),
);

// env 隔离完成后才允许 require lib（config 冻结路径）
const {
  assembleManager,
  probeCachePath,
  readProbeCacheEntry,
  writeProbeCacheEntry,
  isInvalidatingError,
} = require('../lib/assemble');
const AppServerRunner = require('../lib/runner-appserver');
const driver = require('../lib/driver');

const FAKE_CLI = path.join(__dirname, '..', 'fixtures', 'fake-appserver.js');
const BAD_CLI = path.join(TMP, 'no-such-cli.cjs');

const fakeCliMtime = () => fs.statSync(FAKE_CLI).mtimeMs;
function clearProbeCache() {
  try { fs.rmSync(probeCachePath(), { force: true }); } catch { /* 尽力 */ }
}

/** patch AppServerRunner.prototype.probe：impl 换行为 + 计数；返回恢复函数。 */
function setProbe(impl) {
  const orig = AppServerRunner.prototype.probe;
  let calls = 0;
  AppServerRunner.prototype.probe = async function (...args) {
    calls += 1;
    return impl ? impl.call(this, ...args) : { ok: true, protocolVersion: 1 };
  };
  return { count: () => calls, restore: () => { AppServerRunner.prototype.probe = orig; } };
}

/** patch AppServerRunner.prototype.start：恒返回失效类 create 失败句柄。 */
function setFailingStart() {
  const orig = AppServerRunner.prototype.start;
  let calls = 0;
  AppServerRunner.prototype.start = function () {
    calls += 1;
    return {
      exec: { kind: 'apc', sessionId: undefined },
      cancel: () => {},
      done: Promise.resolve({
        status: 'error',
        error: 'session/create 失败: [-32603] Model config is missing',
        sessionId: undefined,
      }),
    };
  };
  return { count: () => calls, restore: () => { AppServerRunner.prototype.start = orig; } };
}

/** patch driver.runHeadless：spawn 执行体换 fake（降级重跑断言面）。 */
function setFakeRunHeadless() {
  const orig = driver.runHeadless;
  let calls = 0;
  driver.runHeadless = () => {
    calls += 1;
    const p = Promise.resolve({ status: 'closed', response: 'SPAWN-OK', sessionId: 'sess_spawn_unit' });
    p.pid = 424242;
    p.cancel = () => {};
    return p;
  };
  return { count: () => calls, restore: () => { driver.runHeadless = orig; } };
}

after(() => {
  delete process.env.ZSW_RUNNER;
  delete process.env.ZSW_ZCODE_CLI;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// ---------------------------------------------------------- 缺省翻转 + probe 门控

test('缺省（无 ZSW_RUNNER）→ appserver（probe OK），ok 结论落盘缓存', async () => {
  delete process.env.ZSW_RUNNER;
  clearProbeCache();
  process.env.ZSW_ZCODE_CLI = FAKE_CLI;
  try {
    const a = await assembleManager();
    assert.equal(a.runnerKind, 'appserver', 'D1 翻转：缺省通道 = appserver');
    assert.equal(a.manager.runner.capabilities().kind, 'appserver');
    const entry = readProbeCacheEntry(FAKE_CLI, fakeCliMtime());
    assert.ok(entry && entry.ok === true, 'probe ok 结论必须落盘（键=CLI 路径+mtime）');
    await a.manager.runner.shutdown();
  } finally {
    delete process.env.ZSW_ZCODE_CLI;
  }
});

test('缺省且 probe 失败（CLI 不存在）→ 降级 spawn，失败结论不落盘', async () => {
  delete process.env.ZSW_RUNNER;
  clearProbeCache();
  process.env.ZSW_ZCODE_CLI = BAD_CLI;
  try {
    const a = await assembleManager();
    assert.equal(a.runnerKind, 'spawn', 'probe 失败自动降级 spawn（CLI 与 MCP 入口同一决策）');
    assert.equal(a.manager.runner.capabilities().kind, 'spawn');
    assert.ok(!fs.existsSync(probeCachePath()), '只缓存 ok=true：失败不落盘（每次组装重探）');
  } finally {
    delete process.env.ZSW_ZCODE_CLI;
  }
});

test('ZSW_RUNNER=spawn 显式回退 → spawn，无 probe 开销（坏 CLI 也不探）', async () => {
  process.env.ZSW_RUNNER = 'spawn';
  clearProbeCache();
  process.env.ZSW_ZCODE_CLI = BAD_CLI; // 探针必败路径：被调用即失败
  const probe = setProbe(null); // 计数器；impl=null 返回 ok（若被误调至少不误降级）
  try {
    const a = await assembleManager();
    assert.equal(a.runnerKind, 'spawn', '显式回退旧通道');
    assert.equal(a.manager.runner.capabilities().kind, 'spawn');
    assert.equal(probe.count(), 0, '显式指定不 probe');
    assert.ok(!fs.existsSync(probeCachePath()), '不探则无结论落盘');
  } finally {
    probe.restore();
    delete process.env.ZSW_ZCODE_CLI;
  }
});

test('ZSW_RUNNER=appserver 显式定向 → 不探（probe 必败也保持 appserver）', async () => {
  process.env.ZSW_RUNNER = 'appserver';
  clearProbeCache();
  process.env.ZSW_ZCODE_CLI = BAD_CLI;
  const probe = setProbe(() => ({ ok: false, reason: 'unit: 不应被调用' }));
  try {
    const a = await assembleManager();
    assert.equal(a.runnerKind, 'appserver', '显式定向 = 接管，不做健康检查');
    assert.equal(a.manager.runner.capabilities().kind, 'appserver');
    assert.equal(probe.count(), 0, '显式指定不 probe');
    await a.manager.runner.shutdown();
  } finally {
    probe.restore();
    delete process.env.ZSW_ZCODE_CLI;
  }
});

test('显式 opts.runner 注入 → 不探测，注入即接管', async () => {
  process.env.ZSW_RUNNER = 'appserver';
  process.env.ZSW_ZCODE_CLI = BAD_CLI; // 即使探针必败也不应触发
  try {
    const fakeRunner = {
      capabilities: () => ({ kind: 'fake', steering: 'none', coldStartMs: 0 }),
      start: () => { throw new Error('not used'); },
      resume: async () => ({}),
      alive: () => false,
    };
    const a = await assembleManager({ runner: fakeRunner });
    assert.equal(a.manager.runner.capabilities().kind, 'fake');
  } finally {
    delete process.env.ZSW_ZCODE_CLI;
  }
});

// ---------------------------------------------------------- probe 落盘缓存

test('resolveCliPath：无 ZSW_ZCODE_CLI env 时回落 config.ZCODE_CLI（真机缓存键必须可解析）', () => {
  // 回归钉：曾误引 config.DEFAULTS.ZCODE_CLI（undefined）——真实部署 env 未设时
  // cliPath 为 undefined，statSync 抛错被吞，缓存静默失效（单测显式设 env 掩盖）
  delete process.env.ZSW_ZCODE_CLI;
  const { resolveCliPath } = require('../lib/assemble');
  const config = require('../lib/config');
  assert.equal(resolveCliPath(), config.ZCODE_CLI);
  assert.ok(resolveCliPath() && resolveCliPath() !== 'undefined');
});

test('缓存命中（同 CLI 同 mtime）→ 跳过 probe 直接 appserver', async () => {
  delete process.env.ZSW_RUNNER;
  clearProbeCache();
  process.env.ZSW_ZCODE_CLI = FAKE_CLI;
  const probe = setProbe(null);
  try {
    writeProbeCacheEntry(FAKE_CLI, fakeCliMtime(), 1);
    const a = await assembleManager();
    assert.equal(a.runnerKind, 'appserver');
    assert.equal(probe.count(), 0, '命中必须跳过 probe');
    await a.manager.runner.shutdown();
  } finally {
    probe.restore();
    delete process.env.ZSW_ZCODE_CLI;
  }
});

test('CLI mtime 变化 → 缓存 miss，重新 probe 并刷新条目', async () => {
  delete process.env.ZSW_RUNNER;
  clearProbeCache();
  process.env.ZSW_ZCODE_CLI = FAKE_CLI;
  const probe = setProbe(null);
  try {
    writeProbeCacheEntry(FAKE_CLI, fakeCliMtime(), 1);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(FAKE_CLI, later, later); // 模拟 CLI 更新
    assert.equal(readProbeCacheEntry(FAKE_CLI, fakeCliMtime()), null, 'mtime 不匹配即 miss');
    const a = await assembleManager();
    assert.equal(a.runnerKind, 'appserver');
    assert.equal(probe.count(), 1, 'miss 必须重探');
    const entry = readProbeCacheEntry(FAKE_CLI, fakeCliMtime());
    assert.ok(entry && entry.mtimeMs === fakeCliMtime(), '重探 ok 后按新 mtime 刷新条目');
  } finally {
    probe.restore();
    delete process.env.ZSW_ZCODE_CLI;
  }
});

test('probe-cache.json 损坏 → 容错为无缓存，组装照常 probe', async () => {
  delete process.env.ZSW_RUNNER;
  clearProbeCache();
  process.env.ZSW_ZCODE_CLI = FAKE_CLI;
  const probe = setProbe(null);
  try {
    fs.mkdirSync(path.dirname(probeCachePath()), { recursive: true });
    fs.writeFileSync(probeCachePath(), '{not json');
    const a = await assembleManager();
    assert.equal(a.runnerKind, 'appserver', '损坏缓存不得影响组装决策');
    assert.equal(probe.count(), 1, '损坏按 miss 处理（重探）');
  } finally {
    probe.restore();
    delete process.env.ZSW_ZCODE_CLI;
  }
});

// ---------------------------------------------------------- 首败失效重探（D1）

test('isInvalidatingError：-32603/-32601/-32602 命中，其余不命中', () => {
  assert.equal(isInvalidatingError({ status: 'error', error: 'session/create 失败: [-32603] Model config is missing' }), true);
  assert.equal(isInvalidatingError({ status: 'error', errorKind: 'protocol-drift', error: '协议漂移（protocol-drift）: session/send 失败: [-32602] ZodError' }), true);
  assert.equal(isInvalidatingError({ status: 'error', error: 'session/send 失败: [-32010] A prompt is already running' }), false);
  assert.equal(isInvalidatingError({ status: 'error', error: '请求 session/send 超时（30000ms）' }), false);
  assert.equal(isInvalidatingError({ status: 'closed' }), false);
});

test('缓存命中后首次 create 失败 + 重探 OK → 原错误上行（不静默重试），缓存写回', async () => {
  delete process.env.ZSW_RUNNER;
  clearProbeCache();
  process.env.ZSW_ZCODE_CLI = FAKE_CLI;
  writeProbeCacheEntry(FAKE_CLI, fakeCliMtime(), 1); // 预置命中态（组装期不 probe）
  const probe = setProbe(null); // 只会收到重探这一次
  const failStart = setFailingStart();
  try {
    const a = await assembleManager();
    assert.equal(a.runnerKind, 'appserver');
    const res = await a.manager.start(
      { task: '单元测试', slug: 'asm-invalidate-ok', model: 'GLM-5.3', wait: true },
      { cwd: TMP },
    );
    assert.equal(res.status, 'error', '重探 ok：原 create 错误走既有错误路径，不静默重试');
    assert.match(res.error, /\[-32603\]/);
    assert.equal(probe.count(), 1, '首败后重探恰好一次');
    assert.ok(readProbeCacheEntry(FAKE_CLI, fakeCliMtime()), '重探 ok → ok 结论写回缓存');
    assert.equal(a.manager.runner.capabilities().kind, 'appserver', '环境健康不降级');
    await a.manager.runner.shutdown();
  } finally {
    probe.restore();
    failStart.restore();
    delete process.env.ZSW_ZCODE_CLI;
  }
});

test('缓存命中后首次 create 失败 + 重探失败 → 降级 spawn 重跑本任务 + record 如实改标', async () => {
  delete process.env.ZSW_RUNNER;
  clearProbeCache();
  process.env.ZSW_ZCODE_CLI = FAKE_CLI;
  writeProbeCacheEntry(FAKE_CLI, fakeCliMtime(), 1); // 预置命中态
  const probe = setProbe(() => ({ ok: false, reason: 'unit: 环境已变坏' })); // 重探失败
  const failStart = setFailingStart();
  const fakeRun = setFakeRunHeadless();
  try {
    const a = await assembleManager();
    assert.equal(a.runnerKind, 'appserver');
    const res = await a.manager.start(
      { task: '单元测试', slug: 'asm-invalidate-degrade', model: 'GLM-5.3', wait: true },
      { cwd: TMP },
    );
    assert.equal(res.status, 'closed', '本任务由 spawn 重跑并完成');
    assert.equal(res.result, 'SPAWN-OK');
    assert.equal(probe.count(), 1, '重探恰好一次（失败即降级，不再反复）');
    assert.equal(fakeRun.count(), 1, '降级重跑恰好一次 spawn 执行体');
    assert.equal(readProbeCacheEntry(FAKE_CLI, fakeCliMtime()), null, '重探失败：坏结论不写回');
    const rec = a.manager.status(res.subagentId);
    assert.equal(rec.runnerKind, 'spawn', 'record 如实标注实际通道');
    assert.equal(rec.exec && rec.exec.kind, 'spawn', 'exec 句柄随降级切换为 spawn 形态');
    assert.equal(a.manager.runner.capabilities().kind, 'spawn', '通道级降级：capabilities 翻转 spawn');
  } finally {
    probe.restore();
    failStart.restore();
    fakeRun.restore();
    delete process.env.ZSW_ZCODE_CLI;
  }
});

test('通道级降级后第二个任务免重探：直接走 spawn，probe 与 inner 均不再触达', async () => {
  delete process.env.ZSW_RUNNER;
  clearProbeCache();
  process.env.ZSW_ZCODE_CLI = FAKE_CLI;
  writeProbeCacheEntry(FAKE_CLI, fakeCliMtime(), 1); // 预置命中态（组装期不 probe）
  const probe = setProbe(() => ({ ok: false, reason: 'unit: 环境已变坏' })); // 首任务重探失败 → 降级
  const failStart = setFailingStart();
  const fakeRun = setFakeRunHeadless();
  try {
    const a = await assembleManager();
    // 第一任务：撞失效类 create 失败 → 重探失败 → 降级翻转 + 本任务 spawn 重跑
    const res1 = await a.manager.start(
      { task: '单元测试', slug: 'asm-degrade-1st', model: 'GLM-5.3', wait: true },
      { cwd: TMP },
    );
    assert.equal(res1.status, 'closed');
    assert.equal(a.manager.runner.capabilities().kind, 'spawn', '前置：第一任务后已通道级降级');
    assert.equal(probe.count(), 1);
    assert.equal(fakeRun.count(), 1);
    assert.equal(failStart.count(), 1);

    // 第二任务（降级翻转后的核心断言面）：manager 按 capabilities().kind='spawn'
    // 组装（runEnv 为 spawn 形态），runner.start 走 degraded 分流——不重探、
    // 不撞 inner 的失效类 create，直接 spawn 执行
    const res2 = await a.manager.start(
      { task: '单元测试二', slug: 'asm-degrade-2nd', model: 'GLM-5.3', wait: true },
      { cwd: TMP },
    );
    assert.equal(res2.status, 'closed', '第二任务直接 spawn 完成');
    assert.equal(res2.result, 'SPAWN-OK');
    assert.equal(probe.count(), 1, '免重探：probe 计数不再增长');
    assert.equal(fakeRun.count(), 2, 'spawn 执行体恰好新增一次（第二任务直跑）');
    assert.equal(failStart.count(), 1, '不再喂 AppServerRunner（inner.start 计数不增长）');
    const rec2 = a.manager.status(res2.subagentId);
    assert.equal(rec2.runnerKind, 'spawn', '第二任务 record 通道标注 spawn');
    assert.equal(rec2.exec && rec2.exec.kind, 'spawn', '第二任务 exec 为真实 spawn 句柄（非占位）');
    assert.ok(rec2.exec && typeof rec2.exec.pid === 'number', 'exec.pid 已由真实句柄回填（relabel 生效）');
  } finally {
    probe.restore();
    failStart.restore();
    fakeRun.restore();
    delete process.env.ZSW_ZCODE_CLI;
  }
});
