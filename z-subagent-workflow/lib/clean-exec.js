'use strict';
/**
 * 会话残留清理执行器（u3 = 设计 docs/design/zsw-session-residue-cleanup-design.md
 * §3.3 D2/D3/D4 + §2.1 面① FK 列粒度 + §3.1 执行样张；实施计划 u3）。
 *
 * 编排顺序（runClean → runCleanLocked → runDbFlow，一切路径可注入，缺省 = 真实
 * ~/.zcode 约定；M6/M1 修复后：停机校验先于删除集构建、索引联动先于磁盘③/VACUUM，
 * 后者回归设计 §5 F3 编排序）：
 *   0. 跨进程互斥锁         <maintenanceDir>/.clean.lock（'wx' 原子建 + pid 探活
 *                           + stale 接管；M4——并发 clean 的 keep-1 prune 会互删
 *                           对方备份安全网，锁先于一切写面动作）
 *   1. runShutdownChecks    四项停机校验（D2，--fs-only 同样全查不豁免；M6 修复：
 *                           先于删除集构建——识别管线的索引库读失败必须发生在停机
 *                           确认之后，杜绝「GUI 退出瞬间 BUSY → 空集识别 → 校验
 *                           通过 → 删除」的错序链）
 *   2. buildDeleteSet       五类分治（只读，u2；staleMode 档位语义权威源在
 *                           clean-identify 头注——本层只透传。索引库存在而打开/
 *                           查询失败即 coded 拒绝，缺文件才 n/a 空集——M6 收紧）
 *   3. checkSentinel        污染哨兵复断言（对剔除前原始集——R2 教训，u2 同款）
 *   4. checkIndexConflicts + excludeConflicts  冲突会话双库整体剔除（D1⑤）
 *   5. [--fs-only] planFileCleanup + executeFileCleanup → 报告（库操作全部跳过）
 *   6. 磁盘校验① 备份前「剩余 ≥ 库三件套×1.1」（D4）
 *   7. SQLITE_TMPDIR 钉死与库同卷（mkdtemp 于 <maintenance>/tmp-<ts>，用后清理）
 *   8. 三件套一致性备份 → keep-1 清旧备份（D3；M5：逐库 BEGIN EXCLUSIVE 保持
 *      事务期间拷贝 → ROLLBACK，锁窗口内无并发写者，拷贝集同提交点；写连接
 *      busy_timeout 骑过瞬时锁残留）
 *   9. 索引库存在防御拦截（删除连接对缺文件凭空建库——任何删除开始前 fail-closed）
 *  10. 磁盘校验② 删除前「剩余−备份实占 ≥ 1GB」（基准时点 = 备份完成后）
 *  11. ④ 独占开锁复探测（M5③：停机校验是时点探测，到删除连接间隔可达分钟级
 *      （多 GB 库备份）——本步为删除连接打开前最后一道门禁，重跑收窄无写者窗口）
 *  12. 引擎库分块删除（≤200 会话/事务 + 批间 wal_checkpoint(PASSIVE)；
 *      PRAGMA foreign_keys=ON 后 8 张 CASCADE 表直删、part 经 message 级联、
 *      session_task_link 双列分处理、workflow_run/workflow_activity 置空、
 *      input_history 随删计数、session 最后删——§2.1 面① FK 列粒度）
 *  13. 索引库 tasks + task_group_members 同事务联动删除（C4；M1 修复：紧随引擎
 *      删除、先于磁盘③/VACUUM——旧序下 pre-vacuum 拒绝/中途中止三条路径停在
 *      「引擎行已删、tasks 行未删」，且重跑不补删索引面；automations/off_peak
 *      只在冲突预检报告，不删——冲突会话已整体剔除，D1⑤）
 *  14. 磁盘校验③ VACUUM 前「剩余−备份实占 ≥ 库三件套×1.1」（基准 = 删除完成后）
 *  15. VACUUM（page_count×page_size 前后计入报告）
 *  16. 文件面 plan + execute（u4 clean-fs）
 *  17. 报告渲染（§3.1 第三代码块样张；--json 出结构化报告；A-4 对账 counts）
 *
 * D4 头注纪律：批间 wal_checkpoint(PASSIVE) **不截断** -wal 文件（文件保留峰值
 * 体积直至连接关闭）——勿以 -wal 文件大小判断 checkpoint 失效，以批级行数与
 * pragma integrity_check 为准。删除整体单事务被否（WAL 峰值无界）；
 * journal_mode 改写与 auto_vacuum 侵入宿主配置均被否（D4 被否谱系）。
 *
 * P3 停机探测（实施期门，2026-09-06 本机实测）：
 *   ① ZCode GUI——Electron 主进程命令行为裸 `ZCode`（无路径无参数），Helper 带
 *     `/Applications/ZCode.app/` bundle 路径；两类形态都拦截（宁可误拦，方向安全）。
 *   ② app-server——命令行含 `zcode.cjs` 且含 `app-server`（进程名可被改写，须按
 *     命令行匹配；仅含 zcode.cjs 的 plugin-host 形态不含 app-server，不误拦）。
 *   ③ 嵌套标记（ZSW_NESTED=1 / XYZ_AGENT_SUBAGENT=1）——检出面 = argv 文本含
 *     标记字样的形态；真实嵌套形态（argv 干净 + env 注入，config.js isNestedEnv
 *     双标记口径）的 env 段在 macOS ps 输出中可见性不可靠（2026-09-06 三形态
 *     复核：shell env 前缀 / env X=x / Node spawn env 注入均不可见，目标进程行
 *     呈裸名），本项为尽力检出。真实防线 = ①②④（④ 独占开锁拦住持库进程；
 *     不持库的孤儿嵌套进程无破坏面）。其余局限：他用户进程 env 不可见、
 *     超长 env 可能截断。
 *   ④ 双库 BEGIN EXCLUSIVE 独占开锁——探测连接立即 ROLLBACK 释放（WAL 库只影响
 *     写锁，无数据变更；-wal/-shm 若因连接产生会在干净关闭时自动清理）。兜底拦
 *     截无进程名的持库 fd / crash 残留句柄（重写进程名的 zcode-cli 形态即此类）。
 *
 * 真实 ~/.zcode 红线：拒绝路径（停机校验/哨兵/磁盘）不触碰双库数据（库数据零
 * 改动）；备份自磁盘②段起先行落盘作为安全网，tmpdir 拒绝路径的临时目录由
 * teardown 清理。备份/删除/VACUUM 仅在四项校验全过后执行。开发期真实库只读
 * （探针全部 readOnly）。
 *
 * --stale 周期维护档边界（u5，设计 D5）：staleMode=true 时删除集缩到超龄部分
 * （语义权威源 = clean-identify.buildDeleteSet 头注）。--older-than 天数**只**
 * 作用于会话识别集，不跟随到文件面安全阈值——log 按龄保留 14 天、exec 空壳
 * 7 天的档位（lib/clean-fs.js DEFAULT_LOG_RETENTION_DAYS /
 * DEFAULT_EXEC_STALE_DAYS）在任何档位下保持各自默认：一个 flag 不暗改两处
 * 安全阈值；文件面 id 匹配通道（artifacts/execInSet）随删除集收缩自然收缩。
 *
 * 零依赖 plain Node CJS（node:sqlite 内置；禁 npm 依赖）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const {
  buildDeleteSet,
  checkSentinel,
  checkIndexConflicts,
  excludeConflicts,
  DEFAULT_OLDER_THAN_DAYS,
  DB_CORRUPT_MESSAGE_RE,
} = require('./clean-identify');
const { planFileCleanup, executeFileCleanup } = require('./clean-fs');
const { recordsPath: defaultRecordsPath, zswRoot, resolveEnginePaths } = require('./config');
// fmtBytes/fmtCount 走叶子模块 clean-format：执行器不 require('./doctor')——
// 那会把体检模块（连带其依赖面）拉进执行器依赖图（clean-fs 头注同款纪律）。
const { fmtBytes, fmtCount } = require('./clean-format');

/** GB 口径 1000 进制（clean-format fmtBytes 同口径：1e9）。 */
const GB = 1000 * 1000 * 1000;
/** 分块大小：≤200 会话/事务（设计 D4；~6,290 行 ≈ 32 批）。 */
const DEFAULT_CHUNK_SIZE = 200;
/** 磁盘校验安全系数（D4：库三件套 ×1.1）。 */
const DISK_SAFETY_FACTOR = 1.1;
/** WAL 三件套后缀（C3：-wal/-shm 伴生文件一并处理；存在才拷/才计）。 */
const TRIPLE_SUFFIXES = Object.freeze(['', '-wal', '-shm']);
/** 写连接 busy_timeout（M5②）：停机校验已确保无运行中写者，取值只需骑过瞬时锁
 *  残留（进程刚退出的锁释放延迟 / WAL 恢复）——5s 为 SQLite 生态常用缺省
 *  （Python sqlite3 同值）：更短会把瞬时残留放大成失败，更长把停机窗口卡成悬挂。
 *  ④ 探测连接不设（残留句柄不会自行释放，等 5s 是纯悬挂，立即拒绝才可操作）。 */
const BUSY_TIMEOUT_MS = 5000;

/**
 * 8 张直接 FK→session 且 CASCADE 的表（设计 §2.1 面①，sqlite_master 穷举 +
 * FK 列粒度；2026-09-06 真库只读摘抄核实全部为 `references session(id)
 * on delete cascade`）。part 不在列——其 FK 指向 message（CASCADE），经
 * message 删除级联（间接，P1 口径）；session_task_link 双列分处理；2 个 SET
 * NULL 列 + input_history（无 FK）单独处理。
 */
