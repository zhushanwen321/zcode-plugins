# zsw appserver（apc）主通道化 — 调研与方案

> **一句话结论**：功能面 apc 全面占优（per-session 模型/thinking/工具白名单、零冷启动、事件流），GUI 底层即此架构（同 bundle 每 workspace 一个 `app-server` 进程，subagent 同进程 child session）；真机探针证实协议可用性（thoughtLevel 生效、双会话并发不串线、非法值容错），但推翻了两个此前假设——**send-while-running 是 -32010 硬错误（非排队）**、**崩溃恢复 resume 链卡在 -32031（模型恢复有坑，未走通）**。方案采取「默认翻转 + 降级链保留 + 分阶段能力接入」，spawn 退为显式回退位。

日期：2026-08-29 | 调研方式：bundle 静态读（zcode.cjs 0.13.3，offset 证据）+ zsw 侧代码盘点 + 真机探针 P1-P6b（7 项，真模型，探针产物已清理）。

## 1. 背景与问题

zsw 有两条 runner 通道（`RunnerPort` 策略位，`lib/ports.js:8`「spawn（基线）| appserver（长线）」）。用户决策：推 appserver 为主通道，理由是功能更全面且与 GUI 底层同构（GUI 也是单进程多 session——故障连坐面与 GUI 相当，可接受）。本轮调研目标：查清协议面全部待定语义（send-while-running 等）、盘点还有哪些问题、出切换方案，**不实施**。

## 2. 调研结论

### 2.1 协议全景（bundle 源码）

- **方法全集**（offset 461938 常量表 `rr`）：session 族 21 个（create/resume/list/subagents/read/messages/events/subscribe/send/stop/fork/compact/goal/close/setModel/**setThoughtLevel**/setMode/usage…）、workspace 族 14 个（readState/setDefaultModel/**setDefaultThoughtLevel**/setDefaultMode/generateText…）、plugins/mcp/skills/automation/usage/interaction 族若干。GUI 订阅面 `v4/*` 另一组。
- **session/create params**（zod `.strict()`，未知字段拒收）：`sessionId? parentSessionId? workspace mode? model? runtimeModel? persistence? thoughtLevel? titleGenerationEnabled? mcpServers? toolAllowlist? toolDenylist? importedHistory?`——**per-session 工具白名单/黑名单与 MCP 注入是现成面**（spawn 通道 `--allowed-tools` 被解析器拒收，apc 反而有白名单）。
- **thoughtLevel 合法值按模型动态**：来自 model catalog 的 `capability.reasoning.levels`（`Dcn` 校验，offset 12021428）。**GLM-5.3 系 = `["low","high","max"]`，默认 `max`**（budget low=8k/high=16k/max=32k，anthropic effort+thinking 双通道）。校验源建议用 `workspace/readState` 的 `thoughtLevel.available`。
- **setThoughtLevel 有全局副作用**：写 `localSettingStore.saveGlobalReasoningLevel`（user 级 SQLite）——create 的 `thoughtLevel` 入参同样走此路径（探针 P1 实证：池 HOME db 出现 `reasoningLevel={"level":"high"}`）。隔离 HOME 内无害；**共享 HOME 方案因此再被否一票**。
- **persistence**：枚举 `"immediate"|"deferred"`（deferred=临时会话，list 不可见，首次 send 升级 immediate）。要「崩溃可恢复 + list 可见」须显式 `persistence:"immediate"`。
- **崩溃/驱逐恢复**：会话持久化 SQLite（`~/.zcode/cli/db/db.sqlite`，schema migration 体系）；`session/resume` 从 db 重建并驻留；`requireSession` 只查内存——重启/被驱逐后直接 send 报 `-32004`，**必须先 resume**。**驻留池**（targetCount=8，highWater=16，idleTimeout=10min）意味着 -32004 是常态路径，非仅崩溃。`session/close` 只断开不删数据。
- **send-while-running**：RPC 层硬错误 `-32010 "A prompt is already running"`（不排队不打断）；GUI 的 queue/guide 是引擎层 turn-steer 机制，RPC 用不到。send 是 fire-and-forget（立即返回 `prompt_started`，turn 经 `session/event` 异步推送）；`expectedRevision` 乐观并发（不匹配 `-32009`）；**stop 是唯一绕过请求串行队列的方法**（运行期取消可依赖）。
- **请求串行但会话天然并发**：同一 stdio 连接上请求按 promise 链串行进入处理链，但 send 快速返回不占链；各 session 独立 record/abortController，互不阻塞。
- **无版本协商**：无 initialize 握手；schema 全 strict，漂移表现为 `-32601`（方法没了）/`-32602`（schema 变）——必须当「版本不兼容」信号显式上报而非普通重试。
- **GUI 同构证实**：GUI 主进程 spawn 同一个 `zcode.cjs app-server --stdio`（每 workspace 一个）；GUI 的 subagent = 同进程 child session（`parentSessionId` + `subagents` 投影）。
- **附加面**：app-server 加载完整配置分层（System→User→Project→Env→CLI）、MCP 客户端、plugins RPC、workspace hooks；`ZCODE_STORAGE_DIR`/`ZCODE_SESSION_DB_PATH` 等 env 可覆盖存储根（**不必换整个 HOME**——但插件/技能多根发现是否全随 storage.dir 未逐一验证）；遥测默认开（`ZCODE_MODEL_TELEMETRY_ENABLED` 可关）；无官方嵌套守卫（ZSW_NESTED 自建标记维持）。

