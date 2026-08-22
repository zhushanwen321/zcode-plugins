'use strict';

/**
 * SubagentManager 编排内核测试（W2-S4）。
 *
 * 隔离原则：全 fake——不跑真 zcode、不碰真实 ~/.zcode。
 * runner/model-router/resolver/slots/worktree 全 fake；record-store /
 * output-store / notifier-mailbox 走真实实现（W1 已测，这里测的是接线），
 * 其路径全部来自 env，故 ZSUB_ROOT / ZCODE_MAILBOX_ROOT / HOME 必须在
 * require 任何 lib 之前指到临时目录。
 *
 * 进程内共享文件系统的两级隔离：每个测试独立 targetSessionId（mailbox
 * 目录互不可见）；buildManager 每次清空共享 records.jsonl（RecordStore
 * 实例内存独立，但事件日志落同一 ZSUB_ROOT 文件，不清会让 recover 的
 * rebuild 读到前序测试事件）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-mgr-'));
process.env.ZSUB_ROOT = path.join(TMP, 'zsub-root');
process.env.ZCODE_MAILBOX_ROOT = path.join(TMP, 'mailbox');
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

// env 隔离完成后才允许 require lib（见文件头注释）
const { RecordStore } = require('../lib/record-store');
const outputs = require('../lib/output-store');
const { recordsPath } = require('../lib/config');
const { MailboxNotifier, PollingNotifier } = require('../lib/notifier-mailbox');
const { SubagentManager } = require('../lib/manager');

/** 每测试独立会话 id：mailbox 目录与 envelope 计数按会话隔离。 */
let sessSeq = 0;
function ctx() {
  sessSeq += 1;
  return { targetSessionId: `sess_mgr_${sessSeq}`, cwd: TMP };
}

// ---------------------------------------------------------------- fakes

/**
 * 内存 FakeRunner：start 注册待决议 waiter（测试用 finish/finishAll 注入
 * 延迟完成/失败/超时/取消），resume 立即闭环；alive 由 livePids 决定
 * （预置 process.pid 供 recover 测试探活）。
 */
class FakeRunner {
  constructor() {
    this.startCalls = [];
    this.resumeCalls = [];
    this.livePids = new Set([process.pid]); // 本进程恒活（recover 活探活用）
    this._seq = 0;
    this._pending = new Map(); // pid -> finish(result)
    this.lastExec = null;
  }
  capabilities() {
    return { kind: 'fake', steering: 'none', coldStartMs: 0 };
  }
  start(taskCtx) {
    this.startCalls.push(taskCtx);
    const pid = 40000 + this._seq;
    this._seq += 1;
    this.livePids.add(pid);
    const exec = { kind: 'fake', pid, sessionId: undefined, home: '/fake/home', cwd: taskCtx.cwd };
    this.lastExec = exec;
    let resolveDone;
    const done = new Promise((res) => { resolveDone = res; });
    this._pending.set(pid, (result) => {
      this.livePids.delete(pid);
      this._pending.delete(pid);
      // 对齐 SpawnRunner：done 回调后回填 exec.sessionId（可变引用语义）
      const final = {
        status: 'closed',
        response: `fake-result-${pid}`,
        sessionId: `sess-fake-${pid}`,
        usage: { input_tokens: 10, output_tokens: 20 },
        ...result,
      };
      if (final.sessionId) exec.sessionId = final.sessionId;
      resolveDone(final);
    });
    return { exec, cancel: () => this.finish(exec, { status: 'cancelled', response: '' }), done };
  }
  resume(exec, message, opts = {}) {
    this.resumeCalls.push({ exec, message, opts });
    return Promise.resolve({
      status: 'closed',
      response: `续聊回复:${message}`,
      sessionId: exec.sessionId,
      usage: { input_tokens: 5, output_tokens: 5 },
    });
  }
  alive(exec) {
    return Boolean(exec && this.livePids.has(exec.pid));
  }
  finish(exec, result) {
    const fin = this._pending.get(exec.pid);
    if (fin) fin(result);
  }
  finishAll(result) {
    for (const fin of [...this._pending.values()]) fin(result);
  }
}

