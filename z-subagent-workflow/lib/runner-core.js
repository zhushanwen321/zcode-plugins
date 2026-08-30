'use strict';
/**
 * RunnerPort 的 core engine 实现（回接计划 2c，D6-⑥）。
 *
 * zsub 执行链整体切到 vendored subagent-core 的引擎抽象：
 *   start → routeEngine（三层路由 + probe + fallback 三守卫）→ EnginePort.run
 *   （zcode 引擎：preparer 隔离 HOME 池 → launcher spawn 单轮 → parser 终 JSON）。
 * stdout 解析归 core parser（D6-①），zsw 侧不再有解析段；per-provider+model
 * HOME 池 / 凭据预检 / 兜底模型全在引擎 preparer 内（TS 重写自 zsub 同源机制），
 * 本层只做端口形状映射。appserver 常驻通道已按 D6-⑥ 退役——常驻实现的
 * 回归路线见 P3（core zcode engine 内部换常驻实现，EnginePort 接口常驻友好）。
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
 *   {kind:'spawn', pid, sessionId?, engineId?, poolKey?, cwd}
 *   - kind:'spawn'：spawn 单轮语义（record.runnerKind 台账格式与旧 spawn 回退
 *     一致，D7 旧数据可读不受影响）
 *   - pid：onChildSpawned 回调回填（可变引用，崩溃恢复探活依据）
 *   - sessionId/poolKey：done 后回填（P3 冷续聊回归时的定位锚）
 *
 * 行为边界（README「回接 2c break 变更」节对应）：
 *   - resume（conversation 续聊）：core EnginePort 面无 resume 入口
 *     （launcher 支持 --resume 但 run 未透出），显式报可操作错误——旧 spawn
 *     回退的 --resume 冷续聊让渡，随 P3 常驻实现回归
 *   - message/close：spawn 单轮降级语义（message 经 manager 走 resume 即报上述
 *     错误；close 是壳层 record 终态化，runner 无驻留对应物）
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

/** 测试隔离：重建登记标记。 */
function resetZcodeRegistration() {
  zcodeRegistered = false;
}

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
   * @param {boolean} [opts.strict] routeEngine strict（probe 失败一律报错不
   *        fallback）。缺省 false——zsw 单引擎生产形态下 fallback 目标本就
   *        不可达（engineFor 抛错），false 保持 core 守卫语义原样透出。
   * @param {(msg: string) => void} [opts.log] 诊断通道（缺省 stderr）
   */
  constructor(opts = {}) {
    this._customEngines = opts.engines instanceof Map ? opts.engines : null;
    this._lazyEngines = new Map();
    this._strict = opts.strict === true;
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
   * 组装期探针门控与探针落盘缓存已随 appserver 通道退役（assemble 不再消费本方法做
   * 降级决策）；保留真探针实现供诊断面与契约完备。
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
      kind: 'spawn',
      steering: 'none',   // argv-only spawn 单轮，无运行中插话通道（core capabilities.steer=unsupported）
      coldStartMs: 1500,  // 每轮一次完整 node 进程 + CLI 启动（engine spawn 同构）
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
   * @returns {{exec: object, cancel: function(): void, done: Promise<RunResult>}}
   *          done 对 prepare 期错误（凭据缺失/模型不可用/路由失败）reject——
   *          manager._execRound 与 agent-runner-adapter 的 catch 均已收口。
   */
  start(taskCtx) {
    if (!taskCtx || typeof taskCtx.prompt !== 'string' || taskCtx.prompt === '') {
      throw new Error(
        'CoreRunner.start: taskCtx.prompt 必填（收到空值）。'
        + '恢复指引：经 manager.start 或 agent-runner-adapter 组装 taskCtx（prompt 已由 buildPrompt 拼装）。'
      );
    }
    const controller = new AbortController();
    const exec = {
      kind: 'spawn',
      pid: undefined,
      sessionId: undefined,
      engineId: undefined,
      poolKey: undefined,
      cwd: taskCtx.cwd,
    };
    let abortCause = null; // 先到者定语义：'cancel' | 'timeout'
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
          strict: this._strict,
          probe: (id) => this._engineFor(id).probe(),
          getEngineFn: (id) => this._engineFor(id),
          hasEngineFn: (id) => this._hasEngine(id),
          listEnginesFn: () => this._listEngines(),
        });
        exec.engineId = route.engineId;
        if (route.engineFallback) {
          // D9① fallback 留痕出声（record 面由 RunResult.engineFallback 透传）
          this._log(`engine fallback: ${route.engineFallback.from} → ${route.engineId}（${route.engineFallback.reason}）`);
        }

        const deny = mergeDenyTools(taskCtx);
        const spec = {
          task: taskCtx.prompt,
          slug: taskCtx.slug,
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
          onChildSpawned: (child) => { if (child && Number.isInteger(child.pid)) exec.pid = child.pid; },
          onPoolResolved: (poolKey) => { exec.poolKey = poolKey; },
          engineFallback: route.engineFallback,
        };
        const { outcome } = await route.engine.run(spec, runCtx);
        if (outcome.sessionId !== undefined) exec.sessionId = outcome.sessionId;
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
   * 续聊一轮：core EnginePort 面无 resume 入口（zcode launcher 支持 --resume
   * 但 EnginePort.run 未透出——core 面缺口，报告已登记），显式报可操作错误。
   * 旧 spawn 回退的 --resume 冷续聊随本次切换让渡，回归路线 P3。
   */
  resume(exec) {
    throw new Error(
      'CoreRunner.resume: core zcode engine 的 EnginePort 面无 resume 入口（spawn 单轮模式），'
      + 'conversation 续聊暂不可用（appserver 通道已按设计 D6-⑥ 退役）。'
      + `恢复指引：重新 start 派发新任务（上下文写进 task 文本）。常驻实现与冷续聊回归路线见 P3。`
      + (exec && exec.sessionId ? `（原会话 sessionId=${exec.sessionId}，历史可读性待 P3 read 面接入）` : '')
    );
  }

  /**
   * 一次性会话终态释放：no-op——engine spawn 单轮，done 即进程退出，无驻留
   * 会话/聚合缓冲等释放面（与旧 spawn 回退同语义，上层可统一调用）。
   */
  release() {}

  /**
   * 探活：pid 信号 0 探测（ESRCH → 不存在；EPERM → 存在但属主不同，按存在算）。
   */
  alive(exec) {
    if (!exec || exec.kind !== 'spawn' || !Number.isInteger(exec.pid)) return false;
    try {
      process.kill(exec.pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  }

  /**
   * 进程级收尾（daemon 退出面）：杀掉 core 引擎 spawn 的全部子进程（兜底
   * 收割——正常路径各 handle 的 cancel/timeout 已走杀链）。best-effort 不抛。
   */
  async shutdown() {
    try {
      coreRef.requireCore().killAllSpawnedChildren();
    } catch (e) {
      this._log(`killAllSpawnedChildren 失败（best-effort）: ${e && e.message || e}`);
    }
  }
}

module.exports = CoreRunner;
module.exports.ZCODE_ENGINE_ID = ZCODE_ENGINE_ID;
module.exports.outcomeToRunResult = outcomeToRunResult;
module.exports.toZswUsage = toZswUsage;
module.exports.mergeDenyTools = mergeDenyTools;
module.exports.ensureZcodeEngineRegistered = ensureZcodeEngineRegistered;
module.exports.resetZcodeRegistration = resetZcodeRegistration;
module.exports.zswEngineDataDir = zswEngineDataDir;
