'use strict';
/**
 * 端口契约（设计文档 DESIGN-v3.md §3.1/§5.3）。
 *
 * 这是 zsub 的「决策可换」地基：manager.js 与上层入口（MCP server / CLI）
 * 只依赖本文件声明的接口，不依赖任何具体实现。正交决策位：
 *
 *   决策位① 执行引擎  RunnerPort     : core zcode engine（回接 2c，D6-⑥ 后唯一
 *                                      通道——appserver 已退役，spawn 驱动归
 *                                      vendored subagent-core，zsw 不再有自有实现）
 *   决策位② 回流通道  NotifierPort   : mailbox（主）| polling（兜底）| task-notification（预留）
 *   决策位③ 入口形态  （MCP / CLI）   : dist/mcp/server.js 与 bin/zsw.js 都只是 manager 的薄壳
 *
 * 更换决策 = 在 createRuntime 里换一个实现类，manager 零改动。
 * 平台版本漂移（zcode 闭源升级）被限制在端口实现与 core 引擎内部消化。
 *
 * 本文件只含 JSDoc 契约 + registry 工厂，不含实现。
 */

const DEFAULTS = require('./config').DEFAULTS;

/**
 * @typedef {Object} AgentProfile   agent .md 解析结果（AgentResolverPort）
 * @property {string} name          frontmatter name（缺省取文件名）
 * @property {string} description
 * @property {string} filePath      绝对路径（唯一性来源）
 * @property {string} [model]       frontmatter model（解析链中间层；执行校验归
 *                                  core 引擎 preparer）
 * @property {string} [engine]      frontmatter engine（core 路由三层优先级的
 *                                  frontmatter 层；缺省 zcode）
 * @property {string[]} [tools]     白名单（仅 buildPrompt 软约束；D6 显式决策：
 *                                  不升级为 toolAllowlist，spawn 单轮无 flag 通道）
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
 * @property {string} [modelRef]    模型引用（原始请求透传——短名/全名均可，
 *                                  校验与兜底归 core 引擎 preparer）
 * @property {number} [timeoutMs]   超时预算（null/undefined = 不限时）
 * @property {boolean} conversation 允许续聊（record 状态机语义；spawn 单轮下
 *                                  message 续聊报可操作错误，见 runner-core）
 * @property {string} [engine]      调用参数显式引擎（core 路由三层最优先层；
 *                                  workflow agent({engine}) 透传面）
 * @property {string} [agentEngine] agent .md frontmatter engine（第二层）
 * @property {string[]} [disallowedTools]  agent .md frontmatter 来源的工具黑名单
 *                                  （裸工具名）：与 toolDenylist 并集去重后落
 *                                  core 引擎 --disallowed-tools flag（硬约束）
 * @property {string} [thinking]    thinking 档位请求值（F4/D5）：当前引擎通道
 *                                  未映射该请求值，请求了不生效（record 如实
 *                                  标注「请求未生效」）
 * @property {string[]} [toolAllowlist] CLI --allow-tools 来源（F4/D6）：引擎无
 *                                  白名单 flag 通道，请求不消费（record 如实
 *                                  标注）
 * @property {string[]} [toolDenylist]  CLI --deny-tools 来源（F4/D6）：与
 *                                  disallowedTools 并集去重入引擎 denylist
 */

/**
 * @typedef {Object} RunResult      一次运行的结果
 * @property {'closed'|'error'|'timeout'|'cancelled'} [status]
 * @property {string} response      模型最终输出文本
 * @property {object} [usage]       {input_tokens, output_tokens, ...}
 * @property {string} [sessionId]   zcode session id（P3 冷续聊回归的定位锚）
 * @property {string} [engineId]    实际执行引擎 id（core 路由留痕，V3-①）
 * @property {{from: string, reason: string}} [engineFallback]  probe 失败 fallback
 *                                  留痕（V3-③；调用参数显式指定则不兜底）
 * @property {string} [error]
 * @property {'protocol-drift'} [errorKind] 错误分类（F1/D3）：core 引擎错误不经
 *                                  JSON-RPC 通道，该分类面随 appserver 退役——
 *                                  字段保留兼容旧 record 读取
 */

/** 端口实现必须在启动/注册时自检并声明能力，manager 据此分流与降级。 */

