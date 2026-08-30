import { ChildProcess } from 'node:child_process';
import { E as EngineCapabilities, P as ProbeReport, A as AgentTaskSpec, a as AgentEvent, b as EngineHandle, c as AgentOutcome, I as InteractAction, d as InteractResult, S as SessionView, e as AgentUsage, f as AgentCallOpts, g as AgentResult, h as ExecutionTraceNode, T as TracePatch, R as RunStatus, D as DoneReason, W as WorkerLogEntry } from './types-BxyAidGf.cjs';
export { i as EngineHandleData, j as PersonaSpec, k as ReplayedTurn } from './types-BxyAidGf.cjs';
import { Worker } from 'node:worker_threads';

/**
 * 模型信息（registry 返回元素 / ctx.model 鸭子类型兼容）。
 * ctx.model（SDK Model<Api>）是此类型的超集，运行时直接当 ModelInfo 用。
 */
interface ModelInfo {
    id: string;
    name: string;
    provider: string;
    reasoning: boolean;
    thinkingLevelMap?: Record<string, unknown>;
    contextWindow?: number;
}

/** 日志级别。对齐 @zhushanwen/pi-extension-logger 的 LogLevel（三值，无 info）。 */
type LogLevel = "debug" | "warn" | "error";
/** core logger 接口。与 pi-extension-logger 的 ExtensionLogger 结构兼容——
 *  u0-log 批次替换是纯 import 源替换，调用面（方法名/参数序）逐文件等价。 */
interface CoreLogger {
    debug(msg: string, data?: unknown): void;
    warn(msg: string, data?: unknown): void;
    error(msg: string, data?: unknown): void;
}
declare function getLogger(component: string): CoreLogger;

/** 发现根条目：dir 为扫描根路径；source 是宿主提供的语义标签（遮蔽报告透传用）。
 *  source 不枚举封闭集——core 只透传不解释（宿主如 pi 壳用 user-pi/npm/npm-dev）。 */
interface DiscoveryRoot {
    dir: string;
    source: string;
}
interface HostServices {
    /** 数据根目录：引擎隔离池 / journal / record 派生存放的锚点。
     *  pi 壳返回 getAgentDir()（独立 pi 用户 journal 不漂目录）；zsw 壳返回 zsw 数据根。 */
    dataRoot(): string;
    /** 结构化日志：对齐现 getLogger 调用面（level/component/message/data）。缺省 sink 按级分化：
     *  warn/error 走 console、debug no-op（对齐 pi-extension-logger 语义，见 NULL_HOST.log）。 */
    log(level: LogLevel, component: string, message: string, data?: unknown): void;
    /** agent/skill/workflow 资源发现根（可选端口，缺席 = 调用方降级）。宿主只提供根列表
     *  （按优先级低→高）；扫描 / 同名遮蔽（last-writer-wins）/ 遮蔽报告语义归 core 统一。 */
    discoveryRoots?(): {
        agents?: DiscoveryRoot[];
        skills?: DiscoveryRoot[];
        workflows?: DiscoveryRoot[];
    };
}
/** core 缺省数据根（~/.subagent-core，homedir 推导——禁止写死绝对路径，排查规则）。
 *  供无自有数据根的轻宿主显式采用；core 自身不静默兜底到该值。 */
declare const DEFAULT_DATA_ROOT: string;
declare function configureCore(host: HostServices): void;

/** 投递意图（与 session-delivery 的 DeliveryIntent 字面量一致）。 */
type DeliveryIntent = "interrupt-at-turn-boundary" | "after-run";
/** 文本 payload。 */
interface DeliveryTextPayload {
    kind: "text";
    content: string;
}
/** custom message payload（extension 通路）。 */
interface DeliveryCustomPayload {
    kind: "custom";
    customType: string;
    content: string;
    display: boolean;
    details?: unknown;
}
/** 判别联合 payload（envelope / payload 分离）。 */
type DeliveryPayload = DeliveryTextPayload | DeliveryCustomPayload;
/** 投递消息 envelope。 */
interface DeliveryMessage {
    payload: DeliveryPayload;
    /** 缺省回落工厂 options.intent。 */
    intent?: DeliveryIntent;
    /** 去重 key（工厂开 dedupe 时必填）。 */
    dedupeKey?: string;
}
/** port.send 的受理回执（U2 扩展位；void = 受理未知，按成功处理）。 */
interface DeliverySendReceipt {
    accepted: boolean;
    reason?: string;
}
/** 投递端口：内核与外部世界的唯一接口（notifier 装配，intent→宿主参数翻译在适配器内）。 */
interface DeliveryPort {
    /** 本通路支持的 payload kind（不支持的 kind 由工厂 fail-fast）。 */
    supportedPayloads: readonly DeliveryPayload["kind"][];
    /** 主 agent 是否空闲（gate 投递时机）。 */
    isIdle(): boolean;
    /** 是否有排队中的消息。 */
    hasPendingMessages(): boolean;
    /** 投递消息。返回受理回执或 void（扩展位——旧实现返回 void 兼容）。 */
    send(msg: DeliveryMessage, intent: DeliveryIntent): void | DeliverySendReceipt | Promise<void | DeliverySendReceipt>;
    /** agent_settled 边沿订阅。缺省时工厂退化退避轮询；返回退订函数。 */
    subscribeSettled?(cb: () => void): () => void;
}
/** 投递工厂 options（notifier 实际消费的字段集；其余策略字段未入端口面）。 */
interface DeliveryConfig {
    intent?: DeliveryIntent;
    busyPolicy?: "retry-force" | "park";
    /** 合批窗口（ms）：0 = 关；>0 = 滑动窗口合批。 */
    mergeWindowMs?: number;
    /** 合批依赖谓词（禁止用 isIdle 代替——D4 must-fix 语义）。 */
    mergeHoldActive?: () => boolean;
    backoff?: {
        ms: number;
        max: number;
    };
    dedupe?: {
        maxKeys: number;
    };
    /** 投递失败警告出口（U4：装配方接 logger 使警告落日志盘而非 stderr）。 */
    warn?: (msg: string, err?: unknown) => void;
}
/** 投递句柄（notifier 消费面：send / flush / dispose——诊断面 depth 等不入端口）。 */
interface DeliveryHandle {
    /** 唯一常规入口（合批窗口 + 空闲零延迟立即投）。 */
    send(msg: DeliveryMessage, opts?: {
        merge?: boolean;
    }): void;
    /** 强制投递尝试（shutdown flush 等）。 */
    flush(): void;
    /** 销毁（清队列 + 清 timer + 退订）。 */
    dispose(): void;
}
interface NotifyDomainPorts {
    /** pending 活跃计数（pi 会话 entries 中 register − unregister 差集的数值）。
     *  契约为 number 而非 pi 侧 CountActiveResult：core 消费面只读 count，契约面最窄；
     *  pi 壳注入时拆 `countActiveFromEntries(entries).count`。 */
    countActiveFromEntries?(entries: unknown[]): number;
    /** 投递内核工厂。签名与 @xyz-agent/session-delivery 的 createDelivery 结构兼容，
     *  pi 壳直传其本体即可。缺席 = 消费方降级直发。 */
    createDelivery?(port: DeliveryPort, options?: DeliveryConfig): DeliveryHandle;
}
declare function configureNotifyDomain(ports: NotifyDomainPorts): void;

/**
 * subagent text_delta streaming sink。
 *
 * background subagent 执行期间，session-runner 的 agentEvent 出口把每个 text_delta
 * 传到 SubagentStream.onDelta。本模块做 100ms 时间窗合并后，通过 StreamSink.setWidget
 * 转发到 RPC stdout（经 ctx.ui.setWidget → extension_ui_request 通道）。
 *
 * SubagentStream 是一个生命周期对象——内聚 buffer/timer 状态 + onDelta/dispose 方法。
 * 调用方（subagent-service）创建后只需在 text_delta 时调 onDelta、终态时调 dispose，
 * 不需要拆散 push/clear 两个函数跨层透传。
 *
 * 设计要点：
 * - leading edge：第一个 delta 立即 flush（前端尽快看到开始）
 * - trailing edge：后续 delta 追加 buffer，timer 到期后 flush
 * - 每次 flush 把 buffer 的累积文本 split("\n") 截尾 MAX_WIDGET_LINES 行传给 setWidget
 * - dispose 清除 widget + 清 timer
 */

