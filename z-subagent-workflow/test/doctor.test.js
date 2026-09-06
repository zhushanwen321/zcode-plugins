'use strict';

/**
 * lib/doctor.js 单测（u1 范围：五面只读采集 + 报告渲染 + 容错降级）。
 *
 * fixture 原则（实施计划 §4 测试策略）：一切数据在 mkdtemp 临时目录构建——
 * 微型引擎库（node:sqlite 建表，schema 从真实库只读摘抄关键列：session 七列
 * + 13 表最小列集；混合表按真实列名 child_session_id/parent_session_id）+
 * 伪 records.jsonl（嵌套 sessionId / 干扰 targetSessionId / 坏 JSON 行）+
 * 伪 artifacts/log/exec 目录树 + 伪索引库。真实 ~/.zcode 全程零触碰（进程
 * env ZSW_ROOT 钉到临时目录，zswRoot()/recordsPath() 缺省值随之落在 fixture）。
 *
 * 时间基准注入（collect 的 now 选项）：超 7 天 / 超 14 天判定用固定 now，
 * 断言不随时钟漂移。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { collect, renderText, renderJson, REF_TABLES } = require('../lib/doctor');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-doctor-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
// zsw 数据根钉到 fixture（recordsPath()/zswRoot() 调用期求值，随 env 生效）；
// node --test 文件形态每文件独立进程，不外溢其他测试文件
process.env.ZSW_ROOT = path.join(TMP, 'zsw-root');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

// 会话识别矩阵（fixture 预期口径的权威定义）：
//   s1 interactive 特征目录（zsub-e2e- 段）+ 白名单内（records 嵌套层）
//   s2 interactive 白名单内（records 顶层）
//   s3 subagent_child 超龄（10d）+ 白名单内
//   s4 subagent_child 新鲜（1d）+ 白名单内（records 数组嵌套层）
//   s5 interactive 白名单外（records 只有 targetSessionId: s5——干扰行，不得入集）
//   删除集粗口径 = {s1,s2,s3,s4}（4/5 = 0.8）；特征目录类 = {s1}
const SESSIONS = [
  ['s1', '/tmp/x/zsub-e2e-abc/e1-proj', 'interactive', NOW - 1 * DAY],
  ['s2', '/Users/u/real-proj', 'interactive', NOW - 2 * DAY],
  ['s3', '/Users/u/real-proj', 'subagent_child', NOW - 10 * DAY],
  ['s4', '/Users/u/real-proj', 'subagent_child', NOW - 1 * DAY],
  ['s5', '/Users/u/other-proj', 'interactive', NOW - 3 * DAY],
];

/** 建微型引擎库（schema 按真实库关键列摘抄；withRefTables=false 造缺表场景）。 */
function createEngineDb(dbPath, { withRefTables = true } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, task_type TEXT, '
    + 'parent_id TEXT, time_archived INTEGER, time_created INTEGER, time_updated INTEGER)');
  const ins = db.prepare('INSERT INTO session (id, directory, task_type, parent_id, time_archived, time_created, time_updated) '
    + 'VALUES (?, ?, ?, NULL, NULL, ?, ?)');
  for (const [id, dir, type, created] of SESSIONS) ins.run(id, dir, type, created, created);
  if (withRefTables) {
    // 13 表最小列集（计数只需任意表体；列名按真实库摘抄——混合表无 session_id 列）
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT)');
    db.exec('CREATE TABLE todo (session_id TEXT)');
    db.exec('CREATE TABLE session_entry (id TEXT, session_id TEXT)');
    db.exec('CREATE TABLE session_input (id TEXT, session_id TEXT)');
    db.exec('CREATE TABLE session_target (session_id TEXT)');
    db.exec('CREATE TABLE model_usage (id TEXT, session_id TEXT)');
    db.exec('CREATE TABLE turn_usage (session_id TEXT)');
    db.exec('CREATE TABLE tool_usage (id TEXT, session_id TEXT)');
    db.exec('CREATE TABLE session_task_link (id TEXT, child_session_id TEXT, parent_session_id TEXT)');
    db.exec('CREATE TABLE workflow_run (id TEXT, parent_session_id TEXT)');
    db.exec('CREATE TABLE workflow_activity (id TEXT, child_session_id TEXT)');
    db.exec('CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT)');
    db.exec('CREATE TABLE input_history (id TEXT, session_id TEXT)');
    const rows = {
      message: [['m1', 's1'], ['m2', 's1'], ['m3', 's2']],
      todo: [['s1']],
      session_entry: [['s2']],
      session_input: [['s1']],
      session_target: [['s2']],
      model_usage: [['s1'], ['s3']],
      turn_usage: [['s2']],
      tool_usage: [['s1']],
      session_task_link: [['s2']],
      workflow_run: [['s2']],
      workflow_activity: [['s3']],
      part: [['s1'], ['s2']],
      input_history: [['s2']],
    };
    for (const [t, rs] of Object.entries(rows)) {
      if (t === 'todo' || t === 'session_target' || t === 'turn_usage') {
        db.prepare(`INSERT INTO ${t} (session_id) VALUES (?)`).run(rs[0][0]);
      } else if (t === 'session_task_link') {
        db.prepare('INSERT INTO session_task_link (id, child_session_id) VALUES (?, ?)').run(rs[0][0], rs[0][0]);
      } else if (t === 'workflow_run') {
        db.prepare('INSERT INTO workflow_run (id, parent_session_id) VALUES (?, ?)').run(rs[0][0], rs[0][0]);
      } else if (t === 'workflow_activity') {
        db.prepare('INSERT INTO workflow_activity (id, child_session_id) VALUES (?, ?)').run(rs[0][0], rs[0][0]);
      } else {
        const cols = t === 'part' ? 'id, message_id, session_id' : 'id, session_id';
        const stmt = db.prepare(`INSERT INTO ${t} (${cols}) VALUES (${t === 'part' ? '?, ?, ?' : '?, ?'})`);
        for (const r of rs) stmt.run(...r);
      }
    }
  }
  db.close();
}

