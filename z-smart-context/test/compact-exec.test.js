'use strict';

// lib/compact-exec.js 单测：纯函数层（防呆判定 / runtimeModel 构造 / 事件归类 / 指令拼装）
// + compactSession 的协议错误分支（伪 spawnFn 注入，不 spawn 真进程）。
// 端到端真压缩属 e2e（真实模型消耗），链路验证见 .tmp/probe-report-bg-compact.md §3。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { EventEmitter } = require('node:events');

const {
  RUNTIME_PREFERENCES,
  RECENT_TURN_GUARD_MS,
  refuseReasonForTurn,
  buildRuntimeModel,
  resolveCredential,
  classifyPushEvent,
  compactCommand,
  compactSession,
} = require('../lib/compact-exec');

// ---------- 纯函数 ----------

test('refuseReasonForTurn: running 一律拒绝，原因说明 P15 双持风险', () => {
  const r = refuseReasonForTurn({ status: 'running', startedAt: 1, completedAt: null }, 999);
  assert.match(r, /running/);
  assert.match(r, /持有者无感知/);
});

test('refuseReasonForTurn: 守护窗内刚结束的 turn 拒绝，窗外放行', () => {
  const now = 1_000_000;
  const recent = { status: 'completed', startedAt: now - 10_000, completedAt: now - 5_000 };
  assert.match(refuseReasonForTurn(recent, now), /可能仍被持有/);
  const stale = { status: 'completed', startedAt: now - RECENT_TURN_GUARD_MS * 2, completedAt: now - RECENT_TURN_GUARD_MS * 2 };
  assert.equal(refuseReasonForTurn(stale, now), null);
  assert.equal(refuseReasonForTurn(null, now), null, '无 turn 记录放行，由协议错误兜底');
});

test('buildRuntimeModel: 形态符合探针 schema（revision/generatedAt/model/provider.models[].modelId），kind 缺省 anthropic', () => {
  const now = 12345;
  const rm = buildRuntimeModel({ providerId: 'builtin:x', modelId: 'GLM-5.3' }, null, now);
  assert.equal(rm.revision, `zsc-compact-${now}`);
  assert.equal(rm.generatedAt, now);
  assert.deepEqual(rm.model, { providerId: 'builtin:x', modelId: 'GLM-5.3' });
  assert.equal(rm.provider.kind, 'anthropic');
  assert.deepEqual(rm.provider.models, [{ modelId: 'GLM-5.3' }]);
  // strict schema 红线：不得出现 limit/contextWindow 等会被拒的键
  assert.ok(!('limit' in rm.model) && !('limit' in rm.provider.models[0]));
  assert.equal(buildRuntimeModel({ providerId: 'p', modelId: 'm' }, 'openai', now).provider.kind, 'openai');
  // 无凭据时不得出现空 apiKey 键（strict schema 下 undefined 键会被拒）
  assert.ok(!('apiKey' in rm.provider));
});

test('buildRuntimeModel + resolveCredential: config options.apiKey → inline 内联；apiKeyEnv → env 引用；都没有 → null', () => {
  const rm = buildRuntimeModel({ providerId: 'p', modelId: 'm' }, 'anthropic', 1, { source: 'inline', value: 'sk-x' });
  assert.deepEqual(rm.provider.apiKey, { source: 'inline', value: 'sk-x' });
  assert.deepEqual(
    resolveCredential({ options: { apiKey: 'sk-y' } }),
    { source: 'inline', value: 'sk-y' }
  );
  assert.deepEqual(
    resolveCredential({ options: { apiKeyEnv: 'ANTHROPIC_API_KEY' } }),
    { source: 'env', name: 'ANTHROPIC_API_KEY' }
  );
  assert.equal(resolveCredential({}), null);
  assert.equal(resolveCredential(null), null);
});

