# zcode 上下文压缩触发通道调研（z-smart-context 收口沉淀）

> 调研窗口：2026-08-26 ~ 2026-08-27。环境：ZCode.app 3.9.1（zcode.cjs 0.16.5 构建）/ node v24.11.1 / GLM-5.3（窗口 1M）。
> 方法：隔离 HOME + 真实无头模型会话（`--json --prompt` 单轮 / `app-server` 长驻多轮）+ 生产 db 只读 + bundle 静态逆向 + 官方 zcode-guide v0.1.0 逐条核对。
> 背景：z-smart-context 插件（用量提醒 + agent 自决策压缩）已完成 v1/v2.1 开发后**收口放弃**（见 `docs/adr/0001`）。本文固化全部探针结论，供后续重启或官方开放通道时复用——所有断言均经实测或三处以上互证，未验证处显式标注。
>
> **一句话结论**：zcode 的上下文压缩只能由**持有会话的引擎进程自己**执行；对外部（hook / MCP 工具 / CLI / app-server 跨实例）唯一真实可达的触发面是 **config 预写驱动内建 autoCompact**（仅对新启动进程生效）与 **对非活跃会话的协议链外部压缩**。GUI 活跃会话不存在纯后台触发通道。

---

## 1. 引擎压缩机制事实

| 事实 | 值 / 语义 | 证据 |
|------|----------|------|
| 内建 autoCompact 触发线 | 未显式配置时 = `contextWindow × 95%`（bundle `I1r=95`；快照 `autoCompactThresholdTokens` 默认 null，`thresholdPercentOverride ∈(0,100]` 可覆盖） | 静态逆向三处互证 |
| 触发检查点 | 引擎**每轮模型请求前**（PreRequest）检查 `token > contextWindow − 21000 − 13000`；turn 内工具循环的每次请求都过检查点 → 阈值压低后可在 turn 内自动压缩且任务天然连续 | P17 实测（override 驱动真压缩） |
| catalog override 驱动 | 全局 `~/.zcode/cli/config.json` 的 `modelCatalog.overrides["<provider>/<model>"].contextWindow = threshold + 34000` 可拉低阈值；**进程启动时读定，长驻进程不热重读**（改文件对运行中 GUI 引擎无效——既是死结也是保护） | P17 ✅ / P18 ✅ / P21（项目级 `zcode.json` 的窗口值可见但不驱动）❌ |
| 手动 `/compact [instructions]` | instructions 逐字进压缩 prompt 的 Additional Instructions 段 | P14 ✅ |
| 压缩无 hook | 全程零 hook 触发；`SessionStart(compact)` 在 app-server `/compact` 路径实测**不触发**（matcher 全匹配 0 次调用）；GUI 手动路径未测但无理由更可靠 | P4 ❌ |
| 压缩遥测 | `preCompactTokenCount` / `postCompactTokenCount` / `willRetriggerNextTurn` / `summarizedMessageCount`（bundle）；引擎日志 `compact.started/completed/failed`（含 cause 链） | 逆向 + 日志实测 |
| noop 语义 | 已处压缩态的会话再压返回 `session/event payload.response:"Context is up to date; no compression needed"`，不产生 "Compacted" 帧 | BP-9 e2e |

## 2. 注入通道语义（additionalContext）

