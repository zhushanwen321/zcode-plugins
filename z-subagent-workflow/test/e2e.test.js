'use strict';

/**
 * 无头真机 e2e（DESIGN-v3 §4.1）：真实 zcode.cjs + 真实模型（GLM-5.3）。
 *
 * 回接 2c（D6-⑥）：appserver 常驻通道退役，执行链 = vendored subagent-core 的
 * zcode engine spawn 单轮（lib/runner-core.js）。E7/E9/E10 的 appserver 会话
 * 协议面场景（probe 往返 / session create+send+read / 多会话推送归因）随之
 * 删除——格式漂移核对改由 core 引擎探针承担（binary + version + golden 样本
 * 干跑回归，probe({force:true}) 可手动触发）；常驻实现回归路线 P3。
 * E3 conversation 续聊断言同步改形态：core EnginePort 面无 resume 入口，
 * message 续聊报可操作退役错误（旧 --resume 冷续聊让渡）。
 *
 * 与单测的隔离差异（为什么 env 这么设）：
 * - ZSW_ROOT / ZCODE_MAILBOX_ROOT 指临时目录：records/outputs/引擎池
 *   （<ZSW_ROOT>/engines/） /mailbox 全部隔离，绝不碰真实 ~/.zcode/zsw。
 * - HOME 刻意【不】改：core 引擎 preparer 的凭据源（~/.zcode/v2/config.json）
 *   需要真实登录态（改了 HOME 就没有真实凭据，所有模型调用必挂）。user 级
 *   agent 根的隔离改走 resolver 注入临时 homeDir。
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
process.env.ZSW_ROOT = path.join(TMP, 'zsw-root');
process.env.ZCODE_MAILBOX_ROOT = path.join(TMP, 'mailbox');
process.env.ZCODE_MESSAGE_ENABLED = '1';

// env 隔离完成后才 require lib（config.js 模块加载期冻结 V2_CONFIG_PATH）
const { assembleManager } = require('../lib/assemble');
const agentDiscovery = require('../lib/agent-discovery');
const CoreRunner = require('../lib/runner-core');

const MODEL = process.env.ZSW_E2E_MODEL || 'GLM-5.3'; // 真机模型可配置；换环境用 env 覆盖而非改代码
// bootstrapIsolatedHome 需要 provider 全名；MODEL 允许短名或全名，统一在此推导
const MODEL_REF = MODEL.includes('/') ? MODEL : `builtin:bigmodel-coding-plan/${MODEL}`;
// user 级 agent 根注入临时 HOME（W6a 起发现走 core：homeDir 覆盖 zsw 宿主
// 推导的 user-pi/user-agents 根；core 硬编码 user-agents 本体槽读真实 HOME
// ——e2e 为保真实凭据刻意不改 HOME，该槽的环境渗漏是 core 发现的固有属性，
// 只读无副作用，仅真实 HOME 存在同 stem .md 时才可能干扰按名解析）
const USER_HOME = path.join(TMP, 'user-home');
// 限流实测（2026-08-23）：账户分钟级 RPM 窗口，连续调用必撞 429；CLI 内部长退避
// 重试 ~2 分钟内可挤过。CALL_MS 给足内部重试窗口；GAP_MS 场景间错峰。
const GAP_MS = Number(process.env.ZSW_E2E_GAP_MS || 20000);
const RETRY_WAIT_MS = Number(process.env.ZSW_E2E_RETRY_WAIT_MS || 45000);
const RETRY_MAX = Number(process.env.ZSW_E2E_RETRY_MAX || 2);
const CALL_MS = 150_000;

/** 真实模型调用审计：结尾汇总（预算回溯用）。 */
const CALLS = { starts: 0, retries: 0, messages: 0, killedBeforeFlight: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkEmptyUserHome = () => fs.mkdirSync(path.join(USER_HOME, '.agents', 'agents'), { recursive: true });

// --name <pattern>：单场景冒烟入口（ZCode 升级后本地手动跑
// `node test/e2e.test.js --name E1` 等，真实模型、极小 token；appserver 冒烟
// apc-smoke 已随通道退役删除）。未命中场景注册为 skip；`node --test` 全量
// 入口（不带 --name）行为不变。
const NAME_ARG_IDX = process.argv.indexOf('--name');
const NAME_FILTER = NAME_ARG_IDX >= 0 ? process.argv[NAME_ARG_IDX + 1] : null;

/** --name 过滤：启用且未命中场景名时返回 skip 选项（test(name, opts, fn) 第二参）。 */
function scenarioOpts(namePrefix) {
  return NAME_FILTER && !namePrefix.includes(NAME_FILTER)
    ? { skip: `--name ${NAME_FILTER} 未命中此场景` }
    : {};
}

/** 推送帧的会话归属提取（冒烟自带，不 import 被测 lib 的同段逻辑——冒烟要独立核对协议面）。 */
function pushSidOf(params) {
  const sid = params ? (params.sessionId ?? (params.session ? params.session.id : undefined)) : undefined;
  return sid === undefined ? null : sid;
}

/**
 * 冒烟自带的 assistant 文本提取（不 import 被测 lib 同段逻辑——冒烟要独立核对
 * 协议面）。已收口形态（2026-08-29 真机）：{messages:[{info:{role}, parts:[
 * {type:'text',text}]}]}；旧形态（m.role + m.content）与顶层直给键保留兼容。
 */
function extractTextInline(readResult) {
  if (typeof readResult === 'string') return readResult;
  if (!readResult || typeof readResult !== 'object') return null;
  const roleOf = (m) => (typeof m.role === 'string' ? m.role : (m.info && m.info.role));
  const messages = Array.isArray(readResult.messages) ? readResult.messages
    : Array.isArray(readResult) ? readResult : null;
  if (messages) {
    const last = [...messages].reverse().find((m) => m && typeof m === 'object'
      && (roleOf(m) === 'assistant' || roleOf(m) === undefined));
    if (last) {
      if (Array.isArray(last.parts)) {
        const text = last.parts
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text).join('');
        if (text) return text;
      }
      const c = last.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        return c.map((b) => (typeof b === 'string' ? b : (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))).join('');
      }
    }
  }
  for (const k of ['text', 'response', 'content', 'message']) {
    if (typeof readResult[k] === 'string') return readResult[k];
  }
  return null;
}

