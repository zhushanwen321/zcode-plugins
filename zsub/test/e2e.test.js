'use strict';

/**
 * 无头真机 e2e（DESIGN-v3 §4.1）：真实 zcode.cjs + 真实模型（GLM-4.7-Flash）。
 *
 * 与单测的隔离差异（为什么 env 这么设）：
 * - ZSUB_ROOT / ZCODE_MAILBOX_ROOT 指临时目录：records/outputs/home 池/mailbox
 *   全部隔离，绝不碰真实 ~/.zcode/zsub 与真实 mailbox。
 * - HOME 刻意【不】改：config.V2_CONFIG_PATH 在模块加载期冻结自真实 HOME，
 *   bootstrapIsolatedHome 要从那里读 provider 凭据（改了 HOME 就没有真实凭据，
 *   所有模型调用必挂）。user 级 agent 根的隔离改走 resolver 注入临时 homeDir。
 * - ZCODE_MESSAGE_ENABLED=1：激活 mailbox 档（E2/E3 投递断言的前提）。
 *
 * 成本纪律：task 文本极简；每场景 1-2 次真实调用封顶；E4/E6/E8 零调用。
 * 大模型侧账户级限流（429/1302）会让 CLI 长退避重试、表现为 timeout——
 * startWithRetry 对可重试失败统一退避重试，实际重试次数在结尾汇总输出。
 */

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const REPO = path.resolve(__dirname, '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-e2e-'));
process.env.ZSUB_ROOT = path.join(TMP, 'zsub-root');
process.env.ZCODE_MAILBOX_ROOT = path.join(TMP, 'mailbox');
process.env.ZCODE_MESSAGE_ENABLED = '1';

// env 隔离完成后才 require lib（config.js 模块加载期冻结 V2_CONFIG_PATH）
const { assembleManager } = require('../lib/assemble');
const { AgentMdResolver } = require('../lib/agent-md-resolver');
const AppServerRunner = require('../lib/runner-appserver');
const driver = require('../lib/driver');

const MODEL = 'GLM-4.7-Flash';
const USER_HOME = path.join(TMP, 'user-home'); // 隔离 user 级 agent 根（不读真实 HOME）
// 限流实测（2026-08-23）：账户分钟级 RPM 窗口，连续调用必撞 429；CLI 内部长退避
// 重试 ~2 分钟内可挤过。CALL_MS 给足内部重试窗口；GAP_MS 场景间错峰。
const GAP_MS = Number(process.env.ZSUB_E2E_GAP_MS || 20000);
const RETRY_WAIT_MS = Number(process.env.ZSUB_E2E_RETRY_WAIT_MS || 45000);
const RETRY_MAX = Number(process.env.ZSUB_E2E_RETRY_MAX || 2);
const CALL_MS = 150_000;

/** 真实模型调用审计：结尾汇总（预算回溯用）。 */
const CALLS = { starts: 0, retries: 0, messages: 0, killedBeforeFlight: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkEmptyUserHome = () => fs.mkdirSync(path.join(USER_HOME, '.agents', 'agents'), { recursive: true });

/** 组装 manager：user 级 agent 根注入临时 HOME（四根发现的 3/4 根指向空目录）。 */
function buildManager(opts = {}) {
  return assembleManager({ resolver: new AgentMdResolver({ homeDir: USER_HOME }), ...opts });
}

/** 轮询等待：fn 返回真值即返回该值。 */
async function waitFor(fn, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await sleep(stepMs);
  }
}

/** 终态判定（wait=true 的 start 返回 + record 通用）。 */
const isTerminal = (s) => ['closed', 'idle', 'cancelled', 'error', 'timeout', 'lost'].includes(s);

/**
 * 大模型限流等瞬时失败的统一重试封装（start/wait=true 路径）。
 * 限流实测（2026-08-23）：同账户桌面端 ZCode 持续消耗配额，「窗口」开关式
 * ——开了连续调用全过（run2 全量 7 连发 188s 全绿），关了怎么都撞。故
 * waitForQuotaWindow 先探测窗口，开了再连续跑（场景间仅短 gap）。
 */
