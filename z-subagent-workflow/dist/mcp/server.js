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
 * 不加载 zsub）；本文件是第二重 = 双标记（ZSW_NESTED=1 或
 * XYZ_AGENT_SUBAGENT=1，见 config.isNestedEnv）时不注册工具且拒绝 tools/call。
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
 * socket 控制面 + CLI（bin/zsw.js，默认 thin client）提供。buildToolHandlers
 * 保留：socket 分发的数据源。
 *
 * 多 tool 结构（M3 接线，N2-b 改造）：handler 注册表形态——buildToolHandlers()
 * 出 handler 表 { [toolName]: handler(params, env) }，socket 面经
 * buildDaemonHandlers 按 tool 名查表分发。两个 tool：zsub（九 action 编排，
 * M0 起 +wait）与 zflow（九 action：run / abort / status / list / scripts /
 * lint + 创作闭环三 action script-generate / script-save / script-delete，
 * W8 / D-6）。
 *
 * daemon socket 面（M0 接线）：buildDaemonHandlers() 把 handler 表适配成
 * daemon-socket 要的 (req:{tool,params}, meta:{signal}) 形态。handler 直返
 * 业务对象、错误直接 throw（content 包装对已拆除——CLI 对侧 bin/zsw.js 直接
 * 消费业务字段（如 wait 的 partial 决定 exit code），MCP content 包装对 CLI
 * 是泄漏；throw 由 daemon-socket dispatch 统一映射 ok:false 帧）。
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
 *   解析一份会漂移。workflow 引用契约（D-4/D-E3：script: 拒收；knownNames =
 *   内置 5 + cwd 发现面 saved 名，saved 裸名放行）在入口面校验（bin/zsw.js
 *   的 validateWorkflowRef，CLI 与 socket 面单一来源）。旧
 *   reviewers sugar 在 host 层显式报错（core 契约批次值 = agent .md 路径）；
 *   maxConcurrent/timeoutMsPerPhase 无 core 对应面，以 warnings 显式说明不静默。
 * - run 状态面 = 内存 runs Map（done 保留 MAX_RETAINED_DONE_RUNS 条）+
 *   <zswRoot>/workflow-state/<runId>.jsonl append-only 快照；zsw record
 *   事件流与 mailbox 完成通知线随旧 WorkflowManager 退役。
 * - daemon 生命周期钩子：启动/接管 → host.recoverOrphans()（遗留 running
 *   标 done,failed）；stdin 关闭 → host.shutdown()（terminateRunningRuns）。
 *
 * 可测性：纯函数（buildToolHandlers / buildDaemonHandlers / createFrameDecoder /
 * createServer）导出供 node:test，wfHost / waitHandler 经 buildToolHandlers /
 * createServer 参数可注入 fake（manager 同款模式）；stdio 主循环只在
 * require.main === module 时启动，require 零副作用。
 */

const path = require('node:path');
const config = require('../../lib/config');
const { execZsubAction } = require('../../lib/zsub-actions');

// S5：版本与 package.json 同源（require 缓存 + 发版流程统一 bump，防止
// SERVER_INFO 手抄漂移——修复前 0.1.0 vs 实际 0.0.1 已然漂移）
const SERVER_INFO = { name: 'zsw', version: require('../../package.json').version }; // MCP server 标识用插件缩写；TOOL_NAME 是 tool 语义名，两者不同源
const TOOL_NAME = 'zsub';
const RUN_WORKFLOW_TOOL_NAME = 'zflow';

// ---------------------------------------------------------------- 纯函数区

/** 内置 workflow 清单的单一来源是 orchestration-host（scripts action 经
 * wfHost.scripts().builtin 返回）——server 不再持第二份内置清单，防漂移。 */

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

// errContent 仅剩一个消费者：MCP 面 dispatchToolCall 的 zero-tool 拒绝
// （okContent/unwrap 包装对已随 socket 面收口拆除——D5：handler 直返业务
// 对象，socket 帧负载本就是业务裸 result）
const errContent = (text) => ({ content: [{ type: 'text', text }], isError: true });

