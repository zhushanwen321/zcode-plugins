'use strict';

/**
 * lib/clean-identify.js 基座单测（u1 范围：构造式解析 + 特征目录表）。
 *
 * 为什么全进程内直测：parseRecordWhiteList 是纯函数（路径入参、无全局态），
 * fixture records.jsonl 用 mkdtemp 临时文件承载；matchFeatureDirectory 是
 * 纯谓词。无需子进程/注入 env——识别正确性（仅 sessionId、嵌套层、坏行
 * 跳过、段/整串语义）全部可用直接断言锁定。u2 分治用例追加于本文件。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRecordWhiteList,
  FEATURE_DIRECTORY_SEGMENT_PREFIX,
  FEATURE_DIRECTORY_EXACT,
  matchFeatureDirectory,
} = require('../lib/clean-identify');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-clean-identify-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function writeRecords(lines) {
  const p = path.join(TMP, `records-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, `${lines.join('\n')}\n`);
  return p;
}

// ------------------------------------------------- C6 构造式解析

test('构造式只收 sessionId 键，严禁收 targetSessionId（C6-被否：调用方宿主会话=用户真实会话）', () => {
  const p = writeRecords([
    JSON.stringify({ sessionId: 'sess_a', targetSessionId: 'sess_host' }),
    JSON.stringify({ targetSessionId: 'sess_host2' }),
  ]);
  const wl = parseRecordWhiteList(p);
  assert.ok(wl.has('sess_a'));
  assert.equal(wl.size, 1, 'targetSessionId 不得入式');
  assert.equal(wl.has('sess_host'), false);
  assert.equal(wl.has('sess_host2'), false);
});

test('嵌套层提取：嵌套对象与数组内的 sessionId 均收（exec.sessionId / sessionRef.sessionId 形态）', () => {
  const p = writeRecords([
    JSON.stringify({ exec: { sessionId: 'sess_n1' }, sessionRef: { sessionId: 'sess_n2' } }),
    JSON.stringify({ list: [{ sessionId: 'sess_n3' }, { deep: [{ sessionId: 'sess_n4' }] }] }),
  ]);
  const wl = parseRecordWhiteList(p);
  assert.deepEqual([...wl].sort(), ['sess_n1', 'sess_n2', 'sess_n3', 'sess_n4']);
});

test('坏 JSON 行跳过、空行跳过、非字符串值不收、重复值去重', () => {
  const p = writeRecords([
    '{"sessionId": "sess_ok1"}, trailing garbage', // 坏行
    '', // 空行
    '{"sessionId": 123}', // 非字符串
    '{"sessionId": null}', // null
    '{"sessionId": "sess_ok1"}', // 与首合法行重复（跨行去重）
    '{"sessionId": "sess_ok2"}',
  ]);
  const wl = parseRecordWhiteList(p);
  assert.deepEqual([...wl].sort(), ['sess_ok1', 'sess_ok2']);
});

test('键名精确相等语义：targetSessionId / sessionID 等变体不入式', () => {
  const p = writeRecords([
    JSON.stringify({ targetSessionId: 'sess_t', sessionID: 'sess_c', 'SessionId': 'sess_u' }),
  ]);
  assert.equal(parseRecordWhiteList(p).size, 0);
});

test('文件不存在 → 空集（zsw 从未运行；白名单恒空 = 不误删，保守正确不抛错）', () => {
  const wl = parseRecordWhiteList(path.join(TMP, 'no-such-records.jsonl'));
  assert.ok(wl instanceof Set);
  assert.equal(wl.size, 0);
});

// ------------------------------------------------- 特征目录表（D1③ 闭集）

test('段匹配：路径中存在 zsub-e2e- 前缀段即命中（含其下子路径）', () => {
  assert.equal(matchFeatureDirectory('/tmp/x/zsub-e2e-abc/e1-proj'), true, '特征段 + 项目子路径');
  assert.equal(matchFeatureDirectory('/var/folders/xy/zsub-e2e-Qw3E/zsw-root'), true, 'os.tmpdir() 实际前缀形态（macOS /var/folders）');
  assert.equal(matchFeatureDirectory('/tmp/zsub-e2e-abc'), true, '特征段本身为末段');
});

test('整串匹配：探针目录闭集两串', () => {
  assert.ok(FEATURE_DIRECTORY_EXACT.includes('/tmp/zsw-sidebar-probe'), '闭集含 C7 探针目录一');
  assert.ok(FEATURE_DIRECTORY_EXACT.includes('/tmp/pz2-work'), '闭集含 C7 探针目录二');
  assert.equal(matchFeatureDirectory('/tmp/zsw-sidebar-probe'), true);
  assert.equal(matchFeatureDirectory('/tmp/pz2-work'), true);
  assert.equal(matchFeatureDirectory('/tmp/zsw-sidebar-probe/sub'), false, '整串语义：子路径不命中（闭集未登记）');
});

test('非特征临时目录不误伤', () => {
  assert.equal(matchFeatureDirectory('/tmp/normal-project'), false);
  assert.equal(matchFeatureDirectory('/Users/u/Code/my-project'), false);
});

test('路径段语义：目录名含 zsub-e2e- 子串但不构成独立段的不命中（防模糊匹配误伤）', () => {
  assert.equal(matchFeatureDirectory('/home/u/my-zsub-e2e-notes'), false, '段名以 my- 开头：含子串但段首不符');
  assert.equal(matchFeatureDirectory('/Users/u/Code/proj.zsub-e2e-notes'), false, '段名含子串但段首不符');
});

test('段匹配的判定单位是「段」而非父路径：zsub-e2e- 开头的段在任意父路径下均命中（D1③ 原文口径）', () => {
  // 设计 §3.3 D1③ 原文：「directory 按 / 分段后存在以 zsub-e2e- 开头的段」——
  // 不限定父路径。真实用户项目目录段名以该前缀开头的概率被设计评述覆盖
  // （「真实用户项目不可能位于 OS 临时目录的该前缀下」），语义按设计忠实实现。
  assert.equal(matchFeatureDirectory('/tmp/zsub-e2e-abc/e1-proj'), true);
  assert.equal(matchFeatureDirectory('/var/folders/zz/zsub-e2e-Qw3E/e1-proj'), true);
  assert.equal(matchFeatureDirectory('/home/u/my-zsub-e2e-notes'), false, '段名以 my- 开头：含子串但段首不符');
});

test('边界输入：空串/非字符串不命中', () => {
  assert.equal(matchFeatureDirectory(''), false);
  assert.equal(matchFeatureDirectory(undefined), false);
  assert.equal(matchFeatureDirectory(null), false);
});

test('闭集常量冻结且前缀常量为段匹配语义的单一来源', () => {
  assert.equal(Object.isFrozen(FEATURE_DIRECTORY_EXACT), true, '闭集不可运行期篡改');
  assert.equal(FEATURE_DIRECTORY_SEGMENT_PREFIX, 'zsub-e2e-', '来源：test/e2e.test.js:39 mkdtemp 前缀');
});

// ============================================ u2 五类分治与安全网
// （buildDeleteSet 分治 / 污染哨兵 / 索引冲突预检与剔除 / 目录分布红灯 /
//   input_history 计数 / dry-run 组装与渲染。fixture 延续本文件风格：
//   mkdtemp 临时目录 + node:sqlite 微型库 + 伪 records.jsonl，
//   真实 ~/.zcode 零触碰。）

const { DatabaseSync } = require('node:sqlite');
const {
  parseRecordTargetSessionIds,
  buildDeleteSet,
  checkSentinel,
  checkIndexConflicts,
  excludeConflicts,
  checkRedLight,
  countInputHistoryHits,
  DEFAULT_OLDER_THAN_DAYS,
} = require('../lib/clean-identify');
const { collectDryRun, renderDryRun } = require('../lib/doctor');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

let u2Seq = 0;
function u2Dir() {
  const dir = path.join(TMP, `u2-${++u2Seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 微型引擎库（buildDeleteSet/checkRedLight 只查 session；input_history 按需另建）。 */
