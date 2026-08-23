'use strict';

/**
 * AppServerRunner 测试：全部跑 fixtures/fake-appserver.js，绝不 spawn 真
 * zcode.cjs。协议行为（必答反向请求、终态推送、read 兜底）由 fake 模拟，
 * fake 侧状态经 FAKE_STATE_FILE 流水文件断言。
 *
 * S-8：fake 默认 real 形态（E7 抓包实证），主路径测试（start 全流程/并发/
 * resume/cancel/超时）默认保护真实协议；flat/nested 旧形态只在显式设置的
 * 兼容用例中运行。
 *
 * 隔离（同 execution.test.js）：
 * - ZSUB_ZCODE_CLI → fake 脚本
 * - ZSUB_ROOT / HOME → 临时目录
 * 必须在 require 任何 lib 之前设置（config.js 模块加载期冻结路径）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-apc-'));
process.env.ZSUB_ROOT = path.join(TMP, 'zsub-root');
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
process.env.ZSUB_ZCODE_CLI = path.join(__dirname, '..', 'fixtures', 'fake-appserver.js');

// env 隔离完成后才允许 require lib（见文件头注释）
const AppServerRunner = require('../lib/runner-appserver');
const { createFrameDispatcher, interpretEvent, RUNTIME_PREFERENCES } = require('../lib/runner-appserver');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUNNERS = [];
let stateSeq = 0;

/** 建一个 runner：当前 env 的 FAKE_* 开关随连接 spawn 固化进 fake 进程。 */
function newRunner() {
  const stateFile = path.join(TMP, `state-${++stateSeq}.jsonl`);
  process.env.FAKE_STATE_FILE = stateFile;
  const runner = new AppServerRunner();
  RUNNERS.push(runner);
  return { runner, stateFile };
}

