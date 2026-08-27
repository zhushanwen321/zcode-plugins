'use strict';
// 忽略 SIGTERM 且把自身 PID 落盘的 echo server：
// 用于进程级回归测试——父进程（prescan 调用方）退出后测试凭 PID 文件
// 轮询确认该 server 已被 SIGKILL，钉住 prescan finally 中 await client.close() 的契约。
process.on('SIGTERM', () => {
  process.stderr.write('term-ignore-pid-server: SIGTERM 已收到但被忽略\n');
});

const pidFile = process.env.ZTF_TEST_PID_FILE;
if (pidFile) {
  require('fs').writeFileSync(pidFile, String(process.pid));
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'term-ignore-pid-server', version: '0' } };
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