/**
 * 组装 manager 运行时（main 消费，不导出）。实现收口在 lib/assemble.js
 * （MCP 与 CLI 入口共用同一组装点）。
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
 * - 返回形态（D5 收口）：handler 直返业务对象、错误直接 throw——daemon-socket
 *   dispatch 统一映射 ok:false 帧；MCP content 包装对（okContent/unwrap）已
 *   拆除，唯一残留 errContent 服务 MCP 面 dispatchToolCall 的 zero-tool 拒绝。
 * - wfHost 参数：orchestration host 注入点（assembleManager 组装真实现 =
 *   vendored subagent-core orchestration 的 zsw 宿主），测试传 fake 即可
 *   全链路冒烟（manager 同款模式）。
 * - zsub 的 action 分发查 lib/zsub-actions 表（D3：与 CLI --local 同一执行
 *   单源）。本函数保留两类入口包装层守卫（先于查表）：嵌套门禁（进程级
 *   防递归，丢失即违规）与 manager 就绪检查（表 exec 的契约前提）。
 * - waitHandler：wait action 的执行体（lib/wait-handler 工厂）。显式注入
 *   供测试；缺省 lazy 从 manager 创建（首次 wait 调用时才建——构造期建会
 *   让没有 pending 端口的 fake manager 在无关 action 上也无谓炸穿），
 *   经 deps.waitHandler 包装函数进表。env.signal 透传为 ctx.signal
 *   （daemon socket 面的连接级取消；MCP 面恒 undefined = 无取消）。
 */
function buildToolHandlers({ manager, wfHost, nested = false, waitHandler } = {}) {
  let wait = waitHandler || null;
  function getWaitHandler() {
    if (!wait) wait = require('../../lib/wait-handler').createWaitHandler({ manager });
    return wait;
  }
  // deps 装配（D3 归属表）：agents/models 的端口从 manager 公开端口字段取
  // （assembleManager 组装进 manager 的必然是同一实例，两份会漂移），经
  // ports 进表；waitHandler 用包装函数保 lazy
  const deps = {
    manager,
    waitHandler: (waitParams, waitMeta) => getWaitHandler()(waitParams, waitMeta),
    ports: {
      agentResolver: manager ? manager.resolver : undefined,
      modelRouter: manager ? manager.modelRouter : undefined,
    },
  };
  const handlers = Object.create(null);
  handlers[TOOL_NAME] = async (params, env = {}) => {
    // 嵌套门禁与 manager 就绪守卫留在入口包装层（D3 归属表）：进程级门禁
    // 先于 action 查表。throw（而非 errContent 包装）——socket 面由
    // daemon-socket dispatch 统一映射 ok:false 帧
    if (nested) {
      throw new Error(
        '嵌套调用已拒绝：嵌套环境（ZSW_NESTED=1 或 XYZ_AGENT_SUBAGENT=1）下 zsub 不提供编排（防递归第二重门禁，D10）。'
        + '恢复指引：这是预期行为，subagent 会话内不要调用 zsub。'
      );
    }
    if (!manager) {
      throw new Error('server 未初始化编排运行时');
    }
    const args = params.arguments || {};
    // socket 面无会话定向语义（D6）：ctx 不带 targetSessionId，mailbox 侧
    // 自然降级（manager 定向链保留，CLI 的 --target-session 后门走 start params）
    const ctx = {
      cwd: env.cwd || process.env.ZCODE_PROJECT_DIR || process.cwd(),
      signal: env.signal,
    };
    return execZsubAction(args.action, args, ctx, deps);
  };
  handlers[RUN_WORKFLOW_TOOL_NAME] = async (params, env = {}) => {
    if (nested) {
      throw new Error(
        '嵌套调用已拒绝：嵌套环境（ZSW_NESTED=1 或 XYZ_AGENT_SUBAGENT=1）下不提供 zflow（防递归第二重门禁，D10）。'
        + '恢复指引：这是预期行为，workflow 阶段会话内不要调用 zflow。'
      );
    }
    if (!wfHost) {
      throw new Error('server 未初始化 workflow 运行时');
    }
    const args = params.arguments || {};
    // run 的透传参数剔除 action（host 的 normalizeRunParams 会把保留键外的
    // 透传键组进 $ARGS，action 泄漏进去会污染脚本参数）
    const { action, ...runArgs } = args;
    const ctx = {
      cwd: env.cwd || process.env.ZCODE_PROJECT_DIR || process.cwd(),
    };
    switch (action) {
      case 'run': {
        // 校验/组参权威在 orchestration-host（normalizeRunParams + registry
        // 解析），抛的都是含恢复指引的可操作错误。wait=true 走同步
        // runAndWait（scriptResult 直返；MCP 30s 超时，测试用）。
        // D-4/D-E3 引用契约入口（socket 面与 CLI 共用 bin/zsw.js 的单一实现，
        // 防两入口漂移）：script: 拒收；knownNames = 内置 5 + cwd 发现面
        // saved 名（buildKnownWorkflowNames 单一构建函数，cwd 与 ctx.cwd
        // 同源——三入口同一目录集产出同一集，⛔D），saved 裸名放行（D-E3
        // 裁决）。validateWorkflowRef 的单参缺省（内置 5 名）保留为防御性
        // 兜底，正常路径恒传全量 knownNames。
        const { validateWorkflowRef } = require('../../bin/zsw.js');
        const { buildKnownWorkflowNames } = require('../../lib/orchestration-host');
        const core = require('../../lib/core-ref').requireCore();
        validateWorkflowRef(runArgs.workflow, await buildKnownWorkflowNames(core, ctx.cwd));
        if (args.wait === true) {
          return await wfHost.runAndWait(runArgs, ctx, { signal: env.signal });
        }
        return await wfHost.run(runArgs, ctx);
      }
      case 'abort':
        return await wfHost.abort(requireRunId(args));
      case 'status':
        return wfHost.status(requireRunId(args));
      case 'list':
        return wfHost.list();
      case 'scripts': {
        // vendored 内置 5 + core 发现面 + .zsw 根用户脚本；发现根 =
        // workspace cwd（ctx 组装同 zsub）。builtin/scripts 均以 host 返回
        // 为单一来源（host 内置表与 registry 同源——server 不再持第二份
        // 内置清单，防两处漂移）
        const found = await wfHost.scripts(ctx.cwd);
        return {
          builtin: found.builtin,
          scripts: found.scripts.map((s) => ({
            name: s.name,
            description: s.description || '',
            path: s.path,
            available: s.available,
            source: s.source,
          })),
        };
      }
      case 'lint': {
        if (typeof args.file !== 'string' || args.file.trim() === '') {
          throw new Error(
            'lint 需要 file（脚本文件路径）。恢复指引：先 scripts 查看已发现脚本的 path 字段，或直接给绝对路径。'
          );
        }
        return await wfHost.lint(args.file);
      }
      // 创作闭环三 action（W8 / D-6）：实现与 CLI 共用 bin/zsw.js 导出的单一
      // 来源（core generate/save/delete 管线 + zsw 目录布局）。CLI 面
      // script-generate 恒本地、save/delete 默认经 daemon——本 handler 是
      // socket 面（daemon 进程内）权威路径：delete 的「运行中拒绝」在此用
      // daemon 持有的 runs 真实状态裁决，save 后的发现面 invalidate 也落在本
      // 进程。script-generate 分支为 dispatch 表完备性保留（CLI 不经此路）。
      case 'script-generate': {
        const { scriptGenerateAction } = require('../../bin/zsw.js');
        return scriptGenerateAction(args.name, args.script);
      }
      case 'script-save': {
        const { scriptSaveAction } = require('../../bin/zsw.js');
        return await scriptSaveAction(args.name);
      }
      case 'script-delete': {
        const { scriptDeleteAction, runningScriptPredicate } = require('../../bin/zsw.js');
        return scriptDeleteAction(args.name, runningScriptPredicate(wfHost));
      }
      default:
        throw new Error(
          `不支持的 action "${String(action)}"。支持：run | abort | status | list | scripts | lint | script-generate | script-save | script-delete。`
          + '恢复指引：action 必须取 inputSchema 中的枚举值。'
        );
    }
  };
  return handlers;
}

