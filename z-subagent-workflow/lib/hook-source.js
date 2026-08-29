'use strict';
/**
 * SessionStart hook 数据组装 + 输出的单一实现（bin/zsw-hook.js 极薄入口的宿主）。
 *
 * 为什么从 bin/zsw.js 的 runHookCommand 独立出来：bin/zsw.js 顶层 require
 * assemble/cli-client/record-store 全链，链上任一插件文件缺失时入口加载即
 * exit 1 → 每会话启动 raise error（D5 降级承诺违规；2026-08 实测复现：删
 * lib/assemble.js → `node bin/zsw.js hook session-start` exit 1）。本模块
 * **顶层零 require**：hook 链路依赖（config/model-router/hook-inject/
 * agent-md-resolver/workflow-script）全部在函数体内 require 且被整体 try
 * 包裹——任一模块缺失/损坏 → stdout {} 降级而非 crash，绝不阻断会话启动。
 *
 * 三条硬约束（继承 bin/zsw.js runHookCommand 语义，设计 D4/D5，
 * docs/design/zsw-session-start-injection-design.md）：
 *   1. 嵌套守卫最前：ZSW_NESTED=1 → stdout {} + 返回（exit 0 语义）。不
 *      process.exit——由入口自然退出，防 stdout 未 flush。
 *   2. stdout 是协议通道：严格单行 JSON（hookSpecificOutput）；人读诊断走
 *      stderr（与 MCP server 的 stdout 纪律同构）。
 *   3. 数据读取/渲染任一异常 → stdout {} + stderr 一行 [zsw:hook] 诊断
 *      （降级即现状，注入是纯增益通道）。
 *
 * 可测试性：全部副作用注入（env/cwd/stdout/stderr/now），缺省回落 process.*
 * ；stdout/stderr 只需实现 write(String)，传捕获对象即可断言输出。
 */

/**
 * 内置 workflow 五名。名字集合的权威源是 lib/workflow-manager 的
 * defaultWorkflows() 键集（bin/zsw.js 的 BUILTIN_WORKFLOW_INFO 与
 * dist/mcp/server.js 的同名集合同此口径）。刻意不从 workflow-manager
 * require：那会把 workflow 入口全链（chain/parallel/... 各自依赖树）拉进
 * hook 链路，扩大降级面，违背本模块「hook 链路依赖最小化」的存在理由。
 */
const BUILTIN_WORKFLOW_NAMES = [
  'chain',
  'parallel',
  'map-reduce',
  'scatter-gather',
  'review-fix-loop',
];

/**
 * v2 config 中带非空模型清单的 provider 数（诊断行口径，与 model-router 的
 * providersUsable 同义；该函数未导出，此处仅为可观测性计数、不参与任何
 * 语义判定，两处漂移无行为后果）。
 */
function countUsableProviders(v2) {
  return Object.entries((v2 && v2.provider) || {})
    .filter(([, e]) => e && Object.keys(e.models || {}).length > 0)
    .length;
}

/**
 * 执行 SessionStart hook：组装资源快照并输出协议 JSON；异常降级 {}。
 * 恒不调 process.exit——入口自然退出即 exit 0（降级路径同样零非零退出）。
 *
 * @param {object} [opts]
 *   - env {object}      环境变量（缺省 process.env；读 ZSW_NESTED / ZCODE_PROJECT_DIR）
 *   - cwd {string}      projectDir 的回退基准（缺省 process.cwd()）
 *   - stdout {{write}}  协议输出通道（缺省 process.stdout）
 *   - stderr {{write}}  诊断输出通道（缺省 process.stderr）
 *   - now {() => Date}  快照时间戳时钟（缺省 () => new Date()）
 */
function runSessionStartHook(opts) {
  const env = (opts && opts.env) || process.env;
  const cwd = opts && opts.cwd !== undefined ? opts.cwd : process.cwd();
  const out = (opts && opts.stdout) || process.stdout;
  const err = (opts && opts.stderr) || process.stderr;
  const now = (opts && opts.now) || (() => new Date());
  const startMs = Date.now();

  // 嵌套守卫最前（守卫优先于一切 IO；嵌套下任何 hook 调用零开销退出）
  if (env.ZSW_NESTED === '1') {
    out.write('{}\n');
    return;
  }

  try {
    // 依赖全部函数体内 require（顶层零 require 纪律见文件头注）：任一模块
    // 缺失/损坏在 require 阶段即抛 → 下方 catch 统一 {} 降级
    const fs = require('node:fs');
    const { V2_CONFIG_PATH } = require('./config');
    const { defaultModelRef } = require('./model-router');
    const { renderResourcesBlock } = require('./hook-inject');
    const { AgentMdResolver } = require('./agent-md-resolver');
    const { listScriptNames } = require('./workflow-script');

    // projectDir 解析链与 bin/zsw.js workflow 子命令同源：ZCODE_PROJECT_DIR > cwd
    const source = env.ZCODE_PROJECT_DIR ? 'env' : 'cwd';
    const projectDir = env.ZCODE_PROJECT_DIR || cwd;

    // v2 config fs 直读（models 段主源）：缺失/不可读/坏 JSON 抛错 → 整体
    // 降级 {}（§3.1 失败路径 2）；cli config 缺失不降级——defaultModelRef
    // 内部回退链兜底（cli.main 可解析 → v2 顶层 model.main → 内置回退）
    const v2 = JSON.parse(fs.readFileSync(V2_CONFIG_PATH, 'utf8'));

    const agents = new AgentMdResolver().list(projectDir);
    // name-only 发现：绝不 require 脚本——脚本体顶层副作用（任意用户代码）
    // 不得在会话启动的 hook 内联路径上触发，这正是 listScriptNames 的存在理由
    const scripts = listScriptNames(projectDir);

    const text = renderResourcesBlock({
      v2,
      cliModelMain: defaultModelRef(v2),
      agents,
      scripts,
      builtinWorkflows: BUILTIN_WORKFLOW_NAMES,
      nowIso: now().toISOString(),
    });
    out.write(`${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    })}\n`);
    // 成功可观测性诊断走 stderr（stdout 保持纯协议通道）；providers = 带非空
    // 模型清单的 provider 数（与 zsw models 的可用 provider 口径一致）
    err.write(
      `[zsw:hook] projectDir=${projectDir} source=${source}`
      + ` providers=${countUsableProviders(v2)} agents=${agents.length}`
      + ` scripts=${scripts.length} elapsed=${Date.now() - startMs}ms\n`,
    );
  } catch (e) {
    out.write('{}\n');
    err.write(`[zsw:hook] ${e && e.message || e}\n`);
  }
}

module.exports = { runSessionStartHook, BUILTIN_WORKFLOW_NAMES };
