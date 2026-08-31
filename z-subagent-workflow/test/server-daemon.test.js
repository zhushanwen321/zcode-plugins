'use strict';

/**
 * server × daemon 集成测试（DESIGN-v4 §6.2/6.3/6.7，M0 接线 U4）。
 *
 * 覆盖四条接线链：
 * a) wait action 经 socket 协议往返（buildDaemonHandlers 适配 + MCP handler
 *    的 case 'wait' + lib/wait-handler lazy 创建，fake manager 的 status/pending
 *    受控）；
 * b) MCP 工具面终态（1.0.0 起 D1）：tools/list 恒空、tools/call 恒拒绝指向
 *    CLI（原 ZSW_TOOLS_DISABLED 灰度开关已随 M1 删除，终态内置无开关）；
 * c) 竞选集成：两个 startDaemon 实例接 MCP handler 表，一 daemon 一 standby，
 *    daemon stop 后 standby 事件驱动接管，新 daemon 的 handlers 服务正常；
 * d) 帧 cwd 传导（MF7）。
 *
 * env 必须在 require server 之前设置（同 test/server.test.js：config 在模块
 * 加载期从 env 冻结路径——ZSW_ROOT / HOME / mailbox 根）。
 * socket 隔离：sockPath 全落 mkdtemp 临时目录，不碰 ~/.zcode/zsw。
 * 帧编解码不 import daemon-socket（其导出面收敛为仅 { startDaemon }）：
 * NDJSON 协议就地内联构帧（JSON.stringify(obj)+'\n'）。
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-srv-daemon-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsw-root');
process.env.ZCODE_MAILBOX_ROOT = path.join(TMP, 'mailbox');
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

// env 隔离完成后才允许 require（见文件头注释）
const server = require('../dist/mcp/server');
const { startDaemon } = require('../lib/daemon-socket');

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

/** 临时 sock 目录 + 路径对（daemon-socket.test.js 同款）。 */
function tmpSock(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-srvd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, sockPath: path.join(dir, 'daemon.sock'), lockPath: path.join(dir, 'daemon.sock.lock') };
}

/** 轮询等待条件成立（看门狗接管含 200ms×3 退避窗口）。 */
async function waitUntil(fn, { timeoutMs = 4000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** sockPath 当前是否可连通。 */
function canConnect(sockPath) {
  return new Promise((resolve) => {
    const s = net.connect(sockPath);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

/**
 * 单请求 rpc：发一帧收一帧（wait-handler.test / daemon-socket.test 同款形态）。
 * 帧编解码内联（NDJSON：JSON + '\n'；按 0x0A 字节切行防多字节 UTF-8 被 chunk
 * 边界撕裂，空行跳过、坏行丢弃——与 daemon-socket 传输层解码语义同形）。
 */
function rpc(sockPath, req, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    let buf = Buffer.alloc(0);
    let done = false;
    const timer = setTimeout(() => fail(new Error('rpc 超时')), timeoutMs);
    const fail = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      reject(e);
    };
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on('data', (chunk) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      let nl;
      while ((nl = buf.indexOf(0x0a)) >= 0) {
        const line = buf.subarray(0, nl).toString('utf8').trim();
        buf = buf.subarray(nl + 1);
        if (!line) continue; // 空行不是帧（如结尾 \n 后的尾巴）
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue; // 坏行丢弃，等下一帧
        }
        done = true;
        clearTimeout(timer);
        sock.end();
        resolve(frame);
        return;
      }
    });
    sock.on('error', fail);
    sock.on('close', () => { if (!done) fail(new Error('连接提前关闭')); });
  });
}

/**
 * 内存 fake manager：status/pending 受控（wait 用），list 带 tag（竞选接管
 * 断言用——两个实例的 handler 表可区分服务者身份）。
 */
