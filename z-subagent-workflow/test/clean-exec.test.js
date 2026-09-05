'use strict';

/**
 * lib/clean-exec.test.js（u3）：清理执行器 + 备份管理单测。
 *
 * fixture 原则（延续 test/clean-fs.test.js / test/doctor.test.js）：mkdtemp 临时
 * 目录 + ZSW_ROOT 钉住 + 固定 mtime/now + after 整树清理；真实 ~/.zcode 零触碰
 * （本文件对真实库的仅有交互 = 建库前从 sqlite_master 只读摘抄 CREATE 语句，
 * 固化进下方 DDL——FK 级联行为是被测对象，schema 真实性必要）。
 *
 * 引擎库 DDL 来源（2026-09-06 真库只读摘抄，sqlite_master）：FK 声明与 FK 列
 * NOT NULL 逐字保留（`references session(id) on delete cascade / set null`、
 * part→message cascade、session_task_link 双列、unique(child_session_id)）；
 * 纯观测列（trace/stats/json）裁剪——插入形态现实性保留（NOT NULL 列都有值）。
 * 索引库 DDL 同法（tasks 复合主键 (workspace_key, task_id) + off_peak_task_id）。
 *
 * 停机校验的 ps 文本与空间探测全部注入（runShutdownChecks 的 psText /
 * runClean 的 freeBytesFn），真实 ps/spawn 不进测试进程。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

// zsw 数据根钉到 fixture（maintenanceDir 缺省值随之落在临时目录；node --test
// 文件形态每文件独立进程，不外溢其他测试文件）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-clean-exec-test-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsw-root');

const {
  parsePsLines,
  classifyProcessViolations,
  isGuiCommand,
  isAppServerCommand,
  isNestedCommand,
  runShutdownChecks,
  evalDiskStage,
  setupSqliteTmpdir,
  teardownSqliteTmpdir,
  backupDatabases,
  pruneOldBackups,
  purgeLatestBackup,
  runClean,
  CASCADE_SESSION_TABLES,
  DEFAULT_CHUNK_SIZE,
} = require('../lib/clean-exec');
const { collectDryRun } = require('../lib/doctor');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const GB = 1000 * 1000 * 1000;

/** 停机窗口形态：无任何 ZCode 进程的 ps 文本（fixture 惯例形态）。 */
const PS_CALM = '     1 /sbin/launchd\n  415 /usr/libexec/seserviced\n';
/** 空间充裕的探测函数（除指定阶段外全放行；1e15 < 2^53，安全整数）。 */
const freeGenerous = () => 1e15;

