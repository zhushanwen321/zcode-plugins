'use strict';
/**
 * 孤儿清扫（DESIGN-v3.md §3.2 D12；接线点：server 启动序列，W3 调用）。
 *
 * 边界声明——两个函数删除语义不同的原因：
 *   - worktree/分支是 zsub 自建的派生资源，record store 不再认识即可回收
 *     （reapWorktrees remove=true 自动删）；
 *   - outputs/ 下的结果与 patch 是用户资产，「id 不在 known 集合」可能只是
 *     record 重建窗口而非真孤儿——sweepStaleOutputs 只报告不删，删除永远
 *     需显式授权（人工或上层明确指令），本模块不越界。
 *
 * 现状声明：reapWorktrees 的 remove:true（授权后删）当前无生产入口——1.x
 * 唯一接线点 dist/mcp/server.js 启动序列恒传 remove:false（该入口已随 MCP
 * 壳退役，当前无接线点），worktree 的实际删除目前为人工执行；true 分支是
 * 「显式授权后删」的预留能力（语义由单测经真实 repo 覆盖）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { outputsDir } = require('./config');
const { listOrphans, cleanup } = require('./worktree');

/**
 * 清扫孤儿 worktree（基于 worktree.listOrphans 的物理面对账）。
 *
 * @param {object} p
 * @param {string} p.mainRepo
 * @param {string[]} [p.knownSubagentIds] 活任务 id 集合（record store 重建后提供）
 * @param {boolean} [p.remove=false]      false 只报告（默认，先看后删）；
 *                                        true 逐个 cleanup
 * @returns {Promise<{orphans: Array<{dir: string, branch: string, removed: boolean}>}>}
 *   removed = 目录确已消失（remove=false 时恒 false，未尝试删除）。
 */
async function reapWorktrees({ mainRepo, knownSubagentIds = [], remove = false } = {}) {
  const found = await listOrphans({ mainRepo, knownSubagentIds });
  const orphans = [];
  // 串行清理：一次 reaper 不并发打 N 个 git（pi 同款约束）
  for (const o of found) {
    let removed = false;
    if (remove) {
      await cleanup({ mainRepo, worktreeDir: o.dir, branch: o.branch });
      removed = !fs.existsSync(o.dir);
    }
    orphans.push({ dir: o.dir, branch: o.branch, removed });
  }
  return { orphans };
}

/**
 * 报告 outputs/ 下的孤儿结果文件（<id>.md / <id>.patch 而 id 不在 known 集合）。
 * 只报告不删除——见头注边界声明。
 *
 * 原子写残留的 .<id>.md.<pid>.<ts>.tmp 不匹配 <id>.md|.patch 形态，天然排除
 * （tmp 清扫属 notifier/server 启动序列职责，D4，不在本函数范围）。
 *
 * @param {object} p
 * @param {string[]} [p.knownSubagentIds]
 * @returns {{stale: Array<{file: string, subagentId: string}>}}
 */
function sweepStaleOutputs({ knownSubagentIds = [] } = {}) {
  const known = new Set(knownSubagentIds);
  let files;
  try {
    files = fs.readdirSync(outputsDir());
  } catch {
    return { stale: [] }; // outputs/ 尚不存在（首启/新 ZSW_ROOT）→ 无孤儿
  }
  const stale = [];
  for (const name of files) {
    const m = /^(.+)\.(md|patch)$/.exec(name);
    if (!m) continue;
    if (known.has(m[1])) continue;
    stale.push({ file: path.join(outputsDir(), name), subagentId: m[1] });
  }
  return { stale };
}

module.exports = { reapWorktrees, sweepStaleOutputs };
