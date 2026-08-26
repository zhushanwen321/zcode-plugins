'use strict';

// bin/zac.js CLI 端到端单测：spawnSync 真实脚本进程，ZAC_DATA_DIR 指向临时目录做隔离；
// db 用 node:sqlite 在临时目录建最小 schema 的 fixture 库（绝不碰生产库）。
// macOS 上 os.tmpdir() 是 /var/...（真实路径 /private/var/...），子进程 process.cwd() 返回
// 物理路径，故 cwd 与 session.directory 一律经 realpathSync 归一，保证精确匹配可命中。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ZAC_JS = path.join(__dirname, '..', 'bin', 'zac.js');

function makeTmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function runZac(args, { cwd, dataDir }) {
  return spawnSync(process.execPath, [ZAC_JS, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ZAC_DATA_DIR: dataDir },
  });
}

// fixture 库最小 schema：仅覆盖 lib/db.js 两条查询 SQL 引用到的列
function createFixtureDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      directory TEXT,
      parent_id TEXT,
      time_created INTEGER NOT NULL DEFAULT 0,
      time_updated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE model_usage (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      context_exceeded INTEGER NOT NULL DEFAULT 0,
      model_id TEXT,
      computed_total_tokens INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

// 场景工厂：临时数据目录（config.json 指 fixture 库）+ 临时项目目录（作 cwd 与 directory）
function makeFixture() {
  const dataDir = makeTmpDir('zac-cli-data-');
  const projectDir = makeTmpDir('zac-cli-proj-');
  const dbPath = path.join(dataDir, 'fixture.sqlite');
  const db = createFixtureDb(dbPath);
  // 不写 tiers → 走默认 [200000, 400000, 600000]
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ dbPath }));
  return { dataDir, projectDir, db };
}

function cleanupFixture(fx) {
  try {
    fx.db.close();
  } finally {
    fs.rmSync(fx.dataDir, { recursive: true, force: true });
    fs.rmSync(fx.projectDir, { recursive: true, force: true });
  }
}

function insertSession(db, { id, directory, parentId = null, timeUpdated = 1000 }) {
  db.prepare(
    'INSERT INTO session (id, title, directory, parent_id, time_updated) VALUES (?, ?, ?, ?, ?)',
  ).run(id, `title-${id}`, directory, parentId, timeUpdated);
}

function insertUsage(
  db,
  { sessionId, input = 0, cacheRead = 0, startedAt = 1000, status = 'completed' },
) {
  db.prepare(
    `INSERT INTO model_usage
       (session_id, status, started_at, input_tokens, cache_read_input_tokens, context_exceeded, model_id)
     VALUES (?, ?, ?, ?, ?, 0, 'test-model')`,
  ).run(sessionId, status, startedAt, input, cacheRead);
}

// ---- 用法面 ----

