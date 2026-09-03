'use strict';
/**
 * 运行时组装（入口层共用）：MCP server 与 CLI 都从这里拿 manager。
 * 这是 lib 内唯一允许 import 具体端口实现的地方（对齐 ports.createRuntime
 * 的定位——决策位①③的「换实现」发生在这里，manager 永远只面对端口）。
 *
 * 组装产物：SubagentManager（zsub 生命周期）+ orchestration host（workflow
 * 编排 = vendored subagent-core orchestration 的 zsw 宿主，见
 * lib/orchestration-host.js）。两者共享同一 records / outputs / notifier /
 * runner——zsub record 事件流与通知同源；workflow 线状态面在 core
 * FileRunStore（<zswRoot>/workflow-state/）。
 *
 * 回接 2c（D6-⑥）后的执行通道：runner 恒为 lib/runner-core.js（core zcode
 * engine 适配——engine 内部缺省 appserver 常驻 + spawn 降级链，宿主零私连，
 * 常驻形态的宿主适配点见 runner-core 头注）。旧组装期探针门控 /
 * 探针结论落盘缓存 / 首败失效重探 / 通道级降级链 / 升级检测标记
 * （upgrade-notice.json 及其 CLI/MCP 投递面）已随 1.x 私连通道退役删除：
 * 格式漂移检测归 core 引擎探针（golden 样本干跑 + 协议冒烟门控），CLI 更新
 * 后首个任务启动即经 routeEngine 真探。
 *
 * core 初始化的单一协调点：configureCore（dataRoot/log/discoveryRoots）在
 * orchestration-host.ensureConfigured（幂等）；registerZcodeEngine 在
 * runner-core.ensureZcodeEngineRegistered（幂等，engineDataDir 显式传与
 * configureCore dataRoot 同源的 zswRoot getter）。两者互不依赖（registry 登记惰性
 * 无副作用），assemble 组装顺序无需耦合。
 *
 * ZSW_RUNNER 语义（2c break）：'appserver' = 显式废弃报错（通道已按 D6-⑥ 退役）；
 * 'spawn' = 兼容 no-op（告警一次，通道本就是 spawn 单轮）；其余非空值 = 报错
 * （旧语义「任意值当 appserver」随通道退役失效，未知值前置拦截比静默走缺省
 * 更可操作）。
 */

const config = require('./config');

/** stderr 诊断（assemble 被 MCP 与 CLI 共用，log 走 stderr 不污染协议/stdout）。 */
function log(msg) {
  process.stderr.write(`[zsub] ${new Date().toISOString()} ${msg}\n`);
}

/** ZSW_RUNNER=spawn 兼容告警的一次性标记（daemon 常驻进程内不刷屏）。 */
let warnedSpawnNoop = false;

/** workflow-state 保留上限缺省值（C13；core pruneStateFilesBeyondCap 无缺省
 *  上限，1000 为本设计口径——目录收敛到该值内，无声累积修复的默认开）。 */
const STATE_KEEP_DEFAULT = 1000;

/**
 * ZSW_STATE_KEEP 解析（C13 上限透传；惯例对齐 config.resolveMaxConcurrent）：
 * 正整数生效；未设/空回落缺省 1000；非法值 stderr 警告一次并回落缺省。
 * @param {object} [env] 缺省 process.env（测试注入）
 * @returns {number}
 */
function resolveStateKeep(env = process.env) {
  const raw = env.ZSW_STATE_KEEP;
  if (raw === undefined || raw === '') return STATE_KEEP_DEFAULT;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  process.stderr.write(
    `[zsw] ZSW_STATE_KEEP=${JSON.stringify(raw)} 非法（需正整数），已忽略，回落缺省 ${STATE_KEEP_DEFAULT}。`
    + '恢复指引：设为正整数，如 ZSW_STATE_KEEP=200，然后重启进程生效。\n',
  );
  return STATE_KEEP_DEFAULT;
}

