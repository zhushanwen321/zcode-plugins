'use strict';

/**
 * lib/clean-format.test.js：fmtBytes / fmtCount 边界直接单测（观察 4——新模块
 * 下沉后此前只经 doctor/clean-exec 渲染间接受覆盖，无直接边界用例）。
 *
 * 口径权威源 = lib/clean-format.js 头注：GB 千分位 1000 进制；非数值 → 'n/a'。
 * 零依赖纯函数，无 fixture / 无全局态（进程内直测即可）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fmtBytes, fmtCount } = require('../lib/clean-format');

// ------------------------------------------------- fmtCount

test('fmtCount：0 / 负数 / 小数 / 超大值千分位；非数值 → n/a', () => {
  assert.equal(fmtCount(0), '0', '0 不进千分位分支（渲染「命中 0 条」的合法形态）');
  assert.equal(fmtCount(6425), '6,425', '样张 6,425 千分位形态');
  assert.equal(fmtCount(-1234), '-1,234', '负数保留符号并千分位（失败计数语义不吞负值）');
  assert.equal(fmtCount(1234.56), '1,234.56', '小数不取整（调用方自决定精度）');
  assert.equal(fmtCount(Number.MAX_SAFE_INTEGER), '9,007,199,254,740,991',
    '超大值（2^53-1）逐位千分位（1e21 以上 toLocaleString 转科学计数法，断言停在安全整数域）');
  assert.equal(fmtCount(undefined), 'n/a', 'undefined → n/a（缺表计数形态）');
  assert.equal(fmtCount(null), 'n/a', 'null → n/a（conflicts null 归一形态）');
  assert.equal(fmtCount('12'), 'n/a', '字符串数字不收（类型不拐弯）');
});

// ------------------------------------------------- fmtBytes

test('fmtBytes：0 / 负数 / 边界 999→1000 / 各级换算 / 单位封顶 TB；非有限数值 → n/a', () => {
  assert.equal(fmtBytes(0), '0B', '0 原样 B（不进换算循环）');
  assert.equal(fmtBytes(-1500), '-1500B', '负数不换算（v>=1000 为假，原样带符号输出——现状口径固化）');
  assert.equal(fmtBytes(512.7), '512.7B', 'B 级小数不 toFixed（i=0 分支）');
  assert.equal(fmtBytes(999), '999B');
  assert.equal(fmtBytes(1000), '1.0KB', '1000 进制换算边界（999→B、1000→KB）');
  assert.equal(fmtBytes(1536), '1.5KB');
  assert.equal(fmtBytes(6745678), '6.7MB');
  assert.equal(fmtBytes(6729084928), '6.7GB', '模块头注样例数字（设计 §2.1 实测口径）');
  assert.equal(fmtBytes(1e15), '1000.0TB', 'units 封顶 TB：超 TB 体积不再升单位，数值继续放大');
  assert.equal(fmtBytes(NaN), 'n/a', 'NaN → n/a（磁盘探测失败形态，不渲染 NaN 字面量）');
  assert.equal(fmtBytes(Infinity), 'n/a', 'Infinity → n/a');
  assert.equal(fmtBytes(undefined), 'n/a');
  assert.equal(fmtBytes('123'), 'n/a', '字符串数字不收');
});
