'use strict';
/**
 * 运行时组装（入口层共用）：MCP server 与 CLI 都从这里拿 manager。
 * 这是 lib 内唯一允许 import 具体端口实现的地方（对齐 ports.createRuntime
 * 的定位——决策位①③的「换实现」发生在这里，manager 永远只面对端口）。
 *
 * 组装产物含两个 manager：SubagentManager（subagent 生命周期）与
 * WorkflowManager（workflow run 生命周期，N2-b 接线）。两者共享同一
 * records / outputs / notifier 实例——record 事件流按 recordType 区分
 * （'subagent' 缺省 / 'workflow'），完成通知同走 mailbox。
 *
 * runnerKind 解析顺序（D1 默认翻转）：显式参数 > ZSW_RUNNER env > 默认 appserver。
 * probe 门控（翻转后 = 默认通道健康检查）只对缺省分支生效：组装前探 app-server，
 * 失败降级 spawn——MCP 与 CLI 两个入口共用同一决策，行为不漂移；显式指定
 * （ZSW_RUNNER=spawn 回退 / ZSW_RUNNER=appserver 定向 / runner 注入）均不探。
 *
 * probe 结果落盘缓存（~/.zcode/zsw/probe-cache.json，键 = CLI 路径 + mtime，只缓存
 * ok）：daemon 只在启动时组装一次、--local 每条命令都是一次性 CLI 进程，「进程内
 * 缓存」在两个形态下都无命中面，落盘使 daemon 与 --local 共享结论。只缓存 ok=true，
 * 失败不落盘（每次组装重探，故障期才付代价）。缓存命中跳过 probe；命中不等于持续
 * 健康——probe 结论除 CLI 可用外还依赖隔离 HOME 的 provider 配置，配置在 CLI mtime
 * 不变期间变坏会让旧 ok 结论错误命中、降级链失效，故命中后首次 session/create 失败
 * （-32603/-32601/-32602）即失效缓存并重探一次（wrapWithProbeInvalidation）：
 * 重探 ok 则原 create 错误继续走既有错误路径（D3 漂移分类兜底），不静默重试；
 * 重探失败则补做降级判定，本任务转 spawn 重跑 + record 如实改标 + 通道级降级。
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const PROBE_CACHE_FILE = 'probe-cache.json';
/**
 * D1 失效类错误码：-32603 内部错误（隔离 HOME 无 provider 配置时 session/create
 * 的 "Model config is missing" 主形态）、-32601/-32602 协议漂移。runner 的
 * request 层保证 error.message 携带 `[<code>]` 前缀（_onResponse 构造）。
 */
const INVALIDATING_ERROR_RE = /\[-32603\]|\[-32601\]|\[-32602\]/;

/** stderr 诊断（assemble 被 MCP 与 CLI 共用，log 走 stderr 不污染协议/stdout）。 */
function log(msg) {
  process.stderr.write(`[zsub] ${new Date().toISOString()} ${msg}\n`);
}

/** probe 缓存落盘路径（zswRoot 下；ZSW_ROOT 可覆盖，测试隔离免费获得）。 */
function probeCachePath() {
  return path.join(config.zswRoot(), PROBE_CACHE_FILE);
}

/** probe 缓存的 CLI 键源。与 runner-appserver.js resolveZcodeCli 同源：每次重读
 *  env，ZSW_ZCODE_CLI 的测试覆盖与运行时换 CLI 都即时生效。注意 ZCODE_CLI 导出
 *  在 config 顶层（非 DEFAULTS）——DEFAULTS 引用会在真实部署（env 未设）时得到
 *  undefined，statSync 抛错被吞后缓存静默失效。 */
function resolveCliPath() {
  return process.env.ZSW_ZCODE_CLI || config.ZCODE_CLI;
}

