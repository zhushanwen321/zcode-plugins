'use strict';

/**
 * zsem 入口:被 zcode.cjs 的 trampoline 注入行 require(homedir 拼路径,见
 * patches/provider-sem.js)。协议(docs/api.md「挂点」节):
 *
 *   admit(payload) → { ticket: undefined, release } | undefined | Promise
 *
 * - payload 即 Kyt(admitAttempt)形参:model.providerId / model.modelId /
 *   signal / onQueued / onAdmitted;
 * - provider 未配置 → undefined(trampoline 走原生准入);
 * - 排队时:先 await onQueued,授予后 await onAdmitted(排队毫秒)——
 *   workflow actor 状态机依赖这两个事件推进相位(fact-check A15);
 * - 排队中 signal abort → 抛 ZsemCancelled(name="AbortError",挂
 *   __zsemCancel 标记):trampoline 对带标记错误 rethrow(取消语义上传播,
 *   调用方按原生 cancelled 路径处理),其他错误吞掉走原生;
 * - release 幂等(信号量层 once 守卫,调用方是双点调用模式,fact-check A14)。
 *
 * 本模块顶层零副作用、零依赖(plain node CJS),require 失败 = 永久 fail-open
 * 直到 zcode 重启,故顶层不得抛。
 */

const { createProviderSemaphores } = require('./lib/semaphore');
const { readLimits, resetCache, defaultConfigPath } = require('./lib/config');
const { logEvent, defaultLogPath } = require('./lib/log');

const sems = createProviderSemaphores();

/** failopen 日志节流:config 缺失/损坏是持续态,逐请求落一条会线性膨胀(修剪 ATK-B5) */
const FAILOPEN_LOG_INTERVAL_MS = 60000;
const failopenLastLog = Object.create(null); // why → lastLogAt(ms)

function logFailopenThrottled(why, fields) {
  const now = Date.now();
  if (now - (failopenLastLog[why] || 0) < FAILOPEN_LOG_INTERVAL_MS) return;
  failopenLastLog[why] = now;
  logEvent('failopen', { ...fields, why }, overrides.logPath);
}

/** 取消错误:name 与原生对齐(Ebo 判 AbortError),__zsemCancel 供 trampoline 区分误吞 */
class ZsemCancelled extends Error {
  constructor(reason) {
    super('zsem admission aborted');
    this.name = 'AbortError';
    if (reason !== undefined) this.cause = reason;
    this.__zsemCancel = true;
  }
}

/** 测试/复用注入点:默认路径外的 config/log */
const overrides = { configPath: undefined, logPath: undefined };

async function admit(payload) {
  const providerId = payload && payload.model && typeof payload.model.providerId === 'string' ? payload.model.providerId : null;
  if (!providerId) return undefined;

  let limits;
  try {
    limits = readLimits(overrides.configPath);
  } catch {
    limits = null;
  }
  if (!limits) {
    logFailopenThrottled('config-unavailable', { providerId });
    return undefined;
  }
  const limit = limits[providerId];
  if (!limit) return undefined; // 未配置的 provider:不接管,不打日志(高频)
  sems.setLimit(providerId, limit);

  const signal = payload.signal;
  const modelId = payload.model.modelId;
  logEvent('acquire', { providerId, modelId }, overrides.logPath);
  if (signal && signal.aborted) {
    throw new ZsemCancelled(signal.reason);
  }

  // 原生链是 await onQueued → acquire → await onAdmitted;信号量层在原子同步段
  // 决定时序(入队时/授予时),payload 回调桥接为 fire-and-forget(异常吞掉,
  // 不得反噬信号量)——回调是状态机事件发布,快且无返回值依赖。
  const callSafe = (fn, ...args) => {
    try {
      const r = fn && fn(...args);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      /* 状态回调异常不反噬准入 */
    }
  };

  let release;
  let grantedViaQueue = false;
  try {
    release = await sems.acquire(providerId, {
      signal,
      onQueued: () => {
        logEvent('queue', { providerId, modelId }, overrides.logPath);
        callSafe(payload.onQueued);
      },
      onAdmitted: (queuedMs) => {
        grantedViaQueue = true;
        logEvent('grant', { providerId, modelId, queuedMs }, overrides.logPath);
        callSafe(payload.onAdmitted, queuedMs);
      },
    });
    if (!grantedViaQueue) logEvent('grant', { providerId, modelId, queuedMs: 0 }, overrides.logPath);
  } catch (err) {
    if (signal && signal.aborted) {
      logEvent('cancel', { providerId, modelId }, overrides.logPath);
      throw new ZsemCancelled(signal.reason ?? err);
    }
    logFailopenThrottled('admit-error', { providerId, modelId });
    return undefined;
  }
  let released = false; // 调用方是双点调用(重试分支+finally),日志只记真实归还
  return {
    ticket: undefined,
    release() {
      if (released) return;
      released = true;
      logEvent('release', { providerId, modelId }, overrides.logPath);
      release();
    },
  };
}

module.exports = {
  admit,
  __forTest: { sems, ZsemCancelled, overrides, resetCache, defaultConfigPath, defaultLogPath },
};
