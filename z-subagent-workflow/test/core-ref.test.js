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
 *   3. 消费符号在场——各执行线实际消费的 core 导出必须可从 vendored 主入口取到：
 *      2b/2c 基线（registerZcodeEngine / createZcodeEngine / routeEngine /
 *      WorkerHostImpl / FileRunStore / runWorkflow / configureCore）、sink 扩面
 *      （V8g 清单）、下沉消费收口（worktree-git-ops 函数族 / getCachedParsed /
 *      evictDoneRunsBeyondCap / MAX_RETAINED_DONE_RUNS / FileRunStore 方法本体，
 *      见「下沉消费收口符号在场」用例）。
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

test('sink 扩面新导出面全符号在场（V8g 守卫，拦陈旧 vendored bundle）', () => {
  // V8g 消费面（设计 §3.0 勘误版清单，符号实名以 core barrel 为准）。
  // 本清单是唯一能拦「陈旧 bundle」的网：后续消费单元（V1a/V3w/V5e/V6w）
  // 改调这些符号前，vendored 必须先刷到含 sink 扩面的 bundle——符号缺失
  // 即说明 vendor 产物落后于源，按报错指引刷新。
  const core = coreRef.requireCore();
  // 函数类（V1a/V3w/V5e/V6w 各消费单元将改调的原语）
  for (const k of [
    'normalizeRef', 'invalidAgentRefMessage',       // agent-ref 面（V1a）
    'normalizeWorkflowRef', 'loadWorkflowScriptByPath', // workflow 面（V3w）
    'parseAgentProfile', 'discoverAgents',          // 发现/解析面（V1a）
    'maxTurnsToWatchdogMs', 'createConcurrencyPool', 'isProcessAlive', // 引擎与进程面（V5e）
    'splitZcodeModelRef', 'hasApiKey', 'getModelConfigService', // 模型面（V5e）
    'collectWorktreePatch',                          // worktree git 内核（V6w）
    'recoverCrashedRuns', 'runSummary', 'isScriptRunning', // 运行时面
    'writeAtomicFileSync',                           // 原子写（勘误实名，非 atomicWriteFileSync）
    'normalizeArgsByMeta', 'argKeysFromMeta', 'findFlattenedArgKeys', // args-meta 面
    'displayAgentName',                              // 显示名投影
  ]) {
    assert.equal(typeof core[k], 'function', `sink 扩面消费符号 ${k} 缺失——vendored bundle 落后于源，重跑 node scripts/vendor-subagent-core.js --local <core-checkout> 刷新`);
  }
  // 类/值类：typeof 'function' 同样适用（class 即构造器）
  for (const k of ['WorkflowScript', 'ModelConfigService']) {
    assert.equal(typeof core[k], 'function', `sink 扩面消费类 ${k} 缺失——vendored bundle 落后于源，重跑 node scripts/vendor-subagent-core.js --local <core-checkout> 刷新`);
  }
  // 常量类：按值形态断言（函数循环的 typeof 'function' 不适用于此组）
  for (const k of ['AGENT_REF_EXT', 'WORKFLOW_REF_EXT', 'DEFAULT_PROVIDER_ID', 'ZCODE_FALLBACK_DEFAULT_MODEL']) {
    assert.equal(typeof core[k], 'string', `sink 扩面常量 ${k} 缺失或非 string——vendored bundle 落后于源，重跑 node scripts/vendor-subagent-core.js --local <core-checkout> 刷新`);
  }
  assert.equal(typeof core.SLUG_MAX_LENGTH, 'number', 'sink 扩面常量 SLUG_MAX_LENGTH 缺失或非 number——vendored bundle 落后于源，重跑 node scripts/vendor-subagent-core.js --local <core-checkout> 刷新');
  // 快照版本值断言：落盘快照兼容性锚点（版本漂移 = 存量快照不可读）
  assert.equal(core.SNAPSHOT_VERSION, 'wf-run-v2',
    'SNAPSHOT_VERSION 值漂移——存量 workflow-state 快照按 "wf-run-v2" 落盘，刷新后版本不符须先核实快照兼容性');
});

