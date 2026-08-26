'use strict';

// 配置面：读 <pluginDataDir>/config.json（enabled / tiers / dbPath），坏 JSON 回退默认并 warn；
// mtime+size 双键缓存热加载——hook 每轮触发都会读配置，mtime 或 size 均未变时直接返回缓存，
// 避免无谓 IO；任一变化才重新读盘，用户改配置后下一轮即生效（M5）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { logError } = require('./log');

const DEFAULTS = Object.freeze({
  enabled: true,
  tiers: Object.freeze([200000, 400000, 600000]),
  dbPath: path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite'),
});

function defaultConfig() {
  return { enabled: DEFAULTS.enabled, tiers: [...DEFAULTS.tiers], dbPath: DEFAULTS.dbPath };
}

// D2 normalize 规则（照搬 pi）：滤非正数 → 升序 → 截前 3 档 → 空回退默认。
// 只接受有限正 number：字符串/NaN/Infinity 一律滤除，避免脏配置悄悄改变判档语义。
function normalizeTiers(raw) {
  const positives = Array.isArray(raw)
    ? raw.filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
    : [];
  const sorted = [...positives].sort((a, b) => a - b).slice(0, 3);
  return sorted.length > 0 ? sorted : [...DEFAULTS.tiers];
}

const cache = new Map(); // pluginDataDir -> { mtimeMs, size, config }

function cachedCopy(hit) {
  return { enabled: hit.config.enabled, tiers: [...hit.config.tiers], dbPath: hit.config.dbPath };
}

function readConfig(pluginDataDir) {
  const file = path.join(pluginDataDir, 'config.json');
  let st;
  try {
    st = fs.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 无配置文件是常态（用户从未定制），静默用默认
      return defaultConfig();
    }
    throw err;
  }
  const hit = cache.get(pluginDataDir);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return cachedCopy(hit);
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // stat 与 read 之间文件被删的窄窗口，按无配置处理
      return defaultConfig();
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // §3.4：坏 JSON 回退默认 + warn 日志；不缓存失败结果，修复后下一轮自动生效
    logError(`[config] config.json 解析失败，回退默认配置: ${err.message}`);
    return defaultConfig();
  }
  const config = {
    enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULTS.enabled,
    tiers: normalizeTiers(parsed.tiers),
    dbPath:
      typeof parsed.dbPath === 'string' && parsed.dbPath.trim() !== ''
        ? parsed.dbPath
        : DEFAULTS.dbPath,
  };
  cache.set(pluginDataDir, { mtimeMs: st.mtimeMs, size: st.size, config });
  // 返回拷贝：外部 mutate 不得污染缓存
  return { ...config, tiers: [...config.tiers] };
}

module.exports = { DEFAULTS, normalizeTiers, readConfig };