### 2.2 zsw 侧现状

- 默认 runner 硬编码 `'spawn'`（`lib/assemble.js:64-65`、`lib/ports.js:130`）；唯一开关 `ZSW_RUNNER=appserver` env（无 config 键、无 CLI flag）；probe 门控 + 失败降级 spawn（`lib/assemble.js:30-52`）；降级可观测（stderr + `record.runnerKind` 逐任务）。
- appserver 通道 RunnerPort 五方法全实现、单测 24 用例（fake server）；真机仅 E7 一个场景。四个协议假设待收口：A2（多会话推送归因）、A4（read/messages 形态）、A5（send-while-running）、A6（session/list 形态）——本轮探针已收口 A5/A6（见 2.3）。
- 空缺：无 watchdog/自动重连/会话跨进程恢复；`idleConversationTtlMs` 预留未接线（`lib/config.js:78`）——但引擎自带驻留池空闲驱逐（10min），zsw 侧 idle TTL 的必要性下降为「服务端 session 记录生命周期管理」。
- **workflow（zflow）线不走 runner 端口**：`lib/workflow/run-phase.js:98` 硬编码 `prepareRunEnv(modelRef,'spawn')` + `driver.runHeadless`——**翻默认只影响 zsub 面，review-fix-loop 等 workflow 每阶段仍冷启动**（接入 runner 端口是独立后续设计）。
- daemon 在 MCP server 进程启动时读一次 env 定死 runner——翻默认后已运行 daemon 保持旧行为，需重启 ZCode 才生效（GUI 只在启动时扫描插件配置）。
- 文档漂移：README:123「单 provider」已过时（model-router 已支持全 provider）；CONTEXT.md env 清单未收录 ZSW_RUNNER。

### 2.3 真机探针结果（P1-P6b，真模型 GLM-5.3-Flash，池 HOME 环境）

| # | 场景 | 结果 |
|---|------|------|
| P1 | create `{thoughtLevel:"high"}` + 小任务 | **通过**：会话正常；引擎日志 `hasInitialThoughtLevel:true`、`setInitialThoughtLevelDurationMs:27`、`thoughtLevel:"high"`；副作用：写池 HOME db `reasoningLevel={"level":"high"}` |
| P2 | create `{thoughtLevel:"ultra-fast"}`（非法） | **容错**：warn `skipped unsupported thought level`，会话照常可用，未写库 |
| P3 | 运行中第二次 send | **-32010 结构化拒绝**（`"A prompt is already running for this session"`）；首个 turn 正常完成、全文完整——**不支持运行中投递**，zsw 现有 busy 保守实现正确 |
| P4 | SIGKILL 后重启，直接 list/subscribe/send 旧会话 | list 跨进程可用（A6 收口：形态 `result.sessions[].sessionId/status/title/workspace`，与 zsw 提取兼容）；直接 send 报 **-32004 "Session is not active"** |
| P5 | 双会话并发 send | **通过**：17.5s 双 turn.terminal，响应 A-OK/B-OK 各自正确不串线 |
| P6 | kill → 重启 → `session/resume` → send | resume **成功**（返回完整快照 messages/projection/session/runtime…）；但 send 报 **-32031「历史任务使用的模型已不可用」** |
| P6b | resume → `session/setModel` → send | setModel 成功但 send 仍 -32031——restoreWarning 不因 setModel 清除，**解除条件未探明**（候选：`runtimeModel` 参数 / `session/updateRuntimeModelConfig`；也可能与 per-model 池 HOME 的模型可用面有关） |

### 2.4 相对既往认知的关键修正

