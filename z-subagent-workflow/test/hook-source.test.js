'use strict';

/**
 * lib/hook-source.js runSessionStartHook 进程内单测（依赖全注入，无子进程）：
 * 覆盖嵌套守卫（{} + 零诊断零 IO）、v2 config 缺失/坏 JSON 整体降级、正常
 * 路径协议 JSON（W7 三段 XML：<available_subagents> 含 vendored 内置 10 带
 * location / <available_workflows> 内置 5 + 自定义脚本带 location /
 * <available_provider_models> 含 contextWindow/caps 与 guide 默认句；脚本顶层
 * 代码未执行——marker 探针，组装只读文件解析 @pi-meta 的核心回归）、成功
 * 可观测性 stderr 行（providers/agents/workflows 计数）、projectDir
 * env/cwd 双来源。
 *
 * W7：workflows 数据面从 name-only 升级为完整条目（description 经
 * loadScriptFromPath 的 @pi-meta 解析、location = 绝对路径）——零执行纪律
 * 不变（marker 探针）。HOME 隔离：本文件在任何 ../lib/* require 之前把
 * process.env.HOME 指到 fixture——config.js 的 V2_CONFIG_PATH/CLI_CONFIG_PATH
 * 在模块加载期经 os.homedir()（POSIX 读 $HOME）冻结；W6a 起 agent 清单走
 * core 发现面（agent-discovery 的 homeDir 基准与 core 硬编码 user-agents 槽
 * 都在调用期现取 $HOME，同一 env 即同源）。v2/cli config 的「缺失 → 齐备」
 * 两阶段靠 fixture 文件系统状态按测试顺序演进（node:test 顶层 test 默认
 * 串行；写文件的动作放在独立 setup test 内——test 声明之间的顶层代码会
 * 先于全部 test 执行，不能用来做阶段 setup）。
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

const { runSessionStartHook } = require('../lib/hook-source');
const { BUILTIN_WORKFLOW_NAMES } = require('../lib/orchestration-host');
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
  // 默认 provider（短名清单；GLM-5.3 带 v2 真实形态的 label/limit.context/
  // reasoning.variants——models 段 contextWindow/caps 断言依据）+ 一个带 key
  // 的其他 provider（providers=2 断言依据）；cli config model.main 指向默认
  // provider 的 GLM-5.3-Flash（models guide 默认句断言依据）
  fs.writeFileSync(
    path.join(HOME, '.zcode', 'v2', 'config.json'),
    JSON.stringify({
      provider: {
        [PROVIDER_ID]: {
          models: {
            'GLM-5.3': {
              label: 'GLM 重量档',
              limit: { context: 200000 },
              reasoning: { variants: ['high', 'medium', 'low'], defaultVariant: 'medium' },
            },
            'GLM-5.3-Flash': {},
          },
        },
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

test('正常路径 → 严格单行协议 JSON：三段 XML 在场（vendored location / 窗口档位 / 引导文案），脚本顶层未执行', async () => {
  const r = await runHook();
  // stdout 纯协议：严格单行 JSON（唯一换行在末尾）
  assert.equal(r.out.indexOf('\n'), r.out.length - 1);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  // W7 三段形态（core format 产物，与 pi 同构）：三段 tag 各在场、旧单块退役
  for (const tag of ['available_subagents', 'available_workflows', 'available_provider_models']) {
    assert.ok(ctx.includes(`<${tag}>`), `<${tag}> 段在场`);
  }
  assert.ok(!ctx.includes('zsw-resources'), '旧单块形态不得残留');
  assert.ok(ctx.includes('Snapshot generated 2026-08-29T00:00:00.000Z'), 'now 注入生效（models guide 时戳句）');

  // subagents 段：项目级 fixture 带 location（AgentProfile.filePath → <location>）
  assert.ok(
    ctx.includes(`<name>proj-agent</name><description>项目级探针 agent</description><location>${path.join(PROJECT, '.zcode', 'agents', 'proj-agent.md')}</location>`),
    '项目级 agent 条目带 <location>（W6b 路径契约的注入面对齐）',
  );
  // vendored 内置 10 角色全在场且带 vendored location（开箱 G1 主场景）
  const vendorAgentsDir = path.join(__dirname, '..', 'lib', 'vendor', 'subagent-core', 'agents');
  for (const file of fs.readdirSync(vendorAgentsDir).filter((f) => f.endsWith('.md'))) {
    assert.ok(
      ctx.includes(`<location>${path.join(vendorAgentsDir, file)}</location>`),
      `vendored 内置 ${file} 带 location`,
    );
  }

  // workflows 段：内置 5 带 vendored 资产 location；自定义脚本带绝对路径 location
  for (const name of BUILTIN_WORKFLOW_NAMES) {
    assert.ok(ctx.includes(`<name>${name}</name>`), `内置 workflow ${name} 条目在场`);
  }
  assert.ok(
    ctx.includes(`<location>${path.join(__dirname, '..', 'lib', 'vendor', 'subagent-core', 'workflows', 'chain.js')}</location>`),
    '内置 workflow 的 location = vendored 资产路径',
  );
  assert.ok(
    ctx.includes(`<location>${path.join(PROJECT, '.zsw', 'workflows', 'probe-script.js')}</location>`),
    '自定义脚本 location = 其绝对路径',
  );

  // models 段：v2 真实形态字段（id 全名 / caps / contextWindow）+ guide 默认句
  assert.ok(ctx.includes(`<id>${PROVIDER_ID}/GLM-5.3</id>`), 'id 全名形态');
  assert.ok(ctx.includes('<caps>reasoning</caps>'), 'reasoning 档位 → caps 标记');
  assert.ok(ctx.includes('<contextWindow>200000</contextWindow>'), 'contextWindow 在场');
  assert.ok(
    ctx.includes(`Current default model: ${PROVIDER_ID}/GLM-5.3-Flash`),
    'cli config model.main → models guide 默认句（旧（默认）标记的承载面）',
  );

  // name-only 发现的核心回归：脚本顶层代码不得被 hook 触发
  assert.ok(!fs.existsSync(MARKER), '脚本顶层代码未执行（组装只读文件解析 @pi-meta）');
  // 成功可观测性诊断：单行 [zsw:hook]，计数与 fixture 一致（W6a 起 core
  // 发现面含 vendored 内置 10 角色：agents = 10 内置 + 1 项目级 fixture；
  // W7 起 workflows = 内置 5 + probe-script 1）
  assert.match(
    r.err,
    /^\[zsw:hook\] projectDir=.+ source=cwd providers=2 agents=11 workflows=6 elapsed=\d+ms\n$/,
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

// 旧「第三副本防漂移锚」随 W7 删除：hook-source 不再持有本地静态名单
//（workflows 数据面直接消费 orchestration-host 的 BUILTIN_WORKFLOW_NAMES 权威
// 源），漂移面不存在；正常路径用例已循环 host 名单断言注入段条目在场。
