/**
 * lib/takeover.js — 接管编排层：扫描 → 计算 → 改写 user config + registry（幂等），
 * 以及 restore 逆操作。hook 与 CLI 共用此状态机（DESIGN.md §7）。
 *
 * 并发防护：所有写路径走 withLock（registry.js 单实例锁）+ re-load + 记录级合并。
 * LockHeldError 的降级策略由调用方决定：hook 传 degradeOnLock:true（跳过接管不阻断会话），
 * CLI 默认抛出让用户感知冲突。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { loadUserConfig, saveUserConfig, scanServers } = require('./config-io');
const {
  withLock,
  loadRegistry,
  saveRegistry,
  upsertServer,
  removeServer,
  LockHeldError,
} = require('./registry');
const { backgroundPrescan } = require('./catalog');
const { DATA_DIR } = require('./paths');

// user config 与 zcode 引擎写进程无共享锁：落盘前比对 mtime，外部已改则
// 重读重放本批改动（记录级），连续冲突时放弃本轮（下次会话幂等重试）
const USER_CONFIG_MAX_RETRIES = 5;
const USER_CONFIG_PATH = path.join('.zcode', 'cli', 'config.json');

function statMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null; // 不存在 = 首次创建，无冲突可言
  }
}

/** mutation：{ op:'set'|'del', key, value? }，只作用于 cfg.mcp.servers */
function applyServerMutations(cfg, mutations) {
  if (!cfg.mcp || typeof cfg.mcp !== 'object') cfg.mcp = {};
  if (!cfg.mcp.servers || typeof cfg.mcp.servers !== 'object') cfg.mcp.servers = {};
  for (const m of mutations) {
    if (m.op === 'set') cfg.mcp.servers[m.key] = m.value;
    else delete cfg.mcp.servers[m.key];
  }
  return cfg;
}

/**
 * 带外部写检测的 user config 更新：每次重读 → 重放 mutations → 落盘前
 * 校验 mtime 未变（变了说明引擎在读取后写过 → 丢弃副本重来，保住引擎写入）。
 * 重试耗尽仍冲突则抛错：hook 侧降级、CLI 侧让用户感知，都不静默回滚引擎配置。
 */
function guardedSaveUserConfig(home, mutations, dataDirForLog) {
  const file = path.join(home, USER_CONFIG_PATH);
  for (let i = 0; i < USER_CONFIG_MAX_RETRIES; i++) {
    const before = statMtimeMs(file);
    const cfg = applyServerMutations(loadUserConfig(home), mutations);
    if (statMtimeMs(file) === before) {
      saveUserConfig(cfg, home);
      return;
    }
  }
  throw new Error(
    'user config 在读取后被外部进程持续修改（' + file + '），本次跳过改写以免覆盖；' +
      '操作幂等，可稍后重试' + (dataDirForLog ? '（详情见 ' + dataDirForLog + '）' : '')
  );
}

// 自身主 server 的宿主插件名：接管自己会递归（wrapper 之上再套 wrapper）
const SELF_PLUGIN_NAME = 'z-tool-finder';
const PRESCAN_ENTRIES_FILENAME = 'prescan-entries.json';

// 引擎运行时注入启动参数的插件（静态配置无法还原完整命令）：
// zcode-cua 的 --permission-broker-socket 由 GUI 动态生成注入（引擎
// injectZCodeCuaBrokerMcpServers 机制），且受 resolveTrustedOfficialCuaServerNames
// 特权白名单约束——wrapper 快照启动直接报
// "plugin launcher requires --permission-broker-socket"（2026-08-26 实证）
const ENGINE_INJECTED_PLUGINS = new Set(['zcode-cua']);

/**
 * 单条目分类（computeActions 的逐条规则，范围规则见 DESIGN.md D5）：
 * - self            插件名是 z-tool-finder 自身 → 跳过（接管自己会递归）
 * - engine-excluded 引擎注入型插件 → 硬边界不可接管，归 excluded
 * - taken           已在 registry.servers → 幂等跳过（供漂移检测）
 * - excluded        registry 顶层 excluded 名单 → 跳过
 * - skip            workspace 未点名 / 显式模式未点名的条目
 * - takeover        应接管
 * pinned 不参与分类（只影响 hook 清单渲染）。
 */