function readState(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** 轮询等待 fake 侧事件落盘（fake 异步处理 stdin，测试不能假设即时可见）。 */
async function waitFor(cond, ms = 5000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
}

function baseTaskCtx(prompt, overrides = {}) {
  return {
    subagentId: 'sa-test',
    slug: 'test',
    prompt,
    cwd: TMP,
    modelRef: 'builtin:bigmodel-coding-plan/GLM-5.3',
    timeoutMs: 15000,
    conversation: true,
    ...overrides,
  };
}

after(async () => {
  await Promise.allSettled(RUNNERS.map((r) => r.shutdown()));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// ------------------------------------------------------------- 契约与纯逻辑

test('AppServerRunner：方法签名与 ports.js 契约一致 + capabilities', () => {
  const r = new AppServerRunner();
  for (const m of ['probe', 'start', 'resume', 'alive', 'capabilities', 'shutdown']) {
    assert.equal(typeof r[m], 'function', `runner.${m}`);
  }
  // INFO-15：steering 与实际暴露面一致（manager 门禁 idle-only + A5 未实测）
  assert.deepEqual(r.capabilities(), { kind: 'appserver', steering: 'none', coldStartMs: 0 });
});

test('createFrameDispatcher：响应匹配 / 推送 / 反向请求三路分发 + 坏行容错', () => {
  const seen = { resp: [], push: [], rev: [], proto: [], bad: [] };
  const d = createFrameDispatcher({
    onResponse: (id, frame) => seen.resp.push([id, frame]),
    onPush: (method, params) => seen.push.push([method, params]),
    onReverse: (id, method, params) => seen.rev.push([id, method, params]),
    onProtocol: (info) => seen.proto.push(info),
    onMalformed: (line) => seen.bad.push(line),
  });
  d.handleChunk('{"id":1,"result":{"accepted":true}}\n{"method":"state.u'); // chunk 跨行切半
  d.handleChunk('pdated","params":{"sessionId":"s1","status":"idle"}}\n');
  d.handleLine('  {"id":"srv-1","method":"permission/request","params":{"tool":"Bash"}}  '); // 带空白
  d.handleLine('not-json');
  d.handleLine('{"protocol":{"name":"ZCode Protocol","version":1}}'); // 首帧自报形态
  d.handleLine('{"id":2,"error":{"code":-32602,"message":"ZodError","data":[{"path":["mode"]}]}}');
  d.handleLine(''); // 空行跳过

  assert.deepEqual(seen.resp.map((x) => x[0]), [1, 2]); // 响应按 id 匹配（成功/错误同路）
  assert.equal(seen.resp[1][1].error.code, -32602);
  assert.deepEqual(seen.push, [['state.updated', { sessionId: 's1', status: 'idle' }]]);
  assert.deepEqual(seen.rev, [['srv-1', 'permission/request', { tool: 'Bash' }]]);
  assert.deepEqual(seen.proto, [{ name: 'ZCode Protocol', version: 1 }]);
  assert.deepEqual(seen.bad, ['not-json']);
});

test('interpretEvent：终态宽松匹配是版本漂移防洪堤（假设 A1）', () => {
  // 实测主形态：status 在 patch.status（e2e 抓包 2026-08-23）
  assert.equal(interpretEvent({
    method: 'state.updated',
    params: { patch: { status: 'running' }, reason: 'prompt_started', sessionId: 's1' },
  }), 'running');
  assert.equal(interpretEvent({
    method: 'state.updated',
    params: { patch: { status: 'idle' }, sessionId: 's1' },
  }), 'done');
  // 实测：轮结束的权威信号是 turn.terminal（state.updated 不再发 status:idle）
  assert.equal(interpretEvent({
    method: 'v4/telemetry/event',
    params: { kind: 'turn.terminal', status: 'success', sessionId: 's1' },
  }), 'done');
  assert.equal(interpretEvent({
    method: 'v4/telemetry/event',
    params: { kind: 'turn.terminal', status: 'error', sessionId: 's1' },
  }), 'done'); // error 也是一轮终态（VDe 枚举），不归类会挂到 timeout
  const doneStates = ['idle', 'settled', 'waiting', 'completed', 'IDLE', 'idle-waiting'];
  for (const s of doneStates) {
    assert.equal(interpretEvent({ method: 'state.updated', params: { status: s } }), 'done', s);
  }
  // 嵌套形态 params.state.status
  assert.equal(interpretEvent({ method: 'state.updated', params: { state: { status: 'settled' } } }), 'done');
  // state 直接是字符串的退化形态
  assert.equal(interpretEvent({ method: 'state.updated', params: { state: 'completed' } }), 'done');
  // 活跃态
  assert.equal(interpretEvent({ method: 'state.updated', params: { status: 'running' } }), 'running');
  assert.equal(interpretEvent({ method: 'state.updated', params: { state: { status: 'streaming' } } }), 'running');
  assert.equal(interpretEvent({
    method: 'v4/telemetry/event',
    params: { kind: 'stream.chunk', channel: 'text', firstChunk: true, chunkLength: 3 },
  }), 'running');
  // unknown：非首 chunk / 未知方法 / 缺 status / patch 无 status（轮后 mode/model 帧）
  assert.equal(interpretEvent({
    method: 'v4/telemetry/event',
    params: { kind: 'stream.chunk', firstChunk: false },
  }), 'unknown');
  assert.equal(interpretEvent({ method: 'whatever.else', params: {} }), 'unknown');
  assert.equal(interpretEvent({ method: 'state.updated', params: {} }), 'unknown');
  assert.equal(interpretEvent({
    method: 'state.updated',
    params: { patch: { mode: { current: 'yolo' } }, sessionId: 's1' },
  }), 'unknown');
  assert.equal(interpretEvent(null), 'unknown');
});

test('RUNTIME_PREFERENCES：与实测 schema 逐字段一致', () => {
  assert.deepEqual(RUNTIME_PREFERENCES, {
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: true,
    modelContextBudgetStrategy: 'preflight-v1',
  });
});

test('start：prompt/cwd 缺失同步抛错', () => {
  const r = new AppServerRunner();
  assert.throws(() => r.start({ cwd: TMP }), /prompt/);
  assert.throws(() => r.start({ prompt: 'x' }), /cwd/);
});

// ----------------------------------------------------------------- probe

test('probe：成功（create→反向 prefs→close→shutdown）带回协议版本', async () => {
  const { runner, stateFile } = newRunner();
  const res = await runner.probe();
  assert.equal(res.ok, true);
  assert.equal(res.protocolVersion, 1);
  const evs = readState(stateFile);
  assert.ok(evs.some((e) => e.ev === 'create'), 'probe 发起了 session/create');
  assert.ok(evs.some((e) => e.ev === 'prefs-answer' && e.valid === true), 'prefs 反向请求被正确应答');
  assert.ok(evs.some((e) => e.ev === 'close'), '探针会话被立即 close');
});

test('probe：fake 报错分支 → {ok:false, reason}（降级决策归上层）', async () => {
  process.env.FAKE_MODE = 'fail-create';
  try {
    const { runner } = newRunner();
    const res = await runner.probe();
    assert.equal(res.ok, false);
    assert.match(res.reason, /-32602|ZodError|session\/create/);
  } finally {
    delete process.env.FAKE_MODE;
  }
});

// ------------------------------------------------------------ start 全流程

test('start：create(合入 model)→subscribe→send→终态推送→read 回最终文本', async () => {
  const { runner, stateFile } = newRunner();
  const handle = runner.start(baseTaskCtx('这是第一轮任务提示词', {
    runEnv: { createParams: { model: { providerId: 'builtin:bigmodel-coding-plan', modelId: 'GLM-5.3' } } }, // e2e 实测：model 是 strict 对象
  }));
  assert.equal(handle.exec.kind, 'apc');
  const result = await handle.done;
  assert.equal(result.status, 'closed');
  assert.ok(handle.exec.sessionId.startsWith('sess_fake_'), 'sessionId 已回填');
  assert.equal(result.sessionId, handle.exec.sessionId);
  assert.equal(result.response, 'FAKE_READ:这是第一轮任务提示词'); // response 来自 session/read
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 20);

  const evs = readState(stateFile);
  const create = evs.find((e) => e.ev === 'create');
  assert.equal(create.params.mode, 'yolo');
  assert.deepEqual(create.params.model, { providerId: 'builtin:bigmodel-coding-plan', modelId: 'GLM-5.3' }); // runEnv.createParams 已合入
  assert.equal(create.params.workspace.workspacePath, TMP);
  assert.ok(create.params.workspace.workspaceKey, 'workspaceKey 为稳定 hash');
  const sub = evs.find((e) => e.ev === 'subscribe');
  assert.equal(sub.params.deliveryKind, 'desktop-continuous'); // 必填字段
  assert.equal(sub.params.sessionId, handle.exec.sessionId);
  const send = evs.find((e) => e.ev === 'send');
  assert.equal(send.content, '这是第一轮任务提示词'); // 字段是 content
  await runner.shutdown();
});

test('start 并发两会话：响应按 id 匹配不串线', async () => {
  const { runner } = newRunner();
  const h1 = runner.start(baseTaskCtx('任务甲的独有内容'));
  const h2 = runner.start(baseTaskCtx('任务乙的独有内容'));
  const [res1, res2] = await Promise.all([h1.done, h2.done]);
  assert.equal(res1.status, 'closed');
  assert.equal(res2.status, 'closed');
  assert.equal(res1.response, 'FAKE_READ:任务甲的独有内容');
  assert.equal(res2.response, 'FAKE_READ:任务乙的独有内容');
  assert.notEqual(h1.exec.sessionId, h2.exec.sessionId);
  await runner.shutdown();
});

test('requestRuntimePreferences 应答内容正确性：fake 深比较校验并回显', async () => {
  const { runner, stateFile } = newRunner();
  const handle = runner.start(baseTaskCtx('prefs 校验任务'));
  const result = await handle.done;
  assert.equal(result.status, 'closed'); // prefs 应答错误会拖死 create 握手
  const pa = readState(stateFile).find((e) => e.ev === 'prefs-answer');
  assert.ok(pa, 'fake 收到了 prefs 应答');
  assert.equal(pa.valid, true);
  assert.deepEqual(pa.received, {
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: true,
    modelContextBudgetStrategy: 'preflight-v1',
  });
  await runner.shutdown();
});

test('终态宽松匹配：params.state.status 嵌套形态同样收敛（假设 A1，显式兼容用例）', async () => {
  process.env.FAKE_STATE_SHAPE = 'nested';
  try {
    const { runner } = newRunner();
    const handle = runner.start(baseTaskCtx('嵌套终态形态'));
    const result = await handle.done;
    assert.equal(result.status, 'closed');
    assert.equal(result.response, 'FAKE_READ:嵌套终态形态');
    await runner.shutdown();
  } finally {
    delete process.env.FAKE_STATE_SHAPE;
  }
});

test('终态宽松匹配：flat 形态（params.status:idle 的 state.updated）同样收敛（显式兼容用例）', async () => {
  // S-8：real 已是 fake 默认，flat（E7 前的假想形态）保留为显式兼容——
  // interpretEvent 的宽松匹配对旧/漂移形态仍是防洪堤
  process.env.FAKE_STATE_SHAPE = 'flat';
  try {
    const { runner } = newRunner();
    const handle = runner.start(baseTaskCtx('flat 终态形态'));
    const result = await handle.done;
    assert.equal(result.status, 'closed');
    assert.equal(result.response, 'FAKE_READ:flat 终态形态');
    await runner.shutdown();
  } finally {
    delete process.env.FAKE_STATE_SHAPE;
  }
});

test('实测协议形态（默认）：turn.terminal 终态 + payload.response 全文兜底', async () => {
  // e2e 真实抓包回归（2026-08-23）：轮结束不发 status:idle 的 state.updated，
  // 权威终态是 turn.terminal；read/messages 全废时最终全文来自 session/event。
  // real 已是 fake 默认，显式设置保持用例自解释（不随默认值漂移）
  process.env.FAKE_STATE_SHAPE = 'real';
  process.env.FAKE_READ = 'all-error'; // 逼开 read/messages 降级，验证 response 帧路径
  try {
    const { runner } = newRunner();
    const handle = runner.start(baseTaskCtx('实测形态'));
    const result = await handle.done;
    assert.equal(result.status, 'closed');
    assert.equal(result.response, 'FAKE_TURN:实测形态'); // 来自 session/event payload.response
    assert.equal(result.usage.inputTokens, 11);          // usage 同帧携带
    await runner.shutdown();
  } finally {
    delete process.env.FAKE_STATE_SHAPE;
    delete process.env.FAKE_READ;
  }
});

// ------------------------------------------------------------ cancel / 超时

test('cancel：终态 cancelled 且走 session/stop（优雅取消）', async () => {
  process.env.FAKE_MODE = 'no-terminal';
  try {
    const { runner, stateFile } = newRunner();
    const handle = runner.start(baseTaskCtx('永不结束的任务', { timeoutMs: 60000 }));
    assert.ok(await waitFor(() => readState(stateFile).some((e) => e.ev === 'send')), 'send 已投递');
    handle.cancel();
    const result = await handle.done;
    assert.equal(result.status, 'cancelled');
    assert.ok(
      await waitFor(() => readState(stateFile).some((e) => e.ev === 'stop' && e.sessionId === handle.exec.sessionId)),
      'cancel 走了 session/stop'
    );
    await runner.shutdown();
  } finally {
    delete process.env.FAKE_MODE;
  }
});

test('超时：fake 不推终态 → status timeout + session/stop 兜底，共享进程未被杀', async () => {
  process.env.FAKE_MODE = 'no-terminal';
  try {
    const { runner, stateFile } = newRunner();
    const handle = runner.start(baseTaskCtx('拖住不结束', { timeoutMs: 400 }));
    const result = await handle.done;
    assert.equal(result.status, 'timeout');
    assert.match(result.error, /session\/stop/);
    assert.ok(await waitFor(() => readState(stateFile).some((e) => e.ev === 'stop')), 'stop 已发出');
    // stop 成功 → 不 kill 共享进程：连接仍能应答 session/list（会话仍可见）
    assert.equal(await runner.alive(handle.exec), true);
    await runner.shutdown();
  } finally {
    delete process.env.FAKE_MODE;
  }
});

// ----------------------------------------------------------------- resume

test('resume：拒绝非法句柄（kind/sessionId 校验）', async () => {
  const r = new AppServerRunner();
  await assert.rejects(() => r.resume({}, 'x'), (err) => /apc/.test(err.message) && err.message.includes('恢复指引'));
  await assert.rejects(() => r.resume({ kind: 'spawn', pid: 1 }, 'x'), /apc/);
  await assert.rejects(() => r.resume({ kind: 'apc' }, 'x'), /sessionId/);
});

test('resume：同 sessionId 续聊一轮，response 来自 read', async () => {
  const { runner, stateFile } = newRunner();
  const handle = runner.start(baseTaskCtx('第一轮内容'));
  await handle.done;
  const r2 = await runner.resume(handle.exec, '第二轮暗号内容', { timeoutMs: 15000 });
  assert.equal(r2.status, 'closed');
  assert.equal(r2.sessionId, handle.exec.sessionId);
  assert.equal(r2.response, 'FAKE_READ:第二轮暗号内容');
  const sends = readState(stateFile).filter((e) => e.ev === 'send');
  assert.equal(sends.length, 2, '两次 send 都投递到同一 fake 会话');
  await runner.shutdown();
});

// ------------------------------------------------------- 未知反向请求不拖死

test('未知反向请求（permission）：回空 result 不拖死，会话照常完成', async () => {
  process.env.FAKE_MODE = 'permission-probe';
  try {
    const { runner, stateFile } = newRunner();
    const handle = runner.start(baseTaskCtx('带权限探针的任务'));
    const result = await handle.done;
    assert.equal(result.status, 'closed'); // 若 runner 不应答反向请求，create 握手会拖死
    const ans = readState(stateFile).find((e) => e.ev === 'unknown-reverse-answer');
    assert.ok(ans, 'fake 收到了 runner 对未知反向请求的应答');
    assert.deepEqual(ans.answer, {}); // 默认空 result
    await runner.shutdown();
  } finally {
    delete process.env.FAKE_MODE;
  }
});

// ---------------------------------------------------------- read 兜底链

test('read 兜底：session/read 报错 → 降级 session/messages（假设 A4）', async () => {
  process.env.FAKE_READ = 'read-error';
  try {
    const { runner, stateFile } = newRunner();
    const handle = runner.start(baseTaskCtx('读降级路径'));
    const result = await handle.done;
    assert.equal(result.status, 'closed');
    assert.equal(result.response, 'FAKE_READ:读降级路径'); // messages 路径同文案
    const evs = readState(stateFile);
    assert.ok(evs.some((e) => e.ev === 'read'), '先试 read');
    assert.ok(evs.some((e) => e.ev === 'messages'), 'read 失败后降级 messages');
    await runner.shutdown();
  } finally {
    delete process.env.FAKE_READ;
  }
});

test('read/messages 均不可用 → stream.chunk 按文本聚合兜底（假设 A3；flat 形态）', async () => {
  // S-8：real 形态下 session/event payload.response 是更优先的兜底（会截住
  // 聚合链），chunk 聚合只在旧形态（无 payload.response 帧）可达——显式 flat
  process.env.FAKE_STATE_SHAPE = 'flat';
  process.env.FAKE_READ = 'all-error';
  try {
    const { runner } = newRunner();
    const handle = runner.start(baseTaskCtx('聚合兜底提示词'));
    const result = await handle.done;
    assert.equal(result.status, 'closed');
    assert.equal(result.response, 'AGG-STREAM:聚合兜底提示词'); // 两个 chunk 拼回全文
    assert.equal(result.usage, undefined); // read/messages 均失败，无 usage 来源
    await runner.shutdown();
  } finally {
    delete process.env.FAKE_STATE_SHAPE;
    delete process.env.FAKE_READ;
  }
});

test('chunk 不带文本且 read/messages 均不可用 → 注明全文获取失败，可 resume（flat 形态）', async () => {
  // 同上：「全文获取失败」链路只在旧形态可达（real 的 payload.response 兜底在前）
  process.env.FAKE_STATE_SHAPE = 'flat';
  process.env.FAKE_READ = 'all-error-nochunk';
  try {
    const { runner } = newRunner();
    const handle = runner.start(baseTaskCtx('拿不到全文的提示词'));
    const result = await handle.done;
    assert.equal(result.status, 'closed'); // 轮次本身完成了
    assert.equal(result.response, '');
    assert.match(result.error, /全文获取失败/);
    assert.match(result.error, /resume/);
    await runner.shutdown();
  } finally {
    delete process.env.FAKE_STATE_SHAPE;
    delete process.env.FAKE_READ;
  }
});

// ------------------------------------------------------------- alive / shutdown

test('alive：连接活+会话在 list → true；list 中无此会话/非法句柄 → false；连接死后 → false', async () => {
  const { runner } = newRunner();
  const handle = runner.start(baseTaskCtx('探活任务'));
  await handle.done;
  assert.equal(await runner.alive(handle.exec), true);
  assert.equal(await runner.alive({}), false);
  assert.equal(await runner.alive({ kind: 'spawn', pid: 1 }), false);
  assert.equal(await runner.alive({ kind: 'apc', sessionId: 'sess_not_exist' }), false); // list 成功但不含
  await runner.shutdown();
  assert.equal(await runner.alive(handle.exec), false); // 连接已收尾
});

test('shutdown：close 所有会话 + 杀进程', async () => {
  const { runner, stateFile } = newRunner();
  const handle = runner.start(baseTaskCtx('关闭测试任务'));
  await handle.done;
  await runner.shutdown();
  const evs = readState(stateFile);
  assert.ok(evs.some((e) => e.ev === 'close' && e.sessionId === handle.exec.sessionId), '会话被 session/close');
  assert.equal(await runner.alive(handle.exec), false);
});

test('进程意外退出：进行中的一轮收敛为 error 终态，done 不悬挂', async () => {
  const { runner } = newRunner();
  const handle = runner.start(baseTaskCtx('会被进程退出打断的任务', { timeoutMs: 60000 }));
  // 等 send 落地保证 turn 已进入跟踪（no push 需求——default 模式 25ms 后有终态，
  // 这里抢在那之前强杀连接进程）
  const conn = runner._ensureConnection();
  conn.killChain(50);
  const result = await handle.done;
  assert.equal(result.status, 'error');
  assert.match(result.error, /app-server/);
});

// ------------------------------------------- resume 边界（runFail/busy/cancel）

test('resume busy：同会话一轮进行中再 resume → 保守报 busy（A5）', async () => {
  process.env.FAKE_TURN_DELAY_MS = '1500';
  try {
    const { runner } = newRunner();
    const handle = runner.start(baseTaskCtx('慢轮任务'));
    await waitFor(() => handle.exec.sessionId);
    // busy 判定看 _turns 注册表，而 turn 在 send 应答后才创建（runner-appserver.js
    // start 的 ctl.turn 接线）——只等 sessionId 会在高负载下抢跑（曾偶发 resume
    // 自建 turn 跑到 timeout），必须等到首轮 turn 真正 in-flight
    await waitFor(() => runner._turns.has(handle.exec.sessionId));
    const r2 = await runner.resume(handle.exec, '趁轮在飞续聊', { timeoutMs: 15000 });
    assert.equal(r2.status, 'error');
    assert.match(r2.error, /busy/);
    const result = await handle.done;
    assert.equal(result.status, 'closed'); // 首轮不受 busy 尝试影响
    await runner.shutdown();
  } finally {
    delete process.env.FAKE_TURN_DELAY_MS;
  }
});

test('send-reject：start 与 resume 的 accepted:false 均报错且带恢复指引', async () => {
  process.env.FAKE_MODE = 'send-reject';
  try {
    const { runner } = newRunner();
    const handle = runner.start(baseTaskCtx('投递被拒'));
    const r1 = await handle.done;
    assert.equal(r1.status, 'error');
    assert.match(r1.error, /accepted:false/);
    const r2 = await runner.resume(handle.exec, '续聊也被拒', { timeoutMs: 15000 });
    assert.equal(r2.status, 'error');
    assert.match(r2.error, /accepted:false/);
    assert.match(r2.error, /重新 start/);
    await runner.shutdown();
  } finally {
    delete process.env.FAKE_MODE;
  }
});

test('resume 不活跃会话：-32004 错误追加「会话不活跃…重新 start」恢复提示', async () => {
  const { runner } = newRunner();
  // 从未 create 过的 sessionId（fake 对未知会话回 -32004）
  const r = await runner.resume({ kind: 'apc', sessionId: 'sess_fake_never' }, '幽灵会话', { timeoutMs: 15000 });
  assert.equal(r.status, 'error');
  assert.match(r.error, /会话不活跃/);
  assert.match(r.error, /重新 start/);
  await runner.shutdown();
});

test('resume 在飞轮可经 onHandle 句柄中止（S-6① 接线）：cancel 即回 cancelled，不空等 timeoutMs', async () => {
  process.env.FAKE_TURN_DELAY_MS = '3000';
  try {
    const { runner, stateFile } = newRunner();
    const handle = runner.start(baseTaskCtx('待中止的续聊轮'));
    await handle.done; // 首轮完成，会话 idle
    let turnCancel = null;
    const t0 = Date.now();
    const p = runner.resume(handle.exec, '会被取消的续聊', { timeoutMs: 30000 }, (h) => {
      if (h && typeof h.cancel === 'function') turnCancel = h.cancel;
    });
    await waitFor(() => typeof turnCancel === 'function');
    turnCancel();
    const result = await p;
    assert.equal(result.status, 'cancelled');
    assert.ok(Date.now() - t0 < 2500, '远早于 3s 轮延迟返回，未空等超时');
    await waitFor(() => readState(stateFile).some((e) => e.ev === 'stop')); // stop 异步 best-effort，等落盘
    await runner.shutdown();
  } finally {
    delete process.env.FAKE_TURN_DELAY_MS;
  }
});
