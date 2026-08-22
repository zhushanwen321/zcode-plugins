# zsub — zcode 平台 subagent 编排插件设计文档 v3

> **一句话结论**：以「端口/适配器内核」构建 zsub——MCP 粗粒度单 tool `zsub`（五 action）为入口、双 Runner（spawn 已验证基线 / app-server 长期主路线，探针降级）为执行引擎、mailbox（`tools/call` `_meta` 定向 + 原子写）为完成回流主通道、CLI 薄壳留位 bash 增强通道。执行引擎 / 回流通道 / 入口形态三个决策正交且各自可换（`lib/ports.js` 契约），上层决策改变不动核心域。
>
> **修订记录**：v3（2026-08-23）相对 v2 的架构转向——①入口从「MCP 全量 schema」修正为「粗粒度单 tool + skill 渐进式」（MCP tool 全量常驻注入的实测事实）；②通知定向从「PostToolUse hook + 活跃会话表」替换为「`_meta.session_id` 直取」（hook 机械整体消失）；③执行层从「spawn 单轮唯一」升级为「RunnerPort 双实现」；④明确与引擎原生 background agent 的分工（zsub 只做原生做不到的增量）。v2 文档保留于 `DESIGN.md` 作历史。

**设计层级声明**：本文是「技术方案层」设计，下一层产物是 wave 开发任务与代码。接口契约（ports.js 签名级）在 §5.3 给出，函数实现不在本文。

---

## 1. 背景目标

### SCQA

- **S**：用户在 pi 平台有成熟的 subagent 编排扩展 `pi-subagent-workflow`（29k 行，进程内 extension API）；zcode 平台已有 `dynamic-workflow` v0.2.0（MCP 插件，5 个确定性 workflow，沉淀 driver/jsonout/pool 三件基建）。
- **C**：zcode 闭源，插件只能以 MCP server / hooks / md 资源三种外设形态存在，隔着协议与信任边界；pi 依赖的进程内特权 API（`sendMessage`+`triggerTurn`、EventBus、stdin 直写 steering）一样都摸不到。
- **Q**：外挂形态下，编排能力（委派/并行/生命周期/回流/隔离）能复刻到什么程度？关键决策（执行引擎、回流通道、入口形态）未来变了怎么低成本换？
- **A**：把「编排内核」做成端口化 lib（与入口无关），MCP 单 tool + skill 做薄入口，回流与执行各做成多实现端口——决策可换、核心不动。

### 设计目标

| # | 目标 | 从使用者体验倒推 |
|---|------|------------------|
| G1 | 主 agent 可编程式管理 subagent 生命周期 | zcode 主会话里 LLM 能 start/list/status/cancel/message/close，而非只能一次性 `Agent` tool |
| G2 | 复用现有 agent .md 生态 | `~/.agents/agents/` 与项目 `.agents/agents/` 直接可用（四根发现，绕开 zcode 只扫 `.zcode/agents` + symlink 跳过的限制） |
| G3 | 后台 subagent 完成后结果自动回流主会话 | 主通道：mailbox 注入（`_meta` 定向）；降级：polling（「结果可达」档）。已知边界：外部进程不能投递 task-notification，idle 主动唤醒是外挂物理上限之外 |
| G4 | 文件改动隔离可选 | worktree=true 时改动落独立 worktree，patch 回传，通知含 apply 指引 |

### In / Out of Scope

**In**：五 action；agent .md 四根发现；model 路由（双机制）；conversation 续聊；worktree；schema 近似输出；record store；防递归；并发池；mailbox 回流 + polling 兜底；CLI 薄壳（调试 + bash 通道留位）；AppServerRunner（探针门控）。

**Out**：
- workflow 编排（dynamic-workflow 已交付，收敛到 zsub lib 是后续课题）
- 简单纯后台任务的「原生路径」（frontmatter `background:true` + 引擎 `Agent` tool 已覆盖独立 turn 唤醒 + goal gate；zsub skill 中指引分流，不重复造）
- fork（`session/fork` 留探针后评估）、TUI/GUI 视图（无插件 UI 扩展点）、goal 联动（外挂不进 runtimeTaskRegistry；bash 通道为后续可选增强，见 D4）

---

## 2. 现状与问题分析

