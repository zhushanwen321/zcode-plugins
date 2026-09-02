'use strict';

/**
 * bin/zsw.js 的 workflow 管理面 daemon 形态 + 嵌套拒绝 + wait exit code 测试
 * （Wave A：MF1/MF2/MF4，子进程黑盒 + 假 daemon socket server——假 server
 * 写法参照 cli-client.test.js，CLI 隔离参照 cli.test.js）。
 *
 * 覆盖：
 * - MF2：ZSW_NESTED=1 下 workflow 子命令拒绝（run/管理 action/--local 全拒）
 * - MF1：abort/status/list/scripts 无 --local 时经 daemon 透传
 *   {tool:'zflow', params:...}（--id ↔ runId 映射）；run/lint 恒本地；
 *   --local 全 action 本地
 * - MF4：wait 终态 exit code（closed→0 / cancelled·error·timeout→1 /
 *   mixed→1 / partial→2）
 *
 * 隔离：ZSW_ROOT / ZCODE_MAILBOX_ROOT / HOME / ZSW_SOCK 指向临时目录
 * （默认 ZSW_SOCK 指不存在路径 = 「无 daemon」形态，用例按需覆盖指向假 daemon）。
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-cli-wfd-'));
const BIN = path.join(__dirname, '..', 'bin', 'zsw.js');
/** 默认指向不存在的隔离路径：未显式给假 daemon 的用例一律「daemon 不在场」。 */
const NO_DAEMON_SOCK = path.join(TMP, 'no-daemon', 'daemon.sock');

let sockSeq = 0;
const { encodeFrame } = require('../lib/frame-codec');

function run(args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      {
        env: {
          ...process.env,
          ZSW_ROOT: path.join(TMP, 'zsw-root'),
          ZCODE_MAILBOX_ROOT: path.join(TMP, 'mailbox'),
          HOME: path.join(TMP, 'home'),
          ZCODE_PROJECT_DIR: TMP,
          ZSW_NESTED: '', // 显式清掉宿主可能的标记，用例按需覆盖（MF2 用例经 extraEnv 显式置 '1'，同 cli.test.js 口径）
          XYZ_AGENT_SUBAGENT: '', // F03：core 引擎嵌套标记同款清掉（嵌套宿主下跑测试防误拒）
          ZSW_SOCK: NO_DAEMON_SOCK,
          ...extraEnv,
        },
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      },
    );
  });
}

/**
 * 起假 daemon：记录收到的全部请求帧；onFrame(req) 返回要写回的响应对象
 * （不含 id，这里补上）；构响应帧 import 生产 encodeFrame（帧语法单源，设计
 * D2）。CLI 每次调用独立连接，seen 跨用例累积后按序断言。请求侧解析是测试
 * 替身对已知输入的简化（一行一解、粘包余帧丢弃、string 拼接）——CLI 每次
 * 调用只发单请求帧，替身不复制协议权威解码，解码一般性由 lib/frame-codec
 * 与 daemon-socket 回归锚保证（设计 D2 显式豁免类）。
 */
function startFakeDaemon(onFrame) {
  return new Promise((resolve) => {
    const sockPath = path.join(TMP, `fake-${sockSeq += 1}.sock`);
    const seen = [];
    const server = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl === -1) return; // 半截请求帧：等下一段 data
        const req = JSON.parse(buf.slice(0, nl));
        buf = '';
        seen.push(req);
        conn.write(encodeFrame({ id: req.id, ...onFrame(req) }));
      });
    });
    server.listen(sockPath, () => resolve({ server, sockPath, seen }));
  });
}

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// --------------------------------------------------- MF2：嵌套拒绝（验收 a）

