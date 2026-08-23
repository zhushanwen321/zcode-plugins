'use strict';

/**
 * MCP server 测试（W2-S4 决策位③入口）。
 *
 * 隔离原则：协议层与纯函数用 fake manager 全覆盖；进程级测试 spawn 真实
 * server 进程但 ZSUB_ROOT / ZCODE_MAILBOX_ROOT 指到临时目录——不碰真实
 * ~/.zcode，不跑真 zcode。
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
process.env.ZSUB_ROOT = path.join(TMP, 'zsub-root');
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

test('buildToolDefinition：单 tool zsub，description ≤1600 字符，action 枚举齐全', () => {
  const tool = server.buildToolDefinition();
  assert.equal(tool.name, 'zsub');
  assert.ok(tool.description.length > 0);
  assert.ok(tool.description.length <= 1600, `description ${tool.description.length} 字符超限`);
  // 五 action 一行速查 + 三条纪律 + skill 指针，三要素都在
  for (const action of ['start', 'list', 'status', 'cancel', 'message', 'close']) {
    assert.ok(tool.description.includes(action), `description 缺 ${action}`);
  }
  assert.ok(tool.description.includes('zsub-orchestration'));
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['start', 'list', 'status', 'cancel', 'message', 'close']);
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
  assert.deepEqual(f1[0].result.tools.map((t) => t.name), ['zsub', 'run_workflow']);

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

// ------------------------------------------- 多 tool 注册表形态（结构化改造）

test('buildTools：返回数组形态，含 zsub 与 run_workflow，与单 tool 定义完全一致', () => {
  const tools = server.buildTools();
  assert.ok(Array.isArray(tools), 'tools/list 数据源必须是数组（多 tool 注册表形态）');
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, 'zsub');
  assert.deepEqual(tools[0], server.buildToolDefinition()); // tool 形态不变（回归红线）
  assert.equal(tools[1].name, 'run_workflow');
  assert.deepEqual(tools[1], server.buildRunWorkflowToolDefinition());
});

test('buildRunWorkflowToolDefinition：workflow 枚举 5 种、必填三项、无源插件品牌残留', () => {
  const tool = server.buildRunWorkflowToolDefinition();
  assert.deepEqual(
    tool.inputSchema.properties.workflow.enum,
    ['chain', 'parallel', 'map-reduce', 'scatter-gather', 'review-fix-loop'],
  );
  assert.deepEqual(tool.inputSchema.required, ['workflow', 'task', 'workdir']);
  // 品牌统一（M1-a 定案）：zsub 插件不带 dynamic-workflow 字样
  assert.ok(!tool.description.includes('dynamic-workflow'));
  assert.ok(!JSON.stringify(tool.inputSchema).includes('dynamic-workflow'));
  // 源 description 五种 workflow 速查保留（照搬权威参数面）
  for (const wf of ['chain', 'parallel', 'map-reduce', 'scatter-gather', 'review-fix-loop']) {
    assert.ok(tool.description.includes(`"${wf}"`), `description 缺 ${wf}`);
  }
});

test('dispatchToolCall：两个注册 tool 名可正向分发；未收录名走 -32601（含原型链属性名）', async () => {
  const srv = server.createServer({
    manager: makeFakeManager(),
    nested: false,
    workflows: makeFakeWorkflows().impls,
  });
  // run_workflow 已入表（M3 接线）：正向分发到 handler（此处以缺 task 校验错误证明命中）
  const hit = await srv.dispatchToolCall({
    name: 'run_workflow', arguments: { workflow: 'chain', workdir: TMP },
  });
  assert.equal(hit.isError, true);
  assert.match(hit.content[0].text, /task/);

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
  assert.deepEqual(Object.keys(handlers), ['zsub', 'run_workflow']); // 双 tool 注册表
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

// ------------------------------------------- run_workflow handler 冒烟（M3）

/** fake workflow 入口表：记录调用、驱动 onPlan/onPhase 回调、返回可渲染 result。 */
function makeFakeWorkflows() {
  const calls = [];
  const wrap = (name) => async (opts) => {
    calls.push({ name, opts });
    if (opts.onPlan) opts.onPlan(2);
    if (opts.onPhase) {
      opts.onPhase({ phase: 'analyze', status: 'running' });
      opts.onPhase({ phase: 'analyze', status: 'done' });
    }
    return {
      workflow: name, ok: true, task: opts.task, workdir: opts.workdir, model: opts.model || '-',
      startedAt: '2026-08-23T00:00:00.000Z', finishedAt: '2026-08-23T00:00:05.000Z',
      phases: [], final: 'fake 结论',
    };
  };
  return {
    calls,
    impls: {
      chain: wrap('chain'), parallel: wrap('parallel'), 'map-reduce': wrap('map-reduce'),
      'scatter-gather': wrap('scatter-gather'), 'review-fix-loop': wrap('review-fix-loop'),
    },
  };
}

