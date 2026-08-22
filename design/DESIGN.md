# zsub — zcode 平台 subagent 管理插件设计文档

> **一句话结论**：以独立 MCP 插件 `zsub` 复刻 pi-subagent-workflow 的 subagent 生命周期管理（start/list/cancel/message/close 五 action + 后台运行 + worktree 隔离 + 完成通知），24 项功能中 10 项完全复刻、1 项为 zsub 新增增强（pi 无此能力）、7 项近似复刻、4 项因 zcode 闭源限制明确放弃、2 项不在本文范围；通知采用「Session Mailbox 文件直投」方案（无头链路已 e2e 验证，GUI host drain 为实施期门，附降级）。
>
> **修订记录**：v2（2026-08-23）按对抗式审查报告 `REVIEW.md` 修订——B6 hook 契约重写为 3.8.1 实测形态、D2 补投递语义/原子写规范/patchFile 承诺、G3 分档、D3 竞态防护、对照表 #3 重新归类。

**设计层级声明**：本文是「技术方案层」设计——下一层产物是可实施的里程碑计划（M1-M5）与代码任务。不跨层设计具体函数实现。

---

## 1. 背景目标

### SCQA

- **S（情境）**：用户在 pi 平台上有成熟的 subagent 编排扩展 `pi-subagent-workflow`（subagent 生命周期 + workflow 编排，~30k 行）；在 zcode 平台上已完成第一步移植——`dynamic-workflow` 插件（v0.2.0）用 5 个确定性 workflow 驱动无头 zcode session。
- **C（冲突）**：dynamic-workflow 只覆盖「workflow 编排」这一层；pi 侧的另一半——**单个 subagent 的生命周期管理**（后台启动/取消/续聊/文件隔离/完成通知）——zcode 平台完全没有对等物，且 zcode 闭源，插件只能以 MCP 外挂进程形态存在。
- **Q（问题）**：pi-subagent-workflow 的 subagent 功能有多少能复刻到 zcode？不可复刻的部分如何取舍？通知这个「MCP 无推送通道」的硬约束怎么破？
- **A（答案）**：建独立插件 `zsub`，以无头进程 + 隔离 HOME + Session Mailbox 三个已验证机制为地基，完整复刻五 action 生命周期；本文给出逐项可行性结论、方案对比与验收场景。

### 系统是什么（受众补课）

**pi-subagent-workflow**（参考系，源码 `~/Code/xyz-agent-workspace/main/extensions/subagent-workflow/`）：pi coding agent 的扩展，向 LLM 注册 `subagent` 工具（start/list/cancel/message/close 五 action）和 `workflow` 工具（run/abort）。subagent 以 `pi --mode rpc` 长驻子进程运行，支持后台执行、模型路由、worktree 文件隔离、schema 结构化输出、完成通知（appendMessage + triggerTurn 唤醒）。

**zcode**（目标平台）：Z.AI 的桌面 AI coding 应用（Electron，闭源，v3.8.1）。插件形态 = 本地目录 + `.zcode-plugin/plugin.json` 清单 + `.mcp.json` 声明 MCP server（stdio）。插件能获得的能力面：MCP tools（被动响应）、hooks（7 事件进程回调）、agent/skill/command 的 md 注册。**没有**插件 UI 扩展点、没有 sampling/createMessage（MCP server 无法主动发起 LLM 交互）。

**dynamic-workflow**（前序工作，`feat-zcode-workflow-plugin` worktree，commit c1443d6）：已移植 pi 的 5 个 workflow（chain/parallel/map-reduce/scatter-gather/review-fix-loop），沉淀了三项可复用基建：`driver.js`（无头 zcode 进程驱动 + 隔离 HOME）、`jsonout.js`（三级容错 JSON 提取）、`pool.js`（并发池）。

### 设计目标

| # | 目标 | 从使用者体验倒推 |
|---|------|------------------|
| G1 | 主 agent 可编程式管理 subagent 生命周期 | 在 zcode 主会话里，LLM 能 start（同步/后台）、list、cancel、message、close 一个 subagent，而不是只能一次性 `Agent` tool 调用 |
| G2 | 复用现有 agent .md 生态 | `~/.agents/agents/` 与项目 `.agents/agents/` 下已有的 agent 定义（frontmatter：model/tools/skills）直接可用，不重写 |
| G3 | 后台 subagent 完成后主动触达主 agent | **分两档**——主通道达成：`ZCODE_MESSAGE_ENABLED` 启用后，任务完成时结果**自动出现在主会话上下文**，无需人工提醒；降级达成：未启用时主 agent 按返回的轮询指引经 `list` 拿到终态结果（语义弱化为「结果可达」） |
| G4 | 文件改动隔离可选 | worktree=true 时 subagent 的文件改动落在独立 worktree，以 patch 回传，主树不被污染 |

### In / Out of Scope

**In**：subagent 五 action；agent .md 发现与解析；model 路由；后台 + mailbox 通知（含降级）；conversation 续聊；worktree 隔离；schema 近似输出；record store；防递归；并发池。

