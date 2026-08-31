'use strict';
/**
 * zsub MCP stdio server（决策位③入口：双 tool——zsub 编排 + zflow）。
 *
 * 为什么粗粒度收敛而不是每 action 一个 tool：Z1 实测 MCP tool 的
 * name+description+inputSchema 全量常驻注入每个 LLM 请求（无按需加载），
 * 细粒度多 tool 的 token 成本线性上涨——所以编排原语收敛为 `zsub`
 * tool（action 枚举参数），description 压到 ≤1.25KB，完整用法与分流哲学放
 * skill zsub-zflow-orchestration（Z7 渐进式：一行索引常驻，正文按需读）。
 *
 * 协议：MCP over stdio，换行分隔的 JSON-RPC 2.0（照 dynamic-workflow
 * dist/mcp/server.js 已验证的手写协议层风格）。stdout 只走协议帧，
 * 诊断日志一律 stderr。
 *
 * 防递归（D10 双门禁）：第一重 = 隔离 HOME 无 plugins 配置（子进程物理上
 * 不加载 zsub）；本文件是第二重 = ZSW_NESTED=1 时不注册工具且拒绝 tools/call。
 *
 * 启动序列：NESTED → 只挂协议层；否则 notifier.sweepStaleTmp（mailbox 档）
 * → manager.recover()（record 重建 + 探活）→ startDaemon（unix socket 控制面，
 * DESIGN-v4 D2/D3：锁文件竞选，daemon 独占 socket 服务角色，standby 挂看门狗
 * 等接管）→ 挂 stdin。standby 的 manager 照常初始化（M1 起工具面已恒空，
 * standby 与 daemon 在 MCP 面无行为差异；manager 保留供本实例成为 daemon 后
 * 服务 socket 面）。
 *
 * tools 面已下线（DESIGN-v4 §6.1 D1 终态，1.0.0 起内置）：tools/list 恒空
 * （零上下文注入）、tools/call 恒给「走 CLI」指引。zsub/zflow 的全部能力经
 * socket 控制面 + CLI（bin/zsw.js，默认 thin client）提供。buildTools/
 * buildToolHandlers 保留：后者是 socket 分发的数据源，前者供定义级单测。
 *
 * 多 tool 结构（M3 接线，N2-b 改造）：tool 注册表形态——buildTools() 出定义
 * 数组，buildToolHandlers() 出 handler 表 { [toolName]: handler(params, env) }，
 * tools/call 两级分发（第一级按 params.name 查表，未命中 -32601；第二级
 * 进对应 handler）。两个 tool：zsub（九 action 编排，M0 起 +wait）与 zflow
 * （九 action：run / abort / status / list / scripts / lint + 创作闭环三 action
 * script-generate / script-save / script-delete，W8 / D-6）。
 *
 * daemon socket 面（M0 接线）：buildDaemonHandlers() 把 handler 表适配成
 * daemon-socket 要的 (req:{tool,params}, meta:{signal}) 形态，并解包 MCP
 * content 包装——CLI 对侧（bin/zsw.js）直接消费业务字段（如 wait 的
 * partial 决定 exit code），content 包装形态对 CLI 是泄漏。
 *
 * zflow 管理面（回接 2b：vendored subagent-core orchestration；W8 增创作闭环）：
 * - 九 action（run/abort/status/list/scripts/lint/script-generate/script-save/
 *   script-delete）走 orchestration host（lib/orchestration-host.js）与 bin/zsw.js
 *   的共享创作实现：core runWorkflow/abortRun/FileRunStore + vendored 内置资产
 *   注册 + core generate/save/delete 管线（zsw 目录布局 ~/.zsw/workflows）。run
 *   立即返回 {runId, stateFile}；wait=true 走 runAndWait 同步等终态 +
 *   scriptResult（MCP 30s 超时，主要给测试）。script-delete 的「运行中拒绝」
 *   由 daemon 侧 runs 真实状态裁决（runningScriptPredicate(wfHost)）。
 * - 校验/组参权威在 host 的 normalizeRunParams + registry（task/workdir/
 *   workflow 名/脚本发现/$ARGS 映射均它管），server 不重复解析——两处各
 *   解析一份会漂移。workflow 引用契约（D-4：script:/裸名拒收）在入口面校验
 *   （bin/zsw.js 的 validateWorkflowRef，CLI 与 socket 面单一来源）。旧
 *   reviewers sugar 在 host 层显式报错（core 契约批次值 = agent .md 路径）；
 *   maxConcurrent/timeoutMsPerPhase 无 core 对应面，以 warnings 显式说明不静默。
 * - run 状态面 = 内存 runs Map（done 保留 MAX_RETAINED_DONE_RUNS 条）+
 *   <zswRoot>/workflow-state/<runId>.jsonl append-only 快照；zsw record
 *   事件流与 mailbox 完成通知线随旧 WorkflowManager 退役。
 * - daemon 生命周期钩子：启动/接管 → host.recoverOrphans()（遗留 running
 *   标 done,failed）；stdin 关闭 → host.shutdown()（terminateRunningRuns）。
 *
 * 可测性：纯函数（extractSessionId / buildToolDefinition /
 * buildRunWorkflowToolDefinition / buildTools / buildToolHandlers /
 * buildDaemonHandlers / createFrameDecoder / createServer / createManager）
 * 导出供 node:test，wfHost / waitHandler 经 buildToolHandlers /
 * createServer 参数可注入 fake（manager 同款模式）；stdio 主循环只在
 * require.main === module 时启动，require 零副作用。
 */

const path = require('node:path');
const config = require('../../lib/config');
const { PROVIDER_ID } = require('../../lib/model-router');

// S5：版本与 package.json 同源（require 缓存 + 发版流程统一 bump，防止
// SERVER_INFO 手抄漂移——修复前 0.1.0 vs 实际 0.0.1 已然漂移）
const SERVER_INFO = { name: 'zsw', version: require('../../package.json').version }; // MCP server 标识用插件缩写；TOOL_NAME 是 tool 语义名，两者不同源
const TOOL_NAME = 'zsub';
const RUN_WORKFLOW_TOOL_NAME = 'zflow';

// ---------------------------------------------------------------- 纯函数区

/**
 * 从 tools/call 的 params._meta 提取目标会话 id（Z3 实测通道：
 * `com.zcode/request-context`.session_id，runtime 主路径默认携带）。
 * 取不到返回 undefined——mailbox 投递自然降级（notifier 侧返回
 * delivered:false），不报错：CLI / 异常入口本来就没有会话上下文。
 */
function extractSessionId(meta) {
  const rc = meta && meta['com.zcode/request-context'];
  const sid = rc && rc.session_id;
  return typeof sid === 'string' && sid !== '' ? sid : undefined;
}

