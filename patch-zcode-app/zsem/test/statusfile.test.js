'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { publishStatus, aggregate, clearPid } = require('../lib/statusfile');

function tmpFile(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, 'status.json');
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('publish 写快照,aggregate 读回一致', () => {
  const { file, cleanup } = tmpFile('zsem-st-');
  publishStatus({ p: { limit: 7, active: 2, queued: 1 } }, file);
  const agg = aggregate(file);
  assert.deepEqual(agg, { active: 2, queued: 1, limit: 7, providers: { p: { active: 2, queued: 1, limit: 7 } } });
  cleanup();
});

test('多 pid 分片:各写各的,聚合求和', () => {
  const { file, cleanup } = tmpFile('zsem-st-');
  const realPid = process.pid;
  // 模拟两个进程:本 pid + 伪造的另一个 pid 分片(直接改文件)
  publishStatus({ p: { limit: 7, active: 2, queued: 0 } }, file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.pids['999999'] = { providers: { p: { limit: 7, active: 3, queued: 2 } }, updatedAt: 'x' };
  fs.writeFileSync(file, JSON.stringify(raw));
  const agg = aggregate(file);
  assert.equal(agg.active, 5);
  assert.equal(agg.queued, 2);
  assert.equal(agg.limit, 7);
  // 本 pid 再次发布只换自己的分片,不丢对方
  publishStatus({ p: { limit: 7, active: 1, queued: 0 } }, file);
  const agg2 = aggregate(file);
  assert.equal(agg2.active, 4); // 1 + 3
  clearPid(file, 999999);
  cleanup();
});

test('损坏旧文件按空起,不抛', () => {
  const { file, cleanup } = tmpFile('zsem-st-');
  fs.writeFileSync(file, '{broken');
  publishStatus({ p: { limit: 7, active: 0, queued: 0 } }, file);
  assert.equal(aggregate(file).limit, 7);
  cleanup();
});

test('FIFO/目录等非常规路径:发布静默失败不抛', { timeout: 5000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsem-st-'));
  const fifo = path.join(dir, 'status.json');
  fs.writeFileSync(fifo, 'x');
  fs.unlinkSync(fifo);
  fs.mkdirSync(fifo); // 目录形态:readFileSync EISDIR → 静默
  publishStatus({ p: { limit: 7, active: 0, queued: 0 } }, fifo); // 不得抛不得挂
  fs.rmSync(dir, { recursive: true, force: true });
});
