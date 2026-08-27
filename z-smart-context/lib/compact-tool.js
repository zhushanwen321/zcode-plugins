'use strict';

// zsc_compact 决策核心（v2.1，探针 .tmp/probe-report-bg-compact.md 定案后的重定向）。
//
// 形态路由（诚实边界，CUA 方案已按用户决策删除——占用/扰动前台 GUI 且实测不稳）：
// - gui-active：GUI 活跃会话无纯后台压缩通道（BP-1..BP-5 穷尽：活动性=持有进程内存态，
//   外部零调用面）。返回「粘贴交接」——agent 组织 retention，用户 Cmd+V 执行。
// - headless-active：保持 override apply 预备指引（P17 通道，spawn 前生效）。
// - unknown：双路径说明，agent 按实际处境自选。
// 工具自身只做入参校验、sessionId 缺省探测、形态判定与文案生成——不假装成功。
// 真实执行器（非活跃会话的外部压缩）在 lib/compact-exec.js，经 `zsc compact --session`
// 由调用方使用；本工具的 headless 形态无持有权，不在此内联执行。

const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { openDb, getLatestCompletedUsage, findLatestSessionByDirectory } = require('./db');
const { readConfig } = require('./config');
const { isValidSessionId } = require('./state');

// 与 bin/zsc.js 保持同一数据目录口径（ZSC_DATA_DIR 仅测试隔离用）；lib 不能反向
// require bin，这两行重复是有意的
const DATA_DIR = process.env.ZSC_DATA_DIR || path.join(os.homedir(), '.zcode', 'z-smart-context');

// verifyHint 里的核实命令须指向插件根（bin/zsc.js）；lib 文件天然位于 <root>/lib/ 下
const PLUGIN_ROOT = path.join(__dirname, '..');

// retention 超过此长度时在交接文案中建议截断：压缩摘要生成本身有输出上限，
// 超长保留指令可能在摘要环节丢失细节（工具只建议、不代截——语义边界只有 agent 知道）
const RETENTION_SOFT_LIMIT = 2000;

// GUI 会话无纯后台通道的一句话依据（可审计，指向探针报告）
const GUI_NO_BG_NOTE =
  'GUI 活跃会话的纯后台压缩在当前 zcode 版本不可达（探针定案：会话 compact/updateRuntimeModelConfig 跨实例被活动性检查拒绝，CUA 会占用前台 GUI 已弃用）';

// ---------- 会话形态判定（P-G4） ----------

// P-G4 进程树上溯限深：GUI host→shell→node 的真实链远短于 8 层；
// 限深防御异常环图把工具拖死
const PROBE_MAX_DEPTH = 8;

// GUI host 特征（best-effort，误判代价低——还有 fallback 兜底）：
// ① 设计文档点名的 "zcode-host-local-" 等 host 进程命名；② macOS app bundle 主进程
// （Electron 形态如 .../ZCode.app/Contents/MacOS/ZCode）。特征都足够特异，不会误命中引擎 cli。
function looksLikeGuiHost(commandLine) {
  return /zcode-host-/i.test(commandLine) || /\/Contents\/MacOS\//i.test(commandLine);
}

