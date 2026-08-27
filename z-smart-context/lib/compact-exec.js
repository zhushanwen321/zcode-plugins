'use strict';

// 非活跃会话的外部压缩执行器（探针 BP-9 ✅，链路细节见 .tmp/probe-report-bg-compact.md §3）。
//
// 边界（诚实声明，不是实现细节）：
// 1. 只对「无持有者」的会话安全——GUI tab 还开着 / 无头 runner 还在跑的会话，压缩虽会
//    落盘但持有引擎用内存态继续工作、完全无感知（P15 双持死结），等于白压还留分裂风险。
//    因此入口先做活跃防呆（db 侧近似：最近 turn 在跑或刚刚结束），拒绝执行。
// 2. 压缩真实发生（引擎日志 compact.started→completed），retention 逐字进压缩 prompt
//    的 instructions 段（P14）；成功判据 = session/event 的 response:"Compacted"——
//    turn.terminal 在压缩 turn 上实测会误报 failed，不可用作判据（BP-9 坑位 2）。
// 3. 协议链三步缺一不可：resume（反向请求须应答 runtimePreferences，否则内部 ZodError）
//    → updateRuntimeModelConfig（缺它 send 报 -32031 模型不可用）→ send "/compact …"。

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const { openDb, getSessionMeta, getLatestTurnStatus, getLatestModelOfSession } = require('./db');
const { readConfig } = require('./config');

// 与 z-subagent-workflow 的 ZCODE_CLI 默认值保持同源（本仓既有纪律：路径可被 env 覆盖）
function resolveZcodeCli(env) {
  return env.ZSC_ZCODE_CLI || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
}

// 反向请求应答表：requestRuntimePreferences 必须给完整 prefs（缺字段引擎内部 ZodError），
// 其余未知反向请求回空 result——不答 15s 断连（实测 -32022，zsw 同款纪律）。
const RUNTIME_PREFERENCES = Object.freeze({
  nativeSearchEnhancementsEnabled: true,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1',
});

function reverseAnswerOf(method) {
  return method === 'session/requestRuntimePreferences' ? RUNTIME_PREFERENCES : {};
}

// 会话最近 turn 结束多久才放行。真值（持有态）查不到，只能用时间窗近似：
// running 或 90s 内刚结束的会话大概率仍被持有，宁可拒绝也不冒双持事故。
const RECENT_TURN_GUARD_MS = 90_000;

// 活跃防呆（纯函数，供单测）：返回 null=放行，string=拒绝原因
function refuseReasonForTurn(turn, nowMs) {
  if (!turn) return null; // 无 turn 记录（空会话/异构库）——没有持有痕迹，放行由后续协议错误兜底
  if (turn.status === 'running') {
    return `该会话有 running 中的 turn（started_at=${turn.startedAt}），大概率正被 GUI tab 或无头 runner 持有；外部压缩会落盘但持有者无感知（P15）。请等 turn 结束或关闭持有方后重试。`;
  }
  const last = turn.completedAt || turn.startedAt;
  if (Number.isFinite(last) && nowMs - last < RECENT_TURN_GUARD_MS) {
    return `该会话最近 turn 结束于 ${Math.round((nowMs - last) / 1000)}s 内，可能仍被持有；为避免「落盘成功但持有者无感知」的双持分裂，已拒绝执行。稍等后重试，或确认 GUI tab 已关闭。`;
  }
  return null;
}

