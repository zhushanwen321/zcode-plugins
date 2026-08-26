/**
 * test/fixtures/slow-init-server.js — 慢启动 initialize 的 echo server（测试夹具）
 *
 * 收到 initialize 后延迟 SLOW_INIT_MS（默认 1200ms）才回握手，用于制造
 * 「懒连接握手进行中」窗口；启动时把自身 PID 写入 env ZTF_TEST_PIDFILE。
 */
'use strict';

const fs = require('fs');

if (process.env.ZTF_TEST_PIDFILE) {
  fs.writeFileSync(process.env.ZTF_TEST_PIDFILE, String(process.pid));
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const DELAY = Number(process.env.ZTF_TEST_SLOW_INIT_MS || 1200);

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'slow-init-server', version: '0.0.1' },
        },
      });
    }, DELAY);
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: '回显参数。',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
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
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
