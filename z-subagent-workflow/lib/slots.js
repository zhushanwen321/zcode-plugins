'use strict';
/**
 * 长驻并发槽位池（DESIGN-v3 D11）——core ConcurrencyPool strict-fifo 薄层。
 *
 * 仅服务 zsub start 线（回接 2b 起 workflow 线整体走 vendored subagent-core
 * 编排，其并发自治；旧的一次性批处理辅助 lib/pool.js 已随旧 workflow 运行时
 * 退役）。acquire/release 生命周期跟随 subagent 任务（start → done/cancel）。
 *
 * C5 收敛（E5 裁决）：并发计数与下限钳制（maxConcurrent 下限 1，maxConcurrent=0
 * 会永久排队死锁）单源到 core createConcurrencyPool，FIFO 策略以 strict-fifo
 * 显式注入（core 缺省 priority——策略差异保留为参数，测试锚定排队语义）。
 *
 * 深度分层：effectiveLimit = max(1, limit - depth)。
 * 学 pi（P4）防指数爆炸：嵌套 subagent 每深一层可用槽位少一个；
 * depth >= limit 时保底 1——深层任务只能串行，但不会被饿死。
 * 该公式与 core SubagentService.effectiveMaxConcurrentFor 同构（core 未导出
 * 该公式，本层镜像注册；core 侧公式登记处 = core concurrency-pool.ts 注释）。
 *
 * S-2 契约边界（为何 zsw 不传 effectiveMaxConcurrent）：core 池的分层配额
 * 仅在 acquire 时点强制（fast path 比较），release 出队不复检——若把
 * effectiveLimit 传给池，深层队首会在任意 release 时被无条件让位，破坏本层
 * 「队首 effective 不满足则连出队都不做」的头部门控。因此深度门控留在本层
 * pump（只看队首），本层只在门控放行（active < effectiveLimit <= limit）时
 * 才向池 acquire，池队列在本层用法下恒空；strict-fifo 是该契约的策略面
 * 显式锚定。
 *
 * 排队严格 FIFO：队首未满足时不允许后来者插队。宁可头部阻塞（深层任务
 * 等全空），不做按深度跳级——跳级会让深层任务在浅层任务持续涌入时
 * 永远拿不到槽位；严格 FIFO 天然无饥饿。
 */

const { requireCore } = require('./core-ref');

/**
 * @param {object} [opts]
 * @param {number} [opts.limit] 并发上限（>=1，缺省 1）
 * @returns {{acquire: (depth?: number) => Promise<function(): void>, running: () => number}}
 *          acquire 的 resolve 值是释放函数（幂等，多次调用只释放一次）。
 *          running() 是测试观测面：无生产消费者——manager 生产路径只走
 *          acquire 与释放函数，槽位是否回收由测试经 running() 断言。
 */
function createSlots({ limit } = {}) {
  const { createConcurrencyPool } = requireCore();
  const maxLimit = Math.max(1, Math.floor(limit) || 1);
  const pool = createConcurrencyPool({ maxConcurrent: maxLimit, queuePolicy: 'strict-fifo' });
  const queue = []; // FIFO：{depth, resolve}

  function effectiveLimit(depth) {
    return Math.max(1, maxLimit - depth);
  }

  /** 门控放行后的出队：池 fast path 由门控保证（active < effectiveLimit <=
   *  limit），池同步递增 active——running() 在 waiter resolve 前即可见。 */
  function grant(waiter) {
    let released = false;
    const release = () => {
      if (released) return; // 双重释放会把池计数拉负，破坏上限语义
      released = true;
      pool.release();
      pump();
    };
    pool.acquire(0).then(() => waiter.resolve(release));
  }

  function pump() {
    // 只看队首：严格 FIFO + 深度门控（S-2 边界见头注）。
    while (queue.length > 0 && pool.active < effectiveLimit(queue[0].depth)) {
      grant(queue.shift());
    }
  }

  function acquire(depth = 0) {
    return new Promise((resolve) => {
      queue.push({ depth, resolve });
      pump();
    });
  }

  return { acquire, running: () => pool.active };
}

module.exports = { createSlots };
