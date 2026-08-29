'use strict';

/**
 * bin/zsw.js CLI 入口测试（子进程黑盒）：参数解析、各子命令、--json 输出、
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-cli-'));
const BIN = path.join(__dirname, '..', 'bin', 'zsw.js');

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
  const r = await run(['start', '--local', '--task', 'x', '--slug', 'y', '--no-wait']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--no-wait 已移除/);
});

test('status/cancel 不存在的 id → exit 1，错误含恢复指引', async () => {
  const s = await run(['status', '--local', '--id', 'sa-nope']);
  assert.equal(s.code, 1);
  assert.match(s.stderr, /sa-nope" 不存在/);
  assert.match(s.stderr, /list/);
  const c = await run(['cancel', '--local', '--id', 'sa-nope']);
  assert.equal(c.code, 1);
  assert.match(c.stderr, /不存在/);
});

// --------------------------------------------------------------------- list

test('list --local → exit 0，stdout 为 JSON 数组', async () => {
  const r = await run(['list', '--local']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

// ----------------------------------------------- 默认 daemon 形态（1.0.0 起翻转）

test('默认 daemon 形态：daemon 未运行 → exit 1 + 可操作恢复指引（不静默降级 --local）', async () => {
  // 隔离 ZSW_SOCK 指向不存在路径：connect ENOENT 走 §5.2 第 1 行口径
  const r = await run(['list'], { ZSW_SOCK: path.join(TMP, 'no-daemon', 'daemon.sock') });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /daemon 未运行/);
  assert.match(r.stderr, /恢复指引/);
  assert.match(r.stderr, /--local/);
});

test('wait --local → 显式拒绝（wait 无本地模式）+ exit 1', async () => {
  const r = await run(['wait', '--local', '--id', 'x']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /wait 无本地模式/);
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

// MF1 起 abort/status/list/scripts 管理面默认经 daemon（daemon 形态覆盖见
// cli-workflow-daemon.test.js），本地断言走 --local；run/lint 恒本地。

test('workflow --action list --local → exit 0，JSON 含内置 workflow 名', async () => {
  const r = await run(['workflow', '--action', 'list', '--local']);
  assert.equal(r.code, 0);
  assert.ok(Array.isArray(JSON.parse(r.stdout)));
});

test('workflow --action scripts --local → exit 0，含 builtin 清单', async () => {
  const r = await run(['workflow', '--action', 'scripts', '--local']);
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

// ------------------------------------------------- F4 能力增量 flag（D5/D6）

// parseArgs/csv 纯解析单测：bin/zsw.js 以 require.main 守卫导出解析函数——
// 黑盒子进程测不到的 kebab→camel 映射与缺值布尔形态在此钉住
const { parseArgs, csv } = require('../bin/zsw.js');

test('F4 flag 解析：--thinking/--allow-tools/--deny-tools 的 kebab→camel 与值形态', () => {
  const a = parseArgs(['start', '--thinking', 'low', '--allow-tools', 'Read,Grep', '--deny-tools', 'Bash, WebSearch', '--task', 'x']);
  assert.equal(a.thinking, 'low');
  assert.equal(a.allowTools, 'Read,Grep');
  assert.equal(a.denyTools, 'Bash, WebSearch'); // 原样字符串，逗号拆分在 csv()
  assert.equal(a.task, 'x');
  // 缺值 → 布尔 true（thinkingArg/csvArg 的 warn 分支输入形态）
  const b = parseArgs(['start', '--thinking', '--task', 'x']);
  assert.equal(b.thinking, true);
  assert.equal(b.task, 'x');
  const c = parseArgs(['start', '--deny-tools']);
  assert.equal(c.denyTools, true);
  assert.deepEqual(csv('Bash, WebSearch ,,Grep'), ['Bash', 'WebSearch', 'Grep']); // 去空白、滤空段
  assert.equal(csv(undefined), undefined);
  assert.equal(csv(42), undefined);
});

test('F4 flag 黑盒：--thinking 缺值 → stderr warn + 忽略（容错不失败，daemon 模式可观测）', async () => {
  const r = await run(['start', '--thinking', '--task', 'x', '--slug', 'y'],
    { ZSW_SOCK: path.join(TMP, 'no-daemon', 'daemon.sock') });
  assert.equal(r.code, 1); // daemon 不在场照常报错（warn 不改变退出语义）
  assert.match(r.stderr, /--thinking 需要档位值/);
  assert.match(r.stderr, /已忽略该参数/);
  assert.match(r.stderr, /daemon 未运行/); // 后续路径不受影响
});

test('F4 flag 黑盒：--allow-tools/--deny-tools 缺值 → stderr warn + 忽略', async () => {
  const r = await run(['start', '--allow-tools', '--deny-tools', '--task', 'x', '--slug', 'y'],
    { ZSW_SOCK: path.join(TMP, 'no-daemon', 'daemon.sock') });
  // 两 flag 的 next 都以 -- 开头（parseArgs 缺值语义）→ 均为布尔 true → 均 warn
  assert.match(r.stderr, /--allow-tools 需要逗号分隔的工具名清单/);
  assert.match(r.stderr, /--deny-tools 需要逗号分隔的工具名清单/);
});

test('F4 flag 黑盒：合法档位值不触发缺值 warn', async () => {
  const r = await run(['start', '--thinking', 'low', '--task', 'x', '--slug', 'y'],
    { ZSW_SOCK: path.join(TMP, 'no-daemon', 'daemon.sock') });
  assert.doesNotMatch(r.stderr, /--thinking 需要档位值/);
  assert.match(r.stderr, /daemon 未运行/); // 仍走 daemon 报错路径（本测试不跑引擎）
});
