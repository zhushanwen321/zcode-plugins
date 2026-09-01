'use strict';

/**
 * SubagentManager 编排内核测试（W2-S4）。
 *
 * 隔离原则：全 fake——不跑真 zcode、不碰真实 ~/.zcode。
 * runner/model-router/resolver/slots/worktree 全 fake；record-store /
 * output-store / notifier-mailbox 走真实实现（W1 已测，这里测的是接线），
 * 其路径全部来自 env，故 ZSW_ROOT / ZCODE_MAILBOX_ROOT / HOME 必须在
 * require 任何 lib 之前指到临时目录。
 *
 * 进程内共享文件系统的两级隔离：每个测试独立 targetSessionId（mailbox
 * 目录互不可见）；buildManager 每次清空共享 records.jsonl（RecordStore
 * 实例内存独立，但事件日志落同一 ZSW_ROOT 文件，不清会让 recover 的
 * rebuild 读到前序测试事件）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-mgr-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsub-root');
process.env.ZCODE_MAILBOX_ROOT = path.join(TMP, 'mailbox');
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

// env 隔离完成后才允许 require lib（见文件头注释）
const { RecordStore } = require('../lib/record-store');
const outputs = require('../lib/output-store');
const { recordsPath, DEFAULTS, zswCliPath } = require('../lib/config');
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
 * 延迟完成/失败/超时/取消）；alive 由 livePids 决定
 * （预置 process.pid 供 recover 测试探活）。
 */