function fakeResolver() {
  return {
    resolve(nameOrPath) {
      if (nameOrPath !== 'reviewer') return null;
      return {
        name: 'reviewer',
        description: '代码审查',
        filePath: '/fake/reviewer.md',
        model: 'fake/reviewer-model',
        skills: ['/fake/skills/review-guide'],
        body: '你是资深代码审查员',
      };
    },
  };
}

function fakeRouter() {
  return {
    resolve: (requested, agentDefault) => requested || agentDefault || 'fake/default-model',
    prepareRunEnv: async (modelRef) => ({ env: { HOME: `/fake/home/${modelRef}`, ZSUB_NESTED: '1' } }),
  };
}

function fakeSlots() {
  const state = { running: 0, acquired: 0 };
  return {
    async acquire() { state.running += 1; state.acquired += 1; return () => { state.running -= 1; }; },
    running: () => state.running,
    acquiredCount: () => state.acquired,
  };
}

function buildManager(overrides = {}) {
  // 共享事件日志清零（见文件头「两级隔离」）；本测试的 store 实例内存本就独立
  fs.rmSync(recordsPath(), { force: true });
  const runner = overrides.runner || new FakeRunner();
  const slots = overrides.slots || fakeSlots();
  const records = overrides.records || new RecordStore();
  const manager = new SubagentManager({
    runner,
    modelRouter: overrides.modelRouter || fakeRouter(),
    notifier: overrides.notifier || new MailboxNotifier(),
    resolver: overrides.resolver || fakeResolver(),
    records,
    outputs,
    slots,
    worktree: overrides.worktree,
  });
  return { manager, runner, records, slots };
}

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立（容忍中间态异常，如目录尚未创建）。 */
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

/** 读取某会话 mailbox 下的全部已投递 envelope（按文件名字典序 = 投递序）。 */
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

test('start(wait=false)：立即返回句柄，后台终态落盘 + mailbox 通知含 outputs 路径', async () => {
  const c = ctx();
  const { manager, runner, records, slots } = buildManager();
  const h = await manager.start(
    { task: '分析 lib 目录并给出重构清单', slug: 'bg-demo', agent: 'reviewer', model: 'fake/override-model' },
    c,
  );
  assert.match(h.subagentId, /^sa-/);
  assert.equal(h.status, 'running');
  assert.equal(h.notify, 'mailbox');
  assert.equal(h.guidance, undefined); // mailbox 档无轮询指引
  // 立即返回：任务尚未完成（FakeRunner waiter 挂起），record 在 created/running
  assert.ok(['created', 'running'].includes(records.get(h.subagentId).status));

  // ①②③④ 接线断言：resolver 命中 / model 优先级 / prompt 拼装 / record 字段
  await waitFor(() => runner.startCalls.length === 1);
  const taskCtx = runner.startCalls[0];
  assert.ok(taskCtx.prompt.includes('## 角色设定'));
  assert.ok(taskCtx.prompt.includes('资深代码审查员'));
  assert.ok(taskCtx.prompt.includes('分析 lib 目录并给出重构清单'));
  assert.equal(taskCtx.modelRef, 'fake/override-model');
  assert.equal(taskCtx.cwd, TMP);
  const rec0 = records.get(h.subagentId);
  assert.equal(rec0.agent, 'reviewer');
  assert.equal(rec0.model, 'fake/override-model');
  assert.equal(rec0.runnerKind, 'fake');
  assert.equal(rec0.notifyMode, 'mailbox');
  assert.equal(rec0.targetSessionId, c.targetSessionId);

  runner.finishAll({ status: 'closed', response: '结论：三条重构建议。', sessionId: 'sess-run-1', usage: { input_tokens: 7, output_tokens: 9 } });
  const rec = await waitFor(() => {
    const r = records.get(h.subagentId);
    return r && r.status === 'closed' && envelopeCount(c.targetSessionId) === 1 ? r : null;
  });
  assert.equal(rec.closedReason, 'completed');
  assert.equal(rec.sessionId, 'sess-run-1');
  assert.equal(rec.tokens.output_tokens, 9);
  assert.equal(rec.exec.sessionId, 'sess-run-1'); // done 后回填并持久化
  assert.equal(fs.readFileSync(rec.outputFile, 'utf8'), '结论：三条重构建议。');
  assert.equal(rec.notified, true);

  // 通知文案：完成标记 + slug + outputs 路径（P3：必须含全文指针）
  const envelopes = readEnvelopes(c.targetSessionId);
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].version, 1);
  assert.ok(envelopes[0].content.includes('[subagent 完成]'));
  assert.ok(envelopes[0].content.includes('slug=bg-demo'));
  assert.ok(envelopes[0].content.includes(rec.outputFile));
  assert.equal(slots.running(), 0); // 槽位释放
});

