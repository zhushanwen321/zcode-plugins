'use strict';
// step: rename —— 双写改名：tasks-index (title+title_overridden=1) + db.sqlite (title_source='custom')
const fs = require('fs');
const { openTasksIndex, openCliDb } = require('./lib');

async function main() {
  const sessionId = fs.readFileSync('/tmp/zc-probe/last-session.txt', 'utf8').trim();
  const newTitle = process.argv[2] || '[szm-probe] 改名后的探针会话';
  if (!sessionId.startsWith('sess_')) throw new Error('last-session.txt 无效: ' + sessionId);

  // 写前留存引擎库原行（行级安全）
  const cdb = openCliDb();
  const before = cdb.prepare("SELECT title, title_source FROM session WHERE id=?").get(sessionId);
  console.log('[引擎库] 原值:', JSON.stringify(before));
  console.log('[目标] 新标题:', newTitle);

  const now = Date.now();

  // 1) tasks-index：title + title_overridden=1（照 host renameTask 的 updateTaskState patch 语义）
  const tdb = openTasksIndex({ readonly: false });
  tdb.exec('BEGIN IMMEDIATE');
  tdb.prepare(`
    UPDATE tasks SET
      title = ?,
      title_overridden = 1,
      updated_at = MAX(updated_at, ?),
      meta_json = json_set(meta_json, '$.title', ?, '$.titleOverridden', json('1'), '$.updatedAt', ?)
    WHERE task_id = ?
  `).run(newTitle, now, newTitle, now, sessionId);
  tdb.exec('COMMIT');
  const afterT = tdb.prepare("SELECT title, title_overridden FROM tasks WHERE task_id=?").get(sessionId);
  tdb.close();
  console.log('[索引库] 已更新:', JSON.stringify(afterT));

  // 2) db.sqlite：title + title_source='custom' + time_title_updated（照引擎 setCustomSessionTitle 语义）
  cdb.exec('BEGIN IMMEDIATE');
  cdb.prepare(`
    UPDATE session SET
      title = ?,
      title_source = 'custom',
      time_title_updated = ?,
      time_updated = MAX(time_updated, ?)
    WHERE id = ?
  `).run(newTitle, now, now, sessionId);
  cdb.exec('COMMIT');
  const afterC = cdb.prepare("SELECT title, title_source, time_title_updated IS NOT NULL AS has_ts FROM session WHERE id=?").get(sessionId);
  cdb.close();
  console.log('[引擎库] 已更新:', JSON.stringify(afterC));
  fs.writeFileSync('/tmp/zc-probe/rename-before.json', JSON.stringify(before));
  console.log('\n>>> 请到 GUI 验证：该会话标题是否已变（分组模式与点开后的标题都要看）<<<');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
