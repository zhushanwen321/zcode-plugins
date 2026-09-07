'use strict';
/**
 * RunnerPort 的 core engine 实现（回接计划 2c，D6-⑥）。
 *
 * zsub 执行链整体切到 vendored subagent-core 的引擎抽象：
 *   start → routeEngine（三层路由 + probe + fallback 三守卫）→ EnginePort.run
 *   （zcode 引擎：单一 app-server 常驻形态，共享宿主 HOME——core 0.5.0 起
 *   CLI spawn 链与 HOME 池化已删，会话写真实 ~/.zcode/，协议漂移直接报错）。
 * zsw 宿主层零私连（D6-⑥ 不变），本层对常驻形态的适配点三处：alive() 按
 * exec.kind 分支、shutdown() 补引擎实例 dispose、runCtx onHandleReady 的
 * sessionRef 消费（见各方法注释）。
 *
 * 与 vendored 面的接线模式（对齐 core SAR 生产用法，subprocess-agent-runner）：
 * vendored 导出面无 getEngine/registerEngine 等注册表 getter，routeEngine 的
 * probe/getEngineFn/hasEngineFn/listEnginesFn 参数本就设计为宿主可注入——本层
 * 持有「id → 引擎实例」惰性单例表并全量注入，registerZcodeEngine() 仅作进程级
 * 登记（幂等零成本，供未来 core 内部消费方；registry 惰性工厂不触发探测）。
 * 引擎数据根两份同源：本表实例显式传 () => zswRoot()（与 configureCore
 * dataRoot 同一 SSOT，ZSW_ROOT 测试隔离免费）；registry 份经 registerZcodeEngine
 * 显式传同一 getter（不走 core 的 env 优先链——zsw 是顶层宿主，落点拍板
 * <zswRoot>/engines/，见回接计划验收 ⑤）。
 *
 * exec 句柄（record.exec 持久化，manager 不解读）：
 *   {kind, pid?, sessionId?, sessionRef?, engineId?, poolKey?, cwd}
 *   - kind：恒 'appserver'（单一形态基线；create 应答后 onHandleReady 回填
 *     sessionRef/poolKey）。alive() 仍保留 'spawn' 分支仅为兼容读取池化时代
 *     旧 records（引擎 0.5.0 前的 exec）——新引擎不再产生 spawn 形态
 *   - pid：恒 undefined（常驻进程不经 onChildSpawned——core D6 边界声明，
 *     生命周期归 engine dispose）
 *   - sessionId/poolKey：create 应答后即回填（P3 冷续聊回归时的定位锚）
 *   - sessionRef：{dbPath 宿主绝对路径, sessionId}，create 应答后回填——
 *     运行中落盘，供诊断与 read 面定位（dbPath = ~/.zcode/cli/db/db.sqlite）
 *   - 字段异步就绪（route → create → done 各阶段），start(taskCtx,
 *     hooks) 的 hooks.onExec(snapshot) 在每次回填后回调浅拷贝快照——manager
 *     据此追加 update 事件持久化 sessionRef（running 转换事件序列化于
 *     create 之前；不补落盘的话 standby 从磁盘 rebuild 后定位无依据，A5）
 *
 * 行为边界（README「回接 2c break 变更」节对应）：
 *   - resume（conversation 续聊）：core EnginePort 面无 resume 入口
 *     （capabilities.conversation=unsupported——appserver 常驻亦无同进程 idle
 *     复用），显式报可操作错误。manager 续聊入口已在 manager 层直接报
 *     unavailable（续聊执行线随 app-server 常驻化重构移除，P3 回归），本方法
 *     保留为端口契约防御层
 *   - message/close：message 的续聊不可用由 manager 入口层直接报告（不经
 *     runner）；close 是壳层 record 终态化，runner 无驻留对应物
 *   - schema：zsw 契约面保持壳层（prompt-builder 拼段 + jsonout 提取），不透传
 *     task.schema——避免 engine 仿真段与壳层段在 prompt 内双重出现
 */

