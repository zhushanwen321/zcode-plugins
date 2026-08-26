#!/usr/bin/env node
'use strict';

// zsc —— z-smart-context 用量自查 CLI（M4）。数据流：readConfig → openDb(readonly)
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
const {
  isValidSessionId,
  loadState,
  intersectFired,
} = require('../lib/state');
const {
  applyOverride,
  releaseOverride,
  statusOverride,
} = require('../lib/config-override');
const { logError } = require('../lib/log');

// 数据目录与 hook 侧统一（config/state 同根）；ZSC_DATA_DIR 仅测试隔离用，生产不设置。
const DATA_DIR = process.env.ZSC_DATA_DIR || path.join(os.homedir(), '.zcode', 'z-smart-context');
// override 子命令写入的引擎配置文件路径：生产固定 ~/.zcode/cli/config.json；
// ZSC_CONFIG_PATH 仅测试隔离用（spawn 单测注入 tmp 文件），生产不设置。
const ENGINE_CONFIG_PATH = process.env.ZSC_CONFIG_PATH || null;

// note 固定文案（设计 §3.1 流二）；会话尚无已完成请求时前置一行成因说明
const NOTE_LATEST = '--latest 按 cwd 反查当前项目最近活跃会话；可用 --session <id> 显式指定';
const NOTE_NO_USAGE = '会话尚无已完成的模型请求（首轮进行中属正常态），contextTokens 暂缺';

const USAGE = [
  'zsc - z-smart-context 上下文用量自查 CLI',
  '',
  '用法:',
  '  node zsc.js usage [--session <sessionId>]',
  '      查询当前会话上下文用量与档位状态，stdout 输出单行 JSON：',
  '      {"sessionId":...,"contextTokens":...,"firedTiers":[...],"nextTier":...,"note":"..."}',
  '      默认 --latest：按 cwd 精确匹配反查当前项目最近活跃主会话；',
  '      --session <sessionId> 显式指定会话（id 见提醒文案或会话 UI）。',
  '  node zsc.js override apply --model <modelId> --threshold <tokens> --owner <id>',
  '      写入引擎 catalog override，把内建 autoCompact 阈值拉到 --threshold',
  '      （contextWindow = threshold + 34000）。用于无头 agent spawn 前预备；',
  '      同一 owner 重复执行幂等。窗口期结束务必 revert（见下）。',
  '  node zsc.js override revert --owner <id> [--force]',
  '      注销 owner 引用并还原引擎配置；最后一个 owner 注销时才真正还原。',
  '      --force 供手工救援：跳过 owners 匹配直接按锁内备份还原（无头进程崩溃后用）。',
  '      崩溃残留先看 override status 的 residue 字段再决定 revert --force 或人工处理。',
  '  node zsc.js override status',
  '      只读输出当前登记（owners/backup）与 config 现场核对结果，排查与人工审查入口。',
  '  node zsc.js --help | -h',
  '      显示本帮助。',
  '',
  'Exit code:',
  '  0  成功（含会话尚无已完成请求的正常态，contextTokens 为 null）',
  '  1  内部错误（db 打不开/查询失败/引擎配置坏 JSON 等；排查 tail ~/.zcode/z-smart-context/log/hook.log）',
  '  2  用法错误（未知子命令/参数非法/--latest 反查无命中/override 未登记该 owner）',
  '',
  '示例:',
  '  node zsc.js usage',
  '  node zsc.js usage --session sess_1a2b3c',
  '  node zsc.js override apply --model glm-5.2 --threshold 200000 --owner task-a1',
  '  node zsc.js override revert --owner task-a1',
  '  node zsc.js override status',
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
  writeErr(`[z-smart-context] ${message}\n用法示例: node zsc.js usage --session sess_xxx\n\n${USAGE}\n`);
  process.exit(2);
}

// 内部错误（exit 1）：错误详情由 logError 落 hook.log，stderr 给一行可操作排查指引
function failInternal(err, source) {
  const message = err && err.message ? err.message : String(err);
  logError(`[cli:${source || 'usage'}] ${message}`);
  writeErr(`[z-smart-context] 内部错误: ${message}\n排查: tail ${path.join(DATA_DIR, 'log', 'hook.log')}\n`);
  process.exit(1);
}

// override 操作错误的 stderr 出口：exit code 由调用方定（业务无命中=2，环境/数据坏=1）
function failOverride(result, exitCode, source) {
  if (exitCode === 1) {
    failInternal({ message: result.message }, source);
    return;
  }
  writeErr(`[z-smart-context] ${result.message}\n用法示例见: node zsc.js --help\n`);
  process.exit(2);
}

const VALUE_FLAGS = new Set(['--session', '--model', '--threshold', '--owner']);

