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

// 自身主 server 的宿主插件名：接管自己会递归（wrapper 之上再套 wrapper）
const SELF_PLUGIN_NAME = 'z-tool-finder';
const PRESCAN_ENTRIES_FILENAME = 'prescan-entries.json';

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
  const explicit = Array.isArray(names) ? new Set(names) : null;

  const toTakeover = [];
  const taken = [];
  const excluded = [];
  for (const entry of entries) {
    if (entry.pluginName === SELF_PLUGIN_NAME) continue; // 自身跳过
    if (reg && reg.servers && reg.servers[entry.key]) {
      taken.push(entry.key); // 已接管，幂等跳过
      continue;
    }
    if (excludedList.includes(entry.key)) {
      excluded.push(entry.key);
      continue;
    }
    if (entry.scope === 'workspace' && !(explicit && explicit.has(entry.key))) {
      continue; // workspace 级仅显式接管
    }
    if (explicit && !explicit.has(entry.key)) {
      continue; // 显式模式：只接管点名的 key（各 scope 均可，含 workspace）
    }
    toTakeover.push({ key: entry.key, scope: entry.scope, config: entry.config });
  }
  return { toTakeover, taken, excluded };
}

/**
 * 构造写进 user config mcp.servers[key] 的 wrapper 条目。
 * key 即 scanServers 的归一化 key（user 级裸名 / 插件级 plugin:<p>:<s>，
 * M0 探针实证此覆盖形态有效）。
 */
function buildWrapperEntry(serverEntry, dataDir = DATA_DIR) {
  const launcher = path.join(dataDir, 'launcher', 'proxy-launcher.js');
  const origArgs = Array.isArray(serverEntry.config.args) ? serverEntry.config.args : [];
  return {
    type: 'stdio',
    command: 'node',
    args: [launcher, serverEntry.key, '--', ...origArgs],
    env: serverEntry.config.env ? { ...serverEntry.config.env } : {},
    enabled: true,
  };
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
      for (const t of actions.toTakeover) {
        const wrapperEntry = buildWrapperEntry(t, dir);
        next = upsertServer(next, { key: t.key, scope: t.scope, original: t.config, wrapperEntry });
        cfg.mcp.servers[t.key] = wrapperEntry;
        newEntries.push({ key: t.key, config: t.config });
      }

      if (newEntries.length) {
        saveUserConfig(cfg, home);
        saveRegistry(dir, next);
        // 预扫描预算（§7）：不在调用方同步路径内等结果，daemon 化后台执行
        const entriesFile = writeEntriesFile(dir, newEntries);
        backgroundPrescan(dir, entriesFile);
      }

      return {
        taken: [...newEntries.map((e) => e.key), ...actions.taken],
        newly: newEntries.map((e) => e.key),
        skipped: [...actions.excluded],
        needsRestart: newEntries.length > 0,
      };
    });
  } catch (err) {
    if (degradeOnLock && err instanceof LockHeldError) {
      return { taken: [], newly: [], skipped: [], needsRestart: false, degraded: 'lock-held' };
    }
    throw err;
  }
}

/**
 * 还原一个 server：scope user → user config 恢复 original；
 * scope plugin/workspace → 删除 user config 覆盖条目（原始定义仍在插件/仓库配置里）。
 * 返回还原后的 registry 与 user config（不落盘，由 restoreMany 统一保存）。
 */
function restoreEntry(reg, cfg, key) {
  const rec = reg.servers && reg.servers[key];
  if (!rec) return false;
  if (!cfg.mcp || !cfg.mcp.servers) return false;
  if (rec.scope === 'user') {
    // user 级 key 即裸 server 名，原位恢复
    cfg.mcp.servers[key] = rec.original;
  } else {
    // plugin/workspace 级：接管是 user config 里的覆盖条目，删除即还原
    delete cfg.mcp.servers[key];
  }
  return true;
}

/** restore 公共路径：withLock 内逐 key 还原 + removeServer + 原子落盘 */
function restoreKeys({ home, dataDir, keys }) {
  const dir = dataDir || DATA_DIR;
  return withLock(dir, () => {
    const reg = loadRegistry(dir);
    const cfg = loadUserConfig(home);
    let next = reg;
    const restored = [];
    const missing = [];
    for (const key of keys) {
      if (restoreEntry(next, cfg, key)) {
        next = removeServer(next, key);
        restored.push(key);
      } else {
        missing.push(key); // registry 无记录或 user config 无该段：无法还原，如实报告
      }
    }
    saveUserConfig(cfg, home);
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
  computeActions,
  buildWrapperEntry,
  applyTakeover,
  restoreAll,
  restoreOne,
  syncLauncherNow,
};
