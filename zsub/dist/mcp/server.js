'use strict';
/**
 * zsub MCP stdio server（决策位③入口：双 tool——zsub 编排 + run_workflow）。
 *
 * 为什么粗粒度收敛而不是每 action 一个 tool：Z1 实测 MCP tool 的
 * name+description+inputSchema 全量常驻注入每个 LLM 请求（无按需加载），
 * 细粒度多 tool 的 token 成本线性上涨——所以编排原语收敛为 `zsub`
 * tool（action 枚举参数），description 压到 ≤1.5KB，完整用法与分流哲学放
 * skill zsub-orchestration（Z7 渐进式：一行索引常驻，正文按需读）。
 *
 * 协议：MCP over stdio，换行分隔的 JSON-RPC 2.0（照 dynamic-workflow
 * dist/mcp/server.js 已验证的手写协议层风格）。stdout 只走协议帧，
 * 诊断日志一律 stderr。
 *
 * 防递归（D10 双门禁）：第一重 = 隔离 HOME 无 plugins 配置（子进程物理上
 * 不加载 zsub）；本文件是第二重 = ZSUB_NESTED=1 时不注册工具且拒绝 tools/call。
 *
 * 启动序列：NESTED → 只挂协议层；否则 notifier.sweepStaleTmp（mailbox 档）
 * → manager.recover()（record 重建 + 探活）→ 挂 stdin。
 *
 * 多 tool 结构（M3 已接线）：tool 注册表形态——buildTools() 出定义数组，
 * buildToolHandlers() 出 handler 表 { [toolName]: handler(params, env) }，
 * tools/call 两级分发（第一级按 params.name 查表，未命中 -32601；第二级
 * 进对应 handler）。两个 tool：zsub（七 action 编排）与 run_workflow
 * （dynamic-workflow 移植，5 种 workflow，双段 content 返回）。
 *
 * run_workflow 移植差异（相对源 dist/mcp/server.js，参数校验/分发照源）：
 * - 模型校验不前置：源在 validateCommon 里 resolveModelRef 一次拿
 *   modelRef；zsub 的 workflow 入口内部自带 ModelRouter.resolve（单一权威，
 *   抛可操作错误），server 侧不重复解析——两处各解析一份会漂移。
 * - workdir 语义照源必填（绝对路径，须存在且为目录）；zsub 现有
 *   env.cwd 回落链只服务 zsub tool 的 ctx 组装，与 run_workflow 无关。
 * - 进度上报经 env.emitFrame 通道（源直接 send）：handler 中途产生的
 *   notifications/progress 帧无法进 handleMessage 的返回值数组，由
 *   createServer 注入 emitFrame（main 循环 = writeFrame）实时写出。
 *
 * 可测性：纯函数（extractSessionId / buildToolDefinition /
 * buildRunWorkflowToolDefinition / buildTools / buildToolHandlers /
 * createFrameDecoder / createServer / createManager）导出供 node:test，
 * workflow 入口经 buildToolHandlers 的 workflows 参数可注入 fake；
 * stdio 主循环只在 require.main === module 时启动，require 零副作用。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../../lib/config');
const { runChain } = require('../../lib/workflow/chain');
const { runParallel, DEFAULT_PERSPECTIVES } = require('../../lib/workflow/parallel');
const { runMapReduce } = require('../../lib/workflow/map-reduce');
const { runScatterGather } = require('../../lib/workflow/scatter-gather');
const { runReviewFixLoop, DEFAULT_REVIEWERS } = require('../../lib/workflow/review-fix-loop');
const { buildContentBlocks } = require('../../lib/workflow/report');
const { PROVIDER_ID } = require('../../lib/model-router');

const SERVER_INFO = { name: 'zsub', version: '0.1.0' };
const TOOL_NAME = 'zsub';
const RUN_WORKFLOW_TOOL_NAME = 'run_workflow';

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
 * description 是常驻注入成本，控制在 ~1.5KB 内（见头注）。
 */
