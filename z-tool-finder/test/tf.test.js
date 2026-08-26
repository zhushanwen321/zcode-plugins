'use strict';
// bin/tf.js CLI 端到端单测：spawn 子进程跑真实入口，HOME + ZTF_DATA_DIR 双隔离。
// 断言三层：退出码 / stderr 人读输出 / user config·registry·catalog 磁盘副作用。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TF_CLI = path.join(__dirname, '..', 'bin', 'tf.js');
const ECHO_SERVER = path.join(__dirname, 'fixtures', 'echo-server.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 夹具：user config 含 alpha(stdio, echo-server)；inline 插件 p-demo（demo server）。
 * 返回隔离 env 与关键路径。
 */
function makeEnv() {
  const home = tmpDir('ztf-cli-home-');
  const dataDir = tmpDir('ztf-cli-data-');

  const pluginDir = path.join(home, 'plugins', 'p-demo');
  writeJson(path.join(pluginDir, '.zcode-plugin', 'plugin.json'), { name: 'p-demo', version: '0.0.1' });
  // 插件源用 ${ZCODE_PLUGIN_ROOT} 模板（真实插件形态）：catalog refresh / prescan
  // 消费 registry.original 时必须按接管时刻的 pluginRoot 展开，否则 spawn ENOENT
  writeJson(path.join(pluginDir, '.mcp.json'), {
    mcpServers: { demo: { type: 'stdio', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/echo-server-fixture.js'] } },
  });
  // 模板目标：独立于 test/fixtures/echo-server.js 的真实文件（模板展开后被 spawn）
  fs.mkdirSync(path.join(pluginDir), { recursive: true });
  fs.copyFileSync(ECHO_SERVER, path.join(pluginDir, 'echo-server-fixture.js'));

  const userConfigPath = path.join(home, '.zcode', 'cli', 'config.json');
  writeJson(userConfigPath, {
    mcp: { servers: { alpha: { type: 'stdio', command: 'node', args: [ECHO_SERVER] } } },
    plugins: { dirs: [pluginDir] },
  });

  // 剥离宿主会话的嵌套标记（本仓 zsw 开发环境常设 ZSW_NESTED，泄漏会使 hook 走空路径）；
  // 用例显式传 TF_NESTED=1 时可覆盖
  const env = { ...process.env, ZSW_NESTED: '', TF_NESTED: '', HOME: home, ZTF_DATA_DIR: dataDir };
  return { home, dataDir, env, userConfigPath };
}

function tf(args, env, { timeout = 30000 } = {}) {
  return spawnSync(process.execPath, [TF_CLI, ...args], { encoding: 'utf8', timeout, env });
}

function registryPath(dataDir) {
  return path.join(dataDir, 'registry.json');
}

/* ---------------- usage / 参数错误 ---------------- */

test('tf 无子命令：exit 2 + 用法输出', () => {
  const { env } = makeEnv();
  const r = tf([], env);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /用法: tf/);
});

test('tf hook 非 session-start：exit 2', () => {
  const { env } = makeEnv();
  const r = tf(['hook'], env);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /hook 仅支持子命令 session-start/);
});

test('tf catalog 非 refresh：exit 2', () => {
  const { env } = makeEnv();
  const r = tf(['catalog'], env);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /catalog 仅支持子命令 refresh/);
});

test('tf takeover / restore 无参数：exit 2 + 用法提示', () => {
  const { env } = makeEnv();
  assert.match(tf(['takeover'], env).stderr, /takeover 需要 --all 或至少一个 server key/);
  assert.match(tf(['restore'], env).stderr, /restore 需要 --all 或至少一个 server key/);
});

/* ---------------- hook session-start ---------------- */

