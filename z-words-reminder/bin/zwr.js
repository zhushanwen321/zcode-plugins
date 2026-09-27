#!/usr/bin/env node
/**
 * z-words-reminder CLI。
 * 子命令：hook user-prompt-submit | status | reset
 * hook 子命令由 hooks/hooks.json 调用；status/reset 供人工调试。
 */
'use strict';

const fs = require('fs');
const { DATA_DIR, STATE_DIR, tick, reset } = require('../lib/counter');
const { REMINDER_TEXT, EMPTY_OUTPUT, renderHookOutput } = require('../lib/reminder');

const USAGE = [
  '用法：zwr <command>',
  '',
  '  hook user-prompt-submit   UserPromptSubmit hook 入口（hooks.json 调用，勿手工使用）',
  '  status                    打印各会话计数',
  '  reset                     清空全部计数状态',
].join('\n');

// 其他插件 spawn 的无头 zcode 子会话没有真实用户输入，不注入也不计数
const NESTED_ENV_KEYS = ['ZWR_NESTED', 'ZSW_NESTED', 'ZSUB_NESTED', 'TF_NESTED'];

function isNested() {
  return NESTED_ENV_KEYS.some((k) => process.env[k]);
}

function cmdHook() {
  if (isNested()) {
    process.stdout.write(EMPTY_OUTPUT + '\n');
    return 0;
  }
  try {
    // CLAUDE_SESSION_ID 由 hook 运行器注入环境变量；缺失时降级为全局单键计数
    const sessionId = process.env.CLAUDE_SESSION_ID || 'default';
    const { inject } = tick(sessionId);
    process.stdout.write((inject ? renderHookOutput(REMINDER_TEXT) : EMPTY_OUTPUT) + '\n');
    return 0;
  } catch (err) {
    // 辅助功能降级：hook 永不阻断会话，错误落 stderr 供日志排查
    process.stderr.write('[zwr] hook failed: ' + (err && err.stack ? err.stack : String(err)) + '\n');
    process.stdout.write(EMPTY_OUTPUT + '\n');
    return 0;
  }
}

function cmdStatus() {
  let entries = [];
  try {
    entries = fs.readdirSync(STATE_DIR).filter((n) => n.endsWith('.json')).sort();
  } catch {
    // state 目录尚未创建 = 无会话记录
  }
  process.stdout.write('state dir: ' + STATE_DIR + '\n');
  for (const name of entries) {
    let count = '?';
    try {
      count = JSON.parse(fs.readFileSync(require('path').join(STATE_DIR, name), 'utf8')).count;
    } catch {
      // 损坏文件按未知计数展示
    }
    process.stdout.write('  ' + name.slice(0, -5) + ' count=' + count + '\n');
  }
  return 0;
}

function main(argv) {
  const [cmd, sub] = argv;
  if (cmd === 'hook' && sub === 'user-prompt-submit') return cmdHook();
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'reset') {
    reset();
    process.stdout.write('state cleared: ' + STATE_DIR + '\n');
    return 0;
  }
  process.stderr.write(USAGE + '\n');
  return 1;
}

process.exit(main(process.argv.slice(2)));
