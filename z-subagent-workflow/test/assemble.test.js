'use strict';

/**
 * assemble 组装测试（回接 2c 后）：组装期探针门控 / 探针落盘缓存 / 降级链 / 升级
 * 检测面已随 appserver 通道退役整体删除（原 ~580 行测试同步退役，漂移检测
 * 改由 core 引擎探针承担）。本文件覆盖新装配契约：
 * - 组装产物：SubagentManager + orchestration host 共享同一 runner
 * - runner 恒为 CoreRunner（core zcode engine 适配——engine 内部缺省 appserver
 *   常驻 + spawn 降级，宿主开关只剩 ZSW_RUNNER 校验）
 * - ZSW_RUNNER 语义：'appserver' 显式废弃报错 / 'spawn' 兼容 no-op（告警一次）/
 *   未知值报错 / opts.runner 注入接管
 * - W6a2 退出链组合：真实 wfHost.shutdown 串接 runner.shutdown（daemon 退出面
 *   的进程收割）；注入 fake wfHost 不包装
 *
 * 隔离原则：ZSW_ROOT / HOME 指临时目录，env 必须先于 require 设置。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-asm-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsub-root');
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
delete process.env.ZSW_RUNNER;

const { assembleManager, assertRunnerEnv } = require('../lib/assemble');
const CoreRunner = require('../lib/runner-core');

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

test('组装产物含 orchestration host（回接 2b）：action 面在场，runnerKind=spawn', async () => {
  const a = await assembleManager();
  assert.ok(a.wfHost, 'assembleManager 产物应含 wfHost（lib/orchestration-host）');
  for (const method of ['run', 'runAndWait', 'abort', 'status', 'list', 'scripts', 'lint', 'recoverOrphans', 'shutdown']) {
    assert.equal(typeof a.wfHost[method], 'function', `wfHost 缺 ${method}`);
  }
  // zsub 线不因 workflow 线换核而漂移：manager 面照旧
  assert.equal(typeof a.manager.start, 'function');
  assert.equal(a.runnerKind, 'spawn', '2c 后唯一通道 = core zcode engine spawn 单轮');
});

test('组装 runner 恒为 CoreRunner（core zcode engine 适配），端口面完备', async () => {
  const { manager } = await assembleManager();
  const runner = manager.runner;
  assert.ok(runner instanceof CoreRunner, 'runner 是 CoreRunner 实例');
  assert.equal(runner.capabilities().kind, 'spawn', 'capabilities().kind 恒 spawn（台账标注兼容）');
  for (const method of ['start', 'resume', 'alive', 'release', 'probe', 'capabilities']) {
    assert.equal(typeof runner[method], 'function', `runner.${method} 在场`);
  }
});

test('CoreRunner 构造幂等登记 core registry（registerZcodeEngine 覆盖语义幂等，重复组装不炸）', async () => {
  await assert.doesNotReject(() => assembleManager());
  await assert.doesNotReject(() => assembleManager());
  // ensureZcodeEngineRegistered 幂等标记：重复调用零副作用
  assert.doesNotThrow(() => CoreRunner.ensureZcodeEngineRegistered());
});

test('ZSW_RUNNER=appserver：显式废弃报错（信息含退役说明与引擎模式定向指引）', async () => {
  process.env.ZSW_RUNNER = 'appserver';
  try {
    await assert.rejects(
      () => assembleManager(),
      (err) => {
        assert.match(err.message, /D6-⑥ 退役/);
        assert.match(err.message, /core zcode engine/);
        assert.match(err.message, /XYZ_ZCODE_MODE=spawn/);
        assert.match(err.message, /P3/);
        return true;
      },
    );
    // env 校验入口独立可测（组装前同样消费）
    assert.throws(() => assertRunnerEnv(), /D6-⑥ 退役/);
  } finally {
    delete process.env.ZSW_RUNNER;
  }
});

test('ZSW_RUNNER=spawn：兼容 no-op（组装成功 + 告警一次，不重复刷屏）', async () => {
  process.env.ZSW_RUNNER = 'spawn';
  let stderr = '';
  const origWrite = process.stderr.write;
  process.stderr.write = (s) => { stderr += String(s); return true; };
  try {
    const { manager } = await assembleManager();
    assert.ok(manager.runner instanceof CoreRunner, 'spawn 值被忽略，仍组装 CoreRunner');
    await assembleManager(); // 第二次组装：告警只一次
    const warns = stderr.split('\n').filter((l) => l.includes('ZSW_RUNNER=spawn 已无独立通道'));
    assert.equal(warns.length, 1, '兼容告警恰好一次');
  } finally {
    process.stderr.write = origWrite;
    delete process.env.ZSW_RUNNER;
  }
});

test('ZSW_RUNNER 未知值：前置报错（比静默走缺省更可操作）', async () => {
  process.env.ZSW_RUNNER = 'core';
  try {
    await assert.rejects(
      () => assembleManager(),
      (err) => {
        assert.match(err.message, /ZSW_RUNNER="core"/);
        assert.match(err.message, /恢复指引/);
        return true;
      },
    );
  } finally {
    delete process.env.ZSW_RUNNER;
  }
});

test('显式 opts.runner 注入 → 注入即接管（测试组装面不触达 CoreRunner）', async () => {
  const fake = {
    capabilities: () => ({ kind: 'fake', steering: 'none', coldStartMs: 0 }),
    start() { throw new Error('not started in this test'); },
  };
  const { manager } = await assembleManager({ runner: fake });
  assert.equal(manager.runner, fake, '注入 runner 直接接管');
});

// ------------------------------- W6a2：退出链组合（daemon shutdown 收割面）

test('退出链组合：真实 wfHost.shutdown 串接 runner.shutdown（appserver 常驻 dispose 进 daemon 退出面）', async () => {
  const calls = [];
  const runnerSpy = {
    capabilities: () => ({ kind: 'fake', steering: 'none', coldStartMs: 0 }),
    start() { throw new Error('not started in this test'); },
    async shutdown() { calls.push('runner'); },
  };
  const a = await assembleManager({ runner: runnerSpy }); // 真实 wfHost（不注入）
  await a.wfHost.shutdown();
  assert.deepEqual(calls, ['runner'], 'wfHost.shutdown 触发后必须串接 runner.shutdown（进程收割）');
});

test('退出链组合：注入 fake wfHost 不包装——shutdown 语义保持组装面跳过', async () => {
  const calls = [];
  const fakeWf = { run() {}, shutdown: async () => { calls.push('wf'); } };
  const runnerSpy = {
    capabilities: () => ({ kind: 'fake', steering: 'none', coldStartMs: 0 }),
    start() { throw new Error('not started in this test'); },
    async shutdown() { calls.push('runner'); },
  };
  const a = await assembleManager({ wfHost: fakeWf, runner: runnerSpy });
  assert.equal(a.wfHost, fakeWf, '注入 wfHost 原样透传（不包装）');
  await a.wfHost.shutdown();
  assert.deepEqual(calls, ['wf'], '注入面不串接 runner.shutdown（组合仅作用于真实组装）');
});
