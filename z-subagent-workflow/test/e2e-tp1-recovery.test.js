'use strict';

/**
 * TP-1 真机探针（设计 docs/design/zsw-appserver-promotion-design.md §3.3 D2 / 实施计划 F0）：
 * 恢复序分支判定——驱逐（A）/ 崩溃（B）/ 多会话崩溃恢复（C）三线 + 四条 -32031 清除候选。
 *
 * ## 探针结论（真机实测 2026-08-29，zcode.cjs + GLM-5.3-Flash，A/B/C 三线一次全绿；原始帧证据见 TP1_RESULTS 输出）
 *
 * ### 判定 1：驱逐线是否触发 restoreWarning —— 是，两线无差别
 * - A 线（真驻留池驱逐，high_water_lru 洪泛，virgin 引擎）：驱逐后 send → -32004 ✓；
 *   **plain resume 返回的快照里 `projection.lastError.message` 即为「历史任务使用的模型已不可用…」
 *   （warning 在 resume 应答中直接可见），随后 plain send → -32031
 *   ZCODE_RUNTIME_MODEL_UNAVAILABLE**。「驱逐天然自愈」假设被否证——驱逐与崩溃走同一 kbt 冷
 *   恢复路径，D2 不存在「驱逐自愈 + 崩溃报错」的分支划分，**恢复序 resume 步必须携带 runtimeModel**。
 * - B 线（SIGKILL 崩溃）同形态复现：send 先 -32004，plain resume 快照同挂 warning，send → -32031。
 *
 * ### 判定 2：四条清除候选 —— ①②③可用，④不可用
 * | 候选 | 请求形态（实测可用版） | 结果 |
 * |------|------------------------|------|
 * | ① send 直传 runtimeModel | `session/send {sessionId, content, runtimeModel}` | **可用**：warning 已设的会话一次投递即 ok + turn.terminal 可达（send handler 在硬闸之前应用 runtimeModel 并清 warning） |
 * | ② resume 带 runtimeModel | `session/resume {sessionId, runtimeModel}`（**不是 create**；resume params schema 原生含 runtimeModel?，create 是新会话面与恢复无关） | **可用且最优**：warning 根本不设置（virgin 级归因由 A 线 pool-evict 臂实证；B 线该臂跑在 ③ 接种之后，为一致性证据） |
 * | ③ session/updateRuntimeModelConfig | `{sessionId, runtimeModel}`（applyModelSelection 缺省 true） | **可用**：返回 `{appliedModelRuntimeRevision, changed:true}`，随后 plain send ok + terminal |
 * | ④ registry 就绪等待 | plain resume → 等 12s → plain send | **不可用**：仍 -32031。独立无头引擎没有客户端 push workspace/updateProviderRegistry 的时机，registry arrival 永不到来——等待线从 F2 恢复序中删除 |
 *
 * runtimeModel 请求形态（schema `Of` strict，逐字段实测通过；provider 需忠实携带传输配置，
 * 因为 fL 会把它注册进 workspaceModelCatalogs、成为后续 turn 的 overlay 配置来源）：
 * `{revision:string, generatedAt:epochMs, model:{providerId,modelId}, provider:{providerId, kind:"anthropic"|"openai-compatible"|"openai", label?, source:"custom", baseURL, apiKey:{source:"inline",value}, models:[{modelId},…≥1]}, thoughtLevel?}`——构造源码 buildRuntimeModel()（从 v2 config 读真实凭据，日志脱敏）。
 *
 * ### 判定 2b：引擎进程级「接种」效应（F2 必须知晓的语义）
 * runtimeModel 一旦在引擎进程内被应用（fL 注册 provider 进 workspaceModelCatalogs），
 * **同进程后续所有 plain resume 不再设 warning**（实测：接种后 plain resume 快照 warningTrace=null，
 * plain send 直接成功）。该状态随进程死亡消失（kill 后重启即回 virgin）。据此：
 * 「第一次恢复带 runtimeModel，后续同进程恢复可省」是引擎侧事实，但 F2 恢复序应**无条件每次带**
 * ——runner 无法可靠得知引擎进程是否已被接种（进程可能被外部重启），且 runtimeModel 构造成本为零。
 *
 * ### 判定 3：C 线多会话连坐观察
 * - 并发臂（同连接 pipelined 两路 resume+send 同时发起）：d1、d2 **双双 -32031，连坐成立**。
 * - 串行对照臂（一路 resume+send 落定再走下一路）：d3、d4 **同样双双 -32031——串行化不能避免
 *   -32031**（串行互斥防的是「恢复风暴」压垮刚重启的引擎，不是 warning 本身；warning 的解只有
 *   runtimeModel）。串行 + resume{runtimeModel} 组合：d3、d4 均 ok + turn.terminal 可达。
 *
 * ### 附加实证（超出预期但影响 F1/F2 边界条件）
 * 1. **订阅即免驱逐**：session/subscribe 置 record.legacyStreamSubscribed=true，驻留池 isEligible
 *    要求 !hasLegacySubscriber（源码）/洪泛实测订阅会话不被驱逐——zsw runner 现实形态（start 后
 *    subscribe 常挂）下空闲驱逐几乎不可能命中，-32004 的主来源是进程死亡与 session/close。
 * 2. **titleGenerationEnabled 缺省开会话不可驱逐**：首轮完成后标题生成的后台工作使
 *    hasResidencyBlockingWork=true（源码）/首次洪泛 16+4 会话全部不被驱逐（实测）；显式
 *    `create {titleGenerationEnabled:false}` 后洪泛立即生效（实测驱逐点=18→8，high_water_lru）。
 * 3. 驱逐加速手段结论：idleTimeoutMs 无 env/CLI/config 覆盖面（仅 GUI host 进程内参数），
 *    high_water 洪泛（创建 16+ 个 immediate 不订阅会话）是秒级触发真驱逐的可靠手段。
 * 4. resume 应答快照的 `projection.lastError.message` 是 restoreWarning 的可观测面——恢复序可在
 *    resume 应答上直接断言 warning 是否存在，无需靠 send 失败兜底。
 * - 源码静态佐证（zcode.cjs bundle 逆向，与实测互相印证）：restoreWarning 设置条件
 *   `_ = 冷恢复 && params 无 runtimeModel && 工作区模型目录无该模型目标`（createRecord/p6i）；
 *   send 硬闸在 runtimeModel 应用之后；订阅置 legacyStreamSubscribed 免驱逐。
 *
 * ## 运行方式（真机，烧 token，绝不进 CI——CI find 已排除 e2e*.test.js，且本文件默认全 skip）
 *
 *   cd z-subagent-workflow
 *   ZSW_TP1_SCENARIOS=A node --test test/e2e-tp1-recovery.test.js   # 单线
 *   ZSW_TP1_SCENARIOS=A,B,C node --test test/e2e-tp1-recovery.test.js
 *   node --test --test-name-pattern "TP1-A" test/e2e-tp1-recovery.test.js   # 等价 name-pattern 面
 *
 * env：
 *   ZSW_TP1_SCENARIOS   A/B/C 逗号分隔；未设 = 全部 skip（CI 安全默认）
 *   ZSW_E2E_MODEL       真机模型（默认 GLM-5.3-Flash——最便宜档，成本纪律）
 *   ZSW_TP1_FLOOD_ONLY  =1 时 A 线洪泛驱逐失败不进入 10min 真实空闲等待（默认等待，可 background 跑）
 *
 * 成本纪律（极小任务「回复 ok」级，GLM-5.3-Flash 实测三线全跑约 20 次引擎往返 / 90s 墙钟，
 * 其中 6 次为预期 -32031/-32004 失败往返零 token 消耗）：
 * A≈3 次模型轮（2 基线 + 1 候选②验证），B≈7（4 基线 + 3 候选验证，④失败不消耗），
 * C≈6（4 基线 + 2 组合验证，并发/串行臂全部预期失败零消耗）。
 * 隔离 HOME / 工程目录放 os.tmpdir()，after() 尽力清理；不碰真实 ~/.zcode（v2 config 只读）。
 */

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-tp1-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsw-root'); // config.zswRoot() 运行期读 env，先设再 require