/**
 * zsub 单 tool 定义（现有测试与外部依赖此单 tool 形态，故独立保留）。
 * description 是常驻注入成本，控制在 ≤1250 字符（见头注）。
 */
function buildToolDefinition() {
  return {
    name: TOOL_NAME,
    description:
      '编排后台 subagent 生命周期（zcode 外挂编排器，与原生 background agent 互补）。action 速查：\n'
      + '- start：后台启动任务，立即返回 subagentId；完成后结果通知本会话（mailbox 自动到达，否则按返回指引查询）。参数：task（必填，自包含任务书）、slug（必填，短名）、agent?（.md 绝对路径，支持 ~/；缺省 = general-purpose 内置角色）、model?、schema?（输出契约）、worktree?（改动隔离，完成回传 patch 与 git apply 指引）、conversation?（可续聊）、wait?（同步等结果）、timeoutMs?。\n'
      + '- list：任务精简列表（id/slug/status/error/patchFile）。\n'
      + '- status：单任务全量 + 结果文件路径（subagentId；closed 后 Read 该文件取全文）。\n'
      + '- message：向 idle 的 conversation 任务投递续聊消息（subagentId + text）。\n'
      + '- cancel：取消运行中任务（subagentId）。\n'
      + '- close：终态化任务并清理 worktree（subagentId）。\n'
      + '- agents：列出可用 agent .md（core 发现面：vendored 内置 10 角色 + 项目 .agents/agents > .zcode/agents > HOME 同构两根；返回 name/description/when/location（.md 绝对路径）/来源根）——start 的 agent 参数只收路径，不确定路径时先查这个。\n'
      + '- models：列出可用模型（短名/上下文窗口/推理档位）——路由决策前先查。all=true 出全 provider 视图（跨 provider 引用须全名 <provider>/<model>）。\n'
      + '- wait：等待指定 id 集合到终态（ids 数组 + timeoutMs?；全部终态回 results，超时回 partial+pending）。\n'
      + '何时委派：读 3+ 文件、写 100+ 行实现、可并行的研究/审查——自己干会淹上下文。start 前先 list——已有 running 任务可复用，防上下文压缩后丢 id。同一回复发多个 start = 并发执行（默认上限 3）。\n'
      + '纪律：①task 必须自包含——子进程看不到当前会话任何上下文，目标/验收/关键路径全写进 task；②禁止轮询——完成通知自动到达，mailbox 未启用时 start 返回值附轮询指引；③简单后台任务优先原生 background agent，需要 worktree 隔离/续聊/schema/四根 agent 生态时才用 zsub。\n'
      + '完整用法与分流哲学：加载 skill zsub-zflow-orchestration。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'list', 'status', 'cancel', 'message', 'close', 'agents', 'models', 'wait'],
          description: '要执行的操作',
        },
        task: {
          type: 'string',
          description: 'start 必填。自包含任务书：目标、背景、验收标准、关键文件路径——子进程看不到当前会话上下文',
        },
        slug: { type: 'string', description: 'start 必填。任务短名（通知文案与 worktree 分支名）' },
        agent: { type: 'string', description: 'start 可选。agent .md 绝对路径（支持 ~/ 前缀；取 agents action 的 location 列）。缺省不传 = 加载 general-purpose 内置角色；不想要角色请显式传自定义 .md 路径。名字引用已废弃（传名会被拒并给路径指引）' },
        model: { type: 'string', description: 'start 可选。provider/model 全名（精确匹配任意已配置 provider）或短名（按默认 provider 解析）' },
        schema: { description: 'start 可选。输出契约（字符串或 JSON Schema 对象），以 MANDATORY 段拼入 prompt' },
        worktree: { type: 'boolean', description: 'start 可选。true 时改动落独立 worktree，完成后回传 patch 与 git apply 指引' },
        conversation: { type: 'boolean', description: 'start 可选。true 时首轮完成后进入 idle，可用 message 续聊' },
        wait: { type: 'boolean', description: 'start 可选。true 时同步等待完成并返回结果全文（注意 MCP 30s 超时）' },
        timeoutMs: { type: 'number', description: 'start/wait 可选。start：任务执行超时（不填则无超时限制）；wait：等待上限，到点回 partial' },
        thinking: { type: 'string', description: 'start 可选。thinking 档位（如 low|high|max，合法值按模型动态，GLM 默认 max）。当前引擎通道不消费该请求值——请求后终态 record 落 thinking="null (请求未生效：引擎通道未映射)" 如实标注' },
        allowTools: { type: 'array', items: { type: 'string' }, description: 'start 可选。允许工具名清单（裸工具名）。MCP 直调面传字符串数组，如 ["Read","Grep"]；CLI 面为逗号分隔字符串（--allow-tools "Read,Grep"）。当前引擎无白名单 flag 通道不消费——终态 record 落 toolsNote 如实标注' },
        denyTools: { type: 'array', items: { type: 'string' }, description: 'start 可选。禁止工具名清单（裸工具名）。MCP 直调面传字符串数组，如 ["Bash","WebSearch"]；CLI 面为逗号分隔字符串（--deny-tools "Bash,WebSearch"）。与 agent .md frontmatter disallowedTools 并集去重后落引擎 --disallowed-tools flag 硬生效' },
        subagentId: { type: 'string', description: 'status/cancel/message/close 必填。start 返回的任务 id' },
        ids: { type: 'array', items: { type: 'string' }, description: 'wait 必填。要等待的 subagentId 数组（来自 start 返回 / list 查询）' },
        text: { type: 'string', description: 'message 必填。续聊消息文本' },
        all: { type: 'boolean', description: 'models 可选。true = 全 provider 视图（模型为全名 <provider>/<model>），缺省仅默认 provider' },
      },
      required: ['action'],
    },
  };
}

/** 内置 workflow 清单的单一来源是 orchestration-host（scripts action 经
 * wfHost.scripts().builtin 返回）——server 不再持第二份内置清单，防漂移。 */

/**
 * zflow tool 定义（回接 2b：九 action 走 orchestration-host = vendored
 * subagent-core orchestration + W8 创作闭环三 action）。
 *
 * description 是常驻注入成本，上限压到 ≤1000 字符。workflow 值是自由 string
 * 而非静态 enum：自定义脚本路径是动态发现的，静态枚举无法收录，合法值说明进
 * description（内置 5 名 / .js 绝对路径——script:<name> 与裸名已按 D-4 契约
 * 废弃拒收），运行期由入口校验（validateWorkflowRef）+ host 的 registry 解析。
 */
