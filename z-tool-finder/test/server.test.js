'use strict';

/**
 * 主 server 冒烟测试：spawn 子进程、行式喂 JSON-RPC。
 * 通过 ZTF_DATA_DIR 注入临时目录，绝不触碰真实 ~/.zcode。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'dist', 'mcp', 'server.js');

/** 行式 MCP 客户端：喂消息、收集带 id 应答 */
function startServer(env) {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env } });
  const pending = new Map();
  const notifications = [];
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && msg.id !== null) pending.get(msg.id)?.(msg);
      else notifications.push(msg);
    }
  });
  let nextId = 1;
  return {
    call(method, params) {
      return new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method, params) {
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    close() {
      proc.stdin.end();
      proc.kill();
    },
  };
}

function writeCatalog(dir, servers) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'catalog.json'),
    JSON.stringify({ servers })
  );
}

const FIXTURE = {
  'user-fs': {
    fetchedAt: '2026-01-01T00:00:00Z',
    tools: [
      { name: 'read_file', whenToUse: '读取文件内容', description: 'read file content', inputSchema: {} },
      { name: 'write_file', whenToUse: '写入文件内容', description: 'write file content', inputSchema: {} },
    ],
  },
  'plugin:docs:pdf': {
    fetchedAt: '2026-01-01T00:00:00Z',
    tools: [
      { name: 'make_pdf', whenToUse: '生成 PDF 文档', description: 'create pdf document', inputSchema: {} },
    ],
  },
};

test('initialize + tools/list：仅暴露 search_tools', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztf-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = startServer({ ZTF_DATA_DIR: dir });
  t.after(() => cli.close());

  const init = await cli.call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
  });
  assert.equal(init.result.serverInfo.name, 'z-tool-finder');

  cli.notify('notifications/initialized');

  const list = await cli.call('tools/list', {});
  assert.equal(list.result.tools.length, 1);
  assert.equal(list.result.tools[0].name, 'search_tools');
  assert.deepEqual(list.result.tools[0].inputSchema.required, ['query']);
});

test('未知 method 且带 id → -32601', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztf-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = startServer({ ZTF_DATA_DIR: dir });
  t.after(() => cli.close());
  const res = await cli.call('foo/bar', {});
  assert.equal(res.error.code, -32601);
});

test('tools/call(search_tools)：命中工具并给 get_tool_details 指引', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztf-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeCatalog(dir, FIXTURE);
  const cli = startServer({ ZTF_DATA_DIR: dir });
  t.after(() => cli.close());

  const res = await cli.call('tools/call', {
    name: 'search_tools',
    arguments: { query: '读取文件', limit: 3 },
  });
  assert.equal(res.result.isError, undefined);
  const text = res.result.content[0].text;
  const arr = JSON.parse(text.split('\n')[0]);
  assert.equal(arr[0].tool, 'user-fs:read_file');
  assert.equal(arr[0].whenToUse, '读取文件内容');
  // 指引行：user 级 server 名还原
  assert.ok(text.includes('mcp__user-fs__get_tool_details'), text);

  // plugin 级 serverKey（plugin:<p>:<s>）的还原
  const res2 = await cli.call('tools/call', {
    name: 'search_tools',
    arguments: { query: 'pdf' },
  });
  const text2 = res2.result.content[0].text;
  assert.ok(text2.includes('mcp__plugin_docs_pdf__get_tool_details'), text2);
});

test('catalog 为空：返回友好提示而非报错', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztf-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // 不写 catalog.json → loadCatalog 返回空
  const cli = startServer({ ZTF_DATA_DIR: dir });
  t.after(() => cli.close());
  const res = await cli.call('tools/call', {
    name: 'search_tools',
    arguments: { query: 'anything' },
  });
  assert.equal(res.error, undefined);
  assert.ok(res.result.content[0].text.includes('catalog 未就绪'));
});