function makeFakeManager(tag = 'x') {
  const records = new Map();
  const pending = new Map();
  return {
    tag, records, pending,
    status(id) {
      const rec = records.get(id);
      if (!rec) throw new Error(`subagent "${id}" 不存在。恢复指引：用 list 查看全部任务 id。`);
      return { ...rec, outputFile: `/fake/outputs/${id}.md` };
    },
    list() { return [{ subagentId: `sa-${tag}`, status: 'closed', tag }]; },
    async start() { return { subagentId: 'sa-new', status: 'running' }; },
    async cancel(id) { return { subagentId: id, status: 'cancelled' }; },
    message(id, text) { return { subagentId: id, status: 'running' }; },
    async close(id) { return { subagentId: id, status: 'closed' }; },
  };
}

/** 受控 deferred（settle 顺序对齐真 manager：先落 record 终态再动 promise）。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 一条完整接线链：fake manager → createServer → buildDaemonHandlers → startDaemon。 */
async function startInstance(sockPath, tag) {
  const fake = makeFakeManager(tag);
  const srv = server.createServer({ manager: fake, nested: false });
  return {
    fake,
    handle: await startDaemon({
      sockPath,
      handlers: server.buildDaemonHandlers(srv.toolHandlers),
      log: () => {},
    }),
  };
}

// ------------------------------------------------ a) wait 经 socket 往返

test('socket 面 wait action：终态立即收 + 运行中挂 pending promise 事件驱动唤醒（CLI 消费业务形态）', async (t) => {
  const { sockPath } = tmpSock(t);
  const inst = await startInstance(sockPath, 'w');
  t.after(() => inst.handle.stop());

  // sa-done 已终态；sa-run 运行中，pending 塞受控 promise（事件驱动主路径）
  inst.fake.records.set('sa-done', { subagentId: 'sa-done', status: 'closed' });
  inst.fake.records.set('sa-run', { subagentId: 'sa-run', status: 'running' });
  const exec = deferred();
  inst.fake.pending.set('sa-run', exec.promise);

  const frameP = rpc(sockPath, { id: 1, tool: 'zsub', params: { action: 'wait', ids: ['sa-done', 'sa-run'] } });
  await new Promise((r) => setTimeout(r, 150)); // 等 daemon 侧进入挂起（否则 settle 先于 await 注册，测不出挂起语义）

  // settle：先落终态再动 promise（真 manager 的 _execRound 时序）
  inst.fake.records.set('sa-run', { subagentId: 'sa-run', status: 'closed' });
  inst.fake.pending.delete('sa-run');
  exec.resolve();

  const frame = await frameP;
  assert.equal(frame.id, 1);
  assert.equal(frame.ok, true, `wait 不应失败: ${JSON.stringify(frame.error)}`);
  // 业务形态直达 CLI（partial 决定 exit code 的字段在顶层，不在 MCP content 包装里）
  assert.equal(frame.result.partial, undefined);
  assert.deepEqual(frame.result.results.map((r) => [r.subagentId, r.status, r.outputFile]), [
    ['sa-done', 'closed', '/fake/outputs/sa-done.md'],
    ['sa-run', 'closed', '/fake/outputs/sa-run.md'], // 保持入参 ids 顺序
  ]);
});

test('socket 面 wait：timeoutMs 到点回 partial+pending；未知 id 可操作报错走 ok:false 帧', async (t) => {
  const { sockPath } = tmpSock(t);
  const inst = await startInstance(sockPath, 'p');
  t.after(() => inst.handle.stop());

  // running 且 pending 无条目（模拟 daemon 接管后内存丢失）：只剩轮询兜底，
  // timeoutMs=150 到点必须回 partial 而非永久挂起
  inst.fake.records.set('sa-hang', { subagentId: 'sa-hang', status: 'running' });
  const partial = await rpc(sockPath, {
    id: 2, tool: 'zsub', params: { action: 'wait', ids: ['sa-hang'], timeoutMs: 150 },
  });
  assert.equal(partial.ok, true);
  assert.equal(partial.result.partial, true);
  assert.deepEqual(partial.result.pending, [{ subagentId: 'sa-hang', status: 'running' }]);
  assert.deepEqual(partial.result.results, []);

  // MCP 面 isError 包装在 socket 面解包为 ok:false 帧（CLI exit 1 路径）
  const bad = await rpc(sockPath, { id: 3, tool: 'zsub', params: { action: 'wait', ids: ['sa-ghost'] } });
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /sa-ghost/);
  assert.match(bad.error.message, /恢复指引/);
});