function createU2EngineDb(dbPath, rows) {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, task_type TEXT, time_created INTEGER)');
  const ins = db.prepare('INSERT INTO session (id, directory, task_type, time_created) VALUES (?, ?, ?, ?)');
  for (const [id, dir, type, created] of rows) ins.run(id, dir, type, created);
  db.close();
}

function createU2InputHistory(dbPath, rows) {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE input_history (id TEXT, session_id TEXT)');
  const ins = db.prepare('INSERT INTO input_history (id, session_id) VALUES (?, ?)');
  for (const r of rows) ins.run(...r);
  db.close();
}

/** 微型索引库（tasks 带 off_peak_task_id 列——真实库 pragma 实证的反向关联列）。 */
function createU2IndexDb(dbPath, { taskIds = [], members = [], automations = [], offPeak = [], taskOffPeakRefs = {} } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE tasks (task_id TEXT, off_peak_task_id TEXT)');
  db.exec('CREATE TABLE task_group_members (group_id TEXT, task_id TEXT)');
  db.exec('CREATE TABLE automations (automation_id TEXT, target_task_id TEXT)');
  db.exec('CREATE TABLE off_peak_tasks (off_peak_task_id TEXT, session_id TEXT)');
  const t = db.prepare('INSERT INTO tasks (task_id, off_peak_task_id) VALUES (?, ?)');
  for (const id of taskIds) t.run(id, taskOffPeakRefs[id] !== undefined ? taskOffPeakRefs[id] : null);
  const m = db.prepare('INSERT INTO task_group_members (group_id, task_id) VALUES (?, ?)');
  for (const r of members) m.run(...r);
  const a = db.prepare('INSERT INTO automations (automation_id, target_task_id) VALUES (?, ?)');
  for (const r of automations) a.run(...r);
  const o = db.prepare('INSERT INTO off_peak_tasks (off_peak_task_id, session_id) VALUES (?, ?)');
  for (const r of offPeak) o.run(...r);
  db.close();
}