const config = require('../lib/config');
const driver = require('../lib/driver');
const AppServerRunner = require('../lib/runner-appserver');

const MODEL = process.env.ZSW_E2E_MODEL || 'GLM-5.3-Flash';
const MODEL_REF = MODEL.includes('/') ? MODEL : `builtin:bigmodel-coding-plan/${MODEL}`;
const PROVIDER_ID = MODEL_REF.slice(0, MODEL_REF.lastIndexOf('/'));
const MODEL_ID = MODEL_REF.slice(MODEL_REF.lastIndexOf('/') + 1);
const FLOOD_ONLY = process.env.ZSW_TP1_FLOOD_ONLY === '1';
const IDLE_WAIT_MS = Number(process.env.ZSW_TP1_IDLE_WAIT_MS || 660_000); // 洪泛失败时真实等驱逐的预算

const TINY_TASK = '直接回复文本：ok。禁止使用任何工具，禁止搜索。';
const TURN_TIMEOUT_MS = 120_000;
const REQ_TIMEOUT_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 结果记录

/** 探针结论记录：如实记录，不因「引擎行为与预期不同」而 fail（那正是要测的未知）。 */
const RESULTS = { A: { steps: [] }, B: { steps: [] }, C: { steps: [] } };
function rec(line, event, detail) {
  const entry = { at: new Date().toISOString(), event, ...detail };
  RESULTS[line].steps.push(entry);
  console.error(`[TP1][${line}] ${event} ${JSON.stringify(detail)}`);
}