function parseArgs(args) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      writeOut(`${USAGE}\n`);
      process.exit(0);
    }
    if (arg === '--force') {
      flags.force = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value === '') failUsage(`${arg} 缺少参数值`);
      flags[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) failUsage(`未知参数 "${arg}"`);
    positionals.push(arg);
  }
  return { positionals, flags };
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
        failUsage('未找到 cwd 匹配的活跃会话。用法：node zsc.js usage --session sess_xxx（sessionId 见提醒文案或会话 UI）');
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

// ---- override 子命令（无头场景 spawn 前预备，设计 §3.1 场景二）----
//
// 库函数永不 throw、只返回 {ok,...}；本层只做参数校验（exit 2）、结果分发与 exit code。
// exit 语义：缺参/未知 owner/无登记 → 2（用法或数据面无命中）；坏 JSON/IO/意外 → 1。

const OVERRIDE_ACTIONS = ['apply', 'revert', 'status'];
// 这些失败码属「业务数据面无命中」，与 --latest 无命中同类归 2；其余归 1
const OVERRIDE_USAGE_LEVEL_CODES = new Set(['invalid-args', 'unknown-owner', 'no-lock', 'model-mismatch']);

function overrideRequireFlag(action, flags, name, exampleLine) {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim() === '') {
    failUsage(`override ${action} 缺少 --${name}。${exampleLine}`);
  }
  return value;
}

function runOverride(action, extra, flags) {
  if (action === null) {
    failUsage('override 缺少子动作（apply|revert|status）。示例: node zsc.js override status');
  }
  if (!OVERRIDE_ACTIONS.includes(action)) {
    failUsage(`未知 override 子动作 "${action}"（可用: ${OVERRIDE_ACTIONS.join('|')}）`);
  }
  if (extra.length > 0) {
    failUsage(`多余参数 "${extra[0]}"`);
  }

  if (action === 'apply') {
    const applyExample = '示例: node zsc.js override apply --model glm-5.2 --threshold 200000 --owner task-a1';
    const modelId = overrideRequireFlag('apply', flags, 'model', applyExample);
    const owner = overrideRequireFlag('apply', flags, 'owner', applyExample);
    if (flags.threshold === undefined || flags.threshold.trim() === '') {
      failUsage(`override apply 缺少 --threshold。${applyExample}`);
    }
    const thresholdTokens = Number(flags.threshold);
    if (!Number.isFinite(thresholdTokens) || thresholdTokens <= 0) {
      failUsage(`--threshold 须为有限正数，收到 "${flags.threshold}"`);
    }
    const result = applyOverride({
      modelId,
      thresholdTokens,
      ownerId: owner,
      configPath: ENGINE_CONFIG_PATH || undefined,
      dataDir: DATA_DIR,
    });
    if (!result.ok) {
      failOverride(result, OVERRIDE_USAGE_LEVEL_CODES.has(result.code) ? 2 : 1, `override apply ${owner}`);
    }
    writeOut(`${JSON.stringify(result)}\n`);
    process.exit(0);
  }

  if (action === 'revert') {
    const owner = overrideRequireFlag(
      'revert',
      flags,
      'owner',
      '示例: node zsc.js override revert --owner task-a1 [--force]',
    );
    const result = releaseOverride(owner, {
      configPath: ENGINE_CONFIG_PATH || undefined,
      dataDir: DATA_DIR,
      force: flags.force === true,
    });
    if (!result.ok) {
      failOverride(result, OVERRIDE_USAGE_LEVEL_CODES.has(result.code) ? 2 : 1, `override revert ${owner}`);
    }
    writeOut(`${JSON.stringify(result)}\n`);
    process.exit(0);
  }

  // status：只读观测，任何可报告的现场状态都是成功观测（residue 与否见字段）
  const result = statusOverride({
    configPath: ENGINE_CONFIG_PATH || undefined,
    dataDir: DATA_DIR,
  });
  if (!result.ok) {
    failOverride(result, 1, 'override status');
  }
  writeOut(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0) failUsage('缺少子命令');
  const { positionals, flags } = parseArgs(args);
  const subcommand = positionals.shift() ?? null;
  if (subcommand === null) failUsage('缺少子命令');
  if (subcommand === 'usage') {
    if (positionals.length > 0) failUsage(`多余参数 "${positionals[0]}"`);
    runUsage(flags.session ?? null);
    return;
  }
  if (subcommand === 'override') {
    runOverride(positionals.shift() ?? null, positionals, flags);
    return;
  }
  failUsage(`未知子命令 "${subcommand}"`);
}

try {
  main(process.argv);
} catch (err) {
  // 禁止裸异常栈：未预期异常按内部错误处理（exit 1）
  failInternal(err);
}