test('下沉消费收口符号在场（Wave 1 守卫，worktree/发现/编排三线实际消费面）', () => {
  // 逐一核实过 vendored dist 真实可达形态（函数 / number / prototype 方法）后
  // 固化。符号缺失 = vendored bundle 落后于源（vendor 脚本忘跑 / 刷新中断），
  // 消费单元运行时才会炸的布局漂移在此提前变红。
  const core = coreRef.requireCore();
  const REFRESH = '——vendored bundle 落后于源，重跑 node scripts/vendor-subagent-core.js --local <core-checkout> 刷新';
  // worktree-git-ops 函数族：lib/worktree.js git 执行面全量消费
  // （prepare→gitRun/isSafeId/isTreeDirty；cleanup→cleanupWorktree；listOrphans→listWorktreePorcelain/isSafeId）
  for (const k of ['gitRun', 'isSafeId', 'isTreeDirty', 'cleanupWorktree', 'listWorktreePorcelain']) {
    assert.equal(typeof core[k], 'function', `worktree-git-ops 消费符号 ${k} 缺失${REFRESH}`);
  }
  // 发现线：lib/agent-discovery.js parseFnPool 缓存读（parseAgentProfile 同源缓存原语）
  assert.equal(typeof core.getCachedParsed, 'function', `getCachedParsed 缺失${REFRESH}`);
  // 编排线：lib/orchestration-host.js onRunDone 内存淘汰（done run 超上限即逐出）
  assert.equal(typeof core.evictDoneRunsBeyondCap, 'function', `evictDoneRunsBeyondCap 缺失${REFRESH}`);
  // 上限常量按值形态断言（数值随 core 演进合法，只锚存在与类型）
  assert.equal(typeof core.MAX_RETAINED_DONE_RUNS, 'number', `MAX_RETAINED_DONE_RUNS 缺失或非 number${REFRESH}`);
  // FileRunStore 方法本体：record 修剪消费面（prototype 链上的真实方法——
  // 类在场 ≠ 方法在场，桶内改名/挪方法时类守卫不红，此断言补上该盲区）
  assert.equal(
    typeof core.FileRunStore?.prototype?.pruneStateFilesBeyondCap, 'function',
    `FileRunStore.prototype.pruneStateFilesBeyondCap 缺失${REFRESH}`,
  );
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

test('F04 分流：selfContainedIndex=false → 保守回落文案（状态未确认，指向重刷 + sha256 自检）', () => {
  const { mod, tmp } = makeFakeCoreRef({
    'package.json': '{"version":"0.2.0"}',
    'VENDOR-MANIFEST.json': '{"capabilities":{"selfContainedIndex":false}}',
    'dist/index.cjs': "throw new Error('boom: legacy dist');",
  });
  try {
    assert.throws(mod.requireCore, (err) =>
      err.message.includes('自包含状态未确认为 true')
      && err.message.includes('vendor-subagent-core.js --local <core-path>')
      && err.message.includes('sha256')
      && !err.message.includes('等 @zhushanwen/subagent-core 0.4.0'));
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

test('恢复指引分流：manifest source 为 local: 前缀时指向 --local 通道（--npm 如实记为正规升级通道，不指具体版本）', () => {
  // 当前真实 vendored 即 local 源——local 分流把刷新钉在 --local 原路（与
  // source 同一构建产物），--npm 具体版本不在 local 分流出现，本测试钉住分流
  const { mod, tmp } = makeFakeCoreRef({
    'package.json': '{"version":"0.2.0"}',
    'VENDOR-MANIFEST.json': '{"source":"local:/tmp/fake-core@0.2.0"}',
  });
  try {
    assert.throws(() => mod.workflowAssetPath('no-such-asset.js'), (err) =>
      err.message.includes('vendor-subagent-core.js --local /tmp/fake-core')
      && err.message.includes('正规升级通道')
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
