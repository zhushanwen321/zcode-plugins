'use strict';
// 捕获并忽略 SIGTERM 的 echo server：用于验证 close() 的 SIGKILL 升级路径
process.on('SIGTERM', () => {
  process.stderr.write('term-ignore-server: SIGTERM 已收到但被忽略\n');
});

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'term-ignore-server', version: '0' } };
  } else if (m.method === 'tools/list') {
    result = { tools: [] };
  } else if (m.method === 'tools/call') {
    result = { content: [{ type: 'text', text: 'ok' }] };
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `未知方法 ${m.method}` } }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
});