function buildRunWorkflowToolDefinition() {
  return {
    name: 'zflow',
    description:
      'Deterministic multi-step workflows (vendored subagent-core orchestration); each agent() call = an isolated agent session. ' +
      'action=run returns runId at once (query via status; CLI run is synchronous). ' +
      'Workflows: "chain" analyze->transform->synthesize; "parallel" multi-perspective review + aggregate; ' +
      '"map-reduce" map over a KNOWN items array; "scatter-gather" split, parallel, merge; ' +
      '"review-fix-loop" batches (batch1..batchN = agent .md absolute paths) review->fix->re-review to clean (WRITES files); ' +
      'custom scripts (@pi-meta + top-level agent()) by ABSOLUTE .js path; script:<name> deprecated/rejected. ' +
      'Management: abort/status(runId), list, scripts (builtin 5 + custom paths); lint(file) validates. ' +
      'Creative loop: script-generate(name, script) 5-gate validation (ESM/meta/agent()/syntax/round-trip w/ line-col) -> tmp; ' +
      'script-save(name) tmp -> ~/.zsw/workflows (dup refused); script-delete(name) (refused if running). ' +
      'Runs can take minutes; WARNING: transform/fix may modify files under workdir.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'abort', 'status', 'list', 'scripts', 'lint', 'script-generate', 'script-save', 'script-delete'],
          description: '要执行的操作',
        },
        workflow: {
          type: 'string',
          description: 'run 必填。内置 5 名（chain / parallel / map-reduce / scatter-gather / review-fix-loop，形态见 tool description）或 core 契约脚本 .js 绝对路径（~/ 前缀可展开；script:<名> 与裸名已废弃拒收——路径先查 action=scripts 的 path 字段）',
        },
        task: {
          type: 'string',
          description: 'run 必填（chain/scatter-gather/script 形态）。自包含任务书——阶段会话看不到当前会话上下文。parallel 场景作为 target 回退；review-fix-loop 场景作为 target 回退（显式传 target 更清晰）',
        },
        workdir: { type: 'string', description: 'run 必填。Absolute path of the working directory the agent() calls operate in.' },
        model: {
          type: 'string',
          description: 'Run-level model override (RunSpec.model), exact match: "<provider>/<model>" full name resolves against any configured provider. Invalid names fail with the list of what is actually configured.',
        },
        runId: { type: 'string', description: 'abort/status 必填。run 返回的 wf- 前缀 id（list 可查全部）' },
        file: { type: 'string', description: 'lint 必填。脚本文件路径（scripts 返回的 path 字段，或自填绝对路径）' },
        name: {
          type: 'string',
          description: 'script-generate/script-save/script-delete 必填。脚本名（单段文件名，不含路径分隔符——落盘目录由 zsw 布局 ~/.zsw/workflows 决定）',
        },
        script: {
          type: 'string',
          description: 'script-generate 必填。完整 JS 源码：/* @pi-meta */ YAML 块注释（name/description/phases）+ top-level agent()；core 五道闸校验（ESM 拒/meta 必需/agent() 必需/语法/@pi-meta round-trip 含行列），通过后落 tmp',
        },
        wait: {
          type: 'boolean',
          description: 'run 可选。true 时同步等完成并返回 scriptResult（MCP 30s 超时约束，主要给测试用）',
        },
        timeoutMs: {
          type: 'number',
          description: 'run 可选。workflow 整体墙钟预算毫秒数（RunSpec.budgetTimeMs；不填则无超时限制）',
        },
        perspectives: {
          type: 'array', items: { type: 'string' },
          description: 'parallel only. Analysis perspectives. Default [security, performance, maintainability].',
        },
        items: {
          type: 'array', items: { type: 'string' },
          description: 'map-reduce only (required). The known items to map over.',
        },
        operation: {
          type: 'string',
          description: 'map-reduce only (required). What to do with each item.',
        },
        reviewTarget: {
          type: 'string',
          description: 'review-fix-loop only (legacy sugar). Same as targetType="text" + target=<value>.',
        },
        targetType: {
          type: 'string', enum: ['git-diff', 'file', 'dir', 'text'],
          description: 'review-fix-loop only. Target kind. Default "text".',
        },
        target: {
          type: 'string',
          description: 'review-fix-loop only. What to review: git-diff base ref (e.g. main), file path, dir path, or text description. Required.',
        },
        batch1: {
          type: 'array', items: { type: 'string' },
          description: 'review-fix-loop only. Reviewer agent .md absolute paths of batch 1 (comma-joined into the $ARGS.batch1 string); pass batch2, batch3... the same way. Batches run serially. At least one batchN (or agents) is required.',
        },
        batchNames: {
          type: 'array', items: { type: 'string' },
          description: 'review-fix-loop only. Display names for batches (comma-joined string). Defaults batch-1..N.',
        },
        maxRounds: {
          type: 'integer', minimum: 1,
          description: 'review-fix-loop only. Max review-fix rounds per batch. Default 10.',
        },
        stuckThreshold: {
          type: 'integer', minimum: 1,
          description: 'review-fix-loop only. Declare stuck after this many consecutive rounds without must-fix decrease. Default 3.',
        },
        skipCleanAgents: {
          type: 'boolean',
          description: 'review-fix-loop only. Skip reviewers that reported clean. Default true.',
        },
        recheckAfterFix: {
          type: 'boolean',
          description: 'review-fix-loop only. Re-dispatch ALL reviewers after each fix; previously-clean ones get a scoped regression-only recheck prompt. Default false.',
        },
        convergeNewIssues: {
          type: 'integer', minimum: 1,
          description: 'review-fix-loop only. Convergence: max new findings per round. Default 1.',
        },
        convergeRounds: {
          type: 'integer', minimum: 1,
          description: 'review-fix-loop only. Convergence: consecutive rounds within convergeNewIssues before converging. Default 2.',
        },
        maxFixAttempts: {
          type: 'integer', minimum: 1,
          description: 'review-fix-loop only. Regressed fix attempts per issue before needs-redesign. Default 2.',
        },
        aggregatorModel: {
          type: 'string',
          description: 'review-fix-loop only. Model for the aggregation phase. Default: same as the run model.',
        },
        reviewPrompt: {
          type: 'string',
          description: 'review-fix-loop only. Extra guidance appended to every reviewer prompt.',
        },
        fixPrompt: {
          type: 'string',
          description: 'review-fix-loop only. Extra guidance appended to the fixer prompt.',
        },
        fallowScan: {
          type: 'boolean',
          description: 'review-fix-loop only. Run a fallow static scan as a leading batch (requires targetType=git-diff). Default false.',
        },
        autoCommit: {
          type: 'boolean',
          description: 'review-fix-loop only. Let the fixer stage/commit its changes. Default false.',
        },
      },
      required: ['action'],
    },
  };
}

