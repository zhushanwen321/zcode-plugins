'use strict';

/**
 * MCP server 测试（W2-S4 决策位③入口；N2-b 起 zflow 六 action 面）。
 *
 * 隔离原则：协议层与纯函数用 fake manager / fake wfManager 全覆盖；真实
 * WorkflowManager 接线用例（校验权威 + 后台冒烟 + abort）注入 fake 内置入口
 * （不跑真 zcode）；进程级测试 spawn 真实 server 进程但 ZSW_ROOT /
 * ZCODE_MAILBOX_ROOT 指到临时目录——不碰真实 ~/.zcode。
 *
 * env 必须在 require server 之前设置：server 传递依赖 config，
 * config 在模块加载期从 env 冻结路径。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-srv-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsub-root');
process.env.ZCODE_MAILBOX_ROOT = path.join(TMP, 'mailbox');
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

// env 隔离完成后才允许 require（见文件头注释）
const server = require('../dist/mcp/server');

const SERVER_PATH = path.join(__dirname, '..', 'dist', 'mcp', 'server.js');

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// ----------------------------------------------------- 纯函数：_meta 提取

test('extractSessionId：Z3 通道提取（有值/无值/类型不对均不报错）', () => {
  assert.equal(
    server.extractSessionId({ 'com.zcode/request-context': { session_id: 'sess_abc123' } }),
    'sess_abc123',
  );
  assert.equal(server.extractSessionId({}), undefined);
  assert.equal(server.extractSessionId(undefined), undefined);
  assert.equal(server.extractSessionId(null), undefined);
  assert.equal(
    server.extractSessionId({ 'com.zcode/request-context': { session_id: 123 } }),
    undefined,
  );
  assert.equal(
    server.extractSessionId({ 'com.zcode/request-context': { session_id: '' } }),
    undefined,
  );
});

// ------------------------------------------------------ 纯函数：tool 定义

test('buildToolDefinition：单 tool zsub，description ≤900 字符，action 枚举齐全', () => {
  const tool = server.buildToolDefinition();
  assert.equal(tool.name, 'zsub');
  assert.ok(tool.description.length > 0);
  assert.ok(tool.description.length <= 900, `description ${tool.description.length} 字符超限`);
  // 七 action 一行速查 + 三条纪律 + skill 指针，三要素都在
  for (const action of ['start', 'list', 'status', 'cancel', 'message', 'close', 'agents']) {
    assert.ok(tool.description.includes(action), `description 缺 ${action}`);
  }
  assert.ok(tool.description.includes('zsub-zflow-orchestration'));
  assert.deepEqual(
    tool.inputSchema.properties.action.enum,
    ['start', 'list', 'status', 'cancel', 'message', 'close', 'agents'],
  );
  assert.deepEqual(tool.inputSchema.required, ['action']);
});

// --------------------------------------------------------- 帧编解码

test('createFrameDecoder：跨 chunk 分帧、多行单 chunk、空行忽略', () => {
  const lines = [];
  const dec = server.createFrameDecoder((l) => lines.push(l));
  dec.push('{"a":');
  dec.push('1}\n{"b"');
  dec.push(':2}\r\n\n\n{"c":3}\n');
  dec.push('未结尾的部分帧'); // 无换行：留在缓冲，不吐出
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

// ------------------------------------------------- 协议层（fake manager）

function makeFakeManager() {
  const calls = [];
  return {
    calls,
    async start(params, ctx) { calls.push({ action: 'start', params, ctx }); return { subagentId: 'sa-x', status: 'running', notify: 'mailbox' }; },
    list() { calls.push({ action: 'list' }); return []; },
    status(id) { calls.push({ action: 'status', id }); return { subagentId: id, status: 'closed' }; },
    async cancel(id) { calls.push({ action: 'cancel', id }); return { subagentId: id, status: 'cancelled' }; },
    message(id, text) { calls.push({ action: 'message', id, text }); return { subagentId: id, status: 'running' }; },
    async close(id) { calls.push({ action: 'close', id }); return { subagentId: id, status: 'closed' }; },
  };
}

function callTool(srv, args, extraParams = {}) {
  return srv.handleMessage({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'zsub', arguments: args, ...extraParams },
  });
}

test('协议层：initialize 回 serverInfo 与 protocolVersion', async () => {
  const srv = server.createServer({ manager: makeFakeManager(), nested: false });
  const frames = await srv.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' },
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, 1);
  assert.equal(frames[0].result.serverInfo.name, 'zsub');
  assert.equal(frames[0].result.protocolVersion, '2025-03-26');
  assert.deepEqual(frames[0].result.capabilities, { tools: {} });
});

test('协议层：tools/list 正常档注册双 tool，NESTED 档空列表（防递归第二重）', async () => {
  const normal = server.createServer({ manager: makeFakeManager(), nested: false });
  const f1 = await normal.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(f1[0].result.tools.length, 2);
  assert.deepEqual(f1[0].result.tools.map((t) => t.name), ['zsub', 'zflow']);

  const nested = server.createServer({ manager: makeFakeManager(), nested: true });
  const f2 = await nested.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.deepEqual(f2[0].result.tools, []);
});

test('协议层：unknown method / unknown tool / ping / 通知帧', async () => {
  const srv = server.createServer({ manager: makeFakeManager(), nested: false });
  const bad = await srv.handleMessage({ jsonrpc: '2.0', id: 1, method: 'no/such/method' });
  assert.equal(bad[0].error.code, -32601);
  assert.match(bad[0].error.message, /no\/such\/method/);

  const badTool = await srv.handleMessage({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'other_tool', arguments: {} },
  });
  assert.equal(badTool[0].error.code, -32601);

  const pong = await srv.handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(pong[0].result, {});

  const notif = await srv.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual(notif, []); // 通知帧不应答
  const notJsonrpc = await srv.handleMessage({ id: 4, method: 'ping' });
  assert.deepEqual(notJsonrpc, []);
});

test('tools/call start：_meta 提取 session_id 作为 ctx，cwd 取 ZCODE_PROJECT_DIR', async () => {
  process.env.ZCODE_PROJECT_DIR = '/proj/demo';
  try {
    const fake = makeFakeManager();
    const srv = server.createServer({ manager: fake, nested: false });
    const frames = await callTool(srv, { action: 'start', task: '任务书', slug: 's1' }, {
      _meta: { 'com.zcode/request-context': { session_id: 'sess_zzz' } },
    });
    assert.equal(frames[0].result.isError, undefined);
    const payload = JSON.parse(frames[0].result.content[0].text);
    assert.equal(payload.subagentId, 'sa-x');
    assert.equal(fake.calls[0].ctx.targetSessionId, 'sess_zzz'); // Z3 通道贯通
    assert.equal(fake.calls[0].ctx.cwd, '/proj/demo');
    assert.equal(fake.calls[0].params.slug, 's1');
  } finally {
    delete process.env.ZCODE_PROJECT_DIR;
  }
});

test('tools/call：无 _meta 时 targetSessionId 为 undefined（不报错，mailbox 自然降级）', async () => {
  const fake = makeFakeManager();
  const srv = server.createServer({ manager: fake, nested: false });
  const frames = await callTool(srv, { action: 'list' });
  assert.equal(frames[0].result.isError, undefined);
  assert.deepEqual(fake.calls[0], { action: 'list' });
  const noMeta = await callTool(srv, { action: 'status', subagentId: 'sa-1' });
  assert.equal(JSON.parse(noMeta[0].result.content[0].text).subagentId, 'sa-1');
});

test('tools/call：bad action / 缺 subagentId / manager 异常 → isError 可操作文案', async () => {
  const srv = server.createServer({ manager: makeFakeManager(), nested: false });

  const badAction = await callTool(srv, { action: 'explode' });
  assert.equal(badAction[0].result.isError, true);
  assert.match(badAction[0].result.content[0].text, /不支持的 action/);
  assert.match(badAction[0].result.content[0].text, /恢复指引/);

  const noId = await callTool(srv, { action: 'status' });
  assert.equal(noId[0].result.isError, true);
  assert.match(noId[0].result.content[0].text, /subagentId/);

  const boom = makeFakeManager();
  boom.status = () => { throw new Error('未知模型 "GLM-9"。恢复指引：改用 GLM-5.3。'); };
  const srv2 = server.createServer({ manager: boom, nested: false });
  const err = await callTool(srv2, { action: 'status', subagentId: 'sa-1' });
  assert.equal(err[0].result.isError, true);
  assert.match(err[0].result.content[0].text, /恢复指引/); // manager 错误原样透传
});

test('tools/call：NESTED 档拒绝服务（不触达 manager）', async () => {
  const fake = makeFakeManager();
  const srv = server.createServer({ manager: fake, nested: true });
  const frames = await callTool(srv, { action: 'start', task: 'x', slug: 'y' });
  assert.equal(frames[0].result.isError, true);
  assert.match(frames[0].result.content[0].text, /嵌套调用已拒绝/);
  assert.equal(fake.calls.length, 0);
});

test('tools/call：message 缺 text → isError', async () => {
  const fake = makeFakeManager();
  const srv = server.createServer({ manager: fake, nested: false });
  const frames = await callTool(srv, { action: 'message', subagentId: 'sa-1' });
  assert.equal(frames[0].result.isError, true);
  assert.match(frames[0].result.content[0].text, /text/);
  assert.equal(fake.calls.length, 0);
});

// --------------------------------------------- agents action（按需查询索引）

test('tools/call agents：真实四根 resolver，返回精简视图且 source 按根推断', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-srv-ag-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  const home = path.join(tmp, 'home');
  const mkAgent = (dir, name, desc) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${desc}\n---\n\nbody\n`);
  };
  mkAgent(path.join(ws, '.agents', 'agents'), 'proj-pi', '项目 .agents 根');
  mkAgent(path.join(ws, '.zcode', 'agents'), 'proj-zc', '项目 .zcode 根');
  mkAgent(path.join(home, '.agents', 'agents'), 'user-pi', '用户 .agents 根');
  mkAgent(path.join(home, '.zcode', 'agents'), 'user-zc', '用户 .zcode 根');

  const { AgentMdResolver } = require('../lib/agent-md-resolver');
  const manager = { ...makeFakeManager(), resolver: new AgentMdResolver({ homeDir: home }) };
  const handlers = server.buildToolHandlers({ manager, nested: false });
  const result = await handlers.zsub(
    { name: 'zsub', arguments: { action: 'agents' } },
    { cwd: ws },
  );
  assert.equal(result.isError, undefined);
  const rows = JSON.parse(result.content[0].text);
  // resolver.list 按 name 排序；source 与四根优先级标签一一对应
  assert.deepEqual(rows.map((r) => [r.name, r.source]), [
    ['proj-pi', 'project-agents'],
    ['proj-zc', 'project-zcode'],
    ['user-pi', 'user-agents'],
    ['user-zc', 'user-zcode'],
  ]);
  // 精简视图：只有索引四字段（body/model 等 profile 字段不透出）
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['description', 'file', 'name', 'source']);
    assert.ok(r.file.endsWith('.md'));
  }
});

test('tools/call agents：cwd 透传 resolver.list；description 截 200；resolver 缺失可操作错误', async () => {
  const seenCwd = [];
  const fakeHome = path.join(TMP, 'ag-fake-home'); // TMP 在真实 HOME 外，防 source 推断被真实 HOME 干扰
  const fakeResolver = {
    homeDir: fakeHome,
    list(cwd) {
      seenCwd.push(cwd);
      return [
        {
          name: 'long',
          description: '长'.repeat(350),
          filePath: path.join(fakeHome, '.zcode', 'agents', 'long.md'),
        },
        { name: 'nodesc', filePath: path.join(cwd, '.agents', 'agents', 'nodesc.md') },
      ];
    },
  };
  const manager = { ...makeFakeManager(), resolver: fakeResolver };
  const handlers = server.buildToolHandlers({ manager, nested: false });
  const result = await handlers.zsub(
    { name: 'zsub', arguments: { action: 'agents' } },
    { cwd: '/proj/ag' },
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(seenCwd, ['/proj/ag']); // cwd 原样透传给 resolver.list
  const rows = JSON.parse(result.content[0].text);
  assert.equal(rows[0].description, '长'.repeat(200)); // 超 200 截断
  assert.equal(rows[0].source, 'user-zcode');
  assert.equal(rows[1].description, ''); // description 缺省容忍为空串
  assert.equal(rows[1].source, 'project-agents'); // cwd 前缀优先于 HOME 前缀判定

  // resolver 缺失（异常组装防御）：可操作错误而非 TypeError 被 catch 吞
  const broken = server.buildToolHandlers({ manager: makeFakeManager(), nested: false });
  const err = await broken.zsub({ name: 'zsub', arguments: { action: 'agents' } });
  assert.equal(err.isError, true);
  assert.match(err.content[0].text, /resolver/);
  assert.match(err.content[0].text, /恢复指引/);
});

// ------------------------------------------- 多 tool 注册表形态（结构化改造）

test('buildTools：返回数组形态，含 zsub 与 zflow，与单 tool 定义完全一致', () => {
  const tools = server.buildTools();
  assert.ok(Array.isArray(tools), 'tools/list 数据源必须是数组（多 tool 注册表形态）');
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, 'zsub');
  assert.deepEqual(tools[0], server.buildToolDefinition()); // tool 形态不变（回归红线）
  assert.equal(tools[1].name, 'zflow');
  assert.deepEqual(tools[1], server.buildRunWorkflowToolDefinition());
});

test('buildRunWorkflowToolDefinition：action 枚举 6 值、description ≤1000、workflow 自由 string、无源插件品牌残留', () => {
  const tool = server.buildRunWorkflowToolDefinition();
  assert.deepEqual(
    tool.inputSchema.properties.action.enum,
    ['run', 'abort', 'status', 'list', 'scripts', 'lint'],
  );
  assert.deepEqual(tool.inputSchema.required, ['action']);
  assert.ok(tool.description.length <= 1000, `description ${tool.description.length} 字符超限`);
  // workflow 是自由 string（N2-b）：script:<name> 四根动态发现，静态枚举无法收录
  assert.equal(tool.inputSchema.properties.workflow.enum, undefined);
  assert.ok(tool.inputSchema.properties.workflow.description.includes('script:'));
  // 内置 5 名速查 + 后台纪律（runId 即返 + 勿轮询）保留
  for (const wf of ['chain', 'parallel', 'map-reduce', 'scatter-gather', 'review-fix-loop']) {
    assert.ok(tool.description.includes(`"${wf}"`), `description 缺 ${wf}`);
  }
  assert.ok(tool.description.includes('do NOT poll'));
  // 品牌统一（M1-a 定案）：zsub 插件不带 dynamic-workflow 字样
  assert.ok(!tool.description.includes('dynamic-workflow'));
  assert.ok(!JSON.stringify(tool.inputSchema).includes('dynamic-workflow'));
});

test('dispatchToolCall：两个注册 tool 名可正向分发；未收录名走 -32601（含原型链属性名）', async () => {
  const srv = server.createServer({
    manager: makeFakeManager(),
    wfManager: makeFakeWfManager(),
    nested: false,
  });
  // zflow 已入表（N2-b）：正向分发到 handler（此处以 runId 必填校验错误证明命中）
  const hit = await srv.dispatchToolCall({
    name: 'zflow', arguments: { action: 'status' },
  });
  assert.equal(hit.isError, true);
  assert.match(hit.content[0].text, /runId/);

  // 注册表键必须精确匹配：原型链属性名与未收录名不得被误当 handler 命中
  await assert.rejects(
    srv.dispatchToolCall({ name: 'constructor', arguments: {} }),
    (e) => e.code === -32601 && /constructor/.test(e.message),
  );
  await assert.rejects(
    srv.dispatchToolCall({ name: 'no_such_tool', arguments: {} }),
    (e) => e instanceof server.RpcError && e.code === -32601 && /no_such_tool/.test(e.message),
  );
  await assert.rejects(
    srv.dispatchToolCall(undefined),
    (e) => e.code === -32601,
  );
});

test('注册表隔离：zsub handler 可脱离 dispatch 单独调用（buildToolHandlers 工厂）', async () => {
  const fake = makeFakeManager();
  const handlers = server.buildToolHandlers({ manager: fake, nested: false });
  assert.deepEqual(Object.keys(handlers), ['zsub', 'zflow']); // 双 tool 注册表
  const result = await handlers.zsub(
    {
      name: 'zsub',
      arguments: { action: 'start', task: '任务书', slug: 'iso' },
      _meta: { 'com.zcode/request-context': { session_id: 'sess_iso' } },
    },
    { cwd: '/proj/iso' }, // env 显式注入：证明 ctx 组装封装在 handler 内，不依赖 dispatch
  );
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).subagentId, 'sa-x');
  assert.equal(fake.calls[0].ctx.targetSessionId, 'sess_iso');
  assert.equal(fake.calls[0].ctx.cwd, '/proj/iso');

  // 嵌套门禁也在 handler 内：直接调用同样拒绝且不触达 manager
  const nestedHandlers = server.buildToolHandlers({ manager: fake, nested: true });
  const rejected = await nestedHandlers.zsub({ name: 'zsub', arguments: { action: 'list' } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /嵌套调用已拒绝/);
  assert.equal(fake.calls.length, 1); // 仅上面的 start，嵌套档零触达
});

// ---------------------------------------- zflow 六 action 面（N2-b）

/** fake WorkflowManager：记录调用、返回可断言形态（协议层与分发面测试用）。 */
function makeFakeWfManager() {
  const calls = [];
  return {
    calls,
    async start(params, ctx) {
      calls.push({ action: 'run', params, ctx });
      return { runId: 'wf-fake1', workflow: params.workflow, status: 'running', notify: 'mailbox' };
    },
    async abort(runId) { calls.push({ action: 'abort', runId }); return { runId, status: 'cancelled', aborted: true }; },
    status(runId) {
      calls.push({ action: 'status', runId });
      return { runId, status: 'closed', outputFile: path.join(TMP, 'outputs', `${runId}.md`) };
    },
    list() { calls.push({ action: 'list' }); return [{ runId: 'wf-fake1', workflow: 'chain', status: 'closed' }]; },
    listScripts(cwd) {
      calls.push({ action: 'scripts', cwd });
      return [{ name: 'my-wf', description: '测试脚本', file: path.join(TMP, 'my-wf.js'), source: 'workspace-agents' }];
    },
  };
}

