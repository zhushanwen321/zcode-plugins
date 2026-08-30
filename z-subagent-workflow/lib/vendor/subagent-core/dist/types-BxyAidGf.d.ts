/**
 * 唯一执行状态。所有路径共用。v4 B-1 两态收敛：旧 idle 折入 running、
 * 旧 cancelled 折入 closed（closedReason='cancelled' 区分）。
 *
 * running = 活跃态。含两种子态（由派生谓词区分，见 lifecycle-predicates.ts）：
 *   - 对话模式等待续聊（旧 idle）：进程可能保活（isIdle=hasIdleTimer）或已回收
 *     待冷路径 resume（isResumable=running && 无活进程句柄）。
 *   - 正在执行（有活进程句柄）。
 *
 * closed = 统一终态（done/failed/crashed/cancelled 合并）。具体关闭原因由
 * {@link ClosedReason} 子枚举表达（如 user-close / gc / cancelled / parent-shutdown）。
 * ExecutionRecord.closedReason 携带 L2 原因，投影层按需派生对外语义（error / ended）。
 */
type ExecutionStatus = "running" | "closed";
/**
 * closed 终态的 L2 关闭原因子枚举。
 *
 * 与 ExecutionStatus="closed" 配合使用，表达「为什么关闭」：
 *   parent-shutdown  — 父进程 session_shutdown 时回收子进程
 *   parent-fork     — 父进程 fork 新 session 时清理旧子进程
 *   parent-new      — 父进程创建新 subagent 时清理旧子进程
 *   user-close      — 用户手动 close action（含对话模式 close）
 *   cancelled       — 用户取消（close(force:true) / cancelBackground）
 *   gc              — 通用完成/失败（一次执行自然结束、超时、错误等无专属 reason 的终态）
 *   disconnected    — .finalized sidecar 存在但无 reason 内容（磁盘重建兜底）：
 *                     正常结束但死因不可考——旧格式 sidecar（v8.5 前写入的是空文件）、
 *                     或外部工具手工创建。替代旧的误导性 "gc" 兜底（自然完成 vs 断联
 *                     不分），message/fork-from 据此给出可行动指引。
 */
type ClosedReason = 'parent-shutdown' | 'parent-fork' | 'parent-new' | 'user-close' | 'cancelled' | 'gc' | 'disconnected';
/**
 * 终态三态对外语义（U3 C-outcome 一等披露）。
 *
 * 由 completeRecord 唯一写入点按 deriveOutcome 一次计算（判定顺序：cancelled 优先
 * → error 非空 → completed），消费方（project/list/notify 文案/渲染器）只读本字段，
 * 不再各自手写成败推导 switch（三处同构 switch 已随 U3 收敛删除）。
 *
 * [D6 显式取舍] parent-shutdown/parent-fork/parent-new 合成关闭（subagent-service
 * disposeAllRecords 合成 result 恒写 error:"closed due to ..."）落 "failed"——语义为
 * 「父进程关闭时子 agent 未完成即失败」，选定行为而非疏漏，勿当 bug 改回 cancelled。
 */
type ExecutionOutcome = "completed" | "failed" | "cancelled";
/** 执行模式。background = 调用方立即拿 handle 返回，子 agent 在 detached promise 里跑。 */
type ExecutionMode = "background";
/**
 * Pi session.subscribe 上报的事件。Runtime 把它喂给 updateFromEvent。
 *
 * 设计：AgentEvent 携带 updateFromEvent 收口进 record 所需的**全部数据**——
 * tool_end 带 result（供 turn.toolCalls 存完整 ToolCall），无需翻译层旁路累积。
 *
 * ACP 词汇对照（D11 注记级校准，零行为变更；新引擎实现者按本表对齐语义，
 * 详见 docs/architecture/subagent-engine-gui-visibility.md §3.3 D11）：
 *   text_delta / thinking_delta ↔ ACP content blocks（text / thinking）
 *   tool_start / tool_end      ↔ ACP tool_call / tool_call_update
 *   turn_end / message_end     ↔ ACP prompt turn 终态（stop_reason + usage）
 *   compaction                 ↔ ACP session/compaction
 * 本协议以 pi 为语义锚点（D3）——命名不迁移，对照表仅保证未来 AcpEngine 适配器
 * 与跨引擎 trace 映射的翻译成本最低。
 */
type AgentEvent = {
    type: "tool_start";
    toolName: string;
    args?: unknown;
} | {
    type: "tool_end";
    toolName: string;
    args?: unknown;
    result?: ToolCallResult;
    isError?: boolean;
} | {
    type: "text_delta";
    delta: string;
} | {
    type: "thinking_delta";
    delta: string;
} | {
    type: "turn_end";
    summary?: string;
} | {
    type: "message_end";
    usage?: AgentUsage$1;
    error?: string;
} | {
    type: "compaction";
} | {
    type: "error";
    message: string;
};
/** token 用量（message_end 时由 Core 累加进 record.totalTokens）。 */
interface AgentUsage$1 {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** 本 message 的成本（USD，来自 SDK usage.cost.total）。可选——无成本数据时缺省。 */
    cost?: number;
}
interface AgentUsageTotal extends AgentUsage$1 {
    /** 上述四项之和。投影时不再手工求和。 */
    total: number;
    /** 累计成本（USD，来自 SdkEvent.message.usage.cost.total 求和）。无成本数据时为 0。 */
    cost: number;
}
/** tool 调用结果（tool_execution_end 时累积，含 structured-output 的 details）。 */
interface ToolCallResult {
    content?: unknown[];
    details?: unknown;
}
/**
 * tool 调用（导出的纯净数据形状，不含内部状态）。
 *
 *   tool_start 到达但 tool_end 未到时，调用为进行中；一旦 tool_end 到达，
 *   result/isError 填充完成。对外投影（AgentResult.toolCalls / getAllToolCalls）
 *   一律返回此类型——**不泄漏 running/done/failed 内部状态机**。
 *
 * 进行中状态由 execution-record 内部的 `InternalToolCall`（= ToolCall + _status）承载，
 * 只存在于 record.turns[].toolCalls，跨边界导出时由 getAllToolCalls strip _status。
 */