function classifyEntry(entry, { excludedList, explicit, servers }) {
  if (entry.pluginName === SELF_PLUGIN_NAME) return 'self';
  if (entry.pluginName && ENGINE_INJECTED_PLUGINS.has(entry.pluginName)) return 'engine-excluded';
  if (servers[entry.key]) return 'taken';
  if (excludedList.includes(entry.key)) return 'excluded';
  if (entry.scope === 'workspace' && !(explicit && explicit.has(entry.key))) return 'skip';
  if (explicit && !explicit.has(entry.key)) return 'skip';
  return 'takeover';
}

/**
 * 纯函数：对比扫描结果与 registry，计算本次应接管的 server 集合。
 *
 * 范围规则（DESIGN.md D5）：
 * - scope user/plugin 且 stdio → 自动接管（scanServers 已过滤非 stdio / enabled:false）
 * - scope workspace → 不自动（除非 names 显式包含其 key）
 * - 已在 registry.servers 的 key → 跳过（幂等），归入 taken
 * - registry 顶层 excluded 列表中的 key → 跳过，归入 excluded
 * - 插件名为 z-tool-finder 自身的 server → 跳过
 * - pinned 不影响接管（pinned 只影响 hook 清单渲染），照常返回
 *
 * @returns {{ toTakeover: Array<{key,scope,config}>, taken: string[], excluded: string[] }}
 */
function computeActions({ home, workspaceRoot, reg, names } = {}) {
  const entries = scanServers({ home, workspaceRoot });
  const excludedList = Array.isArray(reg && reg.excluded) ? reg.excluded : [];
  const servers = (reg && reg.servers) || {};
  const explicit = Array.isArray(names) ? new Set(names) : null;

  const toTakeover = [];
  const taken = [];
  const takenEntries = [];
  const excluded = [];
  for (const entry of entries) {
    switch (classifyEntry(entry, { excludedList, explicit, servers })) {
      case 'taken':
        taken.push(entry.key);
        takenEntries.push(entry); // 供 applyTakeover 漂移检测（插件升级/定义变化后刷新 wrapper）
        break;
      case 'engine-excluded':
      case 'excluded':
        excluded.push(entry.key);
        break;
      case 'takeover':
        toTakeover.push({ key: entry.key, scope: entry.scope, config: entry.config, pluginRoot: entry.pluginRoot });
        break;
      // 'self' / 'skip'：静默跳过
    }
  }
  return { toTakeover, taken, takenEntries, excluded };
}

function expandServerDef(serverEntry) {
  const orig = serverEntry.config;
  const root = serverEntry.pluginRoot || null;
  const def = {
    ...orig,
    command: expandTemplates(orig.command, root),
    args: Array.isArray(orig.args) ? orig.args.map((a) => expandTemplates(a, root)) : orig.args,
  };
  if (orig.env) {
    def.env = Object.fromEntries(
      Object.entries(orig.env).map(([k, v]) => [k, expandTemplates(v, root)])
    );
  }
  if (typeof orig.cwd === 'string') def.cwd = expandTemplates(orig.cwd, root);
  return def;
}

/**
 * 构造写进 user config mcp.servers[key] 的 wrapper 条目。
 * key 即 scanServers 的归一化 key（user 级裸名 / 插件级 plugin:<p>:<s>，
 * M0 探针实证此覆盖形态有效）。
 *
 * 模板展开：插件 server 的 ${ZCODE_PLUGIN_ROOT}/${CLAUDE_PLUGIN_ROOT} 只在
 * zcode 的插件层展开，wrapper 条目位于 user config 层（官方规则：不展开模板），
 * 因此写入前替换为接管时刻的插件根绝对路径；插件升级后路径漂移由
 * applyTakeover 的 taken 刷新逻辑重写。${CLAUDE_PROJECT_DIR} 等会话级变量
 * 无会话上下文可展开，保留字面量（用到它的 server 极少且默认不启用）。
 */
function expandTemplates(value, pluginRoot) {
  if (!pluginRoot || typeof value !== 'string') return value;
  return value
    .replace(/\$\{ZCODE_PLUGIN_ROOT\}/g, pluginRoot)
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot);
}

