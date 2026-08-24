'use strict';

/**
 * lib/cli-client.js 单测（DESIGN-v4 D2，M0）：假 daemon（node:test 内起
 * net.Server 监听临时 unix sock）协议往返、ok:false 透传、connect 失败的
 * 可操作文案、帧宽容性（多余换行/前后空白/无尾换行）。不依赖真 daemon、
 * manager 与 lib/daemon-socket（并行开发中，本层自带最小帧编解码）。
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { callDaemon, defaultSockPath } = require('../lib/cli-client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-cliclient-'));
let seq = 0;
const tmpSock = (name) => path.join(TMP, `${name}-${seq += 1}.sock`);

/** 起假 daemon：onFrame(request) 返回要写回 socket 的原始字符串（帧）。 */
function startFakeDaemon(onFrame) {
  return new Promise((resolve) => {
    const sockPath = tmpSock('daemon');
    const server = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl === -1) return; // 半截请求帧：等下一段 data
        const req = JSON.parse(buf.slice(0, nl));
        buf = '';
        conn.write(onFrame(req));
      });
    });
    server.listen(sockPath, () => resolve({ server, sockPath }));
  });
}

const frame = (obj) => `${JSON.stringify(obj)}\n`;

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// ------------------------------------------------------------ 协议往返（验收 a）

