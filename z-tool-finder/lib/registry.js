'use strict';
// 接管登记簿：registry.json 读写 + 单实例锁。
// 为什么锁在此模块：接管/restore 全路径需要互斥（设计文档 §7 并发防护），
// 锁与 registry 读写绑定为一个入口，防止调用方漏持锁直接写。

const fs = require('fs');
const path = require('path');

const LOCK_NAME = 'registry.lock';

class LockHeldError extends Error {
  constructor(pid) {
    super('registry 锁被 PID ' + pid + ' 持有，本次操作跳过（下个会话/稍后重试）');
    this.name = 'LockHeldError';
    this.pid = pid;
  }
}

function lockPath(dataDir) {
  return path.join(dataDir, LOCK_NAME);
}

function registryPath(dataDir) {
  return path.join(dataDir, 'registry.json');
}

// PID 存活探测：signal 0 不实际发信号，仅探测权限/存在性；ESRCH=进程不存在
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// 单实例锁：wx 模式原子创建；已存在时按「PID 存活 → 抛错；死亡/不可读 → stale 强制接管」处理。
// 不用 mtime 判 stale：存活持有者的临界区可能超任意超时（慢盘/重试重放/SIGSTOP），
// 按时间强抢会导致两个进程同时持锁，且原持有者 finally 会误删新锁（R1）。
function withLock(dataDir, fn) {
  const lock = lockPath(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  let acquired = false;
  try {
    const fd = fs.openSync(lock, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    acquired = true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // 已有锁：判断是否可接管
    let pid = NaN;
    try {
      pid = parseInt(fs.readFileSync(lock, 'utf8').trim(), 10);
    } catch {
      // 读失败（并发删除窗口）视为不可复用，走 stale 分支重建
    }
    const stale = Number.isNaN(pid) || !isPidAlive(pid);
    if (!stale) throw new LockHeldError(pid);
    fs.rmSync(lock, { force: true });
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      acquired = true;
    } catch (err) {
      // rm 与 wx 之间被第三进程抢建：按新持有者 PID 重新降级判断，
      // 不能让裸 EEXIST 冒出（绕过 LockHeldError 会让 hook 崩溃而非「跳过接管」）
      if (err.code !== 'EEXIST') throw err;
      let winner = NaN;
      try {
        winner = parseInt(fs.readFileSync(lock, 'utf8').trim(), 10);
      } catch {
        // 抢建者又在并发退出/删除：视为锁不可用，本轮放弃
      }
      throw new LockHeldError(Number.isNaN(winner) ? 0 : winner);
    }
  }
  try {
    return fn();
  } finally {
    // 只有本次成功拿到锁才删除，避免误删他人在 stale 判定后重建的锁
    if (acquired) fs.rmSync(lock, { force: true });
  }
}

/**
 * 结构归一化：合法 JSON 但字段缺失/类型不对（用户手工编辑 registry.json 极易发生
 * ——deny 报错文案就指引编辑 policies）时补默认值，不原样返回。
 * 否则 proxy 的 reg.policies[...] 会解引用 undefined 抛 TypeError，
 * 表现为该 server 全部 call_tool 报「wrapper 内部错误」（fail-closed 但不可诊断）。
 */
function normalizeRegistry(parsed) {
  const reg = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const next = {
    ...reg,
    servers: reg.servers && typeof reg.servers === 'object' && !Array.isArray(reg.servers) ? reg.servers : {},
    overrides: reg.overrides && typeof reg.overrides === 'object' && !Array.isArray(reg.overrides) ? reg.overrides : {},
    policies: reg.policies && typeof reg.policies === 'object' && !Array.isArray(reg.policies) ? reg.policies : {},
  };
  if (Array.isArray(reg.excluded)) next.excluded = reg.excluded;
  return next;
}

function loadRegistry(dataDir) {
  try {
    return normalizeRegistry(JSON.parse(fs.readFileSync(registryPath(dataDir), 'utf8')));
  } catch {
    // 不存在/损坏 → 空 registry（损坏时不抛：restore 缺记录可提示，比整体崩溃好）
    return { servers: {}, overrides: {}, policies: {} };
  }
}

// 原子写（tmp+rename 防半截读；防 last-writer-wins 靠 withLock + re-read + 记录级合并）
function saveRegistry(dataDir, reg) {
  const file = registryPath(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// 纯函数：插入/更新一条接管记录，返回新 reg（不 mutate 入参）
function upsertServer(reg, entry) {
  const prev = (reg.servers && reg.servers[entry.key]) || {};
  const next = {
    servers: {
      ...reg.servers,
      [entry.key]: {
        scope: entry.scope,
        original: entry.original,
        // 插件源接管时刻的插件根：catalog refresh 等消费方展开 ${ZCODE_PLUGIN_ROOT} 模板用
        pluginRoot: entry.pluginRoot === undefined ? null : entry.pluginRoot,
        wrapperEntry: entry.wrapperEntry,
        pinned: entry.pinned === undefined ? Boolean(prev.pinned) : Boolean(entry.pinned),
        takenOverAt: entry.takenOverAt || new Date().toISOString(),
      },
    },
    overrides: { ...reg.overrides },
    policies: { ...reg.policies },
  };
  return next;
}

// 纯函数：移除一条接管记录，返回新 reg；key 不存在时原样返回（等值新对象）
function removeServer(reg, key) {
  if (!reg.servers || !(key in reg.servers)) {
    return { servers: { ...reg.servers }, overrides: { ...reg.overrides }, policies: { ...reg.policies } };
  }
  const servers = { ...reg.servers };
  delete servers[key];
  return { servers, overrides: { ...reg.overrides }, policies: { ...reg.policies } };
}

module.exports = {
  LockHeldError,
  withLock,
  loadRegistry,
  saveRegistry,
  upsertServer,
  removeServer,
};