/** UI streaming sink 的最小接口（ctx.ui.setWidget 的 duck-typed 子集）。
 *
 * 当前只有一个 adapter（index.ts session_start 包装 ctx.ui.setWidget）。
 * 保留接口而非裸函数类型，因为 StreamSink 的语义是「UI sink 契约」——
 * 测试 mock 和未来可能的第二 sink（如写文件）都走此契约。 */
interface StreamSink {
    setWidget(key: string, lines: string[] | undefined): void;
}
/**
 * subagent text_delta streaming 生命周期对象。
 *
 * 创建后：
 * - `onDelta(delta)`：session-runner 每次 text_delta 调
 * - `dispose()`：subagent 终态时调，清除 widget + 清 timer
 *
 * buffer/timer 状态全部内聚在此对象，调用方不需要关心合并逻辑。
 */
declare class SubagentStream {
    private readonly widgetKey;
    private readonly sink;
    private buffer;
    private timer;
    private hasFlushed;
    private disposed;
    constructor(recordId: string, sink: StreamSink);
    /** 接收一个 text_delta 增量。空串静默丢弃（不消耗 leading edge）。 */
    onDelta(delta: string): void;
    /** 终态清理：清除 widget + 清 timer（幂等）。 */
    dispose(): void;
    private flush;
}

/**
 * run 的运行期上下文。任务声明（AgentTaskSpec）与运行期句柄分离——signal/ctxModel/
 * onComplete 从 ExecuteOptions 移出（设计 §3.3.5 删字段去向），因为它们是宿主注入的
 * 运行期对象，不属于跨引擎持久化的任务声明。
 *
 * 常驻进程友好（D1）：onEvent 回调式（而非迭代器式）+ AbortSignal——引擎内部换常驻
 * server 实现（未来 driver host）时接口不动。
 */
interface RunContext {
    /** = record.id（bg-N-xxx / run-N）——journal 文件名与池引用计数 key（P2 消费）。 */
    taskId: string;
    /** D5 隔离池（宿主分配，设计 §3.3.9；pi 无池化恒 'shared'）。 */
    poolKey: string;
    /** abort 分级入口（D1：引擎原生中断 → 公共杀链兜底）。 */
    signal?: AbortSignal;
    /** 事件流出口（host 消费后统一落 journal，D6 第②级）。 */
    onEvent?: (event: AgentEvent) => void;
    /** model 解析第三层兼底（现有 D-008 语义不变）。 */
    ctxModel?: ModelInfo;
    /**
     * text_delta streaming 通道（宿主侧 UI widget）。与 onEvent 平行的 text_delta 出口：
     * background 路径 onEvent=undefined 但流式仍需送达（双通道互斥设计，见 session-runner
     * agentEvent 出口注释）。pi 回填期承载 AgentRunner port 的 stream 透传（行为零变化），
     * 语义上是宿主设施而非引擎专有——未来引擎的 text_delta 同样可走此通道。
     */
    stream?: SubagentStream;
    /**
     * [P1 pi 回填透传] 调用方已持有的 schema 激活预编码值（AgentCallOpts.schemaEnv 直传
     * 形态）。生产路径中 resolveAgentOpts 恒耦合产出 schema+schemaEnv（值 = JSON.stringify
     * (schema)），引擎从 task.schema 派生即可逐字节等值；解耦形态（有 schemaEnv 无
     * schema）生产不可达、仅见于直构调用，派生无源——本字段是其唯一透交通道。
     * 引擎在 task.schema 存在时忽略此值（派生优先，设计 §3.3.5 删字段去向）。
     */
    schemaEnv?: string;
    /**
     * [P4 D9①] 引擎 fallback 留痕（probe 失败路由回默认引擎）。路由层（routing.ts）
     * 产出，引擎投影到 outcome.engineFallback（zcode 等无 record 通路的引擎以此留痕；
     * pi 引擎另经 ExecuteOptions 投影进 record）。
     */
    engineFallback?: {
        from: string;
        reason: string;
    };
    /**
     * [P4 对齐点③] 引擎声明实际隔离池 key（journal 落盘路径权威）。宿主创建 journal
     * writer 时只能用缺省占位 poolKey（pi 恒 'shared'），非池化稳定的引擎（zcode 按
     * provider+model 池化）在 prepare 期确定 poolKey 后回调本方法重定向 writer——
     * 保证 journal 落盘路径与 handle.poolKey 同源（单一权威，不再两边推导）。
     * 契约：必须在首个事件 emit 之前调用（zcode coarse 事件在终态后合成，天然满足；
     * 未来流式引擎需在事件出口前调用）。
     */
    onPoolResolved?: (poolKey: string) => void;
    /**
     * [U0 D10] 引擎 spawn 的子进程句柄注册钩子（宿主终止链记账）。引擎在 spawn 成功后
     * 同步回调（与 pi runSpawn 的 spawnedChildren.set 同构时机）；宿主据此把 child 注册进
     * session-runner 的 spawnedChildren Map（cancel SIGTERM / dispose 收割兜底 / killAll
     * 全量清理对非 pi 引擎 record 生效）。close/error 后由宿主按句守卫移除。可选：引擎
     * 内部不 spawn 进程（如未来常驻 driver host 实现）时不调用，宿主记账自然为空。
     */
    onChildSpawned?: (child: ChildProcess) => void;
}
/**
 * run 的返回：终态 + 可持久化 handle。
 *
 * handle 语义（设计 §3.3.5 run 错误语义三条）：prepare 期错误（credential_missing /
 * model_not_available / prompt_too_large）在进程创建前 reject、不产生 handle；运行中
 * 失败不 reject——合成 error outcome + 正常 handle 返回（record 必须收尾）；abort 走
 * 完杀链后同前（exitCode=null + error 含杀链标记）。
 */
interface EngineRunResult {
    handle: EngineHandle;
    outcome: AgentOutcome;
}
/**
 * subagent 执行引擎的唯一契约点（D1）。实现方：PiEngine（回填）/ ZcodeEngine（P3）/
 * 未来各引擎适配器。上层（工具面/workflow 引擎/GUI）只消费中立类型，不感知引擎。
 *
 * 贯穿纪律（设计 §3.3.1）：宿主编排——引擎只当单 agent 执行器，六家原生多 agent 机制
 * 一律禁用不依赖。
 */
interface EnginePort {
    /** 注册表 key（'pi' | 'zcode' | ...）。 */
    readonly id: string;
    /** D3（同步无副作用——调用前拒绝的判据）。 */
    capabilities(): EngineCapabilities;
    /** D7（factory 初始化 + 版本变化检测触发；opts.force 跳过缓存强探）。 */
    probe(opts?: {
        force?: boolean;
    }): Promise<ProbeReport>;
    /** D1 主语义：fire-to-completion。 */
    run(task: AgentTaskSpec, ctx: RunContext): Promise<EngineRunResult>;
    /**
     * D1 可选面：交互控制面。pi 首期原生实现（现有 chatMode 行为直通）；不支持
     * conversation 的引擎返回 engine_capability_unsupported（同步拒绝、不创建进程）。
     */
    interact(handle: EngineHandle, action: InteractAction): Promise<InteractResult>;
    /** D6 三级降级链：①引擎原生读取 → ②宿主 event journal（P2）→ ③outcome-only。 */
    read(handle: EngineHandle): Promise<SessionView>;
    /**
     * [U7] 可选面：模型可发现性——引擎自带 provider/model 体系时（如 zcode 的 v2 桌面
     * 登录态），列出当前环境实际可用的模型清单（带凭据校验），供 system prompt 引擎段
     * 与 GUI 引擎选择器消费。省略/返回 null = 「与主 agent 模型体系一致」（pi 的语义：
     * system prompt 已有 <available_provider_models> 段，无需引擎再列）。
     * engine-neutral：未来引擎（AcpEngine 等）实现本方法即自动获得注入与展示，宿主
     * 侧零改动。
     */
    listModels?(): Array<{
        id: string;
        name?: string;
    }> | null;
}

