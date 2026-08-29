'use strict';

/**
 * bin/zsw.js 的 zsub 面 daemon 路径参数映射测试（R7）：message / close /
 * agents / models 四个子命令此前零测试触达——agents/models 是 1.0.0 工具面
 * 下线后查询 agent 名与模型清单的唯一 CLI 入口，字段拼错（如 subagentId vs
 * id）单测全绿但用户拿到错结果。子进程黑盒 + 假 daemon socket server
 * （写法参照 cli-workflow-daemon.test.js）。
 *
 * 隔离：ZSW_ROOT / ZCODE_MAILBOX_ROOT / HOME / ZSW_SOCK 指向临时目录。
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-cli-zsub-'));
const BIN = path.join(__dirname, '..', 'bin', 'zsw.js');
const NO_DAEMON_SOCK = path.join(TMP, 'no-daemon', 'daemon.sock');

let sockSeq = 0;

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
          ZSW_NESTED: '', // 显式清掉宿主可能的标记，用例按需覆盖（对齐 cli.test.js——嵌套宿主下 message 子命令会被 ensureNotNested 拦截误红）
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

/** 起假 daemon：记录全部请求帧，onFrame(req) 返回响应对象（不含 id）。 */
function startFakeDaemon(onFrame) {
  return new Promise((resolve) => {
    const sockPath = path.join(TMP, `fake-${sockSeq += 1}.sock`);
    const seen = [];
    const server = net.createServer((conn) => {
      let buf = Buffer.alloc(0);
      conn.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const nl = buf.indexOf(0x0a);
        if (nl === -1) return; // 半截请求帧：等下一段 data
        const req = JSON.parse(buf.subarray(0, nl).toString('utf8'));
        buf = Buffer.alloc(0);
        seen.push(req);
        conn.write(`${JSON.stringify({ id: req.id, ...onFrame(req) })}\n`);
      });
    });
    server.listen(sockPath, () => resolve({ server, sockPath, seen }));
  });
}

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

test('message --id --text → {action:"message",subagentId,text} 且打印 round/notify 句柄', async () => {
  const d = await startFakeDaemon(() => ({
    ok: true,
    result: { subagentId: 'sa-1', status: 'running', round: 2, notify: 'none' },
  }));
  const r = await run(['message', '--id', 'sa-1', '--text', '追问细节'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 0);
  assert.equal(d.seen[0].tool, 'zsub');
  assert.deepEqual(d.seen[0].params, { action: 'message', subagentId: 'sa-1', text: '追问细节' });
  assert.equal(JSON.parse(r.stdout).round, 2);
  d.server.close();
});

test('close --id → {action:"close",subagentId}（CLI flag --id 映射为 subagentId）', async () => {
  const d = await startFakeDaemon(() => ({
    ok: true,
    result: { subagentId: 'sa-2', status: 'closed', worktreeCleaned: null, worktreeError: null },
  }));
  const r = await run(['close', '--id', 'sa-2'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 0);
  assert.deepEqual(d.seen[0].params, { action: 'close', subagentId: 'sa-2' });
  assert.equal(JSON.parse(r.stdout).status, 'closed');
  d.server.close();
});

test('agents → {action:"agents"}（M1 后唯一 agent 清单入口），结果原样打印', async () => {
  const d = await startFakeDaemon(() => ({
    ok: true,
    result: [{ name: 'reviewer', description: '审查', source: 'project-agents', file: '/x/reviewer.md' }],
  }));
  const r = await run(['agents'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 0);
  assert.deepEqual(d.seen[0].params, { action: 'agents' });
  assert.equal(JSON.parse(r.stdout)[0].name, 'reviewer');
  d.server.close();
});

test('models → {action:"models"}（M1 后唯一模型清单入口）', async () => {
  const d = await startFakeDaemon(() => ({
    ok: true,
    result: { provider: 'zcode', models: [{ name: 'm1' }], guidance: '按需选择' },
  }));
  const r = await run(['models'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 0);
  assert.deepEqual(d.seen[0].params, { action: 'models' });
  assert.equal(JSON.parse(r.stdout).provider, 'zcode');
  d.server.close();
});

test('message 缺 --text → daemon 报业务错误（参数校验在 daemon 侧 handler）exit 1', async () => {
  const d = await startFakeDaemon(() => ({
    ok: false,
    error: { message: 'message 需要 text（非空字符串，续聊消息内容）。' },
  }));
  const r = await run(['message', '--id', 'sa-1'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /需要 text/);
  d.server.close();
});
