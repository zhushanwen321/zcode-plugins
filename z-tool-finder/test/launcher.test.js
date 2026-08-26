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
