'use strict';

/**
 * zsem 配置读取:`~/.zcode/cli/zsem-config.json`
 *   { "providers": { "<providerId>": { "limit": 10 } } }
 *
 * - mtime 缓存:文件变化后下一次读取即时生效(mtime 变了重读);
 * - 缺失/损坏/字段非法/非常规文件(FIFO、目录、设备) → 返回 null(调用方按
 *   fail-open 处理,不接管)——同步 IO 对 FIFO 会永久阻塞,必须前置 isFile 检查;
 * - limit 必须为 (0, MAX_LIMIT] 的整数,providerId 长度 ≤ MAX_ID_LEN(超限条目
 *   忽略,不产生巨量日志或恒真限流);
 * - 键只认自有属性(Object.hasOwn,防 constructor 等原型链键命中);
 * - 截断覆盖式保存的撕裂读 → null → fail-open 放行(亚毫秒窗口,api.md 登记)。
 * 读取本身的异常一律吞掉返回 null——配置系统故障不得拖垮 LLM 请求链路。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_LIMIT = 10000;
const MAX_ID_LEN = 256;

function defaultConfigPath() {
  return path.join(os.homedir(), '.zcode', 'cli', 'zsem-config.json');
}

/** @type {{file: string, mtimeMs: number, value: Record<string, number> | null} | null} */
let cache = null;

/**
 * @param {string} [configPath]
 * @returns {Record<string, number> | null} providerId → limit;null = 整体不可用
 */
function readLimits(configPath) {
  const file = configPath || defaultConfigPath();
  let stat;
  try {
    // stat(跟随 symlink)后必须 isFile:FIFO/目录/设备一律按不可用处理——
    // readFileSync 对无数据 FIFO 会永久阻塞,事件循环冻结即 fail-open 失效;
    // symlink 指向正常文件是合法形态(dotfiles 管理),不得拒绝。
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs) {
    return cache.value;
  }
  let value = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && raw.providers && typeof raw.providers === 'object') {
      const limits = Object.create(null);
      for (const [id, entry] of Object.entries(raw.providers)) {
        const limit = entry && typeof entry === 'object' ? entry.limit : undefined;
        if (
          typeof id === 'string' &&
          id.length > 0 &&
          id.length <= MAX_ID_LEN &&
          Number.isInteger(limit) &&
          limit > 0 &&
          limit <= MAX_LIMIT
        ) {
          limits[id] = limit;
        }
      }
      value = limits;
    }
  } catch {
    value = null;
  }
  cache = { file, mtimeMs: stat.mtimeMs, value };
  return value;
}

/** 测试辅助:清缓存 */
function resetCache() {
  cache = null;
}

module.exports = { readLimits, resetCache, defaultConfigPath, MAX_LIMIT, MAX_ID_LEN };
