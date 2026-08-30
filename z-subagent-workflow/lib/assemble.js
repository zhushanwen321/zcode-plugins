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
 * 重探失败则补做降级判定，本任务转 spawn 重跑 + record 如实改标 + 通道级降级
 * （capabilities 翻转后 start 分流直接走 spawn，daemon 生命周期内后续任务免重探；
 * daemon 随 ZCode 重启后重新组装、恢复探测）。
 *
 * 升级检测出声（wave2 D5）：读缓存区分两种 miss——「无该 CLI 条目」（首次）静默；
 * 「有条目但 mtime 不匹配」（CLI 已更新）落升级标记 ~/.zcode/zsw/upgrade-notice.json
 * （{cliPath, mtimeMs, detectedAt}，原子写与 probe 缓存同款）后照常重探。标记是
 * 两个投递面的共享事实源（检测与投递解耦）：① 任意 zsw CLI 命令执行前检查标记
 * stderr 出声；② zsub/zflow MCP tool 结果文本尾部追加。daemon/GUI 主形态下组装
 * 发生在进程启动时且其 stderr 非用户可见面，纯 stderr 方案对主形态不生效，故以
 * 落盘标记为媒介。清除语义：升级冒烟（node test/e2e.test.js --name apc-smoke）
 * 通过后删除标记；手动清除 = 删文件。提示文案复用 D3 的 DRIFT_SMOKE_CMD/
 * DRIFT_FALLBACK_ENV 常量（buildUpgradeNoticeMessage）。
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
 * 读取并校验缓存 JSON。不存在/损坏/形态不对（entries 非 object）返回 null——
 * 缓存文件格式契约的唯一判定点，三个缓存函数共用。
 */
function loadCacheData(cacheFile) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    return null; // 不存在或损坏：视为无缓存
  }
  if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') return null;
  return data;
}

/** 原子覆写缓存。tmp 名带 pid：daemon 与 --local CLI 多进程并发写同缓存时，固定
 * tmp 名会互相踩踏（A 写 tmp → B 覆写 tmp → A rename 出 B 的内容），损坏虽被
 * 读取侧容错为 miss 重探，仍属可避免面。 */
function saveCacheFile(cacheFile, data) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, cacheFile);
}

/**
 * 缓存查找分类（wave2 D5）：命中返回 null；无该 CLI 条目（缓存文件不存在/
 * 损坏/条目缺失/非 ok）返回 'first'（首次组装，静默）；有条目但 mtime 不匹配
 * （CLI 已更新）返回 'stale'（升级事实已发生，落升级标记）。readProbeCacheEntry
 * 与 resolveRunnerKind 共用本判定，防两种 miss 的区分逻辑漂移。
 * @returns {null|'first'|'stale'}
 */
function classifyProbeCacheLookup(cliPath, mtimeMs, cacheFile = probeCachePath()) {
  const data = loadCacheData(cacheFile);
  const entry = data ? data.entries[cliPath] : null;
  if (!entry || typeof entry !== 'object' || entry.ok !== true) return 'first';
  if (typeof entry.mtimeMs !== 'number' || entry.mtimeMs !== mtimeMs) return 'stale';
  return null;
}

/**
 * 读缓存条目。mtime 不匹配（CLI 更新）、损坏（不可解析/形态不对）、非 ok 一律
 * 按 miss 处理——缓存只做加速，任何可疑都回到真实 probe。
 * @returns {{ok: true, mtimeMs: number, protocolVersion: number|null}|null}
 */
function readProbeCacheEntry(cliPath, mtimeMs, cacheFile = probeCachePath()) {
  if (classifyProbeCacheLookup(cliPath, mtimeMs, cacheFile) !== null) return null;
  return loadCacheData(cacheFile).entries[cliPath];
}

/**
 * 写缓存条目（原子写）。只缓存 ok=true——失败不落盘，调用方仅在 probe.ok 后调用；
 * 一次暂时性故障不会让 mtime 不变期间持续走 spawn 丢掉 apc 能力。
 */
function writeProbeCacheEntry(cliPath, mtimeMs, protocolVersion, cacheFile = probeCachePath()) {
  const data = loadCacheData(cacheFile) || { entries: {} }; // 新建或损坏重建
  data.entries[cliPath] = {
    ok: true,
    mtimeMs,
    protocolVersion: protocolVersion == null ? null : protocolVersion,
    cachedAt: new Date().toISOString(),
  };
  try {
    saveCacheFile(cacheFile, data);
  } catch (e) {
    log(`probe 缓存写入失败（${e && e.message || e}），下次组装将重探`);
  }
}

/** 失效缓存条目（D1 首败失效）。无缓存/损坏时静默——本来就没有可失效的结论。 */
function invalidateProbeCacheEntry(cliPath, cacheFile = probeCachePath()) {
  const data = loadCacheData(cacheFile);
  if (!data || !data.entries[cliPath]) return;
  delete data.entries[cliPath];
  try {
    saveCacheFile(cacheFile, data);
  } catch { /* 写失败：缓存留旧结论，读取侧仍会按形态容错为 miss */ }
}