// updateRuntimeModelConfig 的 runtimeModel 构造（纯函数，供单测）。
// provider.kind 枚举仅 anthropic/openai/openai-compatible；models[] 元素是 strict schema
// （白名单键），只给必填的 modelId。kind 从引擎 config 的 provider 块读（无则 anthropic 兜底——
// 三枚举里 anthropic 是 zcode 内置 provider 的主流形态）。
// credential：provider 的 apiKey 是 discriminatedUnion("source")——inline{value}/env{name}/
// credential{key}/server-config{key}/session-secret{key}。必须显式传：updateRuntimeModelConfig
// 的 provider 定义会整体覆盖进程内 registry，不带凭据 = 压缩模型调用报 provider_not_configured
// （e2e 实测，2026-08-27）。
function buildRuntimeModel(model, kind, nowMs, credential, baseURL) {
  const revision = `zsc-compact-${nowMs}`;
  const provider = {
    providerId: model.providerId,
    kind: kind || 'anthropic',
    models: [{ modelId: model.modelId }],
  };
  if (credential) provider.apiKey = credential;
  // baseURL 必须显式传：runtime provider 定义整体覆盖进程内 registry，自定义端点丢失
  // 会让同一 key 打到默认端点 → 认证失败（e2e 实测，2026-08-27）
  if (baseURL) provider.baseURL = baseURL;
  return {
    revision,
    generatedAt: nowMs,
    model: { providerId: model.providerId, modelId: model.modelId },
    provider,
  };
}

