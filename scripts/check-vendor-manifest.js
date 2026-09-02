#!/usr/bin/env node
'use strict';

/**
 * vendored subagent-core sha256 完整性门禁（设计 D-E2/§5.1 的 CI 落地）。
 *
 * 为什么需要独立门禁：vendored 副本是构建期产物（scripts/vendor-subagent-core.js
 * 刷新），VENDOR-MANIFEST.json 记录逐文件 sha256 溯源；刷新中断 / 手工改动 /
 * 部分拷贝等漂移要等到运行时 requireCore 失败才暴露。本脚本对工作区真实
 * vendored 重放 vendor 脚本的同款自检，把漂移拦在合入前。
 *
 * 校验规则（对 z-subagent-workflow/lib/vendor/subagent-core/VENDOR-MANIFEST.json）：
 *   1. manifest 可读且为合法 JSON，files 为非空数组
 *   2. files 清单逐文件：文件在场且 sha256 与记录一致
 *   （manifest 自身不在 files 清单内——vendor 脚本落盘契约，无从自校验）
 *
 * 用法：node scripts/check-vendor-manifest.js [workspaceRoot]
 *   退出码 0 = 全部一致；1 = manifest 损坏 / 文件缺失 / sha256 不匹配
 *   （输出全部问题，首个不匹配项在最前）。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const VENDOR_DIR = path.join(ROOT, 'z-subagent-workflow', 'lib', 'vendor', 'subagent-core');
const MANIFEST = path.join(VENDOR_DIR, 'VENDOR-MANIFEST.json');

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
} catch (err) {
  console.error(`check-vendor-manifest: 读取 VENDOR-MANIFEST.json 失败（${MANIFEST}: ${err.message}）。`);
  console.error('恢复指引：workspace 根执行 node scripts/vendor-subagent-core.js 重刷 vendored 副本（产物含新 manifest）。');
  process.exit(1);
}

const entries = Array.isArray(manifest.files) ? manifest.files : [];
if (entries.length === 0) {
  console.error('check-vendor-manifest: VENDOR-MANIFEST.json 无 files 清单（vendor 产物异常）。');
  console.error('恢复指引：workspace 根执行 node scripts/vendor-subagent-core.js 重刷 vendored 副本。');
  process.exit(1);
}

const problems = [];
for (const entry of entries) {
  const rel = entry && typeof entry.path === 'string' ? entry.path : '';
  const recorded = entry && typeof entry.sha256 === 'string' ? entry.sha256 : '';
  if (rel === '') {
    problems.push('<无效条目>: files 清单含缺 path/sha256 的条目');
    continue;
  }
  const file = path.join(VENDOR_DIR, rel);
  if (!fs.existsSync(file)) {
    problems.push(`${rel}: 文件缺失（manifest 记录 ${recorded || '<无>'}）`);
    continue;
  }
  const actual = sha256(file);
  if (actual !== recorded) problems.push(`${rel}: sha256 不匹配（manifest ${recorded} / 磁盘 ${actual}）`);
}

if (problems.length > 0) {
  console.error(`check-vendor-manifest: ${problems.length}/${entries.length} 个文件校验失败：`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('恢复指引：workspace 根执行 node scripts/vendor-subagent-core.js 重刷 vendored 副本（勿手工改动 lib/vendor/ 下任何文件）。');
  process.exit(1);
}

console.log(`check-vendor-manifest: ${entries.length} 个文件 sha256 全部一致（source: ${manifest.source || '<unknown>'}）`);