const CASCADE_SESSION_TABLES = Object.freeze([
  'message', 'todo', 'session_entry', 'session_input', 'session_target',
  'model_usage', 'turn_usage', 'tool_usage',
]);

// ---------------------------------------------------- node:sqlite 检测

/** node:sqlite 运行时检测（doctor.loadSqlite / clean-identify.loadSqliteOperational
 *  同款语义第三实例——依赖面纪律见 clean-fs 头注；文案指向 clean 恢复动作）。 */
function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch (e) {
    const err = new Error(
      `node:sqlite 不可用（${e && e.message || e}）。doctor clean 需要 Node ≥22.5（建议 24），`
      + `当前 ${process.version}。恢复指引：升级 Node 后重跑 node bin/zsw.js doctor clean。`,
    );
    err.code = 'NODE_SQLITE_UNAVAILABLE';
    throw err;
  }
}

// ---------------------------------------------------- D2 停机校验

/**
 * 解析 `ps axeww -o pid=,command=` 文本 → [{pid, command}]。eww 形态下本用户
 * 进程的 env 附加在命令行之后（③ 的探测面），解析层不区分——整行都是 command。
 * 空行/无 pid 行跳过；pid 非数字跳过（防御 ps 形态漂移）。
 */
function parsePsLines(psText) {
  const out = [];
  if (typeof psText !== 'string') return out;
  for (const line of psText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const spaceIdx = trimmed.search(/\s/);
    if (spaceIdx === -1) continue;
    const pid = Number(trimmed.slice(0, spaceIdx));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.push({ pid, command: trimmed.slice(spaceIdx + 1).trim() });
  }
  return out;
}

/** GUI 形态一：ZCode.app bundle 路径（主进程/helper/crashpad 全家族）。 */
const GUI_BUNDLE_MARKER = '/ZCode.app/';

/** 命令行首 token 的 basename（裸进程名形态判定用）。 */
function firstTokenBase(command) {
  const first = command.split(/\s+/)[0] || '';
  return first.split('/').pop();
}

/**
 * ① ZCode GUI 判定（P3 实测形态，2026-09-06）：命令行含 ZCode.app bundle 路径，
 * 或首 token basename 恰为 `ZCode`（GUI 主进程裸名形态 `ZCode`，无路径无参数）。
 * 判定面 = ps 整行（argv + 可变可见性的 env 段），误拦自身/同链进程属预期安全
 * 行为（宁可误拦；多拦一个同名进程只是拒绝执行，不产生删除）。
 */
function isGuiCommand(command) {
  if (command.includes(GUI_BUNDLE_MARKER)) return true;
  return firstTokenBase(command) === 'ZCode';
}

/**
 * ② app-server 判定（D2：进程名可被改写，按命令行匹配）：命令行同时含
 * `zcode.cjs` 与 `app-server`。仅含 zcode.cjs 的 plugin-host/MCP 形态
 * （实测 proxy-launcher 行）不含 app-server，不误拦。
 */
function isAppServerCommand(command) {
  return command.includes('zcode.cjs') && command.includes('app-server');
}

/**
 * ③ 嵌套标记判定（axeww argv/env 文本面；检出局限见头注 P3③）：双标记与
 * config.js isNestedEnv / bin/zsw.js ensureNotNested 同口径——ZSW_NESTED=1
 * （zsw 自有通道注入）与 XYZ_AGENT_SUBAGENT=1（core 引擎嵌套派发注入并剥离
 * ZSW_NESTED，嵌套会话内再起的 zsw 进程只能看到后者）。
 */
function isNestedCommand(command) {
  return command.includes('ZSW_NESTED=1') || command.includes('XYZ_AGENT_SUBAGENT=1');
}

/**
 * ①②③ 进程分类（纯函数，ps 文本注入）：返回 {kind,pid,command} 数组，
 * kind ∈ 'gui' | 'app-server' | 'nested'。同一进程可命中多类（各自报告）。
 * command 截断 200 字符（报告可读性；判定用完整串）。
 */
function classifyProcessViolations(psText) {
  const out = [];
  for (const { pid, command } of parsePsLines(psText)) {
    if (isGuiCommand(command)) out.push({ kind: 'gui', pid, command: command.slice(0, 200) });
    if (isAppServerCommand(command)) out.push({ kind: 'app-server', pid, command: command.slice(0, 200) });
    if (isNestedCommand(command)) out.push({ kind: 'nested', pid, command: command.slice(0, 200) });
  }
  return out;
}

/** 默认 ps 采集（axeww = 宽命令行 + 本用户 env 附加，一次采集覆盖 ①②③）。 */
function collectPsText() {
  try {
    return execSync('ps axeww -o pid=,command=', {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 1000,
    });
  } catch (e) {
    const err = new Error(
      `进程探测失败（${e && e.message || e}）。恢复指引：确认 ps 可用后重跑；`
      + '停机窗口校验（设计 D2）无法跳过。',
    );
    err.code = 'PS_PROBE_FAILED';
    throw err;
  }
}

/**
 * ④ 双库 BEGIN EXCLUSIVE 独占开锁（D2④ 兜底）。探测连接 BEGIN 成功后立即
 * ROLLBACK 释放——无数据变更（WAL 下 -wal/-shm 若因连接产生，干净关闭自动清理）。
 * 库文件缺失 ≠ 有锁（M3 修复：原把缺失记为锁失败 → 无 GUI 机器 --fs-only 永久
 * 被拒、lsof 指引成死路）：缺失 → 跳过该库探测 + stderr 一行告警（fail-closed
 * 针对的是锁竞争；引擎库缺失仍由识别管线 DB_OPEN_FAILED fail-closed，索引库
 * 缺失为合法环境态 n/a）；损坏/非库文件同样 ≠ 有锁（REG-1 修复：原被 catch-all
 * 记为锁失败 → 渲染「库仍被持有 + lsof 指引」死路，而损坏库该走识别/体检管线的
 * DB_OPEN_FAILED / INDEX_DB_UNAVAILABLE 专业诊断）：与缺文件同型归入 skipped
 * （reason 区分，--json 机读可辨）+ stderr 告警，流程继续；锁竞争 → 记入
 * failures 由调用方拒绝。
 * @returns {{ok:boolean, failures:Array<{label,dbPath,message}>, skipped:Array<{label,dbPath,reason}>}}
 */
function checkExclusiveLocks({ engineDbPath, indexDbPath }) {
  const { DatabaseSync } = loadSqlite();
  const targets = [
    { label: '引擎库', dbPath: engineDbPath },
    { label: '索引库', dbPath: indexDbPath },
  ];
  const failures = [];
  const skipped = [];
  for (const { label, dbPath } of targets) {
    if (typeof dbPath !== 'string' || dbPath === '' || !fs.existsSync(dbPath)) {
      skipped.push({ label, dbPath, reason: 'missing' });
      process.stderr.write(`⚠ 独占开锁跳过：${label}文件不存在：${dbPath || '(未提供)'}`
        + '（缺文件 ≠ 有锁；引擎库缺失由识别管线 fail-closed）\n');
      continue;
    }
    let db = null;
    try {
      db = new DatabaseSync(dbPath); // 读写打开（readOnly 连接拿不到写锁，探测无效）
      db.exec('BEGIN EXCLUSIVE');
      db.exec('ROLLBACK');
    } catch (e) {
      const message = (e && e.message) || String(e);
      if (DB_CORRUPT_MESSAGE_RE.test(message)) {
        // 损坏/非库文件开不出锁 ≠ 锁竞争：跳过探测交由识别/体检管线报专业诊断
        skipped.push({ label, dbPath, reason: 'suspect-corrupt' });
        process.stderr.write(`⚠ 独占开锁失败（疑似损坏或非库文件）：跳过${label}锁探测，`
          + `交由识别/体检管线诊断：${dbPath}（${message}）\n`);
      } else {
        failures.push({ label, dbPath, message });
      }
    } finally {
      try { if (db) db.close(); } catch { /* 关闭失败不改变判定 */ }
    }
  }
  return { ok: failures.length === 0, failures, skipped };
}

/**
 * 四项停机校验组合（D2；--fs-only 同样全查不豁免）。①②③ 任一命中即拒绝且
 * **不做** ④（GUI 在跑时锁探测必然失败，噪音无益；短路与样张逐条文案一致）。
 * @param {object} options engineDbPath / indexDbPath / psText（注入；缺省实采 ps）
 * @returns {{ok, psSource:'injected'|'ps', processViolations, lockFailures}}
 */
function runShutdownChecks(options = {}) {
  const injected = typeof options.psText === 'string';
  const psText = injected ? options.psText : collectPsText();
  const processViolations = classifyProcessViolations(psText);
  if (processViolations.length > 0) {
    return { ok: false, psSource: injected ? 'injected' : 'ps', processViolations, lockFailures: [], lockSkipped: [] };
  }
  const locks = checkExclusiveLocks({ engineDbPath: options.engineDbPath, indexDbPath: options.indexDbPath });
  if (!locks.ok) {
    return { ok: false, psSource: injected ? 'injected' : 'ps', processViolations, lockFailures: locks.failures, lockSkipped: locks.skipped };
  }
  return { ok: true, psSource: injected ? 'injected' : 'ps', processViolations: [], lockFailures: [], lockSkipped: locks.skipped };
}

// ---------------------------------------------------- D4 磁盘三段校验 + SQLITE_TMPDIR

/** 卷剩余可用字节（statfs bavail×bsize，非特权可用口径）。 */
function freeBytesOnVolume(volumePath /* , stage */) {
  const st = fs.statfsSync(volumePath);
  return st.bavail * st.bsize;
}

