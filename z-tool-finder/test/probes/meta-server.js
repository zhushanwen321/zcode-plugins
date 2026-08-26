const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe-meta', version: '0.0.1' } } });
  } else if (msg.method === 'notifications/initialized') {
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'get_tool_details', description: 'P0-3 meta tool: fetch full details of a tool', inputSchema: { type: 'object', properties: { tool: { type: 'string' } }, required: ['tool'] } },
      { name: 'call_tool', description: 'P0-3 meta tool: execute a tool call', inputSchema: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' } }, required: ['tool'] } }
    ] } });
  } else if (msg.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'P0-3 echo: ' + JSON.stringify(msg.params) }] } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + msg.method } });
  }
});
