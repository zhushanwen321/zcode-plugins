'use strict';
// step: create —— 走引擎协议创建会话（spawn app-server → create → send 首条提示词 → 等待回合结束）
// 然后回填 tasks-index 行（restore 插件同款 upsert），使侧边栏可见。
const fs = require('fs');
const { openTasksIndex, openCliDb, AppServerClient, waitSessionSettled, WORKSPACE_PATH, PROBE_TAG } = require('./lib');

const PROMPT = `${PROBE_TAG} 会话管理器探针创建的测试会话。请只回复五个字符：probe-ok。不要使用任何工具，不要做任何其他事情。`;

// 从 GUI 设置库读 builtin glm coding plan 的 provider 配置（含 key；不打印）
function loadGlmProvider() {
  const cfg = JSON.parse(fs.readFileSync(require('os').homedir() + '/.zcode/v2/config.json', 'utf8'));
  const p = cfg.provider && cfg.provider['builtin:bigmodel-coding-plan'];
  if (!p || !p.enabled) throw new Error('v2/config.json 中无启用的 builtin:bigmodel-coding-plan');
  const modelIds = Object.keys(p.models || {});
  if (!modelIds.length) throw new Error('该 provider 无 models');
  return {
    providerId: 'builtin:bigmodel-coding-plan',
    kind: p.kind || 'anthropic',
    baseURL: p.options.baseURL,
    apiKey: p.options.apiKey,
    models: modelIds.map((m) => ({ modelId: m })),
  };
}

async function tryCreate() {
  const client = new AppServerClient();
  await new Promise((r) => setTimeout(r, 1500));
  // 注入 provider（不带 apiKey：凭据走 spawn 时的 ANTHROPIC_API_KEY env 回退）
  const prov = loadGlmProvider();
  client.setSecrets([prov.apiKey]);
  const up = await client.request('workspace/upsertModelProvider', {
    workspace: { workspaceKey: WORKSPACE_PATH, workspacePath: WORKSPACE_PATH },
    provider: { providerId: prov.providerId, kind: prov.kind, baseURL: prov.baseURL, models: prov.models },
  }, 30000);
  console.log('    upsertModelProvider OK:', JSON.stringify(up).slice(0, 150));

  // GUI 完全同款：单条 v4/command createSession，firstInput 携带提示词
  const crypto = require('crypto');
  const cmd = {
    commandId: crypto.randomUUID(),
    clientId: 'szm-probe',
    sessionId: null,
    type: 'createSession',
    payload: {
      workspaceId: WORKSPACE_PATH,
      firstInput: { text: PROMPT, attachments: [] },
      config: { mode: 'build' },
    },
    issuedAt: Date.now(),
  };
  const res = await client.request('v4/command', cmd, 90000);
  console.log(`    v4 createSession status=${res.status}`, res.result ? JSON.stringify(res.result).slice(0, 250) : '');
  if (res.status !== 'accepted') throw new Error('createSession 未 accepted: ' + JSON.stringify(res).slice(0, 300));
  return { client, created: res };
}

