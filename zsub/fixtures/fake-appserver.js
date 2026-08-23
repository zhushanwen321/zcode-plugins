'use strict';
/**
 * fake app-server（测试专用，绝不 spawn 真 zcode.cjs）。
 *
 * 启动方式与真协议对齐：`node fake-appserver.js app-server --cwd <dir>`（参数
 * 解析后忽略——fake 不需要）。stdio NDJSON，帧形态对齐 lib/runner-appserver.js
 * 头注的实测事实。
 *
 * 行为由 env 开关控制（spawn 时固化，测试按需设置）：
 *   FAKE_STATE_FILE   事件流水文件（append JSONL，测试断言 fake 侧状态的依据）
 *   FAKE_MODE         fail-create     session/create 回 -32602 ZodError
 *                     no-terminal     send 应答 accepted 但永不推终态（超时路径）
 *                     permission-probe 启动期多发一个未知反向请求 permission/request
 *                     （默认：正常）
 *   FAKE_READ         default           read 可用（主路径）
 *                     read-error        read 报错 → 逼 runner 降级 session/messages
 *                     all-error         read/messages 均报错 → 逼 chunk 聚合（带文本）
 *                     all-error-nochunk 同上且 chunk 不带文本 → 逼「全文获取失败」
 *   FAKE_STATE_SHAPE  real（默认——E7 抓包实证形态，主路径单测的保护对象：
 *                       patch.status + turn.terminal 终态 + session/event
 *                       payload.response 全文，2026-08-23 e2e 抓包）
 *                     | flat（params.status——旧假想形态，仅显式兼容用例）
 *                     | nested（params.state.status——同上）
 *                     —— 验证 interpretEvent 的宽松匹配（A1）与文本兜底链（A3/A4）
 *
 * 反向请求语义：session/create 先发 requestRuntimePreferences 并等 runner 应答，
 * 校验内容后回显（prefsValid / 州文件 prefs-answer），模拟「必答反向请求」。
 */

const fs = require('node:fs');

const STATE_FILE = process.env.FAKE_STATE_FILE;
// S-8：real 是缺省形态（只有显式 flat/nested 才走旧形态分支）——主路径单测
// 默认保护实证协议，真实形态漂移时立即红
const SHAPE = process.env.FAKE_STATE_SHAPE;
const REAL_SHAPE = SHAPE !== 'flat' && SHAPE !== 'nested';
const EXPECTED_PREFS = {
  nativeSearchEnhancementsEnabled: true,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1',
};

