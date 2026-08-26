#!/usr/bin/env node
/**
 * bin/tf.js — z-tool-finder CLI / hook 入口。
 *
 * 子命令：hook session-start | status | takeover | restore | catalog refresh | doctor。
 * 硬约束（DESIGN.md D7 / §7）：
 * - hook 子命令 stdout 只输出一个 JSON 对象（协议契约），任何异常降级为 {}，绝不阻断会话
 * - 嵌套标记 TF_NESTED / ZSW_NESTED 下 hook 只输出空，不注入不接管
 * - 人读日志一律 stderr / 落盘 LOGS_DIR，stdout 留给协议输出
 * 退出码：成功 0；usage 错误 2。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { DATA_DIR, LOGS_DIR } = require('../lib/paths');
const { loadRegistry } = require('../lib/registry');
const { loadCatalog, prescan, saveCatalog } = require('../lib/catalog');
const {
  applyTakeover,
  restoreAll,
  restoreOne,
  syncLauncherNow,
  expandServerDef,
  ENGINE_INJECTED_PLUGINS,
} = require('../lib/takeover');
const { scanServers } = require('../lib/config-io');
const { renderManifest, renderHookOutput } = require('../lib/inject');

const USAGE = `用法: tf <command> [args]

命令:
  hook session-start        SessionStart hook 入口（hooks.json 调用，勿手工使用）
  status                    接管 / catalog / pinned / excluded 概览
  takeover [--all | <key>…] 接管 server（--all=自动范围；指定 key 可显式接管 workspace server）
  restore  [--all | <key>…] 还原接管
  catalog refresh           同步预扫描全部已接管 server，刷新 catalog
  doctor [serverKey]        逐项自检与修复建议`;

function logError(err) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(LOGS_DIR, 'hook.log'),
      `[${new Date().toISOString()}] ${err && err.stack ? err.stack : err}\n`
    );
  } catch {
    // 日志落盘失败也别抛——hook 契约优先
  }
}

/* ---------------- hook session-start ---------------- */

async function cmdHook() {
  // 嵌套防护：子会话（zsub spawn 等）不重复注入、不自动接管
  if (process.env.TF_NESTED || process.env.ZSW_NESTED) {
    process.stdout.write('{}\n');
    return 0;
  }
  try {
    syncLauncherNow(DATA_DIR);
    // 自动范围接管；锁被他人持有时降级跳过（下个会话再接管），不阻断注入
    const result = await applyTakeover({
      home: os.homedir(),
      dataDir: DATA_DIR,
      degradeOnLock: true,
    });
    if (result && result.needsRestart) {
      logError(new Error('info: 本次新接管 ' + result.newly.join(', ') + '，需重启 ZCode 生效'));
    }
    const cat = loadCatalog(DATA_DIR);
    const reg = loadRegistry(DATA_DIR);
    const text = renderManifest({ cat, reg });
    process.stdout.write(renderHookOutput(text) + '\n');
    return 0;
  } catch (err) {
    logError(err);
    process.stdout.write('{}\n'); // 空输出：会话照常，只是无清单
    return 0;
  }
}

/* ---------------- status ---------------- */

function cmdStatus() {
  const reg = loadRegistry(DATA_DIR);
  const cat = loadCatalog(DATA_DIR);
  const keys = Object.keys(reg.servers || {}).sort();
  process.stderr.write(`已接管 server: ${keys.length}\n`);
  for (const key of keys) {
    const rec = reg.servers[key];
    const tools = (cat.servers[key] && cat.servers[key].tools) || [];
    const flags = [
      rec.pinned ? 'pinned' : '',
      (reg.excluded || []).includes(key) ? 'excluded' : '',
    ].filter(Boolean).join(',');
    process.stderr.write(
      `  ${key} [scope=${rec.scope}${flags ? ' ' + flags : ''}] 工具数=${tools.length}` +
        ` takenOverAt=${rec.takenOverAt}\n`
    );
  }
  const excluded = reg.excluded || [];
  process.stderr.write(`excluded: ${excluded.length ? excluded.join(', ') : '(无)'}\n`);
  // 引擎注入型硬边界（代码级排除，不可配置）：列出避免「为何没接管」疑惑
  const injected = scanServers({ home: os.homedir(), workspaceRoot: process.cwd() })
    .filter((e) => e.pluginName && ENGINE_INJECTED_PLUGINS.has(e.pluginName))
    .map((e) => e.key);
  if (injected.length) {
    process.stderr.write(`引擎注入不可接管（硬边界）: ${injected.join(', ')}\n`);
  }
  process.stderr.write(`catalog server 数: ${Object.keys(cat.servers || {}).length}\n`);
  return 0;
}

