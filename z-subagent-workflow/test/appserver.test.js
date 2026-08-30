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
 * - ZSW_ZCODE_CLI → fake 脚本
 * - ZSW_ROOT / HOME → 临时目录
 * 必须在 require 任何 lib 之前设置（config.js 模块加载期冻结路径）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-apc-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsub-root');
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
process.env.ZSW_ZCODE_CLI = path.join(__dirname, '..', 'fixtures', 'fake-appserver.js');

// env 隔离完成后才允许 require lib（见文件头注释）
const AppServerRunner = require('../lib/runner-appserver');
const {
  createFrameDispatcher, interpretEvent, RUNTIME_PREFERENCES, classifyApcError,
  extractAssistantText, extractReadUsage, buildRuntimeModel,
} = require('../lib/runner-appserver');
const { wrapWithProbeInvalidation } = require('../lib/assemble');

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

/** 临时接管 process.stderr.write 捕获 runner 出声（D3 stderr 落点断言用）。 */
async function captureStderr(fn) {
  const orig = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    return { value: await fn(), lines };
  } finally {
    process.stderr.write = orig;
  }
}

let errFakeSeq = 0;
/**
 * 最小错误注入 fake（写进测试 TMP，after 统一清理，不落仓库）：对
 * FAKE_ERR_METHOD 指定的方法回 FAKE_ERR_CODE 错误帧（-32601/-32602 全链路
 * 用——fixtures/fake-appserver.js 只有 fail-create(-32602) 开关且不在本单元
 * 领地），其余 client 请求一律回 -32004。
 */
function writeErrFake() {
  const p = path.join(TMP, `errfake-${++errFakeSeq}.cjs`);
  fs.writeFileSync(p, [
    "'use strict';",
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    'const CODE = Number(process.env.FAKE_ERR_CODE);',
    "const METHOD = process.env.FAKE_ERR_METHOD || 'session/create';",
    'const out = (f) => console.log(JSON.stringify(f));',
    "out({ method: 'protocol', params: { name: 'ZCode Protocol', version: 1 } });",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) return;',
    '  let f;',
    '  try { f = JSON.parse(line); } catch { return; }',
    '  if (f && f.id != null && f.method) {',
    '    if (f.method === METHOD) {',
    "      out({ id: f.id, error: { code: CODE, message: 'drift-probe ' + CODE, data: [{ path: ['fake'], message: 'errfake' }] } });",
    '    } else {',
    "      out({ id: f.id, error: { code: -32004, message: 'not active (errfake)' } });",
    '    }',
    '  }',
    '});',
    "rl.on('close', () => process.exit(0));",
  ].join('\n'));
  return p;
}

/** 恢复默认 ZSW_ZCODE_CLI（errfake 用例的 finally 复位）。 */
function restoreFakeCli() {
  process.env.ZSW_ZCODE_CLI = path.join(__dirname, '..', 'fixtures', 'fake-appserver.js');
}

// ------------------------------------------- D2 恢复序测试环境（v2 config fixture）

// runtimeModel 构造源（F2 适配自 F0 buildRuntimeModel：provider 传输配置唯一权威源
// = v2 config）。V2_CONFIG_PATH 在 config.js 模块加载期冻结为 $HOME/.zcode/v2/config.json
//（HOME 已指 TMP）——写入 fixture 即完成隔离，绝不触真实 ~/.zcode。
const V2_FIXTURE_PATH = path.join(process.env.HOME, '.zcode', 'v2', 'config.json');
const V2_FIXTURE = {
  model: { main: 'prov-fake/GLM-5.3' },
  provider: {
    'prov-fake': {
      kind: 'anthropic',
      name: 'Prov Fake',
      models: { 'GLM-5.3': {}, 'GLM-5.3-Flash': {} },
      options: { baseURL: 'https://fake.example/api', apiKey: 'sk-fake-secret-123' },
    },
  },
};
fs.mkdirSync(path.dirname(V2_FIXTURE_PATH), { recursive: true });
fs.writeFileSync(V2_FIXTURE_PATH, JSON.stringify(V2_FIXTURE, null, 2));

// ------------------------------------------- 幽灵恢复兜底直测（默认模型链 + v2 解析闸门）

// W1-a 附带发现收口：zcode 桌面端不写 v2 config 的 model 键，旧「仅 v2 model.main」
// 兜底在这类机器上恒 throw。修复后兜底经 defaultModelRef 同链（cli config main →
// v2 config main → 内置）+ v2 清单解析闸门。CLI_CONFIG_PATH 同样在模块加载期冻结
// （$HOME/.zcode/cli/config.json），fixture 写 TMP 内即隔离；用例内改写 v2 fixture
// 后 finally 原样还原，不污染下游恢复序用例（它们依赖 V2_FIXTURE 的 model.main）。
const CLI_FIXTURE_DIR = path.join(process.env.HOME, '.zcode', 'cli');

test('buildRuntimeModel 幽灵恢复兜底：会话登记优先于任何兜底层', () => {
  const rt = buildRuntimeModel({ providerId: 'prov-fake', modelId: 'GLM-5.3' });
  assert.equal(rt.model.providerId, 'prov-fake');
  assert.equal(rt.model.modelId, 'GLM-5.3');
});

test('buildRuntimeModel 幽灵恢复兜底：v2 config model.main 层（既有行为钉住）', () => {
  // cli config 不存在（fixture 未写）→ 链落到 v2 model.main
  const rt = buildRuntimeModel(undefined);
  assert.equal(rt.model.providerId, 'prov-fake');
  assert.equal(rt.model.modelId, 'GLM-5.3');
  assert.equal(rt.provider.baseURL, 'https://fake.example/api');
  assert.equal(rt.provider.apiKey.value, 'sk-fake-secret-123');
});

test('buildRuntimeModel 幽灵恢复兜底：v2 无 model 键时走 cli config main（本机失效场景）', () => {
  const v2Bak = fs.readFileSync(V2_FIXTURE_PATH, 'utf8');
  try {
    fs.writeFileSync(V2_FIXTURE_PATH, JSON.stringify({ provider: V2_FIXTURE.provider }));
    fs.mkdirSync(CLI_FIXTURE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CLI_FIXTURE_DIR, 'config.json'),
      JSON.stringify({ model: { main: 'prov-fake/GLM-5.3-Flash' } }));
    const rt = buildRuntimeModel(undefined);
    assert.equal(rt.model.providerId, 'prov-fake');
    assert.equal(rt.model.modelId, 'GLM-5.3-Flash');
  } finally {
    fs.writeFileSync(V2_FIXTURE_PATH, v2Bak);
    fs.rmSync(CLI_FIXTURE_DIR, { recursive: true, force: true });
  }
});

test('buildRuntimeModel 幽灵恢复兜底：默认模型链全不可解析时显式 throw（闸门）', () => {
  const v2Bak = fs.readFileSync(V2_FIXTURE_PATH, 'utf8');
  try {
    // v2 无 model 键 + cli config 不存在 → 链落内置兜底（prov-fake 清单外的
    // provider/model）→ 闸门拒绝 → 显式 throw（不落到 provider 条目缺失的含糊报错）
    fs.writeFileSync(V2_FIXTURE_PATH, JSON.stringify({ provider: V2_FIXTURE.provider }));
    assert.throws(() => buildRuntimeModel(undefined), /无法确定恢复目标模型/);
  } finally {
    fs.writeFileSync(V2_FIXTURE_PATH, v2Bak);
  }
});

