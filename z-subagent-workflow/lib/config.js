'use strict';
/**
 * zsw（z-subagent-workflow）全局配置：路径、env、常量。命名体系见 CONTEXT.md。
 *
 * 目录约定（真实 HOME 下）：
 *   ~/.zcode/zsw/                  插件数据根（ZSW_ROOT 可覆盖，测试用）
 *     ├── records.jsonl            append-only record 事件流（D9）
 *     ├── outputs/<subagentId>.md  任务结果全文（+ <id>.patch）
 *     ├── engines/zcode/shared/    core zcode 引擎 journal 分组目录（0.5.0 起共享
 *     │                            宿主 HOME：poolKey 恒 'shared'，无隔离池；旧
 *     │                            home-appserver 派生目录与 home-provider-model
 *     │                            池目录随 HOME 池化退役，存量无害可手工清理）
 *     └── workflow-state/          core FileRunStore（workflow 线状态面）
 *
 * env 语义（Z10：MCP server 由引擎 spawn，继承引擎进程的全部字符串 env，
 * 因此 process.env 读到的就是宿主真实值）：
 *   ZCODE_MESSAGE_ENABLED   引擎 mailbox 开关（"1"/"true" 开）——未启用时通知降级 polling
 *   ZCODE_MAILBOX_ROOT      mailbox 根覆盖（默认 ~/.zcode/mailbox）
 *   ZSW_NESTED=1           防递归标记（D10）：本进程若在嵌套环境直接拒绝服务
 *   XYZ_AGENT_SUBAGENT=1   core 引擎嵌套标记（同 D10 判定）：core 引擎 spawn 的
 *                          zcode 子进程统一注入此标记并剥离 ZSW_NESTED
 *                          （nesting-guard），嵌套会话内再起的 zsw 进程只看得到它
 *   ZSW_MAX_CONCURRENT     并发槽位上限覆盖（正整数；非法值忽略并警告，缺省 3）
 *   ZSW_RECORD_KEEP        records.jsonl 终态 run 保留上限（正整数；非法值忽略
 *                          并警告，缺省 1000）——仅 daemon 角色确定后 compact 消费
 */

const os = require('node:os');
const path = require('node:path');

const V2_CONFIG_PATH = path.join(os.homedir(), '.zcode', 'v2', 'config.json');
const CLI_CONFIG_PATH = path.join(os.homedir(), '.zcode', 'cli', 'config.json');

/** 插件数据根（zsw = 插件缩写，与 env 前缀 ZSW_ 同源）。测试可用 ZSW_ROOT 指到临时目录。 */
function zswRoot() {
  return process.env.ZSW_ROOT || path.join(os.homedir(), '.zcode', 'zsw');
}

/** 引擎侧 zcode CLI 数据根（~/.zcode/cli；homeDir 可注入，测试传 fixture）。 */
function engineCliRoot(homeDir) {
  return path.join(homeDir || os.homedir(), '.zcode', 'cli');
}

/**
 * 引擎侧缺省路径组装（单一权威源）：zcode 引擎库根 ~/.zcode/cli 及其 db/
 * artifacts/ log/ exec/ 派生 + GUI 索引库 ~/.zcode/v2/tasks-index.sqlite。
 * 消费方 = lib/doctor.js / lib/clean-fs.js / lib/clean-exec.js——原先三模块
 * 各持一份 os.homedir() 组装实现（同一约定三处漂移风险），收敛至此；
 * clean-identify 只收显式路径入参，不做缺省推导。
 * @param {string} [homeDir] 注入式测试用 HOME（缺省 os.homedir()）
 * @returns {{cliRoot, engineDbPath, indexDbPath, artifactsDir, logDir, execDir}}
 */
