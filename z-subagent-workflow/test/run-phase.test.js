'use strict';

/**
 * runPhase RunnerPort 单测（wave2 W1-b，fake runner 直测，不真跑引擎）。
 *
 * 覆盖六类（impl-plan W1-b 验收②）：
 * ① 三行范式（appserver/spawn 两 kind → start 收到 runEnv+prompt+cwd）
 * ② abort 双检查窗口两点（start 前已 aborted；prepareRunEnv await 期间 abort
 *    → 均不调 start）
 * ③ 运行中 abort → handle.cancel 被调 + aborted 条目
 * ④ channel 字段两通道如实（D4）
 * ⑤ 全终态调 release（成功/失败/超时/中止四态各一）
 * ⑥ release 不存在（fake 无 release 方法）不炸
 *
 * 隔离原则（同 test/workflow-base.test.js）：禁止真跑 zcode、禁止碰真实
 * ~/.zcode。prepareRunEnv 经原型 patch 可控化（真实 bootstrap 写盘与此处的
 * 协议测试无关，patch 同时提供确定性的 await 窗口供②注入 abort）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-runphase-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsub-root');
process.env.ZCODE_MAILBOX_ROOT = path.join(TMP, 'mailbox');
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

// env 隔离完成后才允许 require lib（见文件头注释）
const ModelRouter = require('../lib/model-router');
const { runPhase } = require('../lib/workflow/run-phase');
const phases = require('../lib/workflow/phases');

const MODEL_REF = 'builtin:bigmodel-coding-plan/GLM-4.7-Flash';
const CWD = path.join(TMP, 'work');

// ---- prepareRunEnv 可控化：记录调用 + 制造确定性 await 窗口 ----
// 窗口时长（20ms）：测试②b 在 5ms 时 abort，必落在窗口内 → 复查点兜住
const PREPARE_DELAY_MS = 20;
const prepareCalls = []; // 每次调用的 [modelRef, kind]
const origPrepareRunEnv = ModelRouter.prototype.prepareRunEnv;
ModelRouter.prototype.prepareRunEnv = async function patched(modelRef, kind) {
  prepareCalls.push([modelRef, kind]);
  await new Promise((r) => setTimeout(r, PREPARE_DELAY_MS));
  if (kind === 'appserver') {
    return { createParams: { model: { providerId: 'builtin:bigmodel-coding-plan', modelId: 'GLM-4.7-Flash' } } };
  }
  return { env: { HOME: path.join(TMP, 'home-pool'), ZSW_NESTED: '1' } };
};
after(() => { ModelRouter.prototype.prepareRunEnv = origPrepareRunEnv; });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 可编程 fake runner。results 逐次消费 start 的脚本：
 *   - {status, ...} 直接作为 done 的 RunResult 落定；
 *   - {holdUntilCancel: true, result} → done 挂起直到 handle.cancel 被调，
 *     届时以 result 落定（运行中中止场景）。
 * exec.kind 按 capabilities().kind 给出（'apc'|'spawn'，RunHandle 契约）。
 */
function makeFakeRunner({ kind = 'appserver', results = [], withRelease = true } = {}) {
  const calls = { start: [], cancel: 0, release: [] };
  const runner = {
    capabilities() {
      return { kind, steering: 'none', coldStartMs: 0 };
    },
    start(taskCtx) {
      calls.start.push(taskCtx);
      const scripted = results.length > 0 ? results.shift() : { status: 'closed', response: 'ok' };
      const exec = { kind: kind === 'appserver' ? 'apc' : 'spawn', sessionId: undefined };
      let done;
      if (scripted.holdUntilCancel) {
        done = new Promise((resolve) => {
          exec._resolveOnCancel = resolve; // cancel 时经句柄落定
        });
      } else {
        done = Promise.resolve(scripted);
      }
      const handle = {
        exec,
        cancel: () => {
          calls.cancel++;
          if (scripted.holdUntilCancel) exec._resolveOnCancel(scripted.result);
        },
        done,
      };
      return handle;
    },
  };
  if (withRelease) runner.release = (exec) => { calls.release.push(exec); };
  return { runner, calls };
}

/** 轮询等 start 被调（runPhase 的 prepareRunEnv 窗口后才会调）。 */
async function waitForStart(calls) {
  for (let i = 0; i < 200 && calls.start.length === 0; i++) await sleep(1);
  assert.ok(calls.start.length > 0, 'fake runner.start 未被调用（超时）');
}

// ── ① 三行范式 ──────────────────────────────────────────────────────