function log(ev, data = {}) {
  if (!STATE_FILE) return;
  try {
    fs.appendFileSync(STATE_FILE, `${JSON.stringify({ pid: process.pid, ev, ...data })}\n`);
  } catch { /* 流水写失败不影响协议行为 */ }
}

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const reply = (id, result) => out({ id, result });
const replyErr = (id, code, message, data) => out({ id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

/** 顺序无关的深比较（runner 应答字段序不可依赖）。 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

let reqSeq = 0;   // 反向请求 id 计数
let sessSeq = 0;  // 会话 id 计数
const liveSessions = new Map();   // sessionId -> {lastContent, amSeq}
const pendingReverse = new Map(); // 反向请求 id -> (answer) => void

// 协议自报（推送形态；首帧形态由 runner 的 dispatcher.onProtocol 另行覆盖）
out({ method: 'protocol', params: { name: 'ZCode Protocol', version: 1 } });

if (process.env.FAKE_MODE === 'permission-probe') {
  const permId = `srv-perm-${++reqSeq}`;
  pendingReverse.set(permId, (answer) => log('unknown-reverse-answer', { method: 'permission/request', answer }));
  out({ id: permId, method: 'permission/request', params: { tool: 'Bash', input: { command: 'true' } } });
}

function terminalPush(sessionId) {
  const s = liveSessions.get(sessionId) || { lastContent: '' };
  if (REAL_SHAPE) {
    // 实测形态（e2e 真实抓包 2026-08-23）：轮结束不发 status:idle 的
    // state.updated；权威终态是 turn.terminal + session/event(payload.response
    // 携带最终全文与 usage）
    out({
      method: 'v4/telemetry/event',
      params: { kind: 'turn.terminal', status: 'success', resultType: 'success', toolCallCount: 0, sessionId },
    });
    out({
      method: 'session/event',
      params: {
        sessionId,
        deliveryKind: 'desktop-continuous',
        payload: { response: `FAKE_TURN:${s.lastContent}`, tokenCount: 13, usage: { inputTokens: 11, outputTokens: 2 } },
      },
    });
    return;
  }
  const params = SHAPE === 'nested'
    ? { sessionId, state: { status: 'idle' } }
    : { sessionId, status: 'idle' };
  out({ method: 'state.updated', params });
}

/** send 被接受后模拟一轮：stream.chunk（可带文本）→ running → 终态 idle。 */
function simulateTurn(sessionId) {
  setTimeout(() => {
    const s = liveSessions.get(sessionId);
    if (!s) return;
    s.amSeq += 1;
    const amId = `am-${s.amSeq}`;
    const full = `AGG-STREAM:${s.lastContent}`;
    const noText = process.env.FAKE_READ === 'all-error-nochunk';
    const parts = [full.slice(0, Math.ceil(full.length / 2)), full.slice(Math.ceil(full.length / 2))];
    parts.forEach((p, i) => {
      if (!p) return;
      out({
        method: 'v4/telemetry/event',
        params: {
          kind: 'stream.chunk',
          channel: 'text',
          chunkLength: p.length,
          firstChunk: i === 0,
          assistantMessageId: amId,
          ...(noText ? {} : { chunk: p }),
        },
      });
    });
    // running 帧：real 形态在 patch.status（实测 prompt_started 帧）
    out({
      method: 'state.updated',
      params: REAL_SHAPE
        ? { sessionId, patch: { status: 'running' }, reason: 'prompt_started' }
        : { sessionId, status: 'running' },
    });
    terminalPush(sessionId);
  }, 25);
}

function readPayload(sessionId) {
  const s = liveSessions.get(sessionId) || { lastContent: '' };
  return {
    messages: [
      { role: 'user', content: s.lastContent },
      { role: 'assistant', content: `FAKE_READ:${s.lastContent}` },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

const READ_BROKEN = ['read-error', 'all-error', 'all-error-nochunk'];
const MESSAGES_BROKEN = ['all-error', 'all-error-nochunk'];

function handleClientRequest(frame) {
  const { id, method, params = {} } = frame;
  switch (method) {
    case 'session/create': {
      log('create', { params });
      if (process.env.FAKE_MODE === 'fail-create') {
        replyErr(id, -32602, 'ZodError (fake)', [{ path: ['mode'], message: 'Invalid enum value (fake)' }]);
        return;
      }
      // 必答反向请求：等 runner 应答并校验后才回 create 响应（对齐实测握手）
      const prefsId = `srv-prefs-${++reqSeq}`;
      pendingReverse.set(prefsId, (answer) => {
        const valid = answer && typeof answer === 'object' && !answer.error && deepEqual(answer, EXPECTED_PREFS);
        log('prefs-answer', { valid, received: answer });
        const sessionId = `sess_fake_${++sessSeq}`;
        liveSessions.set(sessionId, { lastContent: '', amSeq: 0 });
        reply(id, { sessionId, prefsValid: valid });
      });
      out({ id: prefsId, method: 'session/requestRuntimePreferences', params: {} });
      return;
    }
    case 'session/subscribe':
      log('subscribe', { params });
      return reply(id, { subscribed: true });
    case 'session/send': {
      const { sessionId, content } = params;
      if (!liveSessions.has(sessionId)) {
        return replyErr(id, -32004, 'Session not active (fake)');
      }
      liveSessions.get(sessionId).lastContent = String(content ?? '');
      log('send', { sessionId, content });
      reply(id, { accepted: true });
      if (process.env.FAKE_MODE !== 'no-terminal') simulateTurn(sessionId);
      return;
    }
    case 'session/stop':
      log('stop', { sessionId: params.sessionId });
      return reply(id, { stopped: true });
    case 'session/close':
      log('close', { sessionId: params.sessionId });
      liveSessions.delete(params.sessionId);
      return reply(id, { closed: true });
    case 'session/read':
      log('read', { sessionId: params.sessionId });
      if (READ_BROKEN.includes(process.env.FAKE_READ)) {
        return replyErr(id, -32004, 'Session not active (fake read)');
      }
      return reply(id, readPayload(params.sessionId));
    case 'session/messages':
      log('messages', { sessionId: params.sessionId });
      if (MESSAGES_BROKEN.includes(process.env.FAKE_READ)) {
        return replyErr(id, -32004, 'Session not active (fake messages)');
      }
      return reply(id, readPayload(params.sessionId));
    case 'session/list':
      return reply(id, { sessions: [...liveSessions.keys()].map((x) => ({ sessionId: x })) });
    default:
      return replyErr(id, -32601, `method not found (fake): ${method}`);
  }
}

/** runner 对 fake 反向请求的应答：{id, result|error}，无 method。 */
function handleClientResponse(frame) {
  const handler = pendingReverse.get(frame.id);
  if (!handler) {
    log('unmatched-response', { id: frame.id });
    return;
  }
  pendingReverse.delete(frame.id);
  handler(frame.error ? { error: frame.error } : frame.result);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let frame = null;
    try { frame = JSON.parse(line); } catch { log('bad-line', { line }); continue; }
    if (frame && typeof frame.method === 'string' && frame.id != null) handleClientRequest(frame);
    else if (frame && frame.id != null) handleClientResponse(frame);
    else log('bad-frame', { line });
  }
});
// 对端关闭即退出（被 kill 时随进程终止）
process.stdin.on('end', () => process.exit(0));