### 2.1 使用者视角现状与失败模式

zcode 主 agent 今天用 subagent 只有两条路：GUI `@mention`（同步阻塞一次性）与 `.zcode/agents/` 下的 .md 定义。失败模式：**F1 无法后台**（长任务卡死主会话）、**F2 无法取消/查看**、**F3 无法续聊**、**F4 无隔离**、**F5 生态分裂**（pi 的 `~/.agents/agents/` 在 zcode 不可见，symlink 被 agent 扫描跳过）。

### 2.2 平台事实基线（全部实测/源码锚点）

**zcode 基础设施（本轮逆向 + 前序实测，锚点为 zcode.cjs 内 offset）**：

| # | 事实 | 证据 |
|---|------|------|
| Z1 | **MCP tool 全量常驻注入**：每个 MCP tool 的 name+description+inputSchema 无上限注册并进每个 LLM 请求的 tools 数组，无按需加载（SDK 有 deferLoading 但 zcode 未用）；输出截断 inline 100KB / model 50KB | @10758615 全量注册、@10422692 bdt、@4120580 每请求序列化 |
| Z2 | **MCP tools/call 超时 30s 默认**，progress 通知可无限续命（resetTimeoutOnProgress 且无 maxTotalTimeout） | @7548949 callTool、Fot=3e4 @7545085 |
| Z3 | **`_meta` 自带会话上下文**：每次 tools/call 请求的 `params._meta["com.zcode/request-context"]` 含 `session_id`/`turn_id`/trace（runtime 主路径默认带）——MCP server 直知当前主会话，**无需 hook** | @7553130 B4o、@7549870 附加点 |
| Z4 | **引擎原生 background agent**：frontmatter `background:true` → 同进程 childSession、`Agent` tool 立即返回 `async_launched`、完成走 `backgroundSource:"subagent"` 的 task-notification **独立 turn 唤醒**（含 result 全文 ≤120k 字符）、写 runtimeTaskRegistry（isBackgrounded）→ **阻塞 goal gate**；子代理内部后台通知被 sealed 防泄漏 | @10260805 解析、@10437400 jdt、@10458000 Fdt 入队、@10709481 vNr 独立 turn、@10698807 gate |
| Z5 | **外部进程不能投递 task-notification**（该通道在引擎内部）；外部唯一注入通道是 mailbox（`ZCODE_MESSAGE_ENABLED` 默认禁用） | 通道注入点全在引擎内部；mailbox @10358509/@11602458 |
| Z6 | **Bash 后台通知只有 output-file 路径 + 一句 summary**（无 stdout 正文，模型需自己 read）；全局文本截断 120k 字符 | @7699948 format、@7679900 渲染 |
| Z7 | **skill 渐进式**：一行索引（name+desc+when 各截 250 + file 路径）每 turn 注入（总预算 20k 字符），正文触发时经 Skill tool 读（100k 上限）；agent .md 一行索引嵌在 Agent tool description；command .md 无常驻索引（用户键入展开） | @7596600-7597570、@10270900、@10264754 |
| Z8 | **mailbox 语义**：根 `ZCODE_MAILBOX_ROOT ?? ~/.zcode/mailbox`；envelope 六字段严格校验；drain 挂 UserPromptSubmit/PostToolUse/Stop、单次 ≤20 条、按文件名字典序；**坏文件中断本轮 drain 且永久阻塞排序在后的消息**（无 quarantine）——投递必须 tmp+rename 原子写 | @11067925、@10358509、@11763160（v2 实测复核） |
| Z9 | 无头 CLI：`--json --cwd --mode --prompt --resume --disallowed-tools` 可用；`--max-turns/--allowed-tools/--settings` 拒收；provider 配置读 `$HOME/.zcode/cli/config.json` → 隔离 HOME = 独立 provider/model；无 `--model` flag | driver.js 生产 + v2 实测（B1-B4 沿用） |
| Z10 | MCP server（stdio）由引擎 spawn，继承引擎进程全部字符串 env（含 `ZCODE_MESSAGE_ENABLED`/`ZCODE_MAILBOX_ROOT` 的真实值）；plugin server 额外注入 `ZCODE_PLUGIN_ROOT`/`ZCODE_PROJECT_DIR` | @7554700、@7522315 Hvr、@6954960 |
| Z11 | `zcode app-server`：NDJSON 双向 RPC（GUI 同款协议）。请求/响应/推送/反向请求四帧；`session/create` 支持 model/thoughtLevel/toolAllowlist/toolDenylist/mcpServers/parentSessionId，**必答反向请求 `session/requestRuntimePreferences`（15s 超时）**；`session/subscribe`（deliveryKind 必填）/`send`（字段 content）/`stop`/`close`/`list`（跨进程）；实时流在 `v4/telemetry/event` kind:"stream.chunk"；`session/read` 仅限本进程 active 会话 | handoff v2 实测全通（协议骨架与错误码 -32602/-32004/-32022 已映射） |