/** 三层路由的输入（各层值由调用方装配；undefined = 该层不指定）。 */
interface EngineRoutingInput {
    /** 第一层：调用参数 engine（workflow step 级 / AgentCallOpts.engine）。 */
    callEngine?: string;
    /** 第二层：agent .md frontmatter engine（解析期已对注册表校验）。 */
    agentEngine?: string;
    /** 第三层：全局默认引擎（config.json defaultEngine；缺省 'pi'）。 */
    globalDefaultEngine?: string;
}
/** 生效层标记（守卫 a 的判据：'call' = 显式指定，probe 失败不兜底）。 */
type EngineRoutingSource = "call" | "frontmatter" | "default";
interface EngineRouting {
    engineId: string;
    source: EngineRoutingSource;
}
/** routeEngine 的参数（probe/getEngine 注入——测试可 mock，SAR 提供生产实现）。 */
interface EngineRouteOptions {
    routing: EngineRoutingInput;
    /**
     * 显式 model（守卫 c 判据：model 与引擎 provider 体系绑定，D9②）。短名 model 的
     * provider 缺省决策在 zcode preparer 的 defaultProviderForShortName——显式默认引擎
     * 模型配置（config.json per-engine model）引入时，两处须同步让位配置值优先
     * （对齐点⑦，详见 preparer.ts 该函数注释）。
     */
    taskModel?: string;
    /** engineRouting.strict（config.json）：true = 一切 probe 失败直接报错。 */
    strict: boolean;
    /** 探针执行体（返回 ProbeReport；引擎实例内部有缓存语义）。 */
    probe: (engineId: string) => Promise<ProbeReport>;
    /** 引擎获取（缺省 registry.getEngine；测试/SAR 可注入）。 */
    getEngineFn?: (engineId: string) => EnginePort;
    /** 注册表存在性检查（缺省 registry.hasEngine）。 */
    hasEngineFn?: (engineId: string) => boolean;
    /** 注册表清单（缺省 registry.listEngines——engine_not_found 文案的数据源）。 */
    listEnginesFn?: () => string[];
}
interface EngineRouteResult {
    engine: EnginePort;
    /** 实际执行引擎 id（fallback 后可能 ≠ 请求值）。 */
    engineId: string;
    /** 路由决策时的请求引擎 id（fallback 留痕的 from 值）。 */
    requestedEngineId: string;
    /** 生效层（守卫 a 判据的留痕）。 */
    source: EngineRoutingSource;
    /** fallback 留痕（record/outcome 投影，GUI 警告条数据源）。无 fallback 缺省。 */
    engineFallback?: {
        from: string;
        reason: string;
    };
}
/**
 * 路由 + 探针 + fallback 编排（SAR run 入口调用）。
 *
 * 失败形态（全部抛结构化错误，调用方转 AgentResult.error）：
 *   - 未注册 id（调用参数层漏网）：EngineNotFoundError（engine_not_found）
 *   - strict 或守卫命中：EngineError(engine_probe_failed)
 *   - 守卫 c（显式 model + 将换引擎）：EngineError(model_not_available)
 */
declare function routeEngine(opts: EngineRouteOptions): Promise<EngineRouteResult>;

/**
 * Workflow Extension — Worker Handle
 *
 * node:worker_threads.Worker 的线程句柄封装。技术资源，Infra 层具体类（D-12）。
 * RunRuntime 直接持有，不经 interface（§domain-models 9）。
 *
 * 核心职责：竞态防护（G-025）。
 *
 * 背景：一个 run 可经历多个 WorkerHandle（终止/重试各换一个）。
 * 需防止「terminate(old) → start(new) → old exit fires」竞态——
 * WorkerHandle 把守卫内化：terminate 后 isCurrent=false，
 * 已终止 handle 的 onMessage/onError/onExit 回调自动 no-op（无需调用方比对引用）。
 *
 * 层归属：Infra（D-12）。仅依赖 node:worker_threads（Node 原生）。
 */

/** Worker → Main 业务消息回调。 */
type WorkerMessageHandler = (raw: unknown) => void;
/** Worker 线程 uncaught error 回调。 */
type WorkerErrorHandler = (err: Error) => void;
/** Worker 线程 exit 回调（code=0 正常退出，非 0 崩溃）。 */
type WorkerExitHandler = (code: number) => void;
declare class WorkerHandle {
    private readonly worker;
    /**
    * 竞态守卫。true = 此 handle 仍是当前活动 handle；false = 已 terminate，
    * 后续事件（已终止 worker 延迟触发的 message/error/exit）必须忽略。
    *
    * 终止后置 false 并永不回升（幂等语义）。新 handle 由调用方（WorkerHost）
    * 重新创建，已终止 handle 留在内存里直到 GC，但其回调全部 no-op。
    */
    private current;
    constructor(worker: Worker);
    /** 此 handle 是否仍是当前活动 handle（terminate 后 false，G-025）。 */
    get isCurrent(): boolean;
    /** 底层 Worker（WorkerHost/RunRuntime 偶尔需要直接访问，如 ref/href）。 */
    get raw(): Worker;
    /**
    * 向 worker 发送消息。terminate 后 no-op（已终止 handle 的 postMessage 无意义）。
    */
    postMessage(msg: unknown): void;
    /**
    * 终止 worker 线程。幂等——重复调用安全，第二次起 no-op。
    * 置 isCurrent=false 后再 await worker.terminate，确保并发 exit 事件
    * 在 terminate resolve 之前到达时也被守卫拦下。
    */
    terminate(): Promise<void>;
    /**
    * 绑定 message 回调。仅当 isCurrent 时触发——已终止 handle 的事件被吞掉。
    * 返回 this 便于链式 onMessage(...).onError(...).onExit(...)。
    */
    onMessage(handler: WorkerMessageHandler): this;
    /**
    * 绑定 error 回调。仅当 isCurrent 时触发。
    */
    onError(handler: WorkerErrorHandler): this;
    /**
    * 绑定 exit 回调。仅当 isCurrent 时触发——这是 G-025 的关键守卫：
    * terminate(old) → startWorker(new) → old exit 触发时，old handle.current
    * 已为 false，回调 no-op，不会误删 new worker。
    */
    onExit(handler: WorkerExitHandler): this;
}

/**
 * Workflow Extension — Budget 值对象
 *
 * Token / cost 预算值对象（D-12）。纯数据 + 不变式守卫，无副作用。
 *
 * maxTokens===0 视为不限制（守卫，避免首个 agent 完成误判 budget_limited）。
 * （预算语义对齐 2026-08：soft-limit 常量（500 调用数预警）与 90% 阈值预警方法
 * 已删——全库无生产消费方，仅测试锁定。）
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §4（字段/不变式/操作）。
 */

/**
 * Budget 值对象。
 *
 * 不变式（domain-models.md §4）：
 * - maxTokens > 0 守卫：maxTokens===0 或 undefined 视为不限制
 * - maxCost > 0 守卫：同上
 * - consume 只累加，不减；isExceeded 只读
 * - 无回调字段——所有副作用由调用方在 consume 后查询决定
 */
