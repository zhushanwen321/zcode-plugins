#!/usr/bin/env node
'use strict';

/**
 * npm 包内容完整性检查（CI 用；发布前的最后防线）。
 *
 * 为什么需要：files 白名单写漏一行，发布后用户装到的就是「装得上但跑不起来」
 * 的坏包——错误要等到第一个安装者报障才暴露。本脚本对每个插件跑
 * `npm pack --dry-run --json`，断言 zcode 插件的运行必需件都在 tarball 里：
 *   - bin 声明的每个入口（npm 包 CLI 契约）
 *   - .zcode-plugin/plugin.json + .mcp.json（zcode 插件发现契约）
 *
 * 用法：node scripts/check-pack.js [workspaceRoot]
 *   退出码 0 = 全部通过；1 = 有缺失（每条缺失指出该加进哪个 package.json 字段）。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));

const pluginDirs = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => e.name)
  .filter((name) => fs.existsSync(path.join(ROOT, name, 'package.json')));

if (pluginDirs.length === 0) {
  console.log('check-pack: 无含 package.json 的插件目录，跳过。');
  process.exit(0);
}

const problems = [];
const bad = (msg) => problems.push(msg);

for (const name of pluginDirs) {
  const dir = path.join(ROOT, name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

  // npm pack --dry-run --json：stdout 是单元素数组的 JSON（npm 7+）
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }),
  )[0];
  const paths = new Set(packed.files.map((f) => f.path));

  // 必需件 1：bin 入口
  for (const [cmd, entry] of Object.entries(pkg.bin || {})) {
    if (!paths.has(entry)) bad(`${name}: bin 入口 ${entry}（命令 ${cmd}）不在 tarball，把它加入 package.json 的 files`);
  }
  // 必需件 2：zcode 插件双清单
  for (const must of ['.zcode-plugin/plugin.json', '.mcp.json']) {
    if (!paths.has(must)) bad(`${name}: ${must} 不在 tarball——zcode 靠它发现插件，加入 files 后发布`);
  }
}

if (problems.length > 0) {
  console.error(`check-pack: ${problems.length} 处包内容缺失`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-pack: ${pluginDirs.length} 个插件包内容完整（${pluginDirs.join(', ')}）`);
