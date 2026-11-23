/**
 * 会话模型判定与守望挂起检测。
 *
 * 模型判定链：db message 表该会话最近一条带 modelId 的消息 → 回落 config.json 的
 * model.main（首轮请求 db 尚无该会话消息行时）。
 * GLM 套餐判定 = modelId 以 GLM 开头且 providerId 为 account: 前缀（订阅套餐，
 * 有 5 小时窗口可守望；builtin: 等自配 API key 形态按 token 计费，无窗口，忽略）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  DB_PATH,
  USER_CONFIG_PATH,
  WATCH_BINARY,
  FAILURE_COOLDOWN_MS,
  COUNT_TTL_MS,
  SESSION_TTL_MS,
} = require('./config');

function sanitizeSessionId(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return s.length ? s.slice(0, 128) : 'default';
}

/** db 查询该会话最近消息的模型；无记录/库不可读返回 null。 */
function querySessionModel(dbPath, sessionId, DatabaseSyncImpl) {
  let DatabaseSync = DatabaseSyncImpl;
  if (!DatabaseSync) {
    try {
      // node:sqlite 在 Node 22.5+ 可用；缺失或库锁死都按「查不到」降级
      DatabaseSync = require('node:sqlite').DatabaseSync;
    } catch {
      return null;
    }
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const rows = db.prepare(
      'SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 8',
    ).all(sessionId);
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data);
        if (d && typeof d.modelId === 'string') {
          return {
            modelId: d.modelId,
            providerId: typeof d.providerId === 'string' ? d.providerId : null,
          };
        }
      } catch {
        // 跳过损坏行，继续往前找
      }
    }
    return null;
  } finally {
    db.close();
  }
}

/** 首轮回落：config.json 的 model.main 形如 "<provider>/<model>"。 */
function fallbackModelFromConfig(configPath) {
  try {
    const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const ref = c && c.model && typeof c.model.main === 'string' ? c.model.main : null;
    if (!ref) return null;
    const slash = ref.lastIndexOf('/');
    return slash === -1
      ? { modelId: ref, providerId: null }
      : { modelId: ref.slice(slash + 1), providerId: ref.slice(0, slash) };
  } catch {
    return null;
  }
}

/** GLM 套餐模型 = GLM 系 modelId + account: 前缀 provider。 */
function isGlmPlan(model) {
  if (!model || typeof model.modelId !== 'string') return false;
  if (!/^GLM/i.test(model.modelId)) return false;
  return typeof model.providerId === 'string' && model.providerId.startsWith('account:');
}

function listProcessCommands() {
  const out = execFileSync('ps', ['-axo', 'command='], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return out.split('\n');
}

// 匹配真实 node 进程形态（node /path/zqw-watch.js --session ...），排除命令行文本里
// 恰好含该文件名的 shell / 编辑器进程（它们不以 node 直接起 wrapper 为本体）
const WATCH_PROC_RE = /^node\s+\S*zqw-watch\.js\s/;
const SESSION_ARG_RE = /--session\s+(\S+)/;

// 引擎对同一会话存在两种 id 形态（实测 sess_789381d-… 与 sess_7893816d-… 并存：
// bash 执行上下文/起守望时的短形 vs hook env 的长形，中段差一位、尾部一致）。尾 16
// 字符落在 id 高熵段，按尾段比对可跨形态认领同一会话；碰撞为 2^-64 量级，且误伤
// 方向只是少注入一次（下个门控周期重检测），后果轻微。
const SESSION_TAIL_LEN = 16;

function sameSessionTail(a, b) {
  return (
    a.length >= SESSION_TAIL_LEN &&
    b.length >= SESSION_TAIL_LEN &&
    a.slice(-SESSION_TAIL_LEN) === b.slice(-SESSION_TAIL_LEN)
  );
}

/** 本会话是否有存活的守望 wrapper 进程（ps 全表匹配 node 本体 + --session 会话归属）。 */
function hasActiveWatch(processLines, sessionId) {
  const key = sanitizeSessionId(sessionId);
  return processLines.some((line) => {
    const t = line.trim();
    if (!WATCH_PROC_RE.test(t)) return false;
    const m = t.match(SESSION_ARG_RE);
    return Boolean(m) && (m[1] === key || sameSessionTail(m[1], key));
  });
}

function readStateJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 用户叫停守望（suppress 子命令写入）未过期 → 跳过注入。 */
function isSuppressed(stateDir, key, nowMs) {
  const s = readStateJson(path.join(stateDir, key, 'suppress-until.json'));
  return Boolean(s) && Number.isFinite(s.untilMs) && s.untilMs > nowMs;
}

/** 上次守望以失败退出且仍在冷却期 → 跳过注入，防 CLI 故障时反复催起。被信号杀（killed，如 TaskStop 主动终止）不算失败。 */
function inFailureCooldown(stateDir, key, nowMs) {
  let r = readStateJson(path.join(stateDir, key, 'result.json'));
  if (!r) {
    // 双 id 形态兜底：wrapper 按起动时 argv id 写 result.json，与 hook 检测时的 env
    // id 可能中段差一位；精确目录 miss 时按尾段找同会话目录，保住失败冷却判定
    try {
      for (const name of fs.readdirSync(stateDir)) {
        if (name === key || !sameSessionTail(name, key)) continue;
        r = readStateJson(path.join(stateDir, name, 'result.json'));
        if (r) break;
      }
    } catch { /* 目录不存在忽略 */ }
  }
  if (!r || r.exitCode === 0 || r.killed) return false;
  return Number.isFinite(r.finishedAtMs) && nowMs - r.finishedAtMs < FAILURE_COOLDOWN_MS;
}

/** TTL 清扫：计数文件与过期的会话状态目录（低频跑，失败忽略下次再清）。 */
function sweepStale(stateDir, countDir, nowMs) {
  try {
    for (const name of fs.readdirSync(countDir)) {
      if (!name.endsWith('.count')) continue;
      const file = path.join(countDir, name);
      try {
        if (nowMs - fs.statSync(file).mtimeMs > COUNT_TTL_MS) fs.unlinkSync(file);
      } catch { /* 竞态忽略 */ }
    }
  } catch { /* 目录不存在忽略 */ }
  try {
    for (const name of fs.readdirSync(stateDir)) {
      const dir = path.join(stateDir, name);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        if (nowMs - fs.statSync(dir).mtimeMs > SESSION_TTL_MS) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch { /* 竞态忽略 */ }
    }
  } catch { /* 目录不存在忽略 */ }
}

/** status 展示用：全表里所有守望 wrapper node 本体进程行。 */
function filterWatchLines(processLines) {
  return processLines.filter((line) => WATCH_PROC_RE.test(line.trim()));
}

module.exports = {
  sanitizeSessionId,
  sameSessionTail,
  querySessionModel,
  fallbackModelFromConfig,
  isGlmPlan,
  listProcessCommands,
  hasActiveWatch,
  filterWatchLines,
  isSuppressed,
  inFailureCooldown,
  sweepStale,
};