**pi 参考系（源码调研）**：

| # | 事实 | 证据 |
|---|------|------|
| P1 | pi 的 tool 同样 description+schema 全量注入，但 system prompt 只放一行 `promptSnippet`；agent/skill 走一行渐进索引（name+desc+location）——token 经济学与 zcode 面临同构问题，解法同构 | agent-session.js:633/261、system-prompt.js:45、subagent-list-injector.ts:159 |
| P2 | steering = stdin 直写（`followUp` 入队 / `steer` 抢占），busy/idle 由子进程权威裁决；冷路径 resume 重 spawn + 消息重放 | subagent-service.ts:901 deliverMessage |
| P3 | 回流 = `sendMessage({customType, content}, {triggerTurn:true, deliverAs:"steer"})`，时机是主 agent isIdle 后立即（isIdle gate 防窄窗口丢消息）；patchFile 通知带 `git apply` 指引 | notifier.ts:126/223、finalize-record.ts:63 |
| P4 | 设计哲学：background-only（父 turn 不阻塞）、明示禁止 poll（烧 token 且与通知冗余）、fork 低频（上下文污染）、并发 6 + 深度分层 `max(1, N - depth)` | subagent-tool.ts:249/276、config.ts:24、subagent-service.ts:1417 |

### 2.3 定位分析：zsub 与原生机制的分工

引擎原生 background agent（Z4）已免费提供「立即返回 + 独立 turn 唤醒 + goal gate」，但它是**同进程 childSession**，受制于：无文件隔离、无 schema 结构化输出、无续聊（一次性）、agent 发现只认 `.zcode/agents` 双根、frontmatter model 之外的动态路由被移除、无跨会话 record。

**zsub 的增量价值 = 原生做不到的部分**：worktree 隔离 + patch、conversation、schema、四根发现、跨窗口 record store、per-start model 路由。简单后台任务（无上述需求）应走原生路径——zsub 的 skill 明确指引分流，不与原生竞争。

**外挂模式的物理上限（如实声明）**：外部进程不能投 task-notification（Z5），mailbox 只在主 agent 下次活动时注入。pi 的 idle 主动唤醒（P3 triggerTurn）在外挂形态下不可达；唯一例外是 bash `run_in_background`（Z6，独立 turn + goal gate，但通知只有路径，模型需自己 read）——留作 CLI 增强通道（D4/D13），不进 MVP 主链路。

### 2.4 根因

zcode 的扩展是「宿主的外设」（协议边界外，只能借道文件系统/子进程/被动注入），pi 的 extension 是「宿主的器官」（进程内特权 API）。复刻的本质是用三个低特权原语（无头进程 + 隔离 HOME + 文件通道）重新搭出等价语义，并把「哪些决策可能变」封装成可替换端口——这是闭源平台上唯一能对抗版本漂移的结构。

---

## 3. 解决方案

### 3.1 终态架构（端口/适配器内核）

