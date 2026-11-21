'use strict';

/**
 * 修剪修复的变异验证探针(撤掉任一防护,对应用例必红):
 * - FIFO 置换存储文件不挂死(同步 IO 前置 isFile 检查)
 * - 原型链键(constructor)不命中
 * - limit 上限与 providerId 长度上限
 * - failopen 日志节流
 * - onQueued 同步段 abort 的补查
 * - status 控制序列转义
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { readLimits, resetCache } = require('../lib/config');
const { logEvent } = require('../lib/log');
const { createProviderSemaphores } = require('../lib/semaphore');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkfifo(file) {
  execFileSync('mkfifo', [file]);
}

test('config 为 FIFO 时不挂死,返回 null(同步读前置 isFile)', { timeout: 5000 }, () => {
  const dir = tmpdir('zsem-fifo-cfg-');
  const fifo = path.join(dir, 'zsem-config.json');
  mkfifo(fifo);
  resetCache();
  const t0 = Date.now();
  assert.equal(readLimits(fifo), null);
  assert.ok(Date.now() - t0 < 1000, '不得阻塞');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config 为目录时返回 null', () => {
  const dir = tmpdir('zsem-dir-cfg-');
  resetCache();
  assert.equal(readLimits(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('原型链键 constructor 不命中:未显式登记即不限流', () => {
  const dir = tmpdir('zsem-proto-');
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ providers: { p: { limit: 3 } } }), 'utf8');
  resetCache();
  const limits = readLimits(file);
  assert.equal('constructor' in limits, false);
  assert.equal(limits.constructor, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('limit 极值(>10000)与超长 providerId(>256)条目被忽略', () => {
  const dir = tmpdir('zsem-bounds-');
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      providers: {
        ok: { limit: 10 },
        huge: { limit: 1e9 },
        edge: { limit: 10001 },
        maxOk: { limit: 10000 },
        [`${'x'.repeat(257)}`]: { limit: 5 },
        lenOk: { limit: 5 },
      },
    }),
    'utf8',
  );
  resetCache();
  const limits = readLimits(file);
  assert.deepEqual({ ...limits }, { ok: 10, maxOk: 10000, lenOk: 5 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('log 为 FIFO 时 logEvent 不挂死不抛(静默跳过)', { timeout: 5000 }, () => {
  const dir = tmpdir('zsem-fifo-log-');
  const fifo = path.join(dir, 'log.jsonl');
  mkfifo(fifo);
  const t0 = Date.now();
  logEvent('acquire', { providerId: 'p' }, fifo); // 不得阻塞不得抛
  assert.ok(Date.now() - t0 < 1000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('failopen 日志按 why 节流(60s 窗口内同因一条)', async () => {
  const entryPath = path.join(__dirname, '..', 'entry.js');
  const dir = tmpdir('zsem-throttle-');
  const configPath = path.join(dir, 'missing-config.json');
  const logPath = path.join(dir, 'log.jsonl');
  delete require.cache[require.resolve(entryPath)];
  const entry = require(entryPath);
  entry.__forTest.overrides.configPath = configPath;
  entry.__forTest.overrides.logPath = logPath;
  for (let i = 0; i < 5; i++) await entry.admit({ model: { providerId: 'p', modelId: 'm' } });
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, '5 次请求只落 1 条 failopen');
  assert.equal(JSON.parse(lines[0]).why, 'config-unavailable');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('onQueued 同步段内 abort:立即取消不留占位(补查)', async () => {
  const sems = createProviderSemaphores();
  sems.setLimit('p', 1);
  const r1 = await sems.acquire('p');
  const ac = new AbortController();
  let cancelledNow = false;
  const w = sems.acquire('p', {
    signal: ac.signal,
    onQueued: () => {
      // 回调同步段内取消(listener 尚未注册)
      ac.abort(new Error('early-in-callback'));
      cancelledNow = true;
    },
  });
  assert.ok(cancelledNow);
  const err = await w.then(
    () => assert.fail('should reject'),
    (e) => e,
  );
  assert.equal(err.message, 'early-in-callback');
  const snap = sems.snapshot().p;
  assert.equal(snap.queued, 0, '不留占位等待者');
  r1();
});

test('status CLI:控制序列不进终端显示', () => {
  const dir = tmpdir('zsem-status-esc-');
  const logPath = path.join(dir, 'log.jsonl');
  fs.writeFileSync(logPath, JSON.stringify({ t: 'x', type: 'grant', providerId: 'a\x1b[31mfake-b' }) + '\n', 'utf8');
  const cli = path.join(__dirname, '..', 'bin', 'zsem.js');
  const out = execFileSync(process.execPath, [cli, 'status', '--log', logPath], { encoding: 'utf8' });
  assert.ok(!out.includes('\x1b'), '输出不得含裸 ESC 序列');
  assert.ok(out.includes('a?[31mfake-b'), 'ESC 转为可见占位,其余字符保留');
  fs.rmSync(dir, { recursive: true, force: true });
});