interface ToolCall {
    toolName: string;
    args?: unknown;
    result?: ToolCallResult;
    isError?: boolean;
}
/**
 * 内部 ToolCall：在 ToolCall 基础上追加 _status 进行中状态标记与 startedTs 时间戳。
 *
 *   running = tool_start 已收到但 tool_end 未到；
 *   done/failed = tool_end 已到。
 *
 * 仅存在于 ExecutionRecord.turns[].toolCalls（Core 内部可变状态）。
 * 跨边界导出（getAllToolCalls → AgentResult.toolCalls / 持久化）由 getAllToolCalls
 * 映射回 ToolCall（丢弃 _status / startedTs），保证导出形状清洁。
 */
interface InternalToolCall extends ToolCall {
    _status: "running" | "done" | "failed";
    /** tool_start 到达时的墙钟时间戳（Date.now()，ms）。getEventLog 派生 tool 条目 ts 用。 */
    startedTs: number;
}
/**
 * 一个 turn 的完整内容（ExecutionRecord.turns[] 的元素）。
 *
 * 收口设计：text/thinking 流式累积**完整内容**（非 100 字切片），
 * toolCalls 存完整 ToolCall（含 result + _status 内部状态）。turn_end 到达后 closed=true，
 * 下次 text/thinking/tool 时开新 turn。
 *
 * eventLog / currentActivity / result 均从 turns[] 派生，不再独立存储。
 */
interface Turn {
    /** 本 turn assistant 正文（text_delta 流式累积，完整）。 */
    text: string;
    /** 本 turn 推理（thinking_delta 流式累积，完整）。 */
    thinking: string;
    /** 本 turn 工具调用（InternalToolCall：含完整 result + _status 进行中标记）。 */
    toolCalls: InternalToolCall[];
    /** 本 turn message_end 的 token 增量（聚合得 totalUsage）。 */
    usageDelta?: AgentUsage$1;
    /** turn_end 是否已到达。false=正在进行；true=已闭合，下次内容开新 turn。 */
    closed: boolean;
    /** turn_end 到达时的墙钟时间戳（Date.now()，ms）。getEventLog 派生 turn_end 条目 ts 用。 */
    closedTs?: number;
}
/** 一次 session 执行的完整结果。collectResult 产出，写入 Record.outcome。 */
interface AgentResult$1 {
    text: string;
    turns: number;
    durationMs: number;
    success: boolean;
    error?: string;
    sessionId: string;
    toolCalls: ToolCall[];
    usage?: AgentUsageTotal;
    /** /resume /fork 可恢复的 session 文件名（不含目录）。 */
    sessionFile?: string;
    /** schema 模式下，structured-output tool 的 result.details（已通过 schema 校验）。 */
    parsedOutput?: unknown;
}
/**
 * worktree handle 值对象。仅 worktree:true 时持有——worktree 是独立维度，
 * 需显式开启，fork alone 不创建 worktree。
 * Object.freeze 守卫保证不可变。
 */
interface WorktreeHandle {
    /** checkout 目录（子 agent 工作目录，tmpdir 下）。 */
    readonly path: string;
    readonly branch: string;
    readonly baseCommit: string;
    /** 主仓库根目录（cleanup/scan 需要，不再靠路径反推）。 */
    readonly mainCwd: string;
}
/**
 * 所有执行路径的唯一状态源。
 *
 * 收口设计：一次执行的完整内容（text/thinking/toolCalls/usage）按 turn 收口在
 * `turns: Turn[]` 里。eventLog / currentActivity / result 文本均从 turns[] 派生
 * （getEventLog / getCurrentActivity / getFullText），不再独立存储切片或缓冲。
 *
 * 生命周期：createRecord() 创建 → updateFromEvent() 实时更新（累积进 turns）→
 *           completeRecord() 冻结 → archive 立即移出内存（读时从 session.jsonl 重建）。
 *
 * TUI 永远拿 RecordSnapshot（.slice() 快照），不直接持此可变对象。
 */