```
┌─ 入口层（决策位③，薄）─────────────────────────────────────┐
│ MCP server：单 tool `zsub`（五 action，description ≤1.5KB）  │
│ skill：zsub-orchestration（一行索引渐进式，用法哲学/分流指引）│
│ CLI 薄壳：bin/zsub.js（人类调试 + bash 增强通道留位）         │
├─ 编排层 ──────────────────────────────────────────────────┤
│ SubagentManager（lib/manager.js）：五 action 用例编排，      │
│ 只依赖 ports.js 契约，不依赖任何具体实现                      │
├─ 端口层（lib/ports.js 契约 + registry）────────────────────┤
│ RunnerPort（决策位①）      NotifierPort（决策位②）           │
│  ├ SpawnRunner ✅基线       ├ MailboxNotifier ✅主           │
│  └ AppServerRunner 长线    ├ PollingNotifier ✅兜底          │
│ ModelRouterPort            └ (预留 TaskNotificationNotifier)│
│  ├ home-pool（spawn 配套）  AgentResolverPort / RecordStore- │
│  └ per-session（apc 配套）  Port / WorktreePort（固定实现）   │
├─ 域层（纯逻辑 + fs，无平台依赖）────────────────────────────┤
│ agent-md-resolver / prompt-builder / record-store /         │
│ output-store / worktree / jsonout / pool / reaper            │
└───────────────────────────────────────────────────────────┘
```

**三个正交决策位**（用户核心诉求「决策可换、核心不动」的落点）：

| 决策位 | 现行选择 | 备选 | 更换成本 |
|--------|---------|------|---------|
| ① 执行引擎 | SpawnRunner（已验证） | AppServerRunner（长线主路线，探针门控） | 实现同一 RunnerPort，manager 零改动；record.exec 存 runner 不透明句柄 |
| ② 回流通道 | MailboxNotifier（`_meta` 定向） | PollingNotifier（兜底，自动切换）；TaskNotificationNotifier（bash 模式，预留） | 同一 NotifierPort；capabilities() 声明语义档位 |
| ③ 入口形态 | MCP 单 tool + skill | CLI（已有薄壳）；未来任意前端 | 同一 manager；MCP server / CLI 都只是 ~100 行胶水 |

### 3.2 关键决策与权衡

**D1 总架构：端口/适配器内核**。域层（record/resolver/prompt/worktree）不依赖平台细节；平台依赖全部收进端口实现。闭源平台的版本漂移（3.0.0→3.8.1 已实测 help 漂移、hook 契约变更、锚点位移）由「端口实现可替换 + 启动探针 + 能力声明」消化，不需要改内核。

**D2 入口：MCP 粗粒度单 tool + skill 渐进式**。Z1 实测 MCP tool 全量常驻注入——编排原语收敛为一个 `zsub` tool（五 action 枚举参数），description 压到 ~1.5KB（pi 的 5KB 太肥）；完整用法哲学（何时用 zsub vs 原生 background、task 自包含原则、禁止 poll）放 skill `zsub-orchestration`（Z7：一行索引渐进式，正文 100k 上限内按需读）。被否：多细粒度 tool（每 tool 一条常驻定义，token 成本线性涨）；纯 skill 无 MCP（LLM 拼 bash 命令易错，且丢 `_meta` 定向能力——Z3 只在 MCP 通道有）。

**D3 执行：RunnerPort 双实现**。
- **SpawnRunner（MVP 主力）**：`zcode --json --cwd --mode yolo --prompt` 单轮 + `--resume` 续聊（Z9，全部已验证）。每轮冷启动 ~1-2s，如实标注；running 不可投递（busy 语义）。
- **AppServerRunner（长线主路线，W2 交付 + 探针门控）**：manager 持一个 `app-server` 长驻子进程（隔离 HOME），subagent 会话在期内 create/subscribe/send/stop（Z11）。收益：零冷启动、per-session model/thoughtLevel/tools（D5 的 home-pool 在此模式整体消失）、实时进度、优雅取消；`session/fork` 为后续 fork 评估留口。风险（无文档协议、反向请求 handler、崩溃重启）由「启动探针（create 探针会话 + 立即 close）+ 失败自动降级 SpawnRunner + record 标记 runnerKind」消化。
- 会话句柄是不透明 `record.exec`（spawn: `{kind:'spawn', pid}`；apc: `{kind:'apc', sessionId}`），manager 不解读。

