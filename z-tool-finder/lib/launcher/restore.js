/**
 * lib/launcher/restore.js — 独立还原入口（零依赖单文件）
 *
 * 插件可能已卸载，因此本文件禁止 require 任何 lib/ 模块（只用 node 内置）。
 * 用法：
 *   node restore.js --all          还原全部接管 server
 *   node restore.js <serverKey>    还原指定 server
 *
 * 行为：读 registry.json → scope==='user' 时把 original 写回 config 的
 * mcp.servers[serverName]；scope==='plugin' 时删除 mcp.servers 里的
 * `plugin:<plugin>:<server>` 覆盖条目（原注册在插件 .mcp.json，无需恢复）。
 * 随后从 registry 移除该记录，两个文件均原子写。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.ZTF_DATA_DIR || path.join(os.homedir(), '.zcode', 'z-tool-finder');
const REGISTRY_PATH = path.join(DATA_DIR, 'registry.json');
const CONFIG_PATH = path.join(os.homedir(), '.zcode', 'cli', 'config.json');

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 原子写：同目录 tmp + rename（内联实现，几行即可）
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function usage() {
  process.stderr.write('用法: node restore.js [--all | <serverKey>]\n');
  process.exit(2);
}

const target = process.argv[2];
if (!target) usage();

const reg = readJsonSafe(REGISTRY_PATH);
if (!reg || !reg.servers || !Object.keys(reg.servers).length) {
  process.stderr.write(`registry 无接管记录（${REGISTRY_PATH}），无需还原\n`);
  process.exit(0);
}

const keys = target === '--all' ? Object.keys(reg.servers) : [target];
const unknown = keys.filter((k) => !(k in reg.servers));
if (unknown.length) {
  process.stderr.write(`registry 中不存在: ${unknown.join(', ')}。现有记录: ${Object.keys(reg.servers).join(', ')}\n`);
  process.exit(1);
}

const cfg = readJsonSafe(CONFIG_PATH) || {};
if (!cfg.mcp || typeof cfg.mcp !== 'object') cfg.mcp = {};
if (!cfg.mcp.servers || typeof cfg.mcp.servers !== 'object') cfg.mcp.servers = {};

for (const key of keys) {
  const entry = reg.servers[key];
  if (entry.scope === 'plugin') {
    // 插件源：原注册在插件 .mcp.json，只需删除用户 config 的覆盖条目
    delete cfg.mcp.servers[key];
  } else {
    // user / workspace 源：key 即 server 名，original 原样写回
    cfg.mcp.servers[key] = entry.original;
  }
  delete reg.servers[key];
}

writeJsonAtomic(CONFIG_PATH, cfg);
writeJsonAtomic(REGISTRY_PATH, reg);
process.stderr.write(`已还原 ${keys.length} 个 server: ${keys.join(', ')}（config: ${CONFIG_PATH}）\n`);
