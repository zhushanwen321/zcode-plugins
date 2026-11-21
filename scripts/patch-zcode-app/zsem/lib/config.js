'use strict';

/**
 * zsem 配置读取:`~/.zcode/cli/zsem-config.json`
 *   { "providers": { "<providerId>": { "limit": 10 } } }
 *
 * - mtime 缓存:文件变化后下一次读取即时生效(mtime 变了重读);
 * - 缺失/损坏/字段非法 → 返回 null(调用方按 fail-open 处理,不接管);
 * - limit <= 0 视为非法条目(忽略该 provider,不产生永久排队)。
 * 读取本身的异常一律吞掉返回 null——配置系统故障不得拖垮 LLM 请求链路。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs) {
    return cache.value;
  }
  let value = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && raw.providers && typeof raw.providers === 'object') {
      const limits = {};
      for (const [id, entry] of Object.entries(raw.providers)) {
        const limit = entry && typeof entry === 'object' ? entry.limit : undefined;
        if (typeof id === 'string' && id.length > 0 && Number.isInteger(limit) && limit > 0) {
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

module.exports = { readLimits, resetCache, defaultConfigPath };
