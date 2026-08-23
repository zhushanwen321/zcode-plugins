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
 * runnerKind 解析顺序：显式参数 > ZSUB_RUNNER env > 默认 spawn。
 * appserver 的 probe 门控不在本模块（main 循环与 CLI 各自决定降级策略）。
 */

const config = require('./config');

function assembleManager(opts = {}) {
  const { createRuntime } = require('./ports');
  const { RecordStore } = require('./record-store');
  const outputs = require('./output-store');
  const { createSlots } = require('./slots');
  const { SubagentManager } = require('./manager');
  const { WorkflowManager } = require('./workflow-manager');
  const { createWorktreeAdapter } = require('./worktree-adapter');
  const resolver = require('./agent-md-resolver');

  const runnerKind = opts.runnerKind
    || (process.env.ZSUB_RUNNER === 'appserver' ? 'appserver' : 'spawn');
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