test('hook：嵌套标记（TF_NESTED）只输出 {}，不接管不注入', () => {
  const { env, userConfigPath } = makeEnv();
  const before = readJson(userConfigPath);
  const r = tf(['hook', 'session-start'], { ...env, TF_NESTED: '1' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '{}');
  assert.deepStrictEqual(readJson(userConfigPath), before); // 无副作用
});

test('hook：正常路径 stdout 单 JSON 契约 + 接管副作用 + 幂等', () => {
  const { env, dataDir, userConfigPath } = makeEnv();

  const r = tf(['hook', 'session-start'], env);
  assert.strictEqual(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  assert.strictEqual(lines.length, 1); // 契约：stdout 只有一个 JSON 对象
  const out = JSON.parse(lines[0]);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
  // 首次接管时 catalog 未就绪 → 空清单占位（不报错）
  assert.match(out.hookSpecificOutput.additionalContext, /<available-custom-tools>/);

  // 副作用 1：user config 中 alpha 被改写为 wrapper 条目（单层包裹）
  const cfg1 = readJson(userConfigPath);
  const alpha1 = cfg1.mcp.servers.alpha;
  assert.strictEqual(alpha1.command, 'node');
  assert.strictEqual(path.basename(alpha1.args[0]), 'proxy-launcher.js');
  assert.strictEqual(alpha1.args[1], 'alpha');
  assert.strictEqual(alpha1.args[2], '--');
  assert.strictEqual(alpha1.args[3], 'node'); // original command 透传
  // 副作用 2：registry 记录 alpha + plugin:p-demo:demo
  const reg = readJson(registryPath(dataDir));
  assert.ok(reg.servers.alpha);
  assert.ok(reg.servers['plugin:p-demo:demo']);
  // 副作用 3：launcher 脚本被刷新到数据目录
  assert.ok(fs.existsSync(path.join(dataDir, 'launcher', 'proxy-launcher.js')));

  // 幂等：再跑一次 hook 不重复包裹
  const r2 = tf(['hook', 'session-start'], env);
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(path.basename(readJson(userConfigPath).mcp.servers.alpha.args[0]), 'proxy-launcher.js');
  const reg2 = readJson(registryPath(dataDir));
  assert.strictEqual(Object.keys(reg2.servers).length, 2);
});

/* ---------------- status ---------------- */

test('status：列出已接管 server 与 catalog 计数', () => {
  const { env } = makeEnv();
  tf(['hook', 'session-start'], env); // 建立接管状态
  const r = tf(['status'], env);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /已接管 server: 2/);
  assert.match(r.stderr, /alpha \[scope=user\]/);
  assert.match(r.stderr, /plugin:p-demo:demo \[scope=plugin\]/);
});

/* ---------------- takeover / restore ---------------- */

test('takeover --all → config wrapper + registry；restore --all → 原样还原', () => {
  const { env, dataDir, userConfigPath } = makeEnv();
  const original = readJson(userConfigPath);

  const t = tf(['takeover', '--all'], env);
  assert.strictEqual(t.status, 0);
  assert.match(t.stderr, /接管: alpha, plugin:p-demo:demo/);
  const wrapped = readJson(userConfigPath).mcp.servers.alpha;
  assert.strictEqual(path.basename(wrapped.args[0]), 'proxy-launcher.js');

  const r = tf(['restore', '--all'], env);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /已还原: alpha,plugin:p-demo:demo/);
  // user 级恢复原始定义；plugin 级覆盖条目被删除
  const cfg = readJson(userConfigPath);
  assert.deepStrictEqual(cfg.mcp.servers.alpha, original.mcp.servers.alpha);
  assert.strictEqual(cfg.mcp.servers['plugin:p-demo:demo'], undefined);
  assert.deepStrictEqual(readJson(registryPath(dataDir)).servers, {});
});

test('takeover <key> 显式模式：只接管点名 key，其余不动', () => {
  const { env, userConfigPath } = makeEnv();
  const r = tf(['takeover', 'alpha'], env);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /接管: alpha/);
  const cfg = readJson(userConfigPath);
  assert.strictEqual(path.basename(cfg.mcp.servers.alpha.args[0]), 'proxy-launcher.js');
  // 未点名的 plugin server 不被接管（user config 无覆盖条目）
  assert.strictEqual(cfg.mcp.servers['plugin:p-demo:demo'], undefined);
});

test('takeover 未知 key：报错 exit 1（不静默成功）', () => {
  const { env } = makeEnv();
  const r = tf(['takeover', 'nope'], env);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /未知 server key: nope/);
});