let seq = 0;
function nextDir(prefix = 't') {
  const dir = path.join(TMP, `${prefix}${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function setMtime(p, ms) {
  const d = new Date(ms);
  fs.utimesSync(p, d, d);
}

// ---------------------------------------------------- fixture 建库（真实 FK schema）

/**
 * 微型引擎库（DDL 从真库只读摘抄固化，见文件头注；journal_mode=WAL 与真库
 * C3 一致）。rows = {sessions:[[id,directory,taskType,created]], ...各表行}。
 */
function createEngineDb(dbPath, rows) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE session (
    id text primary key,
    project_id text not null,
    parent_id text,
    directory text not null,
    title text not null,
    time_created integer not null,
    time_updated integer not null,
    task_type text not null default 'interactive')`);
  db.exec(`CREATE TABLE message (
    id text primary key,
    session_id text not null references session(id) on delete cascade,
    time_created integer not null,
    time_updated integer not null,
    data text not null)`);
  db.exec(`CREATE TABLE part (
    id text primary key,
    message_id text not null references message(id) on delete cascade,
    session_id text not null,
    time_created integer not null,
    time_updated integer not null,
    data text not null)`);
  db.exec(`CREATE TABLE todo (
    session_id text not null references session(id) on delete cascade,
    content text not null,
    status text not null,
    priority text not null,
    position integer not null,
    time_created integer not null,
    time_updated integer not null,
    primary key(session_id, position))`);
  db.exec(`CREATE TABLE session_entry (
    id text primary key,
    session_id text not null references session(id) on delete cascade,
    type text not null,
    time_created integer not null,
    time_updated integer not null,
    data text not null)`);
  db.exec(`CREATE TABLE session_input (
    id text primary key,
    session_id text not null references session(id) on delete cascade,
    kind text not null,
    status text not null,
    time_created integer not null,
    time_updated integer not null)`);
  db.exec(`CREATE TABLE session_target (
    session_id text primary key references session(id) on delete cascade,
    target_id text not null)`);
  db.exec(`CREATE TABLE model_usage (
    id text primary key,
    logical_request_id text not null,
    session_id text not null references session(id) on delete cascade,
    query_source text not null,
    provider_id text not null,
    model_id text not null,
    status text not null,
    started_at integer not null)`);
  db.exec(`CREATE TABLE turn_usage (
    session_id text not null references session(id) on delete cascade,
    turn_id text not null,
    status text not null,
    started_at integer not null,
    primary key(session_id, turn_id))`);
  db.exec(`CREATE TABLE tool_usage (
    id text primary key,
    session_id text not null references session(id) on delete cascade,
    tool_call_id text not null,
    tool_name text not null,
    status text not null,
    started_at integer not null)`);
  db.exec(`CREATE TABLE session_task_link (
    id text primary key,
    parent_session_id text references session(id) on delete set null,
    child_session_id text not null references session(id) on delete cascade,
    role text not null,
    depth integer not null default 0,
    path text not null,
    status text not null,
    time_created integer not null,
    time_updated integer not null,
    unique(child_session_id))`);
  db.exec(`CREATE TABLE workflow_run (
    id text primary key,
    name text not null,
    parent_session_id text references session(id) on delete set null,
    cwd text not null,
    script_hash text not null,
    status text not null,
    time_created integer not null,
    time_updated integer not null)`);
  db.exec(`CREATE TABLE workflow_activity (
    id text primary key,
    run_id text not null references workflow_run(id) on delete cascade,
    type text not null,
    input_hash text not null,
    status text not null,
    child_session_id text references session(id) on delete set null,
    time_created integer not null,
    time_updated integer not null)`);
  db.exec(`CREATE TABLE input_history (
    id text primary key,
    project_id text not null,
    session_id text,
    text text not null,
    kind text not null,
    time_created integer not null)`);

  const ts = NOW;
  const insSession = db.prepare('INSERT INTO session (id, project_id, directory, title, time_created, time_updated, task_type) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const [id, dir, type, created] of rows.sessions) {
    insSession.run(id, 'proj1', dir, `title-${id}`, created, created, type);
  }
  const insMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
  for (const [id, sid] of rows.messages || []) insMessage.run(id, sid, ts, ts, 'd');
  const insPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, mid, sid] of rows.parts || []) insPart.run(id, mid, sid, ts, ts, 'd');
  const insTodo = db.prepare('INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const [sid, pos] of rows.todos || []) insTodo.run(sid, 'c', 'pending', 'p0', pos, ts, ts);
  const insEntry = db.prepare('INSERT INTO session_entry (id, session_id, type, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, sid] of rows.entries || []) insEntry.run(id, sid, 't', ts, ts, 'd');
  const insInput = db.prepare('INSERT INTO session_input (id, session_id, kind, status, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, sid] of rows.inputs || []) insInput.run(id, sid, 'k', 'admitted', ts, ts);
  const insTarget = db.prepare('INSERT INTO session_target (session_id, target_id) VALUES (?, ?)');
  for (const [sid, tid] of rows.targets || []) insTarget.run(sid, tid);
  const insModel = db.prepare('INSERT INTO model_usage (id, logical_request_id, session_id, query_source, provider_id, model_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [id, sid] of rows.modelUsage || []) insModel.run(id, `lr-${id}`, sid, 'q', 'p', 'm', 'completed', ts);
  const insTurn = db.prepare('INSERT INTO turn_usage (session_id, turn_id, status, started_at) VALUES (?, ?, ?, ?)');
  for (const [sid, turnId] of rows.turnUsage || []) insTurn.run(sid, turnId, 'completed', ts);
  const insTool = db.prepare('INSERT INTO tool_usage (id, session_id, tool_call_id, tool_name, status, started_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, sid] of rows.toolUsage || []) insTool.run(id, sid, `tc-${id}`, 'Bash', 'completed', ts);
  const insLink = db.prepare('INSERT INTO session_task_link (id, parent_session_id, child_session_id, role, path, status, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [id, parent, child] of rows.links || []) insLink.run(id, parent, child, 'root', `/${id}`, 'active', ts, ts);
  const insRun = db.prepare('INSERT INTO workflow_run (id, name, parent_session_id, cwd, script_hash, status, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [id, parent] of rows.workflowRuns || []) insRun.run(id, `wf-${id}`, parent, '/w', 'h', 'completed', ts, ts);
  const insActivity = db.prepare('INSERT INTO workflow_activity (id, run_id, type, input_hash, status, child_session_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [id, runId, child] of rows.workflowActivities || []) insActivity.run(id, runId, 'agent', 'ih', 'completed', child, ts, ts);
  const insHistory = db.prepare('INSERT INTO input_history (id, project_id, session_id, text, kind, time_created) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, sid] of rows.inputHistory || []) insHistory.run(id, 'proj1', sid, 'txt', 'user', ts);
  db.close();
}

/** 微型索引库（DDL 从真库只读摘抄固化；复合主键 + off_peak_task_id 反向关联列）。 */
function createIndexDb(dbPath, { taskIds = [], members = [], automations = [], offPeak = [] } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE tasks (
    workspace_key TEXT NOT NULL,
    task_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    off_peak_task_id TEXT,
    PRIMARY KEY (workspace_key, task_id))`);
  db.exec(`CREATE TABLE task_group_members (
    group_id TEXT NOT NULL,
    workspace_key TEXT NOT NULL,
    task_id TEXT NOT NULL)`);
  db.exec(`CREATE TABLE automations (
    automation_id TEXT PRIMARY KEY,
    cron_expr TEXT NOT NULL,
    prompt TEXT NOT NULL,
    workspace_key TEXT NOT NULL,
    target_task_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE off_peak_tasks (
    off_peak_task_id TEXT PRIMARY KEY,
    session_id TEXT,
    prompt TEXT NOT NULL,
    permission_mode TEXT NOT NULL,
    workspace_key TEXT NOT NULL,
    status TEXT NOT NULL,
    queued_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL)`);
  const t = db.prepare('INSERT INTO tasks (workspace_key, task_id, created_at, updated_at) VALUES (?, ?, ?, ?)');
  for (const id of taskIds) t.run('wk', id, NOW, NOW);
  const m = db.prepare('INSERT INTO task_group_members (group_id, workspace_key, task_id) VALUES (?, ?, ?)');
  for (const [gid, tid] of members) m.run(gid, 'wk', tid);
  const a = db.prepare('INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, target_task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const [aid, tid] of automations) a.run(aid, '* * * * *', 'p', 'wk', tid, NOW, NOW);
  const o = db.prepare('INSERT INTO off_peak_tasks (off_peak_task_id, session_id, prompt, permission_mode, workspace_key, status, queued_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [oid, sid] of offPeak) o.run(oid, sid, 'p', 'yolo', 'wk', 'queued', NOW, NOW, NOW);
  db.close();
}

function writeRecords(dir, lines) {
  const p = path.join(dir, 'records.jsonl');
  fs.writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return p;
}

// ---------------------------------------------------- 主 fixture（全流程正例用）

/**
 * 主 fixture 会话/引用矩阵（预期口径的权威定义）：
 *   删除集 5 = wl1, sess_wl2, wl3（白名单；wl3 兼特征目录）+ sc1, sc2（超龄 subagent_child）；
 *   保留 3 = scfresh（新鲜 child）/ keep1（records 的 targetSessionId 干扰行指向它，
 *   不得入集）/ keep2（普通 interactive）。
 *   sc2 挂 300 条 message+part 批量行——VACUUM 前后 page_count 可断言下降。
 */
function buildMainFixture() {
  const dir = nextDir('main-');
  const engineDbPath = path.join(dir, 'db.sqlite');
  const sessions = [
    ['wl1', '/Users/u/proj', 'interactive', NOW - 1 * DAY],
    ['sess_wl2', '/Users/u/proj', 'interactive', NOW - 2 * DAY],
    ['wl3', '/tmp/x/zsub-e2e-abc/e1-proj', 'interactive', NOW - 2 * DAY],
    ['sc1', '/Users/u/proj', 'subagent_child', NOW - 10 * DAY],
    ['sc2', '/Users/u/proj', 'subagent_child', NOW - 10 * DAY],
    ['scfresh', '/Users/u/proj', 'subagent_child', NOW - 1 * DAY],
    ['keep1', '/Users/u/other', 'interactive', NOW - 3 * DAY],
    ['keep2', '/Users/u/other', 'interactive', NOW - 3 * DAY],
  ];
  const messages = [['m1', 'wl1'], ['m2', 'sc1'], ['m3', 'scfresh'], ['m4', 'keep1']];
  const parts = [['p1', 'm1', 'wl1'], ['p2', 'm2', 'sc1'], ['p3', 'm3', 'scfresh'], ['p4', 'm4', 'keep1']];
  for (let i = 0; i < 300; i++) {
    messages.push([`mb${i}`, 'sc2']);
    parts.push([`pb${i}`, `mb${i}`, 'sc2']);
  }
  createEngineDb(engineDbPath, {
    sessions,
    messages,
    parts,
    todos: [['wl1', 0]],
    entries: [['se1', 'sess_wl2']],
    inputs: [['si1', 'wl1']],
    targets: [['sess_wl2', 'tgt1']],
    modelUsage: [['mu1', 'wl1'], ['mu2', 'sc2']],
    turnUsage: [['wl1', 'tu1'], ['scfresh', 'tu2']],
    toolUsage: [['tl1', 'wl1']],
    links: [['l1', 'keep1', 'sess_wl2'], ['l2', 'sc2', 'keep2']],
    workflowRuns: [['wr1', 'sc1']],
    workflowActivities: [['wa1', 'wr1', 'sc2']],
    inputHistory: [['i1', 'wl1'], ['i2', 'keep1'], ['i3', null]],
  });
  const indexDbPath = path.join(dir, 'tasks-index.sqlite');
  // members 只挂 tk9：task_group_members 命中删除集 = 冲突源（u2 checkIndexConflicts
  // 语义，会话整体剔除）——主 fixture 保持零冲突，冲突形态由专门用例覆盖
  createIndexDb(indexDbPath, {
    taskIds: ['wl1', 'sess_wl2', 'wl3', 'sc1', 'sc2', 'tk9'],
    members: [['g9', 'tk9']],
    automations: [['a1', 'tk9']],
  });
  const records = writeRecords(dir, [
    { sessionId: 'wl1' },
    { exec: { sessionId: 'sess_wl2' }, sessionId: 'wl3' },
    { sessionId: 'sc1' },
    { sessionId: 'sc2' },
    { targetSessionId: 'keep1' },
  ]);

  const artifactsDir = path.join(dir, 'artifacts');
  const execDir = path.join(dir, 'exec');
  const logDir = path.join(dir, 'log');
  for (const name of ['wl1', 'sc1', 'keepdir1']) fs.mkdirSync(path.join(artifactsDir, name), { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, 'wl1', 'a.txt'), 'x'.repeat(100));
  fs.writeFileSync(path.join(artifactsDir, 'sc1', 'b.txt'), 'x'.repeat(50));
  fs.writeFileSync(path.join(artifactsDir, 'keepdir1', 'c.txt'), 'x'.repeat(70));
  fs.mkdirSync(path.join(execDir, 'sess_wl2'), { recursive: true });
  fs.mkdirSync(path.join(execDir, 'sess_old_empty'), { recursive: true });
  fs.mkdirSync(path.join(execDir, 'bash-startup'), { recursive: true });
  fs.writeFileSync(path.join(execDir, 'sess_wl2', 'x.txt'), 'x'.repeat(70));
  fs.writeFileSync(path.join(execDir, 'bash-startup', 'y.txt'), 'x'.repeat(10));
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'old.log'), 'x'.repeat(400));
  fs.writeFileSync(path.join(logDir, 'new.log'), 'x'.repeat(100));
  const old = NOW - 20 * DAY;
  const fresh = NOW - 1 * DAY;
  setMtime(path.join(execDir, 'sess_old_empty'), old);
  setMtime(path.join(execDir, 'bash-startup'), old);
  setMtime(path.join(logDir, 'old.log'), old);
  setMtime(path.join(logDir, 'new.log'), fresh);

  // 备份前快照（备份字节等值断言基准——备份发生在删除之前）
  const engineBytes = fs.readFileSync(engineDbPath);
  const indexBytes = fs.readFileSync(indexDbPath);

  // 每 fixture 独立 maintenance 目录（跨用例备份计数互不污染；runClean 经 options 注入）
  const maintenanceDir = path.join(dir, 'maintenance');
  fs.mkdirSync(maintenanceDir, { recursive: true });
  fs.mkdirSync(path.join(maintenanceDir, 'backup-old'), { recursive: true });
  fs.writeFileSync(path.join(maintenanceDir, 'backup-old', 'marker.txt'), 'old');

  return {
    dir, engineDbPath, indexDbPath, records, artifactsDir, execDir, logDir, maintenanceDir,
    engineBytes, indexBytes,
  };
}

function cleanOptions(fx, extra = {}) {
  return {
    now: NOW,
    engineDbPath: fx.engineDbPath,
    indexDbPath: fx.indexDbPath,
    recordsPath: fx.records,
    artifactsDir: fx.artifactsDir,
    logDir: fx.logDir,
    execDir: fx.execDir,
    maintenanceDir: fx.maintenanceDir,
    psText: PS_CALM,
    freeBytesFn: freeGenerous,
    ...extra,
  };
}

function query(dbPath, sql, ...params) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------- 纯函数：ps 解析与进程分类

test('parsePsLines：pid/command 解析、坏行跳过、eww env 附加段并入 command', () => {
  const lines = parsePsLines('  13791 ZCode\n  33334 sleep 20 ZSW_NESTED=1\n\nbadline\nxx yy\n');
  assert.deepEqual(lines, [
    { pid: 13791, command: 'ZCode' },
    { pid: 33334, command: 'sleep 20 ZSW_NESTED=1' },
  ], '无空格行与首 token 非 pid 行跳过');
  assert.deepEqual(parsePsLines(undefined), []);
});

test('CASCADE_SESSION_TABLES：8 张直接 CASCADE 表闭集（§2.1 面①列粒度，设计载荷）', () => {
  assert.deepEqual([...CASCADE_SESSION_TABLES], [
    'message', 'todo', 'session_entry', 'session_input', 'session_target',
    'model_usage', 'turn_usage', 'tool_usage',
  ]);
  assert.equal(Object.isFrozen(CASCADE_SESSION_TABLES), true);
});

test('进程分类（2026-09-06 真机形态固化）：GUI 裸名与 bundle 路径命中；app-server 双条件；TaiJi/zcode-cli/plugin-host 不误拦', () => {
  // 真机样本：GUI 主进程裸 `ZCode`；Helper 带 ZCode.app 路径；重写名 zcode-cli 无命令行
  assert.equal(isGuiCommand('ZCode'), true, 'GUI 主进程裸名形态');
  assert.equal(isGuiCommand('/Applications/ZCode.app/Contents/Frameworks/ZCode Helper --type=gpu'), true);
  assert.equal(isGuiCommand('node /x/pnpm --filter electron dev'), false);
  assert.equal(isGuiCommand('/Users/u/.dev-electron/Taiji.app/Contents/MacOS/Electron . --port=9222'), false, '他 Electron 应用不误拦');
  assert.equal(isAppServerCommand('node /x/zcode.cjs app-server --cwd /tmp/w'), true);
  assert.equal(isAppServerCommand('node .../ZCode Helper /x/glm/zcode.cjs __zcode-plugin-host /x/server.js'), false, '仅含 zcode.cjs 的 plugin-host 形态不误拦');
  assert.equal(isNestedCommand('sleep 20 ZSW_NESTED=1'), true, 'axeww env 附加面');
  // 真机文本全量分类
  const psText = [
    '     1 /sbin/launchd',
    ' 13791 ZCode',
    ' 14421 zcode-host-local-1',
    ' 14540 zcode-cli',
    ' 23899 node /x/zcode.cjs app-server --cwd /tmp/w',
    ' 24001 sh -c ZSW_NESTED=1 node agent.js',
  ].join('\n');
  const v = classifyProcessViolations(psText);
  assert.deepEqual(v.filter((x) => x.kind === 'gui').map((x) => x.pid), [13791]);
  assert.deepEqual(v.filter((x) => x.kind === 'app-server').map((x) => x.pid), [23899]);
  assert.deepEqual(v.filter((x) => x.kind === 'nested').map((x) => x.pid), [24001]);
  // 重写名 zcode-cli（无命令行）不属于任一命令行模式——该形态由 ④ 独占开锁兜底（D2④）
  assert.equal(v.some((x) => x.pid === 14540), false);
});

// ---------------------------------------------------- 纯函数：磁盘阶段求值 / tmpdir / 备份

test('evalDiskStage：三段门槛与基准面（pre-backup 全额 / pre-delete 与 pre-vacuum 扣备份）', () => {
  const total = 10 * GB;
  const ok1 = evalDiskStage('pre-backup', { free: Math.ceil(total * 1.1), dbBytesTotal: total, backupBytes: 0 });
  assert.equal(ok1.ok, true);
  assert.equal(ok1.needed, Math.ceil(total * 1.1));
  assert.equal(evalDiskStage('pre-backup', { free: Math.ceil(total * 1.1) - 1, dbBytesTotal: total, backupBytes: 0 }).ok, false);
  const ok2 = evalDiskStage('pre-delete', { free: 2 * GB, dbBytesTotal: total, backupBytes: GB });
  assert.deepEqual({ ok: ok2.ok, needed: ok2.needed, base: ok2.base }, { ok: true, needed: GB, base: GB });
  assert.equal(evalDiskStage('pre-delete', { free: 2 * GB, dbBytesTotal: total, backupBytes: 1.5 * GB }).ok, false);
  const ok3 = evalDiskStage('pre-vacuum', { free: 13 * GB, dbBytesTotal: total, backupBytes: GB });
  assert.deepEqual({ ok: ok3.ok, base: ok3.base }, { ok: true, base: 12 * GB });
  assert.equal(evalDiskStage('pre-vacuum', { free: 8 * GB, dbBytesTotal: total, backupBytes: GB }).ok, false, '7GB < 11GB（库×1.1）');
});

test('setupSqliteTmpdir：env 钉死 + 同卷判定 + teardown 还原 env 并删目录', () => {
  const dir = nextDir('tmp-maint');
  const dbDir = nextDir('tmp-dbdir'); // 同卷（同一 TMP 树）
  const tmp = setupSqliteTmpdir({ maintenanceDir: dir, engineDbPath: path.join(dbDir, 'db.sqlite') });
  assert.equal(tmp.sameVolume, true, '同一临时树结构性同卷');
  assert.equal(process.env.SQLITE_TMPDIR, tmp.dir);
  assert.ok(fs.existsSync(tmp.dir));
  const prev = 'keep-me';
  process.env.SQLITE_TMPDIR = prev;
  teardownSqliteTmpdir({ ...tmp, previous: prev });
  assert.equal(process.env.SQLITE_TMPDIR, prev, '先前值还原');
  assert.equal(fs.existsSync(tmp.dir), false, '临时目录用后清理');
  teardownSqliteTmpdir(tmp); // previous undefined 形态：env 删除 + 目录已不存在不抛
  assert.equal(process.env.SQLITE_TMPDIR, undefined);
});

test('backupDatabases：存在才拷（三件套形态），字节与源逐 Buffer 相等', () => {
  const dir = nextDir('bk');
  const dbPath = path.join(dir, 'db.sqlite');
  fs.writeFileSync(dbPath, 'MAIN-BYTES');
  fs.writeFileSync(dbPath + '-wal', 'WAL-BYTES');
  fs.writeFileSync(dbPath + '-shm', Buffer.alloc(8, 7));
  const r = backupDatabases({ engineDbPath: dbPath, indexDbPath: path.join(dir, 'no-index.sqlite'), backupDir: path.join(dir, 'backup-x') });
  assert.deepEqual(r.files.map((f) => f.name), ['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm'], '缺失索引库跳过；三件套存在才拷');
  assert.equal(fs.readFileSync(path.join(r.backupDir, 'db.sqlite')).toString(), 'MAIN-BYTES');
  assert.equal(fs.readFileSync(path.join(r.backupDir, 'db.sqlite-wal')).toString(), 'WAL-BYTES');
  assert.equal(r.totalBytes, 10 + 9 + 8);
});

test('keep-1 与 purge：pruneOldBackups 只留新备份；purgeLatestBackup 删最新/无备份如实报告', () => {
  const maint = nextDir('purge-maint');
  fs.mkdirSync(path.join(maint, 'backup-a'));
  fs.mkdirSync(path.join(maint, 'backup-b'));
  fs.mkdirSync(path.join(maint, 'tmp-x')); // 非 backup- 前缀不动
  const removed = pruneOldBackups({ maintenanceDir: maint, keepName: 'backup-b' });
  assert.deepEqual(removed, ['backup-a']);
  assert.equal(fs.existsSync(path.join(maint, 'backup-b')), true);
  assert.equal(fs.existsSync(path.join(maint, 'tmp-x')), true);
  const p = purgeLatestBackup({ maintenanceDir: maint });
  assert.equal(p.purged, 'backup-b', 'purge 删除最新（字典序末位）');
  assert.equal(fs.existsSync(path.join(maint, 'backup-b')), false);
  const p2 = purgeLatestBackup({ maintenanceDir: path.join(maint, 'no-such') });
  assert.equal(p2.purged, null, '无备份如实报告 purged:null');
});

// ---------------------------------------------------- 全流程正例（fixture 双库 + 文件面）

test('全流程：删除计数 / 13 表 FK 列级联 / 备份等值 + keep-1 / VACUUM / 文件面 / 环境清理', () => {
  const fx = buildMainFixture();
  const outcome = runClean(cleanOptions(fx));
  assert.equal(outcome.exitCode, 0, `应成功：${outcome.text}`);
  const r = outcome.json;

  // 引擎库：删除集 5 会话（1 批），普通/新鲜会话与伴生行精确保留
  assert.deepEqual(r.engine.chunks, [5]);
  assert.equal(r.engine.checkpoints, 1);
  assert.equal(r.engine.sessionDeleted, 5);
  assert.equal(r.engine.perTable.message, 302, 'm1+m2+300 批量行直删（part 另经级联）');
  assert.deepEqual(query(fx.engineDbPath, 'SELECT id FROM session ORDER BY id').map((x) => x.id),
    ['keep1', 'keep2', 'scfresh'], '仅保留普通与新鲜会话');
  // 8 张直接 CASCADE 表对删除集归零；保留会话的行在（targeting 证据：scfresh 的 tu2）
  assert.equal(query(fx.engineDbPath, 'SELECT COUNT(*) n FROM message').at(0).n, 2, 'm3(scfresh)+m4(keep1)');
  assert.deepEqual(query(fx.engineDbPath, 'SELECT id FROM message ORDER BY id').map((x) => x.id), ['m3', 'm4']);
  assert.equal(query(fx.engineDbPath, "SELECT COUNT(*) n FROM todo WHERE session_id='wl1'").at(0).n, 0);
  assert.equal(query(fx.engineDbPath, "SELECT COUNT(*) n FROM session_entry WHERE session_id='sess_wl2'").at(0).n, 0);
  assert.equal(query(fx.engineDbPath, "SELECT COUNT(*) n FROM session_input WHERE session_id='wl1'").at(0).n, 0);
  assert.equal(query(fx.engineDbPath, "SELECT COUNT(*) n FROM session_target WHERE session_id='sess_wl2'").at(0).n, 0);
  assert.deepEqual(query(fx.engineDbPath, 'SELECT id FROM model_usage ORDER BY id').map((x) => x.id).length, 0, 'mu1/mu2 全删');
  assert.deepEqual(query(fx.engineDbPath, 'SELECT session_id FROM turn_usage').map((x) => x.session_id), ['scfresh'], '保留会话的统计行不动');
  assert.equal(query(fx.engineDbPath, 'SELECT COUNT(*) n FROM tool_usage').at(0).n, 0);
  // part 经 message 级联（C1+FK ON）：删除集的 302 行归零，保留会话的 p3/p4 在
  assert.equal(r.engine.partCascaded, 302, 'p1+p2+300 批量行经 message CASCADE');
  assert.deepEqual(query(fx.engineDbPath, 'SELECT id FROM part ORDER BY id').map((x) => x.id), ['p3', 'p4']);
  // session_task_link 双列：child 级联删行；parent 置 NULL 且行保留
  assert.equal(r.engine.sessionTaskLinkDeleted, 1);
  assert.equal(r.engine.sessionTaskLinkParentNull, 1);
  const l2 = query(fx.engineDbPath, "SELECT parent_session_id, child_session_id FROM session_task_link WHERE id='l2'").at(0);
  assert.equal(l2.parent_session_id, null, 'l2 parent 置空');
  assert.equal(l2.child_session_id, 'keep2', 'l2 行保留');
  assert.equal(query(fx.engineDbPath, "SELECT COUNT(*) n FROM session_task_link WHERE id='l1'").at(0).n, 0, 'l1 随 child 级联删除');
  // SET NULL 列 2：行保留 + 列置空
  assert.equal(r.engine.workflowRunNull, 1);
  assert.equal(r.engine.workflowActivityNull, 1);
  assert.equal(query(fx.engineDbPath, "SELECT parent_session_id FROM workflow_run WHERE id='wr1'").at(0).parent_session_id, null);
  assert.equal(query(fx.engineDbPath, "SELECT child_session_id FROM workflow_activity WHERE id='wa1'").at(0).child_session_id, null);
  // input_history（无 FK）随删计数；保留行与 null 行不动
  assert.equal(r.engine.inputHistoryDeleted, 1);
  assert.deepEqual(query(fx.engineDbPath, 'SELECT id FROM input_history ORDER BY id').map((x) => x.id), ['i2', 'i3']);

  // VACUUM：真实回收（300 批量行删除后 page_count 下降）
  assert.ok(r.engine.vacuum, 'VACUUM 已执行');
  assert.ok(r.engine.vacuum.after.count < r.engine.vacuum.before.count, 'page_count 下降');
  assert.ok(r.engine.vacuum.freedBytes > 0);

  // 备份：三件套文件字节与源一致（备份发生在删除前）+ keep-1 清旧
  assert.deepEqual(r.backup.pruned, ['backup-old']);
  assert.deepEqual(r.backup.files.map((f) => f.name).sort(), ['db.sqlite', 'tasks-index.sqlite'], '干净关闭库无 -wal/-shm，存在才拷');
  assert.equal(fs.readFileSync(path.join(r.backup.dir, 'db.sqlite')).equals(fx.engineBytes), true, '引擎库备份逐字节一致');
  assert.equal(fs.readFileSync(path.join(r.backup.dir, 'tasks-index.sqlite')).equals(fx.indexBytes), true, '索引库备份逐字节一致');
  assert.equal(fs.existsSync(path.join(fx.maintenanceDir, 'backup-old')), false, 'keep-1：旧备份已清');

  // 索引库联动：tasks 对最终集归零；tk9 及其 members/automations 保留。
  // membersDeleted 恒 0：member 命中删除集 = 冲突源 → 会话已被整体剔除（D1⑤），
  // 联动 DELETE 语句保留为防御性清扫（只可能命中不挂 tasks 行的边缘形态）
  assert.deepEqual({ tasksDeleted: r.index.tasksDeleted, membersDeleted: r.index.membersDeleted }, { tasksDeleted: 5, membersDeleted: 0 });
  assert.deepEqual(query(fx.indexDbPath, 'SELECT task_id FROM tasks').map((x) => x.task_id), ['tk9']);
  assert.deepEqual(query(fx.indexDbPath, 'SELECT task_id FROM task_group_members').map((x) => x.task_id), ['tk9']);
  assert.equal(query(fx.indexDbPath, 'SELECT COUNT(*) n FROM automations').at(0).n, 1, 'automations 不删（D1⑤：仅冲突预检报告）');

  // 文件面：集内删、集外与引擎自有目录留
  assert.equal(fs.existsSync(path.join(fx.artifactsDir, 'wl1')), false);
  assert.equal(fs.existsSync(path.join(fx.artifactsDir, 'sc1')), false);
  assert.equal(fs.existsSync(path.join(fx.artifactsDir, 'keepdir1')), true);
  assert.equal(fs.existsSync(path.join(fx.execDir, 'sess_wl2')), false);
  assert.equal(fs.existsSync(path.join(fx.execDir, 'sess_old_empty')), false, '超龄空壳通道');
  assert.equal(fs.existsSync(path.join(fx.execDir, 'bash-startup')), true, '引擎自有目录不动');
  assert.equal(fs.existsSync(path.join(fx.logDir, 'old.log')), false);
  assert.equal(fs.existsSync(path.join(fx.logDir, 'new.log')), true);

  // SQLITE_TMPDIR：钉死同卷 + 用后清理 + env 还原
  assert.equal(r.disk.sqliteTmpdir.sameVolume, true);
  assert.equal(r.disk.sqliteTmpdir.cleaned, true);
  assert.ok(r.disk.sqliteTmpdir.dir.startsWith(fx.maintenanceDir));
  assert.equal(fs.existsSync(r.disk.sqliteTmpdir.dir), false);
  assert.equal(process.env.SQLITE_TMPDIR, undefined, 'env 用后还原');

  // 成功样张结构 + 还原指引逐字
  assert.match(outcome.text, /✓ 前置校验：ZCode GUI \/ zcode app-server \/ ZSW_NESTED 进程均未运行；双库独占开锁成功；/);
  assert.match(outcome.text, /磁盘三段校验过/);
  assert.match(outcome.text, /SQLITE_TMPDIR 已钉死与库同卷/);
  assert.match(outcome.text, /✓ 污染哨兵：删除集 ∩ targetSessionId 值域 = 0/);
  assert.match(outcome.text, /✓ 索引冲突预检：members \/ automations \/ off_peak 命中 0 条/);
  assert.match(outcome.text, new RegExp(`✓ 快照备份：${r.backup.dir}/ 内双库三件套`));
  assert.match(outcome.text, /✓ 引擎库：分块删除（1 批 × ≤200 会话，/);
  assert.match(outcome.text, /VACUUM 完成（/);
  assert.match(outcome.text, /✓ GUI 索引：删除 tasks 5 行；input_history 随删 1 行/);
  assert.match(outcome.text, /✓ 文件面：artifacts 2 目录、log 按龄 1 文件、exec sess_ 2 目录/);
  assert.match(outcome.text, /如有异常，还原：①退出 ZCode；②删除原位 db\.sqlite\/-wal\/-shm 与/);
  assert.match(outcome.text, /zsw doctor clean --purge-backup 释放备份空间。/);
});

test('A-4 fixture 版：dry-run 与执行报告逐面计数一致（全覆盖文件面形态）', () => {
  const dir = nextDir('a4-');
  const engineDbPath = path.join(dir, 'db.sqlite');
  createEngineDb(engineDbPath, {
    sessions: [
      ['sess_a', '/Users/u/proj', 'interactive', NOW - 1 * DAY],
      ['sc1', '/Users/u/proj', 'subagent_child', NOW - 10 * DAY],
    ],
    messages: [['m1', 'sess_a']],
    parts: [['p1', 'm1', 'sess_a']],
    inputHistory: [['i1', 'sess_a']],
  });
  const indexDbPath = path.join(dir, 'tasks-index.sqlite');
  createIndexDb(indexDbPath, { taskIds: ['sess_a', 'sc1'] });
  const records = writeRecords(dir, [{ sessionId: 'sess_a' }]);
  const artifactsDir = path.join(dir, 'artifacts');
  const execDir = path.join(dir, 'exec');
  const logDir = path.join(dir, 'log');
  for (const name of ['sess_a', 'sc1']) fs.mkdirSync(path.join(artifactsDir, name), { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, 'sess_a', 'a.txt'), 'x');
  fs.writeFileSync(path.join(artifactsDir, 'sc1', 'b.txt'), 'x');
  fs.mkdirSync(path.join(execDir, 'sess_a'), { recursive: true }); // ∈ 集
  fs.mkdirSync(path.join(execDir, 'sess_stale_old'), { recursive: true }); // ∉ 集，超龄空壳
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'old.log'), 'x'.repeat(10));
  setMtime(path.join(execDir, 'sess_stale_old'), NOW - 20 * DAY);
  setMtime(path.join(logDir, 'old.log'), NOW - 20 * DAY);
  const fx = { engineDbPath, indexDbPath, records, artifactsDir, execDir, logDir, maintenanceDir: path.join(dir, 'maintenance') };

  // 同刻 dry-run（只读）→ 执行
  const dry = collectDryRun({ now: NOW, engineDbPath, indexDbPath, recordsPath: records, artifactsDir, logDir, execDir });
  const outcome = runClean(cleanOptions(fx, { maintenanceDir: fx.maintenanceDir }));
  assert.equal(outcome.exitCode, 0, outcome.text);
  const counts = outcome.json.counts;

  assert.deepEqual([...dry.deleteSet.engineSessionIds].sort(), outcome.json.deleteSet.engineSessionIds, '删除集一致');
  assert.equal(counts.engineSessionIds, dry.deleteSet.engineSessionIds.length);
  assert.equal(counts.whitelist, dry.deleteSet.byClass.whitelist.length);
  assert.equal(counts.subagentChildStale, dry.deleteSet.byClass.subagentChildStale.length);
  assert.equal(counts.indexTaskIds, dry.deleteSet.indexTaskIds.length);
  assert.equal(counts.inputHistoryHits, dry.inputHistoryHits, 'input_history 命中 = 实删');
  // 文件面三口径（dry-run 全量扫描 == 执行清单：全覆盖形态）
  assert.equal(dry.files.artifacts.dirCount, counts.artifacts);
  assert.equal(dry.files.exec.sessPrefixed, counts.execInSet + counts.execStaleEmpty);
  assert.equal(dry.files.log.olderThan14d, counts.logFiles);
  // 实删与计划一致（无失败项）
  const res = outcome.json.files.result;
  assert.equal(res.totalFailureCount, 0);
  assert.equal(res.artifacts.deletedCount, counts.artifacts);
  assert.equal(res.exec.deletedCount, counts.execInSet + counts.execStaleEmpty);
  assert.equal(res.log.deletedCount, counts.logFiles);
});

// ---------------------------------------------------- 分块删除

test('分块：450 会话 → 3 批（200/200/50），批间 checkpoint 可观测，最终计数一致', () => {
  const dir = nextDir('chunk-');
  const engineDbPath = path.join(dir, 'db.sqlite');
  const sessions = [];
  for (let i = 0; i < 450; i++) sessions.push([`cs${String(i).padStart(3, '0')}`, '/Users/u/proj', 'subagent_child', NOW - 10 * DAY]);
  sessions.push(['kp1', '/Users/u/other', 'interactive', NOW - 1 * DAY]);
  createEngineDb(engineDbPath, { sessions });
  createIndexDb(path.join(dir, 'tasks-index.sqlite'), {}); // 空索引库：锁校验要求文件存在
  const records = writeRecords(dir, []);
  const maintenanceDir = path.join(dir, 'maintenance');
  const batches = [];
  const outcome = runClean(cleanOptions({
    engineDbPath, indexDbPath: path.join(dir, 'tasks-index.sqlite'), records,
    artifactsDir: path.join(dir, 'a'), logDir: path.join(dir, 'l'), execDir: path.join(dir, 'e'),
    maintenanceDir,
  }, {
    afterBatch: (i, info) => batches.push([i, info.chunkSize]),
  }));
  assert.equal(outcome.exitCode, 0, outcome.text);
  const r = outcome.json;
  assert.equal(DEFAULT_CHUNK_SIZE, 200);
  assert.deepEqual(r.engine.chunks, [200, 200, 50]);
  assert.deepEqual(batches, [[0, 200], [1, 200], [2, 50]], '批序稳定（升序切块）');
  assert.equal(r.engine.checkpoints, 3);
  assert.equal(r.engine.sessionDeleted, 450);
  assert.deepEqual(query(engineDbPath, 'SELECT id FROM session').map((x) => x.id), ['kp1']);
});

// ---------------------------------------------------- 四项停机校验（D2）

test('停机校验①②③：ps 文本注入 GUI/app-server/ZSW_NESTED 形态 → 拒绝 + PID + 恢复指引；库零改动', () => {
  const cases = [
    {
      name: 'GUI',
      psText: '     1 /sbin/launchd\n 13791 ZCode\n 13807 /Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper --type=gpu\n',
      pidText: '13791、13807',
      head: '✗ 前置校验失败：检测到 ZCode 进程（PID 13791、13807）正在运行。',
    },
    { name: 'app-server', psText: ' 500 node /x/zcode.cjs app-server --cwd /tmp/w\n', pidText: '500', head: '✗ 前置校验失败：检测到 zcode app-server 进程（PID 500）正在运行。' },
    { name: 'nested', psText: ' 600 sh -c ZSW_NESTED=1 node agent.js\n', pidText: '600', head: '✗ 前置校验失败：检测到 ZSW_NESTED=1 进程（PID 600）正在运行。' },
  ];
  for (const c of cases) {
    const fx = buildMainFixture();
    const before = query(fx.engineDbPath, 'SELECT COUNT(*) n FROM session').at(0).n;
    const outcome = runClean(cleanOptions(fx, { psText: c.psText }));
    assert.equal(outcome.exitCode, 1, c.name);
    assert.ok(outcome.text.startsWith(c.head), `${c.name} 首行逐字：${outcome.text.split('\n')[0]}`);
    assert.ok(outcome.text.includes(c.pidText), `${c.name} 文案含 PID`);
    assert.match(outcome.text, /👉 退出 ZCode（含菜单栏常驻）后重跑本命令。|👉 /, '恢复指引');
    assert.equal(query(fx.engineDbPath, 'SELECT COUNT(*) n FROM session').at(0).n, before, '拒绝路径库零改动');
    assert.equal(fs.readdirSync(fx.maintenanceDir).filter((n) => n.startsWith('backup-') && n !== 'backup-old').length, 0, '未产生新备份');
  }
});

test('停机校验④：fixture 库被另一连接 BEGIN EXCLUSIVE 持锁 → 拒绝（兜底拦截改写名持库者），库零改动', () => {
  const fx = buildMainFixture();
  const holder = new DatabaseSync(fx.engineDbPath);
  try {
    holder.exec('BEGIN EXCLUSIVE');
    const outcome = runClean(cleanOptions(fx));
    assert.equal(outcome.exitCode, 1);
    assert.match(outcome.text, /✗ 前置校验失败：双库独占开锁失败/);
    assert.match(outcome.text, /引擎库：/);
    assert.match(outcome.text, /lsof/);
    assert.equal(query(fx.engineDbPath, 'SELECT COUNT(*) n FROM session').at(0).n, 8, '拒绝路径库零改动');
    assert.equal(outcome.json.backup, null, '未走到备份');
  } finally {
    holder.close(); // 关闭即回滚并释放
  }
});

test('runShutdownChecks：ps 注入不落盘；独占开锁对缺文件报可操作失败', () => {
  const r = runShutdownChecks({ psText: PS_CALM, engineDbPath: '/no/such.sqlite', indexDbPath: '/no/such2.sqlite' });
  assert.equal(r.ok, false);
  assert.equal(r.psSource, 'injected');
  assert.equal(r.processViolations.length, 0, '进程面干净');
  assert.deepEqual(r.lockFailures.map((f) => f.label), ['引擎库', '索引库']);
  assert.match(r.lockFailures[0].message, /不存在/);
});

// ---------------------------------------------------- 三段磁盘校验（D4）

test('磁盘校验① 备份前不足 → 拒绝 + --fs-only 指引，无备份产生', () => {
  const fx = buildMainFixture();
  const outcome = runClean(cleanOptions(fx, { freeBytesFn: (vol, stage) => (stage === 'pre-backup' ? 1 : freeGenerous()) }));
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.text, /✗ 前置校验失败：备份前剩余空间不足——剩余 1B < 需要 /);
  assert.match(outcome.text, /库三件套 .*×1.1/);
  assert.match(outcome.text, /zsw doctor clean --fs-only 清文件面腾空间，再重跑全量 clean。/);
  assert.match(outcome.text, /不设豁免。/);
  assert.deepEqual(fs.readdirSync(fx.maintenanceDir).filter((n) => n.startsWith('backup-')), ['backup-old'], '未产生新备份');
  assert.equal(query(fx.engineDbPath, 'SELECT COUNT(*) n FROM session').at(0).n, 8, '库零改动');
});

test('磁盘校验② 删除前不足 → 拒绝；备份已产生（安全网先行），库零改动', () => {
  const fx = buildMainFixture();
  const outcome = runClean(cleanOptions(fx, { freeBytesFn: (vol, stage) => (stage === 'pre-delete' ? 0.5 * GB : freeGenerous()) }));
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.text, /✗ 前置校验失败：删除前剩余空间不足——备份已占/);
  assert.match(outcome.text, /< 需要 1GB。/);
  assert.match(outcome.text, /zsw doctor clean --fs-only/);
  // keep-1：新备份成功即清旧（backup-old 已被 prune），拒绝发生在备份之后——安全网 = 最新一份
  const backups = fs.readdirSync(fx.maintenanceDir).filter((n) => n.startsWith('backup-'));
  assert.equal(backups.length, 1, '只保留最新一份（keep-1）');
  assert.match(backups[0], /^backup-2026-/, '现存备份即本次新备份');
  assert.equal(query(fx.engineDbPath, 'SELECT COUNT(*) n FROM session').at(0).n, 8, '删除未开始，库零改动');
});

test('磁盘校验③ VACUUM 前不足 → 拒绝；删除已提交、VACUUM 跳过（中流状态如实声明）', () => {
  const fx = buildMainFixture();
  // 门槛 = 库三件套×1.1（小库 KB 级）：注入 0 才能真实击穿
  const outcome = runClean(cleanOptions(fx, { freeBytesFn: (vol, stage) => (stage === 'pre-vacuum' ? 0 : freeGenerous()) }));
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.text, /✗ 前置校验失败：VACUUM 前剩余空间不足——备份已占/);  assert.match(outcome.text, /当前状态：引擎库删除已提交（分块事务生效），VACUUM 未执行——删除已生效但空间尚未回收。/);
  assert.match(outcome.text, /备份保留在原位（回滚安全网仍在）/);
  assert.equal(outcome.json.engine.vacuum, null, 'VACUUM 跳过');
  assert.equal(outcome.json.engine.sessionDeleted, 5, '删除已提交');
  assert.equal(query(fx.engineDbPath, 'SELECT COUNT(*) n FROM session').at(0).n, 3);
});

// ---------------------------------------------------- 污染哨兵复断言

test('哨兵复断言：交集命中 → clean 中止不改库（库字节/行数前后一致）+ 样本文案', () => {
  const fx = buildMainFixture();
  // sc1 同帧作为 targetSessionId（嵌套合法重叠的 fixture 化）→ 原始删除集命中
  fs.writeFileSync(fx.records, `${[
    JSON.stringify({ sessionId: 'wl1' }),
    JSON.stringify({ exec: { sessionId: 'sess_wl2' }, sessionId: 'wl3' }),
    JSON.stringify({ sessionId: 'sc1' }),
    JSON.stringify({ sessionId: 'sc2' }),
    JSON.stringify({ targetSessionId: 'keep1' }),
    JSON.stringify({ targetSessionId: 'sc1' }),
  ].join('\n')}\n`);
  const bytesBefore = fs.readFileSync(fx.engineDbPath).length;
  const outcome = runClean(cleanOptions(fx));
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.text, /✗ 污染哨兵失败：删除集 ∩ targetSessionId 值域 = 1（sc1）。/);
  assert.match(outcome.text, /命中可能是识别器污染（C6-被否：targetSessionId 是 zsw 调用方宿主会话=用户真实会话），/);
  assert.match(outcome.text, /嵌套调用的合法重叠/);
  assert.match(outcome.text, /中止不改库/);
  assert.equal(fs.readFileSync(fx.engineDbPath).length, bytesBefore, '库字节一致');
  assert.equal(query(fx.engineDbPath, 'SELECT COUNT(*) n FROM session').at(0).n, 8, '行数一致');
  assert.deepEqual(fs.readdirSync(fx.maintenanceDir).filter((n) => n.startsWith('backup-')), ['backup-old'], '未产生新备份');
});

// ---------------------------------------------------- 冲突剔除联动（D1⑤）

test('冲突剔除：automations 命中会话双侧收缩；删除后该 tasks 行与引擎 session 行都在', () => {
  const fx = buildMainFixture();
  const idb = new DatabaseSync(fx.indexDbPath);
  idb.prepare('INSERT INTO automations (automation_id, cron_expr, prompt, workspace_key, target_task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('a-conflict', '* * * * *', 'p', 'wk', 'wl1', NOW, NOW);
  idb.close();

  const outcome = runClean(cleanOptions(fx));
  assert.equal(outcome.exitCode, 0, outcome.text);
  const r = outcome.json;
  assert.deepEqual(r.deleteSet.engineSessionIds, ['sc1', 'sc2', 'sess_wl2', 'wl3'], 'wl1 双侧剔除');
  assert.deepEqual(r.deleteSet.indexTaskIds, ['sc1', 'sc2', 'sess_wl2', 'wl3']);
  assert.equal(r.identify.conflicts.removed.length, 1);
  assert.equal(r.identify.conflicts.removed[0].id, 'wl1');
  assert.match(r.identify.conflicts.removed[0].source, /automations/);
  // 冲突会话双库均保留
  assert.ok(query(fx.engineDbPath, "SELECT id FROM session WHERE id='wl1'").length === 1, '引擎 session 行保留');
  assert.ok(query(fx.indexDbPath, "SELECT task_id FROM tasks WHERE task_id='wl1'").length === 1, 'index tasks 行保留');
  assert.equal(fs.existsSync(path.join(fx.artifactsDir, 'wl1')), true, '文件面同步保留');
  // 报告行：冲突剔除明细（automations 单源命中）
  assert.match(outcome.text, /✓ 索引冲突预检：命中 1 条 → 冲突会话 1 个已从双库删除集整体剔除（wl1\[automations\]）/);
});

// ---------------------------------------------------- --fs-only 档

test('--fs-only：停机校验不豁免（GUI 进程在场即拒绝）', () => {
  const fx = buildMainFixture();
  const outcome = runClean(cleanOptions(fx, {
    fsOnly: true,
    psText: ' 13791 ZCode\n',
  }));
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.text, /✗ 前置校验失败：检测到 ZCode 进程（PID 13791）正在运行。/);
  assert.equal(fs.existsSync(path.join(fx.artifactsDir, 'wl1')), true, '拒绝路径文件面零动作');
});

test('--fs-only：库操作跳过、文件面执行、无备份', () => {
  const fx = buildMainFixture();
  const outcome = runClean(cleanOptions(fx, { fsOnly: true }));
  assert.equal(outcome.exitCode, 0, outcome.text);
  const r = outcome.json;
  assert.equal(r.fsOnly, true);
  assert.equal(r.engine, null, '库操作跳过');
  assert.equal(r.index, null);
  assert.equal(r.backup, null, '无备份');
  assert.equal(r.disk.stages.length, 0, '磁盘校验属库面，fs-only 不跑');
  assert.equal(query(fx.engineDbPath, 'SELECT COUNT(*) n FROM session').at(0).n, 8, '引擎库零改动');
  assert.equal(query(fx.indexDbPath, 'SELECT COUNT(*) n FROM tasks').at(0).n, 6, '索引库零改动');
  assert.equal(fs.existsSync(path.join(fx.artifactsDir, 'wl1')), false, '文件面照常执行');
  assert.equal(fs.existsSync(path.join(fx.execDir, 'wl1')), false);
  assert.match(outcome.text, /✓ 文件面（--fs-only，库操作已跳过、未做备份）/);
  assert.equal(fs.readdirSync(fx.maintenanceDir).filter((n) => n.startsWith('backup-') && n !== 'backup-old').length, 0);
});

// ---------------------------------------------------- --stale 周期维护档（u5）

/**
 * stale 端到端 fixture（A-5 fixture 版）：三类识别源各一对「旧（10d）/新（1d）」
 * + 集外普通会话；文件面含集内目录、新会话非空壳目录、超龄空壳（独立 7d 龄档
 * 通道）与 10d/20d 两档 log（log 保留 14 天，不跟随 --older-than 7）。
 */
function buildStaleE2EFixture() {
  const dir = nextDir('stale-');
  const engineDbPath = path.join(dir, 'db.sqlite');
  // session id 恒为 sess_ 前缀形态（与 u3 主 fixture / 真实库一致——文件面 exec
  // 目录名 = session id 精确相等匹配，id 形态决定 exec 目录名）
  createEngineDb(engineDbPath, {
    sessions: [
      ['sess_owl', '/Users/u/stale-proj', 'interactive', NOW - 10 * DAY],
      ['sess_onew', '/Users/u/stale-proj', 'interactive', NOW - 1 * DAY],
      ['sess_fold', '/tmp/x/zsub-e2e-stale/proj', 'interactive', NOW - 10 * DAY],
      ['sess_fnew', '/tmp/x/zsub-e2e-stale/proj', 'interactive', NOW - 1 * DAY],
      ['sess_cold', '/Users/u/stale-proj', 'subagent_child', NOW - 10 * DAY],
      ['sess_cnew', '/Users/u/stale-proj', 'subagent_child', NOW - 1 * DAY],
      ['keep1', '/Users/u/other', 'interactive', NOW - 1 * DAY],
    ],
    messages: [['mo', 'sess_owl'], ['mno', 'sess_onew'], ['mc', 'sess_cold'], ['mcn', 'sess_cnew']],
    parts: [['po', 'mo', 'sess_owl'], ['pno', 'mno', 'sess_onew'], ['pc', 'mc', 'sess_cold'], ['pcn', 'mcn', 'sess_cnew']],
    modelUsage: [['mu1', 'sess_owl']],
    turnUsage: [['sess_onew', 'tu1']],
    inputHistory: [['i1', 'sess_owl'], ['i2', 'sess_onew']],
  });
  const indexDbPath = path.join(dir, 'tasks-index.sqlite');
  createIndexDb(indexDbPath, {
    taskIds: ['sess_owl', 'sess_onew', 'sess_fold', 'sess_fnew', 'sess_cold', 'sess_cnew', 'tk9'],
  });
  const records = writeRecords(dir, [{ sessionId: 'sess_owl' }, { sessionId: 'sess_onew' }]);
  const artifactsDir = path.join(dir, 'artifacts');
  const execDir = path.join(dir, 'exec');
  const logDir = path.join(dir, 'log');
  for (const name of ['sess_owl', 'sess_fold', 'sess_cold', 'sess_onew', 'sess_fnew']) {
    fs.mkdirSync(path.join(artifactsDir, name), { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, name, 'a.txt'), 'x');
  }
  fs.mkdirSync(path.join(execDir, 'sess_owl'), { recursive: true }); // ∈ 删除集 → execInSet
  fs.mkdirSync(path.join(execDir, 'sess_onew'), { recursive: true }); // ∉ 集（新会话）+ 非空壳 → 不删
  fs.writeFileSync(path.join(execDir, 'sess_onew', 'live.txt'), 'x');
  fs.mkdirSync(path.join(execDir, 'sess_stale_shell'), { recursive: true }); // ∉ 集 + 超龄空壳 → execStaleEmpty（独立 7d 龄档）
  fs.mkdirSync(path.join(execDir, 'bash-startup'), { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'mid.log'), 'x'); // 10d 龄：< 14d log 档 → 保留（档位不跟随 --older-than 7）
  fs.writeFileSync(path.join(logDir, 'ancient.log'), 'x'); // 20d 龄：> 14d → 删
  const stale = NOW - 20 * DAY;
  const mid = NOW - 10 * DAY;
  setMtime(path.join(execDir, 'sess_stale_shell'), stale);
  setMtime(path.join(execDir, 'bash-startup'), stale);
  setMtime(path.join(logDir, 'mid.log'), mid);
  setMtime(path.join(logDir, 'ancient.log'), stale);
  const maintenanceDir = path.join(dir, 'maintenance');
  fs.mkdirSync(maintenanceDir, { recursive: true });
  return { dir, engineDbPath, indexDbPath, records, artifactsDir, execDir, logDir, maintenanceDir };
}

test('--stale 全流程：删除只命中超龄部分——新会话与其子表行/文件面完好，文件面档位不跟随', () => {
  const fx = buildStaleE2EFixture();
  const outcome = runClean(cleanOptions(fx, { staleMode: true }));
  assert.equal(outcome.exitCode, 0, outcome.text);
  const r = outcome.json;

  assert.equal(r.staleMode, true);
  assert.equal(r.engine.sessionDeleted, 3, 'owl/fold/cold 三类超龄行各删 1');
  assert.deepEqual(query(fx.engineDbPath, 'SELECT id FROM session ORDER BY id').map((x) => x.id),
    ['keep1', 'sess_cnew', 'sess_fnew', 'sess_onew'], '新会话与集外 keep1 保留');
  // 新会话子表行完好；超龄会话的伴生行随删
  assert.equal(query(fx.engineDbPath, "SELECT COUNT(*) n FROM message WHERE session_id='sess_onew'").at(0).n, 1);
  assert.equal(query(fx.engineDbPath, "SELECT COUNT(*) n FROM part WHERE session_id='sess_onew'").at(0).n, 1);
  assert.equal(query(fx.engineDbPath, "SELECT COUNT(*) n FROM turn_usage WHERE session_id='sess_onew'").at(0).n, 1);
  assert.equal(query(fx.engineDbPath, 'SELECT COUNT(*) n FROM model_usage').at(0).n, 0, '超龄 sess_owl 的统计行随删');
  assert.deepEqual(query(fx.engineDbPath, 'SELECT id FROM input_history ORDER BY id').map((x) => x.id), ['i2'],
    '新会话输入历史保留，超龄会话的 i1 随删');
  // 索引联动只命中超龄部分
  assert.equal(r.index.tasksDeleted, 3);
  assert.deepEqual(query(fx.indexDbPath, 'SELECT task_id FROM tasks ORDER BY task_id').map((x) => x.task_id),
    ['sess_cnew', 'sess_fnew', 'sess_onew', 'tk9']);
  // 文件面 id 匹配通道随删除集收缩：超龄删、新会话与集外留
  assert.equal(fs.existsSync(path.join(fx.artifactsDir, 'sess_owl')), false);
  assert.equal(fs.existsSync(path.join(fx.artifactsDir, 'sess_fold')), false);
  assert.equal(fs.existsSync(path.join(fx.artifactsDir, 'sess_cold')), false);
  assert.equal(fs.existsSync(path.join(fx.artifactsDir, 'sess_onew')), true, '新会话 artifacts 目录保留');
  assert.equal(fs.existsSync(path.join(fx.artifactsDir, 'sess_fnew')), true);
  assert.equal(fs.existsSync(path.join(fx.execDir, 'sess_owl')), false);
  assert.equal(fs.existsSync(path.join(fx.execDir, 'sess_onew')), true, '新会话 exec 目录保留（非空壳不删）');
  // 文件面档位不跟随 --older-than：exec 空壳 7d 独立通道照常、log 14d 档不变
  assert.equal(fs.existsSync(path.join(fx.execDir, 'sess_stale_shell')), false, '空壳超 7d 照删（exec 档位独立于 --older-than）');
  assert.equal(fs.existsSync(path.join(fx.execDir, 'bash-startup')), true);
  assert.equal(fs.existsSync(path.join(fx.logDir, 'mid.log')), true, '10d 龄 log 保留——log 14d 档不跟随 --older-than 7');
  assert.equal(fs.existsSync(path.join(fx.logDir, 'ancient.log')), false, '20d 龄 log 照删');
  // 报告：staleMode 字段 + 档位行（缺省形态不输出）
  assert.equal(r.files.result.totalFailureCount, 0);
  assert.match(outcome.text, /档位：--stale 周期维护（--older-than 7 天）——删除集缩到超龄部分；/);
  assert.match(outcome.text, /文件面档位不跟随（log 保留 14 天 \/ exec 空壳 7 天）/);
  assert.match(outcome.text, /✓ 引擎库：分块删除（1 批 × ≤200 会话，/);
});

test('--stale 对照：同 fixture 缺省形态存量全清（白名单/特征类不加龄、child 恒按龄），报告无档位行', () => {
  const fx = buildStaleE2EFixture();
  const outcome = runClean(cleanOptions(fx));
  assert.equal(outcome.exitCode, 0, outcome.text);
  const r = outcome.json;
  assert.equal(r.staleMode, false);
  assert.equal(r.engine.sessionDeleted, 5, '存量全清：白名单/特征类新旧全删 + 超龄 child；1d 新 child（sess_cnew）按 D1① 保留');
  assert.deepEqual(query(fx.engineDbPath, 'SELECT id FROM session ORDER BY id').map((x) => x.id), ['keep1', 'sess_cnew']);
  assert.equal(/档位：--stale/.test(outcome.text), false, '缺省样张无档位行（§3.1 逐字保持）');
});

// ---------------------------------------------------- 文件面失败项不阻断库侧对账

test('executeFileCleanup 失败项进 failures 不阻断库侧；planned=deleted+failures 闭合入报告', (t) => {
  if (process.getuid && process.getuid() === 0) {
    return t.skip('root 下 chmod 000 不构成删除屏障，用例仅对普通用户有意义');
  }
  const fx = buildMainFixture();
  const locked = path.join(fx.artifactsDir, 'wl1');
  fs.chmodSync(locked, 0o000);
  try {
    const outcome = runClean(cleanOptions(fx));
    assert.equal(outcome.exitCode, 1, '失败项如实反映退出码');
    const res = outcome.json.files.result;
    assert.equal(res.artifacts.failures.length, 1);
    assert.equal(res.artifacts.failures[0].name, 'wl1');
    assert.equal(res.artifacts.planned, res.artifacts.deletedCount + res.artifacts.failures.length, '面级闭合');
    assert.equal(res.totalFailureCount, 1);
    assert.match(outcome.text, /⚠ 文件面清理有 1 项失败（库侧已完成；/);
    // 闭合恒等式入文：planned(2+2+1=5) = deleted(1+2+1=4) + failures(1)
    assert.match(outcome.text, /planned=5 = deleted 4 \+ failures 1）。/);
    // 库侧照常完成
    assert.equal(outcome.json.engine.sessionDeleted, 5);
    assert.equal(query(fx.engineDbPath, 'SELECT COUNT(*) n FROM session').at(0).n, 3);
  } finally {
    fs.chmodSync(locked, 0o755); // after 清理可删
  }
});

// ---------------------------------------------------- 引擎库缺文件（禁静默空删）

test('引擎库不存在 → buildDeleteSet 抛可操作错误（DB_OPEN_FAILED，与 dry-run 同语义），未凭空建库', () => {
  const dir = nextDir('nodb-');
  const records = writeRecords(dir, [{ sessionId: 'wl1' }]);
  const opts = {
    now: NOW,
    engineDbPath: path.join(dir, 'nope.sqlite'),
    indexDbPath: path.join(dir, 'no-index.sqlite'),
    recordsPath: records,
    artifactsDir: path.join(dir, 'a'),
    logDir: path.join(dir, 'l'),
    execDir: path.join(dir, 'e'),
    maintenanceDir: path.join(dir, 'maintenance'),
    psText: PS_CALM,
    freeBytesFn: freeGenerous,
  };
  assert.throws(() => runClean(opts), (e) => {
    assert.equal(e.code, 'DB_OPEN_FAILED');
    assert.match(e.message, /引擎库打不开/);
    assert.match(e.message, /恢复指引/);
    return true;
  }, '识别管线对缺库的报错面（CLI main catch 输出 [zsw] 错误 + exit 1）');
  assert.equal(fs.existsSync(path.join(dir, 'nope.sqlite')), false, '未凭空建库（删除连接从未打开）');
});

// ---------------------------------------------------- 事务中止形态

test('引擎库删除中途抛错 → 失败报告含备份路径与还原指引，exitCode 1', () => {
  const fx = buildMainFixture();
  // 缺 workflow_run 表：第 4 条块内语句必抛（严格中止——删除链路禁静默）
  const db = new DatabaseSync(fx.engineDbPath);
  db.exec('DROP TABLE workflow_run');
  db.close();
  const outcome = runClean(cleanOptions(fx));
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.text, /✗ 清理执行失败：/);
  assert.match(outcome.text, new RegExp(`备份安全网在：${fx.maintenanceDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/backup-`));
  assert.match(outcome.text, /按还原指引整库回滚，或排除错误后重跑/);
  assert.match(outcome.text, /如有异常，还原：①退出 ZCode/);
});

after(() => fs.rmSync(TMP, { recursive: true, force: true }));
