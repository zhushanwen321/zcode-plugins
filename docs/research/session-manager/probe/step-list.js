'use strict';
// step: list —— 双通道对照：直读 tasks-index vs 引擎协议 session/list（只读）
const { openTasksIndex, openCliDb, AppServerClient, WORKSPACE_PATH } = require('./lib');

async function main() {
  console.log('=== A. 直读 tasks-index.sqlite（侧边栏同源）===');
  const db = openTasksIndex({ readonly: true });
  const cnt = (sql, ...p) => db.prepare(sql).get(...p).n;
  console.log(`活跃(timeline) : ${cnt("SELECT COUNT(*) n FROM tasks WHERE deleted=0 AND pinned=0 AND archived=0")}`);
  console.log(`置顶           : ${cnt("SELECT COUNT(*) n FROM tasks WHERE deleted=0 AND pinned=1 AND archived=0")}`);
  console.log(`归档           : ${cnt("SELECT COUNT(*) n FROM tasks WHERE deleted=0 AND archived=1")}`);
  console.log(`已删除(软删)   : ${cnt("SELECT COUNT(*) n FROM tasks WHERE deleted=1")}`);
  console.log('\n--- 最近 10 条活跃任务（跨 workspace，updated_at 倒序）---');
  const rows = db.prepare(
    "SELECT task_id, title, task_status, archived, pinned, workspace_path FROM tasks WHERE deleted=0 ORDER BY updated_at DESC LIMIT 10"
  ).all();
  for (const r of rows) {
    console.log(`${r.archived ? '[归档]' : r.pinned ? '[置顶]' : '[时间线]'} ${r.task_id.slice(0, 20)}  ${String(r.title).slice(0, 40)}  <${String(r.workspace_path).split('/').slice(-2).join('/')}>`);
  }
  console.log(`\n--- 本探针 workspace (${WORKSPACE_PATH.split('/').pop()}) 现有条目 ---`);
  const mine = db.prepare("SELECT task_id, title, archived FROM tasks WHERE workspace_path=? AND deleted=0").all(WORKSPACE_PATH);
  console.log(mine.length ? mine.map((r) => `${r.task_id} ${r.title}`).join('\n') : '(无)');
  db.close();

  console.log('\n=== B. 引擎协议 session/list（includeArchived:true）===');
  const client = new AppServerClient();
  try {
    const res = await client.request('session/list', {
      workspace: { workspaceKey: WORKSPACE_PATH, workspacePath: WORKSPACE_PATH },
      includeArchived: true,
      limit: 50,
    }, 30000);
    const sessions = res.sessions || [];
    console.log(`返回 ${sessions.length} 条：`);
    for (const s of sessions.slice(0, 10)) {
      console.log(`  ${s.sessionId.slice(0, 24)}  [${s.sessionKind}] ${String(s.title).slice(0, 40)}  status=${s.status}`);
    }
  } catch (e) {
    console.log('session/list 失败:', e.message);
    console.log(client.dumpTraffic(30));
  } finally {
    await client.close();
  }

  // 引擎库对照：本 workspace 的 interactive 会话总数
  const cdb = openCliDb();
  const eng = cdb.prepare("SELECT COUNT(*) n FROM session WHERE directory=?").get(WORKSPACE_PATH);
  console.log(`\n引擎库中 directory=${WORKSPACE_PATH.split('/').pop()} 的会话总数（含 subagent）: ${eng.n}`);
  cdb.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