test('start(worktree=true)：任务 cwd 切隔离目录，patchFile 回填 + 通知含 git apply 指引', async () => {
  const c = ctx();
  const wtCalls = { prepared: [], patched: [], cleaned: [] };
  const fakeWorktree = {
    async prepare(slug) { wtCalls.prepared.push(slug); return { dir: path.join(TMP, 'wt', slug), branch: `zsub/${slug}` }; },
    async collectPatch(dir) { wtCalls.patched.push(dir); return 'diff --git a/f b/f\n--- a/f\n+++ b/f\n'; },
    async cleanup(dir) { wtCalls.cleaned.push(dir); },
  };
  const { manager, runner, records } = buildManager({ worktree: fakeWorktree });
  const h = await manager.start({ task: '重构 auth 模块的任务书', slug: 'wt-demo', worktree: true }, c);
  assert.deepEqual(wtCalls.prepared, ['wt-demo']);
  await waitFor(() => runner.startCalls.length === 1);
  assert.equal(runner.startCalls[0].cwd, path.join(TMP, 'wt', 'wt-demo')); // cwd 已切 worktree

  runner.finishAll({ status: 'closed', response: '已重构完成', sessionId: 'sess-wt-1' });
  const rec = await waitFor(() => {
    const r = records.get(h.subagentId);
    return r && r.status === 'closed' && envelopeCount(c.targetSessionId) === 1 ? r : null;
  });
  assert.ok(rec.patchFile && rec.patchFile.endsWith('.patch'));
  assert.ok(fs.readFileSync(rec.patchFile, 'utf8').startsWith('diff --git'));
  assert.deepEqual(wtCalls.patched, [rec.worktree]);
  const env1 = readEnvelopes(c.targetSessionId).at(-1);
  assert.ok(env1.content.includes(rec.patchFile)); // patch 路径
  assert.ok(env1.content.includes('git apply'));   // apply 指引行
});

test('start(wait=true)：同步等待，返回终态与结果全文（不截断）', async () => {
  const { manager, runner } = buildManager();
  const full = '长结果行'.repeat(300); // 1200 字符，验证全文而非 500 截断
  setTimeout(() => runner.finishAll({ status: 'closed', response: full, sessionId: 'sess-wait-1' }), 20);
  const res = await manager.start({ task: '同步任务书', slug: 'wait-demo', wait: true }, ctx());
  assert.equal(res.status, 'closed');
  assert.equal(res.result, full);
  assert.equal(fs.readFileSync(res.outputFile, 'utf8'), full);
});

test('start(wait=true) error 终态：返回失败原因，record error，通知带恢复指引', async () => {
  const c = ctx();
  const { manager, runner, records } = buildManager();
  setTimeout(() => runner.finishAll({ status: 'error', error: '退出码 2: 进程崩了', response: '部分输出' }), 20);
  const res = await manager.start({ task: '会失败的任务书', slug: 'err-demo', wait: true }, c);
  assert.equal(res.status, 'error');
  assert.match(res.error, /退出码 2/);
  const rec = records.get(res.subagentId);
  assert.equal(rec.status, 'error');
  assert.match(rec.closedReason, /error/);
  const env1 = await waitFor(() => readEnvelopes(c.targetSessionId).at(-1));
  assert.ok(env1.content.includes('失败'));
  assert.ok(env1.content.includes('退出码 2'));
  assert.ok(env1.content.includes('恢复指引'));
});