test('协议往返：请求帧 {id,tool,params,cwd}，响应 ok:true → resolve {ok,result}', async () => {
  let seen = null;
  const d = await startFakeDaemon((req) => {
    seen = req;
    return frame({ id: req.id, ok: true, result: { tasks: [], note: 'ok' } });
  });
  const r = await callDaemon({ sockPath: d.sockPath, tool: 'zsub', params: { action: 'list' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { tasks: [], note: 'ok' });
  assert.equal(r.error, undefined);
  // 请求帧契约：tool/params 原样到达，id 存在（单请求单响应，值不限）
  assert.equal(seen.tool, 'zsub');
  assert.deepEqual(seen.params, { action: 'list' });
  assert.ok(Number.isInteger(seen.id));
  d.server.close();
});

// ------------------------------------------------------- 帧cwd 缺省与覆盖（MF7）

test('请求帧 cwd：缺省 = CLI 侧 process.cwd()；显式传入可覆盖；非 string 回落缺省', async () => {
  // 逐 case 各起一个假 daemon（startFakeDaemon 的闭包 seen 一次一测）
  for (const [cwdArg, expect] of [
    [undefined, process.cwd()],
    ['/tmp/zsw-wt-override', '/tmp/zsw-wt-override'],
    ['', process.cwd()],       // 空串 = 视为缺省
    [123, process.cwd()],      // 非 string = 视为缺省（daemon 侧仅接受 string）
  ]) {
    let seen = null;
    const d = await startFakeDaemon((req) => {
      seen = req;
      return frame({ id: req.id, ok: true, result: {} });
    });
    const r = await callDaemon({ sockPath: d.sockPath, tool: 'zsub', params: { action: 'list' }, cwd: cwdArg });
    assert.equal(r.ok, true);
    assert.equal(seen.cwd, expect, `cwd=${JSON.stringify(cwdArg)} 应帧传导 ${expect}`);
    assert.equal(typeof seen.cwd, 'string', '帧 cwd 恒为 string（协议契约）');
    d.server.close();
  }
});

test('ok:false 帧 → 正常 resolve {ok:false,error}（业务失败不是传输层异常）', async () => {
  const d = await startFakeDaemon((req) => frame({
    id: req.id,
    ok: false,
    error: { code: -32000, message: '任务 "sa-x" 不存在。恢复指引：先 list 查 id' },
  }));
  const r = await callDaemon({ sockPath: d.sockPath, tool: 'zsub', params: { action: 'status', subagentId: 'sa-x' } });
  assert.equal(r.ok, false);
  assert.equal(r.result, undefined);
  assert.equal(r.error.code, -32000);
  assert.match(r.error.message, /不存在/);
  d.server.close();
});

// ---------------------------------------------------- connect 失败（验收 c）

test('connect 失败（sock 不存在，ENOENT）→ throw 文案含恢复指引', async () => {
  const absent = path.join(TMP, 'absent.sock');
  await assert.rejects(
    () => callDaemon({ sockPath: absent, tool: 'zsub', params: { action: 'list' }, connectTimeoutMs: 2000 }),
    (err) => /daemon 未运行/.test(err.message)
      && /稍候重试/.test(err.message)
      && /插件已启用/.test(err.message)
      && /ENOENT/.test(err.message),
  );
});

test('connect 失败（SIGKILL 残留的 sock 文件，ECONNREFUSED）→ 同款可操作文案', async () => {
  const stale = path.join(TMP, 'stale.sock');
  // 子进程 bind 后 SIGKILL：异常死亡不走退出卫生，sock 文件残留——
  // 正是 §5.2 看门狗接管窗口内 CLI 看到的形态（本 Node 版本 server.close
  // 会自动 unlink，无法用同进程 close 构造）
  const holder = spawn(process.execPath, ['-e',
    `const net=require('node:net');const s=net.createServer(()=>{});`
    + `s.listen(${JSON.stringify(stale)},()=>console.log('ready'));`,
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => {
    holder.stdout.on('data', (c) => { if (String(c).includes('ready')) resolve(); });
  });
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.on('exit', resolve));
  assert.equal(fs.existsSync(stale), true);
  await assert.rejects(
    () => callDaemon({ sockPath: stale, tool: 'zsub', params: { action: 'list' }, connectTimeoutMs: 2000 }),
    (err) => /daemon 未运行/.test(err.message) && /ECONNREFUSED/.test(err.message),
  );
});

test('connect 失败（sock 路径被普通文件占用，ENOTSOCK）→ 同款可操作文案', async () => {
  const plain = path.join(TMP, 'plain.sock');
  fs.writeFileSync(plain, 'x');
  await assert.rejects(
    () => callDaemon({ sockPath: plain, tool: 'zsub', params: { action: 'list' }, connectTimeoutMs: 2000 }),
    (err) => /daemon 未运行/.test(err.message) && /ENOTSOCK/.test(err.message),
  );
});

// ------------------------------------------------------- 帧宽容性（验收 d）

test('响应帧含多余换行与前后空白 → 仍能解出', async () => {
  const d = await startFakeDaemon(() => `\n\n   \n  ${JSON.stringify({ id: 1, ok: true, result: { partial: false } })}  \n\n`);
  const r = await callDaemon({ sockPath: d.sockPath, tool: 'zsub', params: { action: 'wait', ids: ['sa-1'] } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { partial: false });
  d.server.close();
});

test('无布尔 ok 字段的 JSON 行（非响应帧）被跳过，取首个合法响应帧', async () => {
  const payload = JSON.stringify({ id: 1, ok: true, result: { fine: 1 } });
  const d = await startFakeDaemon(() => `${JSON.stringify({ log: 'noise' })}\n${frame({ id: 1 })}${payload}\n`);
  const r = await callDaemon({ sockPath: d.sockPath, tool: 'zsub', params: { action: 'list' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { fine: 1 });
  d.server.close();
});

test('对端写帧后即关闭（无尾换行）→ close 兜底解出，不误报断连', async () => {
  const d = await new Promise((resolve) => {
    const sockPath = tmpSock('nolf');
    const server = net.createServer((conn) => {
      conn.on('data', () => conn.end(JSON.stringify({ id: 1, ok: true, result: { via: 'close-fallback' } })));
    });
    server.listen(sockPath, () => resolve({ server, sockPath }));
  });
  const r = await callDaemon({ sockPath: d.sockPath, tool: 'zsub', params: { action: 'list' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { via: 'close-fallback' });
  d.server.close();
});

test('对端未回帧即关闭 → throw 含 daemon 终止恢复指引的可操作错误', async () => {
  const d = await new Promise((resolve) => {
    const sockPath = tmpSock('silent');
    const server = net.createServer((conn) => {
      conn.on('data', () => conn.end());
    });
    server.listen(sockPath, () => resolve({ server, sockPath }));
  });
  await assert.rejects(
    () => callDaemon({ sockPath: d.sockPath, tool: 'zsub', params: { action: 'wait', ids: ['sa-1'] } }),
    (err) => /daemon 连接中断/.test(err.message) && /status --id/.test(err.message),
  );
  d.server.close();
});

// --------------------------------------------------------- sockPath 缺省解析

test('defaultSockPath：ZSW_SOCK 覆盖 > ~/.zcode/zsw/daemon.sock', () => {
  const prev = process.env.ZSW_SOCK;
  try {
    delete process.env.ZSW_SOCK;
    assert.equal(defaultSockPath(), path.join(os.homedir(), '.zcode', 'zsw', 'daemon.sock'));
    process.env.ZSW_SOCK = path.join(TMP, 'override.sock');
    assert.equal(defaultSockPath(), path.join(TMP, 'override.sock'));
  } finally {
    if (prev === undefined) delete process.env.ZSW_SOCK;
    else process.env.ZSW_SOCK = prev;
  }
});