/**
 * workflow-state 磁盘裁剪接线（C13，无声恶化项修复）：把
 * <zswRoot>/workflow-state/ 收敛到上限个最新 .jsonl（mtime 升序删最旧，语义
 * 由 core FileRunStore.pruneStateFilesBeyondCap 承担）。设计 V7 后半的装配点
 * 裁决：本函数在 assembleManager 收尾 fire-and-forget 调用——2.0 经组装面的
 * 只有 CLI 本地组装路径（bin/zsw.js zsub 子命令 / workflow 子命令；hook 子
 * 命令在组装前分流，不经 assembleManager；1.x 的 daemon 启动挂点
 * dist/mcp/server.js main → createManager 已随 MCP 壳退役），单点覆盖 CLI
 * 各子命令语义；workflow-state 只产生于经组装面的路径，hook
 * 不落状态、无需 prune。server.js 不设第二调用点（同一次启动会双跑 prune，
 * 且状态目录与 wfHost.store 同源）。
 *
 * env 通道裁决：不传 core 的 envName 参数——该通道是 opt-in 语义（env 未设即
 * no-op），会让「无声累积修复」退化为默认关；zsw 侧自行解析 ZSW_STATE_KEEP
 * （resolveStateKeep），缺省即启用，上限经参数传入（core 契约：envName 缺省
 * → 直接按 max 裁剪，调用方自管启用时机）。
 *
 * 清理是旁路维护：任何失败只走 stderr warn（daemon 侧经 assemble log 可见），
 * 不阻断装配/启动。
 * @param {object} [p]
 * @param {object} [p.store] FileRunStore 注入（缺省 new core.FileRunStore()，测试可换）
 * @param {number} [p.cap]   上限注入（缺省经 resolveStateKeep 读 env）
 * @param {object} [p.env]   env 注入（透传 resolveStateKeep）
 * @returns {Promise<{ok: boolean, cap?: number}>} 永不 reject
 */
async function pruneWorkflowState({ store, cap, env } = {}) {
  try {
    const core = require('./core-ref').requireCore();
    const runStore = store || new core.FileRunStore();
    const limit = cap === undefined ? resolveStateKeep(env) : cap;
    await runStore.pruneStateFilesBeyondCap(limit);
    return { ok: true, cap: limit };
  } catch (err) {
    log(`workflow-state 裁剪失败（不影响服务）: ${err && err.message || err}`
      + '。恢复指引：检查 <ZSW_ROOT>/workflow-state/ 可写性；可用 ZSW_STATE_KEEP=<正整数> 调整保留上限（缺省 1000）');
    return { ok: false };
  }
}

/**
 * ZSW_RUNNER env 校验（2c break 后的唯一语义）。
 * @returns {void} 合法值（未设置 / 'spawn'）静默或告警通过
 * @throws 'appserver' 或未知值 → 可操作的退役/未知值错误
 */
function assertRunnerEnv() {
  const envRunner = process.env.ZSW_RUNNER;
  if (envRunner === undefined || envRunner === '') return;
  if (envRunner === 'spawn') {
    if (!warnedSpawnNoop) {
      warnedSpawnNoop = true;
      log('ZSW_RUNNER=spawn 已无独立通道（执行统一走 core zcode engine 单一 app-server 形态），值被忽略');
    }
    return;
  }
  if (envRunner === 'appserver') {
    throw new Error(
      'ZSW_RUNNER=appserver：zsw 1.x 宿主私连通道已按设计 D6-⑥ 退役（执行统一走 core zcode engine，'
      + 'app-server 常驻自动生效——宿主层不再有独立通道开关）。'
      + '恢复指引：去掉 ZSW_RUNNER（缺省即 core 引擎）。'
    );
  }
  throw new Error(
    `ZSW_RUNNER=${JSON.stringify(envRunner)} 不是有效值（可选值仅 'spawn'，且为兼容 no-op）。`
    + '恢复指引：去掉 ZSW_RUNNER 走缺省 core zcode engine。'
  );
}

/**
 * records.jsonl 磁盘收敛挂点（1.x 自 dist/mcp/server.js 的 daemon 启动/接管
 * 挂点迁来，daemon 已退役）：收敛「活跃全量 + 最近 N 终态」，恢复成本与磁盘封顶。
 *
 * 1.x 单属主由 daemon 角色保证；2.0 挂在 assembleManager 收尾 fire-and-forget
 * ——CLI 组装路径单点覆盖，并发 CLI 调用的竞态由 RecordStore.compact 的
 * D9② 双向复查兜住（读后复查前并发 append 变大 / 他者 compact rename 缩小
 * → 均放弃 + temp 清理）。run 总数 ≤ keep 时秒级跳过（不触文件）；结果/放弃
 * 一行 stderr 日志；失败不炸组装（compact 是旁路维护，下次调用幂等再试）。
 * @param {object} manager 已重建索引的 manager（records = RecordStore）
 * @param {string} phase 日志定位（2.0 恒 'cli'；保留参数兼容测试）
 * @param {(msg: string) => void} log
 */
function compactRecords(manager, phase, log) {
  try {
    const keep = config.resolveRecordKeep();
    const total = manager.records.records.size;
    if (total <= keep) return; // 零成本跳过：总数不超 keep 则终态必不超
    const r = manager.records.compact({ keep });
    if (r.skipped) {
      // skipped 含两种成因：D9② 复查放弃 / MF-4 前置闸（非终态近窗内有事件，
      // 疑似对端进程在写）——均为不动文件、下次再试语义
      log(`record compact 跳过（台账被并发变更或非终态 run 疑似活跃，下次启动再试）：phase=${phase} runs=${total} keep=${keep}`);
    } else {
      log(`record compact 完成：phase=${phase} removedRuns=${r.removedRuns} removedLines=${r.removedLines} keptRuns=${r.keptRuns} keep=${keep}`);
    }
  } catch (e) {
    log(`record compact 失败（不影响服务，下次启动再试）: ${e && e.message || e}`);
  }
}

