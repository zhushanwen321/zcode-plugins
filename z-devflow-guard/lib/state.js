/**
 * 会话标记状态：按会话 id 分片的 JSON 文件 + 同名 .waive 豁免文件。
 *
 * 隔离保证（用户裁决）：每个 zcode 会话的开启/关闭标志只存在于以自己
 * session id 命名的文件里，任何其他会话（含并行会话）都读不到、改不了
 * 别的会话的标志。没有跨会话共享的开关。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { STATE_TTL_MS } = require('./config');

function sanitizeSessionId(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return s.length ? s.slice(0, 128) : 'default';
}

function statePath(stateDir, sessionId) {
  return path.join(stateDir, sanitizeSessionId(sessionId) + '.json');
}

function waivePath(stateDir, sessionId) {
  return path.join(stateDir, sanitizeSessionId(sessionId) + '.waive');
}

function readMark(stateDir, sessionId) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(stateDir, sessionId), 'utf8'));
    if (!raw || !Array.isArray(raw.taskDirs)) return null;
    return {
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      sources: Array.isArray(raw.sources) ? raw.sources : [],
      taskDirs: raw.taskDirs.filter((d) => typeof d === 'string'),
    };
  } catch {
    return null;
  }
}

// 原子写：先写临时文件再 rename，避免并发 hook 留下半截 JSON
function writeMark(stateDir, mark, sessionId) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = statePath(stateDir, sessionId);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(mark) + '\n');
  fs.renameSync(tmp, file);
}

// 打开始标记。幂等：已有标记不重置（保留既有 taskDirs 与首次时间）
function markStart(stateDir, sessionId, source) {
  sweepStale(stateDir);
  const existing = readMark(stateDir, sessionId);
  if (existing) {
    if (source && !existing.sources.includes(source)) {
      existing.sources.push(source);
      writeMark(stateDir, existing, sessionId);
    }
    return existing;
  }
  const mark = { startedAt: new Date().toISOString(), sources: source ? [source] : [], taskDirs: [] };
  writeMark(stateDir, mark, sessionId);
  return mark;
}

function addTaskDir(stateDir, sessionId, taskDir) {
  const mark = readMark(stateDir, sessionId) || markStart(stateDir, sessionId, 'fingerprint');
  if (!mark.taskDirs.includes(taskDir)) {
    mark.taskDirs.push(taskDir);
    writeMark(stateDir, mark, sessionId);
  }
  return mark;
}

function isWaived(stateDir, sessionId) {
  try {
    fs.statSync(waivePath(stateDir, sessionId));
    return true;
  } catch {
    return false;
  }
}

function waive(stateDir, sessionId) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(waivePath(stateDir, sessionId), new Date().toISOString() + '\n');
}

function sweepStale(stateDir, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  let entries = [];
  try {
    entries = fs.readdirSync(stateDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.json') && !name.endsWith('.waive')) continue;
    const file = path.join(stateDir, name);
    try {
      const st = fs.statSync(file);
      if (now - st.mtimeMs > STATE_TTL_MS) fs.unlinkSync(file);
    } catch {
      // 并发会话同刻清理/写入的竞态失败忽略，下轮再清
    }
  }
}

module.exports = {
  sanitizeSessionId,
  statePath,
  waivePath,
  readMark,
  markStart,
  addTaskDir,
  isWaived,
  waive,
  sweepStale,
};