test('message：running 中返回 busy；非 conversation 任务拒绝', async () => {
  const c = ctx();
  const { manager, runner, records } = buildManager();
  const h = await manager.start({ task: '忙碌任务书', slug: 'busy-demo', conversation: true }, c);
  await waitFor(() => runner.startCalls.length === 1);
  const busy = await manager.message(h.subagentId, '现在怎么样了');
  assert.deepEqual(busy, { busy: true, message: '该 subagent 正在运行，仅 idle 状态可投递' });

  // 非 conversation：完成后 message 直接报可操作错误
  const h2 = await manager.start({ task: '普通任务书', slug: 'plain-demo' }, c);
  runner.finishAll({ status: 'closed', response: 'done', sessionId: 'sess-plain-1' });
  await waitFor(() => records.get(h2.subagentId).status === 'closed');
  await assert.rejects(() => manager.message(h2.subagentId, 'hi'), /不支持续聊/);
});

test('message：idle 续聊流转（idle→running→idle），resume 拿到回填句柄，二轮通知', async () => {
  const c = ctx();
  const { manager, runner, records, slots } = buildManager();
  const h = await manager.start({ task: '对话任务书', slug: 'chat-demo', conversation: true }, c);
  await waitFor(() => runner.startCalls.length === 1);
  runner.finishAll({ status: 'closed', response: '第一轮回答', sessionId: 'sess-chat-1' });
  const idle1 = await waitFor(() => {
    const r = records.get(h.subagentId);
    return r && r.status === 'idle' ? r : null;
  });
  assert.equal(idle1.closedReason, 'round-complete'); // 不进 closed 硬终态（CAS 状态机接线）
  assert.equal(idle1.exec.sessionId, 'sess-chat-1');

  const r = await manager.message(h.subagentId, '追问：详细说说');
  assert.equal(r.status, 'running');
  assert.equal(r.round, 1);
  const idle2 = await waitFor(() => {
    const rec = records.get(h.subagentId);
    return rec && rec.status === 'idle' && rec.rounds === 1 ? rec : null;
  });
  assert.equal(runner.resumeCalls.length, 1);
  assert.equal(runner.resumeCalls[0].exec.sessionId, 'sess-chat-1'); // 首轮回填的句柄
  assert.equal(runner.resumeCalls[0].message, '追问：详细说说');
  assert.equal(idle2.status, 'idle');
  // 第二封完成通知（首轮 + 续聊轮各一封）
  await waitFor(() => envelopeCount(c.targetSessionId) >= 2);
  const second = readEnvelopes(c.targetSessionId).at(-1);
  assert.ok(second.content.includes('续聊回复:追问：详细说说'));
  assert.equal(slots.running(), 0);
});

test('cancel（有句柄）：杀进程 + record 落 cancelled + 不发通知', async () => {
  const c = ctx();
  const { manager, runner, records, slots } = buildManager();
  const h = await manager.start({ task: '长任务书', slug: 'cancel-live' }, c);
  await waitFor(() => runner.startCalls.length === 1);
  const out = await manager.cancel(h.subagentId);
  assert.equal(out.cancelled, true);
  assert.equal(records.get(h.subagentId).status, 'cancelled');
  assert.equal(runner.alive(runner.lastExec), false); // FakeRunner 已清理 livePids
  assert.equal(slots.running(), 0);
  assert.equal(envelopeCount(c.targetSessionId), 0); // cancelled 不通知
  // 已终态再 cancel：幂等提示
  const again = await manager.cancel(h.subagentId);
  assert.equal(again.cancelled, false);
});

test('cancel（重启后无句柄）：running record 直接标 cancelled 并注明进程可能残留', async () => {
  const { manager, records } = buildManager();
  records.create({ subagentId: 'sa-stale-1', slug: 'stale', exec: { kind: 'fake', pid: 999999 } });
  records.transition('sa-stale-1', 'created', 'running');
  const out = await manager.cancel('sa-stale-1');
  assert.equal(out.cancelled, true);
  assert.equal(out.status, 'cancelled');
  const rec = records.get('sa-stale-1');
  assert.equal(rec.status, 'cancelled');
  assert.match(rec.closedReason, /句柄丢失/);
  assert.match(rec.closedReason, /残留/);
});