// 主 fixture 会话矩阵（识别口径的权威定义）：
//   w1 interactive 白名单内（records 顶层）+ workspace 目录
//   w2 interactive 白名单外 特征目录（zsub-e2e- 段，OS 临时目录下）
//   w3 subagent_child 10d（超龄）
//   w4 subagent_child 1d（新鲜，不入集）
//   w5 interactive 白名单外（真实会话形态；records 的 targetSessionId 指向它——不入集）
//   w6 interactive 白名单内（records 嵌套层）+ OS 临时目录 + 不匹配特征表（outsideFeatureHits）
//   w7 subagent_child 恰 7d（阈值边界：严格小于语义下不算超龄）
const MAIN_SESSIONS = [
  ['w1', '/Users/u/real-proj', 'interactive', NOW - 1 * DAY],
  ['w2', '/tmp/x/zsub-e2e-abc/e1-proj', 'interactive', NOW - 2 * DAY],
  ['w3', '/Users/u/real-proj', 'subagent_child', NOW - 10 * DAY],
  ['w4', '/Users/u/real-proj', 'subagent_child', NOW - 1 * DAY],
  ['w5', '/Users/u/other-proj', 'interactive', NOW - 3 * DAY],
  ['w6', '/var/folders/ab/c/T/xyz', 'interactive', NOW - 2 * DAY],
  ['w7', '/Users/u/real-proj', 'subagent_child', NOW - 7 * DAY],
];

function buildMainFixture() {
  const dir = u2Dir();
  const engineDbPath = path.join(dir, 'db.sqlite');
  createU2EngineDb(engineDbPath, MAIN_SESSIONS);
  createU2InputHistory(engineDbPath, [['h1', 'w1'], ['h2', 'w3'], ['h3', 'w5'], ['h4', null]]);
  // 索引库无冲突形态：tasks 含删除集内 4 个 + 库外 t9；姊妹表行全部指向删除集外
  createU2IndexDb(path.join(dir, 'tasks-index.sqlite'), {
    taskIds: ['w1', 'w2', 'w3', 'w6', 't9'],
    members: [['g9', 't9']],
    automations: [['a9', 't9']],
    offPeak: [['op9', 'zz']],
  });
  const records = writeRecords([
    JSON.stringify({ sessionId: 'w1' }),
    JSON.stringify({ exec: { sessionId: 'w6' }, targetSessionId: 'w5' }),
  ]);
  // 文件面目录树（dry-run 渲染的量级行）
  const artifactsDir = path.join(dir, 'artifacts');
  const logDir = path.join(dir, 'log');
  const execDir = path.join(dir, 'exec');
  fs.mkdirSync(path.join(artifactsDir, 'w1'), { recursive: true });
  fs.mkdirSync(path.join(artifactsDir, 'w2'), { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, 'w1', 'a.txt'), 'x');
  fs.writeFileSync(path.join(artifactsDir, 'w2', 'b.txt'), 'x');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'new.log'), 'x');
  fs.mkdirSync(path.join(execDir, 'sess_w1'), { recursive: true });
  fs.mkdirSync(path.join(execDir, 'bash-startup'), { recursive: true });
  return { engineDbPath, indexDbPath: path.join(dir, 'tasks-index.sqlite'), records, artifactsDir, logDir, execDir };
}

