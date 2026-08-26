'use strict';

// bin/zsc.js CLI 端到端单测：spawnSync 真实脚本进程，ZSC_DATA_DIR 指向临时目录做隔离；
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

const ZSC_JS = path.join(__dirname, '..', 'bin', 'zsc.js');

function makeTmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function runZac(args, { cwd, dataDir, engineConfigPath }) {
  const env = { ...process.env, ZSC_DATA_DIR: dataDir };
  if (engineConfigPath !== undefined) {
    // override 子命令写入的引擎配置文件路径注入口（生产缺省 ~/.zcode/cli/config.json，
    // 测试必须重定向 tmp，绝不允许单测触达真实路径）
    env.ZSC_CONFIG_PATH = engineConfigPath;
  }
  return spawnSync(process.execPath, [ZSC_JS, ...args], {
    cwd,
    encoding: 'utf8',
    env,
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
  const dataDir = makeTmpDir('zsc-cli-data-');
  const projectDir = makeTmpDir('zsc-cli-proj-');
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
  const dataDir = makeTmpDir('zsc-cli-data-');
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
  const dataDir = makeTmpDir('zsc-cli-data-');
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
  const dataDir = makeTmpDir('zsc-cli-data-');
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
  const dataDir = makeTmpDir('zsc-cli-data-');
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

// ---- override 子命令（无头场景 spawn 前预备；引擎配置一律重定向 tmp）----

function makeOverrideFixture() {
  const tmpDataDir = makeTmpDir('zsc-cli-ovr-data-');
  const tmpCfgDir = makeTmpDir('zsc-cli-ovr-cfg-');
  return {
    dataDir: tmpDataDir,
    engineConfigPath: path.join(tmpCfgDir, 'config.json'),
    lockPath: path.join(tmpDataDir, 'override-lock.json'),
    cleanup() {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
      fs.rmSync(tmpCfgDir, { recursive: true, force: true });
    },
  };
}

test('CLI override apply: 缺 --model/--threshold/--owner 分别 exit 2 并指明缺哪个', () => {
  const fx = makeOverrideFixture();
  try {
    for (const args of [
      ['override', 'apply', '--threshold', '200000', '--owner', 'o'],
      ['override', 'apply', '--model', 'glm-5.2', '--owner', 'o'],
      ['override', 'apply', '--model', 'glm-5.2', '--threshold', '200000'],
    ]) {
      const r = runZac(args, { cwd: fx.dataDir, dataDir: fx.dataDir, engineConfigPath: fx.engineConfigPath });
      assert.equal(r.status, 2, `args=${args.join(' ')} 应 exit 2，实得 stderr=${r.stderr}`);
      assert.match(r.stderr, /缺少 --/, `args=${args.join(' ')}`);
      assert.match(r.stderr, /用法示例/);
    }
    // 非法 threshold 同样 exit 2
    const rBad = runZac(
      ['override', 'apply', '--model', 'glm-5.2', '--threshold', 'abc', '--owner', 'o'],
      { cwd: fx.dataDir, dataDir: fx.dataDir, engineConfigPath: fx.engineConfigPath },
    );
    assert.equal(rBad.status, 2);
    assert.match(rBad.stderr, /有限正数/);
    assert.equal(fs.existsSync(fx.lockPath), false, '用法错误不得产生任何文件副作用');
  } finally {
    fx.cleanup();
  }
});

test('CLI override revert/status: 未登记时 exit 2 列出现存 owners / status 报空场', () => {
  const fx = makeOverrideFixture();
  try {
    const rRevert = runZac(['override', 'revert', '--owner', 'nobody'], {
      cwd: fx.dataDir,
      dataDir: fx.dataDir,
      engineConfigPath: fx.engineConfigPath,
    });
    assert.equal(rRevert.status, 2);
    assert.match(rRevert.stderr, /没有生效中的 override 登记/);

    const rStatus = runZac(['override', 'status'], {
      cwd: fx.dataDir,
      dataDir: fx.dataDir,
      engineConfigPath: fx.engineConfigPath,
    });
    assert.equal(rStatus.status, 0);
    const s = JSON.parse(rStatus.stdout.trim());
    assert.equal(s.ok, true);
    assert.equal(s.lockExists, false);
    assert.equal(s.residue, false);
  } finally {
    fx.cleanup();
  }
});

test('CLI override apply→status→revert 全链路：写入 +34000、对账在场、归零还原', () => {
  const fx = makeOverrideFixture();
  try {
    fs.writeFileSync(fx.engineConfigPath, JSON.stringify({ plugins: { dirs: ['/d'] } }));
    const opts = { cwd: fx.dataDir, dataDir: fx.dataDir, engineConfigPath: fx.engineConfigPath };

    const rApply = runZac(
      ['override', 'apply', '--model', 'glm-5.2', '--threshold', '200000', '--owner', 'task-a1'],
      opts,
    );
    assert.equal(rApply.error, null);
    assert.equal(rApply.status, 0, `stderr=${rApply.stderr}`);
    const applied = JSON.parse(rApply.stdout.trim());
    assert.equal(applied.ok, true);
    assert.equal(applied.contextWindow, 234000); // 200000 + 34000（P17 公式）

    // 落盘核验：引擎配置只多 override 叶子；锁含 owner 与 backup
    const engine = JSON.parse(fs.readFileSync(fx.engineConfigPath, 'utf8'));
    assert.equal(engine.modelCatalog.overrides['glm-5.2'].contextWindow, 234000);
    assert.deepEqual(engine.plugins, { dirs: ['/d'] });
    const lock = JSON.parse(fs.readFileSync(fx.lockPath, 'utf8'));
    assert.equal(lock._zscManaged, true);
    assert.deepEqual(lock.backup.hadEntry, false);

    const rStatus = runZac(['override', 'status'], opts);
    assert.equal(rStatus.status, 0);
    const s = JSON.parse(rStatus.stdout.trim());
    assert.equal(s.configHasOverride, true);
    assert.equal(s.residue, false);
    assert.deepEqual(s.owners.map((o) => o.ownerId), ['task-a1']);

    const rRevert = runZac(['override', 'revert', '--owner', 'task-a1'], opts);
    assert.equal(rRevert.status, 0, `stderr=${rRevert.stderr}`);
    const released = JSON.parse(rRevert.stdout.trim());
    assert.equal(released.restored, true);
    // 还原后引擎配置回到初始内容、锁删除
    assert.deepEqual(JSON.parse(fs.readFileSync(fx.engineConfigPath, 'utf8')), { plugins: { dirs: ['/d'] } });
    assert.equal(fs.existsSync(fx.lockPath), false);

    const rStatusAfter = runZac(['override', 'status'], opts);
    const sAfter = JSON.parse(rStatusAfter.stdout.trim());
    assert.equal(sAfter.lockExists, false);
    assert.equal(sAfter.configHasOverride, false);
  } finally {
    fx.cleanup();
  }
});

test('CLI override apply: 引擎配置坏 JSON → exit 1，stderr 给恢复动作，原文字节不动', () => {
  const fx = makeOverrideFixture();
  try {
    fs.writeFileSync(fx.engineConfigPath, '{ broken');
    const r = runZac(
      ['override', 'apply', '--model', 'glm-5.2', '--threshold', '200000', '--owner', 'o'],
      { cwd: fx.dataDir, dataDir: fx.dataDir, engineConfigPath: fx.engineConfigPath },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /内部错误/);
    assert.match(r.stderr, /修复/);
    assert.match(r.stderr, /排查.*hook\.log/);
    assert.equal(fs.readFileSync(fx.engineConfigPath, 'utf8'), '{ broken');
    assert.equal(fs.existsSync(fx.lockPath), false);
  } finally {
    fx.cleanup();
  }
});

test('CLI override revert: 存活其他 owner 时未知 id exit 2 且列出在役登记；--force 可救援', () => {
  const fx = makeOverrideFixture();
  try {
    const opts = { cwd: fx.dataDir, dataDir: fx.dataDir, engineConfigPath: fx.engineConfigPath };
    fs.writeFileSync(fx.engineConfigPath, '{}');
    assert.equal(runZac(['override', 'apply', '--model', 'm', '--threshold', '10000', '--owner', 'alive'], opts).status, 0);

    const rUnknown = runZac(['override', 'revert', '--owner', 'ghost'], opts);
    assert.equal(rUnknown.status, 2);
    assert.match(rUnknown.stderr, /alive/);
    assert.match(rUnknown.stderr, /--force/);

    const rForce = runZac(['override', 'revert', '--owner', 'anyone', '--force'], opts);
    assert.equal(rForce.status, 0, `stderr=${rForce.stderr}`);
    assert.equal(JSON.parse(rForce.stdout.trim()).restored, true);
    assert.equal(fs.existsSync(fx.lockPath), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(fx.engineConfigPath, 'utf8')), {});
  } finally {
    fx.cleanup();
  }
});
