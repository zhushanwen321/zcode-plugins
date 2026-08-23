'use strict';

/**
 * WorkflowManager 测试（N2-a）：record 化 workflow 生命周期。
 *
 * 隔离原则（同 test/manager.test.js）：全 fake——内置 workflow 入口经构造
 * 注入 fake（不跑真 zcode、不碰真实 ~/.zcode）；record-store / output-store /
 * notifier-mailbox 走真实实现，路径全部来自 env，故 ZSW_ROOT /
 * ZCODE_MAILBOX_ROOT / HOME 必须在 require 任何 lib 之前指到临时目录。
 * script: 前缀用例走真实 workflow-script 发现层（脚本落临时 ws 目录，脚本
 * 本身不调 runAgent，不触 CLI）。
 *
 * 共享文件系统隔离：每测试独立 targetSessionId + buildManager 清空共享
 * records.jsonl（同 manager.test.js 的两级隔离）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-wfm-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsub-root');
process.env.ZCODE_MAILBOX_ROOT = path.join(TMP, 'mailbox');
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

// env 隔离完成后才允许 require lib（见文件头注释）
const { RecordStore } = require('../lib/record-store');
const outputs = require('../lib/output-store');
const { recordsPath } = require('../lib/config');
const { MailboxNotifier } = require('../lib/notifier-mailbox');
const {
  WorkflowManager, WORKFLOW_MAX_CONCURRENT, DEFAULT_WORKFLOW_TIMEOUT_MS,
} = require('../lib/workflow-manager');

/** 每测试独立会话 id：mailbox 目录与 envelope 计数按会话隔离。 */
let sessSeq = 0;
function ctx(cwd = TMP) {
  sessSeq += 1;
  return { targetSessionId: `sess_wfm_${sessSeq}`, cwd };
}

// ---------------------------------------------------------------- fakes

/** 造一个与内置入口统一返回结构一致的 ok 结果（buildMarkdownReport 可消费）。 */
function okResult(opts, workflow = 'chain') {
  const now = new Date().toISOString();
  return {
    ok: true, status: 'ok', workflow,
    task: opts.task, workdir: opts.workdir, model: opts.model || 'fake/model',
    phases: [{
      phase: 'analyze', label: '分析', ok: true, sessionId: 'sess_wfm_phase',
      usage: { input_tokens: 1, output_tokens: 2 }, timedOut: false, durationMs: 10,
      response: '阶段输出',
    }],
    final: '链式结论',
    startedAt: now, finishedAt: now,
  };
}

/** 挂住直到 signal abort 才返回 aborted 结果（abort/超时用例的入口形态）。 */
function hangingUntilAbort(opts) {
  return new Promise((resolve) => {
    const finish = () => {
      const now = new Date().toISOString();
      resolve({
        ok: false, status: 'aborted', abortedAtPhase: 'analyze',
        workflow: 'chain', task: opts.task, workdir: opts.workdir, model: 'fake/model',
        phases: [], final: null, error: '阶段 analyze（分析）被中止（aborted）',
        startedAt: now, finishedAt: now,
      });
    };
    if (opts.signal?.aborted) { finish(); return; }
    opts.signal?.addEventListener('abort', finish, { once: true });
  });
}

function buildManager(overrides = {}) {
  // 共享事件日志清零（见文件头「两级隔离」）；本测试的 store 实例内存本就独立
  fs.rmSync(recordsPath(), { force: true });
  const records = overrides.records || new RecordStore();
  const manager = new WorkflowManager({
    records,
    outputs,
    notifier: overrides.notifier || new MailboxNotifier(),
    workflows: overrides.workflows,
    slots: overrides.slots,
  });
  return { manager, records };
}

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立（容忍中间态异常）。 */
async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = fn();
      if (v) return v;
    } catch { /* 中间态：目录/文件尚未落位 */ }
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await sleep(10);
  }
}

