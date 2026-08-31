#!/usr/bin/env node
'use strict';

/**
 * @zhushanwen/subagent-core 构建期 vendor 刷新脚本（可重复执行，幂等）。
 *
 * 为什么需要：插件三形态（inline 直载 / marketplace 副本 / npm 包内容）都没有
 * node_modules 解析面，core 只能以「构建期 vendored 副本」形态进插件目录（与
 * shared/ 构建期 vendor 同一模式）。产物入 git，本脚本是唯一刷新入口，溯源与
 * 完整性收口在产物目录的 VENDOR-MANIFEST.json（source + 逐文件 sha256）。
 *
 * 拷贝规则（目标 z-subagent-workflow/lib/vendor/subagent-core/，先清空再拷）：
 *   workflows/    全量 .js/.cjs（含子目录；README 等非资产文件不进 vendor）
 *   agents/       全量 .md（core ≥0.4.0 内置 agent 模板；源无该目录则跳过且
 *                 capabilities.agentsAssets=false——兼容旧版本 --npm 刷新）
 *   dist/         源有即拷；源存在 dist.bundle/index.cjs 时优先拷 dist.bundle/
 *                 （为 core 0.4.0 自包含 bundle 预留），统一落位 vendored dist/
 *   package.json  仅重写 name/version 两个字段（精简版，依赖声明绝不 vendor 进来）
 *
 * 源二选一：
 *   --npm <version>    npm registry 拉 tarball（npm pack --json，网络命令带超时）
 *   --local <path>     本地 core checkout（读其 package.json 的 version）
 *
 * 自检：拷贝后逐文件 sha256 与源比对；workflows/review-fix-loop-utils.cjs 必须
 * 存在，否则 exit 1（该存在性在 manifest 落盘前把关，capabilities 不记录恒为
 * true 的 workflowsAssets）。capabilities.selfContainedIndex 如实记录：
 * vendored index 产物内容无 ajv/yaml/proper-lockfile 外部 require 才为 true
 * （npm 0.2.0 dist 依赖 ajv → false，lib/core-ref.js 的 requireCore 据此分流
 * 恢复指引——true 与 false/清单不可读均指向重刷 + manifest sha256 自检）。
 *
 * 用法：node scripts/vendor-subagent-core.js (--npm <version> | --local <path>)
 *   退出码 0 = 刷新成功；1 = 失败（错误信息含恢复方向）。
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'z-subagent-workflow', 'lib', 'vendor', 'subagent-core');
const NPM_TIMEOUT_MS = 120000; // 网络命令必须带超时：卡死走 SIGTERM 兜底而非挂起
const REQUIRED_ASSET = path.join('workflows', 'review-fix-loop-utils.cjs');
// agents/ 的代表性资产（capabilities.agentsAssets 判定锚；general-purpose 是
// zsw 缺省角色的依赖面，缺失即 vendored agent 模板集不可用）
const REQUIRED_AGENT_ASSET = path.join('agents', 'general-purpose.md');
// 主入口自包含判定：这些外部依赖出现在 require(...) 即非自包含（单双引号都算）
const EXTERNAL_DEP_RE = /require\((["'])(ajv|yaml|proper-lockfile)\1\)/;

const die = (msg) => {
  console.error(`vendor-subagent-core: ${msg}`);
  process.exit(1);
};

// ---- 参数解析（源二选一，互斥） ----
const args = process.argv.slice(2);
let npmVersion = null;
let localPath = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--npm' && args[i + 1]) npmVersion = args[++i];
  else if (args[i] === '--local' && args[i + 1]) localPath = args[++i];
  else die(`未知参数或缺值: "${args[i]}"\n用法: node scripts/vendor-subagent-core.js (--npm <version> | --local <core-checkout-path>)`);
}
if ((npmVersion ? 1 : 0) + (localPath ? 1 : 0) !== 1) {
  die('必须且只能指定一个源：--npm <version> 或 --local <core-checkout-path>');
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** 递归列出 root 下全部文件的相对路径（POSIX 分隔符，排序保证 manifest 顺序稳定）。 */
function listFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), relPath);
      else out.push(relPath);
    }
  };
  walk(root, '');
  return out.sort();
}

/** 递归拷贝 src → dst（filter(相对路径) 为假的文件跳过，目录照常递归）。 */
function copyTree(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(path.join(src, e.name), path.join(dst, e.name), filter);
    else if (!filter || filter(e.name)) fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
}

