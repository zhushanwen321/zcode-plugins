/**
 * 计数状态：按会话统计用户消息数，每 N 条命中一次注入轮。
 * 状态文件按会话分片存放在 state/ 下，写入时惰性清理超过保留期的旧文件。
 * ZWR_DATA_DIR 供测试注入隔离目录。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = process.env.ZWR_DATA_DIR || path.join(os.homedir(), '.zcode', 'z-words-reminder');
const STATE_DIR = path.join(DATA_DIR, 'state');
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EVERY = 3;

function sanitizeSessionId(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return s.length ? s.slice(0, 128) : 'default';
}

function statePath(stateDir, key) {
  return path.join(stateDir, key + '.json');
}

function readCount(stateDir, key) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(stateDir, key), 'utf8'));
    return Number.isInteger(raw.count) && raw.count >= 0 ? raw.count : 0;
  } catch {
    return 0;
  }
}

function writeCount(stateDir, key, count) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(statePath(stateDir, key), JSON.stringify({ count }) + '\n');
}

function sweepStale(stateDir, nowMs) {
  let entries = [];
  try {
    entries = fs.readdirSync(stateDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(stateDir, name);
    try {
      const st = fs.statSync(file);
      if (nowMs - st.mtimeMs > STATE_TTL_MS) fs.unlinkSync(file);
    } catch {
      // 竞态（并发会话同刻清理/写入）失败忽略，下次再清
    }
  }
}

/**
 * 计数 +1 并返回本轮是否命中注入。
 * 返回 { inject: boolean, count: number }。
 */
function tick(sessionId, opts) {
  const o = opts || {};
  const stateDir = o.stateDir || STATE_DIR;
  const every = o.every || EVERY;
  const key = sanitizeSessionId(sessionId);
  sweepStale(stateDir, o.nowMs != null ? o.nowMs : Date.now());
  const count = readCount(stateDir, key) + 1;
  writeCount(stateDir, key, count);
  return { inject: count % every === 0, count };
}

function reset(stateDir) {
  fs.rmSync(stateDir || STATE_DIR, { recursive: true, force: true });
}

module.exports = { DATA_DIR, STATE_DIR, EVERY, sanitizeSessionId, tick, reset };
