'use strict';
/**
 * zsw doctor 只读体检（u1）+ dry-run 预览采集与渲染（u2）。
 *
 * 五面只读采集（设计 §2.1 写入面 / §3.1 报告样张 / 实施计划 u1）：
 *   面① 引擎库 ~/.zcode/cli/db/db.sqlite（node:sqlite readOnly）
 *   面② GUI 索引库 ~/.zcode/v2/tasks-index.sqlite（readOnly；真机可能无此文件）
 *   面③④⑤ 文件面 artifacts/ log/ exec/
 * 全部路径参数可注入（测试传 fixture；缺省值按 lib/config.js 约定 + os.homedir()
 * 下 ~/.zcode 约定——config.js 未约定引擎侧路径，此处组装处均注释来源）。
 *
 * u2 增量（设计 §3.1 第二代码块 dry-run 样张 / §3.3 D1）：collectDryRun 组装
 * 删除集链路（clean-identify 五类分治 → 污染哨兵 → 索引冲突预检 → 双库整体
 * 剔除 → 目录分布红灯 → input_history 命中计数）+ 文件面量级，产出 JSON-safe
 * 报告对象；renderDryRun 以 §3.1 样张为权威逐行渲染，返回 { text, exitCode }
 * ——哨兵失败（非零交集）时 exitCode=1 且输出失败样例文案（第三代码块形态），
 * dry-run 只读不写但报告必须醒目阻断。删除集构建与渲染的全部 DB 访问 readOnly。
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
const {
  parseRecordWhiteList,
  matchFeatureDirectory,
  buildDeleteSet,
  checkSentinel,
  checkIndexConflicts,
  excludeConflicts,
  checkRedLight,
  countInputHistoryHits,
} = require('./clean-identify');
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

// ---------------------------------------------------- u2 dry-run 预览

/**
 * dry-run 报告组装（设计 §3.1 第二代码块 / §3.3 D1）：删除集链路编排 + 文件面
 * 量级。只读——引擎库/索引库全部 DatabaseSync readOnly，文件面仅 readdir/stat。
 * 编排顺序（R3 作用域闭合 + 哨兵语义）：
 *   1. buildDeleteSet       五类分治 → 原始删除集
 *   2. checkSentinel        污染哨兵对**原始删除集**断言（冲突剔除可能碰巧掩盖
 *                           污染——R2 的 sess_fc9b87dc 即靠冲突机制碰巧保留，
 *                           哨兵必须把这种「碰巧」显式化，剔除前断言）
 *   3. checkIndexConflicts  索引冲突预检（原始删除集）
 *   4. excludeConflicts     冲突会话双库整体剔除 → 最终删除集
 *   5. checkRedLight / countInputHistoryHits  按**最终删除集**口径
 *      （红灯与 input_history 报告的都是「将删除的内容」；冲突剔除的会话不删，
 *       计入会误导人工审红灯）
 * 文件面复用 u1 collectFiles（artifacts/log/exec 三面量级，dry-run 与体检同源
 * 同口径）；预估回收基于最终删除集占比 × 库三件套体积（u1 偏差 3 粗估口径）。
 *
 * 返回 JSON-safe 报告（集合字段 = 排序数组 + size 语义由 length 承担；--json
 * 通道与文本渲染共同消费；u3 执行器领地应直接消费 clean-identify 原生结构）。
 *
 * @param {object} [options] 与 collect 同款路径注入 + olderThanDays / staleMode：
 *   engineDbPath / indexDbPath / recordsPath / artifactsDir / logDir / execDir /
 *   now / olderThanDays / staleMode（--stale 周期维护档，语义权威源见
 *   clean-identify.buildDeleteSet 头注——本层只透传，不复制语义）
 */