/** dev_t 等价同卷判定（fs.statfs 无 dev 字段，statSync().dev 即 dev_t）。 */
function devOfPath(p) {
  return fs.statSync(p).dev;
}

/** 库三件套体积合计（存在的文件才计；doctor dbTripleBytes 同口径双库版）。 */
function tripleBytes(dbPath) {
  if (typeof dbPath !== 'string' || dbPath === '' || !fs.existsSync(dbPath)) return 0;
  return TRIPLE_SUFFIXES.reduce((sum, suffix) => {
    const p = dbPath + suffix;
    try {
      return sum + fs.statSync(p).size;
    } catch {
      return sum; // -wal/-shm 竞态消失：按 0 计
    }
  }, 0);
}

/**
 * 单段校验求值（D4 三段；base = 校验基准面）：
 *   pre-backup  剩余 ≥ 库三件套×1.1
 *   pre-delete  剩余 − 备份实占 ≥ 1GB（基准时点 = 备份完成后）
 *   pre-vacuum  剩余 − 备份实占 ≥ 库三件套×1.1（基准时点 = 删除完成后）
 */
function evalDiskStage(stage, { free, dbBytesTotal, backupBytes }) {
  const backup = backupBytes || 0;
  if (stage === 'pre-backup') {
    const needed = Math.ceil(dbBytesTotal * DISK_SAFETY_FACTOR);
    return { needed, base: free, ok: free >= needed };
  }
  if (stage === 'pre-delete') {
    return { needed: GB, base: free - backup, ok: free - backup >= GB };
  }
  if (stage === 'pre-vacuum') {
    const needed = Math.ceil(dbBytesTotal * DISK_SAFETY_FACTOR);
    return { needed, base: free - backup, ok: free - backup >= needed };
  }
  throw new Error(`未知磁盘校验阶段: ${stage}`);
}

/**
 * SQLITE_TMPDIR 钉死与库同卷（D4）：mkdtemp 于 <maintenanceDir>/tmp-<ts>-
 * （与 ~/.zcode 结构性同卷），statSync dev 双重断言；设置进程 env 供 SQLite
 * 临时文件（VACUUM/大事务 spill）落同卷。返回 previous 供调用方 finally 还原
 * （sameVolume=false 时 env 未被触碰，previous 透传现值，teardown 安全）。
 * @param {object} p maintenanceDir / engineDbPath / devFn（同卷判定的 dev 采集
 *   注入，仅测试用——缺省真 devOfPath）
 */
function setupSqliteTmpdir({ maintenanceDir, engineDbPath, devFn = devOfPath }) {
  fs.mkdirSync(maintenanceDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(maintenanceDir, `tmp-${timestamp()}-`));
  const dbDev = devFn(path.dirname(engineDbPath));
  const tmpDev = devFn(dir);
  const sameVolume = dbDev === tmpDev;
  const previous = process.env.SQLITE_TMPDIR;
  if (sameVolume) process.env.SQLITE_TMPDIR = dir;
  return { dir, sameVolume, dbDev, tmpDev, previous };
}

/** 还原 SQLITE_TMPDIR + 清理临时目录（runClean finally 消费）。 */
function teardownSqliteTmpdir(tmp) {
  if (!tmp) return;
  if (tmp.previous === undefined) delete process.env.SQLITE_TMPDIR;
  else process.env.SQLITE_TMPDIR = tmp.previous;
  try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* 用后清理尽力 */ }
}

// ---------------------------------------------------- D3 备份管理

/** 备份目录名时间戳（字典序 = 时间序，keep-1/purge 的「最新」判定基础）。 */
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 双库既有三件套文件清单（M5 备份拷贝集基准）。在停机校验通过后、识别管线
 * 运行前快照——识别管线的 readOnly 连接会给 WAL 库留下空 -wal/-shm（read-only
 * 关闭无法 checkpoint 清理，node:sqlite 实测），备份若按拷贝时点判断会把本进程
 * 的瞬态伴生文件当源文件拷入备份。
 * @returns {{engine:string[], index:string[]}}
 */
function collectBackupSources({ engineDbPath, indexDbPath }) {
  const list = (base) => (typeof base === 'string' && base !== ''
    ? TRIPLE_SUFFIXES.map((suffix) => base + suffix).filter((p) => fs.existsSync(p))
    : []);
  return { engine: list(engineDbPath), index: list(indexDbPath) };
}

/**
 * 双库三件套一致性备份（D3 + M5）：逐库开写连接 BEGIN EXCLUSIVE **保持事务**
 * 期间完成该库既有三件套的 copyFileSync，再 ROLLBACK——EXCLUSIVE 写锁窗口内
 * 无并发写者（TRUNCATE checkpoint 需写锁，同样被挡），main/-wal 拷贝集必然处于
 * 同一提交点。原逐文件裸拷在「拷完 main、拷 -wal 前」遇写者 checkpoint 会产出
 * 旧 main + 新 -wal 的撕裂备份，却被字典序「最新备份」当有效安全网展示。
 * 拷贝集 = sources（停机确认后的快照，runClean 主链路传入）；缺省回落为打开
 * 连接**前**的即时快照（直接调用形态，如单测）。「存在才拷」语义保持（备份
 * 连接自身的瞬态 -wal/-shm 不入备份）。任一文件拷贝失败 → 删除本次半成品
 * backup 目录后重抛（半套备份会被 keep-1/字典序判为最新）。库文件缺失照旧
 * 跳过（索引库缺文件 = 合法环境态；引擎库缺失已被上游拦截）。
 */
function backupDatabases({ engineDbPath, indexDbPath, backupDir, sources }) {
  const { DatabaseSync } = loadSqlite();
  fs.mkdirSync(backupDir, { recursive: true });
  const files = [];
  try {
    for (const [db, base] of [['engine', engineDbPath], ['index', indexDbPath]]) {
      if (typeof base !== 'string' || base === '' || !fs.existsSync(base)) continue;
      const sourcesForDb = sources && Array.isArray(sources[db])
        ? sources[db].filter((p) => fs.existsSync(p))
        : TRIPLE_SUFFIXES.map((suffix) => base + suffix).filter((p) => fs.existsSync(p));
      const conn = new DatabaseSync(base);
      try {
        conn.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
        conn.exec('BEGIN EXCLUSIVE');
        try {
          for (const src of sourcesForDb) {
            fs.copyFileSync(src, path.join(backupDir, path.basename(src)));
            files.push({ db, name: path.basename(src), bytes: fs.statSync(src).size });
          }
        } finally {
          try { conn.exec('ROLLBACK'); } catch { /* 释放失败交由 close 收尾 */ }
        }
      } finally {
        try { conn.close(); } catch { /* 尽力关闭；最后连接关闭时 SQLite 自动 checkpoint */ }
      }
    }
  } catch (e) {
    // M5 顺带：半成品备份目录清理——半套备份会被字典序判为「最新备份」展示
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* 清理尽力，不掩盖原错误 */ }
    throw e;
  }
  return { backupDir, files, totalBytes: files.reduce((s, f) => s + f.bytes, 0) };
}

