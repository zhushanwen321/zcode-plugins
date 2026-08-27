#!/usr/bin/env node
'use strict';

// dist/mcp/server.js — z-smart-context MCP server（v2 W1，参照 z-tool-finder 的 stdio 骨架）。
// 仅暴露单一工具 zsc_compact（D5）：决策逻辑全部在 lib/compact-tool.js，本文件只做协议壳。
//
// 红线：stdout 是 JSON-RPC 通道，任何输出必须经 writeOut（fs.writeSync 同步写，
// 防 CLI 输出被异步 pipe 截断——bin/zsc.js 同款手法）；人读日志一律 stderr + 落盘。
// 嵌套防护：env 存在 *_NESTED 键（与 lib/state.js isNestedSession 同一口径）时
// tools/list 返回空数组，防编排插件 spawn 出的子会话递归再挂本工具。

const fs = require('node:fs');
const readline = require('node:readline');

const { handleCompactTool } = require('../../lib/compact-tool');
const { isNestedSession } = require('../../lib/state');
const { log, logError } = require('../../lib/log');

// serverInfo.version 跟 package.json 走，避免发版后协议应答里的版本漂移
let VERSION = '0.0.0';
try {
  VERSION = require('../../package.json').version || VERSION;
} catch {
  // 读不到版本不致命，用占位值
}

function writeOut(obj) {
  try {
    fs.writeSync(1, `${JSON.stringify(obj)}\n`);
  } catch {
    // stdout 断开（客户端先退）时无能为力，静默即可
  }
}

const TOOL_ZSC_COMPACT = {
  name: 'zsc_compact',
  description:
    '上下文压缩决策辅助：校验入参、探测当前会话形态，返回可执行的压缩交接指引或诚实降级。' +
    'GUI 会话无纯后台压缩通道（探针定案），工具返回由你组织好 retention 的可粘贴 /compact 指令，转告用户执行；' +
    '无头会话返回 config 预写指引。工具不做语义压缩、不直接触发压缩。',
  inputSchema: {
    type: 'object',
    properties: {
      retention: {
        type: 'string',
        description:
          '压缩保留指令（拼入 /compact 保留：…）。描述压缩后必须留存的上下文：已完成子任务的状态、关键文件路径、未完成任务的描述与验收标准。必填。',
      },
      sessionId: {
        type: 'string',
        pattern: '^sess_[A-Za-z0-9._-]+$',
        description:
          '可选。目标会话 id；缺省链为 env CLAUDE_SESSION_ID → db 按 cwd 反查最近活跃主会话。',
      },
    },
    required: ['retention'],
  },
};

// tools/call(zsc_compact) 的业务包装：决策层返回结构化对象，这里统一序列化进 content。
// 入参错误用 result.isError 表达（协议层成功 + 工具层失败），错误正文附恢复动作。
function handleToolCall(params) {
  const name = params && params.name;
  if (name !== 'zsc_compact') {
    return { error: { code: -32602, message: `未知工具: ${name}（本 server 仅提供 zsc_compact）` } };
  }
  const out = handleCompactTool((params && params.arguments) || {});
  return {
    result: {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      isError: out.ok === false,
    },
  };
}

function dispatch(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    writeOut({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'z-smart-context', version: VERSION },
      },
    });
    return;
  }
  // 通知无应答（notifications/initialized 等）
  if (method === 'notifications/initialized') return;
  if (method === 'ping') {
    writeOut({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    // 嵌套环境直接不可见工具面，比 tools/call 时拒答更早掐断递归编排
    const tools = isNestedSession(process.env, null) ? [] : [TOOL_ZSC_COMPACT];
    writeOut({ jsonrpc: '2.0', id, result: { tools } });
    return;
  }
  if (method === 'tools/call') {
    const handled = handleToolCall(params);
    if (handled.error) {
      writeOut({ jsonrpc: '2.0', id, error: handled.error });
    } else {
      writeOut({ jsonrpc: '2.0', id, result: handled.result });
    }
    return;
  }
  if (id !== undefined) {
    writeOut({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // 非 JSON 行不是本通道的语言，忽略
  }
  try {
    dispatch(msg);
  } catch (err) {
    logError(`[mcp] 处理消息失败 method=${msg.method}: ${err && err.message}`);
    if (msg.id !== undefined) {
      writeOut({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: `internal error: ${err && err.message}` },
      });
    }
  }
});
rl.on('close', () => process.exit(0));

log(`[mcp] server 启动 nested=${isNestedSession(process.env, null)}`);
