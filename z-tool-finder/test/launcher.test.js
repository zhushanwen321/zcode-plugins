'use strict';
// launcher 解析优先级 + syncLauncher + restore.js 独立 roundtrip。
// 全部走 ZTF_DATA_DIR / HOME 注入，不碰真实 ~/.zcode。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');

const PLUGIN_ROOT = path.join(__dirname, '..');
const LAUNCHER_SRC = path.join(PLUGIN_ROOT, 'lib', 'launcher');
const { syncLauncher } = require('../lib/launcher-sync');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 会话夹具：发一组请求，按 id 收齐全部响应后 resolve
function session(child, requests, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const results = new Map();
    const pendingIds = new Set();
    let nextId = 1;
    const timer = setTimeout(() => reject(new Error('launcher 会话超时')), timeoutMs);
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id !== undefined && pendingIds.has(msg.id)) {
        results.set(msg.id, msg);
        pendingIds.delete(msg.id);
        if (!pendingIds.size) {
          clearTimeout(timer);
          resolve(requests.map((_, i) => results.get(i + 1)));
        }
      }
    });
    requests.forEach(([method, params], i) => {
      const id = nextId++;
      pendingIds.add(id);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  });
}

// 跑一个 launcher 副本并完成 initialize + tools/list
async function launcherToolsList(launcherFile, serverKey, env) {
  const child = spawn(process.execPath, [launcherFile, serverKey, '--', process.execPath, path.join(__dirname, 'fixtures', 'echo-server.js')], { env });
  const [initRes, listRes] = await session(child, [
    ['initialize', { protocolVersion: '2024-11-05', capabilities: {} }],
    ['tools/list', {}],
  ]);
  child.kill();
  return { initRes, listRes };
}

test('syncLauncher：复制两文件 + 写 launcher.json', (t) => {
  const dataDir = tmpDir('ztf-launcher-test-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const result = syncLauncher(dataDir, PLUGIN_ROOT);
  assert.equal(path.basename(result.launcherDir), 'launcher');
  for (const name of ['proxy-launcher.js', 'restore.js', 'launcher.json']) {
    assert.ok(fs.existsSync(path.join(result.launcherDir, name)), `缺少 ${name}`);
  }
  const meta = JSON.parse(fs.readFileSync(result.metaPath, 'utf8'));
  assert.equal(meta.pluginRoot, PLUGIN_ROOT);
  assert.ok(meta.syncedAt);
});

test('launcher 优先级：同目录 launcher.json 胜过 ZTF_PLUGIN_ROOT', async (t) => {
  const dataDir = tmpDir('ztf-launcher-test-');
  const fakeHome = tmpDir('ztf-fake-home-');
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });
  syncLauncher(dataDir, PLUGIN_ROOT);
  // env 指向一个不含 proxy.js 的假根：若 env 优先则启动失败，launcher.json 优先则正常返回 meta 工具
  const bogusRoot = tmpDir('ztf-bogus-root-');
  t.after(() => fs.rmSync(bogusRoot, { recursive: true, force: true }));
  const { listRes } = await launcherToolsList(
    path.join(dataDir, 'launcher', 'proxy-launcher.js'),
    'echo-test',
    { ZTF_DATA_DIR: dataDir, ZTF_PLUGIN_ROOT: bogusRoot, HOME: fakeHome }
  );
  const names = listRes.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['call_tool', 'get_tool_details']);
});

test('launcher 回退：无 launcher.json 时用 ZTF_PLUGIN_ROOT', async (t) => {
  const dataDir = tmpDir('ztf-launcher-test-');
  const fakeHome = tmpDir('ztf-fake-home-');
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });
  // 只复制 launcher 本体，不写 launcher.json
  fs.mkdirSync(path.join(dataDir, 'launcher'), { recursive: true });
  fs.copyFileSync(path.join(LAUNCHER_SRC, 'proxy-launcher.js'), path.join(dataDir, 'launcher', 'proxy-launcher.js'));
  const { listRes } = await launcherToolsList(
    path.join(dataDir, 'launcher', 'proxy-launcher.js'),
    'echo-test',
    { ZTF_DATA_DIR: dataDir, ZTF_PLUGIN_ROOT: PLUGIN_ROOT, HOME: fakeHome }
  );
  assert.equal(listRes.result.tools.length, 2);
});

