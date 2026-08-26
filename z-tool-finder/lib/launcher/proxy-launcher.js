/**
 * lib/launcher/proxy-launcher.js — stable launcher（DESIGN.md D4）
 *
 * 接管条目的 command 指向数据目录下的本文件副本（~/.zcode/z-tool-finder/launcher/），
 * 内部解析当前插件本体后把控制权交给 dist/mcp/proxy.js。插件升级只刷新副本指向，
 * 不改接管条目。
 *
 * argv：<serverKey> -- <原 command> <原 args...>（与 proxy.js 相同约定，原样转发）
 *
 * 本文件会被复制到数据目录独立运行，因此禁止 require 任何 lib/ 模块——
 * 插件本体解析逻辑在此内联实现。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_NAME = 'z-tool-finder';

/**
 * 插件本体解析优先级（D4）：
 * 1. 同目录 launcher.json 的 pluginRoot（launcher-sync 刷新副本时写入，最权威）
 * 2. 环境变量 ZTF_PLUGIN_ROOT（hook 刷新 launcher 时写入的当前插件根）
 * 3. 扫 ~/.zcode/cli/config.json 的 inline plugins.dirs
 * 4. 扫 marketplace cache 下各 z-tool-finder 目录的最高版本子目录
 * @returns {string|null} 插件根目录（须含 dist/mcp/proxy.js），找不到返回 null
 */
function resolvePluginRoot() {
  const candidates = [];

  // 1. 同目录 launcher.json（launcher-sync 写入 { pluginRoot, syncedAt }）
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'launcher.json'), 'utf8'));
    if (meta && typeof meta.pluginRoot === 'string') candidates.push(meta.pluginRoot);
  } catch {
    // 无 launcher.json / 损坏 → 走后续候选
  }

  // 2. 环境变量（hook 刷新 launcher 时导出）
  if (process.env.ZTF_PLUGIN_ROOT) candidates.push(process.env.ZTF_PLUGIN_ROOT);

  const home = os.homedir();
  const userConfig = readJsonSafe(path.join(home, '.zcode', 'cli', 'config.json')) || {};

  // 3. inline plugins.dirs（以 plugin.json 的 name 为准，目录名可能不同）
  for (const dir of (userConfig.plugins && userConfig.plugins.dirs) || []) {
    const manifest = readJsonSafe(path.join(dir, '.zcode-plugin', 'plugin.json'));
    if (manifest && manifest.name === PLUGIN_NAME) candidates.push(dir);
  }

  // 4. marketplace cache：*/z-tool-finder/<最高版本>/（多版本共存取最高）
  const cacheBase = path.join(home, '.zcode', 'cli', 'plugins', 'cache');
  let cacheEntries = [];
  try {
    cacheEntries = fs.readdirSync(cacheBase);
  } catch {
    cacheEntries = [];
  }
  const versionRe = /^\d+\.\d+\.\d+/;
  for (const marketplace of cacheEntries) {
    const base = path.join(cacheBase, marketplace, PLUGIN_NAME);
    let versions = [];
    try {
      versions = fs.readdirSync(base).filter((v) => versionRe.test(v));
    } catch {
      continue;
    }
    if (!versions.length) continue;
    versions.sort(compareSemver);
    candidates.push(path.join(base, versions[versions.length - 1]));
  }

  for (const root of candidates) {
    // 候选必须真实含 proxy 本体，否则继续降级（防指向残缺目录）
    if (fs.existsSync(path.join(root, 'dist', 'mcp', 'proxy.js'))) return root;
  }
  return null;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function compareSemver(a, b) {
  const pa = a.split(/[.-]/).map((s) => parseInt(s, 10));
  const pb = b.split(/[.-]/).map((s) => parseInt(s, 10));
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

const root = resolvePluginRoot();
if (!root) {
  // 插件已卸载：不回退用 cache 旧版本（避免僵尸版本静默续跑），直接失败并给还原指引
  process.stderr.write(
    'z-tool-finder 插件本体不存在（可能已卸载）。' +
      '运行 node ~/.zcode/z-tool-finder/launcher/restore.js --all 还原全部接管。\n'
  );
  process.exit(1);
}

// 交给插件本体 wrapper（导出 main(argv) 形态，比改写 process.argv 稳）
require(path.join(root, 'dist', 'mcp', 'proxy.js')).main(process.argv.slice(2));