/** maintenance 目录下 backup-* 目录清单（升序）。 */
function listBackupDirs(maintenanceDir) {
  let entries;
  try {
    entries = fs.readdirSync(maintenanceDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && e.name.startsWith('backup-')).map((e) => e.name).sort();
}

/** 最新备份目录名（doctor.latestBackupName 同口径：backup-* 升序取末；无 → null）。 */
function findLatestBackupName(maintenanceDir) {
  const names = listBackupDirs(maintenanceDir);
  return names.length ? names[names.length - 1] : null;
}

/**
 * keep-1（D3）：新备份成功后删除其余 backup-* 目录。只动目录，不碰 tmp- 前缀
 * 临时目录等其他内容。返回被清理目录名清单。
 */
function pruneOldBackups({ maintenanceDir, keepName }) {
  const removed = [];
  for (const name of listBackupDirs(maintenanceDir)) {
    if (name === keepName) continue;
    fs.rmSync(path.join(maintenanceDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * --purge-backup（D3/F4 + M4）：删除最新 backup-* 目录。无备份 → purged:null（如实
 * 报告，不伪装成功）。只删 zsw 自有备份目录，不触任何库。受 clean 互斥锁约束——
 * 并发下 purge 会删掉进行中 clean 刚建的安全网（M4 危害链末端）；锁被占用时抛
 * coded CLEAN_LOCK_BUSY（CLI main catch 输出 [zsw] 错误 + exit 1）。
 */
function purgeLatestBackup(options = {}) {
  const maintenanceDir = options.maintenanceDir || defaultMaintenanceDir();
  const lockPath = acquireCleanLock(maintenanceDir);
  try {
    const latest = findLatestBackupName(maintenanceDir);
    if (!latest) return { purged: null, path: null, maintenanceDir };
    const target = path.join(maintenanceDir, latest);
    fs.rmSync(target, { recursive: true, force: true });
    return { purged: latest, path: target, maintenanceDir };
  } finally {
    releaseCleanLock(lockPath);
  }
}

function defaultMaintenanceDir() {
  return path.join(zswRoot(), 'maintenance');
}

// ---------------------------------------------------- M4 clean 跨进程互斥锁

/** clean 执行互斥锁文件名（maintenanceDir 下；backup- 与 tmp- 前缀清单均不受影响）。 */
const CLEAN_LOCK_FILENAME = '.clean.lock';

function cleanLockPath(maintenanceDir) {
  return path.join(maintenanceDir, CLEAN_LOCK_FILENAME);
}

/** 探活：kill(pid,0) 无信号探测；EPERM = 进程存在但属他主，按活进程保守处理。 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

/** 读锁内容；损坏/被并发删除 → null（无主锁按 stale 处理，不让坏锁永久阻断维护）。 */
function readCleanLockInfo(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return parsed && typeof parsed.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 获取 clean 跨进程互斥锁（M4）：'wx'（O_CREAT|O_EXCL）原子建
 * `<maintenanceDir>/.clean.lock`，内容 {pid, startedAt}。已存在时读 pid 探活：
 * 活进程 → coded CLEAN_LOCK_BUSY 拒绝（错误 → 原因 → 恢复动作闭环）；死进程/
 * 内容损坏 → stale 接管（stderr 说明后删旧重试）。两进程同时判 stale 的理论
 * 竞窗由「单人手动停机窗口 + O_EXCL 原子建」收敛：至多一方建锁成功，另一方
 * EEXIST 后探活拒绝；release 只删 pid = 自己的锁，不误删接管竞窗下他人的新锁。
 * @returns {string} lockPath（releaseCleanLock 消费）
 */
function acquireCleanLock(maintenanceDir) {
  fs.mkdirSync(maintenanceDir, { recursive: true });
  const lockPath = cleanLockPath(maintenanceDir);
  const payload = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      const info = readCleanLockInfo(lockPath);
      if (info && pidAlive(info.pid)) {
        const err = new Error(
          `另一个 clean 正在运行（PID ${info.pid}，锁文件：${lockPath}）。`
            + `恢复指引：等待其结束；确认无并发 clean（ps -p ${info.pid}）后手工删除锁文件再重跑。`,
        );
        err.code = 'CLEAN_LOCK_BUSY';
        // 机读载体（REG-3）：runClean 把其填进 report.refusal——--json 形态
        // 可区分拒绝类型/持锁方，不依赖人读文案解析
        err.pid = info.pid;
        err.lockPath = lockPath;
        throw err;
      }
      process.stderr.write(`⚠ 清理锁 stale（持锁进程 ${info ? info.pid : '未知'} 已不在），接管：删除旧锁重试（${lockPath}）\n`);
      try { fs.rmSync(lockPath, { force: true }); } catch { /* 重试 openSync 以 EEXIST 再报 */ }
      continue;
    }
    try {
      fs.writeFileSync(fd, payload);
    } finally {
      fs.closeSync(fd);
    }
    return lockPath;
  }
  const err = new Error(
    `清理锁获取失败（stale 接管后仍被占用）：${lockPath}。`
      + '恢复指引：确认无并发 clean 后手工删除锁文件再重跑。',
  );
  err.code = 'CLEAN_LOCK_BUSY';
  err.pid = null; // stale 接管竞窗态无确定持锁方，机读面如实为 null
  err.lockPath = lockPath;
  throw err;
}

/** 释放自己的锁：仅当锁内容 pid = 本进程才删（stale 接管竞窗下不误删他人新锁）。 */
function releaseCleanLock(lockPath) {
  if (typeof lockPath !== 'string') return;
  const info = readCleanLockInfo(lockPath);
  if (info && info.pid === process.pid) {
    try { fs.rmSync(lockPath, { force: true }); } catch { /* 释放失败不掩盖主流程错误 */ }
  }
}

// ---------------------------------------------------- 引擎库分块删除 / VACUUM / 索引联动

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function chunkIds(ids, chunkSize) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));
  return chunks;
}

/**
 * 引擎库分块删除（D4 + §2.1 FK 列粒度）。前置：db 连接已 PRAGMA foreign_keys=ON
 * （同连接生效，C1——engine 声明 CASCADE 但 foreign_keys=0 时 DELETE session
 * 不级联，P1 实测纪律；此处校验 pragma 确实生效，不生效即抛）。块序 = 最终集
 * 升序切块，稳定。每块一个事务，块序内语句序：
 *   8 张 CASCADE 表 DELETE（message 最前——part 由其级联）→ session_task_link
 *   child DELETE + parent 置 NULL → workflow_run/workflow_activity 置 NULL →
 *   input_history DELETE（无 FK，计数）→ session DELETE（最后）→ COMMIT →
 *   wal_checkpoint(PASSIVE)（不截断 -wal，见头注纪律）。
 * part 级联行数 = 前后 COUNT 差（CASCADE 不计入 changes）。
 *
 * @param {object} p {db, ids(升序数组), chunkSize, afterBatch(i, info) 观测钩子}
 * @returns {{chunks:number[], checkpoints:number, sessionDeleted, perTable,
 *   partCascaded, sessionTaskLinkDeleted, sessionTaskLinkParentNull,
 *   workflowRunNull, workflowActivityNull, inputHistoryDeleted}}
 */
function deleteEngineSessionsChunked({ db, ids, chunkSize = DEFAULT_CHUNK_SIZE, afterBatch }) {
  const fk = db.prepare('PRAGMA foreign_keys').get();
  if (!fk || fk.foreign_keys !== 1) {
    throw new Error('PRAGMA foreign_keys=ON 未生效（C1：级联依赖 FK 开启）——中止删除，不改库。');
  }
  const partBefore = countRows(db, 'part');
  const counts = {
    chunks: [], checkpoints: 0, sessionDeleted: 0,
    perTable: Object.fromEntries(CASCADE_SESSION_TABLES.map((t) => [t, 0])),
    partCascaded: 0, sessionTaskLinkDeleted: 0, sessionTaskLinkParentNull: 0,
    workflowRunNull: 0, workflowActivityNull: 0, inputHistoryDeleted: 0,
  };
  const chunks = chunkIds(ids, chunkSize);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const ph = chunk.map(() => '?').join(', ');
    db.exec('BEGIN');
    try {
      for (const t of CASCADE_SESSION_TABLES) {
        counts.perTable[t] += db.prepare(`DELETE FROM ${t} WHERE session_id IN (${ph})`).run(...chunk).changes;
      }
      counts.sessionTaskLinkDeleted
        += db.prepare(`DELETE FROM session_task_link WHERE child_session_id IN (${ph})`).run(...chunk).changes;
      counts.sessionTaskLinkParentNull
        += db.prepare(`UPDATE session_task_link SET parent_session_id = NULL WHERE parent_session_id IN (${ph})`).run(...chunk).changes;
      counts.workflowRunNull
        += db.prepare(`UPDATE workflow_run SET parent_session_id = NULL WHERE parent_session_id IN (${ph})`).run(...chunk).changes;
      counts.workflowActivityNull
        += db.prepare(`UPDATE workflow_activity SET child_session_id = NULL WHERE child_session_id IN (${ph})`).run(...chunk).changes;
      counts.inputHistoryDeleted
        += db.prepare(`DELETE FROM input_history WHERE session_id IN (${ph})`).run(...chunk).changes;
      counts.sessionDeleted
        += db.prepare(`DELETE FROM session WHERE id IN (${ph})`).run(...chunk).changes;
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 已断连等：保留原错误 */ }
      throw e;
    }
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    counts.checkpoints++;
    counts.chunks.push(chunk.length);
    if (typeof afterBatch === 'function') afterBatch(i, { chunkSize: chunk.length, checkpoint });
  }
  // part 经 message 级联不入 changes（CASCADE 由引擎执行）——以前后 COUNT 差计
  counts.partCascaded = Math.max(0, partBefore - countRows(db, 'part'));
  return counts;
}

/** VACUUM（C2：auto_vacuum=0 删行不还空间）+ page_count×page_size 前后实测。 */
function vacuumEngineDb(db) {
  const pages = () => {
    const count = db.prepare('PRAGMA page_count').get().page_count;
    const size = db.prepare('PRAGMA page_size').get().page_size;
    return { count, size, bytes: count * size };
  };
  const before = pages();
  db.exec('VACUUM');
  const after = pages();
  return { before, after, freedBytes: Math.max(0, before.bytes - after.bytes) };
}

/**
 * 索引库联动删除（C4/D1⑤）：tasks + task_group_members 同一事务，task_id ∈
 * 最终删除集。automations/off_peak 不删——冲突会话已整体剔除，其 tasks 行保留
 * （D1⑤ 作用域闭合）。索引库不做 VACUUM（设计未要求，报告注记）。
 */
function deleteIndexTasks({ db, ids }) {
  if (ids.length === 0) return { tasksDeleted: 0, membersDeleted: 0 };
  const ph = ids.map(() => '?').join(', ');
  db.exec('BEGIN');
  try {
    const tasksDeleted = db.prepare(`DELETE FROM tasks WHERE task_id IN (${ph})`).run(...ids).changes;
    const membersDeleted = db.prepare(`DELETE FROM task_group_members WHERE task_id IN (${ph})`).run(...ids).changes;
    db.exec('COMMIT');
    return { tasksDeleted, membersDeleted };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 保留原错误 */ }
    throw e;
  }
}

// ---------------------------------------------------- 拒绝文案（§3.1 失败样例）