test('三行范式：appserver kind → prepareRunEnv(modelRef, appserver)，start 收到 createParams 形态 runEnv + prompt + cwd', async () => {
  const { runner, calls } = makeFakeRunner({
    kind: 'appserver',
    results: [{ status: 'closed', response: 'resp', sessionId: 'sess_a1', usage: { input_tokens: 2, output_tokens: 3 } }],
  });
  const entry = await runPhase({ prompt: 'p1', cwd: CWD, modelRef: MODEL_REF, timeoutMs: 1234, runner });
  assert.deepEqual(prepareCalls[prepareCalls.length - 1], [MODEL_REF, 'appserver']);
  assert.equal(calls.start.length, 1);
  const taskCtx = calls.start[0];
  assert.equal(taskCtx.prompt, 'p1');
  assert.equal(taskCtx.cwd, CWD);
  assert.equal(taskCtx.modelRef, MODEL_REF);
  assert.equal(taskCtx.timeoutMs, 1234);
  assert.deepEqual(
    taskCtx.runEnv.createParams,
    { model: { providerId: 'builtin:bigmodel-coding-plan', modelId: 'GLM-4.7-Flash' } },
  );
  assert.equal(entry.ok, true);
  assert.equal(entry.sessionId, 'sess_a1');
});

test('三行范式：spawn kind → prepareRunEnv(modelRef, spawn)，start 收到 env 形态 runEnv（HOME 可取）', async () => {
  const { runner, calls } = makeFakeRunner({
    kind: 'spawn',
    results: [{ status: 'closed', response: 'resp', sessionId: 'sess_s1' }],
  });
  await runPhase({ prompt: 'p2', cwd: CWD, modelRef: MODEL_REF, runner });
  assert.deepEqual(prepareCalls[prepareCalls.length - 1], [MODEL_REF, 'spawn']);
  const taskCtx = calls.start[0];
  assert.equal(taskCtx.prompt, 'p2');
  assert.equal(taskCtx.cwd, CWD);
  assert.equal(typeof taskCtx.runEnv.env.HOME, 'string');
  assert.ok(taskCtx.runEnv.env.HOME.length > 0);
});

// ── ② abort 双检查窗口两点 ──────────────────────────────────────────

test('双检查窗口点 1：调用前已 aborted → 不做环境准备、不调 start，返回预置 aborted 条目', async () => {
  const { runner, calls } = makeFakeRunner({ kind: 'appserver' });
  const ctl = new AbortController();
  ctl.abort();
  const prepareBefore = prepareCalls.length;
  const entry = await runPhase({ prompt: 'p', cwd: CWD, modelRef: MODEL_REF, signal: ctl.signal, runner });
  assert.equal(prepareCalls.length, prepareBefore);
  assert.equal(calls.start.length, 0);
  assert.equal(entry.ok, false);
  assert.equal(entry.aborted, true);
  assert.equal(entry.error, 'aborted');
  assert.equal(entry.channel, 'appserver'); // 预置条目同样如实标注通道（D4）
});

test('双检查窗口点 2：prepareRunEnv await 期间 abort → start 前复查兜住，不调 start', async () => {
  const { runner, calls } = makeFakeRunner({ kind: 'appserver' });
  const ctl = new AbortController();
  const prepareBefore = prepareCalls.length;
  const p = runPhase({ prompt: 'p', cwd: CWD, modelRef: MODEL_REF, signal: ctl.signal, runner });
  // prepareRunEnv 窗口（20ms）内到达的 abort：事件已触发、无第二次事件，
  // 只能靠 start 前复查点拦截（D1 保留义务）
  setTimeout(() => ctl.abort(), 5);
  const entry = await p;
  assert.equal(prepareCalls.length, prepareBefore + 1); // 环境准备已做（不可回退）
  assert.equal(calls.start.length, 0); // 但阶段未启动
  assert.equal(entry.aborted, true);
  assert.equal(entry.channel, 'appserver');
});

// ── ③ 运行中 abort ─────────────────────────────────────────────────

test('运行中 abort → handle.cancel 被调，done 以 cancelled 落定后映射 aborted 条目', async () => {
  const { runner, calls } = makeFakeRunner({
    kind: 'appserver',
    results: [{ holdUntilCancel: true, result: { status: 'cancelled', response: 'partial output' } }],
  });
  const ctl = new AbortController();
  const p = runPhase({ prompt: 'p', cwd: CWD, modelRef: MODEL_REF, signal: ctl.signal, runner });
  await waitForStart(calls); // 先确保已过双检查窗口、handle 已产生
  ctl.abort();
  const entry = await p;
  assert.equal(calls.cancel, 1);
  assert.equal(entry.ok, false);
  assert.equal(entry.aborted, true);
  assert.equal(entry.response, 'partial output');
  assert.equal(entry.channel, 'appserver');
});