function buildToolDefinition() {
  return {
    name: TOOL_NAME,
    description:
      '编排后台 subagent 生命周期（zcode 外挂编排器，与原生 background agent 互补）。action 速查：\n'
      + '- start：后台启动任务，立即返回 subagentId，完成后结果自动通知本会话。参数：task（必填，自包含任务书）、slug（必填，短名）、agent?（agent .md 名或路径）、model?、schema?（输出契约）、worktree?（改动隔离，完成回传 patch 与 git apply 指引）、conversation?（可续聊）、wait?（同步等结果）、timeoutMs?。\n'
      + '- list：任务精简列表（id/slug/status/error/patchFile）。\n'
      + '- status：单任务全量 + 结果文件路径（subagentId；closed 后 Read 该文件取全文）。\n'
      + '- message：向 idle 的 conversation 任务投递续聊消息（subagentId + text）。\n'
      + '- cancel：取消运行中任务（subagentId）。\n'
      + '- close：终态化任务并清理 worktree（subagentId）。\n'
      + '- agents：列出可用 agent .md（四根发现：项目 .agents/agents > .zcode/agents > HOME 同构两根；返回 name/description/路径/来源根）——start 前不确定 agent 名时先查这个。\n'
      + '纪律：①task 必须自包含——子进程看不到当前会话任何上下文，目标/验收/关键路径全写进 task；②禁止轮询——完成通知自动到达，mailbox 未启用时 start 返回值附轮询指引；③简单后台任务优先原生 background agent，需要 worktree 隔离/续聊/schema/四根 agent 生态时才用 zsub。\n'
      + '完整用法与分流哲学：加载 skill zsub-orchestration。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'list', 'status', 'cancel', 'message', 'close', 'agents'],
          description: '要执行的操作',
        },
        task: {
          type: 'string',
          description: 'start 必填。自包含任务书：目标、背景、验收标准、关键文件路径——子进程看不到当前会话上下文',
        },
        slug: { type: 'string', description: 'start 必填。任务短名（通知文案与 worktree 分支名）' },
        agent: { type: 'string', description: 'start 可选。agent .md 的名字或路径（四根发现）' },
        model: { type: 'string', description: 'start 可选。模型（短名或 provider 全名）' },
        schema: { description: 'start 可选。输出契约（字符串或 JSON Schema 对象），以 MANDATORY 段拼入 prompt' },
        worktree: { type: 'boolean', description: 'start 可选。true 时改动落独立 worktree，完成后回传 patch 与 git apply 指引' },
        conversation: { type: 'boolean', description: 'start 可选。true 时首轮完成后进入 idle，可用 message 续聊' },
        wait: { type: 'boolean', description: 'start 可选。true 时同步等待完成并返回结果全文（注意 MCP 30s 超时）' },
        timeoutMs: { type: 'number', description: 'start 可选。超时毫秒数，默认 600000' },
        subagentId: { type: 'string', description: 'status/cancel/message/close 必填。start 返回的任务 id' },
        text: { type: 'string', description: 'message 必填。续聊消息文本' },
      },
      required: ['action'],
    },
  };
}

/**
 * run_workflow tool 定义（dynamic-workflow 移植，M3 接线）。
 * description/inputSchema 逐字照源 dist/mcp/server.js（源文本身无
 * "dynamic-workflow" 字样，无需替换）——参数面以源为权威，防止两插件
 * 行为漂移；默认值文案引用 zsub 自己的常量，值与源一致。
 */