function makeWfServer() {
  const fw = makeFakeWorkflows();
  return { fw, srv: server.createServer({ manager: makeFakeManager(), nested: false, workflows: fw.impls }) };
}

test('run_workflow：参数校验错误全部 isError 可操作（缺 task / workdir 不存在 / 未知 workflow / map-reduce 缺 items）', async () => {
  const { fw, srv } = makeWfServer();
  const call = (args) => srv.dispatchToolCall({ name: 'run_workflow', arguments: args });

  const noTask = await call({ workflow: 'chain', workdir: TMP });
  assert.equal(noTask.isError, true);
  assert.match(noTask.content[0].text, /task/);

  const badDir = await call({ workflow: 'chain', task: 't', workdir: '/no/such/dir' });
  assert.equal(badDir.isError, true);
  assert.match(badDir.content[0].text, /workdir 不存在或不是目录/);
  assert.match(badDir.content[0].text, /恢复指引/);

  const badWf = await call({ workflow: 'fancy', task: 't', workdir: TMP });
  assert.equal(badWf.isError, true);
  assert.match(badWf.content[0].text, /不支持的工作流类型/);

  const noItems = await call({ workflow: 'map-reduce', task: 't', workdir: TMP, operation: 'op' });
  assert.equal(noItems.isError, true);
  assert.match(noItems.content[0].text, /items/);

  const noOp = await call({ workflow: 'map-reduce', task: 't', workdir: TMP, items: ['a'] });
  assert.equal(noOp.isError, true);
  assert.match(noOp.content[0].text, /operation/);

  assert.equal(fw.calls.length, 0); // 校验失败零触达 workflow 入口
});