interface ExecutionRecord {
    /** 唯一 ID（sync: "run-N"，bg: "bg-N-xxx"）。 */
    readonly id: string;
    readonly agent: string;
    readonly model: string;
    readonly thinkingLevel: string | undefined;
    readonly mode: ExecutionMode;
    readonly task: string;
    /**
     * 人类可读的短标签（≤35 字符），简述本次 subagent「在做什么」。
     * 区别于 agent（类型名）/ task（完整 prompt）。旧持久化 record 反序列化时缺失兜底空串。
     */
    readonly slug: string;
    readonly startedAt: number;
    /** 根 Pi session ID（session 隔离过滤用）。递归链上所有层 record 同值。 */
    readonly rootSessionId: string | undefined;
    /** 直接父 subagent record ID（层级树构建用）。顶层 record 为 undefined。 */
    readonly parentRecordId: string | undefined;
    /** subagent 递归深度。顶层（主 session 直接创建）=0，每层嵌套 +1。 */
    readonly depth: number;
    /**
     * 对话模式标志（可持续对话 subagent）。true = 轮次完成进 idle 态（保留 record +
     * worktree）等待续聊，而非一次性终态化。
     * undefined/false = 一次性模式（默认，行为完全不变）。
     * 向后兼容：旧 record / 旧 session 文件无此字段，按一次性模式处理。
     */
    readonly chatMode?: boolean;
    /**
     * 执行态信号（residual-fixes 设计）：true = 该 record 无活进程驱动（轮终 idle /
     * 重建孤儿兜底），处于「可续聊/等续聊」态——不是后台真在跑。轮终迁移
     * （doFinalizeRoundToIdle）置 true，冷路径续轮（进程启动）清除；GUI 侧
     * streaming/waiting 细分与 hasRunning 判据消费。缺省 falsy = 有进程或旧数据。
     */
    resumable?: boolean;
    /**
     * 空闲超时毫秒数（仅 chatMode 有意义）。覆盖默认 5min idle timeout。
     * 优先级：参数 > env XYZ_SUBAGENT_IDLE_TIMEOUT_MS > 默认 300000ms。
     * 向后兼容：旧 record 无此字段，按默认值处理。
     */
    readonly idleTimeoutMs?: number;
    /**
     * 实际执行引擎 id（P4 路由留痕，D9①）。创建时确定不可变；缺省（存量 record）
     * = pi 投影（消费方零迁移）。持久化经 subagent-record entry。
     */
    readonly engine?: string;
    /**
     * 引擎 fallback 留痕（D9①：probe 失败路由回默认引擎）。GUI 警告条数据源；
     * 缺省 = 无 fallback。持久化经 subagent-record entry。
     */
    readonly engineFallback?: {
        from: string;
        reason: string;
    };
    /**
     * 引擎自描述定位符（U2：非 pi run resolve 后回填、终态迁移落 entry 前——run 前
     * 缺省不可用）。sessionRef 整体透传（失败终态 sessionId 缺失时仍回填已有部分，
     * 读侧①级降②级的防御形态）；journalPath 为 retarget 后实际落盘路径。pi 分支不
     * 回填（sessionFile 即定位符）。持久化经 subagent-record entry。
     */
    engineHandle?: {
        sessionRef: Record<string, string>;
        journalPath?: string;
        poolKey: string;
    };
    status: ExecutionStatus;
    /** L2 关闭原因子枚举（仅 status="closed" 时有意义）。表达「为什么关闭」。
     *  由 tryTransition(record, "closed", reason) 写入；投影层按需派生对外语义。
     *  向后兼容：旧 record 无此字段，按 gc 处理（通用完成/失败）。 */
    closedReason?: ClosedReason;
    /**
     * 终态三态对外语义（U3 C-outcome）。completeRecord 唯一写入点按 deriveOutcome
     * 一次计算，消费方只读本字段不再自行推导。向后兼容：旧 record / 磁盘重建
     * record 无此字段，投影层按 projectOutcome 兜底（closed-legacy 语义）。
     */
    outcome?: ExecutionOutcome;
    /** 完整执行内容，按 turn 组织。createRecord 初始化为 [空 turn]。 */
    turns: Turn[];
    /** turn 计数（= turns.filter(closed).length，冗余存储供投影直接读）。 */
    turnCount: number;
    totalTokens: number;
    /** 运行期最近一次 error 事件的消息（getEventLog 派生 error 条目用）。 */
    lastError: string | undefined;
    /**
     * 对话轮次计数（仅 chatMode 有意义）。首轮运行时 = 0；每完成一轮（finalizeRoundToIdle
     * 进 idle）+1。undefined 时视为 0。非 chatMode 不自增。
     */
    round?: number;
    /**
     * [增量通知] 当前轮次增量的 turns[] 起始下标（仅 chatMode 有意义；内存态记账，D4 不持久化）。
     *
     * - 生命周期：undefined 视为 0（首轮增量 = 全量，与改造前首轮通知逐字节一致，向后兼容旧
     *   record）；唯一写点 onRoundSettled 第 5 步（notify 之后推进），唯一读点同回调第 2 步
     *   （`getFullTextFrom(record, record.roundBaseTurnIndex ?? 0)`）。非 chatMode 恒
     *   undefined（onRoundSettled 是 session-runner chatMode 分支专属回调）。
     * - D1 滞后空 turn 防丢文本（防御性）：pi 当前事件序下该形态不可达——带 usage 的
     *   message_end 恒先于 turn_end（@earendil-works/pi-agent-core dist/agent-loop.js
     *   :240/:253/:547 三处 message_end emit 均在 :131 正常路径 turn_end 之前），settle 时
     *   turn 全闭合。防 pi 未来事件序变化：若 settle 时刻末 turn 是滞后 message_end 开出的
     *   空 turn（execution-record.ts message_end 分支经 currentTurn，需同时过两层 usage 守卫：
     *   session-runner.ts 转发层 `if (msg?.usage)`（bare message_end 不转发）+ execution-record.ts
     *   累积层 `if (event.usage)`（bare message_end 不开 turn）），推进公式
     *   nextRoundBaseTurnIndex 把它留在下一轮增量内（新轮首个 text_delta 经 currentTurn 复用该
     *   空 turn，复用累积被 slice 覆盖）；直用 turns.length 推进会把下轮首段文本挤出 slice
     *   范围静默丢失。
     * - D4 不持久化：磁盘重建走 createRecord（turns 仅为初始 [emptyTurn()]），base=0 对空 turn
     *   的增量派生等价为空、天然产出仅新轮增量，持久化是死数据。故不写 manifest、不参与重建。
     * - pi 内部序锚定依据（R1 mitigation）：@earendil-works/pi-agent-core 0.84.2
     *   dist/agent-loop.js :108-111（error/aborted stopReason 也先 emit turn_end 再 agent_end）
     *   与 :131（正常路径 turn_end 收尾）；agent_settled 在 agent_end 之后 emit，故未闭合
     *   turn 只可能来自滞后事件。pi 升级若改变 turn_end/agent_end 时序，onRoundSettled 推进前
     *   的观测哨（末 turn 未闭合且 text 非空 → logger.warn）会留痕。
     */
    roundBaseTurnIndex?: number;
    /**
     * record 进入 idle 态的时间戳（ms）。finalizeRoundToIdle 设值；GC 定时器据此计算
     * 剩余 TTL。undefined = 非 idle 态（running/closed/cancelled）或旧 record 缺失字段。
     */
    idleSince?: number;
    /**
     * close 优雅关闭标志（M2-B3）。chatMode record 运行中调 `close {force:false}` 时置 true；
     * runAndFinalize 的 done 分流检查此标志——true 则终态化为 done（而非进 idle），并清标志。
     * undefined/false = 正常 idle 分流（对话模式轮次完成进 idle 等续聊）。
     * 仅 chatMode + running 时有意义；force:true（立即终止）不走此标志。
     */
    closeAfterRound?: boolean;
    endedAt: number | undefined;
    result: string | undefined;
    error: string | undefined;
    /** 完整 AgentResult（含 usage/toolCalls，完成时填）。 */
    agentResult: AgentResult$1 | undefined;
    /** session jsonl 文件名。session 创建成功后由 session-runner.run() 回填（窗口期内 undefined）。 */
    sessionFile?: string;
    /**
     * [V2 决策 3] 子进程 pid（spawn 后由 session-runner 回填到内存 record）。
     *
     * 用于 lifecycle-manager 孤儿扫描（V2 §5.2 职责 4：父进程重启时按持久化 pid 扫收
     * 上次崩溃遗留的孤儿）。本字段仅在内存记账，持久化留 Step 5（record
     * 文件写入 pid + 启动时 scanOrphanProcesses 消费）。undefined = 尚未 spawn / 已退出。
     * 向后兼容：旧 record 无此字段，按无 pid 处理（孤儿扫描跳过）。
     */
    pid?: number;
    /** [MF#3] worktree 模式下子 agent 改动的 patch 文件路径（worktree 外，供调用方应用）。 */
    patchFile?: string;
    /** worktree 隔离时的 handle（仅 worktree:true 时存在；fork alone 无此字段）。 */
    worktreeHandle?: WorktreeHandle;
    /**
     * [review round2] 该 record 创建时启用了 worktree 隔离（跨重启磁盘重建时从 session
     * entry 的 worktree 标志恢复）。handle 本体不可序列化——跨重启后 worktreeHandle 恒
     * undefined，续聊（冷路径 resume）须拒绝（防 cwd 静默回落主 repo 破坏隔离）。仅内存
     * record 使用，与持久化无关；execute() 新建 record 不设（有真 handle 时无意义）。
     */
    hadWorktree?: boolean;
    controller: AbortController | undefined;
}