// 引擎 config 的 provider 块读取（best-effort：文件缺失/结构漂移一律回退 null）
function readProviderBlock(homeDir, providerId) {
  try {
    const cfgPath = path.join(homeDir, '.zcode', 'cli', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const block = cfg && cfg.provider && cfg.provider[providerId];
    return block && typeof block === 'object' ? block : null;
  } catch {
    return null;
  }
}

// 凭据解析（纯函数）：config options.apiKey 存在 → inline 内联回传；否则 env 兜底
// （无头进程的 provider 常见 ANTHROPIC_API_KEY 形态）；两者皆无返回 null（保持无凭据，
// 错误信息可诊断）。明文 key 只经本机 stdio pipe 进程间传递，与 config 存储同级暴露面。
function resolveCredential(providerBlock) {
  if (!providerBlock) return null;
  const key = providerBlock.options && providerBlock.options.apiKey;
  if (typeof key === 'string' && key) return { source: 'inline', value: key };
  const envName = providerBlock.options && providerBlock.options.apiKeyEnv;
  if (typeof envName === 'string' && envName) return { source: 'env', name: envName };
  return null;
}

// 压缩输入指令（与工具层的 compactCommandOf 同构；此处独立实现避免 lib 间反向依赖）
function compactCommand(retention) {
  return retention ? `/compact 保留：${retention}` : '/compact';
}

// 帧事件的压缩终态归类（纯函数，供单测）：
// 'compacted' = session/event response:"Compacted"（权威成功判据）
// 'noop'      = response:"Context is up to date; no compression needed"——会话已处于
//               压缩态无需再压（e2e 实测形态，2026-08-27），按成功语义处理
// 'terminal'  = turn.terminal（压缩 turn 上可能误报 failed，仅作超时前的辅助信号）
// 'other'     = 不相关帧
function classifyPushEvent(method, params) {
  if (method === 'session/event') {
    const resp = params && params.payload && params.payload.response;
    if (resp === 'Compacted') return 'compacted';
    if (typeof resp === 'string' && resp.includes('no compression needed')) return 'noop';
  }
  if (method === 'v4/telemetry/event' && params && params.kind === 'turn.terminal') {
    return 'terminal';
  }
  return 'other';
}

// ---------- 主流程（spawn 真实 app-server，IO 密集，不可单测的部分全收敛于此） ----------

function protocolErrorOf(frame) {
  if (!frame || !frame.error) return null;
  const e = frame.error;
  const data = e.data && typeof e.data === 'object' ? e.data : {};
  return { code: e.code, message: e.message, dataCode: data.code };
}

// options 仅测试/调用方注入用：{ zcodeCli?, spawnFn?, homeDir?, dataDir?, now? }
async function compactSession(args, options = {}) {
  const sessionId = args.sessionId;
  const retention = typeof args.retention === 'string' ? args.retention.trim() : '';
  const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 180_000;
  if (!sessionId || !/^sess_[A-Za-z0-9._-]+$/.test(sessionId)) {
    return { ok: false, reason: 'invalid-session-id', text: `sessionId 非法：${JSON.stringify(sessionId)}（须形如 sess_xxx）` };
  }

  const dataDir = options.dataDir || (process.env.ZSC_DATA_DIR || path.join(require('node:os').homedir(), '.zcode', 'z-smart-context'));
  const homeDir = options.homeDir || require('node:os').homedir();
  const zcodeCli = options.zcodeCli || resolveZcodeCli(process.env);
  const spawnFn = options.spawnFn || spawn;
  const nowMs = options.now || Date.now();

  // ① 会话定位 + 活跃防呆 + 模型信息（一次只读连接全部取齐）
  let meta, turn, model;
  try {
    const db = openDb(readConfig(dataDir).dbPath);
    try {
      meta = getSessionMeta(db, sessionId);
      turn = getLatestTurnStatus(db, sessionId);
      model = getLatestModelOfSession(db, sessionId);
    } finally {
      try { db.close(); } catch { /* 尽力而为 */ }
    }
  } catch (e) {
    return { ok: false, reason: 'db-unavailable', text: `引擎库只读查询失败：${e.message}。排查：确认 dbPath 配置与 ~/.zcode/cli/db/db.sqlite 存在。` };
  }
  if (!meta) {
    return { ok: false, reason: 'session-not-found', text: `db 中不存在会话 ${sessionId}。排查：sessionId 是否抄对（zsc usage --latest 可反查）。` };
  }
  const refuse = refuseReasonForTurn(turn, nowMs);
  if (refuse) return { ok: false, reason: 'session-likely-held', text: `[zsc] 已拒绝外部压缩：${refuse}` };
  if (!model) {
    return { ok: false, reason: 'model-unknown', text: `会话 ${sessionId} 无已完成的模型调用记录，无法构造 runtimeModel。排查：会话是否真的跑过任务。` };
  }

  const cwd = meta.directory || process.cwd();
  const providerBlock = readProviderBlock(homeDir, model.providerId);
  const kind = (providerBlock && providerBlock.kind) || 'anthropic';
  const credential = resolveCredential(providerBlock);
  const baseURL = providerBlock && providerBlock.options && providerBlock.options.baseURL;
  const runtimeModel = buildRuntimeModel(model, kind, nowMs, credential, baseURL);
  // 单请求控制面超时（默认 30s）；测试注入小值避免真等待
  const reqTimeoutMs = Number.isFinite(options.reqTimeoutMs) && options.reqTimeoutMs > 0 ? options.reqTimeoutMs : 30_000;

  // ② 协议链：resume → updateRuntimeModelConfig → send → 等 Compacted
  const startedAt = Date.now();
  const child = spawnFn('node', [zcodeCli, 'app-server', '--cwd', cwd], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: homeDir },
  });
  let nextId = 1;
  const pending = new Map();
  let buf = '';
  let finished = null; // {kind:'compacted'} | {kind:'timeout'} | {kind:'error',...}
  let stderrTail = '';

  const settle = (v) => { if (!finished) { finished = v; pumpEnd(); } };

  function handleLine(line) {
    let f; try { f = JSON.parse(line); } catch { return; }
    if (f.id != null && f.method) { // 反向请求：必答
      child.stdin.write(JSON.stringify({ id: f.id, result: reverseAnswerOf(f.method) }) + '\n');
      return;
    }
    if (f.id != null && pending.has(f.id)) { pending.get(f.id)(f); pending.delete(f.id); return; }
    const cls = classifyPushEvent(f.method, f.params);
    if (cls === 'compacted') settle({ kind: 'compacted' });
    else if (cls === 'noop') settle({ kind: 'noop' });
  }

  child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-2000); });
  child.on('exit', () => settle(finished || { kind: 'child-exited', stderrTail }));

  const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs);

  let pumpEnded = false;
  function pumpEnd() {
    if (pumpEnded) return;
    pumpEnded = true;
    clearTimeout(timer);
    for (const fn of pending.values()) fn({ timeout: true });
    pending.clear();
    try { child.stdin.write(JSON.stringify({ method: 'session/close', params: { sessionId } }) + '\n'); } catch { /* 已退出 */ }
    setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 500);
  }

  const req = (method, params, ms = reqTimeoutMs) => new Promise((resolve) => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, ms);
    pending.set(id, (f) => { clearTimeout(t); resolve(f); });
    try { child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); } catch (e) { clearTimeout(t); resolve({ timeout: true }); }
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    // 等 app-server 起泵（首帧 protocol 推送无 id，不阻塞）；测试注入 readyHook 跳过等待
    if (typeof options.readyHook === 'function') await options.readyHook();
    else await sleep(1200);

    const r1 = await req('session/resume', { sessionId });
    const e1 = protocolErrorOf(r1);
    if (e1 || r1.timeout) {
      return outcome(false, 'resume-failed', `session/resume 失败：${e1 ? `${e1.code} ${e1.message}` : '超时'}。若为 -32004（会话活跃于别处）请先关闭持有方。` , r1);
    }
    // 订阅必须在 send 之前：session/event（Compacted 判据）只推给已订阅连接（BP-9 e2e 实测）
    await req('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
    const r2 = await req('session/updateRuntimeModelConfig', { sessionId, runtimeModel });
    const e2 = protocolErrorOf(r2);
    if (e2 || r2.timeout) {
      return outcome(false, 'runtime-model-failed', `updateRuntimeModelConfig 失败：${e2 ? `${e2.code} ${e2.message}` : '超时'}。恢复：重试；持续失败请检查引擎 config 的 provider 定义。`, r2);
    }
    const r3 = await req('session/send', { sessionId, content: compactCommand(retention) }, 30_000);
    const e3 = protocolErrorOf(r3);
    if (e3 || r3.timeout) {
      return outcome(false, 'send-failed', `压缩指令投递失败：${e3 ? `${e3.code} ${e3.message}` : '超时'}。-32031 表示 runtime model 未就位（本执行器已尝试自动修复，仍失败请报告）。`, r3);
    }

    // 等 Compacted（成功判据）/ noop（无需压缩）；turn.terminal 辅助信号不单独定案
    const deadline = Date.now() + timeoutMs;
    while (!finished && Date.now() < deadline) await sleep(500);
    if (finished && finished.kind === 'compacted') {
      return outcome(true, 'compacted', `压缩完成（retention 已进压缩 instructions）。会话 ${sessionId}`, null);
    }
    if (finished && finished.kind === 'noop') {
      return outcome(true, 'noop', `引擎判定当前上下文无需压缩（会话已处于压缩态）。会话 ${sessionId}`, null);
    }
    return outcome(false, 'no-compact-confirmation',
      `压缩指令已投递（accepted）但在 ${Math.round(timeoutMs / 1000)}s 内未收到 Compacted 确认。排查：引擎日志 grep '"event":"compact' ~/.zcode/cli/log/zcode-<date>.jsonl；确认成功可无视本超时。`, null);
  } finally {
    settle(finished || { kind: 'done' });
    pumpEnd();
  }

  function outcome(ok, reason, text, frame) {
    return {
      ok, reason, text,
      sessionId,
      model: model ? `${model.providerId}/${model.modelId}` : null,
      elapsedMs: Date.now() - startedAt,
      detail: frame ? JSON.stringify(frame).slice(0, 500) : undefined,
    };
  }
}

module.exports = {
  RUNTIME_PREFERENCES,
  RECENT_TURN_GUARD_MS,
  refuseReasonForTurn,
  buildRuntimeModel,
  resolveCredential,
  classifyPushEvent,
  compactCommand,
  compactSession,
};