function buildWrapperEntry(serverEntry, dataDir = DATA_DIR) {
  const launcher = path.join(dataDir, 'launcher', 'proxy-launcher.js');
  const orig = serverEntry.config;
  const root = serverEntry.pluginRoot || null;
  const origArgs = Array.isArray(orig.args) ? orig.args : [];
  const entry = {
    type: 'stdio',
    command: 'node',
    args: [
      launcher,
      serverEntry.key,
      '--',
      expandTemplates(orig.command, root),
      ...origArgs.map((a) => expandTemplates(a, root)),
    ],
    env: orig.env
      ? Object.fromEntries(Object.entries(orig.env).map(([k, v]) => [k, expandTemplates(v, root)]))
      : {},
    enabled: true,
  };
  // timeoutMs/cwd 透传：不保留会让 computer-use 这类长调用退回 30s 默认超时
  if (typeof orig.timeoutMs === 'number') entry.timeoutMs = orig.timeoutMs;
  if (typeof orig.cwd === 'string') entry.cwd = expandTemplates(orig.cwd, root);
  return entry;
}

// 原子写预扫描任务文件（后台 prescan 进程读它；写坏会被 prescan 进程捕获退出）
function writeEntriesFile(dataDir, entries) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, PRESCAN_ENTRIES_FILENAME);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

/**
 * 核心接管（幂等）：withLock 内 re-load registry → computeActions →
 * 逐条 upsertServer + 改写 user config → 原子落盘 → 首次接管触发后台预扫描。
 *
 * @param {object} opts
 * @param {string} opts.home HOME 目录（user config 读写基准）
 * @param {string} [opts.dataDir] 数据目录，默认 paths.DATA_DIR
 * @param {string} [opts.workspaceRoot] workspace 根（扫描 workspace 源用）
 * @param {string[]} [opts.names] 显式接管 key 列表（解锁 workspace server）
 * @param {boolean} [opts.degradeOnLock] true 时 LockHeldError 降级返回而非抛出（hook 场景）
 * @returns {Promise<{taken:string[],newly:string[],skipped:string[],needsRestart:boolean,degraded?:string}>}
 */
async function applyTakeover({ home, dataDir, workspaceRoot, names, degradeOnLock = false } = {}) {
  const dir = dataDir || DATA_DIR;
  try {
    return await withLock(dir, () => {
      const reg = loadRegistry(dir);
      const actions = computeActions({ home, workspaceRoot, reg, names });

      const cfg = loadUserConfig(home);
      if (!cfg.mcp) cfg.mcp = {};
      if (!cfg.mcp.servers) cfg.mcp.servers = {};

      let next = reg;
      const newEntries = [];
      const refreshed = [];
      const mutations = [];
      for (const t of actions.toTakeover) {
        const wrapperEntry = buildWrapperEntry(t, dir);
        next = upsertServer(next, { key: t.key, scope: t.scope, original: t.config, pluginRoot: t.pluginRoot, wrapperEntry });
        mutations.push({ op: 'set', key: t.key, value: wrapperEntry });
        // prescan 消费的是可直连的真实定义：模板必须已展开
        //（prescan 不经 wrapper，拿原始模板 spawn 会因路径无效失败）
        newEntries.push({ key: t.key, config: expandServerDef(t) });
      }
      // 已接管条目漂移检测：插件升级（pluginRoot 变化使模板展开结果变）或原始定义
      // 变化时，期望 wrapper 条目与 config 现值不一致 → 重写（外部手改 config 也被纠正）
      for (const t of actions.takenEntries) {
        const expected = buildWrapperEntry(t, dir);
        if (JSON.stringify(cfg.mcp.servers[t.key]) === JSON.stringify(expected)) continue;
        next = upsertServer(next, { key: t.key, scope: t.scope, original: t.config, pluginRoot: t.pluginRoot, wrapperEntry: expected });
        mutations.push({ op: 'set', key: t.key, value: expected });
        refreshed.push(t.key);
      }

      if (newEntries.length || refreshed.length) {
        guardedSaveUserConfig(home, mutations, dir);
        saveRegistry(dir, next);
      }
      // 预扫描预算（§7）：只对新接管条目触发；刷新路径 newEntries 为空，
      // 覆盖写空 entries 文件会清掉上一轮未消费的任务
      if (newEntries.length) {
        const entriesFile = writeEntriesFile(dir, newEntries);
        backgroundPrescan(dir, entriesFile);
      }

      return {
        taken: [...newEntries.map((e) => e.key), ...actions.taken],
        newly: newEntries.map((e) => e.key),
        refreshed,
        skipped: [...actions.excluded],
        needsRestart: newEntries.length > 0 || refreshed.length > 0,
      };
    });
  } catch (err) {
    if (degradeOnLock && err instanceof LockHeldError) {
      return { taken: [], newly: [], refreshed: [], skipped: [], needsRestart: false, degraded: 'lock-held' };
    }
    throw err;
  }
}

