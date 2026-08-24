# zsw v1.0 daemon 化设计：socket 控制面 + CLI thin client，统一 push 唤醒

> **一句话结论**：把 zsw 的 MCP server 从「daemon 职责 + 工具暴露」的耦合体改造成 **zero-tool daemon（引擎托管生命周期）+ unix socket 控制面 + CLI thin client**，agent 交互面全收敛到 Bash 工具——等待场景借引擎原生 background bash 通知获得 idle push 唤醒，同时消除两个 MCP tool 定义（name+description+inputSchema 全量注入，实测约 5.5KB，其中 description 约 2.0KB）的常驻上下文注入。

## 开篇（SCQA）

- **S（情境）**：zsw（z-subagent-workflow）是 zcode 插件，编排后台 subagent 与多阶段 workflow。后台任务的执行体（runner 子进程、appserver 长连接、并发槽位池）必须挂在常驻进程下——这个常驻进程现在是 MCP server。
- **C（冲突）**：引擎逆向实证，zcode 引擎对外部进程没有 push 通道（MCP client 只处理 `notifications/cancelled` 和 `notifications/progress`，sampling/tasks 协议面是 SDK 死代码）；mailbox 文件通道只在三个 hook 时机惰性注入，**idle 会话无法被外部进程唤醒**。结果：mailbox 档未启用时（当前用户环境实测 `ZCODE_MESSAGE_ENABLED` 未设置），agent 拿到 start 返回的轮询指引后只能发明 `sleep N → status → sleep…` 循环；即使启用 mailbox 档，「结束 turn 纯等通知」也不可靠。同时两个 tool 定义按引擎注入语义**全量**常驻每个会话的系统提示词（name+description+inputSchema 合计约 5.5KB，实测 zsub 3.1KB + zflow 2.6KB）。
- **Q（问题）**：如何让 zsw 后台任务完成时**可靠唤醒任意状态的会话**（含 idle），同时降低常驻上下文成本、不丢 daemon 才有的能力（异步启动、conversation 续聊、并发限流）？
- **A（答案）**：职责分离——daemon 与 agent 交互面解耦。MCP server 进程保留（白嫖引擎的 spawn/kill 生命周期管理）但 `tools/list` 恒返回空（零上下文注入），新增 unix socket 控制面；CLI 从「独立执行体」改为 daemon 的 thin client；agent 用 Bash 工具调 CLI，等待场景用 `run_in_background=true` 让 CLI 阻塞进程成为引擎进程内 background task——**完成即触发原生 `<task-notification>`，经引擎 `executeTurnCommand` 直接开新 turn，idle 会话被唤醒**。

---

## 1. 背景：被设计的系统是什么

**本章结论**：zsw 的价值在「常驻 daemon 持有执行体」+「四根 agent 发现/worktree 隔离/schema 契约」这些引擎原生原语给不了的能力；本次设计只改「能力暴露面与通知回流」，不动编排内核。

zsw 插件（目录 `z-subagent-workflow/`，npm 包 `@zhushanwen/z-subagent-workflow`）为 zcode 提供后台 subagent 编排：

- **subagent 面（zsub）**：start（后台 spawn 无头 zcode 跑任务书）/ status / list / cancel / close / message（conversation 任务续聊）/ agents（四根发现）/ models（模型路由）八个 action；
- **workflow 面（zflow）**：chain / parallel / map-reduce / scatter-gather / review-fix-loop 五种多阶段管线 + 自定义脚本，run / abort / status / list / scripts / lint 六个管理 action；
- **执行体**：runner 子进程（spawn 无头 zcode）由常驻 MCP server 进程持有；并发由进程内 FIFO 槽位池限流（`lib/slots.js`，深度分层防递归爆炸）；任务 record append-only 落盘 `~/.zcode/zsw/records.jsonl`，结果全文落 `~/.zcode/zsw/outputs/<id>.md`；
- **当前双入口**：MCP tools（zsub/zflow，异步启动 + 完成通知）与 CLI（`bin/zsw.js`，一次性进程**自己**组装 manager 跑任务、强制阻塞到完成——是独立执行体，不是 daemon 的客户端）。

受众假设：读者会用 zsub/zflow 工具，但不知道引擎通知机制的内部分工。两个关键术语先锚定：

> **执行体（exec）** = 真正跑任务的 runner 子进程/长连接。谁 spawn 它，谁进程死它就死。就是现状里 MCP server 持有、CLI 进程退出就丢的那个东西。
>
> **push 唤醒** = 任务完成时引擎**主动**为发起会话开新 turn 注入通知。引擎里只有一类输入有此权限：引擎自己 spawn 的进程内 background task（Bash/Agent/Workflow 工具的 `run_in_background`）完成时的事件回调。文件通道（mailbox）没有。

## 2. 设计目标

**本章结论**：四个目标——唤醒可靠性、上下文经济学、能力无损、生命周期健壮。

1. **G1（push 唤醒）**：agent 派发 zsw 后台任务并结束 turn，任务完成时会话被自动唤醒并拿到结果路径——不依赖 `ZCODE_MESSAGE_ENABLED`，不需要 agent 发明 sleep 轮询。
2. **G2（上下文经济学）**：zsub/zflow 两个 tool 定义（约 5.5KB 全量注入）从每个会话的系统提示词中消失；agent 学用法改为按需加载（skill / CLI `--help`）。
3. **G3（能力无损）**：异步启动（start 立即回 id）、conversation 续聊、并发限流（默认 maxConcurrent=3 + 深度分层）、worktree 隔离、schema 契约——daemon 才有的能力全部保留，CLI 入口全部可达。**如实声明一处语义变更**：并发限流的定义域从「每会话」（现状每会话一个 MCP server 实例 = 每会话独立槽位池，多会话并发上限 = 3 × 会话数）变为「全局单 daemon = 全局 3」——重度多会话用户的总并发收紧；换来全局上限可控与 record/槽位语义统一。`ZSW_MAX_CONCURRENT` env 覆盖（既有 env 覆盖模式）提供给需要的用户。
4. **G4（生命周期健壮）**：daemon 死亡（会话关闭）不产生静默僵尸：任务 record 状态可查、可接管、可重发；CLI 对 daemon 不在场给出可操作错误。

