#!/usr/bin/env node
'use strict';

/**
 * 无头 e2e：真实 zcode app-server + 真实模型，验证 V1/V2/V3 的数据层证据（设计 §4）。
 * 本地显式触发：ZSC_E2E=1 node test/e2e-headless.test.js
 * （node --test 全量下默认 skip：e2e 烧真实 token，CI 亦排除 e2e*.test.js——双保险门控。）
 *
 * 断言（全部来自落盘数据，非模型复述）：
 *   1. 越档 additionalContext 物理进入 request.messages（rollout grep，V1 主证据）
 *   2. 回落知情文案同样进入 request.messages（V3b 主证据）
 *   3. hook 日志恰 1 次 tier-notify（fired 去重，V2 计数口径 = hook 日志注入动作数）
 *   4. hook 日志恰 1 次 dropout-reset（D4 回落自愈）
 *   5. state 终态 firedTiers=[]（回落清档）、引擎日志无 hook 失败
 *
 * 方法（M0 探针方法论）：隔离 HOME + plugins.dirs inline 注册本插件 + app-server 三轮；
 * turn1 后向隔离库最末 completed 行写 fixture 读数 214500 制造越默认 200K 档条件；
 * turn3 读到 turn2 真实低读数行（~30K）自然触发回落自愈——fixture 的副产品恰好覆盖 V3。
 * provider 凭据取自 ~/.zcode/v2/config.json（zsw bootstrapIsolatedHome 同源，不落盘密钥）。
 */

const test = require('node:test');
const skip = !process.env.ZSC_E2E;