// ---- 源准备：npm tarball 或本地 checkout，统一得到 { srcRoot, source, cleanup? } ----
function prepareNpmSource(version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-subagent-core-'));
  try {
    const stdout = execFileSync(
      'npm',
      ['pack', `@zhushanwen/subagent-core@${version}`, '--json', '--pack-destination', tmp],
      { encoding: 'utf8', timeout: NPM_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const packed = JSON.parse(stdout);
    if (!Array.isArray(packed) || !packed[0] || !packed[0].filename) die(`npm pack 输出形态异常: ${stdout.slice(0, 200)}`);
    execFileSync('tar', ['-xzf', path.join(tmp, packed[0].filename), '-C', tmp], { timeout: 30000 });
    const srcRoot = path.join(tmp, 'package');
    if (!fs.existsSync(srcRoot)) die('tarball 解包后无 package/ 目录（npm pack 产物契约变化？）');
    return { srcRoot, source: `npm@${version}`, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    die(`npm 源准备失败（--npm ${version}）: ${err.message}（网络命令已带 ${NPM_TIMEOUT_MS}ms 超时；先确认 registry 可达或本地镜像配置后重试）`);
  }
}

function prepareLocalSource(p) {
  const srcRoot = path.resolve(p);
  const pkgFile = path.join(srcRoot, 'package.json');
  if (!fs.existsSync(pkgFile)) die(`--local 源缺少 package.json: ${srcRoot}`);
  return { srcRoot, source: `local:${srcRoot}@${JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version}` };
}

const { srcRoot, source, cleanup } = npmVersion ? prepareNpmSource(npmVersion) : prepareLocalSource(localPath);
const srcPkg = JSON.parse(fs.readFileSync(path.join(srcRoot, 'package.json'), 'utf8'));
if (!fs.existsSync(path.join(srcRoot, 'workflows'))) die(`源缺少 workflows/ 目录: ${srcRoot}`);

// ---- 幂等基线：先清空目标目录再拷（重复执行产出一致，仅 fetchedAt 变化） ----
fs.rmSync(TARGET, { recursive: true, force: true });
fs.mkdirSync(TARGET, { recursive: true });

copyTree(path.join(srcRoot, 'workflows'), path.join(TARGET, 'workflows'), (name) => /\.(js|cjs)$/.test(name));

// agents/（core ≥0.4.0）：源无该目录则跳过（capabilities.agentsAssets=false，
// 兼容旧版本 --npm 刷新路径）；源有该目录但缺代表性资产 = 资产集异常，自检拦截
const srcAgentsDir = path.join(srcRoot, 'agents');
if (fs.existsSync(srcAgentsDir)) {
  copyTree(srcAgentsDir, path.join(TARGET, 'agents'), (name) => name.endsWith('.md'));
}

// dist 源选择：dist.bundle/index.cjs 存在则优先（0.4.0 自包含 bundle 预留），
// 拷入 vendored dist/ —— lib/core-ref.js 的入口路径跨 core 版本稳定
const distIsBundle = fs.existsSync(path.join(srcRoot, 'dist.bundle', 'index.cjs'));
const distSrc = distIsBundle ? path.join(srcRoot, 'dist.bundle') : path.join(srcRoot, 'dist');
if (fs.existsSync(distSrc)) copyTree(distSrc, path.join(TARGET, 'dist'));

fs.writeFileSync(
  path.join(TARGET, 'package.json'),
  `${JSON.stringify({ name: srcPkg.name, version: srcPkg.version }, null, 2)}\n`,
);

// ---- 完整性自检：逐文件 sha256 与源比对（package.json 是重写产物，改字段级校验） ----
const problems = [];
for (const rel of listFiles(TARGET)) {
  if (rel === 'package.json') continue;
  const srcFile = rel.startsWith('dist/') && distIsBundle
    ? path.join(srcRoot, 'dist.bundle', rel.slice('dist/'.length))
    : path.join(srcRoot, rel);
  if (!fs.existsSync(srcFile) || sha256(path.join(TARGET, rel)) !== sha256(srcFile)) problems.push(`${rel}: sha256 与源不一致`);
}
const vendoredPkg = JSON.parse(fs.readFileSync(path.join(TARGET, 'package.json'), 'utf8'));
if (vendoredPkg.name !== srcPkg.name || vendoredPkg.version !== srcPkg.version) problems.push('package.json: name/version 与源不符');
if (!fs.existsSync(path.join(TARGET, REQUIRED_ASSET))) problems.push(`必需资产缺失: ${REQUIRED_ASSET}（core workflows 资产集变化？）`);
if (fs.existsSync(srcAgentsDir) && !fs.existsSync(path.join(TARGET, REQUIRED_AGENT_ASSET))) {
  problems.push(`必需资产缺失: ${REQUIRED_AGENT_ASSET}（core agents 模板集变化？）`);
}
if (problems.length > 0) {
  for (const p of problems) console.error(`  - ${p}`);
  die(`完整性自检失败 ${problems.length} 处`);
}

// ---- capabilities 如实记录 + manifest 落盘（files 不含 manifest 自身） ----
const indexPath = ['dist/index.cjs', 'index.cjs'].map((rel) => path.join(TARGET, rel)).find((p) => fs.existsSync(p));
const selfContainedIndex = !!indexPath && !EXTERNAL_DEP_RE.test(fs.readFileSync(indexPath, 'utf8'));
const manifest = {
  source,
  fetchedAt: new Date().toISOString(),
  capabilities: {
    agentsAssets: fs.existsSync(path.join(TARGET, REQUIRED_AGENT_ASSET)),
    selfContainedIndex,
  },
  files: listFiles(TARGET).map((rel) => ({ path: rel, sha256: sha256(path.join(TARGET, rel)) })),
};
fs.writeFileSync(path.join(TARGET, 'VENDOR-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

if (cleanup) cleanup();
console.log(`vendor-subagent-core: ${source} → ${path.relative(ROOT, TARGET)}`);
console.log(`  files: ${manifest.files.length}，capabilities: ${JSON.stringify(manifest.capabilities)}`);