**In-scope**：daemon 化改造（socket 控制面、CLI thin client、wait 命令、tools 摘除开关与节奏、指引层更新）。
**Out-of-scope**：编排内核改造（runner/pool/worktree/record 逻辑不动）；mailbox 机制代码保留但降级为 legacy（不再作为主通知路径）；给 zcode 引擎提 MCP tasks push 的 feature request（另行跟进，不在本设计内）；本设计不含 description 文案 bug 的单独修复（`pollingGuidance` 的「已完成」文案问题在 0.2.0 过渡期仍存在，见 §9 迁移路径）。

---

## 3. 现状：使用者眼里是什么样的

**本章结论**：现状下 agent 的等待行为是被轮询指引逼出来的「发明 sleep」，且这条路径在任何通知档位下都不是最优解。

### 3.1 现状的真实样子

mailbox 档未启用（当前环境实测）时，agent 调 `zsub start`（wait=false）拿到的返回值原文（`lib/notifier-mailbox.js:175` `pollingGuidance`）：

```
zsub 后台任务 sa-xxxx 已完成，但 mailbox 通知通道未启用，结果不会自动回流本会话。
查询状态：zsub(action="status", subagentId="sa-xxxx")——任务完成后 status 会变为 closed。
读取结果：closed 后 result 全文落在 outputs 文件（默认 ~/.zcode/zsw/outputs/sa-xxxx.md，status 返回中带该路径），用 Read 工具读取即可。
```

注意第一句「**已完成**」——这是 start 时刻的返回值，任务明明刚启动（文案从完成通知模板复制而来，是已知文案 bug）。zsub tool description 同时写着「②**禁止轮询**——完成通知自动到达，mailbox 未启用时 start 返回值附轮询指引」——「禁止轮询」与「去查状态」在同一次交互里自相矛盾，且没有告诉 agent 任务典型要跑多久。

即便启用 mailbox 档，zsub description 对等待姿势只有四个字「自动到达」——没说注入时机，agent 不知道「自动」的边界。

### 3.2 怎么出错

**失败模式 A（观察到的实际行为）**：agent 调 `zsub start` → 看到「已完成」立刻查 status → `running` → 无时间预期 → 发明 `sleep 60 && …` 循环轮询。代价：每个 sleep 占一次工具调用、拉长 turn、烧上下文；任务跑 10 分钟则 agent 傻等 10 分钟。

**失败模式 B（mailbox 档启用后依然存在）**：agent 听话地结束 turn「等通知」。mailbox 通知投到 `~/.zcode/mailbox/<sess>/unread/`，但引擎只在三个 hook 时机 drain（用户下次发消息 / 本会话任意工具调用结束 / turn 结束瞬间）。若任务在 turn 结束**之后**完成，通知静静躺到用户下次说话——「等通知」等来的是无限期沉默，agent 对结果的承诺食言。

**失败模式 C（跨入口割裂）**：想用 `Bash run_in_background` 拿原生通知时，只能跑 CLI——但 CLI 是独立执行体：`start --conversation` 的会话随 CLI 退出而亡（续聊死路）、无并发限流（N 个 background bash = N 个无上限 runner）、`--no-wait` 已被移除（一次性进程退出即丢执行体，`bin/zsw.js:277` 显式报错）。

### 3.3 根因

三个症状指向同一根因：**daemon 职责与 MCP 工具暴露面耦合在同一个进程的同一个协议上**。

1. 因为暴露面是 MCP tools，agent 的等待只能发生在「模型工具调用」语义里——没有「可挂起的等待原语」，只能 sleep 轮询（模式 A）；
2. 因为执行体挂靠 MCP server（而不是挂在任何一个可被 background bash 触达的进程上），完成事件到不了引擎进程内——注定走不了原生 push 通道，只能走文件 + 惰性 drain（模式 B）；
3. 因为 CLI 与 daemon 无通信通道，background bash 这条**唯一有 push 权的原生通道**要么不可用（conversation），要么用上就丢失 daemon 能力（模式 C）。

## 4. 根因 + 物理数据流

**本章结论**：原生 background bash 通道的 push 链路完整存在且与 zsw 无关——缺的只是「把 zsw 的任务完成」变成「一个引擎进程内 background task 的完成」。本设计用 CLI wait 进程补上这一环。

引擎侧已验证事实（本设计的事实基座，来源：zcode.cjs 逆向，锚点函数名为压缩名，升级引擎后需重验）：