**D4 回流：NotifierPort 三档**。
- **MailboxNotifier（主通道）**：目标 sessionId 取自 `tools/call` `_meta["com.zcode/request-context"].session_id`（Z3，v2 的 hook + 活跃会话表机械整体删除）；投递遵守 Z8 硬规范——tmp+rename 原子落位、envelope 六字段写前自检、文件名单调前缀 `<epochMs>-<seq>-<id>.json`、启动清扫己方 `*.tmp` 残留。启用探测：server 进程 env 直接读 `ZCODE_MESSAGE_ENABLED`/`ZCODE_MAILBOX_ROOT`（Z10，server 继承引擎 env，即宿主真实值），未启用自动切 PollingNotifier 并在 start(bg) 返回 `notify:"polling"` + 指引。
- **PollingNotifier（兜底）**：不投递，返回轮询指引文本（「完成后经 list 查询」）。
- **TaskNotificationNotifier（预留，不实现）**：CLI 模式下任务经 Bash `run_in_background` 启动可获独立 turn 唤醒 + goal gate（Z4/Z6 语义）；接口签名留在 ports.js，实现等 CLI 增强通道立项。
- 通知文案承诺（P3 教训）：worktree 任务必须含 patchFile 路径 + `git apply` 指引；文本含 outputs 全文路径指针。

**D5 model 路由：ModelRouterPort 双实现**。解析链 `start.model > agent.md frontmatter.model > 默认（= ~/.zcode/v2/config.json 的当前主模型）`，模型清单从 v2 config provider 条目校验。spawn 模式：per-model 隔离 HOME 池 `~/.zcode/zsub/home-<modelShort>/`，config 写入 tmp+rename + per-model 互斥，仅在池创建/源 config mtime 变化时重写；apc 模式：`session/create` 的 model 参数，无需 HOME 池（单一隔离 HOME）。

**D6 agent 发现：四根扫描，project > user**。`<ws>/.agents/agents/` > `<ws>/.zcode/agents/` > `~/.agents/agents/` > `~/.zcode/agents/`，递归 `*.md`，自己 readdir + follow symlink（绕开引擎扫描的 symlink 跳过，解决 F5）。消费 frontmatter 子集：name/description/model/tools/disallowedTools/skills/maxTurns。

**D7 注入：prompt 拼装**。agent .md 正文（角色设定段）+ task + schema 契约段（MANDATORY 输出格式）+ skill 参考段，按固定顺序拼 `--prompt`；jsonout 三级容错提取。与 pi 差异（prompt 文本 vs 真 system prompt，权重略低）如实标注。

**D8 conversation**。spawn：`--resume <sessionId>`（record 存 sessionId）；apc：`session/send`（running 投递语义 W2 实测后定，探针失败按 busy 语义兜底）。

**D9 record store：jsonl event sourcing**。`~/.zcode/zsub/records.jsonl` append-only；server 重启重建内存索引；running 记录探活（spawn 查 pid；apc 查 session 状态），死进程标 `lost`。

**D10 防递归：双门禁**。`ZSUB_NESTED=1` 注入所有 subagent 进程 + server 收到嵌套调用直接拒绝；第二重：隔离 HOME 无 plugins 配置，subagent 进程不加载 zsub（物理隔断）。

**D11 并发池：默认 3 + 深度分层**。pi 为 6（P4）；zcode 每任务 = 完整 node 进程（spawn 模式），取 dynamic-workflow 已验证值 3；嵌套深度分层 `effective = max(1, 3 - depth)`（学 pi 防指数爆炸）。

**D12 worktree：域服务**。干净主树校验 → branch + worktree 创建 → 任务运行 → `git diff` 收集 patch 到 outputs（worktree 目录之外，防 cleanup 误删）→ 清理 + 孤儿 reaper。patchFile 进 record 与通知文案。

**D13 CLI 薄壳：`bin/zsub.js`**。同一 manager 的命令行壳（start/list/status/cancel/message/close/run），供人类调试与脚本化；`run` 子命令设计为可被 Bash `run_in_background` 包裹（stdout 尾部结构化摘要契约），是 TaskNotificationNotifier 的入口留位。

**D14 超时**：默认 `timeoutMs=600_000`，SIGTERM + 5s SIGKILL，record 标 `error:"timeout"` 并保留 stdout 尾部。

### 3.3 目标数据流（bg start，mailbox 主通道）

