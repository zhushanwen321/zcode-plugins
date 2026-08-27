'use strict';

// lib/compact-tool.js 单测 + server.js 子进程冒烟。IO 隔离纪律：dataDir 一律注入
// mkdtemp 临时目录（config.json 的 dbPath 指 tmp 内不存在/自建的库），子进程另覆
// HOME 与 ZSC_DATA_DIR——生产 db 与真实 ~/.zcode 全程零接触；
// db 失败分支即「tmp 库打不开」的真实 ENOENT，不做任何 mock。

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  INJECT_SIGNATURE,
  RETENTION_SOFT_LIMIT,
  detectSessionShape,
  handleCompactTool,
} = require('../lib/compact-tool');

const SERVER_JS = path.join(__dirname, '..', 'dist', 'mcp', 'server.js');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 隔离 dataDir：config.json 把 dbPath 指到 tmp 内不存在的库，
// 复现「无引擎库环境」常态并证明读数失败只降级、不影响 plan 输出
function makeIsolatedDataDir() {
  const dir = makeTmpDir('zsc-ct-data-');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dbPath: path.join(dir, 'absent.sqlite') }));
  return dir;
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 会话形态判定（P-G4） ----------

test('detectSessionShape: ZSC_HEADLESS=1 即判 headless-active（最高优先）', () => {
  assert.equal(detectSessionShape({ env: { ZSC_HEADLESS: '1' }, pid: 1, probe: () => null }), 'headless-active');
});

test('detectSessionShape: 父链命中 zcode-host- 特征判 gui-active', () => {
  // 从 node server 的视角逐级上溯：node(700) ← shell(600) ← GUI host(500)
  const cmds = {
    700: '600 /bin/zsh -c node dist/mcp/server.js',
    600: '500 /Applications/ZCode.app/Contents/Resources/zcode-host-local-electron main',
    500: '1 /sbin/launchd',
  };
  const probe = (pid) => cmds[pid] || null;
  assert.equal(detectSessionShape({ env: {}, pid: 700, probe }), 'gui-active');
});

test('detectSessionShape: Electron app bundle 主进程特征同样命中', () => {
  const probe = () => '1 /Applications/ZCode.app/Contents/MacOS/ZCode';
  assert.equal(detectSessionShape({ env: {}, pid: 42, probe }), 'gui-active');
});

test('detectSessionShape: 探针失败（ps 异常/链断）与普通链全落 unknown 兜底', () => {
  assert.equal(detectSessionShape({ env: {}, pid: 1234, probe: () => null }), 'unknown');
  assert.equal(
    detectSessionShape({
      env: {},
      pid: 700,
      probe: () => '600 /usr/local/bin/node --max-old-space-size foo',
    }),
    'unknown'
  );
});

test('detectSessionShape: 判定异常吞掉当 unknown，绝不向上抛', () => {
  const boom = () => {
    throw new Error('ps exploded');
  };
  assert.equal(detectSessionShape({ env: {}, pid: 1, probe: boom }), 'unknown');
});

// ---------- 入参校验（错误文本必须可操作） ----------

test('缺双参返回结构化错误，文本含正确入参格式示例作恢复动作', () => {
  const out = handleCompactTool({}, {});
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'invalid-arguments');
  assert.match(out.text, /retention/);
  assert.match(out.text, /nextInstruction/);
  assert.match(out.text, /\{"retention":[\s\S]*"nextInstruction"/);
  assert.match(out.text, /zsc_compact/);
});

test('非对象入参（字符串/数组/null）一律按参数错误拒绝', () => {
  for (const bad of ['oops', [1], null, 42]) {
    const out = handleCompactTool(bad, {});
    assert.equal(out.ok, false, `输入 ${JSON.stringify(bad)} 应被拒`);
    assert.match(out.text, /JSON 对象|必填/);
  }
});

test('sessionId 白名单拒绝非法值（防路径穿越），错误附 sess_ 格式提示', () => {
  for (const bad of ['../evil', 'not-a-sess', 'sess_有空格']) {
    const out = handleCompactTool({ retention: 'x', sessionId: bad }, {});
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'invalid-session-id');
    assert.match(out.text, /sess_/);
  }
});

test('显式合法 sessionId 直通（不查 db、不做 cwd 反查）', () => {
  const dir = makeIsolatedDataDir();
  try {
    const out = handleCompactTool(
      { retention: 'x', sessionId: 'sess_explicit' },
      { dataDir: dir, shape: 'headless-active' }
    );
    assert.equal(out.sessionId, 'sess_explicit');
    assert.equal(out.contextTokens, null);
  } finally {
    rmDir(dir);
  }
});

// ---------- gui-active：plan 包装原文 ----------

