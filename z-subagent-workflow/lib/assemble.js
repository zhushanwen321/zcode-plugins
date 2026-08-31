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
      log('ZSW_RUNNER=spawn 已无独立通道（执行统一走 core zcode engine；引擎模式定向用 XYZ_ZCODE_MODE=appserver|spawn），值被忽略');
    }
    return;
  }
  if (envRunner === 'appserver') {
    throw new Error(
      'ZSW_RUNNER=appserver：zsw 1.x 宿主私连通道已按设计 D6-⑥ 退役（执行统一走 core zcode engine，'
      + '其内部已缺省 appserver 常驻——P3 回归完成，宿主层不再有独立通道开关）。'
      + '恢复指引：去掉 ZSW_RUNNER（缺省即 core 引擎，appserver 常驻自动生效）；'
      + '需定向 spawn 单轮改用 XYZ_ZCODE_MODE=spawn。'
    );
  }
  throw new Error(
    `ZSW_RUNNER=${JSON.stringify(envRunner)} 不是有效值（2c 后可选值仅 'spawn'，且为兼容 no-op）。`
    + '恢复指引：去掉 ZSW_RUNNER 走缺省 core zcode engine，或设 ZSW_RUNNER=spawn。'
  );
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
  // 退出链组合（W6a2）：daemon 退出的唯一生产 shutdown 钩子是 wfHost.shutdown
  // （MCP server stdin 关闭面，dist/mcp/server.js 不在本层领地）——runner 的
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
  return { manager, wfHost, notifier };
}

module.exports = { assembleManager, assertRunnerEnv };
