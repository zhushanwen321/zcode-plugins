'use strict';
/**
 * zsw doctor 只读体检（u1 交付；u2 将在本文件扩展 dry-run 渲染入口）。
 *
 * 五面只读采集（设计 §2.1 写入面 / §3.1 报告样张 / 实施计划 u1）：
 *   面① 引擎库 ~/.zcode/cli/db/db.sqlite（node:sqlite readOnly）
 *   面② GUI 索引库 ~/.zcode/v2/tasks-index.sqlite（readOnly；真机可能无此文件）
 *   面③④⑤ 文件面 artifacts/ log/ exec/
 * 全部路径参数可注入（测试传 fixture；缺省值按 lib/config.js 约定 + os.homedir()
 * 下 ~/.zcode 约定——config.js 未约定引擎侧路径，此处组装处均注释来源）。
 *
 * 红线：本模块对真实 ~/.zcode 只读（DatabaseSync readOnly / fs 只读 API），
 * 任何写删属 lib/clean-exec.js（u3）领地。
 *
 * node:sqlite 运行时检测：collect 内 lazy require，不可用时抛
 * code=NODE_SQLITE_UNAVAILABLE 的可操作错误（不 crash、无堆栈转储），由 CLI
 * 面 stderr 输出并 exit 1（需 Node ≥22.5，建议 24）。
 *
 * 容错口径：单面失败（缺库/缺表/缺目录）该面 n/a，不拖垮整体报告；
 * 缺表计 undefined（报告渲染 n/a）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseRecordWhiteList, matchFeatureDirectory } = require('./clean-identify');
const { recordsPath, zswRoot } = require('./config');

/** subagent_child 默认只清 time_created 早于 7 天的（设计 §3.3 D1①）。 */
const SUBAGENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** log 按文件年龄整文件删，默认保留 14 天（设计 §3.3 D7）。 */
const LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * 引擎库 13 张 session 引用表（设计 §2.1 面①，sqlite_master 穷举 + FK 列粒度）：
 * 8 张直接 CASCADE 表 + part（经 message 间接级联，非 session 直接 FK）+
 * session_task_link（child/parent 双列混合）+ workflow_run / workflow_activity
 * （SET NULL 列所在表）+ input_history（无 FK，删除集命中行随删并计数）。
 * u1 只做逐表行数（量级观测）；级联删除口径是 u3 执行器领地。
 */
const REF_TABLES = Object.freeze([
  'message', 'todo', 'session_entry', 'session_input', 'session_target',
  'model_usage', 'turn_usage', 'tool_usage', 'session_task_link',
  'workflow_run', 'workflow_activity', 'part', 'input_history',
]);

/** node:sqlite 运行时检测（探针实证 Node v24.11.1 可用；engines >=20 声明不变，
 *  双保险 = README 显式声明 + 此处运行时报可操作错误）。 */
function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch (e) {
    const err = new Error(
      `node:sqlite 不可用（${e && e.message || e}）。doctor/clean 需要 Node ≥22.5（建议 24），`
      + `当前 ${process.version}。恢复指引：升级 Node 后重跑 node bin/zsw.js doctor。`,
    );
    err.code = 'NODE_SQLITE_UNAVAILABLE';
    throw err;
  }
}

/** 引擎侧 ~/.zcode/cli 根（设计 §2.1 面①③④⑤；config.js 未约定引擎侧路径，
 *  os.homedir() 组装；HOME 覆写场景（测试）经 options 注入，不走此缺省）。 */
function engineCliRoot() {
  return path.join(os.homedir(), '.zcode', 'cli');
}

/** 三件套体积合计：db.sqlite / -wal / -shm（WAL 库伴生文件一并计量，设计 C3）。 */
function dbTripleBytes(dbPath) {
  return ['main', 'main-wal', 'main-shm'].reduce((sum, suffix) => {
    return sum + statSizeSafe(suffix === 'main' ? dbPath : dbPath + suffix.slice(4));
  }, 0);
}

function statSizeSafe(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0; // -wal/-shm 不恒在（正常关闭后自动清理）；缺即按 0 计
  }
}

/** 递归文件体积合计（只读；readdir/stat 竞态与权限错误跳过——体检不为
 *  个别不可读文件 crash）。 */
function treeBytes(root) {
  let bytes = 0;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) {
        try {
          bytes += fs.statSync(p).size;
        } catch { /* 文件被并发删改：跳过 */ }
      }
    }
  }
  return bytes;
}

/** 顶层子目录清单（目录不存在 → null，调用面标 n/a）。 */
function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return null;
  }
}

/** 递归文件清单（目录不存在 → null）。 */
function listFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      if (cur === dir) return null;
      continue;
    }
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) out.push(p);
    }
  }
  return out;
}