test('socket 面 wait：ids 非法（空数组 / 非字符串）→ ok:false 可操作校验错误', async (t) => {
  const { sockPath } = tmpSock(t);
  const inst = await startInstance(sockPath, 'v');
  t.after(() => inst.handle.stop());
  for (const ids of [[], ['ok', 123], 'sa-not-array']) {
    const frame = await rpc(sockPath, { id: 1, tool: 'zsub', params: { action: 'wait', ids } });
    assert.equal(frame.ok, false, `ids=${JSON.stringify(ids)} 应被拒绝`);
    assert.match(frame.error.message, /wait 需要 ids/);
  }
});

// ------------------------------------------------ b) MCP 工具面终态（1.0.0 起 D1）

test('MCP 工具面终态：tools/list 恒空、tools/call 恒拒绝指向 CLI（正常档与 NESTED 档同形）', async () => {
  // 1.0.0 起 D1 终态内置（原 ZSW_TOOLS_DISABLED 灰度开关已删，无 env 可翻）：
  // 正常档与嵌套档在 MCP 面无行为差异，均恒空注册 + 恒给「走 CLI」指引
  for (const nested of [false, true]) {
    const srv = server.createServer({ manager: makeFakeManager(), nested });
    const tl = await srv.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.deepEqual(tl[0].result.tools, [], `nested=${nested} tools/list 应恒空`);

    const call = await srv.handleMessage({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'zsub', arguments: { action: 'list' } },
    });
    assert.equal(call[0].result.isError, true, `nested=${nested} tools/call 应恒拒绝`);
    assert.match(call[0].result.content[0].text, /工具面已下线/);
    assert.match(call[0].result.content[0].text, /bin\/zsw\.js/); // 恢复指引指向 CLI 出口
  }
});

// ------------------------------------------------ c) 竞选集成（MCP handler 表挂真 daemon）

test('竞选集成：双实例一 daemon 一 standby；daemon stop 后 standby 接管，新 daemon 用自己的 handler 表服务', async (t) => {
  const { sockPath, lockPath } = tmpSock(t);
  const a = await startInstance(sockPath, 'a');
  const b = await startInstance(sockPath, 'b');
  t.after(() => a.handle.stop());
  t.after(() => b.handle.stop());
  const daemon = a.handle.role === 'daemon' ? a : b;
  const standby = a.handle.role === 'daemon' ? b : a;
  assert.ok(daemon.handle.role === 'daemon' && standby.handle.role === 'standby', '有且仅一个 daemon');

  // socket 面走完整 MCP handler 链（buildDaemonHandlers → toolHandlers.zsub
  // → manager.list）：content 已解包，result 是业务数组
  const before = await rpc(sockPath, { id: 1, tool: 'zsub', params: { action: 'list' } });
  assert.equal(before.ok, true);
  assert.deepEqual(before.result.map((r) => r.tag), [daemon.fake.tag]);

  await daemon.handle.stop(); // → standby 看门狗 close → 事件驱动接管
  await waitUntil(() => canConnect(sockPath));

  const after = await rpc(sockPath, { id: 2, tool: 'zsub', params: { action: 'list' } });
  assert.equal(after.ok, true);
  assert.deepEqual(after.result.map((r) => r.tag), [standby.fake.tag], '接管者用自己的 handler 表（含自己的 fake manager）');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), String(process.pid), '接管者持有新 lock');
});

test('socket 面经适配器可调全部注册 tool：zflow status 走 runId 校验（MCP 错误语义保留到 ok:false 帧）', async (t) => {
  const { sockPath } = tmpSock(t);
  const inst = await startInstance(sockPath, 'f');
  t.after(() => inst.handle.stop());
  // 本实例未注入 wfHost：zflow handler throw → daemon-socket dispatch 统一
  // 映射 ok:false 帧（handler 异常语义不因换传输面而丢）
  const frame = await rpc(sockPath, { id: 1, tool: 'zflow', params: { action: 'list' } });
  assert.equal(frame.ok, false);
  assert.match(frame.error.message, /workflow 运行时/);
});