/** 读取某会话 mailbox 下的全部已投递 envelope。 */
function readEnvelopes(sessionId) {
  const dir = path.join(process.env.ZCODE_MAILBOX_ROOT, sessionId, 'unread');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function envelopeCount(sessionId) {
  try {
    return readEnvelopes(sessionId).length;
  } catch {
    return 0;
  }
}

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// ------------------------------------------------------------------ tests

test('start(wait=false)：立即返回句柄，后台终态落盘 + 报告双段落盘 + mailbox 通知', async () => {
  const c = ctx();
  const entryCalls = [];
  const { manager, records } = buildManager({
    workflows: { chain: async (opts) => { entryCalls.push(opts); return okResult(opts); } },
  });
  const h = await manager.start(
    { workflow: 'chain', task: '审查 README 结构', workdir: TMP, model: 'GLM-5.3' },
    c,
  );
  assert.match(h.runId, /^wf-/);
  assert.equal(h.workflow, 'chain');
  assert.equal(h.status, 'running');
  assert.equal(h.notify, 'mailbox');
  assert.equal(h.guidance, undefined); // mailbox 档无轮询指引

  const rec = await waitFor(() => {
    const r = records.get(h.runId);
    return r && r.status === 'closed' && envelopeCount(c.targetSessionId) === 1 ? r : null;
  });
  assert.equal(rec.recordType, 'workflow');
  assert.equal(rec.workflow, 'chain');
  assert.equal(rec.closedReason, 'completed');
  assert.equal(rec.phaseCount, 1);
  assert.equal(rec.notified, true);
  assert.equal(rec.timeoutMs, DEFAULT_WORKFLOW_TIMEOUT_MS); // 缺省整体超时 30min

  // 报告落盘：markdown 人读段 + ```json 机器段（对齐 report.buildContentBlocks）
  const reportText = fs.readFileSync(rec.outputFile, 'utf8');
  assert.ok(reportText.includes('# zsw · chain 报告'));
  assert.ok(reportText.includes('## 最终结论'));
  assert.ok(reportText.includes('```json'));
  assert.ok(reportText.includes('"status": "ok"'));

  // 通知文案：任务书规定格式 + outputs 路径
  const env0 = readEnvelopes(c.targetSessionId)[0];
  assert.ok(env0.content.startsWith(`[workflow 完成] chain runId=${h.runId}。状态: closed。报告: `));
  assert.ok(env0.content.includes(rec.outputFile));

  // 入口接线：task/workdir/model 透传 + AbortSignal 实例
  assert.equal(entryCalls.length, 1);
  assert.equal(entryCalls[0].task, '审查 README 结构');
  assert.equal(entryCalls[0].workdir, TMP);
  assert.equal(entryCalls[0].model, 'GLM-5.3');
  assert.ok(entryCalls[0].signal instanceof AbortSignal);
});

test('start(wait=true)：阻塞到终态，返回报告全文（与落盘文件一致）', async () => {
  const entryCalls = [];
  const { manager } = buildManager({
    workflows: { parallel: async (opts) => { entryCalls.push(opts); return okResult(opts, 'parallel'); } },
  });
  const c = ctx();
  const out = await manager.start(
    { workflow: 'parallel', task: '多视角审查', workdir: TMP, wait: true, perspectives: ['security', 'perf'] },
    c,
  );
  assert.equal(out.status, 'closed');
  assert.ok(out.report.includes('# zsw · parallel 报告'));
  assert.ok(out.report.includes('```json'));
  assert.equal(out.error, null);
  assert.equal(fs.readFileSync(out.outputFile, 'utf8'), out.report); // 全文 = 落盘内容
  assert.equal(out.runId.startsWith('wf-'), true);
  // per-workflow 参数透传（perspectives 不进 STRIP 名单）
  assert.deepEqual(entryCalls[0].perspectives, ['security', 'perf']);
  assert.equal(envelopeCount(c.targetSessionId), 1); // wait=true 同样通知
});

test('abort 分支①（有句柄）：杀 signal → record cancelled，aborted 不通知', async () => {
  const c = ctx();
  const { manager, records } = buildManager({ workflows: { chain: hangingUntilAbort } });
  const h = await manager.start({ workflow: 'chain', task: '运行中中止', workdir: TMP }, c);
  await waitFor(() => records.get(h.runId).status === 'running');

  const r = await manager.abort(h.runId);
  assert.equal(r.aborted, true);
  assert.equal(r.status, 'cancelled'); // 响应与 record 终态一致（等 pending 落盘）
  const rec = records.get(h.runId);
  assert.equal(rec.status, 'cancelled');
  assert.equal(rec.closedReason, 'cancelled-by-user');
  await sleep(50); // 通知链已收尾（abort 内部已等 pending）
  assert.equal(envelopeCount(c.targetSessionId), 0); // cancelled 不通知（对齐 subagent）
  // aborted 的报告仍落盘（已完成阶段保留——本例 0 阶段，含失败原因段）
  const reportText = fs.readFileSync(rec.outputFile, 'utf8');
  assert.ok(reportText.includes('aborted'));
});

test('abort 分支③（无句柄·running）：直接终态化 + note（重启后句柄丢失语义）', async () => {
  const { manager, records } = buildManager();
  // 直接造 running record：模拟 server 重启后（日志有 running，内存无句柄）
  records.create({
    subagentId: 'wf-restart1', recordType: 'workflow', workflow: 'chain',
    task: 'x', workdir: TMP, timeoutMs: 1000,
  });
  records.transition('wf-restart1', 'created', 'running');

  const r = await manager.abort('wf-restart1');
  assert.equal(r.aborted, true);
  assert.equal(r.status, 'cancelled');
  assert.match(r.note, /句柄丢失（server 重启）/);
  assert.equal(records.get('wf-restart1').status, 'cancelled');
  // 已终态再 abort：幂等返回
  const again = await manager.abort('wf-restart1');
  assert.equal(again.aborted, false);
  assert.match(again.note, /已是终态/);
});

test('abort 分支②（无句柄·created 排队中）：直接终态化，执行体拿槽后不启动入口', async () => {
  let releaseGate;
  const gatedSlots = {
    acquire: () => new Promise((res) => { releaseGate = res; }),
  };
  const started = [];
  const { manager, records } = buildManager({
    slots: gatedSlots,
    workflows: { chain: async (opts) => { started.push(opts); return okResult(opts); } },
  });
  const h = await manager.start({ workflow: 'chain', task: '排队中止', workdir: TMP }, ctx());
  assert.equal(records.get(h.runId).status, 'created'); // 未拿到并发槽

  const r = await manager.abort(h.runId);
  assert.equal(r.aborted, true);
  assert.equal(r.status, 'cancelled');
  assert.match(r.note, /排队中被中止/);

  releaseGate(() => {}); // 放行执行体：应自查终态已定、不再调入口
  await sleep(50);
  assert.equal(started.length, 0);
  assert.equal(records.get(h.runId).status, 'cancelled'); // 终态不被覆盖
});

test('type 过滤：wf list 只见 workflow record；subagent record 不入列（反向查询拒绝）', async () => {
  const { manager, records } = buildManager({
    workflows: { chain: async (opts) => okResult(opts) },
  });
  // 共享 store 里先有两条 subagent record：旧形态（无 recordType）+ 显式标注
  records.create({ subagentId: 'sa-legacy', slug: 'old-task' });
  records.create({ subagentId: 'sa-new', slug: 'new-task', recordType: 'subagent' });

  await manager.start({ workflow: 'chain', task: '过滤验证', workdir: TMP, wait: true }, ctx());

  const lst = manager.list();
  assert.equal(lst.length, 1); // subagent record（两种形态）都不入 workflow list
  assert.match(lst[0].runId, /^wf-/);
  assert.equal(lst[0].workflow, 'chain');
  assert.equal(lst[0].status, 'closed');
  assert.equal(lst[0].endedAt !== null, true);

  // store 层语义不变：全部 record 仍可见（SubagentManager.list 兼容旧数据）
  assert.equal(records.list().length, 3);

  // 反向：subagent id 不能经 workflow 面查询（两种形态都拒绝）
  assert.throws(() => manager.status('sa-legacy'), /不是 workflow record/);
  assert.throws(() => manager.status('sa-new'), /不是 workflow record/);
  assert.throws(() => manager.status('wf-not-exist'), /不存在/);
});

test('recover：非终态 wf record 全标 lost + 注明（执行体无进程可探）；终态照抄；subagent 不碰', async () => {
  const { manager } = buildManager();
  const st = manager.records;
  // running 的 wf record（重启即死）；closed 的 wf record；subagent record
  st.create({ subagentId: 'wf-dead1', recordType: 'workflow', workflow: 'chain', task: 'x', workdir: TMP });
  st.transition('wf-dead1', 'created', 'running');
  st.create({ subagentId: 'wf-done1', recordType: 'workflow', workflow: 'chain', task: 'y', workdir: TMP });
  st.transition('wf-done1', 'created', 'running');
  st.transition('wf-done1', 'running', 'closed', { closedReason: 'completed' });
  st.create({ subagentId: 'sa-mix', slug: 'mix' });

  const r = await manager.recover();
  assert.deepEqual(r.lost, ['wf-dead1']);
  assert.equal(r.rebuild.records, 3);

  const dead = manager.status('wf-dead1');
  assert.equal(dead.status, 'lost');
  assert.match(dead.lostReason, /server 进程内/);
  assert.match(dead.lostReason, /重跑/);
  assert.equal(manager.status('wf-done1').status, 'closed'); // 终态不动

  // list 只含 wf record（lost 的也入列——用户需要看到挂账），subagent 不入
  const ids = manager.list().map((x) => x.runId).sort();
  assert.deepEqual(ids, ['wf-dead1', 'wf-done1']);
});

test('timeoutMs：整体超时 → abort 执行体 + record timeout + 通知（区别于用户 abort）', async () => {
  const c = ctx();
  const { manager, records } = buildManager({ workflows: { chain: hangingUntilAbort } });
  const h = await manager.start(
    { workflow: 'chain', task: '超时验证', workdir: TMP, timeoutMs: 150 },
    c,
  );
  const rec = await waitFor(() => {
    const r = records.get(h.runId);
    return r && r.status === 'timeout' ? r : null;
  });
  assert.equal(rec.closedReason, 'timeout');
  assert.match(rec.error, /整体超时/);
  // timeout 通知（仅 cancelled 不通知）：文案含终态与原因
  await waitFor(() => envelopeCount(c.targetSessionId) === 1);
  const content = readEnvelopes(c.targetSessionId)[0].content;
  assert.ok(content.includes(`[workflow 完成] chain runId=${h.runId}。状态: timeout。`));
  assert.ok(content.includes('原因:'));
  assert.ok(fs.existsSync(rec.outputFile)); // aborted 报告落盘（含已完成阶段）
});

test('script: 前缀：分发到真实 workflow-script 发现层，报告 = 脚本 markdown + json 围栏', async () => {
  // 脚本落 ws 的 .zsub/workflows（ctx.cwd = ws 触发真实四根发现）
  const ws = path.join(TMP, 'ws-script');
  fs.mkdirSync(path.join(ws, '.zsw', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.zsw', 'workflows', 'hello.js'), `'use strict';
module.exports = {
  name: 'hello', description: '测试脚本',
  run: async (c) => {
    c.log('脚本进度');
    return { markdown: 'hello: ' + c.task, json: { okFlag: true } };
  },
};`);
  const { manager, records } = buildManager();
  const c = ctx(ws);
  const out = await manager.start(
    { workflow: 'script:hello', task: '脚本分发验证', workdir: TMP, wait: true, customParam: 7 },
    c,
  );
  assert.equal(out.status, 'closed');
  assert.ok(out.report.includes('hello: 脚本分发验证'));
  assert.ok(out.report.includes('```json'));
  assert.ok(out.report.includes('"okFlag": true'));

  const rec = records.get(out.runId);
  assert.equal(rec.workflow, 'script:hello');
  assert.equal(rec.closedReason, 'completed');
  assert.equal(rec.workflowParams.customParam, 7); // per-workflow 参数快照入 record
  assert.deepEqual(rec.workflowParams, { customParam: 7 });
  assert.equal(rec.notified, true);
  assert.equal(envelopeCount(c.targetSessionId), 1);
  // ctx.log 进度留痕经 status() 暴露
  assert.ok(manager.status(out.runId).progress.some((l) => l.includes('脚本进度')));
});

test('参数校验：未知 workflow / task 缺失 / workdir 不存在 → 可操作错误且不建 record', async () => {
  const { manager, records } = buildManager();
  await assert.rejects(
    () => manager.start({ workflow: 'nope', task: 'x', workdir: TMP }, ctx()),
    (e) => /不支持的 workflow "nope"/.test(e.message) && e.message.includes('script:'),
  );
  await assert.rejects(
    () => manager.start({ workflow: 'script:ghost', task: 'x', workdir: TMP }, ctx()),
    /未找到 workflow 脚本 "ghost"/,
  );
  await assert.rejects(
    () => manager.start({ workflow: 'chain', task: '   ', workdir: TMP }, ctx()),
    /需要 task/,
  );
  await assert.rejects(
    () => manager.start({ workflow: 'chain', task: 'x', workdir: '/no/such/dir' }, ctx()),
    /workdir 不存在/,
  );
  await assert.rejects(
    () => manager.start({ workflow: 'chain', task: 'x', workdir: TMP }, { targetSessionId: 'sess_x' }),
    /需要 ctx\.cwd/,
  );
  assert.equal(records.list().length, 0); // fail fast：不产生孤儿 record
});

test('并发上限：默认池 limit=2，第三个 run 排队 created，槽释放后启动', async () => {
  assert.equal(WORKFLOW_MAX_CONCURRENT, 2);
  let finishAll;
  const gate = new Promise((res) => { finishAll = res; });
  let startedCount = 0;
  const { manager, records } = buildManager({
    workflows: { chain: (opts) => { startedCount += 1; return gate.then(() => okResult(opts)); } },
  });
  const hs = [];
  for (let i = 0; i < 3; i++) {
    hs.push(await manager.start({ workflow: 'chain', task: `t${i}`, workdir: TMP }, ctx()));
  }
  await waitFor(() => records.get(hs[0].runId).status === 'running'
    && records.get(hs[1].runId).status === 'running');
  assert.equal(startedCount, 2); // 只有两个入口被调
  assert.equal(records.get(hs[2].runId).status, 'created'); // 第三个在排队

  finishAll(); // 放行前两个 → 第三个拿槽启动并完成（gate 已 resolve）
  await waitFor(() => hs.every((h) => records.get(h.runId).status === 'closed'), 8000);
  assert.equal(startedCount, 3);
  assert.deepEqual(manager.list().map((x) => x.status), ['closed', 'closed', 'closed']);
});

// ------------------------------------------- 两级超时预算交互（per-phase vs 整体）

/** 模拟 chain 的 per-phase 超时产物形态（runPhase 超时：timedOut 条目 + failed）。 */
function perPhaseTimeoutResult(opts) {
  const now = new Date().toISOString();
  return {
    ok: false, status: 'failed', workflow: 'chain',
    task: opts.task, workdir: opts.workdir, model: opts.model || 'fake/model',
    phases: [{
      phase: 'analyze', label: '分析', ok: false, timedOut: true, durationMs: 60000,
      error: '阶段超时（timeoutMsPerPhase=60000ms）：60s 内未完成',
    }],
    final: null, error: '阶段 analyze（分析）超时',
    startedAt: now, finishedAt: now,
  };
}

test('timeoutMsPerPhase 先于整体 timeoutMs 触发 → timedOut 条目 + 终态 error（非 timeout）', async () => {
  const { manager } = buildManager({
    workflows: {
      chain: async (opts) => perPhaseTimeoutResult(opts),
    },
  });
  const c = ctx();
  // 整体预算 5s 远大于单阶段 60ms：只有 per-phase 先触发
  const fin = await manager.start(
    { workflow: 'chain', task: '单阶段超时', workdir: TMP, timeoutMs: 5000, timeoutMsPerPhase: 60, wait: true },
    c,
  );
  assert.equal(fin.status, 'error', 'per-phase 超时的终态是 error/failed，不是整体 timeout');
  const rec = manager.status(fin.runId);
  assert.equal(rec.status, 'error');
  assert.equal(rec.closedReason, 'failed');
  assert.match(rec.error, /阶段 analyze.*超时/);
  assert.ok(rec.outputFile);
  const report = fs.readFileSync(rec.outputFile, 'utf8');
  assert.match(report, /timedOut/); // 报告保留 timedOut 阶段条目（诊断依据）
});

test('整体 timeoutMs 在阶段间/阶段内计时触发（gap 不豁免）→ 终态 timeout', async () => {
  // 入口两段各 60ms，中间 idle 等 200ms——整体 300ms 在第二段前触发
  const { manager } = buildManager({
    workflows: {
      chain: (opts) => new Promise((resolve) => {
        const finish = () => resolve(perPhaseTimeoutResult(opts));
        if (opts.signal?.aborted) { finish(); return; }
        opts.signal?.addEventListener('abort', finish, { once: true });
        setTimeout(finish, 5000); // 挂住：只有整体超时或 abort 能唤醒
      }),
    },
  });
  const c = ctx();
  const fin = await manager.start(
    { workflow: 'chain', task: '整体预算先耗尽', workdir: TMP, timeoutMs: 200, timeoutMsPerPhase: 5000, wait: true },
    c,
  );
  assert.equal(fin.status, 'timeout', '整体预算先于 per-phase 触发 → timeout 终态');
  const rec = manager.status(fin.runId);
  assert.equal(rec.status, 'timeout');
  assert.equal(rec.closedReason, 'timeout');
  assert.match(rec.error, /整体超时/);
});