/**
 * daemon socket 面适配器（DESIGN-v4 D2 / §7：M0 接线；D5 收口后纯形态适配）。
 *
 * 形态转换两端：
 * - 入参：socket 帧 {tool, params, cwd?} 的 params 是业务参数本体（CLI
 *   bin/zsw.js 组的 {action, ...}），而 handler 吃 {arguments} 形态——
 *   这里包一层 {arguments: params}。socket 面无会话定向语义（D6）：ctx 不带
 *   targetSessionId，mailbox 侧自然降级（CLI 的 --target-session 后门走
 *   start params，不经此处）。
 *   req.cwd（MF7 帧协议扩展，daemon-socket 传输层已做 string 类型守卫）
 *   非空 string 时透传为 handler 第二参 env.cwd——handler 内既有
 *   `env.cwd || ZCODE_PROJECT_DIR || process.cwd()` 链自然取到发起方目录
 *   （多 worktree 下 agent 发现 / worktree 定位不再落到 daemon 宿主 cwd）。
 * - 出参：handler 直返业务对象 / throw（原 MCP content 包装-拆包弯路已拆
 *   除）——dispatch 组 {id, ok:true, result} | {id, ok:false, error} 帧，
 *   CLI 直接消费业务字段（如 wait 的 partial 决定 exit code、start 的
 *   subagentId 供 --wait sugar 追发）。
 * - env.signal 原样透传：连接级 AbortSignal（CLI 断连取消挂起的 wait，
 *   不碰执行体，lib/wait-handler 的 abort 语义）。
 */
