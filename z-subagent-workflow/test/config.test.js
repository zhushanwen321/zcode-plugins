'use strict';

/**
 * lib/config.js 单测：ZSW_MAX_CONCURRENT 解析（MF5）+ 嵌套判定 isNestedEnv/NESTED
 * （F03 双标记）+ zswCliPath（F12 单源）。
 *
 * 为什么用子进程而不是进程内重载 require.cache：DEFAULTS / NESTED 在模块加载期
 * 求值一次（require 缓存保证「警告一次」语义），进程内 delete cache 重载
 * 会与本文件其它 lib 共享的 config 实例脱钩，且捕获不到 stderr 警告的
 * 「恰好一次」；子进程天然一个全新模块实例，stdout 取值 + stderr 取警告。
 * isNestedEnv / zswCliPath 是调用期求值的纯函数，进程内直测即可（env 显式传参）。
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isNestedEnv, zswCliPath, resolveEnginePaths } = require('../lib/config');
const CONFIG = path.join(__dirname, '..', 'lib', 'config.js');

/** 子进程加载 config，打印 DEFAULTS.maxConcurrent；返回 {value, stderr}。
 *  env 值为 null 时表示显式删除该键（区分「未设置」与「设为空串」两种形态）。 */
function loadWithEnv(env) {
  const merged = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e',
      `console.log(require(${JSON.stringify(CONFIG)}).DEFAULTS.maxConcurrent)`,
    ], { env: merged, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`子进程退出 code=${code}，stderr: ${err}`));
      else resolve({ value: Number(out.trim()), stderr: err });
    });
  });
}

/** 子进程加载 config，打印 NESTED 布尔（模块加载期求值语义的取值面）。 */
function loadNestedWithEnv(env) {
  const merged = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e',
      `console.log(require(${JSON.stringify(CONFIG)}).NESTED)`,
    ], { env: merged, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`子进程退出 code=${code}`));
      else resolve(out.trim());
    });
    child.stdout.on('data', (c) => { out += c; });
  });
}

test('ZSW_MAX_CONCURRENT 缺省（未设置 / 空串）→ 3，无警告', async () => {
  for (const absent of [null, '']) {
    const { value, stderr } = await loadWithEnv({ ZSW_MAX_CONCURRENT: absent });
    assert.equal(value, 3);
    assert.equal(stderr, '');
  }
});

test('ZSW_MAX_CONCURRENT=5（合法正整数）→ 5', async () => {
  const { value, stderr } = await loadWithEnv({ ZSW_MAX_CONCURRENT: '5' });
  assert.equal(value, 5);
  assert.equal(stderr, '', '合法值不警告');
});

test('ZSW_MAX_CONCURRENT=1（边界最小值）→ 1 生效', async () => {
  const { value } = await loadWithEnv({ ZSW_MAX_CONCURRENT: '1' });
  assert.equal(value, 1);
});

test('ZSW_MAX_CONCURRENT 非法（abc / 0 / -2 / 2.5）→ 忽略并 stderr 警告一次，回落 3', async () => {
  for (const bad of ['abc', '0', '-2', '2.5']) {
    const { value, stderr } = await loadWithEnv({ ZSW_MAX_CONCURRENT: bad });
    assert.equal(value, 3, `${bad} 应回落缺省 3`);
    assert.match(stderr, /ZSW_MAX_CONCURRENT/, `${bad} 应有警告`);
    assert.match(stderr, /正整数/, `${bad} 警告应指向合法形态`);
    assert.match(stderr, /缺省 3/, `${bad} 警告应说明回落值`);
    // 恰好一次：警告行只出现一行（模块加载期求值一次的语义锚点）
    assert.equal(stderr.split('\n').filter((l) => l.includes('ZSW_MAX_CONCURRENT')).length, 1,
      `${bad} 警告应恰好一次`);
  }
});

// ------------------------------------------------- F03：嵌套判定（双标记）

