#!/usr/bin/env node
'use strict';

/**
 * 改动-发版关联检测：列出「改了消费者可见文件但版本未 bump」的插件（软门禁，信息工具）。
 *
 * 为什么需要：check-sync 只保证「版本三处一致」，不保证「改了代码就该发版」——
 * 改了 <plugin>/lib 但不 bump，三处一致地停留在旧版本，bug fix 静默丢失，用户装不到。
 * 多插件后「哪个插件该发版」的判定靠记忆必然出错，此脚本把判定机械化。
 * （机制借鉴 xyz-agent check-version-changes.sh 的触发判定，形态按本仓零依赖裁剪；
 * 不引入 changesets——其核心价值 workspace 依赖闭包在本仓不存在，见 AGENTS.md npm 规范。）
 *
 * 触发判定 = 变更文件落在插件 package.json 的 files 白名单内（消费者安装可见 = 发版才有意义）：
 *   - lib/bin/dist/skills/双 manifest/README/CONTEXT 等白名单内 → 触发
 *   - test/fixtures/design 等白名单外目录 → 天然不触发（消费者装不到，无需发版）
 *   - 插件 package.json 自身变更不触发（version bump 就在改它，触发即自锁）；
 *     files/bin 等消费契约变化视为发版流程一部分，由 release.js 时的 check-pack 把关
 *   - workspace 级文件（scripts/、.github/、marketplace.json、docs/…）不属于任何插件 → 不触发
 *
 * 输出三段（RELEASING 正常 / UNRELEASED 待决策 / SHARED_CHANGED 警告），
 * 退出码恒 0——发不发版是用户决策，本脚本只保证决策面完整可见。
 *
 * 用法：node scripts/check-release-needed.js [--base <ref>]（默认 base = main）
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
let base = 'main';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base' && args[i + 1]) base = args[i + 1];
}

const git = (gitArgs, quiet) =>
  execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'] });

// 插件发现：与 check-sync.js 同规则（一级目录含 package.json）
const pluginDirs = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => e.name)
  .filter((name) => fs.existsSync(path.join(ROOT, name, 'package.json')));

// files 白名单匹配（npm files 三类条目：精确文件 / 目录 foo/ / glob）。
// glob 简版语义：** 匹配零或多层目录，* 单层，? 单字符（够覆盖本仓与常规写法）。
function globToRegex(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += pattern[i + 2] === '/' ? 3 : 2;
      continue;
    }
    if (c === '*') { re += '[^/]*'; i++; continue; }
    if (c === '?') { re += '[^/]'; i++; continue; }
    if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
    i++;
  }
  return new RegExp(`^${re}$`);
}

function inFilesWhitelist(relFile, files) {
  if (!Array.isArray(files)) return false;
  for (const entry of files) {
    if (entry.endsWith('/')) {
      const dir = entry.slice(0, -1);
      if (relFile === dir || relFile.startsWith(`${dir}/`)) return true;
    } else if (entry.includes('*')) {
      if (globToRegex(entry).test(relFile)) return true;
    } else if (relFile === entry) {
      return true;
    }
  }
  return false;
}

const readPkg = (dir) => JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));

// 某 ref 下插件的 version（ref 上无此文件返回 null；stderr 静默——新插件首分支是常态非错误）
function versionAt(ref, dir) {
  try {
    const raw = git(['show', `${ref}:${dir}/package.json`], true);
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}

let changedFiles;
try {
  changedFiles = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);
} catch {
  console.error(`check-release-needed: 无法读取 diff ${base}...HEAD（base ref 不存在？）`);
  process.exit(0); // 信息工具：自身故障不当发版门禁
}

const releasing = [];   // 版本已 bump 的插件（正常，列出供核对）
const unreleased = [];  // 改了白名单内文件但版本未变（决策面）
let sharedChanged = false;

for (const name of pluginDirs) {
  const pkg = readPkg(name);
  const baseVersion = versionAt(base, name);
  const headVersion = pkg.version;
  const bumped = baseVersion !== null && baseVersion !== headVersion;

  const triggering = changedFiles.some((f) => {
    if (!f.startsWith(`${name}/`) || f === `${name}/package.json`) return false;
    return inFilesWhitelist(f.slice(name.length + 1), pkg.files);
  });

  if (bumped) {
    releasing.push(`${name} ${baseVersion} -> ${headVersion}${triggering ? '' : '（注意：版本已 bump 但白名单内无变更）'}`);
  } else if (triggering) {
    unreleased.push(name);
  }
}

sharedChanged = changedFiles.some((f) => f.startsWith('shared/'));

const lines = [];
lines.push('RELEASING（版本已 bump，正常）:');
lines.push(releasing.length ? releasing.map((s) => `  ${s}`).join('\n') : '  (none)');
lines.push('');
lines.push('UNRELEASED（改了消费者可见文件但版本未变，发版待决策）:');
lines.push(unreleased.length ? unreleased.map((s) => `  ${s}（当前 ${readPkg(s).version}；要发版用 node scripts/release.js ${s} <patch|minor|major>）`).join('\n') : '  (none)');
if (sharedChanged) {
  lines.push('');
  lines.push('SHARED_CHANGED: shared/ 有变更——确认是否需要重发 vendored 它的插件（shared 构建期复制进插件 dist，消费者不会自动获得修复）');
}
console.log(lines.join('\n'));