/**
 * 本 server 暴露的全量 tool 定义（tools/list 的数据源）。为什么是数组：
 * 注册表形态，追加 tool 只改本函数与 buildToolHandlers，tools/list 与
 * 分发层零改动。
 */
function buildTools() {
  return [buildToolDefinition(), buildRunWorkflowToolDefinition()];
}

/**
 * 换行分帧器（协议层独立于传输，便于单测）：吸收 chunk、按 \n 切帧。
 * 空/空白行忽略；\r\n 由 trim 兼容。
 */
function createFrameDecoder(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) onLine(line);
      }
    },
  };
}

/** 协议级错误（unknown method / unknown tool）：走 JSON-RPC error 帧。 */
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const okContent = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const errContent = (text) => ({ content: [{ type: 'text', text }], isError: true });

/**
 * 组装 manager 运行时（main 与测试共用）。实现收口在 lib/assemble.js
 * （MCP 与 CLI 入口共用同一组装点），本导出保留向后兼容签名。
 */
function createManager(opts = {}) {
  return require('../../lib/assemble').assembleManager(opts);
}

/**
 * tool handler 注册表工厂：{ [toolName]: handler(params, env) }。
 * - 为什么是工厂而不是模块级表：handler 闭包持有 manager / wfHost /
 *   nested，每次 createServer 一份，实例间互不串线。
 * - 为什么 null 原型 + hasOwnProperty 守卫：防止 params.name 撞 Object
 *   原型链属性名（如 "constructor"）被误当 handler 命中——注册表键必须
 *   精确匹配（改造前 `name !== TOOL_NAME` 严格比较的等价行为）。
 * - 嵌套门禁在各自 handler 内而非分发层：拒绝文案按 tool 定制。
 * - wfHost 参数：orchestration host 注入点（assembleManager 组装真实现 =
 *   vendored subagent-core orchestration 的 zsw 宿主），测试传 fake 即可
 *   全链路冒烟（manager 同款模式）。
 * - env.emitFrame：handler 中途发通知帧的通道，缺省 no-op（直接调用
 *   handler 的测试不需要收集通知帧）。
 * - agents action 的 resolver 经 manager.resolver 取（公开端口字段，构造
 *   直存）而非 server 再传一份：assembleManager 组装进 manager 的必然是
 *   同一实例，两份 resolver 会漂移（opts.resolver 注入时尤其如此）。
 * - waitHandler：wait action 的执行体（lib/wait-handler 工厂）。显式注入
 *   供测试；缺省 lazy 从 manager 创建（首次 wait 调用时才建——构造期建会
 *   让没有 pending 端口的 fake manager 在无关 action 上也无谓炸穿）。
 *   env.signal 透传（daemon socket 面的连接级取消；MCP 面恒 undefined =
 *   无取消，同步挂到终态或超时）。
 */