/** 上次清理备份目录（设计 §3.1「备份状态」行；u3 才会写入，此处只读探测）。 */
function latestBackupName() {
  const dir = path.join(zswRoot(), 'maintenance');
  const names = listDirs(dir);
  if (!names) return null;
  const backups = names.filter((n) => n.startsWith('backup-')).sort();
  return backups.length ? backups[backups.length - 1] : null;
}

/**
 * 面①引擎库采集。返回 { report, coarseDeleteSet }；report.available 恒 true
 * （打不开的分支在 collect 处理）。session 全量拉 id/directory/task_type/
 * time_created 四列内存聚合（万行级，doctor 手动低频可接受）——白名单∩库与
 * 特征目录类都是行级谓词，SQL 无法表达「路径段匹配」语义
 * （matchFeatureDirectory），统一内存过滤保口径单一。
 */
function collectEngine(db, options) {
  const { now, whiteList, engineDbPath } = options;
  const report = { available: true, dbPath: engineDbPath };

  report.sessionTotal = db.prepare('SELECT COUNT(*) AS n FROM session').get().n;
  report.taskTypeDistribution = {};
  for (const row of db.prepare('SELECT task_type AS t, COUNT(*) AS n FROM session GROUP BY task_type').all()) {
    report.taskTypeDistribution[row.t === null ? '(null)' : row.t] = row.n;
  }

  // 白名单双口径（C6：总数 ≠ ∩库，分离计数）
  const ids = new Set();
  const featureIds = new Set();
  const subagentIds = new Set();
  let subagentOlderThan7d = 0;
  const cutoff = now - SUBAGENT_MAX_AGE_MS;
  for (const row of db.prepare('SELECT id, directory, task_type, time_created FROM session').all()) {
    ids.add(row.id);
    if (matchFeatureDirectory(row.directory)) featureIds.add(row.id);
    if (row.task_type === 'subagent_child') {
      subagentIds.add(row.id);
      if (typeof row.time_created === 'number' && row.time_created < cutoff) subagentOlderThan7d++;
    }
  }
  report.whiteListTotal = whiteList.size;
  report.whiteListInDb = [...whiteList].filter((id) => ids.has(id)).length;
  report.featureDirectoryCount = featureIds.size;
  report.subagentChild = { total: subagentIds.size, olderThan7d: subagentOlderThan7d };

  // 13 表逐表行数（缺表 → undefined，报告渲染 n/a；fixture/未来 schema 变化不 crash）
  report.refTables = {};
  for (const t of REF_TABLES) {
    try {
      report.refTables[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    } catch {
      report.refTables[t] = undefined;
    }
  }

  report.dbBytes = {
    total: dbTripleBytes(engineDbPath),
    main: statSizeSafe(engineDbPath),
    wal: statSizeSafe(engineDbPath + '-wal'),
    shm: statSizeSafe(engineDbPath + '-shm'),
  };

  // 删除集粗口径（doctor 只报数；正式删除集 = u2 分治 + 哨兵 + 冲突预检的领地）
  const coarseDeleteSet = new Set([...whiteList].filter((id) => ids.has(id)));
  for (const id of featureIds) coarseDeleteSet.add(id);
  for (const id of subagentIds) coarseDeleteSet.add(id);
  report.coarseDeleteSetSize = coarseDeleteSet.size;
  return { report, coarseDeleteSet };
}

/**
 * 面②索引库采集。删除集粗口径命中按 tasks.task_id（值 = 引擎 session id，
 * 探针实证；tasks 无 session_id 列）。库不存在整面 n/a（真机可能无此文件）。
 */
function collectIndex(dbPath, coarseDeleteSet) {
  const report = { available: false, dbPath };
  let fileOk = false;
  try {
    fileOk = fs.existsSync(dbPath);
  } catch {
    fileOk = false;
  }
  if (!fileOk) return report;
  const { DatabaseSync } = loadSqlite();
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return report; // 打不开（损坏/权限）→ 整面 n/a，不 crash
  }
  try {
    report.available = true;
    const taskIds = new Set(db.prepare('SELECT task_id FROM tasks').all().map((r) => r.task_id));
    report.tasksTotal = taskIds.size;
    report.tasksHit = [...coarseDeleteSet].filter((id) => taskIds.has(id)).length;
    // 姊妹表只读计数（无对 tasks 的 FK——正式联动删除是 u3 领地，此处只报数）
    report.sisterTables = {
      taskGroupMembers: countSafe(db, 'task_group_members'),
      automationsWithTarget: countSafe(db, 'automations', 'target_task_id IS NOT NULL'),
      offPeakTasks: countSafe(db, 'off_peak_tasks'),
    };
  } finally {
    db.close();
  }
  return report;
}

