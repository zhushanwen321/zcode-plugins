'use strict';
/**
 * zsw（z-subagent-workflow）全局配置：路径、env、常量。命名体系见 CONTEXT.md。
 *
 * 目录约定（真实 HOME 下）：
 *   ~/.zcode/zsw/                  插件数据根（ZSW_ROOT 可覆盖，测试用）
 *     ├── records.jsonl            append-only record 事件流（D9）
 *     ├── outputs/<subagentId>.md  任务结果全文（+ <id>.patch）
 *     └── home-<provider>-<model>/ per-model 隔离 HOME 池（spawn runner，D5）
 *
 * env 语义（Z10：MCP server 由引擎 spawn，继承引擎进程的全部字符串 env，
 * 因此 process.env 读到的就是宿主真实值）：
 *   ZCODE_MESSAGE_ENABLED   引擎 mailbox 开关（"1"/"true" 开）——未启用时通知降级 polling
 *   ZCODE_MAILBOX_ROOT      mailbox 根覆盖（默认 ~/.zcode/mailbox）
 *   ZSW_NESTED=1           防递归标记（D10）：本进程若在嵌套环境直接拒绝服务
 *   ZSW_MAX_CONCURRENT     并发槽位上限覆盖（正整数；非法值忽略并警告，缺省 3）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ZCODE_CLI = process.env.ZSW_ZCODE_CLI || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const V2_CONFIG_PATH = path.join(os.homedir(), '.zcode', 'v2', 'config.json');
const CLI_CONFIG_PATH = path.join(os.homedir(), '.zcode', 'cli', 'config.json');

/** 插件数据根（zsw = 插件缩写，与 env 前缀 ZSW_ 同源）。测试可用 ZSW_ROOT 指到临时目录。 */
function zswRoot() {
  return process.env.ZSW_ROOT || path.join(os.homedir(), '.zcode', 'zsw');
}

function outputsDir() { return path.join(zswRoot(), 'outputs'); }
function recordsPath() { return path.join(zswRoot(), 'records.jsonl'); }
/** provider id 含 ':'，目录名安全化（builtin:bigmodel-coding-plan → builtin_bigmodel-coding-plan）。 */
function providerDirName(p) { return String(p).replace(/[^A-Za-z0-9._-]/g, '_'); }

/** spawn per-model HOME 池。目录名含 provider 维度：跨 provider 同名模型不共池（凭据/配置互不污染）。 */
function homePoolDir(modelShort, provider) {
  const p = provider || 'builtin:bigmodel-coding-plan'; // 缺省 = 默认 provider（向后兼容旧调用）
  return path.join(zswRoot(), `home-${providerDirName(p)}-${modelShort}`);
}
/** appserver runner 的单一隔离 HOME（D5：apc 无 per-model 池，模型走 create 参数）。 */
function appserverHomeDir() { return path.join(zswRoot(), 'home-appserver'); }

/** mailbox 根：与引擎 drain 侧同一解析规则（Z8）。 */
function mailboxRoot() {
  return process.env.ZCODE_MAILBOX_ROOT || path.join(os.homedir(), '.zcode', 'mailbox');
}

/** 引擎 mailbox 是否启用（宿主 env 透传，Z10）。 */
function mailboxEnabled() {
  const v = process.env.ZCODE_MESSAGE_ENABLED;
  return v === '1' || v === 'true';
}

/**
 * ZSW_MAX_CONCURRENT 解析（MF5）：覆盖并发槽位上限（DEFAULTS.maxConcurrent
 * 的唯一消费点是 assemble 的 createSlots）。正整数生效；非法值忽略并
 * stderr 警告一次，回落缺省 3。模块加载期求值——require 缓存保证每进程
 * 只读一次 env、警告只出一次（daemon 是长驻进程，改 env 需重启才生效）。
 */
function resolveMaxConcurrent() {
  const raw = process.env.ZSW_MAX_CONCURRENT;
  if (raw === undefined || raw === '') return 3;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  process.stderr.write(
    `[zsub] ZSW_MAX_CONCURRENT=${JSON.stringify(raw)} 非法（需正整数），已忽略，回落缺省 3。`
    + '恢复指引：设为正整数，如 ZSW_MAX_CONCURRENT=5，然后重启进程生效。\n',
  );
  return 3;
}

const DEFAULTS = {
  timeoutMs: null,          // 不设超时限制（用户可按需填写）
  killGraceMs: 5_000,      // SIGTERM 后等这么久再 SIGKILL
  maxConcurrent: resolveMaxConcurrent(), // D11；ZSW_MAX_CONCURRENT env 覆盖（MF5）
  idleConversationTtlMs: 30 * 60_000, // apc conversation 会话空闲回收
};

const NESTED = process.env.ZSW_NESTED === '1';

module.exports = {
  ZCODE_CLI,
  V2_CONFIG_PATH,
  CLI_CONFIG_PATH,
  zswRoot,
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