test('run_workflow：正常分发到对应入口 + 双段 content（[0] zsub 品牌 markdown、[1] json 围栏）', async () => {
  const { fw, srv } = makeWfServer();
  const result = await srv.dispatchToolCall({
    name: 'run_workflow',
    arguments: {
      workflow: 'chain', task: '接线冒烟', workdir: TMP,
      model: 'GLM-4.7-Flash', maxConcurrent: 2, timeoutMsPerPhase: 12345,
    },
  });
  assert.equal(result.isError, false); // 照源：isError 字段常驻（!ok），ok 时为 false
  assert.equal(fw.calls.length, 1);
  assert.equal(fw.calls[0].name, 'chain');
  assert.equal(fw.calls[0].opts.task, '接线冒烟');
  assert.equal(fw.calls[0].opts.workdir, TMP);
  assert.equal(fw.calls[0].opts.model, 'GLM-4.7-Flash');
  assert.equal(fw.calls[0].opts.maxConcurrent, 2);
  assert.equal(fw.calls[0].opts.timeoutMsPerPhase, 12345);
  assert.equal(typeof fw.calls[0].opts.onPhase, 'function');
  assert.equal(typeof fw.calls[0].opts.onPlan, 'function');

  assert.equal(result.content.length, 2); // 双段 content（照源 buildContentBlocks）
  assert.match(result.content[0].text, /^# zsub · chain 报告/); // 品牌行定案（M1-a）
  assert.ok(!result.content[0].text.includes('dynamic-workflow'));
  assert.match(result.content[1].text, /^```json\n/);
  assert.equal(JSON.parse(result.content[1].text.replace(/^```json\n/, '').replace(/\n```$/, '')).workflow, 'chain');
});

test('run_workflow：per-workflow 参数透传（perspectives/items/subtaskCount/reviewTarget 等）', async () => {
  const { fw, srv } = makeWfServer();
  const call = (args) => srv.dispatchToolCall({ name: 'run_workflow', arguments: { task: 't', workdir: TMP, ...args } });
  const last = () => fw.calls.at(-1);

  await call({ workflow: 'parallel', perspectives: ['sec', 'perf'] });
  assert.equal(last().name, 'parallel');
  assert.deepEqual(last().opts.perspectives, ['sec', 'perf']);

  await call({ workflow: 'map-reduce', items: ['a', 'b'], operation: 'do-x' });
  assert.equal(last().name, 'map-reduce');
  assert.deepEqual(last().opts.items, ['a', 'b']);
  assert.equal(last().opts.operation, 'do-x');

  await call({ workflow: 'scatter-gather', subtaskCount: 3 });
  assert.equal(last().name, 'scatter-gather');
  assert.equal(last().opts.subtaskCount, 3);

  await call({ workflow: 'review-fix-loop', reviewTarget: 'src/', reviewers: ['correctness'], maxRounds: 2 });
  assert.equal(last().name, 'review-fix-loop');
  assert.equal(last().opts.reviewTarget, 'src/');
  assert.deepEqual(last().opts.reviewers, ['correctness']);
  assert.equal(last().opts.maxRounds, 2);

  // reviewTarget 缺省回落「git 未提交改动」（照源默认值）
  await call({ workflow: 'review-fix-loop' });
  assert.equal(last().opts.reviewTarget, 'git 未提交改动');
  assert.equal(fw.calls.length, 5);
});

test('run_workflow：progressToken 经 env.emitFrame 实时推 progress 通知帧', async () => {
  const { fw, srv } = makeWfServer();
  const emitted = [];
  const result = await srv.dispatchToolCall(
    {
      name: 'run_workflow',
      arguments: { workflow: 'chain', task: 't', workdir: TMP },
      _meta: { progressToken: 'tok-1' },
    },
    { emitFrame: (frame) => emitted.push(frame) },
  );
  assert.equal(result.isError, false);
  // fake 入口驱动 onPlan(2) + onPhase(running/done)：done=1/expected=2 → 0.5
  assert.ok(emitted.some((f) => f.method === 'notifications/progress'
    && f.params.progressToken === 'tok-1' && f.params.progress === 0.5));
  // 终态帧：progress=1 completed
  assert.ok(emitted.some((f) => f.method === 'notifications/progress'
    && f.params.progressToken === 'tok-1' && f.params.progress === 1 && f.params.message === 'completed'));
  // 无 progressToken 时不产生通知帧：emitted 长度不再增长
  const before = emitted.length;
  const quiet = await srv.dispatchToolCall({
    name: 'run_workflow', arguments: { workflow: 'chain', task: 't', workdir: TMP },
  });
  assert.equal(quiet.isError, false);
  assert.equal(emitted.length, before);
});

test('run_workflow：入口抛错转 isError；NESTED 档拒绝（零触达入口）', async () => {
  const impls = makeFakeWorkflows().impls;
  impls.chain = async () => { throw new Error('未知模型 "GLM-9"。恢复指引：改用 GLM-5.3。'); };
  const srv = server.createServer({ manager: makeFakeManager(), nested: false, workflows: impls });
  const failed = await srv.dispatchToolCall({
    name: 'run_workflow', arguments: { workflow: 'chain', task: 't', workdir: TMP },
  });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /工作流执行失败/);
  assert.match(failed.content[0].text, /恢复指引/); // 入口可操作错误原样透传

  const fw = makeFakeWorkflows();
  const nestedSrv = server.createServer({ manager: makeFakeManager(), nested: true, workflows: fw.impls });
  const rejected = await nestedSrv.dispatchToolCall({
    name: 'run_workflow', arguments: { workflow: 'chain', task: 't', workdir: TMP },
  });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /嵌套调用已拒绝/);
  assert.equal(fw.calls.length, 0); // 防递归第二重对两个 tool 一视同仁
});

// ---------------------------------------------------------- 进程级测试

/** spawn 真实 server 进程：发送 initialize + tools/list，收帧后关 stdin。 */
function runServerProc({ nested, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ZSUB_ROOT: path.join(TMP, nested ? 'root-nested' : 'root-normal'),
      ZCODE_MAILBOX_ROOT: path.join(TMP, 'mailbox-proc'),
      ZSUB_ZCODE_CLI: '/nonexistent', // 防御：即使误启 runner 也不碰真 CLI
    };
    if (nested) env.ZSUB_NESTED = '1';
    else delete env.ZSUB_NESTED;

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
  assert.deepEqual(tl.result.tools.map((t) => t.name), ['zsub', 'run_workflow']);
  assert.match(r.stderr, /record 恢复/); // 启动序列（sweep+recover）日志走 stderr
});

test('进程级：NESTED 档不注册工具，仍正常应答协议后退出', async () => {
  const r = await runServerProc({ nested: true });
  assert.equal(r.code, 0);
  const tl = r.frames.find((f) => f.id === 2);
  assert.deepEqual(tl.result.tools, []);
  assert.match(r.stderr, /ZSUB_NESTED/);
});