class FakeRunner {
  constructor() {
    this.startCalls = [];
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

/** 缺省角色 fake（D-4 缺省统一：resolveDefault 的 general-purpose 形态）。 */
const fakeGeneralPurpose = () => ({
  name: 'general-purpose',
  description: '通用兜底',
  filePath: '/fake/general-purpose.md',
  body: '你是通用兜底 agent——直接用提供的工具执行 task',
});

function fakeResolver() {
  return {
    // D-4a 收紧后 resolver 只吃归一化绝对路径（manager 先 normalizeAgentRef）
    resolve(ref) {
      if (ref !== '/fake/reviewer.md') return null;
      return {
        name: 'reviewer',
        description: '代码审查',
        filePath: '/fake/reviewer.md',
        model: 'fake/reviewer-model',
        skills: ['/fake/skills/review-guide'],
        body: '你是资深代码审查员',
      };
    },
    resolveDefault() {
      return fakeGeneralPurpose();
    },
  };
}

function fakeRouter() {
  // 2c 后 manager 只消费清单器的 resolveDefault（默认模型回退链展示值）；
  // 模型校验归 core 引擎 preparer，fake 不再需要 resolve/prepareRunEnv
  return {
    resolveDefault: () => 'fake/default-model',
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
    { task: '分析 lib 目录并给出重构清单', slug: 'bg-demo', agent: '/fake/reviewer.md', model: 'fake/override-model' },
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
    async prepare({ slug, subagentId, cwd }) {
      wtCalls.prepared.push({ slug, subagentId, cwd });
      return { dir: path.join(TMP, 'wt', slug), branch: `zsub/${slug}`, mainRepo: TMP };
    },
    async collectPatch({ dir, subagentId }) {
      wtCalls.patched.push({ dir, subagentId });
      const { writePatch } = require('../lib/output-store');
      return writePatch(subagentId, 'diff --git a/f b/f\n--- a/f\n+++ b/f\n');
    },
    async cleanup({ dir, subagentId, meta }) { wtCalls.cleaned.push({ dir, subagentId, meta }); },
  };
  const { manager, runner, records } = buildManager({ worktree: fakeWorktree });
  const h = await manager.start({ task: '重构 auth 模块的任务书', slug: 'wt-demo', worktree: true }, c);
  assert.deepEqual(wtCalls.prepared.map((p) => p.slug), ['wt-demo']);
  assert.equal(wtCalls.prepared[0].subagentId, h.subagentId); // worktree 命名用 record id
  assert.equal(wtCalls.prepared[0].cwd, c.cwd);
  await waitFor(() => runner.startCalls.length === 1);
  assert.equal(runner.startCalls[0].cwd, path.join(TMP, 'wt', 'wt-demo')); // cwd 已切 worktree

  runner.finishAll({ status: 'closed', response: '已重构完成', sessionId: 'sess-wt-1' });
  const rec = await waitFor(() => {
    const r = records.get(h.subagentId);
    return r && r.status === 'closed' && envelopeCount(c.targetSessionId) === 1 ? r : null;
  });
  assert.ok(rec.patchFile && rec.patchFile.endsWith('.patch'));
  assert.ok(fs.readFileSync(rec.patchFile, 'utf8').startsWith('diff --git'));
  assert.deepEqual(wtCalls.patched.map((p) => p.dir), [rec.worktree]);
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
  assert.deepEqual(busy, {
    busy: true,
    message: `该 subagent 正在运行，仅 idle 状态可投递。等待当前轮完成（node "${zswCliPath()}" wait --id ${h.subagentId}）`
      + `或 node "${zswCliPath()}" cancel --id ${h.subagentId} 取消后再投递`,
  });

  // 非 conversation：完成后 message 直接报可操作错误
  const h2 = await manager.start({ task: '普通任务书', slug: 'plain-demo' }, c);
  runner.finishAll({ status: 'closed', response: 'done', sessionId: 'sess-plain-1' });
  await waitFor(() => records.get(h2.subagentId).status === 'closed');
  await assert.rejects(() => manager.message(h2.subagentId, 'hi'), /不支持续聊/);
});

test('message：idle 续聊在 manager 入口直接报 unavailable（record 不翻转，无二轮通知）', async () => {
  const c = ctx();
  const { manager, runner, records } = buildManager();
  const h = await manager.start({ task: '对话任务书', slug: 'chat-demo', conversation: true }, c);
  await waitFor(() => runner.startCalls.length === 1);
  runner.finishAll({ status: 'closed', response: '第一轮回答', sessionId: 'sess-chat-1' });
  const idle1 = await waitFor(() => {
    const r = records.get(h.subagentId);
    return r && r.status === 'idle' ? r : null;
  });
  assert.equal(idle1.closedReason, 'round-complete'); // 不进 closed 硬终态（CAS 状态机接线）
  assert.equal(idle1.rounds, 1); // 完成计数：首轮成功收尾 0→1
  assert.equal(idle1.exec.sessionId, 'sess-chat-1');

  // 续聊执行线已随 app-server 常驻化重构移除（P3 回归）：入口即报明确
  // unavailable，不起轮——调用方拿到清晰错误而非深层异常
  await assert.rejects(
    () => manager.message(h.subagentId, '追问：详细说说'),
    (e) => /续聊暂不可用/.test(e.message) && /P3/.test(e.message) && /重新 start/.test(e.message),
  );
  const idle2 = records.get(h.subagentId);
  assert.equal(idle2.status, 'idle', 'record 不发生 idle→running 翻转');
  assert.equal(idle2.rounds, 1, '入口报错不产生轮，完成计数不动');
  await sleep(30);
  assert.equal(envelopeCount(c.targetSessionId), 1, '无二轮通知');
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

test('recover（W6a2）：appserver 形态 exec 保守存活 → orphan 分流 + 如实文案（不判死）', async () => {
  const runner = new FakeRunner();
  // appserver 形态的 exec 无 pid（常驻进程不经 onChildSpawned）；alive 按 kind
  // 分支返回 true（保守），不走 livePids 的 pid 判定
  runner.alive = (exec) => Boolean(exec && exec.kind === 'appserver');
  const { manager, records } = buildManager({ runner });
  records.create({
    subagentId: 'sa-app-1', slug: 'app-resident',
    exec: {
      kind: 'appserver', sessionId: 'sess-app-1',
      sessionRef: { dbPath: '.zcode/cli/db/db.sqlite', sessionId: 'sess-app-1' },
      poolKey: 'home-appserver',
    },
  });
  records.transition('sa-app-1', 'created', 'running');

  const summary = await manager.recover();
  assert.deepEqual(summary.dead, [], 'appserver 形态不判死（core 未暴露任务级探活面，保守处置）');
  assert.deepEqual(summary.orphan, ['sa-app-1']);
  const rec = records.get('sa-app-1');
  assert.equal(rec.status, 'lost');
  assert.equal(rec.orphan, true);
  assert.match(rec.lostReason, /孤儿会话/);
  assert.match(rec.lostReason, /进度未知/);
  assert.match(rec.lostReason, /cancel 后重发/);
});

// ------------------------------- R1/R2 回归（上轮 must-fix 的反退化锚点）

test('R1 回归：alive 返回 Promise 时 recover 仍正确分流死/活进程（await 退化即翻车）', async () => {
  // runner.alive 可能是 async（runner-core 的 exec 形态分支）——若 manager 漏
  // await，Promise 恒 truthy，死进程全部误入 orphan 分支。此用例用 Promise
  // 返回的 alive 钉住该语义。
  const runner = new FakeRunner();
  runner.alive = (exec) => Promise.resolve(Boolean(exec && runner.livePids.has(exec.pid)));
  const { manager, records } = buildManager({ runner });
  records.create({ subagentId: 'sa-dead-async-1', slug: 'dead-async', exec: { kind: 'fake', pid: 4194305 } });
  records.transition('sa-dead-async-1', 'created', 'running');
  records.create({ subagentId: 'sa-live-async-1', slug: 'live-async', exec: { kind: 'fake', pid: process.pid } });
  records.transition('sa-live-async-1', 'created', 'running');

  const summary = await manager.recover();
  assert.deepEqual(summary.dead, ['sa-dead-async-1']);
  assert.deepEqual(summary.orphan, ['sa-live-async-1']);
  assert.match(records.get('sa-dead-async-1').lostReason, /进程已死/);
  assert.equal(records.get('sa-live-async-1').orphan, true);
});

test('R2 回归：start 同步抛错 + wait=false → 句柄正常返回、record 收敛 error、无 unhandledRejection', async () => {
  const rejections = [];
  const onUnhandled = (e) => rejections.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const runner = new FakeRunner();
    runner.start = () => { throw new Error('spawn 失败：ENOENT'); };
    const c = ctx();
    const { manager, records } = buildManager({ runner });
    const h = await manager.start({ task: '注定起不来的任务书', slug: 'start-throw' }, c);
    assert.equal(h.status, 'running'); // handle 正常返回，不向上抛
    const rec = await waitFor(() => {
      const r = records.get(h.subagentId);
      return r && r.status === 'error' ? r : null;
    });
    assert.match(rec.error, /ENOENT/);
    assert.equal(rec.notified, undefined, 'start 抛错路径不经 _completeRun，无完成通知（消费方以 record error 终态为准）');
    // 等 no-op catch 之外的逃逸 rejection 浮出（至少一个宏任务轮）
    await sleep(50);
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('worktree 端口缺省占位：worktree=true 报可操作错误，且不产生 record', async () => {
  const { manager, records } = buildManager(); // 不注入 worktree → noOp 占位
  await assert.rejects(
    () => manager.start({ task: '隔离任务书', slug: 'wt-missing', worktree: true }, ctx()),
    (e) => /worktree 能力未注入/.test(e.message) && e.message.includes('恢复指引'),
  );
  assert.equal(records.list().length, 0); // 校验先于 create，失败不留悬挂 record
});

// ---------------------------------------------------------------------------
// agent 参数契约（W6b：D-4a 收紧 + D-4 缺省统一）
// ---------------------------------------------------------------------------

/**
 * core agent-registry `loadByPath(ref, true)` 的 Invalid agent ref 模板
 * （报错同源基准，xyz-agent 仓 packages/subagent-core/src/execution/agent-registry.ts）：
 *   `Invalid agent ref: ${ref}. Agent refs must be absolute paths to .md files (use <location> from <available_subagents>).`
 * zsw 侧主句与其逐字同源（尾部括号内恢复指引按 zsw 双出口适配：注入段
 * location 或 zsw agents 查路径；F12 起查询命令为完整可执行形态）。人工对照
 * 锚点：本硬编码断言只锁 zsw 侧文案形态（zsw 侧漂移在此暴露）；与 core 源的
 * 逐字对齐它测不出来（core 侧文案变更不会让本断言失败）——靠 review 对照维护。
 */
const CORE_INVALID_AGENT_REF_PREFIX = (ref) =>
  `Invalid agent ref: ${ref}. Agent refs must be absolute paths to .md files`;

/** F12：指引文案里的 CLI 完整可执行形态（测试进程未设 ZCODE_PLUGIN_ROOT → 仓库内插件根）。 */
const ZSW_CLI = process.env.ZCODE_PLUGIN_ROOT || path.join(__dirname, '..', 'bin', 'zsw.js');

test('start 参数校验：task/slug/cwd 缺失与 agent 引用非法/未命中均为可操作错误', async () => {
  const { manager } = buildManager();
  const c = ctx();
  await assert.rejects(() => manager.start({ slug: 'x' }, c), /task/);
  await assert.rejects(() => manager.start({ task: '任务书' }, c), /slug/);
  await assert.rejects(
    () => manager.start({ task: '任务书', slug: 'x' }, { targetSessionId: 'sess_x' }),
    /cwd/,
  );
  // D-4a：名字形态拒——文案与 core agent-registry 同源（主句逐字一致）；
  // F12：查询指引为完整可执行 CLI 形态（node "<abs>/bin/zsw.js" agents）
  await assert.rejects(
    () => manager.start({ task: '任务书', slug: 'x', agent: 'reviewer' }, c),
    (e) => e.message.startsWith(CORE_INVALID_AGENT_REF_PREFIX('reviewer'))
      && e.message.includes(`node "${ZSW_CLI}" agents`),
  );
  // 相对路径与非 .md 引用同拒（core normalizeRef 口径）
  await assert.rejects(
    () => manager.start({ task: '任务书', slug: 'x', agent: './reviewer.md' }, c),
    (e) => e.message.startsWith(CORE_INVALID_AGENT_REF_PREFIX('./reviewer.md')),
  );
  await assert.rejects(
    () => manager.start({ task: '任务书', slug: 'x', agent: '/abs/reviewer.txt' }, c),
    (e) => e.message.startsWith(CORE_INVALID_AGENT_REF_PREFIX('/abs/reviewer.txt')),
  );
  // 路径合法但文件不可读：core agent-registry 的 Agent file not found 同款文案
  await assert.rejects(
    () => manager.start({ task: '任务书', slug: 'x', agent: '/fake/missing.md' }, c),
    (e) => e.message.startsWith('Agent file not found or unreadable: /fake/missing.md.')
      && e.message.includes(`node "${ZSW_CLI}" agents`),
  );
  // `..` 段引用拒（V1a C2 行为变更：复刻版放行，core normalizeRef 拒）——
  // 消息走 core 工厂 without ".." 分支且带 zsw 恢复指引
  await assert.rejects(
    () => manager.start({ task: '任务书', slug: 'x', agent: '/x/../evil.md' }, c),
    (e) => e.message.includes('without ".." path segments')
      && e.message.includes(`node "${ZSW_CLI}" agents`),
  );
});

test('slug 长度闸（V1a C11）：超过 SLUG_MAX_LENGTH=35 拒绝且消息含上限与恢复指引；35 字符边界放行', async () => {
  const { manager, runner, records } = buildManager();
  const c = ctx();
  // 消息含上限值（35 字符上限）+ 常量标识 + 恢复指引（缩短后重试）
  await assert.rejects(
    () => manager.start({ task: '任务书', slug: 'x'.repeat(36) }, c),
    /task-slug 超过 35 字符上限（SLUG_MAX_LENGTH）——请缩短后重试/,
  );
  // 边界等值：35 字符（上限内）不被长度闸拒——正常起任务
  const h = await manager.start({ task: '任务书', slug: 'b'.repeat(35) }, c);
  assert.match(h.subagentId, /^sa-/);
  runner.finishAll({ status: 'closed', response: 'ok', sessionId: 'sess-slug-1' });
  await waitFor(() => records.get(h.subagentId).status === 'closed');
});

test('start agent 缺省：resolveDefault 加载 general-purpose 角色（record.agent 同名 + prompt 含角色正文）', async () => {
  const c = ctx();
  const { manager, runner, records } = buildManager();
  const h = await manager.start({ task: '整理任务书', slug: 'gp-default' }, c);
  await waitFor(() => runner.startCalls.length === 1);
  // record.agent 从 null 变 general-purpose（D-4 缺省段：与 pi 对齐）
  assert.equal(records.get(h.subagentId).agent, 'general-purpose');
  // prompt-builder 消费 agentProfile：角色段注入 general-purpose 正文
  assert.ok(runner.startCalls[0].prompt.includes('## 角色设定'));
  assert.ok(runner.startCalls[0].prompt.includes('通用兜底 agent'));
  // 模型链：缺省角色 frontmatter 无 model → 默认链产物
  assert.equal(runner.startCalls[0].modelRef, 'fake/default-model');
  runner.finishAll({ status: 'closed', response: 'ok', sessionId: 'sess-gp-1' });
  await waitFor(() => records.get(h.subagentId).status === 'closed');
  // 对照：显式传自定义 .md 路径不走缺省角色（不想要角色的用户出口）
  const h2 = await manager.start({ task: '任务书', slug: 'explicit', agent: '/fake/reviewer.md' }, ctx());
  assert.equal(records.get(h2.subagentId).agent, 'reviewer');
  runner.finishAll({ status: 'closed', response: 'ok', sessionId: 'sess-gp-2' });
});

test('start agent 路径正例：绝对路径经 resolver 命中（D-4a 唯一合法形态）', async () => {
  const c = ctx();
  const { manager, records } = buildManager();
  const h = await manager.start(
    { task: '任务书', slug: 'path-hit', agent: '/fake/reviewer.md', model: 'fake/m' },
    c,
  );
  assert.equal(records.get(h.subagentId).agent, 'reviewer');
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

test('notify 三态（MF6）：mailbox 无 target=none（socket/CLI 面）；mailbox+target=mailbox；polling 恒 polling', async () => {
  // ① mailbox 档 + 无 targetSessionId（socket/CLI 面恒无——D6）：句柄不得写
  // 'mailbox' 误导「会自动回流」（notifyCompletion 必 delivered:false）
  const m1 = buildManager();
  const noTarget = await m1.manager.start({ task: '无回流通道任务书', slug: 'no-target' }, { cwd: TMP });
  assert.equal(noTarget.notify, 'none');
  assert.equal(noTarget.guidance, undefined, 'none 档不是 polling，无轮询指引');
  // record 侧如实：targetSessionId=null（句柄语义与 record 落盘一致）
  assert.equal(m1.records.get(noTarget.subagentId).targetSessionId, null);

  // ② mailbox 档 + 有 target（MCP 面遗留形态）：保持 'mailbox'
  const withTarget = await m1.manager.start({ task: '有回流通道任务书', slug: 'has-target' }, ctx());
  assert.equal(withTarget.notify, 'mailbox');

  // ③ polling 档：有无 target 均 'polling'（档位即通道，guidance 兜底）
  const m2 = buildManager({ notifier: new PollingNotifier() });
  const pollNoTarget = await m2.manager.start({ task: '轮询无target任务书', slug: 'poll-no-target' }, { cwd: TMP });
  assert.equal(pollNoTarget.notify, 'polling');
  const pollWithTarget = await m2.manager.start({ task: '轮询有target任务书', slug: 'poll-has-target' }, { targetSessionId: 'sess_pt', cwd: TMP });
  assert.equal(pollWithTarget.notify, 'polling');

  // 收尾：等四个任务的 runner.start 全部就位再统一 finish（finishAll 只
  // finish 已注册的 waiter，早于 start 调用会落空、任务悬在 created/running）
  await waitFor(() => m1.runner.startCalls.length === 2 && m2.runner.startCalls.length === 2);
  m1.runner.finishAll({ status: 'closed', response: 'done' });
  m2.runner.finishAll({ status: 'closed', response: 'done' });
  await waitFor(() => m1.records.get(noTarget.subagentId).status === 'closed'
    && m1.records.get(withTarget.subagentId).status === 'closed'
    && m2.records.get(pollNoTarget.subagentId).status === 'closed'
    && m2.records.get(pollWithTarget.subagentId).status === 'closed');
});

test('notify 三态（MF6）：wait=true 路径句柄同款 none 语义', async () => {
  const { manager, runner } = buildManager();

  // wait=true + 无 target → 'none'（结果已同步在手，字段语义仍如实标通道）。
  // FakeRunner 的 done 挂起：先拿 promise、触 finish、再 await（直接 await 会永久挂起）
  const finP = manager.start({ task: '同步等待任务书', slug: 'wait-sync', wait: true }, { cwd: TMP });
  await waitFor(() => runner.startCalls.length === 1);
  runner.finishAll({ status: 'closed', response: '同步结果' });
  const fin = await finP;
  assert.equal(fin.status, 'closed');
  assert.equal(fin.notify, 'none');
});

test('close：运行中任务先取消再终态化；worktree 清理被调用', async () => {
  const c = ctx();
  const wtCleaned = [];
  const fakeWorktree = {
    async prepare({ slug }) { return { dir: path.join(TMP, 'wt2', slug), branch: `zsub/${slug}`, mainRepo: TMP }; },
    async collectPatch() { return null; },
    async cleanup({ dir, meta }) { wtCleaned.push({ dir, meta }); },
  };
  const { manager, runner, records } = buildManager({ worktree: fakeWorktree });
  const h = await manager.start({ task: '待关闭任务书', slug: 'close-demo', worktree: true }, c);
  await waitFor(() => runner.startCalls.length === 1);
  const out = await manager.close(h.subagentId);
  assert.equal(out.status, 'cancelled'); // 运行中 close = 取消链（杀进程）
  assert.equal(out.worktreeCleaned, true);
  assert.deepEqual(wtCleaned.map((x) => x.dir), [records.get(h.subagentId).worktree]);
  assert.equal(records.get(h.subagentId).status, 'cancelled');
});

// -------------------------------------------- MUST_FIX-3 / SUGGESTION-4

test('timeoutMs 决策链：显式 params.timeoutMs > core maxTurnsToWatchdogMs（floor=30min）> 全局默认（MUST_FIX-3 + V1a C4）', async () => {
  const capped = {
    name: 'capped', description: '限轮任务', filePath: '/fake/capped.md', body: '正文',
    maxTurns: 4, disallowedTools: ['web-search', 'mcp__demo__x'],
  };
  const cappedResolver = { resolve: (n) => (n === '/fake/capped.md' ? capped : null), resolveDefault: () => null };
  const settle = (records, id) =>
    waitFor(() => ['closed', 'idle'].includes(records.get(id).status));

  // ① 显式 timeoutMs 优先于 maxTurns 换算（调用方声明即覆盖 agent 约定）
  {
    const { manager, runner, records } = buildManager({ resolver: cappedResolver });
    const h = await manager.start({ task: '任务书', slug: 'explicit', agent: '/fake/capped.md', timeoutMs: 12345 }, ctx());
    await waitFor(() => runner.startCalls.length === 1);
    assert.equal(runner.startCalls[0].timeoutMs, 12345);
    runner.finishAll({ status: 'closed', response: 'ok', sessionId: 'sess-mt-1' });
    await settle(records, h.subagentId);
  }
  // ② 无显式 → core maxTurnsToWatchdogMs（×5min/turn + floor=30min——V1a C4
  // 行为变更：旧 MS_PER_TURN 纯线性 4×5min=20min，floor 恢复后抬到 30min）
  {
    const { manager, runner, records } = buildManager({ resolver: cappedResolver });
    const h = await manager.start({ task: '任务书', slug: 'turns', agent: '/fake/capped.md' }, ctx());
    await waitFor(() => runner.startCalls.length === 1);
    assert.equal(runner.startCalls[0].timeoutMs, 1_800_000); // max(30min, 4×5min) = floor 生效
    assert.equal(records.get(h.subagentId).timeoutMs, 1_800_000); // record 持久化同值
    runner.finishAll({ status: 'closed', response: 'ok', sessionId: 'sess-mt-2' });
    await settle(records, h.subagentId);
  }
  // ②b S2① 函数级口径落 manager 挂载面：maxTurns=2（旧口径 2×5min=10min）
  // 挂载时长 ≥ 30min floor；大 maxTurns 保持线性（floor 不压低大预算）
  {
    const profileOf = (maxTurns) => ({ ...capped, maxTurns, filePath: `/fake/turns-${maxTurns}.md` });
    const resolver = {
      resolve: (n) => (n === '/fake/turns-2.md' ? profileOf(2) : n === '/fake/turns-8.md' ? profileOf(8) : null),
      resolveDefault: () => null,
    };
    const { manager, runner, records } = buildManager({ resolver });
    const hMin = await manager.start({ task: '任务书', slug: 'floor-min', agent: '/fake/turns-2.md' }, ctx());
    await waitFor(() => runner.startCalls.length === 1);
    assert.ok(runner.startCalls[0].timeoutMs >= 1_800_000,
      `maxTurns=2 挂载时长不低于 30min floor（实际 ${runner.startCalls[0].timeoutMs}）`);
    assert.equal(runner.startCalls[0].timeoutMs, 1_800_000); // 2×5min=10min < floor → 抬到 30min
    assert.equal(records.get(hMin.subagentId).timeoutMs, 1_800_000);
    const hBig = await manager.start({ task: '任务书', slug: 'floor-linear', agent: '/fake/turns-8.md' }, ctx());
    await waitFor(() => runner.startCalls.length === 2);
    assert.equal(runner.startCalls[1].timeoutMs, 8 * 300_000, 'maxTurns=8 → 40min > floor，线性段保持');
    runner.finishAll({ status: 'closed', response: 'ok', sessionId: 'sess-mt-2b' });
    await settle(records, hMin.subagentId);
    await settle(records, hBig.subagentId);
  }
  // ③ 无 profile → 全局默认（config.DEFAULTS.timeoutMs）
  {
    const { manager, runner, records } = buildManager();
    const h = await manager.start({ task: '任务书', slug: 'default' }, ctx());
    await waitFor(() => runner.startCalls.length === 1);
    assert.equal(runner.startCalls[0].timeoutMs, DEFAULTS.timeoutMs); // 全局默认现可为 null（无超时）
    runner.finishAll({ status: 'closed', response: 'ok', sessionId: 'sess-mt-3' });
    await settle(records, h.subagentId);
  }
});

test('profile.disallowedTools 透传 taskCtx（MUST_FIX-3 硬约束上游）；tools 走 prompt 软约束', async () => {
  const restricted = {
    name: 'restricted', description: '', filePath: '/fake/restricted.md', body: '正文',
    tools: ['read', 'bash'], disallowedTools: ['web-search'],
  };
  const { manager, runner, records } = buildManager({
    resolver: { resolve: (n) => (n === '/fake/restricted.md' ? restricted : null), resolveDefault: () => null },
  });
  const h = await manager.start({ task: '任务书', slug: 'denylist', agent: '/fake/restricted.md' }, ctx());
  await waitFor(() => runner.startCalls.length === 1);
  // denylist → taskCtx（runner 层落 --disallowed-tools flag，硬约束）
  assert.deepEqual(runner.startCalls[0].disallowedTools, ['web-search']);
  // 白名单无 flag 通道 → prompt 工具约束段（软约束，prompt-builder 两态见 domain.test.js）
  assert.ok(runner.startCalls[0].prompt.includes('## 工具约束'));
  assert.ok(runner.startCalls[0].prompt.includes('只允许使用以下工具'));
  // 无 disallowedTools 的 agent（缺省角色走 resolveDefault）不透传
  const { manager: m2, runner: r2 } = buildManager();
  await m2.start({ task: '任务书', slug: 'no-agent' }, ctx());
  await waitFor(() => r2.startCalls.length === 1);
  assert.equal(r2.startCalls[0].disallowedTools, undefined);
  runner.finishAll({ status: 'closed', response: 'ok', sessionId: 'sess-deny-1' });
  await waitFor(() => ['closed', 'idle'].includes(records.get(h.subagentId).status));
});

test('schema 提取成功：response 围栏 JSON → record.structured + 通知注明「已提取结构化输出」（SUGGESTION-4）', async () => {
  const c = ctx();
  const { manager, runner, records } = buildManager();
  const fenced = '前置说明\n```json\n{"verdict":"pass","issues":[]}\n```\n后置';
  setTimeout(() => runner.finishAll({ status: 'closed', response: fenced, sessionId: 'sess-schema-1' }), 20);
  const res = await manager.start(
    { task: '审查并输出 JSON', slug: 'schema-ok', schema: '输出 {"verdict":"pass|fail"}', wait: true },
    c,
  );
  assert.equal(res.status, 'closed');
  assert.deepEqual(res.structured, { verdict: 'pass', issues: [] }); // wait 返回值带 structured
  const rec = records.get(res.subagentId);
  assert.deepEqual(rec.structured, { verdict: 'pass', issues: [] }); // record 落盘
  assert.equal(rec.schemaParseFailed, undefined);
  const env = readEnvelopes(c.targetSessionId).at(-1);
  assert.ok(env.content.includes('已提取结构化输出'), '通知文案注明提取成功');
  assert.ok(!env.content.includes('未符合 schema 契约'));
});

test('schema 提取失败：无 JSON → record.schemaParseFailed + 通知提示契约未符；无 schema 任务不受影响', async () => {
  const c = ctx();
  const { manager, runner, records } = buildManager();
  setTimeout(() => runner.finishAll({ status: 'closed', response: '纯文本回答没有 JSON', sessionId: 'sess-schema-2' }), 20);
  const res = await manager.start(
    { task: '自由回答', slug: 'schema-bad', schema: { type: 'object' }, wait: true },
    c,
  );
  assert.equal(res.status, 'closed');
  assert.equal(res.schemaParseFailed, true);
  const rec = records.get(res.subagentId);
  assert.equal(rec.schemaParseFailed, true);
  assert.equal(rec.structured, undefined);
  const env = readEnvelopes(c.targetSessionId).at(-1);
  assert.ok(env.content.includes('未符合 schema 契约'), '通知提示契约未符');
  assert.ok(env.content.includes(rec.outputFile), '全文指针兜底');
  assert.ok(!env.content.includes('已提取结构化输出'));

  // 对照：无 schema 声明的任务不提取、文案无 schema 回执行
  const c2 = ctx();
  setTimeout(() => runner.finishAll({ status: 'closed', response: '直接结论', sessionId: 'sess-schema-3' }), 20);
  const res2 = await manager.start({ task: '无 schema 任务', slug: 'schema-none', wait: true }, c2);
  assert.equal(res2.structured, undefined);
  assert.equal(records.get(res2.subagentId).schemaParseFailed, undefined);
  const env2 = readEnvelopes(c2.targetSessionId).at(-1);
  assert.ok(!env2.content.includes('schema 契约'));
  assert.ok(!env2.content.includes('已提取结构化输出'));
});

// ------------------------------------------- 双池隔离与排队期取消（补边界）

test('recordType 越界：wf record 不经 zsub 面 status/cancel/close（_mustGet 校验）', async () => {
  const { manager, records } = buildManager();
  const wf = 'wf-test0001';
  records.create({ subagentId: wf, recordType: 'workflow', slug: 'chain', task: 'x', status: 'created' });
  for (const fn of [
    async () => manager.status(wf),
    () => manager.cancel(wf),
    () => manager.close(wf),
  ]) {
    await assert.rejects(fn, (err) => /workflow record，不经 zsub/.test(err.message)
      && err.message.includes(`node "${ZSW_CLI}" workflow --action`));
  }
  // record 未被越界改写（终态化/transition 都没发生）
  assert.equal(records.get(wf).status, 'created');
});

test('recover：共享 store 的 workflow record 不进 subagent 探活循环', async () => {
  const { manager, records } = buildManager();
  const wf = 'wf-test0002';
  // wf record 非终态且无 exec：若不过滤会被误判死进程 + 写入 lostReason update
  records.create({ subagentId: wf, recordType: 'workflow', slug: 'parallel', task: 'x', status: 'running' });
  const rec = await manager.recover();
  assert.ok(!rec.dead.includes(wf), 'wf record 不进 dead 名单');
  assert.ok(!rec.orphan.includes(wf));
  assert.equal(records.get(wf).lostReason, undefined, '事件流未被 subagent 语义的 lostReason 污染');
});

// ------------------------------------- exec 异步回填 pid 持久化（A5 回归）

/**
 * 模拟 core 引擎形态的 fake runner：start 返回的 exec 无 pid，异步分阶段
 * 回填 engineId → pid 并回调 hooks.onExec 快照——钉「running 转换事件落盘的
 * exec 无 pid 时，pid 就绪必须追加 update 事件」的持久化通道（standby 从
 * 磁盘 rebuild 后 alive 探活的依据；e2e-daemon A5 红 1 的根因形态）。
 */
class AsyncExecPidRunner {
  constructor() {
    this.startCalls = 0;
    this.livePids = new Set();
    this._resolveDone = null;
    this.exec = null;
  }
  capabilities() { return { kind: 'spawn', steering: 'none', coldStartMs: 0 }; }
  start(taskCtx, hooks = {}) {
    this.startCalls += 1;
    const exec = { kind: 'spawn', pid: undefined, sessionId: undefined, engineId: undefined, cwd: taskCtx.cwd };
    this.exec = exec;
    // 快照通道契约：record.exec 被 update 快照替换后不再共享本引用——所有
    // 回填点（含 done 前 sessionId）都必须经 onExec 通知，同真 CoreRunner
    this._hooks = hooks;
    const pid = 41000 + this.startCalls;
    const notify = () => { if (hooks.onExec) hooks.onExec({ ...exec }); };
    // 引擎异步 prepare（路由）→ spawn 两阶段回填，与 CoreRunner 真实时序同构：
    // start() 同步返回后 pid 才出现（exec 对象变异）
    setTimeout(() => { exec.engineId = 'zcode'; notify(); }, 5);
    setTimeout(() => { exec.pid = pid; this.livePids.add(pid); notify(); }, 15);
    const done = new Promise((res) => { this._resolveDone = res; });
    return { exec, cancel: () => this._resolveDone({ status: 'cancelled', response: '' }), done };
  }
  /** 对齐 CoreRunner 语义：done 前 sessionId 回填并经 onExec 通知落盘。 */
  finish(result) {
    if (result && result.sessionId && this.exec) {
      this.exec.sessionId = result.sessionId;
      if (this._hooks && this._hooks.onExec) this._hooks.onExec({ ...this.exec });
    }
    this._resolveDone(result);
  }
  alive(x) { return Boolean(x && this.livePids.has(x.pid)); }
}

test('exec 异步回填 pid：running 事件无 pid 时追加 update 事件，磁盘 rebuild 后 alive 可判（A5 回归）', async () => {
  const c = ctx();
  const runner = new AsyncExecPidRunner();
  const { manager, records } = buildManager({ runner });
  const h = await manager.start({ task: '长任务书', slug: 'async-pid' }, c);

  // running 转换事件已落盘，且其序列化的 exec 无 pid（JSON 丢 undefined——
  // 与真 core 引擎「transition 先于 spawn」的时序一致，即 A5 红 1 场景）
  await waitFor(() => records.get(h.subagentId).status === 'running');
  const events = () => fs.readFileSync(recordsPath(), 'utf8').trim().split('\n')
    .filter((l) => l !== '').map((l) => JSON.parse(l));
  const runningEv = events().find((e) => e.type === 'transition' && e.to === 'running');
  assert.ok(runningEv, 'running 转换事件已落盘');
  assert.ok(!(runningEv.exec && Number.isInteger(runningEv.exec.pid)),
    'running 事件序列化时 exec 无 pid（异步 spawn 形态，测试前提成立）');

  // pid 就绪 → 必须追加 update 事件（磁盘获得 pid）
  await waitFor(() => {
    const r = records.get(h.subagentId);
    return r && r.exec && Number.isInteger(r.exec.pid) ? r : null;
  });
  assert.ok(events().some((e) => e.type === 'update' && e.exec && Number.isInteger(e.exec.pid)),
    'pid 就绪后必须追加含 pid 的 update 事件（standby 探活的磁盘依据）');

  // standby 形态：全新 RecordStore 从磁盘 rebuild，fold 后 exec.pid 可判活
  const store2 = new RecordStore();
  store2.rebuildFromLog();
  const rec2 = store2.get(h.subagentId);
  assert.ok(rec2 && Number.isInteger(rec2.exec && rec2.exec.pid), 'rebuild 后 record.exec.pid 必须存在');
  assert.equal(runner.alive(rec2.exec), true, 'rebuild 后 alive 判活（orphan/dead 分流前提）');

  // 收尾：任务完成终态化（终态 exec 重写含全字段）
  runner.finish({ status: 'closed', response: 'ok', sessionId: 'sess-async-pid' });
  const fin = await waitFor(() => {
    const r = records.get(h.subagentId);
    return r && r.status === 'closed' ? r : null;
  });
  assert.equal(fin.exec.sessionId, 'sess-async-pid', '终态 exec 重写含 sessionId');
  assert.equal(fin.exec.pid, 41001, '终态 exec 重写保住 pid');
});

test('conversation 首轮 wait=true 返回 rounds=1；续聊入口报错不动 record（E3 回归）', async () => {
  const c = ctx();
  const { manager, runner, records } = buildManager();
  setTimeout(() => runner.finishAll({ status: 'closed', response: '首轮回答', sessionId: 'sess-rounds-1' }), 20);
  const res = await manager.start(
    { task: '对话任务书', slug: 'chat-rounds', conversation: true, wait: true },
    c,
  );
  assert.equal(res.status, 'idle', 'conversation 首轮完成终态 idle（非 closed）');
  assert.equal(res.rounds, 1, 'wait=true 投影必须带完成计数（E3 断言面，此前缺字段）');

  // 续聊执行线已移除（P3 回归）：入口即报明确 unavailable——record 停在
  // idle、rounds 维持 1，「成功完成的轮数」语义不受影响（无轮产生即无计数扰动）
  await assert.rejects(() => manager.message(res.subagentId, '追问'), /续聊暂不可用/);
  assert.equal(records.get(res.subagentId).status, 'idle', '入口报错不翻转 record');
  assert.equal(records.get(res.subagentId).rounds, 1, '报错不计入完成数');
});

test('排队期 cancel：槽位占满时取消 → 零 spawn 直接终态化', async () => {
  // 阻塞 slots：第一次 acquire 挂起（占满），手动放行
  let releaseFirst;
  const gate = new Promise((r) => { releaseFirst = r; });
  let acquired = 0;
  const state = { running: 0 };
  const slots = {
    async acquire() {
      acquired += 1;
      if (acquired === 1) { await gate; return () => {}; } // 第一个调用方排队等待
      return () => {};
    },
    running: () => state.running,
  };
  const { manager, runner, records } = buildManager({ slots });
  const c = ctx();
  const h = await manager.start({ task: '排队任务的命运', slug: 'queued-cancel' }, c);
  assert.equal(records.get(h.subagentId).status, 'created'); // 尚未拿到槽位
  const fin = await manager.cancel(h.subagentId);
  assert.equal(fin.cancelled, true);
  assert.match(fin.note, /排队中被取消，进程未启动/);
  assert.equal(runner.startCalls.length, 0, '零 spawn：进程从未启动');
  // 放行槽位：执行体自查终态后安静退出（不抛、不 transition）
  releaseFirst();
  await manager.pending.get(h.subagentId);
  assert.equal(records.get(h.subagentId).status, 'cancelled');
});

// ---------------------------------------------- R2：同 id 操作串行化（_withLock）

test('同 id 操作串行化：close 的 await 窗口内并发 message 不越序，record 不被再起轮', async () => {
  const c = ctx();
  const worktree = {
    async prepare() { return { dir: '/fake/wt', branch: 'zsub/x', mainRepo: '/fake' }; },
    async collectPatch() { return null; },
    cleanup: () => new Promise((r) => setTimeout(r, 30)), // 拉长 close 的 await 窗口
  };
  const { manager, runner, records } = buildManager({ worktree });
  // conversation + worktree 任务，首轮完成后停在 idle 且带 worktree 字段
  const h = await manager.start({ task: '对话任务书', slug: 'serial-demo', conversation: true, worktree: true }, c);
  await waitFor(() => runner.startCalls.length === 1);
  runner.finishAll({ status: 'closed', response: '首轮', sessionId: 'sess-serial-1' });
  await waitFor(() => records.get(h.subagentId).status === 'idle');

  const closeP = manager.close(h.subagentId); // 先进入：idle→closed 后卡在 cleanup await
  await sleep(5);
  await assert.rejects(() => manager.message(h.subagentId, '迟到的消息'), /仅 idle 可投递|不是 conversation/);
  await closeP;
  const rec = records.get(h.subagentId);
  assert.equal(rec.status, 'closed', '终态 closed，未被迟到的 message 再起轮');
});

test('_withLock：同 id 排队按到达序执行，链空自清，不同 id 并行', async () => {
  const { manager } = buildManager();
  const order = [];
  let gate;
  const gated = new Promise((r) => { gate = r; });
  const a = manager._withLock('sa-lock', async () => { order.push('a-start'); await gated; order.push('a-end'); });
  const b = manager._withLock('sa-lock', async () => { order.push('b'); });
  const c2 = manager._withLock('sa-other', async () => { order.push('c'); });
  await sleep(10);
  assert.deepEqual(order, ['a-start', 'c'], '同 id 的 b 排队等待，不同 id 的 c 并行');
  gate();
  await Promise.all([a, b, c2]);
  assert.deepEqual(order, ['a-start', 'c', 'a-end', 'b'], 'a 完成后 b 才执行');
  assert.equal(manager._locks.size, 0, '链空自清');
});

// -------------------------------------- F4 能力增量：thinking 标注 / errorKind 透传

/** capabilities.kind 可覆盖的 FakeRunner（thinking 标注按实际通道判定，需模拟两通道）。 */
function runnerWithKind(kind) {
  const runner = new FakeRunner();
  runner.capabilities = () => ({ kind, steering: 'none', coldStartMs: 0 });
  return runner;
}

test('thinking 标注矩阵：runner 回填优先 / spawn 单轮降级 / 未请求不落字段', async () => {
  // 返回终态 record（不是 boolean）——本测试直接断言返回值的 thinking 字段。
  // 2c 后唯一通道是 core 引擎 spawn 单轮：runner 无 thinking 回填面（appserver
  // 通道退役），但「RunResult.thinking 回填优先」的字段契约保留（未来引擎
  // 提供档位回填时零改动生效）
  const settle = (records, id) =>
    waitFor(() => {
      const r = records.get(id);
      return r && ['closed', 'idle'].includes(r.status) ? r : null;
    });

  // ① runner 回填实际档位优先：请求 low，runner 确认 high（创建时落请求值，
  //    终态覆盖为实际生效值——status 查询全程有观测面）
  {
    const runner = runnerWithKind('spawn');
    const { manager, records } = buildManager({ runner });
    const h = await manager.start({ task: '任务书', slug: 'think-ok', thinking: 'low' }, ctx());
    assert.equal(records.get(h.subagentId).thinking, 'low', '创建时落请求值（运行中可观测）');
    runner.finishAll({ status: 'closed', response: 'ok', thinking: 'high' });
    const rec = await settle(records, h.subagentId);
    assert.equal(rec.thinking, 'high', 'runner 回填的实际档位优先于请求值');
  }
  // ② spawn 单轮请求了 thinking：runner 无回填 → 'null (请求未生效：引擎
  //    通道未映射)'（无 flag 通道的字面标注；appserver 非法跳过的 null 分支
  //    随通道退役不可达）
  {
    const runner = runnerWithKind('spawn');
    const { manager, records } = buildManager({ runner });
    const h = await manager.start({ task: '任务书', slug: 'think-degraded', thinking: 'low' }, ctx());
    runner.finishAll({ status: 'closed', response: 'ok' });
    const rec = await settle(records, h.subagentId);
    assert.equal(rec.thinking, 'null (请求未生效：引擎通道未映射)');
  }
  // ③ 未请求 thinking：不落字段（undefined）
  {
    const runner = runnerWithKind('spawn');
    const { manager, records } = buildManager({ runner });
    const h = await manager.start({ task: '任务书', slug: 'think-none' }, ctx());
    runner.finishAll({ status: 'closed', response: 'ok' });
    const rec = await settle(records, h.subagentId);
    assert.equal(rec.thinking, undefined);
  }
});

test('thinking 标注：conversation 首轮回填值随 idle 终态保留（会话级设置）', async () => {
  const runner = runnerWithKind('appserver');
  const { manager, runner: r, records } = buildManager({ runner });
  const h = await manager.start(
    { task: '对话任务书', slug: 'think-chat', thinking: 'low', conversation: true },
    ctx(),
  );
  r.finishAll({ status: 'closed', response: '首轮', thinking: 'low', sessionId: 'sess-think-1' });
  await waitFor(() => records.get(h.subagentId).status === 'idle');
  assert.equal(records.get(h.subagentId).thinking, 'low');
});

test('errorKind 透传（F1 移交）：protocol-drift 分类以独立字段落 record', async () => {
  const { manager, runner, records } = buildManager();
  setTimeout(() => runner.finishAll({
    status: 'error', error: '协议漂移: -32602', errorKind: 'protocol-drift', response: '',
  }), 20);
  const res = await manager.start({ task: '漂移任务书', slug: 'drift-kind', wait: true }, ctx());
  assert.equal(res.status, 'error');
  const rec = records.get(res.subagentId);
  assert.equal(rec.errorKind, 'protocol-drift', '错误分类独立字段可查询（不必从 error 文案反推）');
  assert.equal(rec.status, 'error');

  // 对照：无 errorKind 的普通错误不落该字段
  const { manager: m2, runner: r2, records: rec2 } = buildManager();
  setTimeout(() => r2.finishAll({ status: 'error', error: '普通失败', response: '' }), 20);
  const res2 = await m2.start({ task: '普通失败任务书', slug: 'plain-err', wait: true }, ctx());
  assert.equal(rec2.get(res2.subagentId).errorKind, undefined);
});

test('F4 工具限制未生效标注（G6 对称）：spawn+请求了 allowlist → toolsNote；deny-only / appserver / 未请求 → 不落', async () => {
  const settle = (records, id) =>
    waitFor(() => {
      const r = records.get(id);
      return r && ['closed', 'idle'].includes(r.status) ? r : null;
    });

  // ① spawn 回退通道请求了 allowlist：无白名单 flag 通道 → 静默失效，toolsNote 如实标注
  {
    const runner = runnerWithKind('spawn');
    const { manager, runner: r, records } = buildManager({ runner });
    const h = await manager.start(
      { task: '任务书', slug: 'tools-degraded', allowTools: ['Read'], denyTools: ['Bash'] },
      ctx(),
    );
    r.finishAll({ status: 'closed', response: 'ok' });
    const rec = await settle(records, h.subagentId);
    assert.equal(rec.toolsNote, 'null (工具限制未生效：引擎通道未映射)', 'allow 白名单失效必须可见');
  }
  // ② appserver 通道请求了工具限制：正常消费（create 面），不落降级标注
  {
    const runner = runnerWithKind('appserver');
    const { manager, runner: r, records } = buildManager({ runner });
    const h = await manager.start({ task: '任务书', slug: 'tools-apc', allowTools: ['Read'] }, ctx());
    r.finishAll({ status: 'closed', response: 'ok' });
    const rec = await settle(records, h.subagentId);
    assert.equal(rec.toolsNote, undefined, 'appserver 通道无 toolsNote');
  }
  // ③ spawn 通道未请求工具限制：无失效面，不落字段
  {
    const runner = runnerWithKind('spawn');
    const { manager, runner: r, records } = buildManager({ runner });
    const h = await manager.start({ task: '任务书', slug: 'tools-none' }, ctx());
    r.finishAll({ status: 'closed', response: 'ok' });
    const rec = await settle(records, h.subagentId);
    assert.equal(rec.toolsNote, undefined, '未请求 tools 不落 toolsNote');
  }
  // ④ spawn 通道仅请求 denylist：deny 并集在 runner-core 侧去重后落引擎
  // --disallowed-tools 硬生效，无失效面——落「未生效」标注即失真，不得标
  {
    const runner = runnerWithKind('spawn');
    const { manager, runner: r, records } = buildManager({ runner });
    const h = await manager.start({ task: '任务书', slug: 'tools-deny-only', denyTools: ['Bash'] }, ctx());
    r.finishAll({ status: 'closed', response: 'ok' });
    const rec = await settle(records, h.subagentId);
    assert.equal(rec.toolsNote, undefined, 'deny-only 硬生效，不得失真标注为未生效');
  }
});

test('F4 CLI 工具限制透传 taskCtx（appserver runner 侧做 frontmatter 并集）', async () => {
  const { manager, runner } = buildManager();
  await manager.start(
    { task: '任务书', slug: 'cli-tools', allowTools: ['Read', ' Grep '], denyTools: ['Bash', ''] },
    ctx(),
  );
  await waitFor(() => runner.startCalls.length === 1);
  const taskCtx = runner.startCalls[0];
  assert.deepEqual(taskCtx.toolAllowlist, ['Read', 'Grep'], '规范化（trim）后透传');
  assert.deepEqual(taskCtx.toolDenylist, ['Bash'], '空段过滤后透传');
  // frontmatter disallowedTools 仍按原字段透传（spawn 通道既有路径不回归）
  const restricted = {
    name: 'restricted2', description: '', filePath: '/fake/r2.md', body: '正文',
    disallowedTools: ['WebSearch'],
  };
  const { manager: m2, runner: r2 } = buildManager({
    resolver: { resolve: (n) => (n === '/fake/r2.md' ? restricted : null), resolveDefault: () => null },
  });
  await m2.start(
    { task: '任务书', slug: 'fm-tools', agent: '/fake/r2.md', denyTools: ['Bash'] },
    ctx(),
  );
  await waitFor(() => r2.startCalls.length === 1);
  assert.deepEqual(r2.startCalls[0].disallowedTools, ['WebSearch']);
  assert.deepEqual(r2.startCalls[0].toolDenylist, ['Bash']);
  // 并集去重断言在 appserver.test.js（runner 组 create 面）——此处只钉 manager 透传
});