// 冲突 fixture：三个冲突源各命中一个会话 + tasks.off_peak_task_id 反向关联一例。
//   c1 白名单（members g1 命中）/ c2 特征（automations a1 命中）/
//   c3 超龄 subagent_child（off_peak_tasks.session_id 命中）/
//   c4 特征（tasks.off_peak_task_id='op8' 反向关联命中）/
//   c5 白名单（无冲突——剔除后剩余项）/ c9 普通不入集 / cx 仅在索引库（不入删除集）
function buildConflictFixture() {
  const dir = u2Dir();
  const engineDbPath = path.join(dir, 'db.sqlite');
  createU2EngineDb(engineDbPath, [
    ['c1', '/Users/u/c-proj', 'interactive', NOW - 1 * DAY],
    ['c2', '/tmp/x/zsub-e2e-c/proj', 'interactive', NOW - 1 * DAY],
    ['c3', '/Users/u/c-proj', 'subagent_child', NOW - 10 * DAY],
    ['c4', '/var/folders/zz/T/zsub-e2e-D/proj', 'interactive', NOW - 1 * DAY],
    ['c5', '/Users/u/c-proj5', 'interactive', NOW - 1 * DAY],
    ['c9', '/Users/u/other-proj', 'interactive', NOW - 1 * DAY],
  ]);
  const indexDbPath = path.join(dir, 'tasks-index.sqlite');
  createU2IndexDb(indexDbPath, {
    taskIds: ['c1', 'c2', 'c3', 'c4', 'c5', 'cx'],
    members: [['g1', 'c1'], ['g2', 'cx']],
    automations: [['a1', 'c2'], ['a2', null]],
    offPeak: [['op1', 'c3'], ['op8', 'zz']],
    taskOffPeakRefs: { c4: 'op8' },
  });
  const records = writeRecords([
    JSON.stringify({ sessionId: 'c1' }),
    JSON.stringify({ sessionId: 'c5' }),
  ]);
  return { engineDbPath, indexDbPath, records };
}

function identifyOptions(fx, extra = {}) {
  return {
    now: NOW,
    engineDbPath: fx.engineDbPath,
    indexDbPath: fx.indexDbPath,
    recordsPath: fx.records,
    artifactsDir: fx.artifactsDir,
    logDir: fx.logDir,
    execDir: fx.execDir,
    ...extra,
  };
}

// ------------------------------------------------- 五类分治（D1①-⑤）

test('五类分治：byClass 分类 / 并集 / index 命中；w4 新鲜与 w7 恰 7d 不入超龄集', () => {
  const fx = buildMainFixture();
  const ds = buildDeleteSet(identifyOptions(fx));
  assert.deepEqual(ds.byClass.whitelist, ['w1', 'w6'], '白名单∩库：targetSessionId:w5 不入式');
  assert.deepEqual(ds.byClass.feature, ['w2']);
  assert.deepEqual(ds.byClass.subagentChildStale, ['w3'], 'w4（1d）新鲜保留；w7 恰等于 7d 阈值不算超龄（严格小于）');
  assert.deepEqual([...ds.engineSessionIds].sort(), ['w1', 'w2', 'w3', 'w6']);
  assert.deepEqual([...ds.interactiveClassIds].sort(), ['w1', 'w2', 'w6'], '红灯口径 = 白名单∪特征，不含 subagent_child');
  assert.deepEqual([...ds.indexTaskIds].sort(), ['w1', 'w2', 'w3', 'w6'], 'tasks.task_id ∈ 引擎删除集；t9 不在引擎库不入');
  assert.equal(ds.engineSessionIds.has('w5'), false, '不构造库外/集外 id');
  assert.equal(ds.engineSessionIds.has('t9'), false);
  assert.equal(ds.olderThanDays, DEFAULT_OLDER_THAN_DAYS);
  assert.equal(typeof ds.generatedAt, 'string');
});

test('olderThanDays 参数化：10d 时 w3（恰 10d）不算超龄；0d 时全部 subagent_child 入集', () => {
  const fx = buildMainFixture();
  const d10 = buildDeleteSet(identifyOptions(fx, { olderThanDays: 10 }));
  assert.deepEqual(d10.byClass.subagentChildStale, [], '恰等于阈值不算超龄');
  const d0 = buildDeleteSet(identifyOptions(fx, { olderThanDays: 0 }));
  assert.deepEqual(d0.byClass.subagentChildStale, ['w3', 'w4', 'w7']);
});

test('buildDeleteSet 缺必传参数 → 可操作错误（不静默产出空删除集）', () => {
  assert.throws(() => buildDeleteSet({ recordsPath: '/tmp/x.jsonl' }), /engineDbPath/);
  assert.throws(() => buildDeleteSet({ engineDbPath: '/tmp/nope.sqlite' }), /recordsPath/);
});

// ------------------------------------------------- --stale 周期维护档（u5，D5）