declare class Budget {
    readonly maxTokens?: number;
    readonly maxCost?: number;
    readonly maxTimeMs?: number;
    usedTokens: number;
    usedCost: number;
    /** 总调用计数（持久化/诊断用；execute-agent-call 每次 dispatch 后 increment）。 */
    totalCallCount: number;
    constructor(opts?: {
        maxTokens?: number;
        maxCost?: number;
        maxTimeMs?: number;
        usedTokens?: number;
        usedCost?: number;
        totalCallCount?: number;
    });
    /**
    * 累加一次 agent 调用的 usage（加权口径）。
    *
    * 四项 token 按各自权重（INPUT/CACHE_READ/CACHE_WRITE/OUTPUT_WEIGHT）折算后求和，
    * 而非原始 token 数直接相加。retry 间的真实消耗如实记录，避免预算被低估。
    * 详见上方权重常量的口径说明。
    */
    consume(usage: AgentUsage): void;
    /** 累加调用计数（每次 agent dispatch 后调用；持久化快照同步）。 */
    incrementCallCount(): void;
    /**
    * 是否超 token / cost 预算（FR-3）。
    *
    * maxTokens===0 或 undefined 视为不限制（守卫）；
    * maxCost===0 或 undefined 视为不限制。
    * 时间预算（maxTimeMs）不由本方法判断——它是 wall-clock 约束，需参照 startedAt，
    * 由 lifecycle 层的 scheduleTimeBudget（runWorkflow 内 setTimeout）
    * 独立调度，到期 abortRun(doneReason="time_limited")。
    */
    isExceeded(): boolean;
    /**
    * 剩余 token 预算。maxTokens 未设或 ≤0 时返回 undefined（视为不限制）。
    *
    * 嵌套 workflow() 调用时由 executeNestedWorkflow 消费：子 run 的 budgetTokens
    * 继承父 run 的剩余预算，实现父子预算隔离下的总量约束。
    */
    remaining(): number | undefined;
}

/**
 * Workflow Extension — RunSpec 值对象
 *
 * 单次 workflow run 的不可变规格（domain-models.md §2）。
 *
 * 设计：
 * - 全部字段 readonly——run 一旦创建，规格不可改（状态变化走 RunState）
 * - scriptSource 是已 strip `export const meta` 的可执行源（WorkflowScript.toExecutable）
 * - budgetTokens/budgetTimeMs 是上限（可选，未设 = 不限制）
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §2。
 */

/**
 * RunSpec——一次 workflow run 的不可变输入规格。
 *
 * 作为 RunStore 持久化的一部分（WorkflowRun.spec），崩溃恢复重水合后
 * 需要 scriptSource/args 重建 worker（G3-001）。
 */
interface RunSpec {
    /** 已 strip export 的可执行源（WorkflowScript.toExecutable 产物）。 */
    readonly scriptSource: string;
    /**
    * 参数契约（JSON Schema draft-07，来自 script.meta.parameters 整对象透传，m3 DM2）。
    *
    * undefined = 不校验（安全退化——漏拷 parameters 退化是「不校验」非「校验错」）。
    * 由调用方（actionRun/runAndWait/executeNestedWorkflow）从 script.meta.parameters 拷贝。
    * lifecycle.runWorkflow 首行经 validateRunArgs 校验 spec.args（coerceTypes 原地规范化
    * args 对象内容，字段引用不变；worker 启动与崩溃重建共用同一对象）。
    */
    readonly parameters?: Record<string, unknown>;
    /** 调用方传入的参数（worker 内通过 $ARGS 访问）。 */
    readonly args: Record<string, unknown>;
    /**
    * Run 级 model override（Option B：经 workerData → worker global $MODEL → agent() fallback）。
    *
    * undefined = 继承主 agent 模型（零配置默认）。设置时该 run 内所有 agent() 调用默认继承
    * （除非 per-call 显式指定 model）。注意：不 merge 进 args（对称单路径注入），
    * 而是经 worker-script-builder 注入为 $MODEL worker global。
    */
    readonly model?: string;
    /**
    * Run 级 thinkingLevel override（Option B：经 workerData → worker global $THINKING_LEVEL）。
    *
    * undefined = 继承主 agent thinkingLevel。取值范围由 THINKING_ORDER SSOT 派生（含 max）。
    */
    readonly thinkingLevel?: string;
    /** Token 预算上限（未设或 0 = 不限制，见 Budget 守卫）。 */
    readonly budgetTokens?: number;
    /** 时间预算上限（ms，wall-clock，由 lifecycle.scheduleTimeBudget 调度）。 */
    readonly budgetTimeMs?: number;
    /**
    * 父 Budget 共享引用（嵌套 workflow() 时由 executeNestedWorkflow 传入）。
    *
    * 设置时 lifecycle.runWorkflow 直接复用此 Budget 实例，而非 new 一个独立 Budget——
    * 子 run 的 consume 直接反映到父 Budget，消除并行嵌套下的超支窗口（F-7 方案 B）。
    * 顶层 run 无此字段（budgetTokens 走独立 Budget 构造）。
    */
    readonly budgetRef?: Budget;
    /** 脚本名（meta.name 或文件名 stem）。 */
    readonly scriptName: string;
    /**
    * Run 级简短标签（≤20 字符），区别于 scriptName（脚本身份名）。
    * 区分同脚本的不同 run 实例（如 'migrate-users-batch1' vs 'migrate-users-batch2'）。
    * 旧持久化 run 缺失时为 undefined，渲染时回落 scriptName。
    */
    readonly slug?: string;
    /** 脚本文件绝对路径（用于诊断/日志）。 */
    readonly scriptPath: string;
    /** 人类可读描述（meta.description）。 */
    readonly description?: string;
    /**
    * 父 workflow 调用链（嵌套 workflow() 时自动填充，循环检测用）。
    *
    * 顶层 run 无此字段。子 run 的 chain = [...parentChain, parentScriptName]。
    * executeNestedWorkflow 检查目标 name 是否已在 chain 中，防止 A→B→A 死循环。
    */
    readonly parentWorkflowChain?: readonly string[];
}

/**
 * Workflow Extension — Run Runtime
 *
 * 聚合内运行时资源（仅 status==="running" 时存在）。技术资源聚合，
 * Engine 层类型，持 WorkerHandle 具体类（D-12 不造 interface）。
 *
 * 职责：封装一次 running-segment 的所有技术资源（worker 线程 +
 * abort controller），统一 release 入口（AC-2：单 release 替代多 boolean flag）。
 * （旧并发门闩 gate 抽象已删——no-op，实际并发由 SubagentService ConcurrencyPool 管理；
 * 原 withSlot 的 pre-abort 检查内联到 error-recovery dispatchAgentCall。）
 *
 * 一次性生命周期（G3-001）：runtime 释放后不再复用——AbortController 一次性
 * 语义决定 controller 无法跨释放复用，所以整个 RunRuntime 重建。唯一注入路径：
 * assignRuntime（runWorkflow 创建）与 replaceRuntime（error-recovery 崩溃重试）。
 *
 * 参考：domain-models.md §10、clarification.md G3-001。
 */

/**
 * release mode 枚举——调用方表达意图。
 *
 * 一次性生命周期后唯一语义：terminal（终局释放，worker + controller 全释放，
 * runtime 即被调用方丢弃）。原 "pause" 值已随 pause/resume 生命周期删除（F8）
 * ——release 后不存在「保留待恢复」的中间形态。
 */
