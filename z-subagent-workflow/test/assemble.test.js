'use strict';

/**
 * assemble.js probe 门控测试（决策位①下沉）：ZSW_RUNNER=appserver 的
 * probe+降级链在组装层统一执行——MCP 与 CLI 共用，两入口行为不漂移。
 * probe 走 fixtures/fake-appserver.js（成功）与不存在的 CLI 路径（失败降级）。
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
const { assembleManager } = require('../lib/assemble');

after(() => {
  delete process.env.ZSW_RUNNER;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

test('ZSW_RUNNER 缺省 → spawn，无探针开销', async () => {
  delete process.env.ZSW_RUNNER;
  const a = await assembleManager();
  assert.equal(a.runnerKind, 'spawn');
  assert.equal(a.manager.runner.capabilities().kind, 'spawn');
});

test('ZSW_RUNNER=appserver 且 probe OK（fake app-server）→ 保持 appserver', async () => {
  process.env.ZSW_RUNNER = 'appserver';
  process.env.ZSW_ZCODE_CLI = path.join(__dirname, '..', 'fixtures', 'fake-appserver.js');
  try {
    const a = await assembleManager();
    assert.equal(a.runnerKind, 'appserver');
    assert.equal(a.manager.runner.capabilities().kind, 'appserver');
    await a.manager.runner.shutdown();
  } finally {
    delete process.env.ZSW_ZCODE_CLI;
  }
});

test('ZSW_RUNNER=appserver 且 probe 失败（CLI 不可用）→ 降级 spawn，不抛错', async () => {
  process.env.ZSW_RUNNER = 'appserver';
  process.env.ZSW_ZCODE_CLI = path.join(TMP, 'no-such-cli.cjs');
  try {
    const a = await assembleManager();
    assert.equal(a.runnerKind, 'spawn', 'probe 失败自动降级 spawn（CLI 与 MCP 入口同一决策）');
    assert.equal(a.manager.runner.capabilities().kind, 'spawn');
  } finally {
    delete process.env.ZSW_ZCODE_CLI;
  }
});

test('显式 opts.runner 注入 → 不探测，注入即接管', async () => {
  process.env.ZSW_RUNNER = 'appserver';
  process.env.ZSW_ZCODE_CLI = path.join(TMP, 'no-such-cli.cjs'); // 即使探针必败也不应触发
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