**Out**（本文明确不做，理由见 §3.3 决策）：
- workflow 编排（已在 dynamic-workflow 完成，zsub 不重复）
- thinkingLevel 路由（无 CLI 通道，D8）
- fork 上下文继承（D5）
- TUI/GUI 视图（zcode 无插件 UI 扩展点）
- goal 联动 / pending-notifications 等价层（zcode goal 私有）
- idle 主会话的主动唤醒（mailbox 被动 drain，G3 的已知边界）

---

## 2. 现状与问题分析

### 2.1 使用者视角的现状

今天 zcode 用户（主 agent）使用 subagent 只有两条路：

1. **GUI `@mention`**：输入框 `@demo-agent`，触发引擎内置 `Agent` tool 一次性子会话。同步阻塞、无后台、无续聊、无文件隔离、结果以 tool result 返回。
2. **agent .md 定义**：放 `~/.zcode/agents/`（用户级）或 `<ws>/.zcode/agents/`（项目级）。

真实失败模式（对齐 pi 用户已经解决过的痛点）：

- **F1 无法后台**：主 agent 调 `Agent` tool 必须等子会话跑完才能继续，长任务（全库审查 ~10min）期间主会话卡死。
- **F2 无法取消/查看**：跑错了不能 kill，没有 running 列表。
- **F3 无法续聊**：子会话一次性，追问必须从头重跑。
- **F4 无隔离**：子会话直接改主树文件，改坏了要靠 git 手工恢复。
- **F5 生态分裂**：pi 的 agent .md 在 `~/.agents/agents/`，zcode 只扫 `.zcode/agents/`——同一份定义要维护两处（且 zcode 扫描不识别 symlink 条目，实测验证，无法软链复用）。

### 2.2 平台事实基线（zcode 3.8.1 逆向结论，全部实测/源码锚点）

以下事实是本设计全部方案的地基，标注证据来源（`zcode.cjs@offset` 为 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` 内字符串偏移）：

| # | 事实 | 证据 |
|---|------|------|
| B1 | 无头 CLI：`zcode --json --cwd <dir> --mode <m> --prompt <text>` 单轮运行，stdout 输出 `{sessionId, response, usage, ...}` | driver.js 已在生产使用（dynamic-workflow v0.2.0） |
| B2 | `--resume <sessionId>` 真实可用（resume 持久化 session，上下文保留） | 实测：resume 不存在 id 报 `Session not found`；mailbox e2e 两轮 resume 上下文保留 |
| B3 | `--disallowed-tools` 可用；`--max-turns` / `--allowed-tools` / `--settings` **拒收**（help 漂移） | 实测：`Unknown option` 错误 |
| B4 | 无 `--model` / `--append-system-prompt` / `--skill` flag；模型由 `~/.zcode/cli/config.json`（即 `$HOME/.zcode/cli/config.json`）的 `model.main` 决定；`HOME` 可被 env 覆盖 → **隔离 HOME = 独立模型路由** | driver.js 机制 + T005 session 实测 |
| B5 | **Session Mailbox**：`ZCODE_MESSAGE_ENABLED=1` 启用后（gate `dYr` 定义 @11602483，port 消费点 @11766820），投递 JSON 文件到 mailbox 根 `<ZCODE_MAILBOX_ROOT 或 ~/.zcode/mailbox>/<toSessionId>/unread/`（envelope：`{version:1, messageId, fromSessionId, toSessionId, content, createdAt}`），引擎在 UserPromptSubmit/PostToolUse/Stop 时 drain（**只认 `.json` 后缀，按文件名字典序取前 20 条**，读后移入 `read/`），以 `<session-message source="mailbox">` 注入 LLM 上下文。**关键容错行为（对抗审查核出）**：drain 逐文件先 parse 再 rename，任一文件非法即中断本轮 drain，坏文件永久留在 unread/ 且**排序在其后的消息永远投不进**（无 quarantine） | `zcode.cjs@11067925`（adapter + envelope 校验）`@10358509`（drain hook，limit=20）`@11602483`（`dYr` 定义）`@11763070`（`ZCODE_MAILBOX_ROOT` 读取）；**无头全链路 e2e 已跑通**（投递→resume→模型原样复述内容） |
| B6 | hooks（**3.8.1 实测契约，v2 修订**）：hook 进程经 **stdin 收 JSON payload**（snake_case：`session_id`/`hook_event_name`/`tool_name`/`tool_input`/`tool_response`），env 设 `ZCODE_SESSION_ID`/`CLAUDE_SESSION_ID`/`ZCODE_PROJECT_DIR`；`transcript_path` 是用后即删的临时文件，不可依赖。7 事件（SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop）在代码中存在（枚举 @368446）。⚠️ **证据边界**：`~/.zcode/hooks/` 的 583 个 dump 全部是 3.0.0 旧版的 SessionStart 事件——「PostToolUse 在 3.8.1 GUI host 真实触发（尤其对 MCP tool 调用）」**无触发实证**，列为 DoR 门（见 §5） | zcode.cjs 全文 `ZCODE_HOOK_PAYLOAD` 0 命中（3.0.0 时代说法，3.8.1 已不存在）；hook payload 构造 @10339623 读出 snake_case 契约；583 dump 逐文件核对（全 SessionStart/3.0.0） |
| B7 | MCP client 无 sampling/createMessage；elicitation/roots/logging 存在但均非 LLM 注入通道 | zcode.cjs 全文核查（前轮对话） |
| B8 | 原生后台 Bash：`run_in_background: true` 完成后走引擎 `<task-notification>`（`backgroundSource:"bash"`）注入——无需任何环境变量 | `zcode.cjs@776399`（schema）`@7699452`（通知入队） |
| B9 | agent .md frontmatter 字段：name/description（必填）+ model/thoughtLevel/tools/disallowedTools/skills/maxTurns/permissionMode/memory/mcpServers 等 | `vct` 解析器 @10260805 |
| B10 | GUI host 进程（zcode-host-local-1）当前**未**启用 `ZCODE_MESSAGE_ENABLED`（launchctl 为空） | 实测 `launchctl getenv` 为空 |

### 2.3 现状物理数据流（无后台能力）

```
主 agent (GUI host, sessionId S)
   │ Agent tool call（同步阻塞）
   ▼
