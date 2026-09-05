'use strict';
/**
 * 文件面清理（u4 = 设计 docs/design/zsw-session-residue-cleanup-design.md
 * §3.3 D7 / D1④，§2.1 面③④⑤）：artifacts / exec / log 三目录的 plan（只读
 * 计划）与 execute（执行删除）两段式——u3 编排（lib/clean-exec.js）可在停机
 * 校验通过后先 plan、报告、再 execute。本模块不碰任何 sqlite 库（纯 node:fs），
 * 删除集 engineSessionIds 由 u2 buildDeleteSet 产出后注入。
 *
 * 防误删三纪律（设计 D7，全部机械可断言）：
 *   1. artifacts 精确 id 匹配：目录名 ∈ engineSessionIds（readdir 目录名字符串
 *      精确相等，无任何模糊/子串/前缀语义）；
 *   2. exec 限 sess_ 前缀：∈ 删除集的与超龄「空壳」都必须以 sess_ 开头
 *      （bash-startup 等引擎自有目录一律不动，实测存在于 exec/，D7 被否谱系）；
 *      空壳保守判定 = 递归树内文件数为 0（有任何文件/symlink 即非空壳不删；
 *      readdir 失败按非空壳处理——状态不明不动手）；
 *   3. log 整文件按龄删：mtime 早于保留窗的文件整文件删除，不解析不截断内容
 *      （log 是引擎全局诊断面，动内容会破坏当日写入句柄，D7）。
 *
 * 与 lib/doctor.js collectFiles 的计数口径一致性（clean-fs.test.js 跨模块
 * 用例锁定）：目录计数（artifacts 全量目录 / exec 只数 sess_ 前缀）、超龄定义
 * （mtime **严格早于** now - N*DAY，恰等于阈值不算）、体积合计（递归正则文件
 * 字节和，readdir/stat 竞态与权限错误跳过）三处同语义。本模块 engineCliRoot /
 * treeBytesSafe 镜像 doctor.js 同名私有实现（doctor 未导出；且本模块纯文件面
 * 不应经 require('./doctor') 间接背上 node:sqlite 依赖面——clean-identify 的
 * loadSqliteOperational 双实现同款先例），防漂移靠上述跨模块锁定用例。
 *
 * execStaleDays 默认 7 天的依据（设计 D7 只说「超龄空壳」未定档）：对齐 D1①
 * subagent_child 的 7 天保留逻辑（GUI 会话详情页可能引用近期会话的伴生目录）
 * 与 GUI taskAutoArchiveOlderThanDays 默认 7 天——同一「近期引用窗口」语义
 * 取同值，宁保守勿激进。
 *
 * 零依赖 plain Node CJS；根路径全部可注入（测试传 fixture；缺省 os.homedir()
 * 下 ~/.zcode/cli 约定，与 lib/doctor.js engineCliRoot 同源）。真实 ~/.zcode
 * 上只应调用 planFileCleanup（只读）；executeFileCleanup 仅在停机窗口（u3
 * 四项停机校验通过后）对真实路径调用。
 *
 * u3 消费契约（签名稳定性，同 checkSentinel 先例）：
 *   const plan = planFileCleanup({ engineSessionIds: deleteSet.engineSessionIds, ... });
 *   const result = executeFileCleanup(plan, { artifactsDir, logDir, execDir });
 * execute 只消费 plan 清单项（name/bytes），不重扫文件系统——报告与执行严格
 * 对账同一份清单（planned = deletedCount + failures.length 恒闭合）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 一天的毫秒数（按龄判定的基准单位，clean-identify 同值）。 */
const DAY_MS = 24 * 60 * 60 * 1000;
/** log 按文件年龄整文件删，默认保留 14 天（设计 §3.3 D7；doctor.LOG_RETENTION_MS 同源）。 */
const DEFAULT_LOG_RETENTION_DAYS = 14;
/** exec 空壳按龄档阈值，默认 7 天（依据见头注；与 D1① 7 天保留同源）。 */
const DEFAULT_EXEC_STALE_DAYS = 7;

/** 引擎侧 ~/.zcode/cli 根（doctor.js engineCliRoot 同款镜像，见头注）。 */
function engineCliRoot() {
  return path.join(os.homedir(), '.zcode', 'cli');
}

/** 数值天数选项归一（buildDeleteSet olderThanDays 同款：非有限/负值 → 默认）。 */
function daysOption(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value : fallback;
}

/**
 * 删除集归一：Set 原样收，Array 转 Set（u2 buildDeleteSet 产 Set；容忍调用方
 * 传数组）。其他类型 → null（调用面抛可操作错误——缺失时静默按空集处理会让
 * artifacts/execInSet 面无声失效，删除链路禁静默）。
 */
function normalizeIdSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return null;
}

/** 顶层子目录名清单（目录不存在/不可读 → []：该面无候选项，与 doctor n/a 面同口径）。 */
function listTopDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * 递归文件体积合计（du 语义；doctor.js treeBytes 同款镜像——竞态与权限错误
 * 跳过，体检/计划不为个别不可读文件 crash）。
 */