/**
 * Workflow Extension — Engine 共享类型
 *
 * Engine 层全局基础类型。零 infra 依赖——不 import 任何 infra 文件，
 * 可独立编译测试（D-12 三层架构，AC-1）。
 *
 * 核心内容：
 * - 状态机：RunStatus = "running" | "done"（2 态，一次性生命周期，FR-3）
 * + DoneReason（completed/failed/aborted/budget_limited/time_limited）
 * - AgentCallOpts / AgentResult / AgentUsage（单次 agent 调用的输入/输出）
 * - ExecutionTraceNode / TracePatch / ToolCallEntry / WorkerLogEntry（trace 数据）
 *
 * 层归属：Engine（数据结构 + 不变式守卫）。
 */

/**
 * 状态机：2 态（D-12 / FR-3，一次性生命周期——run 不可挂起）。
 *
 * running → done
 *
 * `done` 是唯一终态，具体原因由 DoneReason 区分。
 */
type RunStatus = "running" | "done";
/** 终态原因。done 时必有（WorkflowRun 不变式）。 */
type DoneReason = "completed" | "failed" | "aborted" | "budget_limited" | "time_limited" | "invalid_args";
/**
 * 单次 agent 调用的输入选项。
 *
 * D-12 仅重组执行编排，AgentCallOpts 形状保持兼容。
 */