// ---------------------------------------------------------------- 引擎封装

const ENGINES = new Set();

/**
 * 一个探针引擎 = 独立隔离 HOME + 独立 app-server 子进程 + 裸协议请求面。
 * 复用 AppServerRunner 的连接层（反向请求应答 / NDJSON 分帧与 e2e E7 同源），
 * 之上直接驱动协议（探针需要 create 不 subscribe、resume 带 runtimeModel 等 runner 外形态）。
 */
function makeEngine(line, name) {
  const home = path.join(TMP, `${line.toLowerCase()}-${name}-home`);
  driver.bootstrapIsolatedHome(home, MODEL_REF, { allProviders: true });
  const proj = path.join(TMP, `${line.toLowerCase()}-${name}-proj`);
  fs.mkdirSync(proj, { recursive: true });
  const engine = {
    line, name, home, proj,
    stderr: '',
    frames: [],            // {method, sessionId, kind} 环形证据
    runner: null,
    conn() { return this.runner && this.runner._conn; },
  };
  engine.boot = () => {
    engine.runner = engine.runner || new AppServerRunner({ homeDir: home });
    const conn = engine.runner._ensureConnection(proj);
    conn.onPush((method, params) => {
      if (engine.frames.length > 500) engine.frames.shift();
      engine.frames.push({
        method,
        sessionId: params && typeof params === 'object' ? params.sessionId : undefined,
        kind: params && typeof params === 'object' ? params.kind : undefined,
      });
    });
    const child = conn._child;
    if (child && child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => {
        engine.stderr += d;
        if (engine.stderr.length > 400_000) engine.stderr = engine.stderr.slice(-200_000);
      });
    }
    return conn;
  };
  engine.kill = async () => {
    const conn = engine.conn();
    assert.ok(conn && conn._child, 'kill 前提：引擎子进程存在');
    conn._child.kill('SIGKILL');
    await conn._waitExit();
    rec(line, 'engine-killed', { name });
  };
  engine.rebuild = () => engine.boot(); // 旧连接已 exited → _ensureConnection 重建并重挂 collector
  engine.req = (method, params, opts = {}) =>
    engine.conn().request(method, params, { timeoutMs: REQ_TIMEOUT_MS, ...opts });
  engine.shutdown = () => engine.runner.shutdown().catch(() => {});
  ENGINES.add(engine);
  return engine;
}

/** 引擎 stderr 中与驻留池/restoreWarning 相关的证据行（收尾取证）。 */
function residencyEvidence(engine) {
  const hits = [];
  for (const raw of engine.stderr.split('\n')) {
    if (/resident_deactivat|restore_warning|restoreWarning|runtime_model_unavailable/i.test(raw)) {
      hits.push(raw.trim().slice(0, 300));
    }
  }
  return hits.slice(-20);
}

// ---------------------------------------------------------------- 协议动作

