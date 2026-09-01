'use strict';

/**
 * MCP server 测试（W2-S4 决策位③入口；N2-b 起 zflow 九 action 面——
 * orchestration-host + bin/zsw.js 共享创作实现）。
 *
 * 隔离原则：协议层与纯函数用 fake manager / fake wfHost 全覆盖；真实编排
 * 接线用例（校验权威 + 后台冒烟 + abort）注入 fake 内置入口
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

/** MCP 面入口（tools/call 全链）：1.0.0 起恒拒绝，用于下线终态断言。 */
function callTool(srv, args, extraParams = {}) {
  return srv.handleMessage({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'zsub', arguments: args, ...extraParams },
  });
}

/**
 * handler 直调入口（1.0.0 起业务分发用例的测试入口）：MCP 面 tools/call 恒
 * 拒绝（D1 终态），handler 表是 socket 分发的数据源（buildDaemonHandlers
 * 包装后由 daemon-socket 分发）——直调 handler = socket 面真实路径。
 * 签名对齐 handler(params, env)：params = {arguments}，env = {cwd?, signal?}
 * （socket 面透传形态）。返回 MCP content 包装（okContent/errContent），
 * 与旧 dispatchToolCall 层一致。
 */
function callHandler(srv, name, args, env) {
  return srv.toolHandlers[name]({ name, arguments: args }, env);
}

test('协议层：initialize 回 serverInfo 与 protocolVersion', async () => {
  const srv = server.createServer({ manager: makeFakeManager(), nested: false });
  const frames = await srv.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' },
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, 1);
  assert.equal(frames[0].result.serverInfo.name, 'zsw'); // server 标识 = 插件缩写（CONTEXT.md）；tool 名 zsub/zflow 是另一层
  // S5：版本与 package.json 同源（防 SERVER_INFO 手抄漂移——修复前 0.1.0 已漂移）
  assert.equal(frames[0].result.serverInfo.version, require('../package.json').version);
  assert.equal(frames[0].result.protocolVersion, '2025-03-26');
  assert.deepEqual(frames[0].result.capabilities, { tools: {} });
});

test('协议层：tools/list 恒空（1.0.0 终态 D1）：正常档与 NESTED 档同形（零上下文注入）', async () => {
  const normal = server.createServer({ manager: makeFakeManager(), nested: false });
  const f1 = await normal.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(f1[0].result.tools, []);

  const nested = server.createServer({ manager: makeFakeManager(), nested: true });
  const f2 = await nested.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.deepEqual(f2[0].result.tools, []);
});

test('协议层：unknown method / unknown tool / ping / 通知帧', async () => {
  const srv = server.createServer({ manager: makeFakeManager(), nested: false });
  const bad = await srv.handleMessage({ jsonrpc: '2.0', id: 1, method: 'no/such/method' });
  assert.equal(bad[0].error.code, -32601);
  assert.match(bad[0].error.message, /no\/such\/method/);

  // 1.0.0 终态（D1）：unknown tool 不再 -32601——tools/call 恒拒绝，文案指向 CLI
  const badTool = await srv.handleMessage({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'other_tool', arguments: {} },
  });
  assert.equal(badTool[0].error, undefined);
  assert.equal(badTool[0].result.isError, true);
  assert.match(badTool[0].result.content[0].text, /工具面已下线/);

  const pong = await srv.handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(pong[0].result, {});

  const notif = await srv.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual(notif, []); // 通知帧不应答
  const notJsonrpc = await srv.handleMessage({ id: 4, method: 'ping' });
  assert.deepEqual(notJsonrpc, []);
});

test('handler 直调 start：cwd 取 ZCODE_PROJECT_DIR，ctx 不带会话定向（socket 面无 _meta 通道）', async () => {
  process.env.ZCODE_PROJECT_DIR = '/proj/demo';
  try {
    const fake = makeFakeManager();
    const srv = server.createServer({ manager: fake, nested: false });
    const result = await callHandler(srv, 'zsub', { action: 'start', task: '任务书', slug: 's1' });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.subagentId, 'sa-x');
    assert.equal('targetSessionId' in fake.calls[0].ctx, false); // ctx 无会话定向，mailbox 自然降级
    assert.equal(fake.calls[0].ctx.cwd, '/proj/demo');
    assert.equal(fake.calls[0].params.slug, 's1');
  } finally {
    delete process.env.ZCODE_PROJECT_DIR;
  }
});

