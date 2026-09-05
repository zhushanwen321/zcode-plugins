'use strict';
/**
 * 会话残留识别（u1 基座 + u2 五类目标分治，设计
 * docs/design/zsw-session-residue-cleanup-design.md §3.3 D1）。
 *
 * u1 范围 = 两块基座，供 lib/doctor.js 体检计数与 u2 分治复用：
 *   1. C6 白名单构造式解析（parseRecordWhiteList）
 *   2. 特征目录表闭集常量与匹配（matchFeatureDirectory）
 * u2 范围 = 分治与安全网：
 *   parseRecordTargetSessionIds（哨兵值域解析）/ buildDeleteSet（五类分治）/
 *   checkSentinel（污染哨兵，u3 执行前复断言同用）/ checkIndexConflicts +
 *   excludeConflicts（冲突预检与双库整体剔除）/ checkRedLight（目录分布红灯）/
 *   countInputHistoryHits（input_history 命中计数）
 *
 * 零依赖 plain Node CJS；u1 基座两导出保持纯函数（路径入参、无全局态）。
 * u2 分治函数按设计只读访问数据：records 文件读取与引擎/索引库 DatabaseSync
 * readOnly 查询——任何写删属 lib/clean-exec.js（u3）领地。路径一律显式入参
 * （缺省路径组装留在 lib/doctor.js，本模块不做 env/homedir 推导，测试可注入
 * fixture 路径）。
 */

/**
 * C6 白名单构造式（设计 §2.4 C6）：解析 records.jsonl，深度递归收集每一层
 * JSON 值中键名**恰为** "sessionId" 的字符串值（含嵌套对象/数组内的层，如
 * exec.sessionId / sessionRef.sessionId），仅此一类键。
 *
 * 为什么严禁收 "targetSessionId"（C6-被否，设计 §2.4）：targetSessionId 是
 * zsw 调用方的宿主会话 = 用户真实会话（manager.js 头注「ctx.targetSessionId
 * 取自 _meta」即通知投递目标）。R2 实测并入后白名单∩库虚增，其中 7 个用户
 * 会话会被直接误删——G2「零误删」被系统性击穿。键名精确相等天然排除
 * targetSessionId / 其他 *SessionId 变体；非字符串值（数字/对象）不收。
 *
 * 另一个构造式边界（同样不入式）：records 的 outputs/ 目录名是 sa- run id
 * 不是 session id，不参与收集。
 *
 * 口径纪律（C6）：白名单总数 ≠ 白名单∩引擎库——两个口径必须分离计数
 * （doctor 报双口径；u2 分治消费 ∩ 库子集）。
 *
 * @param {string} recordsPath records.jsonl 绝对路径（lib/config.js recordsPath()）
 * @returns {Set<string>} 去重后的 sessionId 值集合。文件不存在（zsw 从未运行）
 *   返回空集——白名单恒空 = 不识别任何会话 = 不误删，保守正确，不抛错。
 */
function parseRecordWhiteList(recordsPath) {
  return parseRecordStringKeyValues(recordsPath, 'sessionId');
}

/**
 * 污染哨兵值域解析（u2，设计 §3.3 D1⑤ 哨兵 / §3.1 失败样例）：与
 * parseRecordWhiteList 同一解析器、不同键名——收集全部 "targetSessionId"
 * 字符串值。它**不参与删除集构建**（C6-被否），只作为哨兵的值域基准：
 * dry-run 与执行前断言「删除集 ∩ 本函数结果 = 0」。
 *
 * 命中归因中性（设计 R3）：可能是识别器污染（targetSessionId 误入删除集），
 * 也可能是嵌套调用的合法重叠（zsw 会话充当另一次 zsw 调用的宿主，同一
 * session 合法地既是 sessionId 又是 targetSessionId）——两种可能都要求
 * 人工逐条核查后处理，不武断诊断。文件不存在 → 空集（哨兵恒过）。
 *
 * @param {string} recordsPath records.jsonl 绝对路径
 * @returns {Set<string>} 去重后的 targetSessionId 值集合
 */
function parseRecordTargetSessionIds(recordsPath) {
  return parseRecordStringKeyValues(recordsPath, 'targetSessionId');
}

