'use strict';

/**
 * core-ref 消费面守卫（回接计划 U5a，V6-② 恢复指引闭环的可测形态）。
 *
 * 守卫对象：vendored subagent-core 是构建期副本（无 node_modules 解析面），
 * 布局漂移（vendor 脚本忘跑 / 刷新中断 / 未来 vendor 回非自包含形态）只能
 * 靠运行时报错暴露。本文件固化三类守卫：
 *   1. 可操作报错闭环——workflowAssetPath / vendorManifest / requireCore 的
 *      失败路径都指向恢复动作 `node scripts/vendor-subagent-core.js`；
 *   2. 当前 vendored 形态断言——capabilities.selfContainedIndex === true，
 *      vendor 回非自包含 bundle 形态时该断言变红，这正是守卫目的；
 *   3. 消费符号在场——2b/2c 两条执行线实际消费的 core 导出（registerZcodeEngine
 *      / createZcodeEngine / routeEngine / WorkerHostImpl / FileRunStore /
 *      runWorkflow / configureCore）必须可从 vendored 主入口取到。
 *
 * 错误路径隔离：core-ref 的 VENDOR_DIR 绑定其自身 __dirname，无 env 注入点；
 * 但模块零依赖（仅 node:fs / node:path）——复制进临时目录、旁边构造假 vendor
 * 布局后 require 副本即可覆盖全部错误路径，不碰真实 vendored 目录。每用例
 * 独立 mkdtemp，require 缓存按绝对路径天然互不污染。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const coreRef = require('../lib/core-ref');

const REFRESH_CMD = /node scripts\/vendor-subagent-core\.js/;
const CORE_REF_SRC = path.join(__dirname, '..', 'lib', 'core-ref.js');

/**
 * 构造受控假 vendor 布局下的 core-ref 副本。
 * files: { <vendor 内相对路径>: <文件内容> }，undefined 值表示只建目录。
 */
