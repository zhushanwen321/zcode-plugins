'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { HOST_INDEX_JS, STYLES_CHUNK_JS } = require('./helpers');
const yolo = require('../patches/yolo');
const quota = require('../patches/quota-auto-reset');

test('yolo transform：等宽替换 build→yolo，结果可被 isApplied 识别', () => {
  const before = Buffer.byteLength(HOST_INDEX_JS, 'utf8');
  const { content, note } = yolo.transform(HOST_INDEX_JS, '/out/host/index.js');
  assert.equal(note, 'patched');
  assert.equal(Buffer.byteLength(content, 'utf8'), before, 'yolo 必须等宽');
  assert.ok(content.includes('mode:l.mode ??"yolo"'));
  assert.ok(!content.includes('??"build"'));
  assert.equal(yolo.isApplied(content), true);
  assert.equal(yolo.isApplied(HOST_INDEX_JS), false);
});

test('yolo transform：幂等（已应用内容原样返回）', () => {
  const once = yolo.transform(HOST_INDEX_JS, 'x').content;
  const twice = yolo.transform(once, 'x');
  assert.equal(twice.note, 'already-applied');
  assert.equal(twice.content, once);
});

test('yolo transform：锚点缺失/多命中时报可操作错误', () => {
  assert.throws(() => yolo.transform('mode:a??"build";mode:b??"build";', 'x'), /命中 2 处/);
  assert.throws(() => yolo.transform('nothing here', 'x'), /命中 0 处/);
});

test('quota transform：捕获钩子包裹原调用 + 观察器追加到尾部', () => {
  const { content, note } = quota.transform(STYLES_CHUNK_JS, '/out/renderer/assets/styles-X.js');
  assert.equal(note, 'patched');
  assert.ok(content.includes('globalThis.__zswQuotaCtx={service:e,scope:e.scope,authSessionSeq:e.authSessionSeq},e.service.getCodingPlanResetStatus(e.scope)'));
  assert.ok(content.includes(`zcode-patch:quota-auto-reset ${quota.version}`));
  assert.ok(content.includes('zcode-patch:quota-auto-reset end'));
  assert.ok(content.endsWith('*/\n'), '补丁块应以闭合标记换行结尾');
  assert.equal(quota.isApplied(content), true);
});

test('quota transform：幂等（当前版本已应用 → 原样返回）', () => {
  const once = quota.transform(STYLES_CHUNK_JS, 'x').content;
  const twice = quota.transform(once, 'x');
  assert.equal(twice.note, 'already-applied');
  assert.equal(twice.content, once);
});

test('quota transform：版本升级（v1 注入在场上 → 剥离旧版换装当前版本）', () => {
  // 用旧版 marker 手工构造 v1 场上的内容（模拟 2026-11-21 首次真机 apply 的产物）
  const v1Injected = quota.transform(STYLES_CHUNK_JS, 'x').content.replace(
    '/* zcode-patch:quota-auto-reset v2 */',
    '/* zcode-patch:quota-auto-reset v1 */'
  );
  assert.equal(quota.isApplied(v1Injected), false, 'v1 内容不应被识别为当前版本已应用');
  const upgraded = quota.transform(v1Injected, 'x');
  assert.equal(upgraded.note, 'patched');
  assert.ok(upgraded.content.includes(`zcode-patch:quota-auto-reset ${quota.version}`), '应注入当前版本');
  assert.ok(!upgraded.content.includes('quota-auto-reset v1'), '旧版本观察器应被剥离');
  // 捕获钩子只包一层（升级不能叠双层包裹）
  const wrapCount = (upgraded.content.match(/globalThis\.__zswQuotaCtx=\{service:/g) || []).length;
  assert.equal(wrapCount, 1, `捕获钩子应恰好一层，实际 ${wrapCount} 层`);
  assert.equal(quota.isApplied(upgraded.content), true);
});

test('quota transform：捕获锚点缺失时报可操作错误', () => {
  assert.throws(() => quota.transform('let x=1;', 'x'), /命中 0 处/);
});