/**
 * 构造式共享解析器：深度递归收集键名恰为 key 的非空字符串值（去重）。
 * 坏 JSON 行跳过（records 是 append-only 事件流，尾部可能有不完整行）；
 * 文件不存在（ENOENT）→ 空集，其余读错误上抛。
 */
function parseRecordStringKeyValues(recordsPath, key) {
  const out = new Set();
  let raw;
  try {
    raw = require('node:fs').readFileSync(recordsPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return out;
    throw e;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // 坏行跳过：records 是 append-only 事件流，尾部可能有不完整行
    }
    collectStringKeyValues(obj, key, out);
  }
  return out;
}

/** 深度递归收集：对象与数组逐层下钻，键名恰为 key 且值为非空字符串才收。 */
function collectStringKeyValues(node, key, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectStringKeyValues(item, key, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [k, value] of Object.entries(node)) {
    if (k === key && typeof value === 'string' && value !== '') out.add(value);
    collectStringKeyValues(value, key, out);
  }
}

/**
 * 特征目录表（设计 §3.3 D1③，消解 C7 白名单盲区——e2e/探针执行路径不写
 * records，其会话 directory 落在 zsw 自测试/探针目录下）。
 *
 * **闭集清单**：新增条目必须附来源注释（出处文件:行或人工确认记录）；
 * **禁止子串模糊匹配**——路径段/整串语义防止误伤目录名恰好含特征片段的
 * 真实项目（如 /home/u/my-zsub-e2e-notes）。此类目录只会被 zsw 测试代码/
 * 探针创建，真实用户项目不可能位于 OS 临时目录的该前缀下。
 */

/** 路径段匹配前缀：directory 按 `/` 分段后存在以此开头的段即命中。
 *  来源：test/e2e.test.js:39 `fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-e2e-'))`
 *  （mkdtemp 后缀随机，天然覆盖其下 e1-proj / zsw-root / wt-* 子路径）。 */
const FEATURE_DIRECTORY_SEGMENT_PREFIX = 'zsub-e2e-';

/** 整串匹配清单（directory 与条目完全相等才命中）。
 *  来源：设计 §2.4 C7——分析期探针目录，人工确认（2026-09-05 二轮分析）。 */
const FEATURE_DIRECTORY_EXACT = Object.freeze([
  '/tmp/zsw-sidebar-probe',
  '/tmp/pz2-work',
]);

/**
 * 特征目录匹配（D1③）：整串相等，或按 `/` 分段后存在以
 * FEATURE_DIRECTORY_SEGMENT_PREFIX 开头的段。不做子串模糊匹配。
 * @param {string} directory 引擎库 session.directory
 * @returns {boolean}
 */
function matchFeatureDirectory(directory) {
  if (typeof directory !== 'string' || directory === '') return false;
  if (FEATURE_DIRECTORY_EXACT.includes(directory)) return true;
  return directory.split('/').some((seg) => seg.startsWith(FEATURE_DIRECTORY_SEGMENT_PREFIX));
}

// ---------------------------------------------------- u2 分治与安全网

/** 一天的毫秒数（按龄判定的基准单位）。 */
const DAY_MS = 24 * 60 * 60 * 1000;
/** subagent_child 默认只清 time_created 早于 7 天的（设计 §3.3 D1①）。 */
const DEFAULT_OLDER_THAN_DAYS = 7;

/** node:sqlite 运行时检测（与 lib/doctor.js loadSqlite 同款语义；独立成函数
 *  是因 doctor → clean-identify 单向依赖，本模块反向 require doctor 会成环）。 */
function loadSqliteOperational() {
  try {
    return require('node:sqlite');
  } catch (e) {
    const err = new Error(
      `node:sqlite 不可用（${e && e.message || e}）。清理识别需要 Node ≥22.5（建议 24），`
      + `当前 ${process.version}。恢复指引：升级 Node 后重跑 zsw doctor clean --dry-run。`,
    );
    err.code = 'NODE_SQLITE_UNAVAILABLE';
    throw err;
  }
}

