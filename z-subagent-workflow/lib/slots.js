'use strict';
/**
 * 长驻并发槽位池（DESIGN-v3 D11）。
 *
 * 仅服务 zsub start 线（回接 2b 起 workflow 线整体走 vendored subagent-core
 * 编排，其并发自治；旧的一次性批处理辅助 lib/pool.js 已随旧 workflow 运行时
 * 退役）。acquire/release 生命周期跟随 subagent 任务（start → done/cancel）。
 *
 * 深度分层：effectiveLimit = max(1, limit - depth)。
 * 学 pi（P4）防指数爆炸：嵌套 subagent 每深一层可用槽位少一个；
 * depth >= limit 时保底 1——深层任务只能串行，但不会被饿死。
 *
 * 排队严格 FIFO：队首未满足时不允许后来者插队。宁可头部阻塞（深层任务
 * 等全空），不做按深度跳级——跳级会让深层任务在浅层任务持续涌入时
 * 永远拿不到槽位；严格 FIFO 天然无饥饿。
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.limit] 并发上限（>=1，缺省 1）
 * @returns {{acquire: (depth?: number) => Promise<function(): void>, running: () => number}}
 *          acquire 的 resolve 值是释放函数（幂等，多次调用只释放一次）。
 */
function createSlots({ limit } = {}) {
  const maxLimit = Math.max(1, Math.floor(limit) || 1);
  let running = 0;
  const queue = []; // FIFO：{depth, resolve}

  function effectiveLimit(depth) {
    return Math.max(1, maxLimit - depth);
  }

  function grant() {
    let released = false;
    return () => {
      if (released) return; // 双重释放会把计数拉负，破坏上限语义
      released = true;
      running -= 1;
      pump();
    };
  }

  function pump() {
    // 只看队首：严格 FIFO。running 在 resolve 前同步递增，
    // 连续 acquire 的计数立即可见（不等微任务）。
    while (queue.length > 0 && running < effectiveLimit(queue[0].depth)) {
      const waiter = queue.shift();
      running += 1;
      waiter.resolve(grant());
    }
  }

  function acquire(depth = 0) {
    return new Promise((resolve) => {
      queue.push({ depth, resolve });
      pump();
    });
  }

  return { acquire, running: () => running };
}

module.exports = { createSlots };
