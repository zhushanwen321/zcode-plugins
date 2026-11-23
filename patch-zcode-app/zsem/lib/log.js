'use strict';

/**
 * zsem 观测日志:JSONL 追加写(默认 `~/.zcode/cli/zsem-log.jsonl`)。
 * 事件类型:acquire / grant / queue / release / cancel / failopen。
 * 写失败/非常规文件(FIFO、目录——同步 open 对它们会永久阻塞,冻结事件循环)
 * 静默跳过(观测不得影响主流程);损坏行由消费侧(status)跳过。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function defaultLogPath() {
  return path.join(os.homedir(), '.zcode', 'cli', 'zsem-log.jsonl');
}

/**
 * @param {string} type 事件类型
 * @param {Record<string, unknown>} [fields]
 * @param {string} [logPath] 覆盖路径(测试用)
 */
function logEvent(type, fields = {}, logPath) {
  try {
    const file = logPath || defaultLogPath();
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      if (err.code !== 'ENOENT') return; // 不可 stat:静默跳过
      stat = null; // 文件不存在:append 会创建,正常继续
    }
    if (stat && !stat.isFile()) return; // FIFO/目录/设备:静默跳过,不阻塞不抛
    const line = JSON.stringify({ t: new Date().toISOString(), type, ...fields }) + '\n';
    fs.appendFileSync(file, line, 'utf8');
  } catch {
    /* 观测失败静默 */
  }
}

module.exports = { logEvent, defaultLogPath };