// stale fixture：白名单/特征目录/child 三类各有「旧（10d）/ 新（1d）」一对 +
// 两个边界行（恰 7d、time_created null）。语义权威口径（clean-identify 头注）：
// --stale = 三类统一按 time_created 严格早于 cutoff 过滤（周期维护不删新会话）；
// 缺省 = ②③存量全清（不加时间过滤）、①恒按龄（D1①）。
function buildStaleFixture() {
  const dir = u2Dir();
  const engineDbPath = path.join(dir, 'db.sqlite');
  createU2EngineDb(engineDbPath, [
    ['sw1', '/Users/u/stale-proj', 'interactive', NOW - 10 * DAY], // 白名单旧
    ['sw2', '/Users/u/stale-proj', 'interactive', NOW - 1 * DAY], // 白名单新
    ['sw3', '/Users/u/stale-proj', 'interactive', NOW - 7 * DAY], // 白名单恰等 7d
    ['sx', '/Users/u/stale-proj', 'interactive', null], // time_created 非数值
    ['sf1', '/tmp/x/zsub-e2e-stale/proj', 'interactive', NOW - 10 * DAY], // 特征旧
    ['sf2', '/tmp/x/zsub-e2e-stale/proj', 'interactive', NOW - 1 * DAY], // 特征新
    ['sc1', '/Users/u/stale-proj', 'subagent_child', NOW - 10 * DAY], // child 旧
    ['sc2', '/Users/u/stale-proj', 'subagent_child', NOW - 1 * DAY], // child 新
  ]);
  const records = writeRecords([
    JSON.stringify({ sessionId: 'sw1' }),
    JSON.stringify({ sessionId: 'sw2' }),
    JSON.stringify({ sessionId: 'sw3' }),
    JSON.stringify({ sessionId: 'sx' }),
  ]);
  return { engineDbPath, indexDbPath: path.join(dir, 'tasks-index.sqlite'), records };
}

test('--stale 档位：三类统一按龄——只删超龄，新会话与 null 行保留；staleMode 字段透出', () => {
  const fx = buildStaleFixture();
  const ds = buildDeleteSet(identifyOptions(fx, { staleMode: true }));
  assert.equal(ds.staleMode, true);
  assert.deepEqual(ds.byClass.whitelist, ['sw1'], '白名单新（sw2 1d）/恰等 7d（sw3）/null（sx）全保留');
  assert.deepEqual(ds.byClass.feature, ['sf1'], '特征目录类同样按龄（D5 识别集缩到超龄部分）');
  assert.deepEqual(ds.byClass.subagentChildStale, ['sc1'], 'child 按龄语义不变（D1①）');
  assert.deepEqual([...ds.engineSessionIds].sort(), ['sc1', 'sf1', 'sw1']);
  assert.equal(ds.olderThanDays, DEFAULT_OLDER_THAN_DAYS, '未传 --older-than 回落缺省 7 天');
});

test('缺省（非 --stale）存量全清语义回归锁定：白名单/特征类不加时间过滤，child 恒按龄', () => {
  const fx = buildStaleFixture();
  const ds = buildDeleteSet(identifyOptions(fx));
  assert.equal(ds.staleMode, false);
  assert.deepEqual(ds.byClass.whitelist, ['sw1', 'sw2', 'sw3', 'sx'], '新/恰等/null 行全入集（存量全清）');
  assert.deepEqual(ds.byClass.feature, ['sf1', 'sf2'], '特征类不受 1d「新鲜」影响');
  assert.deepEqual(ds.byClass.subagentChildStale, ['sc1'], 'child 恒按龄（sc2 1d 保留）');
  assert.deepEqual([...ds.engineSessionIds].sort(), ['sc1', 'sf1', 'sf2', 'sw1', 'sw2', 'sw3', 'sx']);
});

test('--stale 恰等 cutoff 边界：严格小于语义三类一致（olderThanDays=10 时 10d 行恰等不入集）', () => {
  const fx = buildStaleFixture();
  const ds = buildDeleteSet(identifyOptions(fx, { staleMode: true, olderThanDays: 10 }));
  assert.deepEqual([...ds.engineSessionIds].sort(), [], 'sw1/sf1/sc1（恰 10d）全不超龄 → 空删除集');
  const ds0 = buildDeleteSet(identifyOptions(fx, { staleMode: true, olderThanDays: 0 }));
  assert.deepEqual(ds0.byClass.whitelist, ['sw1', 'sw2', 'sw3'], '0d = 全部严格早于 now 入集；sx null 仍保守保留');
  assert.deepEqual(ds0.byClass.subagentChildStale, ['sc1', 'sc2']);
});

test('excludeConflicts 透传 staleMode（冲突剔除后的最终集档位字段不丢）', () => {
  const fx = buildStaleFixture();
  const ds = buildDeleteSet(identifyOptions(fx, { staleMode: true }));
  const conflicts = { available: true, members: [], automations: [], offPeak: [], conflictedSessionIds: new Set() };
  const { deleteSet: final } = excludeConflicts(ds, conflicts);
  assert.equal(final.staleMode, true);
  assert.deepEqual([...final.engineSessionIds].sort(), ['sc1', 'sf1', 'sw1']);
});

