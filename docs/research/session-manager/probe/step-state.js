'use strict';
// step: archive/unarchive/delete —— 索引库状态翻转（GUI 同款软删/归档语义）
const fs = require('fs');
const { openTasksIndex } = require('./lib');

async function main() {
  const action = process.argv[2];
  const sessionId = fs.readFileSync('/tmp/zc-probe/last-session.txt', 'utf8').trim();
  if (!['archive', 'unarchive', 'delete'].includes(action)) throw new Error('action 必须是 archive|unarchive|delete');

  const field = action === 'archive' ? 'archived' : action === 'delete' ? 'deleted' : null;
  const value = action === 'unarchive' ? 0 : 1;
  const col = field || 'archived';

  const tdb = openTasksIndex({ readonly: false });
  tdb.exec('BEGIN IMMEDIATE');
  const sets = [`${col} = ${value}`, 'updated_at = updated_at'];
  // 归档语义照 host：archiveStaleTasks 只动 archived 列；deleteTask 只动 deleted 列
  tdb.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(sessionId);
  tdb.exec('COMMIT');
  const row = tdb.prepare("SELECT archived, deleted, pinned FROM tasks WHERE task_id=?").get(sessionId);
  tdb.close();
  console.log(`[${action}] 已执行，行现状:`, JSON.stringify(row));
  console.log('>>> 请到 GUI 验证 <<<');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