test('gui-active: plan 包含 retention/nextInstruction 原文、署名前缀与压缩命令', () => {
  const retention = 'T1/T2 完成状态与关键文件路径 lib/compact-tool.js；T3 任务描述与验收标准';
  const nextInstruction = '继续执行 T3（压缩完成后开始）';
  const out = handleCompactTool(
    { retention, nextInstruction, sessionId: 'sess_gui1' },
    { shape: 'gui-active' }
  );
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'gui-active');
  const joined = out.plan.join('\n');
  for (const frag of [
    `/compact 保留：${retention}`,
    nextInstruction,
    INJECT_SIGNATURE,
    'computer-use',
    'element',
    'step3',
  ]) {
    assert.ok(joined.includes(frag), `plan 应包含片段：${frag.slice(0, 40)}`);
  }
  assert.match(out.verifyHint, /zsc\.js usage --session sess_gui1/);
  assert.match(out.fallback, /CUA_PERMISSION_REQUIRED/);
  assert.ok(out.fallback.includes(`/compact 保留：${retention}`), 'fallback 应附可整段复制的保留指令原文');
});

test('gui-active: 仅传 nextInstruction 时退化为裸 /compact，step 结构仍完整', () => {
  const out = handleCompactTool({ nextInstruction: '压缩后继续收尾文档' }, { shape: 'gui-active' });
  const joined = out.plan.join('\n');
  assert.ok(joined.includes('\n/compact'), `应含裸 /compact 命令行，实得：${joined}`);
  assert.ok(joined.includes('压缩后继续收尾文档'));
});

test('retention 超软上限时 plan 给出截断建议并注明理由', () => {
  const longRetention = '长'.repeat(RETENTION_SOFT_LIMIT + 1);
  const out = handleCompactTool({ retention: longRetention }, { shape: 'gui-active' });
  const joined = out.plan.join('\n');
  assert.match(joined, /截断/);
  assert.match(joined, /输出上限/);
});

// ---------- headless-active：诚实降级 ----------

test('headless-active: 绝不含空 plan 假装成功，guidance 说明无法实时压缩与 override apply 预备', () => {
  const out = handleCompactTool({ retention: 'r' }, { shape: 'headless-active' });
  assert.equal(out.plan, undefined, 'headless 分支不允许出现 plan 字段');
  assert.ok(Array.isArray(out.guidance) && out.guidance.length > 0, 'guidance 必须是非空指引');
  const text = out.guidance.join('\n');
  assert.match(text, /无法实时触发压缩|无法实时压缩/);
  assert.match(text, /override apply/);
});

// ---------- mode unknown：双路径兜底 ----------

test('unknown: 双路径说明（GUI 编排步骤 + 无头预备）由 agent 自选', () => {
  const retention = '保留要点R';
  const nextInstruction = '之后继续 N';
  const out = handleCompactTool(
    { retention, nextInstruction },
    { dataDir: makeIsolatedDataDir(), shape: 'unknown' }
  );
  assert.equal(out.mode, 'unknown');
  const joined = out.plan.join('\n');
  assert.match(joined, /路径 A/);
  assert.match(joined, /路径 B/);
  assert.match(joined, /computer-use/, '路径 A 应是 GUI 编排');
  assert.match(joined, /override apply/, '路径 B 应是无头预备');
  assert.ok(joined.includes(retention) && joined.includes(nextInstruction));
});

// ---------- sessionId 缺省链与 db 只读取数 ----------

test('CLAUDE_SESSION_ID 参与 env 缺省链（须过白名单，脏值视同未提供）', () => {
  const out1 = handleCompactTool({ retention: 'r' }, { env: { CLAUDE_SESSION_ID: 'sess_from_env' }, shape: 'headless-active' });
  assert.equal(out1.sessionId, 'sess_from_env');
  const out2 = handleCompactTool({ retention: 'r' }, { env: { CLAUDE_SESSION_ID: '../../bad' }, shape: 'headless-active' });
  assert.equal(out2.sessionId, null, '脏 env 值应被白名单拦下后走后续探测');
});