/**
 * 计算还原一个 server 的 config mutation：scope user → 恢复 original；
 * scope plugin/workspace → 删除覆盖条目（原始定义仍在插件/仓库配置里）。
 * 返回 {op,key,value?}；无记录或 user config 无 mcp.servers 段时返回 null（归入 missing）。
 */
function restoreEntry(reg, cfg, key) {
  const rec = reg.servers && reg.servers[key];
  if (!rec) return null;
  if (!cfg.mcp || !cfg.mcp.servers) return null;
  if (rec.scope === 'user') {
    // user 级 key 即裸 server 名，原位恢复
    return { op: 'set', key, value: rec.original };
  }
  // plugin/workspace 级：接管是 user config 里的覆盖条目，删除即还原
  return { op: 'del', key };
}

/** restore 公共路径：withLock 内逐 key 还原 + removeServer + 原子落盘（config 带外部写检测） */
function restoreKeys({ home, dataDir, keys }) {
  const dir = dataDir || DATA_DIR;
  return withLock(dir, () => {
    const reg = loadRegistry(dir);
    const cfg = loadUserConfig(home);
    let next = reg;
    const restored = [];
    const missing = [];
    const mutations = [];
    for (const key of keys) {
      const mutation = restoreEntry(next, cfg, key);
      if (mutation) {
        mutations.push(mutation);
        next = removeServer(next, key);
        restored.push(key);
      } else {
        missing.push(key); // registry 无记录或 user config 无该段：无法还原，如实报告
      }
    }
    if (mutations.length) guardedSaveUserConfig(home, mutations, dir);
    saveRegistry(dir, next);
    return { restored, missing };
  });
}

/** 还原全部已接管 server */
function restoreAll({ home, dataDir } = {}) {
  const dir = dataDir || DATA_DIR;
  const keys = withLock(dir, () => Object.keys(loadRegistry(dir).servers || {}));
  return restoreKeys({ home, dataDir: dir, keys });
}

/** 还原单个 server */
function restoreOne({ home, dataDir, key } = {}) {
  if (!key) throw new TypeError('restoreOne: key 参数必传');
  return restoreKeys({ home, dataDir, keys: [key] });
}

/**
 * 刷新数据目录下的 stable launcher 副本（hook 每次运行自检，DESIGN.md D4）。
 * 本模块在 lib/ 下，插件根即 __dirname/..。launcher-sync 由并行单元提供，
 * 懒加载 + 失败降级：launcher 刷新失败不应阻断 hook 注入。
 */
function syncLauncherNow(dataDir = DATA_DIR) {
  const pluginRoot = path.resolve(__dirname, '..');
  let sync;
  try {
    sync = require('./launcher-sync');
  } catch {
    return { ok: false, reason: 'lib/launcher-sync.js 不可用（并行单元未就绪）' };
  }
  try {
    return sync.syncLauncher(dataDir, pluginRoot);
  } catch (err) {
    return { ok: false, reason: err && err.message };
  }
}

module.exports = {
  SELF_PLUGIN_NAME,
  ENGINE_INJECTED_PLUGINS,
  computeActions,
  buildWrapperEntry,
  expandServerDef,
  applyTakeover,
  restoreAll,
  restoreOne,
  syncLauncherNow,
};
