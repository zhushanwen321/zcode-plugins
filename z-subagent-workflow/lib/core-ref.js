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
 * - `local:<core 仓路径>@<版本>`：vendored 副本来自本地 core 构建，指引指向
 *   --local 通道按 source 原路刷新（core 仓路径即 source 记录的路径）——
 *   --npm 是正规升级通道但不在此处指定具体版本（已发版 tarball 可能与本地
 *   构建产物不一致）；
 * - 其余（vendor 脚本生成的 `npm@<版本>` / manifest 缺失或损坏）：给
 *   --npm <版本> 形态（能读到 vendored package.json 就给具体版本，否则占位
 *   符），并追加一行 npm 包 / marketplace 形态用户的受众分流指引（设计
 *   §3.1）——插件包消费者没有 workspace 仓与 vendor 脚本，可操作的恢复
 *   动作是升级 z-subagent-workflow 插件包版本（vendored 副本随包分发）。
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
      return `恢复指引：workspace 根执行 ${cmd} --local ${corePath}（当前 vendored 副本即来自该本地 core checkout；${cmd} --npm <版本> 为正规升级通道，core 发版后可切换）`;
    }
  } catch { /* manifest 缺失/损坏：走 npm 版本形态指引 */ }
  let version = '<version>';
  try {
    version = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'package.json'), 'utf8')).version;
  } catch { /* 未 vendor / 清单损坏：占位符形态已可操作 */ }
  return `恢复指引：workspace 根执行 ${cmd} --npm ${version}。`
    + 'npm 包 / marketplace 形态用户（无 workspace vendor 脚本场景）：升级 z-subagent-workflow 插件包版本即可获得配套修复的 vendored 副本。';
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

/**
 * 主入口 require 失败的恢复指引（按 VENDOR-MANIFEST.json 的
 * capabilities.selfContainedIndex 分流）：
 * - true：副本应已自包含，加载失败多为副本不完整/损坏 → 指向重刷与 sha256 自检；
 * - false 或 manifest 缺失/损坏（保守回落）：自包含状态未确认为 true——当前
 *   vendored 副本已自包含（现行清单记录 selfContainedIndex=true），走到本分支
 *   多为清单缺失/损坏或历史非自包含产物 → 同向指引重刷 + sha256 自检。
 * vendorManifest() 在此刻意 try 包裹：本函数是报错文案组装，manifest 读不到时
 * 不能反客为主吞掉底层 require 错误主句。
 */
function requireLoadHint() {
  let selfContained = false;
  try {
    selfContained = vendorManifest().capabilities.selfContainedIndex === true;
  } catch { /* manifest 缺失/损坏：按非自包含旧文案（保守指引） */ }
  if (selfContained) {
    return '当前 vendored 副本应已自包含（VENDOR-MANIFEST.json capabilities.selfContainedIndex=true），'
      + '主入口加载失败多为副本不完整或损坏。'
      + '恢复路径：在 workspace 根重跑 node scripts/vendor-subagent-core.js --local <core-checkout> 刷新 vendored 副本，'
      + '或核对 VENDOR-MANIFEST.json 逐文件 sha256 完整性'
      + '（规范：zcode-plugin-workspace 仓 docs/standards.md「vendored 核心包消费」节）。';
  }
  return 'vendored 主入口自包含状态未确认为 true（VENDOR-MANIFEST.json 的 '
    + 'capabilities.selfContainedIndex 缺失、不可读或为 false——历史非自包含产物形态）。'
    + '当前 vendored 副本已自包含（现行清单记录 selfContainedIndex=true），走到本分支多为清单缺失或损坏。'
    + '恢复路径：在 workspace 根重跑 node scripts/vendor-subagent-core.js --local <core-path> 刷新 vendored 副本，'
    + '或核对 VENDOR-MANIFEST.json 逐文件 sha256 完整性'
    + '（规范：zcode-plugin-workspace 仓 docs/standards.md「vendored 核心包消费」节）。';
}

function requireCore() {
  for (const rel of INDEX_CANDIDATES) {
    const entry = path.join(VENDOR_DIR, rel);
    if (!fs.existsSync(entry)) continue;
    try {
      return require(entry);
    } catch (err) {
      throw new Error(
        `加载 vendored subagent-core 主入口失败（${entry}: ${err.code ? `${err.code} ` : ''}${err.message}）。`
        + requireLoadHint(),
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