test('handler 直调：无 _meta 上下文不报错（mailbox 自然降级）', async () => {
  const fake = makeFakeManager();
  const srv = server.createServer({ manager: fake, nested: false });
  const result = await callHandler(srv, 'zsub', { action: 'list' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(fake.calls[0], { action: 'list' });
  const noMeta = await callHandler(srv, 'zsub', { action: 'status', subagentId: 'sa-1' });
  assert.equal(JSON.parse(noMeta.content[0].text).subagentId, 'sa-1');
});

test('handler 直调：bad action / 缺 subagentId / manager 异常 → isError 可操作文案', async () => {
  const srv = server.createServer({ manager: makeFakeManager(), nested: false });

  const badAction = await callHandler(srv, 'zsub', { action: 'explode' });
  assert.equal(badAction.isError, true);
  assert.match(badAction.content[0].text, /不支持的 action/);
  assert.match(badAction.content[0].text, /恢复指引/);

  const noId = await callHandler(srv, 'zsub', { action: 'status' });
  assert.equal(noId.isError, true);
  assert.match(noId.content[0].text, /subagentId/);

  const boom = makeFakeManager();
  boom.status = () => { throw new Error('未知模型 "GLM-9"。恢复指引：改用 GLM-5.3。'); };
  const srv2 = server.createServer({ manager: boom, nested: false });
  const err = await callHandler(srv2, 'zsub', { action: 'status', subagentId: 'sa-1' });
  assert.equal(err.isError, true);
  assert.match(err.content[0].text, /恢复指引/); // manager 错误原样透传
});

test('tools/call 恒拒绝（1.0.0 终态 D1）：正常档与 NESTED 档同文案，不触达 manager', async () => {
  for (const nested of [false, true]) {
    const fake = makeFakeManager();
    const srv = server.createServer({ manager: fake, nested });
    const frames = await callTool(srv, { action: 'start', task: 'x', slug: 'y' });
    assert.equal(frames[0].result.isError, true, `nested=${nested} 应恒拒绝`);
    assert.match(frames[0].result.content[0].text, /工具面已下线/);
    assert.match(frames[0].result.content[0].text, /bin\/zsw\.js/);
    assert.equal(fake.calls.length, 0); // 拒绝在 handler 分发之前，manager 零触达
  }
});

test('handler 直调：message 缺 text → isError', async () => {
  const fake = makeFakeManager();
  const srv = server.createServer({ manager: fake, nested: false });
  const result = await callHandler(srv, 'zsub', { action: 'message', subagentId: 'sa-1' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /text/);
  assert.equal(fake.calls.length, 0);
});

// --------------------------------------------- agents action（按需查询索引）

test('tools/call agents：core 发现面（lib/agent-discovery），vendored 内置 + 四根，source 由槽位标签映射', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-srv-ag-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  const home = path.join(tmp, 'home');
  const mkAgent = (dir, name, desc, when) => {
    fs.mkdirSync(dir, { recursive: true });
    const whenLine = when ? `when: ${when}\n` : '';
    fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${desc}\n${whenLine}---\n\nbody\n`);
  };
  mkAgent(path.join(ws, '.agents', 'agents'), 'proj-pi', '项目 .agents 根', '代码审查与修复验证');
  mkAgent(path.join(ws, '.zcode', 'agents'), 'proj-zc', '项目 .zcode 根');
  mkAgent(path.join(home, '.agents', 'agents'), 'user-pi', '用户 .agents 根');
  mkAgent(path.join(home, '.zcode', 'agents'), 'user-zc', '用户 .zcode 根');

  // core 硬编码 user-agents 槽在调用期读进程 HOME——测试窗口内指到 fixture home
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = prevHome; });

  const agentDiscovery = require('../lib/agent-discovery');
  const manager = { ...makeFakeManager(), resolver: agentDiscovery.createAgentDiscovery({ homeDir: home }) };
  const handlers = server.buildToolHandlers({ manager, nested: false });
  const result = await handlers.zsub(
    { name: 'zsub', arguments: { action: 'agents' } },
    { cwd: ws },
  );
  assert.equal(result.isError, undefined);
  const rows = JSON.parse(result.content[0].text);
  // 四根标签一一对应（source 不再按路径推断——core 发现面自带槽位标签）
  const byName = new Map(rows.map((r) => [r.name, r]));
  assert.deepEqual(
    ['proj-pi', 'proj-zc', 'user-pi', 'user-zc'].map((n) => [n, byName.get(n).source]),
    [
      ['proj-pi', 'project-agents'],
      ['proj-zc', 'project-zcode'],
      ['user-pi', 'user-agents'],
      ['user-zc', 'user-zcode'],
    ],
  );
  // vendored 内置 10 全部在场（npm 槽 → core-vendored 标签）
  const vendored = rows.filter((r) => r.source === 'core-vendored');
  assert.equal(vendored.length, 10, 'vendored 内置 10 角色');
  assert.ok(vendored.every((r) => r.file.includes(path.join('vendor', 'subagent-core', 'agents'))));
  // 精简视图：只有索引六字段（body/model 等 profile 字段不透出）；W6b 起
  // 带 location（D-4a：start 的 agent 参数只收路径，location 是其来源列；
  // file 为同值兼容字段）
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['description', 'file', 'location', 'name', 'source', 'when']);
    assert.equal(r.location, r.file, 'location 与 file 同值（.md 绝对路径）');
    assert.ok(r.file.endsWith('.md'));
  }
  // when（何时用我）透传：有则原样、无则空串
  assert.equal(byName.get('proj-pi').when, '代码审查与修复验证');
  assert.equal(byName.get('proj-zc').when, '');
});

test('tools/call agents：cwd 透传 resolver.list；description/when 截 200；resolver 缺失可操作错误', async () => {
  const seenCwd = [];
  const fakeResolver = {
    list(cwd) {
      seenCwd.push(cwd);
      return [
        {
          name: 'long',
          description: '长'.repeat(350),
          when: '何'.repeat(250),
          source: 'user-pi',
          filePath: '/fake/home/.zcode/agents/long.md',
        },
        { name: 'nodesc', source: 'project-agents', filePath: '/proj/ag/.agents/agents/nodesc.md' },
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
  assert.equal(rows[0].when, '何'.repeat(200)); // when 同样截 200
  assert.equal(rows[0].source, 'user-zcode', 'core 槽位标签 user-pi → 面上标签 user-zcode');
  assert.equal(rows[1].description, ''); // description 缺省容忍为空串
  assert.equal(rows[1].when, ''); // when 缺省容忍为空串
  assert.equal(rows[1].source, 'project-agents');

  // resolver 缺失（异常组装防御）：可操作错误而非 TypeError 被 catch 吞
  const broken = server.buildToolHandlers({ manager: makeFakeManager(), nested: false });
  const err = await broken.zsub({ name: 'zsub', arguments: { action: 'agents' } });
  assert.equal(err.isError, true);
  assert.match(err.content[0].text, /resolver/);
  assert.match(err.content[0].text, /恢复指引/);
});

// ------------------------------------------- models action（模型清单按需查询）

test('tools/call models：真实 ModelRouter + 临时 v2 config，返回清单 + 默认标记 + 选择指引', async (t) => {
  // fake v2 config（execution.test.js 同款手法）：本文件 HOME 已指临时目录，
  // config.V2_CONFIG_PATH 在模块加载期冻结为该 HOME 下的路径，直接落这里
  const v2Path = require('../lib/config').V2_CONFIG_PATH;
  fs.mkdirSync(path.dirname(v2Path), { recursive: true });
  fs.writeFileSync(v2Path, JSON.stringify({
    model: { main: 'builtin:bigmodel-coding-plan/GLM-5.3' },
    provider: {
      'builtin:bigmodel-coding-plan': {
        options: { apiKey: 'test-key' },
        models: {
          'GLM-5.3': {
            limit: { context: 1000000 },
            reasoning: { variants: ['low', 'high', 'max'], defaultVariant: 'max' },
          },
          'GLM-4.7-Flash': {},
        },
      },
    },
  }));
  t.after(() => { fs.rmSync(v2Path, { force: true }); });

  const ModelRouter = require('../lib/model-router');
  const manager = { ...makeFakeManager(), modelRouter: new ModelRouter() };
  const handlers = server.buildToolHandlers({ manager, nested: false });
  const result = await handlers.zsub({ name: 'zsub', arguments: { action: 'models' } });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.provider, 'builtin:bigmodel-coding-plan');
  // 结构化条目：短名 + 可选维度（无 label 不造默认值）+ 默认标记
  assert.deepEqual(payload.models, [
    {
      name: 'GLM-5.3',
      contextWindow: 1000000,
      reasoning: { variants: ['low', 'high', 'max'], defaultVariant: 'max' },
      default: true,
    },
    { name: 'GLM-4.7-Flash' },
  ]);
  assert.match(payload.guidance, /轻量/); // 档位原则压缩成一行指引
});

test('tools/call models：清单不可读可操作错误；modelRouter 缺失可操作错误', async () => {
  const v2Path = require('../lib/config').V2_CONFIG_PATH;
  fs.mkdirSync(path.dirname(v2Path), { recursive: true });
  fs.writeFileSync(v2Path, JSON.stringify({ provider: {} })); // 无 models：清单不可读
  const ModelRouter = require('../lib/model-router');
  const manager = { ...makeFakeManager(), modelRouter: new ModelRouter() };
  const handlers = server.buildToolHandlers({ manager, nested: false });
  const err = await handlers.zsub({ name: 'zsub', arguments: { action: 'models' } });
  assert.equal(err.isError, true);
  assert.match(err.content[0].text, /模型清单/);
  assert.match(err.content[0].text, /恢复指引/);
  fs.rmSync(v2Path, { force: true });

  // modelRouter 未注入（异常组装防御）：可操作错误而非 TypeError 炸穿
  const broken = server.buildToolHandlers({ manager: makeFakeManager(), nested: false });
  const noPort = await broken.zsub({ name: 'zsub', arguments: { action: 'models' } });
  assert.equal(noPort.isError, true);
  assert.match(noPort.content[0].text, /modelRouter/);
  assert.match(noPort.content[0].text, /恢复指引/);
});

test('tools/call models --all：全 provider 视图（凭据+非空清单筛、全名、default 按 provider 感知）', async (t) => {
  // fixture 四种 provider 形态：合格（默认 provider + prov-a）、无凭据（筛掉）、
  // 清单空（筛掉）——口径与注入块「其他可运行 provider」段一致
  const v2Path = require('../lib/config').V2_CONFIG_PATH;
  fs.mkdirSync(path.dirname(v2Path), { recursive: true });
  fs.writeFileSync(v2Path, JSON.stringify({
    model: { main: 'builtin:bigmodel-coding-plan/GLM-5.3' },
    provider: {
      'builtin:bigmodel-coding-plan': {
        options: { apiKey: 'k-def' },
        models: {
          'GLM-5.3': { limit: { context: 1000000 } },
          'GLM-4.7-Flash': {},
        },
      },
      'prov-a': { options: { apiKey: 'k-a' }, models: { m1: {} } },
      'prov-nokey': { models: { n1: {} } }, // 无凭据：不列
      'prov-empty': { options: { apiKey: 'k-e' }, models: {} }, // 清单空：不列
    },
  }));
  t.after(() => { fs.rmSync(v2Path, { force: true }); });

  const ModelRouter = require('../lib/model-router');
  const manager = { ...makeFakeManager(), modelRouter: new ModelRouter() };
  const handlers = server.buildToolHandlers({ manager, nested: false });
  const result = await handlers.zsub({ name: 'zsub', arguments: { action: 'models', all: true } });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.all, true);
  // 无凭据 / 清单空两组被筛掉，只剩合格两 provider（fixture 字面序）
  assert.deepEqual(payload.providers.map((p) => p.provider), [
    'builtin:bigmodel-coding-plan',
    'prov-a',
  ]);
  // 条目 = listModels 结构化逻辑升格全名（contextWindow 透出、default 按
  // provider 感知：main 指默认 provider → 仅其 GLM-5.3 标记）
  assert.deepEqual(payload.providers[0].models, [
    { name: 'builtin:bigmodel-coding-plan/GLM-5.3', contextWindow: 1000000, default: true },
    { name: 'builtin:bigmodel-coding-plan/GLM-4.7-Flash' },
  ]);
  assert.deepEqual(payload.providers[1].models, [{ name: 'prov-a/m1' }]);
  assert.match(payload.guidance, /全名/);

  // 合格 provider 零个（config 可读但无条目）→ 空 providers 成功响应（合法状态）
  fs.writeFileSync(v2Path, JSON.stringify({ provider: {} }));
  const empty = await handlers.zsub({ name: 'zsub', arguments: { action: 'models', all: true } });
  assert.equal(empty.isError, undefined);
  assert.deepEqual(JSON.parse(empty.content[0].text).providers, []);

  // v2 config 不可读 → 可操作错误（与默认视图失败口径一致，不静默回空）
  fs.rmSync(v2Path, { force: true });
  const err = await handlers.zsub({ name: 'zsub', arguments: { action: 'models', all: true } });
  assert.equal(err.isError, true);
  assert.match(err.content[0].text, /模型清单/);
  assert.match(err.content[0].text, /恢复指引/);
});

test('tools/call models --all：modelRouter 缺 allProviders 实现 → 可操作错误而非 TypeError（端口守卫与 listModels 同口径）', async () => {
  // 换实现防御：端口实现缺 allProviders 方法时，--all 给含恢复指引的可操作错误
  //（契约声明见 lib/ports.js ModelRouterPort），缺省视图（listModels）不受影响
  const manager = { ...makeFakeManager(), modelRouter: { listModels: () => [{ name: 'stub-model' }] } };
  const handlers = server.buildToolHandlers({ manager, nested: false });
  const noAll = await handlers.zsub({ name: 'zsub', arguments: { action: 'models', all: true } });
  assert.equal(noAll.isError, true);
  assert.match(noAll.content[0].text, /allProviders/);
  assert.match(noAll.content[0].text, /恢复指引/);
  const defaults = await handlers.zsub({ name: 'zsub', arguments: { action: 'models' } });
  assert.equal(defaults.isError, undefined);
  assert.deepEqual(JSON.parse(defaults.content[0].text).models, [{ name: 'stub-model' }]);
});

// ------------------------------------------- 多 tool 注册表形态（结构化改造）

test('dispatchToolCall：恒拒绝（1.0.0 终态 D1）——任何 tool 名同文案，不再 -32601', async () => {
  const wfm = makeFakeWfHost();
  const srv = server.createServer({
    manager: makeFakeManager(),
    wfHost: wfm,
    nested: false,
  });
  // 已注册名 / 原型链属性名 / 未收录名 / 参数缺失：一律 errContent（文案指向
  // CLI），不再有 -32601 协议级 reject——工具面下线对所有名字一视同仁
  for (const params of [
    { name: 'zsub', arguments: { action: 'list' } },
    { name: 'zflow', arguments: { action: 'status' } },
    { name: 'constructor', arguments: {} },
    { name: 'no_such_tool', arguments: {} },
    undefined,
  ]) {
    const res = await srv.dispatchToolCall(params);
    const label = JSON.stringify(params && params.name);
    assert.equal(res.isError, true, `${label} 应恒拒绝`);
    assert.match(res.content[0].text, /工具面已下线/);
    assert.match(res.content[0].text, /bin\/zsw\.js/);
  }
  assert.equal(wfm.calls.length, 0); // 拒绝在 handler 分发之前，运行时零触达
});

test('注册表隔离：zsub handler 可脱离 dispatch 单独调用（buildToolHandlers 工厂）', async () => {
  const fake = makeFakeManager();
  const handlers = server.buildToolHandlers({ manager: fake, nested: false });
  assert.deepEqual(Object.keys(handlers), ['zsub', 'zflow']); // 双 tool 注册表
  const result = await handlers.zsub(
    {
      name: 'zsub',
      arguments: { action: 'start', task: '任务书', slug: 'iso' },
    },
    { cwd: '/proj/iso' }, // env 显式注入：证明 ctx 组装封装在 handler 内，不依赖 dispatch
  );
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).subagentId, 'sa-x');
  assert.equal(fake.calls[0].ctx.cwd, '/proj/iso');

  // 嵌套门禁也在 handler 内：直接调用同样拒绝且不触达 manager
  const nestedHandlers = server.buildToolHandlers({ manager: fake, nested: true });
  const rejected = await nestedHandlers.zsub({ name: 'zsub', arguments: { action: 'list' } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /嵌套调用已拒绝/);
  assert.equal(fake.calls.length, 1); // 仅上面的 start，嵌套档零触达
});

// ---------------------------------------- zflow 九 action 面（orchestration-host + bin/zsw.js 共享创作实现）

/** fake orchestration host：记录调用、返回可断言形态（协议层与分发面测试用）。 */
function makeFakeWfHost() {
  const calls = [];
  return {
    calls,
    async run(params, ctx) {
      calls.push({ action: 'run', params, ctx });
      return { runId: 'wf-fake1', workflow: params.workflow, status: 'running', stateFile: '/tmp/state/wf-fake1.jsonl', warnings: [] };
    },
    async runAndWait(params, ctx, opts) {
      calls.push({ action: 'runAndWait', params, ctx, opts });
      return { status: 'done', reason: 'completed', scriptResult: { ok: 1 }, runId: 'wf-fake1', warnings: [] };
    },
    async abort(runId) { calls.push({ action: 'abort', runId }); return { runId, aborted: true }; },
    status(runId) {
      calls.push({ action: 'status', runId });
      return { runId, status: 'done', reason: 'completed', stateFile: path.join(TMP, 'state', `${runId}.jsonl`), steps: [] };
    },
    list() { calls.push({ action: 'list' }); return [{ runId: 'wf-fake1', workflow: 'chain', status: 'done', reason: 'completed' }]; },
    async scripts(cwd) {
      calls.push({ action: 'scripts', cwd });
      return {
        builtin: [
          { name: 'chain', description: 'd', path: '/v/chain.js', source: 'core-vendored' },
        ],
        scripts: [{ name: 'my-wf', path: path.join(TMP, 'my-wf.js'), available: true, source: 'workspace-zsw' }],
      };
    },
    async lint(file) { calls.push({ action: 'lint', file }); return { valid: true, findings: [] }; },
    async recoverOrphans() { calls.push({ action: 'recoverOrphans' }); return { recovered: 0, orphaned: 0 }; },
    async shutdown() { calls.push({ action: 'shutdown' }); },
  };
}

function makeWfServer(wfHost = makeFakeWfHost()) {
  return { wfm: wfHost, srv: server.createServer({ manager: makeFakeManager(), wfHost, nested: false }) };
}

test('zflow run：action 剥离后透传 host.run，env.cwd 组装 ctx，立即返回句柄', async () => {
  const { wfm, srv } = makeWfServer();
  process.env.ZCODE_PROJECT_DIR = '/proj/wf';
  try {
    const result = await callHandler(srv, 'zflow', {
      action: 'run', workflow: 'chain', task: '接线冒烟', workdir: TMP,
      model: 'GLM-4.7-Flash', timeoutMs: 12345, wait: false,
    });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.runId, 'wf-fake1');
    assert.equal(payload.status, 'running');
    assert.equal(wfm.calls.length, 1);
    // action 不得泄入 run 参数（泄漏会污染 $ARGS 组装）
    assert.equal(wfm.calls[0].params.action, undefined);
    assert.equal(wfm.calls[0].params.workflow, 'chain');
    assert.equal(wfm.calls[0].ctx.cwd, '/proj/wf');
  } finally {
    delete process.env.ZCODE_PROJECT_DIR;
  }
});

test('zflow run wait=true：走 host.runAndWait（同步等终态面）', async () => {
  const { wfm, srv } = makeWfServer();
  const result = await callHandler(srv, 'zflow', {
    action: 'run', workflow: 'chain', task: 't', workdir: TMP, wait: true,
  });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.reason, 'completed');
  assert.deepEqual(payload.scriptResult, { ok: 1 });
  assert.equal(wfm.calls[0].action, 'runAndWait');
});

test('zflow：abort/status/list 分发与 runId 必填校验', async () => {
  const { wfm, srv } = makeWfServer();
  const call = (args) => callHandler(srv, 'zflow', args);

  const noId = await call({ action: 'status' });
  assert.equal(noId.isError, true);
  assert.match(noId.content[0].text, /runId/);

  const st = await call({ action: 'status', runId: 'wf-1' });
  assert.equal(JSON.parse(st.content[0].text).stateFile.includes('wf-1'), true);
  assert.deepEqual(wfm.calls.at(-1), { action: 'status', runId: 'wf-1' });

  const ab = await call({ action: 'abort', runId: 'wf-1' });
  assert.equal(JSON.parse(ab.content[0].text).aborted, true);

  const ls = await call({ action: 'list' });
  assert.equal(JSON.parse(ls.content[0].text).length, 1);
  assert.deepEqual(wfm.calls.at(-1), { action: 'list' });
});

test('zflow scripts：内置 vendored + 用户脚本合并输出，cwd 透传发现层', async () => {
  const { wfm, srv } = makeWfServer();
  const result = await callHandler(srv, 'zflow', { action: 'scripts' }, { cwd: '/proj/scripts-cwd' });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(payload.builtin.map((b) => b.name), ['chain']);
  assert.deepEqual(payload.scripts.map((s) => s.name), ['my-wf']);
  assert.deepEqual(wfm.calls[0], { action: 'scripts', cwd: '/proj/scripts-cwd' });
});

test('zflow lint：file 必填 + host.lint 透传', async () => {
  const { wfm, srv } = makeWfServer();
  const call = (args) => callHandler(srv, 'zflow', args);

  const noFile = await call({ action: 'lint' });
  assert.equal(noFile.isError, true);
  assert.match(noFile.content[0].text, /file/);

  const ok = JSON.parse((await call({ action: 'lint', file: '/tmp/good.js' })).content[0].text);
  assert.deepEqual(ok, { valid: true, findings: [] });
  assert.deepEqual(wfm.calls.at(-1), { action: 'lint', file: '/tmp/good.js' });
});

// ------------------ zflow 创作闭环三 action（W8 / D-6：bin/zsw.js 共享实现接线）

test('zflow script-generate/save/delete：handler 分发 + core 管线真跑 + delete 运行中拒绝（HOME 已隔离至 TMP）', async () => {
  const wfm = makeFakeWfHost();
  const srv = server.createServer({ manager: makeFakeManager(), wfHost: wfm, nested: false });
  const call = (args) => callHandler(srv, 'zflow', args);

  // name 必填（共享实现的入口守卫，经 handler catch 转 isError 可操作文案）
  const noName = await call({ action: 'script-save' });
  assert.equal(noName.isError, true);
  assert.match(noName.content[0].text, /需要 name/);
  // 非法名（路径形态）：core 拼 `${name}.js` 会写到落盘目录之外，入口拦下
  const evil = await call({ action: 'script-generate', name: '../evil', script: 'x' });
  assert.equal(evil.isError, true);
  assert.match(evil.content[0].text, /非法脚本名/);

  // ESM 拒（五道闸第一闸，文案与 pi 侧 core 管线逐字同源）
  const esm = await call({
    action: 'script-generate', name: 'w8-srv',
    script: 'import x from "y";\nconst r = await agent({ prompt: "p" });\nreturn r;\n',
  });
  assert.equal(esm.isError, true);
  assert.match(esm.content[0].text, /ESM 'import' syntax/);

  // 合法源 → tmp 落盘（zsw 布局 <HOME>/.zsw/workflows/.tmp）
  const valid = '/* @pi-meta\nname: w8-srv\ndescription: d\nphases: [run]\n*/\nconst r = await agent({ prompt: "p" });\nreturn r;\n';
  const gen = JSON.parse((await call({ action: 'script-generate', name: 'w8-srv', script: valid })).content[0].text);
  const tmpPath = path.join(process.env.HOME, '.zsw', 'workflows', '.tmp', 'w8-srv.js');
  assert.equal(gen.path, tmpPath);
  assert.ok(fs.existsSync(tmpPath));

  // save → 固化 + tmp 消失（rename 语义）
  const saved = JSON.parse((await call({ action: 'script-save', name: 'w8-srv' })).content[0].text);
  const savedPath = path.join(process.env.HOME, '.zsw', 'workflows', 'w8-srv.js');
  assert.equal(saved.savedPath, savedPath);
  assert.ok(fs.existsSync(savedPath));
  assert.equal(fs.existsSync(tmpPath), false);

  // delete 运行中拒绝：fake host 的 _runs 报 running w8-srv（runningScriptPredicate
  // 改调 core isScriptRunning——吃原始 runs Map 的 spec/state 字段，非 list 投影）
  const fakeRunning = {
    _runs: new Map([['wf-r1', { spec: { scriptName: 'w8-srv' }, state: { status: 'running' } }]]),
  };
  const srvRunning = server.createServer({ manager: makeFakeManager(), wfHost: fakeRunning, nested: false });
  const refused = await callHandler(srvRunning, 'zflow', { action: 'script-delete', name: 'w8-srv' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /currently running/);
  assert.ok(fs.existsSync(savedPath), '拒绝删除时文件必须原位');

  // delete（非运行）→ 删除成功
  const del = JSON.parse((await call({ action: 'script-delete', name: 'w8-srv' })).content[0].text);
  assert.match(del.message, /Deleted workflow 'w8-srv'/);
  assert.equal(fs.existsSync(savedPath), false);
});

test('zflow：bad action / host 可操作错误透传 / NESTED 拒绝 / wfHost 缺失 throw 透出', async () => {
  const { wfm, srv } = makeWfServer();
  const call = (args) => callHandler(srv, 'zflow', args);

  const bad = await call({ action: 'explode' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /不支持的 action/);
  assert.match(bad.content[0].text, /run \| abort \| status \| list \| scripts \| lint \| script-generate \| script-save \| script-delete/);

  // host 抛的都是含恢复指引的可操作错误，原样透传（D-4 后用路径 ref 触达 host 层）
  const wfm2 = makeFakeWfHost();
  wfm2.run = async () => {
    throw new Error('workflow 脚本不可用（meta 解析失败或文件不可读）: /tmp/fancy.js。恢复指引：core 契约脚本需带 /* @pi-meta name/description */ 块。');
  };
  const srv2 = server.createServer({ manager: makeFakeManager(), wfHost: wfm2, nested: false });
  const err = await callHandler(srv2, 'zflow', { action: 'run', workflow: '/tmp/fancy.js', task: 't', workdir: TMP });
  assert.equal(err.isError, true);
  assert.match(err.content[0].text, /不可用/);
  assert.match(err.content[0].text, /恢复指引/);

  // NESTED 档：拒绝且零触达（防递归第二重在 handler 内，对两个 tool 一视同仁）
  const wfmNested = makeFakeWfHost();
  const nestedSrv = server.createServer({ manager: makeFakeManager(), wfHost: wfmNested, nested: true });
  const rejected = await callHandler(nestedSrv, 'zflow', { action: 'list' });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /嵌套调用已拒绝/);
  assert.equal(wfmNested.calls.length, 0);

  // wfHost 缺失（异常组装防御）：handler throw 直接透出（daemon-socket 统一映射
  // ok:false 帧），而非被吞成 TypeError 假阳性
  const broken = server.createServer({ manager: makeFakeManager(), nested: false });
  await assert.rejects(
    callHandler(broken, 'zflow', { action: 'list' }),
    (e) => /workflow 运行时/.test(e.message),
  );
  assert.equal(wfm.calls.length, 0); // 上面的 fake 未被触碰
});

// ------------------ 真实 orchestration-host 接线（校验权威 + fake runner 冒烟）

/** 真实 host + fake core AgentRunner（组装形态同 orchestration-host.test.js）。 */
function buildRealWfHost(agentRunner) {
  const { createOrchestrationHost } = require('../lib/orchestration-host');
  return createOrchestrationHost({ agentRunner });
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

test('zflow run：校验权威在 orchestration-host + 入口契约（D-4/D-E3：script:/未知裸名拒收；缺 task / reviewers 废弃 → isError 可操作）', async () => {
  const wfm = buildRealWfHost({ async run() { return { content: '', parsedOutput: { ok: 1 } }; } });
  const srv = server.createServer({ manager: makeFakeManager(), wfHost: wfm, nested: false });
  const call = (args) => callHandler(srv, 'zflow', { action: 'run', ...args });

  const noTask = await call({ workflow: 'chain', workdir: TMP });
  assert.equal(noTask.isError, true);
  assert.match(noTask.content[0].text, /task/);

  // D-4 契约在入口面（socket 面与 CLI 共用 bin/zsw.js 的 validateWorkflowRef）
  const bare = await call({ workflow: 'fancy', task: 't', workdir: TMP });
  assert.equal(bare.isError, true);
  assert.match(bare.content[0].text, /Invalid workflow ref/);
  assert.match(bare.content[0].text, /绝对路径/);
  const prefixed = await call({ workflow: 'script:fancy', task: 't', workdir: TMP });
  assert.equal(prefixed.isError, true);
  assert.match(prefixed.content[0].text, /script: 前缀/);

  // reviewers 废弃（core 契约批次值 = agent .md 路径）：显式报错不静默
  const rev = await call({ workflow: 'review-fix-loop', task: 't', workdir: TMP, reviewers: ['correctness'] });
  assert.equal(rev.isError, true);
  assert.match(rev.content[0].text, /不再支持 --reviewers/);
});

test('zflow run（D-E3 socket 面）：saved 裸名按名 run 成功（knownNames 全量传入）；未知裸名仍拒收', async () => {
  // HOME saved 根 fixture（~/.zsw/workflows = script-save 落盘目录；文件头
  // env.HOME 已隔离）：socket 面 handler 经 buildKnownWorkflowNames(core,
  // ctx.cwd) 传全量 knownNames，saved 名命中放行。零引擎形态（agent() 挂
  // $ARGS.callAgent 条件不触发，fake runner 全程零调用）。
  const savedDir = path.join(process.env.HOME, '.zsw', 'workflows');
  fs.mkdirSync(savedDir, { recursive: true });
  fs.writeFileSync(path.join(savedDir, 'srv-saved-probe.js'),
    '/* @pi-meta\nname: srv-saved-probe\ndescription: socket saved probe\nphases: [run]\n*/\n'
    + 'if ($ARGS.callAgent === true) {\n  await agent({ prompt: "x" });\n}\n'
    + 'return { status: "ok", params: $ARGS };\n');

  const wfm = buildRealWfHost({ async run() { return { content: '', parsedOutput: { ok: true } }; } });
  const srv = server.createServer({ manager: makeFakeManager(), wfHost: wfm, nested: false });
  const call = (args, env) => callHandler(srv, 'zflow', { action: 'run', ...args }, env);

  // cwd 口径 = handler ctx.cwd（此处显式给空目录：knownNames = 内置 5 + HOME saved 根，
  // 与 CLI 入口 buildWorkflowRunParams 的 cwd 同源，⛔D 断言在 orchestration-host.test.js）
  const fin = await call({ workflow: 'srv-saved-probe', task: '探针', workdir: TMP, wait: true }, { cwd: TMP });
  assert.equal(fin.isError, undefined, `content: ${fin.content[0].text}`);
  const h = JSON.parse(fin.content[0].text);
  assert.equal(h.reason, 'completed');
  assert.equal(h.scriptResult.params.task, '探针');

  // 反向：未知裸名（knownNames 不含）仍拒收，isError 可操作文案
  const unknown = await call({ workflow: 'no-such-wf-name', task: 't', workdir: TMP }, { cwd: TMP });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Invalid workflow ref/);
  assert.match(unknown.content[0].text, /不是内置名或已保存脚本名/);
});

test('zflow 后台冒烟（真实 orchestration-host + fake runner）：run 立即返句柄 → status 轮询至 done → scriptResult 可查 → list 可见', async () => {
  // 为什么在单测层而非 e2e：e2e 文件 before() 做真实模型配额窗口探测（窗口
  // 不开则整个文件失败），fake 冒烟放 e2e 会被真机前置条件绑架；worker 执行体
  // 在 server 进程内，本测试与 e2e 结构同构（createServer + dispatchToolCall）
  const calls = [];
  const wfm = buildRealWfHost({
    async run(opts) { calls.push(opts); return { content: '', parsedOutput: { insights: 'i', keyPoints: [] } }; },
  });
  const srv = server.createServer({ manager: makeFakeManager(), wfHost: wfm, nested: false });

  const result = await callHandler(srv, 'zflow', {
    action: 'run', workflow: 'chain', task: '后台冒烟', workdir: TMP,
  });
  assert.equal(result.isError, undefined);
  const h = JSON.parse(result.content[0].text);
  assert.match(h.runId, /^wf-/);
  assert.equal(h.status, 'running');

  // 轮询走 handler status action（socket 面同款分发链，非直连 host）
  const fin = await waitForAsync(async () => {
    const r = await callHandler(srv, 'zflow', { action: 'status', runId: h.runId });
    const rec = JSON.parse(r.content[0].text);
    return rec.status === 'done' ? rec : null;
  });
  assert.equal(fin.reason, 'completed', `终态: ${fin.error || ''}`);
  // chain 三段 agent() 全经 fake runner
  assert.equal(calls.length, 3);
  assert.equal(typeof fin.scriptResult, 'object');
  assert.match(fin.stateFile, /workflow-state/);

  const listed = JSON.parse((await callHandler(srv, 'zflow', { action: 'list' })).content[0].text);
  assert.ok(listed.some((r) => r.runId === h.runId && r.status === 'done'));
});

test('zflow abort（真实 orchestration-host）：hanging runner → abort 落 aborted 终态', async () => {
  const wfm = buildRealWfHost({
    run(opts, signal) {
      return new Promise((_, reject) => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        signal.addEventListener('abort', () => reject(err), { once: true });
      });
    },
  });
  const srv = server.createServer({ manager: makeFakeManager(), wfHost: wfm, nested: false });

  const h = JSON.parse((await callHandler(srv, 'zflow', {
    action: 'run', workflow: 'chain', task: '中止冒烟', workdir: TMP,
  })).content[0].text);
  assert.equal(h.status, 'running');

  const ab = JSON.parse((await callHandler(srv, 'zflow', {
    action: 'abort', runId: h.runId,
  })).content[0].text);
  assert.equal(ab.aborted, true);

  const fin = JSON.parse((await callHandler(srv, 'zflow', {
    action: 'status', runId: h.runId,
  })).content[0].text);
  assert.equal(fin.status, 'done');
  assert.equal(fin.reason, 'aborted');
});

// ---------------------------------------------------------- 进程级测试

/** spawn 真实 server 进程：发送 initialize + tools/list，收帧后关 stdin。
 *  nestedMarker：置 '1' 的嵌套标记键（F03 双标记：ZSW_NESTED | XYZ_AGENT_SUBAGENT）。 */
function runServerProc({ nested, nestedMarker = 'ZSW_NESTED', timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ZSW_ROOT: path.join(TMP, nested ? 'root-nested' : 'root-normal'),
      ZCODE_MAILBOX_ROOT: path.join(TMP, 'mailbox-proc'),
      ZSW_ZCODE_CLI: '/nonexistent', // 防御：即使误启 runner 也不碰真 CLI
    };
    if (nested) env[nestedMarker] = '1';
    else {
      delete env.ZSW_NESTED;
      delete env.XYZ_AGENT_SUBAGENT; // F03：core 引擎嵌套标记同款清掉（嵌套宿主下跑测试防误拒）
    }

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

test('进程级：正常档 initialize→tools/list 恒空（1.0.0 终态），stdin 关闭后干净退出（exit 0，stdout 无杂音）', async () => {
  const r = await runServerProc({ nested: false });
  assert.equal(r.code, 0);
  assert.equal(r.restStdout.trim(), ''); // stdout 只走协议帧（帧已全部解析，无半截残留）
  const init = r.frames.find((f) => f.id === 1);
  assert.equal(init.result.serverInfo.name, 'zsw');
  const tl = r.frames.find((f) => f.id === 2);
  // D1 终态：恒空注册（agent 交互面全走 CLI，零上下文注入）
  assert.deepEqual(tl.result.tools, []);
  assert.match(r.stderr, /record 恢复/); // 启动序列（sweep+recover）日志走 stderr
  assert.match(r.stderr, /workflow 孤儿恢复/); // 回接 2b：wfHost.recoverOrphans 与 subagent recover 并存
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

test('进程级：XYZ_AGENT_SUBAGENT=1（core 引擎嵌套标记）同款不注册工具（F03 双标记判定）', async () => {
  const r = await runServerProc({ nested: true, nestedMarker: 'XYZ_AGENT_SUBAGENT' });
  assert.equal(r.code, 0);
  const tl = r.frames.find((f) => f.id === 2);
  assert.deepEqual(tl.result.tools, []);
  assert.match(r.stderr, /XYZ_AGENT_SUBAGENT/);
});

// ------------------------------------------------ R4：async manager.message

test('handler 直调：manager.message 为 async → 返回完整句柄而非 "{}"', async () => {
  const fake = makeFakeManager();
  // 真 manager.message 是 async（lib/manager.js）；同步 fake 会掩蔽未 await 的
  // 回归——此处强制 async，断言 round/notify 经 await 到达调用方
  fake.message = async (id, text) => {
    await new Promise((r) => setTimeout(r, 5));
    return { subagentId: id, status: 'running', round: 2, notify: 'none' };
  };
  const srv = server.createServer({ manager: fake, nested: false });
  const result = await callHandler(srv, 'zsub', { action: 'message', subagentId: 'sa-1', text: '追问' });
  assert.equal(result.isError, undefined);
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed, { subagentId: 'sa-1', status: 'running', round: 2, notify: 'none' });
});