function buildToolHandlers({ manager, wfHost, nested = false, waitHandler } = {}) {
  let wait = waitHandler || null;
  function getWaitHandler() {
    if (!wait) wait = require('../../lib/wait-handler').createWaitHandler({ manager });
    return wait;
  }
  const handlers = Object.create(null);
  handlers[TOOL_NAME] = async (params, env = {}) => {
    if (nested) {
      return errContent(
        '嵌套调用已拒绝：嵌套环境（ZSW_NESTED=1 或 XYZ_AGENT_SUBAGENT=1）下 zsub 不提供编排（防递归第二重门禁，D10）。'
        + '恢复指引：这是预期行为，subagent 会话内不要调用 zsub。'
      );
    }
    if (!manager) {
      throw new RpcError(-32603, 'server 未初始化编排运行时');
    }
    const args = params.arguments || {};
    const action = args.action;
    try {
      // Z3 通道取目标会话；取不到 → undefined → mailbox 自然降级，不报错
      const ctx = {
        targetSessionId: extractSessionId(params._meta),
        cwd: env.cwd || process.env.ZCODE_PROJECT_DIR || process.cwd(),
      };
      switch (action) {
        case 'start':
          return okContent(await manager.start(args, ctx));
        case 'list':
          return okContent(manager.list());
        case 'status':
          return okContent(manager.status(requireSubagentId(args)));
        case 'cancel':
          return okContent(await manager.cancel(requireSubagentId(args)));
        case 'message': {
          const id = requireSubagentId(args);
          if (typeof args.text !== 'string' || args.text.trim() === '') {
            return errContent('message 需要 text（非空字符串，续聊消息内容）。');
          }
          // 必须 await：manager.message 是 async，不 await 会把 Promise 序列化
          // 成 '{}'——socket/CLI 面拿不到 round/notify 句柄（R4）
          return okContent(await manager.message(id, args.text));
        }
        case 'close':
          return okContent(await manager.close(requireSubagentId(args)));
        case 'wait':
          // 语义在 lib/wait-handler（DESIGN-v4 D4：终态立即收、运行中挂
          // pending promise 事件驱动唤醒、轮询兜底、abort 只取消等待不碰执行体）
          return okContent(await getWaitHandler()(args, { signal: env.signal }));
        case 'agents': {
          // 按需查询版 agent 索引：pi 的 <available_subagents> 每 turn 常驻
          // 注入在 zcode 平台做不到（进程内 extension API 才有），等价物是
          // 本 action——Z1 结论：MCP tool 常驻注入贵，按需查询零常驻成本。
          // resolver 取 manager.resolver（lib/assemble.js 组装进 manager 的
          // 公开端口字段，构造直存）：server 不再注入第二份，必然同一实例。
          // W6a 起数据源 = core 发现面（lib/agent-discovery，async list——
          // vendored 内置 10 角色 + 四根 + 目录 symlink 展开）。
          const resolver = manager.resolver;
          if (!resolver || typeof resolver.list !== 'function') {
            return errContent(
              'agents 需要 resolver 端口（agent .md 发现），当前 manager 未注入。'
              + '恢复指引：其他 action 不受影响；agents 排障查 lib/assemble.js 的 resolver 组装。'
            );
          }
          return okContent(await agentListView(resolver, ctx.cwd));
        }
        case 'models': {
          // 模型清单按需查询（与 agents 同理：常驻注入贵，按需零成本）。
          // 模型集随 v2 config 变化（桌面端启停即变），description/skill 里
          // 硬编码模型名会过时——路由决策前先查本 action。modelRouter 同样
          // 取 manager 公开端口字段（与 resolver 同一理由：单一实例防漂移）。
          const router = manager.modelRouter;
          if (!router || typeof router.listModels !== 'function') {
            return errContent(
              'models 需要 modelRouter 端口（v2 config 模型清单），当前 manager 未注入。'
              + '恢复指引：其他 action 不受影响；models 排障查 lib/assemble.js 的 modelRouter 组装。'
            );
          }
          // --all（跨 provider 兜底链闭合）：默认 provider 不可用时模型路由
          // 仍可走其他带凭据 provider，但查询面此前只有默认 provider 视图，
          // 兜底链在「查」这一环断头。--all 出全 provider 视图；缺省行为
          // （默认 provider 单视图）完全不变，既有消费方零感知。
          // --all 数据源 = router.allProviders()（下沉后的单一实现，本入口
          // 零复制）；清单不可读的可操作错误由外层 catch 原样透传。
          if (args.all === true) {
            // allProviders 端口守卫（与 listModels 同口径）：换实现缺该方法时给
            // 可操作错误，而非 TypeError 崩溃（契约声明见 lib/ports.js ModelRouterPort）
            if (typeof router.allProviders !== 'function') {
              return errContent(
                'models --all 需要 modelRouter 端口实现 allProviders()（跨 provider 模型清单），当前实现未提供。'
                + '恢复指引：缺省 models（不带 all）仍可查默认 provider 视图；排障查 lib/model-router.js 的 allProviders 与 lib/assemble.js 的 modelRouter 组装。'
              );
            }
            return okContent({
              all: true,
              providers: router.allProviders(),
              guidance: '跨 provider 引用必须用全名 <provider>/<model> 传 model；default 标记 = 该 provider 的默认模型。',
            });
          }
          // listModels 抛的清单不可读错误是可操作错误（含恢复指引），
          // 由外层 catch 原样透传
          return okContent({
            provider: PROVIDER_ID,
            models: router.listModels(),
            guidance: '选择指引：重量任务（设计/架构/深调研/复杂修复）省略 model 用默认（default 标记）；简单任务（探索/计数/格式转换/测试）传轻量模型短名降成本。',
          });
        }
        default:
          return errContent(
            `不支持的 action "${String(action)}"。支持：start | list | status | cancel | message | close | agents | models | wait。`
            + '恢复指引：action 必须取 inputSchema 中的枚举值。'
          );
      }
    } catch (e) {
      // manager 抛的都是可操作错误（含恢复指引），原样回给主 agent
      return errContent(String(e && e.message || e));
    }
  };
  handlers[RUN_WORKFLOW_TOOL_NAME] = async (params, env = {}) => {
    if (nested) {
      return errContent(
        '嵌套调用已拒绝：嵌套环境（ZSW_NESTED=1 或 XYZ_AGENT_SUBAGENT=1）下不提供 zflow（防递归第二重门禁，D10）。'
        + '恢复指引：这是预期行为，workflow 阶段会话内不要调用 zflow。'
      );
    }
    if (!wfHost) {
      throw new RpcError(-32603, 'server 未初始化 workflow 运行时');
    }
    const args = params.arguments || {};
    // run 的透传参数剔除 action（host 的 normalizeRunParams 会把保留键外的
    // 透传键组进 $ARGS，action 泄漏进去会污染脚本参数）
    const { action, ...runArgs } = args;
    const ctx = {
      targetSessionId: extractSessionId(params._meta),
      cwd: env.cwd || process.env.ZCODE_PROJECT_DIR || process.cwd(),
    };
    try {
      switch (action) {
        case 'run': {
          // 校验/组参权威在 orchestration-host（normalizeRunParams + registry
          // 解析），抛的都是含恢复指引的可操作错误。wait=true 走同步
          // runAndWait（scriptResult 直返；MCP 30s 超时，测试用）。
          // D-4 引用契约入口收紧（socket 面与 CLI 共用 bin/zsw.js 的单一实现，
          // 防两入口漂移）：script:/裸名在此拒收
          const { validateWorkflowRef } = require('../../bin/zsw.js');
          validateWorkflowRef(runArgs.workflow);
          if (args.wait === true) {
            return okContent(await wfHost.runAndWait(runArgs, ctx, { signal: env.signal }));
          }
          return okContent(await wfHost.run(runArgs, ctx));
        }
        case 'abort':
          return okContent(await wfHost.abort(requireRunId(args)));
        case 'status':
          return okContent(wfHost.status(requireRunId(args)));
        case 'list':
          return okContent(wfHost.list());
        case 'scripts': {
          // vendored 内置 5 + core 发现面 + .zsw 根用户脚本；发现根 =
          // workspace cwd（ctx 组装同 zsub）。builtin/scripts 均以 host 返回
          // 为单一来源（host 内置表与 registry 同源——server 不再持第二份
          // 内置清单，防两处漂移）；scripts 条目补 file 兼容字段（lint action
          // 的 file 参数指引用旧字段名）
          const found = await wfHost.scripts(ctx.cwd);
          return okContent({
            builtin: found.builtin,
            scripts: found.scripts.map((s) => ({
              name: s.name,
              description: s.description || '',
              path: s.path,
              file: s.path, // 兼容旧字段名（lint action 的 file 参数指引）
              available: s.available,
              source: s.source,
            })),
          });
        }
        case 'lint': {
          if (typeof args.file !== 'string' || args.file.trim() === '') {
            return errContent(
              'lint 需要 file（脚本文件路径）。恢复指引：先 scripts 查看已发现脚本的 path 字段，或直接给绝对路径。'
            );
          }
          return okContent(await wfHost.lint(args.file));
        }
        // 创作闭环三 action（W8 / D-6）：实现与 CLI 共用 bin/zsw.js 导出的单一
        // 来源（core generate/save/delete 管线 + zsw 目录布局）。CLI 面
        // script-generate 恒本地、save/delete 默认经 daemon——本 handler 是
        // socket 面（daemon 进程内）权威路径：delete 的「运行中拒绝」在此用
        // daemon 持有的 runs 真实状态裁决，save 后的发现面 invalidate 也落在本
        // 进程。script-generate 分支为 dispatch 表完备性保留（CLI 不经此路）。
        case 'script-generate': {
          const { scriptGenerateAction } = require('../../bin/zsw.js');
          return okContent(scriptGenerateAction(args.name, args.script));
        }
        case 'script-save': {
          const { scriptSaveAction } = require('../../bin/zsw.js');
          return okContent(await scriptSaveAction(args.name));
        }
        case 'script-delete': {
          const { scriptDeleteAction, runningScriptPredicate } = require('../../bin/zsw.js');
          return okContent(scriptDeleteAction(args.name, runningScriptPredicate(wfHost)));
        }
        default:
          return errContent(
            `不支持的 action "${String(action)}"。支持：run | abort | status | list | scripts | lint | script-generate | script-save | script-delete。`
            + '恢复指引：action 必须取 inputSchema 中的枚举值。'
          );
      }
    } catch (e) {
      // wfHost 抛的都是可操作错误（含恢复指引），原样回给主 agent
      return errContent(String(e && e.message || e));
    }
  };
  return handlers;
}