test('launcher：本体不存在时透传原始定义（卸载后不改配置继续用）', async (t) => {
  const dataDir = tmpDir('ztf-launcher-test-');
  const fakeHome = tmpDir('ztf-fake-home-');
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dataDir, 'launcher'), { recursive: true });
  fs.copyFileSync(path.join(LAUNCHER_SRC, 'proxy-launcher.js'), path.join(dataDir, 'launcher', 'proxy-launcher.js'));
  const { listRes } = await launcherToolsList(
    path.join(dataDir, 'launcher', 'proxy-launcher.js'),
    'echo-test',
    { ZTF_DATA_DIR: dataDir, HOME: fakeHome }
  );
  // 透传形态：返回 fixture 原生工具，而非 wrapper 的 meta 2 件套
  const names = listRes.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('echo'), `应含原生工具 echo，实际: ${names.join(',')}`);
  assert.ok(
    !names.includes('call_tool') && !names.includes('get_tool_details'),
    `不应再有 meta 工具，实际: ${names.join(',')}`
  );
});

test('launcher：本体不存在且 argv 无 "--" → exit 1 + restore 指引', (t) => {
  const dataDir = tmpDir('ztf-launcher-test-');
  const fakeHome = tmpDir('ztf-fake-home-');
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dataDir, 'launcher'), { recursive: true });
  fs.copyFileSync(path.join(LAUNCHER_SRC, 'proxy-launcher.js'), path.join(dataDir, 'launcher', 'proxy-launcher.js'));
  const res = spawnSync(
    process.execPath,
    [path.join(dataDir, 'launcher', 'proxy-launcher.js'), 'echo-test'], // 无 "--" 段
    { env: { ...process.env, ZTF_DATA_DIR: dataDir, HOME: fakeHome }, encoding: 'utf8', timeout: 10000 }
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /restore\.js --all/);
});

// ---------- restore.js 独立 roundtrip ----------

function makeRestoreFixture() {
  const home = tmpDir('ztf-restore-home-');
  const dataDir = tmpDir('ztf-restore-data-');
  const configDir = path.join(home, '.zcode', 'cli');
  fs.mkdirSync(configDir, { recursive: true });

  const registry = {
    servers: {
      'my-user-server': {
        scope: 'user',
        original: { command: 'node', args: ['/orig/user-server.js'], env: {} },
        wrapperEntry: { command: 'node', args: ['<launcher>', 'my-user-server', '--', 'node', '/orig/user-server.js'] },
        takenOverAt: '2026-08-26T00:00:00Z',
      },
      'plugin:demo:helper': {
        scope: 'plugin',
        original: { command: 'node', args: ['/cache/demo/0.1.0/helper.js'], env: {} },
        wrapperEntry: { command: 'node', args: ['<launcher>', 'plugin:demo:helper', '--', 'node', '/cache/demo/0.1.0/helper.js'] },
        takenOverAt: '2026-08-26T00:00:00Z',
      },
      'ws-server': {
        scope: 'workspace',
        original: { command: 'node', args: ['/repo/.zcode/ws-server.js'], env: {} },
        wrapperEntry: { command: 'node', args: ['<launcher>', 'ws-server', '--', 'node', '/repo/.zcode/ws-server.js'] },
        takenOverAt: '2026-08-26T00:00:00Z',
      },
    },
    overrides: {},
    policies: {},
  };
  fs.writeFileSync(path.join(dataDir, 'registry.json'), JSON.stringify(registry, null, 2));

  // 被接管后的 config：user 条目已被改写、plugin 条目是覆盖形态
  const config = {
    mcp: {
      servers: {
        'my-user-server': { command: 'node', args: ['~/.zcode/z-tool-finder/launcher/proxy-launcher.js', 'my-user-server', '--', 'node', '/orig/user-server.js'] },
        'plugin:demo:helper': { command: 'node', args: ['~/.zcode/z-tool-finder/launcher/proxy-launcher.js', 'plugin:demo:helper', '--', 'node', '/cache/demo/0.1.0/helper.js'] },
        'ws-server': { command: 'node', args: ['~/.zcode/z-tool-finder/launcher/proxy-launcher.js', 'ws-server', '--', 'node', '/repo/.zcode/ws-server.js'] },
      },
    },
  };
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2));
  return { home, dataDir, configPath: path.join(configDir, 'config.json') };
}