test('isNestedEnv：ZSW_NESTED=1 拒 / XYZ_AGENT_SUBAGENT=1 拒 / 两者都无则过（F03）', () => {
  assert.equal(isNestedEnv({ ZSW_NESTED: '1' }), true, 'ZSW_NESTED=1 → 嵌套');
  assert.equal(isNestedEnv({ XYZ_AGENT_SUBAGENT: '1' }), true, 'XYZ_AGENT_SUBAGENT=1（core 引擎嵌套标记）→ 嵌套');
  assert.equal(isNestedEnv({ ZSW_NESTED: '1', XYZ_AGENT_SUBAGENT: '1' }), true, '双标记 → 嵌套');
  assert.equal(isNestedEnv({}), false, '两者都无 → 非嵌套');
  assert.equal(isNestedEnv({ ZSW_NESTED: '0' }), false, '非 "1" 值不判定为嵌套');
  assert.equal(isNestedEnv({ ZSW_NESTED: 'true' }), false, '宽松真值不判定为嵌套（严格 === "1"）');
});

test('NESTED 模块加载期求值：子进程 env 双标记分别置位 → NESTED=true（加载期冻结语义）', async () => {
  assert.equal(await loadNestedWithEnv({ ZSW_NESTED: '1', XYZ_AGENT_SUBAGENT: null }), 'true');
  assert.equal(await loadNestedWithEnv({ ZSW_NESTED: null, XYZ_AGENT_SUBAGENT: '1' }), 'true',
    'core 引擎嵌套标记（XYZ_AGENT_SUBAGENT=1）单独命中即 NESTED=true');
  assert.equal(await loadNestedWithEnv({ ZSW_NESTED: null, XYZ_AGENT_SUBAGENT: null }), 'false');
});

// ------------------------------------------------- resolveEnginePaths（观察 4）

/**
 * 缺省路径组装单一权威源的直接单测：doctor/clean-fs/clean-exec 三消费方经
 * resolvePaths 同构消费，字段集缺一即运行期 undefined 传染——字段集完整性
 * 与双根（cliRoot 派生面 / v2 索引库独立面）布局在此钉死。
 */
test('resolveEnginePaths：显式 homeDir → 双根布局派生；字段集完整（6 键闭集）', () => {
  const home = path.join('fixtures', 'home-x'); // 相对形态即可验拼接，不触真实 FS
  const r = resolveEnginePaths(home);
  assert.equal(r.cliRoot, path.join(home, '.zcode', 'cli'));
  assert.equal(r.engineDbPath, path.join(home, '.zcode', 'cli', 'db', 'db.sqlite'));
  assert.equal(r.indexDbPath, path.join(home, '.zcode', 'v2', 'tasks-index.sqlite'),
    '索引库不在 cliRoot 下（GUI v2 独立根——clean 删除面防御拦截的路径前提）');
  assert.equal(r.artifactsDir, path.join(home, '.zcode', 'cli', 'artifacts'));
  assert.equal(r.logDir, path.join(home, '.zcode', 'cli', 'log'));
  assert.equal(r.execDir, path.join(home, '.zcode', 'cli', 'exec'));
  assert.deepEqual(Object.keys(r).sort(),
    ['artifactsDir', 'cliRoot', 'engineDbPath', 'execDir', 'indexDbPath', 'logDir'],
    '6 键闭集（消费方依赖面字段恒在，防 undefined 传染）');
});

test('resolveEnginePaths：缺省回落 os.homedir()（与显式传 homedir 同值；不触真实 ~/.zcode 文件）', () => {
  const os = require('node:os');
  const r = resolveEnginePaths();
  const explicit = resolveEnginePaths(os.homedir());
  assert.deepEqual(r, explicit, '缺省 = 显式 os.homedir() 同值（engineCliRoot 单点回落）');
  assert.ok(r.engineDbPath.startsWith(path.join(os.homedir(), '.zcode', 'cli', 'db')));
});

// ------------------------------------------------- F12：zswCliPath 单源

test('zswCliPath：ZCODE_PLUGIN_ROOT 优先，缺省回退插件根 bin/zsw.js（调用期求值）', () => {
  const prev = process.env.ZCODE_PLUGIN_ROOT;
  try {
    delete process.env.ZCODE_PLUGIN_ROOT;
    assert.equal(zswCliPath(), path.join(__dirname, '..', 'bin', 'zsw.js'), '回退 = lib 上级插件根的 bin/zsw.js');
    process.env.ZCODE_PLUGIN_ROOT = '/fake/plugin-root';
    assert.equal(zswCliPath(), path.join('/fake/plugin-root', 'bin', 'zsw.js'), 'env 优先（marketplace 副本形态）');
  } finally {
    if (prev === undefined) delete process.env.ZCODE_PLUGIN_ROOT;
    else process.env.ZCODE_PLUGIN_ROOT = prev;
  }
});