/**
 * daemon socket 面适配器（DESIGN-v4 D2 / §7：M0 接线）。
 *
 * 形态转换两端：
 * - 入参：socket 帧 {tool, params, cwd?} 的 params 是业务参数本体（CLI
 *   bin/zsw.js 组的 {action, ...}），而 MCP handler 吃 tools/call 的
 *   {arguments, _meta} 形态——这里包一层 {arguments: params}。_meta 刻意
 *   不带：socket 面无会话定向语义（D6），ctx.targetSessionId 恒 undefined，
 *   mailbox 侧自然降级。
 *   req.cwd（MF7 帧协议扩展，daemon-socket 传输层已做 string 类型守卫）
 *   非空 string 时透传为 handler 第二参 env.cwd——handler 内既有
 *   `env.cwd || ZCODE_PROJECT_DIR || process.cwd()` 链自然取到发起方目录
 *   （多 worktree 下 agent 发现 / worktree 定位不再落到 daemon 宿主 cwd）。
 * - 出参：MCP handler 返回 okContent/errContent 包装，socket 帧的 result
 *   必须是业务对象——CLI 直接消费业务字段（如 wait 的 partial 决定 exit
 *   code、start 的 subagentId 供 --wait sugar 追发），content 包装对 CLI
 *   是泄漏。isError 包装解包为 throw（daemon-socket 统一映射成 ok:false 帧，
 *   CLI 侧 exit 1 + stderr 打印，与 MCP 面 isError 语义等价）。
 * - env.signal 原样透传：连接级 AbortSignal（CLI 断连取消挂起的 wait，
 *   不碰执行体，lib/wait-handler 的 abort 语义）。
 */
function buildDaemonHandlers(toolHandlers) {
  const table = Object.create(null);
  for (const name of Object.keys(toolHandlers)) {
    table[name] = async (req, meta = {}) => {
      const wrapped = await toolHandlers[name](
        { arguments: req && req.params },
        {
          signal: meta.signal,
          // 非空 string 才透传（帧协议安全边界：cwd 不校验存在性——handler 层
          // workdir/resolver 已有存在性校验——但 daemon 侧仅接受 string 类型）
          cwd: typeof req.cwd === 'string' && req.cwd !== '' ? req.cwd : undefined,
        },
      );
      return unwrapContentResult(wrapped);
    };
  }
  return table;
}

