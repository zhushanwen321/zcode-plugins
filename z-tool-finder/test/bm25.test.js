'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIndex, search, tokenize } = require('../lib/bm25.js');

const docs = [
  { id: 'a:read_file', text: 'read file content 读取文件内容' },
  { id: 'a:write_file', text: 'write file content 写入文件内容' },
  { id: 'b:browser_navigate', text: 'navigate browser to url 浏览器导航网页' },
  { id: 'plugin:p:s:fetch_url', text: 'fetch url content 抓取网页内容' },
];

test('tokenize：英文按非字母数字切、中文单字、统一小写', () => {
  assert.deepEqual(tokenize('Read FILE, 内容!'), ['read', 'file', '内', '容']);
});

test('中文命中排序：相关工具得分更高且降序', () => {
  const idx = buildIndex(docs);
  const hits = search(idx, '读取文件');
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, 'a:read_file');
  assert.ok(hits[0].score > 0);
  if (hits.length > 1) {
    assert.ok(hits[0].score >= hits[hits.length - 1].score);
  }
});

test('英文命中排序：file 同时命中读写，均返回', () => {
  const idx = buildIndex(docs);
  const hits = search(idx, 'file');
  const ids = hits.map((h) => h.id);
  assert.ok(ids.includes('a:read_file'));
  assert.ok(ids.includes('a:write_file'));
});

test('中英混合查询命中', () => {
  const idx = buildIndex(docs);
  const hits = search(idx, 'browser 导航');
  assert.equal(hits[0].id, 'b:browser_navigate');
});

test('无命中返回空数组', () => {
  const idx = buildIndex(docs);
  assert.deepEqual(search(idx, 'nonexistent'), []);
});

test('limit 截断结果条数', () => {
  const idx = buildIndex(docs);
  const hits = search(idx, 'file', 1);
  assert.equal(hits.length, 1);
});

test('空索引与空查询返回空', () => {
  assert.deepEqual(search(buildIndex([]), 'x'), []);
  const idx = buildIndex(docs);
  assert.deepEqual(search(idx, '   '), []);
});
