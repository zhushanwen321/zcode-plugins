'use strict';
// 配置源扫描与 user config 原子读写。
// 为什么独立成模块：三个配置源（user config / workspace config / 插件 .mcp.json）
// 的发现逻辑被 registry 状态机与 CLI status/doctor 共用，收敛在此避免漂移。

const fs = require('fs');
const path = require('path');

const USER_CONFIG_REL = path.join('.zcode', 'cli', 'config.json');
// 锁文件超时与 registry.js 保持一致（设计文档 §7 并发防护：30s 视为 stale）
const LOCK_STALE_MS = 30 * 1000;

function userConfigPath(home) {
  return path.join(home, USER_CONFIG_REL);
}

// 读 JSON 文件；不存在或损坏返回 null（调用方决定默认值），不让扫描路径因单个坏文件中断
function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// 原子写：同目录 tmp + rename，防读到半截文件（防 last-writer-wins 靠上层锁+re-read+合并）
function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

function loadUserConfig(home) {
  if (!home) throw new TypeError('loadUserConfig: home 参数必传（由调用方注入，不默认 os.homedir）');
  // 损坏配置不抛——返回 {} 让扫描跳过 user 源，比让整个 hook 崩溃更符合降级策略
  return readJsonFile(userConfigPath(home)) || {};
}

function saveUserConfig(cfg, home) {
  if (!home) throw new TypeError('saveUserConfig: home 参数必传（由调用方注入，不默认 os.homedir）');
  writeJsonAtomic(userConfigPath(home), cfg);
}

// 从目录名集合里取语义化最高版本（目录名即版本号，如 "1.2.0"）
function highestVersionDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  for (const name of entries) {
    if (!/^\d+\.\d+\.\d+/.test(name)) continue; // 非语义化目录（如 pre-release 之外的杂项）跳过
    if (!best || compareSemver(name, best) > 0) best = name;
  }
  return best;
}

function compareSemver(a, b) {
  const pa = a.split(/[.-]/).map((s) => parseInt(s, 10));
  const pb = b.split(/[.-]/).map((s) => parseInt(s, 10));
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// 条目过滤：只接管 stdio（缺 type 视为 stdio，与 zcode 默认一致）；enabled:false 显式禁用跳过
function isEligibleServer(config) {
  if (!config || typeof config !== 'object') return false;
  if (config.type && config.type !== 'stdio') return false;
  if (config.enabled === false) return false;
  return true;
}

// inline 插件目录 → { pluginName, root }；以 plugin.json 的 name 为准（目录名可能不同）
function resolveInlinePlugin(pluginDir) {
  const manifest = readJsonFile(path.join(pluginDir, '.zcode-plugin', 'plugin.json'));
  if (!manifest || !manifest.name) return null;
  return { pluginName: manifest.name, root: pluginDir };
}

// 供 withLock 等模块复用（保持单一定义点）
module.exports = { LOCK_STALE_MS };

// 扫描三源，返回 [{ key, scope, pluginName, serverName, config }]
// key 归一化：user/workspace 用裸 server 名；插件源用 `plugin:<plugin>:<server>`
// （M0 探针实证：用户 config 覆盖插件 server 必须用全命名空间 key，裸名无效）
function scanServers({ home, workspaceRoot } = {}) {
  const results = [];
  const userConfig = loadUserConfig(home);

  // 源 1：user config mcp.servers
  const userServers = (userConfig.mcp && userConfig.mcp.servers) || {};
  for (const [name, config] of Object.entries(userServers)) {
    if (!isEligibleServer(config)) continue;
    results.push({ key: name, scope: 'user', pluginName: null, serverName: name, config });
  }

  // 源 2：workspace config mcp.servers（文件不存在跳过）
  if (workspaceRoot) {
    const wsConfig = readJsonFile(path.join(workspaceRoot, '.zcode', 'config.json'));
    const wsServers = (wsConfig && wsConfig.mcp && wsConfig.mcp.servers) || {};
    for (const [name, config] of Object.entries(wsServers)) {
      if (!isEligibleServer(config)) continue;
      results.push({ key: name, scope: 'workspace', pluginName: null, serverName: name, config });
    }
  }

  // 源 3：插件 .mcp.json —— inline dirs + marketplace cache，两者都读
  const pluginRoots = new Map(); // pluginName -> root（inline 优先）
  const inlineDirs = (userConfig.plugins && userConfig.plugins.dirs) || [];
  for (const dir of inlineDirs) {
    const resolved = resolveInlinePlugin(dir);
    if (resolved) pluginRoots.set(resolved.pluginName, resolved.root);
  }
  const enabled = (userConfig.plugins && userConfig.plugins.enabledPlugins) || [];
  for (const entry of enabled) {
    const at = entry.lastIndexOf('@');
    if (at <= 0) continue; // 非法形态（无 marketplace 段）跳过
    const name = entry.slice(0, at);
    const marketplace = entry.slice(at + 1);
    if (pluginRoots.has(name)) continue; // inline 形态优先于 cache
    const base = path.join(home, '.zcode', 'cli', 'plugins', 'cache', marketplace, name);
    const version = highestVersionDir(base);
    if (!version) continue;
    pluginRoots.set(name, path.join(base, version));
  }

  for (const [pluginName, root] of pluginRoots) {
    const mcp = readJsonFile(path.join(root, '.mcp.json'));
    const servers = (mcp && mcp.mcpServers) || {};
    for (const [name, config] of Object.entries(servers)) {
      if (!isEligibleServer(config)) continue;
      results.push({
        key: 'plugin:' + pluginName + ':' + name,
        scope: 'plugin',
        pluginName,
        serverName: name,
        config,
      });
    }
  }

  return results;
}

// 当前插件自身根目录解析（inline dirs 中 plugin.json name 匹配者 > cache 最高版本）
function pluginRootFor({ home, pluginName }) {
  if (!home || !pluginName) return null;
  const userConfig = loadUserConfig(home);
  const inlineDirs = (userConfig.plugins && userConfig.plugins.dirs) || [];
  for (const dir of inlineDirs) {
    const resolved = resolveInlinePlugin(dir);
    if (resolved && resolved.pluginName === pluginName) return resolved.root;
  }
  const enabled = (userConfig.plugins && userConfig.plugins.enabledPlugins) || [];
  for (const entry of enabled) {
    const at = entry.lastIndexOf('@');
    if (at <= 0) continue;
    if (entry.slice(0, at) !== pluginName) continue;
    const base = path.join(home, '.zcode', 'cli', 'plugins', 'cache', entry.slice(at + 1), pluginName);
    const version = highestVersionDir(base);
    if (version) return path.join(base, version);
  }
  return null;
}

module.exports = {
  loadUserConfig,
  saveUserConfig,
  scanServers,
  pluginRootFor,
  LOCK_STALE_MS,
};