// ── ④ channel 字段两通道如实 ────────────────────────────────────────

test('channel 字段两通道如实：appserver 条目标 appserver、spawn 条目标 spawn', async () => {
  const apc = makeFakeRunner({ kind: 'appserver', results: [{ status: 'closed', response: 'r' }] });
  const entryApc = await runPhase({ prompt: 'p', cwd: CWD, modelRef: MODEL_REF, runner: apc.runner });
  assert.equal(entryApc.channel, 'appserver');

  const spawn = makeFakeRunner({ kind: 'spawn', results: [{ status: 'closed', response: 'r' }] });
  const entrySpawn = await runPhase({ prompt: 'p', cwd: CWD, modelRef: MODEL_REF, runner: spawn.runner });
  assert.equal(entrySpawn.channel, 'spawn');

  // 失败条目同样携带（所有返回条目统一标注）
  const fail = makeFakeRunner({ kind: 'spawn', results: [{ status: 'error', error: 'boom' }] });
  const entryFail = await runPhase({ prompt: 'p', cwd: CWD, modelRef: MODEL_REF, runner: fail.runner });
  assert.equal(entryFail.ok, false);
  assert.equal(entryFail.channel, 'spawn');
});

// ── ⑤ 全终态调 release（成功/失败/超时/中止四态各一）────────────────

test('全终态调 release：closed/error/timeout/aborted 四态均以 handle.exec 调用且仅一次', async () => {
  const cases = [
    { name: 'closed', results: [{ status: 'closed', response: 'r', sessionId: 'sess_1' }], check: (e) => assert.equal(e.ok, true) },
    { name: 'error', results: [{ status: 'error', error: 'engine gone' }], check: (e) => assert.equal(e.ok, false) },
    { name: 'timeout', results: [{ status: 'timeout', response: 'partial' }], check: (e) => assert.equal(e.timedOut, true) },
  ];
  for (const c of cases) {
    const { runner, calls } = makeFakeRunner({ kind: 'appserver', results: c.results });
    const entry = await runPhase({ prompt: 'p', cwd: CWD, modelRef: MODEL_REF, runner });
    c.check(entry);
    assert.equal(calls.release.length, 1, `终态 ${c.name} 应调 release 一次`);
  }
  // 中止态：cancel → done 落定 → release 照常（early 终态也释放）
  const abortCase = makeFakeRunner({
    kind: 'appserver',
    results: [{ holdUntilCancel: true, result: { status: 'cancelled' } }],
  });
  const ctl = new AbortController();
  const p = runPhase({ prompt: 'p', cwd: CWD, modelRef: MODEL_REF, signal: ctl.signal, runner: abortCase.runner });
  await waitForStart(abortCase.calls);
  ctl.abort();
  const entry = await p;
  assert.equal(entry.aborted, true);
  assert.equal(abortCase.calls.release.length, 1, '终态 aborted 应调 release 一次');
});

// ── ⑥ release 不存在不炸 ────────────────────────────────────────────

test('release 不存在（fake 无 release 方法）→ 可选调用不炸，条目正常返回', async () => {
  const { runner, calls } = makeFakeRunner({
    kind: 'appserver',
    results: [{ status: 'closed', response: 'r', sessionId: 'sess_x' }],
    withRelease: false,
  });
  assert.equal(runner.release, undefined);
  const entry = await runPhase({ prompt: 'p', cwd: CWD, modelRef: MODEL_REF, runner });
  assert.equal(entry.ok, true);
  assert.equal(entry.sessionId, 'sess_x');
  assert.equal(entry.channel, 'appserver');
  assert.equal(calls.start.length, 1);
});

// ── 附：phases 包装层透传 runner + channel 上浮（B 改动的直测）───────

test('phases.runPhase 透传 runner 给 execPhase，并把 result.channel 带上条目', async () => {
  const { runner, calls } = makeFakeRunner({
    kind: 'appserver',
    results: [{ status: 'closed', response: 'r', sessionId: 'sess_p' }],
  });
  const entry = await phases.runPhase({ name: 'analyze', label: '分析', prompt: 'p', cwd: CWD, modelRef: MODEL_REF, runner });
  assert.equal(calls.start.length, 1); // runner 真被透传到了执行落点
  assert.equal(entry.channel, 'appserver');
  assert.equal(entry.phase, 'analyze');
  assert.equal(entry.ok, true);
});