async function assembleManager(opts = {}) {
  const { createRuntime } = require('./ports');
  const { RecordStore } = require('./record-store');
  const outputs = require('./output-store');
  const { createSlots } = require('./slots');
  const { SubagentManager } = require('./manager');
  const { createOrchestrationHost } = require('./orchestration-host');
  const { createWorktreeAdapter } = require('./worktree-adapter');
  const resolver = require('./agent-discovery');

  // runnerKind 值维度已消失（2c）：唯一通道 = core zcode engine（engine 内部
  // 按缺省门控选 appserver 常驻 / spawn 降级，宿主开关只剩 ZSW_RUNNER 校验）
  assertRunnerEnv();
  const rt = createRuntime({ notifyMode: opts.notifyMode });
  const notifier = opts.notifier || rt.createNotifier();
  const modelRouter = opts.modelRouter || rt.createModelRouter();
  // 端口实例先于 manager/host 构造（SubagentManager 与 orchestration host
  // 共享同一 records/outputs/notifier——zsub 线 record 事件流与通知同源）
  const records = opts.records || new RecordStore();
  const outputsPort = opts.outputs || outputs;
  const runner = opts.runner || rt.createRunner();
  const manager = new SubagentManager({
    runner,
    modelRouter,
    notifier,
    resolver: opts.resolver || resolver, // 模块对象自带 resolve(agentRefPath, cwd)（async，core 发现面），天然满足端口契约
    records,
    outputs: outputsPort,
    slots: opts.slots || createSlots({ limit: config.DEFAULTS.maxConcurrent }),
    worktree: opts.worktree === undefined ? createWorktreeAdapter() : opts.worktree,
  });
  // workflow 线（回接 2b）：编排整体走 vendored subagent-core orchestration
  // （orchestration-host 组装 core 三 port + 内置资产注册）。与 zsub 线共用
  // 同一 runner 实例；测试经 opts.wfHost 注入 fake 跳过组装
  const wfHostBase = opts.wfHost || createOrchestrationHost({
    runner,
    resolver: opts.resolver || resolver,
  });
  // 退出链组合（W6a2）：2.0 一次性 CLI 的唯一生产 shutdown 钩子是
  // bin/zsw.js 的 exitAfterEngineShutdown（成功路径与 main catch 错误出口都
  // 收口，dist/mcp/server.js 已随 MCP 壳退役不再存在）——runner 的
  // 进程收割面（appserver 常驻引擎 dispose + spawn 子进程 killAll 兜底）没有
  // 独立生产调用点，组合进同一钩子：先 terminate workflow runs（record 卫生），
  // 再收 runner（常驻进程回收，dispose 的 close 帧先于 SIGTERM）。注入 fake
  // wfHost 的测试组装不包装（跳过组装的组合语义与 createOrchestrationHost 同款）。
  const wfHost = opts.wfHost || {
    ...wfHostBase,
    shutdown: async () => {
      try {
        await wfHostBase.shutdown();
      } finally {
        if (runner && typeof runner.shutdown === 'function') await runner.shutdown();
      }
    },
  };
  // C13 workflow-state 磁盘裁剪（无声恶化项修复）：fire-and-forget——清理是
  // 旁路维护，不阻断装配（失败语义见 pruneWorkflowState 头注）。位置在 wfHost
  // 组装之后：生产路径此时 orchestration-host.ensureConfigured 已 configureCore
  // （dataRoot 就绪，FileRunStore.stateDir 可解析）
  pruneWorkflowState();
  // records.jsonl 收敛（compactRecords 头注）：同样 fire-and-forget 旁路维护。
  // MF-1 时序修复：compact 判定依赖内存索引的终态数，而 RecordStore 构造不
  // 读盘——组装点先 rebuildFromLog（只建内存索引，不动文件），否则 total 恒 0
  // 恒早退、compact 在组装路径永不执行。调用方（CLI main）随后的二次 rebuild
  // 幂等无冲突；compact 动文件不动内存索引，rebuild 读到 compact 前后任一
  // 形态的合法事件流均一致（D9② 并发防护保证 rename 原子性）
  if (records && typeof records.rebuildFromLog === 'function') {
    try { records.rebuildFromLog(); } catch (e) { log(`record 重建失败（跳过 compact 判定）: ${e && e.message || e}`); }
  }
  compactRecords(manager, 'cli', log);
  return { manager, wfHost, notifier };
}

module.exports = { assembleManager, assertRunnerEnv, pruneWorkflowState, resolveStateKeep, STATE_KEEP_DEFAULT, compactRecords };
