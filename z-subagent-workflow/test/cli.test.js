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

// ---------------------------------- review-fix-loop v2 CLI 冒烟（零引擎）

// 探针脚本（模块顶层创建，发现根 = ZCODE_PROJECT_DIR = TMP；清理走文件级
// after 的 TMP 整删）：run(ctx) 把收到的 ctx.params 塞进返回 json——manager
// 剥壳后原样透传给脚本 ctx.params，CLI 组参形态（batchN 数组、透传键）由此
// 端到端断言；脚本不调 runAgent，全程零引擎 spawn。
const WF_DIR = path.join(TMP, '.agents', 'workflows');
fs.mkdirSync(WF_DIR, { recursive: true });
fs.writeFileSync(path.join(WF_DIR, 'params-probe.js'), `'use strict';
module.exports = {
  name: 'params-probe',
  description: '测试探针：回显收到的 params',
  async run(ctx) { return { markdown: 'probe', json: { params: ctx.params } }; },
};
`);

/** 从 CLI 默认输出（markdown 报告 + 摘要两段）提取脚本返回的 ```json 机器段。 */
function probeParams(stdout) {
  const fenced = stdout.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(fenced, '报告应含 ```json 机器段（脚本返回的 json）');
  return JSON.parse(fenced[1]).params;
}

test('v2 冒烟：batchN csv 转数组抵达入口参数（防透传覆写回归）', async () => {
  const r = await run(['workflow', '--workflow', 'script:params-probe', '--task', '探针',
    '--workdir', TMP, '--batch1', 'correctness,robustness', '--batch2', 'security']);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const params = probeParams(r.stdout);
  // 修复前：batchN 循环先 csv 成数组，透传循环又用原始字符串覆写回 params——
  // 数组形态永远到不了入口。deepEqual 数组同时排除字符串形态回归。
  assert.deepEqual(params.batch1, ['correctness', 'robustness']);
  assert.deepEqual(params.batch2, ['security']);
});

test('v2 冒烟：未映射 flag 原样透传抵达入口参数（白名单可见面）', async () => {
  const r = await run(['workflow', '--workflow', 'script:params-probe', '--task', '探针',
    '--workdir', TMP, '--totally-unknown-flag', 'x']);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const params = probeParams(r.stdout);
  assert.equal(params.totallyUnknownFlag, 'x'); // parseArgs camelCase 化后透传
});

test('v2 冒烟：透传的未知键被 review-fix-loop 入口白名单拒绝（exit 1 + 可操作文案）', async () => {
  // 拼错 flag（--stuck-threshld）不在 CLI 映射面 → 原样透传 → 入口
  // normalizeParams 白名单报错（先于一切引擎派发，零 spawn 快速失败）
  const r = await run(['workflow', '--workflow', 'review-fix-loop', '--task', '白名单冒烟',
    '--workdir', TMP, '--batch1', 'correctness', '--stuck-threshld', '2']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /收到未知参数/); // 报错文案随 error 报告落 stdout 双段
  assert.match(r.stdout, /stuckThreshld/); // 指向透传后的实际键名（可操作）
});