// ------------------------------------------------ d) 帧 cwd 传导（MF7）

test('buildDaemonHandlers：req.cwd（非空 string）透传为 handler env.cwd → ctx.cwd；缺失/非 string 走既有回落链', async () => {
  const seen = [];
  // 最小 fake manager：仅 start 捕获 ctx（handler 内 env.cwd || ZCODE_PROJECT_DIR || process.cwd() 链的落点）
  const fake = {
    async start(params, ctx) { seen.push(ctx.cwd); return { subagentId: 'sa-x', status: 'running' }; },
    list() { return []; },
  };
  const handlers = server.buildToolHandlers({ manager: fake, nested: false });
  const daemonHandlers = server.buildDaemonHandlers(handlers);

  const prevProjDir = process.env.ZCODE_PROJECT_DIR;
  try {
    delete process.env.ZCODE_PROJECT_DIR;
    // 帧带非空 string cwd → env.cwd → ctx.cwd 原样到达（多 worktree 定位锚点）
    await daemonHandlers.zsub({ tool: 'zsub', params: { action: 'start', task: 't', slug: 's' }, cwd: '/tmp/zsw-wt-a' });
    // 帧缺失 cwd → env.cwd undefined → 回落 process.cwd()（daemon 宿主目录）
    await daemonHandlers.zsub({ tool: 'zsub', params: { action: 'start', task: 't', slug: 's' } });
    // 帧带非 string cwd（传输层已拦，适配层再守卫一次）→ 同缺失
    await daemonHandlers.zsub({ tool: 'zsub', params: { action: 'start', task: 't', slug: 's' }, cwd: 42 });
    // 空串同忽略
    await daemonHandlers.zsub({ tool: 'zsub', params: { action: 'start', task: 't', slug: 's' }, cwd: '' });
    assert.deepEqual(seen, ['/tmp/zsw-wt-a', process.cwd(), process.cwd(), process.cwd()]);

    // 既有链的中间优先级仍在：帧无 cwd 但 ZCODE_PROJECT_DIR 存在 → 取后者
    process.env.ZCODE_PROJECT_DIR = '/tmp/zsw-projdir';
    seen.length = 0;
    await daemonHandlers.zsub({ tool: 'zsub', params: { action: 'start', task: 't', slug: 's' } });
    // 帧 cwd 优先于 ZCODE_PROJECT_DIR（发起方目录 > daemon 宿主项目目录）
    await daemonHandlers.zsub({ tool: 'zsub', params: { action: 'start', task: 't', slug: 's' }, cwd: '/tmp/zsw-wt-b' });
    assert.deepEqual(seen, ['/tmp/zsw-projdir', '/tmp/zsw-wt-b']);
  } finally {
    if (prevProjDir === undefined) delete process.env.ZCODE_PROJECT_DIR;
    else process.env.ZCODE_PROJECT_DIR = prevProjDir;
  }
});

test('socket 面端到端：帧 cwd 经 buildDaemonHandlers 到达 manager.start 的 ctx（完整接线链）', async (t) => {
  const { sockPath } = tmpSock(t);
  const seen = [];
  const fake = {
    async start(params, ctx) { seen.push(ctx.cwd); return { subagentId: 'sa-e2e', status: 'running' }; },
    list() { return []; },
  };
  const srv = server.createServer({ manager: fake, nested: false });
  const handle = await startDaemon({
    sockPath,
    handlers: server.buildDaemonHandlers(srv.toolHandlers),
    log: () => {},
  });
  t.after(() => handle.stop());

  const frame = await rpc(sockPath, {
    id: 1, tool: 'zsub', params: { action: 'start', task: '任务书', slug: 'cwd-e2e' }, cwd: '/tmp/zsw-wt-socket',
  });
  assert.equal(frame.ok, true, `start 不应失败: ${JSON.stringify(frame.error)}`);
  assert.equal(frame.result.subagentId, 'sa-e2e');
  assert.deepEqual(seen, ['/tmp/zsw-wt-socket'], '帧 cwd 经 daemon-socket 类型守卫 + 适配器透传，完整到达 manager ctx');
});