| 事实 | 语义 | 证据 |
|------|------|------|
| UserPromptSubmit 顶层 `{"additionalContext":…}` | ✅ 以 `role=system` 消息物理进入本请求 `request.messages` 尾部；turn 内所有请求带；**同进程跨 turn 存续（累积至 compact，compact 会卷入摘要）；进程重启即丢；不落任何 db 表**（message/session_entry/part/input_history 全查过） | P13 对照实验 |
| Stop 事件的 additionalContext | ❌ **两形态（顶层 / hookSpecificOutput）均不进模型请求**（对照实验：STOP hook 确认执行、同进程连续轮请求零命中） | P13 |
| 注入命令不解析 | mailbox / send 投递的 `/compact` 文本作为普通内容注入或送模型，**不执行**（引擎安全设计） | P1 / P19 |
| Stop 触发粒度 | 交互轮级（一个 turn 内 4 次工具调用仅 1 次 Stop）；PostToolUse 每工具一次（唯一 turn 内粒度候选，spawn 成本高） | P12 ✅ |
| hook stdin 无用量字段 | 四事件 payload 全 dump：SS 带 `source`/`model`，UPS 带 `prompt`，PTU 带工具五元组，Stop 带 `responseText`/`toolCallCount`/`stopHookActive`；无任何 token 字段 | M0 dump |
| hooks schema 错误的爆炸半径 | hooks.json 的 command 误写数组等 → **整个 config.json 拒载**（连 model 配置失效）；引擎日志 `config.file.invalid` 可查 | 实测（计划外发现） |
| timeout 单位陷阱 | `command.timeout` 秒 / `process.timeoutMs` 毫秒 / 默认 60000ms；`async:true` 无效恒内联（阻塞事件流） | 官方文档在册 |

## 3. 用量数据源口径

| 数据源 | 口径 | 判定 |
|--------|------|------|
| `turn_usage.computed_total_tokens` | **= Σ(input+output) 本 turn 全部调用累计**（12 行生产数据逐行精确吻合；req_count=97 行达 15.1M）——干活越久越虚高 | ⛔ 阈值/回落两用皆废 |
| `model_usage` 末行 `input_tokens + cache_read_input_tokens` | 单调递增即上下文增长曲线，末行 ≈ 当前上下文规模 | ✅ 正确读数（一行 SQL） |
| rollout JSONL 末行 `response.usage` | `inputTokens + cacheReadTokens` 同构（注意：messages 在 `request.messages` 非 body；usage 在 `response.usage` 非行顶层） | ✅ 可互验 |
| app-server `session/usage`（跨实例可读） | `inputBaselineBySource.main_turn` = 干净的当前上下文读数；`session/list` 跨实例可枚举会话 | ✅ 协议面（hook/CLI 不可达） |
| agent Bash env | **无任何 sessionId 变量**（session 标识只注入 hook 进程：`CLAUDE_SESSION_ID`） | CLI 必须 `--latest`（cwd 反查） |

## 4. 触发通道矩阵（全部探针汇总，死活一目）

**外部 → GUI 活跃会话（全部死路）**：

| 通道 | 结果 |
|------|------|
| hook 输出 schema | 无 compact 触发键（T3r 全量字段核对）❌ |
| mailbox 投 `/compact` 文本 | 纯文本注入不执行 ❌（P1） |
| app-server `session/send` 文本 `/compact` | 不解析为命令，普通 prompt 送模型 ❌（P19）；turn 运行中 send → `-32010` ❌ |
| 外部 app-server `session/compact` / `session/send` / 会话级方法 | `-32004 Session is not active`——**会话活动性 = 持有进程内存 Map，外部实例零调用面**（BP-1） |
| `session/updateRuntimeModelConfig` 运行时改窗口 | strict schema：`model` 与 `provider.models[]` 两层拒 `limit`/`contextWindow` ❌（BP-2） |
| `workspace/upsertModelProvider` | 可达但写全局注册表 + 持有引擎不热重读，链条断 + 副作用不可接受 ❌（BP-3） |
| 外部 `--resume --prompt /compact` 压活跃会话 | 落盘成功但**持有引擎完全无感知**（每轮只读内存历史，无 db watch）——双持分裂 ❌（P15） |
| 长驻引擎热改 config | 不重读 ❌（P18） |
| 引擎进程 `znr-*.sock` | 实为 Browser Use 的 browser broker（op: list/execute + browserId/command），非引擎 eval ❌（BP-4） |
| GUI 引擎进程调用面 | stdio 为与 host 的私有 socketpair、无 listen sock、无 URL scheme、SingletonSocket 为实例互斥 ❌（BP-5） |
| CUA（computer-use）注入输入框 | 技术上走 GUI 完整链路，但**占用/扰动前台 GUI**；且实测非前台 Electron AX 全 mismatched、合成键入丢中文 → 产品否决 ❌（P16/P20） |