function treeBytesSafe(root) {
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

/**
 * 空壳保守判定（D7 纪律二）：递归树内文件数为 0。任何非目录项（文件/symlink/
 * 其他）即非空壳；readdir 失败（权限等）按非空壳——状态不明不动手。
 */
function isEmptyTree(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) return false;
      stack.push(path.join(cur, ent.name));
    }
  }
  return true;
}

/**
 * log 面超龄文件扫描（D7 纪律三）：递归列正则文件（与 doctor listFiles 递归
 * 口径一致，防嵌套形态漏计），mtime **严格早于** cutoff 才入清单。name = 相对
 * logDir 的路径（真实 log/ 为平铺日文件；嵌套仅为口径完备）。stat 失败跳过
 * （与 doctor collectFiles 的 log 面同口径）。
 */
function staleLogFiles(logDir, cutoff) {
  const out = [];
  const stack = [logDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      if (cur === logDir) return out; // 根目录不可读 → 该面无候选项
      continue;
    }
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) {
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        if (st.mtimeMs < cutoff) out.push({ name: path.relative(logDir, p), bytes: st.size });
      }
    }
  }
  return out;
}

/** name 升序（清单输出确定性，报告与测试可复现）。 */
function byName(a, b) {
  return a.name < b.name ? -1 : 1;
}

/**
 * 文件面只读计划（设计 §3.3 D7 / D1④）：三面扫描，输出可执行清单。
 *
 * ① artifacts：顶层目录名 ∈ engineSessionIds（精确相等，无模糊）；
 * ② exec：双通道均限 sess_ 前缀——
 *      execInSet     目录名 ∈ engineSessionIds（删除集命中：不判龄不判空，
 *                    集内目录无论内容都删——与其会话行删除语义对齐）；
 *      execStaleEmpty 目录名 ∉ 集 且 mtime 严格早于 now - execStaleDays*DAY
 *                    且 isEmptyTree（空壳保守判定）；
 * ③ log：mtime 严格早于 now - logRetentionDays*DAY 的整文件。
 *
 * @param {object} options 全部显式入参：
 *   engineSessionIds（必传，Set|Array；u2 buildDeleteSet().engineSessionIds
 *   并集；确认无误传空集 = 仅按龄/按前缀通道清理）/
 *   logRetentionDays（默认 14）/ execStaleDays（默认 7）/ now（ms，缺省
 *   Date.now()）/ artifactsDir / logDir / execDir（缺省 ~/.zcode/cli/*）。
 * @returns {{artifacts:{name,bytes}[], execInSet:{name,bytes}[],
 *   execStaleEmpty:{name,bytes}[], logFiles:{name,bytes}[],
 *   totalReclaimableBytes:number, scannedAt:string}} bytes = du 语义递归字节
 *   合计（execStaleEmpty 恒 0——空壳按定义无文件）；totalReclaimableBytes =
 *   四清单字节和；scannedAt = 计划时点 ISO。
 */
function planFileCleanup(options = {}) {
  const ids = normalizeIdSet(options.engineSessionIds);
  if (!ids) {
    throw new Error('planFileCleanup 需要 options.engineSessionIds（Set 或 Array；'
      + '传 lib/clean-identify.js buildDeleteSet().engineSessionIds 并集）。'
      + '确认无误时传空集（new Set()）= 仅按龄/按前缀通道清理。');
  }
  const logRetentionDays = daysOption(options.logRetentionDays, DEFAULT_LOG_RETENTION_DAYS);
  const execStaleDays = daysOption(options.execStaleDays, DEFAULT_EXEC_STALE_DAYS);
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const artifactsDir = options.artifactsDir || path.join(engineCliRoot(), 'artifacts');
  const logDir = options.logDir || path.join(engineCliRoot(), 'log');
  const execDir = options.execDir || path.join(engineCliRoot(), 'exec');

  // ① artifacts：精确 id 匹配（D7 纪律一）
  const artifacts = listTopDirs(artifactsDir)
    .filter((name) => ids.has(name))
    .map((name) => ({ name, bytes: treeBytesSafe(path.join(artifactsDir, name)) }))
    .sort(byName);

  // ② exec：sess_ 前缀是两通道共同前置（D7 纪律二）
  const execInSet = [];
  const execStaleEmpty = [];
  const execCutoff = now - execStaleDays * DAY_MS;
  for (const name of listTopDirs(execDir).sort()) {
    if (!name.startsWith('sess_')) continue; // bash-startup 等引擎自有目录一律不动
    const full = path.join(execDir, name);
    if (ids.has(name)) {
      execInSet.push({ name, bytes: treeBytesSafe(full) }); // 集内命中：不判龄不判空
      continue;
    }
    let stale = false;
    try {
      stale = fs.statSync(full).mtimeMs < execCutoff; // 严格早于（恰等于不算，doctor 同口径）
    } catch {
      stale = false; // 状态不明 → 保守不动
    }
    if (stale && isEmptyTree(full)) execStaleEmpty.push({ name, bytes: 0 });
  }

  // ③ log：整文件按龄（D7 纪律三）
  const logFiles = staleLogFiles(logDir, now - logRetentionDays * DAY_MS).sort(byName);

  const totalReclaimableBytes = [...artifacts, ...execInSet, ...execStaleEmpty, ...logFiles]
    .reduce((sum, item) => sum + item.bytes, 0);

  return {
    artifacts,
    execInSet,
    execStaleEmpty,
    logFiles,
    totalReclaimableBytes,
    scannedAt: new Date(now).toISOString(),
  };
}

