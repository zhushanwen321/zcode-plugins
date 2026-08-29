'use strict';
/**
 * RunnerPort 的 app-server 实现（DESIGN-v3.md §3.2 D3「长线主路线」）。
 *
 * 形态：runner 持一个 `zcode app-server` 长驻子进程（隔离 HOME + ZSW_NESTED=1，
 * stdio NDJSON），subagent 会话在期内 create/subscribe/send/stop——收益是零冷启动、
 * per-session model/thoughtLevel/tools（经 runEnv.createParams 合入 create）与实时
 * 进度（capabilities.coldStartMs=0）。协议无官方文档，所有平台断言集中在本文件，
 * 版本漂移只改这里。
 *
 * ## 平台协议事实（前期实测全通，唯一权威；anchor 到行为，不 anchor 到推测）
 * - 启动 `node <ZCODE_CLI> app-server --cwd <dir>`，env HOME=<隔离> + ZSW_NESTED=1；
 *   stdio NDJSON（每行一个 JSON）。进程启动即要求 $HOME/.zcode/cli/config.json 存在
 *   模型配置（缺失时 create -32603 "Model config is missing"）——由 model-router
 *   prepareRunEnv('appserver') bootstrap。
 * - 四种帧：client 请求 {id,method,params} / 响应 {id,result|error}（error 形如
 *   {code,message,data}）/ 服务端推送 {method,params}（无 id）/ 服务端反向请求
 *   {id,method,params}——必须回 {id,result}，不答 15s 超时（实测错误码 -32022）。
 * - 协议自报 protocol:{name:"ZCode Protocol",version:1}（首帧/推送，忽略即可）。
 * - session/create {workspace:{workspacePath,workspaceKey}, mode:"yolo", model?} →
 *   必答反向请求 session/requestRuntimePreferences（实测 schema 见
 *   RUNTIME_PREFERENCES；workspaceKey 用 workspacePath 的稳定 hash 即可）。
 *   **model 是 strict 对象 {providerId, modelId, variant?}**（e2e 实测 2026-08-23，
 *   zcode.cjs schema C1t/hc；字符串被 -32602 ZodError 拒收）。
 * - session/subscribe {sessionId, deliveryKind:"desktop-continuous"}（deliveryKind
 *   必填）；session/send {sessionId, content}（字段是 content 不是 text）→
 *   {accepted:true}；session/stop / session/close {sessionId}；
 *   session/list {workspace, limit}（跨进程可查）。
 * - 会话状态枚举（zcode.cjs VDe）：idle|running|waiting|paused|completed|error。
 * - **一轮生命周期（e2e 实测 2026-08-23，真实帧抓包）**：
 *   send 后收 state.updated {patch:{status:"running"}, reason:"prompt_started"}——
 *   status 在 **patch.status**；轮结束**不发** status:idle 的 state.updated（终态
 *   帧的 patch 只有 mode/model 等键），一轮结束的权威信号是 v4/telemetry/event
 *   {kind:"turn.terminal", status:"success"|...}。
 * - 文本流：stream.chunk 只有 chunkLength 无文本；实时增量在 session/event 的
 *   payload.delta；最终全文在 session/event 的 payload.response（turn 收尾帧，
 *   携带 usage；同内容的 content+stopReason:"stop" 形态也出现）。
 * - 错误码：-32602 ZodError（error.data 带完整 zod 诊断）、-32004 Session not
 *   active、-32022 反向请求超时、-32603 内部错误（含 Model config missing）。
 *   D3 漂移分类：-32601（方法不存在）/ -32602（参数校验失败）经
 *   classifyApcError 归 protocol-drift（错误文案含升级冒烟命令与
 *   ZSW_RUNNER=spawn 回退指引），start/resume 错误出口双落点
 *   （RunResult.errorKind + stderr 出声）；其余错误码不归该类，互斥不遮蔽。
 *
 * ## -32004 四步恢复序（D2，F0 真机结论固化，探针归档 test/e2e-tp1-recovery.test.js）
 * send/message 遇 -32004（会话被引擎驱逐/进程重启/close 后不在内存）自动执行：
 *   ① session/resume {sessionId, runtimeModel}——**每次无条件携带 runtimeModel**
 *     （F0 实证：驱逐与崩溃同设 restoreWarning，plain resume 后 send 必挂 -32031；
 *     resume 带 runtimeModel 则 warning 根本不设置。「接种效应」（runtimeModel 一旦
 *     在引擎进程内应用，同进程后续 plain resume 不再设 warning）不可依赖——runner
 *     无法得知引擎是否被外部重启，且构造成本为零）。runtimeModel 构造见
 *     _buildRuntimeModel()（model 目标 = 会话登记的 create model → v2 config
 *     model.main 兜底；provider 传输配置唯一权威源 = v2 config，与 model-router
 *     bootstrap 同源；apiKey 仅回传引擎，不落日志）。
 *   ② 重挂 session/subscribe {sessionId, deliveryKind:"desktop-continuous"}——
 *     订阅是 per-session 的，resume 不自动恢复订阅（F0/源码双证）；缺此步则
 *     send accepted 但 turn 终态事件不达，恢复变假死。
 *   ③ 重试一次原 send。-32010（busy）不重试——恢复序只由 -32004 触发，
 *     重试中遇 -32010 说明会话已恢复且有轮在跑，按 busy 如实上报不落分支 B。
 *   ④ 终态事件等待窗口 = 该轮任务 timeoutMs（_createTurn 超时判据）；窗口耗尽
 *     判「恢复后事件流不可达」→ session/stop 清场（stop 是唯一绕过请求串行
 *     队列的方法，防引擎侧孤儿轮）→ 分支 B 收尾。
 * resume/重试仍失败 → **分支 B**（branchBMessage：「会话弃用 + zsw start 重建指引
 * + record 历史保留 + ZSW_RUNNER=spawn 回退」，禁止裸错误码）。恢复序中遇
 * -32601/-32602 不吞不重试，原样上抛交 classifyApcError 出 protocol-drift
 * （D3 互斥：漂移是「版本问题」不是「会话问题」）。
 * **runner 级恢复互斥**：同一时刻至多一路恢复序在执行（单例 promise 链）——
 * 引擎崩溃时 N 个会话同被击落，N 路恢复并发会形成恢复风暴；F0 C 线实证串行化
 * 不解 -32031 本身（每路带 runtimeModel 才是解），互斥只防风暴。
 *
 * ## 引擎 stderr 实时落盘（D3 观测/取证面）
 * 引擎子进程 stderr 除内存滚动缓冲（_stderrTail，进程退出时尾部 400 字符进
 * exitReason——保留）外，**实时 append** 到 `~/.zcode/zsw/logs/<date>-appserver.log`
 * （logging-conventions 未约定专项日志文件命名，取单文件按日 append：同日多连接
 * （引擎崩溃重建）集中同一文件，跨日另起新文件；落盘失败静默，不影响主流程）。
 * 这是 A-5 thinking 档位观测面与漂移 issues 取证面。测试用 runner 构造 opts
 * stderrLogPath 注入隔离路径（默认路径经 ZSW_ROOT env 已随测试根隔离）。
 *
 * ## 协议假设收口状态（真机探针随 apc-smoke 冒烟沉淀；失败时的单点修改位置不变）
 * A2 推送帧的会话归属（单会话面已收口，2026-08-29 apc-smoke 真机）：会话级推送
 *    帧全部携带 params.sessionId 且归因正确；但存在引擎级非会话帧（实测
 *    process/mcpTelemetry 的 MCP 进程遥测帧）不带 sessionId——_lookupSession 的
 *    「无 sid 且唯一会话时兜底归因」对这类帧单会话下无害（无文本/usage 数据面），
 *    多会话下按宁丢勿错丢弃，策略成立。多会话并发归因留 A-8（4 并发）验收。
 *    → 只改 extractPushSessionId() 与 _lookupSession()/_lookupTurn()
 * A4 session/read 返回形态（已收口，2026-08-29 apc-smoke 真机全量抓包）：
 *    实测形态 {messages:[{info:{role,...}, parts:[{type:'text',text},
 *    {type:'step-finish',tokens}, ...]}], projection, settings, session, ...}：
 *    - role 在 m.info.role（非 m.role），assistant 正文 = 最后一条 assistant 消息
 *      parts 中 type:'text' 部件的 text 拼接（旧 m.role/m.content 形态保留兼容）；
 *    - tokens 在最后 assistant 消息 parts 的 step-finish 部件 tokens 字段
 *      （{input,output,reasoning,cache, total}），非顶层 usage；
 *    - settings.thoughtLevel:{available:[low|high|max], current, defaultLevel}
 *      同帧可见（F4 thinking 校验可直接消费 read 的这一面）。
 *    extractAssistantText()/extractReadUsage() 已按实测形态实现并保留旧形态兼容。
 *    → 只改 extractAssistantText()/extractReadUsage() 与 _fetchFinalResponse() 的降级链
 *
 * ## D5 thinking 接线（F4）
 * `--thinking <level>` → runEnv.createParams.thoughtLevel（model-router 组装）→
 * create 前经 _resolveThinking 连接级校验（缓存源：session/read 应答顺带沉淀 >
 * workspace/readState；后者 params 形态未真机实测，任何失败缓存「不可用」并
 * 透传档位给引擎，由引擎 P2 容错兜底——任务不失败）。非法档位 stderr warn +
 * 跳过（create 不带 thoughtLevel）；合法档位生效后 result.thinking 标注实际档位，
 * 非法跳过标 null（record 物理落点由 manager._completeRun 透传）。**全程不调用
 * session/setThoughtLevel**（写 user 级全局设置，探针 P1 实证，D5 禁用面）。
 * resume 轮无 create 面——thinking 是会话级设置，随会话驻留续聊自然延续。
 *
 * ## D6 工具限制双来源（F4）
 * create.toolDenylist = CLI --deny-tools（runEnv.createParams.toolDenylist）∪
 * frontmatter taskCtx.disallowedTools（并集去重，_applyCreateToolLimits）；
 * create.toolAllowlist = CLI --allow-tools 原样。裸工具名形态（D6 源码证据）。
 * frontmatter `tools` 白名单维持 prompt-builder 软约束不升级（D6 显式决策）；
 * spawn 通道行为不变（denylist 走 --disallowed-tools 既有路径，CLI 来源不消费）。
 * A5 send 对 running 会话的行为（排队 or 拒绝）未实测：设计 optimistic（send 后
 *    等一轮完成）；但本 runner 内同会话已有进行中的一轮时保守报 busy。
 *    → 只改 resume() 的 busy 分支
 * A6 session/list 返回形态：按 result.sessions[].sessionId|id 提取；解析不出
 *    数组或请求失败时保守按「存在」处理。
 *    → 只改 alive() 的提取逻辑
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');
const { PROVIDER_ID } = require('./model-router'); // 默认 provider（runtimeModel 幽灵恢复兜底；driver→config 单向依赖，无环）

const DEFAULT_PROVIDER_ID = PROVIDER_ID;

const REQUEST_TIMEOUT_MS = 15_000;   // 控制面请求默认超时（create/subscribe/send 等）
const PROBE_BUDGET_MS = 10_000;      // probe 全程预算（启动+往返+关闭）
const PROBE_SHUTDOWN_GRACE_MS = 1_500; // probe 收尾不等满 5s 宽限，快速 SIGKILL 兜底
const READ_TIMEOUT_MS = 5_000;       // 终态后 read/messages 兜底拉取的超时
const STOP_TIMEOUT_MS = 2_000;       // session/stop 控制超时（超了就该杀进程兜底）

/** session/requestRuntimePreferences 的应答：逐字段对齐实测 schema，改动前先有新实测依据。 */
const RUNTIME_PREFERENCES = Object.freeze({
  nativeSearchEnhancementsEnabled: true,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1',
});