引擎内置子会话（同进程）
   │ 结果作为 tool result 返回
   ▼
主 agent 等待期间什么都不能做          ← F1
（无 list/cancel/通知/隔离通道）
```

### 2.4 根因分析

zcode 引擎的 subagent 能力是**宿主进程私有**的（与 pi 的 extension API 同构的特权层），MCP 外挂进程被隔离在协议边界外。pi-subagent-workflow 依赖的三样东西——`pi.appendMessage`、`triggerTurn` 唤醒、进程内 EventBus——zcode 插件一样都摸不到。**根因不是缺功能，是信任边界不同**：必须用「文件系统 + 子进程 + 无头 CLI」三个低特权原语，重新搭出等价语义。

---

## 3. 解决方案

### 3.1 终态（使用者视角）

安装 zsub 后，主 agent（GLM）在 zcode 主会话里获得一个 `subagent` MCP 工具。以下为真实交互样例（成功路径）：

```
用户：帮我把 src/ 下所有 TODO 注释整理成清单，顺便让一个后台 agent 审查
      login.ts 的安全性。

主 agent（并行两个 tool call）：
1. subagent(action="start", task="扫描 src/ 全部 TODO 注释，输出
   markdown 清单：文件:行号:内容", slug="todo-scan", wait=true)
   → [sync] 30s 后返回：
     { subagentId: "sa-a1b2", sessionId: "sess_...", status: "closed",
       result: "## TODO 清单\n- src/auth.ts:42: ...", tokens: 12300 }

2. subagent(action="start", task="安全审查 login.ts...", slug="sec-review",
   model="GLM-4.7-Flash", worktree=false, wait=false)
   → [bg] 立即返回：
     { subagentId: "sa-c3d4", status: "running",
       notify: "mailbox", note: "完成后将自动通知；也可随时 list 查询" }

主 agent：（把 todo 清单交给用户，继续别的对话）

—— 后台 sec-review 完成，引擎在下一个 PostToolUse drain mailbox ——
<session-message source="mailbox" message_id="msg-..." from_session="sess_...">
[subagent 完成] slug=sec-review。结果：发现 2 个中危问题（SQL 拼接、
明文 cookie）...完整报告: ~/.zcode/zsub/outputs/sa-c3d4.md
</session-message>

主 agent：（向用户转达审查结果）
```

失败路径与恢复指引：

| 失败 | 表现 | 恢复 |
|------|------|------|
| model 未配置 | start 抛错：`未知模型 X。可用: GLM-5.3, GLM-4.7-Flash...` | 按错误里列出的清单重传 model |
| mailbox 未启用（B10） | start(bg) 返回 `notify: "polling"` + 提示文本 | 主 agent 按约定每轮调 `list`；或用户 `launchctl setenv ZCODE_MESSAGE_ENABLED 1` 重启 ZCode 后恢复 mailbox 模式 |
| 无头进程超时 | record 标 `error: timeout`，结果文件含已完成部分 stdout | 调大 `timeoutMs` 重跑；或拆小 task |
| message 投给 running subagent | 返回 `busy：该 subagent 正在运行，仅 idle（轮次完成）状态可投递` | 先 `list` 等 idle，或 `wait` 参数阻塞至完成 |
| worktree 非干净主树 | start 抛错：主树 dirty，worktree 基线不可靠 | 用户先 commit/stash，或改 `worktree:false` |

### 3.2 方案对比

#### 方案 A（推荐）：独立插件 zsub，MCP 单工具五 action

新建插件目录 `zsub/`，结构对齐 dynamic-workflow（`.zcode-plugin/plugin.json` + `.mcp.json` + `dist/mcp/server.js`），vendor 复用 driver/jsonout/pool 三件基建。

- **长期架构合理性**：高。与 pi 侧「subagent 层 / workflow 层」分层一致；dynamic-workflow 未来可把阶段执行切到 zsub 的 lib 上（重构自由度）；两插件独立演进版本。
- **短期实现成本**：中。driver.js vendor 升级（+resume）约 1 天；其余为新代码（M1-M5 详见 §5）。
- **风险**：用户需在 config.json 注册第二个插件目录（一次性）；两份 driver 副本短暂分叉（M5 后可谈统一）。

#### 方案 B：并入 dynamic-workflow，作为第二个 MCP tool

在现有插件里加 `subagent` tool，server 分发。

- **长期**：中。与 pi「一个包两个 tool」结构对齐；但 dynamic-workflow 定位是编排，混入生命周期管理后职责膨胀；未来想单独复用 subagent 层必须再拆。
- **短期**：低。共享 lib 零成本，安装零变更。
- **风险**：已有插件的回归面扩大（0.2.0 已稳定运行）；单 server 进程崩溃影响两 tool。
- **若选 B**：§3.1 交互样例不变，仅 tool 名变为 `mcp__dynamic-workflow__subagent`。

#### 方案 C：纯 agent .md 增强，不写 MCP

只往 `.zcode/agents/` 投放定义，靠引擎原生 `Agent` tool。

- **长期**：低。受制于闭源引擎能力面（无后台/取消/续聊，B7），F1-F4 一个都解决不了。
- **短期**：极低（只是写 md）。
- **若选 C**：§2.1 的失败模式全部维持原状。**不解决根本问题，排除。**

**推荐 A**。理由：用户已开独立 worktree（`feat-zcode-subagent-plugin`，明确信号）；分层对齐 pi 生态；vendor 成本一次性且可控。方案 B 作为「若最终嫌两插件麻烦」的合并退路，M1-M5 的 lib 结构与 B 兼容（server.js 只是薄入口）。

### 3.3 关键决策与权衡

**D1 进程模型：无头单轮进程 + `--resume` 续聊**（对齐 pi 的 spawn 模型）
- 被否：`app-server` 长连接（help 里的 `zcode app-server` 是 stdio 双向协议，可能支持长驻会话——但完全无文档、协议 schema 未逆向，赌博成分高）。
- 证据：B1/B2；pi 侧 session-runner.ts:650 同为 spawn 模型。
- 探针：✅ 已测（driver.js 生产 + resume e2e）。
- 代价：conversation 每轮重启进程（~1-2s 模块加载），密集续聊场景累积开销。文档中如实标注，引导主 agent 用「一次性大 task」为主。

**D2 通知：Session Mailbox 文件直投**（G3 主通道）
- 被否 ①：原生后台 Bash 通知（B8）——依赖主 agent 配合执行 watcher 命令（LLM 行为不可控）+ 通知文本由引擎拼装（可控性弱）。保留为 fallback 文档建议。
- 被否 ②：MCP 推送（B7 不存在）。
- **投递语义（多会话/时序，v2 补）**：不采用单值 last-session 文件——hook 在 tool call 完成后才触发，start 调用中读到的是旧值，且多窗口并发时互相覆盖会错投。改为 hook 维护「**近期活跃会话表**」`~/.zcode/zsub/active-sessions.json`（N≤8 个 `{sessionId, projectDir, lastSeen}`，原子写 tmp+rename，损坏时丢弃重写）；server 在 start(bg) 时刻快照「与当前 cwd 匹配的最近活跃会话」存入 record，完成时投给该会话；无匹配（如会话首个 tool call 即 start）时投给全部活跃会话并标注。错投后果有限：通知仅含结果摘要与 outputs 路径，非敏感数据。
- **原子写硬规范（v2 补，对抗审查 MUST_FIX-2）**：引擎 drain 遇坏 envelope 会中断且坏文件永久阻塞后续消息（B5）。因此投递必须：①写 `*.tmp` 后 `rename` 原子落位；②envelope 六字段写前自检（全 string + version===1）；③msg 文件名用单调前缀 `<epochMs>-<seq>-<id>.json` 保证字典序=时间序（drain 取前 20 条的顺序语义）；④ server 启动时扫描 unread/ 中己方残留的 `*.tmp` 并清除。
- **通知文案承诺**（v2 补，吸取 pi [MF#1] 教训）：worktree=true 的完成通知必须含 `patchFile 路径 + git apply 指引`，否则隔离改动会静默丢失（pi 曾踩过此坑）。
- **hook 契约（v2 修正，B6 重写后）**：PostToolUse hook 脚本从 stdin JSON 取 `session_id`（兑底 `$ZCODE_SESSION_ID` env）写活跃会话表；matcher 语法与触发范围（尤其对 MCP tool 调用是否触发）为 DoR 门，未验证前不假设。
- 前提：GUI host 启用 `ZCODE_MESSAGE_ENABLED=1`（B10 当前未启用——插件 README 给一键配置命令 `launchctl setenv` + 重启；manager 启动时探测，未启用则降级）。若 host 设了 `ZCODE_MAILBOX_ROOT`，默认投递路径会失效——DoR 端到端探测天然覆盖（探测失败即发现）。
- 探针：✅ 已测（无头 mailbox e2e 全链路）；GUI host 侧 drain 行为 + PostToolUse 触发 ⛔ M2 实施期门（无头与 GUI 共用同一 gate `dYr`，代码层无旁路，但需真机确认；门失败时降级 A4 polling，G3 降档为「结果可达」）。
- 已知边界：主会话 idle 时消息躺在信箱，直到用户下次交互/主 agent 下次活动才注入（对比 pi triggerTurn 无主动唤醒）——G3 验收场景按此边界设计。

**D3 model 路由：per-model 隔离 HOME 池**
- `~/.zcode/zsub/home-<modelShort>/` 目录池，每个池内 `cli/config.json` 写 `model.main = <providerId>/<model>`（B4）。
- 被否：单 HOME 每次调用重写 config——并发场景下 A 任务写 GLM-5.3、B 任务写 Flash 会互相踩（竞态）。
- **同 model 并发防护（v2 补，对抗审查 S-5）**：per-model 池内 config 写入同样需 tmp+rename 原子写 + 进程内 per-model 互斥锁；进一步降频：仅在池目录首次创建或 apiKey 引用变更（源 v2 config mtime 变化）时重写，其余情况复用——生产先例（driver.js）为每个 workflow 入口写一次，从不并发重写，zsub 的 per-start 写入是新模式，需此防护。
- 解析顺序对齐 pi：`start.model 参数 > agent.md frontmatter.model > 主模型默认（= v2 config 的 model.main）`。模型清单从 `~/.zcode/v2/config.json` provider 条目读取并校验。
- 探针：✅ 已测（driver.js 的 resolveModelRef 同款机制生产在用）。
- 边界：M1 仅支持 driver 已验证的 `builtin:bigmodel-coding-plan` provider；多 provider（M4）读 v2 config 全量 provider 列表。

**D4 conversation：`--resume` 语义等价实现**
- message(action) = 读 record 的 sessionId → spawn `--resume <id> --prompt <text>` → 进程退出即本轮完成，record 回 idle。
- 探针：✅ 已测（B2 + mailbox e2e 两轮 resume）。
- 与 pi 差异（如实声明）：pi 是长驻进程 idle 续聊（零启动开销 + 可 steer）；zsub 每轮冷启动。且 **running 状态不可投递**（stdin 不通）——message 对 running 返回 busy（§3.1 失败表）。

**D5 fork：放弃**
- zcode 无 `--fork`；`--resume` 是续写**同一** session，会污染父会话历史。pi 文档自身也承认 fork 是低频需求（"most tasks a plain prompt can describe do NOT need fork"）。替代：task 自包含原则（主 agent 在 task 里内联必要上下文）。

**D6 注入面收缩：systemPrompt/schema/skill 全部拼进 `--prompt`**
- zcode 无 `--append-system-prompt`/`--skill` flag（B3/B4）。agent .md 正文作为「角色设定」段落、schema 指令作为「MANDATORY 输出契约」段落、skill 内容作为「参考技能」段落，按固定顺序拼装后经 `--prompt` 传入。
- 与 pi 差异：pi 是真正的 system prompt 注入（模型权重更高）；zsub 是 prompt 文本（权重略低）。jsonout 三级容错提取（T009 已验证）兜底 schema。
- 探针：✅ 已测（T009 的 review-fix-loop 即此模式，5/5 workflow 真实跑通）。

**D7 agent .md 发现：四根扫描，project > user**
- 优先级：`<ws>/.agents/agents/` > `<ws>/.zcode/agents/` > `~/.agents/agents/` > `~/.zcode/agents/`（对齐 pi 的 project>user 精神 + zcode 双根现实，解决 F5）。
- 只扫 `*.md`（递归），不依赖 zcode 引擎扫描规则（绕开其 symlink 跳过限制——自己 readdir 自己 follow）。
- frontmatter 消费字段：name/description/model/tools/disallowedTools/skills/maxTurns（B9 中与我们执行层相关的子集；thoughtLevel 因 D8 不消费）。

**D8 thinkingLevel：放弃对齐**
- 无 CLI flag、无 config key（前轮源码核查：`local_setting.reasoning_level` 是会话级运行时 API 非配置）。残路：v2 config provider models 条目里的 `reasoning.defaultLevel`（模型目录可带默认档位）——不做成路由功能，文档记录即可。

**D9 maxTurns：timeout 兜底**
- `--max-turns` 拒收（B3）。默认 `timeoutMs=600_000`（10min，对齐 driver.js），SIGTERM + 5s SIGKILL。超时 record 标 `error:"timeout"` 并保留已完成 stdout 尾部供诊断。

**D10 防递归：双重门禁**
- env `ZSUB_NESTED=1` 注入所有 subagent 进程；zsub server 收到 tool call 时检查自身 env，嵌套环境直接拒绝（对齐 dynamic-workflow 的 DWF_NESTED）。第二重：subagent 的隔离 HOME 无 plugins 配置（继承 driver.js 设计），引擎不加载 zsub，物理上无法递归。

**D11 record store：jsonl event sourcing**（对齐 pi record-store 模式）
- `~/.zcode/zsub/records.jsonl` append-only；record 字段对齐 pi `SubagentToolDetails` 子集（subagentId/slug/agent/model/status/closedReason/sessionId/worktree/patchFile/tokens/startedAt/endedAt/error）。MCP server 重启后从 jsonl 重建内存索引（running 记录探活：进程在则续管，不在则标 lost——对齐 pi 的冷路径 resume 判定）。

**D12 并发池：默认 3**（pi 为 6；zcode 每任务 = 完整 node 进程 + 引擎冷启动，更重，取 dynamic-workflow 已验证值）。

### 3.4 目标物理数据流

```
┌─ 主 agent（GUI host 进程，sessionId S，真实 HOME）────────────┐
│  ① tools/call: subagent(start, task, slug, model, wait=false) │
└──────────────┬────────────────────────────────────────────────┘
               ▼ (stdio JSON-RPC)
┌─ zsub MCP server（长驻，manager）──────────────────────────────┐
│  ② 读 ~/.zcode/zsub/active-sessions.json ← hook 维护的活跃会话表 │
│    （快照 start 时刻与 cwd 匹配的最近会话 → 存入 record，D2）      │
│  ③ resolver：四根扫 agent .md → profile（D7）                   │
│  ④ home-pool：~/.zcode/zsub/home-<model>/config.json（D3，原子写）│
│  ⑤ prompt-builder：角色设定+任务+schema 契约 拼装（D6）          │
│  ⑥ process-pool（≤3 并发, D12）：                                │
│     spawn node zcode.cjs --json --cwd <ws|worktree>             │
│        --mode yolo --prompt <拼装> [--resume <sid>]              │
│     env: HOME=home-<model>, ZSUB_NESTED=1（D10）                 │
│  ⑦ record → ~/.zcode/zsub/records.jsonl（D11）                  │
│  ⑧ wait=false → 立即返回 {subagentId, status:running}           │
└──────┬─────────────────────────────────────────────────────────┘
       │ (子进程异步跑完 close)
       ▼
┌─ 完成通知（D2）─────────────────────────────────────────────────┐
│  ⑨ watcher：record 终态 + 结果落 outputs/<id>.md                 │
│     （worktree 任务含 patchFile 路径，进通知文案）                 │
│  ⑩ 原子投递 mailbox 根/unread/<epochMs>-<seq>-<id>.json           │
│     （tmp+rename；envelope 写前自检；投给 record 快照的目标会话）  │
└──────┬─────────────────────────────────────────────────────────┘
       ▼
┌─ 引擎（GUI host）───────────────────────────────────────────────┐
│  ⑪ 主 agent 下一次任意 tool 调用 → PostToolUse drain mailbox     │
│  ⑫ <session-message> 注入 LLM 上下文 → 主 agent 转达用户（G3）    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. 验收

> 验收环境：真实 ZCode.app GUI 主会话（模型 GLM-5.2/5.3）+ zsub 插件已安装（`~/.zcode/cli/config.json` plugins.dirs + `.mcp.json`）。禁止用 mock/单测代替。每个场景标注回溯目标。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|----------|------|
| A1 | 同步 start + agent .md 复用（项目级根） | 往测试项目 `.agents/agents/` 放 `reviewer.md`（frontmatter: name/description/tools 只读）；主会话让 LLM 调 `subagent(start, agent=reviewer, task="审查 README.md", wait=true)` | 返回结构化结果；`~/.zcode/zsub/records.jsonl` 有该 record（agent=reviewer）；子进程的 debug 日志证实 prompt 含 reviewer.md 正文（D6 注入） | G1 G2 |
| A1b | agent .md 复用（user 级根，v2 补） | 不放项目级，仅用已有的 `~/.agents/agents/` 下某 agent 定义，重复 A1 调用 | 同 A1 通过标准（四根优先级中 user 级可命中） | G2 |
| A2 | model 路由 | 同上但 `model="GLM-4.7-Flash"`；另跑一次不传 model | record.model 分别为 `GLM-4.7-Flash` 与默认模型；两个 home 目录各自存在且 config.json 的 model.main 不同（D3） | G1 |
| A3 | 后台 + mailbox 通知（G3 主通道档） | `launchctl setenv ZCODE_MESSAGE_ENABLED 1` + 重启 ZCode；`start(wait=false, slug="bg-test")`；主 agent 立即去做另一件 2-3 轮的事 | start 立即返回 running；主 agent 在**后续轮次上下文**中出现 `<session-message>`（GUI 里肉眼可见模型主动提及 bg-test 完成）；`mailbox/<S>/read/` 有已消费文件且文件名为单调前缀 | G3-主档 |
| A3b | 多窗口通知归属（v2 补） | 两个 GUI 窗口分别开不同项目会话；窗口 A `start(bg, slug="who-am-i")`；窗口 B 随后做 1-2 次 tool 调用；等完成 | 通知出现在 A 的会话（record 快照的目标），不投给 B；若 A 是首个 tool call 无快照，投给全部活跃会话且文案可辨认归属 | G3-主档（边界） |
| A4 | 通知降级（G3 降级档） | 关闭环境变量重启；同样 start(wait=false) | 返回 `notify:"polling"` + 轮询指引文本；主 agent 按 `list` 能拿到终态结果；全程无 mailbox 写入 | G3-降档 |
| A5 | conversation 续聊 + busy 分支 | ①`start(conversation=true, task="记住暗号 X")` 等完成 → `message(text="暗号是什么？")`；②另跑一个 bg 长任务，完成前立即 `message` | ①第二轮回复含 X；两轮 record 的 sessionId 相同（--resume 生效）；close 后 record 终态 closed。②返回 busy 提示文本（running 不可投递，D4）且进程不被干扰 | G1 |
| A6 | cancel | start 一个 60s 长任务 wait=false → 立即 `cancel(subagentId)` | record 标 `cancelled`；`ps` 无残留 zcode.cjs 进程（SIGKILL 兜底验证）；list 不再显示 running | G1 |
| A7 | 并发 | 同时 start 2 个 bg + 1 个 sync | 3 record 并存；sync 正常返回；list 显示 2 running；总并发不超 3（D12） | G1 |
| A8 | worktree 隔离 + patch 通知 | 干净主树；`start(worktree=true, task="在 src/ 新增 hello.ts")` 等完成 | 主树 `git status` 干净（无 hello.ts）；patch 文件存在于 outputs/；`git apply --check` 通过；worktree 分支被清理（无孤儿）；**mailbox 通知文本含 patchFile 路径与 apply 指引**（D2 承诺） | G4 |
| A9 | 防递归 | 诱导 subagent task 里写「调用 zsub 的 subagent 工具再启动一个子任务」 | 子进程内 zsub 不可达——debug 日志含 ZSUB_NESTED 拒绝记录，或 zsub 工具完全不可见（插件未加载）；记录实际命中的是哪种，任一成立即可；主流程不崩 | G1（稳定性） |

**验收前置检查（DoR，v2 扩充）**：A3/A3b 依赖若干部未真机验证的平台行为，实施第一步先跑下列探针（1-3 项失败各有降级动作，第 4 项为已知语义固化）：
1. **GUI 真机 mailbox drain**：`ZCODE_MESSAGE_ENABLED=1` + 重启后向 GUI 会话投递探测消息，确认 drain——失败则 A3/A3b 改用 A4 降级语义验收并升级为已知问题；
2. **PostToolUse hook 触发实证**（B6 证据边界）：注册最小 hook（stdin 读 `session_id` 写文件），在 GUI 会话里做几次 tool 调用（含 MCP tool），确认触发与 payload 形态——失败则活跃会话表机制不可用，通知退化为「投给全部已知会话 + 轮询」双通道；
3. **matcher 语法**：确认 3.8.1 的 matcher 写法（能否收窄到高频只读工具子集，降低每次 tool 调用 spawn hook 进程的开销）；
4. **mailbox 坏文件行为用例**：探测脚本故意投一个坏 envelope → 确认引擎 drain 静默阻塞的已知语义，固化到 M2 测试。

---

## 5. 下一层拆分

### 里程碑

| 里程碑 | 内容 | 验收覆盖 | justification |
|--------|------|----------|---------------|
| M1 最小闭环 | 插件骨架 + 四根 resolver + prompt-builder + home-pool + sync start + 基础 record | A1 A2 | 先证明「定义复用 + 模型路由 + 注入」三地基成立，最大风险（D6 注入效果）最早暴露 |
| M2 生命周期 + 通知 | record store 完整版 + bg start + cancel + list + PostToolUse hook（活跃会话表，契约按 B6）+ mailbox 原子投递 + host 探测降级 + DoR 四探针 | A3 A3b A4 A6 A7 | 通知是第二高风险（GUI 真机 drain + hook 触发实证），尽早跑通；cancel/list 与 bg 同批才有意义 |
| M3 conversation | --resume 接线 + message/close action + idle 投递语义 | A5 | 依赖 M1 的 sessionId record，独立可验收 |
| M4 worktree + 多 provider | worktree-manager 移植（含孤儿 reaper）+ patch 回传 + v2 config 全 provider 支持 | A8 | worktree 独立子系统，放后不阻塞主线 |
| M5 加固 | 防递归双门禁 + 进程泄漏 reaper（server 崩溃后孤儿进程清理）+ e2e 回归 + README | A9 + 全量回归 | 防递归与收尾 |

### 文件改动地图

```
zsub/
├── .zcode-plugin/plugin.json        # 清单（对齐 dynamic-workflow 格式）
├── .mcp.json                        # MCP server 声明（stdio, ${ZCODE_PLUGIN_ROOT}）
├── bin/zsub.js                      # 安装/自检 CLI（可选）
├── dist/mcp/server.js               # MCP 入口：subagent tool（五 action 分发）
├── lib/
│   ├── driver.js                    # vendor 自 dynamic-workflow，+ --resume 支持
│   ├── agent-md-resolver.js         # 四根扫描 + frontmatter（D7）
│   ├── home-pool.js                 # per-model HOME（D3）
│   ├── prompt-builder.js            # 角色/任务/schema 拼装（D6）
│   ├── record-store.js              # jsonl event sourcing（D11）
│   ├── process-pool.js              # spawn/kill/timeout/并发（D1 D9 D12）
│   ├── notify.js                    # mailbox 原子投递 + host 探测降级 + 活跃会话表消费（D2）
│   └── worktree.js                  # M4
├── hooks/zsub-session-hook.sh       # PostToolUse：stdin JSON 取 session_id → 原子写活跃会话表（B6 契约）
├── test/                            # e2e 脚本（对齐 A1-A9 + A1b/A3b）
└── README.md
```

安装面（一次性，写入 README）：`~/.zcode/cli/config.json` 的 `plugins.dirs` 追加 zsub 路径 + hooks 块注册 PostToolUse（ZCode 格式，enabled:true）+ 可选 `launchctl setenv ZCODE_MESSAGE_ENABLED 1`。

### 待验证检查点（实施期门，⛔ 探针未跑，均含降级路径）

1. **GUI 真机 mailbox drain**（A3 前置）：launchctl 开关 + GUI 会话投递探测——无头已验证，GUI host 未验证。降级：A4 polling。
2. **PostToolUse hook 触发实证**（A3b 前置，B6 证据边界）：3.8.1 GUI host 下真实触发（含 MCP tool 调用）+ matcher 语法。降级：投给全部已知会话 + 轮询双通道。
3. **MCP tool 在主 agent 上下文中的实际名字**（`mcp__zsub__subagent` 还是短名）：影响 hook matcher 与提示词，M2 实测确认。
4. **`--disallowed-tools` 对 MCP 工具的覆盖语义**：subagent 进程隔离 HOME 不加载插件理论已隔断（D10 第二重），但 flag 对内置工具的实际拦截范围需 M1 冒烟确认。

---

## 附录：pi-subagent-workflow 功能复刻对照总表

| # | pi 功能 | 结论 | 落地方式 / 放弃理由 |
|---|---------|------|---------------------|
| 1 | subagent 五 action | ✅ 完全 | MCP tool 同构分发 |
| 2 | agent .md（frontmatter） | ✅ 完全 | D7 四根 resolver（thoughtLevel 除外） |
| 3 | sync start | ➕ zsub 增强 | pi 为 background-only（无 wait 参数，明示 no poll action）；zsub 的 wait=true 是新增能力，非复刻 |
| 4 | cancel | ✅ 完全 | SIGTERM+SIGKILL |
| 5 | list 状态树 | ✅ 完全 | record store |
| 6 | conversation 续聊 | ✅ 完全（进程级） | --resume；每轮冷启动（D4） |
| 7 | close | ✅ 完全 | record 终态 + worktree 清理 |
| 8 | worktree 隔离 + patch | ✅ 完全 | M4 移植（git 层与宿主无关） |
| 9 | record store 恢复 | ✅ 完全 | jsonl 重建 + 探活（D11） |
| 10 | 并发池 | ✅ 完全 | 默认 3（D12） |
| 11 | 防递归 | ✅ 完全 | 双门禁（D10） |
| 12 | schema 结构化输出 | 🟡 近似 | prompt 契约 + jsonout 提取（D6） |
| 13 | model 路由 | 🟡 近似 | HOME 池（D3）；无逐 call 原生 flag |
| 14 | tools 白名单 | 🟡 近似 | frontmatter tools → prompt 约束 + `--disallowed-tools` 反向表达 |
| 15 | 完成通知 | 🟡 近似 | mailbox 轮中注入优于 pi 的 turn 边界；但无 idle 主动唤醒（D2） |
| 16 | message running 投递 | 🟡 弱化 | 仅 idle 可投（D4 busy 语义） |
| 17 | skills 注入 | 🟡 近似 | SKILL.md 内容拼 prompt（D6） |
| 18 | maxTurns 熔断 | 🟡 弱化 | timeout 兜底（D9） |
| 19 | fork 上下文继承 | ❌ 放弃 | 污染父 session（D5） |
| 20 | thinkingLevel 路由 | ❌ 放弃 | 无通道（D8） |
| 21 | TUI 视图 | ❌ 放弃 | 平台无插件 UI 扩展点 |
| 22 | goal 联动 / pending 层 | ❌ 放弃 | zcode goal 私有 |
| 23 | workflow 编排 | ➖ 不在本文 | dynamic-workflow v0.2.0 已完成 |
| 24 | workflow-script 临时脚本 | ➖ 后期可选 | 模式可移植，M5 后评估 |

统计：✅ 10 项 / ➕ 1 项（zsub 增强）/ 🟡 7 项 / ❌ 4 项 / ➖ 2 项（合计 24）。

> ➖ 中 #23（workflow 编排）已在 dynamic-workflow v0.2.0 完成——若计入已交付能力，则「pi→zcode 生态整体」的完全复刻为 11 项。