| # | 事实 | 证据锚点 | 状态 |
|---|------|---------|------|
| F1 | 引擎 mailbox drain 只注册在 UserPromptSubmit / PostToolUse / Stop 三个 hook；Stop 时恰有消息返回 `continue:true` 延续 turn | `builtin.sessionMailbox.drain`（PSe） | ✅ 已验 |
| F2 | 原生 background task 完成 → `maybeEnqueueBackgroundTaskNotification` → `runtimeCommandQueue`（mode=task-notification）→ `vNr` → `executeTurnCommand(inputSource:"background_task", inputVisibility:"model-only")` **直接开新 turn，idle 也唤醒** | core.tool.executor 日志串 `background_task.notification.enqueued` + vNr 函数体 | ✅ 已验 |
| F3 | 上述 enqueue 链只在引擎进程内调用；MCP client 只注册 `notifications/cancelled`/`progress` 两个 handler，sampling/elicitation/tasks 无消费代码——外部进程无 push 通道 | SDK 基类构造器 + 全文 grep 无 handler 注册 | ✅ 已验 |
| F4 | MCP server `tools/list` 返回空数组合法：zsw 嵌套模式（ZSW_NESTED=1）即零工具分支（`nested ? [] : buildTools()`）。注：subagent 会话因隔离 HOME 不含 plugins 配置（`lib/driver.js` bootstrapIsolatedHome）物理上不加载 zsw server，故零工具分支是纵深防御代码路径而非常态运行形态——引擎/GUI 对零工具 server 的日常容忍与 V2 同批真机验证 | `dist/mcp/server.js:489` | ✅ 代码路径已验；日常形态并入 V2 |
| F5 | background bash 无 timeout 硬限（前台超预算自动转后台继续跑并通知）；完成通知带 summary（命令+退出码）与 output-file（stdout 全文落盘路径） | Bash 工具结果文案 `moved to the background … You will be notified` | ✅ 已验 |
| F6 | 当前用户环境 `ZCODE_MESSAGE_ENABLED` 未设置，`~/.zcode/mailbox/` 目录不存在——mailbox 档从未启用 | 本机实测 | ✅ 已验 |

**现状数据流（任务完成 → agent 眼前，三条路都不通）**：

```
runner 完成
  ├─ mailbox 档   → 写 ~/.zcode/mailbox/<sess>/unread/*.json → 等 F1 三时机被动 drain
  │                 → idle 会话无限期沉默（模式 B）
  ├─ polling 档   → 什么都不做，agent 按 guidance 自己 sleep+status 轮询（模式 A）
  └─ 原生 push    → ✗ 执行体不是引擎进程内 background task，进不了 F2 链路（F3）
```

**本设计后的数据流**：

```
agent: Bash(run_in_background=true, "zsw start --wait --task ... --slug ...")
  → CLI thin client connect ~/.zcode/zsw/daemon.sock，发 {tool:"zsub",action:"start",wait:true,…}
  → daemon 收请求 → manager.start()（执行体、槽位限流、record 落盘，全部现状逻辑）
  → CLI 进程阻塞（daemon 侧挂起，任务完成才回包）
  → 此刻 CLI 进程本身 = 引擎进程内 background bash 任务
  → 任务完成 → daemon 回包（status + outputFile）→ CLI stdout 打印 JSON → exit
  → 引擎 core.tool.executor 检测终态 → <task-notification>（含 output-file）
  → executeTurnCommand 开新 turn（F2）→ idle 会话被唤醒 → agent Read 结果继续干活
```

一环都不用发明新机制：等待挂在 daemon 内存、通知借 F2 原生链路、生命周期借 MCP spawn/kill、协议借现有 handler 表。

## 5. 终态：使用者眼里将是什么样的

**本章结论**：agent 的全部交互收敛为 Bash 调 CLI；等待 = 一次 background bash；失败路径各有可操作恢复。

### 5.1 成功路径（agent 视角完整样例）

场景：主 agent 需要派两个并行代码审查 subagent，自己同时继续写主逻辑。

```
[agent 调 Bash 工具，前台同步]
$ node <pluginRoot>/bin/zsw.js start --task "审查 lib/manager.js 的错误处理…" --slug review-mgr
{"subagentId":"sa-a1b2","status":"running","notify":"daemon","hint":"等待用: zsw wait --id sa-a1b2 (建议 run_in_background)"}

[agent 调 Bash 工具，前台同步，同上第二个任务]
$ node <pluginRoot>/bin/zsw.js start --task "审查 lib/workflow/…" --slug review-wf
{"subagentId":"sa-c3d4","status":"running",…}

[agent 调 Bash 工具，run_in_background=true —— 挂起等待，立即返回任务句柄]
$ node <pluginRoot>/bin/zsw.js wait --id sa-a1b2 --id sa-c3d4
（引擎返回："Command running in background with ID: bash_7"）

（命令为 1.0.0 默认形态；0.2.0 观察期各命令加 --daemon flag）

[agent 结束 turn，向用户汇报「两个审查任务已派出，完成后我会继续」——会话进入 idle]

……十分钟后两个任务先后完成，daemon 回包，CLI exit 0……

[引擎自动为会话开新 turn，注入]
<task-notification>
  <task-id>bash_7</task-id><status>completed</status>
  <summary>command: zsw wait …; exit 0</summary>
  <output-file>~/.zcode/cli/…/bash_7.out</output-file>
</task-notification>

[agent 读 output-file（CLI stdout，含两任务终态 JSON + 结果文件路径），再 Read
 ~/.zcode/zsw/outputs/sa-a1b2.md 与 sa-c3d4.md，汇总审查发现，继续工作]
```

异步不等待的用法保持现状语义：`zsw start` 立即回 id，agent 之后随时 `zsw status --id …` / `zsw list`；conversation 续聊 `zsw message --id … --text "…"`（阻塞本轮，可同样配 background）。

### 5.2 失败路径（带恢复指引）