type ReleaseMode = "terminal";
declare class RunRuntime {
    /** Worker 线程句柄。 */
    readonly worker: WorkerHandle;
    /** per-running-segment AbortController（一次性，无法复用——G3-001）。 */
    readonly controller: AbortController;
    /** Run 级墙钟时间预算计时器（spec.budgetTimeMs > 0 时由 lifecycle 调度，
      * 到期 abortRun time_limited）。release 时清理，避免 abort/replaceRuntime
      * 后孤儿计时器仍触发（rebuildRuntime 会重排一个全新的计时器，旧的不应残留）。 */
    readonly timeBudgetTimer?: ReturnType<typeof setTimeout>;
    /**
    * 本 runtime 代际是否已收到 worker 的终态消息（return / error）。
    *
    * [F1] worker exit(0) 且本标记为 false = worker 静默退出、未交付任何终态——最常见根因
    * 是 execute() 返回值不可克隆，worker 侧 _safePost 吞掉 DataCloneError 后 return 消息
    * 根本没发出。旧实现 handleWorkerExit 对 code===0 no-op → run 永久 running、runAndWait
    * 悬挂。handleWorkerExit 据此判定转 done,failed。
    *
    * 按代际归零：字段挂在 RunRuntime（每代际 new 一个实例）而非 run.meta——script-error
    * 重试退避窗口内（error 消息已收到、run 仍 running、旧 worker exit(0)）必须 no-op 等
    * rebuild；若挂 meta 则 rebuild 后新 worker 再静默退出时会被旧标记误放行，重新悬挂。
    *
    * 写点：① handleWorkerMessage 的 return/error 分支（WorkerHandle.isCurrent 守卫保证
    * 消息必来自当前代际）；② handleWorkerError 进入处理前（[R4-F1] 同代际幂等守卫——
    * worker 崩溃时 error + exit(1) 双事件各派发一次 handleWorkerError，第一个事件标记
    * 本代际已处理，第二个事件命中标志跳过，消除单次崩溃计数 +2 / 双 rebuild 交错）。
    * rebuildRuntime 构造新 RunRuntime 自然重置。
    */
    receivedTerminalMessage: boolean;
    /** 防止 release 重复执行（幂等）。 */
    private released;
    constructor(worker: WorkerHandle, controller: AbortController, timeBudgetTimer?: ReturnType<typeof setTimeout>);
    /**
    * 释放所有资源：terminate worker + abort controller。
    *
    * 幂等——重复调用安全（第二次起 no-op，released flag 守卫）。
    * 调用后此 RunRuntime 应被调用方丢弃（WorkflowRun.runtime = undefined），
    * 崩溃重试时由 replaceRuntime 注入新实例（G3-001）。
    *
    * worker.terminate 本身幂等，controller.abort 本身幂等
    * （重复 abort 无副作用），但 released flag 让本方法语义更明确：
    * 「释放过一次的 runtime 不再释放第二次」。
    *
    * @param mode terminal —— 终局释放（唯一值，保留参数为调用方语义显式化）
    */
    release(_mode: ReleaseMode): void;
    /** 是否已 release（测试 + 诊断用）。 */
    get isReleased(): boolean;
}

/**
 * Workflow Extension — AgentCall 实体
 *
 * 单次 agent 调用的数据 + 不变式守卫（D-12）。纯数据，无 execute 上帝方法——
 * 执行编排（重试+预算+stale 检测）在 execute-agent-call.ts 的 free function。
 *
 * - 状态机：pending → running → done（不可逆）
 * - markRunning 进入 running 并 attempts++（每次 retry 前调用）
 * - markDone(result) 进入 done 并记录结果
 * - traceNode 持有引用，但 AgentCall 不直接改其字段——trace 同步由
 * Trace.update 负责（D-10 单一来源），AgentCall 只持有引用供 executeAgentCall 读取
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §5（字段/不变式/设计决策）。
 */

/** AgentCall 生命周期状态。pending→running→done，不可逆。 */
type AgentCallStatus = "pending" | "running" | "done";
/**
 * AgentCall 实体（在 RunState.calls Map 内）。
 *
 * 不变式：
 * - status 转换严格 pending→running→done，反向抛错
 * - done 时 result 必须已设置（markDone(result) 前置保证）
 * - attempts 反映 dispatch 次数（markRunning 累加，含首次）
 * - **无 execute 方法**（D-12：执行编排由 Engine executeAgentCall 函数承担）
 */
declare class AgentCall {
    readonly id: number;
    readonly opts: AgentCallOpts;
    status: AgentCallStatus;
    attempts: number;
    result?: AgentResult;
    /** Pi subprocess session ID（uuidv7，G-017 归此）。 */
    sessionId?: string;
    /** Session JSONL 绝对路径（finalizeCall 后从 result.sessionFile 填入，对齐 sessionId 模式）。 */
    sessionFile?: string;
    /** 与 Trace 共享的节点引用（D-10 单源）。AgentCall 不直接改其字段。 */
    readonly traceNode: ExecutionTraceNode;
    constructor(id: number, opts: AgentCallOpts, traceNode: ExecutionTraceNode);
    /**
    * 标记进入 running 状态（dispatch 前）。attempts++（含首次）。
    * @throws 若已 done（不可重启）
    */
    markRunning(): void;
    /**
    * 标记完成（成功或失败均调用——result.error 区分）。
    * @throws 若当前非 running（pending 不能直接跳 done，必须先 markRunning）
    */
    markDone(result: AgentResult): void;
    /** 记录 pi subprocess session ID（dispatch 成功后）。 */
    setSessionId(sessionId: string): void;
    /** 记录 session JSONL 绝对路径（finalizeCall 后，对齐 setSessionId 模式）。 */
    setSessionFile(sessionFile: string): void;
}

/**
 * Workflow Extension — Trace 值对象
 *
 * 执行追踪事件流（D-10 单一来源）。纯 append-only + 单字段 update。
 *
 * 设计：
 * - trace 节点存储 + 变更逻辑收敛为值对象（外部不能直接打洞 nodes 数组）。
 * - update 只改单个 node 的 status/result/error/completedAt/sessionId（TracePatch）。
 * - callId 不存在时 update no-op（防御性，避免 race 下抛错）。
 * - 持久化（appendEntry）与事件通知（emit）不在本值对象内——它们由 engine 函数
 * 在调用 update 前后负责（值对象只管数据形状，不管 IO）。
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §6（字段/不变式）。
 */

/**
 * Trace 值对象（事件流，唯一来源 D-10）。
 *
 * 不变式：
 * - nodes 只增不改索引顺序（append-only）
 * - update 只改单个 node 的 status/result/error/completedAt/sessionId
 * - byIndex 与 nodes 恒一致（每个 append/remove 同步维护，无惰性重建）；
 *   Map 值与数组元素引用共享（非拷贝），nodes 仍是持久化与 TUI 投影 SSOT
 * - 不含 verifyStrategy（G-020 删除，不迁移）
 */
