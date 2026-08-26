#!/usr/bin/env node
/**
 * dist/mcp/server.js — z-tool-finder 主 MCP server（全局检索面，DESIGN.md §6.3 D3）。
 *
 * 仅暴露 search_tools(query, limit?)：读 catalog 建 BM25 索引（内存），
 * 返回命中工具清单 + 指引到对应 wrapper 的 get_tool_details。
 *
 * stdout 严格保留给 JSON-RPC；人读日志走 stderr 落 <LOGS_DIR>/server.log。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { DATA_DIR, LOGS_DIR } = require('../../lib/paths');
const { loadCatalog } = require('../../lib/catalog');
const { buildIndex, search } = require('../../lib/bm25');

// ---------- 日志（stderr + 落盘） ----------

function initLog(logsDir) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    return (msg) => {
      const line = `[${new Date().toISOString()}] ${msg}\n`;
      process.stderr.write(line);
      try {
        fs.appendFileSync(path.join(logsDir, 'server.log'), line);
      } catch {
        // 落盘失败不致命，stderr 仍可见
      }
    };
  } catch {
    return (msg) => process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
  }
}
const log = initLog(LOGS_DIR);

// ---------- 检索 ----------

/** serverKey → 引擎工具命名空间：plugin:<p>:<s> → plugin_<p>_<s>；user 级裸名 */
function engineServerName(serverKey) {
  if (serverKey.startsWith('plugin:')) {
    const parts = serverKey.split(':'); // ['plugin', p, s]
    if (parts.length === 3) return 'plugin_' + parts[1] + '_' + parts[2];
  }
  return serverKey;
}

/** catalog → BM25 文档集：每工具一条，text = server:tool + whenToUse + description */
function buildDocs(cat) {
  const docs = [];
  for (const [serverKey, server] of Object.entries(cat.servers || {})) {
    for (const tool of (server && server.tools) || []) {
      if (!tool || !tool.name) continue;
      docs.push({
        id: serverKey + ':' + tool.name,
        text:
          serverKey + ':' + tool.name + ' ' +
          (tool.whenToUse || '') + ' ' +
          (tool.description || ''),
      });
    }
  }
  return docs;
}

/** tools/call(search_tools) 的业务实现 */
function handleSearch(params) {
  const query = params && params.query;
  if (typeof query !== 'string' || !query.trim()) {
    return {
      content: [{ type: 'text', text: '参数错误：query 必须为非空字符串' }],
      isError: true,
    };
  }
  let limit = 5;
  if (params.limit != null) {
    if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 10) {
      return {
        content: [{ type: 'text', text: '参数错误：limit 必须为 1-10 的整数' }],
        isError: true,
      };
    }
    limit = params.limit;
  }

  const cat = loadCatalog(DATA_DIR);
  const docs = buildDocs(cat);
  if (!docs.length) {
    return {
      content: [{
        type: 'text',
        text: 'catalog 未就绪，工具将在首次使用时通过 get_tool_details 实时发现',
      }],
    };
  }

  const index = buildIndex(docs);
  const hits = search(index, query, limit);
  // id 形如 serverKey:toolName，但 plugin 级 serverKey 自身含冒号（plugin:p:s），
  // 不能简单 split——从 catalog 建反向表拿 serverKey。
  const byId = new Map();
  for (const [serverKey, server] of Object.entries(cat.servers || {})) {
    for (const tool of (server && server.tools) || []) {
      if (tool && tool.name) {
        byId.set(serverKey + ':' + tool.name, { serverKey, tool });
      }
    }
  }

  if (!hits.length) {
    return { content: [{ type: 'text', text: '未命中任何工具，请尝试其他关键词' }] };
  }

  const result = hits.map(({ id }) => {
    const hit = byId.get(id);
    return { tool: id, whenToUse: (hit && hit.tool.whenToUse) || '' };
  });
  const detailTargets = [...new Set(
    hits.map(({ id }) => engineServerName(byId.get(id).serverKey))
  )];
  const guide =
    '对命中工具调 ' +
    detailTargets.map((s) => 'mcp__' + s + '__get_tool_details').join(' / ') +
    ' 获取详情';
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result) + '\n' + guide,
    }],
  };
}

// ---------- MCP 协议（行式 JSON-RPC over stdio） ----------

const TOOL_SEARCH_TOOLS = {
  name: 'search_tools',
  description:
    '跨所有 MCP server 的工具全局检索（关键词 + BM25）。返回命中工具名与 when-to-use，详情用对应 server 的 get_tool_details 获取。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索关键词（中英文均可）' },
      limit: { type: 'integer', minimum: 1, maximum: 10, description: '返回条数上限，默认 5' },
    },
    required: ['query'],
  },
};

const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // 非 JSON 行直接忽略
  }
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'z-tool-finder', version: '0.1.0' },
        },
      });
    } else if (method === 'notifications/initialized') {
      // 通知无应答
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: [TOOL_SEARCH_TOOLS] } });
    } else if (method === 'tools/call') {
      if (params && params.name === 'search_tools') {
        send({ jsonrpc: '2.0', id, result: handleSearch(params.arguments || {}) });
      } else {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: '未知工具: ' + (params && params.name) },
        });
      }
    } else if (id !== undefined) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'method not found: ' + method },
      });
    }
  } catch (err) {
    log('处理消息失败: ' + (err && err.message));
    if (id !== undefined) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: 'internal error: ' + (err && err.message) },
      });
    }
  }
});

rl.on('close', () => process.exit(0));
log('主 server 启动，DATA_DIR=' + DATA_DIR);