/** 深搜 resume/subscribe 返回里的 restoreWarning 踪迹（定位 warning 暴露面）。 */
function findWarning(result, path = '', depth = 0) {
  if (result == null || depth > 6) return null;
  if (typeof result === 'string') {
    return /ZCODE_RUNTIME_MODEL_UNAVAILABLE|历史任务使用的模型/.test(result) ? { path, sample: result.slice(0, 120) } : null;
  }
  if (typeof result !== 'object') return null;
  for (const [k, v] of Object.entries(result)) {
    const hit = findWarning(v, path ? `${path}.${k}` : k, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const wsOf = (dir) => ({ workspacePath: dir, workspaceKey: 'ws-' + crypto.createHash('sha256').update(dir).digest('hex').slice(0, 16) });

async function createSession(engine, { subscribe = true, titleGenerationEnabled } = {}) {
  const params = {
    workspace: wsOf(engine.proj),
    mode: 'yolo',
    model: { providerId: PROVIDER_ID, modelId: MODEL_ID },
    persistence: 'immediate',
  };
  if (titleGenerationEnabled !== undefined) params.titleGenerationEnabled = titleGenerationEnabled;
  const created = await engine.req('session/create', params);
  const sessionId = created && created.session && created.session.sessionId;
  assert.ok(typeof sessionId === 'string' && sessionId, `session/create 未返回 sessionId: ${JSON.stringify(created).slice(0, 200)}`);
  if (subscribe) {
    await engine.req('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
  }
  return sessionId;
}

/** 带响应文本的终态等待：直接订阅推送流，terminal/response 二选一即返回。 */
function waitTurnDone(engine, sessionId, timeoutMs = TURN_TIMEOUT_MS) {
  const conn = engine.conn();
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const handler = (method, params) => {
      if (!params || params.sessionId !== sessionId) return;
      let signal = null;
      let response = null;
      if (method === 'v4/telemetry/event' && params.kind === 'turn.terminal') signal = 'turn.terminal';
      if (method === 'session/event' && params.payload && typeof params.payload === 'object') {
        if (typeof params.payload.response === 'string' && params.payload.response) {
          signal = signal || 'session/event.response';
          response = params.payload.response;
        } else if (params.payload.stopReason === 'stop' && typeof params.payload.content === 'string') {
          signal = signal || 'session/event.stop';
          response = params.payload.content;
        }
      }
      if (signal) {
        cleanup();
        resolve({ signal, response: response || null });
      }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`等待 turn 终态超时（${timeoutMs}ms）`)); }, timeoutMs);
    function cleanup() { clearTimeout(timer); const i = conn._pushHandlers.indexOf(handler); if (i >= 0) conn._pushHandlers.splice(i, 1); }
    conn.onPush(handler);
    if (Date.now() > deadline) { cleanup(); reject(new Error('deadline 已过')); }
  });
}

/** 极小任务一轮：send → 等终态 → 返回 {sendResult, done}。首_TURN 自带限流重试。 */
async function runTinyTurn(engine, sessionId, { attempts = 2 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const done = waitTurnDone(engine, sessionId);
    let sent;
    try {
      sent = await engine.req('session/send', { sessionId, content: TINY_TASK });
    } catch (err) {
      lastErr = err;
      if (i + 1 < attempts) { await sleep(20_000); continue; }
      throw err;
    }
    try {
      const doneRes = await done;
      return { sent, done: doneRes };
    } catch (err) {
      lastErr = err;
      // 超时可能是限流退避：stop 清场后重试
      await engine.req('session/stop', { sessionId }).catch(() => {});
      if (i + 1 < attempts) { await sleep(20_000); continue; }
      throw lastErr;
    }
  }
  throw lastErr || new Error('unreachable');
}

/** 驱逐探针：session/read 走 requireSession，被驱逐/未驻留即 -32004，且无任何副作用。 */
async function isResident(engine, sessionId) {
  try {
    await engine.req('session/read', { sessionId }, { timeoutMs: 8_000 });
    return true;
  } catch (err) {
    if (err && err.code === -32004) return false;
    throw err;
  }
}

/** send 的结构化结果：{kind:'ok'|'error', code?, message} */
async function trySend(engine, sessionId, extra = {}) {
  try {
    const sent = await engine.req('session/send', { sessionId, content: TINY_TASK, ...extra });
    return { kind: 'ok', sent };
  } catch (err) {
    return { kind: 'error', code: err && err.code, message: String((err && err.message) || err).slice(0, 300) };
  }
}