async function waitForQuotaWindow() {
  const home = path.join(TMP, 'quota-probe-home');
  driver.bootstrapIsolatedHome(home, 'builtin:bigmodel-coding-plan/GLM-4.7-Flash');
  for (let i = 1; i <= 8; i++) {
    CALLS.starts += 1;
    const t0 = Date.now();
    const r = await driver.runHeadless({
      home,
      cwd: TMP,
      prompt: '回复：ok。不要做任何其他事。',
      timeoutMs: 120_000,
    });
    console.error(`[e2e] 配额窗口探测 #${i}: status=${r.status} elapsed=${Date.now() - t0}ms`);
    if (r.status === 'closed') return true;
    CALLS.retries += 1;
    await sleep(45_000);
  }
  return false;
}

async function startWithRetry(manager, params, ctx) {
  let res;
  for (let i = 0; ; i++) {
    CALLS.starts += 1;
    res = await manager.start({ timeoutMs: CALL_MS, ...params, wait: true }, ctx);
    if (res.status === 'closed' || res.status === 'idle') return res;
    const transient = /rate_limit|1302|429|超时|timeout|Turn execution failed/i.test(res.error || '');
    if (!transient || i >= RETRY_MAX) return res;
    CALLS.retries += 1;
    console.error(`[e2e] 第 ${i + 1} 次尝试失败（${(res.error || '').slice(0, 120)}），${RETRY_WAIT_MS}ms 后重试`);
    await sleep(RETRY_WAIT_MS);
  }
}

