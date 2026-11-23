'use strict';

/**
 * per-provider FIFO 信号量(进程内,zcode 进程唯一实例)。
 *
 * 语义对齐原生准入(admitIn):
 * - signal 已中止时 acquire 立即 reject(signal.reason),不入队;
 * - 排队中中止:把 waiter 摘出队列后 reject(signal.reason);
 * - release 幂等(once 守卫)——调用方(Kyt 的 Wwo/Qwo)对同一 ticket 是
 *   「重试分支显式调 + finally 兜底调」双点模式(见 docs/fact-check.md A14);
 * - FIFO 无跳级:队首未满足不授予后来者。
 */

/**
 * @returns {{acquire: (providerId: string, opts?: {signal?: AbortSignal, onQueued?: () => void, onAdmitted?: (queuedMs: number) => void}) => Promise<() => void>,
 *            setLimit: (providerId: string, limit: number) => void,
 *            snapshot: () => Record<string, {limit: number, active: number, queued: number}>}}
 *
 * onQueued/onAdmitted 语义(对齐原生 tryAcquire→onQueued→acquire 链,消除外部
 * 决策竞态):onQueued 在「确定入队」的同步段调用;onAdmitted(queuedMs) 在排队后
 * 授予时调用;立即授予两者都不调(与原生 fast path 一致)。
 */
function createProviderSemaphores() {
  /** @type {Map<string, {limit: number, active: number, queue: Array<{grant:(r:()=>void)=>void, reject:(e:unknown)=>void, signal?: AbortSignal, onAbort?: () => void}>}>} */
  const pools = new Map();

  function ensure(providerId) {
    let pool = pools.get(providerId);
    if (!pool) {
      pool = { limit: 0, active: 0, queue: [] };
      pools.set(providerId, pool);
    }
    return pool;
  }

  function detach(pool, waiter) {
    const i = pool.queue.indexOf(waiter);
    if (i >= 0) pool.queue.splice(i, 1);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
  }

  function pump(pool) {
    while (pool.queue.length > 0 && pool.active < pool.limit) {
      const waiter = pool.queue[0];
      if (waiter.signal && waiter.signal.aborted) {
        detach(pool, waiter);
        waiter.reject(waiter.signal.reason);
        continue;
      }
      detach(pool, waiter);
      pool.active += 1;
      waiter.grant(makeRelease(pool));
    }
  }

  function makeRelease(pool) {
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      pool.active -= 1;
      pump(pool);
    };
    return release;
  }

  function acquire(providerId, opts = {}) {
    const pool = ensure(providerId);
    const signal = opts.signal;
    if (signal && signal.aborted) return Promise.reject(signal.reason);
    if (pool.active < pool.limit && pool.queue.length === 0) {
      pool.active += 1;
      return Promise.resolve(makeRelease(pool));
    }
    const queuedAt = Date.now();
    if (opts.onQueued) opts.onQueued();
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: (release) => {
          if (opts.onAdmitted) opts.onAdmitted(Date.now() - queuedAt);
          resolve(release);
        },
        reject,
        signal,
        onAbort: undefined,
      };
      waiter.onAbort = () => {
        detach(pool, waiter);
        reject(signal.reason);
      };
      pool.queue.push(waiter);
      if (signal) signal.addEventListener('abort', waiter.onAbort, { once: true });
      // 入队+注册 listener 之后补查一次:onQueued 回调可能在同步段内已触发 abort
      // (事件早于 listener 注册),此时按取消路径立即摘除,不留占位等待者
      if (signal && signal.aborted) waiter.onAbort();
    });
  }

  function setLimit(providerId, limit) {
    const pool = ensure(providerId);
    pool.limit = limit;
    pump(pool);
  }

  function snapshot() {
    const out = {};
    for (const [id, pool] of pools) {
      out[id] = { limit: pool.limit, active: pool.active, queued: pool.queue.length };
    }
    return out;
  }

  return { acquire, setLimit, snapshot };
}

module.exports = { createProviderSemaphores };
