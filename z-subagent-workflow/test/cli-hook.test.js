'use strict';

/**
 * bin/zsw-hook.js（SessionStart hook 专用极薄入口，hooks/hooks.json 指向
 * 此处）子进程黑盒测试：覆盖 impl-plan u2 验收条款——嵌套守卫输出 {} 且
 * exit 0（P-nested-guard，双断言防 exit 1 违规形态）、正常路径严格协议
 * JSON（hookEventName + W7 三段 XML 块 + 本机默认 provider 名）、
 * ZCODE_PROJECT_DIR 项目级 agent 发现（P-cwd 可脚本部分）、v2 config 不可
 * 读整体降级 {}、cli config 缺失时默认模型回退链生效（D3 与 zsw models 同
 * 口径：v2 顶层 model.main / 内置回退，经 models guide 默认句承载——W7 起
 * 旧（默认）标记机制退役）、入口极薄性守门（require 全在 try 内 + 无
 * process.exit——防把 bin/zsw.js 的顶层重 require 链搬回 hook 入口，D5
 * 降级承诺的静态防线）。
 *
 * 隔离：HOME 指向临时目录——config.js 的 V2_CONFIG_PATH/CLI_CONFIG_PATH 在
 * 子进程加载期由 os.homedir() 冻结（POSIX 读 $HOME，仓内 workflow-script/
 * driver 同款注释），测试改 HOME 即注入配置路径；ZCODE_PROJECT_DIR 指向
 * fixture 项目目录（与 lib/hook-source 的 projectDir 解析链对齐：
 * ZCODE_PROJECT_DIR > process.cwd()）。
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { PROVIDER_ID } = require('../lib/model-router');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-cli-hook-'));
const BIN = path.join(__dirname, '..', 'bin', 'zsw-hook.js'); // 专用极薄入口，无参数
const HOME = path.join(TMP, 'home'); // 正常路径 HOME（v2 + cli config 齐全）
const EMPTY_HOME = path.join(TMP, 'empty-home'); // v2 config 不可读用例
const PROJECT = path.join(TMP, 'project'); // ZCODE_PROJECT_DIR fixture

fs.mkdirSync(path.join(HOME, '.zcode', 'v2'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.zcode', 'cli'), { recursive: true });
fs.mkdirSync(EMPTY_HOME, { recursive: true }); // 存在但无 ~/.zcode/v2/config.json
fs.mkdirSync(path.join(PROJECT, '.zcode', 'agents'), { recursive: true });

// v2 config fixture：默认 provider（短名解析 target，不筛 apiKey）+ 一个带
// key 的其他 provider（全名段）；cli config：默认主模型（默认标记依据）
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

// 项目级 agent fixture（P-cwd：<projectDir>/.zcode/agents/ 根发现）
fs.writeFileSync(
  path.join(PROJECT, '.zcode', 'agents', 'proj-probe.md'),
  '---\nname: proj-probe\ndescription: 项目级探针 agent\n---\n\nbody\n',
);

/** 真跑 `node bin/zsw-hook.js`（cwd 与 env 可控）。 */
function run(extraEnv = {}, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN], // 极薄入口无子命令/参数
      {
        cwd: opts.cwd, // 缺省继承测试进程 cwd；P-cwd 用例显式指到无 agent 目录
        env: {
          ...process.env,
          HOME,
          ZSW_NESTED: '', // 显式清掉宿主可能的标记，用例按需覆盖
          ZCODE_PROJECT_DIR: PROJECT,
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

// ------------------------------------------- 入口极薄性守门（D5 静态防线）

test('bin/zsw-hook.js 极薄性：require ≤2 且在 try 内、无 process.exit', () => {
  const src = fs.readFileSync(BIN, 'utf8');
  // 剥注释后守门：断言只认代码形态，头注里的说明文案（如「不 process.exit」）不得误报
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const requireCount = (code.match(/\brequire\s*\(/g) || []).length;
  assert.ok(requireCount <= 2, `极薄入口 require 计数须 ≤2，实际 ${requireCount}`);
  assert.ok(
    /try\s*\{[\s\S]*?require\s*\(/.test(code),
    'require 须位于 try 块内（hook-source 模块级损坏时兜底 {}）',
  );
  assert.ok(
    !code.includes('process.exit('),
    'hook 入口禁 process.exit（自然退出即 exit 0，防 stdout 未 flush）',
  );
});

// ------------------------------------------- P-nested-guard（双断言）

test('ZSW_NESTED=1 → stdout 解析为 {} 且 exit code 0（P-nested-guard）', async () => {
  const r = await run({ ZSW_NESTED: '1' });
  // 只验输出不验 exit code 会漏掉 exit 1 违规形态（非零退出会在会话启动
  // raise error，D5 禁止）——两者都断言
  assert.equal(r.code, 0, `exit code 须为 0，实际 ${r.code}，stderr: ${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), {});
});

// ------------------------------------------- 正常路径（协议 JSON + 快照块）

test('正常路径 → 严格单行协议 JSON：SessionStart + 三段 XML 块 + 默认 provider 名', async () => {
  const r = await run({}, { cwd: TMP });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  // stdout 严格单行 JSON（协议通道纪律：唯一换行在末尾）
  assert.equal(r.stdout.indexOf('\n'), r.stdout.length - 1);
  const out = JSON.parse(r.stdout); // JSON 可解析（验收条款原文）
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.equal(typeof ctx, 'string');
  // W7 三段 XML（core format 产物，与 pi 同构）；旧单块形态退役
  for (const tag of ['available_subagents', 'available_workflows', 'available_provider_models']) {
    assert.ok(ctx.includes(`<${tag}>`), `<${tag}> 段在场`);
  }
  assert.ok(!ctx.includes('zsw-resources'), '旧单块形态不得残留');
  assert.ok(ctx.includes(PROVIDER_ID), '含本机默认 provider 名（fixture 写入同款，防硬编码漂移）');
  assert.ok(
    ctx.includes(`Current default model: ${PROVIDER_ID}/GLM-5.3-Flash`),
    'cli config model.main → models guide 默认句真实生效',
  );
});

// ------------------------------------------- P-cwd（ZCODE_PROJECT_DIR 项目级发现）

test('ZCODE_PROJECT_DIR 指向含项目级 agent 的 fixture → 块含该 agent 名（P-cwd 可脚本部分）', async () => {
  // cwd 指向无 agent 的目录：agent 名只能来自 ZCODE_PROJECT_DIR 的四根发现
  const r = await run({}, { cwd: TMP });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('proj-probe'));
});

// ------------------------------------------- v2 config 不可读 → 降级

test('v2 config 不可读（HOME 指向空目录）→ {} + exit 0 + stderr 一行诊断', async () => {
  const r = await run({ HOME: EMPTY_HOME });
  assert.equal(r.code, 0, `exit code 须为 0，实际 ${r.code}`);
  assert.deepEqual(JSON.parse(r.stdout), {});
  assert.match(r.stderr, /\[zsw:hook\]/); // 诊断走 stderr 且只此通道
});

// ----------------------- 默认标记回退链（D3：cli 缺失时与 zsw models 同口径）

// cli config 缺失时默认标记不再缺席——model-router defaultModelRef 的回退链
// （cli.main 可解析 → v2 顶层 model.main → 内置 FALLBACK_DEFAULT_MODEL）生效。
// 第 1 层已由正常路径用例覆盖（cli.main 可解析），此处分别构造第 2/3 层。

test('cli config 缺失 + v2 顶层 model.main → guide 默认句标它（回退链第 2 层）', async () => {
  const homeV2Main = path.join(TMP, 'home-v2-main');
  fs.mkdirSync(path.join(homeV2Main, '.zcode', 'v2'), { recursive: true });
  fs.writeFileSync(
    path.join(homeV2Main, '.zcode', 'v2', 'config.json'),
    JSON.stringify({
      model: { main: `${PROVIDER_ID}/GLM-5.3-Flash` },
      provider: { [PROVIDER_ID]: { models: { 'GLM-5.3': {}, 'GLM-5.3-Flash': {} } } },
    }),
  );
  const r = await run({ HOME: homeV2Main }, { cwd: TMP });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  // 尾随句点锚定精确匹配（guide 句式 "Current default model: <ref>. Do NOT…"；
  // 防 GLM-5.3 对 GLM-5.3-Flash 的前缀误判）
  assert.ok(ctx.includes(`Current default model: ${PROVIDER_ID}/GLM-5.3-Flash.`), 'v2 顶层 model.main 应进 guide 默认句');
  assert.ok(!ctx.includes(`Current default model: ${PROVIDER_ID}/GLM-5.3.`), '内置回退 GLM-5.3 未被标——证明确实走了第 2 层而非第 3 层');
});

test('cli config 缺失 + v2 顶层无 model → guide 默认句标内置回退（回退链第 3 层）', async () => {
  const homeNoCli = path.join(TMP, 'home-no-cli');
  fs.mkdirSync(path.join(homeNoCli, '.zcode', 'v2'), { recursive: true });
  fs.writeFileSync(
    path.join(homeNoCli, '.zcode', 'v2', 'config.json'),
    JSON.stringify({ provider: { [PROVIDER_ID]: { models: { 'GLM-5.3': {} } } } }),
  );
  const r = await run({ HOME: homeNoCli }, { cwd: TMP });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('<available_provider_models>'), 'models 段照常渲染');
  assert.ok(ctx.includes(PROVIDER_ID));
  assert.ok(
    ctx.includes(`Current default model: ${PROVIDER_ID}/GLM-5.3.`),
    '回退链尽头应标内置 FALLBACK_DEFAULT_MODEL',
  );
});
