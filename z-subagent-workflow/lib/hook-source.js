'use strict';
/**
 * SessionStart hook 数据组装 + 输出的单一实现（bin/zsw-hook.js 极薄入口的宿主）。
 *
 * 为什么从 bin/zsw.js 的 runHookCommand 独立出来：bin/zsw.js 顶层 require
 * assemble/cli-client/record-store 全链，链上任一插件文件缺失时入口加载即
 * exit 1 → 每会话启动 raise error（D5 降级承诺违规；2026-08 实测复现：删
 * lib/assemble.js → `node bin/zsw.js hook session-start` exit 1）。本模块
 * **顶层零 require**：hook 链路依赖（config/model-router/hook-inject/
 * agent-discovery/orchestration-host）全部在函数体内 require 且被整体 try
 * 包裹——任一模块缺失/损坏 → stdout {} 降级而非 crash，绝不阻断会话启动。
 *
 * 三条硬约束（继承 bin/zsw.js runHookCommand 语义，设计 D4/D5，
 * docs/design/zsw-session-start-injection-design.md）：
 *   1. 嵌套守卫最前：ZSW_NESTED=1 或 XYZ_AGENT_SUBAGENT=1（core 引擎嵌套
 *      标记，F03 双标记判定；谓词权威源 config.isNestedEnv）→ stdout {} +
 *      返回（exit 0 语义）。不 process.exit——由入口自然退出，防 stdout 未 flush。
 *   2. stdout 是协议通道：严格单行 JSON（hookSpecificOutput）；人读诊断走
 *      stderr（与 MCP server 的 stdout 纪律同构）。
 *   3. 数据读取/渲染任一异常 → stdout {} + stderr 一行 [zsw:hook] 诊断
 *      （降级即现状，注入是纯增益通道）。
 *
 * 可测试性：全部副作用注入（env/cwd/stdout/stderr/now），缺省回落 process.*
 * ；stdout/stderr 只需实现 write(String)，传捕获对象即可断言输出。
 */

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
 * hook 选项与 IO 通道解析（全部副作用注入点，缺省回落 process.*）。
 *
 * @param {object} [opts]
 *   - env {object}      环境变量（缺省 process.env；读 ZSW_NESTED /
 *                       XYZ_AGENT_SUBAGENT / ZCODE_PROJECT_DIR）
 *   - cwd {string}      projectDir 的回退基准（缺省 process.cwd()）
 *   - stdout {{write}}  协议输出通道（缺省 process.stdout）
 *   - stderr {{write}}  诊断输出通道（缺省 process.stderr）
 *   - now {() => Date}  快照时间戳时钟（缺省 () => new Date()）
 * @returns {{env, cwd, out, err, now, startMs}} startMs = 流程起点时钟采样（诊断耗时基准）
 */
function resolveHookIO(opts) {
  const env = (opts && opts.env) || process.env;
  const cwd = opts && opts.cwd !== undefined ? opts.cwd : process.cwd();
  const out = (opts && opts.stdout) || process.stdout;
  const err = (opts && opts.stderr) || process.stderr;
  const now = (opts && opts.now) || (() => new Date());
  const startMs = Date.now();
  return { env, cwd, out, err, now, startMs };
}

/**
 * 定位/装载注入源并渲染两行输出文本：require 链、fs 读取、资源列举、渲染
 * 全部在此——任一异常向上抛，由 runSessionStartHook 的 catch 统一降级 {}。
 *
 * W7（注入对齐）：渲染改 lib/hook-inject 的 core 三段形态，本函数负责喂
 * 完整条目数据——agents 为 agent-discovery AgentProfile[]（含 vendored 内置
 * 10 角色与四根，async）；workflows 为 [{name, description, path}]（内置 5 =
 * vendored 资产 meta 解析 + location，用户脚本 = 发现面条目 + meta 解析；
 * 经 orchestration-host 的 registry/loadScriptFromPath，只读文件解析 @pi-meta
 * 不执行脚本体——marker 探针回归见 test/hook-source.test.js）；models 投影
 * 在 hook-inject 内消费 v2。内置 workflow 名单自 W7 起直接取 orchestration-host
 * 权威源（旧 name-only 时代的本地静态第三副本随发现面消费一并退役——
 * core-ref 链反正已进 hook 链路，静态名单的省依赖理由消失）。
 *
 * @returns {Promise<{protocolLine, diagLine}>}
 *   - protocolLine：stdout 协议通道的严格单行 JSON（hookSpecificOutput）
 *   - diagLine：stderr 人读诊断行（providers/agents/workflows 计数 + 耗时）
 */
