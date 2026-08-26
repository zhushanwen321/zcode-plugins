#!/usr/bin/env node
'use strict';

// zac —— z-auto-compact 用量自查 CLI。Wave 1 骨架：仅参数解析与用法输出，
// usage 主查询逻辑在后续 wave（M4）填充。
// Exit code 约定（§3.4）：0 成功；2 用法错误/查询失败，报错必附用法示例。

// 输出用 writeSync：CLI 输出被管道捕获（如 $(...) 或重定向）时 stdout/stderr 是异步 pipe，
// write 后立刻 exit 可能截断输出；同步写保证字节先落。
const fs = require('node:fs');

const USAGE = [
  'zac - z-auto-compact 上下文用量自查 CLI',
  '',
  '用法:',
  '  node zac.js usage [--session <sessionId>]',
  '      查询用量与档位状态。默认按 cwd 反查当前项目最近活跃主会话；',
  '      --session <sessionId> 显式指定会话（id 见提醒文案或会话 UI）。',
  '  node zac.js --help',
  '      显示本帮助。',
  '',
  'Exit code:',
  '  0  成功',
  '  2  用法错误或查询失败',
].join('\n');

function failWithUsage(message) {
  try {
    fs.writeSync(
      2,
      `[z-auto-compact] ${message}\n用法示例: node zac.js usage --session sess_xxx\n\n${USAGE}\n`,
    );
  } catch {
    // stderr 不可用时仍需保证 exit code
  }
  process.exit(2);
}

function parseArgs(args) {
  let subcommand = null;
  let session = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (subcommand === null) {
      subcommand = arg;
      continue;
    }
    if (arg === '--session') {
      const value = args[i + 1];
      if (value === undefined || value === '') failWithUsage('--session 缺少参数值');
      session = value;
      i += 1;
      continue;
    }
    failWithUsage(`未知参数 "${arg}"`);
  }
  return { subcommand, session };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0) failWithUsage('缺少子命令');
  const { subcommand, session } = parseArgs(args);
  if (subcommand !== 'usage') failWithUsage(`未知子命令 "${subcommand}"`);

  // TODO(M4/Wave 后续)：usage 主查询填充点（设计 D5 反查语义 + §5.2 SQL-1/SQL-2）：
  //   1. session 为空 → findLatestSessionByDirectory(openDb(config.dbPath), process.cwd())
  //      按 cwd 精确匹配反查最近活跃主会话（parent_id IS NULL 必带）；
  //   2. 反查无命中或 db 打开失败 → exit 2，报错含上方用法示例文案；
  //   3. 命中后 getLatestCompletedUsage 输出流二 JSON：
  //      { sessionId, contextTokens, firedTiers, nextTier, note }。

  void session;
  try {
    fs.writeSync(
      2,
      [
        '[z-auto-compact] usage 尚未实现（当前为 Wave 1 骨架，主查询将在后续 wave 填充）。',
        '用法示例: node zac.js usage --session sess_xxx',
        '',
      ].join('\n'),
    );
  } catch {
    // stderr 不可用时仍需保证 exit code
  }
  process.exit(2);
}

try {
  main(process.argv);
} catch (err) {
  // 禁止裸异常栈：未预期异常压成单行 + 用法指引
  try {
    fs.writeSync(2, `[z-auto-compact] 执行失败: ${err && err.message ? err.message : err}\n`);
  } catch {
    // stderr 不可用
  }
  process.exit(2);
}
