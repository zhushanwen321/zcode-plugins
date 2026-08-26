'use strict';
// config-io 单测：全部用临时目录构造 fixture，不碰真实 ~/.zcode
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  loadUserConfig,
  saveUserConfig,
  scanServers,
  pluginRootFor,
} = require('../lib/config-io.js');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ztf-cfg-'));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

test('saveUserConfig 原子写：写后 JSON 可读回', () => {
  const home = tmpHome();
  const cfg = { mcp: { servers: { a: { command: 'node' } } } };
  saveUserConfig(cfg, home);
  assert.deepStrictEqual(loadUserConfig(home), cfg);
});

test('loadUserConfig：文件不存在返回 {}，损坏 JSON 返回 {}，不抛', () => {
  const home = tmpHome();
  assert.deepStrictEqual(loadUserConfig(home), {});
  const file = path.join(home, '.zcode/cli/config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{broken json');
  assert.deepStrictEqual(loadUserConfig(home), {});
});

test('loadUserConfig：home 缺参抛 TypeError', () => {
  assert.throws(() => loadUserConfig(), TypeError);
});

function buildFixture() {
  const home = tmpHome();
  const inlinePlugin = path.join(home, 'dev-plugins', 'z-tool-finder');
  writeJson(path.join(inlinePlugin, '.zcode-plugin', 'plugin.json'), { name: 'z-tool-finder' });
  writeJson(path.join(inlinePlugin, '.mcp.json'), {
    mcpServers: {
      main: { command: 'node', args: ['server.js'] },
      disabled: { command: 'node', enabled: false },
      http: { type: 'sse', url: 'http://x' },
    },
  });
  const cacheRoot = path.join(home, '.zcode/cli/plugins/cache');
  writeJson(path.join(cacheRoot, 'zcode-plugins-official', 'browser-use', '1.3.0', '.mcp.json'), {
    mcpServers: { browser: { command: 'node', args: ['b.js'] } },
  });
  writeJson(path.join(cacheRoot, 'zcode-plugins-official', 'browser-use', '1.10.0', '.mcp.json'), {
    mcpServers: { browser: { command: 'node', args: ['b-new.js'] } },
  });
  writeJson(path.join(home, '.zcode/cli/config.json'), {
    mcp: {
      servers: {
        myserver: { command: 'node', args: ['x.js'] },
        off: { command: 'node', enabled: false },
        remote: { type: 'http', url: 'http://y' },
        sseSkip: { type: 'sse' },
      },
    },
    plugins: {
      dirs: [inlinePlugin],
      enabledPlugins: ['browser-use@zcode-plugins-official'],
    },
  });
  const workspaceRoot = path.join(home, 'ws');
  writeJson(path.join(workspaceRoot, '.zcode', 'config.json'), {
    mcp: { servers: { wsserver: { command: 'node', args: ['w.js'] } } },
  });
  return { home, workspaceRoot, inlinePlugin, cacheRoot };
}

test('scanServers 三源归一化：key 形态、enabled:false 与非 stdio 跳过', () => {
  const { home, workspaceRoot } = buildFixture();
  const servers = scanServers({ home, workspaceRoot });
  const keys = servers.map((s) => s.key).sort();

  assert.deepStrictEqual(keys, [
    'myserver', // user
    'plugin:browser-use:browser', // cache 插件，取最高版本
    'plugin:z-tool-finder:main', // inline 插件
    'wsserver', // workspace
  ]);

  const byKey = Object.fromEntries(servers.map((s) => [s.key, s]));
  assert.strictEqual(byKey['myserver'].scope, 'user');
  assert.strictEqual(byKey['wsserver'].scope, 'workspace');
  assert.strictEqual(byKey['plugin:z-tool-finder:main'].scope, 'plugin');
  assert.strictEqual(byKey['plugin:z-tool-finder:main'].pluginName, 'z-tool-finder');
  assert.strictEqual(byKey['plugin:browser-use:browser'].serverName, 'browser');
  // cache 多版本取语义化最高（1.10.0 > 1.3.0）
  assert.deepStrictEqual(byKey['plugin:browser-use:browser'].config.args, ['b-new.js']);
  // config 为原文，未动模板变量
  const tplHome = tmpHome();
  writeJson(path.join(tplHome, '.zcode/cli/config.json'), {
    mcp: { servers: { t: { command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/x.js'] } } },
  });
  const [t] = scanServers({ home: tplHome });
  assert.deepStrictEqual(t.config.args, ['${ZCODE_PLUGIN_ROOT}/x.js']);
});

test('scanServers：workspace config 不存在时跳过该源', () => {
  const { home } = buildFixture();
  const servers = scanServers({ home, workspaceRoot: path.join(home, 'nope') });
  assert.ok(servers.every((s) => s.scope !== 'workspace'));
});

test('pluginRootFor：inline 优先，其次 cache 最高版本，找不到返回 null', () => {
  const { home, inlinePlugin } = buildFixture();
  assert.strictEqual(pluginRootFor({ home, pluginName: 'z-tool-finder' }), inlinePlugin);
  assert.strictEqual(
    pluginRootFor({ home, pluginName: 'browser-use' }),
    path.join(home, '.zcode/cli/plugins/cache/zcode-plugins-official/browser-use/1.10.0')
  );
  assert.strictEqual(pluginRootFor({ home, pluginName: 'no-such' }), null);
});