| 失败 | 表现 | 👉 恢复 |
|------|------|--------|
| daemon 不在场（插件未启用 / 所有会话已关闭 / 看门狗接管瞬时窗口） | CLI：`daemon 未运行（connect ~/.zcode/zsw/daemon.sock 失败）。👉 稍候重试（多会话下其他实例接管需 1-2s）；仍失败则在任一 zcode 会话确认插件已启用；或 --local 显式本地执行（一次性进程语义，无续聊/限流）` | 按指引三选一（接管窗口内重试即恢复） |
| 沙箱拦截 socket connect（V1 未实测） | Bash 工具报沙箱拒绝 | 该调用带 `dangerouslyDisableSandbox`（仅 connect 本地 socket + 打印，无其他副作用）或用户为 `node …/bin/zsw.js` 配 allow 规则 |
| wait 期间 daemon 死亡（会话被关） | CLI：socket 断开 + `任务执行体随 daemon 终止。👉 zsw status --id … 确认 orphan 标记后重新 start`（record 由下一次 daemon recover 探活落盘） | 重新 start |
| 任务超时/失败 | wait 正常返回非零 exit + 终态 JSON（error 字段），notification 依然触发（F2 不区分成功失败） | 按 error 字段处理，与现状语义一致 |
| 嵌套环境误用（subagent 会话内调 CLI） | CLI 读到 `ZSW_NESTED=1` 直接拒绝：`嵌套环境禁止编排（防递归）` | subagent 内不编排，由主会话派发 |
| CLI 进程被 TaskStop 杀掉 | 只杀遥控器，daemon 任务不受影响（与模式 C 的本质区别） | 需要结果时重新 `zsw wait --id …` 或 `status` |

## 6. 关键决策与权衡

**本章结论**：六个决策，共同把「耦合的 MCP server」变成「daemon + thin client」。

### 6.1 D1 daemon 形态：保留 .mcp.json 注册，tools/list 恒空

- **采用**：daemon 仍是 `.mcp.json` 注册的 MCP server 进程（引擎在会话启动时 spawn、会话关闭时 kill——生命周期管理白嫖），但 v1.0 起 `tools/list` 恒返回 `[]`，同时启动 unix socket 控制面。
- **被否①**：完全脱离 MCP 自管 daemon（launchd/惰性 spawn）——要自己处理孤儿收养、崩溃恢复、多会话共享清理，重造引擎已提供的管理，短期成本高且长期是负担。
- **被否②**：维持现状（MCP tools 暴露）——§3 三个失败模式的根因就是它，不解决。
- **证据**：F4（零工具 MCP 进程是日常形态，嵌套模式天天在跑）；`bin/zsw.js:6` 头注已预留此方向（"bash 增强通道留位…TaskNotificationNotifier 的天然入口"）。
- **效果**：G2（上下文）+ 为 D4 提供宿主。

### 6.2 D2 控制协议：unix socket + NDJSON，一比一映射现有 handler 表

- **采用**：daemon 在 `~/.zcode/zsw/daemon.sock`（路径可用 `ZSW_SOCK` 覆盖，测试用）监听 unix domain socket；帧协议 NDJSON：请求 `{id, tool:"zsub"|"zflow", params:{action,…}}`，响应 `{id, ok:true, result}|{id, ok:false, error:{code,message}}`。**协议面直接复用 `buildToolHandlers()` 的 handler 表**——handler 签名 `(params, ctx)→result`，socket 分发器按 `tool` 查表后以 `{cwd: process.cwd()}` 构造 ctx 调用（ctx.targetSessionId 恒 undefined：socket 面无会话定向语义，见 D6），编排内核零改动。
- **被否**：HTTP/localhost 端口（端口占用冲突、防火箱弹窗、无鉴权暴露面更大）；文件队列轮询（延迟、清理复杂）。
- **证据**：`dist/mcp/server.js:21` 起 handler 注册表形态（M3 接线）——工具注册与业务逻辑本就解耦。
- **效果**：G3（能力无损的成本最小化）；实现量集中在传输层薄壳。
- 安全边界：socket 文件权限 0600（仅本用户）；CLI 校验 daemon 归属（sock 同目录写 daemon.pid，connect 后比对）——防同机其他用户场景下的误连（macOS 单用户场景为主，防御从简但留桩）。

### 6.3 D3 daemon 单例：锁文件竞选 + 长连接看门狗接管

- **采用**：多个 MCP server 实例（zcode 多会话各 spawn 一个，进程树实测）竞选 daemon 角色，**用锁文件串行化 + socket 长连接看门狗**，三段式：
  1. **竞选（锁文件原子互斥）**：启动时先在 sock 同目录以 `O_EXCL` 原子创建 `daemon.lock`（内容写 pid）。创建成功者初始化 manager（含 `recover()`）并 bind socket，成为 daemon；创建失败者**保持一条到 daemon 的 socket 长连接（看门狗连接）**后进入空转（不初始化 manager，只保持 MCP 协议层活着）。
  2. **接管（看门狗事件驱动，零轮询）**：空转实例的看门狗连接对端 close（daemon 进程死亡，unix socket 的内核行为）即触发重新竞选——先 `unlink` 自己锁不住的锁文件与残留 sock（此时持有者已死，安全），再走第 1 步。多空转实例同时被唤醒时由锁文件 `O_EXCL` 再度原子裁决，落选者重挂看门狗。
  3. **退出卫生**：daemon 收 SIGTERM/SIGINT 时先 unlink sock 与 lock 再退出——正常死亡不留残留；异常死亡由看门狗路径清理。引擎 kill MCP server 的粒度（kill pid vs 进程组，是否波及 runner 子进程）列为 V4 同批实测。
  接管时跑 `recover()`：record 重建 + 探活，orphan/dead 标记与重发指引为现有逻辑。