test('headless e2e: tier-notify inject + dedup + dropout reset', { skip }, async () => {
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const assert = require('node:assert');
  const { DatabaseSync } = require('node:sqlite');

  const PLUGIN_ROOT = path.resolve(__dirname, '..');
  const ZCODE_CLI = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsc-e2e-'));
  const HOME = path.join(TMP, 'home');
  const CWD = path.join(TMP, 'work');
  fs.mkdirSync(path.join(HOME, '.zcode', 'cli'), { recursive: true });
  fs.mkdirSync(CWD, { recursive: true });

  // 隔离 config：provider 从 v2 config 提取（含 apiKey），plugins.dirs inline 注册本插件
  const v2 = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.zcode', 'v2', 'config.json'), 'utf8'));
  const providerEntry = v2?.provider?.['builtin:bigmodel-coding-plan'];
  assert.ok(providerEntry?.options?.apiKey, 'v2 config 无 bigmodel provider 凭据（先在 ZCode 桌面端登录）');
  fs.writeFileSync(
    path.join(HOME, '.zcode/cli/config.json'),
    JSON.stringify({
      model: { main: 'builtin:bigmodel-coding-plan/GLM-5.3' },
      provider: { 'builtin:bigmodel-coding-plan': providerEntry },
      plugins: { dirs: [PLUGIN_ROOT], enabledPlugins: { 'z-smart-context@inline': true } },
    }),
  );

  const child = spawn('node', [ZCODE_CLI, 'app-server', '--cwd', CWD], {
    env: { ...process.env, HOME },
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  let nextId = 1;
  const pending = new Map();
  let terminalCount = 0;
  const request = (method, params, timeoutMs = 60000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  };
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let f;
      try { f = JSON.parse(line); } catch { continue; }
      if (f.id != null && f.method) {
        child.stdin.write(JSON.stringify({
          id: f.id,
          result: f.method === 'session/requestRuntimePreferences'
            ? { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1' }
            : {},
        }) + '\n');
      } else if (f.id != null && pending.has(f.id)) {
        pending.get(f.id).resolve(f.result != null ? f.result : f.error);
      } else if (f.method === 'v4/telemetry/event' && f.params?.kind === 'turn.terminal') {
        terminalCount++;
      }
    }
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitTerminal = async (before, budgetMs = 180000) => {
    const deadline = Date.now() + budgetMs;
    while (terminalCount <= before && Date.now() < deadline) await sleep(1000);
    assert.ok(terminalCount > before, 'turn 未完成（terminal 超时）');
    await sleep(3000); // 等 hook 与 db 落盘
  };

  try {
    const created = await request('session/create', { workspace: { workspacePath: CWD, workspaceKey: 'ws-zsc-e2e' }, mode: 'yolo' });
    const sessionId = created?.sessionId ?? created?.session?.sessionId;
    assert.ok(sessionId, 'no sessionId: ' + JSON.stringify(created).slice(0, 200));
    await request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
    await sleep(2000);

    const send = async (content, tag) => {
      const before = terminalCount;
      await request('session/send', { sessionId, content });
      await waitTerminal(before);
      void tag;
    };
    await send('只回复两个字符：ok', 'turn1');

    // fixture：把该会话最末 completed 行读数改为 214500（越默认 200K 档）
    const dbPath = path.join(HOME, '.zcode/cli/db/db.sqlite');
    const db = new DatabaseSync(dbPath);
    const row = db.prepare(
      "SELECT id FROM model_usage WHERE session_id = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 1",
    ).get(sessionId);
    assert.ok(row, 'fixture: 无 completed 行可改（turn1 未落盘？）');
    db.prepare('UPDATE model_usage SET input_tokens = 200000, cache_read_input_tokens = 14500 WHERE id = ?').run(row.id);
    db.close();

    await send('只回复两个字符：ok', 'turn2-should-notify');
    await send('只回复两个字符：ok', 'turn3-dedup-then-dropout');

    // 断言 1/2：两种注入文案都物理进入 request.messages（V1/V3b 主证据）
    const rollout = fs.readFileSync(
      path.join(HOME, '.zcode/cli/rollout', `model-io-${sessionId}.jsonl`), 'utf8',
    );
    let tierHit = 0, dropoutHit = 0;
    for (const line of rollout.split('\n')) {
      if (!line.includes('[z-smart-context]')) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const msgs = j?.request?.messages;
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) {
        const c = typeof m.content === 'string' ? m.content : '';
        if (c.includes('[z-smart-context] 上下文用量')) tierHit++;
        if (c.includes('上下文用量已显著回落')) dropoutHit++;
      }
    }
    assert.ok(tierHit >= 1, `rollout request.messages 应含越档文案（实命中 ${tierHit}）`);
    assert.ok(dropoutHit >= 1, `rollout request.messages 应含回落知情文案（实命中 ${dropoutHit}）`);

    // 断言 3/4：hook 日志注入动作计数（V2 口径：以此为准，rollout grep 会跨轮重复命中）
    const hookLog = fs.readFileSync(
      path.join(HOME, '.zcode/z-smart-context/log/hook.log'), 'utf8',
    );
    assert.equal((hookLog.match(/tier-notify 注入动作/g) || []).length, 1, 'tier-notify 恰 1 次（fired 去重）');
    assert.equal((hookLog.match(/dropout-reset 注入动作/g) || []).length, 1, 'dropout-reset 恰 1 次');

    // 断言 5：state 终态回落清档 + 引擎日志干净
    const st = JSON.parse(fs.readFileSync(
      path.join(HOME, '.zcode/z-smart-context/state', `${sessionId}.json`), 'utf8',
    ));
    assert.deepEqual(st.firedTiers, [], '回落自愈应清空 firedTiers');
    const logDir = path.join(HOME, '.zcode/cli/log');
    for (const f of fs.readdirSync(logDir).filter((x) => x.endsWith('.jsonl'))) {
      assert.doesNotMatch(
        fs.readFileSync(path.join(logDir, f), 'utf8'),
        /config\.file\.invalid|hook.*(failed|error)/i,
        `引擎日志 ${f} 含插件加载/执行错误`,
      );
    }
  } finally {
    child.kill();
  }
});