/** 进程类拒绝（GUI 形态逐字对齐样例第一行）。 */
function renderProcessRefusal(violations) {
  const lines = [];
  const gui = violations.filter((v) => v.kind === 'gui');
  const apps = violations.filter((v) => v.kind === 'app-server');
  const nested = violations.filter((v) => v.kind === 'nested');
  if (gui.length) {
    lines.push(`✗ 前置校验失败：检测到 ZCode 进程（PID ${gui.map((v) => v.pid).join('、')}）正在运行。`);
    lines.push('  运行中清理会与 GUI 内存态冲突。👉 退出 ZCode（含菜单栏常驻）后重跑本命令。');
  }
  if (apps.length) {
    lines.push(`✗ 前置校验失败：检测到 zcode app-server 进程（PID ${apps.map((v) => v.pid).join('、')}）正在运行。`);
    lines.push('  运行中清理会与引擎库写入冲突。👉 退出 ZCode（app-server 进程随之退出）后重跑本命令。');
  }
  if (nested.length) {
    lines.push(`✗ 前置校验失败：检测到嵌套标记进程（ZSW_NESTED=1 / XYZ_AGENT_SUBAGENT=1，PID ${nested.map((v) => v.pid).join('、')}）正在运行。`);
    lines.push('  嵌套环境下清理会被递归触发。👉 回到主会话/非嵌套终端执行本命令。');
  }
  return `${lines.join('\n')}\n`;
}

/** ④ 独占开锁拒绝（D2④ 兜底口径 + lsof 排查指引）。midFlowBackupDir = 删除前
 *  复探测（M5③）拒绝时附当前状态行——备份已落盘、尚未开始删除。 */
function renderLockRefusal(lockFailures, midFlowBackupDir) {
  const lines = ['✗ 前置校验失败：双库独占开锁失败（库仍被其他进程/残留句柄持有）：'];
  for (const f of lockFailures) lines.push(`  ${f.label}：${f.message}`);
  lines.push('  D2④ 兜底：无进程名的持库 fd / crash 残留句柄由此拦截。'
    + '👉 确认全部 ZCode 进程退出后重跑；仍失败用 lsof <库路径> 排查持锁方。');
  if (midFlowBackupDir) lines.push(`  当前状态：尚未开始删除，备份安全网已先行落盘：${midFlowBackupDir}。`);
  return `${lines.join('\n')}\n`;
}

/** 并发 clean 锁忙拒绝（M4；错误详情含 PID/锁文件路径/恢复动作，由
 *  acquireCleanLock 组装，此处只加拒绝头）。 */
function renderLockBusyRefusal(message) {
  return `✗ 无法开始清理：${message}\n`;
}

/** 污染哨兵拒绝（§3.1 失败样例逐字，与 renderDryRun 同文案）。 */
function renderSentinelRefusal(intersection) {
  const show = intersection.slice(0, 8);
  const more = intersection.length > show.length ? ' …' : '';
  return [
    `✗ 污染哨兵失败：删除集 ∩ targetSessionId 值域 = ${intersection.length}（${show.join(' / ')}${more}）。`,
    '  命中可能是识别器污染（C6-被否：targetSessionId 是 zsw 调用方宿主会话=用户真实会话），',
    '  也可能是嵌套调用的合法重叠（zsw 会话充当另一次 zsw 调用的宿主）。👉 中止不改库；',
    '  逐条核查命中会话的 directory/标题后，把 dry-run 清单交维护者判定。',
  ].join('\n') + '\n';
}

/** 磁盘三段拒绝（§3.1 失败样例形态 + --fs-only 指引；pre-vacuum 附中流状态行）。 */
function renderDiskRefusal(stage, { free, needed, dbBytesTotal, backupBytes, midFlow }) {
  const backup = backupBytes || 0;
  let head;
  if (stage === 'pre-backup') {
    head = `✗ 前置校验失败：备份前剩余空间不足——剩余 ${fmtBytes(free)} < 需要 ${fmtBytes(needed)}`
      + `（库三件套 ${fmtBytes(dbBytesTotal)}×1.1）。`;
  } else if (stage === 'pre-delete') {
    head = `✗ 前置校验失败：删除前剩余空间不足——备份已占 ${fmtBytes(backup)}，`
      + `剩余 ${fmtBytes(free - backup)} < 需要 1GB。`;
  } else {
    head = `✗ 前置校验失败：VACUUM 前剩余空间不足——备份已占 ${fmtBytes(backup)}，`
      + `剩余 ${fmtBytes(free - backup)} < 需要 ${fmtBytes(needed)}（库三件套 ${fmtBytes(dbBytesTotal)}×1.1）。`;
  }
  const lines = [head];
  if (stage === 'pre-vacuum') {
    lines.push('  当前状态：引擎库删除与 GUI 索引联动均已提交生效，VACUUM 未执行——删除已生效但空间尚未回收。');
  }
  lines.push('  备份 + VACUUM 临时空间峰值 ≈ 2× 库体积（分阶段校验见 D4）。👉 先跑');
  lines.push('  zsw doctor clean --fs-only 清文件面腾空间，再重跑全量 clean。');
  lines.push('  注意 --fs-only 同样执行全量停机校验——artifacts 删除会破坏运行中会话的转录引用，');
  lines.push('  log 删除破坏写入句柄，不停机一样不安全，不设豁免。');
  // M1③：指引顺序——先 --fs-only（不动备份安全网），删备份降为最后手段
  lines.push('  仍不足时：确认放弃回滚后才可删除备份目录（备份是回滚唯一安全网，最后手段）。');
  if (midFlow) lines.push('  备份保留在原位（回滚安全网仍在）。');
  return `${lines.join('\n')}\n`;
}

/**
 * SQLITE_TMPDIR 同卷失败（D4 临时卷纪律）。文案指向 maintenance 目录（一致性
 * 审查修复：该拒绝发生在备份之前——旧指引「手工把备份目录与库迁至同卷」引用
 * 了尚不存在的备份目录对象，误导）。
 */
function renderTmpdirRefusal(tmp, maintenanceDir) {
  return [
    '✗ 前置校验失败：SQLITE_TMPDIR 无法钉到与库同卷'
      + `（库卷 dev=${tmp.dbDev} / 临时目录 dev=${tmp.tmpDev}）。`,
    `  SQLite 临时文件落盘卷由 SQLITE_TMPDIR 决定，分卷环境下校验的卷和断粮的卷可能不是同一个（D4）。`,
    `  👉 检查 ${maintenanceDir}（本命令的 SQLITE_TMPDIR 临时目录所在，本次尚未产生备份）是否被独立挂载，`,
    '  否则把 maintenance 目录（或整个 ~/.zcode/zsw）迁至与库同卷后重跑。',
  ].join('\n') + '\n';
}

// ---------------------------------------------------- 成功样张渲染（§3.1 第三代码块）

const RESTORE_GUIDANCE = [
  '完成。如有异常，还原：①退出 ZCode；②删除原位 db.sqlite/-wal/-shm 与',
  'tasks-index.sqlite/-wal/-shm；③将备份目录三件套整组 cp 回原路径（半套覆盖会产生',
  'WAL 不一致）。确认无异常后 zsw doctor clean --purge-backup 释放备份空间。',
].join('\n');

/** ✓ 前置校验行（四项 + 磁盘三段 + SQLITE_TMPDIR；fs-only 形态注明豁口）。开锁探测
 *  跳过的库逐一如实注记（M3：缺失 ≠ 有锁；REG-1：损坏 ≠ 有锁——按 reason 区分
 *  文案，不伪装「开锁成功」）。 */
function lockSkipNote(shutdown) {
  const skipped = shutdown && Array.isArray(shutdown.lockSkipped) ? shutdown.lockSkipped : [];
  return skipped.length
    ? `（${skipped.map((x) => `${x.label}${x.reason === 'suspect-corrupt' ? '疑似损坏/非库文件' : '缺文件'}，开锁探测跳过 n/a`).join('、')}）`
    : '';
}

/** ✓ 前置校验行（四项 + 磁盘三段 + SQLITE_TMPDIR；fs-only 形态注明豁口）。 */
function renderPreflightLine(report) {
  const s = report.shutdown;
  if (report.fsOnly) {
    return '✓ 前置校验：ZCode GUI / zcode app-server / 嵌套标记子进程（ZSW_NESTED、XYZ_AGENT_SUBAGENT）均未运行；双库独占开锁成功'
      + `${lockSkipNote(s)}\n`
      + '  （--fs-only：库操作已跳过——磁盘三段校验与 SQLITE_TMPDIR 仅全量 clean 需要）';
  }
  const stages = report.disk.stages.map((st) => {
    if (st.stage === 'pre-backup') {
      return `备份前剩余 ${fmtBytes(st.free)} ≥ 库三件套×1.1（${fmtBytes(st.needed)}）`;
    }
    if (st.stage === 'pre-delete') {
      return `删除前「剩余−备份」${fmtBytes(st.base)} ≥ 1GB`;
    }
    return `VACUUM 前「剩余−备份」${fmtBytes(st.base)} ≥ 库三件套×1.1（${fmtBytes(st.needed)}）`;
  }).join('；');
  return '✓ 前置校验：ZCode GUI / zcode app-server / 嵌套标记子进程（ZSW_NESTED、XYZ_AGENT_SUBAGENT）均未运行；双库独占开锁成功'
    + `${lockSkipNote(s)}；\n`
    + `  磁盘三段校验过（${stages}）；\n`
    + `  SQLITE_TMPDIR 已钉死与库同卷（${report.disk.sqliteTmpdir.dir}）`;
}

