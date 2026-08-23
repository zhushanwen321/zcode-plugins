'use strict';
/**
 * zsub 全局配置：路径、env、常量。
 *
 * 目录约定（真实 HOME 下）：
 *   ~/.zcode/zsub/                 插件数据根（ZSW_ROOT 可覆盖，测试用）
 *     ├── records.jsonl            append-only record 事件流（D9）
 *     ├── outputs/<subagentId>.md  任务结果全文（+ <id>.patch）
 *     └── home-<modelShort>/       per-model 隔离 HOME 池（spawn runner，D5）
 *
 * env 语义（Z10：MCP server 由引擎 spawn，继承引擎进程的全部字符串 env，
 * 因此 process.env 读到的就是宿主真实值）：
 *   ZCODE_MESSAGE_ENABLED   引擎 mailbox 开关（"1"/"true" 开）——未启用时通知降级 polling
 *   ZCODE_MAILBOX_ROOT      mailbox 根覆盖（默认 ~/.zcode/mailbox）
 *   ZSW_NESTED=1           防递归标记（D10）：本进程若在嵌套环境直接拒绝服务
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ZCODE_CLI = process.env.ZSW_ZCODE_CLI || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const V2_CONFIG_PATH = path.join(os.homedir(), '.zcode', 'v2', 'config.json');

/** 插件数据根。测试可用 ZSW_ROOT 指到临时目录。 */
function zsubRoot() {
  return process.env.ZSW_ROOT || path.join(os.homedir(), '.zcode', 'zsub');
}

function outputsDir() { return path.join(zsubRoot(), 'outputs'); }
function recordsPath() { return path.join(zsubRoot(), 'records.jsonl'); }
function homePoolDir(modelShort) { return path.join(zsubRoot(), `home-${modelShort}`); }
/** appserver runner 的单一隔离 HOME（D5：apc 无 per-model 池，模型走 create 参数）。 */
function appserverHomeDir() { return path.join(zsubRoot(), 'home-appserver'); }

/** mailbox 根：与引擎 drain 侧同一解析规则（Z8）。 */
function mailboxRoot() {
  return process.env.ZCODE_MAILBOX_ROOT || path.join(os.homedir(), '.zcode', 'mailbox');
}

/** 引擎 mailbox 是否启用（宿主 env 透传，Z10）。 */
function mailboxEnabled() {
  const v = process.env.ZCODE_MESSAGE_ENABLED;
  return v === '1' || v === 'true';
}

const DEFAULTS = {
  timeoutMs: 600_000,      // D14：对齐 driver.js
  killGraceMs: 5_000,      // SIGTERM 后等这么久再 SIGKILL
  maxConcurrent: 3,        // D11
  idleConversationTtlMs: 30 * 60_000, // apc conversation 会话空闲回收
};

const NESTED = process.env.ZSW_NESTED === '1';

module.exports = {
  ZCODE_CLI,
  V2_CONFIG_PATH,
  zsubRoot,
  outputsDir,
  recordsPath,
  homePoolDir,
  appserverHomeDir,
  mailboxRoot,
  mailboxEnabled,
  DEFAULTS,
  NESTED,
  fs, path, os,
};