const config = require('./config');
const coreRef = require('./core-ref');

/** zsw 缺省（且唯一生产）引擎 id。 */
const ZCODE_ENGINE_ID = 'zcode';

/**
 * 进程级 registry 登记幂等标记（registerZcodeEngine 覆盖语义本身幂等，flag
 * 防 assemble 每次组装都重复登记——无行为差异，纯去抖）。
 */
let zcodeRegistered = false;

/** zsw 引擎数据根 getter（与 orchestration-host configureCore dataRoot 同源）。 */
function zswEngineDataDir() {
  return config.zswRoot();
}

/**
 * 把 'zcode' 引擎登记进 core 进程级 registry（幂等）。engineDataDir 显式传
 * zswRoot 同源 getter——不依赖 core getEngineDataDir 的 host-services 状态
 * （未 configureCore 时读 dataRoot 会抛 core_host_not_configured；zsw 执行面
 * 用自建实例表，registry 份仅登记备查，但两份数据根必须同源防漂移）。
 */
function ensureZcodeEngineRegistered() {
  if (zcodeRegistered) return;
  coreRef.requireCore().registerZcodeEngine(zswEngineDataDir);
  zcodeRegistered = true;
}

/** core AgentUsage（camelCase）→ zsw RunResult.usage（snake_case，旧台账形态）。 */
function toZswUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const out = {};
  if (num(usage.input) !== undefined) out.input_tokens = usage.input;
  if (num(usage.output) !== undefined) out.output_tokens = usage.output;
  if (num(usage.cacheRead) !== undefined) out.cache_read_tokens = usage.cacheRead;
  if (num(usage.cacheWrite) !== undefined) out.cache_write_tokens = usage.cacheWrite;
  if (num(usage.turns) !== undefined) out.turns = usage.turns;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * AgentOutcome → zsw RunResult（终态映射单一权威点）。
 * 终态判定：outcome.error 存在即失败类；具体档位由 abortCause（本层发起的
 * cancel/timeout 计时事实）区分——engine 对两种 abort 都合成杀链中止文案，
 * 只有发起方知道语义，不依赖 engine 文案反推。
 * fallback 留痕以路由层产物（routeFallback）为权威：真 zcode 引擎会经
 * RunContext.engineFallback 投影进 outcome（两处等价），fake 引擎不投影——
 * 路由层值保证留痕在任何 EnginePort 实现下都不丢。
 */
function outcomeToRunResult(outcome, abortCause, routeFallback) {
  const fallback = routeFallback || outcome.engineFallback;
  const base = {
    response: typeof outcome.content === 'string' ? outcome.content : '',
    usage: toZswUsage(outcome.usage),
    ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
    ...(outcome.engineId !== undefined ? { engineId: outcome.engineId } : {}),
    ...(fallback !== undefined ? { engineFallback: fallback } : {}),
  };
  if (outcome.error === undefined) return { ...base, status: 'closed' };
  if (abortCause === 'timeout') {
    return { ...base, status: 'timeout', error: `任务超时，杀链终止。${outcome.error}` };
  }
  if (abortCause === 'cancel') {
    return { ...base, status: 'cancelled', error: outcome.error };
  }
  return { ...base, status: 'error', error: outcome.error };
}

/**
 * 工具 denylist 并集（frontmatter disallowedTools + CLI --deny-tools）。
 * 旧 spawn 回退只落 frontmatter 侧；engine 的 --disallowed-tools flag 通道
 * 对两来源等价，并集去重（deny 是硬约束，来源无关）。
 */
function mergeDenyTools(taskCtx) {
  const raw = [
    ...(Array.isArray(taskCtx && taskCtx.disallowedTools) ? taskCtx.disallowedTools : []),
    ...(Array.isArray(taskCtx && taskCtx.toolDenylist) ? taskCtx.toolDenylist : []),
  ];
  return [...new Set(raw.map((t) => String(t).trim()).filter((t) => t !== ''))];
}