function makeWfServer(wfManager = makeFakeWfManager()) {
  return { wfm: wfManager, srv: server.createServer({ manager: makeFakeManager(), wfManager, nested: false }) };
}

test('zflow run：action 剥离后透传 start，_meta session + env.cwd 组装 ctx，立即返回句柄', async () => {
  const { wfm, srv } = makeWfServer();
  process.env.ZCODE_PROJECT_DIR = '/proj/wf';
  try {
    const result = await srv.dispatchToolCall({
      name: 'zflow',
      arguments: {
        action: 'run', workflow: 'chain', task: '接线冒烟', workdir: TMP,
        model: 'GLM-4.7-Flash', maxConcurrent: 2, timeoutMsPerPhase: 12345, wait: false,
      },
      _meta: { 'com.zcode/request-context': { session_id: 'sess_wf' } },
    });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.runId, 'wf-fake1');
    assert.equal(payload.status, 'running');
    assert.equal(wfm.calls.length, 1);
    // action 不得泄入 start 参数（WorkflowManager 的 workflowParams 只剥
    // STRIP_PARAM_KEYS，泄漏会污染入口参数与 record）
    assert.equal(wfm.calls[0].params.action, undefined);
    assert.equal(wfm.calls[0].params.workflow, 'chain');
    assert.equal(wfm.calls[0].params.maxConcurrent, 2);
    assert.equal(wfm.calls[0].ctx.targetSessionId, 'sess_wf');
    assert.equal(wfm.calls[0].ctx.cwd, '/proj/wf');
  } finally {
    delete process.env.ZCODE_PROJECT_DIR;
  }
});