function runRestore(home, dataDir, args) {
  return spawnSync(process.execPath, [path.join(LAUNCHER_SRC, 'restore.js'), ...args], {
    env: { ...process.env, HOME: home, ZTF_DATA_DIR: dataDir },
    encoding: 'utf8',
    timeout: 10000,
  });
}

test('restore --all：user 条目恢复原文、plugin 条目删除、registry 清空', (t) => {
  const { home, dataDir, configPath } = makeRestoreFixture();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const res = runRestore(home, dataDir, ['--all']);
  assert.equal(res.status, 0, res.stderr);

  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(cfg.mcp.servers['my-user-server'], { command: 'node', args: ['/orig/user-server.js'], env: {} });
  assert.ok(!('plugin:demo:helper' in cfg.mcp.servers), 'plugin 覆盖条目应被删除');
  // workspace 源：删除覆盖条目，不得把 original 写进 user config（原始定义在仓库 workspace config）
  assert.ok(!('ws-server' in cfg.mcp.servers), 'workspace 覆盖条目应被删除');

  const reg = JSON.parse(fs.readFileSync(path.join(dataDir, 'registry.json'), 'utf8'));
  assert.deepEqual(reg.servers, {});
});

test('restore <serverKey>：只还原指定条目，其余保留', (t) => {
  const { home, dataDir, configPath } = makeRestoreFixture();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const res = runRestore(home, dataDir, ['plugin:demo:helper']);
  assert.equal(res.status, 0, res.stderr);

  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.ok(!('plugin:demo:helper' in cfg.mcp.servers));
  // 未指定的 user 条目保持 wrapper 形态
  assert.match(cfg.mcp.servers['my-user-server'].args[0], /proxy-launcher\.js/);

  const reg = JSON.parse(fs.readFileSync(path.join(dataDir, 'registry.json'), 'utf8'));
  assert.ok('my-user-server' in reg.servers);
  assert.ok(!('plugin:demo:helper' in reg.servers));
});

test('restore：无参数打印用法；未知 key 报错列出现有记录', (t) => {
  const { home, dataDir } = makeRestoreFixture();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const noArg = runRestore(home, dataDir, []);
  assert.equal(noArg.status, 2);
  assert.match(noArg.stderr, /用法/);

  const unknown = runRestore(home, dataDir, ['no-such-server']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /my-user-server/);
});

test('restore：锁被活跃进程持有时放弃且不动任何文件', (t) => {
  const { home, dataDir, configPath } = makeRestoreFixture();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const regBefore = fs.readFileSync(path.join(dataDir, 'registry.json'), 'utf8');
  const cfgBefore = fs.readFileSync(configPath, 'utf8');
  // 活锁：写当前测试进程的 PID（存活且 mtime 新鲜）
  fs.writeFileSync(path.join(dataDir, 'registry.lock'), String(process.pid));
  const res = runRestore(home, dataDir, ['--all']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /锁被其他进程持有/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'registry.json'), 'utf8'), regBefore);
  assert.equal(fs.readFileSync(configPath, 'utf8'), cfgBefore);
  // 锁文件保留（属持锁者），内容未被篡改
  assert.equal(fs.readFileSync(path.join(dataDir, 'registry.lock'), 'utf8'), String(process.pid));
});

test('restore：锁标记死亡 PID 时按 stale 接管并完成还原', (t) => {
  const { home, dataDir } = makeRestoreFixture();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dataDir, 'registry.lock'), '999999999'); // 不存在的 PID
  const res = runRestore(home, dataDir, ['--all']);
  assert.equal(res.status, 0, res.stderr);
  const reg = JSON.parse(fs.readFileSync(path.join(dataDir, 'registry.json'), 'utf8'));
  assert.deepEqual(reg.servers, {});
  assert.ok(!fs.existsSync(path.join(dataDir, 'registry.lock')), '还原后锁应被释放');
});