async function main() {
  try {
    console.log('[1-2] spawn app-server + 注入 provider + v4 createSession(firstInput) ...');
    const { client, created } = await tryCreate();

    const scan = (o) => {
      if (!o || typeof o !== 'object') return null;
      if (typeof o.sessionId === 'string' && o.sessionId.startsWith('sess_')) return o.sessionId;
      for (const v of Object.values(o)) { const r = scan(v); if (r) return r; }
      return null;
    };
    let sessionId = scan(created.result) || scan(created);
    if (!sessionId) {
      const noticeHit = client.notices.find((n) => JSON.stringify(n).includes('sess_'));
      sessionId = scan(noticeHit || {});
    }
    if (!sessionId) throw new Error('未能从响应中提取 sessionId: ' + JSON.stringify(created).slice(0, 400));
    console.log('    sessionId:', sessionId);

    // 立即订阅会话主题（模拟 GUI：无监听者时引擎可能暂停/丢弃回合输出）
    try {
      const ack = await client.request('v4/conversation/subscribe', {
        topic: `conversation/${sessionId}`,
        clientMode: 'desktop-continuous',
        connectionId: 'szm-probe-conn-1',
      }, 20000);
      console.log('    订阅 OK:', JSON.stringify(ack).slice(0, 150));
    } catch (e) {
      console.log('    订阅失败(继续):', e.message.slice(0, 150));
    }


    console.log('[4] 等待回合完成（轮询引擎库 assistant text part）...');
    const t0 = Date.now();
    let replied = false;
    while (Date.now() - t0 < 120000) {
      await new Promise((r) => setTimeout(r, 1500));
      const rdb = openCliDb();
      const n = rdb.prepare(`
        SELECT COUNT(*) n FROM part p
        JOIN message m ON m.id = p.message_id AND p.session_id = m.session_id
        WHERE p.session_id = ? AND json_extract(m.data,'$.role')='assistant'
          AND json_extract(p.data,'$.type')='text'
      `).get(sessionId).n;
      rdb.close();
      if (n > 0) { replied = true; break; }
    }
    console.log('    助手回复出现:', replied);

    // 对照实验：close 之前先查库（判断持久化时机）+ 读内存态
    {
      const evs = client.notices.map((n) => n.method || '?');
      const tally = {};
      for (const m of evs) tally[m] = (tally[m] || 0) + 1;
      console.log('    [通知统计]', JSON.stringify(tally));
      try {
        const read = await client.request('session/read', { sessionId, messageLimit: 50 }, 20000);
        const msgs = read.messages || [];
        console.log('    [内存] session/read 消息数:', msgs.length);
        const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
        if (lastAssistant) console.log('    [内存] 最后助手消息片段:', JSON.stringify(lastAssistant).slice(0, 400));
      } catch (e) { console.log('    [内存] session/read 失败:', e.message.slice(0, 150)); }
      const { DatabaseSync } = require('node:sqlite');
      const rdb = new DatabaseSync(require('os').homedir() + '/.zcode/cli/db/db.sqlite', { readOnly: true });
      const n1 = rdb.prepare('SELECT COUNT(*) n FROM session WHERE id=?').get(sessionId).n;
      const n2 = rdb.prepare('SELECT COUNT(*) n FROM part WHERE session_id=?').get(sessionId).n;
      rdb.close();
      console.log(`    [close 前] session 行=${n1} part 行=${n2}`);
    }

    const updatedAt = Date.now();

    console.log('[5] session/close + 进程收尾（给优雅退出最多 15s）...');
    try { await client.request('session/close', { sessionId }, 15000); } catch (e) { console.log('    close 警告(忽略):', e.message); }
    try { client.child.stdin.end(); } catch {}
    await Promise.race([client.exitPromise, new Promise((r) => setTimeout(r, 15000))]);
    {
      const { DatabaseSync } = require('node:sqlite');
      const rdb = new DatabaseSync(require('os').homedir() + '/.zcode/cli/db/db.sqlite', { readOnly: true });
      const n1 = rdb.prepare('SELECT COUNT(*) n FROM session WHERE id=?').get(sessionId).n;
      const n2 = rdb.prepare('SELECT COUNT(*) n FROM part WHERE session_id=?').get(sessionId).n;
      rdb.close();
      console.log(`    [close 后] session 行=${n1} part 行=${n2} (exited=${client.exited})`);
    }
    if (!client.exited) { try { client.child.kill('SIGKILL'); } catch {} }

    console.log('[6] 回填 tasks-index 行 ...');
    const createdAt = (created.session && created.session.createdAt) ?? Date.now();
    const snapTitle = (created.session && created.session.title) || PROMPT.slice(0, 57) + '...';
    const snapModel = typeof created.model === 'string' ? created.model : null;
    const traceId = (created.session && created.session.traceId) || null;
    const db = openTasksIndex({ readonly: false });
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`
      INSERT INTO tasks
        (workspace_key, workspace_path, workspace_identity, task_id, title,
         task_status, provider, mode, model, migration_source, forked_from_task_id,
         created_at, updated_at, unread_at, pinned, archived, deleted, title_overridden,
         meta_json, searchable_text)
      VALUES (?, ?, NULL, ?, ?, ?, 'glm', 'build', ?, NULL, NULL,
              ?, ?, NULL, 0, 0, 0, 0, ?, ?)
      ON CONFLICT(workspace_key, task_id) DO UPDATE SET
        title = CASE WHEN tasks.title_overridden = 1 THEN tasks.title ELSE excluded.title END,
        task_status = excluded.task_status,
        updated_at = MAX(tasks.updated_at, excluded.updated_at),
        meta_json = excluded.meta_json
    `).run(
      WORKSPACE_PATH, WORKSPACE_PATH, sessionId, snapTitle,
      'completed', snapModel, createdAt, updatedAt,
      JSON.stringify({
        taskId: sessionId,
        traceId: traceId || require('crypto').randomUUID(),
        title: snapTitle,
        titleOverridden: false,
        workspacePath: WORKSPACE_PATH,
        createdAt: Math.min(createdAt, updatedAt),
        updatedAt,
        mode: 'build',
        ...(snapModel ? { model: snapModel } : {}),
        thoughtLevel: 'max',
        provider: 'glm',
        status: 'completed',
      }),
      PROMPT,
    );
    db.exec('COMMIT');
    db.close();
    console.log('    tasks 行已写入');

    console.log('\n=== 完成 ===');
    console.log('sessionId :', sessionId);
    console.log('title     :', snapTitle);
    console.log('status    :', replied ? 'completed(assistant replied)' : 'no-reply');
    fs.writeFileSync('/tmp/zc-probe/last-session.txt', sessionId);
    console.log('\n>>> 请到 ZCode GUI 左侧边栏找标题含 szm-probe 的会话 <<<');
    console.log('>>> 若没有：先切换侧边栏搜索/分组试试；再不行重启 ZCode 再看 <<<');
  } catch (e) {
    console.error('\nFAILED:', e.message);
    process.exitCode = 1;
  }
}

main();
