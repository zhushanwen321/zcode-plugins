'use strict';
/**
 * 会话清理报告的人读格式化叶子工具（fmtBytes / fmtCount，零依赖纯函数）。
 *
 * 为什么独立成模块：执行器（clean-exec）与体检（doctor）都要渲染人读数字，
 * 实现原先住在 doctor.js——执行器为两个格式化函数经 require('./doctor') 把
 * 体检模块（连带其 clean-identify/clean-fs 依赖面）拉进执行器依赖图，违反
 * clean-fs.js 头注「不应经 require('./doctor') 背上间接依赖面」同款纪律。
 * 下沉到本叶子模块后，doctor 与 clean-exec 各自直接引用，依赖边消除。
 *
 * 口径：GB 千分位 1000 进制（与设计 §2.1 实测数字同口径）；非数值 → 'n/a'。
 */

/** 千分位（样张 6,425 形态）。 */
function fmtCount(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : 'n/a';
}

/** 体积人读（GB 口径 = 1000 进制，与设计 §2.1 实测数字同口径：6,729,084,928B → 6.7GB）。 */
function fmtBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)}${units[i]}`;
}

module.exports = { fmtBytes, fmtCount };
