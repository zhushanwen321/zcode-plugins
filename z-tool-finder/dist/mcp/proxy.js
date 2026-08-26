/**
 * dist/mcp/proxy.js — wrapper 代理层（DESIGN.md §4 / D3 / D4）
 *
 * 一个 stdio MCP server 进程，替换被接管 server 的原 command。对 zcode 只暴露
 * get_tool_details / call_tool 两个 meta 工具（本插件的核心价值断言）；底层真实
 * server 懒启动、调用转发、5 分钟空闲回收。
 *
 * 启动参数：node proxy.js <serverKey> -- <原 command> <原 args...>
 * （launcher 转发时拼好；env 原样继承）
 *
 * stdout 是 JSON-RPC 通道：绝对禁止写任何非协议内容，日志一律走 stderr 落盘
 * <LOGS_DIR>/proxy-<serverKey>.log。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { DATA_DIR, REGISTRY_PATH, CATALOG_PATH, LOGS_DIR } = require('../../lib/paths');
const { loadRegistry } = require('../../lib/registry');
const { loadCatalog, withCatalogLock, getTool, upsertServer } = require('../../lib/catalog');
const { connect } = require('../../lib/mcp-client');

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 30 * 1000;

/** 两个 meta 工具的定义（全局统一名称，靠 server 命名空间区分归属） */
const META_TOOLS = [
  {
    name: 'get_tool_details',
    description:
      '获取本 server 某个工具的完整用法（description、inputSchema、最小示例）。' +
      '调用真实工具前先调它拿参数说明。',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '工具名，见清单 <available-custom-tools>' },
      },
      required: ['tool'],
    },
  },
  {
    name: 'call_tool',
    description: '调用本 server 的某个真实工具（先经 get_tool_details 获取用法）。',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '工具名' },
        args: { type: 'object', description: '工具参数，须符合该工具 inputSchema' },
      },
      required: ['tool'],
    },
  },
];

// ---------- 轻量日志（stderr 落盘，append 模式；失败静默——日志不能反噬主流程） ----------

function createLogger(serverKey) {
  const file = path.join(LOGS_DIR, `proxy-${serverKey}.log`);
  return (msg) => {
    try {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
      // 忽略：日志写失败不影响代理
    }
  };
}

// ---------- 参数示例生成（Anthropic「搜索结果 = 完整可执行信息」原则） ----------

const TYPE_PLACEHOLDERS = {
  string: 'text',
  number: 0,
  integer: 0,
  boolean: true,
  array: [],
  object: {},
  null: null,
};

/** 按 inputSchema required 属性生成最小示例对象（每个 type 填占位值） */
function buildExample(inputSchema) {
  if (!inputSchema || inputSchema.type !== 'object') return {};
  const props = inputSchema.properties || {};
  const example = {};
  for (const name of inputSchema.required || []) {
    const type = props[name] && props[name].type;
    example[name] = Object.prototype.hasOwnProperty.call(TYPE_PLACEHOLDERS, type)
      ? TYPE_PLACEHOLDERS[type]
      : 'text';
  }
  return example;
}

// ---------- 轻量校验（只处理 type / required / properties 一层，不做完整 JSON Schema） ----------

/**
 * @param {object} inputSchema 底层工具的 schema
 * @param {object} args 调用参数
 * @returns {string[]} 错误信息数组（空数组 = 通过）
 */
function validateArgs(inputSchema, args) {
  const errors = [];
  if (!inputSchema || typeof inputSchema !== 'object') return errors;
  if (inputSchema.type === 'object' && (args === undefined || args === null || typeof args !== 'object' || Array.isArray(args))) {
    errors.push('args 必须是 object');
    return errors;
  }
  const props = inputSchema.properties || {};
  const argv = args || {};
  for (const name of inputSchema.required || []) {
    if (!(name in argv)) errors.push(`缺少必填参数: ${name}`);
  }
  for (const [name, value] of Object.entries(argv)) {
    const expected = props[name] && props[name].type;
    if (!expected) continue; // 未知属性不拦截（底层 schema 可能未声明完整）
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const ok =
      (expected === 'integer' && actual === 'number' && Number.isInteger(value)) ||
      (expected === 'number' && actual === 'number') ||
      expected === actual;
    if (!ok) errors.push(`参数 ${name} 类型不符: 期望 ${expected}，实际 ${actual}`);
  }
  return errors;
}

// ---------- wrapper 主体 ----------

/**
 * @param {string[]} argv 形如 [serverKey, '--', command, ...args]
 * @returns {void}
 */