/** 组装 manager：user 级 agent 根注入临时 HOME（四根发现的 3/4 根指向空目录）。 */
async function buildManager(opts = {}) {
  return assembleManager({ resolver: agentDiscovery.createAgentDiscovery({ homeDir: USER_HOME }), ...opts }); // async：调用方需 await
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
  // 2c 起：配额探测 = core zcode engine 真实 spawn 单轮（原 driver.runHeadless
  // 已删；CoreRunner 缺省实例 = 真 CLI + 真凭据，engineDataDir 派生自隔离 ZSW_ROOT）
  const runner = new CoreRunner();
  for (let i = 1; i <= 8; i++) {
    CALLS.starts += 1;
    const t0 = Date.now();
    const handle = runner.start({
      subagentId: `sa-quota-${i}`,
      slug: 'quota-probe',
      prompt: '回复：ok。不要做任何其他事。',
      cwd: TMP,
      modelRef: MODEL_REF,
      timeoutMs: 120_000,
      conversation: false,
    });
    const r = await handle.done;
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
const agentDiscovery = require(${JSON.stringify(path.join(REPO, 'lib', 'agent-discovery'))});
(async () => {
  const { manager } = await assembleManager({
    resolver: agentDiscovery.createAgentDiscovery({ homeDir: ${JSON.stringify(USER_HOME)} }),
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

test('E1 sync start + agent 注入：tester 正文进 prompt，回复含口令「菠萝啤」', scenarioOpts('E1'), async () => {
  const { manager } = await buildManager();
  const res = await startWithRetry(manager, {
    task: '报告就绪',
    slug: 'e1-agent-inject',
    // D-4a（W6b）：agent 仅收 .md 绝对路径——按名传 tester 的旧形态已废弃
    agent: path.join(TMP, 'e1-proj', '.agents', 'agents', 'tester.md'),
    model: MODEL,
  }, { cwd: path.join(TMP, 'e1-proj'), targetSessionId: 'sess_e1' });

  assert.equal(res.status, 'closed', `失败详情: ${res.error}`);
  assert.ok(res.result.includes('菠萝啤'), `角色正文未注入 prompt，response=${JSON.stringify(res.result)}`);
  const rec = manager.status(res.subagentId);
  assert.equal(rec.agent, 'tester'); // 路径解析命中项目级 .agents/agents（user 根为空）
  await sleep(GAP_MS);
});

// ------------------------------------------------------------------ E2

test('E2 mailbox 文件级投递：bg 完成后 unread/ 有合法 envelope', scenarioOpts('E2'), async () => {
  const TARGET = 'sess_e2etest-abc'; // 匹配引擎 drain 的 /^sess_[A-Za-z0-9._-]+$/
  const { manager } = await buildManager();
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

test('E3 conversation：首轮 idle（conversation 标志作用于 record 状态机），message 续聊报可操作退役错误', scenarioOpts('E3'), async () => {
  // 2c（D6-⑥）：core EnginePort 面无 resume 入口——旧 spawn 通道的 --resume
  // 冷续聊让渡，P3 常驻实现回归。本场景钉「首轮照常 + 续聊明确报错（不静默
  // 假成功）」的新契约形态。
  const { manager } = await buildManager();
  const ctxv = { cwd: path.join(TMP, 'e1-proj'), targetSessionId: 'sess_e2etest-abc' }; // 与 E2 同 target：顺带验证跨投递文件名单调
  const res = await startWithRetry(manager, {
    task: '记住暗号：紫葡萄。只回复：收到',
    slug: 'e3-conversation',
    conversation: true,
    model: MODEL,
  }, ctxv);
  assert.equal(res.status, 'idle', `首轮失败: ${res.error}`); // conversation 首轮完成 → idle（非 closed）
  assert.equal(res.rounds, 1, '首轮完成计数');

  // 续聊轮：明确报错（core 面缺口的可操作暴露，record 收敛 error 终态）
  CALLS.messages += 1;
  const r = await manager.message(res.subagentId, '暗号是什么？只回复暗号本身。');
  assert.equal(r.status, 'running');
  const fin = await waitFor(() => {
    const rec = manager.status(res.subagentId);
    return ['idle', 'error', 'closed'].includes(rec.status) ? rec : null;
  }, 20_000);
  assert.equal(fin.status, 'error', '续聊轮必须落 error 终态（resume 不可用）');
  assert.match(fin.error, /无 resume 入口/);
  assert.match(fin.error, /重新 start/);

  // E2+E3 同 target 共 2 封（首轮完成通知 ×2；续聊失败轮的 notify 门卫：
  // cancel 语义不投，error 终态照投一封失败通知）
  await sleep(GAP_MS);
});

// ------------------------------------------------------------------ E4

test('E4 cancel：bg 立即取消，record cancelled 且无残留进程', scenarioOpts('E4'), async () => {
  const { manager } = await buildManager();
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

test('E5 worktree：主树干净、patch 可 apply、close 后无 worktree 残留', scenarioOpts('E5'), async () => {
  const repo = path.join(TMP, 'e5-repo');
  fs.mkdirSync(repo, { recursive: true });
  await git(repo, ['init', '-q']);
  await git(repo, ['-c', 'user.email=zsub@e2e.test', '-c', 'user.name=zsub-e2e', 'add', '-A']);
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['-c', 'user.email=zsub@e2e.test', '-c', 'user.name=zsub-e2e', 'commit', '-q', '-m', 'init']);

  const { manager } = await buildManager();
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

test('E6 崩溃恢复：server 进程死亡后 recover 把死 pid running record 标 lost', scenarioOpts('E6'), async () => {
  const script = writeE6ServerScript();
  const server = spawn(process.execPath, [script], {
    env: { ...process.env }, // 继承 ZSW_ROOT/ZCODE_MAILBOX_ROOT 等隔离 env
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

  const { manager } = await buildManager();
  const summary = await manager.recover();
  assert.ok(summary.dead.includes(line.id), `dead=[${summary.dead}] 应含 ${line.id}`);
  const rec = manager.status(line.id);
  assert.equal(rec.status, 'lost');
  assert.match(rec.lostReason, /已死|探活/);
  await sleep(GAP_MS);
});

// ------------------------------------------------------------------ E7

test('E7 core 引擎链路：probe 真探 → spawn 单轮 start（真实模型）→ engine 留痕 → message 续聊报退役错误', scenarioOpts('E7'), async () => {
  // 2c（D6-⑥）后的全链路形态：原 appserver 会话协议面场景（create/send/read
  // 推送归因）随通道退役删除，漂移核对归 core 引擎探针（binary + version +
  // golden 干跑）。本场景钉新通道的核心面：probe 真探过、start 真实模型
  // 完成、record.engine 留痕（V3-①）、续聊报可操作退役错误。
  const runner = new CoreRunner();
  const probe = await runner.probe();
  assert.ok(probe.ok, `core 引擎探针失败: ${probe.reason}`);
  console.error(`[e2e] E7 probe ok, engineVersion=${probe.protocolVersion ?? '未捕获'}`);

  const e7proj = path.join(TMP, 'e7-proj');
  fs.mkdirSync(e7proj, { recursive: true });
  const { manager } = await buildManager({ runner });
  const res = await startWithRetry(manager, {
    task: '直接回复文本：茄子紫。禁止使用任何工具，禁止搜索。',
    slug: 'e7-core-engine',
    model: MODEL,
    conversation: true,
    timeoutMs: CALL_MS,
  }, { cwd: e7proj, targetSessionId: 'sess_e7' });
  assert.equal(res.status, 'idle', `首轮失败: ${res.error}`);
  assert.ok(res.result && res.result.trim() !== '', '终态 response 非空');
  assert.ok(res.result.includes('茄子紫'), `response=${JSON.stringify(res.result.slice(0, 200))}`);

  // V3-① 引擎留痕：record.engine 恒 zcode（zsw 唯一生产引擎）+ exec.spawn 形态
  const rec = manager.status(res.subagentId);
  assert.equal(rec.engine, 'zcode', 'record.engine 留痕（core 路由产物）');
  assert.equal(rec.runnerKind, 'spawn');
  assert.ok(Number.isInteger(rec.exec && rec.exec.pid), 'exec.pid 回填（onChildSpawned）');
  assert.equal(typeof rec.exec.sessionId, 'string', 'exec.sessionId 回填（P3 冷续聊定位锚）');

  // 续聊面（同 E3 契约）：明确报错不静默
  const r = await manager.message(res.subagentId, '直接回复文本：完成。禁止使用任何工具。');
  assert.equal(r.status, 'running');
  const fin = await waitFor(() => {
    const x = manager.status(res.subagentId);
    return ['idle', 'error', 'closed'].includes(x.status) ? x : null;
  }, 20_000);
  assert.equal(fin.status, 'error');
  assert.match(fin.error, /无 resume 入口/);
  await sleep(GAP_MS);
});

// ------------------------------------------------------------------ E8

test('E8 防递归轻验证：ZSW_NESTED=1 真实 env 下 tools/list 空', scenarioOpts('E8'), async () => {
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
      env: { ...process.env, ZSW_NESTED: '1' },
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

// ------------------------------------------- E9/E10（appserver 专有，已随 D6-⑥ 退役删除）
// E9 apc-smoke（D3/G3 升级冒烟：session/create 扩面 + send + session/read 形态 +
//   推送帧归因）与 E10 appserver 多会话并发（A-8/G1）依赖常驻 JSON-RPC 会话协议，
//   通道退役后无对应面。漂移核对改由 core 引擎探针承担（binary + version +
//   golden 样本干跑回归；手动触发：ZSW_ROOT=<隔离目录> node -e
//   "require('./lib/runner-core').prototype.probe" 或经 runner-core 单测）。
//   多会话并发等价面 = E1-E5 的 slots 并行 + core 引擎 per-provider+model 池。
//   常驻实现与 per-session model 的回归路线见 P3。