function resolveEnginePaths(homeDir) {
  const cliRoot = engineCliRoot(homeDir);
  return {
    cliRoot,
    engineDbPath: path.join(cliRoot, 'db', 'db.sqlite'),
    indexDbPath: path.join(homeDir || os.homedir(), '.zcode', 'v2', 'tasks-index.sqlite'),
    artifactsDir: path.join(cliRoot, 'artifacts'),
    logDir: path.join(cliRoot, 'log'),
    execDir: path.join(cliRoot, 'exec'),
  };
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
 * 嵌套环境判定（D10 防递归的单一谓词，F03 双标记）：zsw 自有通道沿用
 * ZSW_NESTED=1（hook/daemon spawn 显式注入）；core 引擎 spawn 的 zcode 子进程
 * 则统一注入 XYZ_AGENT_SUBAGENT=1 并剥离 ZSW_NESTED（vendored core
 * nesting-guard）——嵌套派发的 zcode 会话里再起的 zsw 进程只能看到后者，只查
 * ZSW_NESTED 会让第二重门禁失效。两标记任一命中即嵌套。
 * @param {object} [env] 注入式测试用 env（缺省 process.env）
 */
function isNestedEnv(env) {
  const e = env || process.env;
  return e.ZSW_NESTED === '1' || e.XYZ_AGENT_SUBAGENT === '1';
}

/**
 * zsw CLI 可执行绝对路径（agent 面文案的唯一权威源：注入段指引/报错恢复指引
 * 必须给「照抄即可执行」的完整形态——主 agent cwd 是项目目录，裸 `zsw` 短命令
 * 与相对 `bin/zsw.js` 都会 ENOENT）。优先插件根 env（marketplace 副本形态），
 * 回退模块相对（lib 的上级 = 插件根，inline/npm/marketplace 三形态一致）。
 */
function zswCliPath() {
  return path.join(process.env.ZCODE_PLUGIN_ROOT || path.join(__dirname, '..'), 'bin', 'zsw.js');
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

/** record 台账终态 run 保留上限缺省值（socket-record 收口 D8）。 */
const RECORD_KEEP_DEFAULT = 1000;

/**
 * ZSW_RECORD_KEEP 解析（socket-record 收口 D8；家族语义对齐 assemble.js 的
 * resolveStateKeep）：正整数生效；未设/空回落缺省 1000；非法值 stderr 警告
 * 一次并回落缺省。函数形态带 env 注入（与 resolveMaxConcurrent 的加载期
 * 求值不同——消费点是 daemon 侧 compact 挂点的调用期，函数形态便于单测注入）。
 * @param {object} [env] 缺省 process.env（测试注入）
 * @returns {number}
 */
function resolveRecordKeep(env = process.env) {
  const raw = env.ZSW_RECORD_KEEP;
  if (raw === undefined || raw === '') return RECORD_KEEP_DEFAULT;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  process.stderr.write(
    `[zsub] ZSW_RECORD_KEEP=${JSON.stringify(raw)} 非法（需正整数），已忽略，回落缺省 ${RECORD_KEEP_DEFAULT}。`
    + '恢复指引：设为正整数，如 ZSW_RECORD_KEEP=200，然后重启进程生效。\n',
  );
  return RECORD_KEEP_DEFAULT;
}

const DEFAULTS = {
  timeoutMs: null,          // 不设超时限制（用户可按需填写）
  maxConcurrent: resolveMaxConcurrent(), // D11；ZSW_MAX_CONCURRENT env 覆盖（MF5）
  // 杀链宽限（SIGTERM 后等这么久再 SIGKILL）归 core 引擎常量（ZCODE_KILL_GRACE_MS），
  // zsw 侧不再持有同名配置；会话空闲回收归引擎（D7 注记同旧）
};

const NESTED = isNestedEnv();

module.exports = {
  V2_CONFIG_PATH,
  CLI_CONFIG_PATH,
  zswRoot,
  engineCliRoot,
  resolveEnginePaths,
  outputsDir,
  recordsPath,
  logsDir,
  mailboxRoot,
  mailboxEnabled,
  isNestedEnv,
  zswCliPath,
  resolveRecordKeep,
  DEFAULTS,
  NESTED,
};