/** 读某会话 mailbox unread 下的全部 envelope（文件名字典序 = 引擎 drain 序）。 */
function readEnvelopes(sessionId) {
  const dir = path.join(process.env.ZCODE_MAILBOX_ROOT, sessionId, 'unread');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ name: f, body: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

function git(repoDir, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repoDir, ...args], { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

/** 无投递（目录不存在）安全计数：cancelled 等场景 mailbox 目录从未创建。 */
function envelopeCountSafe(sessionId) {
  try { return readEnvelopes(sessionId).length; } catch { return 0; }
}

/** E6 的「server 进程」脚本：真实 start bg 后保活，等测试进程 SIGKILL 模拟崩溃。 */
function writeE6ServerScript() {
  const script = path.join(TMP, 'e6-server.cjs');
  fs.writeFileSync(script, `'use strict';
const { assembleManager } = require(${JSON.stringify(path.join(REPO, 'lib', 'assemble'))});
const { AgentMdResolver } = require(${JSON.stringify(path.join(REPO, 'lib', 'agent-md-resolver'))});
(async () => {
  const { manager } = assembleManager({
    resolver: new AgentMdResolver({ homeDir: ${JSON.stringify(USER_HOME)} }),
  });
  const h = await manager.start(
    { task: '从 1 逐个数到 1000000，不要停', slug: 'e6-crash', model: '${MODEL}', timeoutMs: 60000 },
    { cwd: ${JSON.stringify(path.join(TMP, 'e6-proj'))}, targetSessionId: 'sess_e6_crash' },
  );
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const rec = manager.status(h.subagentId);
    if (rec && rec.exec && rec.exec.pid) {
      console.log('READY ' + h.subagentId + ' ' + rec.exec.pid);
      setInterval(() => {}, 5000); // 保活：等待被 SIGKILL
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  console.log('TIMEOUT_NO_PID');
  process.exit(3);
})().catch((e) => { console.log('SRV_ERR ' + (e && e.message)); process.exit(4); });
`);
  return script;
}

before(async () => {
  mkEmptyUserHome();
  fs.mkdirSync(path.join(TMP, 'e1-proj', '.agents', 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(TMP, 'e1-proj', '.agents', 'agents', 'tester.md'),
    '---\nname: tester\ndescription: e2e 测试员\n---\n你是测试员。收到任何任务，先复述口令：菠萝啤。然后完成任务。\n',
  );
  fs.mkdirSync(path.join(TMP, 'e6-proj'), { recursive: true });
  // 配额窗口探测：窗口不开就跑必然全撞限流（真机环境实测），探测本身计数审计
  const ok = await waitForQuotaWindow();
  if (!ok) {
    throw new Error('模型配额窗口等待超时（8 次探测均失败）——同账户桌面端持续占用或配额耗尽，稍后重跑');
  }
});

after(() => {
  console.error(`[e2e] 模型调用审计: start=${CALLS.starts}（重试 ${CALLS.retries}）message=${CALLS.messages} killed-before-flight=${CALLS.killedBeforeFlight}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// ------------------------------------------------------------------ E1

test('E1 sync start + agent 注入：tester 正文进 prompt，回复含口令「菠萝啤」', async () => {
  const { manager } = buildManager();
  const res = await startWithRetry(manager, {
    task: '报告就绪',
    slug: 'e1-agent-inject',
    agent: 'tester',
    model: MODEL,
  }, { cwd: path.join(TMP, 'e1-proj'), targetSessionId: 'sess_e1' });

  assert.equal(res.status, 'closed', `失败详情: ${res.error}`);
  assert.ok(res.result.includes('菠萝啤'), `角色正文未注入 prompt，response=${JSON.stringify(res.result)}`);
  const rec = manager.status(res.subagentId);
  assert.equal(rec.agent, 'tester'); // resolver 命中项目级 .agents/agents（user 根为空）
  await sleep(GAP_MS);
});

// ------------------------------------------------------------------ E2

test('E2 mailbox 文件级投递：bg 完成后 unread/ 有合法 envelope', async () => {
  const TARGET = 'sess_e2etest-abc'; // 匹配引擎 drain 的 /^sess_[A-Za-z0-9._-]+$/
  const { manager } = buildManager();
  // bg + 429 容错：失败限流则重开一个 bg（计数进 CALLS）
  let id = null;
  for (let i = 0; ; i++) {
    CALLS.starts += 1;
    const h = await manager.start(
      { task: '回复：暗号西瓜绿。不要做任何其他事。', slug: 'e2-mailbox', model: MODEL, timeoutMs: CALL_MS },
      { cwd: path.join(TMP, 'e1-proj'), targetSessionId: TARGET },
    );
    assert.equal(h.status, 'running');
    assert.equal(h.notify, 'mailbox');
    assert.equal(h.guidance, undefined);
    id = h.subagentId;
    const rec = await waitFor(() => {
      const r = manager.status(id);
      return isTerminal(r.status) ? r : null;
    }, CALL_MS + 20_000);
    if (rec.status === 'closed' || i >= 1) break;
    CALLS.retries += 1;
    console.error(`[e2e] E2 bg 失败（${rec.error || ''}），重开一个`);
    await sleep(RETRY_WAIT_MS);
  }
  const fin = manager.status(id);
  assert.equal(fin.status, 'closed', `bg 终态: ${fin.status} ${fin.error || ''}`);
  assert.equal(fin.notified, true);
  assert.ok(fin.sessionId, 'spawn 模式 done 后回填 sessionId');

  const envelopes = readEnvelopes(TARGET);
  assert.equal(envelopes.length, 1);
  const { name, body } = envelopes[0];
  // Z8 六字段 + version 数字 1 + 单调文件名 <13位epoch>-<6位seq>-<id>.json
  assert.match(name, /^\d{13}-\d{6}-sa-[a-f0-9]+\.json$/);
  assert.equal(body.version, 1);
  for (const k of ['messageId', 'fromSessionId', 'toSessionId', 'content', 'createdAt']) {
    assert.equal(typeof body[k], 'string', `envelope.${k} 必须 string`);
  }
  assert.equal(body.toSessionId, TARGET);
  assert.ok(body.content.includes('[subagent 完成]'));
  assert.ok(body.content.includes(fin.outputFile), '通知文案必须含 outputs 全文路径');
  // 无 tmp 残留（原子写证据）
  const files = fs.readdirSync(path.join(process.env.ZCODE_MAILBOX_ROOT, TARGET, 'unread'));
  assert.ok(files.every((f) => !f.includes('.tmp')), `tmp 残留: ${files}`);
  await sleep(GAP_MS);
});

// ------------------------------------------------------------------ E3

test('E3 conversation resume：两轮同 session，第二轮答出第一轮暗号', async () => {
  const { manager } = buildManager();
  const ctxv = { cwd: path.join(TMP, 'e1-proj'), targetSessionId: 'sess_e2etest-abc' }; // 与 E2 同 target：顺带验证跨投递文件名单调
  const res = await startWithRetry(manager, {
    task: '记住暗号：紫葡萄。只回复：收到',
    slug: 'e3-conversation',
    conversation: true,
    model: MODEL,
  }, ctxv);
  assert.equal(res.status, 'idle', `首轮失败: ${res.error}`); // conversation 首轮完成 → idle（非 closed）

  await sleep(GAP_MS); // message 轮无重试钩子（resume 失败即终态），投递前错峰限流窗口
  CALLS.messages += 1;
  const r = await manager.message(res.subagentId, '暗号是什么？只回复暗号本身。');
  assert.equal(r.status, 'running');
  const fin = await waitFor(() => {
    const rec = manager.status(res.subagentId);
    return rec.status === 'idle' || rec.status === 'error' ? rec : null;
  }, CALL_MS + 20_000);
  assert.equal(fin.status, 'idle', `续聊轮失败: ${fin.error}`);
  assert.equal(fin.rounds, 2, 'rounds=完成轮数（首轮+续聊）');
  const round2 = fs.readFileSync(fin.outputFile, 'utf8');
  assert.ok(round2.includes('紫葡萄'), `第二轮未答出暗号: ${JSON.stringify(round2.slice(0, 200))}`);

  // E2+E3 同 target 共 3 封，文件名字典序单调（Z8 规范 3）
  const names = readEnvelopes('sess_e2etest-abc').map((e) => e.name);
  assert.equal(names.length, 3);
  assert.deepEqual(names, [...names].sort(), '文件名字典序必须单调（drain 顺序 = 投递顺序）');
  await sleep(GAP_MS);
});

// ------------------------------------------------------------------ E4

test('E4 cancel：bg 立即取消，record cancelled 且无残留进程', async () => {
  const { manager } = buildManager();
  const h = await manager.start(
    { task: '从 1 逐个数到 1000000，不要停', slug: 'e4-cancel', model: MODEL, timeoutMs: 120_000 },
    { cwd: path.join(TMP, 'e1-proj'), targetSessionId: 'sess_e4' },
  );
  const rec = await waitFor(() => {
    const r = manager.status(h.subagentId);
    return r.exec && r.exec.pid ? r : null;
  }, 10_000);
  const pid = rec.exec.pid;

  const out = await manager.cancel(h.subagentId);
  assert.equal(out.cancelled, true);
  assert.equal(manager.status(h.subagentId).status, 'cancelled');

  // SIGTERM 优雅退出可能超 200ms（收尾钩子）；轮询 ps 直到该 pid 消失或已
  // 非 zcode.cjs（本机 pid 高复用环境下 kill(pid,0) 有假阳性——几 ms 窗口内
  // pid 可被无关短命进程复用，ps 命令行是权威判据）。上限 = killGraceMs + 1s。
  const deadline = Date.now() + 6_000;
  let cmd = 'unknown';
  while (Date.now() < deadline) {
    cmd = await psCommandOf(pid);
    if (cmd === null || !cmd.includes('zcode.cjs')) break;
    await sleep(100);
  }
  assert.ok(cmd === null || !cmd.includes('zcode.cjs'), `pid ${pid} 仍存活 zcode.cjs: ${cmd}`);
  assert.equal(manager.notifier.capabilities().mode, 'mailbox');
  assert.equal(envelopeCountSafe('sess_e4'), 0, 'cancelled 不投递');
});

/** ps 查某 pid 的 command 行；进程不存在返回 null（ps 权威判据）。 */
function psCommandOf(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

// ------------------------------------------------------------------ E5

test('E5 worktree：主树干净、patch 可 apply、close 后无 worktree 残留', async () => {
  const repo = path.join(TMP, 'e5-repo');
  fs.mkdirSync(repo, { recursive: true });
  await git(repo, ['init', '-q']);
  await git(repo, ['-c', 'user.email=zsub@e2e.test', '-c', 'user.name=zsub-e2e', 'add', '-A']);
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['-c', 'user.email=zsub@e2e.test', '-c', 'user.name=zsub-e2e', 'commit', '-q', '-m', 'init']);

  const { manager } = buildManager();
  const res = await startWithRetry(manager, {
    task: '在当前目录创建 hello.txt 文件，内容为 hi。不要做任何其他事。',
    slug: 'e5-worktree',
    worktree: true,
    model: MODEL,
  }, { cwd: repo, targetSessionId: 'sess_e5' });
  assert.equal(res.status, 'closed', `worktree 任务失败: ${res.error}`);

  assert.equal((await git(repo, ['status', '--porcelain'])).trim(), '', '主树必须干净');
  assert.ok(res.patchFile, '返回值必须带 patchFile');
  assert.ok(fs.existsSync(res.patchFile));
  const patchText = fs.readFileSync(res.patchFile, 'utf8');
  assert.ok(patchText.includes('hello.txt'), `patch 未包含新增文件:\n${patchText.slice(0, 400)}`);
  await git(repo, ['apply', '--check', res.patchFile]); // 基线可应用性

  const closed = await manager.close(res.subagentId);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.worktreeCleaned, true, `worktree 清理失败: ${closed.worktreeError}`);
  const wts = (await git(repo, ['worktree', 'list', '--porcelain'])).split('\n')
    .filter((l) => l.startsWith('worktree '));
  assert.equal(wts.length, 1, `worktree 残留: ${wts.join(' | ')}`);
  assert.ok(!fs.existsSync(manager.status(res.subagentId).worktree), 'worktree 目录应已删除');
  await sleep(GAP_MS);
});

// ------------------------------------------------------------------ E6

test('E6 崩溃恢复：server 进程死亡后 recover 把死 pid running record 标 lost', async () => {
  const script = writeE6ServerScript();
  const server = spawn(process.execPath, [script], {
    env: { ...process.env }, // 继承 ZSUB_ROOT/ZCODE_MAILBOX_ROOT 等隔离 env
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errTail = '';
  server.stderr.on('data', (d) => { errTail += d; });

  const line = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`E6 server 未就绪。stderr: ${errTail.slice(-400)}`)), 30_000);
    server.stdout.setEncoding('utf8');
    let buf = '';
    server.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/^READY (sa-\S+) (\d+)$/m);
      if (m) { clearTimeout(t); resolve({ id: m[1], agentPid: Number(m[2]) }); }
      if (/TIMEOUT_NO_PID|SRV_ERR/.test(buf)) { clearTimeout(t); reject(new Error(`E6 server 异常: ${buf.trim()}`)); }
    });
  });

  // 模拟 server 崩溃：先杀 server（断掉 record 写盘），再杀 subagent 进程
  server.kill('SIGKILL');
  await sleep(100);
  try { process.kill(line.agentPid, 'SIGKILL'); } catch { /* 可能已自行退出 */ }
  CALLS.killedBeforeFlight += 1;
  await sleep(400);

  const { manager } = buildManager();
  const summary = await manager.recover();
  assert.ok(summary.dead.includes(line.id), `dead=[${summary.dead}] 应含 ${line.id}`);
  const rec = manager.status(line.id);
  assert.equal(rec.status, 'lost');
  assert.match(rec.lostReason, /已死|探活/);
  await sleep(GAP_MS);
});

// ------------------------------------------------------------------ E7

test('E7 appserver 全链路：probe → start（真实模型）→ message 续聊（A1-A5 实证）', async () => {
  // 与 server.js main 的真实链路一致：probe 前先经 model-router bootstrap 隔离 HOME
  // （app-server 启动即要求 $HOME 有模型配置，否则 create -32603 Model config is missing）
  const ModelRouter = require('../lib/model-router');
  const router = new ModelRouter();
  await router.prepareRunEnv(router.resolve(MODEL), 'appserver');
  const runner = new AppServerRunner(); // homeDir=config.appserverHomeDir()，与 model-router bootstrap 同源
  const probe = await runner.probe();
  assert.ok(probe.ok, `app-server 探针失败: ${probe.reason}`);
  // protocol 自报帧未捕获不影响往返（probe.ok 已证协议可用）；version 缺失仅记录
  console.error(`[e2e] E7 probe ok, protocolVersion=${probe.protocolVersion ?? '未捕获'}`);

  const e7proj = path.join(TMP, 'e7-proj');
  fs.mkdirSync(e7proj, { recursive: true });
  // 实证 A1/A2/A3 的观测材料：记录真实推送帧的 method 序列（start 前注册）
  const pushLog = [];
  runner._ensureConnection(e7proj).onPush((method, params) => {
    pushLog.push(method + (params && params.kind ? `(${params.kind})` : ''));
  });
  const { manager } = buildManager({ runnerKind: 'appserver', runner });
  try {
    const res = await startWithRetry(manager, {
      task: '直接回复文本：茄子紫。禁止使用任何工具，禁止搜索。',
      slug: 'e7-appserver',
      model: MODEL,
      conversation: true,
      timeoutMs: CALL_MS,
    }, { cwd: e7proj, targetSessionId: 'sess_e7' });
    assert.equal(res.status, 'idle', `appserver 首轮失败: ${res.error}`);
    assert.ok(res.result && res.result.trim() !== '', 'A1/A4：终态判定 + 最终文本读取，response 非空');
    assert.ok(res.result.includes('茄子紫'), `response=${JSON.stringify(res.result.slice(0, 200))}`);

    // A5 侧写：idle 会话 send 投递可用（manager 语义下 message 仅 idle 可投）
    await sleep(GAP_MS); // 续聊轮无重试钩子，投递前错峰限流窗口
    CALLS.messages += 1;
    const r = await manager.message(res.subagentId, '直接回复文本：完成。禁止使用任何工具。');
    assert.equal(r.status, 'running');
    const fin = await waitFor(() => {
      const rec = manager.status(res.subagentId);
      return rec.status === 'idle' || rec.status === 'error' ? rec : null;
    }, CALL_MS + 20_000);
    assert.equal(fin.status, 'idle', `appserver 续聊轮失败: ${fin.error}`);
    assert.equal(fin.rounds, 2);
    assert.ok(fs.readFileSync(fin.outputFile, 'utf8').trim() !== '', '续聊轮 response 非空');
    // 真实推送帧序列留档（A1 终态判定 / A2 会话归属 / A3 chunk 的实证材料）
    console.error(`[e2e] E7 push frames: ${pushLog.join(' | ')}`);
  } finally {
    await runner.shutdown();
  }
  await sleep(GAP_MS);
});

// ------------------------------------------------------------------ E8

test('E8 防递归轻验证：ZSUB_NESTED=1 真实 env 下 tools/list 空', async () => {
  const code = `
    'use strict';
    (async () => {
      const config = require(${JSON.stringify(path.join(REPO, 'lib', 'config'))});
      const { createServer } = require(${JSON.stringify(path.join(REPO, 'dist', 'mcp', 'server'))});
      const s = createServer({ nested: config.NESTED });
      const frames = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      console.log('RESULT ' + config.NESTED + ' ' + frames[0].result.tools.length);
    })().catch((e) => { console.log('ERR ' + e.message); process.exit(1); });
  `;
  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', code], {
      env: { ...process.env, ZSUB_NESTED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const t = setTimeout(() => reject(new Error('E8 子进程超时')), 15_000);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { buf += d; });
    p.on('close', () => { clearTimeout(t); resolve(buf.trim()); });
  });
  assert.match(out, /^RESULT true 0$/m, `期望 NESTED=true 且 tools 数为 0，实际输出: ${out}`);
});