- **被否①**：纯 bind 竞争（无锁文件）——bind/unlink 双检存在窗口：实例 3 bind 成功但未及 listen 时，实例 2 connect 得 ECONNREFUSED 误判残留而 unlink 其 sock，产生监听无路径的幽灵 daemon，与后续 bind 者并存导致任务静默分裂。锁文件 `O_EXCL` 是单 syscall 原子裁决，无窗口。
- **被否②**：每会话独立 daemon + socket 按会话寻址——CLI 无法得知「当前会话」对应哪个 sock，且并发限流/任务互见语义割裂。
- **被否③**：独立 daemon 进程（launchd/惰性 spawn）——脱离引擎生命周期管理，孤儿收养/崩溃恢复自建，重造引擎已提供的能力。
- **证据**：`lib/manager.js:374` recover 已处理「server 重启丢失句柄」的探活与 orphan/dead 标记；record append-only 落盘使接管可见历史；unix socket 对端进程死亡时内核关闭连接（`ECONNRESET`/close 事件）是 POSIX 保证。
- **效果**：G4——daemon 死亡后由仍存活的空转实例**事件驱动接管**（不依赖新会话启动）。代价如实声明：**daemon 所在会话关闭 = 其持有执行体的任务死亡**（runner 是 daemon 子进程，record 已落盘，接管实例 recover 后标 orphan/dead 给出重发指引，不静默）；并发定义域变更见 G3。

### 6.4 D4 wait：daemon 内存挂起，零轮询

- **采用**：新增 `wait` 命令（daemon 侧新 handler）：对给定 id 集合，终态者立即回，运行中者 `await manager.pending.get(id)`（执行体 promise，`bin/zsw.js:320` 已有同款消费先例）——全部终态后回包 `{results:[{id,status,outputFile,…}]}`。支持 `--timeout-ms`（到点回 partial + 各自状态，exit 2）。CLI 侧即阻塞进程——配 `run_in_background` 后整条链路进 F2。
- **被否①**：wait 实现为 CLI 侧 sleep+status 轮询——把模式 A 的 sleep 从 agent 搬进 CLI 进程，看似眼不见为净，实则每个等待都烧轮询、且有通知延迟（轮询间隔）；daemon 挂起是事件驱动，语义干净。
- **被否②**：`start` 一律同步等完（不提供异步形态）——丢失「先干别的」的异步价值（G3）。
- **效果**：G1 的核心机制。`start --wait` 提供 sugar（start+wait 原子，省一次工具调用），`wait` 独立命令服务「异步后再等」和多 id 聚合。

### 6.5 D5 CLI 双模式：socket 优先，`--local` 显式降级

- **采用**：CLI 默认 thin client（connect daemon）；`--local` flag 显式走现状的本地组装执行（人类调试/无引擎环境）。**daemon 不在场时默认报错并给指引，不静默降级**——静默降级会制造「以为在用 daemon，实际独立执行体」的语义漂移（正是模式 C 的坑）。
- **被否**：CLI 只保留 thin client——黑盒子进程测试（`test/cli.test.js`，子进程形态、不跑真引擎）与人类调试/无引擎环境需要本地形态，一刀切丢失既有测试基建与 AGENTS.md「CLI 直跑（不经 MCP）」用法。
- **效果**：G3/G4；迁移期双模式并存，长期 `--local` 保留为调试后门。

### 6.6 D6 通知策略：原生 notification 为主，mailbox 降级 legacy

- **采用**：完成通知不再依赖 mailbox（daemon 的 notifyCompletion 路径保留但非主路径）；等待一律走 wait+background bash（F2）。MCP tools 摘除后 `_meta` 通道（targetSessionId 提取）随之消失——socket 面任务**天然无 mailbox 定向**（ctx.targetSessionId 恒 undefined，notifyCompletion 按 `notifier-mailbox.js:96` 的 target 缺失分支静默跳过投递），这是预期行为而非缺陷：等待一律走 wait，notification 由 CLI 进程的归属会话天然确定，这正是架构的妙处。
- **被否**：继续投入 mailbox 档（推动用户配 `ZCODE_MESSAGE_ENABLED`）——F1 证明它最多做到「下次活动注入」，idle 唤醒物理不可达；且依赖用户级 env 配置，脆弱。
- **效果**：G1 不依赖任何环境开关（对比：mailbox 需 `launchctl setenv` + 重启）；mailbox 代码保留做 legacy 兼容（存量 0.0.1 用户过渡期 MCP 面还在时仍有用）。

### 6.7 D7 版本与摘除节奏：0.2.0 纯增量，1.0.0 翻默认 + 摘工具

- **采用**：两个台阶，CLI 默认行为的翻转只发生在 major。
  - **0.2.0（minor，纯增量）**：daemon socket + 单例竞选 + wait + `start --wait` 落地；CLI **新增** thin client 模式但**默认仍是本地执行**（`--daemon` flag 显式启用 thin client）；MCP tools 保留；skill 指引新增 daemon 用法（注明需 `--daemon`）。
  - **1.0.0（major）**：CLI 默认翻转为 thin client（`--local` 显式回退，见 D5）+ `tools/list` 恒空（D1 终态）+ AGENTS.md 一行指引成为唯一入口。
