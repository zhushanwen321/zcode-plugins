'use strict';

/**
 * workflow 线 apc 主链路测试（wave2 W1-c）：fake runner 驱动 runChain 走全链，
 * 钉住「真实入口经注入走常驻 app-server 通道」的翻转面（impl-plan W1-c 验收②；
 * spawn 缺省回退面由 workflow-base/workflow-a 的 channel:'spawn' 断言钉住，
 * 与本文件构成 B-9 两臂的离线对照）。
 *
 * 覆盖五类（任务书 A）：
 * ① 阶段条目 channel:'appserver'（chain 全部阶段）
 * ② runner.start 收到 {prompt, cwd, modelRef, runEnv, timeoutMs}（D1 三行范式
 *    的 taskCtx 契约；runEnv 为 appserver 形态 {createParams}）
 * ③ 各阶段 done 后 release 被调（D2 全终态释放，成功态）
 * ④ 运行中 abort → handle.cancel 被调 + 后续阶段不启动（编排层契约 2/3）
 * ⑤ 降级翻转形态：首阶段 capabilities kind 'appserver'、次阶段起翻转为 'spawn'
 *   （模拟 probe 失效后的通道级降级，D4 阶段级重读）——两阶段 channel 各自如实，
 *    且第二阶段 runEnv 按新通道备成 spawn 形态 {env}
 *
 * fake runner 形态复用 test/run-phase.test.js 的 W1-b 惯例（start 可编程结果、
 * holdUntilCancel、release 记录），本文件只加两点：capabilities 按调用序消费
 * kind 序列（run-phase 每阶段恰读一次，序列位置即阶段通道），以及 start 侧
 * exec.kind 随当前 kind 生成（真实 AppServerRunner/SpawnRunner 同构）。
 *
 * 隔离原则（同 test/workflow-base.test.js）：禁止真跑 zcode、禁止碰真实 ~/.zcode。
 * env 四件套必须在 require 任何 lib 之前设置（config.js 模块加载期冻结路径）；
 * ZSW_ZCODE_CLI 设为不存在的路径——本文件全部用例注入 runner，driver 永不应被
 * 调，若意外落回缺省直调路径会让阶段失败而不是静默走真实 CLI。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-wfapc-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsub-root');
process.env.ZCODE_MAILBOX_ROOT = path.join(TMP, 'mailbox');
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
// 防意外落回缺省直调路径时触真实 zcode（注入 runner 的用例永远碰不到它）
process.env.ZSW_ZCODE_CLI = path.join(TMP, 'no-such-zcode.cjs');

// ---- prepareRunEnv 可控化：两通道各备各的环境（真实 ModelRouter 同构）----
const ModelRouter = require('../lib/model-router');
const origPrepareRunEnv = ModelRouter.prototype.prepareRunEnv;
ModelRouter.prototype.prepareRunEnv = async function patched(modelRef, kind) {
  if (kind === 'appserver') {
    return { createParams: { model: { providerId: 'builtin:bigmodel-coding-plan', modelId: 'GLM-4.7-Flash' } } };
  }
  return { env: { HOME: path.join(TMP, 'home-pool'), ZSW_NESTED: '1' } };
};
after(() => { ModelRouter.prototype.prepareRunEnv = origPrepareRunEnv; });

// env 隔离完成后才允许 require lib（见文件头注释）
const config = require('../lib/config');
const { runChain } = require('../lib/workflow/chain');

const MODEL_REF = 'builtin:bigmodel-coding-plan/GLM-4.7-Flash';
const WORKDIR = path.join(TMP, 'work');

/** 写入测试用 v2 config（chain 入口 ModelRouter.resolve 的数据源）。 */
function writeV2Config() {
  const base = {
    model: { main: 'builtin:bigmodel-coding-plan/GLM-5.3' },
    provider: {
      'builtin:bigmodel-coding-plan': {
        options: { apiKey: 'test-key' },
        models: { 'GLM-5.3': {}, 'GLM-4.7-Flash': {} },
      },
    },
  };
  fs.mkdirSync(path.dirname(config.V2_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(config.V2_CONFIG_PATH, JSON.stringify(base, null, 2));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 轮询等 start 被调（runPhase 的 prepareRunEnv await 窗口后才调）。 */
async function waitForStart(calls) {
  for (let i = 0; i < 200 && calls.start.length === 0; i++) await sleep(1);
  assert.ok(calls.start.length > 0, 'fake runner.start 未被调用（超时）');
}

/**
 * 可编程 fake runner（W1-c 主链路版）。
 * @param {string|string[]} kindSequence 每阶段通道（capabilities() 按调用序消费，
 *   末位持续——run-phase 每阶段恰读一次 capabilities，序列位置即阶段通道）；
 *   传字符串 = 全阶段同通道
 * @param {object[]} results 逐次消费的 start 脚本：{status,...} 直接作为 done 的
 *   RunResult；{holdUntilCancel:true, result} → done 挂起直到 handle.cancel 被调
 */
function makeFakeRunner({ kindSequence = 'appserver', results = [] } = {}) {
  const seq = Array.isArray(kindSequence) ? kindSequence : [kindSequence];
  const calls = { start: [], cancel: 0, release: [] };
  let capIdx = 0;
  let currentKind = null; // capabilities 与 start 一一交替，start 复读最近通道
  const runner = {
    capabilities() {
      const kind = seq[Math.min(capIdx, seq.length - 1)];
      capIdx += 1;
      currentKind = kind;
      return { kind, steering: 'none', coldStartMs: 0 };
    },
    start(taskCtx) {
      calls.start.push(taskCtx);
      const scripted = results.length > 0 ? results.shift() : { status: 'closed', response: 'resp' };
      const exec = { kind: currentKind === 'appserver' ? 'apc' : 'spawn', sessionId: undefined };
      let done;
      if (scripted.holdUntilCancel) {
        done = new Promise((resolve) => {
          exec._resolveOnCancel = resolve; // cancel 时经句柄落定
        });
      } else {
        // sessionId 回填进 exec（真实 AppServerRunner 的 done 落定路径同构），
        // 使 release 收到的 exec 可断言通道与登记形态
        exec.sessionId = scripted.sessionId;
        done = Promise.resolve(scripted);
      }
      return {
        exec,
        cancel: () => {
          calls.cancel += 1;
          if (scripted.holdUntilCancel) exec._resolveOnCancel(scripted.result);
        },
        done,
      };
    },
  };
  runner.release = (exec) => { calls.release.push(exec); };
  return { runner, calls };
}

// ── ①+②+③ 全成功主链路：通道标注 / taskCtx 契约 / 全终态释放 ─────────

test('runChain 注入 fake runner：三阶段条目 channel=appserver，start 收到 D1 taskCtx 契约，各阶段 done 后 release 被调', async () => {
  writeV2Config();
  const { runner, calls } = makeFakeRunner({
    kindSequence: 'appserver',
    results: [
      { status: 'closed', response: '分析结论', sessionId: 'sess_apc_1' },
      { status: 'closed', response: '实现结果', sessionId: 'sess_apc_2' },
      { status: 'closed', response: '最终报告', sessionId: 'sess_apc_3' },
    ],
  });
  const result = await runChain({
    task: 'apc 主链路验证任务', workdir: WORKDIR, model: 'GLM-4.7-Flash',
    timeoutMsPerPhase: 5000, runner,
  });

  // ① 阶段条目 channel:'appserver'（三阶段全部，B-1 口径值域）
  assert.equal(result.status, 'ok');
  assert.equal(result.phases.length, 3);
  for (const p of result.phases) {
    assert.equal(p.channel, 'appserver', `阶段 ${p.phase} 条目应标 appserver 通道`);
    assert.equal(p.ok, true);
  }
  // sessionId 透传（apc 会话形态字段直达条目）
  assert.deepEqual(result.phases.map((p) => p.sessionId), ['sess_apc_1', 'sess_apc_2', 'sess_apc_3']);

  // ② start 收到 {prompt, cwd, modelRef, runEnv, timeoutMs}——逐阶段形态
  assert.equal(calls.start.length, 3);
  const promptMarks = ['第 1 步：分析者', '第 2 步：实现者', '第 3 步：总结者'];
  calls.start.forEach((taskCtx, i) => {
    assert.ok(taskCtx.prompt.includes(promptMarks[i]), `阶段 ${i} prompt 应为 chain 对应阶段任务书`);
    assert.equal(taskCtx.cwd, WORKDIR);
    assert.equal(taskCtx.modelRef, MODEL_REF);
    assert.equal(taskCtx.timeoutMs, 5000);
    // appserver 通道的 runEnv 是 createParams 形态（prepareRunEnv(modelRef,'appserver') 产物）
    assert.deepEqual(
      taskCtx.runEnv.createParams,
      { model: { providerId: 'builtin:bigmodel-coding-plan', modelId: 'GLM-4.7-Flash' } },
    );
  });

  // ③ 各阶段 done 后 release 被调（成功三阶段各一次），exec 为 apc 形态且带 sessionId
  assert.equal(calls.release.length, 3);
  assert.deepEqual(calls.release.map((e) => e.kind), ['apc', 'apc', 'apc']);
  assert.deepEqual(calls.release.map((e) => e.sessionId), ['sess_apc_1', 'sess_apc_2', 'sess_apc_3']);
});

// ── ④ 运行中 abort：handle.cancel 被调 + 后续阶段不启动 ──────────────

test('runChain 注入 fake runner：运行中 abort → handle.cancel 被调，后续阶段不启动，报告 status=aborted', async () => {
  writeV2Config();
  const { runner, calls } = makeFakeRunner({
    kindSequence: 'appserver',
    results: [{ holdUntilCancel: true, result: { status: 'cancelled', response: 'partial output' } }],
  });
  const ctl = new AbortController();
  const p = runChain({
    task: 'apc 运行中中止验证', workdir: WORKDIR, model: 'GLM-4.7-Flash',
    timeoutMsPerPhase: 20000, signal: ctl.signal, runner,
  });
  await waitForStart(calls); // 先确保已过双检查窗口、analyze 句柄已产生
  ctl.abort();
  const result = await p;

  // cancel 走 RunnerPort（handle.cancel），不是 driver 杀进程链
  assert.equal(calls.cancel, 1);
  // 编排层契约：analyze aborted 后 transform/synthesize 不启动
  assert.equal(result.status, 'aborted');
  assert.equal(result.abortedAtPhase, 'analyze');
  assert.equal(result.phases.length, 1);
  assert.equal(result.phases[0].aborted, true);
  assert.equal(result.phases[0].ok, false);
  assert.equal(result.phases[0].channel, 'appserver'); // 中止条目同样如实标注通道
  assert.equal(result.final, null);
  assert.equal(calls.start.length, 1); // 后续阶段未产生任何 start
  // aborted 也是终态：release 照常发出（D2 全终态释放）
  assert.equal(calls.release.length, 1);
});

// ── ⑤ 降级翻转形态：阶段级 kind 重读，两通道各自如实（D4/B-9①对照）──

test('runChain 注入 fake runner：首阶段 appserver 次阶段 kind 翻转 spawn → 条目 channel 各自如实，后续阶段按新通道备 runEnv', async () => {
  writeV2Config();
  const { runner, calls } = makeFakeRunner({
    // 序列末位持续：probe 降级翻转后（capabilities().kind 变 spawn），后续全部
    // 阶段走 spawn 备环境——模拟 wrapWithProbeInvalidation 的通道级降级
    kindSequence: ['appserver', 'spawn'],
    results: [
      { status: 'closed', response: '分析结论', sessionId: 'sess_mix_1' },
      { status: 'closed', response: '实现结果', sessionId: 'sess_mix_2' },
      { status: 'closed', response: '最终报告', sessionId: 'sess_mix_3' },
    ],
  });
  const result = await runChain({
    task: '降级翻转验证任务', workdir: WORKDIR, model: 'GLM-4.7-Flash',
    timeoutMsPerPhase: 5000, runner,
  });

  assert.equal(result.status, 'ok');
  // 通道逐阶段如实：首阶段 appserver、降级翻转后 spawn
  assert.deepEqual(
    result.phases.map((p) => p.channel),
    ['appserver', 'spawn', 'spawn'],
  );
  // 各阶段 runEnv 按当次通道备：第一阶段 createParams、翻转后 env 形态
  assert.ok(calls.start[0].runEnv.createParams, '首阶段应备 appserver 形态 runEnv');
  assert.equal(calls.start[1].runEnv.env.HOME.length > 0, true, '翻转后阶段应备 spawn 形态 runEnv');
  assert.equal(calls.start[1].runEnv.env.ZSW_NESTED, '1');
  assert.equal(calls.start[2].runEnv.env.ZSW_NESTED, '1');
  // release 按 exec.kind 路由（包装层转发契约的同构断言面）
  assert.deepEqual(calls.release.map((e) => e.kind), ['apc', 'spawn', 'spawn']);
});