test('recover：死 pid → lost 落因，活 pid → 保留 + 孤儿标记', async () => {
  const runner = new FakeRunner();
  const { manager, records } = buildManager({ runner });
  records.create({ subagentId: 'sa-dead-1', slug: 'dead', exec: { kind: 'fake', pid: 4194304 } });
  records.transition('sa-dead-1', 'created', 'running');
  records.create({ subagentId: 'sa-orphan-1', slug: 'orphan', exec: { kind: 'fake', pid: process.pid } });
  records.transition('sa-orphan-1', 'created', 'running');

  const summary = await manager.recover();
  assert.equal(summary.rebuild.records, 2);
  assert.deepEqual(summary.dead, ['sa-dead-1']);
  assert.deepEqual(summary.orphan, ['sa-orphan-1']);
  const dead = records.get('sa-dead-1');
  assert.equal(dead.status, 'lost'); // 死 → lost（W1 设计：内存标记，幂等收敛）
  assert.match(dead.lostReason, /已死|探活/);
  const orphan = records.get('sa-orphan-1');
  assert.equal(orphan.status, 'lost'); // 活 → 保留（无法重挂句柄）
  assert.equal(orphan.orphan, true);
  assert.match(orphan.lostReason, /孤儿/);
});

test('noOpWorktree：worktree=true 报可操作错误，且不产生 record', async () => {
  const { manager, records } = buildManager(); // 不注入 worktree → noOp 占位
  await assert.rejects(
    () => manager.start({ task: '隔离任务书', slug: 'wt-missing', worktree: true }, ctx()),
    (e) => /worktree 模块未就绪/.test(e.message) && e.message.includes('恢复指引'),
  );
  assert.equal(records.list().length, 0); // 校验先于 create，失败不留悬挂 record
});

test('start 参数校验：task/slug/cwd 缺失与 agent 未命中均为可操作错误', async () => {
  const { manager } = buildManager();
  const c = ctx();
  await assert.rejects(() => manager.start({ slug: 'x' }, c), /task/);
  await assert.rejects(() => manager.start({ task: '任务书' }, c), /slug/);
  await assert.rejects(
    () => manager.start({ task: '任务书', slug: 'x' }, { targetSessionId: 'sess_x' }),
    /cwd/,
  );
  await assert.rejects(
    () => manager.start({ task: '任务书', slug: 'x', agent: 'nope' }, c),
    (e) => /未找到 agent/.test(e.message) && e.message.includes('恢复指引'),
  );
});

test('status/list：精简视图与全量查询；polling 档附轮询指引', async () => {
  const { manager: mPoll } = buildManager({ notifier: new PollingNotifier() });
  const h = await mPoll.start({ task: '轮询任务书', slug: 'poll-demo' }, { targetSessionId: 'sess_poll_1', cwd: TMP });
  assert.equal(h.notify, 'polling');
  assert.ok(h.guidance.includes(h.subagentId)); // polling 指引含任务 id 与结果路径

  const st = mPoll.status(h.subagentId);
  assert.equal(st.subagentId, h.subagentId);
  assert.ok(st.outputFile.includes(h.subagentId));
  const lst = mPoll.list();
  assert.equal(lst.length, 1);
  assert.equal(lst[0].slug, 'poll-demo');
  // 立即返回与后台体微任务竞态：created 或 running 均合法
  assert.ok(['created', 'running'].includes(lst[0].status));
  assert.equal(lst[0].patchFile, null);
  assert.throws(() => mPoll.status('sa-none'), /不存在/); // status 同步方法
});

test('close：运行中任务先取消再终态化；worktree 清理被调用', async () => {
  const c = ctx();
  const wtCleaned = [];
  const fakeWorktree = {
    async prepare(slug) { return { dir: path.join(TMP, 'wt2', slug), branch: `zsub/${slug}` }; },
    async collectPatch() { return 'diff --git'; },
    async cleanup(dir) { wtCleaned.push(dir); },
  };
  const { manager, runner, records } = buildManager({ worktree: fakeWorktree });
  const h = await manager.start({ task: '待关闭任务书', slug: 'close-demo', worktree: true }, c);
  await waitFor(() => runner.startCalls.length === 1);
  const out = await manager.close(h.subagentId);
  assert.equal(out.status, 'cancelled'); // 运行中 close = 取消链（杀进程）
  assert.equal(out.worktreeCleaned, true);
  assert.deepEqual(wtCleaned, [records.get(h.subagentId).worktree]);
  assert.equal(records.get(h.subagentId).status, 'cancelled');
});
