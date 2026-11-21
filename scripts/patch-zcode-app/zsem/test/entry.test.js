'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// entry 模块级单例,每用例重建状态:直接清 __forTest.overrides + 信号量池
const entryPath = path.join(__dirname, '..', 'entry.js');

function freshEntry(configObj, extra) {
  // 每个用例独立 config/log 文件,避免跨用例污染
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsem-entry-'));
  const configPath = path.join(dir, 'config.json');
  const logPath = path.join(dir, 'log.jsonl');
  fs.writeFileSync(configPath, JSON.stringify({ providers: configObj || {} }), 'utf8');
  delete require.cache[require.resolve(entryPath)];
  const entry = require(entryPath);
  entry.__forTest.overrides.configPath = configPath;
  entry.__forTest.overrides.logPath = logPath;
  return { entry, logPath, readLog: () => fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

function payload(providerId, opts = {}) {
  return {
    model: { providerId, modelId: opts.modelId || 'M-1' },
    signal: opts.signal,
    onQueued: opts.onQueued,
    onAdmitted: opts.onAdmitted,
    admission: { tryAcquire: () => undefined, acquire: async () => ({ release() {} }) },
  };
}

test('未配置 provider → undefined,不接管', async () => {
  const { entry } = freshEntry({ other: { limit: 3 } });
  assert.equal(await entry.admit(payload('account:glm')), undefined);
});

test('配置 provider → 接管:返回 ticket=undefined + 幂等 release', async () => {
  const { entry, readLog } = freshEntry({ 'account:glm': { limit: 2 } });
  const r = await entry.admit(payload('account:glm'));
  assert.ok(r && typeof r.release === 'function');
  assert.equal('ticket' in r, true);
  assert.equal(r.ticket, undefined);
  r.release();
  r.release(); // 双点幂等
  const events = readLog().map((e) => e.type);
  assert.deepEqual(events, ['acquire', 'grant', 'release']);
});

test('超限排队:onQueued 后授予,FIFO 依序', async () => {
  const { entry } = freshEntry({ 'account:glm': { limit: 1 } });
  const seq = [];
  const r1 = await entry.admit(payload('account:glm'));
  const p2 = entry.admit(
    payload('account:glm', {
      onQueued: () => seq.push('q2'),
      onAdmitted: () => seq.push('a2'),
    }),
  ).then((x) => (seq.push('g2'), x));
  const p3 = entry.admit(
    payload('account:glm', {
      onQueued: () => seq.push('q3'),
      onAdmitted: () => seq.push('a3'),
    }),
  ).then((x) => (seq.push('g3'), x));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seq, ['q2', 'q3']); // 双双入队,fast path 不回调
  r1.release();
  const r2 = await p2;
  r2.release();
  const r3 = await p3;
  r3.release();
  assert.deepEqual(seq, ['q2', 'q3', 'a2', 'g2', 'a3', 'g3']);
});

test('排队中 abort → 抛 ZsemCancelled(name=AbortError,带 __zsemCancel),名额不泄漏', async () => {
  const { entry } = freshEntry({ 'account:glm': { limit: 1 } });
  const r1 = await entry.admit(payload('account:glm'));
  const ac = new AbortController();
  const reason = new Error('stop');
  const p2 = entry.admit(payload('account:glm', { signal: ac.signal }));
  await new Promise((r) => setTimeout(r, 5)); // 确保 p2 已入队
  ac.abort(reason);
  const err = await p2.then(
    () => assert.fail('should reject'),
    (e) => e,
  );
  assert.equal(err.name, 'AbortError');
  assert.equal(err.__zsemCancel, true);
  assert.equal(err.cause, reason);
  // 已取消者不占名额:r1 释放后新请求立即授予(而非交给已取消的 p2)
  r1.release();
  const r3 = await entry.admit(payload('account:glm'));
  r3.release();
});

test('admit 前 signal 已 abort → 直接抛 ZsemCancelled,不占名额', async () => {
  const { entry } = freshEntry({ 'account:glm': { limit: 1 } });
  const ac = new AbortController();
  ac.abort(new Error('early'));
  const err = await entry.admit(payload('account:glm', { signal: ac.signal })).then(
    () => assert.fail('should reject'),
    (e) => e,
  );
  assert.equal(err.__zsemCancel, true);
  // 名额未被占用:下一个请求立即授予
  const r = await entry.admit(payload('account:glm'));
  r.release();
});

test('config 缺失 → failopen(undefined)+ failopen 日志', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsem-entry-'));
  delete require.cache[require.resolve(entryPath)];
  const entry = require(entryPath);
  entry.__forTest.overrides.configPath = path.join(dir, 'nonexistent.json');
  entry.__forTest.overrides.logPath = path.join(dir, 'log.jsonl');
  assert.equal(await entry.admit(payload('account:glm')), undefined);
  const lines = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines[0]).type, 'failopen');
});

test('payload 无 model.providerId → undefined(fail-open 形态,不炸)', async () => {
  const { entry } = freshEntry({ 'account:glm': { limit: 1 } });
  assert.equal(await entry.admit({}), undefined);
  assert.equal(await entry.admit(undefined), undefined);
});
