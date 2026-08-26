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
// parent_id IS NULL 必带（D5 定案②）：子会话 directory 与主会话相同且 time_updated 更新，
// 不过滤则 CLI 自查会反查到刚结束的内建 Agent 子会话。
function findLatestSessionByDirectory(db, directory) {
  const row = db
    .prepare(
      `SELECT id, title, time_updated
       FROM session
       WHERE directory = ? AND parent_id IS NULL
       ORDER BY time_updated DESC
       LIMIT 1`
    )
    .get(directory);
  if (!row) return null;
  return { id: row.id, title: row.title, timeUpdated: row.time_updated };
}

// SQL-3（§5.2）：内建 Agent 工具子会话判定。parent_id 非空即子会话，hook 侧静默跳过；
// 行不存在或 parent_id 为空返 null。
function getSessionParentId(db, sessionId) {
  const row = db.prepare('SELECT parent_id FROM session WHERE id = ? LIMIT 1').get(sessionId);
  if (!row || !row.parent_id) return null;
  return row.parent_id;
}

module.exports = { openDb, getLatestCompletedUsage, findLatestSessionByDirectory, getSessionParentId };