function collectDryRun(options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const engineDbPath = options.engineDbPath
    || path.join(engineCliRoot(), 'db', 'db.sqlite');
  const indexDbPath = options.indexDbPath
    || path.join(os.homedir(), '.zcode', 'v2', 'tasks-index.sqlite');
  const records = options.recordsPath || recordsPath();
  const artifactsDir = options.artifactsDir || path.join(engineCliRoot(), 'artifacts');
  const logDir = options.logDir || path.join(engineCliRoot(), 'log');
  const execDir = options.execDir || path.join(engineCliRoot(), 'exec');

  // 1-3：分治 + 哨兵 + 冲突预检（buildDeleteSet/checkIndexConflicts 各自只读开库）
  const initial = buildDeleteSet({
    engineDbPath,
    indexDbPath,
    recordsPath: records,
    olderThanDays: options.olderThanDays,
    staleMode: options.staleMode === true,
    now,
  });
  const sentinel = checkSentinel(initial, records);
  const conflicts = checkIndexConflicts(initial.engineSessionIds, indexDbPath);
  // 4：冲突剔除 → 最终删除集
  const { deleteSet: finalSet, removed } = excludeConflicts(initial, conflicts);

  // 5：红灯 + input_history 计数（最终集口径；顺带取 sessionTotal 供预估回收）
  const { DatabaseSync } = loadSqlite();
  let sessionTotal = undefined;
  let redlight = { workspaceN: 0, tmpN: 0, ratio: 0, outsideFeatureHits: 0, triggered: false };
  let inputHistoryHits = undefined;
  const db = new DatabaseSync(engineDbPath, { readOnly: true });
  try {
    sessionTotal = db.prepare('SELECT COUNT(*) AS n FROM session').get().n;
    redlight = checkRedLight(finalSet, db);
    inputHistoryHits = countInputHistoryHits(finalSet.engineSessionIds, db);
  } finally {
    db.close();
  }

  const files = collectFiles(artifactsDir, logDir, execDir, now);
  const dbBytes = dbTripleBytes(engineDbPath);
  const deleteSetSize = finalSet.engineSessionIds.size;
  const ratio = sessionTotal ? deleteSetSize / sessionTotal : 0;

  return {
    generatedAt: initial.generatedAt,
    now,
    olderThanDays: initial.olderThanDays,
    staleMode: initial.staleMode === true,
    paths: { engineDbPath, indexDbPath, recordsPath: records, artifactsDir, logDir, execDir },
    deleteSet: {
      engineSessionIds: [...finalSet.engineSessionIds].sort(),
      byClass: finalSet.byClass,
      indexTaskIds: [...finalSet.indexTaskIds].sort(),
      interactiveClassIds: [...finalSet.interactiveClassIds].sort(),
      removedByConflict: removed,
    },
    sentinel,
    conflicts: {
      available: conflicts.available,
      members: conflicts.members,
      automations: conflicts.automations,
      offPeak: conflicts.offPeak,
      conflictedSessionIds: [...conflicts.conflictedSessionIds].sort(),
    },
    redlight,
    inputHistoryHits,
    files,
    estimate: {
      deleteSetSize,
      sessionTotal,
      ratio,
      dbBytes,
      estimatedBytes: Math.round(ratio * dbBytes),
      note: '粗估，真实以执行后 du 为准',
    },
  };
}

/**
 * dry-run 人读渲染（设计 §3.1 第二代码块为权威样张，逐行对齐）。
 * 返回 { text, exitCode }：exitCode = 哨兵 ok ? 0 : 1——哨兵失败时输出 §3.1
 * 第三代码块形态的失败文案（中性归因 + 中止指引），且**仍输出删除清单**
 * （失败文案要求「把 dry-run 清单交维护者判定」），但以 ✗ 块收尾并不给
 * 「确认执行」行（醒目阻断：dry-run 只读不写，CLI 按 exitCode 退出）。
 *
 * @param {object} report collectDryRun 返回的 JSON-safe 报告
 * @returns {{text:string, exitCode:number}}
 */