/**
 * 恢复序专用 fake（写进测试 TMP，after 统一清理；fixtures/fake-appserver.js 不在本
 * 单元领地且无 session/resume 方法，故按 errfake 先例 inline）。协议面对齐
 * lib/runner-appserver.js 头注实测事实，并内置两条真实语义（恢复序反向断言的前提）：
 *  - 订阅是 per-session 的：create/resume 后 subscribed=false，未订阅会话 send accepted
 *    但不推终态（真实引擎缺订阅即恢复假死）；
 *  - resume 不自动恢复订阅（F0/源码双证）。
 * env 开关（spawn 时固化；逗号分隔组合）：
 *   FAKE_R_MODE = evict                  每会话首次终态推送后立即驱逐（delete，模拟引擎重启/驻留池驱逐；
 *                                        disk 保留 content 模拟 sqlite，resume 可回）
 *                | resume-fails          session/resume 回 -32031（ZCODE_RUNTIME_MODEL_UNAVAILABLE）
 *                | send-still-fails      resume 后的 send 回 -32031（恢复序 ③ 失败）
 *                | no-terminal-after-recover resume 后 send accepted 但不推终态（恢复序 ④ 窗口耗尽）
 *                | busy                  send 回 -32010（busy 语义）
 *   FAKE_R_STDERR=1                      启动时往 stderr 写两行（实时落盘测试取证）
 * 启动时落盘 env 事件（telemetry/nested）——D8 遥测关闭断言取真实子进程 env。
 */
let recFakeSeq = 0;
function writeRecoveryFake() {
  const p = path.join(TMP, `recfake-${++recFakeSeq}.cjs`);
  fs.writeFileSync(p, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    "const MODES = new Set((process.env.FAKE_R_MODE || '').split(',').map((s) => s.trim()).filter(Boolean));",
    "const STATE = process.env.FAKE_STATE_FILE;",
    "let seq = 0;",
    "let sessSeq = 0;",
    "const live = new Map();   // sid -> {content, amSeq, subscribed}",
    "const disk = new Map();   // sid -> content（驱逐不清，模拟引擎 sqlite 持久化）",
    "const resumed = new Set();",
    "const log = (ev, data = {}) => { if (!STATE) return; try { fs.appendFileSync(STATE, JSON.stringify({ seq: ++seq, ev, ...data }) + '\\n'); } catch {} };",
    "const out = (f) => process.stdout.write(JSON.stringify(f) + '\\n');",
    "const reply = (id, result) => out({ id, result });",
    "const replyErr = (id, code, message) => out({ id, error: { code, message } });",
    "out({ method: 'protocol', params: { name: 'ZCode Protocol', version: 1 } });",
    "log('env', { telemetry: process.env.ZCODE_MODEL_TELEMETRY_ENABLED, nested: process.env.ZSW_NESTED });",
    "if (process.env.FAKE_R_STDERR === '1') process.stderr.write('rfake-stderr-line-A\\nrfake-stderr-line-B\\n');",
    "function simulate(sid) {",
    "  setTimeout(() => {",
    "    const s = live.get(sid);",
    "    if (!s) return;",
    "    out({ method: 'v4/telemetry/event', params: { kind: 'turn.terminal', status: 'success', sessionId: sid } });",
    "    out({ method: 'session/event', params: { sessionId: sid, payload: { response: 'FAKE_TURN:' + s.content, usage: { inputTokens: 3, outputTokens: 1 } } } });",
    "    if (MODES.has('evict')) { live.delete(sid); log('evict', { sessionId: sid }); }",
    "  }, Number(process.env.FAKE_R_DELAY_MS) || 15);",
    "}",
    "rl.on('line', (line) => {",
    "  if (!line.trim()) return;",
    "  let f;",
    "  try { f = JSON.parse(line); } catch { return; }",
    "  if (!(f && f.id != null && f.method)) return; // 本 fake 不发反向请求",
    "  const { id, method, params = {} } = f;",
    "  if (method === 'session/create') {",
    "    const sid = 'sess_r_' + (++sessSeq);",
    "    live.set(sid, { content: '', amSeq: 0, subscribed: false });",
    "    disk.set(sid, '');",
    "    log('create', { params });",
    "    return reply(id, { session: { sessionId: sid } });",
    "  }",
    "  if (method === 'session/subscribe') {",
    "    const s = live.get(params.sessionId);",
    "    if (s) s.subscribed = true;",
    "    log('subscribe', { sessionId: params.sessionId, deliveryKind: params.deliveryKind });",
    "    return reply(id, { subscribed: true });",
    "  }",
    "  if (method === 'session/send') {",
    "    const sid = params.sessionId;",
    "    if (!live.has(sid)) { log('send-err', { sessionId: sid, code: -32004 }); return replyErr(id, -32004, 'Session not active (recfake)'); }",
    "    if (MODES.has('busy')) { log('send-err', { sessionId: sid, code: -32010 }); return replyErr(id, -32010, 'A prompt is already running (recfake)'); }",
    "    if (MODES.has('send-still-fails') && resumed.has(sid)) { log('send-err', { sessionId: sid, code: -32031 }); return replyErr(id, -32031, 'ZCODE_RUNTIME_MODEL_UNAVAILABLE (recfake)'); }",
    "    const content = String(params.content ?? '');",
    "    live.get(sid).content = content;",
    "    disk.set(sid, content);",
    "    log('send', { sessionId: sid, content });",
    "    reply(id, { accepted: true });",
    "    if (MODES.has('no-terminal-after-recover') && resumed.has(sid)) return; // 恢复后事件流不可达",
    "    if (live.get(sid).subscribed) simulate(sid); // 未订阅不推终态（per-session 订阅语义）",
    "    return;",
    "  }",
    "  if (method === 'session/resume') {",
    "    if (MODES.has('resume-fails')) { log('resume-err', { sessionId: params.sessionId, code: -32031 }); return replyErr(id, -32031, 'ZCODE_RUNTIME_MODEL_UNAVAILABLE (recfake resume)'); }",
    "    const sid = params.sessionId;",
    "    resumed.add(sid);",
    "    live.set(sid, { content: disk.get(sid) || '', amSeq: 0, subscribed: false }); // resume 不恢复订阅",
    "    log('resume', { sessionId: sid, runtimeModel: params.runtimeModel });",
    "    return reply(id, { session: { sessionId: sid } });",
    "  }",
    "  if (method === 'session/stop') { log('stop', { sessionId: params.sessionId }); return reply(id, { stopped: true }); }",
    "  if (method === 'session/read') {",
    "    const c = disk.get(params.sessionId) || '';",
    "    log('read', { sessionId: params.sessionId });",
    "    return reply(id, { messages: [{ role: 'user', content: c }, { role: 'assistant', content: 'FAKE_READ:' + c }], usage: { input_tokens: 1, output_tokens: 2 } });",
    "  }",
    "  if (method === 'session/list') return reply(id, { sessions: [...live.keys()].map((x) => ({ sessionId: x })) });",
    "  return replyErr(id, -32601, 'method not found (recfake): ' + method);",
    "});",
    "rl.on('close', () => process.exit(0));",
  ].join('\n'));
  return p;
}

/** 恢复序用例专用 runner：ZSW_ZCODE_CLI 指向 recovery fake（finally 必须 restoreFakeCli）。 */
function newRecoveryRunner(fakePath, runnerOpts = {}) {
  const stateFile = path.join(TMP, `state-${++stateSeq}.jsonl`);
  process.env.FAKE_STATE_FILE = stateFile;
  process.env.ZSW_ZCODE_CLI = fakePath;
  const runner = new AppServerRunner(runnerOpts);
  RUNNERS.push(runner);
  return { runner, stateFile };
}

