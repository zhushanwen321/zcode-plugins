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

test('协议层：tools/list 正常档注册单 tool，NESTED 档空列表（防递归第二重）', async () => {
  const normal = server.createServer({ manager: makeFakeManager(), nested: false });
  const f1 = await normal.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(f1[0].result.tools.length, 1);
  assert.equal(f1[0].result.tools[0].name, 'zsub');

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

test('进程级：正常档 initialize→tools/list 出单 tool，stdin 关闭后干净退出（exit 0，stdout 无杂音）', async () => {
  const r = await runServerProc({ nested: false });
  assert.equal(r.code, 0);
  assert.equal(r.restStdout.trim(), ''); // stdout 只走协议帧（帧已全部解析，无半截残留）
  const init = r.frames.find((f) => f.id === 1);
  assert.equal(init.result.serverInfo.name, 'zsub');
  const tl = r.frames.find((f) => f.id === 2);
  assert.equal(tl.result.tools.length, 1);
  assert.equal(tl.result.tools[0].name, 'zsub');
  assert.match(r.stderr, /record 恢复/); // 启动序列（sweep+recover）日志走 stderr
});

test('进程级：NESTED 档不注册工具，仍正常应答协议后退出', async () => {
  const r = await runServerProc({ nested: true });
  assert.equal(r.code, 0);
  const tl = r.frames.find((f) => f.id === 2);
  assert.deepEqual(tl.result.tools, []);
  assert.match(r.stderr, /ZSUB_NESTED/);
});
