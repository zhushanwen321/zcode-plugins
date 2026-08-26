'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { connect } = require('../lib/mcp-client');

const ECHO = { command: process.execPath, args: [path.join(__dirname, 'fixtures', 'echo-server.js')] };

test('connect + listTools + callTool 全链路', async () => {
  const client = await connect(ECHO);
  try {
    assert.equal(client.serverInfo.name, 'echo-server');
    assert.equal(client.isDead(), false);
    const tools = await client.listTools();
    assert.equal(tools.length, 3);
    assert.equal(tools[0].name, 'echo');
    const result = await client.callTool('echo', { text: 'hi' });
    assert.match(result.content[0].text, /"text":"hi"/);
    assert.equal(client.isDead(), false, '存活期间 isDead 应为 false');
  } finally {
    client.close();
  }
});

test('请求超时 reject，且进程不杀（close 才杀）', async () => {
  // 一个 initialize 后永远不回 tools/list 的 server：收到请求打 stderr 但不响应
  const slowDef = {
    command: process.execPath,
    args: ['-e', `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        let m; try { m = JSON.parse(line); } catch { return; }
        if (m.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'slow', version: '0' } } }) + '\\n');
        } else if (m.method === 'tools/list') {
          process.stderr.write('slow-server: 故意不响应 tools/list\\n');
        }
      });
    `],
  };
  const client = await connect(slowDef, { timeoutMs: 300 });
  try {
    await assert.rejects(() => client.listTools(), (err) => {
      assert.match(err.message, /超时/);
      return true;
    });
    // 超时后进程仍在（stderr 仍可收集 / close 不抛）
    client.close();
  } finally {
    client.close();
  }
});

test('底层进程崩溃：未决请求 reject + stderr 摘要 + 建议动作', async () => {
  const crashDef = {
    command: process.execPath,
    args: ['-e', `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      let initialized = false;
      rl.on('line', (line) => {
        let m; try { m = JSON.parse(line); } catch { return; }
        if (m.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'crashy', version: '0' } } }) + '\\n');
          initialized = true;
        } else if (initialized) {
          process.stderr.write('crashy-server: 即将崩溃\\n');
          process.exit(1);
        }
      });
    `],
  };
  const client = await connect(crashDef, { timeoutMs: 5000 });
  await assert.rejects(() => client.listTools(), (err) => {
    assert.match(err.message, /提前退出/);
    assert.match(err.message, /crashy-server/);
    assert.match(err.message, /建议动作/);
    assert.ok(client.stderrTail().includes('crashy-server'));
    return true;
  });
  // 崩溃后 isDead=true：调用方据此丢弃连接（proxy 的死连接自愈依赖此信号）
  assert.equal(client.isDead(), true);
});

test('connect 失败（无法启动的 command）给出可操作错误', async () => {
  await assert.rejects(
    () => connect({ command: '/nonexistent/ztf-测试-command', args: [] }, { timeoutMs: 1000 }),
    (err) => {
      assert.match(err.message, /ztf-测试-command|nonexistent/);
      assert.match(err.message, /建议动作/);
      return true;
    }
  );
});

test('进程退出后的调用走 dead 预检：以「底层进程已退出」reject；dead 时 close() 立即 resolve', async () => {
  const crashDef = {
    command: process.execPath,
    args: ['-e', `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      let initialized = false;
      rl.on('line', (line) => {
        let m; try { m = JSON.parse(line); } catch { return; }
        if (m.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'crashy2', version: '0' } } }) + '\\n');
          initialized = true;
        } else if (initialized) {
          process.exit(1);
        }
      });
    `],
  };
  const c2 = await connect(crashDef, { timeoutMs: 5000 });
  await assert.rejects(() => c2.listTools(), /提前退出/);
  // ① dead 预检分支：进程退出后再调用，不等待超时，直接以固定文案 reject
  await assert.rejects(() => c2.listTools(), (err) => {
    assert.match(err.message, /底层进程已退出/);
    return true;
  });
  await assert.rejects(() => c2.callTool('x', {}), /底层进程已退出/);
  // ② dead 时 close() 不等 kill 宽限，立即 resolve
  const start = Date.now();
  await c2.close();
  assert.ok(Date.now() - start < 1000, 'dead 连接的 close() 应立即 resolve');
});

test('close() 对忽略 SIGTERM 的底层进程升级 SIGKILL 并 resolve', async () => {
  const def = { command: process.execPath, args: [path.join(__dirname, 'fixtures', 'term-ignore-server.js')] };
  const client = await connect(def, { timeoutMs: 5000 });
  assert.equal(client.isDead(), false);
  const start = Date.now();
  await client.close(); // SIGTERM 被忽略，只能等 SIGKILL
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 4500, `应在 SIGTERM 宽限（5s）后升级 SIGKILL，实际 ${elapsed}ms`);
  assert.ok(elapsed < 15000, `不应远超宽限期，实际 ${elapsed}ms`);
  assert.equal(client.isDead(), true);
  assert.ok(client.stderrTail().includes('SIGTERM 已收到但被忽略'), 'SIGTERM 确实送达并被忽略，证明退出由 SIGKILL 完成');
});

test('close 幂等且清理 pending', async () => {
  const client = await connect(ECHO);
  client.close();
  client.close(); // 幂等
  await assert.rejects(() => client.listTools(), /已关闭/);
});
