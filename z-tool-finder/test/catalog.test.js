'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadCatalog,
  saveCatalog,
  getTool,
  upsertServer,
  removeServer,
  prescan,
} = require('../lib/catalog');

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ztf-catalog-test-'));
}

const ECHO_CONFIG = {
  command: process.execPath,
  args: [path.join(__dirname, 'fixtures', 'echo-server.js')],
};

test('loadCatalog：不存在返回空 catalog', () => {
  const dir = tmpDataDir();
  const cat = loadCatalog(dir);
  assert.deepEqual(cat, { servers: {} });
});

test('loadCatalog：损坏 JSON 容错返回空 catalog', () => {
  const dir = tmpDataDir();
  fs.writeFileSync(path.join(dir, 'catalog.json'), '{ 不是合法 JSON');
  assert.deepEqual(loadCatalog(dir), { servers: {} });
});

test('saveCatalog 原子写（落盘可读回，不留 tmp 文件）+ roundtrip', () => {
  const dir = tmpDataDir();
  const cat = { servers: {} };
  upsertServer(cat, 'echo', {
    serverInfo: { name: 'echo-server' },
    tools: [{ name: 'echo', description: '回显参数。', inputSchema: { type: 'object' } }],
  });
  saveCatalog(dir, cat);
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
  const loaded = loadCatalog(dir);
  assert.ok(loaded.servers.echo);
  assert.equal(loaded.servers.echo.tools[0].name, 'echo');
});

test('upsertServer：whenToUse = description 首句截 120 字符', () => {
  const cat = { servers: {} };
  // 首句即全部
  upsertServer(cat, 'a', {
    serverInfo: {},
    tools: [{ name: 't1', description: '第一句。第二句应被丢弃。', inputSchema: {} }],
  });
  assert.equal(cat.servers.a.tools[0].whenToUse, '第一句。');
  // 超长截断到 120
  const long = 'x'.repeat(300) + '。后面';
  upsertServer(cat, 'b', { serverInfo: {}, tools: [{ name: 't2', description: long, inputSchema: {} }] });
  assert.equal(cat.servers.b.tools[0].whenToUse.length, 120);
  // 无 description 为空串
  upsertServer(cat, 'c', { serverInfo: {}, tools: [{ name: 't3', inputSchema: {} }] });
  assert.equal(cat.servers.c.tools[0].whenToUse, '');
});

test('getTool / removeServer', () => {
  const cat = { servers: {} };
  upsertServer(cat, 's', { serverInfo: {}, tools: [{ name: 't', description: 'd', inputSchema: {} }] });
  assert.equal(getTool(cat, 's', 't').name, 't');
  assert.equal(getTool(cat, 's', 'missing'), undefined);
  assert.equal(getTool(cat, 'missing-server', 't'), undefined);
  removeServer(cat, 's');
  assert.equal(getTool(cat, 's', 't'), undefined);
  removeServer(cat, 'not-exist'); // 无操作不抛
});

test('prescan：一个好 def + 一个坏 def，好者入库、坏者入 failed 不中断', async () => {
  const dir = tmpDataDir();
  const cat = loadCatalog(dir);
  const result = await prescan(
    cat,
    [
      { key: 'bad', config: { command: '/nonexistent/ztf-测试-command', args: [] } },
      { key: 'echo', config: ECHO_CONFIG },
    ],
    { timeoutMs: 10000 }
  );
  assert.deepEqual(result.ok, ['echo']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].key, 'bad');
  assert.match(result.failed[0].error, /建议动作/);
  assert.equal(cat.servers.echo.tools.length, 2);
  assert.equal(cat.servers.echo.serverInfo.name, 'echo-server');
  assert.ok(!cat.servers.bad);
  saveCatalog(dir, cat);
  const reloaded = loadCatalog(dir);
  assert.equal(reloaded.servers.echo.tools[0].whenToUse, '回显传入参数。');
});