test('dry-run --stale：报告透出 staleMode + 渲染档位行（缺省形态不输出档位行）', () => {
  const fx = buildStaleFixture();
  const staleReport = collectDryRun(identifyOptions(fx, { staleMode: true }));
  assert.equal(staleReport.staleMode, true);
  const stale = renderDryRun(staleReport);
  assert.match(stale.text, /档位：--stale 周期维护（--older-than 7 天）——三类识别统一/);
  assert.match(stale.text, /文件面档位不跟随（log 保留 14 天 \/ exec 空壳 7 天）/);
  const plainReport = collectDryRun(identifyOptions(fx));
  assert.equal(plainReport.staleMode, false);
  assert.equal(/档位：--stale/.test(renderDryRun(plainReport).text), false, '缺省样张逐字保持');
});

// ------------------------------------------------- 污染哨兵

test('污染哨兵：零交集 ok；交集命中 ok:false 且 intersection 正确', () => {
  const fx = buildMainFixture();
  const ds = buildDeleteSet(identifyOptions(fx));
  assert.deepEqual(checkSentinel(ds, fx.records), { ok: true, intersection: [] },
    '主 fixture 的 targetSessionId（w5）不在删除集');
  // 命中形态：白名单会话 w1 同时以 targetSessionId 出现（嵌套合法重叠的 fixture 化）
  const p2 = writeRecords([
    JSON.stringify({ sessionId: 'w1', targetSessionId: 'w1' }),
    JSON.stringify({ exec: { sessionId: 'w6' } }),
  ]);
  const hit = checkSentinel(ds, p2);
  assert.equal(hit.ok, false);
  assert.deepEqual(hit.intersection, ['w1']);
});

test('哨兵不依赖 DB：纯 Set 入参 + records 文件即可判定（u3 执行前复断言同用）', () => {
  const p = writeRecords([JSON.stringify({ targetSessionId: 'host_x' })]);
  assert.deepEqual(checkSentinel(new Set(['sess_a', 'host_x']), p), { ok: false, intersection: ['host_x'] });
  assert.deepEqual(checkSentinel(new Set(['sess_a']), p), { ok: true, intersection: [] });
  assert.deepEqual([...parseRecordTargetSessionIds(p)], ['host_x']);
  assert.equal(parseRecordTargetSessionIds(path.join(TMP, 'no-such.jsonl')).size, 0, 'records 不存在 → 空值域，哨兵恒过');
});

// ------------------------------------------------- 索引冲突预检与剔除

test('冲突预检：members/automations/off_peak 三源命中清单（session_id + tasks 反向关联）', () => {
  const fx = buildConflictFixture();
  const ds = buildDeleteSet(identifyOptions(fx));
  assert.deepEqual([...ds.engineSessionIds].sort(), ['c1', 'c2', 'c3', 'c4', 'c5'], 'c9 普通会话不入集');
  const conflicts = checkIndexConflicts(ds.engineSessionIds, fx.indexDbPath);
  assert.equal(conflicts.available, true);
  assert.deepEqual(conflicts.members, [{ sessionId: 'c1', groupId: 'g1' }], 'g2→cx 不命中（cx 不在删除集）');
  assert.deepEqual(conflicts.automations, [{ sessionId: 'c2', automationId: 'a1' }], 'a2→null 不命中');
  assert.deepEqual(
    conflicts.offPeak.map((o) => [o.sessionId, o.via]),
    [['c3', 'off_peak_tasks.session_id'], ['c4', 'tasks.off_peak_task_id']],
    'op8.session_id=zz 不命中；c4 经 tasks.off_peak_task_id 反向关联命中',
  );
  assert.deepEqual([...conflicts.conflictedSessionIds].sort(), ['c1', 'c2', 'c3', 'c4']);
});

test('excludeConflicts：双库删除集同步收缩 + 被剔除项逐条列出；入参不被修改', () => {
  const fx = buildConflictFixture();
  const ds = buildDeleteSet(identifyOptions(fx));
  const conflicts = checkIndexConflicts(ds.engineSessionIds, fx.indexDbPath);
  const { deleteSet: final, removed } = excludeConflicts(ds, conflicts);
  assert.deepEqual([...final.engineSessionIds].sort(), ['c5'], '冲突会话从引擎侧整体剔除');
  assert.deepEqual([...final.indexTaskIds].sort(), ['c5'], 'index 侧同步收缩（双侧一致）');
  assert.deepEqual(final.byClass.whitelist, ['c5']);
  assert.deepEqual(final.byClass.feature, []);
  assert.deepEqual([...final.interactiveClassIds].sort(), ['c5']);
  assert.deepEqual(removed.map((r) => r.id).sort(), ['c1', 'c2', 'c3', 'c4'], '被剔除项逐条列出');
  const byId = Object.fromEntries(removed.map((r) => [r.id, r]));
  assert.match(byId.c1.source, /members/);
  assert.match(byId.c2.source, /automations/);
  assert.match(byId.c3.source, /off_peak/);
  assert.match(byId.c4.source, /off_peak/);
  assert.match(byId.c4.detail, /op8/, 'detail 含来源明细（反向关联的 off_peak_task_id）');
  assert.equal(ds.engineSessionIds.size, 5, '纯函数：入参删除集不被修改');
});