/**
 * RunnerPort（决策位①）——执行引擎（core zcode engine 适配，lib/runner-core.js）。
 *
 * 契约：
 *   probe()                          启动探针（透传 core ProbeReport；不再做
 *                                    组装期门控/降级决策——routeEngine 每任务
 *                                    真探，引擎实例内缓存）
 *   start(taskCtx, hooks?) -> RunHandle
 *                                    启动一次任务；立即返回，不等待完成；
 *                                    prepare 期错误（凭据缺失/模型不可用/路由
 *                                    失败）在 done promise 上 reject（调用方
 *                                    catch 收口）。hooks.onExec(snapshot) 在
 *                                    exec 字段异步就绪时回调浅拷贝快照
 *                                    （engineId/pid/poolKey/sessionId 各一次）
 *                                    ——manager 据此追加 update 事件持久化
 *                                    pid（running 事件序列化于 spawn 之前，
 *                                    不补落盘则重启 rebuild 后探活无依据）
 *   resume(exec, message, opts)      续聊：core EnginePort 面无 resume 入口，
 *                                    显式报可操作错误（P3 常驻实现回归路线）
 *   alive(exec) -> boolean           探活（崩溃恢复用；唯一消费面
 *                                    manager.recover）。W6a2 起按 exec.kind
 *                                    分支：spawn = pid 信号 0 探测（ESRCH →
 *                                    死，EPERM → 活）；appserver = 保守视为
 *                                    存活——core 未暴露任务级探活面（常驻
 *                                    进程 pidfile/activeSessions/连接状态全
 *                                    是引擎内部实现，barrel 未导出探活原语），
 *                                    且「常驻进程活着」≠「本任务 turn 在推进」；
 *                                    recover 语境下句柄已丢、结果无论是否推进
 *                                    都无法回流，orphan（建议 cancel 后重发）
 *                                    才是正确处置，不发明「进程已死」的失真
 *                                    断言
 *   release(exec)                    一次性会话终态释放：no-op（spawn 单轮 done
 *                                    即进程退出；appserver 常驻会话跨任务共享，
 *                                    引擎内部 attempt 收尾时已退订——本层无
 *                                    per-record 释放面）；实现完整契约面，上
 *                                    层可统一调用
 *   shutdown()                       进程级收尾（W6a2 新增；dispose 责任链）：
 *                                    ① 宿主持有的引擎实例逐个 dispose
 *                                    （appserver 常驻进程收割入口——EnginePort
 *                                    .dispose 契约 fire close 帧 → SIGTERM →
 *                                    grace → SIGKILL，幂等；注意 core
 *                                    killAllSpawnedChildren 的内部 dispose 只
 *                                    覆盖 registry 单例，zsw 真正跑任务的实例
 *                                    在 runner 惰性表——不补这步常驻进程必泄
 *                                    漏；dispose 先于 killAll，close 帧必须先
 *                                    于 SIGTERM）② killAllSpawnedChildren 兜底
 *                                    （spawn 形态 per-record 子进程）。
 *                                    调用点（dispose 责任链的宿主侧）：
 *                                    daemon 退出面（assemble 组合进
 *                                    wfHost.shutdown，MCP server stdin 关闭时
 *                                    触发）+ CLI 一次性进程任务完成面
 *                                    （bin/zsw.js 的 zflow run 与 --local，防
 *                                    appserver pipe stdio 挂住父进程事件循环
 *                                    致 CLI 无法自然退出）
 *   capabilities()                   能力声明
 *
 * @typedef {Object} RunHandle
 * @property {object} exec            会话句柄，原样存入 record.exec。权威形状见
 *                                    lib/runner-core.js 头注「exec 句柄」节：
 *                                    {kind:'spawn'|'appserver', pid?,
 *                                    sessionId?, sessionRef?, engineId?,
 *                                    poolKey?, cwd}——kind 初始 'spawn'，命中
 *                                    appserver 常驻路径经 onHandleReady 翻转
 *                                    'appserver'（sessionRef={dbPath,sessionId}
 *                                    为 appserver 形态专属；pid 仅 spawn 形态
 *                                    回填）。manager 不解读句柄内部语义，但按
 *                                    exec.kind 分流处置（recover 探活与
 *                                    lostReason 文案，见 RunnerPort alive()
 *                                    契约）。字段异步回填（可变引用）——消费方
 *                                    需要落盘时机的，经 start 的 hooks.onExec
 *                                    快照通道订阅，不要轮询引用
 * @property {function(): void} cancel   取消（AbortSignal → core 杀链
 *                                    SIGTERM→grace→SIGKILL）
 * @property {Promise<RunResult>} done    完成 promise（含超时/取消终态）
 *
 * @typedef {Object} RunnerCapabilities
 * @property {'none'|'stdin'|'session-send'} steering   running 中追加消息的能力
 * @property {number} coldStartMs                                每轮启动开销估计
 * @property {'spawn'|'appserver'} kind                          台账保守基线恒
 *                                    'spawn'（probe 失败/漂移降级恒可达；是否
 *                                    命中 appserver 常驻是 per-task 事实，落
 *                                    exec.kind 翻转留痕，不在此预判——W6a2）
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
 * ModelRouterPort —— 模型清单器（2c 瘦身后只剩 shell 面；执行解析归 core
 * 引擎 preparer）。
 *
 * 契约：
 *   listModels(provider?) -> 模型条目数组     缺省 = 默认 provider 视图（models action
 *                                             数据源）；清单不可读抛可操作错误
 *   allProviders() -> [{provider, models}]    全 provider 结构化视图（models --all 数据源；
 *                                             只列合格 provider，模型名升格全名）
 *   resolveDefault() -> modelRef              默认模型回退链产物（record.model 台账
 *                                             展示值；执行校验归引擎 preparer）
 */

