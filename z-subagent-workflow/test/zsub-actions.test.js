'use strict';

/**
 * zsub action 表单元锚（D3：lib/zsub-actions.js 是两入口——CLI --local 与
 * daemon handler——的执行单源）。
 *
 * 锚定两类不变量：
 * 1. 错误消息文本与收口前 dist/mcp/server.js 各分支逐字一致（零行为变化
 *    基准——「不支持的 action」全文、subagentId/text 前置校验、agents/models
 *    端口守卫文案）；
 * 2. 表结构不变量：键集与顺序（顺序即「不支持的 action」报错名单序）、
 *    原型链键（如 "constructor"）不得命中、deps 消费形态（manager 直调 /
 *    ports / waitHandler）。
 *
 * 本文件纯 lib 单元测试：不 require server.js / bin/zsw.js，无 env 预设置
 * 依赖（model-router 模块加载无副作用）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  zsubActions,
  execZsubAction,
  unsupportedActionMessage,
} = require('../lib/zsub-actions');

const SUPPORTED_LIST = 'start | list | status | cancel | message | close | agents | models | wait';

// ----------------------------------------------「不支持的 action」全文锚

test('unsupportedActionMessage：全文与收口前 server.js default 分支逐字一致（含尾句）', () => {
  assert.equal(
    unsupportedActionMessage('bogus'),
    '不支持的 action "bogus"。支持：' + SUPPORTED_LIST + '。'
    + '恢复指引：action 必须取 inputSchema 中的枚举值。',
  );
  // 尾句是 MCP 面时代措辞（socket 面无 inputSchema）——零行为变化基准下
  // 逐字保留（D3：文案修订不属于收口范围）
  assert.ok(unsupportedActionMessage('x').endsWith('恢复指引：action 必须取 inputSchema 中的枚举值。'));
});

test('unsupportedActionMessage：非字符串 action 走 String() 插值（undefined/null/对象）', () => {
  assert.equal(
    unsupportedActionMessage(undefined),
    `不支持的 action "undefined"。支持：${SUPPORTED_LIST}。恢复指引：action 必须取 inputSchema 中的枚举值。`,
  );
  assert.ok(unsupportedActionMessage(null).startsWith('不支持的 action "null"。'));
  assert.ok(unsupportedActionMessage({}).startsWith('不支持的 action "[object Object]"。'));
});

test('execZsubAction：未知 action → throw 同文本（两入口共用的查表入口）', async () => {
  await assert.rejects(
    execZsubAction('explode', {}, {}, { manager: {} }),
    (e) => {
      assert.equal(
        e.message,
        '不支持的 action "explode"。支持：' + SUPPORTED_LIST + '。恢复指引：action 必须取 inputSchema 中的枚举值。',
      );
      return true;
    },
  );
});

test('execZsubAction：原型链键（constructor/toString）不得命中表——hasOwnProperty 守卫', async () => {
  await assert.rejects(
    execZsubAction('constructor', {}, {}, { manager: {} }),
    (e) => e.message.startsWith('不支持的 action "constructor"。'),
  );
  await assert.rejects(
    execZsubAction('toString', {}, {}, { manager: {} }),
    (e) => e.message.startsWith('不支持的 action "toString"。'),
  );
});

test('表结构：键集与顺序（顺序即报错名单序，与收口前 switch 分支序一致）', () => {
  assert.deepEqual(Object.keys(zsubActions), [
    'start', 'list', 'status', 'cancel', 'message', 'close', 'agents', 'models', 'wait',
  ]);
  // 每项都是 { exec } 形态
  for (const entry of Object.values(zsubActions)) {
    assert.equal(typeof entry.exec, 'function');
  }
});

// ----------------------------------------错误消息逐字锚（D4：前置校验随表迁移）

test('status/cancel/close/message 缺 subagentId → 逐字消息（收口前 requireSubagentId）', async () => {
  const deps = { manager: {} };
  for (const action of ['status', 'cancel', 'close', 'message']) {
    await assert.rejects(
      execZsubAction(action, {}, {}, deps),
      (e) => {
        assert.equal(
          e.message,
          '缺少必填参数 subagentId（start 返回的任务 id）。恢复指引：先用 list 查全部任务 id。',
        );
        return true;
      },
      `action=${action} 缺 subagentId 应给逐字一致的必填消息`,
    );
  }
  // 空白字符串同缺参（trim 闸）
  await assert.rejects(
    execZsubAction('status', { subagentId: '  ' }, {}, deps),
    (e) => e.message === '缺少必填参数 subagentId（start 返回的任务 id）。恢复指引：先用 list 查全部任务 id。',
  );
});

test('message 缺 text → 逐字消息（收口前 daemon 面 handler 前置校验）', async () => {
  const deps = { manager: { message: () => { throw new Error('不应触达 manager'); } } };
  await assert.rejects(
    execZsubAction('message', { subagentId: 'sa-1' }, {}, deps),
    (e) => {
      assert.equal(e.message, 'message 需要 text（非空字符串，续聊消息内容）。');
      return true;
    },
  );
  await assert.rejects(
    execZsubAction('message', { subagentId: 'sa-1', text: '   ' }, {}, deps),
    (e) => e.message === 'message 需要 text（非空字符串，续聊消息内容）。',
  );
});

test('agents：resolver 端口缺失 → 逐字可操作消息（不触达 resolver.list）', async () => {
  await assert.rejects(
    execZsubAction('agents', {}, {}, { manager: {}, ports: {} }),
    (e) => {
      assert.equal(
        e.message,
        'agents 需要 resolver 端口（agent .md 发现），当前 manager 未注入。'
        + '恢复指引：其他 action 不受影响；agents 排障查 lib/assemble.js 的 resolver 组装。',
      );
      return true;
    },
  );
});

test('models：modelRouter 端口缺失 / --all 缺 allProviders 实现 → 逐字可操作消息', async () => {
  await assert.rejects(
    execZsubAction('models', {}, {}, { manager: {}, ports: {} }),
    (e) => {
      assert.equal(
        e.message,
        'models 需要 modelRouter 端口（v2 config 模型清单），当前 manager 未注入。'
        + '恢复指引：其他 action 不受影响；models 排障查 lib/assemble.js 的 modelRouter 组装。',
      );
      return true;
    },
  );
  const stubRouter = { listModels: () => [] }; // 缺 allProviders
  await assert.rejects(
    execZsubAction('models', { all: true }, {}, { manager: {}, ports: { modelRouter: stubRouter } }),
    (e) => {
      assert.equal(
        e.message,
        'models --all 需要 modelRouter 端口实现 allProviders()（跨 provider 模型清单），当前实现未提供。'
        + '恢复指引：缺省 models（不带 all）仍可查默认 provider 视图；排障查 lib/model-router.js 的 allProviders 与 lib/assemble.js 的 modelRouter 组装。',
      );
      return true;
    },
  );
});

// ------------------------------------------------------成功路径与 deps 消费

test('start/list/status/cancel/close：manager 直调 + params/ctx 原样透传', async () => {
  const calls = [];
  const manager = {
    async start(params, ctx) { calls.push(['start', params, ctx]); return { subagentId: 'sa-x' }; },
    list() { calls.push(['list']); return []; },
    status(id) { calls.push(['status', id]); return { subagentId: id, status: 'closed' }; },
    async cancel(id) { calls.push(['cancel', id]); return { cancelled: true }; },
    async close(id) { calls.push(['close', id]); return { closed: true }; },
  };
  const deps = { manager };
  const ctx = { cwd: '/proj/x' };

  const startParams = { task: 't', slug: 's', wait: true };
  assert.deepEqual(await execZsubAction('start', startParams, ctx, deps), { subagentId: 'sa-x' });
  assert.equal(calls[0][1], startParams); // params 引用原样（入口组参分叉在调用点可见）
  assert.equal(calls[0][2], ctx);

  assert.deepEqual(await execZsubAction('list', {}, ctx, deps), []);
  assert.deepEqual(await execZsubAction('status', { subagentId: 'sa-1' }, ctx, deps), { subagentId: 'sa-1', status: 'closed' });
  assert.deepEqual(await execZsubAction('cancel', { subagentId: 'sa-1' }, ctx, deps), { cancelled: true });
  assert.deepEqual(await execZsubAction('close', { subagentId: 'sa-1' }, ctx, deps), { closed: true });
  assert.deepEqual(calls.map((c) => c[0]), ['start', 'list', 'status', 'cancel', 'close']);
});

test('message：id/text 解包后透传 manager.message（await async，R4）', async () => {
  const calls = [];
  const manager = {
    async message(id, text) {
      await new Promise((r) => setTimeout(r, 5));
      calls.push([id, text]);
      return { subagentId: id, round: 2, notify: 'none' };
    },
  };
  const result = await execZsubAction('message', { subagentId: 'sa-1', text: '追问' }, {}, { manager });
  assert.deepEqual(result, { subagentId: 'sa-1', round: 2, notify: 'none' }); // 完整句柄而非序列化 Promise
  assert.deepEqual(calls, [['sa-1', '追问']]);
});

test('wait：deps.waitHandler 收 params + ctx.signal 透传（连接级取消）', async () => {
  const seen = [];
  const deps = {
    manager: {},
    waitHandler: (params, meta) => {
      seen.push([params, meta]);
      return { results: [] };
    },
  };
  const ac = new AbortController();
  const result = await execZsubAction('wait', { ids: ['sa-1'] }, { cwd: '/x', signal: ac.signal }, deps);
  assert.deepEqual(result, { results: [] });
  assert.deepEqual(seen, [[{ ids: ['sa-1'] }, { signal: ac.signal }]]);
  // 无 signal（ctx 缺省）→ meta.signal undefined
  await execZsubAction('wait', { ids: ['sa-1'] }, {}, deps);
  assert.deepEqual(seen[1], [{ ids: ['sa-1'] }, { signal: undefined }]);
});

test('agents：ports.agentResolver 消费 + 视图拼装（截 200 / source 标签 / location 与 file 同值）', async () => {
  const deps = {
    manager: {},
    ports: {
      agentResolver: {
        async list(cwd) {
          assert.equal(cwd, '/proj/ag'); // ctx.cwd 透传发现层
          return [
            {
              name: 'a1',
              description: '长'.repeat(350),
              when: '何'.repeat(250),
              source: 'user-pi',
              filePath: '/h/.zcode/agents/a1.md',
            },
            { name: 'a2', source: 'npm', filePath: '/v/a2.md' },
            { name: 'a3', source: 'project-host', filePath: '/p/a3.md' },
          ];
        },
      },
    },
  };
  const rows = await execZsubAction('agents', {}, { cwd: '/proj/ag' }, deps);
  assert.equal(rows[0].description, '长'.repeat(200));
  assert.equal(rows[0].when, '何'.repeat(200));
  assert.equal(rows[0].source, 'user-zcode'); // core 槽位标签 → 面上标签
  assert.equal(rows[1].source, 'core-vendored');
  assert.equal(rows[2].source, 'project-zcode');
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['description', 'file', 'location', 'name', 'source', 'when']);
    assert.equal(r.location, r.file);
  }
  assert.equal(rows[1].when, ''); // when 缺省容忍为空串
  assert.equal(rows[2].when, '');
  assert.equal(rows[1].description, ''); // description 缺省容忍为空串
});

test('models：缺省视图（provider/models/guidance）与 --all 视图（ports.modelRouter 消费）', async () => {
  const router = {
    listModels: () => [{ name: 'GLM-5.3', default: true }],
    allProviders: () => [{ provider: 'p1', models: [{ name: 'p1/m1' }] }],
  };
  const deps = { manager: {}, ports: { modelRouter: router } };

  const view = await execZsubAction('models', {}, {}, deps);
  assert.equal(view.provider, 'builtin:bigmodel-coding-plan'); // PROVIDER_ID 常量同源
  assert.deepEqual(view.models, [{ name: 'GLM-5.3', default: true }]);
  assert.match(view.guidance, /轻量/);

  const all = await execZsubAction('models', { all: true }, {}, deps);
  assert.equal(all.all, true);
  assert.deepEqual(all.providers, [{ provider: 'p1', models: [{ name: 'p1/m1' }] }]);
  assert.match(all.guidance, /全名/);
});