interface AgentCallOpts {
    /** The task prompt to send to the agent. */
    prompt: string;
    /**
    * Optional JSON schema for structured output.
    * When provided, the schema is passed via PI_WORKFLOW_SCHEMA env to the subprocess,
    * which activates the structured-output tool + turn_end hook.
    * The tool's execute validates model output against the schema.
    * On success, `parsedOutput` on the result is set to `tool_execution_end.result.details`
    * (the validated, parsed data object — not the raw tool call args).
    */
    schema?: Record<string, unknown>;
    /**
    * Model to use (e.g. "router-openai/glm-5.1").
    * When omitted, pi's default model is used.
    */
    model?: string;
    /**
    * Thinking level override (e.g. "high", "medium", "low").
    * M2: Added to align with subagent path's ExecuteOptions.thinkingLevel.
    * When omitted, agent .md frontmatter thinkingLevel is used (via resolveIdentity/getAgentConfig).
    */
    thinkingLevel?: string;
    /** Scene name passed through to the worker for model-selection hints. */
    scene?: string;
    /**
    * Wall-clock timeout in milliseconds. When > 0, aborts the subprocess
    * if it runs longer than this, regardless of external signal.
    * Per-call，归 AgentCall 实体（G-027）。
    */
    timeoutMs?: number;
    /**
    * Turn 上限（turn limiter 用）。
    *
    * [预算语义对齐] 未传或 <=0 = 不限 turn；此时也不按 turns 估算 spawn watchdog——
    * 仅当 env XYZ_SUBAGENT_SPAWN_WATCHDOG_MS 设置时才按绝对时限挂 watchdog（见
    * session-runner.resolveSpawnWatchdogMs）。mapToExecuteOptions 原样透传到
    * ExecuteOptions.maxTurns → 引擎 task-spec → runSpawn。
    */
    maxTurns?: number;
    /**
    * Skill name to load (e.g. "code-review"). Resolved to SKILL.md path
    * and injected via --skill flag in the subprocess.
    */
    skill?: string;
    /**
    * Resolved absolute path to the skill directory or SKILL.md file.
    * Set by agent-opts-resolver when opts.skill is present.
    */
    skillPath?: string;
    /** Human-readable description for logging and debugging. */
    description?: string;
    /**
    * Agent ref (absolute .md path). Resolved by resolveIdentity via getAgentConfig,
    * which injects the agent's systemPrompt/model/tools/thinkingLevel. Not handled by
    * resolveAgentOpts (single-responsibility: agent ref ownership belongs to resolveIdentity,
    * M2 fix — previously overlapped causing double-injection + model-tier confusion).
    */
    agent?: string;
    /**
    * System prompt injection CONTENT (not file paths).
    * Set by agent-opts-resolver: schema structured-output instruction string.
    * Agent systemPrompt is NOT included here (handled by resolveIdentity/agentConfig).
    * mapToExecuteOptions passes this through to ExecuteOptions.appendSystemPrompt
    * (same name/semantics, transparent passthrough).
    */
    appendSystemPrompt?: string[];
    /**
    * Schema JSON for PI_WORKFLOW_SCHEMA env var.
    * Set by agent-opts-resolver when opts.schema is present; passed as env var
    * to activate the structured-output tool + hook.
    */
    schemaEnv?: string;
    /**
    * Per-call 工作目录（ADR-029 决策 1）。传给 child_process.spawn 的 cwd option。
    *
    * 用于 worktree 隔离：传入 worktree 绝对路径，spawn 的 pi 子进程绑定到该目录，
    * 其内部的 createAgentSession/ResourceLoader/bash 工具都在该目录运行。
    * undefined 时 spawn 继承 workflow 进程的 cwd（向后兼容）。
    */
    cwd?: string;
    /** Inherit parent session context (fork mode). Independent of worktree (file isolation). */
    fork?: boolean;
    /**
     * 执行引擎 id（P4 D9 三层优先级的第一层：调用参数级，workflow step 显式指定）。
     * 仅限「必须某引擎独有能力」的场景使用并注释原因（D9③ workflow 脚本不写死
     * engine——环境差异由 frontmatter/全局默认承载）；透传链 worker-script-builder
     * agent() → execute-agent-call → SAR 路由层。
     */
    engine?: string;
    /** Filesystem isolation: when true, creates a new git worktree for the agent. Independent of fork. */
    worktree?: boolean;
    /** When true, agent() resolves {value, sessionFile, worktreePath, error} instead of a bare value.
     * Worker-layer flag only — not forwarded to ExecuteOptions (mapToExecuteOptions drops it). */
    returnMeta?: boolean;
}
/**
 * 单次 agent 调用的资源用量（FR-7 跨 turn 累积）。
 */
interface AgentUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
}
/**
 * 单次 tool 调用记录（FR-7 从 agent JSONL 流采）。
 */
interface ToolCallEntry {
    /** Tool name. */
    name: string;
    /** Args preview string. */
    input: string;
}
/**
 * 单次 agent 调用的结果（统一形态）。
 *
 * Engine 直接消费 SubprocessAgentRunner 返回值；callCache replay 时 worker
 * 取 parsedOutput ?? content（见 worker-script-builder.ts 消息处理）。
 */
interface AgentResult {
    /** Raw text output from the agent. */
    content: string;
    /**
    * Parsed structured output.
    * Present when `schema` was provided and the output was valid JSON.
    * Source: tool_execution_end.result.details（validated data object）。
    */
    parsedOutput?: unknown;
    /** Token and cost usage accumulated across all assistant turns. */
    usage?: AgentUsage;
    /** Wall-clock duration in milliseconds. */
    durationMs?: number;
    /** True when the pi process exited with code 0. */
    error?: string;
    /**
    * Pi session ID for the subagent process (uuidv7).
    * Present when pi emits a session header (default in --mode json).
    * Can be used to locate the session JSONL file for post-run inspection (G-017)。
    */
    sessionId?: string;
    /**
    * Session JSONL 绝对路径（不含目录的文件名在 subagents 侧 AgentResult.sessionFile）。
    * 由 mapToWorkflowAgentResult 从 subagents AgentResult 透传——让 workflow 编排层
    * 继承 subagent 执行管道产出的 session 文件路径，overlay/GUI 可直接定位。
    * 窗口期内可能 undefined（session 尚未创建成功）。
    */
    sessionFile?: string;
    /**
    * Absolute path of the git worktree used for filesystem isolation (set when
    * worktree isolation is active). Injected by executeAndAwait from record.worktreeHandle.path.
    *
    * ⚠️ Diagnostic only, may not exist: executeAndAwait's finalizeRecord cleans up the
    * worktree (git worktree remove --force) before returning, so by the time this field
    * reaches the caller the directory has typically been deleted. Use it only for log/trace
    * correlation (e.g. attributing a session jsonl to its worktree origin) — never as a cwd
    * for a subsequent agent or filesystem operation (would ENOENT).
    */
    worktreePath?: string;
    /** All tool calls collected from JSONL stream (FR-7). */
    toolCalls?: ToolCallEntry[];
}
/**
 * 执行追踪节点（事件流 D-10 单一来源）。
 */
