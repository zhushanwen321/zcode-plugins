#!/usr/bin/env node
'use strict';

/**
 * 插件 npm 包一致性检查（pre-commit / CI / release workflow 三处共用）。
 *
 * 为什么需要三处版本同步：npm 包（package.json）、zcode 插件清单
 * （.zcode-plugin/plugin.json）、workspace marketplace（marketplace.json）
 * 是同一插件的三个发布面，任一漂移都会让用户装到「版本号相同但内容不同」的包。
 *
 * 校验规则（对每个含 package.json 的一级插件目录）：
 *   1. 包名必须为 @zhushanwen/<目录名>（z- 前缀目录名即包名后缀，AGENTS.md npm 规范）
 *   2. package.json / plugin.json / marketplace.json 三处 version 一致
 *   3. marketplace.json 必须已登记该插件
 *   4. 零依赖红线：package.json 不得声明 dependencies / devDependencies
 *      （发布清单用途，不是依赖管理入口；引入依赖须走 AGENTS.md 评估流程）
 *
 * 用法：node scripts/check-sync.js [workspaceRoot]
 *   退出码 0 = 全部通过；1 = 有违规（每条违规输出具体文件与修复方向）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const SCOPE = '@zhushanwen';

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { __error: `${file}: ${err.message}` };
  }
};

const problems = [];
const bad = (msg) => problems.push(msg);

// 收集候选插件目录：一级目录且含 package.json（docs/ shared/ 等无清单即跳过）
const pluginDirs = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => e.name)
  .filter((name) => fs.existsSync(path.join(ROOT, name, 'package.json')));

if (pluginDirs.length === 0) {
  console.log('check-sync: 无含 package.json 的插件目录，跳过。');
  process.exit(0);
}

const marketplace = readJson(path.join(ROOT, 'marketplace.json'));
if (marketplace.__error) bad(marketplace.__error);

for (const name of pluginDirs) {
  const dir = path.join(ROOT, name);
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg.__error) {
    bad(pkg.__error);
    continue;
  }

  // 规则 1：包名规范
  if (pkg.name !== `${SCOPE}/${name}`) {
    bad(`${name}/package.json: name 应为 "${SCOPE}/${name}"，实际 "${pkg.name}"（npm 包名 = @zhushanwen/ + 插件目录名）`);
  }

  // 规则 4：零依赖红线
  for (const depField of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (pkg[depField] && Object.keys(pkg[depField]).length > 0) {
      bad(`${name}/package.json: 声明了 ${depField}，违反零依赖红线（如确需引入，先按 AGENTS.md 评估三种安装形态影响并更新规范）`);
    }
  }

  // 规则 2：plugin.json 版本一致（有 plugin.json 才检查）
  const manifestPath = path.join(dir, '.zcode-plugin', 'plugin.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = readJson(manifestPath);
    if (manifest.__error) {
      bad(manifest.__error);
    } else if (manifest.version !== pkg.version) {
      bad(`版本漂移：${name}/package.json@${pkg.version} != ${name}/.zcode-plugin/plugin.json@${manifest.version}（用 node scripts/release.js ${name} <patch|minor|major> 统一 bump 三处）`);
    }
  } else {
    bad(`${name}: 有 package.json 但缺 .zcode-plugin/plugin.json（npm 包与 zcode 插件清单必须成对，见 AGENTS.md npm 发布规范）`);
  }

  // 规则 3：marketplace 登记 + 版本一致
  const entry = Array.isArray(marketplace.plugins) && marketplace.plugins.find((p) => p.name === name);
  if (!entry) {
    bad(`marketplace.json: 插件 ${name} 未登记（合入 main 前必须补条目）`);
  } else if (entry.version !== pkg.version) {
    bad(`版本漂移：${name}/package.json@${pkg.version} != marketplace.json@${entry.version}（用 node scripts/release.js ${name} <patch|minor|major> 统一 bump 三处）`);
  }
}

if (problems.length > 0) {
  console.error(`check-sync: ${problems.length} 处违规`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-sync: ${pluginDirs.length} 个插件包全部一致（${pluginDirs.join(', ')}）`);
