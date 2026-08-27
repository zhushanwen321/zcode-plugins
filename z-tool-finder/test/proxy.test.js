'use strict';
// wrapper 代理层冒烟：真实 spawn proxy.js 子进程 + 行式 JSON-RPC，
// 底层用 test/fixtures/echo-server.js。全部走 ZTF_DATA_DIR 注入，不碰真实 ~/.zcode。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const readline = require('readline');

const PROXY = path.join(__dirname, '..', 'dist', 'mcp', 'proxy.js');
const ECHO = path.join(__dirname, 'fixtures', 'echo-server.js');
const CRASH = path.join(__dirname, 'fixtures', 'crash-server.js');

// ---------- 行式 JSON-RPC 会话夹具 ----------

function startProxy(serverKey, { env, onStderr, server = [process.execPath, ECHO] } = {}) {
  const child = spawn(
    process.execPath,
    [PROXY, serverKey, '--', ...server],
    { env: { ...process.env, ...env } }
  );
  const pending = new Map();
  let nextId = 1;
  if (onStderr) child.stderr.on('data', (d) => onStderr(String(d)));
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  return {
    child,
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`请求超时: ${method}`));
        }, 10000);
      });
    },
    call(name, args) {
      return this.request('tools/call', { name, arguments: args });
    },
    kill() {
      for (const fn of pending.values()) fn({ error: { message: 'killed' } });
      pending.clear();
      child.kill();
    },
  };
}

// ---------- 公共夹具：临时数据目录 + 预置 registry/catalog ----------

function withDataDir(t, { registry, catalog } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztf-proxy-test-'));
  if (registry) fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(registry));
  if (catalog) fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function init(rpc) {
  const initRes = await rpc.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(initRes.result.serverInfo.name, 'z-tool-finder-proxy');
}

// ---------- 用例 ----------

test('tools/list 只返回两个 meta 工具（核心价值断言）', async (t) => {
  const dataDir = withDataDir(t);
  const rpc = startProxy('echo-test', { env: { ZTF_DATA_DIR: dataDir } });
  t.after(() => rpc.kill());
  await init(rpc);
  const res = await rpc.request('tools/list', {});
  const names = res.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['call_tool', 'get_tool_details']);
});

test('get_tool_details：catalog 命中返回完整详情与示例', async (t) => {
  const dataDir = withDataDir(t, {
    catalog: {
      servers: {
        'echo-test': {
          fetchedAt: '2026-01-01T00:00:00Z',
          tools: [
            {
              name: 'echo',
              whenToUse: '回显传入参数',
              description: '回显传入参数。Echo the arguments back.',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            },
          ],
        },
      },
    },
  });
  const rpc = startProxy('echo-test', { env: { ZTF_DATA_DIR: dataDir } });
  t.after(() => rpc.kill());
  await init(rpc);
  const res = await rpc.call('get_tool_details', { tool: 'echo' });
  assert.equal(res.result.isError, undefined);
  const details = JSON.parse(res.result.content[0].text);
  assert.equal(details.name, 'echo');
  assert.equal(details.whenToUse, '回显传入参数');
  assert.deepEqual(details.example, { text: 'text' }); // required 属性按 type 填占位值
});

test('get_tool_details：catalog miss 走实时兜底并回写 catalog', async (t) => {
  const dataDir = withDataDir(t, { catalog: { servers: {} } });
  const rpc = startProxy('echo-test', { env: { ZTF_DATA_DIR: dataDir } });
  t.after(() => rpc.kill());
  await init(rpc);
  const res = await rpc.call('get_tool_details', { tool: 'ping' });
  const details = JSON.parse(res.result.content[0].text);
  assert.equal(details.name, 'ping');
  // 回写后 catalog 应包含底层真实 tools/list 结果
  const cat = JSON.parse(fs.readFileSync(path.join(dataDir, 'catalog.json'), 'utf8'));
  const names = cat.servers['echo-test'].tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['echo', 'ping', 'slow']);
});

test('idle 回收：在途调用推迟回收、完成后重计窗、空闲到期后回收并自动重连', async (t) => {
  const dataDir = withDataDir(t, { catalog: { servers: {} } });
  // 300ms 空闲窗：慢工具（800ms）必然跨窗，验证 inFlightCalls 推迟分支
  const rpc = startProxy('echo-test', { env: { ZTF_DATA_DIR: dataDir, ZTF_IDLE_TIMEOUT_MS: '300' } });
  t.after(() => rpc.kill());
  await init(rpc);

  // 慢调用：idle 窗口在调用进行中到期，连接不被回收，调用照常成功
  const res = await rpc.call('call_tool', { tool: 'slow', args: {} });
  assert.equal(res.result.isError, undefined, JSON.stringify(res.result));

  const readLog = () => {
    try {
      return fs.readFileSync(path.join(dataDir, 'logs', 'proxy-echo-test.log'), 'utf8');
    } catch {
      return '';
    }
  };
  assert.match(readLog(), /推迟回收/);

  // 调用完成后重计窗：再等空闲到期，应看到自动回收日志
  await new Promise((r) => setTimeout(r, 700));
  assert.match(readLog(), /自动回收/);

  // 回收后再调用：自动重连新底层进程并成功
  const again = await rpc.call('call_tool', { tool: 'echo', args: { text: 'again' } });
  assert.equal(again.result.isError, undefined, JSON.stringify(again.result));
  assert.equal((readLog().match(/底层连接建立/g) || []).length, 2);
});