test('MF2: ZSW_NESTED=1 workflow --action list → exit 1 嵌套拒绝', async () => {
  const r = await run(['workflow', '--action', 'list'], { ZSW_NESTED: '1' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /嵌套环境禁止编排（防递归，ZSW_NESTED=1 或 XYZ_AGENT_SUBAGENT=1）/);
  assert.match(r.stderr, /恢复指引/);
});

test('MF2/F03: XYZ_AGENT_SUBAGENT=1（core 引擎嵌套标记）→ 同款拒绝', async () => {
  // core 引擎嵌套派发的会话只带 XYZ_AGENT_SUBAGENT=1——只查 ZSW_NESTED 会漏
  const r = await run(['workflow', '--action', 'list'], { ZSW_NESTED: '', XYZ_AGENT_SUBAGENT: '1' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /嵌套环境禁止编排（防递归，ZSW_NESTED=1 或 XYZ_AGENT_SUBAGENT=1）/);
});

test('MF2: ZSW_NESTED=1 workflow --action list --local → 同款拒绝（本地跑同样递归）', async () => {
  const r = await run(['workflow', '--action', 'list', '--local'], { ZSW_NESTED: '1' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /嵌套环境禁止编排/);
});

test('MF2: ZSW_NESTED=1 workflow（缺省 action = run，本地路径）→ 同款拒绝', async () => {
  const r = await run(['workflow'], { ZSW_NESTED: '1' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /嵌套环境禁止编排/);
});

// ------------------------------------------- MF1：管理面 daemon 透传（验收 b）

test('MF1: workflow --action list（默认）→ 透传 {tool:"zflow",params:{action:"list"}} 且打印响应', async () => {
  const d = await startFakeDaemon(() => ({ ok: true, result: [{ runId: 'wf-1', status: 'closed' }] }));
  const r = await run(['workflow', '--action', 'list'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), [{ runId: 'wf-1', status: 'closed' }]);
  assert.equal(d.seen.length, 1);
  assert.equal(d.seen[0].tool, 'zflow');
  assert.deepEqual(d.seen[0].params, { action: 'list' });
  assert.ok(Number.isInteger(d.seen[0].id));
  d.server.close();
});

test('MF1: workflow --action abort --id wf-x → params 映射 runId（非 --id 直传）', async () => {
  const d = await startFakeDaemon(() => ({ ok: true, result: { runId: 'wf-x', status: 'cancelled' } }));
  const r = await run(['workflow', '--action', 'abort', '--id', 'wf-x'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 0);
  assert.deepEqual(d.seen[0].params, { action: 'abort', runId: 'wf-x' });
  assert.equal(JSON.parse(r.stdout).status, 'cancelled');
  d.server.close();
});

test('MF1: workflow --action status --id wf-y → params 映射 runId', async () => {
  const d = await startFakeDaemon(() => ({ ok: true, result: { runId: 'wf-y', status: 'running' } }));
  const r = await run(['workflow', '--action', 'status', '--id', 'wf-y'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 0);
  assert.deepEqual(d.seen[0].params, { action: 'status', runId: 'wf-y' });
  d.server.close();
});

test('MF1: workflow --action scripts → 透传 {action:"scripts"}，daemon 结果原样打印', async () => {
  const d = await startFakeDaemon(() => ({ ok: true, result: { builtin: [], scripts: [] } }));
  const r = await run(['workflow', '--action', 'scripts'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 0);
  assert.deepEqual(d.seen[0].params, { action: 'scripts' });
  assert.deepEqual(JSON.parse(r.stdout), { builtin: [], scripts: [] });
  d.server.close();
});

test('MF1: workflow --action abort 缺 --id → daemon/--local 同款本地报错（组帧前校验）+ exit 1', async () => {
  const d = await startFakeDaemon(() => ({ ok: true, result: {} }));
  const r = await run(['workflow', '--action', 'abort'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--id/);
  assert.equal(d.seen.length, 0); // 缺参在组帧前拦截，不产生 daemon 请求
  d.server.close();
});

test('MF1: daemon 回 ok:false（run 不存在）→ exit 1 + stderr 打印业务错误', async () => {
  const d = await startFakeDaemon(() => ({
    ok: false,
    error: { code: -32000, message: 'run "wf-x" 不存在。恢复指引：先 list 查 runId' },
  }));
  const r = await run(['workflow', '--action', 'status', '--id', 'wf-x'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /wf-x" 不存在/);
  d.server.close();
});

test('MF1: run 恒本地——无 daemon 环境缺 --workdir 报本地校验错（非 daemon 未运行）', async () => {
  const r = await run(['workflow', '--workflow', 'chain', '--task', '做点事']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /缺少 --workdir/);
  assert.doesNotMatch(r.stderr, /daemon 未运行/);
});

test('MF1: lint 恒本地——无 daemon 环境缺 --file 报本地校验错（非 daemon 未运行）', async () => {
  const r = await run(['workflow', '--action', 'lint']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--file/);
  assert.doesNotMatch(r.stderr, /daemon 未运行/);
});

// ----------------------------------------------- MF1：--local 本地路径（验收 c）

test('MF1: workflow --action list --local → 本地路径，无 daemon 依赖，exit 0 空数组', async () => {
  // ZSW_SOCK 保持默认隔离路径（不存在）：本地路径不应触碰 daemon
  const r = await run(['workflow', '--action', 'list', '--local']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

// ------------------------------------------------- MF4：wait exit code（验收 d）

/** wait 请求帧断言（顺带验证 ids 透传）后返回指定 results 的响应对象。 */
function waitFrame(results, extra = {}) {
  return (req) => {
    assert.deepEqual(req.params, { action: 'wait', ids: ['sa-1'] });
    return { ok: true, result: { results, ...extra } };
  };
}

test('MF4: wait results 全 closed → exit 0', async () => {
  const d = await startFakeDaemon(waitFrame([{ subagentId: 'sa-1', status: 'closed' }]));
  const r = await run(['wait', '--id', 'sa-1'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 0);
  d.server.close();
});

test('MF4: wait results 含 error → exit 1', async () => {
  const d = await startFakeDaemon(waitFrame([{ subagentId: 'sa-1', status: 'error' }]));
  const r = await run(['wait', '--id', 'sa-1'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 1);
  d.server.close();
});

test('MF4: wait results 含 timeout → exit 1', async () => {
  const d = await startFakeDaemon(waitFrame([{ subagentId: 'sa-1', status: 'timeout' }]));
  const r = await run(['wait', '--id', 'sa-1'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 1);
  d.server.close();
});

test('MF4: wait results 含 cancelled → exit 1（主动取消计失败，更诚实）', async () => {
  const d = await startFakeDaemon(waitFrame([{ subagentId: 'sa-1', status: 'cancelled' }]));
  const r = await run(['wait', '--id', 'sa-1'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 1);
  d.server.close();
});

test('MF4: wait results mixed（closed + error）→ exit 1', async () => {
  const d = await startFakeDaemon(waitFrame([
    { subagentId: 'sa-1', status: 'closed' },
    { subagentId: 'sa-1', status: 'error' },
  ]));
  const r = await run(['wait', '--id', 'sa-1'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 1);
  d.server.close();
});

test('MF4: wait partial:true → exit 2（优先于失败判定）', async () => {
  const d = await startFakeDaemon(waitFrame(
    [{ subagentId: 'sa-1', status: 'closed' }],
    { partial: true, pending: [{ subagentId: 'sa-1', status: 'running' }] },
  ));
  const r = await run(['wait', '--id', 'sa-1'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 2);
  d.server.close();
});