test('zflow：abort/status/list 分发与 runId 必填校验', async () => {
  const { wfm, srv } = makeWfServer();
  const call = (args) => srv.dispatchToolCall({ name: 'zflow', arguments: args });

  const noId = await call({ action: 'status' });
  assert.equal(noId.isError, true);
  assert.match(noId.content[0].text, /runId/);

  const st = await call({ action: 'status', runId: 'wf-1' });
  assert.equal(JSON.parse(st.content[0].text).outputFile.includes('wf-1'), true);
  assert.deepEqual(wfm.calls.at(-1), { action: 'status', runId: 'wf-1' });

  const ab = await call({ action: 'abort', runId: 'wf-1' });
  assert.equal(JSON.parse(ab.content[0].text).aborted, true);

  const ls = await call({ action: 'list' });
  assert.equal(JSON.parse(ls.content[0].text).length, 1);
  assert.deepEqual(wfm.calls.at(-1), { action: 'list' });
});

test('zflow scripts：内置 5 + 脚本清单合并，cwd 透传发现层', async () => {
  const { wfm, srv } = makeWfServer();
  const result = await srv.dispatchToolCall(
    { name: 'zflow', arguments: { action: 'scripts' } },
    { cwd: '/proj/scripts-cwd' },
  );
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(
    payload.builtin.map((b) => b.name),
    ['chain', 'parallel', 'map-reduce', 'scatter-gather', 'review-fix-loop'],
  );
  assert.deepEqual(payload.scripts.map((s) => s.name), ['my-wf']);
  assert.deepEqual(wfm.calls[0], { action: 'scripts', cwd: '/proj/scripts-cwd' });
});