test('get_tool_details：兜底后仍 miss 返回可操作错误（列实际工具名）', async (t) => {
  const dataDir = withDataDir(t, { catalog: { servers: {} } });
  const rpc = startProxy('echo-test', { env: { ZTF_DATA_DIR: dataDir } });
  t.after(() => rpc.kill());
  await init(rpc);
  const res = await rpc.call('get_tool_details', { tool: 'not-exist' });
  assert.equal(res.result.isError, true);
  const text = res.result.content[0].text;
  assert.match(text, /not-exist 不存在/);
  assert.match(text, /echo/);
  assert.match(text, /ping/);
});

test('call_tool：required 缺失返回校验错误文本', async (t) => {
  const dataDir = withDataDir(t, { catalog: { servers: {} } });
  const rpc = startProxy('echo-test', { env: { ZTF_DATA_DIR: dataDir } });
  t.after(() => rpc.kill());
  await init(rpc);
  const res = await rpc.call('call_tool', { tool: 'echo', args: {} });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /缺少必填参数: text/);
});

test('call_tool：无 required 工具可省略 args（undefined 规范化为 {}）', async (t) => {
  const dataDir = withDataDir(t, { catalog: { servers: {} } });
  const rpc = startProxy('echo-test', { env: { ZTF_DATA_DIR: dataDir } });
  t.after(() => rpc.kill());
  await init(rpc);
  const res = await rpc.call('call_tool', { tool: 'ping' });
  assert.equal(res.result.isError, undefined, JSON.stringify(res.result));
});

test('call_tool：合法参数懒启动底层并原样转发结果', async (t) => {
  const dataDir = withDataDir(t, { catalog: { servers: {} } });
  const rpc = startProxy('echo-test', { env: { ZTF_DATA_DIR: dataDir } });
  t.after(() => rpc.kill());
  await init(rpc);
  const res = await rpc.call('call_tool', { tool: 'echo', args: { text: 'hi' } });
  assert.equal(res.result.isError, undefined);
  assert.equal(res.result.content[0].text, 'echo: {"text":"hi"}');
});

test('call_tool：policies deny 在转发前拦截并提示改 registry', async (t) => {
  const dataDir = withDataDir(t, {
    catalog: { servers: {} },
    registry: { servers: {}, overrides: {}, policies: { 'echo-test:echo': 'deny' } },
  });
  const rpc = startProxy('echo-test', { env: { ZTF_DATA_DIR: dataDir } });
  t.after(() => rpc.kill());
  await init(rpc);
  const res = await rpc.call('call_tool', { tool: 'echo', args: { text: 'hi' } });
  assert.equal(res.result.isError, true);
  const text = res.result.content[0].text;
  assert.match(text, /被 registry 策略拒绝/);
  assert.match(text, /registry\.json/);
});

// ---------- 死连接自愈（底层崩溃后无需等 5 分钟空闲回收） ----------