function buildRunWorkflowToolDefinition() {
  return {
    name: 'run_workflow',
    description:
      'Run a deterministic multi-phase workflow by driving headless zcode sessions. ' +
      'Each phase runs in its own isolated agent session; intermediate conclusions are chained or merged, ' +
      'so the main conversation keeps only the final report. Returns a human-readable markdown report plus full JSON data. ' +
      'Workflows: "chain" = analyze -> implement -> summarize pipeline; ' +
      '"parallel" = multi-perspective parallel review of one target, then aggregate; ' +
      '"map-reduce" = parallel transform over a KNOWN items array, then reduce; ' +
      '"scatter-gather" = split a big task into 2-4 subtasks, process in parallel, merge; ' +
      '"review-fix-loop" = parallel review -> aggregate must-fix -> fix -> re-review until clean (WRITES files). ' +
      'Use when the task benefits from a fixed multi-agent pipeline with isolated contexts. ' +
      'NOT for trivial single-file edits or pure Q&A. ' +
      'WARNING: transform/process/fix phases may modify files under `workdir`; runs can take minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: {
          type: 'string',
          enum: ['chain', 'parallel', 'map-reduce', 'scatter-gather', 'review-fix-loop'],
          description: 'Workflow type, see tool description for each one\'s shape.',
        },
        task: {
          type: 'string',
          description: 'Task / target description. For map-reduce this is optional context (operation+items carry the work).',
        },
        workdir: { type: 'string', description: 'Absolute path of the working directory the phases operate in.' },
        model: {
          type: 'string',
          description: `Model override (${PROVIDER_ID} short name, e.g. GLM-5.3 / GLM-4.7-Flash). Default GLM-5.3.`,
        },
        perspectives: {
          type: 'array', items: { type: 'string' },
          description: `parallel only. Default [${DEFAULT_PERSPECTIVES.join(', ')}].`,
        },
        items: {
          type: 'array', items: { type: 'string' },
          description: 'map-reduce only (required). The known items to map over.',
        },
        operation: {
          type: 'string',
          description: 'map-reduce only (required). What to do with each item.',
        },
        subtaskCount: {
          type: 'integer', minimum: 2, maximum: 4,
          description: 'scatter-gather only. Hint for how many subtasks to split into.',
        },
        reviewTarget: {
          type: 'string',
          description: 'review-fix-loop only. What to review (e.g. "git 未提交改动" or specific files). Defaults to uncommitted changes.',
        },
        reviewers: {
          type: 'array', items: { type: 'string' },
          description: `review-fix-loop only. Review focuses. Default [${DEFAULT_REVIEWERS.join(', ')}].`,
        },
        maxRounds: {
          type: 'integer', minimum: 1, maximum: 10,
          description: 'review-fix-loop only. Max review-fix rounds. Default 5.',
        },
        maxConcurrent: {
          type: 'integer', minimum: 1, maximum: 6,
          description: 'Max concurrent phase sessions. Default 3.',
        },
        timeoutMsPerPhase: {
          type: 'number',
          description: 'Per-phase timeout in milliseconds. Default 600000 (10 min).',
        },
      },
      required: ['workflow', 'task', 'workdir'],
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
 * - 为什么是工厂而不是模块级表：handler 闭包持有 manager / nested /
 *   workflows，每次 createServer 一份，实例间互不串线。
 * - 为什么 null 原型 + hasOwnProperty 守卫：防止 params.name 撞 Object
 *   原型链属性名（如 "constructor"）被误当 handler 命中——注册表键必须
 *   精确匹配（改造前 `name !== TOOL_NAME` 严格比较的等价行为）。
 * - 嵌套门禁在各自 handler 内而非分发层：拒绝文案按 tool 定制。
 * - workflows 参数：workflow 入口注入点（默认真实 lib/workflow 五入口），
 *   测试传 fake 即可全链路冒烟（fake manager 同款模式）——否则正常分发
 *   冒烟必须 spawn 真 zcode，成本不可接受。
 * - env.emitFrame：handler 中途发通知帧（progress）的通道，缺省 no-op
 *   （直接调用 handler 的测试不需要收集通知帧）。
 * - agents action 的 resolver 经 manager.resolver 取（公开端口字段，构造
 *   直存）而非 server 再传一份：assembleManager 组装进 manager 的必然是
 *   同一实例，两份 resolver 会漂移（opts.resolver 注入时尤其如此）。
 */
