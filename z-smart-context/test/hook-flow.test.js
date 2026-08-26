'use strict';

// hook 主流程集成测试：node:sqlite 建临时 fixture 库（列集对照设计 §5.2 与 lib/db.js 实际 SQL），
// ZSC_DATA_DIR + 隔离 HOME 指向临时目录，spawnSync 喂 stdin 跑真实 dist/hooks/threshold-check.js，
// 断言 stdout 契约与 state 落盘。不 mock 任何 lib 模块。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(PLUGIN_ROOT, 'dist', 'hooks', 'threshold-check.js');
const TIERS = [100, 200, 300];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsc-hookflow-'));
  const ctx = {
    root,
    dataDir: path.join(root, 'data'),
    homeDir: path.join(root, 'home'),
    dbPath: path.join(root, 'fixture.sqlite'),
  };
  fs.mkdirSync(ctx.dataDir, { recursive: true });
  fs.mkdirSync(ctx.homeDir, { recursive: true });
  return ctx;
}

function teardown(ctx) {
  fs.rmSync(ctx.root, { recursive: true, force: true });
}

function writeConfig(ctx, overrides = {}) {
  fs.writeFileSync(
    path.join(ctx.dataDir, 'config.json'),
    JSON.stringify({ enabled: true, tiers: TIERS, dbPath: ctx.dbPath, ...overrides })
  );
}