**外部可达的真实通道**：

| 通道 | 语义 | 约束 |
|------|------|------|
| config 预写（`modelCatalog.overrides`） | 新启动进程读到低阈值 → PreRequest 自动压缩（turn 内连续） | 只影响新进程；窗口期全局生效须紧包裹 + 还原（P17 ✅） |
| 非活跃会话外部压缩（协议链） | 见 §5 | 目标会话必须无持有者（tab 已关 / runner 已退） |

## 5. 非活跃会话外部压缩协议链（BP-9 端到端实证，52s）

```
spawn node zcode.cjs app-server --cwd <会话目录>          # 生产 HOME（读真实 config/db）
  │  反向请求必答（不答 15s 断连 -32022）：
  │    session/requestRuntimePreferences → {nativeSearchEnhancementsEnabled: true,
  │      memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true,
  │      modelContextBudgetStrategy: "preflight-v1"}
  ▼
session/resume {sessionId}
  ▼
session/subscribe {sessionId, deliveryKind: "desktop-continuous"}   # 不订阅收不到确认推送
  ▼
session/updateRuntimeModelConfig {sessionId, runtimeModel: {
    revision: <string>, generatedAt: <number>,
    model: {providerId, modelId},
    provider: {providerId, kind, baseURL, apiKey, models: [{modelId}]}}}
  ▼
session/send {sessionId, content: "/compact 保留：<retention>"}
  ▼
session/event payload.response = "Compacted" | "…no compression needed"(noop)
```

**provider 凭据三坑**（runtime provider 定义整体覆盖进程内 registry）：
1. 缺 `apiKey` → 压缩调用 `provider_not_configured`（提示 envKey: ANTHROPIC_API_KEY 有误导性）；
2. 带 `apiKey` 缺 `baseURL` → 同一 key 打到默认端点 → `Provider authentication failed`；
3. 正确形态：`apiKey = {source:"inline", value: <config options.apiKey>}`（schema 为 discriminatedUnion("source")：`inline{value}` / `env{name}` / `credential{key}` / `server-config{key}` / `session-secret{key}`）。

**其他坑位**：`turn.terminal` 在压缩 turn 上会误报 failed（成功判据只能用 session/event）；resume 的 params 顶层不收 runtimePreferences（走反向请求应答）；已压会话复压返回 noop 文案；压缩请求不出现在 rollout model-io（事后核实用 `session/usage` 回落或引擎日志 `"event":"compact`）。

## 6. 协议方法与收获清单

- ZCode Protocol 方法全枚举（22 个 session/* + workspace/*）：`create/resume/send/stop/close/list/read/messages/events/subscribe/compact/fork/goal/setMode/setModel/setThoughtLevel/updateRuntimeModelConfig/usage/subagents/cancelBackgroundTask/requestRuntimePreferences`；workspace 级 `readState/hookTrustGrant/updateProviderRegistry/updateInteractionPreferences/updateModelIoPreferences/upsertModelProvider/removeModelProvider/setDefaultModel`。
- 会话引擎架构实测：GUI = Electron → `zcode-host-local-*`（host）→ 每会话一个 `zcode-cli` 引擎进程（stdio socketpair 私有）；agent 的 MCP server 由引擎 spawn（进程树可判会话形态，zsc 曾用 `ZSC_HEADLESS` + 父链特征双判）。
- 无头模式正常执行 config hooks（单轮与 app-server 均验证）——hook 类插件的 e2e 方法论可行。

## 7. 复用指引

若官方开放以下任一通道，本调研的协议链与判据可直接重启该场景：① `session/compact` 跨实例授权（或活动性查询面）；② mailbox 命令白名单（kind:command）；③ hooks 输出 schema 增加 compact 触发键；④ `updateRuntimeModelConfig` 暴露窗口/thresholdPercent 字段。GUI 会话的 agent 自决策压缩在④落地后最顺（运行时压阈值 → PreRequest 自动压缩，turn 内连续且零 GUI 接触）。
