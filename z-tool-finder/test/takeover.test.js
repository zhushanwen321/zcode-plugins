'use strict';
// takeover 单测：computeActions 范围规则矩阵 + applyTakeover/restore roundtrip。
// 全部用临时 HOME + 临时 dataDir，不碰真实 ~/.zcode。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  computeActions,
  buildWrapperEntry,
  applyTakeover,
  restoreAll,
  restoreOne,
} = require('../lib/takeover.js');
const { LockHeldError, loadRegistry, withLock } = require('../lib/registry.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'ztf-tk-'));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/**
 * 夹具：user config 含 alpha(stdio)/blocked(stdio, 在 excluded)/remote(sse)；
 * 插件 p-demo（demo server）；插件 z-tool-finder 自身（search server）；
 * workspace 含 ws1。返回 { home, dataDir, workspaceRoot, userConfigPath }。
 */
function makeFixture() {
  const home = tmpDir('ztf-home-');
  const dataDir = tmpDir('ztf-data-');
  const workspaceRoot = tmpDir('ztf-ws-');

  const pluginDir = path.join(home, 'plugins', 'p-demo');
  writeJson(path.join(pluginDir, '.zcode-plugin', 'plugin.json'), { name: 'p-demo', version: '0.0.1' });
  writeJson(path.join(pluginDir, '.mcp.json'), {
    mcpServers: { demo: { type: 'stdio', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/demo.js'] } },
  });

  const selfDir = path.join(home, 'plugins', 'z-tool-finder');
  writeJson(path.join(selfDir, '.zcode-plugin', 'plugin.json'), { name: 'z-tool-finder', version: '0.0.1' });
  writeJson(path.join(selfDir, '.mcp.json'), {
    mcpServers: { search: { type: 'stdio', command: 'node', args: ['server.js'] } },
  });

  const userConfig = {
    mcp: {
      servers: {
        alpha: { type: 'stdio', command: 'node', args: ['alpha.js'], env: { A: '1' } },
        blocked: { type: 'stdio', command: 'node', args: ['blocked.js'] },
        remote: { type: 'sse', url: 'http://example.com/sse' },
      },
    },
    plugins: { dirs: [pluginDir, selfDir] },
  };
  const userConfigPath = path.join(home, '.zcode', 'cli', 'config.json');
  writeJson(userConfigPath, userConfig);

  writeJson(path.join(workspaceRoot, '.zcode', 'config.json'), {
    mcp: { servers: { ws1: { type: 'stdio', command: 'node', args: ['ws.js'] } } },
  });

  return { home, dataDir, workspaceRoot, userConfigPath, pluginDir };
}

test('computeActions：user/plugin stdio 自动接管，sse 被扫描层排除', () => {
  const f = makeFixture();
  const actions = computeActions({ home: f.home, workspaceRoot: f.workspaceRoot, reg: { servers: {} } });
  const keys = actions.toTakeover.map((t) => t.key);
  assert.ok(keys.includes('alpha'), 'user 级 alpha 应自动接管');
  assert.ok(keys.includes('plugin:p-demo:demo'), '插件级 demo 应自动接管');
  assert.ok(!keys.includes('remote'), 'sse 不在扫描结果（config-io 过滤）');
  assert.ok(!keys.includes('z-tool-finder'), '自身 server 跳过');
  assert.deepStrictEqual(actions.taken, []);
  fs.rmSync(f.home, { recursive: true, force: true });
  fs.rmSync(f.dataDir, { recursive: true, force: true });
  fs.rmSync(f.workspaceRoot, { recursive: true, force: true });
});

test('computeActions：workspace 不自动，显式 names 时接管', () => {
  const f = makeFixture();
  const reg = { servers: {} };
  const auto = computeActions({ home: f.home, workspaceRoot: f.workspaceRoot, reg });
  assert.ok(!auto.toTakeover.some((t) => t.key === 'ws1'), 'workspace 不自动接管');

  const explicit = computeActions({ home: f.home, workspaceRoot: f.workspaceRoot, reg, names: ['ws1'] });
  assert.ok(explicit.toTakeover.some((t) => t.key === 'ws1' && t.scope === 'workspace'));
  fs.rmSync(f.home, { recursive: true, force: true });
  fs.rmSync(f.dataDir, { recursive: true, force: true });
  fs.rmSync(f.workspaceRoot, { recursive: true, force: true });
});

test('computeActions：引擎注入型插件（zcode-cua）归入 excluded，不接管', () => {
  const f = makeFixture();
  // 追加一个 zcode-cua 形态插件：manifest mcpServers 定义（模拟真实 zcode-cua）
  const cuaDir = path.join(f.home, 'plugins', 'zcode-cua');
  writeJson(path.join(cuaDir, '.zcode-plugin', 'plugin.json'), {
    name: 'zcode-cua',
    mcpServers: { 'computer-use': { command: 'node', args: ['cu.js'] } },
  });
  const cfg = JSON.parse(fs.readFileSync(f.userConfigPath, 'utf8'));
  cfg.plugins.dirs.push(cuaDir);
  writeJson(f.userConfigPath, cfg);

  const actions = computeActions({ home: f.home, workspaceRoot: f.workspaceRoot });
  assert.ok(!actions.toTakeover.some((t) => t.key === 'plugin:zcode-cua:computer-use'));
  assert.ok(actions.excluded.includes('plugin:zcode-cua:computer-use'));

  fs.rmSync(f.home, { recursive: true, force: true });
  fs.rmSync(f.dataDir, { recursive: true, force: true });
  fs.rmSync(f.workspaceRoot, { recursive: true, force: true });
});

test('computeActions：excluded 跳过；已接管 key 幂等归入 taken', () => {
  const f = makeFixture();
  const reg = {
    servers: { alpha: { scope: 'user', original: {}, wrapperEntry: {} } },
    excluded: ['blocked'],
  };
  const actions = computeActions({ home: f.home, workspaceRoot: f.workspaceRoot, reg });
  assert.ok(!actions.toTakeover.some((t) => t.key === 'alpha'), '已接管跳过');
  assert.deepStrictEqual(actions.taken, ['alpha']);
  assert.deepStrictEqual(actions.excluded, ['blocked']);
  assert.ok(!actions.toTakeover.some((t) => t.key === 'blocked'));
  fs.rmSync(f.home, { recursive: true, force: true });
  fs.rmSync(f.dataDir, { recursive: true, force: true });
  fs.rmSync(f.workspaceRoot, { recursive: true, force: true });
});

test('buildWrapperEntry：形态与原 args/env 传递正确', () => {
  const entry = { key: 'plugin:p-demo:demo', scope: 'plugin', config: { type: 'stdio', command: 'npx', args: ['x', 'y'], env: { K: 'V' } } };
  const wrapper = buildWrapperEntry(entry, '/data');
  assert.strictEqual(wrapper.type, 'stdio');
  assert.strictEqual(wrapper.command, 'node');
  assert.deepStrictEqual(wrapper.args, [
    '/data/launcher/proxy-launcher.js',
    'plugin:p-demo:demo',
    '--',
    'npx',
    'x',
    'y',
  ]);
  assert.deepStrictEqual(wrapper.env, { K: 'V' });
  assert.strictEqual(wrapper.enabled, true);
});

test('buildWrapperEntry：${ZCODE_PLUGIN_ROOT}/${CLAUDE_PLUGIN_ROOT} 展开为插件根，timeoutMs/cwd 透传', () => {
  const entry = {
    key: 'plugin:p-demo:demo',
    scope: 'plugin',
    pluginRoot: '/cache/p-demo/1.2.0',
    config: {
      type: 'stdio',
      command: 'node',
      args: ['${ZCODE_PLUGIN_ROOT}/dist/mcp/server.js', '${CLAUDE_PLUGIN_ROOT}/lib/x.js', '-v'],
      env: { SCRIPT: '${ZCODE_PLUGIN_ROOT}/s.js' },
      timeoutMs: 90000,
      cwd: '${ZCODE_PLUGIN_ROOT}',
    },
  };
  const wrapper = buildWrapperEntry(entry, '/data');
  assert.deepStrictEqual(wrapper.args.slice(3), [
    'node',
    '/cache/p-demo/1.2.0/dist/mcp/server.js',
    '/cache/p-demo/1.2.0/lib/x.js',
    '-v',
  ]);
  assert.deepStrictEqual(wrapper.env, { SCRIPT: '/cache/p-demo/1.2.0/s.js' });
  assert.strictEqual(wrapper.timeoutMs, 90000);
  assert.strictEqual(wrapper.cwd, '/cache/p-demo/1.2.0');
});

test('buildWrapperEntry：user 级无 pluginRoot 时模板保留字面量', () => {
  const entry = {
    key: 'alpha',
    scope: 'user',
    config: { type: 'stdio', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/x.js'] },
  };
  const wrapper = buildWrapperEntry(entry, '/data');
  assert.deepStrictEqual(wrapper.args.slice(3), ['node', '${ZCODE_PLUGIN_ROOT}/x.js']);
});

test('applyTakeover roundtrip：接管 → config/registry 正确 → 幂等 → restoreAll 恢复原样', async () => {
  const f = makeFixture();
  const originalConfig = JSON.parse(fs.readFileSync(f.userConfigPath, 'utf8'));

  // 1. 接管（自动范围）
  const r1 = await applyTakeover({ home: f.home, dataDir: f.dataDir, workspaceRoot: f.workspaceRoot });
  assert.deepStrictEqual(r1.newly.sort(), ['alpha', 'blocked', 'plugin:p-demo:demo'].sort());
  assert.strictEqual(r1.needsRestart, true);

  const after = JSON.parse(fs.readFileSync(f.userConfigPath, 'utf8'));
  const alpha = after.mcp.servers.alpha;
  assert.strictEqual(alpha.command, 'node');
  assert.strictEqual(alpha.args[0], path.join(f.dataDir, 'launcher', 'proxy-launcher.js'));
  assert.strictEqual(alpha.args[1], 'alpha');
  assert.strictEqual(alpha.args[2], '--');
  assert.deepStrictEqual(alpha.args.slice(3), ['node', 'alpha.js']);
  // 插件级覆盖条目必须用全命名空间 key；模板在写入时展开为插件根绝对路径
  const override = after.mcp.servers['plugin:p-demo:demo'];
  assert.ok(override, '插件级覆盖条目存在');
  assert.strictEqual(override.args[1], 'plugin:p-demo:demo');
  assert.deepStrictEqual(override.args.slice(3), ['node', path.join(f.pluginDir, 'demo.js')]);
  // registry original 保持模板原文（restore 还原插件原定义用）
  assert.deepStrictEqual(loadRegistry(f.dataDir).servers['plugin:p-demo:demo'].original.args, [
    '${ZCODE_PLUGIN_ROOT}/demo.js',
  ]);
  // workspace server 未被自动接管
  assert.ok(!after.mcp.servers.ws1);

  const reg = loadRegistry(f.dataDir);
  assert.deepStrictEqual(reg.servers.alpha.original, originalConfig.mcp.servers.alpha);
  assert.strictEqual(reg.servers['plugin:p-demo:demo'].scope, 'plugin');
  // 预扫描任务文件已生成
  assert.ok(fs.existsSync(path.join(f.dataDir, 'prescan-entries.json')));

  // 2. 幂等：再跑一次无新增、无刷新
  const r2 = await applyTakeover({ home: f.home, dataDir: f.dataDir, workspaceRoot: f.workspaceRoot });
  assert.deepStrictEqual(r2.newly, []);
  assert.deepStrictEqual(r2.refreshed, []);
  assert.strictEqual(r2.needsRestart, false);

  // 3. restoreAll → user config 与接管前 deepEqual、registry 清空
  const rr = restoreAll({ home: f.home, dataDir: f.dataDir });
  assert.deepStrictEqual(rr.restored.sort(), ['alpha', 'blocked', 'plugin:p-demo:demo'].sort());
  assert.deepStrictEqual(rr.missing, []);
  const restored = JSON.parse(fs.readFileSync(f.userConfigPath, 'utf8'));
  assert.deepStrictEqual(restored, originalConfig);
  assert.deepStrictEqual(loadRegistry(f.dataDir).servers, {});

  fs.rmSync(f.home, { recursive: true, force: true });
  fs.rmSync(f.dataDir, { recursive: true, force: true });
  fs.rmSync(f.workspaceRoot, { recursive: true, force: true });
});

test('applyTakeover 漂移刷新：插件定义变化后已接管条目的 wrapper 被重写', async () => {
  const f = makeFixture();
  await applyTakeover({ home: f.home, dataDir: f.dataDir, workspaceRoot: f.workspaceRoot });
  const before = JSON.parse(fs.readFileSync(f.userConfigPath, 'utf8'));
  assert.deepStrictEqual(before.mcp.servers['plugin:p-demo:demo'].args.slice(3), [
    'node',
    path.join(f.pluginDir, 'demo.js'),
  ]);

  // 模拟插件升级：.mcp.json 入口文件改名（pluginRoot 不变，展开结果变）
  writeJson(path.join(f.pluginDir, '.mcp.json'), {
    mcpServers: { demo: { type: 'stdio', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/demo2.js'] } },
  });

  const r = await applyTakeover({ home: f.home, dataDir: f.dataDir, workspaceRoot: f.workspaceRoot });
  assert.deepStrictEqual(r.newly, []);
  assert.deepStrictEqual(r.refreshed, ['plugin:p-demo:demo']);
  assert.strictEqual(r.needsRestart, true);

  const after = JSON.parse(fs.readFileSync(f.userConfigPath, 'utf8'));
  assert.deepStrictEqual(
    after.mcp.servers['plugin:p-demo:demo'].args.slice(3),
    ['node', path.join(f.pluginDir, 'demo2.js')]
  );
  // registry original 保持模板原文（restore 还原插件原定义用）
  assert.deepStrictEqual(
    loadRegistry(f.dataDir).servers['plugin:p-demo:demo'].original.args,
    ['${ZCODE_PLUGIN_ROOT}/demo2.js']
  );

  fs.rmSync(f.home, { recursive: true, force: true });
  fs.rmSync(f.dataDir, { recursive: true, force: true });
  fs.rmSync(f.workspaceRoot, { recursive: true, force: true });
});

test('applyTakeover + restoreOne：workspace 显式接管、单 key 还原', async () => {
  const f = makeFixture();
  const r = await applyTakeover({
    home: f.home,
    dataDir: f.dataDir,
    workspaceRoot: f.workspaceRoot,
    names: ['ws1'],
  });
  assert.deepStrictEqual(r.newly, ['ws1']);
  const after = JSON.parse(fs.readFileSync(f.userConfigPath, 'utf8'));
  assert.ok(after.mcp.servers.ws1, 'workspace server 经 user config 覆盖条目接管');

  const one = restoreOne({ home: f.home, dataDir: f.dataDir, key: 'ws1' });
  assert.deepStrictEqual(one.restored, ['ws1']);
  const restored = JSON.parse(fs.readFileSync(f.userConfigPath, 'utf8'));
  assert.ok(!restored.mcp.servers.ws1, '还原 = 删除覆盖条目（原定义仍在 workspace config）');
  assert.deepStrictEqual(loadRegistry(f.dataDir).servers, {});

  fs.rmSync(f.home, { recursive: true, force: true });
  fs.rmSync(f.dataDir, { recursive: true, force: true });
  fs.rmSync(f.workspaceRoot, { recursive: true, force: true });
});

test('applyTakeover：LockHeldError 时 degradeOnLock=true 降级不抛，false 时抛出', async () => {
  const f = makeFixture();
  const lock = path.join(f.dataDir, 'registry.lock');
  fs.mkdirSync(f.dataDir, { recursive: true });
  fs.writeFileSync(lock, String(process.pid)); // 存活 PID → 互斥

  const degraded = await applyTakeover({
    home: f.home,
    dataDir: f.dataDir,
    degradeOnLock: true,
  });
  assert.strictEqual(degraded.degraded, 'lock-held');
  assert.deepStrictEqual(degraded.newly, []);

  await assert.rejects(
    () => applyTakeover({ home: f.home, dataDir: f.dataDir }),
    (err) => err instanceof LockHeldError
  );
  fs.rmSync(f.home, { recursive: true, force: true });
  fs.rmSync(f.dataDir, { recursive: true, force: true });
  fs.rmSync(f.workspaceRoot, { recursive: true, force: true });
});

test('applyTakeover 写序回归：user config 写失败时 registry 已落记录，下轮 hook 漂移检测自愈', async () => {
  const f = makeFixture();
  const originalConfig = JSON.parse(fs.readFileSync(f.userConfigPath, 'utf8'));

  // 注入 guardedSaveUserConfig 失败：把 config 所在目录设为只读（load 仍可读，save 抛 EACCES）
  const cfgDir = path.dirname(f.userConfigPath);
  fs.chmodSync(cfgDir, 0o555);

  await assert.rejects(() => applyTakeover({ home: f.home, dataDir: f.dataDir, workspaceRoot: f.workspaceRoot }));

  // 先 registry 后 config 的写序：中途失败时 registry 已含接管记录（restore 依赖），
  // 而 user config 未被改写（不产生 config 已覆盖、registry 无记录的孤儿）
  const reg = loadRegistry(f.dataDir);
  assert.ok(reg.servers.alpha, 'registry 已记录 alpha（restore 凭此可还原）');
  assert.ok(reg.servers['plugin:p-demo:demo'], 'registry 已记录插件级条目');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.userConfigPath, 'utf8')), originalConfig);

  // 自愈路径：恢复可写后重跑，takenEntries 漂移检测补写 wrapper 条目
  fs.chmodSync(cfgDir, 0o755);
  const r2 = await applyTakeover({ home: f.home, dataDir: f.dataDir, workspaceRoot: f.workspaceRoot });
  assert.deepStrictEqual(r2.newly, []);
  assert.deepStrictEqual(r2.refreshed.sort(), ['alpha', 'blocked', 'plugin:p-demo:demo'].sort());
  const after = JSON.parse(fs.readFileSync(f.userConfigPath, 'utf8'));
  assert.strictEqual(after.mcp.servers.alpha.args[1], 'alpha', 'wrapper 条目已被补写');

  fs.rmSync(f.home, { recursive: true, force: true });
  fs.rmSync(f.dataDir, { recursive: true, force: true });
  fs.rmSync(f.workspaceRoot, { recursive: true, force: true });
});

test('restoreAll：registry 无记录时返回 missing 而非崩溃', () => {
  const f = makeFixture();
  const rr = restoreAll({ home: f.home, dataDir: f.dataDir });
  assert.deepStrictEqual(rr.restored, []);
  fs.rmSync(f.home, { recursive: true, force: true });
  fs.rmSync(f.dataDir, { recursive: true, force: true });
  fs.rmSync(f.workspaceRoot, { recursive: true, force: true });
});
