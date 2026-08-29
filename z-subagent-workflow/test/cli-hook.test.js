'use strict';

/**
 * bin/zsw.js `hook session-start` 子命令测试（子进程黑盒）：覆盖 impl-plan
 * u2 验收条款——嵌套守卫输出 {} 且 exit 0（P-nested-guard，双断言防 exit 1
 * 违规形态）、正常路径严格协议 JSON（hookEventName + <zsw-resources 块 +
 * 本机默认 provider 名）、ZCODE_PROJECT_DIR 项目级 agent 发现（P-cwd 可脚
 * 本部分）、v2 config 不可读整体降级 {}、cli config 缺失时默认标记回退链
 * 生效（D3 与 zsw models 同口径：v2 顶层 model.main / 内置回退，禁止缺席）。
 *
 * 隔离：HOME 指向临时目录——config.js 的 V2_CONFIG_PATH/CLI_CONFIG_PATH 在
 * 子进程加载期由 os.homedir() 冻结（POSIX 读 $HOME，仓内 workflow-script/
 * driver 同款注释），测试改 HOME 即注入配置路径；ZCODE_PROJECT_DIR 指向
 * fixture 项目目录（与 bin/zsw.js workflow 子命令及本地模式的 projectDir
 * 解析链对齐：ZCODE_PROJECT_DIR > process.cwd()）。
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { PROVIDER_ID } = require('../lib/model-router');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-cli-hook-'));
const BIN = path.join(__dirname, '..', 'bin', 'zsw.js');
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

/** 真跑 `node bin/zsw.js hook session-start`（cwd 与 env 可控）。 */
function run(extraEnv = {}, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, 'hook', 'session-start'],
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

// ------------------------------------------- P-nested-guard（双断言）

test('ZSW_NESTED=1 → stdout 解析为 {} 且 exit code 0（P-nested-guard）', async () => {
  const r = await run({ ZSW_NESTED: '1' });
  // 只验输出不验 exit code 会漏掉 exit 1 违规形态（非零退出会在会话启动
  // raise error，D5 禁止）——两者都断言
  assert.equal(r.code, 0, `exit code 须为 0，实际 ${r.code}，stderr: ${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), {});
});

// ------------------------------------------- 正常路径（协议 JSON + 快照块）

test('正常路径 → 严格单行协议 JSON：SessionStart + <zsw-resources 块 + 默认 provider 名', async () => {
  const r = await run({}, { cwd: TMP });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  // stdout 严格单行 JSON（协议通道纪律：唯一换行在末尾）
  assert.equal(r.stdout.indexOf('\n'), r.stdout.length - 1);
  const out = JSON.parse(r.stdout); // JSON 可解析（验收条款原文）
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.equal(typeof ctx, 'string');
  assert.match(ctx, /^<zsw-resources snapshot="/); // 含 <zsw-resources 开块
  assert.ok(ctx.includes('</zsw-resources>'));
  assert.ok(ctx.includes(PROVIDER_ID), '含本机默认 provider 名（fixture 写入同款，防硬编码漂移）');
  assert.ok(ctx.includes('GLM-5.3-Flash（默认）'), 'cli config model.main → 默认标记链路真实生效');
  // 硬预算 ≤45 行（设计 D3；探针 P-token-budget 的可脚本承接）
  assert.ok(
    ctx.split('\n').length <= 45,
    `注入块行数超硬预算：${ctx.split('\n').length} > 45`,
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

test('cli config 缺失 + v2 顶层 model.main → 标它（回退链第 2 层）', async () => {
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
  assert.ok(ctx.includes('GLM-5.3-Flash（默认）'), 'v2 顶层 model.main 应成为默认标记');
  assert.ok(!ctx.includes('GLM-5.3（默认）'), '内置回退 GLM-5.3 未被标——证明确实走了第 2 层而非第 3 层');
});

test('cli config 缺失 + v2 顶层无 model → 标内置回退 GLM-5.3（回退链第 3 层）', async () => {
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
  assert.match(ctx, /^<zsw-resources snapshot="/); // 块照常渲染
  assert.ok(ctx.includes(PROVIDER_ID));
  assert.ok(ctx.includes('GLM-5.3（默认）'), '回退链尽头应标内置 FALLBACK_DEFAULT_MODEL 短名');
});
