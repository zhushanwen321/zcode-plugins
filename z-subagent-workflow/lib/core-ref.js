'use strict';
/**
 * vendored subagent-core 的单一解析点。
 *
 * 为什么收口在这层：插件三形态（inline 直载 / marketplace 副本 / npm 包内容）
 * 都没有 node_modules 解析面，core 只能以构建期 vendored 副本形态存在
 * （lib/vendor/subagent-core/，由 workspace 仓 scripts/vendor-subagent-core.js
 * 刷新、VENDOR-MANIFEST.json 溯源）；所有消费方经本模块取路径/入口，vendor
 * 布局调整只改这里，禁止各自拼路径或走 node_modules 解析。规范见
 * zcode-plugin-workspace 仓 docs/standards.md「vendored 核心包消费」节。
 */
const fs = require('node:fs');
const path = require('node:path');

const VENDOR_DIR = path.join(__dirname, 'vendor', 'subagent-core');

/**
 * 报错附带的刷新指引。按 VENDOR-MANIFEST.json 的 source 分流：
 * - `local:<core 仓路径>@<版本>`：vendored 副本来自本地 core 构建时，npm 上
 *   尚无等价产物（agents 等收口面全落 0.4.0，0.3.0 无 agents 资产——按 --npm
 *   刷会回退到扩面前的旧 npm tarball 丢面），指引必须指向 --local 通道
 *   （core 仓路径即 source 记录的路径）；
 * - 其余（npm@<版本> / manifest 缺失或损坏）：给 --npm <版本> 形态（能读到
 *   vendored package.json 就给具体版本，否则占位符）。
 */
function refreshHint() {
  const cmd = 'node scripts/vendor-subagent-core.js';
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'VENDOR-MANIFEST.json'), 'utf8'));
    const source = typeof manifest.source === 'string' ? manifest.source : '';
    if (source.startsWith('local:')) {
      // source 形态 = local:<srcRoot>@<version>（vendor 脚本生成）；剥尾部
      // @版本取 core 仓路径（lastIndexOf 防路径自身含 @ 时误切）
      const raw = source.slice('local:'.length);
      const at = raw.lastIndexOf('@');
      const corePath = at > 0 ? raw.slice(0, at) : raw;
      return `恢复指引：workspace 根执行 ${cmd} --local ${corePath}（待 core 0.4.0 发布后可用 ${cmd} --npm 0.4.0）`;
    }
  } catch { /* manifest 缺失/损坏：走 npm 版本形态指引 */ }
  let version = '<version>';
  try {
    version = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'package.json'), 'utf8')).version;
  } catch { /* 未 vendor / 清单损坏：占位符形态已可操作 */ }
  return `恢复指引：workspace 根执行 ${cmd} --npm ${version}`;
}

function vendorDir() {
  return VENDOR_DIR;
}

function workflowAssetPath(name) {
  const file = path.join(VENDOR_DIR, 'workflows', name);
  if (!fs.existsSync(file)) throw new Error(`core workflow 资产缺失: ${file}。${refreshHint()}`);
  return file;
}

// 主入口候选：vendored 布局以 dist/ 为规范位（源 dist.bundle/ 刷新时同样落位
// dist/，入口路径跨 core 版本稳定）；根位 index.cjs 为兼容候选
const INDEX_CANDIDATES = ['dist/index.cjs', 'index.cjs'];

function requireCore() {
  for (const rel of INDEX_CANDIDATES) {
    const entry = path.join(VENDOR_DIR, rel);
    if (!fs.existsSync(entry)) continue;
    try {
      return require(entry);
    } catch (err) {
      throw new Error(
        `加载 vendored subagent-core 主入口失败（${entry}: ${err.code ? `${err.code} ` : ''}${err.message}）。`
        + '当前 vendored 主入口非自包含（ajv/yaml/proper-lockfile 外部依赖未 vendor，'
        + 'VENDOR-MANIFEST.json 的 capabilities.selfContainedIndex 如实记录）。'
        + '恢复路径：等 @zhushanwen/subagent-core 0.3.0 自包含 bundle 发布后，'
        + '在本地 core checkout 构建并执行 node scripts/vendor-subagent-core.js --local <core-path> 刷新'
        + '（规范：zcode-plugin-workspace 仓 docs/standards.md「vendored 核心包消费」节）。',
      );
    }
  }
  throw new Error(`vendored subagent-core 主入口不存在（${VENDOR_DIR}）。${refreshHint()}`);
}

function vendorManifest() {
  const file = path.join(VENDOR_DIR, 'VENDOR-MANIFEST.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`读取 VENDOR-MANIFEST.json 失败（${file}: ${err.message}）。${refreshHint()}`);
  }
}

module.exports = { vendorDir, workflowAssetPath, requireCore, vendorManifest };