/* ---------------- takeover / restore ---------------- */

async function cmdTakeover(args) {
  if (args.length === 0) {
    process.stderr.write('takeover 需要 --all 或至少一个 server key\n' + USAGE + '\n');
    return 2;
  }
  let names;
  if (args[0] === '--all') {
    names = undefined; // 自动范围
  } else {
    names = args; // 显式 key（支持 workspace server）
  }
  const result = await applyTakeover({ home: os.homedir(), dataDir: DATA_DIR, names });
  process.stderr.write(`接管: ${result.newly.length ? result.newly.join(', ') : '(无新增)'}\n`);
  process.stderr.write(`已在接管中: ${result.taken.filter((k) => !result.newly.includes(k)).join(',') || '(无)'}\n`);
  process.stderr.write(`跳过(excluded): ${result.skipped.join(',') || '(无)'}\n`);
  if (result.degraded) process.stderr.write(`降级: ${result.degraded}（锁被持有，稍后重试）\n`);
  if (result.needsRestart) process.stderr.write('需重启 ZCode 生效\n');
  return 0;
}

async function cmdRestore(args) {
  if (args.length === 0) {
    process.stderr.write('restore 需要 --all 或至少一个 server key\n' + USAGE + '\n');
    return 2;
  }
  const home = os.homedir();
  let result;
  if (args[0] === '--all') {
    result = restoreAll({ home, dataDir: DATA_DIR });
  } else {
    result = { restored: [], missing: [] };
    for (const key of args) {
      const one = restoreOne({ home, dataDir: DATA_DIR, key });
      result.restored.push(...one.restored);
      result.missing.push(...one.missing);
    }
  }
  process.stderr.write(`已还原: ${result.restored.join(',') || '(无)'}\n`);
  if (result.missing.length) {
    process.stderr.write(`registry 无记录(未还原): ${result.missing.join(',')}\n`);
  }
  process.stderr.write('需重启 ZCode 生效\n');
  return 0;
}

/* ---------------- catalog refresh ---------------- */

async function cmdCatalogRefresh() {
  const reg = loadRegistry(DATA_DIR);
  const entries = Object.entries(reg.servers || {}).map(([key, rec]) => ({
    key,
    // registry.original 是原始定义（模板未展开），prescan 直连 spawn 前必须按
    // 接管时刻的 pluginRoot 展开 ${ZCODE_PLUGIN_ROOT}/${CLAUDE_PLUGIN_ROOT}，
    // 否则插件源 server 必然 ENOENT（与 applyTakeover 后台预扫描口径一致）
    config: expandServerDef({ key, config: rec.original, pluginRoot: rec.pluginRoot }),
  }));
  if (entries.length === 0) {
    process.stderr.write('无已接管 server，catalog 无需刷新\n');
    return 0;
  }
  const cat = loadCatalog(DATA_DIR);
  const result = await prescan(cat, entries, { timeoutMs: 30000 });
  saveCatalog(DATA_DIR, cat);
  process.stderr.write(`ok: ${result.ok.join(',') || '(无)'}\n`);
  process.stderr.write(
    `failed: ${result.failed.map((f) => `${f.key} (${f.error})`).join('; ') || '(无)'}\n`
  );
  return result.failed.length ? 1 : 0;
}