test('CLI: --help / -h exit 0，含子命令、参数与三个 exit code', () => {
  const dataDir = makeTmpDir('zac-cli-data-');
  try {
    for (const flag of ['--help', '-h']) {
      const r = runZac([flag], { cwd: dataDir, dataDir });
      assert.equal(r.status, 0, `${flag} 应 exit 0`);
      assert.match(r.stdout, /usage \[--session/);
      assert.match(r.stdout, /Exit code/);
      assert.match(r.stdout, /0\s+成功/);
      assert.match(r.stdout, /1\s+内部错误/);
      assert.match(r.stdout, /2\s+用法错误/);
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('CLI: 无参 exit 2 且 stderr 含用法', () => {
  const dataDir = makeTmpDir('zac-cli-data-');
  try {
    const r = runZac([], { cwd: dataDir, dataDir });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /缺少子命令/);
    assert.match(r.stderr, /用法/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('CLI: 未知子命令 exit 2', () => {
  const dataDir = makeTmpDir('zac-cli-data-');
  try {
    const r = runZac(['frobnicate'], { cwd: dataDir, dataDir });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /未知子命令 "frobnicate"/);
    assert.match(r.stderr, /用法示例/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('CLI: --session 非法格式（路径穿越串）exit 2', () => {
  const dataDir = makeTmpDir('zac-cli-data-');
  try {
    const r = runZac(['usage', '--session', '../../etc'], { cwd: dataDir, dataDir });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--session 参数非法/);
    assert.match(r.stderr, /用法示例/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---- 查询面（fixture 临时库）----

test('CLI: usage 默认 --latest 命中 cwd 主会话，单行 JSON 字段与数值正确', () => {
  const fx = makeFixture();
  try {
    insertSession(fx.db, { id: 'sess_main_a', directory: fx.projectDir, timeUpdated: 2000 });
    // 子会话 directory 相同且 time_updated 更新：D5 定案②，反查必须排除它
    insertSession(fx.db, {
      id: 'sess_subagent_agent_x',
      directory: fx.projectDir,
      parentId: 'sess_main_a',
      timeUpdated: 3000,
    });
    // completed 末行读数 = 150000 + 64500 = 214500；更晚的 running 行必须被 status 过滤排除
    insertUsage(fx.db, { sessionId: 'sess_main_a', input: 150000, cacheRead: 64500, startedAt: 2000 });
    insertUsage(fx.db, {
      sessionId: 'sess_main_a',
      input: 999999,
      cacheRead: 0,
      startedAt: 3000,
      status: 'running',
    });

    const r = runZac(['usage'], { cwd: fx.projectDir, dataDir: fx.dataDir });
    assert.equal(r.error, null);
    assert.equal(r.status, 0);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'stdout 必须是单行 JSON');
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.sessionId, 'sess_main_a');
    assert.equal(payload.contextTokens, 214500); // input + cache_read
    assert.deepEqual(payload.firedTiers, []); // 无 state 文件 → 空
    assert.equal(payload.nextTier, 200000); // 200K 已越且未 fired → hook 下轮即提醒它（与 pickTier 同判定）
    assert.equal(typeof payload.note, 'string');
  } finally {
    cleanupFixture(fx);
  }
});

test('CLI: cwd 无匹配会话 → exit 2 报错含用法示例', () => {
  const fx = makeFixture();
  try {
    // fixture 库为空：当前 cwd 必然无匹配
    const r = runZac(['usage'], { cwd: fx.projectDir, dataDir: fx.dataDir });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /未找到 cwd 匹配的活跃会话/);
    assert.match(r.stderr, /--session sess_xxx/);
  } finally {
    cleanupFixture(fx);
  }
});

test('CLI: firedTiers 与配置求交，nextTier 跳过已 fired 档（D3 定案②）', () => {
  const fx = makeFixture();
  try {
    insertSession(fx.db, { id: 'sess_state_case', directory: fx.projectDir, timeUpdated: 1000 });
    insertUsage(fx.db, { sessionId: 'sess_state_case', input: 150000, cacheRead: 64500 });
    // 预置 state：fired 含一个不在配置 tiers 内的旧值 250000（改档残留），求交后应只剩 200000
    const stateDir = path.join(fx.dataDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'sess_state_case.json'),
      JSON.stringify({ firedTiers: [200000, 250000], lastTokens: 210000, updatedAt: 1 }),
    );

    const r = runZac(['usage'], { cwd: fx.projectDir, dataDir: fx.dataDir });
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout.trim());
    assert.deepEqual(payload.firedTiers, [200000]); // 250000 不在当前配置被滤除
    assert.equal(payload.nextTier, 400000); // 200K 已 fired，214500 未越 400K
  } finally {
    cleanupFixture(fx);
  }
});

test('CLI: 会话尚无已完成请求 → exit 0 且 contextTokens 为 null（正常态）', () => {
  const fx = makeFixture();
  try {
    insertSession(fx.db, { id: 'sess_fresh', directory: fx.projectDir, timeUpdated: 1000 });
    insertUsage(fx.db, {
      sessionId: 'sess_fresh',
      input: 88888,
      cacheRead: 0,
      startedAt: 2000,
      status: 'running', // 首轮请求进行中，尚无 completed 行
    });

    const r = runZac(['usage', '--session', 'sess_fresh'], { cwd: fx.projectDir, dataDir: fx.dataDir });
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout.trim());
    assert.equal(payload.sessionId, 'sess_fresh');
    assert.equal(payload.contextTokens, null);
    assert.deepEqual(payload.firedTiers, []);
    assert.equal(payload.nextTier, 200000); // 无读数时首个未 fired 档即下一档
    assert.match(payload.note, /尚无已完成/);
  } finally {
    cleanupFixture(fx);
  }
});
