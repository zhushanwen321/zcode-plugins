'use strict';

/**
 * bin/zsub.js CLI 入口测试（子进程黑盒）：参数解析、各子命令、--json 输出、
 * usage/退出码。不跑真 zcode——只覆盖不需要 spawn 引擎的路径（list/status/
 * cancel/close/管理面 workflow action 与错误分支）。
 *
 * 隔离：ZSW_ROOT / ZCODE_MAILBOX_ROOT / HOME 指向临时目录（必须在 CLI
 * 子进程 env 里传入，config.js 在子进程加载期冻结路径）。
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-cli-'));
const BIN = path.join(__dirname, '..', 'bin', 'zsub.js');

function run(args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      {
        env: {
          ...process.env,
          ZSW_ROOT: path.join(TMP, 'zsub-root'),
          ZCODE_MAILBOX_ROOT: path.join(TMP, 'mailbox'),
          HOME: path.join(TMP, 'home'),
          ZCODE_PROJECT_DIR: TMP,
          ...extraEnv,
        },
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      },
    );
  });
}

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// ------------------------------------------------------------- usage / 退出码

test('无参数 → usage + exit 1', async () => {
  const r = await run([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /用法/);
});

test('未知子命令 → usage + exit 1', async () => {
  const r = await run(['frobnicate']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /未知子命令: frobnicate/);
});

test('start 缺 --task / --slug → usage + exit 1', async () => {
  const a = await run(['start']);
  assert.equal(a.code, 1);
  assert.match(a.stderr, /用法/);
  const b = await run(['start', '--task', '只有任务没有短名']);
  assert.equal(b.code, 1);
});

test('start --no-wait → 显式拒绝 + exit 1', async () => {
  const r = await run(['start', '--task', 'x', '--slug', 'y', '--no-wait']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--no-wait 已移除/);
});

test('status/cancel 不存在的 id → exit 1，错误含恢复指引', async () => {
  const s = await run(['status', '--id', 'sa-nope']);
  assert.equal(s.code, 1);
  assert.match(s.stderr, /sa-nope" 不存在/);
  assert.match(s.stderr, /list/);
  const c = await run(['cancel', '--id', 'sa-nope']);
  assert.equal(c.code, 1);
  assert.match(c.stderr, /不存在/);
});

// --------------------------------------------------------------------- list

test('list → exit 0，stdout 为 JSON 数组', async () => {
  const r = await run(['list']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

// ------------------------------------------------------------------ workflow

test('workflow --action 非法 → exit 1', async () => {
  const r = await run(['workflow', '--action', 'explode']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /不支持的 --action: explode/);
});

test('workflow run 缺必填参数 → exit 1 + workflow usage', async () => {
  const a = await run(['workflow']);
  assert.equal(a.code, 1);
  assert.match(a.stderr, /缺少 --workflow/);
  const b = await run(['workflow', '--workflow', 'chain']);
  assert.equal(b.code, 1);
  assert.match(b.stderr, /缺少 --task/);
  const c = await run(['workflow', '--workflow', 'chain', '--task', '做点事']);
  assert.equal(c.code, 1);
  assert.match(c.stderr, /缺少 --workdir/);
});

test('workflow --action list → exit 0，JSON 含内置 workflow 名', async () => {
  const r = await run(['workflow', '--action', 'list']);
  assert.equal(r.code, 0);
  assert.ok(Array.isArray(JSON.parse(r.stdout)));
});

test('workflow --action scripts → exit 0，含 builtin 清单', async () => {
  const r = await run(['workflow', '--action', 'scripts']);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.stdout);
  assert.ok(Array.isArray(j.builtin) && j.builtin.length >= 5);
});

test('workflow --action abort/status 缺 --id → exit 1', async () => {
  const a = await run(['workflow', '--action', 'abort']);
  assert.equal(a.code, 1);
  assert.match(a.stderr, /--id/);
  const s = await run(['workflow', '--action', 'status']);
  assert.equal(s.code, 1);
  assert.match(s.stderr, /--id/);
});

test('workflow --action lint 缺 --file → exit 1', async () => {
  const r = await run(['workflow', '--action', 'lint']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--file/);
});

test('workflow --action lint 对合法脚本 → exit 0 + ok JSON', async () => {
  const f = path.join(TMP, 'wf-ok.js');
  fs.writeFileSync(f, `'use strict';
module.exports = {
  name: 'demo',
  description: '演示脚本',
  async run() { return { final: 'done' }; },
};
`);
  const r = await run(['workflow', '--action', 'lint', '--file', f]);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
});