declare class Trace {
    private readonly nodes;
    /** stepIndex 倒排索引（查询加速 O(1)；值与 nodes 元素引用共享）。 */
    private readonly byIndex;
    /**
    * 从已有节点数组重建 Trace（用于 RunStore 反序列化重水合）。
    *
    * 防御性拷贝——传入数组不被持有，外部 mutation 不影响 Trace。
    * 不验证节点顺序/唯一性（调用方保证快照来源可信）。
    * 不做裁剪——落盘快照已是 write 路径裁剪后形态，旧版本未裁剪长
    * content 重水合保持原样（read 路径无二次信息损失）。
    * 重水合后 call.traceNode（来自快照 calls[].traceNode，
    * jsonl-run-store.ts:156 直接传入）与 Trace.nodes 副本非同引用——
    * D-10 引用共享仅 live append 路径成立。
    */
    static fromArray(nodes: readonly ExecutionTraceNode[]): Trace;
    /**
    * Append a trace node（append-only，不改已有节点）。
    *
    * 入口裁剪：超长 result.content 先 mutate 入参节点的 result 字段，
    * 再 push 原节点引用（禁止 push 副本——保持 AgentCall.traceNode 与
    * Trace.nodes 共享同一引用的 D-10 不变式）。
    */
    append(node: ExecutionTraceNode): void;
    /**
    * Update a trace node by stepIndex (callId) with a partial patch.
    *
    * 只改 patch 中提供的字段（status/result/error/completedAt/sessionId）。
    * stepIndex 不存在时 no-op（防御性——agent 完成/失败回调可能晚于 run 终止到达）。
    */
    update(stepIndex: number, patch: TracePatch): void;
    /**
    * 查找指定 stepIndex 的节点（byIndex O(1)，trace 中 stepIndex 应唯一）。
    *
    * 语义差异声明（旧线性扫 first-match → Map last-wins）：仅在破坏
    * stepIndex 唯一性的违规使用下可见，两组场景——
    * 1. 重复 append 同 stepIndex 且未 remove：返回最后一个节点（last-wins；
    *    旧线性扫 first-match 会返回第一个）。
    * 2. 重复 append 后 removeByStepIndex：remove 的 findIndex 命中首个旧节点
    *    splice，而 byIndex.delete 把整个 stepIndex 键删掉——nodes 残留第二个
    *    节点成为孤儿（find/update 不可达，length/toArray 仍可见）。
    * 合法路径无差异：唯一性由 discard 先 remove 再 append 保证（W1TC12 锚定）。
    */
    private findByStepIndex;
    /** 按节点引用删除（仅用于测试或 run 重建场景；正常运行不调用）。 */
    find(stepIndex: number): ExecutionTraceNode | undefined;
    /**
    * 按 stepIndex 移除节点（崩溃重建清理在飞 call 用）。
    *
    * 正常运行不调用（append-only 不变式）。仅 error-recovery 的 discardInFlightCalls
    * （rebuildRuntime 内，F2）清理被旧 runtime abort 的在飞 call 时用——移除其 trace
    * 节点，让重跑重发 agent-call 时 append 全新节点走全新执行路径（避免 stale
    * "running" 节点残留 + trace.update 命中旧节点导致新节点 orphan）。
    * stepIndex 不存在时 no-op（防御性）。
    */
    removeByStepIndex(stepIndex: number): void;
    /**
    * readonly 视图——返回内部 nodes 数组引用（仅类型级 readonly，运行时无
    * 防御）。消费方禁止结构化 mutate（push/splice/重排/覆盖元素）：byIndex
    * 引入后外部结构化 mutate 会使 nodes 与倒排索引 desync。字段级变更走 update()。
    */
    toArray(): readonly ExecutionTraceNode[];
    /** 当前节点数。 */
    get length(): number;
}

/**
 * Workflow Extension — RunState 值对象
 *
 * 单次 workflow run 的可持久化状态（domain-models.md §3）。
 *
 * 设计：
 * - status/reason/budget/calls/trace/errorLogs 是可变字段（运行中持续更新）
 * - error/scriptResult 仅终态有值（done 时）
 * - 与 RunSpec 的区别：RunSpec 不可变（输入），RunState 可变（执行快照）
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §3。
 */

/**
 * RunState——一次 run 的可持久化执行状态。
 *
 * 持久化由 RunStore.save(WorkflowRun) 触发（WorkflowRun 持 RunState）。
 * 跨进程重启时 RunState 从 JSONL 重水合（callCache 保留，worker 由崩溃恢复重建）。
 */
interface RunState {
    /** 当前状态（running/done）。 */
    status: RunStatus;
    /** 终态原因（done 时必有）。 */
    reason?: DoneReason;
    /** Token/cost 预算（含 usedTokens/usedCost 累积）。 */
    budget: Budget;
    /** 按 callId 索引的 agent 调用集合（含 result，跨 runtime 重建存活——callCache replay）。 */
    calls: Map<number, AgentCall>;
    /** 执行追踪事件流（唯一来源 D-10）。 */
    trace: Trace;
    /** Worker console.* 捕获条目（run 级诊断，仅展示在 TUI widget）。 */
    errorLogs: WorkerLogEntry[];
    /** done && reason !== completed 时可有（失败/中止/预算超限的原因）。 */
    error?: string;
    /** done && reason === completed 时有（脚本 execute 返回值）。 */
    scriptResult?: unknown;
}

/**
 * Workflow Extension — WorkflowRun
 *
 * 单次 workflow run 的聚合根。封装状态机 + runtime 生命周期 + 不变式守卫。
 * 架构核心——所有字段变更通过方法（transition/assignRuntime/releaseRuntime/
 * replaceRuntime），engine 模块不直接打洞（AC-3）。
 *
 * 层归属：Engine。依赖 RunRuntime（具体类，D-12 允许）+ RunSpec/RunState + 类型。
 *
 * 关键不变式（必须全测）：
 * I1: state.status === "running" ⟺ runtime !== undefined
 * I2: state.status === "done" ⟹ state.reason !== undefined
 *
 * 状态机（一次性生命周期，2 态）：
 * 构造（status="running"，I1 构造期跳过——runtime 由 assignRuntime 注入）
 * running ──transition("done", reason)──→ done (releaseRuntime + completedAt)
 * done ──(no out edges, zombie)
 *
 * 「创建即 running」与 I1 的协调（F4）：构造瞬间 running 而 runtime 尚未注入，
 * I1 在构造期跳过（仅查 I2），完整校验由 assignRuntime/transition/replaceRuntime
 * 末尾的 validateInvariants 维持；构造到 assignRuntime 的 I1 窗口由调用方
 * （lifecycle.runWorkflow 在 assignRuntime 之后才 runs.set）保证对外不可见。
 *
 * worker-error-retry（G5-001 + G6-001）：
 * - replaceRuntime(newRt): 前置 status==="running"（G6-001），原子释放前一个 runtime
 * + 绑定新 runtime，全程保持不变式 I1（中间不经过 runtime===undefined 的可见状态）。
 *
 * 参考：domain-models.md §1（聚合根定义）、clarification.md G3-001/G5-001/G6-001。
 */

/**
 * 聚合根级 meta（非 RunState 的一部分，不随 trace 持久化到 worker JSONL）。
 *
 * workerErrorCount/scriptErrorCount 跨 runtime 存活（C.5：error-recovery 重试计数载体），
 * 因为 retry 会 replaceRuntime，但计数是 run 级而非 runtime 级。
 */