interface ExecutionTraceNode {
    stepIndex: number;
    agent: string;
    task: string;
    model: string;
    status: "pending" | "running" | "completed" | "failed";
    /** Phase name for TUI grouping. Set from explicit opts.phase or global _currentPhase. */
    phase?: string;
    startedAt?: string;
    completedAt?: string;
    result?: AgentResult;
    error?: string;
    /**
    * Pi session ID (uuidv7) for the subagent process.
    * Used to locate the session JSONL for post-run inspection.
    */
    sessionId?: string;
    /**
    * Session JSONL 绝对路径。finalizeCall 从 result.sessionFile 透传。
    * 持久化到快照（serializeRun），跨 session 重水合后保留。
    */
    sessionFile?: string;
    /**
    * Live 执行进度对象（running 时存在，done 时由 dispatchAgentCall 清除）。
    *
    * 挂在 node 上（D-10 单源延伸：AgentCall.traceNode 与 Trace.nodes 共享同一引用）。
    * TUI 通过 trace.toArray() 读 node.live，派生 getEventLog/getCurrentActivity 实时展示。
    * 不持久化（序列化时 strip；重跑时由 dispatchAgentCall 重建）。
    */
    live?: ExecutionRecord;
}
/**
 * Trace.update 用的 patch（字段全可选）。
 *
 * 不变式：只改单个 node 的 status/result/error/completedAt/sessionId。
 * callId 不存在时 update 为 no-op（D-10）。
 */
interface TracePatch {
    status?: "pending" | "running" | "completed" | "failed";
    result?: AgentResult;
    error?: string;
    completedAt?: string;
    sessionId?: string;
    sessionFile?: string;
}
/**
 * Worker console.* 捕获条目（run 级诊断，仅展示在 TUI widget，不泄漏到 input area）。
 */
interface WorkerLogEntry {
    level: "log" | "warn" | "error" | "info";
    message: string;
}

/** 人设（persona）注入规格：原 skillPath + appendSystemPrompt 收拢进一个语义单元（D2）。 */
interface PersonaSpec {
    /**
     * agent 名/路径。与 AgentTaskSpec.agent 的分工：agent 是 resolveIdentity 的身份解析
     * 键（模型/系统提示等身份语义）；agentRef 是 persona 注入通道的定位符——引擎按
     * capabilities.personaInjection 决定注入通道（file/flag/prompt）时用它定位人设。
     * pi 引擎不消费此字段（身份解析走 spec.agent），留给 flag/file 通道的引擎。
     */
    agentRef?: string;
    /**
     * 原 ExecuteOptions.skillPath。公共 persona 路由三策略（file/flag/prompt）的分流
     * 载体（D4）——超长 prompt 时优先 file/flag 通道分流的落点。
     */
    skillPath?: string;
    /** 追加系统提示内容数组（原样透传；schema 仿真段由公共降级层拼装后放入，P2）。 */
    appendSystemPrompt?: string[];
}
/**
 * 引擎无关的 agent 任务声明（= ExecuteOptions 泛化，字段逐条锚定设计 §3.3.5）。
 *
 * 与 ExecuteOptions 的差异（泛化点）：
 *   - thinkingLevel（pi 7 档枚举语义）→ effort?: string，各引擎自行映射或忽略；
 *   - skillPath + appendSystemPrompt → persona（PersonaSpec）；
 *   - conversation/idleTimeoutMs 保留原名透传——属 interact 交互控制面的 task 标志（D1），
 *     不是 pi 专有语义的泄漏，而是「任务声明里声明交互模式」的中立表达；
 *   - 删字段去向：signal/ctxModel/onComplete 是运行期句柄，移入 RunContext（port.ts）；
 *     schemaEnv 内化到 PiEngine（从 task.schema 派生，见 engines/pi/task-spec-mapper.ts）。
 *
 * 新增（为后续 wave 预留形状，P1 无生产写入方）：
 *   - denyTools：中立工具 denylist（附录 A 该行的载体）；
 *   - permissionMode：中立权限模式（映射按 capabilities.permissionMode）。
 */
