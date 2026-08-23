'use strict';
/**
 * 端口契约（设计文档 DESIGN-v3.md §3.1/§5.3）。
 *
 * 这是 zsub 的「决策可换」地基：manager.js 与上层入口（MCP server / CLI）
 * 只依赖本文件声明的接口，不依赖任何具体实现。三个正交决策位：
 *
 *   决策位① 执行引擎  RunnerPort     : spawn（基线）| appserver（长线）
 *   决策位② 回流通道  NotifierPort   : mailbox（主）| polling（兜底）| task-notification（预留）
 *   决策位③ 入口形态  （MCP / CLI）   : dist/mcp/server.js 与 bin/zsub.js 都只是 manager 的薄壳
 *
 * 更换决策 = 在 createRuntime 里换一个实现类，manager 零改动。
 * 平台版本漂移（zcode 闭源升级）被限制在端口实现内部消化。
 *
 * 本文件只含 JSDoc 契约 + registry 工厂，不含实现。
 */

const DEFAULTS = require('./config').DEFAULTS;

/**
 * @typedef {Object} AgentProfile   agent .md 解析结果（AgentResolverPort）
 * @property {string} name          frontmatter name（缺省取文件名）
 * @property {string} description
 * @property {string} filePath      绝对路径（唯一性来源）
 * @property {string} [model]       frontmatter model（解析链中间层）
 * @property {string[]} [tools]     白名单（prompt 约束 + --disallowed-tools 反向表达）
 * @property {string[]} [disallowedTools]
 * @property {string[]} [skills]    参考 skill 目录（prompt 参考段）
 * @property {number} [maxTurns]
 * @property {string} body          md 正文（角色设定，prompt-builder 消费）
 */

/**
 * @typedef {Object} TaskCtx        一次 start 的完整输入（runner 消费）
 * @property {string} subagentId    sa-<rand>
 * @property {string} slug          用户可读名
 * @property {string} prompt        prompt-builder 拼装后的完整 prompt
 * @property {string} cwd           运行目录（主会话 cwd 或 worktree 路径）
 * @property {string} modelRef      ModelRouterPort.resolve 的结果（provider/model 全名）
 * @property {number} timeoutMs
 * @property {boolean} conversation 允许续聊（record 保留会话句柄）
 */

/**
 * @typedef {Object} RunResult      一次运行（或续聊一轮）的结果
 * @property {'closed'|'error'|'timeout'|'cancelled'} [status]
 * @property {string} response      模型最终输出文本
 * @property {object} [usage]       {input_tokens, output_tokens, ...}
 * @property {string} [sessionId]   zcode session id（conversation 续聊依据）
 * @property {string} [error]
 */

/** 端口实现必须在启动/注册时自检并声明能力，manager 据此分流与降级。 */

/**
 * RunnerPort（决策位①）——执行引擎。
 *
 * 契约：
 *   probe()                          启动探针（appserver 验协议往返；spawn 恒 ok）
 *   start(taskCtx) -> RunHandle      启动一次任务；立即返回，不等待完成
 *   resume(exec, message, opts)      续聊一轮（仅 conversation record；exec 为 record.exec）
 *   alive(exec) -> boolean           探活（崩溃恢复用）
 *   capabilities()                   能力声明
 *
 * @typedef {Object} RunHandle
 * @property {object} exec            不透明会话句柄，原样存入 record.exec（manager 不解读）
 *                                    spawn: {kind:'spawn', pid, sessionId?}
 *                                    appserver: {kind:'apc', sessionId}
 * @property {function(): void} cancel   取消（SIGTERM→SIGKILL / session/stop）
 * @property {Promise<RunResult>} done    完成 promise（含超时/取消终态）
 *
 * @typedef {Object} RunnerCapabilities
 * @property {'none'|'stdin'|'session-send'} steering   running 中追加消息的能力
 * @property {number} coldStartMs                                每轮启动开销估计
 * @property {'spawn'|'appserver'} kind
 */

/**
 * NotifierPort（决策位②）——完成回流。
 *
 * 契约：
 *   notifyCompletion(record, summaryText) -> {delivered, target?}
 *   capabilities() -> {mode, wakeIdle, requiresEnv?}
 *
 * 语义档位（G3 分档依据）：
 *   mailbox : 完成即投递文件，主 agent 下次活动时注入（wakeIdle=false，物理上限）
 *   polling : 不投递；start(bg) 返回轮询指引（「结果可达」档）
 *   task-notification（预留）: 仅 bash 包裹启动的任务可获独立 turn 唤醒 + goal gate
 */

/**
 * ModelRouterPort —— 模型解析与运行环境准备。
 *
 * 契约：
 *   resolve(requested?, agentDefault?) -> modelRef   未知模型抛可操作错误（列可用清单）
 *   prepareRunEnv(modelRef, runnerKind) -> spawn 场景 {env:{HOME,...}}；
 *                                          appserver 场景 {createParams:{model,...}}
 */

/**
 * AgentResolverPort —— agent .md 四根发现（固定实现，接口化为可测）。
 *   list(cwd) -> AgentProfile[]      四根优先级：ws/.agents > ws/.zcode > ~/.agents > ~/.zcode
 *   resolve(nameOrPath, cwd) -> AgentProfile | null
 */

/**
 * RecordStorePort —— record 持久化（固定实现）。
 *   append(event) / get(id) / list(filter) / rebuildFromLog()
 *   record 字段对齐 pi SubagentToolDetails 子集：
 *   {subagentId, slug, agent, model, status, closedReason, sessionId, exec,
 *    worktree, patchFile, tokens, startedAt, endedAt, error, runnerKind, notifyMode,
 *    targetSessionId}
 */

/**
 * WorktreePort —— 文件隔离（固定实现，可 no-op）。
 *   prepare(slug) -> {dir, branch}    干净主树校验 + 创建
 *   collectPatch(dir) -> patchFile    git diff 落 outputs（worktree 目录之外）
 *   cleanup(dir)                       清理 + 孤儿检测
 */

/**
 * registry：按配置组装运行时。上层唯一入口。
 * @param {object} opts
 * @param {'spawn'|'appserver'} [opts.runnerKind='spawn']
 * @param {'mailbox'|'polling'} [opts.notifyMode]   缺省按 env 自动探测
 */
function createRuntime(opts = {}) {
  // 实现在 W1/W2 接线；本函数是唯一允许 import 具体实现的地方。
  const runnerKind = opts.runnerKind || 'spawn';
  let notifyMode = opts.notifyMode;
  if (!notifyMode) {
    const { mailboxEnabled } = require('./config');
    notifyMode = mailboxEnabled() ? 'mailbox' : 'polling';
  }
  const Runner = runnerKind === 'appserver'
    ? require('./runner-appserver')
    : require('./runner-spawn');
  const ModelRouter = require('./model-router');
  const Notifier = notifyMode === 'mailbox'
    ? require('./notifier-mailbox')
    : require('./notifier-mailbox'); // 同模块导出 PollingNotifier
  return {
    runnerKind,
    notifyMode,
    createRunner: () => new Runner(),
    createModelRouter: () => new ModelRouter(),
    createNotifier: () => notifyMode === 'mailbox'
      ? new Notifier.MailboxNotifier()
      : new Notifier.PollingNotifier(),
  };
}

module.exports = { createRuntime, DEFAULTS };
