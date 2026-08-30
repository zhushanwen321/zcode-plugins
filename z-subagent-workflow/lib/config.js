'use strict';
/**
 * zsw（z-subagent-workflow）全局配置：路径、env、常量。命名体系见 CONTEXT.md。
 *
 * 目录约定（真实 HOME 下）：
 *   ~/.zcode/zsw/                  插件数据根（ZSW_ROOT 可覆盖，测试用）
 *     ├── records.jsonl            append-only record 事件流（D9）
 *     ├── outputs/<subagentId>.md  任务结果全文（+ <id>.patch）
 *     ├── engines/zcode/<pool>/    core zcode 引擎数据（回接 2c：per-provider+model
 *     │                            隔离 HOME 池 + journal，布局归 core paths SSOT；
 *     │                            旧 home-<provider>-<model>/ 池目录随自有 spawn
 *     │                            驱动退役，存量目录无害残留可手工清理）
 *     └── workflow-state/          core FileRunStore（workflow 线状态面）
 *
 * env 语义（Z10：MCP server 由引擎 spawn，继承引擎进程的全部字符串 env，
 * 因此 process.env 读到的就是宿主真实值）：
 *   ZCODE_MESSAGE_ENABLED   引擎 mailbox 开关（"1"/"true" 开）——未启用时通知降级 polling
 *   ZCODE_MAILBOX_ROOT      mailbox 根覆盖（默认 ~/.zcode/mailbox）
 *   ZSW_NESTED=1           防递归标记（D10）：本进程若在嵌套环境直接拒绝服务
 *   ZSW_MAX_CONCURRENT     并发槽位上限覆盖（正整数；非法值忽略并警告，缺省 3）
 */

const os = require('node:os');
const path = require('node:path');

const V2_CONFIG_PATH = path.join(os.homedir(), '.zcode', 'v2', 'config.json');
const CLI_CONFIG_PATH = path.join(os.homedir(), '.zcode', 'cli', 'config.json');

/** 插件数据根（zsw = 插件缩写，与 env 前缀 ZSW_ 同源）。测试可用 ZSW_ROOT 指到临时目录。 */
function zswRoot() {
  return process.env.ZSW_ROOT || path.join(os.homedir(), '.zcode', 'zsw');
}

function outputsDir() { return path.join(zswRoot(), 'outputs'); }
function recordsPath() { return path.join(zswRoot(), 'records.jsonl'); }
/** 引擎 stderr 实时落盘目录（观测/取证面）。 */
function logsDir() { return path.join(zswRoot(), 'logs'); }

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
  maxConcurrent: resolveMaxConcurrent(), // D11；ZSW_MAX_CONCURRENT env 覆盖（MF5）
  // 杀链宽限（SIGTERM 后等这么久再 SIGKILL）归 core 引擎常量（ZCODE_KILL_GRACE_MS），
  // zsw 侧不再持有同名配置；会话空闲回收归引擎（D7 注记同旧）
};

const NESTED = process.env.ZSW_NESTED === '1';

module.exports = {
  V2_CONFIG_PATH,
  CLI_CONFIG_PATH,
  zswRoot,
  outputsDir,
  recordsPath,
  logsDir,
  mailboxRoot,
  mailboxEnabled,
  DEFAULTS,
  NESTED,
  path, os,
};