interface AgentTaskSpec {
    /** 原样（ExecuteOptions.task）。 */
    task: string;
    /** 原样（ExecuteOptions.slug，≤35 字符）。 */
    slug: string;
    /** 原样（ExecuteOptions.agent，resolveIdentity 的 agent ref）。 */
    agent?: string;
    /** 原样（ExecuteOptions.model；在引擎 provider 体系内解释，D9②）。 */
    model?: string;
    /**
     * 泛化：原 ExecuteOptions.thinkingLevel。引擎无关的推理投入档位字符串——
     * pi 引擎把它原值映射回 thinkingLevel 7 档；其他引擎自行映射（CC 5 档）或忽略
     * （kimi ❌）。不定义联合枚举：档位集合是引擎私有语义，中立层只透传字符串。
     */
    effort?: string;
    /** 泛化：原 skillPath + appendSystemPrompt 收拢（D2）。 */
    persona?: PersonaSpec;
    /**
     * 原样（ExecuteOptions.schema）。native/emulated 分流依据（D4 硬边界）：pi 的
     * PI_WORKFLOW_SCHEMA env 注入链路按 native 直传，公共仿真层只服务 emulated 引擎。
     */
    schema?: Record<string, unknown>;
    /**
     * 原样（ExecuteOptions.maxTurns）。pi 引擎专属（turn limiter + spawn watchdog
     * 估算依赖 pi 的 turn_end 事件流）；其他引擎 prepare 期显式拒绝（U4，同 fork 模式）。
     * 显式 0 压过 SPAWN_WATCHDOG_ENV 兑底（SP-6 参数 > env，U5）；undefined 未传才由
     * env 兑底。
     */
    maxTurns?: number;
    /** 原样（ExecuteOptions.graceTurns）。 */
    graceTurns?: number;
    /** 原样（ExecuteOptions.fork）。pi 专属；其他引擎 prepare 期按 capabilities 拒绝。 */
    fork?: boolean;
    /**
     * 原样（ExecuteOptions.worktree）。公共层职责（worktree-manager），非引擎职责——
     * 引擎只把它当 spawn cwd 的来源之一。
     */
    worktree?: boolean | WorktreeHandle;
    /** 原样（ExecuteOptions.cwd）。 */
    cwd?: string;
    /** 原样（ExecuteOptions.conversation，interact 控制面的 task 标志，D1）。 */
    conversation?: boolean;
    /** 原样（ExecuteOptions.idleTimeoutMs，同上）。 */
    idleTimeoutMs?: number;
    /** 新增：中立工具 denylist。各引擎做语法映射（附录 A「工具 denylist」行的载体）。 */
    denyTools?: string[];
    /** 新增：中立权限模式。映射按 capabilities.permissionMode（kimi fixed auto = ignored）。 */
    permissionMode?: string;
    /**
     * [P4 形状预留，D9① 守卫 b 的独立载体] 任务对引擎能力的显式依赖声明。
     * 首期无生产写入方：守卫 b 与守卫 a 合流（显式 engine 即能力依赖声明）——调用方
     * 按引擎 id 表达依赖。下钻时机（AgentTaskSpec 泛化成熟后）：调用方改按能力表达
     * （如 requires: { sandbox: 'native' }），路由层将本字段与各引擎 capabilities()
     * 对照，无引擎满足时报 engine_capability_unsupported（调用前拒绝，D11 处置三级）。
     */
    requires?: Partial<EngineCapabilities>;
}
/**
 * 一次引擎执行的终态。锚定 orchestration/models/types.ts 的 AgentResult（workflow
 * 引擎消费的那份——content/parsedOutput/usage/error）并追加引擎层字段；见文件头消歧说明。
 */
interface AgentOutcome {
    /** 原样（AgentResult.content）。 */
    content: string;
    /**
     * 原样（AgentResult.parsedOutput）。native 引擎直传 / 仿真层 ajv 产出（D4 硬分流：
     * native 路径公共层不做二次校验、不改写其结果）。
     */
    parsedOutput?: unknown;
    /** 原样（AgentResult.usage，orchestration 版 AgentUsage：含 contextTokens/turns）。 */
    usage?: AgentUsage;
    /** 原样（AgentResult.durationMs）。 */
    durationMs?: number;
    /** 原样（AgentResult.error，错误码前缀格式见设计 §3.3.3 错误规格表）。 */
    error?: string;
    /** 原样（AgentResult.sessionId，引擎语义 session id）。 */
    sessionId?: string;
    /** 原样（AgentResult.sessionFile）。 */
    sessionFile?: string;
    /** 原样（AgentResult.worktreePath，仅诊断——目录可能已被 finalize 清理）。 */
    worktreePath?: string;
    /** 原样（AgentResult.toolCalls，ToolCallEntry[]）。 */
    toolCalls?: ToolCallEntry[];
    /** 新增：实际执行引擎（fallback 后可能 ≠ 请求值，D9①）。 */
    engineId: string;
    /** 新增：fallback 留痕（record 同步投影，GUI 警告条数据源）。P1 恒缺省（无 fallback 路由）。 */
    engineFallback?: {
        from: string;
        reason: string;
    };
    /** 新增：null = 被信号杀死（杀链/abort 合成终态的判据）。P1 pi 链路不暴露 exit code，恒缺省。 */
    exitCode?: number | null;
}
/**
 * EngineHandle 的持久化形态（设计 §3.3.6，JSON v1）。
 * 内存态 EngineHandle = 本数据 + 引擎运行时引用（各引擎自持）。
 */
interface EngineHandleData {
    v: 1;
    /** 引擎 id（'pi' | 'zcode' | ...，registry key）。 */
    engineId: string;
    /**
     * 引擎自定义键值（定位符）。pi = { recordId?, sessionFile? }——recordId 是
     * interact 控制面的 key（subagent record id），sessionFile 是 read 第①级（JSONL
     * 直读）的定位符；zcode = { sessionId, dbPath }。
     */
    sessionRef: Record<string, string>;
    /** 隔离池定位（设计 §3.3.9）。pi 无池化（PI_CODING_AGENT_DIR 全局一份）恒 'shared'。 */
    poolKey: string;
    /**
     * journal 绝对路径（read 第②级数据源；runtime 读前校验前缀白名单）。
     * P2 event journal 落地后由宿主回填；P1 无 journal 写入者，缺省 undefined——
     * read 降级链第②级不可达，直接走 ①/③。
     */
    journalPath?: string;
    /** probe 实测版本（漂移排查锚点）。 */
    engineVersion?: string;
    /** 适配器版本（golden 样本对齐排查）。 */
    adapterVersion: string;
}
/**
 * 引擎会话句柄（run 返回、interact/read 入参）。
 *
 * 契约三条（D1）：不透明（上层不解构——唯一例外是 record 持久化层序列化 data 字段与
 * read 降级链）、可持久化（data 是纯 JSON，主会话 reload 后 read/interact 仍可用）、
 * 自描述（data 含 engineId + 引擎 session 定位符 + pool key + adapter 版本）。
 *
 * 对进程已死的 handle 调 interact 必须返回 engine_session_not_resumable（指向 cold
 * resume 路径），而非笼统失败——由各引擎 interact 实现保证。
 */