/** 事件流水便捷查询。 */
function findEvs(file, ev) {
  return readState(file).filter((e) => e.ev === ev);
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
  for (const m of ['probe', 'start', 'resume', 'alive', 'release', 'capabilities', 'shutdown']) {
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

test('turn 无超时（timeoutMs:null）：终态延迟到达仍 closed（回归：setTimeout(cb,null)→1ms 立即超时）', async () => {
  // 终态延迟 300ms：若 null 被强转为 1ms timer，会在终态前先判 timeout
  process.env.FAKE_TURN_DELAY_MS = '300';
  try {
    const { runner } = newRunner();
    const handle = runner.start(baseTaskCtx('慢终态轮', { timeoutMs: null }));
    const result = await handle.done;
    assert.equal(result.status, 'closed');
    await runner.shutdown();
  } finally {
    delete process.env.FAKE_TURN_DELAY_MS;
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
    assert.match(r2.error, /等待当前轮完成/, 'A-9：busy 文案含等待指引');
    assert.match(r2.error, /zsw cancel --id/, 'A-9：busy 文案含取消命令指引');
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

test('resume 不活跃会话：-32004 触发恢复序，fake 无 resume 方法（-32601）原样上抛归 drift 不吞', async () => {
  // fixtures fake 不认识 session/resume（default -32601）——恰好覆盖 D3 互斥衔接：
  // 恢复序中收 -32601/-32602 不吞不重试，交既有分类路径出 protocol-drift
  const { runner } = newRunner();
  const { value: r, lines } = await captureStderr(() =>
    runner.resume({ kind: 'apc', sessionId: 'sess_fake_never' }, '幽灵会话', { timeoutMs: 15000 }));
  assert.equal(r.status, 'error');
  assert.equal(r.errorKind, 'protocol-drift'); // -32004 → 恢复序 → resume -32601 → drift（不吞）
  assert.match(r.error, /-32601/);
  assert.match(r.error, /apc-smoke/);
  assert.match(r.error, /ZSW_RUNNER=spawn/);
  assert.ok(lines.some((l) => l.includes('[zsub:appserver]') && l.includes('protocol-drift')), 'stderr 双落点');
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

// ------------------------------------------------- 协议漂移分类（D3/G3）

test('classifyApcError：-32601/-32602 归 protocol-drift，文案含冒烟命令与回退开关', () => {
  assert.equal(classifyApcError({ code: -32601, message: 'method not found' }).kind, 'protocol-drift');
  assert.equal(classifyApcError({ code: -32602, message: 'ZodError' }).kind, 'protocol-drift');
  for (const code of [-32601, -32602]) {
    const d = classifyApcError({ code, message: `probe ${code}` });
    assert.match(d.hint, /protocol-drift/);
    assert.match(d.hint, /apc-smoke/, '文案含升级冒烟场景名');
    assert.match(d.hint, /ZSW_RUNNER=spawn/, '文案含显式回退开关');
    assert.match(d.hint, new RegExp(String(code)), '文案保留原始错误码便于取证');
  }
});

test('classifyApcError：其他错误码互斥不遮蔽（-32004/-32010/-32031/-32022/-32603/无码 → null）', () => {
  for (const code of [-32004, -32010, -32031, -32022, -32603]) {
    assert.equal(classifyApcError({ code, message: 'x' }), null, String(code));
  }
  assert.equal(classifyApcError(new Error('no code')), null);
  assert.equal(classifyApcError(null), null);
  assert.equal(classifyApcError(undefined), null);
});

test('start 遇 -32602（create 参数漂移）：errorKind=protocol-drift + stderr 双落点 + 指引文案（fake fail-create）', async () => {
  process.env.FAKE_MODE = 'fail-create';
  try {
    const { runner } = newRunner();
    const { value: result, lines } = await captureStderr(async () => {
      const handle = runner.start(baseTaskCtx('参数漂移任务'));
      return await handle.done;
    });
    assert.equal(result.status, 'error');
    assert.equal(result.errorKind, 'protocol-drift', 'record 落点：RunResult.errorKind');
    assert.match(result.error, /-32602/);
    assert.match(result.error, /apc-smoke/);
    assert.match(result.error, /ZSW_RUNNER=spawn/);
    const drift = lines.filter((l) => l.includes('[zsub:appserver]') && l.includes('protocol-drift'));
    assert.ok(drift.length >= 1, `stderr 应出声漂移分类，捕获: ${lines.join(' | ').slice(0, 300)}`);
    assert.match(drift[0], /apc-smoke/);
    await runner.shutdown();
  } finally {
    delete process.env.FAKE_MODE;
  }
});

test('start 遇 -32601（方法消失漂移）：errorKind=protocol-drift + stderr 双落点（inline errfake）', async () => {
  process.env.FAKE_ERR_CODE = '-32601';
  process.env.FAKE_ERR_METHOD = 'session/create';
  process.env.ZSW_ZCODE_CLI = writeErrFake();
  try {
    const { runner } = newRunner();
    const { value: result, lines } = await captureStderr(async () => {
      const handle = runner.start(baseTaskCtx('方法消失任务'));
      return await handle.done;
    });
    assert.equal(result.status, 'error');
    assert.equal(result.errorKind, 'protocol-drift');
    assert.match(result.error, /-32601/);
    assert.match(result.error, /apc-smoke/);
    assert.match(result.error, /ZSW_RUNNER=spawn/);
    assert.ok(
      lines.some((l) => l.includes('[zsub:appserver]') && l.includes('protocol-drift')),
      `stderr 出声缺失，捕获: ${lines.join(' | ').slice(0, 300)}`,
    );
    await runner.shutdown();
  } finally {
    delete process.env.FAKE_ERR_CODE;
    delete process.env.FAKE_ERR_METHOD;
    restoreFakeCli();
  }
});

test('resume 遇 -32602（send 参数漂移）：errorKind=protocol-drift + 指引（inline errfake）', async () => {
  process.env.FAKE_ERR_CODE = '-32602';
  process.env.FAKE_ERR_METHOD = 'session/send';
  process.env.ZSW_ZCODE_CLI = writeErrFake();
  try {
    const { runner } = newRunner();
    const { value: r1 } = await captureStderr(() =>
      runner.resume({ kind: 'apc', sessionId: 'sess_errfake' }, '漂移续聊', { timeoutMs: 15000 }));
    assert.equal(r1.status, 'error');
    assert.equal(r1.errorKind, 'protocol-drift');
    assert.match(r1.error, /-32602/);
    assert.match(r1.error, /apc-smoke/);
    assert.match(r1.error, /ZSW_RUNNER=spawn/);
    await runner.shutdown();
  } finally {
    delete process.env.FAKE_ERR_CODE;
    delete process.env.FAKE_ERR_METHOD;
    restoreFakeCli();
  }
});

// ------------------------------------------------- A4 read 形态收口（2026-08-29 真机）

test('extractAssistantText：真机实测形态（info.role + parts text）提取正文，timeline 事件不误取', () => {
  // 2026-08-29 apc-smoke 真机抓包简版：首条是 timeline 事件（info.role=assistant
  // 但 parts 无 text），末条才是真正回复
  const realShape = {
    messages: [
      {
        info: { role: 'assistant', semantics: { kind: 'timeline_event' }, tokens: { input: 0, output: 0 } },
        parts: [{ type: 'timeline', timelineType: 'model_change', display: 'separator' }],
      },
      {
        info: { role: 'user', semantics: { kind: 'user_prompt' } },
        parts: [{ type: 'text', text: '只回复两个字：就绪。' }],
      },
      {
        info: { role: 'assistant', finish: 'stop', tokens: { input: 15166, output: 5 } },
        parts: [
          { type: 'step-start' },
          { type: 'text', text: '就绪。' },
          { type: 'step-finish', reason: 'stop', tokens: { input: 15166, output: 5 } },
        ],
      },
    ],
    projection: { sessionId: 'sess_x', status: 'idle' },
  };
  assert.equal(extractAssistantText(realShape), '就绪。');
  assert.deepEqual(extractReadUsage(realShape), { input: 15166, output: 5 }); // step-finish tokens
});

test('extractAssistantText/extractReadUsage：旧形态（m.role + m.content / 顶层 usage）兼容不回归', () => {
  const oldShape = {
    messages: [
      { role: 'user', content: '问' },
      { role: 'assistant', content: '答' },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
  assert.equal(extractAssistantText(oldShape), '答');
  assert.deepEqual(extractReadUsage(oldShape), { input_tokens: 10, output_tokens: 20 }); // 顶层 usage 兜底
  // 无任何 usage 来源 → undefined（result.usage 缺失）
  assert.equal(extractReadUsage({ messages: [{ role: 'assistant', content: '答' }] }), undefined);
  assert.equal(extractReadUsage(null), undefined);
  // content 块数组形态（历史兼容断言）
  assert.equal(extractAssistantText({ messages: [{ role: 'assistant', content: [{ text: '块' }, { text: '拼接' }] }] }), '块拼接');
});

// ------------------------------------------------- -32004 四步恢复序（D2/F0）

/** 恢复序主路径用例的 taskCtx：runEnv.createParams.model 是 runtimeModel 目标解析主路径。 */
function recoveryTaskCtx(prompt, overrides = {}) {
  return baseTaskCtx(prompt, {
    runEnv: { createParams: { model: { providerId: 'prov-fake', modelId: 'GLM-5.3' } } },
    ...overrides,
  });
}

test('恢复序全链：-32004 → resume{runtimeModel} → 重挂 subscribe → send 重试成功 → 终态可达', async () => {
  process.env.FAKE_R_MODE = 'evict';
  const { runner, stateFile } = newRecoveryRunner(writeRecoveryFake());
  try {
    // 首轮正常（evict 模式：终态推送后立即驱逐，模拟引擎重启/驻留池驱逐）
    const handle = runner.start(recoveryTaskCtx('第一轮'));
    const r1 = await handle.done;
    assert.equal(r1.status, 'closed');

    // 第二轮 send → -32004 → 四步恢复序
    const r2 = await runner.resume(handle.exec, '恢复暗号', { timeoutMs: 15000 });
    assert.equal(r2.status, 'closed', `恢复后应正常完成: ${JSON.stringify(r2).slice(0, 200)}`);
    assert.equal(r2.response, 'FAKE_READ:恢复暗号');

    const evs = readState(stateFile);
    const resumeEvs = evs.filter((e) => e.ev === 'resume');
    assert.equal(resumeEvs.length, 1, '恰好一次恢复序');
    const rt = resumeEvs[0].runtimeModel;
    // runtimeModel 形态（F0 schema strict 实测）：model 目标 = 会话登记的 create model；
    // provider 忠实携带 v2 config 传输配置（会被引擎注册进 workspaceModelCatalogs）
    assert.match(rt.revision, /^zsw-recover-/);
    assert.equal(typeof rt.generatedAt, 'number');
    assert.deepEqual(rt.model, { providerId: 'prov-fake', modelId: 'GLM-5.3' });
    assert.equal(rt.provider.providerId, 'prov-fake');
    assert.equal(rt.provider.kind, 'anthropic');
    assert.equal(rt.provider.label, 'Prov Fake');
    assert.equal(rt.provider.source, 'custom');
    assert.equal(rt.provider.baseURL, 'https://fake.example/api');
    assert.deepEqual(rt.provider.apiKey, { source: 'inline', value: 'sk-fake-secret-123' }); // 仅回传引擎
    assert.deepEqual(rt.provider.models, [{ modelId: 'GLM-5.3' }, { modelId: 'GLM-5.3-Flash' }]);

    // 四步时序（seq 单调）：resume → 重挂 subscribe → 重试 send → 终态可达（closed 本身）
    const after = evs.filter((e) => e.seq > resumeEvs[0].seq);
    const sub = after.find((e) => e.ev === 'subscribe' && e.sessionId === handle.exec.sessionId);
    assert.ok(sub, '恢复序重挂了 session/subscribe');
    assert.equal(sub.deliveryKind, 'desktop-continuous');
    const retry = after.find((e) => e.ev === 'send' && e.sessionId === handle.exec.sessionId);
    assert.ok(retry, '恢复序重试了原 send');
    assert.equal(retry.content, '恢复暗号');
    assert.ok(sub.seq < retry.seq, '先重挂订阅再重试 send');
  } finally {
    delete process.env.FAKE_R_MODE;
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('恢复序凭据脱敏：stderr 出声含模型目标摘要，不含 apiKey', async () => {
  process.env.FAKE_R_MODE = 'evict';
  const { runner } = newRecoveryRunner(writeRecoveryFake());
  try {
    const handle = runner.start(recoveryTaskCtx('脱敏检查'));
    await handle.done;
    const { value: r2, lines } = await captureStderr(() => runner.resume(handle.exec, '续', { timeoutMs: 15000 }));
    assert.equal(r2.status, 'closed');
    const joined = lines.join('');
    assert.match(joined, /-32004/, '恢复序出声含触发错误码');
    assert.match(joined, /prov-fake\/GLM-5\.3/, '出声含模型目标摘要（describeModelTarget）');
    assert.ok(!joined.includes('sk-fake-secret-123'), 'stderr 绝不落 apiKey');
  } finally {
    delete process.env.FAKE_R_MODE;
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('反向断言（订阅重挂缺失时终态不达）：未订阅会话 send accepted 但无终态推送', async () => {
  // fake 的「未订阅不推终态」语义是恢复序全链用例有判别力的前提：若 runner 漏了
  // 重挂订阅，恢复后的轮必然挂到 ④ 窗口耗尽（假死），不可能 closed
  const { runner } = newRecoveryRunner(writeRecoveryFake());
  try {
    const conn = runner._ensureConnection(TMP);
    const pushes = [];
    conn.onPush((method) => pushes.push(method));
    const created = await conn.request('session/create', {
      workspace: { workspacePath: TMP, workspaceKey: 'rev-sub-check' },
      mode: 'yolo',
      persistence: 'immediate',
    }, { timeoutMs: 5000 });
    const sid = created.session.sessionId;
    await conn.request('session/send', { sessionId: sid, content: '未订阅投递' }, { timeoutMs: 5000 });
    await sleep(300);
    assert.ok(!pushes.includes('v4/telemetry/event'), '未订阅 → send accepted 但终态不达（真实 per-session 订阅语义）');
    await conn.request('session/subscribe', { sessionId: sid, deliveryKind: 'desktop-continuous' }, { timeoutMs: 5000 });
    await conn.request('session/send', { sessionId: sid, content: '订阅后投递' }, { timeoutMs: 5000 });
    assert.ok(await waitFor(() => pushes.includes('v4/telemetry/event'), 3000), '订阅后终态可达');
  } finally {
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('D2 ④：恢复后事件流不可达（窗口耗尽）→ session/stop 清场 + 分支 B 收尾', async () => {
  process.env.FAKE_R_MODE = 'evict,no-terminal-after-recover';
  const { runner, stateFile } = newRecoveryRunner(writeRecoveryFake());
  try {
    const handle = runner.start(recoveryTaskCtx('窗口耗尽首轮'));
    await handle.done;
    const { value: r, lines } = await captureStderr(() =>
      runner.resume(handle.exec, '恢复后无终态', { timeoutMs: 500 }));
    assert.equal(r.status, 'error');
    // 分支 B 文案（复审 INFO-1：语境适配「事件流不可达」）——禁止裸错误码
    assert.match(r.error, /会话恢复失败/);
    assert.match(r.error, /事件流不可达/);
    assert.match(r.error, /session\/stop 清场/);
    assert.match(r.error, /zsw start 重建任务/);
    assert.match(r.error, /record 已保留历史输出/);
    assert.match(r.error, /ZSW_RUNNER=spawn/);
    assert.equal(r.errorKind, undefined); // 分支 B 不是 protocol-drift
    assert.ok(lines.some((l) => l.includes('[zsub:appserver]') && l.includes('会话恢复失败')), '分支 B stderr 双落点');
    // ④ 清场：stop 已发出（防引擎侧孤儿轮）
    assert.ok(
      await waitFor(() => findEvs(stateFile, 'stop').some((e) => e.sessionId === handle.exec.sessionId)),
      '窗口耗尽后 session/stop 已发出',
    );
  } finally {
    delete process.env.FAKE_R_MODE;
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('D2 ①失败：resume 回 -32031 → 分支 B（无重试 send）', async () => {
  process.env.FAKE_R_MODE = 'evict,resume-fails';
  const { runner, stateFile } = newRecoveryRunner(writeRecoveryFake());
  try {
    const handle = runner.start(recoveryTaskCtx('resume失败首轮'));
    await handle.done;
    const { value: r } = await captureStderr(() => runner.resume(handle.exec, '续', { timeoutMs: 15000 }));
    assert.equal(r.status, 'error');
    assert.match(r.error, /会话恢复失败/);
    assert.match(r.error, /-32031/, '错误码随语境带出做取证（非裸错误码：有完整指引）');
    assert.match(r.error, /zsw start 重建任务/);
    assert.match(r.error, /record 已保留历史输出/);
    assert.match(r.error, /ZSW_RUNNER=spawn/);
    assert.equal(r.errorKind, undefined);
    // 恢复序在 ① 失败即中止：无 subscribe 重挂、无重试 send
    const evs = readState(stateFile);
    assert.equal(evs.filter((e) => e.ev === 'resume').length + evs.filter((e) => e.ev === 'resume-err').length, 1, '一次 resume 尝试');
    assert.equal(evs.filter((e) => e.ev === 'send').length, 1, '只有首轮 send，无重试');
  } finally {
    delete process.env.FAKE_R_MODE;
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('D2 ③失败：resume+subscribe 成功但重试 send 仍 -32031 → 分支 B', async () => {
  process.env.FAKE_R_MODE = 'evict,send-still-fails';
  const { runner, stateFile } = newRecoveryRunner(writeRecoveryFake());
  try {
    const handle = runner.start(recoveryTaskCtx('重试失败首轮'));
    await handle.done;
    const { value: r } = await captureStderr(() => runner.resume(handle.exec, '续', { timeoutMs: 15000 }));
    assert.equal(r.status, 'error');
    assert.match(r.error, /会话恢复失败/);
    assert.match(r.error, /重试 send 失败/);
    assert.match(r.error, /-32031/);
    assert.match(r.error, /zsw start 重建任务/);
    assert.match(r.error, /ZSW_RUNNER=spawn/);
    // 恢复序走到了 ③：resume 与 subscribe 重挂都发生过
    assert.equal(findEvs(stateFile, 'resume').length, 1);
    assert.equal(findEvs(stateFile, 'subscribe').length, 2, '首轮 + 恢复序重挂');
    assert.equal(findEvs(stateFile, 'send').length, 1, '无成功重试 send');
    assert.ok(findEvs(stateFile, 'send-err').some((e) => e.code === -32031), '重试 send 的 -32031 留痕');
  } finally {
    delete process.env.FAKE_R_MODE;
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('恢复互斥：两路并发 -32004 恢复串行化（第二路在第一路恢复序落定后才开始）', async () => {
  process.env.FAKE_R_MODE = 'evict';
  const { runner, stateFile } = newRecoveryRunner(writeRecoveryFake());
  try {
    const h1 = runner.start(recoveryTaskCtx('互斥甲'));
    const h2 = runner.start(recoveryTaskCtx('互斥乙'));
    await Promise.all([h1.done, h2.done]); // 两会话均已 evict
    const [r1, r2] = await Promise.all([
      runner.resume(h1.exec, '甲恢复', { timeoutMs: 15000 }),
      runner.resume(h2.exec, '乙恢复', { timeoutMs: 15000 }),
    ]);
    assert.equal(r1.status, 'closed');
    assert.equal(r2.status, 'closed');
    // 时序断言：第二路的 resume 晚于第一路恢复序的（重试）send——F0 C 线：互斥防恢复风暴
    const evs = readState(stateFile);
    const resumes = evs.filter((e) => e.ev === 'resume');
    assert.equal(resumes.length, 2);
    const first = resumes[0];
    const second = resumes[1];
    assert.notEqual(first.sessionId, second.sessionId);
    const firstRetrySend = evs
      .filter((e) => e.ev === 'send' && e.sessionId === first.sessionId)
      .pop();
    assert.ok(firstRetrySend, '第一路重试 send 存在');
    assert.ok(
      second.seq > firstRetrySend.seq,
      `第二路 resume(seq=${second.seq}) 应晚于第一路恢复序落定（重试 send seq=${firstRetrySend.seq}）`,
    );
  } finally {
    delete process.env.FAKE_R_MODE;
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('-32010 不重试：busy 如实上报，恢复序不触发（无 resume 请求）', async () => {
  process.env.FAKE_R_MODE = 'busy';
  const { runner, stateFile } = newRecoveryRunner(writeRecoveryFake());
  try {
    // -32010 的真实语义要求会话在引擎内存中存活且在跑：先 create 一个活会话再投递
    const conn = runner._ensureConnection(TMP);
    const created = await conn.request('session/create', {
      workspace: { workspacePath: TMP, workspaceKey: 'busy-check' },
      mode: 'yolo',
      persistence: 'immediate',
    }, { timeoutMs: 5000 });
    const sid = created.session.sessionId;
    const r = await runner.resume({ kind: 'apc', sessionId: sid }, '趁忙投递', { timeoutMs: 15000 });
    assert.equal(r.status, 'error');
    assert.match(r.error, /-32010/);
    assert.match(r.error, /等待当前轮完成/, 'A-9：-32010 兜底透传附加 busy 语境指引');
    assert.match(r.error, /zsw cancel --id/, 'A-9：-32010 兜底透传附取消命令');
    assert.doesNotMatch(r.error || '', /会话恢复失败/, 'busy 不是恢复失败，不落分支 B');
    assert.equal(findEvs(stateFile, 'resume').length, 0, '-32010 不触发恢复序');
  } finally {
    delete process.env.FAKE_R_MODE;
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('runtimeModel 幽灵恢复兜底：会话登记无 model → v2 config model.main 解析', async () => {
  // daemon 重启后 _sessions 无登记（A-2b 变体）：model 目标回退 v2 model.main
  const { runner, stateFile } = newRecoveryRunner(writeRecoveryFake());
  try {
    const r = await runner.resume({ kind: 'apc', sessionId: 'sess_ghost' }, '幽灵恢复', { timeoutMs: 15000 });
    assert.equal(r.status, 'closed', `幽灵恢复应走通: ${JSON.stringify(r).slice(0, 200)}`);
    const rt = findEvs(stateFile, 'resume')[0].runtimeModel;
    assert.deepEqual(rt.model, { providerId: 'prov-fake', modelId: 'GLM-5.3' }); // v2 model.main
    assert.equal(rt.provider.baseURL, 'https://fake.example/api');
  } finally {
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('runtimeModel 构造失败（v2 config 无凭据）→ 恢复序①前中止，分支 B 诚实报错', async () => {
  const { runner, stateFile } = newRecoveryRunner(writeRecoveryFake());
  const backup = fs.readFileSync(V2_FIXTURE_PATH, 'utf8');
  try {
    fs.writeFileSync(V2_FIXTURE_PATH, JSON.stringify({ provider: { 'prov-fake': { models: { 'GLM-5.3': {} } } } }));
    const { value: r } = await captureStderr(() =>
      runner.resume({ kind: 'apc', sessionId: 'sess_ghost_nov2' }, '无凭据恢复', { timeoutMs: 15000 }));
    assert.equal(r.status, 'error');
    assert.match(r.error, /会话恢复失败/);
    assert.match(r.error, /无法构造 runtimeModel/);
    assert.match(r.error, /zsw start 重建任务/);
    // 构造失败不发盲请求：无 resume / subscribe 请求到达 fake
    assert.equal(findEvs(stateFile, 'resume').length, 0);
    assert.equal(findEvs(stateFile, 'resume-err').length, 0);
  } finally {
    fs.writeFileSync(V2_FIXTURE_PATH, backup);
    await runner.shutdown();
    restoreFakeCli();
  }
});

// ------------------------------------------- D5/D6 thinking 与工具限制（F4）

/**
 * thinking/工具限制专用 fake（写进测试 TMP，after 统一清理；fixtures/fake-appserver.js
 * 不在本单元领地且无 workspace/readState，按 errfake/recfake 先例 inline）。
 * 协议面对齐 lib/runner-appserver.js 头注实测事实；read/readState 应答携带
 * settings.thoughtLevel（F1 真机实测面）供校验源与顺带沉淀断言。
 * env 开关（spawn 时固化）：
 *   FAKE_T_AVAILABLE=low,high   thoughtLevel.available（缺省 low,high,max）
 *   FAKE_T_READSTATE=off        workspace/readState 回 -32601（校验源漂移模拟）
 */
let thinkFakeSeq = 0;
function writeThinkingFake() {
  const p = path.join(TMP, `thinkfake-${++thinkFakeSeq}.cjs`);
  fs.writeFileSync(p, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    "const AVAILABLE = (process.env.FAKE_T_AVAILABLE || 'low,high,max').split(',').map((s) => s.trim()).filter(Boolean);",
    "const STATE = process.env.FAKE_STATE_FILE;",
    "let seq = 0;",
    "let sessSeq = 0;",
    "const live = new Map();   // sid -> {content, subscribed}",
    "const log = (ev, data = {}) => { if (!STATE) return; try { fs.appendFileSync(STATE, JSON.stringify({ seq: ++seq, ev, ...data }) + '\\n'); } catch {} };",
    "const out = (f) => process.stdout.write(JSON.stringify(f) + '\\n');",
    "const reply = (id, result) => out({ id, result });",
    "const replyErr = (id, code, message) => out({ id, error: { code, message } });",
    "const thoughtLevel = () => ({ available: AVAILABLE, current: AVAILABLE[AVAILABLE.length - 1], defaultLevel: AVAILABLE[AVAILABLE.length - 1] });",
    "out({ method: 'protocol', params: { name: 'ZCode Protocol', version: 1 } });",
    "function simulate(sid) {",
    "  setTimeout(() => {",
    "    const s = live.get(sid);",
    "    if (!s) return;",
    "    out({ method: 'v4/telemetry/event', params: { kind: 'turn.terminal', status: 'success', sessionId: sid } });",
    "    out({ method: 'session/event', params: { sessionId: sid, payload: { response: 'FAKE_T:' + s.content, usage: { input: 1, output: 1 } } } });",
    "  }, 15);",
    "}",
    "rl.on('line', (line) => {",
    "  if (!line.trim()) return;",
    "  let f;",
    "  try { f = JSON.parse(line); } catch { return; }",
    "  if (!(f && f.id != null && f.method)) return; // 本 fake 不发反向请求",
    "  const { id, method, params = {} } = f;",
    "  if (method === 'session/create') {",
    "    const sid = 'sess_t_' + (++sessSeq);",
    "    live.set(sid, { content: '', subscribed: false });",
    "    log('create', { params });",
    "    return reply(id, { session: { sessionId: sid } });",
    "  }",
    "  if (method === 'session/subscribe') {",
    "    const s = live.get(params.sessionId);",
    "    if (s) s.subscribed = true;",
    "    return reply(id, { subscribed: true });",
    "  }",
    "  if (method === 'session/send') {",
    "    const s = live.get(params.sessionId);",
    "    if (!s) return replyErr(id, -32004, 'Session not active (thinkfake)');",
    "    s.content = String(params.content ?? '');",
    "    reply(id, { accepted: true });",
    "    if (s.subscribed) simulate(params.sessionId); // 未订阅不推终态（per-session 订阅语义）",
    "    return;",
    "  }",
    "  if (method === 'session/read') {",
    "    const s = live.get(params.sessionId);",
    "    log('read', { sessionId: params.sessionId });",
    "    return reply(id, {",
    "      messages: [{ role: 'user', content: (s && s.content) || '' }, { role: 'assistant', content: 'FAKE_T_READ:' + ((s && s.content) || '') }],",
    "      settings: { thoughtLevel: thoughtLevel() },",
    "    });",
    "  }",
    "  if (method === 'workspace/readState') {",
    "    if (process.env.FAKE_T_READSTATE === 'off') { log('readstate-err', { code: -32601 }); return replyErr(id, -32601, 'method not found (thinkfake)'); }",
    "    log('readstate', {});",
    "    return reply(id, { settings: { thoughtLevel: thoughtLevel() } });",
    "  }",
    "  if (method === 'session/list') return reply(id, { sessions: [...live.keys()].map((x) => ({ sessionId: x })) });",
    "  return replyErr(id, -32601, 'method not found (thinkfake): ' + method);",
    "});",
    "rl.on('close', () => process.exit(0));",
  ].join('\n'));
  return p;
}

/** thinking 用例 taskCtx：runEnv.createParams 由 model-router 组装形态（model + 会话级参数）。 */
function thinkingTaskCtx(prompt, createParams, overrides = {}) {
  return baseTaskCtx(prompt, {
    runEnv: { createParams: { model: { providerId: 'prov-fake', modelId: 'GLM-5.3' }, ...createParams } },
    ...overrides,
  });
}

test('D5 thinking：合法档位经 workspace/readState 校验后生效，连接级缓存只读一次', async () => {
  const { runner, stateFile } = newRecoveryRunner(writeThinkingFake());
  try {
    const handle = runner.start(thinkingTaskCtx('低档任务', { thoughtLevel: 'low' }));
    const result = await handle.done;
    assert.equal(result.status, 'closed', JSON.stringify(result).slice(0, 200));
    assert.equal(result.thinking, 'low', '实际生效档位随 result 上行');
    const evs = readState(stateFile);
    const create = evs.find((e) => e.ev === 'create');
    assert.equal(create.params.thoughtLevel, 'low', 'create 携带校验通过的档位');
    assert.equal(evs.filter((e) => e.ev === 'readstate').length, 1, '首个 thinking 任务发一次 workspace/readState');

    // 同连接第二个 thinking 任务：命中连接级缓存，不再发 readState
    const h2 = runner.start(thinkingTaskCtx('第二任务', { thoughtLevel: 'high' }));
    const r2 = await h2.done;
    assert.equal(r2.status, 'closed');
    assert.equal(r2.thinking, 'high');
    assert.equal(readState(stateFile).filter((e) => e.ev === 'readstate').length, 1, '缓存命中：readState 仍只有 1 次');
    assert.equal(readState(stateFile).find((e) => e.ev === 'create' && e.params.thoughtLevel === 'high') != null, true);
  } finally {
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('D5 thinking：非法档位 stderr warn 跳过（create 不带 thoughtLevel，任务不失败）', async () => {
  process.env.FAKE_T_AVAILABLE = 'low,high';
  const { runner, stateFile } = newRecoveryRunner(writeThinkingFake());
  try {
    const { value: result, lines } = await captureStderr(() => {
      const handle = runner.start(thinkingTaskCtx('非法档任务', { thoughtLevel: 'max' }));
      return handle.done;
    });
    assert.equal(result.status, 'closed', '非法值不失败（P2 容错语义）');
    assert.equal(result.thinking, null, '跳过标注为 null');
    const create = readState(stateFile).find((e) => e.ev === 'create');
    assert.equal('thoughtLevel' in create.params, false, '非法档位不占 create 参数面');
    const warn = lines.filter((l) => l.includes('--thinking') && l.includes('max'));
    assert.ok(warn.length >= 1, `stderr 出声跳过原因，捕获: ${lines.join(' | ').slice(0, 200)}`);
    assert.match(warn[0], /low, high/, 'warn 含可用档位清单');
  } finally {
    delete process.env.FAKE_T_AVAILABLE;
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('D5 thinking：未请求则 create 无 thoughtLevel 且不发 readState，result.thinking 缺省', async () => {
  const { runner, stateFile } = newRecoveryRunner(writeThinkingFake());
  try {
    const handle = runner.start(thinkingTaskCtx('无档位任务', {}));
    const result = await handle.done;
    assert.equal(result.status, 'closed');
    assert.equal(result.thinking, undefined);
    const evs = readState(stateFile);
    assert.equal('thoughtLevel' in evs.find((e) => e.ev === 'create').params, false);
    assert.equal(evs.some((e) => e.ev === 'readstate'), false, '未请求不发校验请求');
  } finally {
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('D5 thinking：校验源不可用（readState -32601）→ 透传引擎容错，任务不失败', async () => {
  process.env.FAKE_T_READSTATE = 'off';
  const { runner, stateFile } = newRecoveryRunner(writeThinkingFake());
  try {
    const { value: result, lines } = await captureStderr(() => {
      const handle = runner.start(thinkingTaskCtx('校验源漂移任务', { thoughtLevel: 'low' }));
      return handle.done;
    });
    assert.equal(result.status, 'closed', 'readState 漂移不拖垮任务（-32601 在校验层消化，不上抛 drift 分类）');
    assert.equal(result.thinking, 'low', '档位透传给引擎（引擎 P2 容错兜底）');
    const create = readState(stateFile).find((e) => e.ev === 'create');
    assert.equal(create.params.thoughtLevel, 'low');
    assert.ok(
      lines.some((l) => l.includes('workspace/readState 不可用')),
      `校验源不可用出声，捕获: ${lines.join(' | ').slice(0, 200)}`,
    );
  } finally {
    delete process.env.FAKE_T_READSTATE;
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('D5 thinking：session/read 应答的 settings.thoughtLevel 顺带沉淀校验缓存', async () => {
  const { runner, stateFile } = newRecoveryRunner(writeThinkingFake());
  try {
    // 任务 A 无 thinking：轮终态后的 session/read 应答携带 settings 面 → 沉淀缓存
    const h1 = runner.start(thinkingTaskCtx('铺垫任务', {}));
    const r1 = await h1.done;
    assert.equal(r1.status, 'closed');
    assert.equal(readState(stateFile).some((e) => e.ev === 'readstate'), false);
    // 任务 B thinking：命中 read 沉淀的缓存，零 readState 请求
    const h2 = runner.start(thinkingTaskCtx('受益任务', { thoughtLevel: 'low' }));
    const r2 = await h2.done;
    assert.equal(r2.status, 'closed');
    assert.equal(r2.thinking, 'low');
    assert.equal(readState(stateFile).filter((e) => e.ev === 'readstate').length, 0, 'read 应答沉淀生效：免发 readState');
  } finally {
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('D6 工具限制双来源：CLI deny ∪ frontmatter disallowedTools 并集去重入 create', async () => {
  const { runner, stateFile } = newRecoveryRunner(writeThinkingFake());
  try {
    const handle = runner.start(thinkingTaskCtx('工具限制任务', {
      toolAllowlist: ['Read', ' Grep '],
      toolDenylist: ['Bash', 'WebSearch'],
    }, {
      // frontmatter 来源（manager 组 taskCtx 的 disallowedTools 字段）：与 CLI deny 有交集 + 含脏值
      disallowedTools: ['Bash', ' mcp__demo__x ', 42, null],
    }));
    const result = await handle.done;
    assert.equal(result.status, 'closed');
    const create = readState(stateFile).find((e) => e.ev === 'create').params;
    assert.deepEqual(create.toolDenylist, ['Bash', 'WebSearch', 'mcp__demo__x'],
      '并集去重 + 规范化（trim/滤非字符串），CLI 来源在前');
    assert.deepEqual(create.toolAllowlist, ['Read', 'Grep'], 'allowlist 规范化后原样入 create');
  } finally {
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('D6 工具限制：两来源皆空时 create 不携带工具限制键', async () => {
  const { runner, stateFile } = newRecoveryRunner(writeThinkingFake());
  try {
    const handle = runner.start(thinkingTaskCtx('无工具限制任务', {}));
    const result = await handle.done;
    assert.equal(result.status, 'closed');
    const create = readState(stateFile).find((e) => e.ev === 'create').params;
    assert.equal('toolDenylist' in create, false);
    assert.equal('toolAllowlist' in create, false);
  } finally {
    await runner.shutdown();
    restoreFakeCli();
  }
});

// ------------------------------------------------- D4 create 显式化 / D8 遥测 / D3 落盘

test('D4：create 固定携带 persistence:"immediate"，上游 createParams 不可覆盖', async () => {
  const { runner, stateFile } = newRunner();
  const handle = runner.start(baseTaskCtx('持久化显式化', {
    runEnv: { createParams: { model: { providerId: 'builtin:bigmodel-coding-plan', modelId: 'GLM-5.3' }, persistence: 'deferred' } }, // 恶意覆盖尝试
  }));
  const result = await handle.done;
  assert.equal(result.status, 'closed');
  const create = readState(stateFile).find((e) => e.ev === 'create');
  assert.equal(create.params.persistence, 'immediate', 'runner 固定 immediate（可恢复 + list 可见，D4）');
  await runner.shutdown();
});

test('D8：引擎子进程 env 注入 ZCODE_MODEL_TELEMETRY_ENABLED=false（fake 端到端取证）', async () => {
  const { runner, stateFile } = newRecoveryRunner(writeRecoveryFake());
  try {
    const handle = runner.start(recoveryTaskCtx('遥测关闭'));
    const result = await handle.done;
    assert.equal(result.status, 'closed');
    const env = findEvs(stateFile, 'env')[0];
    assert.ok(env, 'fake 启动 env 事件已落盘');
    assert.equal(env.telemetry, 'false', '真实子进程 env 中遥测已关');
    assert.equal(env.nested, '1', 'ZSW_NESTED 防递归标记仍在（不回归）');
  } finally {
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('D3：引擎 stderr 实时落盘（注入路径），退出摘要行为保留', async () => {
  process.env.FAKE_R_STDERR = '1';
  const injectLog = path.join(TMP, 'logs-inject', 'engine.log');
  const { runner } = newRecoveryRunner(writeRecoveryFake(), { stderrLogPath: injectLog });
  try {
    const handle = runner.start(recoveryTaskCtx('落盘取证'));
    const result = await handle.done;
    assert.equal(result.status, 'closed');
    assert.ok(
      await waitFor(() => {
        try { return fs.readFileSync(injectLog, 'utf8').includes('rfake-stderr-line-A'); } catch { return false; }
      }),
      'stderr 实时 append 到注入路径',
    );
    const content = fs.readFileSync(injectLog, 'utf8');
    assert.match(content, /rfake-stderr-line-A/);
    assert.match(content, /rfake-stderr-line-B/);
    // 退出摘要（既有行为）：进程退出 reason 仍带 stderr 尾部
    const conn = runner._conn;
    await conn.shutdown();
    assert.match(conn.exitReason, /stderr 尾部/);
  } finally {
    delete process.env.FAKE_R_STDERR;
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('D7：config 不再含 idleConversationTtlMs（会话回收职责归引擎驻留池）', () => {
  const configLib = require('../lib/config');
  assert.equal('idleConversationTtlMs' in configLib.DEFAULTS, false);
  assert.equal(typeof configLib.logsDir, 'function', 'logsDir() 已就位（D3 落盘路径单一事实源）');
  assert.ok(configLib.logsDir().endsWith(path.join('logs')));
});

// ------------------------------------------------- release：一次性会话终态释放（wave2 D2）

/**
 * release 专用 fake（写进测试 TMP，after 统一清理；fixtures/fake-appserver.js 不在本
 * 单元领地且 close 行为不可注入，按 errfake/recfake 先例 inline）。最小可走通面
 * （create/subscribe/send/turn 终态/read）+ close 注入开关：
 *   FAKE_CLOSE_MODE = error（close 回错误帧）| hang（close 不应答，逼控制面超时）
 */
let relFakeSeq = 0;
function writeReleaseFake() {
  const p = path.join(TMP, `relfake-${++relFakeSeq}.cjs`);
  fs.writeFileSync(p, [
    "'use strict';",
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    "const CLOSE_MODE = process.env.FAKE_CLOSE_MODE || '';",
    "let sessSeq = 0;",
    "const live = new Map();",
    "const out = (f) => process.stdout.write(JSON.stringify(f) + '\\n');",
    "out({ method: 'protocol', params: { name: 'ZCode Protocol', version: 1 } });",
    "function simulate(sid) {",
    "  setTimeout(() => {",
    "    if (!live.has(sid)) return;",
    "    out({ method: 'v4/telemetry/event', params: { kind: 'turn.terminal', status: 'success', sessionId: sid } });",
    "    out({ method: 'session/event', params: { sessionId: sid, payload: { response: 'FAKE_REL:' + sid } } });",
    "  }, 15);",
    "}",
    "rl.on('line', (line) => {",
    "  if (!line.trim()) return;",
    "  let f;",
    "  try { f = JSON.parse(line); } catch { return; }",
    "  if (!(f && f.id != null && f.method)) return;",
    "  const { id, method, params = {} } = f;",
    "  if (method === 'session/create') {",
    "    const sid = 'sess_rel_' + (++sessSeq);",
    "    live.set(sid, { subscribed: false });",
    "    return out({ id, result: { session: { sessionId: sid } } });",
    "  }",
    "  if (method === 'session/subscribe') {",
    "    const s = live.get(params.sessionId);",
    "    if (s) s.subscribed = true;",
    "    return out({ id, result: { subscribed: true } });",
    "  }",
    "  if (method === 'session/send') {",
    "    if (!live.has(params.sessionId)) return out({ id, error: { code: -32004, message: 'not active (relfake)' } });",
    "    out({ id, result: { accepted: true } });",
    "    if (live.get(params.sessionId).subscribed) simulate(params.sessionId);",
    "    return;",
    "  }",
    "  if (method === 'session/read') return out({ id, result: { messages: [{ role: 'assistant', content: 'FAKE_REL_READ' }], usage: { input_tokens: 1, output_tokens: 1 } } });",
    "  if (method === 'session/close') {",
    "    if (CLOSE_MODE === 'error') return out({ id, error: { code: -32000, message: 'close rejected (relfake)' } });",
    "    if (CLOSE_MODE === 'hang') return; // 不应答：逼 runner 的 1.5s 控制面超时",
    "    return out({ id, result: { closed: true } });",
    "  }",
    "  return out({ id, error: { code: -32601, message: 'method not found (relfake): ' + method } });",
    "});",
    "rl.on('close', () => process.exit(0));",
  ].join('\n'));
  return p;
}

test('release：调 session/close 且注销登记（chunks 缓冲随条目回收）', async () => {
  const { runner, stateFile } = newRunner();
  const handle = runner.start(baseTaskCtx('release 正常路径任务'));
  await handle.done;
  assert.ok(runner._sessions.has(handle.exec.sessionId), '前置：done 后会话仍在登记（chunks 聚合缓冲在）');
  await runner.release(handle.exec);
  assert.ok(
    readState(stateFile).some((e) => e.ev === 'close' && e.sessionId === handle.exec.sessionId),
    'session/close 已对该会话发出',
  );
  assert.equal(runner._sessions.has(handle.exec.sessionId), false, '登记已注销（chunks 聚合缓冲随条目删除回收）');
  await runner.shutdown();
});

test('release：close 失败 best-effort 不抛，登记仍注销 + stderr 出声', async () => {
  process.env.FAKE_CLOSE_MODE = 'error';
  const { runner } = newRecoveryRunner(writeReleaseFake());
  try {
    const handle = runner.start(recoveryTaskCtx('close 失败任务'));
    const result = await handle.done;
    assert.equal(result.status, 'closed', '前置：任务正常完成');
    const { lines } = await captureStderr(() => runner.release(handle.exec)); // 不抛即通过
    assert.equal(runner._sessions.has(handle.exec.sessionId), false, 'close 失败仍注销登记（回收不因 close 失败回退）');
    assert.ok(
      lines.some((l) => l.includes('[zsub:appserver]') && l.includes('session/close 失败')),
      `close 失败 stderr 出声，捕获: ${lines.join(' | ').slice(0, 200)}`,
    );
  } finally {
    delete process.env.FAKE_CLOSE_MODE;
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('release：close 挂起 → 1.5s 控制面超时 best-effort 返回不抛', { timeout: 20_000 }, async () => {
  process.env.FAKE_CLOSE_MODE = 'hang';
  const { runner } = newRecoveryRunner(writeReleaseFake());
  try {
    const handle = runner.start(recoveryTaskCtx('close 挂起任务'));
    await handle.done;
    const { lines } = await captureStderr(() => runner.release(handle.exec));
    assert.equal(runner._sessions.has(handle.exec.sessionId), false, '超时路径登记仍注销');
    assert.ok(
      lines.some((l) => l.includes('session/close 失败')),
      '超时按失败出声（best-effort 语义，不静默）',
    );
  } finally {
    delete process.env.FAKE_CLOSE_MODE;
    await runner.shutdown();
    restoreFakeCli();
  }
});

test('release：sessionId 未回填 no-op（不发任何请求、不拉起引擎连接）', async () => {
  const { runner, stateFile } = newRunner();
  await runner.release(undefined);
  await runner.release({});
  await runner.release({ kind: 'spawn', pid: 1 });
  await runner.release({ kind: 'apc', sessionId: undefined }); // create 前失败/取消的早期终态
  await runner.release({ kind: 'apc', sessionId: '' });
  assert.equal(
    readState(stateFile).filter((e) => e.ev === 'close').length, 0,
    '未回填句柄不触发 session/close',
  );
  assert.equal(runner._conn, null, 'release 不得无谓拉起引擎连接（惰性连接不被破坏）');
});

test('wrapWithProbeInvalidation：release 按 exec.kind 路由转发（fromCache 包装面 release 非 undefined）', () => {
  const released = [];
  const fakeInner = {
    capabilities: () => ({ kind: 'appserver', steering: 'none', coldStartMs: 0 }),
    start: () => { throw new Error('not used'); },
    resume: () => { throw new Error('not used'); },
    alive: () => true,
    shutdown: async () => {},
    release: (exec) => released.push(exec),
  };
  const wrapped = wrapWithProbeInvalidation(fakeInner, null);
  assert.equal(typeof wrapped.release, 'function', '包装面必须暴露 release（漏转发则消费方 runner.release 为 undefined）');
  const apcExec = { kind: 'apc', sessionId: 'sess_wrap_x' };
  wrapped.release(apcExec);
  assert.deepEqual(released, [apcExec], 'apc 句柄原样转发 inner');

  // spawn 句柄路由 spawnRunner：wrap 内部惰性 new SpawnRunner，patch prototype 计数
  const SpawnRunner = require('../lib/runner-spawn');
  const orig = SpawnRunner.prototype.release;
  const spawnCalls = [];
  SpawnRunner.prototype.release = function (exec) { spawnCalls.push(exec); };
  try {
    const spawnExec = { kind: 'spawn', pid: 1 };
    wrapped.release(spawnExec);
    assert.deepEqual(spawnCalls, [spawnExec], 'spawn 句柄转发 spawnRunner（参数原样）');
    assert.equal(released.length, 1, 'spawn 句柄不误入 inner');
  } finally {
    SpawnRunner.prototype.release = orig;
  }
});
