/**
 * lib/launcher-sync.js — 刷新数据目录下的 stable launcher 副本（DESIGN.md D4）
 *
 * 把 lib/launcher/{proxy-launcher.js, restore.js} 复制到 <dataDir>/launcher/，
 * 并同目录写 launcher.json（{ pluginRoot, syncedAt }）——不改副本文件内容，
 * launcher 启动时优先读同目录 launcher.json 的 pluginRoot 定位插件本体。
 * 插件升级/迁移后重跑一次即可，接管条目（指向稳定路径）无需变更。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LAUNCHER_FILES = ['proxy-launcher.js', 'restore.js'];
const META_FILENAME = 'launcher.json';

/**
 * @param {string} dataDir 数据目录（如 ~/.zcode/z-tool-finder）
 * @param {string} pluginRoot 当前插件根目录（须含 dist/mcp/proxy.js）
 * @returns {{ launcherDir: string, copied: string[], metaPath: string }}
 */
function syncLauncher(dataDir, pluginRoot) {
  const launcherDir = path.join(dataDir, 'launcher');
  fs.mkdirSync(launcherDir, { recursive: true });

  const srcDir = path.join(__dirname, 'launcher');
  const copied = [];
  for (const name of LAUNCHER_FILES) {
    fs.copyFileSync(path.join(srcDir, name), path.join(launcherDir, name));
    copied.push(name);
  }

  const metaPath = path.join(launcherDir, META_FILENAME);
  const tmp = metaPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ pluginRoot, syncedAt: new Date().toISOString() }, null, 2) + '\n');
  fs.renameSync(tmp, metaPath);

  return { launcherDir, copied, metaPath };
}

module.exports = { syncLauncher };
