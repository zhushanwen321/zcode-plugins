#!/usr/bin/env node
'use strict';

/**
 * 插件 npm 发布入口：统一 bump 三处版本 + commit + tag（不 push）。
 *
 * 为什么有这个脚本：版本存在于三个发布面（package.json / plugin.json /
 * marketplace.json），手工改必漂移（check-sync.js 的存在即是证据）。
 * 发不发布 npm 由 tag 触发的 GitHub Actions 决定；本脚本只负责把
 * 「版本号一致性」收敛到单点。
 *
 * 流程（node scripts/release.js <plugin> <patch|minor|major>）：
 *   1. 前置检查：check-sync 全绿（漂移状态下先修复再发版）+ 工作区干净
 *   2. 三处同步 bump（package.json / plugin.json / marketplace.json）
 *   3. git commit（conventional，scope 用插件缩写）+ tag `<plugin>@<version>`
 *   4. 打印 push 命令后退出——push 需用户授权，脚本绝不代推
 *      （tag 推上远端即触发 .github/workflows/release-npm.yml 发布）
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const [plugin, bumpType] = process.argv.slice(2);

const usage = '用法: node scripts/release.js <plugin-dir> <patch|minor|major>';
if (!plugin || !bumpType || !['patch', 'minor', 'major'].includes(bumpType)) {
  console.error(`${usage}\n  例: node scripts/release.js z-subagent-workflow patch`);
  process.exit(1);
}

const die = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

// 前置 1：插件目录三处清单齐全
const files = {
  pkg: path.join(ROOT, plugin, 'package.json'),
  manifest: path.join(ROOT, plugin, '.zcode-plugin', 'plugin.json'),
  marketplace: path.join(ROOT, 'marketplace.json'),
};
for (const f of Object.values(files)) {
  if (!fs.existsSync(f)) die(`缺少 ${path.relative(ROOT, f)}（npm 包三件套必须齐全，见 AGENTS.md npm 发布规范）`);
}

// 前置 2：当前版本三处一致（漂移时先跑 check-sync 看差异）
execFileSync('node', [path.join(__dirname, 'check-sync.js'), ROOT], { stdio: 'inherit', cwd: ROOT });

// 前置 3：工作区干净（bump commit 只能含版本变更，混入其他改动会让 tag 内容失真）
const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT }).toString();
if (status.trim()) die(`工作区不干净：\n${status}\n先提交或暂存当前改动再发版（release commit 必须只含版本 bump）。`);

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, obj) => fs.writeFileSync(f, `${JSON.stringify(obj, null, 2)}\n`);

const pkg = readJson(files.pkg);
const [major, minor, patch] = pkg.version.split('.').map(Number);
if ([major, minor, patch].some(Number.isNaN)) die(`当前版本 ${pkg.version} 非标准三段 semver`);
const next = {
  patch: `${major}.${minor}.${patch + 1}`,
  minor: `${major}.${minor + 1}.0`,
  major: `${major + 1}.0.0`,
}[bumpType];

// 三处同步 bump（保持键序，2 空格缩进与仓库 JSON 风格一致）
pkg.version = next;
writeJson(files.pkg, pkg);
const manifest = readJson(files.manifest);
manifest.version = next;
writeJson(files.manifest, manifest);
const marketplace = readJson(files.marketplace);
const entry = marketplace.plugins.find((p) => p.name === plugin);
if (!entry) die(`marketplace.json 未登记 ${plugin}（先补条目再发版）`);
entry.version = next;
writeJson(files.marketplace, marketplace);

// 复核：bump 后仍满足全部一致性规则（防脚本自身写坏）
execFileSync('node', [path.join(__dirname, 'check-sync.js'), ROOT], { stdio: 'inherit', cwd: ROOT });

// commit scope 用插件缩写（仓库现有 conventional 风格，如 feat(zsw)）。
// 缩写的 SSOT 是各插件 CONTEXT.md（目录名与缩写无机械映射），此处维护映射，
// 未登记的新插件回退目录名去 z- 前缀。
const SCOPES = { 'z-subagent-workflow': 'zsw' };
const scope = SCOPES[plugin] || plugin.replace(/^z-/, '');
const tag = `${plugin}@${next}`;
execFileSync('git', ['add', files.pkg, files.manifest, files.marketplace], { cwd: ROOT });
execFileSync('git', ['commit', '-m', `release(${scope}): bump ${plugin} to ${next}`], { stdio: 'inherit', cwd: ROOT });
execFileSync('git', ['tag', '-a', tag, '-m', `${plugin} ${next}`], { cwd: ROOT });

console.log(`
release: ${plugin} ${next} 已就绪
  commit: release(${scope}): bump ${plugin} to ${next}
  tag:    ${tag}

下一步（需自行确认后执行，tag 推送即触发 npm 发布 workflow）：
  git push origin HEAD && git push origin ${tag}
`);