function seedFixtureDb(dbFile) {
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, title TEXT, time_updated INTEGER, directory TEXT, parent_id TEXT
    );
    CREATE TABLE model_usage (
      session_id TEXT, status TEXT, input_tokens INTEGER, cache_read_input_tokens INTEGER,
      context_exceeded INTEGER, model_id TEXT, started_at INTEGER
    );
  `);
  // 同目录两条主会话（time_updated 定新旧）+ 一条更新的子会话（子代理 id 形态过滤应排除它）
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('sess_fix_old', 'old', 100, '/proj/x', null);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('sess_fix_new', 'new', 200, '/proj/x', null);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('sess_subagent_agent_child', 'child', 300, '/proj/x', 'sess_fix_new');
  db.prepare('INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?)').run('sess_fix_new', 'completed', 100, 400, 0, 'model-x', 9);
  db.close();
}

test('sessionId 缺省链末端走 db cwd 反查；contextTokens 取该会话最新 completed 读数', () => {
  const dir = makeTmpDir('zsc-ct-db-');
  try {
    const dbFile = path.join(dir, 'engine.sqlite');
    seedFixtureDb(dbFile);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dbPath: dbFile }));
    const out = handleCompactTool(
      { retention: 'r' },
      { dataDir: dir, cwd: '/proj/x', shape: 'gui-active' }
    );
    assert.equal(out.ok, true);
    assert.equal(out.sessionId, 'sess_fix_new', '反查须取最近活跃主会话而非子会话');
    assert.equal(out.contextTokens, 500, 'input + cache_read');
  } finally {
    rmDir(dir);
  }
});

test('db 不可用只把 contextTokens 降为 null，照常出结果', () => {
  const dir = makeIsolatedDataDir();
  try {
    const out = handleCompactTool(
      { retention: 'r', nextInstruction: 'n' },
      { dataDir: dir, cwd: os.tmpdir(), shape: 'gui-active' }
    );
    assert.equal(out.ok, true);
    assert.equal(out.contextTokens, null);
    assert.ok(Array.isArray(out.plan) && out.plan.length > 0, 'plan 不因 db 失败缺失');
  } finally {
    rmDir(dir);
  }
});

// ---------- server.js 子进程冒烟（stdio JSON-RPC） ----------

const INIT_FRAME = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {} },
})}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n`;

function rpcFrame(id, method, params) {
  const msg = { jsonrpc: '2.0', id, method };
  if (params !== undefined) msg.params = params;
  return `${JSON.stringify(msg)}\n`;
}

function runServerIsolated(frames, envExtra = {}) {
  const home = makeTmpDir('zsc-ct-home-');
  const dataDir = makeIsolatedDataDir();
  try {
    // 双保险隔离：HOME 管 lib/log 落盘位置（os.homedir() 在 POSIX 尊重 HOME），
    // ZSC_DATA_DIR 管决策层数据目录；清掉外层可能已存在的 *_NESTED 键再按需注入
    const nested = envExtra.nested === true;
    delete envExtra.nested;
    const env = { ...process.env, ...envExtra, HOME: home, ZSC_DATA_DIR: dataDir };
    for (const key of Object.keys(env)) {
      if (/_NESTED$/.test(key)) delete env[key];
    }
    if (nested) env.ZSC_NESTED = '1';
    return spawnSync(process.execPath, [SERVER_JS], {
      input: frames,
      encoding: 'utf8',
      timeout: 15000,
      env,
    });
  } finally {
    rmDir(home);
    rmDir(dataDir);
  }
}

function parseRpcLines(stdout) {
  const msgs = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    // stdout 纯度红线：每一非空行都必须是合法 JSON-RPC 帧
    const msg = JSON.parse(line);
    assert.equal(msg.jsonrpc, '2.0');
    msgs.push(msg);
  }
  return msgs;
}

test('冒烟：initialize 回 serverInfo，tools/list 恰含 zsc_compact 且 schema 契约一致', () => {
  const res = runServerIsolated(INIT_FRAME + rpcFrame(2, 'tools/list'));
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const msgs = parseRpcLines(res.stdout);
  const init = msgs.find((m) => m.id === 1);
  assert.equal(init.result.serverInfo.name, 'z-smart-context');
  assert.ok(init.result.serverInfo.version, 'serverInfo 应带版本号');
  assert.equal(init.result.protocolVersion, '2024-11-05');
  const list = msgs.find((m) => m.id === 2);
  assert.equal(list.result.tools.length, 1);
  const tool = list.result.tools[0];
  assert.equal(tool.name, 'zsc_compact');
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['nextInstruction', 'retention', 'sessionId']);
  // 「retention 与 nextInstruction 至少其一必填」的 anyOf 表达
  const requiredAlts = tool.inputSchema.anyOf.map((alt) => alt.required[0]).sort();
  assert.deepEqual(requiredAlts, ['nextInstruction', 'retention']);
});

test('冒烟：tools/call 缺参返回 isError 且正文含恢复动作', () => {
  const res = runServerIsolated(INIT_FRAME + rpcFrame(3, 'tools/call', { name: 'zsc_compact', arguments: {} }));
  const msgs = parseRpcLines(res.stdout);
  const call = msgs.find((m) => m.id === 3);
  assert.equal(call.result.isError, true);
  const text = call.result.content.map((c) => c.text).join('');
  assert.match(JSON.parse(text).text, /恢复动作/);
});

test('嵌套 env（ZSC_NESTED=1）下 tools/list 返回空数组，工具面对子会话不可见', () => {
  const res = runServerIsolated(INIT_FRAME + rpcFrame(2, 'tools/list'), { nested: true });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const msgs = parseRpcLines(res.stdout);
  const list = msgs.find((m) => m.id === 2);
  assert.deepEqual(list.result.tools, []);
  // initialize 等协议方法不受嵌套影响
  const init = msgs.find((m) => m.id === 1);
  assert.equal(init.result.serverInfo.name, 'z-smart-context');
});
