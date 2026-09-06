'use strict';

/**
 * lib/clean-fs.test.js（u4）：文件面清理 plan/execute 两段单测。
 *
 * fixture 原则延续 test/clean-identify.test.js：mkdtemp 临时目录树 + utimesSync
 * 固定 mtime（超龄/新鲜判定断言不随时钟漂移）+ after 整树清理。plan 用例全部
 * 只读断言；execute 只在 fixture 上删除；真实 ~/.zcode 零触碰。
 *
 * 口径锁定（跨模块防漂移）：doctor.collect 与 planFileCleanup 对同一 fixture 的
 * files 面计数一致——目录计数（artifacts 全量 / exec 只数 sess_ 前缀）、超龄
 * 定义（mtime 严格早于，恰等于不算）、递归体积合计。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// zsw 数据根钉到 fixture（doctor collect 的 recordsPath()/zswRoot() 缺省值随之
// 落在临时目录；node --test 文件形态每文件独立进程，不外溢其他测试文件）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-clean-fs-test-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsw-root');

const {
  planFileCleanup,
  executeFileCleanup,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_EXEC_STALE_DAYS,
} = require('../lib/clean-fs');
const { collect, LOG_RETENTION_MS } = require('../lib/doctor');

/** 不可删项用例造 chmod 000 目录：after 清理前恢复权限，防 rmSync 失败。 */
const RESTORE_PERM_PATHS = [];
after(() => {
  for (const p of RESTORE_PERM_PATHS) {
    try { fs.chmodSync(p, 0o755); } catch { /* 已不存在则忽略 */ }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function setMtime(p, ms) {
  const d = new Date(ms);
  fs.utimesSync(p, d, d);
}

let seq = 0;
function nextDir() {
  const dir = path.join(TMP, `t${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 主 fixture 会话/目录矩阵（plan 只读用例的权威口径；ENGINE_IDS 与目录名对应）：
//   artifacts/  sess_aaa(∈集, 100B) / sess_bbb(∈集, 空) / sess_ccc(∉集, 50B) / realdir(∉集)
//   exec/       sess_in1(∈集, 70B, 新鲜——集内不判龄不判空)
//               sess_empty_old(∉集, 空, 老) / sess_nested_old(∉集, 仅空子目录, 老)
//               sess_file_old(∉集, 含 30B, 老——非空壳) / sess_fresh_empty(∉集, 空, 新——未超龄)
//               bash-startup(非前缀, 老, 引擎自有) / otherdir(非前缀, 老——超龄但非前缀)
//               inset_noprefix(∈集但无 sess_ 前缀, 老, 20B——三重理由叠加仍不动)
//   log/        old1.log(-20d, 400B) / old2.log(-14d-1ms, 10B) /
//               edge.log(恰 -14d——严格早于语义下不算超龄) / fresh.log(-1d)
const ENGINE_IDS = new Set(['sess_aaa', 'sess_bbb', 'sess_in1']);

function buildMainTree() {
  const dir = nextDir();
  const artifacts = path.join(dir, 'artifacts');
  const exec = path.join(dir, 'exec');
  const log = path.join(dir, 'log');
  for (const name of ['sess_aaa', 'sess_bbb', 'sess_ccc', 'realdir']) {
    fs.mkdirSync(path.join(artifacts, name), { recursive: true });
  }
  fs.writeFileSync(path.join(artifacts, 'sess_aaa', 'a1.txt'), 'x'.repeat(100));
  fs.writeFileSync(path.join(artifacts, 'sess_ccc', 'c1.txt'), 'x'.repeat(50));

  fs.mkdirSync(path.join(exec, 'sess_in1'), { recursive: true });
  fs.mkdirSync(path.join(exec, 'sess_empty_old'), { recursive: true });
  fs.mkdirSync(path.join(exec, 'sess_nested_old', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(exec, 'sess_file_old'), { recursive: true });
  fs.mkdirSync(path.join(exec, 'sess_fresh_empty'), { recursive: true });
  fs.mkdirSync(path.join(exec, 'bash-startup'), { recursive: true });
  fs.mkdirSync(path.join(exec, 'otherdir'), { recursive: true });
  fs.mkdirSync(path.join(exec, 'inset_noprefix'), { recursive: true });
  fs.writeFileSync(path.join(exec, 'sess_in1', 'x.txt'), 'x'.repeat(70));
  fs.writeFileSync(path.join(exec, 'sess_file_old', 'f.txt'), 'x'.repeat(30));
  fs.writeFileSync(path.join(exec, 'bash-startup', 'y.txt'), 'x'.repeat(10));
  fs.writeFileSync(path.join(exec, 'inset_noprefix', 'z.txt'), 'x'.repeat(20));

  fs.mkdirSync(log, { recursive: true });
  fs.writeFileSync(path.join(log, 'old1.log'), 'x'.repeat(400));
  fs.writeFileSync(path.join(log, 'old2.log'), 'x'.repeat(10));
  fs.writeFileSync(path.join(log, 'edge.log'), 'x'.repeat(5));
  fs.writeFileSync(path.join(log, 'fresh.log'), 'x'.repeat(5));

  // mtime 统一在内容就绪后设置（建子项会刷新父目录 mtime）
  const old = NOW - 20 * DAY;
  const fresh = NOW - 1 * DAY;
  setMtime(path.join(exec, 'sess_empty_old'), old);
  setMtime(path.join(exec, 'sess_nested_old'), old);
  setMtime(path.join(exec, 'sess_file_old'), old);
  setMtime(path.join(exec, 'bash-startup'), old);
  setMtime(path.join(exec, 'otherdir'), old);
  setMtime(path.join(exec, 'inset_noprefix'), old);
  setMtime(path.join(exec, 'sess_fresh_empty'), fresh);
  setMtime(path.join(exec, 'sess_in1'), fresh);
  setMtime(path.join(log, 'old1.log'), NOW - 20 * DAY);
  setMtime(path.join(log, 'old2.log'), NOW - 14 * DAY - 1);
  setMtime(path.join(log, 'edge.log'), NOW - 14 * DAY);
  setMtime(path.join(log, 'fresh.log'), fresh);
  return { dir, artifacts, exec, log };
}

function planOptions(tree, extra = {}) {
  return {
    engineSessionIds: ENGINE_IDS,
    artifactsDir: tree.artifacts,
    logDir: tree.log,
    execDir: tree.exec,
    now: NOW,
    ...extra,
  };
}

// ------------------------------------------------- plan：artifacts 面

test('plan artifacts：∈集命中 / ∉集不动；体积为递归字节合计（空目录 0）', () => {
  const tree = buildMainTree();
  const plan = planFileCleanup(planOptions(tree));
  assert.deepEqual(plan.artifacts.map((a) => a.name), ['sess_aaa', 'sess_bbb'],
    '清单只含删除集命中目录（精确 id 匹配）');
  assert.equal(plan.artifacts.find((a) => a.name === 'sess_aaa').bytes, 100);
  assert.equal(plan.artifacts.find((a) => a.name === 'sess_bbb').bytes, 0);
  assert.equal(plan.artifacts.some((a) => a.name === 'sess_ccc'), false, '∉集目录不入清单');
  assert.equal(plan.artifacts.some((a) => a.name === 'realdir'), false);
});

// ------------------------------------------------- plan：exec 面

test('plan exec：集内命中（不判龄不判空）/ 超龄空壳两形态 / 五类排除分支', () => {
  const tree = buildMainTree();
  const plan = planFileCleanup(planOptions(tree));
  assert.deepEqual(plan.execInSet.map((x) => x.name), ['sess_in1'],
    '集内命中：新鲜且含文件仍入清单（不判龄不判空）');
  assert.equal(plan.execInSet[0].bytes, 70, '集内目录按实际内容计字节');
  assert.deepEqual(plan.execStaleEmpty.map((x) => x.name),
    ['sess_empty_old', 'sess_nested_old'],
    '超龄空壳两形态：空目录与仅空子目录均入清单');
  assert.equal(plan.execStaleEmpty.every((x) => x.bytes === 0), true, '空壳按定义 0 字节');

  const excluded = ['sess_file_old', 'sess_fresh_empty', 'bash-startup', 'otherdir', 'inset_noprefix'];
  for (const list of [plan.execInSet, plan.execStaleEmpty]) {
    for (const name of excluded) {
      assert.equal(list.some((x) => x.name === name), false,
        `${name} 不应入任何 exec 清单（非空壳/未超龄/非 sess_ 前缀一律不动）`);
    }
  }
});

test('plan exec：sess_ 前缀是集内命中通道的前置——∈集但无前缀的超龄目录也不动（D7）', () => {
  // inset_noprefix：∈集 + 超龄 + 无 sess_ 前缀，三重条件下仍不删——
  // 锁定「exec 限 sess_ 前缀」对两个通道都生效（防引擎自有目录被 id 碰撞误删）
  const tree = buildMainTree();
  const plan = planFileCleanup(planOptions(tree));
  assert.equal(plan.execInSet.some((x) => x.name === 'inset_noprefix'), false);
  assert.equal(plan.execStaleEmpty.some((x) => x.name === 'inset_noprefix'), false);
});

// ------------------------------------------------- plan：log 面

test('plan log：只含超龄整文件；恰等于阈值不算超龄（严格早于）', () => {
  const tree = buildMainTree();
  const plan = planFileCleanup(planOptions(tree));
  assert.deepEqual(plan.logFiles.map((f) => f.name), ['old1.log', 'old2.log']);
  assert.deepEqual(plan.logFiles.map((f) => f.bytes), [400, 10]);
  assert.equal(plan.logFiles.some((f) => f.name === 'edge.log'), false,
    '恰等于 14d 阈值不算超龄（与 doctor 严格早于口径一致）');
  assert.equal(plan.logFiles.some((f) => f.name === 'fresh.log'), false);
});

test('plan log：retentionDays 参数化边界（0 = 全删 / 21 = 只删最老 / 30 = 空）', () => {
  const tree = buildMainTree();
  const p0 = planFileCleanup(planOptions(tree, { logRetentionDays: 0 }));
  assert.equal(p0.logFiles.length, 4, '保留 0 天：全部文件 mtime 早于 now → 全入清单');
  const p15 = planFileCleanup(planOptions(tree, { logRetentionDays: 15 }));
  assert.deepEqual(p15.logFiles.map((f) => f.name), ['old1.log'],
    '保留 15 天：20d 前的 old1 入清单，14d 前的 old2 在保留窗内');
  const p21 = planFileCleanup(planOptions(tree, { logRetentionDays: 21 }));
  assert.deepEqual(p21.logFiles, [], '保留 21 天：最老文件仅 20d，全在保留窗内');
  const p30 = planFileCleanup(planOptions(tree, { logRetentionDays: 30 }));
  assert.deepEqual(p30.logFiles, []);
});

// ------------------------------------------------- plan：汇总字段与入参校验

test('plan 汇总：totalReclaimableBytes = 四清单字节和；scannedAt = 注入 now 的 ISO', () => {
  const tree = buildMainTree();
  const plan = planFileCleanup(planOptions(tree));
  assert.equal(plan.totalReclaimableBytes, 100 + 70 + 400 + 10,
    'artifacts 100 + execInSet 70 + log 410（空壳 0）');
  assert.equal(plan.scannedAt, new Date(NOW).toISOString());
  assert.equal(DEFAULT_LOG_RETENTION_DAYS, 14, 'D7：log 默认保留 14 天');
  assert.equal(DEFAULT_EXEC_STALE_DAYS, 7, 'execStaleDays 默认 7（依据见 lib 头注）');
});

test('plan：空 engineSessionIds → artifacts/execInSet 为空，按龄/按前缀通道照常', () => {
  const tree = buildMainTree();
  const plan = planFileCleanup(planOptions(tree, { engineSessionIds: new Set() }));
  assert.deepEqual(plan.artifacts, []);
  assert.deepEqual(plan.execInSet, []);
  assert.deepEqual(plan.execStaleEmpty.map((x) => x.name),
    ['sess_empty_old', 'sess_nested_old'], '空壳通道不受删除集影响');
  assert.deepEqual(plan.logFiles.map((f) => f.name), ['old1.log', 'old2.log']);
});

test('plan：缺 engineSessionIds → 可操作错误；Array 形态可接受', () => {
  assert.throws(() => planFileCleanup({ artifactsDir: '/tmp/x' }), /engineSessionIds/,
    '缺失静默按空集会让两通道无声失效——删除链路禁静默');
  const tree = buildMainTree();
  const arr = planFileCleanup(planOptions(tree, { engineSessionIds: ['sess_aaa'] }));
  assert.deepEqual(arr.artifacts.map((a) => a.name), ['sess_aaa']);
});

test('plan：三面目录全不存在 → 各面空清单不 crash，合计 0', () => {
  const plan = planFileCleanup({
    engineSessionIds: ENGINE_IDS,
    artifactsDir: path.join(TMP, 'no-such-artifacts'),
    logDir: path.join(TMP, 'no-such-log'),
    execDir: path.join(TMP, 'no-such-exec'),
    now: NOW,
  });
  assert.deepEqual(plan.artifacts, []);
  assert.deepEqual(plan.execInSet, []);
  assert.deepEqual(plan.execStaleEmpty, []);
  assert.deepEqual(plan.logFiles, []);
  assert.equal(plan.totalReclaimableBytes, 0);
});

// ------------------------------------------------- execute：全成功形态

test('execute：plan 项全删（目录消失）、计数与字节如实、未命中项全保留、failures 空', () => {
  const tree = buildMainTree();
  const plan = planFileCleanup(planOptions(tree));
  const result = executeFileCleanup(plan, {
    artifactsDir: tree.artifacts, logDir: tree.log, execDir: tree.exec,
  });

  assert.equal(result.artifacts.deletedCount, 2);
  assert.equal(result.artifacts.deletedBytes, 100);
  assert.equal(result.exec.deletedCount, 3, 'execInSet 1 + execStaleEmpty 2');
  assert.equal(result.exec.deletedBytes, 70);
  assert.equal(result.log.deletedCount, 2);
  assert.equal(result.log.deletedBytes, 410);
  assert.equal(result.totalDeletedCount, 7);
  assert.equal(result.totalDeletedBytes, 100 + 70 + 410);
  assert.equal(result.totalFailureCount, 0);
  assert.deepEqual(result.artifacts.failures, []);
  assert.equal(typeof result.executedAt, 'string');

  // 已删项消失
  for (const p of [
    path.join(tree.artifacts, 'sess_aaa'),
    path.join(tree.artifacts, 'sess_bbb'),
    path.join(tree.exec, 'sess_in1'),
    path.join(tree.exec, 'sess_empty_old'),
    path.join(tree.exec, 'sess_nested_old'),
    path.join(tree.log, 'old1.log'),
    path.join(tree.log, 'old2.log'),
  ]) {
    assert.equal(fs.existsSync(p), false, `${p} 应已删除`);
  }
  // 未命中项全保留（含五类排除分支的 exec 目录与 edge/fresh 日志）
  for (const p of [
    path.join(tree.artifacts, 'sess_ccc'),
    path.join(tree.artifacts, 'realdir'),
    path.join(tree.exec, 'sess_file_old'),
    path.join(tree.exec, 'sess_fresh_empty'),
    path.join(tree.exec, 'bash-startup'),
    path.join(tree.exec, 'otherdir'),
    path.join(tree.exec, 'inset_noprefix'),
    path.join(tree.log, 'edge.log'),
    path.join(tree.log, 'fresh.log'),
  ]) {
    assert.equal(fs.existsSync(p), true, `${p} 不在 plan 内，必须保留`);
  }
});

// ------------------------------------------------- execute：失败项形态

test('execute：不可删项（chmod 000 目录）进 failures 不中断整批，汇总如实闭合', (t) => {
  if (process.getuid && process.getuid() === 0) {
    return t.skip('root 下 chmod 000 不构成删除屏障，用例仅对普通用户有意义');
  }
  const tree = buildMainTree();
  const readOnlyDir = path.join(tree.artifacts, 'sess_aaa');
  RESTORE_PERM_PATHS.push(readOnlyDir);
  fs.chmodSync(readOnlyDir, 0o000); // 删其内部文件需目录写权限 → rmSync 失败

  const plan = planFileCleanup(planOptions(tree));
  const result = executeFileCleanup(plan, {
    artifactsDir: tree.artifacts, logDir: tree.log, execDir: tree.exec,
  });

  assert.equal(result.artifacts.failures.length, 1, '仅 sess_aaa 失败');
  const f = result.artifacts.failures[0];
  assert.equal(f.name, 'sess_aaa');
  assert.equal(f.path, readOnlyDir, '失败项携带完整 path');
  assert.equal(['EACCES', 'EPERM'].includes(f.code), true, `errno/code 可操作（实际 code=${f.code}）`);
  assert.notEqual(f.errno, undefined);

  // 其余项照删
  assert.equal(result.artifacts.deletedCount, 1, 'sess_bbb 照删');
  assert.equal(fs.existsSync(path.join(tree.artifacts, 'sess_bbb')), false);
  assert.equal(result.exec.deletedCount, 3);
  assert.equal(result.log.deletedCount, 2);
  assert.equal(result.exec.failures.length, 0);
  assert.equal(result.log.failures.length, 0);

  // 字节汇总如实：失败项的 100B 不计入
  assert.equal(result.artifacts.deletedBytes, 0);
  assert.equal(result.totalDeletedBytes, 70 + 410);
  assert.equal(result.totalFailureCount, 1);

  // 闭合恒等式：planned = deletedCount + failures.length
  assert.equal(result.artifacts.planned, result.artifacts.deletedCount + result.artifacts.failures.length);
  assert.equal(result.exec.planned, result.exec.deletedCount + result.exec.failures.length);
  assert.equal(result.log.planned, result.log.deletedCount + result.log.failures.length);

  assert.equal(fs.existsSync(readOnlyDir), true, '失败项本体保留（恢复权限后由 after 清理）');
});

// ------------------------------------------------- execute：防逃逸与容错

test('execute：plan 项名越出根目录（../ 逃逸 / 绝对路径）拒删并进 failures', () => {
  const tree = buildMainTree();
  // 树外真实存在的诱饵目标：若实现有漏洞会被删掉
  const bait = path.join(tree.dir, 'escape-bait');
  fs.writeFileSync(bait, 'x');

  const plan = {
    artifacts: [{ name: '../escape-bait', bytes: 5 }, { name: bait, bytes: 5 }],
    execInSet: [],
    execStaleEmpty: [],
    logFiles: [{ name: path.join('..', 'escape-bait'), bytes: 5 }],
  };
  const result = executeFileCleanup(plan, {
    artifactsDir: tree.artifacts, logDir: tree.log, execDir: tree.exec,
  });

  assert.equal(result.totalDeletedCount, 0, '全部拒删');
  assert.equal(result.totalFailureCount, 3);
  for (const face of [result.artifacts, result.log]) {
    for (const item of face.failures) {
      assert.equal(item.code, 'EINVAL_PATH', '越界项 code 可操作');
    }
  }
  assert.equal(fs.existsSync(bait), true, '树外目标未被触碰');
});

test('execute：plan 缺面字段按空清单处理（planned 0，不 crash）', () => {
  const tree = buildMainTree();
  const result = executeFileCleanup({}, {
    artifactsDir: tree.artifacts, logDir: tree.log, execDir: tree.exec,
  });
  assert.equal(result.artifacts.planned, 0);
  assert.equal(result.exec.planned, 0);
  assert.equal(result.log.planned, 0);
  assert.equal(result.totalDeletedCount, 0);
});

// ------------------------------------------------- plan × doctor 口径一致性

/**
 * 全覆盖 fixture：三面全部可删项让 plan 清单 == doctor files 面计数——
 *   artifacts 所有目录 ∈ 集（dirCount == plan.artifacts.length）；
 *   exec 所有 sess_ 目录要么 ∈ 集要么超龄空壳（sessPrefixed == 两清单和；
 *   bash-startup 在场但不入比较口径）；
 *   log 全部文件超龄（olderThan14d == logFiles.length；edge 形态两侧同判）。
 */
function buildCoverageTree() {
  const dir = nextDir();
  const artifacts = path.join(dir, 'artifacts');
  const exec = path.join(dir, 'exec');
  const log = path.join(dir, 'log');
  fs.mkdirSync(path.join(artifacts, 'sess_x'), { recursive: true });
  fs.mkdirSync(path.join(artifacts, 'sess_y'), { recursive: true });
  fs.writeFileSync(path.join(artifacts, 'sess_x', 'a.txt'), 'x'.repeat(30));
  fs.mkdirSync(path.join(exec, 'sess_x'), { recursive: true });
  fs.writeFileSync(path.join(exec, 'sess_x', 's.txt'), 'x'.repeat(8));
  fs.mkdirSync(path.join(exec, 'sess_e_old'), { recursive: true });
  fs.mkdirSync(path.join(exec, 'bash-startup'), { recursive: true });
  fs.writeFileSync(path.join(exec, 'bash-startup', 'b.txt'), 'x'.repeat(5));
  fs.mkdirSync(log, { recursive: true });
  fs.writeFileSync(path.join(log, 'l1.log'), 'x'.repeat(11));
  fs.writeFileSync(path.join(log, 'l2.log'), 'x'.repeat(22));
  setMtime(path.join(exec, 'sess_e_old'), NOW - 30 * DAY);
  setMtime(path.join(log, 'l1.log'), NOW - 30 * DAY);
  setMtime(path.join(log, 'l2.log'), NOW - 15 * DAY);
  return { dir, artifacts, exec, log };
}

test('口径锁定：同 fixture 上 planFileCleanup 计数 == doctor collect files 面计数', () => {
  const tree = buildCoverageTree();
  const plan = planFileCleanup({
    engineSessionIds: new Set(['sess_x', 'sess_y']), // 全覆盖：artifacts 两目录都在集内
    artifactsDir: tree.artifacts,
    logDir: tree.log,
    execDir: tree.exec,
    now: NOW,
  });
  // doctor.collect 独立采集同一棵树（引擎/索引库缺文件 → 该面 n/a，files 面照采）
  const doc = collect({
    engineDbPath: path.join(tree.dir, 'no.sqlite'),
    indexDbPath: path.join(tree.dir, 'no-index.sqlite'),
    recordsPath: path.join(tree.dir, 'no-records.jsonl'),
    artifactsDir: tree.artifacts,
    logDir: tree.log,
    execDir: tree.exec,
    now: NOW,
  });

  assert.equal(doc.engine.available, false, 'fixture 无库：doctor 引擎面 n/a 不影响 files 面');
  assert.equal(doc.files.artifacts.dirCount, plan.artifacts.length,
    'artifacts：doctor 全量目录计数 == plan 命中清单（全覆盖形态）');
  assert.equal(doc.files.exec.sessPrefixed,
    plan.execInSet.length + plan.execStaleEmpty.length,
    'exec：doctor sess_ 前缀计数 == plan 两清单和（前缀口径锁定）');
  assert.equal(doc.files.log.olderThan14d, plan.logFiles.length,
    'log：超龄定义（mtime 严格早于 14d）两侧一致');
  assert.equal(doc.files.log.fileCount, plan.logFiles.length,
    '全覆盖形态：log 总文件数 == 超龄数 == plan 清单');
  assert.equal(LOG_RETENTION_MS, DEFAULT_LOG_RETENTION_DAYS * DAY,
    '默认保留期同源：doctor.LOG_RETENTION_MS == clean-fs 默认 14 天');
});
