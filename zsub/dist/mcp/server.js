'use strict';
/**
 * zsub MCP stdio server（决策位③入口：粗粒度单 tool，DESIGN-v3 D2）。
 *
 * 为什么是单 tool 而不是每 action 一个 tool：Z1 实测 MCP tool 的
 * name+description+inputSchema 全量常驻注入每个 LLM 请求（无按需加载），
 * 细粒度多 tool 的 token 成本线性上涨——所以编排原语收敛为一个 `zsub`
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
 * 可测性：纯函数（extractSessionId / buildToolDefinition / createFrameDecoder
 * / createServer / createManager）导出供 node:test；stdio 主循环只在
 * require.main === module 时启动，require 本模块零副作用。
 */

const config = require('../../lib/config');

const SERVER_INFO = { name: 'zsub', version: '0.1.0' };
const TOOL_NAME = 'zsub';

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

/** 单 tool 定义。description 是常驻注入成本，控制在 ~1.5KB 内（见头注）。 */
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
      + '纪律：①task 必须自包含——子进程看不到当前会话任何上下文，目标/验收/关键路径全写进 task；②禁止轮询——完成通知自动到达，mailbox 未启用时 start 返回值附轮询指引；③简单后台任务优先原生 background agent，需要 worktree 隔离/续聊/schema/四根 agent 生态时才用 zsub。\n'
      + '完整用法与分流哲学：加载 skill zsub-orchestration。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'list', 'status', 'cancel', 'message', 'close'],
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
 * 协议处理器（可测）：输入一个 JSON-RPC 消息对象，返回待写出的帧数组。
 * 通知帧（无 id）不产生输出；tools/call 串行排队由调用方（main 循环）保证。
 */
function createServer({ manager, nested = false, log = () => {} } = {}) {
  async function dispatchToolCall(params, env = {}) {
    if (!params || params.name !== TOOL_NAME) {
      throw new RpcError(-32601, `Unknown tool: ${params && params.name}`);
    }
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
        default:
          return errContent(
            `不支持的 action "${String(action)}"。支持：start | list | status | cancel | message | close。`
            + '恢复指引：action 必须取 inputSchema 中的枚举值。'
          );
      }
    } catch (e) {
      // manager 抛的都是可操作错误（含恢复指引），原样回给主 agent
      return errContent(String(e && e.message || e));
    }
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
        frames.push({ jsonrpc: '2.0', id: msg.id, result: { tools: nested ? [] : [buildToolDefinition()] } });
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

  return { handleMessage, dispatchToolCall };
}

function requireSubagentId(args) {
  if (typeof args.subagentId !== 'string' || args.subagentId.trim() === '') {
    throw new Error('缺少必填参数 subagentId（start 返回的任务 id）。恢复指引：先用 list 查全部任务 id。');
  }
  return args.subagentId;
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
      const staleOut = reaper.sweepStaleOutputs({ knownSubagentIds: known });
      if (staleOut.orphans.length > 0) {
        log(`孤儿结果文件 ${staleOut.orphans.length} 个（只报告不删）：${staleOut.orphans.join(', ')}`);
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

  const server = createServer({ manager, nested: config.NESTED, log });
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
  createFrameDecoder,
  createServer,
  createManager,
  RpcError,
};