/** 计数查询容错：缺表/表达式不合法 → undefined（n/a），不 crash。 */
function countSafe(db, table, where) {
  try {
    const sql = `SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`;
    return db.prepare(sql).get().n;
  } catch {
    return undefined;
  }
}

/** 面③④⑤文件面采集（目录不存在该面 n/a）。 */
function collectFiles(artifactsDir, logDir, execDir, now) {
  const report = {};

  const artDirs = listDirs(artifactsDir); // 目录名 = session id（设计 §2.1 面③）
  report.artifacts = artDirs === null
    ? { available: false }
    : { available: true, dirCount: artDirs.length, bytes: treeBytes(artifactsDir) };

  const logFiles = listFiles(logDir); // 日文件无轮转（设计 §2.1 面④），按文件年龄整文件口径
  if (logFiles === null) {
    report.log = { available: false };
  } else {
    const cutoff = now - LOG_RETENTION_MS;
    let bytes = 0;
    let olderThan14d = 0;
    for (const f of logFiles) {
      let st;
      try {
        st = fs.statSync(f);
      } catch {
        continue;
      }
      bytes += st.size;
      if (st.mtimeMs < cutoff) olderThan14d++;
    }
    report.log = { available: true, fileCount: logFiles.length, bytes, olderThan14d };
  }

  const execDirs = listDirs(execDir); // sess_ 前缀 = 会话空壳；bash-startup 等引擎自有目录排除在命中口径外（D7）
  if (execDirs === null) {
    report.exec = { available: false };
  } else {
    report.exec = {
      available: true,
      dirCount: execDirs.length,
      sessPrefixed: execDirs.filter((n) => n.startsWith('sess_')).length,
      bytes: treeBytes(execDir),
    };
  }
  return report;
}

/**
 * 五面只读采集，返回结构化报告对象（renderJson 的直接输出面）。
 * @param {object} [options] 全部可注入（测试传 fixture 路径）：
 *   engineDbPath / indexDbPath / recordsPath / artifactsDir / logDir / execDir /
 *   now（时间基准 ms，超龄判定用；缺省 Date.now()）
 */
function collect(options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const engineDbPath = options.engineDbPath
    || path.join(engineCliRoot(), 'db', 'db.sqlite');
  const indexDbPath = options.indexDbPath
    || path.join(os.homedir(), '.zcode', 'v2', 'tasks-index.sqlite');
  const records = options.recordsPath || recordsPath();
  const artifactsDir = options.artifactsDir || path.join(engineCliRoot(), 'artifacts');
  const logDir = options.logDir || path.join(engineCliRoot(), 'log');
  const execDir = options.execDir || path.join(engineCliRoot(), 'exec');

  const { DatabaseSync } = loadSqlite(); // node:sqlite 不可用 → 可操作错误（见 loadSqlite）

  const whiteList = parseRecordWhiteList(records);

  const report = {
    generatedAt: new Date(now).toISOString(),
    now,
    paths: { engineDbPath, indexDbPath, recordsPath: records, artifactsDir, logDir, execDir },
  };

  // 面①：引擎库（打不开 → available=false，白名单总数仍可得——records 独立于库）
  let engine = { available: false, dbPath: engineDbPath };
  let coarseDeleteSet = new Set();
  let dbBytesTotal = 0;
  try {
    const db = new DatabaseSync(engineDbPath, { readOnly: true });
    try {
      const collected = collectEngine(db, { now, whiteList, engineDbPath });
      engine = collected.report;
      coarseDeleteSet = collected.coarseDeleteSet;
      dbBytesTotal = engine.dbBytes ? engine.dbBytes.total : 0;
    } finally {
      db.close();
    }
  } catch (e) {
    if (e && e.code === 'NODE_SQLITE_UNAVAILABLE') throw e;
    engine = { available: false, dbPath: engineDbPath, error: String(e && e.message || e) };
    engine.whiteListTotal = whiteList.size;
  }
  report.engine = engine;

  // 面②：索引库（依赖删除集粗口径；引擎库 n/a 时命中无从谈起 → 直接 n/a 面）
  if (engine.available) {
    report.index = collectIndex(indexDbPath, coarseDeleteSet);
  } else {
    report.index = { available: false, dbPath: indexDbPath };
  }

  // 面③④⑤：文件面
  report.files = collectFiles(artifactsDir, logDir, execDir, now);

  // 预估回收（计划偏差 3）：删除集粗口径占比 × 库三件套体积；标注估算性质——
  // 设计 §3.1 的 3.7-4.2GB 无公式定义，不引入无依据的精确假象，真实以执行后 du 为准
  const sessionTotal = engine.available ? engine.sessionTotal : undefined;
  const deleteSetSize = engine.available ? engine.coarseDeleteSetSize : undefined;
  const ratio = sessionTotal ? deleteSetSize / sessionTotal : 0;
  report.estimate = {
    deleteSetSize,
    sessionTotal,
    ratio,
    dbBytes: dbBytesTotal,
    estimatedBytes: Math.round(ratio * dbBytesTotal),
    note: '粗估，真实以执行后 du 为准',
  };

  report.backup = { latest: latestBackupName() };
  return report;
}

