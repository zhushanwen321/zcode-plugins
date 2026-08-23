'use strict';
/**
 * 运行时组装（入口层共用）：MCP server 与 CLI 都从这里拿 manager。
 * 这是 lib 内唯一允许 import 具体端口实现的地方（对齐 ports.createRuntime
 * 的定位——决策位①③的「换实现」发生在这里，manager 永远只面对端口）。
 *
 * 组装产物含两个 manager：SubagentManager（subagent 生命周期）与
 * WorkflowManager（workflow run 生命周期，N2-b 接线）。两者共享同一
 * records / outputs / notifier 实例——record 事件流按 recordType 区分
 * （'subagent' 缺省 / 'workflow'），完成通知同走 mailbox。
 *
 * runnerKind 解析顺序：显式参数 > ZSW_RUNNER env > 默认 spawn。
 * appserver 的 probe 门控（D3）在本模块统一执行：ZSW_RUNNER=appserver 时先
 * prepareRunEnv + probe()，失败降级 spawn——MCP 与 CLI 两个入口共用同一
 * 决策，行为不漂移。
 */

const config = require('./config');

/** stderr 诊断（assemble 被 MCP 与 CLI 共用，log 走 stderr 不污染协议/stdout）。 */
function log(msg) {
  process.stderr.write(`[zsub] ${new Date().toISOString()} ${msg}\n`);
}

/**
 * ZSW_RUNNER=appserver 时的探针门控（D3）：app-server 协议不可用则降级 spawn。
 * 传入 opts.runner 显式注入 runner 的调用方（测试）不探测——注入即接管。
 * @returns {Promise<'appserver'|'spawn'>} 探测后的最终 runnerKind
 */
async function resolveRunnerKind(requested) {
  if (requested !== 'appserver') return requested;
  try {
    // app-server 进程启动即要求隔离 HOME 存在模型/provider 配置（e2e 实测
    // 2026-08-23：无配置时 session/create 直接 -32603 "Model config is
    // missing"），probe 必须发生在 prepareRunEnv 的 bootstrap 之后，否则
    // 真实部署中 appserver 永远误降级 spawn。
    const ModelRouter = require('./model-router');
    const AppServerRunner = require('./runner-appserver');
    const router = new ModelRouter();
    await router.prepareRunEnv(router.resolve(), 'appserver');
    const probe = await new AppServerRunner().probe();
    if (probe.ok) {
      log(`appserver probe OK（protocol ${probe.protocolVersion || '?'}），runner=appserver`);
      return 'appserver';
    }
    log(`appserver probe FAILED（${probe.reason}），降级 runner=spawn`);
    return 'spawn';
  } catch (e) {
    log(`appserver probe crashed（${e && e.message || e}），降级 runner=spawn`);
    return 'spawn';
  }
}

async function assembleManager(opts = {}) {
  const { createRuntime } = require('./ports');
  const { RecordStore } = require('./record-store');
  const outputs = require('./output-store');
  const { createSlots } = require('./slots');
  const { SubagentManager } = require('./manager');
  const { WorkflowManager } = require('./workflow-manager');
  const { createWorktreeAdapter } = require('./worktree-adapter');
  const resolver = require('./agent-md-resolver');

  let runnerKind = opts.runnerKind
    || (process.env.ZSW_RUNNER === 'appserver' ? 'appserver' : 'spawn');
  if (!opts.runner && !opts.runnerKind) {
    // 探针门控只对 env 推断的 appserver 生效（显式注入 runner/runnerKind 即接管）
    runnerKind = await resolveRunnerKind(runnerKind);
  }
  const rt = createRuntime({ runnerKind, notifyMode: opts.notifyMode });
  const notifier = opts.notifier || rt.createNotifier();
  // 三个端口实例先于两个 manager 构造（SubagentManager 与 WorkflowManager
  // 共享同一 records/outputs/notifier——record 事件流、结果落盘、完成通知
  // 必须同源，两份实例会让 recordType 过滤与 mailbox 投递互相看不见）
  const records = opts.records || new RecordStore();
  const outputsPort = opts.outputs || outputs;
  const manager = new SubagentManager({
    runner: opts.runner || rt.createRunner(),
    modelRouter: opts.modelRouter || rt.createModelRouter(),
    notifier,
    resolver: opts.resolver || resolver, // 模块对象自带 resolve(nameOrPath, cwd)，天然满足端口契约
    records,
    outputs: outputsPort,
    slots: opts.slots || createSlots({ limit: config.DEFAULTS.maxConcurrent }),
    worktree: opts.worktree === undefined ? createWorktreeAdapter() : opts.worktree,
  });
  const wfManager = opts.wfManager || new WorkflowManager({
    records,
    outputs: outputsPort,
    notifier,
  });
  return { manager, wfManager, notifier, runnerKind };
}

module.exports = { assembleManager };
