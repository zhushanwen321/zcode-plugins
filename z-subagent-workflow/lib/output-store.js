'use strict';
/**
 * 输出落盘：outputs/<subagentId>.md（结果全文）。patch 文件（<id>.patch）由
 * worktree.js collectPatch 单点产出，不经本模块。
 *
 * 为什么原子写：结果文件被通知文案/record/后续查询引用，读者在写入中途读到
 * 半截文件会拿到损坏内容且无自愈手段；tmp+rename 在同目录内原子替换，读者
 * 要么看到旧版要么看到完整新版。
 *
 * C15 收敛：tmp+rename 手写实现退役，改调 core writeAtomicFileSync（write
 * 失败由 core 清理残留 tmp、ensureDir 内建）。tmp 名随 core atomic-write 约定
 * 为 `<final>.tmp.<pid>.<seq>-<rand>`——不以 .md/.patch 结尾，reaper
 * sweepStaleOutputs 的孤儿识别（/\.(md|patch)$/）天然排除，排除约定不破
 * （worktree.js 同目录自写的 `.tmp` 后缀形态同理仍被排除）。
 */

const path = require('node:path');
const { outputsDir } = require('./config');
const { requireCore } = require('./core-ref');

function atomicWrite(file, text) {
  requireCore().writeAtomicFileSync(file, text); // ensureDir 内建：outputs/ 首启/新 ZSW_ROOT 可能尚未存在
}

/** @returns {string} 实际写入路径（进 record 与通知文案） */
function writeResult(id, text) {
  const file = pathFor(id);
  atomicWrite(file, text);
  return file;
}

/** 结果文件路径（写前预知，便于失败清理与文案生成）。 */
function pathFor(id) {
  return path.join(outputsDir(), `${id}.md`);
}

module.exports = { writeResult, pathFor };