/**
 * 读缓存条目。mtime 不匹配（CLI 更新）、损坏（不可解析/形态不对）、非 ok 一律
 * 按 miss 处理——缓存只做加速，任何可疑都回到真实 probe。
 * @returns {{ok: true, mtimeMs: number, protocolVersion: number|null}|null}
 */
function readProbeCacheEntry(cliPath, mtimeMs, cacheFile = probeCachePath()) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    return null; // 不存在或损坏：视为无缓存
  }
  const entry = data && typeof data === 'object' && data.entries && typeof data.entries === 'object'
    ? data.entries[cliPath]
    : null;
  if (!entry || typeof entry !== 'object' || entry.ok !== true) return null;
  if (typeof entry.mtimeMs !== 'number' || entry.mtimeMs !== mtimeMs) return null;
  return entry;
}

/**
 * 写缓存条目（原子写）。只缓存 ok=true——失败不落盘，调用方仅在 probe.ok 后调用；
 * 一次暂时性故障不会让 mtime 不变期间持续走 spawn 丢掉 apc 能力。
 */
function writeProbeCacheEntry(cliPath, mtimeMs, protocolVersion, cacheFile = probeCachePath()) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch { /* 新建或损坏重建 */ }
  if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
    data = { entries: {} };
  }
  data.entries[cliPath] = {
    ok: true,
    mtimeMs,
    protocolVersion: protocolVersion == null ? null : protocolVersion,
    cachedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, cacheFile);
  } catch (e) {
    log(`probe 缓存写入失败（${e && e.message || e}），下次组装将重探`);
  }
}