function main(argv) {
  const dashIdx = argv.indexOf('--');
  if (!argv[0] || dashIdx < 1 || dashIdx + 1 >= argv.length) {
    process.stderr.write('用法: node proxy.js <serverKey> -- <command> <args...>\n');
    process.exit(2);
  }
  const serverKey = argv[0];
  const serverDef = { command: argv[dashIdx + 1], args: argv.slice(dashIdx + 2) };
  const log = createLogger(serverKey);
  log(`wrapper 启动: serverKey=${serverKey} 底层=${[serverDef.command].concat(serverDef.args).join(' ')}`);

  // 懒启动 + 空闲回收状态
  let client = null;
  let clientPromise = null;
  let idleTimer = null;
  let inFlightCalls = 0; // 有 in-flight tools/call 时不回收：长调用（computer-use 类）可在 idle 窗口内合法超过 5 分钟

  const reclaimIfIdle = () => {
    if (!client) return;
    if (inFlightCalls > 0) {
      // 调用进行中：推迟到调用结束后 resetIdleTimer 重新计窗
      log(`空闲到期但有 ${inFlightCalls} 个调用进行中，推迟回收`);
      return;
    }
    log('底层连接空闲 5 分钟，自动回收');
    client.close();
    client = null;
    clientPromise = null;
  };

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(reclaimIfIdle, IDLE_TIMEOUT_MS);
    idleTimer.unref();
  };

  /** 懒连接底层（并发调用共享同一个 in-flight Promise）；失败抛可操作错误。
   *  死连接检测：底层进程崩溃后 client 对象残留（isDead=true），此处即时清理
   *  重建，否则要等 5 分钟空闲回收才自愈 */
  const ensureClient = async () => {
    if (client) {
      if (!client.isDead()) return client;
      log('底层连接已死，丢弃并重连');
      client.close();
      client = null;
      clientPromise = null;
    }
    if (!clientPromise) {
      clientPromise = connect(serverDef, { timeoutMs: CONNECT_TIMEOUT_MS })
        .then((c) => {
          client = c;
          log('底层连接建立');
          // 任何路径建立的连接都要武装空闲回收：tools/call 分支之外，
          // get_tool_details 的 catalog miss 兜底也会拉起底层连接
          resetIdleTimer();
          return c;
        })
        .catch((err) => {
          clientPromise = null; // 失败后允许下次重试
          throw err;
        });
    }
    return clientPromise;
  };

  const shutdown = () => {
    log('wrapper 退出（信号触发），关闭底层连接');
    if (idleTimer) clearTimeout(idleTimer);
    if (client) client.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // ---------- catalog 查询（miss 时懒 listTools 实时兜底 + 回写） ----------

  const findToolMeta = async (toolName) => {
    let cat = loadCatalog(DATA_DIR);
    let meta = getTool(cat, serverKey, toolName);
    if (meta) return meta;
    // 兜底：真实拉起底层 listTools，回写 catalog 后再查
    log(`catalog 未命中 ${toolName}，实时 tools/list 兜底`);
    const c = await ensureClient();
    const tools = await c.listTools();
    // 锁内重读 + 记录级合并落盘：多个 wrapper 并发 miss 回写时防止互抹对方记录
    return withCatalogLock(DATA_DIR, (fresh) => {
      upsertServer(fresh, serverKey, { serverInfo: c.serverInfo, tools });
      return getTool(fresh, serverKey, toolName);
    });
  };

  // ---------- meta 工具实现 ----------

  /** 「实际可用工具」描述：区分 工具面为空 / catalog 无记录 两种空（与 search_tools 口径一致） */
  const describeAvailableTools = (cat) => {
    const entry = cat.servers[serverKey] || {};
    const names = (entry.tools || []).map((t) => t && t.name).filter(Boolean);
    if (names.length) return names.join(', ');
    return serverKey in cat.servers
      ? '该 server 工具面为空（如 zsw 1.1.0 offline 形态，本属正常）'
      : 'catalog 无该 server 记录（首次调用后自动索引）';
  };

  const handleGetToolDetails = async (args) => {
    const toolName = args && args.tool;
    if (!toolName || typeof toolName !== 'string') {
      return errorResult('get_tool_details 需要字符串参数 tool');
    }
    const meta = await findToolMeta(toolName);
    if (!meta) {
      // 可操作错误：列出该 server 实际工具名，模型可直接纠正
      return errorResult(
        `工具 ${toolName} 不存在于 server ${serverKey}。实际可用工具: ${describeAvailableTools(loadCatalog(DATA_DIR))}`
      );
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              name: meta.name,
              whenToUse: meta.whenToUse,
              description: meta.description,
              inputSchema: meta.inputSchema,
              example: buildExample(meta.inputSchema),
            },
            null,
            2
          ),
        },
      ],
    };
  };

  const handleCallTool = async (args) => {
    const toolName = args && args.tool;
    if (!toolName || typeof toolName !== 'string') {
      return errorResult('call_tool 需要字符串参数 tool');
    }

    // ① 策略校验（registry.policies：`server:tool` 精确 > `server:*` 通配）
    const reg = loadRegistry(DATA_DIR);
    const policy = reg.policies[`${serverKey}:${toolName}`];
    if (policy === undefined ? reg.policies[`${serverKey}:*`] === 'deny' : policy === 'deny') {
      return errorResult(
        `工具 ${serverKey}:${toolName} 被 registry 策略拒绝（deny）。` +
        `如需放行请编辑 ${REGISTRY_PATH} 的 policies 字段后重试`
      );
    }

    // ② schema 轻量校验（catalog miss 同样走实时兜底）
    const meta = await findToolMeta(toolName);
    if (!meta) {
      return errorResult(
        `工具 ${toolName} 不存在于 server ${serverKey}。实际可用工具: ${describeAvailableTools(loadCatalog(DATA_DIR))}`
      );
    }
    const validationErrors = validateArgs(meta.inputSchema, args.args);
    if (validationErrors.length) {
      return errorResult(
        `参数校验失败: ${validationErrors.join('; ')}。` +
        `完整参数说明请先调 get_tool_details(tool: "${toolName}")`
      );
    }

    // ③ 懒启动 + 转发
    let c;
    try {
      c = await ensureClient();
    } catch (err) {
      return errorResult(
        `底层 server 启动失败: ${[serverDef.command].concat(serverDef.args).join(' ')}\n` +
        `${err.message}\n` +
        `建议动作: 运行 node <插件>/bin/tf.js doctor 排查，或 node <插件>/bin/tf.js restore ${serverKey} 还原为直连`
      );
    }
    let result;
    try {
      result = await c.callTool(toolName, args.args);
    } catch (err) {
      if (c.isDead()) {
        // 调用中途底层进程退出：连接已由 ensureClient 的死连接检测清理路径兜底，
        // 此处显式复位以覆盖并发窗口，重试即自动重连
        client.close();
        client = null;
        clientPromise = null;
        return errorResult(
          `底层调用中断（server 进程退出）: ${err.message}\n连接已重置，重试本调用将自动重连`
        );
      }
      return errorResult(
        `底层调用失败: ${err.message}\n可重试本调用；若持续失败请运行 node <插件>/bin/tf.js doctor 排查`
      );
    }
    log(`call_tool ${toolName} 转发完成`);
    return result; // 结果原样返回
  };

  /** tools/call 错误形态：isError + 可操作文本 */
  function errorResult(text) {
    return { content: [{ type: 'text', text }], isError: true };
  }

  // ---------- JSON-RPC 分发（行式） ----------

  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  const handleRequest = async (msg) => {
    if (msg.method === 'initialize') {
      reply(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'z-tool-finder-proxy', version: '0.1.0' },
      });
    } else if (msg.method === 'tools/list') {
      // 核心价值断言：只返回两个 meta 工具，绝不透传底层工具定义
      reply(msg.id, { tools: META_TOOLS });
    } else if (msg.method === 'tools/call') {
      resetIdleTimer();
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      inFlightCalls += 1;
      try {
        if (name === 'get_tool_details') reply(msg.id, await handleGetToolDetails(args));
        else if (name === 'call_tool') reply(msg.id, await handleCallTool(args));
        else replyError(msg.id, -32602, `未知工具: ${name}（仅支持 get_tool_details / call_tool）`);
      } catch (err) {
        reply(msg.id, errorResult(`wrapper 内部错误: ${err.message}`));
      } finally {
        inFlightCalls -= 1;
        resetIdleTimer();
      }
    } else if (msg.id !== undefined) {
      replyError(msg.id, -32601, `method not found: ${msg.method}`);
    }
    // notification（无 id）忽略
  };

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log('忽略非 JSON 输入行');
      return;
    }
    handleRequest(msg).catch((err) => log(`handleRequest 未捕获: ${err.message}`));
  });
  // stdin 关闭（zcode 退出/重启）时静默收尾
  rl.on('close', () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (client) client.close();
  });
}

module.exports = { main, validateArgs, buildExample, META_TOOLS };

if (require.main === module) main(process.argv.slice(2));