```
主 agent（GUI host，sessionId S）
  │ MCP tools/call: zsub(start, task, slug, model?, agent?, worktree?, wait=false)
  │   └ _meta["com.zcode/request-context"].session_id = S   ← Z3 定向依据
  ▼
zsub MCP server（长驻）
  ① 读 env：ZCODE_MESSAGE_ENABLED / ZCODE_MAILBOX_ROOT → 定 notifyMode   ← Z10
  ② AgentResolver 四根解析 agent .md（D6）
  ③ ModelRouter 解析+准备（D5）；RecordStore append start 事件（D9）
  ④ Runner.start：spawn zcode.cjs（HOME=home-<model>, ZSUB_NESTED=1）
  ⑤ wait=false → 立即返回 { subagentId, status:"running", notify:"mailbox" }
  ⑥ 完成回调：OutputStore 落 outputs/<id>.md（worktree 含 patchFile）
  ⑦ MailboxNotifier：tmp+rename 原子投 ~/.zcode/mailbox/<S>/unread/
  ▼
引擎 drain（主 agent 下次 UserPromptSubmit/PostToolUse/Stop）
  → <session-message source="mailbox"> 注入 → 主 agent 处理结果（G3 主档）
```

---

## 4. 验收

> 分两层：**无头 e2e（自动，CI 可跑）**与**真机 GUI 手册（用户执行，含截图判据）**。禁止用 mock 代替真进程。每场景回溯目标。

### 4.1 无头 e2e（自动）

| # | 场景 | 通过标准 | 回溯 |
|---|------|----------|------|
| H1 | sync start + 四根 resolver | 项目级 `.agents/agents/reviewer.md` 被命中；子进程 debug 日志含其正文（D6/D7 注入） | G1 G2 |
| H1b | user 级根命中 | `~/.agents/agents/` 下定义被命中 | G2 |
| H2 | model 路由 | 传/不传 model 两跑；两个 home 目录存在且 config.model.main 不同（D5） | G1 |
| H3 | bg + mailbox 投递 | record 终态后 `<S>/unread/` 有合法 envelope（六字段、单调文件名、无 tmp 残留）；无头两轮 resume 验证注入（对齐 v2 已跑通的无头 mailbox e2e） | G3 |
| H4 | conversation 续聊 | 两轮 sessionId 相同；第二轮回答含第一轮暗号 | G1 |
| H5 | cancel | record 标 cancelled；`ps` 无残留 zcode.cjs；SIGKILL 兜底 | G1 |
| H6 | 并发 | 3 并发上限 + 深度分层生效 | G1 |
| H7 | 崩溃恢复 | kill server → 重启 → record 重建 + 探活（活进程续管/死进程 lost） | G1 |
| H8 | worktree | 主树干净；patch 落 outputs；`git apply --check` 过；无孤儿 worktree | G4 |
| H9 | 防递归 | ZSUB_NESTED 嵌套拒绝记录或插件不可见，任一成立 | 稳定性 |
| H10 | notifier 降级 | 模拟未启用 env → `notify:"polling"` + 无 mailbox 写入 | G3 降档 |

### 4.2 真机 GUI 手册（用户执行，README 附步骤）

| # | 场景 | 通过标准 |
|---|------|----------|
| M1 | mailbox GUI 注入 | `launchctl setenv ZCODE_MESSAGE_ENABLED 1` + 重启后 bg start，主 agent 后续轮次上下文出现 `<session-message>`，模型主动转达结果 |
| M2 | 多窗口定向 | 双窗口不同项目，A start → 通知进 A（`_meta` 快照），不进 B |
| M3 | apc runner 真机 | 探针通过时 conversation 零冷启动；探针失败自动降级 spawn 且 record 标记 |

**实施期门（⛔ 探针未跑，均含降级）**：① GUI host mailbox drain（M1，降级 polling）；② `_meta` 会话上下文在插件 server 路径的实测（Z3 证据在 runtime 主路径，插件 MCP server 场景 W2 冒烟确认，降级：改读 `ZCODE_SESSION_ID` hook 或投全部活跃）；③ AppServerRunner 协议探针（create/close 往返 + 反向请求，失败降级 spawn）。

---

## 5. 下一层拆分

### 5.1 Wave 计划（subagent 并行开发）

