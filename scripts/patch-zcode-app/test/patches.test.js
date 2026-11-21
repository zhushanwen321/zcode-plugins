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
  assert.ok(content.includes('zcode-patch:quota-auto-reset v1'));
  assert.ok(content.includes('zcode-patch:quota-auto-reset end'));
  assert.ok(content.endsWith('*/\n'), '补丁块应以闭合标记换行结尾');
  // 语义保持：原调用仍存在且包裹后是合法逗号表达式
  assert.ok(content.includes('(globalThis.__zswQuotaCtx='));
  assert.ok(quota.isApplied(content));
});

test('quota transform：幂等', () => {
  const once = quota.transform(STYLES_CHUNK_JS, 'x').content;
  const twice = quota.transform(once, 'x');
  assert.equal(twice.note, 'already-applied');
  assert.equal(twice.content, once);
});

test('quota transform：捕获锚点缺失时报可操作错误', () => {
  assert.throws(() => quota.transform('let x=1;', 'x'), /命中 0 处/);
});

test('注入代码语法合法（node --check 级校验用 new Function 覆盖观察器主体）', () => {
  const { content } = quota.transform(STYLES_CHUNK_JS, 'x');
  // 提取观察器 IIFE 段做语法检查：new Function 只验语法不执行（setInterval 不会被触发）
  const m = content.match(/if \(typeof globalThis\.__zswQuotaAutoReset[\s\S]*$/);
  assert.ok(m, '观察器代码段缺失');
  const body = m[0].split('/* zcode-patch:quota-auto-reset end */')[0];
  assert.doesNotThrow(() => new Function(body), '观察器代码有语法错误');
});