/**
 * AgentResolverPort —— agent .md 发现与解析（固定实现，接口化为可测）。
 *   list(cwd) -> AgentProfile[]      四根 + vendored 内置（遮蔽序：project 两根
 *                                     > vendored 内置 > user 两根；W6a 起 core
 *                                     discoverResources 单实现）
 *   resolve(ref, cwd) -> AgentProfile | null
 *                                     D-4a 收紧（W6b）：ref 仅 .md 绝对路径
 *                                     （~/ 展开同 core normalizeRef 口径）；
 *                                     名字/相对路径/非 .md 一律 null——调用方
 *                                     （manager.start / agent-runner-adapter）
 *                                     经 normalizeAgentRef 先归一，非法抛
 *                                     invalidAgentRefMessage（与 core
 *                                     agent-registry 文案同源），合法但 null 抛
 *                                     agentFileNotFoundMessage
 *   resolveDefault(cwd) -> AgentProfile | null
 *                                     D-4 缺省统一（W6b）：agent 参数缺省 =
 *                                     general-purpose 内置角色（遮蔽序胜者，
 *                                     project 级同名 .md 可覆写）；发现面异常
 *                                     时 vendored 直读兜底，再 miss 返回 null
 *                                     （调用方诚实裸跑，record.agent 如实 null）
 */

/**
 * RecordStorePort —— record 持久化（固定实现）。
 *   append(event) / get(id) / list(filter) / rebuildFromLog()
 *   record 字段对齐 pi SubagentToolDetails 子集：
 *   {subagentId, slug, agent, model, status, closedReason, sessionId, exec,
 *    worktree, patchFile, tokens, startedAt, endedAt, error, runnerKind, notifyMode,
 *    targetSessionId}（2c 新增 optional：engine / engineFallback——留痕面，旧数据
 *   读取不受影响）
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
 * @param {'mailbox'|'polling'} [opts.notifyMode]   缺省按 env 自动探测
 */
function createRuntime(opts = {}) {
  // 决策位① 的「换实现」已随 appserver 退役收敛为单实现（core zcode engine）；
  // 本函数仍是唯一 import 具体实现的地方，未来新引擎（P3 常驻）在此接线。
  const Runner = require('./runner-core');
  const ModelRouter = require('./model-router');
  let notifyMode = opts.notifyMode;
  if (!notifyMode) {
    const { mailboxEnabled } = require('./config');
    notifyMode = mailboxEnabled() ? 'mailbox' : 'polling';
  }
  const Notifier = require('./notifier-mailbox');
  return {
    notifyMode,
    createRunner: () => new Runner(),
    createModelRouter: () => new ModelRouter(),
    createNotifier: () => notifyMode === 'mailbox'
      ? new Notifier.MailboxNotifier()
      : new Notifier.PollingNotifier(),
  };
}

module.exports = { createRuntime, DEFAULTS };
