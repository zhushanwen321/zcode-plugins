/**
 * test/fixtures/crash-server.js — 会崩溃的 stdio MCP server（死连接自愈测试夹具）
 *
 * tools/list 返回 [crash, echo]；call crash → 本进程直接 exit(1)（模拟底层崩溃）；
 * call echo → 正常回显。独立于 echo-server.js，专测 wrapper 的连接恢复。
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
        serverInfo: { name: 'crash-server', version: '0.0.1' },
      },
    });
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'crash',
            description: '模拟底层崩溃：调用即 exit(1)',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'echo',
            description: '回显传入参数',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      },
    });
  } else if (msg.method === 'tools/call') {
    if (msg.params && msg.params.name === 'crash') {
      process.exit(1);
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: JSON.stringify(msg.params.arguments || {}) }] },
    });
  }
});
