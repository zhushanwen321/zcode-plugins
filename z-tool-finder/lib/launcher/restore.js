/**
 * lib/launcher/restore.js — 独立还原入口（零依赖单文件）
 *
 * 插件可能已卸载，因此本文件禁止 require 任何 lib/ 模块（只用 node 内置）。
 * 用法：
 *   node restore.js --all          还原全部接管 server
 *   node restore.js <serverKey>    还原指定 server
 *
 * 行为（与 lib/takeover.js restoreEntry 语义同源）：读 registry.json →
 * scope==='user' 时把 original 写回 config 的 mcp.servers[serverName]；
 * scope==='plugin'/'workspace' 时删除 mcp.servers 里的覆盖条目
 * （原始定义仍在插件 .mcp.json / 仓库 workspace config，不进 user config）。
 * 随后从 registry 移除该记录，两个文件均原子写。
 *
 * 并发防护：内联实现与 lib/registry.js withLock 同款的 wx 锁协议
 * （PID 存活检测），防止与并发 takeover 互相覆盖（last-writer-wins）。
 * 另：registry 锁不覆盖 zcode 引擎对 config.json 的写——落盘前比对 mtime，
 * 外部已改则重读重放（记录级 set/del 幂等），连续冲突时放弃本轮并报错，
 * 与 lib/takeover.js guardedSaveUserConfig 同款防护（R4）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.ZTF_DATA_DIR || path.join(os.homedir(), '.zcode', 'z-tool-finder');
const REGISTRY_PATH = path.join(DATA_DIR, 'registry.json');
const LOCK_PATH = path.join(DATA_DIR, 'registry.lock');
const CONFIG_PATH = path.join(os.homedir(), '.zcode', 'cli', 'config.json');
const USER_CONFIG_MAX_RETRIES = 5;

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 原子写：同目录 tmp + rename（内联实现，几行即可）
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// PID 存活探测：signal 0 不实际发信号；ESRCH=进程不存在，EPERM=存在但非本用户进程
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// 单实例锁（与 lib/registry.js 同协议）：wx 原子创建；
// 已存在时「PID 存活 → 拒绝执行；死亡/不可读 → stale 接管重建」（不用 mtime
// 判 stale：存活持有者临界区慢于任意超时时按时间强抢会导致双持锁 + 误删新锁）。
// 返回 release 函数；锁被活跃持有者占用时返回 null。
function acquireLock(dataDir = DATA_DIR, lockPath = LOCK_PATH) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tryCreate = () => {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  };
  try {
    tryCreate();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let pid = NaN;
    try {
      pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    } catch {
      // 读失败（并发删除窗口）走 stale 分支重建
    }
    if (!(Number.isNaN(pid) || !isPidAlive(pid))) return null;
    fs.rmSync(lockPath, { force: true });
    try {
      tryCreate();
    } catch (err) {
      // rm 与 wx 之间被第三进程抢建：不冒裸 EEXIST，按锁被持有降级（本轮放弃）
      if (err.code !== 'EEXIST') throw err;
      return null;
    }
  }
  return () => fs.rmSync(lockPath, { force: true });
}

const statMtimeMs = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null; // 不存在 = 首次创建，无冲突可言
  }
};

/**
 * 带外部写检测的 config 落盘（与 lib/takeover.js guardedSaveUserConfig 同款）：
 * 每次重读 → 重放 mutations → 落盘前比对 mtime（外部已改则丢弃副本重来）。
 * simulateExternalWrite 仅供测试注入并发写（在 mtime 比对前触发，模拟引擎恰在
 * 读取后写 config）。返回 true=已落盘，false=连续冲突重试耗尽。
 */
function guardedConfigSave(configPath, mutations, { maxRetries = USER_CONFIG_MAX_RETRIES, simulateExternalWrite } = {}) {
  for (let i = 0; i < maxRetries; i++) {
    const before = statMtimeMs(configPath);
    const cfg = readJsonSafe(configPath) || {};
    if (!cfg.mcp || typeof cfg.mcp !== 'object') cfg.mcp = {};
    if (!cfg.mcp.servers || typeof cfg.mcp.servers !== 'object') cfg.mcp.servers = {};
    for (const m of mutations) {
      if (m.op === 'set') cfg.mcp.servers[m.key] = m.value;
      else delete cfg.mcp.servers[m.key];
    }
    if (simulateExternalWrite) simulateExternalWrite(i);
    if (statMtimeMs(configPath) !== before) continue; // 引擎在读取后写过：丢弃副本重来
    writeJsonAtomic(configPath, cfg);
    return true;
  }
  return false;
}

/**
 * 还原主流程（锁 → registry 读 → mutations → guarded config save → registry 落盘）。
 * 与脚本入口分离以便测试注入路径与并发写模拟；不 process.exit，返回 { exitCode, messages }。
 */
function runRestore({ dataDir = DATA_DIR, registryPath = REGISTRY_PATH, lockPath = LOCK_PATH, configPath = CONFIG_PATH, target, simulateExternalWrite } = {}) {
  if (!target) return { exitCode: 2, messages: ['用法: node restore.js [--all | <serverKey>]'] };
  const release = acquireLock(dataDir, lockPath);
  if (!release) {
    return {
      exitCode: 1,
      messages: [
        `registry 锁被其他进程持有（${lockPath}，可能有并发接管/还原进行中），本次放弃。请稍后重试；` +
          `确认无 zcode 会话运行时也可删除该锁文件后重试。`,
      ],
    };
  }
  let exitCode = 0;
  const messages = [];
  try {
    const reg = readJsonSafe(registryPath) || { servers: {} };
    reg.servers = reg.servers || {};
    if (!Object.keys(reg.servers).length) {
      messages.push(`registry 无接管记录（${registryPath}），无需还原`);
      return { exitCode, messages };
    }
    const keys = target === '--all' ? Object.keys(reg.servers) : [target];
    const unknown = keys.filter((k) => !(k in reg.servers));
    if (unknown.length) {
      messages.push(`registry 中不存在: ${unknown.join(', ')}。现有记录: ${Object.keys(reg.servers).join(', ')}`);
      return { exitCode: 1, messages };
    }

    // 每个待还原 key 的 mutation（记录级、幂等，可对重读后的 config 重放）
    const mutations = keys.map((key) => {
      const entry = reg.servers[key];
      if (entry.scope === 'user') return { op: 'set', key, value: entry.original };
      return { op: 'del', key };
    });
    for (const key of keys) delete reg.servers[key];

    const saved = guardedConfigSave(configPath, mutations, { simulateExternalWrite });
    if (!saved) {
      messages.push(
        `config.json（${configPath}）在读取后被外部进程持续修改，本次跳过改写以免覆盖；` +
          '操作幂等，请稍后重试'
      );
      return { exitCode: 1, messages };
    }
    writeJsonAtomic(registryPath, reg);
    messages.push(`已还原 ${keys.length} 个 server: ${keys.join(', ')}（config: ${configPath}）`);
  } finally {
    release();
  }
  return { exitCode, messages };
}

module.exports = { guardedConfigSave, runRestore, isPidAlive };

if (require.main === module) {
  const { exitCode, messages } = runRestore({ target: process.argv[2] });
  for (const m of messages) process.stderr.write(m + '\n');
  process.exit(exitCode);
}