function renderDryRun(report) {
  const ds = report.deleteSet;
  const wl = ds.byClass.whitelist.length;
  const ft = ds.byClass.feature.length;
  const sc = ds.byClass.subagentChildStale.length;
  const rl = report.redlight;
  const interactiveN = rl.workspaceN + rl.tmpN;
  const cf = report.conflicts;
  const removed = ds.removedByConflict || [];
  const lines = [];

  lines.push('将删除（不写库）：');
  // --stale 周期维护档位行（缺省形态不输出——存量全清样张逐字保持）。文件面
  // 档位不跟随 --older-than 的边界在此显式化（一个 flag 不暗改两处安全阈值）。
  if (report.staleMode === true) {
    lines.push(`  档位：--stale 周期维护（--older-than ${fmtCount(report.olderThanDays)} 天）——三类识别统一`
      + '只清 time_created 超龄会话；文件面档位不跟随（log 保留 14 天 / exec 空壳 7 天）');
  }
  lines.push(`  引擎库 session ${fmtCount(wl)}（白名单∩库）+ ${fmtCount(ft)}（特征目录类）`
    + `+ ${fmtCount(sc)}（超龄 subagent_child）行；`);
  lines.push('    按 FK 列级联（8 张 CASCADE 表 + part 经 message 间接级联 + session_task_link.child），');
  lines.push(`    model_usage/turn_usage 统计行随之级联；input_history 命中 ${fmtCount(report.inputHistoryHits)} 行随删（GUI 手输与 RPC send 均写该表）`);

  const s = report.sentinel || { ok: true, intersection: [] };
  lines.push(s.ok
    ? '  污染哨兵：删除集 ∩ targetSessionId 值域 = 0（非 0 中止——污染或嵌套合法重叠，逐条核查）'
    : `  污染哨兵：删除集 ∩ targetSessionId 值域 = ${s.intersection.length}（${s.intersection.join(' / ')}）`);

  lines.push(`  删除集 directory 分布（口径：仅 interactive 识别类——白名单∩库 + 特征目录类，共 ${fmtCount(interactiveN)}；`);
  lines.push('    排除 subagent_child——其 directory 全为工作区类且识别键是 task_type，纳入只会稀释红灯）：');
  lines.push(`    workspace 类 ${fmtCount(rl.workspaceN)} / 临时类（特征目录）${fmtCount(rl.tmpN)}`);
  lines.push('    人工审红灯（机械阈值）：临时类占比 > 30%，或特征表之外的临时目录命中数非 0 → 停手核查');
  if (rl.triggered) {
    lines.push(`    ⚠ 红灯触发：临时类占比 ${(rl.ratio * 100).toFixed(1)}% / 特征表外临时目录命中 ${fmtCount(rl.outsideFeatureHits)} 处`
      + ' → 停手核查（逐条核查命中会话的 directory/标题，确认识别无污染后再考虑执行）');
  }

  const conflictN = (cf.members ? cf.members.length : 0)
    + (cf.automations ? cf.automations.length : 0)
    + (cf.offPeak ? cf.offPeak.length : 0);
  const conflictDesc = removed.length > 0
    ? `姊妹表冲突 ${conflictN} 条 → 冲突会话 ${removed.length} 个已从双库删除集整体剔除`
      + `（${removed.map((r) => `${r.id}[${r.source}]`).join('、')}）；下次 clean 重查后自然纳入；冲突机制保留为安全网`
    : (cf.available === false ? '索引库 n/a；' : '当前无姊妹表冲突；') + '冲突机制保留为安全网';
  lines.push(`  GUI 索引 tasks ${fmtCount(ds.indexTaskIds.length)} 行（${conflictDesc}）`);

  const f = report.files || {};
  lines.push(`  artifacts ${fmtCount(f.artifacts && f.artifacts.dirCount)} 目录`
    + `；log 按执行日超龄文件（当前 ${fmtCount(f.log && f.log.olderThan14d)}）`
    + `；exec sess_ 前缀空壳 ${fmtCount(f.exec && f.exec.sessPrefixed)} 目录`);

  lines.push(`预估回收 ~${fmtBytes(report.estimate && report.estimate.estimatedBytes)}`
    + `（${report.estimate && report.estimate.note} = 删除集占比 × 库体积；log 面随执行日增长；库内空间需 VACUUM 后生效）`);

  if (!s.ok) {
    lines.push('');
    const show = s.intersection.slice(0, 8);
    const more = s.intersection.length > show.length ? ' …' : '';
    lines.push(`✗ 污染哨兵失败：删除集 ∩ targetSessionId 值域 = ${s.intersection.length}（${show.join(' / ')}${more}）。`);
    lines.push('  命中可能是识别器污染（C6-被否：targetSessionId 是 zsw 调用方宿主会话=用户真实会话），');
    lines.push('  也可能是嵌套调用的合法重叠（zsw 会话充当另一次 zsw 调用的宿主）。👉 中止不改库；');
    lines.push('  逐条核查命中会话的 directory/标题后，把 dry-run 清单交维护者判定。');
    return { text: `${lines.join('\n')}\n`, exitCode: 1 };
  }
  lines.push('👉 确认执行：退出 ZCode 后跑 zsw doctor clean');
  return { text: `${lines.join('\n')}\n`, exitCode: 0 };
}

module.exports = {
  collect,
  renderText,
  renderJson,
  // u2 dry-run
  collectDryRun,
  renderDryRun,
  REF_TABLES,
  SUBAGENT_MAX_AGE_MS,
  LOG_RETENTION_MS,
  loadSqlite,
  fmtBytes,
  fmtCount,
};