interface EngineHandle {
    /** 持久化数据。上层不得解构其内部字段（见契约三条）。 */
    readonly data: EngineHandleData;
}
/**
 * read(handle) 的返回：turns[] 派生数据。与 Turn 同构但无内部态（_status/startedTs
 * 剥离，closed 恒 true）。
 */
interface ReplayedTurn {
    text: string;
    thinking: string;
    /** 导出的纯净形状（execution 层 ToolCall，无 _status）。 */
    toolCalls: ToolCall[];
    closed: true;
}
/**
 * session 历史的引擎中立视图。降级链三级（D6）：①引擎原生读取（pi JSONL / zcode
 * sqlite）→ ②宿主 event journal 重放（P2）→ ③outcome-only。source 字段是 GUI 降级
 * 标记数据源（A8）。
 */
interface SessionView {
    engineId: string;
    sessionId?: string;
    /** turns[] 派生数据（重放/重建产物）。 */
    turns: ReplayedTurn[];
    /** 各 turn usageDelta 聚合（execution 层 AgentUsageTotal）。 */
    usage?: AgentUsageTotal;
    source: "native" | "journal" | "outcome-only";
}
/**
 * 引擎能力声明（设计 D3 原样落地）。三级：native / emulated / unsupported。
 *
 * 易错点（D3）：声明的是**本仓 subagent 链路实际接通的能力**，不是引擎 RPC 层的理论
 * 能力——pi 的 RPC 有 steer 但现有 spawn 链路未接通（session-runner steer no-op），
 * 故 PiEngine 声明 unsupported，接通后再升级。上层据声明选择策略（schema 为 emulated
 * 时自动走公共降级层；steer/conversation unsupported 时 UI 隐藏对应入口），而非
 * try-catch 运行时试错。
 */
interface EngineCapabilities {
    /** native: --json-schema/--output-schema/env 注入（pi = PI_WORKFLOW_SCHEMA 链路）。 */
    schemaEnforcement: "native" | "emulated";
    /** 注意区分「引擎 RPC 层有此能力」与「subagent 链路已接通」。 */
    steer: "native" | "emulated" | "unsupported";
    /** interact 控制面（message/close/cancel + idle）。 */
    conversation: "native" | "unsupported";
    /** 决定 persona 路由策略（公共降级层按此选择 file/flag/prompt 通道）。 */
    personaInjection: "file" | "flag" | "prompt";
    /** 粗粒度引擎：GUI 显示降级为阶段态。 */
    eventGranularity: "stream" | "coarse";
    /** emulated = worktree 隔离（无 OS sandbox 的引擎用文件写维度隔离补齐）。 */
    sandbox: "native" | "emulated" | "none";
    /** 重建历史的能力（read 降级链第①级的保真度上限）。 */
    sessionRead: "full" | "partial" | "outcome-only";
    resume: "native" | "cold" | "unsupported";
    /** 优雅中断 or 只能杀进程（公共杀链兜底，见 D1 abort 分级）。 */
    interrupt: "native" | "kill-only";
    /** kimi headless 固定 auto = ignored；GUI 据此隐藏/提示。 */
    permissionMode: "native" | "fixed" | "ignored";
}
/** 引擎探针报告（probe() 返回）。探针在引擎 factory 初始化与版本变化检测时触发（P4 接线）。 */
interface ProbeReport {
    ok: boolean;
    /** 实测版本（handle.engineVersion 数据源）。探测不到时为空串。 */
    engineVersion: string;
    /** 二进制存在/版本解析/干跑回归逐项。 */
    checks: Array<{
        name: string;
        ok: boolean;
        detail?: string;
    }>;
    /** engine_probe_failed 的恢复指引（设计 §3.3.3 终态四样例；ok=false 时必填）。 */
    error?: {
        code: string;
        recovery: string;
    };
}
/**
 * interact 的 action（D1 交互控制面）。pi 首期原生实现（现有 chatMode 行为直通）；
 * 声明 conversation unsupported 的引擎调用前拒绝（engine_capability_unsupported）。
 */
type InteractAction = {
    kind: "message";
    payload: string;
} | {
    kind: "close";
    payload?: {
        force: boolean;
    };
} | {
    kind: "cancel";
};
/**
 * interact 的结果。失败码取自设计 §3.3.3：engine_session_not_resumable（死 handle）/
 * engine_capability_unsupported（能力声明拒绝）等。
 */
type InteractResult = {
    ok: true;
    delivered: true;
} | {
    ok: false;
    code: string;
    message: string;
};

export type { AgentTaskSpec as A, DoneReason as D, EngineCapabilities as E, InteractAction as I, ProbeReport as P, RunStatus as R, SessionView as S, TracePatch as T, WorkerLogEntry as W, AgentEvent as a, EngineHandle as b, AgentOutcome as c, InteractResult as d, AgentUsage as e, AgentCallOpts as f, AgentResult as g, ExecutionTraceNode as h, EngineHandleData as i, PersonaSpec as j, ReplayedTurn as k };