async function assembleSessionStartOutput({ env, cwd, now, startMs }) {
  // 依赖全部函数体内 require（顶层零 require 纪律见文件头注）：任一模块
  // 缺失/损坏在 require 阶段即抛 → 上层 catch 统一 {} 降级
  const fs = require('node:fs');
  const { V2_CONFIG_PATH } = require('./config');
  const { defaultModelRef } = require('./model-router');
  const { renderResourcesBlock } = require('./hook-inject');
  const agentDiscovery = require('./agent-discovery');
  const orchestrationHost = require('./orchestration-host');
  const coreRef = require('./core-ref');

  // projectDir 解析链与 bin/zsw.js workflow 子命令同源：ZCODE_PROJECT_DIR > cwd
  const source = env.ZCODE_PROJECT_DIR ? 'env' : 'cwd';
  const projectDir = env.ZCODE_PROJECT_DIR || cwd;

  // v2 config fs 直读（models 段主源）：缺失/不可读/坏 JSON 抛错 → 整体
  // 降级 {}（§3.1 失败路径 2）；cli config 缺失不降级——defaultModelRef
  // 内部回退链兜底（cli.main 可解析 → v2 顶层 model.main → 内置回退）
  const v2 = JSON.parse(fs.readFileSync(V2_CONFIG_PATH, 'utf8'));

  // core 发现面（async）：vendored 内置 + 四根（含目录 symlink 展开），与
  // zsub start / zsw agents 同一数据源（lib/agent-discovery）
  const agents = await agentDiscovery.list(projectDir);

  // workflows 完整条目（W7：<available_workflows> 段带 description/location）：
  // 内置 5 = vendored 资产（workflowAssetPath 锚定 location）；用户脚本 =
  // registry.listUserScripts 发现面（core 面 + .zsw 手工根）。description 经
  // loadScriptFromPath 的 @pi-meta 解析（只 readFileSync + parse，不执行脚本
  // 体——旧 name-only 的零执行纪律不变）；unavailable 条目（meta 校验失败
  // 占位）不进注入段（对齐 pi 侧 discoverAllWorkflows 过滤）。
  const core = coreRef.requireCore();
  // F02：hook 路径必须同样走进程级 configureCore——CLI/daemon 入口经
  // createOrchestrationHost 时才 configure，本路径直接 createRegistry 会跳过
  // 它，discoveryRoots（~/.zsw/workflows 借 user-pi 槽）不注入 → core 发现面
  // 静默降级，注入段清单与 CLI/daemon 口径漂移。幂等（进程级 flag），已配置
  // 时零开销；在 try 内，失败随整体降级 {}
  orchestrationHost.ensureConfigured();
  const registry = orchestrationHost.createRegistry(core);
  const workflows = [];
  for (const name of orchestrationHost.BUILTIN_WORKFLOW_NAMES) {
    const script = await orchestrationHost.loadScriptFromPath(
      coreRef.workflowAssetPath(`${name}.js`),
      core,
    );
    workflows.push({
      name: script.name || name,
      description: (script.meta && script.meta.description) || '',
      path: script.path,
    });
  }
  for (const userScript of await registry.listUserScripts(projectDir)) {
    if (userScript.available === false) continue;
    const script = await orchestrationHost.loadScriptFromPath(userScript.path, core);
    if (!script.available) continue;
    workflows.push({
      name: userScript.name,
      description: (script.meta && script.meta.description) || '',
      path: userScript.path,
    });
  }

  const text = renderResourcesBlock({
    v2,
    cliModelMain: defaultModelRef(v2),
    agents,
    workflows,
    nowIso: now().toISOString(),
  });
  const protocolLine = `${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  })}\n`;
  // 成功可观测性诊断走 stderr（stdout 保持纯协议通道）；providers = 带非空
  // 模型清单的 provider 数（与 zsw models 的可用 provider 口径一致）
  const diagLine =
    `[zsw:hook] projectDir=${projectDir} source=${source}`
    + ` providers=${countUsableProviders(v2)} agents=${agents.length}`
    + ` workflows=${workflows.length} elapsed=${Date.now() - startMs}ms\n`;
  return { protocolLine, diagLine };
}

/**
 * 执行 SessionStart hook：组装资源快照并输出协议 JSON；异常降级 {}。
 * 恒不调 process.exit——入口自然退出即 exit 0（降级路径同样零非零退出）。
 * async（core 发现面是异步 API）：入口（bin/zsw-hook.js / bin/zsw.js 的
 * hook 子命令）负责 await 或 .then 收尾，异常在此内部消化不外抛。
 * 参数/IO 注入点见 resolveHookIO，装载与渲染见 assembleSessionStartOutput。
 */
async function runSessionStartHook(opts) {
  const { env, cwd, out, err, now, startMs } = resolveHookIO(opts);

  // 嵌套守卫最前（守卫优先于一切 IO；嵌套下任何 hook 调用零开销退出）。
  // F03 双标记：core 引擎 spawn 的 zcode 子进程带 XYZ_AGENT_SUBAGENT=1 且被剥
  // 离 ZSW_NESTED（nesting-guard），只查 ZSW_NESTED 会漏掉嵌套派发会话。谓词
  // 权威源 = config.isNestedEnv——此处刻意内联同款表达式而非 require：守卫先于
  // 一切 require（D5 零失败面，config 损坏时守卫仍能输出 {}），不引入新失败模式
  if (env.ZSW_NESTED === '1' || env.XYZ_AGENT_SUBAGENT === '1') {
    out.write('{}\n');
    return;
  }

  try {
    const { protocolLine, diagLine } = await assembleSessionStartOutput({ env, cwd, now, startMs });
    out.write(protocolLine);
    err.write(diagLine);
  } catch (e) {
    out.write('{}\n');
    err.write(`[zsw:hook] ${e && e.message || e}\n`);
  }
}

module.exports = { runSessionStartHook };
