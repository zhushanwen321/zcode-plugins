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
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { PROVIDER_ID } = require('../lib/model-router');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-cli-'));
const BIN = path.join(__dirname, '..', 'bin', 'zsw.js');
const HOOK_BIN = path.join(__dirname, '..', 'bin', 'zsw-hook.js'); // delegator 一致性对照入口
const HOOK_HOME = path.join(TMP, 'hook-home'); // hook 用例 fixture home（不动默认 HOME）

fs.mkdirSync(path.join(HOOK_HOME, '.zcode', 'v2'), { recursive: true });
fs.mkdirSync(path.join(HOOK_HOME, '.zcode', 'cli'), { recursive: true });
fs.writeFileSync(
  path.join(HOOK_HOME, '.zcode', 'v2', 'config.json'),
  JSON.stringify({
    model: { main: `${PROVIDER_ID}/GLM-5.3-Flash` },
    provider: {
      [PROVIDER_ID]: { models: { 'GLM-5.3': {}, 'GLM-5.3-Flash': {} } },
      'prov-a': { options: { apiKey: 'k-a' }, models: { m1: {} } },
    },
  }),
);
fs.writeFileSync(
  path.join(HOOK_HOME, '.zcode', 'cli', 'config.json'),
  JSON.stringify({ model: { main: `${PROVIDER_ID}/GLM-5.3-Flash` } }),
);

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
          ZSW_NESTED: '', // 显式清掉宿主可能的标记，用例按需覆盖
          XYZ_AGENT_SUBAGENT: '', // F03：core 引擎嵌套标记同款清掉（嵌套宿主下跑测试防误拒）
          ...extraEnv,
        },
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      },
    );
  });
}