test('classifyPushEvent: Compacted 是权威成功判据，noop（无需压缩）按成功语义处理，turn.terminal 只是辅助信号', () => {
  assert.equal(classifyPushEvent('session/event', { payload: { response: 'Compacted' } }), 'compacted');
  assert.equal(classifyPushEvent('session/event', { payload: { response: 'Context is up to date; no compression needed' } }), 'noop');
  assert.equal(classifyPushEvent('v4/telemetry/event', { kind: 'turn.terminal', status: 'failed' }), 'terminal');
  assert.equal(classifyPushEvent('session/event', { payload: { response: 'ok' } }), 'other');
  assert.equal(classifyPushEvent('state.updated', {}), 'other');
});

test('compactCommand: retention 进「保留：」段，缺省裸命令（与工具层同构）', () => {
  assert.equal(compactCommand('要点'), '/compact 保留：要点');
  assert.equal(compactCommand(''), '/compact');
});

// ---------- compactSession 协议分支（伪 spawn 注入） ----------

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 种子库：一个旧会话（上次 turn 远超守护窗）+ 模型记录
function seedDb(dbFile, { sessionId = 'sess_ce1', turnStatus = 'completed', turnAgeMs = 600_000 } = {}) {
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER, parent_id TEXT);
    CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER);
    CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT, status TEXT, provider_id TEXT, model_id TEXT, started_at INTEGER,
      input_tokens INTEGER, cache_read_input_tokens INTEGER);
  `);
  const now = Date.now();
  db.prepare('INSERT INTO session VALUES (?, ?, ?, NULL)').run(sessionId, '/tmp/ce-work', now);
  db.prepare('INSERT INTO turn_usage VALUES (?, ?, ?, ?, ?)').run(sessionId, 't1', turnStatus, now - turnAgeMs, now - turnAgeMs + 1000);
  db.prepare(
    'INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('mu1', sessionId, 'completed', 'builtin:x', 'GLM-5.3', now - turnAgeMs, 100, 200);
  db.close();
}

// 伪 child：EventEmitter + stdin 收集器 + stdout/stderr 事件源，测试按需注入协议帧
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdin = { write() {} };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function makeCtx(overrides = {}) {
  const dir = makeTmpDir('zsc-ce-');
  const dbFile = path.join(dir, 'engine.sqlite');
  seedDb(dbFile, overrides);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dbPath: dbFile }));
  const home = makeTmpDir('zsc-ce-home-');
  return {
    dir, home,
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); },
  };
}

test('compactSession: 活跃防呆拒绝（running turn）→ session-likely-held，不 spawn', async () => {
  const ctx = makeCtx({ turnStatus: 'running', turnAgeMs: 1_000 });
  try {
    let spawned = 0;
    const out = await compactSession(
      { sessionId: 'sess_ce1', retention: 'r' },
      { dataDir: ctx.dir, homeDir: ctx.home, spawnFn: () => { spawned += 1; return makeFakeChild(); }, now: Date.now() }
    );
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'session-likely-held');
    assert.equal(spawned, 0, '防呆必须在 spawn 之前拦截');
  } finally {
    ctx.cleanup();
  }
});

test('compactSession: 会话不存在 → session-not-found', async () => {
  const ctx = makeCtx();
  try {
    const out = await compactSession(
      { sessionId: 'sess_absent', retention: 'r' },
      { dataDir: ctx.dir, homeDir: ctx.home, spawnFn: () => makeFakeChild() }
    );
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'session-not-found');
  } finally {
    ctx.cleanup();
  }
});

test('compactSession: sessionId 白名单与三步协议链错误分支', async () => {
  assert.equal((await compactSession({ sessionId: '../evil' }, { spawnFn: () => makeFakeChild() })).reason, 'invalid-session-id');

  const ctx = makeCtx();
  try {
    // resume 应答被 -32004 拒（会话活跃于别处）→ 错误文本指向关闭持有方
    const child = makeFakeChild();
    child.stdin = {
      chunks: [],
      write(s) { this.chunks.push(s); },
    };
    const out = await compactSession(
      { sessionId: 'sess_ce1', retention: 'r' },
      {
        dataDir: ctx.dir, homeDir: ctx.home,
        spawnFn: () => child,
        reqTimeoutMs: 150,
        readyHook: async () => {
          // 等 resume 帧写出后异步注入 server 错误应答（id 对齐 resume 的 id=1）
          await new Promise((r) => setTimeout(r, 50));
          child.stdout.emit('data', Buffer.from(JSON.stringify({ id: 1, error: { code: -32004, message: 'Session is not active' } }) + '\n'));
        },
      }
    );
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'resume-failed');
    assert.match(out.text, /-32004/);
    assert.match(out.text, /关闭持有方/);
    // 帧序红线：resume 必须是第一个请求（updateRuntimeModelConfig 不得先发）
    const firstReq = JSON.parse(child.stdin.chunks[0]);
    assert.equal(firstReq.method, 'session/resume');
  } finally {
    ctx.cleanup();
  }
});

test('compactSession: 三步链全通 + Compacted 推送 → ok（伪协议应答）', async () => {
  const ctx = makeCtx();
  try {
    const child = makeFakeChild();
    child.stdin = {
      chunks: [],
      write(s) { this.chunks.push(s); },
    };
    const respond = (req) => {
      // 逐请求注入成功应答；send 接受后异步推 Compacted 事件
      if (req.method === 'session/resume' || req.method === 'session/subscribe' || req.method === 'session/updateRuntimeModelConfig') {
        setTimeout(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ id: req.id, result: { ok: true } }) + '\n')), 30);
      } else if (req.method === 'session/send') {
        setTimeout(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify({ id: req.id, result: { accepted: true } }) + '\n'));
          child.stdout.emit('data', Buffer.from(JSON.stringify({ method: 'session/event', params: { payload: { response: 'Compacted' } } }) + '\n'));
        }, 30);
      }
    };
    const seen = new Set();
    const poll = setInterval(() => {
      for (const c of child.stdin.chunks) {
        const f = JSON.parse(c);
        if (f.id != null && !seen.has(f.id)) {
          seen.add(f.id);
          respond(f);
        }
      }
    }, 20);
    const out = await compactSession(
      { sessionId: 'sess_ce1', retention: '保留要点' },
      { dataDir: ctx.dir, homeDir: ctx.home, spawnFn: () => child, reqTimeoutMs: 2_000, readyHook: async () => {} }
    );
    clearInterval(poll);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.reason, 'compacted');
    const methods = child.stdin.chunks.map((c) => JSON.parse(c).method);
    // 协议序断言：resume → subscribe（否则收不到 Compacted 推送）→ updateRuntimeModelConfig
    // → send（缺 runtimeModel 修复步 send 会 -32031，BP-9）
    assert.deepEqual(
      methods.filter((m) => m && m.startsWith('session/')),
      ['session/resume', 'session/subscribe', 'session/updateRuntimeModelConfig', 'session/send', 'session/close']
    );
    const send = child.stdin.chunks.map((c) => JSON.parse(c)).find((f) => f.method === 'session/send');
    assert.equal(send.params.content, '/compact 保留：保留要点');
    const upd = child.stdin.chunks.map((c) => JSON.parse(c)).find((f) => f.method === 'session/updateRuntimeModelConfig');
    assert.equal(upd.params.runtimeModel.model.providerId, 'builtin:x');
    assert.equal(upd.params.runtimeModel.provider.models[0].modelId, 'GLM-5.3');
  } finally {
    ctx.cleanup();
  }
});

test('RUNTIME_PREFERENCES: 反向请求应答契约完整（四键，策略 preflight-v1）', () => {
  assert.deepEqual(RUNTIME_PREFERENCES, {
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: true,
    modelContextBudgetStrategy: 'preflight-v1',
  });
});