function buildFixtureDb(ctx, sessions, usageRows) {
  const db = new DatabaseSync(ctx.dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      directory TEXT,
      parent_id TEXT,
      time_updated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE model_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      context_exceeded INTEGER NOT NULL DEFAULT 0,
      model_id TEXT
    );
  `);
  const insSession = db.prepare(
    'INSERT INTO session (id, title, directory, parent_id, time_updated) VALUES (?, ?, ?, ?, ?)'
  );
  for (const s of sessions) {
    insSession.run(s.id, s.title ?? null, s.directory ?? '/tmp/proj', s.parentId ?? null, s.timeUpdated ?? 1);
  }
  const insUsage = db.prepare(
    'INSERT INTO model_usage (session_id, status, started_at, input_tokens, cache_read_input_tokens, context_exceeded, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  let seq = 1000;
  for (const r of usageRows) {
    insUsage.run(
      r.sessionId,
      r.status ?? 'completed',
      r.startedAt ?? (seq += 1),
      r.inputTokens ?? 0,
      r.cacheReadTokens ?? 0,
      r.contextExceeded ?? 0,
      r.modelId ?? 'test-model'
    );
  }
  db.close();
}

function updateUsageTokens(ctx, sessionId, inputTokens, cacheReadTokens) {
  const db = new DatabaseSync(ctx.dbPath);
  db.prepare('UPDATE model_usage SET input_tokens = ?, cache_read_input_tokens = ? WHERE session_id = ?').run(
    inputTokens,
    cacheReadTokens,
    sessionId
  );
  db.close();
}

function runHook(ctx, { stdin = '', env = {} }) {
  const childEnv = { ...process.env };
  // 剥离宿主环境可能残留的干扰变量，再叠加用例显式注入的
  delete childEnv.CLAUDE_SESSION_ID;
  delete childEnv.ZSC_DATA_DIR;
  for (const key of Object.keys(childEnv)) {
    if (/_NESTED$/.test(key)) delete childEnv[key];
  }
  childEnv.ZSC_DATA_DIR = ctx.dataDir;
  // HOME 隔离：lib/log 落盘路径基于 os.homedir()，不隔离会写真实 ~/.zcode
  childEnv.HOME = ctx.homeDir;
  return spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...childEnv, ...env },
  });
}

function stateFileOf(ctx, sessionId) {
  return path.join(ctx.dataDir, 'state', `${sessionId}.json`);
}

function readState(ctx, sessionId) {
  return JSON.parse(fs.readFileSync(stateFileOf(ctx, sessionId), 'utf8'));
}

function stdinOf(sessionId) {
  return JSON.stringify({ session_id: sessionId, prompt: '继续' });
}

// ---- ① 越档注入一次且 state.firedTiers 落盘 ----

test('越档：首轮注入 additionalContext 且 firedTiers 落盘', () => {
  const ctx = setup();
  try {
    writeConfig(ctx);
    buildFixtureDb(
      ctx,
      [{ id: 'sess_fire1' }],
      [{ sessionId: 'sess_fire1', inputTokens: 60, cacheReadTokens: 90 }] // 150 越过 100 档
    );

    const res = runHook(ctx, { stdin: stdinOf('sess_fire1') });
    assert.equal(res.status, 0);

    const out = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(out), ['additionalContext']);
    const text = out.additionalContext;
    assert.match(text, /^\[z-smart-context\] 上下文用量 150 tokens，已越过阈值 100（100）。/);
    assert.ok(text.includes('node ' + path.join(PLUGIN_ROOT, 'bin', 'zsc.js') + ' usage --session sess_fire1'), '应内联插件根真实路径的精确自查命令');
    assert.ok(!text.includes('\n'), '注入文案必须单行');
    // v2 文案锚点（D6 面向 agent）：自主工具引导 + v1 合规资产保留 + 旧用户导向表述清除
    assert.ok(text.includes('zsc_compact'), '应含 agent 自主调用的 zsc_compact 工具引导');
    assert.ok(text.includes('retention') && text.includes('nextInstruction'), '应说明 zsc_compact 两个入参');
    assert.ok(text.includes('不是必须执行的指令'), '应保留「数据非指令」合规表述');
    assert.ok(text.includes('阶段性完成并验证'), '三条件自查①：任务阶段性完成');
    assert.ok(text.includes('依赖将被压缩的细节'), '三条件自查②：后续依赖');
    assert.ok(text.includes('构成压力'), '三条件自查③：用量压力');
    assert.ok(!/建议.{0,4}告知用户执行 \/compact/.test(text), '不得残留 v1 用户导向行动指引');
    assert.ok(text.includes('告知用户执行 /compact'), '应保留人工兜底出口（环境无法使用 zsc_compact 时）');

    const state = readState(ctx, 'sess_fire1');
    assert.deepEqual(state.firedTiers, [100]);
    assert.equal(state.lastTokens, 150);
    assert.equal(typeof state.updatedAt, 'number');
  } finally {
    teardown(ctx);
  }
});

// ---- ② 同读数第二轮静默且 fired 不变 ----

// ---- ② 同读数第二轮静默且 fired 不变 ----

test('多档同越：合并文案覆盖全部已越档且各档只提醒一次（真实场景回归：双档只 fire 最小档会让下一轮重复单提）', () => {
  const ctx = setup();
  try {
    writeConfig(ctx);
    buildFixtureDb(
      ctx,
      [{ id: 'sess_multi' }],
      [{ sessionId: 'sess_multi', inputTokens: 140, cacheReadTokens: 110 }] // 250 同时越 100 与 200 档
    );

    const first = runHook(ctx, { stdin: stdinOf('sess_multi') });
    assert.equal(first.status, 0);
    const text = JSON.parse(first.stdout).additionalContext;
    assert.ok(text.includes('已越过阈值 100（100、200）'), '文案应合并列出全部已越档');

    // 合并提醒一次性覆盖两档 → 两档都置 fired，第二轮同读数不再有任何注入
    const state = readState(ctx, 'sess_multi');
    assert.deepEqual(state.firedTiers, [100, 200]);

    const second = runHook(ctx, { stdin: stdinOf('sess_multi') });
    assert.equal(second.status, 0);
    assert.equal(second.stdout, '');
  } finally {
    teardown(ctx);
  }
});

test('去重：同读数第二轮 stdout 为空且 fired 不变', () => {
  const ctx = setup();
  try {
    writeConfig(ctx);
    buildFixtureDb(
      ctx,
      [{ id: 'sess_dedup' }],
      [{ sessionId: 'sess_dedup', inputTokens: 60, cacheReadTokens: 90 }]
    );

    const first = runHook(ctx, { stdin: stdinOf('sess_dedup') });
    assert.equal(first.status, 0);
    assert.notEqual(JSON.parse(first.stdout).additionalContext, undefined);

    const second = runHook(ctx, { stdin: stdinOf('sess_dedup') });
    assert.equal(second.status, 0);
    assert.equal(second.stdout, '');

    const state = readState(ctx, 'sess_dedup');
    assert.deepEqual(state.firedTiers, [100]);
    assert.equal(state.lastTokens, 150);
  } finally {
    teardown(ctx);
  }
});

// ---- ③ 读数回落触发知情注入且 fired 清空 ----

test('回落自愈：读数降到 min(fired)×0.8 以下触发知情注入且 fired 清空', () => {
  const ctx = setup();
  try {
    writeConfig(ctx);
    buildFixtureDb(
      ctx,
      [{ id: 'sess_drop' }],
      [{ sessionId: 'sess_drop', inputTokens: 60, cacheReadTokens: 90 }] // 150
    );

    const first = runHook(ctx, { stdin: stdinOf('sess_drop') });
    assert.ok(JSON.parse(first.stdout).additionalContext.includes('已越过阈值 100'));

    // 读数降到 70 < 100 × 0.8 = 80，判定压缩/回退已发生
    updateUsageTokens(ctx, 'sess_drop', 40, 30);
    const second = runHook(ctx, { stdin: stdinOf('sess_drop') });
    assert.equal(second.status, 0);
    const out = JSON.parse(second.stdout);
    assert.deepEqual(Object.keys(out), ['additionalContext']);
    assert.match(
      out.additionalContext,
      /^\[z-smart-context\] 上下文用量已显著回落（150 → 70），此前很可能发生了压缩或回退。/
    );

    const state = readState(ctx, 'sess_drop');
    assert.deepEqual(state.firedTiers, []);
    assert.equal(state.lastTokens, 70);
  } finally {
    teardown(ctx);
  }
});

// ---- ④ env 嵌套标记静默 ----

test('嵌套 env（ZSW_NESTED=1）：静默且不产 state', () => {
  const ctx = setup();
  try {
    writeConfig(ctx);
    buildFixtureDb(
      ctx,
      [{ id: 'sess_nested' }],
      [{ sessionId: 'sess_nested', inputTokens: 60, cacheReadTokens: 90 }]
    );

    const res = runHook(ctx, { stdin: stdinOf('sess_nested'), env: { ZSW_NESTED: '1' } });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    assert.equal(fs.existsSync(stateFileOf(ctx, 'sess_nested')), false);
  } finally {
    teardown(ctx);
  }
});

// ---- ⑤ session.parent_id 非空静默 ----

test('db 子会话（parent_id 非空）：静默且不产 state', () => {
  const ctx = setup();
  try {
    writeConfig(ctx);
    buildFixtureDb(
      ctx,
      [
        { id: 'sess_parent' },
        { id: 'sess_subagent', parentId: 'sess_parent' },
      ],
      [{ sessionId: 'sess_subagent', inputTokens: 60, cacheReadTokens: 90 }]
    );

    const res = runHook(ctx, { stdin: stdinOf('sess_subagent') });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    assert.equal(fs.existsSync(stateFileOf(ctx, 'sess_subagent')), false);
  } finally {
    teardown(ctx);
  }
});

// ---- ⑥ config enabled:false 静默 ----

test('配置关停（enabled:false）：静默且不产 state', () => {
  const ctx = setup();
  try {
    writeConfig(ctx, { enabled: false });
    buildFixtureDb(
      ctx,
      [{ id: 'sess_off' }],
      [{ sessionId: 'sess_off', inputTokens: 60, cacheReadTokens: 90 }]
    );

    const res = runHook(ctx, { stdin: stdinOf('sess_off') });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    assert.equal(fs.existsSync(stateFileOf(ctx, 'sess_off')), false);
  } finally {
    teardown(ctx);
  }
});

// ---- ⑦ dbPath 不可达：exit 0 且 stdout 空（流四静默降级）----

test('db 打开失败：exit 0、stdout 空、stderr 留 ERROR 日志', () => {
  const ctx = setup();
  try {
    writeConfig(ctx, { dbPath: '/nonexistent/zsc-hookflow/db.sqlite' });

    const res = runHook(ctx, { stdin: stdinOf('sess_nodb') });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /ERROR db 打开失败/);
    assert.equal(fs.existsSync(path.join(ctx.dataDir, 'state')), false);
  } finally {
    teardown(ctx);
  }
});

// ---- ⑧ 非法 sessionId：exit 0 且不落任何文件 ----

test('非法 sessionId（路径穿越串）：exit 0、stdout 空、data 目录不新增任何会话状态文件', () => {
  const ctx = setup();
  try {
    writeConfig(ctx);
    buildFixtureDb(ctx, [{ id: 'sess_ok' }], []);

    const res = runHook(ctx, { stdin: JSON.stringify({ session_id: '../../etc' }) });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    // config.json + log/（诊断日志目录）之外不得有任何新增：无 state 目录、无穿越产物。
    // log/ 是合法诊断通道（log.js 跟随 ZSC_DATA_DIR 重定向），不算会话状态污染。
    assert.deepEqual(
      fs.readdirSync(ctx.dataDir).filter((n) => n !== 'log').sort(),
      ['config.json'],
    );
  } finally {
    teardown(ctx);
  }
});

// ---- ⑨ sessionId 双通道：env 优先于 stdin ----

test('session 定位：env CLAUDE_SESSION_ID 优先于 stdin.session_id', () => {
  const ctx = setup();
  try {
    writeConfig(ctx);
    buildFixtureDb(
      ctx,
      [{ id: 'sess_envwin' }, { id: 'sess_stdinlose' }],
      [{ sessionId: 'sess_envwin', inputTokens: 60, cacheReadTokens: 90 }]
    );

    const res = runHook(ctx, {
      stdin: stdinOf('sess_stdinlose'),
      env: { CLAUDE_SESSION_ID: 'sess_envwin' },
    });
    assert.equal(res.status, 0);
    assert.ok(JSON.parse(res.stdout).additionalContext.includes('已越过阈值 100'));

    // state 落在 env 指向的会话名下，stdin 侧无产物
    assert.equal(fs.existsSync(stateFileOf(ctx, 'sess_envwin')), true);
    assert.equal(fs.existsSync(stateFileOf(ctx, 'sess_stdinlose')), false);
  } finally {
    teardown(ctx);
  }
});

// ---- ⑩ 坏 stdin 容忍 + 首轮无 completed 行静默 ----

test('坏 stdin 容忍降级 + 无 completed 行：静默且不产 state', () => {
  const ctx = setup();
  try {
    writeConfig(ctx);
    buildFixtureDb(
      ctx,
      [{ id: 'sess_firstround' }],
      // 只有 running 行：SQL-1 过滤 completed 后无读数
      [{ sessionId: 'sess_firstround', status: 'running', inputTokens: 60, cacheReadTokens: 90 }]
    );

    const res = runHook(ctx, {
      stdin: 'not-a-json{{{',
      env: { CLAUDE_SESSION_ID: 'sess_firstround' },
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    assert.equal(fs.existsSync(stateFileOf(ctx, 'sess_firstround')), false);
  } finally {
    teardown(ctx);
  }
});

// ---- ⑪ context_exceeded=1 仅记日志、不阻断注入（D8）----

test('撞限信号（context_exceeded=1）：照常注入', () => {
  const ctx = setup();
  try {
    writeConfig(ctx);
    buildFixtureDb(
      ctx,
      [{ id: 'sess_blimit' }],
      [{ sessionId: 'sess_blimit', inputTokens: 60, cacheReadTokens: 90, contextExceeded: 1 }]
    );

    const res = runHook(ctx, { stdin: stdinOf('sess_blimit') });
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout);
    assert.ok(out.additionalContext.includes('已越过阈值 100'));
    assert.match(res.stderr, /context_exceeded=1 撞限记录/);

    const state = readState(ctx, 'sess_blimit');
    assert.deepEqual(state.firedTiers, [100]);
  } finally {
    teardown(ctx);
  }
});