class CoreRunner {
  /**
   * @param {object} [opts]
   * @param {Map<string, object>} [opts.engines]  id → EnginePort 实例表（测试注入
   *        fake 引擎，不经真实 spawn / 真实 probe）。缺省惰性建 zcode 单例。
   * @param {(msg: string) => void} [opts.log] 诊断通道（缺省 stderr）
   */
  constructor(opts = {}) {
    this._customEngines = opts.engines instanceof Map ? opts.engines : null;
    this._lazyEngines = new Map();
    this._log = opts.log || ((msg) => process.stderr.write(`[zsub:runner-core] ${new Date().toISOString()} ${msg}\n`));
    ensureZcodeEngineRegistered();
  }

  /**
   * 引擎获取（惰性单例）：自定义表直取；缺省表仅建 'zcode'。
   * fallback 目标不可达时（zsw 生产仅注册 zcode）抛可操作错误——比透传 core
   * 的 EngineNotFoundError('pi') 更贴近 zsw 实情（用户没写 pi，是 fallback 无处可去）。
   */
  _engineFor(id) {
    if (this._customEngines) {
      const eng = this._customEngines.get(id);
      if (!eng) throw new Error(this._unavailableEngineMessage(id));
      return eng;
    }
    if (id === ZCODE_ENGINE_ID) {
      if (!this._lazyEngines.has(id)) {
        // deps 全缺省：engineDataDir=zswRoot 同源、cliPath=core 内置缺省
        // （XYZ_ZCODE_CLI env 由 registerZcodeEngine 内部读取——自建实例对齐）
        const core = coreRef.requireCore();
        this._lazyEngines.set(id, core.createZcodeEngine({
          engineDataDir: zswEngineDataDir,
          ...(process.env.XYZ_ZCODE_CLI !== undefined ? { cliPath: process.env.XYZ_ZCODE_CLI } : {}),
        }));
      }
      return this._lazyEngines.get(id);
    }
    throw new Error(this._unavailableEngineMessage(id));
  }

  _unavailableEngineMessage(id) {
    return `引擎 "${id}" 在 zsw 不可用（zsw 生产仅注册 ${ZCODE_ENGINE_ID}）。`
      + '恢复指引：检查 agent .md frontmatter 的 engine: 字段拼写，或去掉该字段走缺省 zcode 引擎。';
  }

  _hasEngine(id) {
    if (this._customEngines) return this._customEngines.has(id);
    return id === ZCODE_ENGINE_ID;
  }

  _listEngines() {
    if (this._customEngines) return [...this._customEngines.keys()];
    return [ZCODE_ENGINE_ID];
  }