// ------------------------------------------------------ 升级检测出声（wave2 D5）

const UPGRADE_NOTICE_FILE = 'upgrade-notice.json';

/** 升级标记落盘路径（zswRoot 下，ZSW_ROOT 可覆盖——测试隔离与 probe 缓存同款免费获得）。 */
function upgradeNoticePath() {
  return path.join(config.zswRoot(), UPGRADE_NOTICE_FILE);
}

/**
 * 读升级标记。不存在/损坏/形态不对返回 null——形态契约（cliPath 必须是
 * string）的唯一判定点，防损坏文件让投递面输出垃圾内容。
 */
function readUpgradeNotice(noticeFile = upgradeNoticePath()) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(noticeFile, 'utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || typeof data.cliPath !== 'string') return null;
  return data;
}

/**
 * 落升级标记（原子写，复用 probe 缓存同款 tmp+rename）。stale miss（CLI mtime
 * 变化）时调用：标记是 CLI stderr 与 MCP tool 结果两个投递面的共享事实源，
 * daemon（组装发生在进程启动）与 CLI（--local 每次组装）两形态据此共享同一次
 * 检测。重复检测幂等覆写（detectedAt 刷新为最近一次检测时间）。写失败只出声
 * 不影响组装——提示缺失的最坏后果是漂移发现时机退回任务失败，不是功能故障。
 */
function writeUpgradeNotice(cliPath, mtimeMs, noticeFile = upgradeNoticePath()) {
  try {
    saveCacheFile(noticeFile, { cliPath, mtimeMs, detectedAt: new Date().toISOString() });
  } catch (e) {
    log(`升级标记写入失败（${e && e.message || e}），不影响组装`);
  }
}

/** 清除升级标记（D5 清除语义：冒烟通过即被指引的动作完成，提示消除；手动清除 = 删文件）。 */
function clearUpgradeNotice(noticeFile = upgradeNoticePath()) {
  try {
    fs.rmSync(noticeFile, { force: true });
  } catch { /* 清除失败留标记：提示误存续无害，下次冒烟再消 */ }
}

/**
 * 升级提示文案（单一事实源，两个投递面共用，防文案漂移）。复用 D3 的
 * DRIFT_SMOKE_CMD/DRIFT_FALLBACK_ENV 常量拼装（79577a0 曾移除导出，wave2 已
 * 恢复），不自造漂移。基调对齐设计 §3.1 升级提示路径样例。
 * @returns {string} 不含投递面前缀/换行，由各投递面按自身惯例包装
 */