/**
 * plan 项 name 安全解析：name 必须落在 root 之内（禁空值/绝对路径/.. 逃逸/
 * 指向 root 本身）。返回绝对目标路径，非法 → null（调用面进 failures，不删）。
 * plan 是普通对象（可被手造/篡改），删除器对自己的每一步越界负责。
 */
function resolveUnderRoot(root, name) {
  if (typeof name !== 'string' || name === '') return null;
  if (path.isAbsolute(name)) return null;
  const rel = path.relative(root, path.resolve(root, name));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return path.join(root, name);
}

/**
 * 单面逐项删除。rmSync force:true = ENOENT（目标已消失）按成功计（清理器的
 * 目标态就是「不存在」，已达成；且令重复执行幂等）；其余错误逐项捕获进
 * failures（errno + code + path），**不中断整批**。deletedBytes 累加 plan
 * 时点的计测值（删除后无法实测，plan 清单是审计基准）。
 */
function deleteItems(items, root) {
  const list = Array.isArray(items) ? items : [];
  const result = { planned: list.length, deletedCount: 0, deletedBytes: 0, failures: [] };
  for (const item of list) {
    const name = item && typeof item === 'object' ? item.name : item;
    const bytes = item && typeof item === 'object' && typeof item.bytes === 'number'
      ? item.bytes : 0;
    const target = resolveUnderRoot(root, name);
    if (target === null) {
      result.failures.push({
        name: String(name),
        path: path.join(root, String(name)),
        errno: undefined,
        code: 'EINVAL_PATH',
        message: 'plan 项名非法（空/绝对路径/越出根目录），拒删',
      });
      continue;
    }
    try {
      fs.rmSync(target, { recursive: true, force: true });
      result.deletedCount++;
      result.deletedBytes += bytes;
    } catch (e) {
      result.failures.push({
        name,
        path: target,
        errno: e && e.errno,
        code: (e && e.code) || 'UNKNOWN',
        message: (e && e.message) || String(e),
      });
    }
  }
  return result;
}

/**
 * 按 plan 逐项执行删除（仅供停机窗口调用，见头注）。逐面（artifacts / exec /
 * log）独立计数，exec 两清单（execInSet + execStaleEmpty）合并执行；单项失败
 * 不中断整批，最后汇总。不重扫文件系统——严格执行 plan 清单（见头注 u3 契约）。
 *
 * @param {object} plan planFileCleanup 返回值（缺字段按空清单处理）
 * @param {object} options artifactsDir / logDir / execDir（缺省 ~/.zcode/cli/*，
 *   与 plan 同款注入约定）
 * @returns {{artifacts:{planned,deletedCount,deletedBytes,failures},
 *   exec:{...}, log:{...}, totalDeletedCount:number, totalDeletedBytes:number,
 *   totalFailureCount:number, executedAt:string}}
 *   failures 逐项 {name, path, errno, code, message}；闭合恒等式
 *   planned = deletedCount + failures.length（面级与总计皆成立）。
 */
function executeFileCleanup(plan, options = {}) {
  const artifactsDir = options.artifactsDir || path.join(engineCliRoot(), 'artifacts');
  const logDir = options.logDir || path.join(engineCliRoot(), 'log');
  const execDir = options.execDir || path.join(engineCliRoot(), 'exec');
  const items = plan && typeof plan === 'object' ? plan : {};

  const artifacts = deleteItems(items.artifacts, artifactsDir);
  const exec = deleteItems(
    [...(items.execInSet || []), ...(items.execStaleEmpty || [])],
    execDir,
  );
  const log = deleteItems(items.logFiles, logDir);

  const faces = [artifacts, exec, log];
  return {
    artifacts,
    exec,
    log,
    totalDeletedCount: faces.reduce((s, f) => s + f.deletedCount, 0),
    totalDeletedBytes: faces.reduce((s, f) => s + f.deletedBytes, 0),
    totalFailureCount: faces.reduce((s, f) => s + f.failures.length, 0),
    executedAt: new Date().toISOString(),
  };
}

module.exports = {
  planFileCleanup,
  executeFileCleanup,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_EXEC_STALE_DAYS,
};