  /**
   * 启动探针（RunnerPort 契约面）：透传缺省引擎的 core ProbeReport。
   * 组装期探针门控与探针落盘缓存已随 1.x 宿主私连通道退役（assemble 不再消费本方法做
   * 降级决策）；无 CLI/MCP 诊断入口，当前消费者为单测与 e2e 真机冒烟。
   */
  async probe() {
    try {
      const report = await this._engineFor(ZCODE_ENGINE_ID).probe();
      return {
        ok: report.ok === true,
        ...(report.engineVersion ? { protocolVersion: report.engineVersion } : {}),
        ...(report.ok ? {} : { reason: report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail || 'FAIL'}`).join('; ') }),
      };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  }

  capabilities() {
    return {
      // 单一 app-server 形态（core 0.5.0 起）：无 spawn 兜底，协议漂移直接报错
      kind: 'appserver',
      steering: 'none',   // send-while-running 恒 -32010 硬错误（core capabilities.steer=unsupported）
      coldStartMs: 1500,  // 首轮含常驻进程引导；后续任务共享连接摊薄为 ~0
    };
  }

  /**
   * 启动一次任务（立即返回，不等待完成）。
   *
   * 路由输入三层（core D9）：taskCtx.engine（调用参数显式指定，优先级最高）
   * > taskCtx.agentEngine（agent .md frontmatter engine）> 全局缺省 zcode。
   * timeoutMs 为正数时本层计时 abort（abortCause='timeout'），engine 杀链
   * 收尾后合成终态；null/undefined = 不限时（对齐 DEFAULTS.timeoutMs=null）。
   *
   * @param {TaskCtx} taskCtx 见 ports.js（runEnv 字段已随 model-router 瘦身废弃）
   * @param {object} [hooks] exec 变异通知（manager 的 pid 持久化通道，A5）
   * @param {(snapshot: object) => void} [hooks.onExec] exec 字段就绪时回调
   *        （engineId/pid/poolKey/sessionId 各一次），参数是 exec 的浅拷贝
   *        快照——调用方落盘后不受 exec 后续回填串扰。钩子异常不炸穿执行体
   *        （done 后 manager 的终态 exec 重写是兜底通道）。
   * @returns {{exec: object, cancel: function(): void, done: Promise<RunResult>}}
   *          done 对 prepare 期错误（凭据缺失/模型不可用/路由失败）reject——
   *          manager._execRound 与 agent-runner-adapter 的 catch 均已收口。
   */
  start(taskCtx, hooks = {}) {
    if (!taskCtx || typeof taskCtx.prompt !== 'string' || taskCtx.prompt === '') {
      throw new Error(
        'CoreRunner.start: taskCtx.prompt 必填（收到空值）。'
        + '恢复指引：经 manager.start 或 agent-runner-adapter 组装 taskCtx（prompt 已由 buildPrompt 拼装）。'
      );
    }
    const controller = new AbortController();
    const exec = {
      kind: 'appserver',
      pid: undefined,
      sessionId: undefined,
      engineId: undefined,
      poolKey: undefined,
      cwd: taskCtx.cwd,
    };
    let abortCause = null; // 先到者定语义：'cancel' | 'timeout'
    // exec 变异通知（A5）：回调浅拷贝快照而非引用——调用方持久化后不受后续
    // 回填串扰；异常吞掉只记日志（终态 exec 重写是兜底，不能让落盘失败炸穿执行体）
    const notifyExec = () => {
      if (typeof hooks.onExec !== 'function') return;
      try {
        hooks.onExec({ ...exec });
      } catch (e) {
        this._log(`onExec 钩子失败（忽略，终态 exec 重写兜底）: ${e && e.message || e}`);
      }
    };
    const timeoutMs = Number.isFinite(taskCtx.timeoutMs) && taskCtx.timeoutMs > 0 ? taskCtx.timeoutMs : null;
    const timer = timeoutMs !== null
      ? setTimeout(() => {
        if (!controller.signal.aborted) {
          abortCause = 'timeout';
          controller.abort();
        }
      }, timeoutMs)
      : null;

    const done = (async () => {
      try {
        const core = coreRef.requireCore();
        // 路由（P4 三层 + probe + fallback 守卫）。zsw 单引擎语境的
        // globalDefaultEngine=zcode：不传则 core 归一到 'pi'（zsw 未注册，必炸）。
        const route = await core.routeEngine({
          routing: {
            callEngine: taskCtx.engine,
            agentEngine: taskCtx.agentEngine,
            globalDefaultEngine: ZCODE_ENGINE_ID,
          },
          taskModel: taskCtx.modelRef,
          // strict 定格 false：zsw 单引擎生产形态下 fallback 目标本就不可达
          // （_engineFor 抛错），false 保持 core 守卫语义原样透出
          strict: false,
          probe: (id) => this._engineFor(id).probe(),
          getEngineFn: (id) => this._engineFor(id),
          hasEngineFn: (id) => this._hasEngine(id),
          listEnginesFn: () => this._listEngines(),
        });
        exec.engineId = route.engineId;
        notifyExec();
        if (route.engineFallback) {
          // D9① fallback 留痕出声（record 面由 RunResult.engineFallback 透传）
          this._log(`engine fallback: ${route.engineFallback.from} → ${route.engineId}（${route.engineFallback.reason}）`);
        }

        const deny = mergeDenyTools(taskCtx);
        // task 形状 = core AgentCallOpts（u-3b D6 合流：旧 AgentTaskSpec 并入，
        // 2026-09 vendored 0.5.1+ 生效）：prompt 文本在 task.prompt（旧 task.task
        // 字段已废弃——core buildPrompt 读 task.prompt，传旧字段名会拼出空
        // prompt，触发 runTurn 空投递守卫 + 首轮误分类 conn-closed + 重试同败）。
        // description 复用 AgentCallOpts 既有键承载 zsw slug：pi 路径 dist:20881
        // 以 task.description 派生 slug，zcode 路径 dist:18411 超时错误文案读
        // task.description 定位任务——传 slug 裸键 core 不消费（曾致 engine_timeout
        // 文案恒 slug=unknown）；thinkingLevel（旧 effort）zsw 从未透传，不新增。
        const spec = {
          prompt: taskCtx.prompt,
          description: taskCtx.slug,
          model: taskCtx.modelRef,
          cwd: taskCtx.cwd,
          // conversation 刻意不透传：zcode engine 对 task.conversation=true 在
          // prepare 期显式拒绝（capabilities.conversation=unsupported）；zsw 壳层
          // 的 conversation 语义只作用于 record 状态机（首轮完成置 idle）
          ...(deny.length > 0 ? { denyTools: deny } : {}),
        };
        const runCtx = {
          taskId: taskCtx.subagentId,
          // zsw 无 journal writer（事件面归 core 宿主），poolKey 占位即可；
          // onPoolResolved 回填 exec 供诊断与 P3 冷续聊定位
          poolKey: 'shared',
          signal: controller.signal,
          // appserver 常驻路径的运行中句柄回填（core §3.4 不变量 3：create 应答后
          // 立即回调，早于 send/终态/run resolve）——本层消费为 sessionRef 落位，
          // 经 onExec 钩子持久化进 record（exec.kind 恒 'appserver'，无需翻转）
          onHandleReady: (partial) => {
            if (partial && partial.sessionRef && typeof partial.sessionRef === 'object') {
              // 浅拷贝防 engine 侧后续变异串扰已落盘快照（与 onExec 快照同款纪律）
              exec.sessionRef = { ...partial.sessionRef };
              if (typeof partial.sessionRef.sessionId === 'string') {
                exec.sessionId = partial.sessionRef.sessionId;
              }
            }
            if (partial && typeof partial.poolKey === 'string') exec.poolKey = partial.poolKey;
            notifyExec();
          },
          onPoolResolved: (poolKey) => { exec.poolKey = poolKey; notifyExec(); },
          engineFallback: route.engineFallback,
        };
        const { outcome } = await route.engine.run(spec, runCtx);
        if (outcome.sessionId !== undefined) {
          exec.sessionId = outcome.sessionId;
          notifyExec();
        }
        return outcomeToRunResult(outcome, abortCause, route.engineFallback);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    })();

    return {
      exec,
      cancel: () => {
        if (!controller.signal.aborted) {
          abortCause = 'cancel';
          controller.abort();
        }
      },
      done,
    };
  }

  /**
   * 续聊一轮：core EnginePort 面无 resume 入口（capabilities.conversation=
   * unsupported——appserver 常驻亦无同进程 idle 复用，D4 每任务自包含），显式
   * 报可操作错误。冷续聊回归路线 P3（core read/resume 面扩容后接入）。
   */
  resume(exec) {
    throw new Error(
      'CoreRunner.resume: core zcode engine 的 EnginePort 面无 resume 入口'
      + '（capabilities.conversation=unsupported，无同进程 idle 复用），'
      + 'conversation 续聊暂不可用。'
      + `恢复指引：重新 start 派发新任务（上下文写进 task 文本）。冷续聊回归路线见 P3。`
      + (exec && exec.sessionId ? `（原会话 sessionId=${exec.sessionId}，历史可读性待 P3 read 面接入）` : '')
    );
  }

  /**
   * 一次性会话终态释放：no-op——spawn 单轮 done 即进程退出；appserver 常驻会话
   * 跨任务共享（engine 内部 attempt 收尾时已退订 activeSessions），本层无 per-
   * record 释放面（与旧语义一致，上层可统一调用）。
   */
  release() {}

  /**
   * 探活：按 exec 形态分支（崩溃恢复依据，唯一消费面 manager.recover——
   * 只对非终态 record 调用）。
   * - spawn：pid 信号 0 探测，原语消费 core isProcessAlive（V5e 收口，语义
   *   等值：信号 0 成功 → 存在；EPERM → 存在但属主不同，按存在算；其余 → 不存在）；
   * - appserver：保守视为存活。core 未暴露任务级探活面——常驻进程 pidfile/
   *   activeSessions/连接状态全是引擎内部实现（barrel 未导出探活原语，深路径
   *   require 禁止），且「常驻进程活着」也不等于「本任务 turn 仍在推进」；
   *   recover 语境下句柄已丢、结果无论是否推进都无法回流，orphan（建议
   *   cancel 后重发）才是正确处置，不发明「进程已死」的失真断言。
   */
  alive(exec) {
    if (!exec) return false;
    if (exec.kind === 'appserver') return true;
    if (exec.kind !== 'spawn' || !Number.isInteger(exec.pid)) return false;
    return coreRef.requireCore().isProcessAlive(exec.pid);
  }

  /**
   * 进程级收尾（daemon 退出面）：
   * ① 对本层持有的引擎实例逐个 dispose（appserver 常驻进程的收割入口——
   *    EnginePort.dispose 契约：fire close 帧 → 同步 SIGTERM → grace → SIGKILL，
   *    幂等）。注意 core 的 killAllSpawnedChildren 内部 disposeEngines() 只
   *    覆盖 registry 已实例化单例，而 zsw 真正跑任务的实例在本层惰性表
   *    （routeEngine 的 getEngineFn 注入，不进 registry）——不补这步常驻进程
   *    必泄漏。dispose 先于 killAll（D6①：close 帧必须先于 SIGTERM）。
   * ② killAllSpawnedChildren：spawn 形态 per-record 子进程兜底收割（正常路径
   *    各 handle 的 cancel/timeout 已走杀链）。best-effort 不抛。
   * spawn 模式回归不变：无 dispose 成员的引擎（旧 fake/无常驻资源实现）跳过，
   * killAll 行为与 2c 前一致。
   */
  async shutdown() {
    const engines = this._customEngines !== null
      ? [...this._customEngines.values()]
      : [...this._lazyEngines.values()];
    for (const eng of engines) {
      if (!eng || typeof eng.dispose !== 'function') continue;
      try {
        await eng.dispose();
      } catch (e) {
        this._log(`engine dispose 失败（best-effort）: ${e && e.message || e}`);
      }
    }
    try {
      coreRef.requireCore().killAllSpawnedChildren();
    } catch (e) {
      this._log(`killAllSpawnedChildren 失败（best-effort）: ${e && e.message || e}`);
    }
  }
}

module.exports = CoreRunner;
// 导出面刻意最小：仅类本体 + 测试直接消费的登记入口；引擎 id / 终态映射 /
// deny 并集 / 数据根 getter 等内部承重件不再外露
module.exports.ensureZcodeEngineRegistered = ensureZcodeEngineRegistered;