1. 「apc 支持运行中投递（待探针）」→ **不支持**（-32010 硬错误；GUI 的排队/引导是引擎层机制，RPC 无此面）。message/steering 能力两通道实际等价，apc 的优势清单去掉此项。
2. 「thinking 一律 max 需要接线」→ **GLM-5.3 默认就是 max**：不传 thoughtLevel 时走 catalog 默认，apc 通道的子代理已在 max 档。thinking 接线的价值变为「**可下调**（low/high 省预算）」而非「补默认」。
3. 「崩溃恢复待设计」→ 协议有 `session/resume` 但**恢复链未走通**（-32031 模型恢复坑）；且空闲驱逐（10min）使 -32004 成为常态——恢复序是主通道化的硬前置。
4. spawn 通道独有优势只剩两条（stdout JSON 稳定输出面、每轮进程故障隔离），作为降级兜底位依然成立。

## 3. 风险清单（合并 R1/R2，去重后 10 条）

| # | 风险 | 处置方向 |
|---|------|----------|
| RK-1 | 协议无版本协商，ZCode 升级字段漂移以 -32601/-32602 出现 | 通道层把 -32601/-32602 识别为「版本不兼容」显式上报 + probe 扩为漂移冒烟（协议方法/关键字段探针）|
| RK-2 | -32004 是常态（空闲驱逐+进程重启），无恢复序则 conversation 断链 | 实现「-32004 → session/resume →（-32031 处理）→ 重试 send」恢复序 |
| RK-3 | resume 后 -32031（模型不可用）未走通（P6b） | 专项探针 TP-1：`runtimeModel` 参数 / `updateRuntimeModelConfig` / 单一 home-appserver 环境（模型可用面更宽）三线排查；都不行则降级语义 =「resume 失败会话弃用、任务级重试」并如实标注 |
| RK-4 | -32010 硬错误：多输入并发打同一会话需自建闸 | manager 维持 idle-only 门禁（现状正确）；以 turn.completed/failed 为闸，-32010 不重试 |
| RK-5 | 事件流是唯一进度面，事件去重/重放幂等未验证 | A2 收口：多会话抓包 + 以 sessionId+turnId+事件类型去重 |
| RK-6 | setThoughtLevel/create.thoughtLevel 写 user 级全局设置 | 隔离 HOME 下无害（现状）；**禁止**在共享 HOME 方案中调用（共享 HOME 已被否） |
| RK-7 | thoughtLevel 合法值 per-model 动态（GLM=low/high/max） | 校验源用 `workspace/readState` 的 `thoughtLevel.available`，禁本地硬编码枚举 |
| RK-8 | daemon 读一次 env 定死 runner；GUI 启动期扫描插件 | 翻默认发布说明注明「重启 ZCode 生效」；probe 失败降级链兜底 |
| RK-9 | --local 路径组装期 probe 开销（失败最长 10s） | probe 预算调小或结果缓存（同一 CLI 版本 + mtime 键） |
| RK-10 | GUI 与 zsw 对同一 workspace 各自 spawn app-server，双 SQLite 连接 | zsw workspace 用任务独立 cwd（现状即如此，stableWorkspaceKey 天然隔离）；文档声明避免共享 workspace 会话集合 |

## 4. 方案（分阶段，均为设计——本轮不实施）

**总原则**：默认翻转 + 降级链保留 + 能力增量分阶段；spawn 从基线退为显式回退位（`ZSW_RUNNER=spawn`）与 probe 降级落点，不删除。workflow 线（zflow）**不在本方案内**（`run-phase.js` 硬编码 spawn，接入 runner 端点是独立后续设计）。

### 阶段 S0：前置收口（默认翻转的硬前置）

1. **TP-1 resume/-32031 专项探针**：①单一 `home-appserver` 环境复现（模型可用面与 per-model 池不同）；②create 带 `runtimeModel` 参数；③`session/updateRuntimeModelConfig`。产出：恢复序规格或降级语义声明。
2. **TP-2 A2/A4 收口**：多会话并发推送抓包（sessionId 归因 + 事件去重键形态）；`session/read`/`session/messages` 真实返回形态（现有四级降级链的链头校准）。
3. **漂移信号显式化**：`runner-appserver` 的错误分类——`-32601/-32602` 上报为 `protocol-drift`（record + stderr 醒目），提示跑升级冒烟。
4. **probe 扩面**：现有 probe（create+close）扩为「create + send 极小任务 + 关键字段存在性断言」的漂移冒烟脚本，供 ZCode 升级后手动/CI 跑。

### 阶段 S1：默认翻转（最小改动面）

