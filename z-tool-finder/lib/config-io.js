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

// 识别 ztf 自身的 wrapper 条目（command=node args=[<launcher>, key, '--', ...]）。
// user config 里已接管的条目就是这种形态，再扫会把它当原始定义 → 递归包裹；
// 其真身只存在于 registry.original，变更应走 restore 后重接管
function isWrapperEntry(key, config) {
  return Boolean(
    config &&
    Array.isArray(config.args) &&
    config.args.length > 2 &&
    typeof config.args[0] === 'string' &&
    path.basename(config.args[0]) === 'proxy-launcher.js' &&
    config.args[1] === key &&
    config.args[2] === '--'
  );
}

// inline 插件目录 → { pluginName, root }；以 plugin.json 的 name 为准（目录名可能不同）
function resolveInlinePlugin(pluginDir) {
  const manifest = readJsonFile(path.join(pluginDir, '.zcode-plugin', 'plugin.json'));
  if (!manifest || !manifest.name) return null;
  return { pluginName: manifest.name, root: pluginDir };
}

// 供 withLock 等模块复用（保持单一定义点）
module.exports = { LOCK_STALE_MS };

// enabledPlugins 双形态归一化：zcode 实写对象形态 { "name@marketplace": true }，
// 部分旧版本/文档为数组 [ "name@marketplace" ]。对象形态 value false = 显式禁用，跳过。
function enabledPluginKeys(enabledPlugins) {
  if (Array.isArray(enabledPlugins)) return enabledPlugins;
  if (enabledPlugins && typeof enabledPlugins === 'object') {
    return Object.entries(enabledPlugins)
      .filter(([, v]) => v !== false)
      .map(([k]) => k);
  }
  return [];
}

// 插件 server 定义双读：根 .mcp.json 与 manifest mcpServers 字段
// （官方 diagnosing-mcp：Plugin 源 = <pluginRoot>/.mcp.json 或 manifest 的 mcpServers；
// zcode-cua 的 computer-use 只在 plugin.json，单读 .mcp.json 会漏）
// 同名 server manifest 优先（后 assign 覆盖）
function pluginMcpServers(root) {
  const servers = {};
  const mcp = readJsonFile(path.join(root, '.mcp.json'));
  if (mcp && mcp.mcpServers && typeof mcp.mcpServers === 'object') {
    Object.assign(servers, mcp.mcpServers);
  }
  const manifest = readJsonFile(path.join(root, '.zcode-plugin', 'plugin.json'));
  if (manifest && manifest.mcpServers && typeof manifest.mcpServers === 'object') {
    Object.assign(servers, manifest.mcpServers);
  }
  return servers;
}

// 官方 marketplace 默认启用插件的磁盘信号：plugins/data/<name>@<marketplace> 存在。
// 引擎的 defaultEnabled 硬编码在二进制内不落盘（2026-08 实证：zcode-cua/browser-use/
// document-skills/skill-creator/zcode-guide 默认启用但 enabledPlugins 无条目），
// data 目录是引擎实际加载过该插件的持久痕迹。已禁用插件的残留目录会误报——
// 取误报（多接管一个已停用 server）不取漏报（活跃 server 缺接管）。
function defaultEnabledCachePlugins(home) {
  const result = new Map(); // pluginName -> root（同名只取首个 marketplace）
  const cacheRoot = path.join(home, '.zcode', 'cli', 'plugins', 'cache');
  const dataRoot = path.join(home, '.zcode', 'cli', 'plugins', 'data');
  let marketplaces;
  try {
    marketplaces = fs.readdirSync(cacheRoot);
  } catch {
    return result;
  }
  for (const marketplace of marketplaces) {
    let names;
    try {
      names = fs.readdirSync(path.join(cacheRoot, marketplace));
    } catch {
      continue;
    }
    for (const name of names) {
      if (result.has(name)) continue;
      if (!fs.existsSync(path.join(dataRoot, name + '@' + marketplace))) continue;
      const base = path.join(cacheRoot, marketplace, name);
      const version = highestVersionDir(base);
      if (version) result.set(name, path.join(base, version));
    }
  }
  return result;
}

// 扫描三源，返回 [{ key, scope, pluginName, serverName, config }]
// key 归一化：user/workspace 用裸 server 名；插件源用 `plugin:<plugin>:<server>`
// （M0 探针实证：用户 config 覆盖插件 server 必须用全命名空间 key，裸名无效）
function scanServers({ home, workspaceRoot } = {}) {
  const results = [];
  const userConfig = loadUserConfig(home);

  // 源 1：user config mcp.servers（wrapper 条目跳过，防递归包裹）
  const userServers = (userConfig.mcp && userConfig.mcp.servers) || {};
  for (const [name, config] of Object.entries(userServers)) {
    if (isWrapperEntry(name, config)) continue;
    if (!isEligibleServer(config)) continue;
    results.push({ key: name, scope: 'user', pluginName: null, serverName: name, config, pluginRoot: null });
  }

  // 源 2：workspace config mcp.servers（文件不存在跳过）
  if (workspaceRoot) {
    const wsConfig = readJsonFile(path.join(workspaceRoot, '.zcode', 'config.json'));
    const wsServers = (wsConfig && wsConfig.mcp && wsConfig.mcp.servers) || {};
    for (const [name, config] of Object.entries(wsServers)) {
      if (!isEligibleServer(config)) continue;
      results.push({ key: name, scope: 'workspace', pluginName: null, serverName: name, config, pluginRoot: null });
    }
  }

  // 源 3：插件 server（.mcp.json + manifest mcpServers 双读）
  // 插件根解析三路合并，优先级 inline dirs > enabledPlugins 点名 cache > 官方默认启用（data 信号）
  const pluginRoots = new Map(); // pluginName -> root（inline 优先）
  const inlineDirs = (userConfig.plugins && userConfig.plugins.dirs) || [];
  for (const dir of inlineDirs) {
    const resolved = resolveInlinePlugin(dir);
    if (resolved) pluginRoots.set(resolved.pluginName, resolved.root);
  }
  const enabled = enabledPluginKeys(userConfig.plugins && userConfig.plugins.enabledPlugins);
  for (const entry of enabled) {
    const at = entry.lastIndexOf('@');
    if (at <= 0) continue; // 非法形态（无 marketplace 段）跳过
    const name = entry.slice(0, at);
    const marketplace = entry.slice(at + 1);
    if (pluginRoots.has(name)) continue; // inline 形态优先于 cache
    const base = path.join(home, '.zcode', 'cli', 'plugins', 'cache', marketplace, name);
    const version = highestVersionDir(base);
    if (version) pluginRoots.set(name, path.join(base, version));
  }
  for (const [name, root] of defaultEnabledCachePlugins(home)) {
    if (!pluginRoots.has(name)) pluginRoots.set(name, root);
  }

  for (const [pluginName, root] of pluginRoots) {
    const servers = pluginMcpServers(root);
    for (const [name, config] of Object.entries(servers)) {
      if (!isEligibleServer(config)) continue;
      results.push({
        key: 'plugin:' + pluginName + ':' + name,
        scope: 'plugin',
        pluginName,
        serverName: name,
        config,
        pluginRoot: root,
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
  const enabled = enabledPluginKeys(userConfig.plugins && userConfig.plugins.enabledPlugins);
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
