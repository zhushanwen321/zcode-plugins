'use strict';
// lib/launcher/restore.js 内联 guarded-save 的回归测试（R10）：
// (1) 锁内检测到外部写后重读重放并成功落盘（引擎写入不被覆盖）
// (2) 持续冲突 5 次耗尽 → exitCode 1 且 registry/config 均不被写入
// (3) 附带覆盖 loadRegistry 结构归一化（R5/R9）与 mcp-client close() reject pending（R3）

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { runRestore } = require('../lib/launcher/restore');
const { loadRegistry } = require('../lib/registry');
const { connect } = require('../lib/mcp-client');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function setupFixture() {
  const home = tmpDir('ztf-rg-home-');
  const dataDir = tmpDir('ztf-rg-data-');
  const configPath = path.join(home, '.zcode', 'cli', 'config.json');
  const registryPath = path.join(dataDir, 'registry.json');
  const lockPath = path.join(dataDir, 'registry.lock');
  const original = { type: 'stdio', command: 'uvx', args: ['mcp-server-x'] };
  const wrapper = { type: 'stdio', command: 'node', args: ['/launcher/proxy-launcher.js', 'x', '--', 'uvx', 'mcp-server-x'] };
  writeJson(configPath, {
    mcp: { servers: { x: wrapper, other: { type: 'stdio', command: 'keep' } } },
  });
  writeJson(registryPath, {
    servers: { x: { scope: 'user', original, wrapperEntry: wrapper } },
  });
  return { home, dataDir, configPath, registryPath, lockPath, original, wrapper };
}

test('guarded-save：外部写后重读重放成功落盘，引擎写入保留', () => {
  const f = setupFixture();
  let conflictsLeft = 2;
  const res = runRestore({
    dataDir: f.dataDir,
    registryPath: f.registryPath,
    lockPath: f.lockPath,
    configPath: f.configPath,
    target: '--all',
    simulateExternalWrite: () => {
      if (conflictsLeft-- > 0) {
        // 模拟引擎恰在 restore 读取后写 config（改了无关 server other）
        const cfg = readJson(f.configPath);
        cfg.mcp.servers.other.enabled = true;
        writeJson(f.configPath, cfg);
      }
    },
  });
  assert.strictEqual(res.exitCode, 0, JSON.stringify(res.messages));
  const cfg = readJson(f.configPath);
  assert.deepStrictEqual(cfg.mcp.servers.x, f.original); // user 级恢复 original
  assert.strictEqual(cfg.mcp.servers.other.enabled, true); // 引擎写入未被覆盖
  assert.deepStrictEqual(readJson(f.registryPath).servers, {}); // 记录清理
  assert.ok(!fs.existsSync(f.lockPath), '锁已释放');
});

test('guarded-save：持续冲突 5 次耗尽 → exit 1 且 registry/config 均不写', () => {
  const f = setupFixture();
  let attempts = 0;
  const res = runRestore({
    dataDir: f.dataDir,
    registryPath: f.registryPath,
    lockPath: f.lockPath,
    configPath: f.configPath,
    target: '--all',
    simulateExternalWrite: () => {
      attempts += 1;
      const cfg = readJson(f.configPath);
      cfg.mcp.servers.other.enabled = true;
      writeJson(f.configPath, cfg);
    },
  });
  assert.strictEqual(res.exitCode, 1);
  assert.strictEqual(attempts, 5); // 恰好重试满 USER_CONFIG_MAX_RETRIES
  assert.match(res.messages.join('\n'), /持续修改/);
  const cfg = readJson(f.configPath);
  assert.deepStrictEqual(cfg.mcp.servers.x, f.wrapper); // config 未被改写
  assert.ok('x' in readJson(f.registryPath).servers); // registry 记录滞留（幂等可重试）
  assert.ok(!fs.existsSync(f.lockPath));
});

test('restore：config 缺 mcp.servers 段时不再误报 missing（R6 语义）', () => {
  const f = setupFixture();
  writeJson(f.configPath, { theme: 'dark' }); // 被重置/精简过的 config
  const res = runRestore({
    dataDir: f.dataDir,
    registryPath: f.registryPath,
    lockPath: f.lockPath,
    configPath: f.configPath,
    target: '--all',
  });
  assert.strictEqual(res.exitCode, 0, JSON.stringify(res.messages));
  const cfg = readJson(f.configPath);
  assert.deepStrictEqual(cfg.mcp.servers.x, f.original); // 补建段并 set original
  assert.strictEqual(cfg.theme, 'dark');
  assert.deepStrictEqual(readJson(f.registryPath).servers, {});
});

test('loadRegistry：合法 JSON 但缺 policies/servers 字段时归一化（R5/R9）', () => {
  const dataDir = tmpDir('ztf-rg-reg-');
  writeJson(path.join(dataDir, 'registry.json'), { policies: { 'x:y': 'deny' } });
  const reg = loadRegistry(dataDir);
  assert.deepStrictEqual(reg.policies, { 'x:y': 'deny' });
  assert.deepStrictEqual(reg.servers, {});
  assert.deepStrictEqual(reg.overrides, {});
  // 非对象 / 数组形态也归一化，不抛
  writeJson(path.join(dataDir, 'registry.json'), [1, 2]);
  const reg2 = loadRegistry(dataDir);
  assert.deepStrictEqual(reg2.policies, {});
});

test('mcp-client close()：未决请求被 reject 而非挂死（R3）', async () => {
  const fixture = path.join(__dirname, 'fixtures', 'echo-server.js');
  const client = await connect({ command: process.execPath, args: [fixture] }, { timeoutMs: 5000 });
  const pendingCall = client.callTool('slow', {});
  client.close();
  await assert.rejects(pendingCall, /client 主动关闭/);
});