const CRASH_CATALOG = {
  servers: {
    'crash-test': {
      fetchedAt: '2026-01-01T00:00:00Z',
      serverInfo: { name: 'crash-server', version: '0.0.1' },
      tools: [
        {
          name: 'crash',
          whenToUse: '模拟崩溃',
          description: '模拟底层崩溃：调用即 exit(1)',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'echo',
          whenToUse: '回显',
          description: '回显传入参数',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
      ],
    },
  },
};

test('call_tool：底层调用中崩溃 → 可操作错误 + 下次调用自动重连', async (t) => {
  const dataDir = withDataDir(t, { catalog: CRASH_CATALOG });
  const rpc = startProxy('crash-test', {
    env: { ZTF_DATA_DIR: dataDir },
    server: [process.execPath, CRASH],
  });
  t.after(() => rpc.kill());
  await init(rpc);

  // 1. 正常调用建立连接
  const ok = await rpc.call('call_tool', { tool: 'echo', args: { text: 'first' } });
  assert.equal(ok.result.isError, undefined, JSON.stringify(ok.result));

  // 2. crash 工具使底层进程退出：应得可操作错误（而非 wrapper 内部错误/挂死）
  const crashed = await rpc.call('call_tool', { tool: 'crash', args: {} });
  assert.equal(crashed.result.isError, true);
  const text = crashed.result.content[0].text;
  assert.match(text, /底层调用中断/);
  assert.match(text, /连接已重置/);

  // 3. 自愈核心断言：紧接着的调用自动重连新进程并成功
  const healed = await rpc.call('call_tool', { tool: 'echo', args: { text: 'again' } });
  assert.equal(healed.result.isError, undefined, JSON.stringify(healed.result));
});

// 回归：并发调用下的 dead-branch 竞态（679bad1）。
// 同一连接上并发 crash + echo：进程退出后两个 callTool 同时 reject，
// 旧实现（catch 里无条件 client.close()）后到的 catch 对已被清空的模块级
// client 调 close() 抛 TypeError，落到「wrapper 内部错误」兜底；且若并发方
// 已重连出健康连接，旧实现会误杀它。断言：两个并发调用都得到可操作的
// 「底层调用中断」错误（非内部错误）、第三次调用重连成功、底层建连恰 2 次
// （初始 1 次 + 崩溃后重连 1 次，无误杀导致的额外建连）。
test('call_tool：并发 crash + echo → 双方可操作错误、无误杀、建连恰 2 次', async (t) => {
  let stderr = '';
  const dataDir = withDataDir(t, { catalog: CRASH_CATALOG });
  const rpc = startProxy('crash-test', {
    env: { ZTF_DATA_DIR: dataDir },
    server: [process.execPath, CRASH],
  });
  t.after(() => rpc.kill());
  await init(rpc);

  // 1. 建立初始连接（第 1 次建连）
  const warm = await rpc.call('call_tool', { tool: 'echo', args: { text: 'warm' } });
  assert.equal(warm.result.isError, undefined, JSON.stringify(warm.result));

  // 2. 并发：一个 crash（杀进程）、一个 echo（共享同一连接，同时 reject）
  const [crashed, echoed] = await Promise.all([
    rpc.call('call_tool', { tool: 'crash', args: {} }),
    rpc.call('call_tool', { tool: 'echo', args: { text: 'concurrent' } }),
  ]);
  for (const [label, res] of [['crash', crashed], ['echo', echoed]]) {
    const text = res.result.content[0].text;
    assert.match(text, /底层调用中断/, `${label} 应得到可操作的调用中断错误: ${text}`);
    assert.doesNotMatch(text, /wrapper 内部错误/, `${label} 不应落入内部错误兜底: ${text}`);
  }

  // 3. 第三次调用经 ensureClient 死连接检测重连（第 2 次建连）并成功
  const third = await rpc.call('call_tool', { tool: 'echo', args: { text: 'third' } });
  assert.equal(third.result.isError, undefined, JSON.stringify(third.result));

  // 日志按 logging-conventions 落盘 ZTF_DATA_DIR/logs/proxy-<serverKey>.log（写盘为同步 append）
  const logText = fs.readFileSync(
    path.join(dataDir, 'logs', 'proxy-crash-test.log'), 'utf8'
  );
  const connectCount = (logText.match(/底层连接建立/g) || []).length;
  assert.equal(connectCount, 2, `底层建连应恰 2 次（实际 ${connectCount}）:\n${logText}`);
});

// ---------- R1 回归：懒连接握手进行中收 SIGTERM，不留孤儿底层进程 ----------

const SLOW_INIT = path.join(__dirname, 'fixtures', 'slow-init-server.js');

test('SIGTERM 落在懒连接握手窗口内：proxy 等握手完成后 close 底层，不孤儿化', async (t) => {
  const dataDir = withDataDir(t, { catalog: { servers: {} } });
  const pidFile = path.join(dataDir, 'server.pid');
  const rpc = startProxy('slow-init-test', {
    env: {
      ZTF_DATA_DIR: dataDir,
      ZTF_TEST_PIDFILE: pidFile,
      ZTF_TEST_SLOW_INIT_MS: '1500',
    },
    server: [process.execPath, SLOW_INIT],
  });
  t.after(() => rpc.kill());
  await init(rpc);

  // 触发懒连接（catalog miss → ensureClient → connect 握手 1500ms），随即 SIGTERM
  rpc.call('get_tool_details', { tool: 'echo' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300)); // 确保进入 connect() 握手窗口
  rpc.child.kill('SIGTERM');

  // proxy 应等到握手完成后才退出（退出码 0），而不是握手期间立刻 exit(0)
  const code = await new Promise((resolve) => rpc.child.on('exit', (c) => resolve(c)));
  assert.equal(code, 0);

  // 底层 server 子进程须被 close（SIGTERM 链），不能存活成孤儿
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(fs.existsSync(pidFile), 'slow-init server 应已启动并写 pidfile');
  const serverPid = Number(fs.readFileSync(pidFile, 'utf8'));
  let alive = true;
  try {
    process.kill(serverPid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, `底层 server（pid ${serverPid}）应已退出，不能被孤儿化`);
});