function buildToolHandlers({ manager, nested = false, workflows } = {}) {
  const wf = workflows || {
    chain: runChain,
    parallel: runParallel,
    'map-reduce': runMapReduce,
    'scatter-gather': runScatterGather,
    'review-fix-loop': runReviewFixLoop,
  };
  const handlers = Object.create(null);
  handlers[TOOL_NAME] = async (params, env = {}) => {
    if (nested) {
      return errContent(
        '嵌套调用已拒绝：ZSUB_NESTED=1 环境下 zsub 不提供编排（防递归第二重门禁，D10）。'
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
          return okContent(manager.message(id, args.text));
        }
        case 'close':
          return okContent(await manager.close(requireSubagentId(args)));
        case 'agents': {
          // 按需查询版 agent 索引：pi 的 <available_subagents> 每 turn 常驻
          // 注入在 zcode 平台做不到（进程内 extension API 才有），等价物是
          // 本 action——Z1 结论：MCP tool 常驻注入贵，按需查询零常驻成本。
          // resolver 取 manager.resolver（lib/assemble.js 组装进 manager 的
          // 公开端口字段，构造直存）：server 不再注入第二份，必然同一实例。
          const resolver = manager.resolver;
          if (!resolver || typeof resolver.list !== 'function') {
            return errContent(
              'agents 需要 resolver 端口（agent .md 四根发现），当前 manager 未注入。'
              + '恢复指引：其他 action 不受影响；agents 排障查 lib/assemble.js 的 resolver 组装。'
            );
          }
          return okContent(agentListView(resolver, ctx.cwd));
        }
        default:
          return errContent(
            `不支持的 action "${String(action)}"。支持：start | list | status | cancel | message | close | agents。`
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
        '嵌套调用已拒绝：ZSUB_NESTED=1 环境下不提供 run_workflow（防递归第二重门禁，D10）。'
        + '恢复指引：这是预期行为，workflow 阶段会话内不要调用 run_workflow。'
      );
    }
    const args = params.arguments || {};
    // ---- 参数校验（照源 executeTool；模型校验例外见文件头注「移植差异」）
    if (!args.task || typeof args.task !== 'string') return errContent('缺少必填参数 task（任务/目标描述）');
    // workdir 必须显式传入：path.resolve 缺省值会静默落到进程 cwd（插件目录），
    // fix 类 workflow 会在错误位置写文件——缺参数直接拒绝优于猜一个目录
    if (!args.workdir || typeof args.workdir !== 'string') return errContent('缺少必填参数 workdir（工作目录，绝对路径）');
    const workdir = path.resolve(args.workdir);
    if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
      return errContent(`workdir 不存在或不是目录: ${workdir}。恢复指引：传 workdir 参数（绝对路径）。`);
    }

    // ---- 进度上报（照源：客户端带 progressToken 才发；经 emitFrame 实时写出）
    const progressToken = params && params._meta ? params._meta.progressToken : undefined;
    const emitFrame = env.emitFrame || (() => {});
    let expected = 1;
    let done = 0;
    const notifyProgress = (message) => {
      if (progressToken === undefined) return;
      emitFrame({
        jsonrpc: '2.0', method: 'notifications/progress',
        params: { progressToken, progress: Math.min(0.99, expected > 0 ? done / expected : 0), message },
      });
    };
    const onPlan = (n) => { expected = Math.max(1, n); };
    const onPhase = ({ phase, status }) => {
      if (status === 'done' || status === 'failed' || /^done/.test(status)) done++;
      notifyProgress(`${phase}: ${status}`);
    };

    const opts = {
      task: args.task, workdir, model: args.model,
      maxConcurrent: args.maxConcurrent || 3,
      timeoutMsPerPhase: args.timeoutMsPerPhase || 600000,
      onPhase, onPlan,
    };

    let result;
    try {
      switch (args.workflow) {
        case 'chain':
          result = await wf.chain(opts);
          break;
        case 'parallel':
          result = await wf.parallel({ ...opts, perspectives: args.perspectives });
          break;
        case 'map-reduce': {
          if (!Array.isArray(args.items) || !args.items.length) {
            return errContent('map-reduce 需要非空 items（字符串数组）');
          }
          if (!args.operation) return errContent('map-reduce 需要 operation（对每个 item 做什么）');
          result = await wf['map-reduce']({ ...opts, items: args.items, operation: args.operation });
          break;
        }
        case 'scatter-gather':
          result = await wf['scatter-gather']({ ...opts, subtaskCount: args.subtaskCount });
          break;
        case 'review-fix-loop':
          result = await wf['review-fix-loop']({
            ...opts,
            reviewTarget: args.reviewTarget || 'git 未提交改动',
            reviewers: args.reviewers,
            maxRounds: args.maxRounds,
          });
          break;
        default:
          return errContent(
            `不支持的工作流类型: ${args.workflow}（支持 chain / parallel / map-reduce / scatter-gather / review-fix-loop）。`
            + '恢复指引：workflow 必须取 inputSchema 中的枚举值。'
          );
      }
    } catch (e) {
      // 入口抛错（含 ModelRouter 的模型校验错误）都是可操作错误，原样透传
      return errContent(`工作流执行失败: ${e && e.message || e}`);
    }

    if (progressToken !== undefined) {
      emitFrame({
        jsonrpc: '2.0', method: 'notifications/progress',
        params: { progressToken, progress: 1, message: result.ok ? 'completed' : 'failed' },
      });
    }
    // 双段 content（照源 buildContentBlocks）：[0] markdown 人读报告，[1] ```json 机器数据
    return { content: buildContentBlocks(result), isError: !result.ok };
  };
  return handlers;
}