/** 伪 records.jsonl：合法（顶层/嵌套对象/数组层）+ 干扰 targetSessionId + 坏行。 */
function createRecords() {
  const p = path.join(TMP, 'records.jsonl');
  fs.writeFileSync(p, [
    JSON.stringify({ sessionId: 's2', slug: 'task-a' }),
    JSON.stringify({ exec: { sessionId: 's1' }, targetSessionId: 's5' }),
    JSON.stringify({ sessionRef: { sessionId: 's3' } }),
    '{bad json line',
    JSON.stringify({ list: [{ sessionId: 's4' }] }),
    '',
  ].join('\n'));
  return p;
}

/** 伪索引库（tasks.task_id = 引擎 session id；姊妹表最小列集。tasks 带
 *  off_peak_task_id 列——真实库 pragma 实证（u2），体检冲突预检
 *  checkIndexConflicts 的 SELECT 需要该列）。 */
function createIndexDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE tasks (task_id TEXT, archived INTEGER, off_peak_task_id TEXT)');
  db.exec('CREATE TABLE task_group_members (group_id TEXT, task_id TEXT)');
  db.exec('CREATE TABLE automations (automation_id TEXT, target_task_id TEXT)');
  db.exec('CREATE TABLE off_peak_tasks (off_peak_task_id TEXT, session_id TEXT)');
  // s1..s4 ∈ 删除集粗口径 + s6 不在引擎库 → 总 5 命中 4
  const t = db.prepare('INSERT INTO tasks (task_id, archived) VALUES (?, 1)');
  for (const id of ['s1', 's2', 's3', 's4', 's6']) t.run(id);
  const m = db.prepare('INSERT INTO task_group_members (group_id, task_id) VALUES (?, ?)');
  m.run('g1', 's2');
  m.run('g1', 's9');
  const a = db.prepare('INSERT INTO automations (automation_id, target_task_id) VALUES (?, ?)');
  a.run('a1', 's2');
  a.run('a2', null);
  a.run('a3', 's8');
  db.prepare('INSERT INTO off_peak_tasks (session_id) VALUES (?)').run('s3');
  db.close();
}