/** 记录一次 send 结果；若为 ok 则顺路等终态并记录（区分 send accepted 与终态可达）。 */
async function sendAndRecord(line, engine, sessionId, tag, extra = {}, { waitDone = true } = {}) {
  const res = await trySend(engine, sessionId, extra);
  rec(line, `send:${tag}`, { result: res.kind, code: res.code, message: res.message || undefined });
  if (res.kind !== 'ok' || !waitDone) return { res, done: null };
  try {
    const done = await waitTurnDone(engine, sessionId);
    rec(line, `terminal:${tag}`, { signal: done.signal, response: (done.response || '').slice(0, 120) || '(空)' });
    return { res, done };
  } catch (err) {
    rec(line, `terminal:${tag}`, { signal: 'TIMEOUT', error: String(err.message).slice(0, 200) });
    await engine.req('session/stop', { sessionId }).catch(() => {});
    return { res, done: null };
  }
}

// ---------------------------------------------------------------- runtimeModel 构造（候选①②③共用）

/**
 * 依 v2 config 构造协议 runtimeModel（schema Of strict：
 * {revision, generatedAt(epochMs), model{providerId,modelId}, provider{…, models[]≥1}, thoughtLevel?}）。
 * provider 条目忠实携带 baseURL + inline apiKey（fL 会把它注册进 workspaceModelCatalogs，
 * catalog overlay 是后续 turn 的传输配置来源——缺凭据会让恢复后的 turn 挂在 provider 层）。
 */
function buildRuntimeModel() {
  let v2 = null;
  try { v2 = JSON.parse(fs.readFileSync(config.V2_CONFIG_PATH, 'utf8')); } catch { v2 = null; }
  const entry = v2 && v2.provider && v2.provider[PROVIDER_ID];
  if (!entry || !entry.options || !entry.options.apiKey) {
    throw new Error(`v2 config 无 ${PROVIDER_ID} 的可用 provider 条目（含 apiKey），无法构造 runtimeModel`);
  }
  const modelIds = Object.keys(entry.models || {});
  const models = (modelIds.length ? modelIds : [MODEL_ID]).map((id) => ({ modelId: id }));
  return {
    revision: `zsw-tp1-${Date.now()}`,
    generatedAt: Date.now(),
    model: { providerId: PROVIDER_ID, modelId: MODEL_ID },
    provider: {
      providerId: PROVIDER_ID,
      kind: entry.kind || 'anthropic',
      label: entry.name || PROVIDER_ID,
      source: 'custom',
      baseURL: entry.options.baseURL,
      apiKey: { source: 'inline', value: entry.options.apiKey }, // 仅回传引擎，不落日志
      models,
    },
  };
}

function describeRuntimeModel(rt) {
  return {
    revision: rt.revision,
    model: rt.model,
    provider: { ...rt.provider, apiKey: { source: rt.provider.apiKey.source, value: '<redacted>' } },
  };
}

// ---------------------------------------------------------------- 场景注册（默认全 skip）

const SCENARIOS = new Set(
  (process.env.ZSW_TP1_SCENARIOS || '')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
);

function defineScenario(name, opts, fn) {
  const full = `TP1-${name} 真机探针（烧 token）`;
  if (SCENARIOS.has(name)) {
    test(full, { timeout: 570_000, ...opts }, fn);
  } else {
    test(full, { skip: '未纳入 ZSW_TP1_SCENARIOS（真机探针默认跳过，防 CI 误烧 token）' }, () => {});
  }
}

// ---------------------------------------------------------------- A 线：同进程驱逐