/**
 * 协议处理器（可测）：输入一个 JSON-RPC 消息对象，返回待写出的帧数组。
 * 通知帧（无 id）不产生输出；tools/call 串行排队由调用方（main 循环）保证。
 * emitFrame：handler 执行中途的通知帧（progress）实时写出通道——这些帧
 * 无法进本函数的返回值数组（返回时机在 handler 完成后），main 传
 * writeFrame 即按真实时序推送。
 */
function createServer({ manager, nested = false, log = () => {}, emitFrame = () => {}, workflows } = {}) {
  const toolHandlers = buildToolHandlers({ manager, nested, workflows });

  /**
   * 两级分发第一级：按 params.name 查注册表，未命中抛 -32601（协议级
   * 错误，走 JSON-RPC error 帧）；命中则整包交给对应 handler（第二级，
   * zsub 的 switch(action) / run_workflow 的 switch(workflow) 见
   * buildToolHandlers）。
   */
  async function dispatchToolCall(params, env = {}) {
    const name = params && params.name;
    const handler = Object.prototype.hasOwnProperty.call(toolHandlers, name)
      ? toolHandlers[name]
      : undefined;
    if (!handler) {
      throw new RpcError(-32601, `Unknown tool: ${name}`);
    }
    return handler(params, env);
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
        // 防递归第二重：嵌套环境不注册工具
        frames.push({ jsonrpc: '2.0', id: msg.id, result: { tools: nested ? [] : buildTools() } });
        break;
      case 'tools/call':
        try {
          frames.push({ jsonrpc: '2.0', id: msg.id, result: await dispatchToolCall(msg.params, { emitFrame }) });
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

function requireSubagentId(args) {
  if (typeof args.subagentId !== 'string' || args.subagentId.trim() === '') {
    throw new Error('缺少必填参数 subagentId（start 返回的任务 id）。恢复指引：先用 list 查全部任务 id。');
  }
  return args.subagentId;
}

/**
 * agents action 的来源标签推断：AgentProfile.filePath → 四根标签。
 * resolver.list（lib/agent-md-resolver.js）不带来源根信息，且 lib 默认
 * 形态是模块对象（读不到 homeDir/roots），source 只能按路径特征推断——
 * list 只扫四根，filePath 必落其一：cwd 前缀 → project-*，否则 HOME 前缀
 * → user-*（项目常开在 HOME 下，必须先判 cwd 才能区分项目根与用户根）；
 * 目录段 .zcode/agents → -zcode，否则 .agents/agents → -agents。
 */
function agentSourceOf(filePath, cwd, homeDir) {
  const scope = filePath.startsWith(cwd + path.sep) ? 'project'
    : filePath.startsWith(homeDir + path.sep) ? 'user'
    : 'project'; // 两个前缀都不中：理论不可达（list 只扫四根），兜底不丢行
  const kind = filePath.includes(`${path.sep}.zcode${path.sep}agents${path.sep}`) ? 'zcode' : 'agents';
  return `${scope}-${kind}`;
}

/**
 * agents action 的精简视图：只透出索引四字段——name / description（截
 * 200，索引不是正文）/ source（四根标签）/ file（绝对路径，可直接作
 * start 的 agent 参数）。body/model/tools 等 profile 字段不透出：索引
 * 的价值在省 token，正文按 file 路径按需读。
 */
function agentListView(resolver, cwd) {
  // homeDir：注入实例（AgentMdResolver 类形态）带真实基准；模块对象形态
  // 无此字段，回落 os.homedir()——与 lib 默认 resolver 的 homeDir 同源，无漂移
  const homeDir = typeof resolver.homeDir === 'string' ? resolver.homeDir : os.homedir();
  return resolver.list(cwd).map((p) => ({
    name: p.name,
    description: typeof p.description === 'string' ? p.description.slice(0, 200) : '',
    source: agentSourceOf(p.filePath || '', cwd, homeDir),
    file: p.filePath,
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
  if (config.NESTED) {
    log('ZSUB_NESTED=1：防递归第二重门禁生效，不注册工具、不初始化编排（第一重：隔离 HOME 无插件）');
  } else {
    // runner 决策位：ZSUB_RUNNER=appserver 时先探针（D3 门控），失败降级 spawn
    let runnerKind = process.env.ZSUB_RUNNER === 'appserver' ? 'appserver' : 'spawn';
    if (runnerKind === 'appserver') {
      const AppServerRunner = require('../../lib/runner-appserver');
      try {
        // app-server 进程启动即要求隔离 HOME 存在模型/provider 配置（e2e 实测
        // 2026-08-23：无配置时 session/create 直接 -32603 "Model config is
        // missing"），probe 必须发生在 prepareRunEnv 的 bootstrap 之后，否则
        // 真实部署中 appserver 永远误降级 spawn。
        const ModelRouter = require('../../lib/model-router');
        const router = new ModelRouter();
        await router.prepareRunEnv(router.resolve(), 'appserver');
        const probe = await new AppServerRunner().probe();
        if (probe.ok) {
          log(`appserver probe OK（protocol ${probe.protocolVersion || '?'}），runner=appserver`);
        } else {
          log(`appserver probe FAILED（${probe.reason}），降级 runner=spawn`);
          runnerKind = 'spawn';
        }
      } catch (e) {
        log(`appserver probe crashed（${e && e.message || e}），降级 runner=spawn`);
        runnerKind = 'spawn';
      }
    }
    const assembled = createManager({ runnerKind });
    manager = assembled.manager;
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

    // 孤儿清扫（报告模式，不自动删——结果文件是用户资产；worktree 孤儿同理由用户 close）
    try {
      const reaper = require('../../lib/reaper');
      const known = manager.list().map((r) => r.subagentId);
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

  const server = createServer({ manager, nested: config.NESTED, log, emitFrame: writeFrame });
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
    queue.then(() => process.exit(0));
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
  createFrameDecoder,
  createServer,
  createManager,
  RpcError,
};