/** 连接级反向请求 handler 表：本表之外的反向请求（permission/elicitation 等，
 * yolo 子会话预期不出现）一律回空 result 并 stderr 记录——不答会被 15s 超时
 * 断连（实测 -32022），拖死共享连接上的所有会话。 */
const REVERSE_HANDLERS = {
  'session/requestRuntimePreferences': () => RUNTIME_PREFERENCES,
};

const READ_FAILED_NOTE =
  '全文获取失败（session/read 与 session/messages 均不可用，且 stream.chunk 未携带文本）；session 可 resume 续聊后重试读取。';

function stderrLog(msg) {
  try { process.stderr.write(`[zsub:appserver] ${msg}\n`); } catch { /* 尽力而为 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** workspacePath → 稳定短 hash（实测只要求 workspaceKey 是稳定标识，算法不限）。 */
function stableWorkspaceKey(workspacePath) {
  return 'ws-' + crypto.createHash('sha256').update(String(workspacePath)).digest('hex').slice(0, 16);
}

/** 每次 spawn 前重读 env：ZSW_ZCODE_CLI 的测试覆盖与运行时更换 CLI 都能生效。 */
function resolveZcodeCli() {
  return process.env.ZSW_ZCODE_CLI || config.ZCODE_CLI;
}

/** 控制面请求超时：随任务超时缩放，但保底 2s（防假死早断）、封顶 15s。 */
function controlTimeout(turnTimeoutMs) {
  const t = Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0 ? turnTimeoutMs : REQUEST_TIMEOUT_MS;
  return Math.min(Math.max(t, 2000), REQUEST_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// interpretEvent —— 版本漂移的防洪堤（A1 实测已收敛：patch.status + turn.terminal）
// ---------------------------------------------------------------------------

/** 终态提示词：一轮完成 = 会话回到空闲/落定态（含 waiting——等用户输入即本轮已结束）。
 * error 也是一轮终态（zcode.cjs 实测 VDe 枚举：idle|running|waiting|paused|completed|error，
 * 会话 error 时不发其他终态——不归类会导致 turn 挂到 timeout）。paused 不算完成（暂停可恢复）。 */
const DONE_STATE_HINTS = ['idle', 'settled', 'waiting', 'completed', 'complete', 'done', 'finished', 'error'];
/** 活跃态提示词：仅用于区分「还在跑」，不参与完成判定。 */
const RUNNING_STATE_HINTS = ['running', 'active', 'busy', 'streaming', 'working', 'thinking', 'generating'];

/**
 * 把一个服务端推送帧归类为 'running' | 'done' | 'unknown'。
 * 全部「未实测的协议判定」收敛在这一个函数（任务规格要求）；新增已知信号时
 * 只改这里，调用方语义不变。
 * @param {{method?: string, params?: object}} evt 推送帧
 */
/**
 * 从 session/create 应答提取 sessionId。
 * 真实实测（2026-08-23，zcode 3.8.1）：id 在 result.session.sessionId；
 * projection.sessionId 恒为 "unknown"（勿用）。宽松链兜底历史/未来形态漂移。
 */
function extractCreatedSessionId(created) {
  if (!created || typeof created !== 'object') return undefined;
  return created.sessionId
    ?? (created.session && (created.session.sessionId ?? created.session.id))
    ?? undefined;
}

function interpretEvent(evt) {
  if (!evt || typeof evt.method !== 'string') return 'unknown';
  if (evt.method === 'state.updated') {
    const p = evt.params || {};
    // 实测（2026-08-23，真实帧抓包）：status 位于 patch.status
    // （prompt_started 时 {"patch":{"status":"running"}}）；轮结束后不发
    // status:idle 的 state.updated（终态帧 patch 只有 mode/model 等键）——
    // 一轮结束的权威信号是 turn.terminal（见下）。patch 之外按 state/status
    // 宽松试取，兼容历史/未来形态漂移。
    const status = (p.patch && typeof p.patch.status === 'string' ? p.patch.status : undefined)
      ?? (p.state && typeof p.state === 'object' && typeof p.state.status === 'string' ? p.state.status : undefined)
      ?? (typeof p.state === 'string' ? p.state : undefined)
      ?? (typeof p.status === 'string' ? p.status : undefined);
    if (typeof status !== 'string') return 'unknown';
    const v = status.trim().toLowerCase();
    if (DONE_STATE_HINTS.some((h) => v === h || v.startsWith(h))) return 'done';
    if (RUNNING_STATE_HINTS.some((h) => v === h || v.startsWith(h))) return 'running';
    return 'unknown';
  }
  if (evt.method === 'v4/telemetry/event' && evt.params) {
    // 一轮终态权威信号（实测）：kind:"turn.terminal"，status success/error 均算
    // 一轮结束（错误语义由结果层处理，不归类会让 turn 挂到 timeout）
    if (evt.params.kind === 'turn.terminal') return 'done';
    // 首个文本 chunk = 一轮确已开始产出（不是终态，但可作活跃信号）
    if (evt.params.kind === 'stream.chunk' && evt.params.firstChunk) {
      return 'running';
    }
  }
  return 'unknown';
}

/** 推送帧的会话归属提取（假设 A2 的单点之一）。 */
function extractPushSessionId(params) {
  const sid = params ? (params.sessionId ?? (params.session ? params.session.id : undefined)) : undefined;
  return typeof sid === 'string' && sid ? sid : null;
}

/**
 * 从 session/read / session/messages 的返回中提取最后一条 assistant 文本
 * （假设 A4 的单点之一）。已收口（2026-08-29 真机 apc-smoke 抓包）：
 *   实测主形态 {messages:[{info:{role,...}, parts:[{type:'text', text}, ...]}]}
 *   —— role 在 m.info.role、正文在 text parts；旧形态（m.role + m.content）保留兼容。
 * 兼容 messages 数组、content 三形态（字符串/{text}/块数组）与顶层直给
 * text/response/content/message 的退化形态。
 */
function extractAssistantText(readResult) {
  if (typeof readResult === 'string') return readResult;
  if (!readResult || typeof readResult !== 'object') return null;
  const messages = Array.isArray(readResult.messages) ? readResult.messages
    : Array.isArray(readResult) ? readResult : null;
  if (messages) {
    const last = [...messages].reverse().find((m) => m && typeof m === 'object'
      && (messageRole(m) === 'assistant' || messageRole(m) === undefined));
    if (last) {
      const t = contentToText(last.content);
      if (t != null) return t;
      const p = partsToText(last.parts);
      if (p != null) return p;
    }
  }
  for (const k of ['text', 'response', 'content', 'message']) {
    if (typeof readResult[k] === 'string') return readResult[k];
  }
  return null;
}

/** 消息条目的 role：实测形态在 m.info.role，旧形态在 m.role。 */
function messageRole(m) {
  if (typeof m.role === 'string') return m.role;
  if (m.info && typeof m.info.role === 'string') return m.info.role;
  return undefined;
}

/** 实测形态的正文提取：parts[] 中 type:'text' 部件的 text 拼接（无 text 部件 → null）。 */
function partsToText(parts) {
  if (!Array.isArray(parts)) return null;
  const texts = parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text);
  return texts.length ? texts.join('') : null;
}

/**
 * 从 session/read 返回提取 tokens（实测 2026-08-29 真机 apc-smoke）：usage 在
 * 最后一条 assistant 消息 parts 的 step-finish 部件 tokens 字段；顶层 usage
 * （旧假设形态）保留兜底。都没有 → undefined。
 */
function extractReadUsage(readResult) {
  if (!readResult || typeof readResult !== 'object') return undefined;
  const messages = Array.isArray(readResult.messages) ? readResult.messages : [];
  for (const m of [...messages].reverse()) {
    if (!m || typeof m !== 'object' || messageRole(m) !== 'assistant' || !Array.isArray(m.parts)) continue;
    const finish = [...m.parts].reverse()
      .find((p) => p && p.type === 'step-finish' && p.tokens && typeof p.tokens === 'object');
    if (finish) return finish.tokens;
  }
  return readResult.usage && typeof readResult.usage === 'object' ? readResult.usage : undefined;
}

/**
 * 从 session/read / workspace/readState 应答提取 thoughtLevel 可用档位
 * （D5 校验源）。F1 真机实测（2026-08-29 apc-smoke）：read 应答的
 * settings.thoughtLevel = {available:[low|high|max], current, defaultLevel}；
 * workspace/readState 同结构面（调研文档 RK-7 源码逆向，params 形态未实测）。
 * 抽不到有效数组 → null（调用方按「校验源不可用」处理）。
 */
function extractThoughtLevels(state) {
  const tl = state && typeof state === 'object'
    && state.settings && typeof state.settings === 'object'
    ? state.settings.thoughtLevel
    : undefined;
  if (tl && Array.isArray(tl.available)) {
    const levels = tl.available.filter((x) => typeof x === 'string' && x.trim() !== '');
    return levels.length > 0 ? levels : null;
  }
  return null;
}

/**
 * 规范化工具名清单（裸名形态，D6：引擎以 new Set(裸名) 匹配，消费点见调研文档
 * offset 12051550）。过滤非字符串/空白项并 trim；非数组 → 空数组。
 */
function cleanToolNames(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => t.trim());
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  if (Array.isArray(content)) {
    const joined = content
      .map((b) => (typeof b === 'string' ? b : (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')))
      .join('');
    return joined || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 协议漂移分类（D3/G3：协议无版本协商，漂移只以 -32601/-32602 出现）
// ---------------------------------------------------------------------------

/** 升级冒烟命令（与 e2e.test.js 的 apc-smoke 场景名对齐；--name 过滤见该文件头注）。 */
const DRIFT_SMOKE_CMD = 'node test/e2e.test.js --name apc-smoke';
/** 显式回退开关（D1）。 */
const DRIFT_FALLBACK_ENV = 'ZSW_RUNNER=spawn';

/**
 * 把 apc 错误分类为 protocol-drift。
 * 只认 -32601（方法不存在）/ -32602（参数校验失败）；其余错误码（-32004 不活跃、
 * -32010 busy、-32031 恢复失败、-32022 反向请求超时、-32603 内部错误）返回 null
 * 走原有错误路径——互斥不遮蔽，且不给漂移加重试（D3 被否项：重试必然再失败并
 * 掩盖根因）。
 * @param {Error & {code?: number}} err _onResponse 挂载了 code 的错误（或任意值）
 * @returns {{kind: 'protocol-drift', hint: string}|null} null = 非漂移类
 */
function classifyApcError(err) {
  const code = err && typeof err === 'object' ? err.code : undefined;
  if (code !== -32601 && code !== -32602) return null;
  return {
    kind: 'protocol-drift',
    hint: `协议漂移（protocol-drift）: ${err && err.message}。`
      + '这通常意味着 ZCode 版本更新改了 apc 协议（协议无版本协商，漂移以 -32601/-32602 出现）。'
      + `恢复指引: 跑升级冒烟 \`${DRIFT_SMOKE_CMD}\` 核对漂移面；确认不兼容期间设 ${DRIFT_FALLBACK_ENV} 回退。`,
  };
}

// ---------------------------------------------------------------------------
// 分支 B（D2 兜底）+ runtimeModel 构造（F0 buildRuntimeModel 的生产适配）
// ---------------------------------------------------------------------------

const DRIFT_FALLBACK_HINT = '或设 ZSW_RUNNER=spawn 走旧通道（每轮独立进程，无此恢复问题）';

/**
 * D2 分支 B 兜底文案（复审 INFO-1：语境适配「事件流不可达/恢复失败」）。
 * 语义三要素：会话弃用 + zsw start 重建指引 + record 历史保留；禁止裸错误码
 * （错误码随 reason 带出做取证，但必须伴随语境与恢复指引）。
 */
function branchBMessage(reason) {
  return `会话恢复失败（${reason}），该会话已弃用。`
    + '恢复指引: 该会话不可续；用 zsw start 重建任务（record 已保留历史输出），'
    + DRIFT_FALLBACK_HINT + '。';
}

/** 分支 B 错误：start/resume 错误出口据 .branchB 标记识别（不走 drift 分类）。 */
function branchBError(reason, code) {
  const err = new Error(branchBMessage(reason));
  err.branchB = true;
  if (code !== undefined) err.code = code;
  return err;
}

/** v2 config 每次恢复时重读（apiKey/模型清单随桌面端操作变化，与 model-router 同纪律）。 */
function readV2Config() {
  try { return JSON.parse(fs.readFileSync(config.V2_CONFIG_PATH, 'utf8')); } catch { return null; }
}

/**
 * 从 v2 config 构造 apc runtimeModel（D2 恢复序①；schema strict 逐字段实测见
 * F0 探针头注：{revision, generatedAt(epochMs), model{providerId,modelId},
 * provider{providerId, kind, label?, source:"custom", baseURL,
 * apiKey:{source:"inline",value}, models:[{modelId}…]}}）。
 * provider 条目忠实携带传输配置——引擎会把它注册进 workspaceModelCatalogs、
 * 成为恢复后 turn 的 overlay 配置来源，缺凭据会让恢复后的轮挂在 provider 层。
 * 凭据脱敏纪律：本函数只被恢复序调用、返回值只进请求帧；任何日志/stderr
 * 不得输出其全文（出声只用 providerId/modelId 摘要）。
 * @param {{providerId?: string, modelId?: string}} [sessionModel] 会话登记的 create model
 * @returns {object} runtimeModel 请求帧字段
 * @throws 无法确定模型目标 / provider 条目无凭据（调用方转分支 B）
 */
function buildRuntimeModel(sessionModel) {
  const v2 = readV2Config();
  let providerId = sessionModel && sessionModel.providerId;
  let modelId = sessionModel && sessionModel.modelId;
  if (!providerId || !modelId) {
    // 幽灵恢复兜底（daemon 重启后 _sessions 无登记）：v2 config 的当前主模型
    //（与 model-router defaultModelRef 的 v2 回退段同语义，避免引入其依赖）
    const main = v2 && v2.model && typeof v2.model.main === 'string' ? v2.model.main.trim() : '';
    if (main) {
      if (main.includes('/')) {
        providerId = providerId || main.slice(0, main.lastIndexOf('/'));
        modelId = modelId || main.slice(main.lastIndexOf('/') + 1);
      } else {
        modelId = modelId || main;
      }
    }
    providerId = providerId || DEFAULT_PROVIDER_ID;
  }
  if (!providerId || !modelId) {
    throw new Error('无法确定恢复目标模型（会话登记与 v2 config model.main 均未提供 provider/model）');
  }
  const entry = v2 && v2.provider && v2.provider[providerId];
  if (!entry || !entry.options || !entry.options.apiKey) {
    throw new Error(`v2 config 无 ${providerId} 的可用 provider 条目（含 apiKey）`);
  }
  const modelIds = Object.keys(entry.models || {});
  return {
    revision: `zsw-recover-${Date.now()}`,
    generatedAt: Date.now(),
    model: { providerId, modelId },
    provider: {
      providerId,
      kind: entry.kind || 'anthropic',
      ...(entry.name ? { label: entry.name } : {}),
      source: 'custom',
      baseURL: entry.options.baseURL,
      apiKey: { source: 'inline', value: entry.options.apiKey },
      models: (modelIds.length ? modelIds : [modelId]).map((id) => ({ modelId: id })),
    },
  };
}

/** 恢复序出声用摘要（凭据脱敏：只报模型目标，不报 runtimeModel 全文）。 */
function describeModelTarget(runtimeModel) {
  const m = runtimeModel && runtimeModel.model;
  return m ? `${m.providerId}/${m.modelId}` : '(unknown)';
}

// ---------------------------------------------------------------------------
// 帧分发器（纯逻辑，便于不 spawn 进程直接单测三路分发）
// ---------------------------------------------------------------------------

/**
 * 按行解析 NDJSON 并四路分发：
 *   - onResponse(id, frame)          id 匹配 pending 请求的响应
 *   - onPush(method, params, frame)  无 id 的服务端推送
 *   - onReverse(id, method, params)  有 id 又有 method 的服务端反向请求
 *   - onProtocol(info)               首帧 protocol 自报（{protocol:{...}} 形态）
 *   - onMalformed(line)              非 JSON / 非法帧（记录后跳过，不断流）
 * @param {object} handlers 上五路回调
 */
function createFrameDispatcher(handlers = {}) {
  const { onResponse, onPush, onReverse, onProtocol, onMalformed } = handlers;
  let buffer = '';
  return {
    handleChunk(chunk) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        this.handleLine(line);
      }
    },
    handleLine(line) {
      const text = String(line).trim();
      if (!text) return;
      let frame = null;
      try { frame = JSON.parse(text); } catch { if (onMalformed) onMalformed(text); return; }
      this.handleFrame(frame, text);
    },
    handleFrame(frame, rawText) {
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
        if (onMalformed) onMalformed(rawText);
        return;
      }
      const hasProtocol = Boolean(frame.protocol) && typeof frame.protocol === 'object';
      if (hasProtocol && onProtocol) onProtocol(frame.protocol);
      if (typeof frame.method === 'string') {
        if (frame.id !== undefined && frame.id !== null) {
          if (onReverse) onReverse(frame.id, frame.method, frame.params, frame);
        } else if (onPush) {
          onPush(frame.method, frame.params, frame);
        }
        return;
      }
      if (frame.id !== undefined && frame.id !== null) {
        if (onResponse) onResponse(frame.id, frame);
        return;
      }
      if (hasProtocol) return; // protocol 自报首帧（无 id 无 method）：已被消费，不是坏帧
      if (onMalformed) onMalformed(rawText);
    },
  };
}

// ---------------------------------------------------------------------------
// 连接：长驻 app-server 子进程 + 请求/推送/反向请求泵
// ---------------------------------------------------------------------------

class AppServerConnection {
  constructor({ cliPath, cwd, homeDir, reverseHandlers = REVERSE_HANDLERS, nodeCmd = 'node', env = {}, stderrLogPath }) {
    this._cliPath = cliPath;
    this._cwd = cwd;
    this._homeDir = homeDir;
    this._reverseHandlers = reverseHandlers;
    this._nodeCmd = nodeCmd;
    this._extraEnv = env;
    // D3 引擎 stderr 实时落盘：显式注入 > 默认 ~/.zcode/zsw/logs/<date>-appserver.log
    //（ZSW_ROOT env 已使测试默认路径随测试根隔离）。文件 lazy 打开：首条 stderr
    // 才建，无 stderr 的短连接（probe）零文件。
    this._stderrLogPath = stderrLogPath
      || path.join(config.logsDir(), `${new Date().toISOString().slice(0, 10)}-appserver.log`);
    this._stderrStream = null;
    this._stderrStreamFailed = false;
    this._child = null;
    this._exited = false;
    this._exitReason = null;
    this._pending = new Map();   // 请求 id -> {resolve, reject, timer, method}
    this._reqSeq = 0;
    this._pushHandlers = [];
    this._closeHandlers = [];
    this._protocolInfo = null;
    this._stderrTail = '';
    this._killTimer = null;
    this._exitResolvers = [];
    this._dispatcher = createFrameDispatcher({
      onResponse: (id, frame) => this._onResponse(id, frame),
      onPush: (method, params) => this._onPush(method, params),
      onReverse: (id, method, params) => this._onReverse(id, method, params),
      onProtocol: (info) => { this._protocolInfo = info; },
      onMalformed: (line) => stderrLog(`无法解析的协议行（忽略）: ${String(line).slice(0, 200)}`),
    });
  }

  get exited() { return this._exited; }
  get exitReason() { return this._exitReason; }
  get protocolInfo() { return this._protocolInfo; }

  onPush(fn) { this._pushHandlers.push(fn); }
  onClose(fn) { this._closeHandlers.push(fn); }

  /** 惰性启动：首个请求时才 spawn（连接构建零成本，probe 失败零残留）。 */
  _start() {
    if (this._child || this._exited) return;
    fs.mkdirSync(this._homeDir, { recursive: true });
    const child = spawn(this._nodeCmd, [this._cliPath, 'app-server', '--cwd', this._cwd], {
      // HOME 权威值来自 homeDir（隔离 HOME，D10 第二重门禁随隔离配置生效）；
      // ZSW_NESTED 是防递归硬性注入（D10 第一重门禁）；
      // ZCODE_MODEL_TELEMETRY_ENABLED=false 是隔离环境遥测关闭（D8：隔离 HOME
      // 内不写遥测标识，维持「隔离目录只含运行必需数据」的排障预期）
      env: {
        ...process.env,
        ...this._extraEnv,
        HOME: this._homeDir,
        ZSW_NESTED: '1',
        ZCODE_MODEL_TELEMETRY_ENABLED: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this._child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this._dispatcher.handleChunk(d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      this._stderrTail = (this._stderrTail + d).slice(-2048);
      this._appendStderrLog(d);
    });
    // 子进程死后的残留写会以 EPIPE 冒泡到 stdin 流，不吞会让宿主进程崩
    child.stdin.on('error', () => {});
    child.on('error', (err) => this._handleExit(`spawn 失败: ${err.message}`));
    child.on('close', (code, signal) => this._handleExit(
      `进程退出（code=${code} signal=${signal}）stderr 尾部: ${this._stderrTail.slice(-400)}`
    ));
  }

  /** 引擎 stderr 实时 append 落盘（D3）。失败静默：取证面不能拖垮主通道。 */
  _appendStderrLog(chunk) {
    if (this._stderrStreamFailed) return;
    if (!this._stderrStream) {
      try {
        fs.mkdirSync(path.dirname(this._stderrLogPath), { recursive: true });
        this._stderrStream = fs.createWriteStream(this._stderrLogPath, { flags: 'a' });
        this._stderrStream.on('error', () => { this._stderrStreamFailed = true; });
      } catch {
        this._stderrStreamFailed = true;
        return;
      }
    }
    this._stderrStream.write(chunk);
  }

  _handleExit(reason) {
    if (this._exited) return;
    this._exited = true;
    this._exitReason = reason;
    if (this._killTimer) { clearTimeout(this._killTimer); this._killTimer = null; }
    if (this._stderrStream) {
      // 实时落盘流收尾（退出摘要仍经 exitReason 出声——保留既有行为）
      const s = this._stderrStream;
      this._stderrStream = null;
      s.end();
    }
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`app-server ${reason}`));
    }
    this._pending.clear();
    for (const fn of this._closeHandlers) {
      try { fn(reason); } catch { /* handler 异常不拖死退出流程 */ }
    }
    for (const res of this._exitResolvers) res();
    this._exitResolvers = [];
  }

  _waitExit() {
    if (this._exited) return Promise.resolve();
    return new Promise((res) => this._exitResolvers.push(res));
  }

  /**
   * 发一个 client 请求并等响应。error 帧转 reject（code/data 挂到 Error 上，
   * -32602 的 zod 诊断随 message 带出，便于逆向 schema）。
   */
  request(method, params, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this._start();
    if (this._exited) {
      return Promise.reject(new Error(`app-server 连接不可用（${this._exitReason || '未启动'}）`));
    }
    const id = ++this._reqSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`请求 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, method });
      this._writeFrame({ id, method, params });
    });
  }

  _onResponse(id, frame) {
    const p = this._pending.get(id);
    if (!p) {
      stderrLog(`响应无匹配请求 id=${id}（忽略）`);
      return;
    }
    this._pending.delete(id);
    clearTimeout(p.timer);
    if (frame.error) {
      const e = frame.error;
      const err = new Error(
        `${p.method} 失败: [${e.code}] ${e.message}`
        + (e.data !== undefined ? `；data: ${JSON.stringify(e.data).slice(0, 400)}` : '')
      );
      err.code = e.code;
      err.data = e.data;
      p.reject(err);
    } else {
      p.resolve(frame.result);
    }
  }

  _onPush(method, params) {
    // 协议自报的推送形态（{method:'protocol', params:{...}}）在此捕获；
    // 首帧形态由 dispatcher.onProtocol 捕获，两处收敛到同一字段
    if (method === 'protocol') this._protocolInfo = params;
    for (const fn of this._pushHandlers) {
      try { fn(method, params); } catch (err) { stderrLog(`push handler 异常: ${err.message}`); }
    }
  }

  _onReverse(id, method) {
    const handler = this._reverseHandlers[method];
    if (!handler) {
      stderrLog(`未知反向请求 ${method}（id=${id}）：回空 result（不答会 15s 超时断连，实测 -32022）`);
      this._writeFrame({ id, result: {} });
      return;
    }
    Promise.resolve()
      .then(() => handler())
      .then((result) => this._writeFrame({ id, result: result == null ? {} : result }))
      .catch((err) => {
        stderrLog(`反向请求 ${method} handler 异常: ${err && err.message}`);
        this._writeFrame({ id, error: { code: -32000, message: String((err && err.message) || err) } });
      });
  }

  _writeFrame(frame) {
    if (!this._child || this._exited) return;
    try {
      this._child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch (err) {
      stderrLog(`写入 app-server 失败: ${err.message}`);
    }
  }

  /** SIGTERM → graceMs → SIGKILL（与 driver 同链，防 CLI 收尾钩子拖延）。 */
  killChain(graceMs = config.DEFAULTS.killGraceMs) {
    if (this._exited || !this._child) return;
    try { this._child.kill('SIGTERM'); } catch { /* 已退出 */ }
    if (this._killTimer) clearTimeout(this._killTimer);
    this._killTimer = setTimeout(() => {
      if (!this._exited) {
        try { this._child.kill('SIGKILL'); } catch { /* 已退出 */ }
      }
    }, graceMs);
  }

  /** 杀进程并等退出（超时上限兜底，绝不永久挂起）。 */
  async shutdown(opts = {}) {
    const graceMs = opts.graceMs ?? config.DEFAULTS.killGraceMs;
    this.killChain(graceMs);
    await Promise.race([this._waitExit(), sleep(graceMs + 1500)]);
  }
}

// ---------------------------------------------------------------------------
// AppServerRunner（RunnerPort 实现）
// ---------------------------------------------------------------------------

class AppServerRunner {
  /**
   * @param {object} [opts]
   * @param {string} [opts.homeDir]  隔离 HOME（默认 zswRoot 下单一目录——apc 模式
   *                                 无 per-model 池，D5「单一隔离 HOME」）
   * @param {string} [opts.cwd]      app-server 进程 --cwd 默认值（首个 start 可覆盖）
   */
  constructor(opts = {}) {
    // 与 model-router.prepareRunEnv('appserver') 的 bootstrap 目标必须同一目录
    // （单一事实源：config.appserverHomeDir），否则凭据写 A 进程读 B。
    this._homeDir = opts.homeDir || config.appserverHomeDir();
    this._cwd = opts.cwd || process.cwd();
    this._conn = null;
    // sessionId -> {workspace, chunks:[{assistantMessageId,text}], lastUsage, closed}
    this._sessions = new Map();
    this._turns = new Map(); // sessionId -> 本会话进行中的一轮（控制器）
    // D2 恢复互斥：单例 promise 链（model-router poolMutex 同款），同一时刻至多
    // 一路恢复序在执行——防引擎崩溃后 N 会话并发恢复风暴（F0 C 线：不解 -32031，
    // 每路带 runtimeModel 才是解；互斥只防风暴）
    this._recoveryChain = Promise.resolve();
    // D5 thinking 校验缓存：AppServerConnection -> string[]|null（null=校验源
    // 不可用）。WeakMap 按连接生命周期——连接重建（进程崩溃/退出）自动 miss 重读，
    // 不需要手动失效
    this._thoughtLevelCache = new WeakMap();
    // D3 stderr 落盘路径注入（测试隔离用；缺省由连接层按 config.logsDir() 自算）
    this._stderrLogPath = opts.stderrLogPath;
  }

  capabilities() {
    return {
      kind: 'appserver',
      // INFO-15：声明必须与实际暴露面一致——manager 的 message 门禁是
      // idle-only，runner 内 A5（running 中 session/send 投递）也未实测，
      // running 投递从未对外可达，故报 'none'（SpawnRunner 同款正例）。
      // A5 实测通过、门禁放开后再升回 'session-send'。
      steering: 'none',
      coldStartMs: 0,           // 长驻进程 + 常驻会话，续聊零冷启动
    };
  }

  /**
   * 启动探针：独立连接上 create 探针会话 → 立即 close → shutdown，全程 10s 预算。
   * 只报告不决策——降级到 SpawnRunner 由 manager/上层做。真实探针 W3 跑，
   * 单测用 fake server。
   * @returns {Promise<{ok: boolean, protocolVersion?: number, reason?: string}>}
   */
  async probe() {
    let tmpDir = null;
    let conn = null;
    let timer = null;
    const timeoutP = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`probe 超时（${PROBE_BUDGET_MS}ms 预算耗尽）`)), PROBE_BUDGET_MS);
    });
    const work = (async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-apc-probe-'));
      // 独立连接：探针失败/收尾不能牵连共享连接上的在跑会话
      conn = new AppServerConnection({
        cliPath: resolveZcodeCli(),
        cwd: tmpDir,
        homeDir: this._homeDir,
      });
      const created = await conn.request('session/create', {
        workspace: { workspacePath: tmpDir, workspaceKey: stableWorkspaceKey(tmpDir) },
        mode: 'yolo',
      }, { timeoutMs: PROBE_BUDGET_MS });
      const sid = extractCreatedSessionId(created);
      if (typeof sid !== 'string' || !sid) {
        throw new Error(`session/create 未返回 sessionId: ${JSON.stringify(created).slice(0, 300)}`);
      }
      await conn.request('session/close', { sessionId: sid }, { timeoutMs: 3_000 });
      return { ok: true, protocolVersion: conn.protocolInfo ? conn.protocolInfo.version : undefined };
    })();
    try {
      return await Promise.race([work, timeoutP]);
    } catch (err) {
      return { ok: false, reason: `app-server 探针失败: ${err && err.message}` };
    } finally {
      clearTimeout(timer);
      try {
        if (conn) await conn.shutdown({ graceMs: PROBE_SHUTDOWN_GRACE_MS });
      } catch { /* 收尾尽力而为 */ }
      try {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* 尽力清理 */ }
    }
  }

  /** 惰性单连接：首个操作时 spawn；进程死过则重建（会话持久化时或可跨进程续，见 A5/-32004 文案）。 */
  _ensureConnection(cwd) {
    if (cwd) this._cwd = cwd;
    if (this._conn && !this._conn.exited) return this._conn;
    const conn = new AppServerConnection({
      cliPath: resolveZcodeCli(),
      cwd: this._cwd,
      homeDir: this._homeDir,
      stderrLogPath: this._stderrLogPath,
    });
    conn.onPush((method, params) => this._handlePush(method, params));
    conn.onClose((reason) => this._failAllTurns(reason));
    this._conn = conn;
    return conn;
  }

  // ------------------------------------------------------------- 推送泵

  _handlePush(method, params) {
    if (method === 'protocol') return; // 连接层已捕获
    const sid = extractPushSessionId(params); // A2 单点
    const session = this._lookupSession(sid);
    if (session) {
      // A3/A4 实测（2026-08-23，真实帧抓包）：stream.chunk 只有 chunkLength 无文本；
      // 实时文本在 session/event 的 payload.delta，最终全文在 payload.response
      // （turn 收尾帧，携带 usage）。两者都收，response 为终态读取的第一优先来源。
      if (method === 'session/event' && params && params.payload && typeof params.payload === 'object') {
        const pl = params.payload;
        if (typeof pl.response === 'string' && pl.response !== '') {
          session.finalResponse = pl.response;
          if (pl.usage && typeof pl.usage === 'object') session.lastUsage = pl.usage;
        } else if (pl.stopReason === 'stop' && typeof pl.content === 'string' && pl.content !== '') {
          // turn 收尾的 content 形态（实测与 response 同值，携带 usage）
          session.finalResponse = pl.content;
          if (pl.usage && typeof pl.usage === 'object') session.lastUsage = pl.usage;
        } else if (typeof pl.delta === 'string' && pl.delta !== '') {
          session.chunks.push({ assistantMessageId: pl.assistantMessageId, text: pl.delta });
        }
      }
      // A3 实测：stream.chunk 无文本，此分支仅为形态漂移兜底（主路径在上方 session/event）
      if (method === 'v4/telemetry/event' && params && params.kind === 'stream.chunk') {
        const text = typeof params.chunk === 'string' ? params.chunk
          : typeof params.text === 'string' ? params.text
            : typeof params.content === 'string' ? params.content : null;
        if (text) session.chunks.push({ assistantMessageId: params.assistantMessageId, text });
      }
      const usage = params ? (params.usage ?? (params.state ? params.state.usage : undefined)) : undefined;
      if (usage && typeof usage === 'object') session.lastUsage = usage;
    }
    if (interpretEvent({ method, params }) === 'done') {
      const turn = this._lookupTurn(sid);
      if (turn) turn.finishDone();
    }
  }

  /** 推送缺 sessionId 时仅敢归因到唯一会话/一轮，多会话并发时宁丢勿错（A2）。 */
  _lookupSession(sid) {
    if (sid) return this._sessions.get(sid) || null;
    if (this._sessions.size === 1) return this._sessions.values().next().value;
    return null;
  }

  _lookupTurn(sid) {
    if (sid) return this._turns.get(sid) || null;
    if (this._turns.size === 1) return this._turns.values().next().value;
    return null;
  }

  _aggregatedText(sessionId) {
    const s = this._sessions.get(sessionId);
    return s && s.chunks.length ? s.chunks.map((c) => c.text).join('') : '';
  }

  _failAllTurns(reason) {
    for (const turn of [...this._turns.values()]) {
      turn.fail(`app-server 连接中断: ${reason}`);
    }
  }

  // ------------------------------------------------------------- 一轮生命周期

  /**
   * 注册并跟踪「一轮」：终态判定只认 interpretEvent 的 done（推送驱动）；
   * 超时走 session/stop，stop 失败才 kill 共享进程（会拖死其他会话，最后手段）。
   * @param {object} [opts] {recovered?: boolean} D2 ④：恢复序重试成功后的轮，
   *   timeoutMs 窗口耗尽即判「恢复后事件流不可达」→ stop 清场 + 分支 B 收尾
   *   （不是普通 timeout——普通 timeout 只对本轮负责，recovered 轮耗尽说明恢复未达成）。
   */
  _createTurn(sessionId, timeoutMs, conn, opts = {}) {
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this._turns.delete(sessionId);
      settle({ sessionId, ...result });
    };
    const aggregated = () => this._aggregatedText(sessionId);
    const stopBestEffort = () => conn.request('session/stop', { sessionId }, { timeoutMs: STOP_TIMEOUT_MS });
    // timeoutMs=null（无超时）不建 timer：setTimeout 会把 null 强转为 1ms 立即超时，
    // 与 driver.js 的 spawn 侧防护同源；turn 依赖终态信号收尾，无超时是安全语义
    const timer = (Number.isFinite(timeoutMs) && timeoutMs > 0)
      ? setTimeout(() => {
        if (opts.recovered) {
          // D2 ④：恢复后的轮窗口耗尽 = 事件流不可达 → 分支 B（stderr 双落点同 drift/分支 B 先例）
          const msg = branchBMessage(
            `恢复后事件流不可达（重试 send 已接受，但一轮未在 ${timeoutMs}ms 窗口内观察到终态；已发 session/stop 清场，防引擎侧孤儿轮）`
          );
          stderrLog(msg);
          finish({ status: 'error', response: aggregated(), error: msg });
        } else {
          finish({
            status: 'timeout',
            response: aggregated(),
            // INFO-16：E7 后权威终态信号是 turn.terminal，state.updated 是兼容信号，
            // 并列表述避免误导诊断
            error: `一轮未在 ${timeoutMs}ms 内观察到终态（turn.terminal / state.updated）。已发 session/stop；stop 失败将 kill app-server 进程兜底。`,
          });
        }
        stopBestEffort().then(
          () => {},
          () => { stderrLog('session/stop 失败 → kill app-server 进程兜底'); conn.killChain(); }
        );
      }, timeoutMs)
      : null;
    const turn = {
      promise,
      cancel() {
        finish({ status: 'cancelled', response: aggregated() });
        stopBestEffort().catch((e) => stderrLog(`cancel 后 session/stop 失败: ${e.message}`));
      },
      fail(reason) { finish({ status: 'error', error: reason, response: aggregated() }); },
      finishDone: () => {
        if (settled) return;
        settled = true; // 先占位：异步取文期间到达的重复终态不再受理
        clearTimeout(timer);
        this._turns.delete(sessionId);
        this._fetchFinalResponse(sessionId, conn).then(
          (r) => {
            const session = this._sessions.get(sessionId);
            const usage = r.usage || (session ? session.lastUsage : undefined);
            settle({
              status: 'closed',
              sessionId,
              response: r.response,
              ...(usage ? { usage } : {}),
              ...(r.failed ? { error: READ_FAILED_NOTE } : {}),
            });
          },
          (e) => settle({
            status: 'closed',
            sessionId,
            response: aggregated(),
            error: `终态后的结果读取异常: ${e && e.message}；session 可 resume`,
          })
        );
      },
    };
    this._turns.set(sessionId, turn);
    return turn;
  }

  /**
   * 终态后的最终文本兜底链（A4 部分；read/messages 真实形态待抓包）：session/read → session/messages →
   * session/event 的 payload.response（实测捕获的 turn 收尾帧）→ stream.chunk/
   * payload.delta 聚合 → 全部失败则注明可 resume。
   */
  async _fetchFinalResponse(sessionId, conn) {
    for (const method of ['session/read', 'session/messages']) {
      try {
        const result = await conn.request(method, { sessionId }, { timeoutMs: READ_TIMEOUT_MS });
        const text = extractAssistantText(result);
        // F1 实测面顺带沉淀（D5）：read 应答的 settings.thoughtLevel.available
        // 填连接级 thinking 校验缓存——后续 start 的 thinking 校验免发
        // workspace/readState。抽不到（null）不覆盖既有结论。
        // 注意必须在文本提取 return 之前：主路径（成功提取正文）同样要沉淀
        const levels = extractThoughtLevels(result);
        if (levels) this._thoughtLevelCache.set(conn, levels);
        if (text != null) {
          // A4 收口（2026-08-29 实测）：read 的 tokens 在 step-finish parts，
          // extractReadUsage 内含顶层 usage 兜底
          return { response: text, usage: extractReadUsage(result) };
        }
        stderrLog(`${method} 成功但未提取到 assistant 文本，继续降级`);
      } catch (err) {
        stderrLog(`${method} 兜底失败: ${err && err.message}`);
      }
    }
    const session = this._sessions.get(sessionId);
    if (session && typeof session.finalResponse === 'string' && session.finalResponse.trim()) {
      return { response: session.finalResponse, usage: session.lastUsage };
    }
    const agg = this._aggregatedText(sessionId);
    if (agg && agg.trim()) return { response: agg };
    return { response: '', failed: true };
  }

  // ------------------------------------------------- per-session 能力参数（D5/D6）

  /**
   * thinking 档位连接级校验（D5）。校验源优先级：
   * ① 连接级缓存（WeakMap；含 session/read 应答顺带沉淀的 settings.thoughtLevel
   *   可见面——F1 实测，优先于未实测的 workspace/readState）；
   * ② workspace/readState（调研文档 RK-7 源码逆向面，params 形态未真机实测——
   *   最小空 params 发起，任何失败一律缓存「不可用」并透传档位给引擎）。
   * 引擎对非法值本就容错（P2 实证 warn 跳过不失败），校验源不可用时透传是
   * 安全降级：workspace/readState 形态漂移不会让 thinking 功能死掉。真机校准
   * （检查点面）只需改本方法内的请求 params。
   * @param {AppServerConnection} conn
   * @param {string} requested 请求档位（如 'low'）
   * @returns {Promise<{ok: boolean, passthrough?: boolean, available?: string[]}>}
   *          ok=true 且 passthrough=true 表示未经校验放行（校验源不可用）
   */
  async _resolveThinking(conn, requested) {
    let levels = this._thoughtLevelCache.get(conn);
    if (levels === undefined) {
      try {
        const state = await conn.request('workspace/readState', {}, { timeoutMs: REQUEST_TIMEOUT_MS });
        levels = extractThoughtLevels(state);
      } catch (err) {
        levels = null;
        stderrLog(`thinking 校验源 workspace/readState 不可用（${err && err.message}），`
          + `档位 "${requested}" 不经本地校验直接透传（引擎容错兜底，P2）`);
      }
      this._thoughtLevelCache.set(conn, levels);
    }
    if (levels === null) return { ok: true, passthrough: true };
    return { ok: levels.includes(requested), available: levels };
  }

  /**
   * create 的工具限制组装（D6 双来源并集）：
   * - toolAllowlist = CLI --allow-tools（经 runEnv.createParams 传入，再兜底规范化）；
   * - toolDenylist = CLI --deny-tools（createParams.toolDenylist）∪ frontmatter
   *   taskCtx.disallowedTools，并集去重。
   * 两清单都做规范化（model-router 已清理过，这里是 create 面组装前的第二道
   * 防御——createParams 可被直接构造的 taskCtx 绕过 router）。frontmatter
   * `tools` 白名单不升级（维持 buildPrompt 软约束，D6 显式决策）；spawn 通道
   * 不消费 CLI 来源（行为不变，denylist 走 --disallowed-tools 既有路径）。
   * 就地改写 createParams；无 CLI 来源且无 frontmatter deny 时保持无键。
   * @param {object} createParams runner 已合入 runEnv.createParams 的组装产物
   * @param {object} taskCtx
   */
  _applyCreateToolLimits(createParams, taskCtx) {
    const allow = cleanToolNames(createParams.toolAllowlist);
    if (allow.length > 0) createParams.toolAllowlist = allow;
    else delete createParams.toolAllowlist;
    const frontDeny = cleanToolNames(taskCtx && taskCtx.disallowedTools);
    const cliDeny = cleanToolNames(createParams.toolDenylist);
    if (frontDeny.length === 0 && cliDeny.length === 0) {
      delete createParams.toolDenylist; // 两来源皆空：不设键（防上游带空数组）
      return;
    }
    createParams.toolDenylist = [...new Set([...cliDeny, ...frontDeny])];
  }

  // ------------------------------------------------------------- -32004 恢复序（D2）

  /** runtimeModel 构造（模块级 buildRuntimeModel 的 runner 侧包装：带会话登记）。 */
  _buildRuntimeModel(sessionId) {
    const session = this._sessions.get(sessionId);
    return buildRuntimeModel(session && session.model);
  }

  /**
   * send 统一入口：正常投递；遇 -32004 自动进四步恢复序（见文件头「-32004 四步
   * 恢复序」）。其余错误（含 -32010 busy、-32601/-32602 漂移、超时）原样上抛。
   * @returns {Promise<{sent: object, recovered: boolean}>} recovered=本轮经恢复序重试送达
   */
  async _sendWithRecovery(conn, sessionId, content, { ctlTimeout }) {
    try {
      return { sent: await conn.request('session/send', { sessionId, content }, { timeoutMs: ctlTimeout }), recovered: false };
    } catch (err) {
      if (!err || err.code !== -32004) throw err;
      stderrLog(`会话 ${sessionId} send 遇 -32004（会话不在引擎内存：驱逐/进程重启/close），启动四步恢复序`);
      const sent = await this._recoverExclusive(() => this._doRecoverAndResend(conn, sessionId, content, { ctlTimeout }));
      return { sent, recovered: true };
    }
  }

  /** 恢复互斥：链尾排队，前序失败不阻塞后续（与 model-router poolMutex 同款）。 */
  _recoverExclusive(fn) {
    const run = this._recoveryChain.then(fn, fn);
    this._recoveryChain = run.catch(() => {});
    return run;
  }

  /**
   * 四步恢复序本体（互斥区内执行）：
   * ① resume{sessionId, runtimeModel}（每次无条件带，F0 结论）
   * ② 重挂 subscribe（订阅 per-session，resume 不自动恢复；缺则终态不达假死）
   * ③ 重试一次原 send（遇 -32010 不重试——恢复已成功，busy 如实上抛）
   * ④ 由 _createTurn({recovered:true}) 的 timeoutMs 窗口判据承接。
   * 任一步失败：-32601/-32602 原样上抛交 drift 分类（不吞不重试）；其余 → 分支 B。
   */
  async _doRecoverAndResend(conn, sessionId, content, { ctlTimeout }) {
    // ① resume（构造失败 = 无法重建恢复模型 → 分支 B，诚实报错不发盲请求）
    let runtimeModel;
    try {
      runtimeModel = this._buildRuntimeModel(sessionId);
    } catch (err) {
      throw branchBError(`无法构造 runtimeModel：${err && err.message}`);
    }
    stderrLog(`恢复序① session/resume ${sessionId}（runtimeModel: ${describeModelTarget(runtimeModel)}）`);
    try {
      await conn.request('session/resume', { sessionId, runtimeModel }, { timeoutMs: ctlTimeout });
    } catch (err) {
      if (classifyApcError(err)) throw err; // 漂移不吞：交既有分类路径出（D3 互斥）
      throw branchBError(`resume 失败: ${err && err.message}`, err && err.code);
    }
    // ② 重挂订阅
    try {
      await conn.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }, { timeoutMs: ctlTimeout });
    } catch (err) {
      if (classifyApcError(err)) throw err;
      throw branchBError(`订阅重挂失败（事件流不可达风险）: ${err && err.message}`, err && err.code);
    }
    // ③ 重试原 send（一次）
    let sent;
    try {
      sent = await conn.request('session/send', { sessionId, content }, { timeoutMs: ctlTimeout });
    } catch (err) {
      if (err && err.code === -32010) throw err; // busy：会话已恢复且有轮在跑，如实上报不落分支 B
      if (classifyApcError(err)) throw err;
      throw branchBError(`恢复后重试 send 失败: ${err && err.message}`, err && err.code);
    }
    if (sent && sent.accepted === false) {
      throw branchBError('恢复后重试 send 返回 accepted:false（投递未被接受）');
    }
    return sent;
  }

  // ------------------------------------------------------------- RunnerPort

  /**
   * 启动一次任务（立即返回，不等待完成）。
   * @param {TaskCtx} taskCtx 需携带 runEnv.createParams（model-router 的 appserver
   *                           分支产物），合入 session/create。
   * @returns {{exec: {kind:'apc', sessionId?: string}, cancel(): void, done: Promise<RunResult>}}
   *           exec.sessionId 在 create 应答后回填（可变引用，同 SpawnRunner 模式）
   */
  start(taskCtx) {
    const prompt = taskCtx ? taskCtx.prompt : undefined;
    const cwd = taskCtx ? taskCtx.cwd : undefined;
    if (prompt == null || prompt === '') {
      throw new Error('AppServerRunner.start: taskCtx.prompt 必填。');
    }
    if (!cwd) {
      throw new Error('AppServerRunner.start: taskCtx.cwd 必填（session/create 的 workspacePath）。');
    }
    const conn = this._ensureConnection(cwd);
    const timeoutMs = taskCtx.timeoutMs ?? config.DEFAULTS.timeoutMs;
    const workspace = { workspacePath: cwd, workspaceKey: stableWorkspaceKey(cwd) };
    // model 等 per-session 设置经 runEnv.createParams 合入（spawn 模式的 HOME 池在此整体不存在）；
    // persistence:"immediate" 由 runner 固定携带（D4：可恢复 + session/list 可见，上游不可覆盖）
    const createParams = {
      workspace,
      mode: 'yolo',
      ...((taskCtx.runEnv && taskCtx.runEnv.createParams) || {}),
      persistence: 'immediate',
    };
    // D6 工具限制双来源并集（CLI deny ∪ frontmatter disallowedTools；allowlist 原样）
    this._applyCreateToolLimits(createParams, taskCtx);
    // D5 thinking：create 前连接级校验（在 done 异步体内执行），非法档位 warn
    // 跳过（任务不失败，P2 语义）。thinkingEffective 三态：undefined=未请求 /
    // string=生效档位 / null=非法跳过
    let thinkingEffective;
    const requestedThinking = createParams.thoughtLevel;
    if (requestedThinking !== undefined && typeof requestedThinking !== 'string') {
      delete createParams.thoughtLevel; // 非字符串请求值（防御）：不占 create 面
    }
    const exec = { kind: 'apc', sessionId: undefined };
    // setup 阶段的取消标记：cancel 在 create/subscribe/send 任一步之间到达都能落地
    const ctl = { cancelled: false, turn: null };
    const ctlTimeout = controlTimeout(timeoutMs);

    const done = (async () => {
      try {
        if (ctl.cancelled) throw new Error('cancelled');
        if (typeof createParams.thoughtLevel === 'string') {
          const verdict = await this._resolveThinking(conn, createParams.thoughtLevel);
          if (verdict.ok) {
            thinkingEffective = createParams.thoughtLevel;
          } else {
            stderrLog(`--thinking "${createParams.thoughtLevel}" 不在当前模型可用档位 `
              + `[${(verdict.available || []).join(', ')}] 内，跳过该参数（任务继续，跟随模型默认档）`);
            delete createParams.thoughtLevel;
            thinkingEffective = null;
          }
        }
        if (ctl.cancelled) throw new Error('cancelled');
        const created = await conn.request('session/create', createParams, { timeoutMs: ctlTimeout });
        const sessionId = extractCreatedSessionId(created);
        if (typeof sessionId !== 'string' || !sessionId) {
          throw new Error(`session/create 未返回 sessionId: ${JSON.stringify(created).slice(0, 300)}`);
        }
        exec.sessionId = sessionId; // 可变引用回填，record 持同一对象
        // 登记带 create model（D2 恢复序的 runtimeModel 目标解析主路径）
        this._sessions.set(sessionId, {
          workspace,
          chunks: [],
          lastUsage: undefined,
          closed: false,
          model: createParams.model && typeof createParams.model === 'object'
            ? { providerId: createParams.model.providerId, modelId: createParams.model.modelId }
            : undefined,
        });
        if (ctl.cancelled) throw new Error('cancelled');
        await conn.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }, { timeoutMs: ctlTimeout });
        if (ctl.cancelled) throw new Error('cancelled');
        const { sent, recovered } = await this._sendWithRecovery(conn, sessionId, String(prompt), { ctlTimeout });
        if (sent && sent.accepted === false) {
          throw new Error('session/send 返回 accepted:false（投递未被接受）');
        }
        if (ctl.cancelled) throw new Error('cancelled');
        ctl.turn = this._createTurn(sessionId, timeoutMs, conn, { recovered });
        return { ...(await ctl.turn.promise), thinking: thinkingEffective };
      } catch (err) {
        if (ctl.cancelled) {
          if (exec.sessionId) {
            conn.request('session/stop', { sessionId: exec.sessionId }, { timeoutMs: STOP_TIMEOUT_MS }).catch(() => {});
          }
          return { status: 'cancelled', sessionId: exec.sessionId, thinking: thinkingEffective };
        }
        const drift = classifyApcError(err);
        if (drift) {
          // D3 双落点：stderr 出声 + RunResult.errorKind（错误分类随结果上行，
          // record 物理落点由上层 _completeRun 透传）
          stderrLog(drift.hint);
          return { status: 'error', errorKind: drift.kind, error: drift.hint, sessionId: exec.sessionId, thinking: thinkingEffective };
        }
        if (err && err.branchB) {
          stderrLog(err.message); // 分支 B 同样双落点（stderr 取证 + error 文案上行）
          return { status: 'error', error: err.message, sessionId: exec.sessionId, thinking: thinkingEffective };
        }
        return { status: 'error', error: err && err.message, sessionId: exec.sessionId, thinking: thinkingEffective };
      }
    })();

    return {
      exec,
      cancel: () => {
        ctl.cancelled = true;
        if (ctl.turn) ctl.turn.cancel();
      },
      done,
    };
  }

  /**
   * 续聊一轮：session/send 后等同一会话的下一轮终态（判定同 start）。
   * A5 单点：send-while-running 语义未实测——本 runner 内同会话仍有进行中的一轮
   * 时保守报 busy；W3 真机探针若确认服务端接受 running 投递，只改这里。
   * @param {object} exec record.exec（{kind:'apc', sessionId}）
   * @param {string} message 续聊消息
   * @param {object} [opts] {timeoutMs?}
   * @returns {Promise<RunResult>}
   */
  async resume(exec, message, opts = {}, onHandle) {
    if (!exec || exec.kind !== 'apc' || typeof exec.sessionId !== 'string' || !exec.sessionId) {
      throw new Error(
        'AppServerRunner.resume: 需要 apc 句柄（exec.kind==="apc" 且 exec.sessionId 已回填）。'
        + `收到 ${JSON.stringify(exec && { kind: exec.kind, hasSessionId: Boolean(exec.sessionId) })}。`
        + '恢复指引：等待首轮 done（sessionId 回填）后再续聊；跨 runner 的句柄不可混用。'
      );
    }
    if (message == null || message === '') {
      throw new Error('AppServerRunner.resume: message 必填。');
    }
    const timeoutMs = opts.timeoutMs ?? config.DEFAULTS.timeoutMs;
    // A5：busy 保守分支（单点修改位置）
    if (this._turns.has(exec.sessionId)) {
      return {
        status: 'error',
        sessionId: exec.sessionId,
        error: `会话 ${exec.sessionId} 仍有进行中的一轮（busy）。恢复指引：等本轮 done 后再续聊。`,
      };
    }
    // 跨重启恢复的句柄本 runner 未必认识：补登记以便 chunk 聚合与 alive 查询
    if (!this._sessions.has(exec.sessionId)) {
      this._sessions.set(exec.sessionId, { workspace: null, chunks: [], lastUsage: undefined, closed: false });
    }
    const conn = this._ensureConnection();
    try {
      const { sent, recovered } = await this._sendWithRecovery(conn, exec.sessionId, String(message), { ctlTimeout: controlTimeout(timeoutMs) });
      if (sent && sent.accepted === false) {
        return {
          status: 'error',
          sessionId: exec.sessionId,
          error: 'session/send 返回 accepted:false（会话可能不接受投递或已失效）。恢复指引：稍后重试或重新 start。',
        };
      }
      // recovered：本轮经 -32004 恢复序重试送达——终态窗口耗尽走分支 B（D2 ④）
      const turn = this._createTurn(exec.sessionId, timeoutMs, conn, { recovered });
      // S-6① 接线：把 turn.cancel 经 onHandle 暴露给上层（manager 的 handles
      // 表），cancel(action) 即可中止在飞轮（finish cancelled + session/stop），
      // 不再空等 timeoutMs 白耗 token
      if (typeof onHandle === 'function') {
        onHandle({ cancel: () => turn.cancel() });
      }
      return await turn.promise;
    } catch (err) {
      const drift = classifyApcError(err);
      if (drift) {
        stderrLog(drift.hint); // D3 双落点：stderr + RunResult.errorKind（同 start）
        return { status: 'error', errorKind: drift.kind, sessionId: exec.sessionId, error: drift.hint };
      }
      if (err && err.branchB) {
        stderrLog(err.message); // 分支 B 双落点（同 start）
        return { status: 'error', sessionId: exec.sessionId, error: err.message };
      }
      // 其余错误如实上报（-32010 busy 等已有语境；-32004 已被恢复序消费，不再直达此处）
      return { status: 'error', sessionId: exec.sessionId, error: err && err.message };
    }
  }

  /**
   * 探活：连接进程活着 && session/list 能看到该 id；list 失败/形态对不上时保守
   * 返回 true（A6 单点）。异步实现（list 是一次协议往返），上层 await 即可。
   */
  async alive(exec) {
    if (!exec || exec.kind !== 'apc' || typeof exec.sessionId !== 'string' || !exec.sessionId) return false;
    const conn = this._conn;
    if (!conn || conn.exited) return false;
    try {
      const session = this._sessions.get(exec.sessionId);
      const params = session && session.workspace
        ? { workspace: session.workspace, limit: 200 }
        : { limit: 200 };
      const result = await conn.request('session/list', params, { timeoutMs: 3_000 });
      const list = result && result.sessions;
      if (!Array.isArray(list)) return true; // 形态对不上：保守按存在
      return list.some((s) => s && (s.sessionId === exec.sessionId || s.id === exec.sessionId));
    } catch {
      return true; // list 失败：保守按存在（契约：降级判断归上层）
    }
  }

  /** 收尾：close 本 runner 登记的全部会话（best-effort）→ 杀进程链。 */
  async shutdown() {
    const conn = this._conn;
    if (!conn) return;
    this._conn = null;
    const targets = [...this._sessions.entries()].filter(([, s]) => !s.closed);
    await Promise.allSettled(targets.map(([sid]) => conn.request('session/close', { sessionId: sid }, { timeoutMs: 1_500 })
      .then(() => { const s = this._sessions.get(sid); if (s) s.closed = true; })));
    await conn.shutdown();
    // 进程退出本应经 onClose 失败所有 turn，这里兜底一次（幂等）
    this._failAllTurns('runner shutdown');
  }
}

module.exports = AppServerRunner;
module.exports.createFrameDispatcher = createFrameDispatcher;
module.exports.interpretEvent = interpretEvent;
module.exports.RUNTIME_PREFERENCES = RUNTIME_PREFERENCES;
module.exports.classifyApcError = classifyApcError;
module.exports.branchBMessage = branchBMessage;
module.exports.buildRuntimeModel = buildRuntimeModel;
module.exports.DRIFT_SMOKE_CMD = DRIFT_SMOKE_CMD;
module.exports.DRIFT_FALLBACK_ENV = DRIFT_FALLBACK_ENV;
module.exports.extractAssistantText = extractAssistantText;
module.exports.extractReadUsage = extractReadUsage;
module.exports.extractThoughtLevels = extractThoughtLevels;
module.exports.cleanToolNames = cleanToolNames;