interface WorkflowRunMeta {
    /** ISO 时间戳，run 创建/启动时刻。 */
    startedAt: string;
    /** ISO 时间戳，transition("done") 时设置。 */
    completedAt?: string;
    /** Worker 线程错误计数（C.5：跨 runtime 存活，重试计数载体）。 */
    workerErrorCount?: number;
    /** 脚本错误计数（C.5：跨 runtime 存活）。 */
    scriptErrorCount?: number;
}
declare class WorkflowRun {
    readonly runId: string;
    readonly spec: RunSpec;
    state: RunState;
    runtime?: RunRuntime;
    meta: WorkflowRunMeta;
    /**
    * 创建聚合根。初始状态 "running"（一次性生命周期：run 从创建起即在执行，
    * runtime 由紧随其后的 assignRuntime 注入）。也可传入 done 状态用于重水合
    * 已完成的 run（loadAll 后的只读聚合）。
    *
    * 不变式 I1 构造期跳过——「创建即 running」要求构造瞬间 runtime===undefined
    * 合法（runtime 必须由 assignRuntime 注入，构造函数无从持有）；重水合的
    * running 快照同样无 worker。I1 的运行时校验在 assignRuntime/transition/
    * replaceRuntime 末尾的 validateInvariants 处生效。
    */
    constructor(runId: string, spec: RunSpec, state: RunState, meta: WorkflowRunMeta);
    /**
    * 从持久化快照重水合聚合根。与构造函数同语义（构造期跳过 I1——持久化的
    * running 状态没有 worker，进程被杀后 worker 不可能还活着）。保留独立工厂
    * 标注重水合意图；调用方（D-4 kill-9 恢复）负责在 session_start 时把残留
    * running 转 done,failed，恢复 I1。
    *
    * @throws I2 违反（done 快照缺 reason 仍是 bug，不可跳过）
    */
    static reconstruct(runId: string, spec: RunSpec, state: RunState, meta: WorkflowRunMeta): WorkflowRun;
    /**
    * 校验不变式 I1 + I2。违反抛错（聚合根自我保护，fail-fast）。
    * 在每个 mutation 方法末尾调用（防御式编程 + 测试可断言）。
    */
    private validateInvariants;
    /**
    * 仅校验不变式 I2（done ⟹ reason）。构造期用——「创建即 running」与重水合的
    * running 快照都无 runtime（I1 构造期跳过），但 I2 必须保证（done 缺 reason 是真 bug）。
    */
    private validateInvariantI2;
    /**
    * 状态机转换。合法转换：running→done。
    *
    * running 的进入不走 transition——构造即 running，replaceRuntime 保持 running。
    * 调用 transition("running") 抛错，防止绕过 runtime 注入直接改状态。
    *
    * 副作用：
    * - →done: releaseRuntime + 设 state.reason + meta.completedAt
    *
    * @param target 目标状态（不允许 "running"——runtime 注入只走 assignRuntime/replaceRuntime）
    * @param reason →done 时必填（done ⟹ reason，不变式 I2）
    * @throws 非法转换 / done 缺 reason / target==="running"
    */
    transition(target: RunStatus, reason?: DoneReason): void;
    /**
    * 绑定 runtime（run 创建后注入执行资源）。
    *
    * 前置：status==="running" && runtime===undefined（runWorkflow 创建路径——
    * 构造即 running 但 runtime 延迟到此处注入）。
    * 原子地：设 runtime 后末尾 validateInvariants，恢复构造期跳过的 I1
    * （running ⟺ runtime!==undefined）。
    *
    * @throws runtime 已定义 / status 不是 "running"（done 僵尸不可复活）
    */
    assignRuntime(rt: RunRuntime): void;
    /**
    * 解绑 runtime（done 时由 transition 调用，也可独立调用）。
    *
    * 前置：无（runtime===undefined 时 no-op，幂等）。
    * 副作用：调 runtime.release("terminal") 释放 worker/controller，置 runtime=undefined。
    */
    releaseRuntime(): void;
    /**
    * 原地替换 runtime（G5-001：worker-error-retry）。
    *
    * 前置：status==="running"（G6-001：终态 run 拒绝重建）。
    * 原子地：释放旧 runtime（worker.terminate + abort）+ 绑定新 runtime，
    * 全程 status 保持 "running"，不变式 I1 不违反（中间无 runtime===undefined 可见态）。
    *
    * 与 release+assign 的区别：replaceRuntime 不改 status，中间同步完成，
    * 外部观察不到违反不变式的瞬间。
    *
    * @throws status!=="running"
    */
    replaceRuntime(rt: RunRuntime): void;
}

/**
 * Workflow Extension — Engine Ports + 编排层共享类型
 *
 * 3 个注入 Port（AgentRunner / RunStore / WorkerHost）——Engine 定义、Infra 实现，
 * 是真需要 mock 测试的依赖（子进程/文件系统/线程）。
 *
 * 编排层共享类型（WorkerHandlers / LifecycleDeps）——打破 lifecycle ↔
 * error-recovery 循环依赖：2 个 engine 函数文件各自独立，共用同一组
 * 依赖签名（D-12）。
 *
 * 层归属：Engine。零 infra 依赖（AC-1）。
 */

/**
 * Agent 子进程执行 port。Infra 实现：SubprocessAgentRunner。
 *
 * run 执行单次 agent 调用（委托 SubagentService.executeAndAwait），返回结构化结果。
 * signal 用于 abort 传播。
 *
 * onEvent（可选）：强类型 AgentEvent 回调，供调用方实时更新 live record 供 TUI 展示进度。
 * 不传则不回调（向后兼容；现有调用点不传不受影响）。
 *
 * D-005: onEvent 签名从 raw Record<string,unknown> 升级为 AgentEvent——委托后不再有
 * raw JSONL 中间层（executeAndAwait 直接出 AgentEvent，session-runner handleSdkEvent 出口）。
 */
interface AgentRunner {
    run(opts: AgentCallOpts, signal: AbortSignal, onEvent?: (event: AgentEvent) => void, stream?: SubagentStream): Promise<AgentResult>;
}
/**
 * WorkflowRun 持久化 port。Infra 实现：JsonlRunStore。
 *
 * save 在每次状态变更后持久化整个 WorkflowRun（聚合根）；
 * loadAll 在 session_start 时重水合（D-5：JSONL 不向后兼容旧 session，旧格式返回空）。
 * stateFilePath 返回 run 状态文件的绝对路径（供 overlay/GUI 暴露给用户）。
 */
interface RunStore {
    save(run: WorkflowRun): Promise<void>;
    loadAll(): Promise<WorkflowRun[]>;
    /** 返回 run 状态快照文件的绝对路径：<sessionDir>/workflow-state/<runId>.jsonl */
    stateFilePath(runId: string): string;
}
/**
 * Worker 线程启动 port。Infra 实现：WorkerHostImpl。
 *
 * start 创建一个 Worker thread 运行 workflow 脚本，返回 WorkerHandle。
 * handlers 绑定 message/error/exit 回调（见 WorkerHandlers）。
 */
interface WorkerHost {
    start(spec: RunSpec, args: Record<string, unknown>, handlers: WorkerHandlers): WorkerHandle;
}
/**
 * Worker 线程事件回调集合——WorkerHost.start 的入参，由 lifecycle
 * 构造并注入。2 个 engine 文件（lifecycle / error-recovery）共用此签名，
 * 避免各自定义形状不一致的 handler bag（打破循环依赖）。
 *
 * 所有回调返回 Promise——允许 engine 层在回调内做 await persistState 等异步操作。
 */
interface WorkerHandlers {
    /** Worker → Main 的业务消息（agent-call / return / error / log）。 */
    onMessage(raw: unknown): Promise<void>;
    /** Worker 线程 uncaught error。 */
    onError(err: Error): Promise<void>;
    /** Worker 线程 exit（含 code，用于区分正常退出 vs 崩溃）。handle 用于竞态防护 G-025。 */
    onExit(code: number, handle: WorkerHandle): Promise<void>;
}
/**
 * lifecycle / error-recovery 2 个 engine 函数文件的共同依赖 bag。
 *
 * 取代旧 4 个 Context factory（errorHandlerContext / agentCallContext /
 * budgetCallbacks / 旧 terminate bag，AC-2 目标）。函数签名 `(deps: LifecycleDeps, ...)`
 * 让每个 free function 自包含依赖，无需 God Facade 中介。
 *
 * - store: 持久化（RunStore port）
 * - workerHost: 启动 worker（WorkerHost port）
 * - runner: 执行 agent（AgentRunner port）
 * - runs: 内存中的活动 run 聚合根索引（runId → WorkflowRun），替代旧 6 张并行 map
 * - onRunDone?: run 到达 done 终态时的回调（C-4 修复，可选）。由 Interface 层
 * factory 注入（notifyDone —— 唤醒 parent agent 消费结果）。Engine 层不依赖
 * Pi SDK，通过 callback 把完成信号外推到 Interface 层。所有 transition("done", ...)
 * 路径（handleReturn / handleWorkerError / handleScriptError / abortRun /
 * dispatchAgentCall budget 终止）调完 transition + save 后触发本回调。
 */