function makeFakeCoreRef(files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-core-ref-'));
  const libDir = path.join(tmp, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.copyFileSync(CORE_REF_SRC, path.join(libDir, 'core-ref.js'));
  for (const [rel, content] of Object.entries(files || {})) {
    const file = path.join(libDir, 'vendor', 'subagent-core', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (content !== undefined) fs.writeFileSync(file, content);
  }
  return { mod: require(path.join(libDir, 'core-ref.js')), tmp };
}

test('workflowAssetPath：真实资产返回 vendored 绝对路径，缺失资产报含刷新命令的错误', () => {
  const p = coreRef.workflowAssetPath('map-reduce.js');
  assert.equal(p, path.join(coreRef.vendorDir(), 'workflows', 'map-reduce.js'));
  assert.ok(fs.existsSync(p), '内置资产 map-reduce.js 应在场');
  assert.throws(
    () => coreRef.workflowAssetPath('no-such-asset.js'),
    (err) => REFRESH_CMD.test(err.message), // 错误指向恢复动作，形成闭环
  );
});

test('vendorManifest：当前 vendored 形态断言（selfContainedIndex 必须为 true）', () => {
  const caps = coreRef.vendorManifest().capabilities;
  assert.equal(caps.selfContainedIndex, true,
    'vendored 主入口应保持自包含 bundle 形态——vendor 回非 bundle（外部依赖未内联）时此断言变红，需按 manifest 溯源刷新');
  assert.equal(caps.workflowsAssets, true, 'workflows/ 资产位是 workflowAssetPath 的前提');
});

test('requireCore：真实 vendored 主入口可加载且暴露 2b/2c 消费面符号', () => {
  const core = coreRef.requireCore();
  // 2c 执行线（lib/runner-core.js 消费面）
  for (const k of ['registerZcodeEngine', 'createZcodeEngine', 'routeEngine', 'killAllSpawnedChildren']) {
    assert.equal(typeof core[k], 'function', `runner-core 消费符号 ${k} 缺失`);
  }
  // 2b workflow 线（lib/orchestration-host.js 消费面）
  assert.equal(typeof core.WorkerHostImpl, 'function', 'WorkerHostImpl 缺失');
  assert.equal(typeof core.FileRunStore, 'function', 'FileRunStore 缺失');
  assert.equal(typeof core.runWorkflow, 'function', 'runWorkflow 缺失');
  assert.equal(typeof core.configureCore, 'function', 'configureCore 缺失');
});

test('错误路径：主入口缺失 → 报错含刷新命令与具体版本号', () => {
  const { mod, tmp } = makeFakeCoreRef({ 'package.json': '{"version":"9.9.9"}' });
  try {
    assert.throws(mod.requireCore, (err) =>
      err.message.includes('主入口不存在')
      && err.message.includes('node scripts/vendor-subagent-core.js --npm 9.9.9'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('错误路径：主入口损坏（require 即抛）→ 报错保留底层错误并含恢复路径文案', () => {
  const { mod, tmp } = makeFakeCoreRef({
    'package.json': '{"version":"0.2.0"}',
    'dist/index.cjs': "throw new Error('boom: intentional');",
  });
  try {
    assert.throws(mod.requireCore, (err) =>
      err.message.includes('加载 vendored subagent-core 主入口失败')
      && err.message.includes('boom: intentional')      // 底层错误不吞
      && err.message.includes('selfContainedIndex'));   // 恢复路径文案锚点
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F04 分流：selfContainedIndex=true → 指向重刷 + sha256 自检（不再误称「非自包含、等 0.4.0」）', () => {
  // 当前 vendored 即自包含 bundle 形态（manifest 如实记录 true）——主入口损坏时
  // 旧静态文案会误导排障方向（让人等一个已发布的 bundle）
  const { mod, tmp } = makeFakeCoreRef({
    'package.json': '{"version":"0.3.0"}',
    'VENDOR-MANIFEST.json': '{"capabilities":{"selfContainedIndex":true}}',
    'dist/index.cjs': "throw new Error('boom: broken bundle');",
  });
  try {
    assert.throws(mod.requireCore, (err) =>
      err.message.includes('应已自包含')
      && err.message.includes('vendor-subagent-core.js --local <core-checkout>')
      && err.message.includes('sha256')
      && !err.message.includes('等 @zhushanwen/subagent-core 0.4.0'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F04 分流：selfContainedIndex=false → 保留旧文案（非自包含，等自包含 bundle 发布）', () => {
  const { mod, tmp } = makeFakeCoreRef({
    'package.json': '{"version":"0.2.0"}',
    'VENDOR-MANIFEST.json': '{"capabilities":{"selfContainedIndex":false}}',
    'dist/index.cjs': "throw new Error('boom: legacy dist');",
  });
  try {
    assert.throws(mod.requireCore, (err) =>
      err.message.includes('非自包含')
      && err.message.includes('等 @zhushanwen/subagent-core 0.4.0 自包含 bundle 发布'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('错误路径：VENDOR-MANIFEST.json 缺失 → vendorManifest 报错含刷新命令', () => {
  const { mod, tmp } = makeFakeCoreRef({ 'package.json': '{"version":"0.2.0"}' });
  try {
    assert.throws(mod.vendorManifest, (err) =>
      err.message.includes('读取 VENDOR-MANIFEST.json 失败') && REFRESH_CMD.test(err.message));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('恢复指引分流：manifest source 为 local: 前缀时指向 --local 通道（防 --npm 刷回扩面前旧产物）', () => {
  // 当前真实 vendored 即 local 源（core 0.4.0 未发 npm）——错误指引会让人把
  // vendored 副本刷回 0.2.0 npm 旧 tarball（无自包含 bundle），本测试钉住分流
  const { mod, tmp } = makeFakeCoreRef({
    'package.json': '{"version":"0.2.0"}',
    'VENDOR-MANIFEST.json': '{"source":"local:/tmp/fake-core@0.2.0"}',
  });
  try {
    assert.throws(() => mod.workflowAssetPath('no-such-asset.js'), (err) =>
      err.message.includes('vendor-subagent-core.js --local /tmp/fake-core')
      && err.message.includes('待 core 0.4.0 发布后可用')
      && !err.message.includes('--npm 0.2.0')); // 不得指引刷回 0.2.0 npm 旧产物
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('解析行为：dist 候选缺失时回退根位 index.cjs（INDEX_CANDIDATES 兼容位）', () => {
  const { mod, tmp } = makeFakeCoreRef({ 'index.cjs': 'module.exports = { sentinel: 42 };' });
  try {
    assert.equal(mod.requireCore().sentinel, 42);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