/** MCP content 包装 → socket 帧业务 result（见 buildDaemonHandlers 头注）。 */
function unwrapContentResult(wrapped) {
  const text = wrapped && Array.isArray(wrapped.content)
  && wrapped.content[0] && typeof wrapped.content[0].text === 'string'
    ? wrapped.content[0].text
    : '';
  if (wrapped && wrapped.isError) {
    throw new Error(text || 'handler 返回未知错误形态（content 包装缺失）');
  }
  // okContent 对非 string 值走 JSON.stringify——parse 还原业务对象；string
  // 值（理论不可达，manager 各 action 都返回对象）parse 失败则原样回退
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * 协议处理器（可测）：输入一个 JSON-RPC 消息对象，返回待写出的帧数组。
 * 通知帧（无 id）不产生输出；tools/call 串行排队由调用方（main 循环）保证。
 * emitFrame：handler 执行中途的通知帧（progress）实时写出通道——这些帧
 * 无法进本函数的返回值数组（返回时机在 handler 完成后），main 传
 * writeFrame 即按真实时序推送。
 * toolsDisabled：已废弃的注入位，1.0.0 起工具面恒空（终态内置，原
 * ZSW_TOOLS_DISABLED 灰度开关删除——自用单用户场景无灰度对象）。参数保留
 * 仅为兼容旧签名，任何值都不改变行为。
 */
function createServer({ manager, wfHost, nested = false, log = () => {}, emitFrame = () => {} } = {}) {
  const toolHandlers = buildToolHandlers({ manager, wfHost, nested });

  /** 工具面下线的可操作拒绝（D1 终态）：指向 CLI 出口（socket 面不受影响）。 */
  const toolsDisabledMessage = () => 'zsub/zflow 工具面已下线（1.0.0 起，agent 交互全走 CLI）。'
    + `恢复指引：用 Bash 工具跑 \`node ${process.env.ZCODE_PLUGIN_ROOT || '<ZCODE_PLUGIN_ROOT>'}/bin/zsw.js <cmd>\`（默认连接 daemon；等待用 wait 子命令，配 run_in_background 获完成通知）。`;

  /**
   * 两级分发第一级：按 params.name 查注册表，未命中抛 -32601（协议级
   * 错误，走 JSON-RPC error 帧）；命中则整包交给对应 handler（第二级，
   * zsub 的 switch(action) / zflow 的 switch(workflow) 见
   * buildToolHandlers）。
   * （升级提示投递面已随 appserver 通道退役删除，回接 2c：格式漂移检测
   * 改由 core 引擎探针的 golden 干跑回归承担。）
   */

  async function dispatchToolCall(params) {
    // _meta 诊断（Z3 通道验证）：tools/call 原文 _meta 落盘，诊断 mailbox 定向未命中用。
    // 常开（一行 jsonl，成本可忽略）；ZSW_ROOT 隔离的测试环境天然不污染。
    try {
      const fs = require('node:fs');
      const root = require('../../lib/config').zswRoot();
      fs.mkdirSync(root, { recursive: true });
      fs.appendFileSync(require('node:path').join(root, 'meta-debug.jsonl'), JSON.stringify({
        ts: Date.now(), tool: params && params.name,
        hasMeta: !!(params && params._meta),
        meta: params && params._meta,
        sessionId: extractSessionId(params && params._meta),
      }) + '\n');
    } catch { /* 诊断失败不影响服务 */ }
    // 工具面恒拒绝（1.0.0 终态，D1：agent 交互全走 CLI；嵌套环境同文案——
    // 嵌套里本就不该调用。handler 分发已不在此路径——socket 面才消费 toolHandlers）。
    return errContent(toolsDisabledMessage());
  }

  async function handleMessage(msg) {
    const frames = [];
    if (!msg || msg.jsonrpc !== '2.0') return frames;
    if (msg.id === undefined || msg.id === null) {
      if (msg.method === 'notifications/initialized') log('client initialized');
      return frames; // 通知帧不应答
    }
    switch (msg.method) {
      case 'initialize':
        frames.push({
          jsonrpc: '2.0', id: msg.id,
          result: {
            protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        });
        break;
      case 'tools/list':
        // 1.0.0 终态（D1）：恒空注册——agent 交互面全走 CLI，零上下文注入。
        // （防递归第二重的历史语义由恒空天然覆盖）
        frames.push({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
        break;
      case 'tools/call':
        try {
          frames.push({ jsonrpc: '2.0', id: msg.id, result: await dispatchToolCall(msg.params) });
        } catch (e) {
          if (e instanceof RpcError) {
            frames.push({ jsonrpc: '2.0', id: msg.id, error: { code: e.code, message: e.message } });
          } else {
            log(`tools/call crashed: ${(e && e.stack) || e}`);
            frames.push({
              jsonrpc: '2.0', id: msg.id,
              result: errContent(`内部错误: ${e && e.message || e}`),
            });
          }
        }
        break;
      case 'ping':
        frames.push({ jsonrpc: '2.0', id: msg.id, result: {} });
        break;
      default:
        frames.push({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
    return frames;
  }

  return { handleMessage, dispatchToolCall, toolHandlers };
}

/**
 * models action 的 --all 全 provider 视图数据源已整体下沉为
 * ModelRouter#allProviders（lib/model-router.js，「合格 provider 判定 + 全
 * provider 模型视图」的单一实现，SessionStart 注入块同口径）：v2 config 读取、
 * 资格过滤（带凭据且清单非空）、全名升格都不在本入口层复制——平台配置结构
 * 知识只活在端口实现内，server 只经 router 端口消费。
 */

function requireSubagentId(args) {
  if (typeof args.subagentId !== 'string' || args.subagentId.trim() === '') {
    throw new Error('缺少必填参数 subagentId（start 返回的任务 id）。恢复指引：先用 list 查全部任务 id。');
  }
  return args.subagentId;
}

function requireRunId(args) {
  if (typeof args.runId !== 'string' || args.runId.trim() === '') {
    throw new Error('缺少必填参数 runId（run 返回的 wf- 前缀 id）。恢复指引：先用 action="list" 查全部 workflow run id。');
  }
  return args.runId;
}

/**
 * agents action 的来源标签映射：core 发现面（lib/agent-discovery）在 profile
 * 上带 core 槽位标签（profile.source），此处映射为 zsw 面向用户的来源根标签
 * ——四根标签与旧版一致（project-zcode/project-agents/user-zcode/user-agents），
 * 新增 vendored 内置（core-vendored）与 pi 生态透传源（project-pi/npm-dev/
 * user-extension-paths，zsw 用户目录里通常缺席）。
 */
function agentSourceLabel(coreSource) {
  switch (coreSource) {
    case 'user-pi': return 'user-zcode';
    case 'user-agents': return 'user-agents';
    case 'npm': return 'core-vendored';
    case 'project-host': return 'project-zcode';
    case 'project-agents': return 'project-agents';
    default: return coreSource; // project-pi / npm-dev / user-extension-paths 等透传
  }
}

/**
 * agents action 的精简视图：只透出索引字段——name / description（截
 * 200，索引不是正文）/ when（「何时用我」提示，截 200）/ source（来源根
 * 标签）/ location（.md 绝对路径，D-4a 契约下 start 的 agent 参数唯一合法
 * 形态；file 为同值兼容字段，旧消费方与 lint 指引沿用）。body/model/
 * tools 等 profile 字段不透出：索引的价值在省 token，正文按 location
 * 路径按需读。list 是 async（core 发现链），handler 侧 await。
 */
async function agentListView(resolver, cwd) {
  const agents = await resolver.list(cwd);
  return agents.map((p) => ({
    name: p.name,
    description: typeof p.description === 'string' ? p.description.slice(0, 200) : '',
    when: typeof p.when === 'string' ? p.when.slice(0, 200) : '',
    source: agentSourceLabel(p.source || ''),
    location: p.filePath,
    file: p.filePath, // 兼容旧字段名（D-4a 前 start 按名/路径双形态时的指引用）
  }));
}

// ----------------------------------------------------------------- 主循环

function log(msg) {
  process.stderr.write(`[zsub] ${new Date().toISOString()} ${msg}\n`);
}

function writeFrame(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function main() {
  log(`mcp server starting (pid=${process.pid})`);
  let manager = null;
  let wfHost = null;
  if (config.NESTED) {
    log('嵌套环境（ZSW_NESTED=1 或 XYZ_AGENT_SUBAGENT=1）：防递归第二重门禁生效，不注册工具、不初始化编排（第一重：隔离 HOME 无插件）');
  } else {
    // 执行通道（回接 2c）：runner 恒为 core zcode engine 的 spawn 单轮
    // （lib/assemble.js 组装；appserver 通道已按 D6-⑥ 退役，ZSW_RUNNER=appserver
    // 在 assemble 显式报错——MCP 与 CLI 共用同一决策，两入口行为不漂移）
    const assembled = await createManager();
    manager = assembled.manager;
    wfHost = assembled.wfHost;
    const notifier = assembled.notifier;
    // mailbox 档启动清扫己方 .tmp 残留（Z8 规范 4；PollingNotifier 无此方法）
    if (typeof notifier.sweepStaleTmp === 'function') {
      const removed = notifier.sweepStaleTmp();
      if (removed > 0) log(`mailbox 启动清扫：删除 ${removed} 个己方 .tmp 残留`);
    }
    try {
      const rec = await manager.recover();
      log(`record 恢复：重建 ${rec.rebuild.records} 条（applied=${rec.rebuild.applied} skipped=${rec.rebuild.skipped}），`
        + `死进程 ${rec.dead.length} 条标 lost，孤儿进程 ${rec.orphan.length} 条待 cancel`);
    } catch (e) {
      // 恢复失败不拒绝启动：record 是持久化事件流，下次启动仍可重建
      log(`recover 失败（继续启动，record 功能可能受限）: ${e && e.message || e}`);
    }
    try {
      // workflow 孤儿恢复（回接 2b）：FileRunStore 重水合上一代 daemon 遗留的
      // workflow-state 快照，running 标 done,failed 落盘（worker 线程随旧进程
      // 死亡，无进程可探活）——与 subagent recover 并存安全（两池存储面已分离）
      const rec = await wfHost.recoverOrphans();
      log(`workflow 孤儿恢复：重水合 ${rec.recovered} 条，running 遗留 ${rec.orphaned} 条标 failed`);
    } catch (e) {
      log(`wfHost recoverOrphans 失败（继续启动，workflow 管理面可能受限）: ${e && e.message || e}`);
    }

    // 孤儿清扫（报告模式，不自动删——结果文件是用户资产；worktree 孤儿同理由用户 close）
    try {
      const reaper = require('../../lib/reaper');
      // manager.list 经 recordType 过滤后不含 wf run——outputs 目录是两池共用
      // 的，wf id 必须并入 known，否则 wf-* 结果文件会被误报孤儿
      const known = [
        ...manager.list().map((r) => r.subagentId),
        ...wfHost.list().map((r) => r.runId),
      ];
      // sweepStaleOutputs 返回 {stale: [{file, subagentId}]}（报告模式，见
      // lib/reaper.js 头注）——字段名必须与 reaper 契约一致，写错会让整段
      // 清扫（含下方 worktree 孤儿）被 catch 吞成死代码
      const staleOut = reaper.sweepStaleOutputs({ knownSubagentIds: known });
      if (staleOut.stale.length > 0) {
        log(`孤儿结果文件 ${staleOut.stale.length} 个（只报告不删）：${staleOut.stale.map((o) => o.file).join(', ')}`);
      }
      const projectDir = process.env.ZCODE_PROJECT_DIR;
      if (projectDir) {
        const { resolveGitRoot } = require('../../lib/worktree-adapter');
        try {
          const mainRepo = await resolveGitRoot(projectDir);
          const wt = reaper.reapWorktrees({ mainRepo, knownSubagentIds: known, remove: false });
          if (wt.orphans.length > 0) {
            log(`孤儿 worktree ${wt.orphans.length} 个（只报告）：${wt.orphans.map((o) => o.dir).join(', ')}`);
          }
        } catch (e) { /* projectDir 非 git 仓库：无 worktree 可扫，正常静默 */ }
      }
    } catch (e) {
      log(`reaper 启动清扫失败（不影响服务）: ${e && e.message || e}`);
    }
  }

  const server = createServer({ manager, wfHost, nested: config.NESTED, log, emitFrame: writeFrame });

  // daemon socket 控制面接线（DESIGN-v4 D2/D3，M0）：非 NESTED 才挂——嵌套
  // 进程不参与竞选（防递归边界保持在 MCP 工具面语义内，socket 面是服务面）。
  // sockPath 解析单一来源 = lib/cli-client.js 的 defaultSockPath（ZSW_SOCK 覆盖
  // > ~/.zcode/zsw/daemon.sock，与 CLI 对侧同一实现，禁止 server 再拼一份——
  // 两处各拼一份会漂移）。
  let daemon = null;
  if (!config.NESTED) {
    const { startDaemon } = require('../../lib/daemon-socket');
    const { defaultSockPath } = require('../../lib/cli-client');
    const sockPath = defaultSockPath();
    try {
      // 首次运行 ~/.zcode/zsw 可能不存在：lock 的 O_EXCL 创建与 listen 都要求
      // 父目录在位（recursive 幂等）
      require('node:fs').mkdirSync(path.dirname(sockPath), { recursive: true });
      daemon = await startDaemon({
        sockPath,
        // 单份 handler 表（createServer 已建，闭包同 manager/wfHost），
        // 适配成 socket 帧 (req, meta) 形态并解包 content（见适配器头注）
        handlers: buildDaemonHandlers(server.toolHandlers),
        log,
        // 接管时重跑 recover（DESIGN-v4 §6.3 D3）：standby 的内存索引缺旧
        // daemon 后建的 record，不重建则 status/wait/list 全部「不存在」
        onTakeover: async () => {
          try {
            const rec = await manager.recover();
            log(`接管后 record 恢复：重建 ${rec.rebuild.records} 条，死进程 ${rec.dead.length} 条标 lost，孤儿 ${rec.orphan.length} 条待 cancel`);
          } catch (e) {
            log(`接管后 recover 失败（继续服务，record 功能可能受限）: ${e && e.message || e}`);
          }
          try {
            const rec = await wfHost.recoverOrphans();
            log(`接管后 workflow 孤儿恢复：重水合 ${rec.recovered} 条，running 遗留 ${rec.orphaned} 条标 failed（执行体随旧 daemon 消亡）`);
          } catch (e) {
            log(`接管后 wfHost recoverOrphans 失败: ${e && e.message || e}`);
          }
        },
      });
      // 竞选事件（接管/退避/看门狗）由 daemon-socket 内部经同一 log 通道输出。
      // standby 的 M1 语义：manager 已照常初始化（上方 recover 跑过）——
      // 工具面恒空（1.0.0 起），standby 与 daemon 在 MCP 面无行为差异；
      // manager 保留供本实例看门狗接管成为 daemon 后服务 socket 面
      log(`daemon 竞选完成：role=${daemon.role}（pid=${process.pid}，sock=${sockPath}）`);
    } catch (e) {
      // MCP 协议层是进程存活锚点（引擎 spawn/kill），socket 面挂了不拒绝
      // 启动——CLI 调用方会拿到 connect 失败的可操作指引（cli-client 文案）
      log(`daemon socket 启动失败（CLI 暂不可用）: ${e && e.message || e}`);
      daemon = null;
    }
  }

  let queue = Promise.resolve(); // 串行处理：record-store 无跨请求事务，但保持顺序可预测
  const decoder = createFrameDecoder((line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log(`bad frame (ignored): ${e.message} | ${line.slice(0, 200)}`);
      return;
    }
    queue = queue
      .then(() => server.handleMessage(msg))
      .then((frames) => { for (const f of frames) writeFrame(f); })
      .catch((e) => log(`handler crashed: ${(e && e.stack) || e}`));
  });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => decoder.push(chunk));
  process.stdin.on('end', () => {
    log('stdin closed, server exiting');
    queue.then(async () => {
      // daemon 退出卫生：stop() 幂等（daemon-socket 头注）；SIGTERM/exit 路径
      // 另有传输层自己的信号钩子兜底，这里只覆盖 stdin 正常关闭的主路径。
      // workflow 退出钩子（回接 2b）：全部 running run 转 done,failed 落盘
      // （worker 线程随进程死亡——不落盘则下次启动误判仍在跑）
      try {
        if (wfHost) await wfHost.shutdown();
      } catch (e) {
        log(`wfHost shutdown 失败（best-effort，下次启动由孤儿恢复收编）: ${e && e.message || e}`);
      }
      if (daemon) await daemon.stop();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 60_000).unref(); // 兜底：不等卡死的处理链
  });
}

if (require.main === module) {
  main().catch((e) => {
    log(`fatal: ${(e && e.stack) || e}`);
    process.exit(1);
  });
}

module.exports = {
  extractSessionId,
  buildToolDefinition,
  buildRunWorkflowToolDefinition,
  buildTools,
  buildToolHandlers,
  buildDaemonHandlers,
  createFrameDecoder,
  createServer,
  createManager,
  RpcError,
};