/* ---------------- doctor ---------------- */

// [1][2] 数据目录脚本存在性（缺失项进 problems）
function doctorScripts(problems) {
  const launcher = path.join(DATA_DIR, 'launcher', 'proxy-launcher.js');
  const launcherOk = fs.existsSync(launcher);
  process.stderr.write(`[1] launcher 脚本 (${launcher}): ${launcherOk ? 'OK' : '缺失'}\n`);
  if (!launcherOk) {
    problems.push('launcher 缺失 → 运行任一会话触发 hook 自动刷新，或重启 ZCode；仍缺失则重装插件');
  }
  const restoreScript = path.join(DATA_DIR, 'launcher', 'restore.js');
  process.stderr.write(`[2] restore 兜底脚本: ${fs.existsSync(restoreScript) ? 'OK' : '缺失（可由 hook 自动补齐）'}\n`);
}

// [3] registry 可读性；不可读时进 problems 并返回 null
function doctorRegistry(problems) {
  try {
    const reg = loadRegistry(DATA_DIR);
    process.stderr.write(`[3] registry.json 可读: OK（已接管 ${Object.keys(reg.servers || {}).length}）\n`);
    return reg;
  } catch (err) {
    problems.push('registry 不可读: ' + err.message + ' → 备份后删除 registry.json 并重新 takeover');
    return null;
  }
}

// [4] catalog 可读性
function doctorCatalog(problems) {
  try {
    const cat = loadCatalog(DATA_DIR);
    process.stderr.write(`[4] catalog.json 可读: OK（server 数 ${Object.keys(cat.servers || {}).length}）\n`);
  } catch (err) {
    problems.push('catalog 不可读: ' + err.message + ' → 运行 tf catalog refresh 重建');
  }
}

// [5] 指定 server key 的 registry 记录检查
function doctorServerKey(key, reg, problems) {
  const rec = reg && reg.servers && reg.servers[key];
  if (!rec) {
    problems.push(`server "${key}" 不在 registry → 先运行 tf takeover ${key}`);
    return;
  }
  process.stderr.write(`[5] ${key}: scope=${rec.scope} original=${rec.original && rec.original.command}\n`);
  // original command 存在性只做静态检查（手动 spawn --help 探测可选，避免 doctor 拉起慢进程）
  const cmd = rec.original && rec.original.command;
  if (!cmd) problems.push(`${key}: original.command 缺失 → tf restore ${key} 后重新接管`);
}

function cmdDoctor(args) {
  const key = args[0];
  const problems = [];
  doctorScripts(problems);
  const reg = doctorRegistry(problems);
  doctorCatalog(problems);
  if (key) doctorServerKey(key, reg, problems);
  process.stderr.write(`日志目录: ${LOGS_DIR}（hook.log 可查注入异常）\n`);
  if (problems.length) {
    process.stderr.write('发现的问题与建议:\n  - ' + problems.join('\n  - ') + '\n');
    return 1;
  }
  process.stderr.write('全部检查通过\n');
  return 0;
}

/* ---------------- main ---------------- */

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'hook':
      if (rest[0] !== 'session-start') {
        process.stderr.write('hook 仅支持子命令 session-start\n' + USAGE + '\n');
        return 2;
      }
      return cmdHook(rest.slice(1));
    case 'status':
      return cmdStatus();
    case 'takeover':
      return cmdTakeover(rest);
    case 'restore':
      return cmdRestore(rest);
    case 'catalog':
      if (rest[0] !== 'refresh') {
        process.stderr.write('catalog 仅支持子命令 refresh\n' + USAGE + '\n');
        return 2;
      }
      return cmdCatalogRefresh(rest.slice(1));
    case 'doctor':
      return cmdDoctor(rest);
    default:
      process.stderr.write(USAGE + '\n');
      return cmd ? 2 : 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    logError(err);
    process.stderr.write('错误: ' + (err && err.message ? err.message : err) + '\n');
    process.exit(1);
  }
);