// 默认探针：macOS ps 逐级取「父 pid + 命令行」。/proc 不通用，ps 是 darwin/linux 双端可用面。
function defaultProbe(pid) {
  const res = spawnSync('ps', ['-o', 'ppid=', '-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  if (res.error || res.status !== 0) return null;
  return String(res.stdout || '');
}

// 从 startPid 逐级上溯父进程链，任一级命中 GUI host 特征即 true；链断/超深/异常一律 false
// （判不了 ≠ 判成 GUI：形态不明必须落 unknown 兜底，由上层给双路径说明）
function parentChainHasGuiHost(startPid, probe, maxDepth = PROBE_MAX_DEPTH) {
  let pid = startPid;
  for (let depth = 0; depth < maxDepth && typeof pid === 'number' && pid > 1; depth++) {
    const out = probe(pid);
    if (!out) return false;
    const m = out.match(/^\s*(\d+)\s*(.*)$/); // ps 单 -p 查询只回一行：首列 ppid，余下命令行
    if (!m) return false;
    if (looksLikeGuiHost(m[2])) return true;
    pid = Number.parseInt(m[1], 10);
  }
  return false;
}

// 形态判定优先级：① 显式 env 标记（编排方 spawn 时注入 ZSC_HEADLESS=1，与 ZSW_NESTED 同模式）
// → ② 进程树 GUI host 特征 → ③ unknown 兜底。三途径全失败返回 unknown，
// handleCompactTool 层给双路径说明由 agent 自选（P-G4 兜底定义）。
function detectSessionShape(opts = {}) {
  const env = opts.env !== undefined ? opts.env : process.env;
  const pid = opts.pid !== undefined ? opts.pid : process.ppid;
  const probe = opts.probe || defaultProbe;
  if (env && env.ZSC_HEADLESS === '1') return 'headless-active';
  try {
    if (parentChainHasGuiHost(pid, probe)) return 'gui-active';
  } catch {
    // 探测环境的任何异常（ps 不存在/权限等）都当未知处理
  }
  return 'unknown';
}

// ---------- sessionId 缺省链与 db 只读查询 ----------

// 缺省链（D5）：显式入参 → env CLAUDE_SESSION_ID → db 按 cwd 反查最近活跃主会话。
// 显式给了脏值直接报错而不静默换探测——否则 agent 会以为探测结果就是它指定的会话。
function resolveSessionId(explicit, envObj, findByDir) {
  if (explicit != null) {
    return isValidSessionId(explicit)
      ? { value: explicit }
      : { error: `sessionId 非法 ${JSON.stringify(explicit)}（须形如 sess_<字母数字._->，如 sess_1a2b3c）` };
  }
  const fromEnv = envObj && typeof envObj.CLAUDE_SESSION_ID === 'string' ? envObj.CLAUDE_SESSION_ID : '';
  if (fromEnv && isValidSessionId(fromEnv)) return { value: fromEnv };
  let found = null;
  try {
    found = findByDir();
  } catch {
    // db 打不开是常态分支之一（无 db 的隔离环境），吞掉走 null
  }
  if (found && found.id) return { value: found.id };
  return { value: null };
}

// 只读打开插件配置指向的引擎库；每次调用现开现关（MCP server 长驻，泄漏 fd 不可接受）
function openReadonlyDb(dataDir) {
  return openDb(readConfig(dataDir).dbPath);
}

function safeClose(db) {
  try {
    db.close();
  } catch {
    // 关闭失败不影响主流程
  }
}

// 用量读数失败一律置 null——contextTokens 只是交接文案的辅助信息，绝不能因它拖垮输出
function fetchContextTokens(dataDir, sessionId) {
  try {
    const db = openReadonlyDb(dataDir);
    try {
      const usage = getLatestCompletedUsage(db, sessionId);
      return usage ? usage.contextTokens : null;
    } finally {
      safeClose(db);
    }
  } catch {
    return null;
  }
}

function findByDirectoryFromDb(dataDir, directory) {
  return () => {
    const db = openReadonlyDb(dataDir);
    try {
      return findLatestSessionByDirectory(db, directory);
    } finally {
      safeClose(db);
    }
  };
}

// ---------- 交接文案生成 ----------

function compactCommandOf(retention) {
  // retention 缺省时裸 /compact 也合法（无保留指令的纯压缩）
  return retention ? `/compact 保留：${retention}` : '/compact';
}

// GUI 粘贴交接（v2.1：CUA 删除后的唯一 gui 路径）。agent 的动作 = 把 command 原样贴给用户。
function buildGuiHandoff(retention) {
  const steps = [];
  if (retention && retention.length > RETENTION_SOFT_LIMIT) {
    steps.push(
      `前置建议：retention 当前 ${retention.length} 字符，超过软上限 ${RETENTION_SOFT_LIMIT}，建议先截断到核心信息——` +
        '理由：压缩摘要生成本身有输出上限，超长保留指令可能在摘要环节丢失细节。'
    );
  }
  steps.push(
    `step1 把下面整段压缩指令原样转告用户执行（复制到 ZCode 输入框回车；你已按任务边界组织好保留要点，这正是自决策压缩的核心增益）：\n${compactCommandOf(retention)}`
  );
  steps.push(
    'step2 用户执行后，下一条用户消息时 hook 会注入用量回落知情通知；基于压缩摘要继续任务即可（引用早前细节前先确认或重读文件）'
  );
  return steps;
}

function buildHeadlessGuidance() {
  return [
    '检出 ZSC_HEADLESS=1：当前是无头/编排子会话，引擎已按启动时的 config 运行；',
    'catalog override 驱动的内建 autoCompact 只在进程 spawn 读取 config 时生效，运行中改 config 不热重读。',
    '因此当前会话无法实时触发压缩，此处不做任何假装成功的操作。',
    '请主控（编排方）在下次 spawn 这类会话之前调用 zsc override apply 预备 config 覆盖（任务结束自动还原）。',
    '当前会话内的缓解措施：把剩余任务拆成更小的轮次提交，降低单 turn 的上下文增量。',
  ];
}

// 形态不明的双路径兜底（P-G4）：体验降级但功能不缺失，由 agent 按实际处境自选
function buildUnknownPlan(retention) {
  return [
    '无法判定当前会话形态（GUI 或无头），请按你的实际处境二选一执行：',
    '',
    '— 路径 A：你在 ZCode 桌面 GUI 会话中 →',
    ...buildGuiHandoff(retention).map((s) => `  ${s}`),
    '',
    '— 路径 B：你是被编排方 spawn 的无头/subagent 会话 →',
    ...buildHeadlessGuidance().map((s) => `  ${s}`),
  ];
}

// ---------- 结构化错误（附可操作的恢复动作，§3.4） ----------

const ARGS_EXAMPLE = '{"retention": "已完成 T1/T2 的状态与关键文件路径；T3 的任务描述与验收标准"}';

function invalidArgsError(detail) {
  return {
    ok: false,
    reason: 'invalid-arguments',
    text:
      `[zsc_compact] ${detail}\n` +
      `恢复动作：retention 必填（描述压缩后必须留存的上下文：已完成子任务的状态、关键文件路径、未完成任务清单），正确入参形如：\n` +
      `  ${ARGS_EXAMPLE}\n` +
      `重试：以正确格式重新调用 mcp__zsc__zsc_compact。`,
  };
}

function invalidSessionError(raw) {
  return {
    ok: false,
    reason: 'invalid-session-id',
    text:
      `[zsc_compact] sessionId 非法 ${JSON.stringify(raw)}，白名单要求形如 sess_<字母数字._->（防路径穿越）。\n` +
      `恢复动作：省略 sessionId 让工具自动探测（env CLAUDE_SESSION_ID → db 按 cwd 反查），` +
      `或传入合法 id 重试，例如 {"retention": "...", "sessionId": "sess_1a2b3c"}。`,
  };
}

// ---------- 主入口 ----------

// rawArgs 即 MCP tools/call 的 arguments；options 仅测试隔离用：
// { shape?, env?, dataDir?, cwd? } —— 不传全走生产真实来源
function handleCompactTool(rawArgs, options = {}) {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return invalidArgsError('入参必须是 JSON 对象');
  }
  const retention = typeof rawArgs.retention === 'string' ? rawArgs.retention.trim() : '';
  if (!retention) {
    return invalidArgsError('retention 必填且不能为空白（v2.1 起不再接受 nextInstruction——压缩后自动继续对话已按产品决策移除）');
  }

  const envObj = options.env !== undefined ? options.env : process.env;
  const dataDir = options.dataDir || DATA_DIR;
  const cwd = options.cwd || process.cwd();

  const resolved = resolveSessionId(
    typeof rawArgs.sessionId === 'string' ? rawArgs.sessionId : null,
    envObj,
    findByDirectoryFromDb(dataDir, cwd)
  );
  if (resolved.error) return invalidSessionError(rawArgs.sessionId);
  const sessionId = resolved.value;

  // any db 失败已在内部吞成 null，不影响后续
  const contextTokens = sessionId ? fetchContextTokens(dataDir, sessionId) : null;

  const shape = options.shape || detectSessionShape({ env: envObj });
  const base = { ok: true, mode: shape, sessionId, contextTokens };

  if (shape === 'headless-active') {
    // 无头 mid-run：诚实降级。刻意不含 plan 字段——空/伪 plan 都会被当成成功承诺
    return { ...base, guidance: buildHeadlessGuidance() };
  }

  // 核实命令对 GUI 与 unknown（agent 可能自选路径 A）都适用；无头场景无事后核实面
  const verifyHint =
    `事后核实压缩是否生效（完成则 contextTokens 显著回落）：node ${path.join(PLUGIN_ROOT, 'bin', 'zsc.js')} ` +
    `usage --session ${sessionId || '<sessionId>'}`;

  if (shape === 'gui-active') {
    return {
      ...base,
      plan: buildGuiHandoff(retention),
      note: GUI_NO_BG_NOTE,
      verifyHint,
    };
  }
  return { ...base, plan: buildUnknownPlan(retention), note: GUI_NO_BG_NOTE, verifyHint };
}

module.exports = {
  RETENTION_SOFT_LIMIT,
  detectSessionShape,
  handleCompactTool,
};

module.exports.__internal = { compactCommandOf }; // 供单测与 compact-exec 行为对齐断言
