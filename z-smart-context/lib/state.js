'use strict';

// 会话级档位状态（D3）：~/.zcode/z-smart-context/state/<sessionId>.json，
// 内容 {firedTiers: number[], lastTokens: number, updatedAt}。hook 进程随事件结束退出，
// 去重必须跨进程持久，故一 session 一文件、每次检查原子写。
// 判档/回落/求交均为纯函数具名导出（可测性约束），IO 只做薄壳。

const fs = require('node:fs');
const path = require('node:path');

// D3 定案①：session_id 来自 hook stdin/env 外部输入，落盘做文件名前必须过白名单，
// 防路径穿越与脏输入落盘。生产实测形态为 sess_<uuid>。
const SESSION_ID_RE = /^sess_[A-Za-z0-9._-]+$/;

function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

function emptyState() {
  return { firedTiers: [], lastTokens: 0 };
}

function stateFile(stateDir, sessionId) {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`invalid sessionId: ${JSON.stringify(sessionId)}`);
  }
  return path.join(stateDir, `${sessionId}.json`);
}

function sanitizeState(parsed) {
  return {
    firedTiers: Array.isArray(parsed.firedTiers)
      ? parsed.firedTiers.filter((n) => typeof n === 'number' && Number.isFinite(n))
      : [],
    lastTokens:
      typeof parsed.lastTokens === 'number' && Number.isFinite(parsed.lastTokens)
        ? parsed.lastTokens
        : 0,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : undefined,
  };
}

function loadState(stateDir, sessionId) {
  const file = stateFile(stateDir, sessionId);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 首轮无状态是常态
      return emptyState();
    }
    throw err;
  }
  try {
    return sanitizeState(JSON.parse(raw));
  } catch {
    // §3.4：坏 state 视为无状态重建；坏文件留 .bak 供人工排查（覆盖旧 .bak 可接受）
    try {
      fs.renameSync(file, `${file}.bak`);
    } catch {
      // 改名失败不阻断重建
    }
    return emptyState();
  }
}

function saveState(stateDir, sessionId, state) {
  const file = stateFile(stateDir, sessionId);
  fs.mkdirSync(stateDir, { recursive: true });
  // updatedAt 以持久化时刻为准：它是孤儿清理 TTL 的唯一依据（D3）
  const record = JSON.stringify({ ...state, updatedAt: Date.now() });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, record);
  fs.renameSync(tmp, file);
}

// D3 定案②：用户中途改档位后，state 里旧 fired 值可能不在新 tiers 中；
// 判档与回落判定都必须基于「fired × 当前配置」交集。副作用仅限改档后可能多提醒一次。
function intersectFired(firedTiers, tiers) {
  const tierSet = new Set(Array.isArray(tiers) ? tiers : []);
  return (Array.isArray(firedTiers) ? firedTiers : []).filter((t) => tierSet.has(t));
}

// D4 回落判定（压缩周期重置的唯一机制，by construction 不依赖任何 hook 事件）：
// fired 交集非空 → 阈值 = min(交集) × 0.8；交集空 → 阈值 = lastTokens × 0.5；
// 当前读数严格小于阈值才算回落。lastTokens <= 0（首轮/无历史）一律 false——无从谈「回落」。
function detectDropout(state, currentTokens, tiers) {
  if (!(state.lastTokens > 0)) return false;
  const fired = intersectFired(state.firedTiers, tiers);
  const baseline = fired.length > 0 ? Math.min(...fired) * 0.8 : state.lastTokens * 0.5;
  return currentTokens < baseline;
}

// 返回最小的「已越档且未 fired」档位值，无则 null。tiers 须升序（normalizeTiers 输出保证）。
function pickTier(tiers, tokens, firedEffective) {
  const fired = new Set(Array.isArray(firedEffective) ? firedEffective : []);
  for (const tier of tiers) {
    if (tokens >= tier && !fired.has(tier)) return tier;
  }
  return null;
}

// D3 嵌套静默双判：① env 存在键名匹配 /_NESTED$/ 即「被 spawn 的嵌套会话」（本仓纪律：
// 编排插件自带 <前缀>_NESTED=1，通配后缀覆盖未来新插件，无需逐个枚举）；
// ② parentDbId 非空即内建 Agent 工具子会话——探针实测子会话不带任何嵌套 env，须靠 db 补判。
function isNestedSession(envObj, parentDbId) {
  if (envObj && Object.keys(envObj).some((key) => /_NESTED$/.test(key))) return true;
  return Boolean(parentDbId);
}

// D3：写前顺带清理 updatedAt 超 TTL 的孤儿 state（会话废弃/clear 后残留）。
// 以文件 mtime 近似 updatedAt——saveState 每次落盘都刷新两者，语义同源；
// 清理是附带动作，目录缺失/单文件失败一律静默跳过，绝不影响 hook 主流程。
function cleanOrphanStates(stateDir, ttlMs = 7 * 24 * 60 * 60 * 1000) {
  let names;
  try {
    names = fs.readdirSync(stateDir);
  } catch {
    return 0;
  }
  const deadline = Date.now() - ttlMs;
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const st = fs.statSync(path.join(stateDir, name));
      if (st.mtimeMs < deadline) {
        fs.unlinkSync(path.join(stateDir, name));
        removed += 1;
      }
    } catch {
      // 单文件清理失败留给下一轮
    }
  }
  return removed;
}

module.exports = {
  isValidSessionId,
  loadState,
  saveState,
  intersectFired,
  detectDropout,
  pickTier,
  isNestedSession,
  cleanOrphanStates,
};