test('takeover <key> 重复执行：已接管 key 不误报未知（registry 兜底可见）', () => {
  const { env } = makeEnv();
  tf(['takeover', 'alpha'], env);
  const r = tf(['takeover', 'alpha'], env);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /接管: \(无新增\)/);
});

test('takeover --all 重复执行：报告已在接管中，不重复包裹', () => {
  const { env, userConfigPath } = makeEnv();
  tf(['takeover', '--all'], env);
  const r = tf(['takeover', '--all'], env);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /接管: \(无新增\)/);
  // user 级 alpha 已是 wrapper 条目，被扫描层防递归跳过（其幂等由 wrapper 形态保证）；
  // 只有插件源条目（源头在 .mcp.json，始终可见）会出现在「已在接管中」
  assert.match(r.stderr, /已在接管中: plugin:p-demo:demo/);
  assert.strictEqual(path.basename(readJson(userConfigPath).mcp.servers.alpha.args[0]), 'proxy-launcher.js');
});

test('restore <key>：只还原指定条目，未知 key 报 missing', () => {
  const { env, userConfigPath } = makeEnv();
  tf(['takeover', '--all'], env);
  const r = tf(['restore', 'alpha', 'nope'], env);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /已还原: alpha/);
  assert.match(r.stderr, /registry 无记录\(未还原\): nope/);
  const cfg = readJson(userConfigPath);
  assert.deepStrictEqual(cfg.mcp.servers.alpha.command, 'node');
  assert.strictEqual(cfg.mcp.servers.alpha.args[0], ECHO_SERVER); // 原始定义
});

/* ---------------- catalog refresh ---------------- */

test('catalog refresh：无接管时提示无需刷新，exit 0', () => {
  const { env } = makeEnv();
  const r = tf(['catalog', 'refresh'], env);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /无已接管 server/);
});

test('catalog refresh：真实扫描已接管 server 并落盘工具清单（插件源模板路径已展开）', () => {
  const { env, dataDir } = makeEnv();
  tf(['takeover', '--all'], env);
  const r = tf(['catalog', 'refresh'], env);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /ok: alpha,plugin:p-demo:demo/);
  const cat = readJson(path.join(dataDir, 'catalog.json'));
  const toolNames = cat.servers.alpha.tools.map((t) => t.name).sort();
  assert.deepStrictEqual(toolNames, ['echo', 'ping']);
  // 插件源 original 是 ${ZCODE_PLUGIN_ROOT} 模板：未按 pluginRoot 展开则 prescan spawn
  // 必然 failed（旧实现该断言失败，回归 R7/上一轮 catalog refresh 修复）
  assert.ok(cat.servers['plugin:p-demo:demo'], '插件源 server 应出现在 catalog');
  assert.deepStrictEqual(
    cat.servers['plugin:p-demo:demo'].tools.map((t) => t.name).sort(),
    ['echo', 'ping']
  );
});

/* ---------------- doctor ---------------- */

test('doctor：全新数据目录 → launcher 缺失，exit 1 + 修复建议', () => {
  const { env } = makeEnv();
  const r = tf(['doctor'], env);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /\[1\] launcher 脚本 .*: 缺失/);
  assert.match(r.stderr, /launcher 缺失 →/);
});

test('doctor：接管后全绿（launcher/registry/catalog 就绪），exit 0', () => {
  const { env } = makeEnv();
  tf(['hook', 'session-start'], env);
  tf(['catalog', 'refresh'], env);
  const r = tf(['doctor'], env);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /\[1\] launcher 脚本 .*: OK/);
  assert.match(r.stderr, /\[3\] registry\.json 可读: OK（已接管 2）/);
  assert.match(r.stderr, /全部检查通过/);
});

test('doctor <key>：已接管 key 输出记录，未知 key 给 takeover 建议', () => {
  const { env } = makeEnv();
  // hook 而非 takeover：doctor [1] 依赖 launcher 副本，只有 hook 路径会刷新它
  tf(['hook', 'session-start'], env);

  const ok = tf(['doctor', 'alpha'], env);
  assert.strictEqual(ok.status, 0);
  assert.match(ok.stderr, /\[5\] alpha: scope=user original=node/);

  const missing = tf(['doctor', 'nope'], env);
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /server "nope" 不在 registry → 先运行 tf takeover nope/);
});