test('zflow lint：file 必填 + 真实 lintScript 两档校验（好/坏脚本）', async (t) => {
  const { srv } = makeWfServer();
  const call = (args) => srv.dispatchToolCall({ name: 'zflow', arguments: args });

  const noFile = await call({ action: 'lint' });
  assert.equal(noFile.isError, true);
  assert.match(noFile.content[0].text, /file/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-srv-lint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const good = path.join(dir, 'good.js');
  fs.writeFileSync(good, "module.exports = { name: 'good', description: 'd', run: async () => 'ok' };");
  const okRes = JSON.parse((await call({ action: 'lint', file: good })).content[0].text);
  assert.deepEqual(okRes, { ok: true, errors: [] });

  const bad = path.join(dir, 'bad.js');
  fs.writeFileSync(bad, "module.exports = { name: 'bad' };\nconst x = ;");
  const badRes = JSON.parse((await call({ action: 'lint', file: bad })).content[0].text);
  assert.equal(badRes.ok, false);
  assert.ok(badRes.errors.some((e) => /语法/.test(e)), JSON.stringify(badRes));
});

test('zflow：bad action / manager 可操作错误透传 / NESTED 拒绝 / wfManager 缺失 -32603', async () => {
  const { wfm, srv } = makeWfServer();
  const call = (args) => srv.dispatchToolCall({ name: 'zflow', arguments: args });

  const bad = await call({ action: 'explode' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /不支持的 action/);
  assert.match(bad.content[0].text, /run \| abort \| status \| list \| scripts \| lint/);

  // wfManager 抛的都是含恢复指引的可操作错误，原样透传
  const wfm2 = makeFakeWfManager();
  wfm2.start = async () => {
    throw new Error('不支持的 workflow "fancy"（内置: chain / parallel / ...）。恢复指引：workflow 必须取内置名或 script:<脚本名>。');
  };
  const srv2 = server.createServer({ manager: makeFakeManager(), wfManager: wfm2, nested: false });
  const err = await srv2.dispatchToolCall({
    name: 'zflow', arguments: { action: 'run', workflow: 'fancy', task: 't', workdir: TMP },
  });
  assert.equal(err.isError, true);
  assert.match(err.content[0].text, /不支持的 workflow/);
  assert.match(err.content[0].text, /恢复指引/);

  // NESTED 档：拒绝且零触达（防递归第二重对两个 tool 一视同仁）
  const wfmNested = makeFakeWfManager();
  const nestedSrv = server.createServer({ manager: makeFakeManager(), wfManager: wfmNested, nested: true });
  const rejected = await nestedSrv.dispatchToolCall({ name: 'zflow', arguments: { action: 'list' } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /嵌套调用已拒绝/);
  assert.equal(wfmNested.calls.length, 0);

  // wfManager 缺失（异常组装防御）：协议级 -32603 而非 TypeError 炸穿
  const broken = server.createServer({ manager: makeFakeManager(), nested: false });
  await assert.rejects(
    broken.dispatchToolCall({ name: 'zflow', arguments: { action: 'list' } }),
    (e) => e.code === -32603 && /workflow 运行时/.test(e.message),
  );
  assert.equal(wfm.calls.length, 0); // 上面的 fake 未被触碰
});

// ----------------------------- 真实 WorkflowManager 接线（校验权威 + 后台冒烟）

/** 造一个与内置入口统一返回结构一致的 ok 结果（buildMarkdownReport 可消费）。 */
function okWfResult(opts, workflow = 'chain') {
  const now = new Date().toISOString();
  return {
    ok: true, status: 'ok', workflow,
    task: opts.task, workdir: opts.workdir, model: opts.model || 'fake/model',
    phases: [{
      phase: 'analyze', label: '分析', ok: true, sessionId: 'sess_phase',
      usage: { input_tokens: 1, output_tokens: 2 }, timedOut: false, durationMs: 10,
      response: '阶段输出',
    }],
    final: '冒烟结论',
    startedAt: now, finishedAt: now,
  };
}

/** 挂住直到 signal abort 才返回 aborted 结果（abort 用例的入口形态）。 */
function hangingUntilAbort(opts) {
  return new Promise((resolve) => {
    const finish = () => {
      const now = new Date().toISOString();
      resolve({
        ok: false, status: 'aborted', abortedAtPhase: 'analyze',
        workflow: 'chain', task: opts.task, workdir: opts.workdir, model: 'fake/model',
        phases: [], final: null, error: '阶段 analyze（分析）被中止（aborted）',
        startedAt: now, finishedAt: now,
      });
    };
    if (opts.signal?.aborted) { finish(); return; }
    opts.signal?.addEventListener('abort', finish, { once: true });
  });
}

/** 真实 WorkflowManager + 注入 fake 内置入口（组装形态同 workflow-manager.test.js）。 */
function buildRealWfManager(workflows) {
  const { RecordStore } = require('../lib/record-store');
  const outputs = require('../lib/output-store');
  const { MailboxNotifier } = require('../lib/notifier-mailbox');
  const { WorkflowManager } = require('../lib/workflow-manager');
  return new WorkflowManager({
    records: new RecordStore(),
    outputs,
    notifier: new MailboxNotifier(),
    workflows,
  });
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForAsync(fn, timeoutMs = 5000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitForAsync 超时');
    await sleepMs(stepMs);
  }
}

test('zflow run：校验权威在 WorkflowManager（缺 task / workdir 不存在 / 未知 workflow / 脚本未发现 → isError 可操作）', async () => {
  const wfm = buildRealWfManager({ chain: async (opts) => okWfResult(opts) });
  const srv = server.createServer({ manager: makeFakeManager(), wfManager: wfm, nested: false });
  const call = (args) => srv.dispatchToolCall({ name: 'zflow', arguments: { action: 'run', ...args } });

  const noTask = await call({ workflow: 'chain', workdir: TMP });
  assert.equal(noTask.isError, true);
  assert.match(noTask.content[0].text, /task/);

  const badDir = await call({ workflow: 'chain', task: 't', workdir: '/no/such/dir' });
  assert.equal(badDir.isError, true);
  assert.match(badDir.content[0].text, /workdir 不存在或不是目录/);
  assert.match(badDir.content[0].text, /恢复指引/);

  const badWf = await call({ workflow: 'fancy', task: 't', workdir: TMP });
  assert.equal(badWf.isError, true);
  assert.match(badWf.content[0].text, /不支持的 workflow/);

  const missingScript = await call({ workflow: 'script:nope', task: 't', workdir: TMP });
  assert.equal(missingScript.isError, true);
  assert.match(missingScript.content[0].text, /未找到 workflow 脚本/);
});

test('zflow 后台冒烟（真实 WorkflowManager）：run 立即返句柄 → status 轮询至 closed → outputs 落盘双段报告 → list 可见', async () => {
  // 为什么在单测层而非 e2e：e2e 文件 before() 做真实模型配额窗口探测（窗口
  // 不开则整个文件失败），fake 冒烟放 e2e 会被真机前置条件绑架；后台执行体
  // 在 server 进程内，本测试与 e2e 结构同构（createServer + dispatchToolCall）
  const entryCalls = [];
  const wfm = buildRealWfManager({ chain: async (opts) => { entryCalls.push(opts); return okWfResult(opts); } });
  const srv = server.createServer({ manager: makeFakeManager(), wfManager: wfm, nested: false });

  const result = await srv.dispatchToolCall({
    name: 'zflow',
    arguments: { action: 'run', workflow: 'chain', task: '后台冒烟', workdir: TMP },
    _meta: { 'com.zcode/request-context': { session_id: 'sess_wf_bg' } },
  });
  assert.equal(result.isError, undefined);
  const h = JSON.parse(result.content[0].text);
  assert.match(h.runId, /^wf-/);
  assert.equal(h.status, 'running');

  // 轮询走 MCP status action（覆盖分发全链，非直连 manager）
  const fin = await waitForAsync(async () => {
    const r = await srv.dispatchToolCall({ name: 'zflow', arguments: { action: 'status', runId: h.runId } });
    const rec = JSON.parse(r.content[0].text);
    return ['closed', 'error', 'timeout', 'cancelled'].includes(rec.status) ? rec : null;
  });
  assert.equal(fin.status, 'closed', `终态: ${fin.error || ''}`);
  assert.equal(entryCalls.length, 1);

  // outputs 落盘断言：报告 = markdown 品牌头 + ```json 机器段（双段合一文件）
  assert.ok(fs.existsSync(fin.outputFile), `outputs 未落盘: ${fin.outputFile}`);
  const text = fs.readFileSync(fin.outputFile, 'utf8');
  assert.match(text, /^# zsub · chain 报告/);
  assert.match(text, /```json\n/);

  const listed = JSON.parse((await srv.dispatchToolCall({
    name: 'zflow', arguments: { action: 'list' },
  })).content[0].text);
  assert.ok(listed.some((r) => r.runId === h.runId && r.status === 'closed'));
});

test('zflow abort（真实 WorkflowManager）：hanging 入口 → abort 落 cancelled，零完成通知', async () => {
  const wfm = buildRealWfManager({ chain: hangingUntilAbort });
  const srv = server.createServer({ manager: makeFakeManager(), wfManager: wfm, nested: false });

  const h = JSON.parse((await srv.dispatchToolCall({
    name: 'zflow',
    arguments: { action: 'run', workflow: 'chain', task: '中止冒烟', workdir: TMP },
    _meta: { 'com.zcode/request-context': { session_id: 'sess_wf_abort' } },
  })).content[0].text);
  assert.equal(h.status, 'running');

  const ab = JSON.parse((await srv.dispatchToolCall({
    name: 'zflow', arguments: { action: 'abort', runId: h.runId },
  })).content[0].text);
  assert.equal(ab.aborted, true);
  assert.equal(ab.status, 'cancelled');

  const fin = JSON.parse((await srv.dispatchToolCall({
    name: 'zflow', arguments: { action: 'status', runId: h.runId },
  })).content[0].text);
  assert.equal(fin.status, 'cancelled');
  // cancelled 不投递完成通知（对齐 subagent cancel 语义）
  const mailboxDir = path.join(process.env.ZCODE_MAILBOX_ROOT, 'sess_wf_abort', 'unread');
  assert.ok(!fs.existsSync(mailboxDir) || fs.readdirSync(mailboxDir).length === 0);
});

// ---------------------------------------------------------- 进程级测试

/** spawn 真实 server 进程：发送 initialize + tools/list，收帧后关 stdin。 */
function runServerProc({ nested, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ZSW_ROOT: path.join(TMP, nested ? 'root-nested' : 'root-normal'),
      ZCODE_MAILBOX_ROOT: path.join(TMP, 'mailbox-proc'),
      ZSW_ZCODE_CLI: '/nonexistent', // 防御：即使误启 runner 也不碰真 CLI
    };
    if (nested) env.ZSW_NESTED = '1';
    else delete env.ZSW_NESTED;

    const child = spawn(process.execPath, [SERVER_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const frames = [];
    let out = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      out += d;
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl);
        out = out.slice(nl + 1);
        if (line.trim()) frames.push(JSON.parse(line));
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`进程级测试超时（nested=${nested}）`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, frames, stderr, restStdout: out });
    });
  });
}

test('进程级：正常档 initialize→tools/list 出双 tool，stdin 关闭后干净退出（exit 0，stdout 无杂音）', async () => {
  const r = await runServerProc({ nested: false });
  assert.equal(r.code, 0);
  assert.equal(r.restStdout.trim(), ''); // stdout 只走协议帧（帧已全部解析，无半截残留）
  const init = r.frames.find((f) => f.id === 1);
  assert.equal(init.result.serverInfo.name, 'zsub');
  const tl = r.frames.find((f) => f.id === 2);
  assert.equal(tl.result.tools.length, 2);
  assert.deepEqual(tl.result.tools.map((t) => t.name), ['zsub', 'zflow']);
  assert.match(r.stderr, /record 恢复/); // 启动序列（sweep+recover）日志走 stderr
  assert.match(r.stderr, /workflow record 恢复/); // N2-b：wfManager.recover 与 subagent recover 并存
  // 启动序列不得有清扫失败（MUST_FIX-1 回归：reaper 接线字段错误曾被 catch 吞掉）
  assert.ok(!r.stderr.includes('清扫失败'), `启动序列不应有清扫失败: ${r.stderr}`);
});

test('进程级：启动序列孤儿 outputs 清扫接线正确（MUST_FIX-1 回归）', async () => {
  // 注入一个 record 索引不认识的孤儿结果文件后启动：reaper 应走报告分支
  // 而非抛 TypeError 被 catch 吞掉（字段名漂移曾让整段清扫不可达）
  const outputsDir = path.join(TMP, 'root-normal', 'outputs');
  fs.mkdirSync(outputsDir, { recursive: true });
  fs.writeFileSync(path.join(outputsDir, 'sa-ghost.md'), '# 崩溃残留\n');
  const r = await runServerProc({ nested: false });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /孤儿结果文件 1 个（只报告不删）/);
  assert.match(r.stderr, /sa-ghost\.md/);
  assert.ok(!r.stderr.includes('清扫失败'), `启动序列不应有清扫失败: ${r.stderr}`);
});

test('进程级：NESTED 档不注册工具，仍正常应答协议后退出', async () => {
  const r = await runServerProc({ nested: true });
  assert.equal(r.code, 0);
  const tl = r.frames.find((f) => f.id === 2);
  assert.deepEqual(tl.result.tools, []);
  assert.match(r.stderr, /ZSW_NESTED/);
});