/** 只读打开 SQLite（DatabaseSync readOnly）。打不开（文件不存在/损坏/权限）
 *  抛 code=DB_OPEN_FAILED 的可操作错误（指向体检命令），不静默吞——dry-run
 *  没有删除集就无事可做。索引库例外：打不开走空集降级（见 buildDeleteSet）。 */
function openDbReadOnly(dbPath, label) {
  const { DatabaseSync } = loadSqliteOperational();
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    const err = new Error(
      `${label}打不开（${e && e.message || e}）：${dbPath}。`
      + '恢复指引：确认文件存在且可读，可先跑 node bin/zsw.js doctor 体检确认各面状态。',
    );
    err.code = 'DB_OPEN_FAILED';
    throw err;
  }
}

/**
 * 五类目标分治（设计 §3.3 D1①-⑤）→ 结构化删除集。只读（引擎/索引库均
 * readOnly 打开即关；engineSessionIds 全部源自引擎库实际存在行的行级过滤，
 * 不构造库外 id）：
 *   ① subagent_child 按龄：task_type='subagent_child' 且 time_created <
 *      now - olderThanDays（恰等于阈值不算超龄——严格小于）；
 *   ② 白名单∩库：parseRecordWhiteList ∩ session.id（C6 构造式，仅 sessionId）；
 *   ③ 特征目录类：session.directory 经 matchFeatureDirectory（D1③ 闭集）；
 *   ④ 文件面：本单元只产出 id 并集供 u4 目录名匹配，不扫目录；
 *   ⑤ 双库联动：index 侧 indexTaskIds = tasks.task_id ∈ 引擎删除集
 *      （列名实证：tasks 无 session_id 列，task_id 值 = 引擎 session id，
 *      u1 交付期 pragma 核实）。
 *
 * staleMode 档位语义分野（u5，设计 §3.3 D5「识别集缩到超龄部分」；本模块是
 * 该语义的单一权威源，上游 bin/zsw.js / clean-exec / doctor 只透传不复制）：
 *   false（缺省 = 存量全清）——②③白名单∩库与特征目录类**不加**时间过滤
 *     （存量 zsw 会话一次清完，G1）；①subagent_child 恒按龄（D1① 既有语义：
 *     GUI 会话详情页可能引用近期子代理记录）。
 *   true（--stale = 周期维护按龄）——①②③统一要求 time_created **严格早于**
 *     cutoff 才入集（周期维护不删刚产生的新会话；A-5 场景：清理后跑新任务
 *     产生新数据，`clean --stale --older-than 1d` 只清新产生的超龄部分）。
 *   time_created 非数值（null 等）在任何模式下都不判超龄、保守保留（与
 *   u1 doctor 口径一致）。--older-than 的档位值**不**跟随到文件面（log 保留
 *   14 天 / exec 空壳 7 天各自的档位在 lib/clean-fs.js，见其头注）——一个
 *   flag 不暗改两处安全阈值。
 *
 * 三类识别（②③①）不强制互斥（白名单∩库与特征目录类可重叠——byClass 各自
 * 独立记录，与设计 §3.1 样张「47 + 47」重叠分报口径一致）；engineSessionIds
 * 为三类并集去重。
 *
 * @param {object} options 全部显式入参：
 *   engineDbPath（必传，引擎库路径）/ indexDbPath（可选，索引库路径；缺省或
 *   打不开 → indexTaskIds 空集——索引面 n/a 不阻塞删除集）/ recordsPath
 *   （必传）/ olderThanDays（默认 7）/ staleMode（默认 false，语义分野见上）/
 *   now（时间基准 ms，默认 Date.now()）
 * @returns {{engineSessionIds:Set, byClass:{whitelist:string[],feature:string[],
 *   subagentChildStale:string[]}, indexTaskIds:Set, interactiveClassIds:Set,
 *   olderThanDays:number, staleMode:boolean, generatedAt:string}}
 *   interactiveClassIds = ②③并集（红灯口径的输入面）。
 */