- **被否①**：0.2.0 即翻 CLI 默认——存量 CLI 用法/脚本从「能跑」变「daemon 缺席报错」，按项目版本准则（major = CLI 参数不兼容）这是 minor 内不允许的行为变更。
- **被否②**：一步到位 1.0——沙箱（V1）、GUI 零工具容忍（V2）两个未实测点直接压在 breaking change 上，风险集中。
- **证据**：项目发布规范（AGENTS.md npm 发布节：major 准则含「CLI 参数不兼容」；minor 准则含「新增 CLI 子命令」——0.2.0 的 `wait` 子命令与 `--daemon` flag 均为增量）。
- **效果**：G1 在 0.2.0 经 `--daemon` 路径可用并可真机验收；G2 在 1.0.0 达成；每个 minor 都可独立回退。

三栏总览（架构路线层面）：

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. daemon + socket + thin CLI（本设计） | 职责分离，全场景统一 push；上下文按需加载 | 中（socket 层 + wait + 指引层；编排内核零改动） | V1 沙箱 / V2 GUI 呈现待实测；会话耦合的 daemon 死亡边界（D3 已声明） | ✅ |
| B. 维持 MCP tools + 信使脚本（wait-for.js 读盘轮询 + bg bash） | 不动架构但留着三入口割裂；信使轮询本质未除 | 低 | 指引层两套（MCP 描述 + 信使用法），终态作废时模型习惯教两遍 | ❌ |
| C. 纯 CLI 独立执行体（现状 CLI 扩用） | 无 daemon：异步/续聊/限流全丢（模式 C） | 低 | conversation 死路；无上限并发 | ❌ |

**被否若用 B**：§5.1 的例子变成「agent start（MCP）→ 另起信使脚本 bg → 信使每 5s 读盘 → 完成后 agent 醒来」——能跑，但异步任务仍走 MCP 面（description 2.1KB 还在），等待与信使的用法指引叠加在已有矛盾文案上，且轮询延迟/开销只是被藏进脚本；0.2.0 落地后这套指引整体作废，agent 行为习惯要再教一遍。

## 7. 实现机制

**本章结论**：四层改动——daemon 层、socket 层、CLI 层、指引层；编排内核（manager/runner/pool/record/workflow）零改动。

```
z-subagent-workflow/
├── lib/
│   ├── daemon-socket.js        [新增] unix socket 服务端：listen/accept/NDJSON 帧/
│   │                                  锁文件竞选（O_EXCL）+ 看门狗接管连接 + SIGTERM
│   │                                  退出卫生（unlink sock/lock）/ 请求分发到 handler 表
│   ├── wait-handler.js         [新增] wait 命令 daemon 侧实现（pending 挂起 + 聚合 + timeout）
│   ├── assemble.js             [小改] 导出「socket 分发器可复用的 handler 表」组装函数
│   └── config.js               [小改] sockPath()（~/.zcode/zsw/daemon.sock，ZSW_SOCK 可覆盖）
├── dist/mcp/server.js          [小改] 启动序列接 daemon-socket；tools 空注册开关（1.0 恒空）
├── bin/zsw.js                  [改] thin client 模式默认 + --local 显式本地 + wait 子命令 +
│                                      ZSW_NESTED 拒绝 + daemon 不在场可操作报错
├── skills/zsub-zflow-orchestration/SKILL.md  [改] 用法改 CLI/Bash 分流决策表（0.2.0 起）
└── test/                       [增] daemon-socket 单测（假 manager）；e2e 增 socket 面 + wait 场景
```

要点：

1. **单例竞选无竞态**：以 sock 同目录 `daemon.lock` 的 `O_EXCL` 原子创建为唯一裁决点（单 syscall，无检查-then-act 窗口）；锁内写 pid 供诊断。纯 bind 竞争方案的反例（已否）：bind 成功但未及 listen 的窗口内，他实例 connect 得 ECONNREFUSED 误判残留而 unlink，产生幽灵 daemon 与双 daemon 并存——锁文件从根上消除此类窗口。锁文件与 sock 残留的清理只在看门狗触发（持有者已死）或 SIGTERM 退出卫生（D3 第 3 段）时进行。
2. **wait 挂起的取消**：CLI 断连（TaskStop 杀 CLI）时 daemon 侧 abort 该连接的挂起响应（不影响任务执行体）；daemon 关闭时（引擎 kill）所有挂起连接随进程退出断开——CLI 侧表现为「socket 断开」失败路径（§5.2 第 3 行）。
3. **stdout 纪律不变**：daemon 的 socket 帧走 socket 而非 stdout，MCP stdout JSON-RPC 通道语义不受影响；日志照旧 stderr 落盘 `~/.zcode/zsw/`。
4. **嵌套防护**：CLI 侧检查 `ZSW_NESTED=1` 拒绝（env 经 bash 传导到 CLI 进程）；daemon 侧不重复检查（socket 请求无会话语义）。防递归边界从「MCP 工具面」平移到「CLI 面」，语义等价。
5. **ZSW_SOCK / ZSW_ROOT** 测试隔离同款覆盖（既有 env 覆盖模式）。

## 8. 验收（真实场景，非单测非 mock）

**本章结论**：大改动（新交互面 + 行为变更 + 接口调整），8 个真实场景，覆盖 G1-G4 与 D3-D6 的关键断言。

### 8.1 改动规模

大改动：新增 socket 控制面与 wait 语义，agent 交互面整体迁移，跨版本兼容。