/** 执行成功报告的人读渲染（样张结构 + 实测数字）。 */
function renderCleanReport(report) {
  const lines = [];
  // --stale 档位行（缺省形态不输出——§3.1 执行样张逐字保持；文件面档位不跟随
  // 的边界在档位行显式化，与 dry-run 渲染同口径）
  if (report.staleMode === true) {
    lines.push(`档位：--stale 周期维护（--older-than ${fmtCount(report.olderThanDays)} 天）——删除集缩到超龄部分；`
      + '文件面档位不跟随（log 保留 14 天 / exec 空壳 7 天）');
  }
  lines.push(renderPreflightLine(report));

  const sen = report.identify.sentinel;
  lines.push(`✓ 污染哨兵：删除集 ∩ targetSessionId 值域 = ${sen.intersection.length}`
    + '（该哨兵把 R2 审查发现的 targetSessionId 污染模式固化为防线——污染与嵌套合法重叠都会在此拦截）');

  const cf = report.identify.conflicts;
  const removed = cf.removed || [];
  if (removed.length > 0) {
    lines.push(`✓ 索引冲突预检：命中 ${cf.members.length + cf.automations.length + cf.offPeak.length} 条`
      + ` → 冲突会话 ${removed.length} 个已从双库删除集整体剔除`
      + `（${removed.map((r) => `${r.id}[${r.source}]`).join('、')}）；`);
    lines.push('  其 tasks 行与引擎 session 行均保留，下次 clean 重查后自然纳入（D1⑤ 作用域闭合）');
  } else {
    lines.push('✓ 索引冲突预检：members / automations / off_peak 命中 0 条'
      + '（机制保留：命中即冲突会话从双库删除集整体剔除 + 报告）');
  }

  if (report.fsOnly) {
    const f = report.files.result;
    const p = report.files.plan;
    lines.push(`✓ 文件面（--fs-only，库操作已跳过、未做备份）：`
      + `artifacts ${fmtCount(f.artifacts.deletedCount)} 目录、log 按龄 ${fmtCount(f.log.deletedCount)} 文件、`
      + `exec sess_ ${fmtCount(f.exec.deletedCount)} 目录（含超龄空壳，plan ${fmtCount(p.execStaleEmpty.length)}）`);
    lines.push(`完成（--fs-only）。失败 ${fmtCount(f.totalFailureCount)} 项（详见 --json 报告 failures）。`);
    return `${lines.join('\n')}\n`;
  }

  const b = report.backup;
  lines.push(`✓ 快照备份：${b.dir}/ 内双库三件套共 ${fmtCount(b.files.length)} 文件 ~${fmtBytes(b.totalBytes)}`
    + (b.pruned.length ? `（旧备份已清 keep-1：${b.pruned.join('、')}）` : '（旧备份已清 keep-1）'));

  const e = report.engine;
  const perTableTotal = Object.values(e.perTable).reduce((x, y) => x + y, 0);
  const vacuumLine = e.vacuum
    ? `VACUUM 完成（${fmtBytes(e.vacuum.before.bytes)}→${fmtBytes(e.vacuum.after.bytes)}，回收 ${fmtBytes(e.vacuum.freedBytes)}）`
    : 'VACUUM 未执行（磁盘校验③未过——逻辑删除已生效，空间未回收，见上方失败原因）';
  lines.push(`✓ 引擎库：分块删除（${fmtCount(e.chunks.length)} 批 × ≤${e.chunkSize} 会话，`
    + '批间 PASSIVE checkpoint——PASSIVE 不截断 -wal，checkpoint 有效性以批级行数为准）'
    + `session ${fmtCount(e.sessionDeleted)} 行 + 13 表列级联动；`);
  lines.push(`  （CASCADE 8 表 ${fmtCount(perTableTotal)} 行 / part 经 message 级联 ${fmtCount(e.partCascaded)} 行 /`
    + ` session_task_link child 删 ${fmtCount(e.sessionTaskLinkDeleted)} 行 + parent 置空 ${fmtCount(e.sessionTaskLinkParentNull)} 行 /`);
  lines.push(`   workflow_run 置空 ${fmtCount(e.workflowRunNull)} 行 / workflow_activity 置空 ${fmtCount(e.workflowActivityNull)} 行 /`
    + ` input_history 随删 ${fmtCount(e.inputHistoryDeleted)} 行）；`);
  lines.push(`  ${vacuumLine}`);

  const idx = report.index;
  // input_history 是引擎库表（计数在上方「✓ 引擎库」行内），不挂 GUI 索引行
  lines.push(`✓ GUI 索引：删除 tasks ${fmtCount(idx.tasksDeleted)} 行`
    + '（索引库不做 VACUUM——设计未要求）');

  const fr = report.files.result;
  lines.push(`✓ 文件面：artifacts ${fmtCount(fr.artifacts.deletedCount)} 目录、`
    + `log 按龄 ${fmtCount(fr.log.deletedCount)} 文件、exec sess_ ${fmtCount(fr.exec.deletedCount)} 目录`);

  lines.push(RESTORE_GUIDANCE);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------- 编排入口

/** 缺省路径组装：引擎侧统一走 config.resolveEnginePaths 单一权威源
 *  （doctor/clean-fs/clean-exec 同源消费）；zsw 侧 records/maintenance 归
 *  config.zswRoot；全部可被 options 覆盖。 */
function resolvePaths(options) {
  const defaults = resolveEnginePaths();
  return {
    engineDbPath: options.engineDbPath || defaults.engineDbPath,
    indexDbPath: options.indexDbPath || defaults.indexDbPath,
    recordsPath: options.recordsPath || defaultRecordsPath(),
    artifactsDir: options.artifactsDir || defaults.artifactsDir,
    logDir: options.logDir || defaults.logDir,
    execDir: options.execDir || defaults.execDir,
    maintenanceDir: options.maintenanceDir || defaultMaintenanceDir(),
  };
}

/**
 * doctor clean 执行编排入口（步骤 0-17 见文件头注）。任何拒绝/失败路径都返回
 * {text, json, exitCode} 而非 throw（拒绝是正常输出面；exitCode 承载语义）；
 * 仅 node:sqlite 不可用/ps 不可用/识别管线 coded 错误等环境级错误照 doctor
 * 先例 throw（CLI 捕获）。
 *
 * M4：锁覆盖 clean 执行全程（含 --fs-only 的不可逆文件删除），先于一切写面
 * 动作——并发 clean 的 keep-1 prune 会互删对方备份安全网。锁忙是拒绝输出面
 * （exit 1 文案）；锁的建/删本身异常照环境级错误上抛。
 *
 * @param {object} options 路径注入（resolvePaths）+ fsOnly / staleMode（--stale
 *   周期维护档，边界见文件头注）/ olderThanDays / now
 *   / psText（停机校验注入）/ freeBytesFn(volumePath, stage)（磁盘校验注入）/
 *   devFn(p)（SQLITE_TMPDIR 同卷判定的 dev 采集注入，仅测试）/
 *   afterBatch（分块观测钩子）/ chunkSize
 * @returns {{text, json, exitCode}}
 */
function runClean(options = {}) {
  const { DatabaseSync } = loadSqlite();
  const paths = resolvePaths(options);
  const fsOnly = options.fsOnly === true;
  const staleMode = options.staleMode === true;
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const freeBytesFn = typeof options.freeBytesFn === 'function' ? options.freeBytesFn : freeBytesOnVolume;
  const chunkSize = typeof options.chunkSize === 'number' && options.chunkSize > 0
    ? options.chunkSize : DEFAULT_CHUNK_SIZE;

  const diskStages = [];

  const report = {
    generatedAt: new Date(now).toISOString(),
    fsOnly,
    staleMode,
    olderThanDays: typeof options.olderThanDays === 'number' ? options.olderThanDays : DEFAULT_OLDER_THAN_DAYS,
    paths,
    shutdown: null,
    identify: null,
    deleteSet: null,
    disk: { stages: diskStages, sqliteTmpdir: null }, // 同一数组引用：渲染时已含全部已过阶段
    backup: null,
    engine: null,
    index: null,
    files: null,
    // 锁忙拒绝形态字段（REG-3：恒在——JSON.stringify 丢 undefined 键，机读方
    // 需区分「拒绝类型/持锁方」与「未拒绝」；成功路径恒 null）
    refusal: null,
  };
  const finish = (text, exitCode) => {
    report.exitCode = exitCode;
    return { text, json: report, exitCode };
  };
  const refuse = (text) => finish(text, 1);

  // 0. M4 跨进程互斥（--purge-backup 路径在 purgeLatestBackup 内单独受锁）
  let lockPath;
  try {
    lockPath = acquireCleanLock(paths.maintenanceDir);
  } catch (e) {
    if (e && e.code === 'CLEAN_LOCK_BUSY') {
      // 机读拒绝载体（REG-3）：text 面不变，--json 形态经 refusal 字段区分拒绝类型
      report.refusal = { kind: 'CLEAN_LOCK_BUSY', pid: e.pid === undefined ? null : e.pid, lockPath: e.lockPath || null };
      return refuse(renderLockBusyRefusal(e.message));
    }
    throw e;
  }
  try {
    return runCleanLocked({ options, paths, report, refuse, finish, fsOnly, staleMode, now, freeBytesFn, chunkSize, diskStages });
  } finally {
    releaseCleanLock(lockPath);
  }
}

/**
 * 步骤 1-7 + 委派 runDbFlow（锁已持有）。M6 修复：停机校验（1）先于删除集构建
 * （2）——识别管线的索引库读失败（coded）必须发生在停机确认之后。
 */
function runCleanLocked(ctx) {
  const { options, paths, report, refuse, finish, fsOnly, staleMode, now, freeBytesFn, chunkSize, diskStages } = ctx;
  let tmp = null;

  // 1. 四项停机校验（D2；fs-only 不豁免）
  const shutdown = runShutdownChecks({
    engineDbPath: paths.engineDbPath,
    indexDbPath: paths.indexDbPath,
    psText: options.psText,
  });
  report.shutdown = shutdown;
  if (!shutdown.ok) {
    if (shutdown.processViolations.length > 0) return refuse(renderProcessRefusal(shutdown.processViolations));
    return refuse(renderLockRefusal(shutdown.lockFailures));
  }

  // 2. 五类分治（只读；fs-only 也需要删除集做文件面 id 匹配）
  // M5 备份源快照：停机确认后立即固化双库既有三件套清单——识别管线 readOnly
  // 连接留下的瞬态 -wal/-shm 不得混入备份拷贝集（见 collectBackupSources 头注）
  const backupSources = collectBackupSources({ engineDbPath: paths.engineDbPath, indexDbPath: paths.indexDbPath });
  const initial = buildDeleteSet({
    engineDbPath: paths.engineDbPath,
    indexDbPath: paths.indexDbPath,
    recordsPath: paths.recordsPath,
    olderThanDays: report.olderThanDays,
    staleMode,
    now,
  });

  // 3. 污染哨兵复断言（剔除前原始集——R2 教训；样本失败文案逐字）
  const sentinel = checkSentinel(initial, paths.recordsPath);
  // 4. 索引冲突预检 + 双库整体剔除（最终集）
  const conflicts = checkIndexConflicts(initial.engineSessionIds, paths.indexDbPath);
  const { deleteSet: finalSet, removed } = excludeConflicts(initial, conflicts);
  const finalIds = [...finalSet.engineSessionIds].sort();
  const finalIndexIds = [...finalSet.indexTaskIds].sort();
  report.identify = {
    sentinel,
    conflicts: {
      available: conflicts.available,
      members: conflicts.members,
      automations: conflicts.automations,
      offPeak: conflicts.offPeak,
      removed,
    },
  };
  report.deleteSet = {
    engineSessionIds: finalIds,
    byClass: finalSet.byClass,
    indexTaskIds: finalIndexIds,
  };
  if (!sentinel.ok) return refuse(renderSentinelRefusal(sentinel.intersection));

  const plan = planFileCleanup({
    engineSessionIds: finalSet.engineSessionIds,
    artifactsDir: paths.artifactsDir,
    logDir: paths.logDir,
    execDir: paths.execDir,
    now,
  });

  // 5. --fs-only：停机校验已全查，跳过库操作只走文件面
  if (fsOnly) {
    const result = executeFileCleanup(plan, {
      artifactsDir: paths.artifactsDir, logDir: paths.logDir, execDir: paths.execDir,
    });
    report.files = { plan, result };
    return finish(renderCleanReport(report), result.totalFailureCount > 0 ? 1 : 0);
  }

  // 引擎库必须存在（禁静默空删——删除连接会凭空建库）。防御性冗余（一致性
  // 审查补强：与前置拦截同语义 fail-closed）：正常路径识别管线（缺库 DB_OPEN_FAILED 先抛）
  // 已先行拦截，停机校验④对缺失跳过（缺文件 ≠ 有锁，M3），不应到达此处；保留只为
  // 守住下方删除连接 new DatabaseSync 对缺文件凭空建空库的空洞形态。
  if (!fs.existsSync(paths.engineDbPath)) {
    return refuse([
      `✗ 防御拦截：引擎库不存在：${paths.engineDbPath}（防御性冗余——识别管线已先行拦截，正常路径不应到达此处）。`,
      '  👉 先跑 node bin/zsw.js doctor 确认各面状态；库缺失时 clean 无事可做（禁静默空删）。',
    ].join('\n') + '\n');
  }

  // 6. 磁盘校验① 备份前
  const dbBytesTotal = tripleBytes(paths.engineDbPath) + tripleBytes(paths.indexDbPath);
  const volumePath = path.dirname(paths.engineDbPath);
  const free0 = freeBytesFn(volumePath, 'pre-backup');
  const st1 = evalDiskStage('pre-backup', { free: free0, dbBytesTotal, backupBytes: 0 });
  diskStages.push({ stage: 'pre-backup', ok: st1.ok, free: free0, needed: st1.needed, base: st1.base, backupBytes: 0 });
  if (!st1.ok) return refuse(renderDiskRefusal('pre-backup', { free: free0, needed: st1.needed, dbBytesTotal }));

  // 7. SQLITE_TMPDIR 同卷钉死（8-17 全程包 try/finally：拒绝/失败/成功路径都还原
  //    env + 清临时目录）。同卷失败拒绝路径同样先 teardown 再 return（一致性
  //    审查修复：补此 teardown 防 tmp-<ts> 空目录无人清理、反复触发累积残留；
  //    env 未被设置时 teardown 仅删目录，安全）。
  tmp = setupSqliteTmpdir({
    maintenanceDir: paths.maintenanceDir,
    engineDbPath: paths.engineDbPath,
    devFn: options.devFn, // undefined 时取真 devOfPath（仅测试注入）
  });
  report.disk.sqliteTmpdir = { dir: tmp.dir, sameVolume: tmp.sameVolume };
  if (!tmp.sameVolume) {
    teardownSqliteTmpdir(tmp);
    report.disk.sqliteTmpdir.cleaned = true;
    return refuse(renderTmpdirRefusal(tmp, paths.maintenanceDir));
  }
  try {
    const outcome = runDbFlow({ options, paths, report, refuse, finish, finalIds, finalIndexIds, finalSet, plan, dbBytesTotal, volumePath, freeBytesFn, chunkSize, diskStages, backupSources });
    return outcome;
  } finally {
    teardownSqliteTmpdir(tmp);
    report.disk.sqliteTmpdir.cleaned = true;
  }
}

/**
 * 步骤 8-17 编排（备份与删除前门禁见 runBackupAndGates、删除执行体见
 * runDeleteAndVacuum、成功收尾见 finishCleanSuccess）。独立成函数使
 * SQLITE_TMPDIR 的 try/finally 覆盖全部拒绝路径。
 */
function runDbFlow(ctx) {
  const { options, paths, report, refuse, finish, finalIds, finalIndexIds, finalSet, plan, dbBytesTotal, volumePath, freeBytesFn, chunkSize, diskStages, backupSources } = ctx;

  // 8-11. 备份 + 删除前门禁（索引存在防御 → 磁盘② → ④ 复探测）——任一拒绝即返回
  const pre = runBackupAndGates({ paths, report, refuse, dbBytesTotal, volumePath, freeBytesFn, diskStages, backupSources });
  if (pre.refusal) return pre.refusal;

  // 12-15. 引擎分块删除 → 索引联动（先于磁盘③/VACUUM，设计 §5 F3 顺序）→ 磁盘③ → VACUUM
  const flow = runDeleteAndVacuum({ options, paths, finalIds, finalIndexIds, dbBytesTotal, backup: pre.backup, volumePath, freeBytesFn, chunkSize, diskStages });
  report.index = flow.indexCounts;
  report.engine = flow.engineCounts
    ? { ...flow.engineCounts, chunkSize, vacuum: flow.vacuum }
    : { chunkSize, vacuum: null, error: flow.engineError && flow.engineError.message };

  if (flow.engineError || flow.indexError || flow.vacuumError) {
    const kind = flow.engineError ? 'engine' : (flow.indexError ? 'index' : 'vacuum');
    const error = flow.engineError || flow.indexError || flow.vacuumError;
    return finish(renderMidFlowFailure(kind, error, pre.backup.backupDir), 1);
  }
  if (!flow.st3.ok) {
    return refuse(renderDiskRefusal('pre-vacuum', {
      free: flow.free2, needed: flow.st3.needed, dbBytesTotal, backupBytes: pre.backup.totalBytes, midFlow: true,
    }));
  }
  return finishCleanSuccess({ report, finish, finalIds, finalIndexIds, finalSet, plan });
}

/**
 * 步骤 8-11：三件套一致性备份 + keep-1 → 索引库存在防御拦截 → 磁盘校验② →
 * ④ 独占开锁复探测。拒绝路径返回 {refusal}；通过返回 {backup}。
 */
function runBackupAndGates({ paths, report, refuse, dbBytesTotal, volumePath, freeBytesFn, diskStages, backupSources }) {
  // 8. 三件套一致性备份 + keep-1（M5：锁窗口内一致拷贝；失败清理半成品后重抛）
  const backupDir = path.join(paths.maintenanceDir, `backup-${timestamp()}`);
  const backup = backupDatabases({ engineDbPath: paths.engineDbPath, indexDbPath: paths.indexDbPath, backupDir, sources: backupSources });
  const pruned = pruneOldBackups({ maintenanceDir: paths.maintenanceDir, keepName: path.basename(backupDir) });
  report.backup = { dir: backupDir, files: backup.files, totalBytes: backup.totalBytes, pruned };

  // 9. 索引库必须存在（删除面防御）：停机校验④对缺失跳过（缺文件 ≠ 有锁，M3）、
  //    识别管线 n/a 容忍，但删除连接对缺文件会凭空建空库——任何删除开始前
  //    fail-closed。此处尚未删除，无「引擎已删索引未动」撕裂态。
  if (!fs.existsSync(paths.indexDbPath)) {
    return { refusal: refuse([
      `✗ 防御拦截：索引库不存在：${paths.indexDbPath}（删除面 fail-closed——删除连接对缺文件会凭空建空库）。`,
      `  当前状态：尚未开始任何删除，无撕裂态；备份已先行落盘：${backupDir}。`,
      '  👉 确认索引库路径正确（缺省 = ~/.zcode/v2/tasks-index.sqlite）；本机 GUI 从未运行、索引库确不存在时，',
      '  引擎面也无 GUI tasks 残留可联动——维护者确认后可 zsw doctor clean --purge-backup 释放本次备份。',
    ].join('\n') + '\n') };
  }

  // 10. 磁盘校验② 删除前（基准时点 = 备份完成后实算）
  const free1 = freeBytesFn(volumePath, 'pre-delete');
  const st2 = evalDiskStage('pre-delete', { free: free1, dbBytesTotal, backupBytes: backup.totalBytes });
  diskStages.push({ stage: 'pre-delete', ok: st2.ok, free: free1, needed: st2.needed, base: st2.base, backupBytes: backup.totalBytes });
  if (!st2.ok) {
    return { refusal: refuse(renderDiskRefusal('pre-delete', {
      free: free1, needed: st2.needed, dbBytesTotal, backupBytes: backup.totalBytes,
    })) };
  }

  // 11. ④ 独占开锁复探测（M5③）：停机校验是时点探测，到删除连接间隔可达分钟级
  //     （多 GB 库备份），本步为删除连接打开前最后一道门禁，重跑收窄无写者窗口。
  //     拒绝态 = 备份在、零删除。
  const reprobe = checkExclusiveLocks({ engineDbPath: paths.engineDbPath, indexDbPath: paths.indexDbPath });
  if (!reprobe.ok) {
    return { refusal: refuse(renderLockRefusal(reprobe.failures, backupDir)) };
  }
  return { backup };
}

/** 步骤 16-17：文件面 plan + execute → 对账 counts → 报告渲染（A-4 同构）。 */
function finishCleanSuccess({ report, finish, finalIds, finalIndexIds, finalSet, plan }) {
  const fileResult = executeFileCleanup(plan, {
    artifactsDir: report.paths.artifactsDir, logDir: report.paths.logDir, execDir: report.paths.execDir,
  });
  report.files = { plan, result: fileResult };

  report.counts = {
    whitelist: finalSet.byClass.whitelist.length,
    feature: finalSet.byClass.feature.length,
    subagentChildStale: finalSet.byClass.subagentChildStale.length,
    engineSessionIds: finalIds.length,
    indexTaskIds: finalIndexIds.length,
    inputHistoryHits: report.engine.inputHistoryDeleted,
    artifacts: plan.artifacts.length,
    execInSet: plan.execInSet.length,
    execStaleEmpty: plan.execStaleEmpty.length,
    logFiles: plan.logFiles.length,
  };
  const exitCode = fileResult.totalFailureCount > 0 ? 1 : 0;
  let text = renderCleanReport(report);
  if (exitCode === 1) {
    text += `\n⚠ 文件面清理有 ${fileResult.totalFailureCount} 项失败（库侧已完成；`
      + `闭合核对 planned=${fileResult.artifacts.planned + fileResult.exec.planned + fileResult.log.planned}`
      + ` = deleted ${fileResult.totalDeletedCount} + failures ${fileResult.totalFailureCount}）。`
      + '详情见 --json 报告逐项 failures。\n';
  }
  return finish(text, exitCode);
}

/**
 * 步骤 12-15 执行体：引擎分块删除 → 索引联动 → 磁盘③ → VACUUM。三阶段错误
 * 分开捕获（engineError / indexError / vacuumError）——失败报告按阶段如实区分
 * （M1：VACUUM 失败 ≠ 删除中止，不得输出整库回滚指引误导）。
 * 索引联动紧随引擎删除、先于磁盘③/VACUUM（M1 回归设计 §5 F3 编排序）：旧序下
 * pre-vacuum 拒绝/引擎中途中止两条路径停在「引擎行已删、tasks 行未删」，且重跑
 * 不补删（识别集只收引擎库现存会话，已删会话的 tasks 行进不了重跑删除集）。
 * @returns {{engineCounts, engineError, indexError, vacuumError, vacuum, st3, free2}}
 */
function runDeleteAndVacuum({ options, paths, finalIds, finalIndexIds, dbBytesTotal, backup, volumePath, freeBytesFn, chunkSize, diskStages }) {
  const { DatabaseSync } = loadSqlite();
  const out = { engineCounts: null, engineError: null, indexError: null, indexCounts: null, vacuumError: null, vacuum: null, st3: null, free2: null };

  // 12. 引擎库分块删除（FK ON + 每块一事务 + 批间 PASSIVE checkpoint）
  const db = new DatabaseSync(paths.engineDbPath);
  try {
    // M5②：写连接立即设 busy_timeout——停机校验已确保无运行中写者，取值只需
    // 骑过瞬时锁残留（进程刚退出的锁释放延迟 / WAL 恢复），不把停机窗口卡成悬挂
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA foreign_keys = ON');
    out.engineCounts = deleteEngineSessionsChunked({
      db, ids: finalIds, chunkSize, afterBatch: options.afterBatch,
    });
  } catch (e) {
    out.engineError = e;
  }

  // 13. 索引库联动（tasks + members 同事务；engineError 时索引面未动——失败文案如实声明）。
  //     REG-2：连接构造（new DatabaseSync）同在 try 内——构造抛错（EACCES/EROFS
  //     窄竞窗）也归 indexError 走 renderMidFlowFailure('index')，不穿透到 CLI
  //     main catch 绕过三态渲染。
  if (!out.engineError) {
    let idb = null;
    try {
      idb = new DatabaseSync(paths.indexDbPath);
      idb.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      out.indexCounts = deleteIndexTasks({ db: idb, ids: finalIndexIds });
    } catch (e) {
      out.indexError = e;
    } finally {
      try { if (idb) idb.close(); } catch { /* 尽力 */ }
    }
  }

  // 14/15. 磁盘校验③（基准 = 删除完成后）+ VACUUM（同一连接、无活跃事务；C2）
  try {
    if (!out.engineError && !out.indexError) {
      out.free2 = freeBytesFn(volumePath, 'pre-vacuum');
      out.st3 = evalDiskStage('pre-vacuum', { free: out.free2, dbBytesTotal, backupBytes: backup.totalBytes });
      diskStages.push({
        stage: 'pre-vacuum', ok: out.st3.ok, free: out.free2, needed: out.st3.needed, base: out.st3.base, backupBytes: backup.totalBytes,
      });
      if (out.st3.ok) out.vacuum = vacuumEngineDb(db);
    }
  } catch (e) {
    out.vacuumError = e;
  } finally {
    try { db.close(); } catch { /* 尽力关闭 */ }
  }
  return out;
}

/**
 * 中流失败三态文案（M1：错误 → 阶段事实 → 恢复动作，按完成度如实区分；
 * 「重跑只处理剩余部分，幂等」对索引面是假承诺——已删会话的 tasks 行不在
 * 重跑识别集内，统一改为手工核查指引，不再出现「幂等」字样）。
 */
function renderMidFlowFailure(kind, error, backupDir) {
  const message = (error && error.message) || String(error);
  if (kind === 'engine') {
    return [
      `✗ 清理执行失败：${message}`,
      `  当前阶段：引擎库删除中止于事务边界（已提交的批次保持生效），索引侧联动尚未执行；备份安全网在：${backupDir}`,
      '  重跑不补删索引面：重跑识别集只收引擎库现存会话，已删会话的 GUI tasks 行不会进入重跑删除集。',
      '  👉 按还原指引整库回滚后重跑（索引面一并重来）；或接受删除现状，对照 --json 报告 deleteSet.indexTaskIds',
      '  手工核查索引残留（sqlite3 -readonly ~/.zcode/v2/tasks-index.sqlite 逐条核对孤儿 tasks 行）。',
      RESTORE_GUIDANCE,
    ].join('\n') + '\n';
  }
  if (kind === 'index') {
    return [
      `✗ 清理执行失败：GUI 索引联动删除失败：${message}`,
      `  当前阶段：引擎库删除已全部提交生效，索引库联动在事务边界中止（tasks/task_group_members 行未删，单事务原子）；备份安全网在：${backupDir}`,
      '  重跑不补删索引面：重跑识别集只收引擎库现存会话，已删会话的 GUI tasks 行不会进入重跑删除集。',
      '  👉 按还原指引整库回滚后重跑；或接受删除现状，对照 --json 报告 deleteSet.indexTaskIds 手工核查索引残留。',
      RESTORE_GUIDANCE,
    ].join('\n') + '\n';
  }
  return [
    `✗ 清理执行失败：VACUUM 失败：${message}`,
    `  当前阶段：删除已全部完成（引擎库 + GUI 索引联动均生效），仅空间回收未完成；备份安全网在：${backupDir}`,
    '  👉 无需回滚：排除磁盘/环境问题后直接重跑 zsw doctor clean——删除集为空，直达 VACUUM 重试。',
  ].join('\n') + '\n';
}

module.exports = {
  // D2 停机校验
  parsePsLines,
  classifyProcessViolations,
  collectPsText,
  isGuiCommand,
  isAppServerCommand,
  isNestedCommand,
  checkExclusiveLocks,
  runShutdownChecks,
  // D4 磁盘
  freeBytesOnVolume,
  devOfPath,
  tripleBytes,
  evalDiskStage,
  setupSqliteTmpdir,
  teardownSqliteTmpdir,
  // D3 备份
  backupDatabases,
  listBackupDirs,
  findLatestBackupName,
  pruneOldBackups,
  purgeLatestBackup,
  // 执行
  deleteEngineSessionsChunked,
  vacuumEngineDb,
  deleteIndexTasks,
  runClean,
  renderCleanReport,
  // M4 锁生命周期原语（导出增量：锁生命周期单测直接消费，不破坏既有导出面）
  CLEAN_LOCK_FILENAME,
  cleanLockPath,
  pidAlive,
  readCleanLockInfo,
  acquireCleanLock,
  releaseCleanLock,
  // 常量
  CASCADE_SESSION_TABLES,
  DEFAULT_CHUNK_SIZE,
  TRIPLE_SUFFIXES,
};
