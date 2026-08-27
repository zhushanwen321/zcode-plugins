'use strict';

// 引擎私有库只读访问层。G5 红线：db.sqlite 是引擎私有持久层，本插件只以 readOnly 打开，
// 任何语句天然不可写；openDb 失败向上 throw，由调用方按 §3.4 静默降级（stderr 落日志、零输出 exit 0）。

const { DatabaseSync } = require('node:sqlite');

function openDb(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

// SQL-1（§5.2）：上一轮已完成请求的上下文规模读数。
// status='completed' 过滤是硬要求（D8）：running/error/cancelled 与撞限重试中的行读数失真，
// 过滤后它们天然排除在判档与回落计算之外。
function getLatestCompletedUsage(db, sessionId) {
  const row = db
    .prepare(
      `SELECT input_tokens, cache_read_input_tokens,
              input_tokens + cache_read_input_tokens AS context_tokens,
              context_exceeded, model_id, started_at
       FROM model_usage
       WHERE session_id = ? AND status = 'completed'
       ORDER BY started_at DESC
       LIMIT 1`
    )
    .get(sessionId);
  if (!row) return null;
  return {
    contextTokens: row.context_tokens,
    inputTokens: row.input_tokens,
    cacheReadTokens: row.cache_read_input_tokens,
    contextExceeded: row.context_exceeded,
    modelId: row.model_id,
    startedAt: row.started_at,
  };
}

// SQL-2（§5.2）：--latest 按 cwd 反查最近活跃主会话。
// 过滤条件用 id 形态而非 parent_id（2026-08-27 真机实测修正）：/fork 产生的主工作会话同样
// 带 parent_id，按 parent_id 过滤会把 fork 会话从反查里漏掉；内建 Agent 子会话的 id 前缀
// sess_subagent_agent_ 才是稳定辨识面。GLOB 不做转义展开，* 即通配。
function findLatestSessionByDirectory(db, directory) {
  const row = db
    .prepare(
      `SELECT id, title, time_updated
       FROM session
       WHERE directory = ? AND id NOT GLOB 'sess_subagent_agent_*'
       ORDER BY time_updated DESC
       LIMIT 1`
    )
    .get(directory);
  if (!row) return null;
  return { id: row.id, title: row.title, timeUpdated: row.time_updated };
}

module.exports = { openDb, getLatestCompletedUsage, findLatestSessionByDirectory };