- `lib/assemble.js:64-65` / `lib/ports.js:130` 默认值 `spawn` → `appserver`；`ZSW_RUNNER=spawn` 成为显式回退开关；probe 失败降级 spawn 保留（降级日志 + record.runnerKind 照旧）。
- 恢复序接线：send/resume 遇 `-32004` → 自动 `session/resume` → 重试一次（TP-1 结论并入）；`-32010` 维持 busy 不重试。
- `create` 参数显式化：`persistence:"immediate"`（可恢复 + list 可见）。
- 测试翻转：`assemble.test.js` 缺省断言反转 + 显式回退用例；`e2e.test.js` E1-E6/E8 逐场景显式钉 `ZSW_RUNNER=spawn`（E4 pid 探活/E6 exec.pid 是 spawn 专有），E7 升级为主链路回归 + 新增多会话并发场景（收口 A2）。
- 文档：README 已知边界重写（:121-123，顺修单 provider 过时条目）、M5 行改写；CONTEXT.md env 清单补 ZSW_RUNNER；发布说明注明「重启 ZCode 生效」。
- **发版判定：minor**（新增默认行为路径 + 回退开关保留旧路径；若团队认为默认执行通道切换构成语义不兼容可升 major——按仓库准则「MCP tool 语义/action 行为不兼容变更」的边界裁量，倾向 minor + 显著 changelog）。

### 阶段 S2：能力增量（apc 独有面接线，逐项独立验收）

1. **thinking 接线**：`zsub start --thinking <low|high|max>`（与 pi 的 thinkingLevel 面对齐）→ `createParams.thoughtLevel`；合法性校验走 `workspace/readState`（RK-7）；非法值沿用引擎容错（warn 跳过，P2 实证）。**注意**：默认不传 = GLM 默认 max（「thinking 一律 max」已天然满足；flag 的价值是省钱下调）。**禁用** `session/setThoughtLevel` RPC（RK-6 全局副作用）。spawn 降级轮 thinking 缺省（可观测标注）。
2. **per-session 工具限制**：`create.toolAllowlist/toolDenylist` 接线（替代 spawn 的 `--disallowed-tools` 单向限制——白名单是 apc 独有能力）。
3. **idle/生命周期**：依赖引擎驻留池（10min 驱逐 + resume 可回）作为会话回收层；zsw 侧 `_sessions` 登记表随 -32004/resume 同步；`idleConversationTtlMs` 要么接线要么删除预留常量（决策点）。
4. **遥测关闭**：app-server env 注入 `ZCODE_MODEL_TELEMETRY_ENABLED=false`（隔离环境不留遥测标识）。

### 阶段 S3（可选后续，独立设计）：workflow 线接入 runner 端口

`run-phase.js` 从硬编码 spawn 改走 RunnerPort，使 review-fix-loop 等聚合/fix phase 复用常驻进程（省每阶段 1-2s × phase 数冷启动）；涉及嵌套防护与 prepareRunEnv 语义迁移，单独出设计。

### 验收场景草案（S1/S2 用，真机）

| # | 场景 | 通过标准 |
|---|------|----------|
| A-1 | 默认（不设 ZSW_RUNNER）`zsw start` 两任务 | record.runnerKind='appserver'；任务正常完成 |
| A-2 | probe 破坏（ZSW_ZCODE_CLI 指向坏路径） | 降级 spawn + stderr 降级日志 + record 如实标注 |
| A-3 | `ZSW_RUNNER=spawn` 显式回退 | 走 spawn 通道（旧路径行为不变） |
| A-4 | conversation 第二轮（任务运行 daemon 重启） | -32004 → 自动 resume → 续聊成功（或按 TP-1 结论的降级语义如实报告） |
| A-5 | `--thinking low` run | 引擎日志 thoughtLevel:"low"；`--thinking ultra` → warn 跳过不失败 |
| A-6 | 双会话并发 4 任务 | 全部完成、响应不串线、事件归因正确 |
| A-7 | Zcode 升级后跑漂移冒烟 | 协议关键面探测结果落档；-32601/-32602 被识别为 protocol-drift |

## 5. 待验证检查点

1. TP-1：resume 后 -32031 的解除条件（runtimeModel 参数？updateRuntimeModelConfig？单一 HOME 环境差异？）——决定 A-4 是「自动恢复」还是「降级重试」。
2. `ZCODE_STORAGE_DIR` 隔离方案下插件/技能多根发现是否完全随 storage.dir（若随，则 appserver HOME 隔离可简化为 env 隔离，连带 RK-6 的库写入也被隔离）。
3. 引擎请求串行链在高频 turn 下的吞吐（P5 双会话已证并发，但 5+ 会话 × 长事件流的 stdio 背压未测）。

## 6. 调研产物索引

- bundle offset 证据与方法全集：见本文 §2.1（源码 /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs 0.13.3）。
- 探针 P1-P6b：临时脚本与输出已清理（结论全文见 §2.3；复现脚本要点：NDJSON 帧不带 jsonrpc 字段、create 触发反向请求 requestRuntimePreferences 必答四字段、sessionId 在 `result.session.sessionId`）。
