/**
 * test/fixtures/echo-server.js — 极简 stdio JSON-RPC MCP server（测试夹具）
 *
 * tools/list 返回 2 个固定工具；tools/call 回显参数。
 * 独立于 test/probes/meta-server.js（那是接管机制探针，本文件服务单测）。
 */
'use strict';

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo-server', version: '0.0.1' },
      },
    });
  } else if (msg.method === 'notifications/initialized') {
    // no-op
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: '回显传入参数。Echo the arguments back.',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
          {
            name: 'ping',
            description: '返回 pong.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });
  } else if (msg.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: 'echo: ' + JSON.stringify(msg.params && msg.params.arguments) }] },
    });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + msg.method } });
  }
});