function buildDaemonHandlers(toolHandlers) {
  const table = Object.create(null);
  for (const name of Object.keys(toolHandlers)) {
    table[name] = (req, meta = {}) => toolHandlers[name](
      { arguments: req && req.params },
      {
        signal: meta.signal,
        // 非空 string 才透传（帧协议安全边界：cwd 不校验存在性——handler 层
        // workdir/resolver 已有存在性校验——但 daemon 侧仅接受 string 类型）
        cwd: typeof req.cwd === 'string' && req.cwd !== '' ? req.cwd : undefined,
      },
    );
  }
  return table;
}

/**
 * 协议处理器（可测）：输入一个 JSON-RPC 消息对象，返回待写出的帧数组。
 * 通知帧（无 id）不产生输出；tools/call 串行排队由调用方（main 循环）保证。
 * toolsDisabled：已废弃的注入位，1.0.0 起工具面恒空（终态内置，原
 * ZSW_TOOLS_DISABLED 灰度开关删除——自用单用户场景无灰度对象）。参数保留
 * 仅为兼容旧签名，任何值都不改变行为。
 */
function createServer({ manager, wfHost, nested = false, log = () => {} } = {}) {
  const toolHandlers = buildToolHandlers({ manager, wfHost, nested });

  /** 工具面下线的可操作拒绝（D1 终态）：指向 CLI 出口（socket 面不受影响）。 */
  const toolsDisabledMessage = () => 'zsub/zflow 工具面已下线（1.0.0 起，agent 交互全走 CLI）。'
    + `恢复指引：用 Bash 工具跑 \`node ${process.env.ZCODE_PLUGIN_ROOT || '<ZCODE_PLUGIN_ROOT>'}/bin/zsw.js <cmd>\`（默认连接 daemon；等待用 wait 子命令，配 run_in_background 获完成通知）。`;

  /**
   * 两级分发第一级：按 params.name 查注册表，未命中抛 -32601（协议级
   * 错误，走 JSON-RPC error 帧）；命中则整包交给对应 handler（第二级，
   * zsub 的 switch(action) / zflow 的 switch(workflow) 见
   * buildToolHandlers）。
   * （升级提示投递面已随 1.x 宿主私连通道退役删除，回接 2c：格式漂移检测
   * 改由 core 引擎探针的 golden 干跑回归承担。）
   */

  async function dispatchToolCall(params) {
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
          log(`tools/call crashed: ${(e && e.stack) || e}`);
          frames.push({
            jsonrpc: '2.0', id: msg.id,
            result: errContent(`内部错误: ${e && e.message || e}`),
          });
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
 * 资格过滤（带凭据且清单非空）、全名升格都不在入口层复制——平台配置结构
 * 知识只活在端口实现内，入口只经 router 端口消费（D3 后消费点 =
 * lib/zsub-actions.js 的 models 表项）。
 */

function requireRunId(args) {
  if (typeof args.runId !== 'string' || args.runId.trim() === '') {
    throw new Error('缺少必填参数 runId（run 返回的 wf- 前缀 id）。恢复指引：先用 action="list" 查全部 workflow run id。');
  }
  return args.runId;
}

// agents/models/requireSubagentId（zsub 表项）已随 D3 收口迁入
// lib/zsub-actions.js——server 不再持第二份，防两处漂移。

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
    // 执行通道（回接 2c）：runner 恒为 lib/runner-core.js 的 core zcode engine
    // 适配（lib/assemble.js 组装；引擎缺省 appserver 常驻复用 +
    // XYZ_ZCODE_MODE=spawn 定向回退，常驻是预期形态，见 README「排障」节；
    // 退役的是 1.x 宿主私连通道——ZSW_RUNNER=appserver 在 assemble 显式报错。
    // MCP 与 CLI 共用同一决策，两入口行为不漂移）
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
      log(`workflow 孤儿恢复：重水合 ${rec.rehydrated} 条，running 遗留 ${rec.orphaned} 条标 failed`);
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

  const server = createServer({ manager, wfHost, nested: config.NESTED, log });

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
            log(`接管后 workflow 孤儿恢复：重水合 ${rec.rehydrated} 条，running 遗留 ${rec.orphaned} 条标 failed（执行体随旧 daemon 消亡）`);
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
  buildToolHandlers,
  buildDaemonHandlers,
  createFrameDecoder,
  createServer,
};