| Wave | 任务 | 内容 | 依赖 |
|------|------|------|------|
| W0 | 骨架（主 agent 自做） | 清单/config/ports.js 契约/vendor jsonout+pool | - |
| W1 | S1 域层 / S2 执行层 / S3 通知层（3 并行） | resolver+prompt-builder+record-store+output-store / runner-spawn+model-router+防递归 / notifier-mailbox+降级 | W0 |
| W2 | S4 manager+MCP server / S5 worktree+reaper+CLI / S6 AppServerRunner（3 并行） | 编排内核与入口 / 隔离子系统 / apc 双实现 | W1 |
| W3 | e2e+skill+README | 无头 e2e 全量 + 修复 + 文档 | W2 |

### 5.2 文件地图

```
zsub/
├── .zcode-plugin/plugin.json        # 对齐 dynamic-workflow 格式（含 description_i18n）
├── .mcp.json                        # stdio server，${ZCODE_PLUGIN_ROOT}
├── bin/zsub.js                      # CLI 薄壳（D13）
├── dist/mcp/server.js               # MCP 入口：单 tool zsub 五 action + _meta 提取
├── lib/
│   ├── ports.js                     # 端口契约（JSDoc 接口 + registry + capabilities）
│   ├── config.js                    # 路径/env/常量（~/.zcode/zsub/ 根）
│   ├── driver.js                    # vendor 自 dynamic-workflow + --resume + HOME 池参数化
│   ├── jsonout.js / pool.js         # vendor（pool + 深度分层）
│   ├── agent-md-resolver.js         # 四根 + frontmatter（D6）
│   ├── prompt-builder.js            # 拼装（D7）
│   ├── record-store.js              # jsonl event sourcing（D9）
│   ├── output-store.js              # outputs/<id>.md + patch 落盘
│   ├── model-router.js              # 双实现（D5）
│   ├── runner-spawn.js / runner-appserver.js   # RunnerPort 双实现（D3）
│   ├── notifier-mailbox.js          # Mailbox + Polling（D4）
│   ├── worktree.js                  # 隔离 + patch + reaper（D12）
│   ├── manager.js                   # SubagentManager（用例编排，只依赖 ports）
│   └── reaper.js                    # 孤儿进程/worktree 清扫
├── skills/zsub-orchestration/SKILL.md  # 渐进式用法（分流指引：原生 vs zsub）
├── test/                            # 单测 + 无头 e2e（H1-H10）
└── README.md                        # 安装（plugins.dirs + launchctl）/验收手册
```

### 5.3 端口契约（ports.js 签名级，实现层遵守）

```js
// RunnerPort（决策位①）
//   probe() -> Promise<{ok:boolean, reason?:string}>
//   start(taskCtx) -> { exec, cancel(), done: Promise<RunResult> }   // exec 不透明句柄入 record
//   resume(exec, message, opts) -> Promise<RunResult>                 // conversation
//   alive(exec) -> boolean                                            // 探活
//   capabilities() -> { steering:'none'|'stdin'|'session-send', coldStartMs:number }
// NotifierPort（决策位②）
//   capabilities() -> { mode:'mailbox'|'polling', wakeIdle:boolean, requiresEnv?:string }
//   notifyCompletion(record, summaryText) -> Promise<{delivered:boolean, target?}>
// ModelRouterPort
//   resolve(requested?, agentDefault?) -> string modelRef（未知模型抛可操作错误）
//   prepareRunEnv(modelRef, runnerKind) -> { env?:object, createParams?:object }
// AgentResolverPort / RecordStorePort / WorktreePort：固定实现，接口化为可测。
```

registry：`ports.createRuntime({runnerKind, notifyMode, ...})` 按配置组装，manager 只面对接口。

---

## 附录：pi 功能复刻对照（v3 口径）

完全复刻：五 action、agent .md、cancel、list 状态树、close、worktree+patch、record 恢复、并发池、防递归、完成通知（mailbox 档）；近似：schema（prompt 契约）、model 路由（HOME 池/per-session）、tools 白名单（prompt 约束 + `--disallowed-tools`）、skills 注入、maxTurns（timeout 兜底）；弱化：message running 投递（spawn busy / apc 待测）；放弃：fork（apc 留探针）、thinkingLevel 路由（apc 下 per-session 可设，spawn 无通道）、TUI 视图、goal 联动（bash 通道预留）、idle 主动唤醒（外挂物理上限）。定位新增：与原生 background agent 的分流指引。