defineScenario('A', {}, async () => {
  const engine = makeEngine('A', 'evict');
  try {
    engine.boot();

    // --- A2 先行（ virgin 引擎上测真驻留池驱逐，避免 A1 的 runtimeModel resume 把
    //     workspaceModelCatalogs「接种」后污染 A2 的 plain-resume 归因）
    // titleGenerationEnabled:false：排除标题生成后台工作把会话钉成 ineligible 的干扰
    const sb = await createSession(engine, { subscribe: false, titleGenerationEnabled: false });
    rec('A', 'session-created', { sessionId: sb, subscribe: false, titleGenerationEnabled: false });
    const base2 = await runTinyTurn(engine, sb);
    rec('A', 'baseline-turn(pool-evict-target)', { signal: base2.done.signal });
    assert.equal(await isResident(engine, sb), true, '洪泛前 sb 应驻留');

    const floodIds = [];
    for (let i = 0; i < 16; i++) {
      floodIds.push(await createSession(engine, { subscribe: false, titleGenerationEnabled: false }));
    }
    rec('A', 'flood-created', { count: floodIds.length });
    await sleep(3_000); // create release 后 rebalance 异步跑，稍等

    let residencyMap = await Promise.all(
      [sb, floodIds[0], floodIds[4], floodIds[15]].map(async (sessionId) => ({ sessionId, resident: await isResident(engine, sessionId) }))
    );
    let evicted = !residencyMap.find((r) => r.sessionId === sb).resident;
    rec('A', 'high-water-eviction', {
      evicted,
      floodTotal: floodIds.length,
      residencyMap,
      residentCountProbe: 'session/read(requireSession)',
    });
    if (!evicted) rec('A', 'stderr-tail', { tail: engine.stderr.slice(-1200) });

    if (!evicted && !FLOOD_ONLY) {
      rec('A', 'idle-wait-fallback', { budgetMs: IDLE_WAIT_MS });
      const deadline = Date.now() + IDLE_WAIT_MS;
      while (!evicted && Date.now() < deadline) {
        await sleep(30_000);
        evicted = !(await isResident(engine, sb));
      }
      rec('A', 'idle-wait-result', { evicted });
    }

    if (evicted) {
      const sendEvicted = await trySend(engine, sb);
      rec('A', 'send-after-pool-evict', { result: sendEvicted.kind, code: sendEvicted.code, message: sendEvicted.message });
      assert.equal(sendEvicted.code, -32004, '驻留池驱逐后直接 send 应 -32004');
      // 核心判定（virgin catalog）：驱逐后 plain resume → plain send 是否 -32031
      const resume3 = await engine.req('session/resume', { sessionId: sb });
      rec('A', 'resume:plain(pool-evict,virgin)', { keys: Object.keys(resume3 || {}), warningTrace: findWarning(resume3) });
      await sendAndRecord('A', engine, sb, 'pool-evict+plain-resume+plain-send(virgin)');
      // 候选②驱逐线形态：close → resume 带 runtimeModel → plain send
      await engine.req('session/close', { sessionId: sb });
      const rt = buildRuntimeModel();
      await engine.req('session/resume', { sessionId: sb, runtimeModel: rt });
      const a2b = await sendAndRecord('A', engine, sb, 'pool-evict+runtimeModel-resume+plain-send');
      assert.ok(a2b.done, '驱逐线 resume 带 runtimeModel 后 send 应可达终态（F2 形态自检）');
    } else {
      rec('A', 'pool-eviction-not-triggered', { note: '洪泛与空闲等待都未驱逐（观察项）' });
    }

    // --- A1：close 退化驱逐（进程存活、会话出内存）。此时 catalog 已被 A2 的
    //     resume{runtimeModel} 接种——plain resume 预期不再挂 -32031（接种效应留证），
    //     -32031 的 close 线原始证据由历次 virgin 引擎运行提供（见头注）。
    const sa = await createSession(engine, { subscribe: true });
    rec('A', 'session-created', { sessionId: sa, subscribe: true });
    const base = await runTinyTurn(engine, sa);
    rec('A', 'baseline-turn-done', { signal: base.done.signal, response: (base.done.response || '').slice(0, 80) });
    assert.ok((base.done.response || '').trim().length > 0, '基线轮必须有非空响应（探针环境自检）');

    await engine.req('session/close', { sessionId: sa });
    assert.equal(await isResident(engine, sa), false, 'session/close 后会话应不在内存');
    const evictSend = await trySend(engine, sa);
    rec('A', 'send-after-evict', { result: evictSend.kind, code: evictSend.code, message: evictSend.message });
    assert.equal(evictSend.code, -32004, `驱逐后直接 send 应 -32004，实际 ${JSON.stringify(evictSend)}`);

    const resume1 = await engine.req('session/resume', { sessionId: sa });
    rec('A', 'resume:plain(post-vaccination)', { keys: Object.keys(resume1 || {}), warningTrace: findWarning(resume1) });
    await sendAndRecord('A', engine, sa, 'close+plain-resume+plain-send(post-vaccination)');

    rec('A', 'residency-evidence', { stderrLines: residencyEvidence(engine) });
  } finally {
    await engine.shutdown();
  }
});