/** 千分位（样张 6,425 形态）。 */
function fmtCount(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : 'n/a';
}

/** 体积人读（GB 口径 = 1000 进制，与设计 §2.1 实测数字同口径：6,729,084,928B → 6.7GB）。 */
function fmtBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)}${units[i]}`;
}

function na(available, text) {
  return available ? text : 'n/a';
}

/** 本地日期（人读标题用；toISOString 是 UTC，本地时区晚于 UTC 时日期会差一天）。 */
function localDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 人读文本渲染（stdout 通道）。行结构以设计 §3.1 第一个代码块为权威样张；
 * 引用表行数为 A-6 核对面（样张省略），以紧凑行补入。
 */
function renderText(report) {
  const e = report.engine;
  const f = report.files;
  const est = report.estimate;
  const lines = [];
  lines.push(`zsw 会话残留体检（${localDate(report.now)}，实时查询）`);

  lines.push(na(e.available, [
    `  引擎库会话行    白名单∩库 ${fmtCount(e.whiteListInDb)} 个（白名单总数 ${fmtCount(e.whiteListTotal)}）`
    + ` / 特征目录类 ${fmtCount(e.featureDirectoryCount)} 个 /`,
    `                  subagent_child ${fmtCount(e.subagentChild && e.subagentChild.total)} 个`
    + `（其中 >7 天 ${fmtCount(e.subagentChild && e.subagentChild.olderThan7d)}）`,
  ].join('\n')));

  if (e.available) {
    const rt = e.refTables || {};
    const half = Math.ceil(REF_TABLES.length / 2);
    const fmt = (t) => `${t} ${fmtCount(rt[t])}`;
    lines.push(`  引擎库引用表    ${REF_TABLES.slice(0, half).map(fmt).join(' / ')}`);
    lines.push(`                  ${REF_TABLES.slice(half).map(fmt).join(' / ')}`);
  } else {
    lines.push('  引擎库引用表    n/a');
  }

  const estLine = e.available
    ? `  引擎库体积      ${fmtBytes(e.dbBytes.total)}（预估库内可回收 ~${fmtBytes(est.estimatedBytes)}`
      + ` = 删除集粗口径 ${fmtCount(est.deleteSetSize)}/${fmtCount(est.sessionTotal)} × 库体积；${est.note}）`
    : `  引擎库体积      n/a（库不可读：${e.error || '文件不存在'}）`;
  lines.push(estLine);

  const idx = report.index;
  lines.push(na(idx.available, `  GUI 索引行      tasks 总数 ${fmtCount(idx.tasksTotal)} / 粗口径命中 ${fmtCount(idx.tasksHit)} 行；`
    + `姊妹表：members ${fmtCount(idx.sisterTables && idx.sisterTables.taskGroupMembers)} /`
    + ` automations ${fmtCount(idx.sisterTables && idx.sisterTables.automationsWithTarget)}（target 非空）`
    + ` / off_peak ${fmtCount(idx.sisterTables && idx.sisterTables.offPeakTasks)}`));

  lines.push(na(f.artifacts && f.artifacts.available,
    `  artifacts/      ${fmtCount(f.artifacts && f.artifacts.dirCount)} 个会话目录（~${fmtBytes(f.artifacts && f.artifacts.bytes)}）`));

  lines.push(na(f.log && f.log.available,
    `  log/            超 14 天日志 ${fmtCount(f.log && f.log.olderThan14d)} 个`
    + `（共 ${fmtCount(f.log && f.log.fileCount)} 个文件 ~${fmtBytes(f.log && f.log.bytes)}；随执行日累积）`));

  lines.push(na(f.exec && f.exec.available,
    `  exec/           sess_ 前缀目录 ${fmtCount(f.exec && f.exec.sessPrefixed)} 个`
    + `（共 ${fmtCount(f.exec && f.exec.dirCount)} 个目录 ~${fmtBytes(f.exec && f.exec.bytes)}）`));

  lines.push(`备份状态          上次清理备份：${report.backup && report.backup.latest || '无'}`);
  lines.push('👉 预览删除清单：zsw doctor clean --dry-run');
  return `${lines.join('\n')}\n`;
}

/** 机器可读渲染（--json；zsw CLI stdout JSON 惯例 + G4 机检通道）。 */
function renderJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

module.exports = {
  collect,
  renderText,
  renderJson,
  REF_TABLES,
  SUBAGENT_MAX_AGE_MS,
  LOG_RETENTION_MS,
  loadSqlite,
  fmtBytes,
  fmtCount,
};