### 8.2 验收场景

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|------|---------|-------------------|---------|
| A1 | idle push 唤醒（核心） | G1 | 真机 ZCode GUI 会话，让 agent 调 `Bash(run_in_background=true)` 跑 `zsw start --daemon --wait --task "总结 ~/.zcode/zsw/README 前 3 行" --slug probe`（真实小任务、真实模型）；agent 结束 turn 后等任务完成。**产物化**：观察记录落盘 `design/`（含 zcode 版本号、notification 原文、agent 后续输出摘录），供审计与 V3 复验对照；wait 链路前半段（CLI 阻塞→exit→output-file 内容正确）已由 e2e 半程自动化覆盖，本场景只人工验「idle 唤醒」一段 | 会话被自动唤醒（无需用户发言），注入的 `<task-notification>` 可见，agent 后续输出引用了任务结果内容；观察记录落盘 |
| A2 | 异步 start + 聚合 wait | G1/G3 | 真机会话：前台 `zsw start --daemon` ×2（两个不同小任务）→ `Bash(bg)` `zsw wait --id a --id b` → 结束 turn | 单次 notification 唤醒，output-file 内含两任务终态与结果路径，两个 outputs 文件可 Read |
| A3 | conversation 续聊走 CLI | G3 | `zsw start --daemon --conversation --task …`（前台等首轮完成）→ `Bash(bg)` `zsw message --id … --text "补充：只看错误处理"` | 第二轮结果产生（outputs 更新、rounds=2），notification 唤醒后 agent 能引用第二轮结论 |
| A4 | 并发限流跨入口生效 | G3 | daemon 已持 2 个 running 任务时，CLI 连发 2 个 `start` | start 句柄立即返回（handle.status='running' 语义）；record 处于 **created**（排队语义，`lib/manager.js:440` created→running 转换发生在 `slots.acquire` 之后）；任一完成后排队者 transition 为 running（FIFO，`lib/slots.js`） |
| A5 | daemon 死亡与看门狗接管 | G4 | 会话 A（daemon 宿主）跑长任务 → 关闭会话 A（daemon 死）→ **不新开任何会话**，在既有会话 B 里 `zsw status --id` | 会话 B 的空转实例经看门狗连接 close 事件自动接管（锁文件+sock 重bind + recover）；`status` 显示该任务 orphan/dead 标记 + 重发指引（探活落盘），无静默僵尸；B 里新 start 正常。e2e 中以杀 daemon 进程模拟关闭 |
| A6 | 上下文注入消失 | G2 | 1.0.0 安装后新开会话，检查系统提示词/工具列表 | 工具列表无 zsub/zflow；会话内 agent 经 skill 指引能正确调 CLI（说「用 zsw 派发」时 agent 走 Bash 而非找 MCP 工具） |
| A7 | 嵌套防护 | G3 边界 | 主会话派一个 subagent，任务书里要求「调 zsw start」 | subagent 内 CLI 被拒（ZSW_NESTED 报错文案），任务输出含该拒绝信息，无递归 spawn |
| A8 | 沙箱与降级（V1 门） | G1 | 真机会话默认 permission 模式下 agent 跑 `zsw --daemon list`（socket 连接） | 要么直接成功；要么沙箱拒绝 → 按 §5.2 指引 `dangerouslyDisableSandbox` 或 allow 规则后成功（结论回填 §11 V1，决定 0.2.0 指引文案） |

> A1/A3 的「idle 唤醒」段需真机 GUI 人工执行（无头 `-p` 模式单 turn 即退，唤醒无意义）；A2/A4/A5/A7 及 A1/A3 的 wait 链路前半段可在 `test/e2e.test.js` 扩展为自动化（真实无头 zcode + 真实模型，既有基建）。A5 的「关闭会话」在 e2e 里以杀 daemon 进程模拟。**A1 与 V3 探针绑定为引擎升级后的固定复验动作**（升级破坏 F2 链路时第一现场发现）。

## 9. 实施

**本章结论**：两阶段（0.2.0 双面 → 1.0.0 摘工具），每阶段独立可验收。

### 9.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 |
|------|------|---------------|
| M0（0.2.0，minor 纯增量） | daemon-socket（含锁文件竞选 + 看门狗接管）+ wait + `start --wait` + CLI `--daemon` flag（默认仍本地执行，存量 CLI 用法无感）+ skill 指引新增 daemon 用法 + pollingGuidance 文案 bug 顺手修 + A2/A4/A5/A7 及 wait 半程 e2e | G1（经 `--daemon` 路径可用并可真机验收）、G3；MCP 面与 CLI 存量用法零变更 |
| M1（1.0.0，major） | CLI 默认翻转为 thin client（`--local` 回退）+ tools/list 恒空 + AGENTS.md 一行指引 + A1/A6/A8 真机验收 | G2（上下文消失）；CLI 默认翻转与工具摘除两项 breaking 合并走一个 major |

M0 与 M1 之间设观察期：真机用 0.2.0 的 `--daemon` 路径跑日常任务，确认 wait/notification 链路稳定、A8 沙箱结论回填后再进 M1。

## 10. 下一层拆分

| 单元 | 说明 | justification（为什么这么拆） |
|------|------|------------------------------|
| U1 lib/daemon-socket.js + 单测 | socket 服务端、NDJSON 帧编解码、锁文件竞选 + 看门狗接管 + 退出卫生、错误映射 | 传输层独立可测（假 handler 表、双进程竞选用临时 ZSW_SOCK 目录模拟），不依赖 manager；协议先稳定 |
| U2 lib/wait-handler.js + 单测 | 挂起/聚合/timeout/断连取消，挂 manager.pending | 依赖 U1 的分发接口约定；核心新语义单独成单元 |
| U3 bin/zsw.js thin client 改造 | M0：`--daemon` flag + wait 子命令 + 嵌套拒绝 + 可操作报错（默认仍本地）；M1：默认翻转 thin client + `--local` 回退 | 交互面变更集中一文件；M0/M1 行为差异收敛为一个默认值；存量 cli.test.js 与 AGENTS.md 用法在 M0 不受影响 |
| U4 dist/mcp/server.js 接线 + tools 开关 | 启动序列挂 U1；`ZSW_TOOLS_DISABLED=1`（1.0 恒空逻辑先行开关化） | 开关让 0.2.0/1.0.0 行为差异收敛为一个常量 |
| U5 指引层 | skill 改写（CLI/Bash 分流表）+ AGENTS.md 提示行 + README | 行为习惯迁移的载体，随 M0 同步发布 |
| U6 e2e 扩展 | A2/A4/A5/A7 自动化（真实无头 zcode + 真实模型） | 验收场景的可回归化；复用既有 e2e 基建 |