// ---------------------------------------------------------------- B 线：崩溃恢复 + 四候选

defineScenario('B', {}, async () => {
  const engine = makeEngine('B', 'crash');
  try {
    engine.boot();

    // --- 崩溃前：4 个会话各跑一轮极小任务（每个候选独立会话，避免清除效果互相污染）
    const sessions = {};
    for (const key of ['c1', 'c2', 'c3', 'c4']) {
      sessions[key] = await createSession(engine, { subscribe: true });
      const r = await runTinyTurn(engine, sessions[key], { attempts: 2 });
      rec('B', `prekill-turn:${key}`, { sessionId: sessions[key], signal: r.done.signal });
    }

    // --- kill -9 引擎 → 重建连接
    await engine.kill();
    engine.rebuild();
    rec('B', 'engine-rebuilt', {});

    // 跨进程 list 可见性顺带留证（P4 已证，这里作恢复序前置证据）
    const list = await engine.req('session/list', { limit: 50 });
    rec('B', 'list-after-restart', { count: (list.sessions || []).length, ids: (list.sessions || []).map((s) => s.sessionId) });

    const rt = buildRuntimeModel();

    // 候选执行顺序刻意安排（归因纪律）：凡 plain resume 测量臂（C1a 复现 / C4 等待 / C2 前置）
    // 必须在任何 runtimeModel 应用之前跑——workspaceModelCatalogs 是引擎进程级状态，一旦被
    // runtimeModel「接种」（fL 注册 provider），后续 plain resume 根本不会再设 restoreWarning，
    // 测量即失效。rt 臂（C3/C1b）放最后。

    // --- C1a：崩溃复现（virgin catalog）：resume plain → send plain → 预期 -32031
    {
      const sid = sessions.c1;
      const sendDirect = await trySend(engine, sid);
      rec('B', 'send-after-crash-no-resume', { result: sendDirect.kind, code: sendDirect.code, message: sendDirect.message });
      assert.equal(sendDirect.code, -32004, '崩溃后未 resume 直接 send 应 -32004');
      const resume = await engine.req('session/resume', { sessionId: sid });
      rec('B', 'resume:plain(c1,virgin)', { keys: Object.keys(resume || {}), warningTrace: findWarning(resume) });
      await sendAndRecord('B', engine, sid, 'c1-plain-resume+plain-send(复现判定)');
    }

    // --- C4：候选④（plain resume → 等待若干秒（registry 就绪假设）→ plain send；virgin）
    {
      const sid = sessions.c4;
      await engine.req('session/resume', { sessionId: sid });
      rec('B', 'registry-wait', { waitMs: 12_000 });
      await sleep(12_000);
      await sendAndRecord('B', engine, sid, 'c4-候选④wait-then-send', {}, { waitDone: false });
    }

    // --- C2：候选③（plain resume（virgin，warning 已设）→ updateRuntimeModelConfig → send）
    {
      const sid = sessions.c2;
      await engine.req('session/resume', { sessionId: sid });
      let upd = { kind: 'error', message: 'not-tried' };
      try {
        const r = await engine.req('session/updateRuntimeModelConfig', { sessionId: sid, runtimeModel: rt });
        upd = { kind: 'ok', result: JSON.stringify(r).slice(0, 300) };
      } catch (err) {
        upd = { kind: 'error', code: err && err.code, message: String(err.message).slice(0, 300) };
      }
      rec('B', 'updateRuntimeModelConfig', { ...upd, requestShape: { sessionId: sid, runtimeModel: describeRuntimeModel(rt) } });
      await sendAndRecord('B', engine, sid, 'c2-候选③after-updateRuntimeModelConfig');
    }

    // --- C3：候选②（resume 带 runtimeModel——纯形态：不做 plain resume）。
    //     注意此时 catalog 已被 C2 的 ③ 接种，本臂证据为「与接种效应一致」级；
    //     virgin 级归因由 A 线 pool-evict+runtimeModel-resume 臂提供。
    {
      const sid = sessions.c3;
      const resume = await engine.req('session/resume', { sessionId: sid, runtimeModel: rt });
      rec('B', 'resume:with-runtimeModel(c3,post-vaccination)', { keys: Object.keys(resume || {}), warningTrace: findWarning(resume) });
      const c3 = await sendAndRecord('B', engine, sid, 'c3-候选②runtimeModel-resume+plain-send');
      assert.ok(c3.done, '候选②：resume 带 runtimeModel 后 send 应可达终态');
    }

    // --- C1b：候选①（send 直传 runtimeModel；c1 的 warning 已在 C1a 设置，本臂测「清已在的 warning」）
    {
      const sid = sessions.c1;
      await sendAndRecord('B', engine, sid, 'c1-候选①send直传runtimeModel', { runtimeModel: rt });
    }

    rec('B', 'residency-evidence', { stderrLines: residencyEvidence(engine) });
  } finally {
    await engine.shutdown();
  }
});