function buildDeleteSet(options = {}) {
  const { engineDbPath, indexDbPath, recordsPath } = options;
  if (typeof engineDbPath !== 'string' || engineDbPath === '') {
    throw new Error('buildDeleteSet 需要 options.engineDbPath（引擎库绝对路径）。');
  }
  if (typeof recordsPath !== 'string' || recordsPath === '') {
    throw new Error('buildDeleteSet 需要 options.recordsPath（records.jsonl 绝对路径）。');
  }
  const olderThanDays = typeof options.olderThanDays === 'number'
    && Number.isFinite(options.olderThanDays) && options.olderThanDays >= 0
    ? options.olderThanDays : DEFAULT_OLDER_THAN_DAYS;
  const staleMode = options.staleMode === true;
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const cutoff = now - olderThanDays * DAY_MS;
  const whiteList = parseRecordWhiteList(recordsPath);

  const whitelistClass = [];
  const featureClass = [];
  const subagentChildStale = [];
  const db = openDbReadOnly(engineDbPath, '引擎库');
  try {
    for (const row of db.prepare('SELECT id, directory, task_type, time_created FROM session').all()) {
      // 超龄判定单点：严格早于 cutoff 才算（恰等于不算）；非数值保守不算。
      // 非 staleMode 时 ②③ 不消费该判定（存量全清），① 恒消费（D1①）。
      const olderThanCutoff = typeof row.time_created === 'number' && row.time_created < cutoff;
      if (whiteList.has(row.id) && (!staleMode || olderThanCutoff)) whitelistClass.push(row.id);
      if (matchFeatureDirectory(row.directory) && (!staleMode || olderThanCutoff)) featureClass.push(row.id);
      if (row.task_type === 'subagent_child' && olderThanCutoff) {
        subagentChildStale.push(row.id);
      }
    }
  } finally {
    db.close();
  }

  const engineSessionIds = new Set([...whitelistClass, ...featureClass, ...subagentChildStale]);

  // ⑤ index 侧命中：tasks.task_id ∈ 引擎删除集。索引库缺文件/打不开 → 空集
  // （真机可能无此文件；体检 collect 对该面同口径 n/a，不拖垮主流程）
  const indexTaskIds = new Set();
  if (typeof indexDbPath === 'string' && indexDbPath !== '') {
    let idx = null;
    try {
      idx = loadSqliteOperational().DatabaseSync;
      const handle = new idx(indexDbPath, { readOnly: true });
      try {
        for (const r of handle.prepare('SELECT task_id FROM tasks').all()) {
          if (engineSessionIds.has(r.task_id)) indexTaskIds.add(r.task_id);
        }
      } finally {
        handle.close();
      }
    } catch {
      // 索引面 n/a（缺文件/缺 tasks 表/权限）→ indexTaskIds 空集
    }
  }

  return {
    engineSessionIds,
    byClass: {
      whitelist: whitelistClass.sort(),
      feature: featureClass.sort(),
      subagentChildStale: subagentChildStale.sort(),
    },
    indexTaskIds,
    interactiveClassIds: new Set([...whitelistClass, ...featureClass]),
    olderThanDays,
    staleMode,
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * 污染哨兵（设计 §3.3 D1⑤ / §3.1 失败样例）：删除集 ∩ records 全部
 * targetSessionId 值域必须为空，非空即 ok:false（调用方中止，不改库）。
 *
 * **此函数同时供 u3 执行前复断言**（lib/clean-exec.js 领地）：签名稳定性
 * 契约 = deleteSet 收结构化删除集对象（buildDeleteSet / excludeConflicts 的
 * 返回值，取其 engineSessionIds）或直接一个 Set<string>；recordsPath 收
 * records.jsonl 绝对路径。本函数不依赖任何数据库（纯 fs 读 records + 内存
 * 交集），u3 可在任何时点独立调用。
 *
 * 命中归因中性（R3）：命中可能是识别器污染（C6-被否：targetSessionId 是
 * 调用方宿主会话 = 用户真实会话），也可能是嵌套调用的合法重叠（zsw 会话
 * 充当另一次 zsw 调用的宿主）——逐条核查 directory/标题后交维护者判定，
 * 不武断诊断 bug（渲染文案见 lib/doctor.js renderDryRun）。
 *
 * @param {object|Set<string>} deleteSet 结构化删除集（取 engineSessionIds）或 id 集合
 * @param {string} recordsPath records.jsonl 绝对路径
 * @returns {{ok:boolean, intersection:string[]}} intersection 升序，非空 = 中止
 */
function checkSentinel(deleteSet, recordsPath) {
  const ids = deleteSet instanceof Set ? deleteSet : deleteSet.engineSessionIds;
  const targets = parseRecordTargetSessionIds(recordsPath);
  const intersection = [...ids].filter((id) => targets.has(id)).sort();
  return { ok: intersection.length === 0, intersection };
}

/**
 * 索引冲突预检（设计 §3.3 D1⑤ 安全网）：姊妹表对删除集的引用面清查。
 * 只读；索引库缺文件/打不开 → available:false + 空清单（与体检 n/a 口径一致，
 * 冲突机制是安全网不是主流程依赖）。三源匹配列（2026-09-06 pragma 实证）：
 *   members     task_group_members.task_id ∈ index 侧删除集（= tasks.task_id ∩ engineSessionIds）
 *   automations automations.target_task_id ∈ index 侧删除集
 *   off_peak    off_peak_tasks.session_id ∈ engineSessionIds（引擎侧命中）
 *               ∨ tasks.off_peak_task_id 反向关联（删除集 task 挂着 off_peak 引用）
 *
 * @param {Set<string>} engineSessionIds 引擎侧删除集
 * @param {string} indexPath tasks-index.sqlite 路径
 * @returns {{available:boolean, members:Array, automations:Array, offPeak:Array,
 *   conflictedSessionIds:Set<string>>}} 命中条目含来源明细；conflictedSessionIds
 *   = 冲突会话全集（供 excludeConflicts 从双库删除集整体剔除）
 */
function checkIndexConflicts(engineSessionIds, indexPath) {
  const result = {
    available: false,
    members: [], automations: [], offPeak: [],
    conflictedSessionIds: new Set(),
  };
  if (typeof indexPath !== 'string' || indexPath === '') return result;
  let db;
  try {
    db = loadSqliteOperational().DatabaseSync;
  } catch {
    return result; // node:sqlite 不可用：可用性由引擎库打开路径先行报错，此处保持空安全网
  }
  let handle;
  try {
    handle = new db(indexPath, { readOnly: true });
  } catch {
    return result;
  }
  try {
    // index 侧删除集 + tasks 挂载的 off_peak 引用（反向关联源数据）
    const indexTaskIds = new Set();
    const taskOffPeakRefs = [];
    for (const r of handle.prepare('SELECT task_id, off_peak_task_id FROM tasks').all()) {
      if (engineSessionIds.has(r.task_id)) indexTaskIds.add(r.task_id);
      if (r.off_peak_task_id !== null && r.off_peak_task_id !== undefined) {
        taskOffPeakRefs.push({ taskId: r.task_id, offPeakTaskId: r.off_peak_task_id });
      }
    }
    // 逐源清查（姊妹表在真机为个位数行，全表拉内存过滤；缺表 → 该源空，不 crash）
    try {
      for (const r of handle.prepare('SELECT group_id, task_id FROM task_group_members').all()) {
        if (indexTaskIds.has(r.task_id)) {
          result.members.push({ sessionId: r.task_id, groupId: r.group_id });
          result.conflictedSessionIds.add(r.task_id);
        }
      }
    } catch { /* 缺表 → 空 */ }
    try {
      for (const r of handle.prepare('SELECT automation_id, target_task_id FROM automations').all()) {
        if (r.target_task_id !== null && r.target_task_id !== undefined && indexTaskIds.has(r.target_task_id)) {
          result.automations.push({ sessionId: r.target_task_id, automationId: r.automation_id });
          result.conflictedSessionIds.add(r.target_task_id);
        }
      }
    } catch { /* 缺表 → 空 */ }
    try {
      for (const r of handle.prepare('SELECT off_peak_task_id, session_id FROM off_peak_tasks').all()) {
        if (r.session_id !== null && r.session_id !== undefined && engineSessionIds.has(r.session_id)) {
          result.offPeak.push({ sessionId: r.session_id, offPeakTaskId: r.off_peak_task_id, via: 'off_peak_tasks.session_id' });
          result.conflictedSessionIds.add(r.session_id);
        }
      }
    } catch { /* 缺表 → 空 */ }
    for (const ref of taskOffPeakRefs) {
      if (indexTaskIds.has(ref.taskId)) {
        result.offPeak.push({
          sessionId: ref.taskId, offPeakTaskId: ref.offPeakTaskId, via: 'tasks.off_peak_task_id',
        });
        result.conflictedSessionIds.add(ref.taskId);
      }
    }
    result.available = true;
  } finally {
    handle.close();
  }
  return result;
}

/**
 * 冲突剔除组合函数（设计 D1⑤ R3 作用域闭合）：冲突会话从双库删除集**整体
 * 剔除**——引擎 session 行与 index tasks 行均保留（只留 index 删引擎 = 侧边栏
 * 幽灵任务指向已删会话），下次 clean 重查后自然纳入。返回新删除集对象
 * （engineSessionIds / indexTaskIds / byClass / interactiveClassIds 双侧同步
 * 收缩）+ 被剔除项逐条清单（供报告；同一会话多重来源时 detail 汇总全部命中源）。
 * 入参 deleteSet 不被修改（纯函数）。
 *
 * @param {object} deleteSet buildDeleteSet / excludeConflicts 返回的结构化删除集
 * @param {object} conflictResult checkIndexConflicts 返回值
 * @returns {{deleteSet:object, removed:Array<{id,source,detail}>}}
 */
function excludeConflicts(deleteSet, conflictResult) {
  const conflicted = conflictResult && conflictResult.conflictedSessionIds instanceof Set
    ? conflictResult.conflictedSessionIds : new Set();
  // 逐会话汇总命中源（同一会话可能被多源同时引用）
  const sourcesById = new Map();
  const addSource = (id, source, detail) => {
    if (!conflicted.has(id) || !deleteSet.engineSessionIds.has(id)) return;
    if (!sourcesById.has(id)) sourcesById.set(id, []);
    sourcesById.get(id).push({ source, detail });
  };
  for (const m of (conflictResult && conflictResult.members) || []) {
    addSource(m.sessionId, 'members', `task_group_members（group_id=${m.groupId}）`);
  }
  for (const a of (conflictResult && conflictResult.automations) || []) {
    addSource(a.sessionId, 'automations', `automations（automation_id=${a.automationId}）`);
  }
  for (const o of (conflictResult && conflictResult.offPeak) || []) {
    addSource(o.sessionId, 'off_peak', `${o.via || 'off_peak'}（off_peak_task_id=${o.offPeakTaskId}）`);
  }
  const removed = [...sourcesById.entries()]
    .map(([id, sources]) => ({
      id,
      source: sources.map((s) => s.source).join('+'),
      detail: sources.map((s) => s.detail).join('; '),
    }))
    .sort((x, y) => (x.id < y.id ? -1 : 1));

  const keep = (id) => !conflicted.has(id);
  return {
    deleteSet: {
      engineSessionIds: new Set([...deleteSet.engineSessionIds].filter(keep)),
      byClass: {
        whitelist: deleteSet.byClass.whitelist.filter(keep),
        feature: deleteSet.byClass.feature.filter(keep),
        subagentChildStale: deleteSet.byClass.subagentChildStale.filter(keep),
      },
      indexTaskIds: new Set([...deleteSet.indexTaskIds].filter(keep)),
      interactiveClassIds: new Set([...deleteSet.interactiveClassIds].filter(keep)),
      olderThanDays: deleteSet.olderThanDays,
      staleMode: deleteSet.staleMode === true,
      generatedAt: deleteSet.generatedAt,
    },
    removed,
  };
}

/** OS 临时目录判定（红灯的 workspace/临时分类口径）：/tmp/、/var/folders/
 *  （macOS os.tmpdir() 实际前缀）与运行时 os.tmpdir() 前缀。 */
function isOsTmpDirectory(directory) {
  if (typeof directory !== 'string' || directory === '') return false;
  if (directory === '/tmp') return true;
  return ['/tmp/', '/var/folders/', `${require('node:os').tmpdir()}/`]
    .some((prefix) => directory.startsWith(prefix));
}

/**
 * 目录分布红灯（设计 §3.3 D1⑤ / §3.1 dry-run 样张）：interactive 识别类的
 * directory 分布机械阈值审查。
 *
 * 口径 = 仅 interactive 识别类（byClass.whitelist ∪ byClass.feature，即
 * interactiveClassIds），**排除 subagent_child**——其 directory 全为工作区类，
 * 纳入只会稀释红灯（设计 §3.1 样张原文）。按 directory 分 workspace 类 /
 * 临时类（isOsTmpDirectory）；机械阈值 = 临时类占比 > 30%（严格大于）或
 * 「白名单∩库会话中位于 OS 临时目录但不匹配特征表」数 > 0（outsideFeatureHits
 * ——白名单会话落在特征表之外的临时目录 = 识别器可能漏登记特征条目的信号）。
 *
 * @param {object} deleteSet 结构化删除集（消费 byClass 与 interactiveClassIds；
 *   传剔除冲突后的最终集 = 报告「将删除的内容」口径）
 * @param {DatabaseSync} engineDb 已只读打开的引擎库句柄（查 id→directory 映射；
 *   全表拉取内存过滤，万行级与 u1 collectEngine 同风格）
 * @returns {{workspaceN:number, tmpN:number, ratio:number, outsideFeatureHits:number,
 *   triggered:boolean}} ratio = tmpN/(workspaceN+tmpN)，分母 0 → 0
 */
function checkRedLight(deleteSet, engineDb) {
  const interactive = deleteSet.interactiveClassIds instanceof Set
    ? deleteSet.interactiveClassIds
    : new Set([...deleteSet.byClass.whitelist, ...deleteSet.byClass.feature]);
  const whitelistSet = new Set(deleteSet.byClass.whitelist);
  const directoryById = new Map();
  for (const row of engineDb.prepare('SELECT id, directory FROM session').all()) {
    directoryById.set(row.id, row.directory);
  }
  let workspaceN = 0;
  let tmpN = 0;
  let outsideFeatureHits = 0;
  for (const id of interactive) {
    const dir = directoryById.get(id);
    if (isOsTmpDirectory(dir)) {
      tmpN++;
      if (whitelistSet.has(id) && !matchFeatureDirectory(dir)) outsideFeatureHits++;
    } else {
      workspaceN++;
    }
  }
  const total = workspaceN + tmpN;
  const ratio = total > 0 ? tmpN / total : 0;
  return {
    workspaceN,
    tmpN,
    ratio,
    outsideFeatureHits,
    triggered: ratio > 0.3 || outsideFeatureHits > 0,
  };
}

/**
 * input_history 命中计数（设计 D1⑤：input_history 无 FK，删除集命中行随删
 * 并显式报数——GUI 手输与 RPC session/send 双写面，R2 实测「零命中」前提不
 * 成立）。引擎库只读查询：全表拉 session_id 内存过滤（与引擎库其他采集同风格）。
 *
 * @param {Set<string>} engineSessionIds 删除集（最终集口径 = 将删除的）
 * @param {DatabaseSync} engineDb 已只读打开的引擎库句柄
 * @returns {number|undefined} 缺表 → undefined（渲染 n/a），其余为命中行数
 */
function countInputHistoryHits(engineSessionIds, engineDb) {
  let rows;
  try {
    rows = engineDb.prepare('SELECT session_id FROM input_history').all();
  } catch {
    return undefined; // 缺表 → n/a（不产出假数字）
  }
  let n = 0;
  for (const r of rows) {
    if (r.session_id !== null && r.session_id !== undefined && engineSessionIds.has(r.session_id)) n++;
  }
  return n;
}

module.exports = {
  // u1 基座（签名不变）
  parseRecordWhiteList,
  FEATURE_DIRECTORY_SEGMENT_PREFIX,
  FEATURE_DIRECTORY_EXACT,
  matchFeatureDirectory,
  // u2 分治与安全网
  parseRecordTargetSessionIds,
  buildDeleteSet,
  checkSentinel,
  checkIndexConflicts,
  excludeConflicts,
  checkRedLight,
  countInputHistoryHits,
  DEFAULT_OLDER_THAN_DAYS,
};