/** 起假 daemon：记录全部请求帧，onFrame(req) 返回响应对象（不含 id）。写法同 cli-daemon-zsub.test.js。 */
function startFakeDaemon(onFrame) {
  return new Promise((resolve) => {
    const sockPath = path.join(TMP, `fake-${process.pid}.sock`);
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

/** 真跑任一 hook 入口（bin 参数化），返回 {code, stdout, stderr}。 */
function runHook(binPath, args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [binPath, ...args],
      {
        cwd: TMP,
        env: {
          ...process.env,
          HOME: HOOK_HOME,
          ZSW_NESTED: '',
          XYZ_AGENT_SUBAGENT: '', // F03：core 引擎嵌套标记同款清掉
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

// S-11：lib/workflow-actions.js 收口契约锚点（MF-1 搬移后 CLI/MCP 两入口的
// 共享创作面）——导出形状断言，防止导出面漂移把入口 require 变静默 undefined
test('lib/workflow-actions 导出面形状（收口契约锚点）', () => {
  const wa = require('../lib/workflow-actions');
  for (const name of [
    'validateWorkflowRef', 'knownWorkflowNames', 'scriptGenerateAction',
    'scriptSaveAction', 'scriptDeleteAction', 'runningScriptPredicate',
    'requireScriptActionName',
  ]) {
    assert.equal(typeof wa[name], 'function', `导出 ${name} 须为函数`);
  }
});

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

test('workflow --action lint 对合法脚本 → exit 0 + valid JSON（core lintScript）', async () => {
  // core 契约好脚本：@pi-meta 块 + agent() 入口（lint 的两项硬检查）
  const f = path.join(TMP, 'wf-ok.js');
  fs.writeFileSync(f, `/* @pi-meta
name: demo
description: 演示脚本
phases: [run]
*/
await agent({ prompt: 'x' });
return { final: 'done' };
`);
  const r = await run(['workflow', '--action', 'lint', '--file', f]);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.valid, true);
  // 无 error 级 finding（warning 级如 agent() 缺 description 允许存在）
  assert.ok(!j.findings.some((x) => x.severity === 'error'), JSON.stringify(j.findings));
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

// ---------------------------------- workflow CLI 参数透传冒烟（零引擎，core 契约）

// 探针脚本（模块顶层创建，发现根 = TMP/.agents/workflows = core 发现面的
// project-agents 根；清理走文件级 after 的 TMP 整删）：core worker 契约，
// $ARGS 原样塞进 scriptResult——host 剥壳后组进 $ARGS 的 CLI 组参形态
// （batchN 数组、透传键）由此端到端断言。agent() 调用挂在 $ARGS.callAgent
// 条件下：满足 lint 静态检查（必须含 agent() 入口）但运行时不触发，
// 全程零引擎 spawn。
const WF_DIR = path.join(TMP, '.agents', 'workflows');
fs.mkdirSync(WF_DIR, { recursive: true });
fs.writeFileSync(path.join(WF_DIR, 'params-probe.js'), `/* @pi-meta
name: params-probe
description: 测试探针回显 $ARGS
phases: [run]
*/
if ($ARGS.callAgent === true) {
  await agent({ prompt: 'probe' });
}
return { status: 'ok', params: $ARGS };
`);

/** 从 CLI 默认输出（markdown 报告 + 摘要两段）提取 scriptResult 的 ```json 机器段。 */
function probeParams(stdout) {
  const fenced = stdout.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(fenced, '报告应含 ```json 机器段（scriptResult 的非 message 字段）');
  return JSON.parse(fenced[1]).params;
}

/** 用户脚本的路径引用形态（D-4：script: 拒收；D-E3 起内置名/saved 裸名/.js 绝对路径合法）。 */
const PROBE_JS = path.join(WF_DIR, 'params-probe.js');

// HOME saved 根 fixture（~/.zsw/workflows = script-save 落盘目录；run() 的 env
// HOME 指向 TMP/home）：D-E3 saved 裸名放行的第二发现根（discoveryRoots 注入
// 槽）断言面。零引擎形态同 params-probe。
const SAVED_DIR = path.join(TMP, 'home', '.zsw', 'workflows');
fs.mkdirSync(SAVED_DIR, { recursive: true });
fs.writeFileSync(path.join(SAVED_DIR, 'saved-probe.js'), `/* @pi-meta
name: saved-probe
description: HOME saved 根按名引用探针
phases: [run]
*/
if ($ARGS.callAgent === true) {
  await agent({ prompt: 'probe' });
}
return { status: 'ok', params: $ARGS };
`);

test('冒烟：batchN csv 转数组抵达 $ARGS（防透传覆写回归）', async () => {
  const r = await run(['workflow', '--workflow', PROBE_JS, '--task', '探针',
    '--workdir', TMP, '--batch1', 'correctness,robustness', '--batch2', 'security']);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const params = probeParams(r.stdout);
  // 修复前（旧线）：batchN 循环先 csv 成数组，透传循环又用原始字符串覆写——
  // 数组形态永远到不了入口。deepEqual 数组同时排除字符串形态回归。
  assert.deepEqual(params.batch1, ['correctness', 'robustness']);
  assert.deepEqual(params.batch2, ['security']);
});

test('冒烟：未映射 flag 原样透传抵达 $ARGS（用户脚本形态无白名单）', async () => {
  const r = await run(['workflow', '--workflow', PROBE_JS, '--task', '探针',
    '--workdir', TMP, '--totally-unknown-flag', 'x']);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const params = probeParams(r.stdout);
  assert.equal(params.totallyUnknownFlag, 'x'); // parseArgs camelCase 化后透传
});

test('workflow 引用契约（D-4/D-E3）：script: 前缀拒收；saved 裸名放行（workspace 根 + HOME saved 根）；未知裸名仍拒', async () => {
  // script: 前缀（旧形态）：拒绝且指路（内置名/绝对路径/scripts 清单）
  const prefixed = await run(['workflow', '--workflow', 'script:params-probe', '--task', 't', '--workdir', TMP]);
  assert.equal(prefixed.code, 1);
  assert.match(prefixed.stderr, /Invalid workflow ref/);
  assert.match(prefixed.stderr, /script: 前缀/);
  assert.match(prefixed.stderr, /绝对路径/);
  assert.match(prefixed.stderr, /恢复指引/);
  // D-E3 裁决：saved 裸名放行（knownNames = 内置 5 + 发现面 saved 名；旧
  // 「多源同名遮蔽下按名引用有歧义」的拒收线撤销）。workspace 根按名 run 成功
  const bare = await run(['workflow', '--workflow', 'params-probe', '--task', '探针', '--workdir', TMP]);
  assert.equal(bare.code, 0, `stderr: ${bare.stderr}`);
  assert.equal(probeParams(bare.stdout).task, '探针');
  // HOME saved 根（~/.zsw/workflows = script-save 落盘目录）按名 run 成功
  const saved = await run(['workflow', '--workflow', 'saved-probe', '--task', '探针', '--workdir', TMP]);
  assert.equal(saved.code, 0, `stderr: ${saved.stderr}`);
  assert.equal(probeParams(saved.stdout).task, '探针');
  // 未知裸名（knownNames = 内置 + 发现面 saved 名，不含 no-such-wf-name）仍拒
  const unknown = await run(['workflow', '--workflow', 'no-such-wf-name', '--task', 't', '--workdir', TMP]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Invalid workflow ref/);
  assert.match(unknown.stderr, /不是内置名或已保存脚本名/);
  // 非 .js 绝对路径（R2 修复：入口拦截而非放行到 host 层报「脚本不可用」——
  // 与 agent 线 normalizeAgentRef 的 .md 严格校验对称）
  const notJs = await run(['workflow', '--workflow', '/tmp/notes.txt', '--task', 't', '--workdir', TMP]);
  assert.equal(notJs.code, 1);
  assert.match(notJs.stderr, /Invalid workflow ref/);
  assert.match(notJs.stderr, /不是 \.js 脚本路径/);
  const tildeNotJs = await run(['workflow', '--workflow', '~/notes.txt', '--task', 't', '--workdir', TMP]);
  assert.equal(tildeNotJs.code, 1);
  assert.match(tildeNotJs.stderr, /不是 \.js 脚本路径/);
  // U2：parent_segment（含 ".." 段的 .js 路径）单独点名真实拒绝原因（安全
  // 语义拒绝），不得混入 bad_ext/not_absolute 专属的「不是 .js 脚本路径」文案
  const parentSeg = await run(['workflow', '--workflow', '/tmp/a/../evil.js', '--task', 't', '--workdir', TMP]);
  assert.equal(parentSeg.code, 1);
  assert.match(parentSeg.stderr, /Invalid workflow ref/);
  assert.match(parentSeg.stderr, /路径段 "\.\." 不允许/);
  assert.match(parentSeg.stderr, /恢复指引/);
  assert.doesNotMatch(parentSeg.stderr, /不是 \.js 脚本路径/);
  const tildeParentSeg = await run(['workflow', '--workflow', '~/workflows/../evil.js', '--task', 't', '--workdir', TMP]);
  assert.equal(tildeParentSeg.code, 1);
  assert.match(tildeParentSeg.stderr, /路径段 "\.\." 不允许/);
});

// ------------------------------------- W8 创作闭环（script-generate/save/delete）

// 创作闭环用例的合法源码样本（与 params-probe 同款零引擎形态：agent() 调用挂
// 在 $ARGS.callAgent 条件下，满足 generate 的 agent() 必需闸但运行时不触发）
const CREATIVE_SRC = `/* @pi-meta
name: w8-loop
description: 创作闭环探针
phases: [run]
*/
if ($ARGS.callAgent === true) {
  await agent({ prompt: 'probe' });
}
return { status: 'ok' };
`;

test('创作闭环：ESM 版拒（core 同源文案）→ YAML round-trip 拒（含行列）→ 合法 generate 落 tmp → lint → save 固化 → scripts 列出 → delete 清理', async () => {
  // ① ESM 错误版被拒（五道闸第一闸；文案与 pi 侧 core 管线逐字同源）
  const esm = await run(['workflow', '--action', 'script-generate', '--name', 'w8-loop',
    '--script', `import { x } from "y";\nconst r = await agent({ prompt: "p" });\nreturn r;\n`]);
  assert.equal(esm.code, 1);
  assert.match(esm.stderr, /ESM 'import' syntax/);
  assert.match(esm.stderr, /use require\(\) instead/);

  // ② @pi-meta YAML 破损版被拒：round-trip 闸报行列（自纠正锚点）
  const badYaml = await run(['workflow', '--action', 'script-generate', '--name', 'w8-loop',
    '--script', `/* @pi-meta\nname: w8-loop\n  description: [broken\nphases: [run]\n*/\nconst r = await agent({ prompt: "p" });\nreturn r;\n`]);
  assert.equal(badYaml.code, 1);
  assert.match(badYaml.stderr, /cannot be parsed \(line \d+, col \d+\)/);

  // ③ 修正版 generate：五道闸通过，落 tmp（zsw 布局 ~/.zsw/workflows/.tmp）
  const gen = await run(['workflow', '--action', 'script-generate', '--name', 'w8-loop', '--script', CREATIVE_SRC]);
  assert.equal(gen.code, 0, `stderr: ${gen.stderr}`);
  const genOut = JSON.parse(gen.stdout);
  const tmpPath = path.join(TMP, 'home', '.zsw', 'workflows', '.tmp', 'w8-loop.js');
  assert.equal(genOut.path, tmpPath);
  assert.ok(fs.existsSync(tmpPath), 'tmp 脚本应已落盘');

  // ④ lint 过（tmp 路径直接校验）
  const lint = await run(['workflow', '--action', 'lint', '--file', tmpPath]);
  assert.equal(lint.code, 0, `stderr: ${lint.stderr}`);
  assert.equal(JSON.parse(lint.stdout).valid, true);

  // ⑤ save：tmp → ~/.zsw/workflows/ 固化，tmp 消失（--local：本地一次性执行）
  const saved = await run(['workflow', '--action', 'script-save', '--name', 'w8-loop', '--local']);
  assert.equal(saved.code, 0, `stderr: ${saved.stderr}`);
  const savedPath = path.join(TMP, 'home', '.zsw', 'workflows', 'w8-loop.js');
  assert.equal(JSON.parse(saved.stdout).savedPath, savedPath);
  assert.ok(fs.existsSync(savedPath));
  assert.equal(fs.existsSync(tmpPath), false, 'save 后 tmp 应消失（rename 语义）');

  // ⑥ scripts 清单互通：save 后用户脚本列表可见（--local）
  const scripts = await run(['workflow', '--action', 'scripts', '--local']);
  assert.equal(scripts.code, 0);
  const users = JSON.parse(scripts.stdout).scripts;
  assert.ok(users.some((s) => s.name === 'w8-loop' && s.path === savedPath), 'save 后 scripts 应列出固化脚本');

  // ⑦ delete 清理：saved 文件删除，scripts 不再列出
  const del = await run(['workflow', '--action', 'script-delete', '--name', 'w8-loop', '--local']);
  assert.equal(del.code, 0, `stderr: ${del.stderr}`);
  assert.match(del.stdout, /Deleted workflow 'w8-loop'/);
  assert.equal(fs.existsSync(savedPath), false);
  const scriptsAfter = JSON.parse((await run(['workflow', '--action', 'scripts', '--local'])).stdout).scripts;
  assert.ok(!scriptsAfter.some((s) => s.name === 'w8-loop'));
});

test('script-save：重名拒绝（tmp 已固化同名时不覆盖）+ tmp 缺失可操作报错', async () => {
  // 生成并固化一次
  await run(['workflow', '--action', 'script-generate', '--name', 'w8-dup', '--script', CREATIVE_SRC]);
  await run(['workflow', '--action', 'script-save', '--name', 'w8-dup', '--local']);
  const savedPath = path.join(TMP, 'home', '.zsw', 'workflows', 'w8-dup.js');
  const before = fs.readFileSync(savedPath, 'utf8');
  // 再次生成同名 tmp 后 save：重名拒绝（core 契约：不静默覆盖）
  await run(['workflow', '--action', 'script-generate', '--name', 'w8-dup', '--script', CREATIVE_SRC]);
  const dup = await run(['workflow', '--action', 'script-save', '--name', 'w8-dup', '--local']);
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /already exists/);
  assert.equal(fs.readFileSync(savedPath, 'utf8'), before, '重名拒绝不得改动已固化文件');
  // tmp 缺失：可操作报错（指引先生成）
  const noTmp = await run(['workflow', '--action', 'script-save', '--name', 'w8-never', '--local']);
  assert.equal(noTmp.code, 1);
  assert.match(noTmp.stderr, /not found/);
  assert.match(noTmp.stderr, /script-generate/);
  // 收尾清理：delete 按 tmp→saved 顺序逐个删（tmp 与 saved 并存时需两次）
  await run(['workflow', '--action', 'script-delete', '--name', 'w8-dup', '--local']); // 先清 tmp
  await run(['workflow', '--action', 'script-delete', '--name', 'w8-dup', '--local']); // 再清 saved
  assert.equal(fs.existsSync(savedPath), false);
});

test('script-save/script-delete 默认经 daemon：帧形态 params={action,name}；缺 name 在组帧前拒绝', async () => {
  const d = await startFakeDaemon(() => ({ ok: true, result: { name: 'w8-frame', message: 'fake' } }));
  // 先 generate 落 tmp（恒本地，不经 daemon），save/delete 走 daemon 帧
  await run(['workflow', '--action', 'script-generate', '--name', 'w8-frame', '--script', CREATIVE_SRC]);
  const saved = await run(['workflow', '--action', 'script-save', '--name', 'w8-frame'], { ZSW_SOCK: d.sockPath });
  assert.equal(saved.code, 0, `stderr: ${saved.stderr}`);
  assert.equal(d.seen[0].tool, 'zflow');
  assert.deepEqual(d.seen[0].params, { action: 'script-save', name: 'w8-frame' });
  const deleted = await run(['workflow', '--action', 'script-delete', '--name', 'w8-frame'], { ZSW_SOCK: d.sockPath });
  assert.equal(deleted.code, 0);
  assert.equal(d.seen[1].tool, 'zflow');
  assert.deepEqual(d.seen[1].params, { action: 'script-delete', name: 'w8-frame' });
  // 缺 --name：CLI 侧组帧前拒绝（daemon/--local 两形态同文案）
  const noName = await run(['workflow', '--action', 'script-save'], { ZSW_SOCK: d.sockPath });
  assert.equal(noName.code, 1);
  assert.match(noName.stderr, /需要 name/);
  d.server.close();
});

test('冒烟：内置 workflow 的未知键被 host 前置拦截（stderr warning + 不进 $ARGS）', async () => {
  // 零引擎约束：--target-type bogus 让 review-fix-loop 资产在 agent() 派发前
  // fail-fast（TARGET_TYPES 枚举校验），杜绝真实引擎 spawn；拼错 flag
  // （--stuck-threshld）不在 CLI 映射面 → 透传 → host normalizeRunParams 对
  // 内置形态出显式 warning（旧线入口白名单报错的等价承接面：不静默丢弃、
  // 指认实际键名）
  const r = await run(['workflow', '--workflow', 'review-fix-loop', '--task', '白名单冒烟',
    '--workdir', TMP, '--target-type', 'bogus', '--batch1', 'x', '--stuck-threshld', '2']);
  assert.equal(r.code, 1); // 资产 fail-fast（reason=failed）
  assert.match(r.stderr, /stuckThreshld/); // warning 指向透传后的实际键名（可操作）
  assert.match(r.stderr, /不被内置 workflow "review-fix-loop" 消费/);
});

// ------------------------------------------- F-A7：--local 嵌套盲区（MF2 补洞）

test('ZSW_NESTED=1：start --local 被拒（exit 1 + 恢复指引），与 daemon 路径同文案', async () => {
  // 修复前：仅 runDaemonCommand / runWorkflowCommand 有 ensureNotNested，
  // 嵌套子会话内 --local start 绕过防递归边界 spawn 真实引擎进程
  const local = await run(['start', '--local', '--task', 'x', '--slug', 'y'], { ZSW_NESTED: '1' });
  assert.equal(local.code, 1);
  assert.match(local.stderr, /嵌套环境禁止编排/);
  assert.match(local.stderr, /恢复指引/);
  // 对照 daemon 路径（既有守卫）：同 env 同文案同退出码——两路径共用
  // ensureNotNested，防递归边界无旁路（ensureNotNested 在 callDaemon 之前，
  // 无需 daemon 在场）
  const daemon = await run(['list'], { ZSW_NESTED: '1' });
  assert.equal(daemon.code, 1);
  assert.match(daemon.stderr, /嵌套环境禁止编排/);
});

test('XYZ_AGENT_SUBAGENT=1（core 引擎嵌套标记）：CLI 同款拒绝（F03 双标记判定）', async () => {
  // core 引擎 spawn 的 zcode 子进程只带 XYZ_AGENT_SUBAGENT=1（ZSW_NESTED 被剥
  // 离）——只查 ZSW_NESTED 时嵌套派发会话内的 CLI 面第二重门禁失效
  const r = await run(['list'], { ZSW_NESTED: '', XYZ_AGENT_SUBAGENT: '1' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /嵌套环境禁止编排（防递归，ZSW_NESTED=1 或 XYZ_AGENT_SUBAGENT=1）/);
});

// ------------------------------------------------- models --all（跨 provider 视图）

test('models --all → 请求带 all:true 透传 daemon，结果原样打印', async () => {
  const d = await startFakeDaemon(() => ({
    ok: true,
    result: {
      all: true,
      providers: [{ provider: 'prov-a', models: [{ name: 'prov-a/m1' }] }],
      guidance: '跨 provider 用全名',
    },
  }));
  const r = await run(['models', '--all'], { ZSW_SOCK: d.sockPath });
  assert.equal(r.code, 0);
  assert.deepEqual(d.seen[0].params, { action: 'models', all: true });
  assert.equal(JSON.parse(r.stdout).providers[0].models[0].name, 'prov-a/m1');
  d.server.close();
});

// ------------------------------------- hook 子命令 delegator（批 A2b 收敛验证）

test('hook 未知事件 → usage + exit 1（人类调试入口的可操作报错）', async () => {
  const r = await run(['hook', 'frobnicate']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /未知 hook 事件: frobnicate/);
});

test('hook session-start 嵌套守卫：{} + exit 0（delegator 路径，先于事件名校验）', async () => {
  // 嵌套下即使事件名错误也零开销 {} 退出（守卫优先——D5：hook 绝不阻断会话）
  const r = await run(['hook', 'frobnicate'], { ZSW_NESTED: '1', HOME: HOOK_HOME });
  assert.equal(r.code, 0, `exit code 须为 0，实际 ${r.code}，stderr: ${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), {});
});

test('hook session-start（delegator）输出与 bin/zsw-hook.js 新入口一致', async () => {
  const viaCli = await runHook(BIN, ['hook', 'session-start']);
  const viaEntry = await runHook(HOOK_BIN, []);
  assert.equal(viaCli.code, 0, `stderr: ${viaCli.stderr}`);
  assert.equal(viaEntry.code, 0, `stderr: ${viaEntry.stderr}`);
  // 两入口共享 lib/hook-source 单一实现：剥掉每次运行必然不同的快照时间戳
  // 后 stdout 全等（最强一致性断言——文案/字段/默认标记任一漂移即红）。
  // 剥 ISO 值本身而非引号形态：stdout 是 JSON 文本，引号在字节流里是 \" 转义
  const strip = (s) => s.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'TIMESTAMP');
  assert.equal(strip(viaCli.stdout), strip(viaEntry.stdout));
  // delegator 正常路径协议形态健全性（fixture 同 cli-hook.test.js 口径；
  // W7 三段 XML 形态）
  const out = JSON.parse(viaCli.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = out.hookSpecificOutput.additionalContext;
  for (const tag of ['available_subagents', 'available_workflows', 'available_provider_models']) {
    assert.ok(ctx.includes(`<${tag}>`), `<${tag}> 段在场`);
  }
  assert.ok(
    ctx.includes(`Current default model: ${PROVIDER_ID}/GLM-5.3-Flash.`),
    'cli config model.main → models guide 默认句经 delegator 生效',
  );
});