// ------------------------------------------------- 目录分布红灯

test('红灯：全 workspace 不触发；subagent_child 的临时目录不入口径', () => {
  const dir = u2Dir();
  const engineDbPath = path.join(dir, 'db.sqlite');
  createU2EngineDb(engineDbPath, [
    ['b1', '/Users/u/p1', 'interactive', NOW],
    ['b2', '/Users/u/ws/zsub-e2e-abc/proj', 'interactive', NOW],
    ['b3', '/tmp/agent-shell', 'subagent_child', NOW - 10 * DAY],
  ]);
  const records = writeRecords([JSON.stringify({ sessionId: 'b1' })]);
  const ds = buildDeleteSet({ engineDbPath, recordsPath: records, now: NOW });
  assert.deepEqual([...ds.engineSessionIds].sort(), ['b1', 'b2', 'b3']);
  const db = new DatabaseSync(engineDbPath, { readOnly: true });
  try {
    assert.deepEqual(checkRedLight(ds, db),
      { workspaceN: 2, tmpN: 0, ratio: 0, outsideFeatureHits: 0, triggered: false },
      'b3（subagent_child，临时目录）不入红灯口径——纳入只会稀释红灯（设计 §3.1 样张口径）');
  } finally {
    db.close();
  }
});

test('红灯：临时类占比 >30% 触发（outsideFeatureHits=0 也可触发）', () => {
  const dir = u2Dir();
  const engineDbPath = path.join(dir, 'db.sqlite');
  createU2EngineDb(engineDbPath, [
    ['d1', '/Users/u/p1', 'interactive', NOW],
    ['d2', '/Users/u/p2', 'interactive', NOW],
    ['d3', '/tmp/x/zsub-e2e-d/proj', 'interactive', NOW],
  ]);
  const records = writeRecords([
    JSON.stringify({ sessionId: 'd1' }),
    JSON.stringify({ sessionId: 'd2' }),
    JSON.stringify({ sessionId: 'd3' }),
  ]);
  const ds = buildDeleteSet({ engineDbPath, recordsPath: records, now: NOW });
  const db = new DatabaseSync(engineDbPath, { readOnly: true });
  try {
    const rl = checkRedLight(ds, db);
    assert.equal(rl.workspaceN, 2);
    assert.equal(rl.tmpN, 1);
    assert.ok(Math.abs(rl.ratio - 1 / 3) < 1e-9);
    assert.equal(rl.outsideFeatureHits, 0, 'd3 命中特征表（zsub-e2e- 段）——占比超阈值单独触发');
    assert.equal(rl.triggered, true);
  } finally {
    db.close();
  }
});

test('红灯：白名单会话落在特征表外临时目录 → outsideFeatureHits>0（主 fixture 形态）', () => {
  const fx = buildMainFixture();
  const ds = buildDeleteSet(identifyOptions(fx));
  const db = new DatabaseSync(fx.engineDbPath, { readOnly: true });
  try {
    const rl = checkRedLight(ds, db);
    assert.equal(rl.workspaceN, 1);
    assert.equal(rl.tmpN, 2, 'w2（特征目录）+ w6（非特征临时目录）');
    assert.ok(Math.abs(rl.ratio - 2 / 3) < 1e-9);
    assert.equal(rl.outsideFeatureHits, 1, 'w6：白名单∩库 + OS 临时目录 + 不匹配特征表');
    assert.equal(rl.triggered, true);
  } finally {
    db.close();
  }
});

// ------------------------------------------------- input_history 命中计数

test('input_history 命中计数：删除集∩行数；不在集与 null 不计', () => {
  const fx = buildMainFixture();
  const ds = buildDeleteSet(identifyOptions(fx));
  const db = new DatabaseSync(fx.engineDbPath, { readOnly: true });
  try {
    assert.equal(countInputHistoryHits(ds.engineSessionIds, db), 2,
      'h1(w1)+h2(w3) 命中；h3(w5 不在删除集) 与 h4(null) 不计');
  } finally {
    db.close();
  }
});

// ------------------------------------------------- dry-run 组装与渲染

