#!/usr/bin/env node
'use strict';

// zac —— z-auto-compact 用量自查 CLI（M4）。数据流：readConfig → openDb(readonly)
// →（--session 显式 | 默认 --latest：按 cwd 反查最近活跃主会话）→ getLatestCompletedUsage
// → firedTiers 与当前配置求交 → nextTier 计算 → stdout 单行 JSON（设计 §3.1 流二）。
//
// 输出用 writeSync：CLI 输出被管道捕获（$(...) 或重定向）时 stdout/stderr 是异步 pipe，
// write 后立刻 exit 可能截断输出；同步写保证字节先落。
//
// Exit code 语义：0 成功 / 1 内部错误 / 2 用法错误（详见 --help 与 README）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, getLatestCompletedUsage, findLatestSessionByDirectory } = require('../lib/db');
const { readConfig } = require('../lib/config');
const { isValidSessionId, loadState, intersectFired } = require('../lib/state');
const { logError } = require('../lib/log');

// 数据目录与 hook 侧统一（config/state 同根）；ZAC_DATA_DIR 仅测试隔离用，生产不设置。
const DATA_DIR = process.env.ZAC_DATA_DIR || path.join(os.homedir(), '.zcode', 'z-auto-compact');

// note 固定文案（设计 §3.1 流二）；会话尚无已完成请求时前置一行成因说明
const NOTE_LATEST = '--latest 按 cwd 反查当前项目最近活跃会话；可用 --session <id> 显式指定';
const NOTE_NO_USAGE = '会话尚无已完成的模型请求（首轮进行中属正常态），contextTokens 暂缺';

const USAGE = [
  'zac - z-auto-compact 上下文用量自查 CLI',
  '',
  '用法:',
  '  node zac.js usage [--session <sessionId>]',
  '      查询当前会话上下文用量与档位状态，stdout 输出单行 JSON：',
  '      {"sessionId":...,"contextTokens":...,"firedTiers":[...],"nextTier":...,"note":"..."}',
  '      默认 --latest：按 cwd 精确匹配反查当前项目最近活跃主会话；',
  '      --session <sessionId> 显式指定会话（id 见提醒文案或会话 UI）。',
  '  node zac.js --help | -h',
  '      显示本帮助。',
  '',
  'Exit code:',
  '  0  成功（含会话尚无已完成请求的正常态，contextTokens 为 null）',
  '  1  内部错误（db 打不开/查询失败等；排查 tail ~/.zcode/z-auto-compact/log/hook.log）',
  '  2  用法错误（未知子命令/参数非法/--latest 反查无命中）',
  '',
  '示例:',
  '  node zac.js usage',
  '  node zac.js usage --session sess_1a2b3c',
].join('\n');

function writeOut(text) {
  try {
    fs.writeSync(1, text);
  } catch {
    // stdout 不可用时仍需保证 exit code
  }
}

function writeErr(text) {
  try {
    fs.writeSync(2, text);
  } catch {
    // stderr 不可用时仍需保证 exit code
  }
}

// 用法错误（exit 2）：报错必附用法示例（§3.4），人读文案、不用 emoji
function failUsage(message) {
  writeErr(`[z-auto-compact] ${message}\n用法示例: node zac.js usage --session sess_xxx\n\n${USAGE}\n`);
  process.exit(2);
}

// 内部错误（exit 1）：错误详情由 logError 落 hook.log，stderr 给一行可操作排查指引
function failInternal(err) {
  const message = err && err.message ? err.message : String(err);
  logError(`[cli] usage 查询失败: ${message}`);
  writeErr(`[z-auto-compact] 内部错误: ${message}\n排查: tail ${path.join(DATA_DIR, 'log', 'hook.log')}\n`);
  process.exit(1);
}

function parseArgs(args) {
  let subcommand = null;
  let session = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      writeOut(`${USAGE}\n`);
      process.exit(0);
    }
    if (arg === '--session') {
      const value = args[i + 1];
      if (value === undefined || value === '') failUsage('--session 缺少参数值');
      session = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) failUsage(`未知参数 "${arg}"`);
    if (subcommand === null) {
      subcommand = arg;
      continue;
    }
    failUsage(`多余参数 "${arg}"`);
  }
  return { subcommand, session };
}

// nextTier：下一个会触发提醒的档，与 hook 侧 pickTier 同一越档判定（tokens >= tier）。
// 优先返回「已越且未 fired」的最小档（hook 下轮即会提醒它）；否则返回首个「尚未达到」的档
// （未来越到时触发）；contextTokens 为 null（尚无已完成请求）时即首个未 fired 档。
function nextTierOf(tiers, contextTokens, firedTiers) {
  const fired = new Set(firedTiers);
  let future = null;
  for (const tier of tiers) {
    if (fired.has(tier)) continue;
    if (contextTokens === null) return tier;
    if (tier <= contextTokens) return tier;
    if (future === null) future = tier;
  }
  return future;
}

function runUsage(session) {
  const config = readConfig(DATA_DIR);
  const stateDir = path.join(DATA_DIR, 'state');
  let sessionId = null;
  // D3 定案①：session_id 是外部输入，做查询键/文件名前先过白名单，防路径穿越
  if (session !== null) {
    if (!isValidSessionId(session)) {
      failUsage(`--session 参数非法 "${session}"（须形如 sess_xxx）`);
    }
    sessionId = session;
  }
  try {
    const db = openDb(config.dbPath);
    if (sessionId === null) {
      // 默认 --latest：cwd 精确匹配 + parent_id IS NULL 排除子会话（D5）
      const found = findLatestSessionByDirectory(db, process.cwd());
      if (!found) {
        failUsage('未找到 cwd 匹配的活跃会话。用法：node zac.js usage --session sess_xxx（sessionId 见提醒文案或会话 UI）');
      }
      sessionId = found.id;
    }
    const usage = getLatestCompletedUsage(db, sessionId);
    const state = loadState(stateDir, sessionId);
    const firedTiers = intersectFired(state.firedTiers, config.tiers);
    const contextTokens = usage ? usage.contextTokens : null;
    const note = usage ? NOTE_LATEST : `${NOTE_NO_USAGE}；${NOTE_LATEST}`;
    const payload = {
      sessionId,
      contextTokens,
      firedTiers,
      nextTier: nextTierOf(config.tiers, contextTokens, firedTiers),
      note,
    };
    writeOut(`${JSON.stringify(payload)}\n`);
    process.exit(0);
  } catch (err) {
    failInternal(err);
  }
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0) failUsage('缺少子命令');
  const { subcommand, session } = parseArgs(args);
  if (subcommand === null) failUsage('缺少子命令');
  if (subcommand !== 'usage') failUsage(`未知子命令 "${subcommand}"`);
  runUsage(session);
}

try {
  main(process.argv);
} catch (err) {
  // 禁止裸异常栈：未预期异常按内部错误处理（exit 1）
  failInternal(err);
}
