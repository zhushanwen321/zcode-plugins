'use strict';

// zsc_compact 决策核心（v2 W1，设计 .tmp/agent-self-compact-design.md §3.1 场景一 / D5 / D8）。
// 工具自身只能从 db 拿用量数字，任务语义全部由 agent 入参提供（D5 定案）：
// 这里只做入参校验、sessionId 缺省探测、会话形态判定（P-G4 三途径 + 兜底）
// 与对应 plan / 降级文案生成——绝不真正触发压缩，也绝不返回空 plan 假装成功。

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

// CUA 注入消息的署名前缀约定（§3.1 用户可见性：代打消息以 user 角色进 transcript，
// 须可一眼溯源到 agent 代打而非用户亲手输入）
const INJECT_SIGNATURE = '（由 agent 经 zsc 自动压缩流程注入）';

// retention 超过此长度时在 plan 中建议截断：压缩摘要生成本身有输出上限，
// 超长保留指令可能在摘要环节丢失细节（工具只建议、不代截——语义边界只有 agent 知道）
const RETENTION_SOFT_LIMIT = 2000;

// P-G4 进程树上溯限深：GUI host→shell→node 的真实链远短于 8 层；
// 限深防御异常环图把工具拖死
const PROBE_MAX_DEPTH = 8;

// ---------- 会话形态判定（P-G4） ----------

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

// 用量读数失败一律置 null——contextTokens 只是 plan 的辅助信息，绝不能因它拖垮 plan 输出
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

// ---------- plan / 降级文案生成 ----------

function compactCommandOf(retention) {
  // retention 缺省时裸 /compact 也合法（无保留指令的纯压缩）
  return retention ? `/compact 保留：${retention}` : '/compact';
}

// GUI 实时路径的编排步骤（C13/C9/C14）：消息体第一行固定署名，第二行才是要执行的内容
function buildGuiSteps(retention, nextInstruction) {
  const steps = [];
  if (retention && retention.length > RETENTION_SOFT_LIMIT) {
    steps.push(
      `前置建议：retention 当前 ${retention.length} 字符，超过软上限 ${RETENTION_SOFT_LIMIT}，建议先截断到核心信息再注入——` +
        '理由：压缩摘要生成本身有输出上限，超长保留指令可能在摘要环节丢失细节。'
    );
  }
  steps.push(
    'step1 用 computer-use 的 type 工具定位 ZCode 聊天输入框 element（AX 文本框定位，勿用屏幕坐标），' +
      `注入以下整段消息后回车（消息首行为署名约定，勿删）：\n${INJECT_SIGNATURE}\n${compactCommandOf(retention)}`
  );
  if (nextInstruction) {
    steps.push(
      'step2 紧接 step1 再注入第二条消息后回车（依赖 GUI 忙时排队顺序执行，若顺序异常见 fallback）：' +
        `\n${INJECT_SIGNATURE}\n${nextInstruction}`
    );
  }
  steps.push(
    nextInstruction
      ? 'step3 结束当前回复（压缩 turn 只在 agent turn 结束后由引擎排队执行），收到继续消息后基于压缩摘要继续任务'
      : 'step3 结束当前回复等待压缩 turn 执行完毕；之后按既有任务清单继续'
  );
  return steps;
}

// 半自动降级（D8）：CUA 权限缺失或注入失败时不静默失败，回落 v1 手动 /compact 行为兜底
function buildGuiFallback(retention) {
  return (
    'fallback（computer-use 报 CUA_PERMISSION_REQUIRED 或注入失败时启用半自动降级）：' +
    '请用户手动在输入框执行压缩，以下指令可整段复制：\n' +
    compactCommandOf(retention) +
    '\nTCC 未授权时的一次性恢复动作：系统设置 → 隐私与安全性 → 辅助功能，为 ZCode 宿主授权后重试 computer-use。'
  );
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
function buildUnknownPlan(retention, nextInstruction) {
  return [
    '无法判定当前会话形态（GUI 或无头），请按你的实际处境二选一执行：',
    '',
    '— 路径 A：你在 ZCode 桌面 GUI 会话中（工具面有 computer-use 类能力）→',
    ...buildGuiSteps(retention, nextInstruction).map((s) => `  ${s}`),
    '',
    '— 路径 B：你是被编排方 spawn 的无头/subagent 会话 →',
    ...buildHeadlessGuidance().map((s) => `  ${s}`),
  ];
}

// ---------- 结构化错误（附可操作的恢复动作，§3.4） ----------

const ARGS_EXAMPLE =
  '{"retention": "已完成 T1/T2 的状态与关键文件路径；T3 的任务描述与验收标准", "nextInstruction": "继续执行 T3"}';

function invalidArgsError(detail) {
  return {
    ok: false,
    reason: 'invalid-arguments',
    text:
      `[zsc_compact] ${detail}\n` +
      `恢复动作：retention 与 nextInstruction 至少传其一（压缩后继续任务的编排依赖 nextInstruction），正确入参形如：\n` +
      `  ${ARGS_EXAMPLE}\n` +
      `也允许只传其一：{"nextInstruction": "压缩完成后继续任务 X"}。\n` +
      `重试：以 correct 格式重新调用 mcp__zsc__zsc_compact。`,
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
  const nextInstruction = typeof rawArgs.nextInstruction === 'string' ? rawArgs.nextInstruction.trim() : '';
  if (!retention && !nextInstruction) {
    return invalidArgsError('retention 与 nextInstruction 至少其一必填，当前两者均缺省');
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
      plan: buildGuiSteps(retention, nextInstruction),
      verifyHint,
      fallback: buildGuiFallback(retention),
    };
  }
  return { ...base, plan: buildUnknownPlan(retention, nextInstruction), verifyHint, fallback: buildGuiFallback(retention) };
}

module.exports = {
  INJECT_SIGNATURE,
  RETENTION_SOFT_LIMIT,
  detectSessionShape,
  handleCompactTool,
};
