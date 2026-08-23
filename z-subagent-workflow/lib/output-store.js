'use strict';
/**
 * 输出落盘：outputs/<subagentId>.md（结果全文）与 <id>.patch（worktree 改动）。
 *
 * 为什么 tmp+rename 原子写：结果文件被通知文案/record/后续查询引用，读者
 * 在写入中途读到半截文件会拿到损坏内容且无自愈手段；rename(2) 在同目录内
 * 原子替换，读者要么看到旧版要么看到完整新版。tmp 名带 pid+时间戳，
 * 避免并发任务写同名 tmp 互相踩踏。
 */

const fs = require('node:fs');
const path = require('node:path');
const { outputsDir } = require('./config');

function atomicWrite(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true }); // outputs/ 可能尚未存在（首启/新 ZSW_ROOT）
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** @returns {string} 实际写入路径（进 record 与通知文案） */
function writeResult(id, text) {
  const file = pathFor(id);
  atomicWrite(file, text);
  return file;
}

/** @returns {string} patch 路径（进 record.patchFile，通知文案附 git apply 指引） */
function writePatch(id, diffText) {
  const file = path.join(outputsDir(), `${id}.patch`);
  atomicWrite(file, diffText);
  return file;
}

/** 结果文件路径（写前预知，便于失败清理与文案生成）。 */
function pathFor(id) {
  return path.join(outputsDir(), `${id}.md`);
}

module.exports = { writeResult, writePatch, pathFor };
