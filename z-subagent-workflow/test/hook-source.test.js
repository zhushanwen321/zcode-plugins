'use strict';

/**
 * lib/hook-source.js runSessionStartHook 进程内单测（依赖全注入，无子进程）：
 * 覆盖嵌套守卫（{} + 零诊断零 IO）、v2 config 缺失/坏 JSON 整体降级、正常
 * 路径协议 JSON（项目级 agent / 自定义脚本名 / 内置五名在场；脚本顶层代码
 * 未执行——marker 探针，name-only 发现的核心回归）、成功可观测性 stderr 行、
 * projectDir env/cwd 双来源。
 *
 * 回接 2b：runSessionStartHook 已 async 化（core 发现面异步）——测试统一
 * await。脚本 fixture 改 core 契约（@pi-meta 块）仍验 name-only 语义。
 * HOME 隔离：本文件在任何 ../lib/* require 之前把 process.env.HOME 指到
 * fixture——config.js 的 V2_CONFIG_PATH/CLI_CONFIG_PATH 与 agent-md-resolver
 * 的 defaultResolver homeDir 都在模块加载期经 os.homedir()（POSIX 读 $HOME）
 * 冻结。v2/cli config 的「缺失 → 齐备」两阶段靠 fixture 文件系统状态按测试
 * 顺序演进（node:test 顶层 test 默认串行；写文件的动作放在独立 setup test
 * 内——test 声明之间的顶层代码会先于全部 test 执行，不能用来做阶段 setup）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-hook-source-'));
const HOME = path.join(TMP, 'home'); // fixture HOME（config 常量固化到此）
const PROJECT = path.join(TMP, 'project'); // projectDir fixture
const MARKER = path.join(TMP, 'marker.txt'); // 脚本顶层副作用探针

// 必须先于下方任何 ../lib/* require（加载期 os.homedir() 冻结，见文件头注）
process.env.HOME = HOME;

const { runSessionStartHook, BUILTIN_WORKFLOW_NAMES } = require('../lib/hook-source');
const { PROVIDER_ID } = require('../lib/model-router');

fs.mkdirSync(path.join(HOME, '.zcode'), { recursive: true }); // 存在但暂无 v2/cli config
fs.mkdirSync(path.join(PROJECT, '.zcode', 'agents'), { recursive: true });
fs.mkdirSync(path.join(PROJECT, '.zsw', 'workflows'), { recursive: true });

// 项目级 agent fixture（<projectDir>/.zcode/agents 四根发现）
fs.writeFileSync(
  path.join(PROJECT, '.zcode', 'agents', 'proj-agent.md'),
  '---\nname: proj-agent\ndescription: 项目级探针 agent\n---\n\nbody\n',
);

// 脚本 fixture（core 契约形态，@pi-meta 块 + top-level）：顶层代码写 marker——
// 若 hook 链路误用 require 版发现（执行脚本体），marker 出现即失败；
// name-only（core discoverWorkflows 只 parse @pi-meta + 手工根 readdir）则永不触发
fs.writeFileSync(
  path.join(PROJECT, '.zsw', 'workflows', 'probe-script.js'),
  `/* @pi-meta\nname: probe-script\ndescription: x\nphases: [run]\n*/\n`
  + `const fs = require('node:fs');\n`
  + `fs.writeFileSync(${JSON.stringify(MARKER)}, 'executed');\n`
  + `await agent({ prompt: 'x' });\n`,
);

/** 注入式执行：env 纯对象起底（不继承宿主，防外部 env 漏入），stdout/stderr 捕获，时钟固定。 */
async function runHook({ env = {}, cwd = PROJECT } = {}) {
  const outChunks = [];
  const errChunks = [];
  await runSessionStartHook({
    env,
    cwd,
    stdout: { write: (s) => outChunks.push(s) },
    stderr: { write: (s) => errChunks.push(s) },
    now: () => new Date('2026-08-29T00:00:00.000Z'),
  });
  return { out: outChunks.join(''), err: errChunks.join('') };
}

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// ---------------------------------------------------- 嵌套守卫（P-nested 同款）

test('ZSW_NESTED=1 → stdout 单行 {} 且零诊断（守卫最前，零 IO 退出）', async () => {
  const r = await runHook({ env: { ZSW_NESTED: '1' } });
  assert.deepEqual(JSON.parse(r.out), {});
  assert.equal(r.out, '{}\n');
  assert.equal(r.err, '', '嵌套守卫零开销：不得产生任何 stderr 诊断');
  assert.ok(!fs.existsSync(MARKER), '嵌套路径同样不触发脚本顶层代码');
});

// ------------------------------- v2 config 缺失降级（此时 fixture 尚无 v2 config）

test('v2 config 缺失 → {} + stderr 一行 [zsw:hook] 诊断', async () => {
  const r = await runHook();
  assert.deepEqual(JSON.parse(r.out), {});
  assert.match(r.err, /^\[zsw:hook\] .+\n$/);
});

// ------------------------------------------ 阶段 setup：fixture HOME 转入齐备态

test('setup：fixture HOME 写入 v2/cli config（后续用例转入配置齐备态）', () => {
  fs.mkdirSync(path.join(HOME, '.zcode', 'v2'), { recursive: true });
  fs.mkdirSync(path.join(HOME, '.zcode', 'cli'), { recursive: true });
  // 与 test/cli-hook.test.js 同款：默认 provider（短名清单）+ 一个带 key 的
  // 其他 provider（countUsableProviders 的 providers=2 断言依据）；cli config
  // model.main 指向默认 provider 的 GLM-5.3-Flash（默认标记依据）
  fs.writeFileSync(
    path.join(HOME, '.zcode', 'v2', 'config.json'),
    JSON.stringify({
      provider: {
        [PROVIDER_ID]: { models: { 'GLM-5.3': {}, 'GLM-5.3-Flash': {} } },
        'prov-a': { options: { apiKey: 'k-a' }, models: { m1: {} } },
      },
    }),
  );
  fs.writeFileSync(
    path.join(HOME, '.zcode', 'cli', 'config.json'),
    JSON.stringify({ model: { main: `${PROVIDER_ID}/GLM-5.3-Flash` } }),
  );
});

// ---------------------------------------------------- 正常路径（协议 + 快照）

test('正常路径 → 严格单行协议 JSON：agent/脚本/内置名在场，脚本顶层未执行', async () => {
  const r = await runHook();
  // stdout 纯协议：严格单行 JSON（唯一换行在末尾）
  assert.equal(r.out.indexOf('\n'), r.out.length - 1);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.match(ctx, /^<zsw-resources snapshot="2026-08-29T00:00:00.000Z">/); // now 注入生效
  assert.ok(ctx.includes('</zsw-resources>'));
  assert.ok(ctx.includes('proj-agent'), '项目级 agent 经四根发现在场');
  assert.ok(ctx.includes('probe-script'), '自定义脚本名在场（name-only 发现）');
  for (const name of BUILTIN_WORKFLOW_NAMES) {
    assert.ok(ctx.includes(name), `内置 workflow ${name} 在场`);
  }
  assert.ok(ctx.includes('GLM-5.3-Flash（默认）'), 'cli config model.main → 默认标记链路生效');
  // name-only 发现的核心回归：脚本顶层代码不得被 hook 触发
  assert.ok(!fs.existsSync(MARKER), '脚本顶层代码未执行（listScriptNames 零 require）');
  // 成功可观测性诊断：单行 [zsw:hook]，计数与 fixture 一致
  assert.match(
    r.err,
    /^\[zsw:hook\] projectDir=.+ source=cwd providers=2 agents=1 scripts=1 elapsed=\d+ms\n$/,
  );
});

// ---------------------------------------------------- projectDir 双来源

test('ZCODE_PROJECT_DIR 设置 → source=env，agent 从 env 的 projectDir 发现', async () => {
  const r = await runHook({ env: { ZCODE_PROJECT_DIR: PROJECT }, cwd: TMP }); // cwd 下无 agent
  const ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('proj-agent'), 'agent 名只能来自 ZCODE_PROJECT_DIR 的发现');
  assert.ok(r.err.includes(`projectDir=${PROJECT} source=env `), `stderr 实际: ${r.err}`);
});

test('ZCODE_PROJECT_DIR 未设 → source=cwd，projectDir 回退注入的 cwd', async () => {
  const r = await runHook({ cwd: PROJECT }); // env 无 ZCODE_PROJECT_DIR
  const ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('proj-agent'), 'agent 名来自回退 cwd 的发现');
  assert.ok(r.err.includes(`projectDir=${PROJECT} source=cwd`), `stderr 实际: ${r.err}`);
});

// ---------------------------------------------------- v2 坏 JSON 降级

test('v2 config 坏 JSON → 整体降级 {} + 诊断（跑后恢复 fixture）', async () => {
  const p = path.join(HOME, '.zcode', 'v2', 'config.json');
  const good = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, '{broken');
  try {
    const r = await runHook();
    assert.deepEqual(JSON.parse(r.out), {});
    assert.match(r.err, /^\[zsw:hook\] .+\n$/);
  } finally {
    fs.writeFileSync(p, good);
  }
});

// ---------------------------------------------------- 内置五名权威源锚定

test('BUILTIN_WORKFLOW_NAMES 与 orchestration-host 内置集合相等（第三副本防漂移锚）', () => {
  // 权威源：lib/orchestration-host 的 BUILTIN_WORKFLOW_NAMES（= vendored core
  // workflows/ 资产 stem）。hook-source 刻意持静态名单（不 require host——
  // 那会把 core-ref → vendored bundle 拉进 hook 链路，扩大降级面），测试
  // 进程里 require 对照防两份名单漂移。
  const { BUILTIN_WORKFLOW_NAMES: HOST_NAMES } = require('../lib/orchestration-host');
  assert.deepEqual(
    [...BUILTIN_WORKFLOW_NAMES].sort(),
    [...HOST_NAMES].sort(),
    'hook 注入块的内置 workflow 名单必须与编排宿主实际注册的内置集合一致',
  );
});