/** 伪文件面目录树 + 固定 mtime（超龄/新鲜文件）。 */
function createFileTree() {
  const artifacts = path.join(TMP, 'artifacts');
  const log = path.join(TMP, 'log');
  const exec = path.join(TMP, 'exec');
  fs.mkdirSync(path.join(artifacts, 's1'), { recursive: true });
  fs.mkdirSync(path.join(artifacts, 's5'), { recursive: true });
  fs.writeFileSync(path.join(artifacts, 's1', 'a.txt'), 'x'.repeat(100));
  fs.writeFileSync(path.join(artifacts, 's1', 'b.txt'), 'x'.repeat(200));
  fs.writeFileSync(path.join(artifacts, 's5', 'c.txt'), 'x'.repeat(50));
  fs.mkdirSync(log, { recursive: true });
  const oldLog = path.join(log, 'old.log');
  const newLog = path.join(log, 'new.log');
  fs.writeFileSync(oldLog, 'x'.repeat(300));
  fs.writeFileSync(newLog, 'x'.repeat(100));
  fs.utimesSync(oldLog, new Date(NOW - 20 * DAY), new Date(NOW - 20 * DAY)); // 超 14 天
  fs.utimesSync(newLog, new Date(NOW - 1 * DAY), new Date(NOW - 1 * DAY)); // 新鲜
  fs.mkdirSync(path.join(exec, 'sess_s1'), { recursive: true });
  fs.mkdirSync(path.join(exec, 'sess_s9'), { recursive: true });
  fs.mkdirSync(path.join(exec, 'bash-startup'), { recursive: true }); // 引擎自有目录（非 sess_）
  fs.writeFileSync(path.join(exec, 'sess_s1', 'x.txt'), 'x'.repeat(70));
  fs.writeFileSync(path.join(exec, 'bash-startup', 'y.txt'), 'x'.repeat(10));
  return { artifacts, log, exec };
}

