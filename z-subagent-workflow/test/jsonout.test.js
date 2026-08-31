'use strict';

/**
 * jsonout 纯函数穷举式直接单测（此前仅经 manager.test.js 间接覆盖）。
 * 解析顺序：整体 JSON → ```json 围栏 → 首个平衡 {...} 段（跳过字符串内花括号）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractJsonObject } = require('../lib/jsonout');

// ------------------------------------------------------------ extractJsonObject

test('非字符串输入返回 null', () => {
  assert.equal(extractJsonObject(null), null);
  assert.equal(extractJsonObject(undefined), null);
  assert.equal(extractJsonObject(123), null);
  assert.equal(extractJsonObject(''), null);
});

test('整体即 JSON 对象', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('  {"a":1}  \n'), { a: 1 });
});

test('合法 JSON 但非对象 → 拒绝数组/标量，继续降级', () => {
  // '[1,2]' 整体解析是数组（isObj 拒绝）；降级路径无 { 起点 → null
  assert.equal(extractJsonObject('[1,2]'), null);
  assert.equal(extractJsonObject('"just a string"'), null);
  assert.equal(extractJsonObject('42'), null);
});

test('```json 围栏块提取', () => {
  const text = '结论如下：\n```json\n{"status":"issues","issues":[]}\n```\n完毕';
  assert.deepEqual(extractJsonObject(text), { status: 'issues', issues: [] });
  // 无语言标注的围栏同样命中
  assert.deepEqual(extractJsonObject('```\n{"x":true}\n```'), { x: true });
});

test('围栏内 JSON 非法 → 降级平衡段', () => {
  // 围栏里没有花括号（整体解析失败且不产生平衡段起点）→ 落到 prose 段
  const text = '```json\noops\n``` 前缀说明 {"real":"obj"} 尾部';
  assert.deepEqual(extractJsonObject(text), { real: 'obj' });
});

test('prose 包裹的平衡花括号段提取', () => {
  assert.deepEqual(extractJsonObject('分析完成，结果为 {"ok":true,"n":2} 请查收'), { ok: true, n: 2 });
});

test('字符串字面量内的未配对花括号不计深度', () => {
  const text = '说明 {"s":"包含 } 和 { 的字符串","end":true}';
  assert.deepEqual(extractJsonObject(text), { s: '包含 } 和 { 的字符串', end: true });
});

test('转义引号不翻转 inStr', () => {
  const text = '{"s":"a \\"b\\" {","t":1}';
  assert.deepEqual(extractJsonObject(text), { s: 'a "b" {', t: 1 });
  // prose 包裹 + 转义引号组合
  assert.deepEqual(extractJsonObject(`前置文字 {"s":"路径 \\"C:\\\\"} 后置`), { s: '路径 "C:\\' });
});

test('首个平衡段非法 JSON → null（不继续尝试后续段）', () => {
  assert.equal(extractJsonObject('先 {非法} 后 {"ok":1}'), null);
});

test('花括号深度嵌套的平衡段', () => {
  const text = '嵌套 {"outer":{"inner":[1,2,{"k":"v"}]},"flag":false}';
  assert.deepEqual(extractJsonObject(text), { outer: { inner: [1, 2, { k: 'v' }] }, flag: false });
});

test('只有未闭合 { → null', () => {
  assert.equal(extractJsonObject('开始 {"a":1'), null);
});