function buildUpgradeNoticeMessage() {
  const { DRIFT_SMOKE_CMD, DRIFT_FALLBACK_ENV } = require('./runner-appserver');
  return '检测到 ZCode CLI 已更新（mtime 变化）。若 zsub/zflow 出现协议类报错，'
    + `先跑升级冒烟 \`${DRIFT_SMOKE_CMD}\` 核对漂移面；`
    + `确认不兼容期间设 ${DRIFT_FALLBACK_ENV} 回退。`
    + '（跑通冒烟后本提示自动消除；手动清除 = 删除 upgrade-notice.json）';
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
  // 两种 miss 区分（wave2 D5）：'first'（无条目/坏路径/损坏缓存）静默；
  // 'stale'（条目在但 mtime 不匹配 = CLI 已更新）落升级标记后照常重探——
  // 不阻塞、不改探测行为，标记供 CLI/MCP 两个投递面出声
  const missKind = mtimeMs === null
    ? 'first'
    : classifyProbeCacheLookup(cliPath, mtimeMs);
  if (missKind === null) {
    log(`probe 缓存命中（${cliPath} mtime=${mtimeMs}），跳过 probe`);
    return { kind: 'appserver', fromCache: true };
  }
  if (missKind === 'stale') writeUpgradeNotice(cliPath, mtimeMs);
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
  // 降级通道的 spawn runEnv 现做（重跑本任务 / 后续任务免重探共用）：无条件按
  // spawn 重组并整体替换 taskCtx.runEnv——manager 按 capabilities().kind 组装，
  // 正常时 runEnv 已是 spawn 形态；降级翻转落在 manager 组装之后的竞态窗口
  // （capabilities 读取与 runner.start 之间隔着 prepareRunEnv 的 await）里
  // taskCtx.runEnv 仍是 appserver 的 createParams 形态，替换式现做对两种形态都正确
  const runSpawnRound = async (taskCtx) => {
    const ModelRouter = require('./model-router');
    const runEnv = await new ModelRouter().prepareRunEnv(taskCtx.modelRef, 'spawn');
    return spawnRunner().start({ ...taskCtx, runEnv });
  };
  // spawn 进程启动后把真实句柄与通道标注回写 record（占位 exec / 组装期
  // runnerKind 的修正）；update 失败只出声不炸轮——实际通道以 exec.kind 为准
  const relabelRecord = (taskCtx, spawnHandle) => {
    if (records && taskCtx && taskCtx.subagentId) {
      try {
        records.update(taskCtx.subagentId, { runnerKind: 'spawn', exec: spawnHandle.exec });
      } catch (e) {
        log(`降级改标失败（${e && e.message || e}）；实际通道以 exec.kind=${spawnHandle.exec && spawnHandle.exec.kind} 为准`);
      }
    }
  };

  // 降级重跑的唯一入口：spawn 重跑必须同步改标 record（runnerKind/exec），两步
  // 捆绑防漏（调用方只拿句柄，不重复写 relabel）
  const rerunViaSpawn = async (taskCtx) => {
    const spawnHandle = await runSpawnRound(taskCtx);
    relabelRecord(taskCtx, spawnHandle);
    return spawnHandle;
  };

  return {
    capabilities: () => (degraded ? spawnRunner().capabilities() : inner.capabilities()),
    start(taskCtx) {
      if (degraded) {
        // 通道级降级后的后续任务：免重探直接走 spawn（stderr 的「后续任务免
        // 重探」承诺兑现处）。inner 已被判定为故障通道，不再喂任何任务。
        let active = null;
        const done = (async () => {
          active = await rerunViaSpawn(taskCtx);
          return active.done;
        })();
        return {
          // 启动窗口（prepareRunEnv 的 await 段）内 exec 未定，先落 spawn 占位，
          // relabelRecord 以真实句柄覆盖
          exec: { kind: 'spawn', pid: undefined },
          cancel: () => {
            if (active) { active.cancel(); return; }
            // 启动窗口（亚秒级）内的 cancel 实质丢失：done.then 只在任务自然完成
            // 后才触发，此时 cancel 已是 no-op，不会真正转发——已知边界（impl-plan
            // 偏差登记表区 B 行：窗口亚秒级、终态不悬挂、裁决不修），终态仍正常
            // 落盘；active 就绪后的 cancel 走上一行正常转发
            done.then(() => { if (active) active.cancel(); }).catch(() => {});
          },
          done,
        };
      }
      const handle = inner.start(taskCtx);
      let active = handle; // cancel 转发的当前活动句柄（降级重跑后切换为 spawn）
      const done = (async () => {
        const result = await handle.done;
        if (!result || result.status !== 'error' || !isInvalidatingError(result)) return result;
        invalidateProbeCacheEntry(cliPath);
        log(`缓存命中后 session/create 失败（${String(result.error || '').slice(0, 160)}），已失效 probe 缓存，重探一次`);
        const reprobe = await runProbeSequence()
          .catch((e) => ({ ok: false, reason: String(e && e.message || e) }));
        if (reprobe.ok) {
          // 环境健康：失败是漂移类问题，原错误走既有错误路径（D3），不静默重试
          if (cliMtimeMs !== null) writeProbeCacheEntry(cliPath, cliMtimeMs, reprobe.protocolVersion);
          return result;
        }
        log(`appserver 重探 FAILED（${reprobe.reason}），降级 runner=spawn 重跑本任务（后续任务免重探）`);
        degraded = true;
        active = await rerunViaSpawn(taskCtx);
        return active.done;
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
    // release 同 resume/alive 按 exec.kind 路由：fromCache 路径下消费方（workflow
    // 阶段的全终态释放，wave2 D2）拿到的是本包装 runner，漏转发则 runner.release
    // 是 undefined 直接 TypeError
    release(exec) {
      if (exec && exec.kind === 'spawn') return spawnRunner().release(exec);
      return inner.release(exec);
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
  // wave2 D1：workflow 线与 zsub 共用同一 runner 实例（含 fromCache 分支的
  // probe 失效包装形态）——probe 门控、通道级降级、降级 spawn 重跑对 workflow
  // 阶段逐阶段生效（D4 零新增）；WorkflowManager 未注入 runner 时其阶段保持
  // spawn 直调旧行为（真实入口组装恒注入）
  const wfManager = opts.wfManager || new WorkflowManager({
    records,
    outputs: outputsPort,
    notifier,
    runner,
  });
  return { manager, wfManager, notifier, runnerKind };
}

// 缓存层与失效判定导出：单测注入 cacheFile / 锁定判定行为，不真跑引擎
// （invalidateProbeCacheEntry 仅内部消费，不导出）。wrapWithProbeInvalidation
// 导出供包装层转发面直接单测（release 按 kind 路由等，不经 assembleManager 全组装）。
// 升级检测面（wave2 D5）：miss 分类、标记读写清与提示文案导出——CLI/MCP 两个
// 投递面与单测共用同一事实源
module.exports = {
  assembleManager,
  probeCachePath,
  resolveCliPath,
  readProbeCacheEntry,
  writeProbeCacheEntry,
  isInvalidatingError,
  wrapWithProbeInvalidation,
  classifyProbeCacheLookup,
  upgradeNoticePath,
  readUpgradeNotice,
  writeUpgradeNotice,
  clearUpgradeNotice,
  buildUpgradeNoticeMessage,
};