interface LifecycleDeps {
    store: RunStore;
    workerHost: WorkerHost;
    runner: AgentRunner;
    runs: Map<string, WorkflowRun>;
    /** run 到达 done 终态时的回调（C-4 修复，可选）。Interface 层注入 notifyDone。 */
    onRunDone?: (run: WorkflowRun) => void;
    /**
    * 跨扩展事件总线（pending-notifications register/unregister 信号灯）。
    *
    * runWorkflow 启动时 emit pending:register；所有 transition("done") 路径 emit
    * pending:unregister。两处均通过本端口（Engine 不直接依赖 Pi SDK）。可选——
    * 无 pending-notifications 扩展时 no-op（向后兼容）。
    */
    eventBus?: {
        emit(channel: string, data: unknown): void;
    };
    /**
    * 调试日志端口（Engine 不直接依赖 Pi SDK）。Interface 层注入实现。
    * 关键路径记录 run 启动、保存、pending 注册/注销，便于排查异步操作状态。
    */
    log?: (level: "debug" | "info" | "warn" | "error", component: string, message: string, data?: unknown) => void;
    /**
    * D-12 regression fix (round-2 #2)：rebuildRuntime 重新调度 run 级墙钟预算计时器。
    *
    * worker/script 错误重试走 replaceRuntime，旧 RunRuntime 的 release 会 clearTimeout
    * 旧计时器（run-runtime.release）。新 runtime 必须重排 scheduleTimeBudget，否则带
    * budgetTimeMs 的 run 命中一次错误重试后时间预算静默失效（直到下次 pause/resume 才重排）。
    * 由 Interface 层 factory 注入——闭包捕获 deps，内部调 lifecycle.scheduleTimeBudget。
    *
    * 可选——旧测试 deps 不注入时 rebuildRuntime 不重排计时器（兼容，不影响无时间预算的 run）。
    */
    scheduleTimeBudget?: (runId: string, budgetTimeMs: number) => ReturnType<typeof setTimeout> | undefined;
    /**
    * workflow() 嵌套调用回调（可选）。Worker 脚本内调 workflow(name, args) 时触发。
    *
    * 由 Interface 层 makeDeps 注入（闭包捕获 registry + deps）。Engine 层的
    * error-recovery.handleWorkerMessage 收到 workflow-call 消息后调本回调，
    * 拿到子 workflow 执行结果后 postMessage(workflow-result) 回 worker。
    *
    * 不注入时 workflow() 返回 error result（向后兼容，不影响非嵌套场景）。
    */
    onWorkflowCall?: (name: string, args: Record<string, unknown>, parentRun: WorkflowRun) => Promise<unknown>;
    /**
    * UI streaming sink（ctx.ui.setWidget），workflow agent call 创建 SubagentStream 用。
    *
    * 由 Interface 层 makeDeps 注入（从 SubagentService.getStreamSink() 取）。
    * dispatchAgentCall 用它创建 SubagentStream（widgetKey=subagent-stream-<runId>-<stepIndex>），
    * 使 workflow agent call 的 text_delta 走与 background subagent 相同的 streaming 链路。
    * 可选——无 UI 模式（TUI/RPC 无 setWidget）时为 undefined，dispatchAgentCall 不创建 stream。
    */
    streamSink?: StreamSink;
}

/**
 * Workflow Extension — lifecycle
 *
 * Workflow run 生命周期 free functions（D-12）。
 *
 * 5 个导出函数：
 * - runWorkflow(spec, deps, signal?) → Promise<runId>
 * - abortRun(runId, deps, reason?, doneReason?) → Promise<void>（done no-op）
 * - terminateRunningRuns(deps, reason) → Promise<void>（session 切换/关闭终止）
 * - evictDoneRunsBeyondCap(runs, keepDone) → number（done run 内存淘汰）
 * - scheduleTimeBudget(runId, deps, budgetTimeMs) → timer（C.7 时间预算）
 *
 * 私有 makeHandlers(run, deps) → WorkerHandlers：
 * - onMessage → handleWorkerMessage(run, raw, deps, handlers)
 * - onError → handleWorkerError(run, err, deps, handlers) + workerErrorCount++
 * - onExit(code, handle) → handleWorkerExit(run, code, handle, deps, handlers)
 * （G-025：handle.isCurrent 检查内化在 handleWorkerExit 内）
 *
 * **A4 原子性**：abort/terminate 内部 transition 先 releaseRuntime（cleanup before
 * mutate），失败时 status 不变。transition("done") 在 WorkflowRun.transition 内已实现
 * 「releaseRuntime → 改 status」原子顺序。
 *
 * **G3-001**（run 一次性生命周期）：AbortController 一次性无法复用，runtime 释放后
 * 只有两类重建——rebuildRuntime（error-recovery，崩溃重试路径，run 保持 running、
 * replaceRuntime 原子换新）与 abort/terminate 的终态释放（transition("done") 内
 * releaseRuntime，run 不再恢复）。
 * （旧并发门闩 gate 抽象已删——no-op 无生产语义，实际并发由 SubagentService
 * ConcurrencyPool 管理；原 D-13 maxConcurrency=4 无消费方。）
 *
 * 层归属：Engine。依赖 LifecycleDeps + WorkerHost via port +
 * WorkflowRun + handleWorker* 函数。
 *
 * 参考：domain-models.md §1（聚合根状态机）。
 */

/**
 * 启动一个 workflow run。
 *
 * 流程：创建 WorkflowRun（running，I1 构造期跳过）+ makeHandlers + 构建 RunRuntime
 * （worker+gate+controller）+ assignRuntime（注入 runtime，恢复 I1）+ 注册到
 * deps.runs + store.save。
 *
 * @param spec RunSpec（scriptSource 只读；args 会被原地注入 _runId——rfl C2 契约，
 * worker 启动与崩溃重建共用同一 args 对象）
 * @param deps LifecycleDeps（store/workerHost/runner/runs）
 * @param signal 外部 abort signal（可选；abort 时调 abortRun）
 * @returns runId（wf-<timestamp>-<random>）
 * @throws signal 已 abort（pre-abort fail fast）
 */
declare function runWorkflow(spec: RunSpec, deps: LifecycleDeps, signal?: AbortSignal): Promise<string>;
/**
 * 中止 workflow（running）。
 *
 * **done 状态 no-op**：已终态的 run 不重复 abort。
 * **A4 原子性**：transition("done", doneReason) 内部先 releaseRuntime。
 *
 * @param runId
 * @param deps
 * @param reason 可选中止原因（存 run.state.error）
 * @param doneReason 终态原因（默认 "aborted"；超时场景传 "time_limited"，C.7）
 * @throws runId 不存在
 */
declare function abortRun(runId: string, deps: LifecycleDeps, reason?: string, doneReason?: DoneReason): Promise<void>;

/**
 * @zhushanwen/subagent-core — 公共 API barrel（D5 定稿）
 *
 * 公共 API 面 = 本文件导出 + package.json exports 的语义子入口
 * （./engines/zcode/reader、./engines/zcode/constants、./engine/paths、./relay-env）
 * + ./workflows/* 资产子入口。exports 面即 semver 契约（D5）：收窄不放宽——
 * 新增导出走 minor，本文件刻意不使用 `export *`，逐名列出以使 diff 可审。
 * 内部实现细节（registry / error-recovery / execution 编排件等）不经 barrel 导出，
 * 仓内壳侧深路径消费（`./*` -> src 通配）不受本文件约束。
 *
 * 设计权威源：docs/design/subagent-core-package-extraction.md §3.3 D5；
 * 宿主接入示例见包 README（§3.4 core_host_not_configured 恢复指引的落点）。
 */
declare const CORE_PACKAGE_VERSION = "0.2.0";

export { AgentEvent, AgentOutcome, AgentTaskSpec, CORE_PACKAGE_VERSION, type CoreLogger, DEFAULT_DATA_ROOT, type DiscoveryRoot, EngineCapabilities, EngineHandle, type EnginePort, type EngineRouteOptions, type EngineRouteResult, type EngineRouting, type EngineRoutingInput, type EngineRoutingSource, type EngineRunResult, type HostServices, InteractAction, InteractResult, type LifecycleDeps, type LogLevel, type ModelInfo, type NotifyDomainPorts, ProbeReport, type RunContext, type RunSpec, SessionView, SubagentStream, abortRun, configureCore, configureNotifyDomain, getLogger, routeEngine, runWorkflow };