/** 主 fixture 组装（五面齐全），返回 collect 的 options。每次调用独立子目录（多测试互不污染）。 */
let fixtureSeq = 0;
function buildMainFixture() {
  const dir = path.join(TMP, `main-${++fixtureSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  const engineDbPath = path.join(dir, 'db.sqlite');
  createEngineDb(engineDbPath);
  createIndexDb(path.join(dir, 'tasks-index.sqlite'));
  const recordsPath = createRecords();
  const tree = createFileTree();
  // 库三件套实际体积（fixture 建库正常关闭后 -wal/-shm 通常已被 SQLite 清理，
  // 断言按实际存在文件合计算，与 doctor.js statSizeSafe 口径一致）
  let dbBytesTotal = 0;
  for (const p of [engineDbPath, engineDbPath + '-wal', engineDbPath + '-shm']) {
    if (fs.existsSync(p)) dbBytesTotal += fs.statSync(p).size;
  }
  return {
    options: {
      now: NOW,
      engineDbPath,
      indexDbPath: path.join(dir, 'tasks-index.sqlite'),
      recordsPath,
      artifactsDir: tree.artifacts,
      logDir: tree.log,
      execDir: tree.exec,
    },
    dbBytesTotal,
  };
}

// ------------------------------------------------- 五面计数（fixture 全量）

test('五面计数：fixture 上白名单双口径 / 特征类 / subagent_child / 13 表 / 索引 / 文件面全部对齐', () => {
  const { options } = buildMainFixture();
  const r = collect(options);

  // 面① 引擎库
  assert.equal(r.engine.available, true);
  assert.equal(r.engine.sessionTotal, 5);
  assert.equal(r.engine.taskTypeDistribution.interactive, 3);
  assert.equal(r.engine.taskTypeDistribution.subagent_child, 2);
  assert.equal(r.engine.whiteListTotal, 4, '白名单总数：s1..s4（targetSessionId:s5 与坏行不入式）');
  assert.equal(r.engine.whiteListInDb, 4, '白名单∩库：4 个全在库');
  assert.equal(r.engine.featureDirectoryCount, 1, '特征目录类：仅 s1（zsub-e2e- 段）');
  assert.deepEqual(r.engine.subagentChild, { total: 2, olderThan7d: 1 }, 's3 超龄 / s4 新鲜');
  assert.equal(Object.keys(r.engine.refTables).length, 13, '13 表逐表计数齐全');
  assert.equal(r.engine.refTables.message, 3);
  assert.equal(r.engine.refTables.part, 2);
  assert.equal(r.engine.refTables.input_history, 1);
  assert.equal(r.engine.refTables.session_task_link, 1);
  assert.ok(r.engine.dbBytes.total > 0);
  assert.equal(r.engine.coarseDeleteSetSize, 4, '删除集粗口径 = 白名单∩库 ∪ 特征类 ∪ subagent_child');

  // 面② 索引库
  assert.equal(r.index.available, true);
  assert.equal(r.index.tasksTotal, 5);
  assert.equal(r.index.tasksHit, 4, '命中按 task_id ∈ 删除集粗口径（s1..s4；s6 不在删除集）');
  assert.deepEqual(r.index.sisterTables, { taskGroupMembers: 2, automationsWithTarget: 2, offPeakTasks: 1 });
  // 姊妹表冲突命中（MF-2：体检复用 checkIndexConflicts 对删除集粗口径的只读预检）：
  // members g1→s2 命中（g1→s9 集外）；automations a1→s2 命中（a3→s8 集外）；
  // off_peak_tasks.session_id s3 命中（tasks.off_peak_task_id 全 null 无反向命中）
  assert.deepEqual(
    r.index.conflictHits,
    { available: true, members: 1, automations: 1, offPeak: 1 },
    '冲突命中口径 = 删除集粗口径（体检可判定的最完整口径）',
  );

  // 面③④⑤ 文件面
  assert.deepEqual(
    { dirCount: r.files.artifacts.dirCount, bytes: r.files.artifacts.bytes },
    { dirCount: 2, bytes: 350 },
    'artifacts 目录名 = session id，递归体积合计',
  );
  assert.deepEqual(r.files.log, { available: true, fileCount: 2, bytes: 400, olderThan14d: 1 }, 'log 按 mtime 判超龄');
  assert.deepEqual(
    { dirCount: r.files.exec.dirCount, sessPrefixed: r.files.exec.sessPrefixed, bytes: r.files.exec.bytes },
    { dirCount: 3, sessPrefixed: 2, bytes: 80 },
    'exec 计 sess_ 前缀数；bash-startup 计入总目录数但不入前缀命中',
  );

  // 预估回收 = 删除集占比 × 库三件套体积（计划偏差 3 粗估口径）
  assert.equal(r.estimate.ratio, 0.8);
  assert.equal(r.estimate.estimatedBytes, Math.round(0.8 * (r.engine.dbBytes.total)));
});

test('预估回收：estimatedBytes = round(ratio × 库三件套实际合计体积)', () => {
  const { options, dbBytesTotal } = buildMainFixture();
  const r = collect(options);
  assert.equal(r.estimate.estimatedBytes, Math.round(0.8 * dbBytesTotal));
});

// ------------------------------------------------- 渲染

test('renderText：人读样张关键行（白名单双口径 / 预估回收标注 / 提示行）', () => {
  const { options } = buildMainFixture();
  const text = renderText(collect(options));
  assert.match(text, /zsw 会话残留体检（/, '标题行（全角括号，照样张）');
  assert.match(text, /白名单∩库 4 个（白名单总数 4）/);
  assert.match(text, /特征目录类 1 个/);
  assert.match(text, /subagent_child 2 个（其中 >7 天 1）/);
  assert.match(text, /粗估，真实以执行后 du 为准/, '预估回收必须标注估算性质（计划偏差 3）');
  assert.match(text, /tasks 总数 5 \/ 粗口径命中 4 行/);
  assert.match(
    text,
    /姊妹表冲突：members 1 \/ automations 1 \/ off_peak 1（表规模：members 2 \/ automations 2（target 非空） \/ off_peak 1）/,
    '姊妹表行 = 冲突命中在前（A-6 样张口径）+ 表规模括注（观测口径）',
  );
  assert.match(text, /artifacts\/\s+2 个会话目录/);
  assert.match(text, /超 14 天日志 1 个/);
  assert.match(text, /sess_ 前缀目录 2 个/);
  assert.match(text, /👉 预览删除清单：zsw doctor clean --dry-run/, '样张末行提示');
  // 13 表 A-6 核对面在渲染中可见
  assert.match(text, /message 3/);
  assert.match(text, /input_history 1/);
});

test('renderJson：输出可 JSON.parse 且结构化字段对齐 collect', () => {
  const { options } = buildMainFixture();
  const report = collect(options);
  const parsed = JSON.parse(renderJson(report));
  assert.equal(parsed.engine.sessionTotal, report.engine.sessionTotal);
  assert.equal(parsed.estimate.estimatedBytes, report.estimate.estimatedBytes);
  assert.equal(parsed.files.exec.sessPrefixed, 2);
});

// ------------------------------------------------- 容错降级（n/a 不 crash）

test('缺表：引擎库仅有 session 表 → 13 表计 undefined，collect 不 crash', () => {
  const dir = path.join(TMP, 'missing-tables');
  fs.mkdirSync(dir, { recursive: true });
  const engineDbPath = path.join(dir, 'db.sqlite');
  createEngineDb(engineDbPath, { withRefTables: false });
  const r = collect({
    now: NOW,
    engineDbPath,
    indexDbPath: path.join(dir, 'none.sqlite'),
    recordsPath: createRecords(),
    artifactsDir: path.join(dir, 'artifacts'),
    logDir: path.join(dir, 'log'),
    execDir: path.join(dir, 'exec'),
  });
  assert.equal(r.engine.available, true, '引擎库本体可读');
  for (const t of REF_TABLES) assert.equal(r.engine.refTables[t], undefined, `${t} 缺表 → undefined`);
  assert.equal(r.engine.whiteListInDb, 4, '白名单∩库不受缺表影响');
});

test('缺库：索引库文件不存在 → 面② n/a；引擎库缺失 → 面① n/a 且白名单总数仍计数、预估归零', () => {
  const dir = path.join(TMP, 'missing-db');
  fs.mkdirSync(dir, { recursive: true });
  const recordsPath = createRecords();
  const r = collect({
    now: NOW,
    engineDbPath: path.join(dir, 'nope.sqlite'),
    indexDbPath: path.join(dir, 'nope-index.sqlite'),
    recordsPath,
    artifactsDir: path.join(dir, 'a'),
    logDir: path.join(dir, 'l'),
    execDir: path.join(dir, 'e'),
  });
  assert.equal(r.engine.available, false);
  assert.equal(r.engine.whiteListTotal, 4, 'records 独立于库，总数仍可得');
  assert.equal(r.index.available, false, '索引库缺文件整面 n/a');
  assert.equal(r.estimate.estimatedBytes, 0, '引擎库 n/a 时预估回收归零（不产出假数字）');
  const text = renderText(r);
  assert.match(text, /n\/a/);
});

test('缺目录：exec 目录不存在 → 该面 n/a，其余面照常', () => {
  const dir = path.join(TMP, 'missing-exec');
  fs.mkdirSync(dir, { recursive: true });
  const engineDbPath = path.join(dir, 'db.sqlite');
  createEngineDb(engineDbPath);
  const r = collect({
    now: NOW,
    engineDbPath,
    indexDbPath: path.join(dir, 'tasks-index.sqlite'),
    recordsPath: createRecords(),
    artifactsDir: path.join(dir, 'artifacts'),
    logDir: path.join(dir, 'log'),
    execDir: path.join(dir, 'no-such-exec'),
  });
  assert.equal(r.files.exec.available, false);
  assert.equal(r.files.log.available, false, 'log 同目录缺失口径');
  assert.equal(r.engine.sessionTotal, 5);
});

test('MF-3 同源绑定：SUBAGENT_MAX_AGE_MS 派生自 clean-identify 的 DEFAULT_OLDER_THAN_DAYS', () => {
  const { SUBAGENT_MAX_AGE_MS } = require('../lib/doctor');
  const { DEFAULT_OLDER_THAN_DAYS } = require('../lib/clean-identify');
  assert.equal(SUBAGENT_MAX_AGE_MS, DEFAULT_OLDER_THAN_DAYS * DAY,
    '体检 olderThan7d 观测口径与删除档位缺省值同源绑定（单一权威源）');
  assert.equal(SUBAGENT_MAX_AGE_MS, 7 * DAY, 'D1① 缺省 7 天语义不变');
});
