'use strict';

/**
 * zsem 状态发布:`~/.zcode/cli/zsem-status.json`
 *
 * 给进程外消费者(如 gen-metrics 扩展插件)读的并发快照。按 pid 分片:每个
 * zcode 进程的 zsem 实例只写自己的分片,读侧聚合全部 pid 求和——多窗口并行
 * 时总量也能正确显示(单文件 last-writer-wins 会互相覆盖分片)。
 *
 * 结构:{ "pids": { "<pid>": { "providers": { "<id>": {limit,active,queued} } },
 *         "updatedAt": "<iso>" } }
 *
 * 写入 = 读旧文件(损坏按空)→ 换本 pid 分片 → temp+rename 原子替换。并发写
 * 竞态(两进程同时读改写)窗口毫秒级、下次写入自愈,显示面可接受。任何失败
 * 静默(状态发布不得影响准入主流程)。
 *
 * 节流:MIN_PUBLISH_INTERVAL_MS 时间窗内多次状态变化合并为一次写入(窗口外首
 * 事件立即写保证可见性,窗口内后续只刷新待写值,由定时器在窗口尾补写)。badge
 * 是人眼消费的,300ms 滞后无感知;高并发流式场景(每秒多次 grant/release)写盘
 * 频率从事件数降为 ≤1/窗口。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MIN_PUBLISH_INTERVAL_MS = 300;

function defaultStatusPath() {
  return path.join(os.homedir(), '.zcode', 'cli', 'zsem-status.json');
}

/** 节流状态(单 zsem 实例单路径) */
let lastWriteAt = 0;
let pendingTimer = null;

/** 实际写盘(读取-合并-原子替换) */
function writeNow(providers, statusPath) {
  const file = statusPath || defaultStatusPath();
  let pids = {};
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (prev && typeof prev === 'object' && prev.pids && typeof prev.pids === 'object') {
      pids = prev.pids;
    }
  } catch {
    /* 缺失/损坏按空起 */
  }
  pids[String(process.pid)] = { providers, updatedAt: new Date().toISOString() };
  const next = JSON.stringify({ pids, updatedAt: new Date().toISOString() });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * @param {Record<string, {limit:number, active:number, queued:number}>} providers 信号量 snapshot()
 * @param {string} [statusPath] 覆盖路径(测试用)
 */
function publishStatus(providers, statusPath) {
  try {
    if (pendingTimer) {
      // 窗口内已有排程:只刷新待写值,到点写最新快照
      pendingTimer.providers = providers;
      return;
    }
    const now = Date.now();
    const elapsed = now - lastWriteAt;
    if (elapsed >= MIN_PUBLISH_INTERVAL_MS) {
      lastWriteAt = now;
      writeNow(providers, statusPath);
      return;
    }
    pendingTimer = { providers, statusPath };
    setTimeout(() => {
      const pending = pendingTimer;
      pendingTimer = null;
      if (!pending) return;
      lastWriteAt = Date.now();
      try {
        writeNow(pending.providers, pending.statusPath);
      } catch {
        /* 静默 */
      }
    }, MIN_PUBLISH_INTERVAL_MS - elapsed).unref();
  } catch {
    pendingTimer = null;
    /* 状态发布失败静默 */
  }
}

/** 测试辅助:清节流状态(定时器已 unref,不阻止进程退出) */
function resetThrottle() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  lastWriteAt = 0;
}

/** 测试辅助:清指定 pid 分片 */
function clearPid(statusPath, pid) {
  try {
    const file = statusPath || defaultStatusPath();
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (prev?.pids) delete prev.pids[String(pid)];
    fs.writeFileSync(file, JSON.stringify(prev), 'utf8');
  } catch {
    /* 静默 */
  }
}

/** 聚合读(扩展侧同构逻辑,单源在此):全部 pid 的 active/queued 求和、limit 取最大 */
function aggregate(statusPath) {
  try {
    const file = statusPath || defaultStatusPath();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = { active: 0, queued: 0, limit: 0, providers: {} };
    for (const shard of Object.values(raw?.pids ?? {})) {
      for (const [id, s] of Object.entries(shard?.providers ?? {})) {
        if (!out.providers[id]) out.providers[id] = { active: 0, queued: 0, limit: 0 };
        out.active += s.active;
        out.queued += s.queued;
        out.providers[id].active += s.active;
        out.providers[id].queued += s.queued;
        out.limit = Math.max(out.limit, s.limit);
        out.providers[id].limit = Math.max(out.providers[id].limit, s.limit);
      }
    }
    return out;
  } catch {
    return null;
  }
}

module.exports = { publishStatus, aggregate, defaultStatusPath, clearPid, resetThrottle, MIN_PUBLISH_INTERVAL_MS };
