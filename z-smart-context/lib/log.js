'use strict';

// 插件统一日志：一行时间戳文本追加到 ~/.zcode/z-smart-context/log/hook.log，并镜像 stderr。
// 为什么镜像 stderr：hook 进程的 stdout 是 additionalContext 注入契约通道（§2.2），
// 人读信息只能走 stderr；落盘则是为了会话结束后仍可排查（tail hook.log）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG_DIR = path.join(os.homedir(), '.zcode', 'z-smart-context', 'log');
const LOG_FILE = path.join(LOG_DIR, 'hook.log');

function emit(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  try {
    process.stderr.write(`${stamped}\n`);
  } catch {
    // stderr 写失败不影响主流程
  }
  // 先直接追加、目录缺失才补建——常态只花一次 syscall；日志自身任何写失败静默吞掉，
  // 日志不能成为故障源（否则提醒功能会被自己的诊断通道拖死）。
  try {
    fs.appendFileSync(LOG_FILE, `${stamped}\n`);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.appendFileSync(LOG_FILE, `${stamped}\n`);
      } catch {
        // 补建后仍失败（磁盘满/权限），放弃本条落盘
      }
    }
  }
}

function log(line) {
  emit(line);
}

function logError(line) {
  emit(`ERROR ${line}`);
}

module.exports = { log, logError };
