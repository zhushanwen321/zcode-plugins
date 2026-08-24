'use strict';

/**
 * lib/config.js 的 ZSW_MAX_CONCURRENT 解析单测（MF5）。
 *
 * 为什么用子进程而不是进程内重载 require.cache：DEFAULTS 在模块加载期
 * 求值一次（require 缓存保证「警告一次」语义），进程内 delete cache 重载
 * 会与本文件其它 lib 共享的 config 实例脱钩，且捕获不到 stderr 警告的
 * 「恰好一次」；子进程天然一个全新模块实例，stdout 取值 + stderr 取警告。
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const CONFIG = path.join(__dirname, '..', 'lib', 'config.js');

/** 子进程加载 config，打印 DEFAULTS.maxConcurrent；返回 {value, stderr}。
 *  env 值为 null 时表示显式删除该键（区分「未设置」与「设为空串」两种形态）。 */
function loadWithEnv(env) {
  const merged = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e',
      `console.log(require(${JSON.stringify(CONFIG)}).DEFAULTS.maxConcurrent)`,
    ], { env: merged, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`子进程退出 code=${code}，stderr: ${err}`));
      else resolve({ value: Number(out.trim()), stderr: err });
    });
  });
}

test('ZSW_MAX_CONCURRENT 缺省（未设置 / 空串）→ 3，无警告', async () => {
  for (const absent of [null, '']) {
    const { value, stderr } = await loadWithEnv({ ZSW_MAX_CONCURRENT: absent });
    assert.equal(value, 3);
    assert.equal(stderr, '');
  }
});

test('ZSW_MAX_CONCURRENT=5（合法正整数）→ 5', async () => {
  const { value, stderr } = await loadWithEnv({ ZSW_MAX_CONCURRENT: '5' });
  assert.equal(value, 5);
  assert.equal(stderr, '', '合法值不警告');
});

test('ZSW_MAX_CONCURRENT=1（边界最小值）→ 1 生效', async () => {
  const { value } = await loadWithEnv({ ZSW_MAX_CONCURRENT: '1' });
  assert.equal(value, 1);
});

test('ZSW_MAX_CONCURRENT 非法（abc / 0 / -2 / 2.5）→ 忽略并 stderr 警告一次，回落 3', async () => {
  for (const bad of ['abc', '0', '-2', '2.5']) {
    const { value, stderr } = await loadWithEnv({ ZSW_MAX_CONCURRENT: bad });
    assert.equal(value, 3, `${bad} 应回落缺省 3`);
    assert.match(stderr, /ZSW_MAX_CONCURRENT/, `${bad} 应有警告`);
    assert.match(stderr, /正整数/, `${bad} 警告应指向合法形态`);
    assert.match(stderr, /缺省 3/, `${bad} 警告应说明回落值`);
    // 恰好一次：警告行只出现一行（模块加载期求值一次的语义锚点）
    assert.equal(stderr.split('\n').filter((l) => l.includes('ZSW_MAX_CONCURRENT')).length, 1,
      `${bad} 警告应恰好一次`);
  }
});