// ---------- resolvePluginRoot 候选 3（inline dirs 扫描）与候选 4（cache 最高版本） ----------

// 最小 proxy 本体桩：respond initialize/tools-list，serverInfo.name 带 marker 以识别被选中的根
function writeStubProxy(root, marker) {
  const file = path.join(root, 'dist', 'mcp', 'proxy.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `'use strict';
const readline = require('readline');
const MARKER = ${JSON.stringify(marker)};
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub-' + MARKER, version: '0.0.0' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'stub_tool' }] } }) + '\\n');
  }
});
module.exports = { main() {} };
`);
}

function copyBareLauncher(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'launcher'), { recursive: true });
  fs.copyFileSync(path.join(LAUNCHER_SRC, 'proxy-launcher.js'), path.join(dataDir, 'launcher', 'proxy-launcher.js'));
}

function writeFakeHomeConfig(home, config) {
  fs.mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zcode', 'cli', 'config.json'), JSON.stringify(config, null, 2));
}

test('候选 3：无 launcher.json/env 时扫 inline plugins.dirs 以 plugin.json name 命中', async (t) => {
  const dataDir = tmpDir('ztf-launcher-test-');
  const fakeHome = tmpDir('ztf-fake-home-');
  const fakeRoot = tmpDir('ztf-inline-root-'); // 目录名故意不带 z-tool-finder，验证按 name 匹配
  t.after(() => {
    for (const d of [dataDir, fakeHome, fakeRoot]) fs.rmSync(d, { recursive: true, force: true });
  });
  copyBareLauncher(dataDir);
  writeJson(path.join(fakeRoot, '.zcode-plugin', 'plugin.json'), { name: 'z-tool-finder' });
  writeStubProxy(fakeRoot, 'inline');
  writeFakeHomeConfig(fakeHome, { plugins: { dirs: [fakeRoot] } });

  const { initRes } = await launcherToolsList(
    path.join(dataDir, 'launcher', 'proxy-launcher.js'),
    'echo-test',
    { ZTF_DATA_DIR: dataDir, HOME: fakeHome } // 无 launcher.json、无 ZTF_PLUGIN_ROOT
  );
  assert.equal(initRes.result.serverInfo.name, 'stub-inline');
});

test('候选 4：inline 候选缺 proxy.js 时降级到 cache 最高版本（1.10.0 > 1.3.0）', async (t) => {
  const dataDir = tmpDir('ztf-launcher-test-');
  const fakeHome = tmpDir('ztf-fake-home-');
  const brokenInline = tmpDir('ztf-broken-inline-');
  t.after(() => {
    for (const d of [dataDir, fakeHome, brokenInline]) fs.rmSync(d, { recursive: true, force: true });
  });
  copyBareLauncher(dataDir);
  // inline dirs 有 name 匹配的插件但缺 dist/mcp/proxy.js → 候选 3 存在却无效，须继续降级
  writeJson(path.join(brokenInline, '.zcode-plugin', 'plugin.json'), { name: 'z-tool-finder' });
  writeFakeHomeConfig(fakeHome, { plugins: { dirs: [brokenInline] } });
  const cacheBase = path.join(fakeHome, '.zcode', 'cli', 'plugins', 'cache', 'mkp', 'z-tool-finder');
  writeStubProxy(path.join(cacheBase, '1.3.0'), '1.3.0');
  writeStubProxy(path.join(cacheBase, '1.10.0'), '1.10.0');

  const { initRes } = await launcherToolsList(
    path.join(dataDir, 'launcher', 'proxy-launcher.js'),
    'echo-test',
    { ZTF_DATA_DIR: dataDir, HOME: fakeHome }
  );
  // 语义化比较（非字典序）：应选 1.10.0
  assert.equal(initRes.result.serverInfo.name, 'stub-1.10.0');
});

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
