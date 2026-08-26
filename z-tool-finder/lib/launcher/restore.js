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
function acquireLock() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tryCreate = () => {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  };
  try {
    tryCreate();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let pid = NaN;
    try {
      pid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10);
    } catch {
      // 读失败（并发删除窗口）走 stale 分支重建
    }
    if (!(Number.isNaN(pid) || !isPidAlive(pid))) return null;
    fs.rmSync(LOCK_PATH, { force: true });
    tryCreate();
  }
  return () => fs.rmSync(LOCK_PATH, { force: true });
}

function usage() {
  process.stderr.write('用法: node restore.js [--all | <serverKey>]\n');
  process.exit(2);
}

const target = process.argv[2];
if (!target) usage();

const release = acquireLock();
if (!release) {
  process.stderr.write(
    `registry 锁被其他进程持有（${LOCK_PATH}，可能有并发接管/还原进行中），本次放弃。请稍后重试；` +
      `确认无 zcode 会话运行时也可删除该锁文件后重试。\n`
  );
  process.exit(1);
}

let exitCode = 0;
try {
  const reg = readJsonSafe(REGISTRY_PATH) || { servers: {} };
  reg.servers = reg.servers || {};
  if (!Object.keys(reg.servers).length) {
    process.stderr.write(`registry 无接管记录（${REGISTRY_PATH}），无需还原\n`);
  } else {
  const keys = target === '--all' ? Object.keys(reg.servers) : [target];
  const unknown = keys.filter((k) => !(k in reg.servers));
  if (unknown.length) {
    process.stderr.write(`registry 中不存在: ${unknown.join(', ')}。现有记录: ${Object.keys(reg.servers).join(', ')}\n`);
    exitCode = 1;
  } else {

  // 每个待还原 key 的 mutation（记录级、幂等，可对重读后的 config 重放）
  const mutations = keys.map((key) => {
    const entry = reg.servers[key];
    if (entry.scope === 'user') return { op: 'set', key, value: entry.original };
    return { op: 'del', key };
  });
  for (const key of keys) delete reg.servers[key];

  // 锁内重读 config + mtime 外部写防护 + 重试重放（引擎写 config 不走 registry 锁）
  const statMtimeMs = (file) => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null; // 不存在 = 首次创建，无冲突可言
    }
  };
  let saved = false;
  for (let i = 0; i < USER_CONFIG_MAX_RETRIES && !saved; i++) {
    const before = statMtimeMs(CONFIG_PATH);
    const cfg = readJsonSafe(CONFIG_PATH) || {};
    if (!cfg.mcp || typeof cfg.mcp !== 'object') cfg.mcp = {};
    if (!cfg.mcp.servers || typeof cfg.mcp.servers !== 'object') cfg.mcp.servers = {};
    for (const m of mutations) {
      if (m.op === 'set') cfg.mcp.servers[m.key] = m.value;
      else delete cfg.mcp.servers[m.key];
    }
    if (statMtimeMs(CONFIG_PATH) !== before) continue; // 引擎在读取后写过：丢弃副本重来
    writeJsonAtomic(CONFIG_PATH, cfg);
    saved = true;
  }
  if (!saved) {
    process.stderr.write(
      `config.json（${CONFIG_PATH}）在读取后被外部进程持续修改，本次跳过改写以免覆盖；` +
      `操作幂等，请稍后重试\n`
    );
    exitCode = 1;
  } else {
    writeJsonAtomic(REGISTRY_PATH, reg);
    process.stderr.write(`已还原 ${keys.length} 个 server: ${keys.join(', ')}（config: ${CONFIG_PATH}）\n`);
  }
  }
  }
} finally {
  release();
}
process.exit(exitCode);