// ---------------------------------------------------------------- C 线：多会话崩溃恢复（连坐观察）

defineScenario('C', {}, async () => {
  const engine = makeEngine('C', 'multi');
  try {
    engine.boot();

    // 4 个会话：D1/D2 = 并发臂，D3/D4 = 串行对照臂
    const d = {};
    for (const key of ['d1', 'd2', 'd3', 'd4']) {
      d[key] = await createSession(engine, { subscribe: true });
      const r = await runTinyTurn(engine, d[key], { attempts: 2 });
      rec('C', `prekill-turn:${key}`, { sessionId: d[key], signal: r.done.signal });
    }

    await engine.kill();
    engine.rebuild();

    // --- 并发臂：两路 resume→send 同时发起（同一连接 pipelined，请求仍逐个进引擎处理链——
    //     这正是 runner 现实拓扑下的「恢复风暴」形态）
    {
      const flow = (key) => (async () => {
        const sid = d[key];
        await engine.req('session/resume', { sessionId: sid });
        return { key, sid, send: await trySend(engine, sid) };
      })();
      const t0 = Date.now();
      const both = await Promise.allSettled([flow('d1'), flow('d2')]);
      for (const p of both) {
        if (p.status === 'fulfilled') {
          rec('C', 'concurrent-resume+send', { key: p.value.key, elapsedMs: Date.now() - t0, send: { result: p.value.send.kind, code: p.value.send.code, message: p.value.send.message } });
        } else {
          rec('C', 'concurrent-resume+send', { elapsedMs: Date.now() - t0, rejected: String(p.reason).slice(0, 200) });
        }
      }
    }

    // --- 串行对照臂：一路恢复完成（含 send 结果落定）再走下一路
    {
      for (const key of ['d3', 'd4']) {
        const sid = d[key];
        const t0 = Date.now();
        await engine.req('session/resume', { sessionId: sid });
        const send = await trySend(engine, sid);
        rec('C', 'serial-resume+send', { key, elapsedMs: Date.now() - t0, send: { result: send.kind, code: send.code, message: send.message } });
      }
    }

    // --- 补充：串行臂若第一路已可清除（候选②形态），验证串行化+runtimeModel 的组合效果
    //     （D2 互斥的真实价值 = 配合 runtimeModel 恢复序逐路成功，而非避免 -32031）
    {
      const rt = buildRuntimeModel();
      for (const key of ['d3', 'd4']) {
        const sid = d[key];
        await engine.req('session/close', { sessionId: sid });
        await engine.req('session/resume', { sessionId: sid, runtimeModel: rt });
        await sendAndRecord('C', engine, sid, `serial+runtimeModel:${key}`);
      }
    }

    rec('C', 'residency-evidence', { stderrLines: residencyEvidence(engine) });
  } finally {
    await engine.shutdown();
  }
});

// ---------------------------------------------------------------- 收尾

process.on('exit', () => {
  // 结果汇总单行输出（外层编排抓取）；引擎进程由各场景 finally shutdown 保证回收
  try { console.error('TP1_RESULTS ' + JSON.stringify(RESULTS)); } catch { /* 尽力 */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  for (const e of ENGINES) { try { e.shutdown(); } catch { /* 尽力 */ } }
});