依赖：U1→U2→U3 串行；U4 依赖 U1；U5 依赖 U3 的 CLI 形态定型；U6 依赖 U3/U4。

## 11. 待验证检查点

| # | 检查点 | 验证方式 | 失败时的降级 |
|---|--------|---------|-------------|
| V1 | zcode Bash 沙箱是否放行 unix socket connect | 真机会话跑 `zsw list`（A8） | `dangerouslyDisableSandbox` 指引 / allow 规则，写进 skill |
| V2 | 零工具 MCP server 在 GUI 插件面板的呈现（是否误报 server 错误）+ 引擎对零工具 server 的日常容忍（F4 的日常形态部分） | 1.0.0 候选 build 真机装 `zcode plugins list` + GUI 面板观察 | 若误报：保留一个哑工具（如 `zsw-ping`）占位，上下文成本 1 行 |
| V3 | 引擎升级后 F1-F5 事实漂移（尤其 F2 notification 链与 F4 空工具容忍） | 升级后重跑逆向锚点探针（AGENTS.md「升级 zcode 后先跑冒烟探针」纪律）+ 复跑 A1（已绑定） | 漂移则回到本设计的 §4 重验，必要时回退 1.0.0 的工具摘除与默认翻转（0.2.0 双面形态即回退位） |
| V4 | 竞选/接管实测三件套：锁文件 + 看门狗在真机多会话下的行为（含 daemon SIGKILL 异常死亡、看门狗并发唤醒）、引擎 kill MCP server 的粒度（kill pid vs 进程组，是否波及 runner 子进程） | 真机两个会话同启 + 杀 daemon 后另一会话看门狗接管观察（A5 覆盖大半） | 看门狗异常则退化为「启动时竞选 + CLI 报错指引用户重开会话」；kill 粒度异常则 daemon 侧显式 `detached` spawn runner |

## 附录：变更历史

- v1：初稿（daemon + socket + thin CLI 架构，M0/M1 两阶段）。待对抗式审查。
- v2：对抗式审查修订（3 must-fix + 8 suggestions 全采纳）——D3 重写为「锁文件竞选 + 看门狗接管」（修复空转实例无死亡感知与 bind/unlink 竞态）；D7 重排版本台阶（CLI 默认翻转挪 1.0.0，0.2.0 纯增量）；上下文口径修正为全量 5.5KB；F4 证据等级修正（代码路径已验/日常形态入 V2）；G3 显式声明并发定义域 per-session→global 及 ZSW_MAX_CONCURRENT 覆盖；A1 产物化 + 与 V3 绑定；A4 状态机口径修正（record created=排队）；A5 改为不新开会话的看门狗验收；D2 补 ctx 约定、D6 补 socket 面无 mailbox 定向声明、D5 证据对象修正（cli.test.js）、退出卫生与 kill 粒度入 V4。
- v3（M0 实现细化补记，0.2.0 已落地）：
  - lock 命名细化为 `sockPath + '.lock'`（设计原文「sock 同目录 daemon.lock」——实现按 sock 绑定命名，天然支持 ZSW_SOCK 多测试域隔离）。
  - **standby 的 M0 过渡语义**：manager 照常初始化、MCP 工具面照常服务（D3 的「空转不初始化 manager」是 1.0 摘工具后的终态）。边界：M0 期间 MCP 面任务（各实例独立槽位）与 daemon socket 面任务（daemon 槽位）并存，总并发上限 = 实例数×3 + 3；1.0 摘工具后收敛为全局 3（G3 声明的语义）。standby 实例启动序列的 recover 探活会把 daemon 正在跑的任务标注 orphan（多实例既有行为，任务照跑不受影响；daemon 死后该标注转为准确语义）。
  - `ZSW_TOOLS_DISABLED=1` 先行开关落地（tools/list 空 + tools/call 可操作拒绝 + socket 面不受影响），作为 V2 真机验证与 1.0 行为的灰度入口；动态读 env（进程内可切换）。
  - wait 经 zsub action 面暴露（inputSchema action enum + description 速查行，而非独立 tool），CLI `zsw wait --daemon --id a [--id b] [--timeout-ms n]`（partial → exit 2）；`start --daemon --wait` sugar 落地。
  - e2e 落地（test/e2e-daemon.test.js）：A7/wait 半程/A2/A4/A5 机制版实跑通过（0 skip）；A4 取「created 排队态 + 句柄立即返回」断言（FIFO 转 running 尾巴因时序成本未自动化）；A5 的 orphan 标记依赖 standby 启动时序的 recover 探活（M0 接管者不重跑 recover），「接管后新 start」未自动化（省模型调用，机制已被其余场景覆盖）；CI 以 `e2e*.test.js` 模式排除（无凭据环境模型场景 skip 不红）。
  - sockPath 单一来源：`lib/cli-client.js` 导出 `defaultSockPath()`（ZSW_SOCK 覆盖 > `~/.zcode/zsw/daemon.sock`），server 接线与 CLI 共用。