test('collectDryRun + renderDryRun：样张关键行齐备 + exitCode 0（哨兵 ok）', () => {
  const fx = buildMainFixture();
  const report = collectDryRun(identifyOptions(fx));
  assert.equal(report.sentinel.ok, true);
  assert.deepEqual(report.deleteSet.engineSessionIds, ['w1', 'w2', 'w3', 'w6']);
  assert.deepEqual(report.deleteSet.byClass.whitelist, ['w1', 'w6']);
  assert.equal(report.inputHistoryHits, 2);
  assert.equal(report.estimate.deleteSetSize, 4);
  assert.deepEqual(report.conflicts.conflictedSessionIds, []);
  assert.deepEqual(report.deleteSet.removedByConflict, []);
  const { text, exitCode } = renderDryRun(report);
  assert.equal(exitCode, 0);
  assert.match(text, /将删除（不写库）：/);
  assert.match(text, /2（白名单∩库）\+ 1（特征目录类）\+ 1（超龄 subagent_child）行/);
  assert.match(text, /按 FK 列级联（8 张 CASCADE 表 \+ part 经 message 间接级联 \+ session_task_link\.child）/);
  assert.match(text, /input_history 命中 2 行随删/);
  assert.match(text, /污染哨兵：删除集 ∩ targetSessionId 值域 = 0/);
  assert.match(text, /workspace 类 1 \/ 临时类（特征目录）2/);
  assert.match(text, /人工审红灯（机械阈值）/);
  assert.match(text, /红灯触发/, '主 fixture triggered：临时类占比 66.7% + 特征表外 1 处');
  assert.match(text, /GUI 索引 tasks 4 行/);
  assert.match(text, /当前无姊妹表冲突；冲突机制保留为安全网/);
  assert.match(text, /artifacts 2 目录/);
  assert.match(text, /预估回收 ~/);
  assert.match(text, /👉 确认执行：退出 ZCode 后跑 zsw doctor clean/);
});

test('renderDryRun：冲突剔除形态——GUI 索引行列出被剔除项并保留安全网说明', () => {
  const fx = buildConflictFixture();
  const report = collectDryRun(identifyOptions(fx));
  assert.deepEqual(report.deleteSet.engineSessionIds, ['c5']);
  assert.equal(report.deleteSet.removedByConflict.length, 4);
  const { text, exitCode } = renderDryRun(report);
  assert.equal(exitCode, 0);
  assert.match(text, /冲突会话 4 个已从双库删除集整体剔除/);
  assert.match(text, /c1\[members\]/);
  assert.match(text, /c2\[automations\]/);
  assert.match(text, /冲突机制保留为安全网/);
  assert.match(text, /GUI 索引 tasks 1 行/);
});

test('renderDryRun：哨兵失败 → exitCode 1 + 失败样例文案（中性归因）+ 无确认执行行', () => {
  const fx = buildMainFixture();
  const hitRecords = writeRecords([
    JSON.stringify({ sessionId: 'w1', targetSessionId: 'w1' }),
    JSON.stringify({ exec: { sessionId: 'w6' } }),
  ]);
  const report = collectDryRun(identifyOptions(fx, { recordsPath: hitRecords }));
  assert.equal(report.sentinel.ok, false);
  assert.deepEqual(report.sentinel.intersection, ['w1']);
  const { text, exitCode } = renderDryRun(report);
  assert.equal(exitCode, 1);
  assert.match(text, /✗ 污染哨兵失败：删除集 ∩ targetSessionId 值域 = 1（w1）/);
  assert.match(text, /命中可能是识别器污染（C6-被否：targetSessionId 是 zsw 调用方宿主会话=用户真实会话）/);
  assert.match(text, /嵌套调用的合法重叠/);
  assert.match(text, /中止不改库/);
  assert.match(text, /逐条核查命中会话的 directory\/标题后，把 dry-run 清单交维护者判定/);
  assert.equal(/👉 确认执行/.test(text), false, '哨兵失败不得输出确认执行指引（醒目阻断）');
});

test('dry-run --json 通道：collectDryRun 报告 JSON 序列化往返可解析', () => {
  const fx = buildMainFixture();
  const report = collectDryRun(identifyOptions(fx));
  const parsed = JSON.parse(JSON.stringify(report));
  assert.deepEqual(parsed.deleteSet.engineSessionIds, ['w1', 'w2', 'w3', 'w6']);
  assert.deepEqual(parsed.deleteSet.indexTaskIds, ['w1', 'w2', 'w3', 'w6']);
  assert.equal(parsed.sentinel.ok, true);
  assert.equal(parsed.redlight.triggered, true);
  assert.equal(parsed.redlight.outsideFeatureHits, 1);
  assert.equal(parsed.inputHistoryHits, 2);
  assert.equal(parsed.conflicts.available, true);
  assert.equal(parsed.olderThanDays, 7);
  assert.ok(parsed.estimate.estimatedBytes >= 0);
  assert.ok(parsed.files.artifacts.available);
});
