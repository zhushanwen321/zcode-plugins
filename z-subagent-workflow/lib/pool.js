'use strict';

/**
 * 简单并发池：保持输入顺序映射结果，超出 limit 自动排队。
 * 对标 pi-subagent-workflow 的 maxConcurrent 语义（默认 6；我们默认 3，
 * 因为每任务是一个完整 zcode 进程，比 pi 的 worker 更重）。
 */

/**
 * @param {Array} items
 * @param {number} limit 并发上限（>=1）
 * @param {(item, index) => Promise<any>} fn
 * @returns {Promise<Array<any>>} 与 items 等长、按序的结果数组
 */
async function runWithLimit(items, limit, fn) {
  const n = Math.max(1, Math.min(limit | 0 || 1, items.length || 1));
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = { runWithLimit };