/** 失效缓存条目（D1 首败失效）。无缓存/损坏时静默——本来就没有可失效的结论。 */
function invalidateProbeCacheEntry(cliPath, cacheFile = probeCachePath()) {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (data && data.entries && data.entries[cliPath]) {
      delete data.entries[cliPath];
      const tmp = `${cacheFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, cacheFile);
    }
  } catch { /* 无缓存/损坏：无需失效 */ }
}

/**
 * probe 序列：先经 model-router bootstrap 隔离 HOME 再 probe——app-server 进程
 * 启动即要求 $HOME 有模型/provider 配置（e2e 实测 2026-08-23：无配置时
 * session/create 直接 -32603 "Model config is missing"），否则真实部署中
 * appserver 永远误降级 spawn。
 * @returns {Promise<{ok: boolean, protocolVersion?: number, reason?: string}>}
 */
async function runProbeSequence() {
  const ModelRouter = require('./model-router');
  const AppServerRunner = require('./runner-appserver');
  const router = new ModelRouter();
  await router.prepareRunEnv(router.resolve(), 'appserver');
  return new AppServerRunner().probe();
}

/**
 * 默认通道健康检查（D1）：probe app-server，失败降级 spawn；ok 结论落盘缓存，
 * 命中（同 CLI 路径 + 同 mtime）跳过 probe。
 * @returns {Promise<{kind: 'appserver'|'spawn', fromCache: boolean}>}
 */
async function resolveRunnerKind() {
  const cliPath = resolveCliPath();
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(cliPath).mtimeMs;
  } catch { /* 坏路径：缓存必 miss，直接走 probe 得到可诊断 reason */ }
  if (mtimeMs !== null) {
    const hit = readProbeCacheEntry(cliPath, mtimeMs);
    if (hit) {
      log(`probe 缓存命中（${cliPath} mtime=${mtimeMs}），跳过 probe`);
      return { kind: 'appserver', fromCache: true };
    }
  }
  try {
    const probe = await runProbeSequence();
    if (probe.ok) {
      if (mtimeMs !== null) writeProbeCacheEntry(cliPath, mtimeMs, probe.protocolVersion);
      log(`appserver probe OK（protocol ${probe.protocolVersion || '?'}），runner=appserver`);
      return { kind: 'appserver', fromCache: false };
    }
    log(`appserver probe FAILED（${probe.reason}），降级 runner=spawn`);
  } catch (e) {
    log(`appserver probe crashed（${e && e.message || e}），降级 runner=spawn`);
  }
  return { kind: 'spawn', fromCache: false };
}

/** D1 失效类错误判定（done 结果形态；errorKind 由 F1 漂移分类上行，正则兜底 -32603）。 */
function isInvalidatingError(result) {
  if (result && result.errorKind === 'protocol-drift') return true;
  return typeof (result && result.error) === 'string'
    && INVALIDATING_ERROR_RE.test(result.error);
}

/**
 * 缓存命中时的 runner 包装（D1 首败失效重探）。probe 结论来自落盘缓存，可能过期：
 * 首次 session/create 失败（-32603/-32601/-32602）→ 失效缓存 + 重探一次。
 *   重探 ok   → 原错误结果原样上行（D3 漂移分类兜底），不静默重试 create；
 *   重探失败 → 环境真实故障：本任务转 spawn 重跑（stderr 出声 + record 如实改标
 *              runnerKind/exec），capabilities 翻转 spawn（通道级降级，后续任务
 *              走 spawn 且免重探）。
 * resume/alive 按 exec.kind 路由——降级重跑后的会话句柄是 spawn 形态。
 * @param {object} inner   AppServerRunner 实例
 * @param {object} [records] RecordStore（降级时改标 record.runnerKind/exec）
 */
function wrapWithProbeInvalidation(inner, records) {
  const cliPath = resolveCliPath();
  let cliMtimeMs = null;
  try { cliMtimeMs = fs.statSync(cliPath).mtimeMs; } catch { /* 缓存命中过的路径必然存在 */ }

  let degraded = false;
  let spawnInst = null;
  const spawnRunner = () => {
    if (!spawnInst) spawnInst = new (require('./runner-spawn'))();
    return spawnInst;
  };
  // 降级重跑的 spawn runEnv 现做：组装期按 appserver 只备了 createParams 形态
  const runSpawnRound = async (taskCtx) => {
    const ModelRouter = require('./model-router');
    const runEnv = await new ModelRouter().prepareRunEnv(taskCtx.modelRef, 'spawn');
    return spawnRunner().start({ ...taskCtx, runEnv });
  };

  return {
    capabilities: () => (degraded ? spawnRunner().capabilities() : inner.capabilities()),
    start(taskCtx) {
      const handle = inner.start(taskCtx);
      let active = handle; // cancel 转发的当前活动句柄（降级重跑后切换为 spawn）
      const done = (async () => {
        const result = await handle.done;
        if (!result || result.status !== 'error' || !isInvalidatingError(result)) return result;
        invalidateProbeCacheEntry(cliPath);
        log(`缓存命中后 session/create 失败（${String(result.error || '').slice(0, 160)}），已失效 probe 缓存，重探一次`);
        let reprobe = { ok: false, reason: 'probe crashed（无详情）' };
        try {
          reprobe = await runProbeSequence();
        } catch (e) {
          reprobe = { ok: false, reason: String(e && e.message || e) };
        }
        if (reprobe.ok) {
          // 环境健康：失败是漂移类问题，原错误走既有错误路径（D3），不静默重试
          if (cliMtimeMs !== null) writeProbeCacheEntry(cliPath, cliMtimeMs, reprobe.protocolVersion);
          return result;
        }
        log(`appserver 重探 FAILED（${reprobe.reason}），降级 runner=spawn 重跑本任务（后续任务免重探）`);
        degraded = true;
        const spawnHandle = await runSpawnRound(taskCtx);
        active = spawnHandle;
        if (records && taskCtx && taskCtx.subagentId) {
          try {
            records.update(taskCtx.subagentId, { runnerKind: 'spawn', exec: spawnHandle.exec });
          } catch (e) {
            log(`降级改标失败（${e && e.message || e}）；实际通道以 exec.kind=${spawnHandle.exec && spawnHandle.exec.kind} 为准`);
          }
        }
        return spawnHandle.done;
      })();
      return {
        exec: handle.exec,
        cancel: () => active.cancel(),
        done,
      };
    },
    resume(exec, message, opts, onHandle) {
      if (exec && exec.kind === 'spawn') return spawnRunner().resume(exec, message, opts, onHandle);
      return inner.resume(exec, message, opts, onHandle);
    },
    alive(exec) {
      if (exec && exec.kind === 'spawn') return spawnRunner().alive(exec);
      return inner.alive(exec);
    },
    async shutdown() {
      await inner.shutdown();
      if (spawnInst && typeof spawnInst.shutdown === 'function') await spawnInst.shutdown();
    },
  };
}

async function assembleManager(opts = {}) {
  const { createRuntime } = require('./ports');
  const { RecordStore } = require('./record-store');
  const outputs = require('./output-store');
  const { createSlots } = require('./slots');
  const { SubagentManager } = require('./manager');
  const { WorkflowManager } = require('./workflow-manager');
  const { createWorktreeAdapter } = require('./worktree-adapter');
  const resolver = require('./agent-md-resolver');

  // ZSW_RUNNER 语义（D1 翻转）：未设置 = 缺省 appserver（走 probe 门控）；
  // 'spawn' = 显式回退；其余值（含 'appserver'）= 显式定向 appserver，不探。
  const envRunner = process.env.ZSW_RUNNER;
  let runnerKind = opts.runnerKind || (envRunner === 'spawn' ? 'spawn' : 'appserver');
  let fromCache = false;
  if (!opts.runner && !opts.runnerKind && !envRunner) {
    // 探针门控只对缺省分支生效（显式注入 runner/runnerKind 或显式 env 即接管）
    ({ kind: runnerKind, fromCache } = await resolveRunnerKind());
  }
  const rt = createRuntime({ runnerKind, notifyMode: opts.notifyMode });
  const notifier = opts.notifier || rt.createNotifier();
  // 三个端口实例先于两个 manager 构造（SubagentManager 与 WorkflowManager
  // 共享同一 records/outputs/notifier——record 事件流、结果落盘、完成通知
  // 必须同源，两份实例会让 recordType 过滤与 mailbox 投递互相看不见）
  const records = opts.records || new RecordStore();
  const outputsPort = opts.outputs || outputs;
  let runner = opts.runner || rt.createRunner();
  if (!opts.runner && runnerKind === 'appserver' && fromCache) {
    // 缓存命中才有「过期结论」问题——刚 probe 过的组装无需首败失效重探
    runner = wrapWithProbeInvalidation(runner, records);
  }
  const manager = new SubagentManager({
    runner,
    modelRouter: opts.modelRouter || rt.createModelRouter(),
    notifier,
    resolver: opts.resolver || resolver, // 模块对象自带 resolve(nameOrPath, cwd)，天然满足端口契约
    records,
    outputs: outputsPort,
    slots: opts.slots || createSlots({ limit: config.DEFAULTS.maxConcurrent }),
    worktree: opts.worktree === undefined ? createWorktreeAdapter() : opts.worktree,
  });
  const wfManager = opts.wfManager || new WorkflowManager({
    records,
    outputs: outputsPort,
    notifier,
  });
  return { manager, wfManager, notifier, runnerKind };
}

module.exports = { assembleManager };
// 缓存层与失效判定导出：单测注入 cacheFile / 锁定判定行为，不真跑引擎
module.exports.probeCachePath = probeCachePath;
module.exports.resolveCliPath = resolveCliPath;
module.exports.readProbeCacheEntry = readProbeCacheEntry;
module.exports.writeProbeCacheEntry = writeProbeCacheEntry;
module.exports.invalidateProbeCacheEntry = invalidateProbeCacheEntry;
module.exports.isInvalidatingError = isInvalidatingError;
