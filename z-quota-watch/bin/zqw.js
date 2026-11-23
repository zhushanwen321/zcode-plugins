#!/usr/bin/env node
/**
 * z-quota-watch CLI。
 * 子命令：hook pre-tool-use | status | suppress --session <id> [--for <+30m|+2h>] | reset
 * hook 子命令由 hooks/hooks.json 的 sh 门控在第 N 次工具调用时调用，勿手工使用。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  STATE_DIR,
  COUNT_DIR,
  DB_PATH,
  USER_CONFIG_PATH,
  DEFAULT_SUPPRESS_MS,
  GATE_THRESHOLD,
} = require('../lib/config');
const {
  sanitizeSessionId,
  querySessionModel,
  fallbackModelFromConfig,
  isGlmPlan,
  listProcessCommands,
  hasActiveWatch,
  filterWatchLines,
  isSuppressed,
  inFailureCooldown,
  sweepStale,
} = require('../lib/detect');
const { EMPTY_OUTPUT, watchCommand, renderInjection } = require('../lib/inject');

const USAGE = [
  '用法：zqw <command>',
  '',
  '  hook pre-tool-use                               PreToolUse 检测入口（门控：计数超过 ' + GATE_THRESHOLD + ' 触发并清零）',
  '  status                                          打印各会话计数、守望进程与最近结果',
  '  suppress --session <id> [--for <+30m|+2h>]      叫停守望注入（默认 24h 静默）',
  '  reset                                           清空全部状态',
].join('\n');

// 其他插件 spawn 的无头 zcode 子会话没有真实额度消耗场景，不检测不注入
const NESTED_ENV_KEYS = ['ZQW_NESTED', 'ZSW_NESTED', 'ZWR_NESTED', 'ZSUB_NESTED', 'TF_NESTED', 'DWF_NESTED'];

function isNested() {
  return NESTED_ENV_KEYS.some((k) => process.env[k]);
}

function sessionKey() {
  return sanitizeSessionId(process.env.CLAUDE_SESSION_ID || 'default');
}

function cmdHook() {
  if (isNested()) {
    process.stdout.write(EMPTY_OUTPUT + '\n');
    return 0;
  }
  const sessionId = process.env.CLAUDE_SESSION_ID || 'default';
  const key = sanitizeSessionId(sessionId);
  try {
    const now = Date.now();
    sweepStale(STATE_DIR, COUNT_DIR, now);
    if (isSuppressed(STATE_DIR, key, now)) return outputEmpty();
    if (inFailureCooldown(STATE_DIR, key, now)) return outputEmpty();
    const model = querySessionModel(DB_PATH, sessionId) ||
      fallbackModelFromConfig(USER_CONFIG_PATH);
    if (!isGlmPlan(model)) return outputEmpty();
    if (hasActiveWatch(listProcessCommands(), sessionId)) return outputEmpty();
    const { PLUGIN_ROOT } = require('../lib/config');
    process.stdout.write(renderInjection({
      modelId: model.modelId,
      providerId: model.providerId,
      sessionId,
      command: watchCommand(PLUGIN_ROOT, sessionId, model.providerId),
      pluginRoot: PLUGIN_ROOT,
    }) + '\n');
    return 0;
  } catch (err) {
    // 辅助功能降级：hook 永不阻断会话，错误落 stderr 供排查
    process.stderr.write('[zqw] hook failed: ' + (err && err.stack ? err.stack : String(err)) + '\n');
    return outputEmpty();
  }
}

function outputEmpty() {
  process.stdout.write(EMPTY_OUTPUT + '\n');
  return 0;
}

function cmdStatus() {
  process.stdout.write('state dir: ' + STATE_DIR + '\n');
  let counts = [];
  try {
    counts = fs.readdirSync(COUNT_DIR).filter((n) => n.endsWith('.count')).sort();
  } catch { /* 尚无计数 */ }
  if (counts.length === 0) process.stdout.write('  (no counts)\n');
  for (const name of counts) {
    let n = '?';
    try {
      n = fs.readFileSync(path.join(COUNT_DIR, name), 'utf8').trim();
    } catch { /* 竞态忽略 */ }
    process.stdout.write('  ' + name.slice(0, -6) + ' count=' + n + '\n');
  }
  try {
    const lines = listProcessCommands();
    const alive = filterWatchLines(lines);
    process.stdout.write('watch processes: ' + (alive.length ? '\n' + alive.map((l) => '  ' + l.trim()).join('\n') + '\n' : '(none)\n'));
  } catch (err) {
    process.stdout.write('watch processes: (ps failed: ' + err.message + ')\n');
  }
  return 0;
}

/** --for 形态：+Ns +Nm +Nh +Nd。返回 epoch ms。 */
function parseDuration(raw, fallbackMs) {
  const m = String(raw || '').match(/^\+(\d+)([smhd])$/);
  if (!m) return fallbackMs;
  const unitMs = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[m[2]];
  return Date.now() + Number(m[1]) * unitMs;
}

function cmdSuppress(argv) {
  const i = argv.indexOf('--session');
  if (i === -1 || !argv[i + 1]) {
    process.stderr.write('缺少 --session <id>\n');
    return 1;
  }
  const key = sanitizeSessionId(argv[i + 1]);
  const j = argv.indexOf('--for');
  const untilMs = parseDuration(j !== -1 ? argv[j + 1] : undefined, Date.now() + DEFAULT_SUPPRESS_MS);
  const dir = path.join(STATE_DIR, key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'suppress-until.json'), JSON.stringify({ untilMs }) + '\n');
  process.stdout.write('suppressed until ' + new Date(untilMs).toLocaleString('sv-SE') + ' (' + key + ')\n');
  return 0;
}

function main(argv) {
  const [cmd, sub] = argv;
  if (cmd === 'hook' && sub === 'pre-tool-use') return cmdHook();
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'suppress') return cmdSuppress(argv.slice(1));
  if (cmd === 'reset') {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    process.stdout.write('state cleared: ' + STATE_DIR + '\n');
    return 0;
  }
  process.stderr.write(USAGE + '\n');
  return 1;
}

process.exit(main(process.argv.slice(2)));
