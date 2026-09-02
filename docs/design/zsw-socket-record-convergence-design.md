# zsw socket 面与 record 台账收口设计（帧 codec / zsub action 面 / record 生命周期）

**一句话结论**：三个互相独立的插件内收口——帧编解码提为可 import 的单源模块（不动 S8 传输层职责分离）、zsub action 面（分发 + 校验 + 结果形态）收进 lib 单一深模块（顺带删除 daemon 内部「MCP 包装再拆包」弯路与不可达的 wait 分支）、record 台账加 keep-N 截断式 compact（interface 不动）——三者都不改变任何使用者可见行为，也都不翻既有裁决。

> 层声明：当前层 = 插件结构收口技术方案；下一层 = 可实施的代码单元（impl-plan）。本文按技术方案设计类最严格口径写（物理数据流 / 错误恢复 / 运行时断言探针全适用）。

## 1. 背景目标

### SCQA

- **S（情境）**：zsw 插件给 zcode 会话提供 subagent 编排能力。MCP server 进程（`dist/mcp/server.js`，由引擎按 `.mcp.json` spawn）内寄生一个常驻 daemon（多实例经锁文件竞选，胜者 daemon、败者 standby）；CLI（`bin/zsw.js`）是 thin client，经 Unix socket 发 NDJSON 帧给 daemon；`--local` 是绕过 daemon 的一次性调试后门。任务状态走 `~/.zcode/zsw/records.jsonl` append-only 事件流台账。
- **C（冲突）**：三条结构债各自付着利息——① 帧语法的权威定义散在两处头注互指（`lib/cli-client.js` 与 `lib/daemon-socket.js` 各持一份实现，S8 收敛定论自认代价「帧语法变更须两文件同步改」），测试侧再持多份构帧 replica；② zsub 的 action 分发存在三份 switch（CLI 组参 / CLI `--local` 执行 / daemon handler）、参数校验三份、daemon 进程内还有一段「业务对象 → MCP content 包装 → 再拆包还原」的历史弯路，以及一段续聊线移除后已不可达的 wait 内联分支；③ `records.jsonl` 只增不减，daemon 每次启动 `readFileSync` 全量重放，长期使用下恢复成本与磁盘占用无上界。
- **Q（问题）**：怎么让帧语法单源、action 面单源、record 台账有生命周期——同时零使用者可见行为变化，且不翻既有裁决（S8 传输层分离、DESIGN-v4 D1 zero-tool、reaper 只报告不删、D-E4 record-store 暂不下沉）？
- **A（答案）**：三个独立收口，见一句话结论。三个收口彼此正交，可独立实施与验收。

### 系统是什么（给没用过内部实现的开发者）

zsw 的运行形态（三个进程角色）：

```
zcode 引擎会话
  └─ spawn MCP server（dist/mcp/server.js，stdio JSON-RPC）
       └─ 内部 startDaemon 竞选 → 胜者 = 常驻 daemon（持 ~/.zcode/zsw/daemon.sock + .lock）
                                  败者 = standby（挂看门狗待接管）

CLI（bin/zsw.js）
  ├─ 默认路径：cli-client 组 NDJSON 帧 → daemon.sock → daemon 分发执行 → 帧回 → 打印
  └─ --local 路径：跳过 daemon，进程内组装完整 manager 直接执行（调试后门）

状态面：~/.zcode/zsw/
  ├─ records.jsonl        subagent 任务事件流台账（本设计 §2.3 与 §3.2 线 C 的对象）
  ├─ workflow-state/      workflow 线独立状态面（每 run 一个 .jsonl，已有 keep-N 裁剪）
  └─ outputs/             任务产物（reaper 只报告不删——边界不动）
```

关键背景三点：

1. **MCP 面已终态化为 zero-tool**（工具面 1.0.0 下线）：`tools/list` 恒空、`tools/call` 恒拒绝。daemon 的 socket 面才是 zsub 的活跃执行面。
2. **daemon 不是独立进程**：它寄生在 MCP server 实例内，宿主 stdin 关闭即随亡。插件升级必然伴随 zcode 重启 → MCP server 重启 → daemon 重新竞选。这一点是 §3.2 线 C 兼容论证的基础。
3. **「帧」**指 socket 上的 NDJSON 报文：请求 `{id, tool:"zsub"|"zflow", params, cwd?}`、响应 `{id, ok:true, result} | {id, ok:false, error:{message}}`，`\n` 分隔。「**codec**」指帧的编码（对象→单行 JSON）与流式解码（Buffer 累积、按字节 `0x0A` 找行界、半包跨 chunk 拼接、坏行容忍）。

### 设计目标（从体验倒推）

1. **维护者改帧语法只动一处**：新增 `lib/frame-codec.js` 为唯一语法源，daemon-socket 与 cli-client import 它；测试不再手写构帧 replica（§2.1 的失败模式 A 消失）。
2. **维护者加/改 zsub action 只动一处**：action 表 + 执行 + 错误消息收进 lib 单一模块，CLI 与 daemon 两入口的执行语义由结构保证一致（§2.2 的失败模式 B/C 消失）。
3. **长期使用成本有上界**：`records.jsonl` 收敛到「活跃 run 全量 + 最近 N 个终态 run」，daemon 启动恢复成本与磁盘占用封顶（§2.3 的失败模式 D 消失）。
4. **使用者零感知**：CLI 命令输出、错误消息文本、MCP 冒烟形态、`--local` 语义全部不回归——三个收口都是内部结构整理。

### In-scope / Out-of-scope

**In-scope**（三线，本文档自包含其问题定义，不依赖任何外部报告即可读懂）：

- 帧 codec 单源化；
- zsub action 面收口：分发表合一、校验归属声明、daemon 内部 MCP 包装/拆包对删除、不可达 wait 内联分支清理（仅 zsub 线）；
- record 台账 keep-N 截断式 compact。

**Out-of-scope**（显式不做，防 scope creep）：

- 统一 run 台账（RecordStore 与 core FileRunStore 的归一/桥接）：等 V8n committed 后按 `zsw-manager-convergence.md` 立案启动，本设计的 record compact 是它之前的独立止血，interface 不动以保证将来桥接不受影响。
- zflow 面抽出 / `dist → bin/zsw.js` 反向 require 消除：D-4/D-E3 裁决「socket 面与 CLI 共用 bin/zsw.js 单一实现防两入口漂移」的现状不动。本设计只重构 zsub 线；zflow handler 的**返回形态**随包装对删除一并调整（那是 daemon 内部管道，不是 zflow 面迁移）。
- `--local` 拓扑与单一属主（`--local` 降级 socket client 或借还协议）、core-ref 投影面（按域分组投影替代裸 requireCore 消费）。
- 引擎收口三份（server stdin 钩子 / assemble 组合 / CLI exitAfterEngineShutdown）**显式不动**：三处触发点与兜底各有真实差异（daemon 收尾多 `daemon.stop()` + 60s 兜底、CLI 是 250ms exit timer 保 exitCode、assemble 是 runner 收割组合点），强行合一需要发明「优雅退出」抽象层，收益低于扰动。
- reaper outputs 删除能力：只报告不删是刻意的资产边界，不动。

## 2. 现状与问题分析

### 2.1 帧协议与 codec：语法双源 + 测试 replica

**帧语法没有可 import 的单源。** 生产侧两份实现（均为有意保留，S8 收敛定论）：

- `lib/daemon-socket.js:67-69` `encodeFrame`（`JSON.stringify` + `\n`）与 `:81-104` `createFrameDecoder`（Buffer 累积、按字节 `0x0A` 找行界、行完整后才 `toString` 保 UTF-8 跨 chunk、坏行走 `onBadLine` 回调）。导出面 `:468` 仅 `{ startDaemon }`，头注（:30-33）声明不导出的理由：
  > 帧编解码（encodeFrame/createFrameDecoder）是模块内部函数，不导出——对外仅暴露 startDaemon；CLI thin client（lib/cli-client.js）不复用它——自带一份最小编解码（S8 收敛定论：两份最小实现并存、语义兼容，帧语法变更须两文件同步改），帧协议契约以 cli-client.js 头注为权威（互指维护）。
- `lib/cli-client.js:44-58` `extractResponseFrame`（宽容版：跳过空行/非 JSON 行/无布尔 `ok` 的 JSON 行），请求帧在 `:81` 内联构造 `` `${JSON.stringify({ id: 1, tool, params, cwd })}\n` ``。头注（:14-19）说明不复用的理由：
  > 那是服务端传输层（listen/accept/锁竞选/看门狗），客户端只需「encode 一行 JSON + 按行读到首个含布尔 ok 的合法 JSON 帧」——单请求单响应场景两端帧语法相同但状态机完全不同。

S8 定论反对的是「client 复用服务端传输层模块」——这个职责分离是对的且本设计不翻。但定论自认的代价「**帧语法变更须两文件同步改**」是真实的维护税：

**失败模式 A（协议演进多改点）**：帧语法一旦演进（例如响应帧加字段、错误形态调整），须同步改 `daemon-socket.js`、`cli-client.js` 两份实现 + 两处头注互指的「帧协议契约」段，漏一处即 daemon 与 client 对同一语法理解分叉——且分叉不报错，只在运行时表现为「client 永远等不到含 `ok` 的行」这类静默挂起。

**测试侧放大**：同一协议在测试里再存多份构帧 replica——

| 文件 | 构帧方式 | 语义 |
|---|---|---|
| `test/daemon-socket.test.js:29-45` | 手写 `encodeFrame` + `createFrameDecoder` 副本 | replica（头注 :24-28 自认「测试侧内联同款最小编解码仅作响应侧解析」） |
| `test/server-daemon.test.js:18-19` 头注 | 声明第三份内联 codec | 「帧编解码不 import daemon-socket（其导出面收敛为仅 { startDaemon }）」 |
| `test/cli-client.test.js:43`、`test/cli-daemon-zsub.test.js:66`、`test/cli-workflow-daemon.test.js:77` | 手写 `` `${JSON.stringify(...)}\n` `` 构响应帧 | 假 daemon 侧构帧 |

其中 `daemon-socket.test.js:427-432` 的注释直指这笔债的由来（69f71eb 重建回归锚时有意留下）：

> createFrameDecoder 是模块内部函数不导出（改源码暴露面超出本批领地），按本文件既有 internal 惯例经 startDaemon 传输层回归……

即：**回归锚当时就是想打生产 decoder 的，只是「改源码暴露面」超出该批次领地才退而求其次**。本设计就是来清这笔账的。

**根因**：帧语法（「一行 JSON + `\n`」+ 解码状态机）与传输层职责（listen/accept/锁/看门狗）被捆绑在同一个模块里，语法因此不可独立 import——S8 用「两份最小实现并存」回避了捆绑，代价是语法权威散在两处头注互指。

### 2.2 zsub action 面：三份分发 + 三份校验 + 内部弯路 + 死分支

**同一个 action → manager 调用的映射存在三份**：

1. **CLI 组参 switch**（`bin/zsw.js:826-881`）：argv → `params` 翻译（start/list/agents/models/status/message/cancel/close）；
2. **CLI `--local` 执行 switch**（`bin/zsw.js:1027-1086`）：action → `manager.*` 直调；
3. **daemon handler switch**（`dist/mcp/server.js:162-249`）：action → `manager.*` 直调（zsub 工具内），zflow handler 另一份 switch（:255-352）。

**参数校验现状是三层分布**（各自服务不同失败面，本设计不删除任何一层，见 D4）：`bin/zsw.js:828` 与 `:1029` 两处 `if (!args.task || !args.slug) usage();`（CLI argv 层快速用法提示）；`server.js:173-175` 的 message text 校验（daemon 面 handler 前置）；`lib/manager.js:117-142` 的 start 入口校验（task 非空自包含提示/slug 长度/ctx.cwd）与 `:343-388` 的 message 四闸（业务权威层，消息可操作）。

**daemon 内部「包装再拆包」弯路**（MCP 时代遗产）：handler 表每个分支返回 `okContent(业务对象)`——`dist/mcp/server.js:104-106` 把对象 `JSON.stringify(value, null, 2)` 进 `content:[{type:'text',text}]`（MCP content 形态）；随后 `buildDaemonHandlers`（:377-394）在**落帧之前**又用 `unwrapContentResult`（:397-412）`JSON.parse` 还原成业务对象。适配器头注（:369-373）自己说明了这段弯路的存在理由：

> 出参：MCP handler 返回 okContent/errContent 包装，socket 帧的 result 必须是业务对象——CLI 直接消费业务字段（如 wait 的 partial 决定 exit code、start 的 subagentId 供 --wait sugar 追发），content 包装对 CLI 是泄漏。

**关键事实（决定本收口风险等级）**：socket 帧**发出去的负载已经是业务裸 result**（`{id, ok:true, result:<业务对象>}`），包装与拆包完全发生在 daemon 进程内部、`socket.write` 之前。CLI 侧 `toResult`（`lib/cli-client.js:60-63`）只剥 `id`。因此**删除这对 adapter 不是线上协议变更**，是 daemon 进程内管道简化。`errContent` 仍有一个真实消费者：MCP 面 `dispatchToolCall`（server.js:437-441）恒返回 `errContent(toolsDisabledMessage())`——zero-tool 拒绝面，保留。

**wait 语义两处，且在 `--local` 入口全部不可达**：daemon 面的 `lib/wait-handler.js` 是事件驱动 wait（`WAIT_DONE_STATUSES` 判据、`Promise.race` 唤醒回查、abort 只取消等待不碰执行体），是唯一可达的 wait 面。另一处是 CLI `--local` message 的内联段（`bin/zsw.js:1064-1076`）：`manager.message` 的续聊执行线已随 app-server 常驻化重构移除（`lib/manager.js:380-388` 入口校验通过后直接 throw「续聊暂不可用……冷续聊回归路线已登记 P3」）；更进一步，`--local` 路径 rebuild 后所有非终态 record 被标 `lost`（`record-store.js:147-149`；`bin/zsw.js:1009-1014` 注释自认），内存态只可能是 `{closed, cancelled, error, timeout, lost}`，而 message 的 busy 闸要求 status 为 running/created——**busy 早退分支与 `await pending` 段在该入口均不可达**，`--local` message 的真实可达输出只有三类错误：id 不存在 / 非 conversation 任务 / 状态非 idle。整段内联（busy 早退 + await）都是死代码。

**失败模式 B（两入口漂移）**：加一个 action 或改一个错误消息，要同步改 CLI 组参、CLI `--local`、daemon handler 三处（还可能漏 manager 层）——漏改的那一处静默保持旧语义。现状已有实例：`start` 在 daemon 路径刻意不传 wait（`bin/zsw.js:830-831` 注释），`--local` 路径硬编 `wait: true`（:1052）——两入口对同一 action 的参数面已经分叉（这是有意的，但「有意分叉」与「漏改分叉」在代码形态上不可区分，审查成本恒在）。

**失败模式 C（弯路放大错误面）**：包装-拆包往返引入了两类只有它才有的边界——`JSON.stringify(value, null, 2)` 后 `JSON.parse` 还原对 `undefined` 字段/`Date` 对象等往返不保真的形态（当前 manager 各 action 返回纯 JSON 对象所以无害，但每个新 action 的返回形态都要过一遍这个隐含约束）；`isError:true` 包装在 unwrap 侧转 throw 再由 dispatch 转 `ok:false` 帧——错误路径多绕两跳。

**根因**：zsub 的「action 面」（action 名 → 校验 → manager 调用 → 结果/错误形态）从未被当作一个模块设计——它是 MCP server 演化留下的形态：handler 表生而为 MCP tools/call 服务（所以有 content 包装），MCP 面下线后 adapter 对成了纯内部弯路；CLI 两个入口各自拼装了一份执行映射。D-4/D-E3 裁决已经把 zflow 线的「共用单一实现」收口到 bin/zsw.js（代价是 dist→bin 反向 require——「zflow 面抽出」重构的处理对象）；zsub 线还没有对应收口。

### 2.3 record 台账：事件流无生命周期

**`records.jsonl` 是 append-only 事件流**（`lib/record-store.js`）：

- 事件三类（:90-93 注释）：`created`（初始字段全量）/ `transition`（CAS 状态转移 + patch）/ `update`（不动 status 的字段回填）。
- 状态机（:20-28）：`TERMINAL_STATUSES = {closed, cancelled, error, timeout}`（硬终态，无出边）；活跃态 `created/running/idle/lost`，`lost` 是崩溃恢复标记（可被探活纠正回）。
- `rebuildFromLog`（:125-151）：**整文件 `readFileSync` + 逐行重放**；终态照抄、非终态标 lost（只改内存不落盘）；坏行/引用不存在/CAS 不匹配计入 skipped 不炸（尾部截断防御）。
- 一次典型任务写 **4-5 个事件**（created → transition→running →（可选 update exec）→ transition→终态（patch 含 closedReason/sessionId/tokens/rounds 等） → update notified）；worktree 任务再多 1-2 个 update；daemon 重启 recover 对孤儿/死进程各追加 update。
- 写入即 `appendFileSync`（:203-207），头注（:5-8）自认多进程并存假设：
  > 为什么 append-only 事件流而不是可变 JSON：server 崩溃/重启后要能无损重建内存索引（rebuildFromLog），且多进程（CLI 与 MCP server 并存）下追加写是文件系统层面最不容易撕裂的形态。

**对照：另两条运行产物线都已有生命周期策略**——`workflow-state/` 有 `pruneWorkflowState`（`lib/assemble.js:90-102`，mtime 升序删最旧、`ZSW_STATE_KEEP` 默认 1000，调用点唯一 = assembleManager 收尾 fire-and-forget，:73-75 论证了单点覆盖）；`outputs/` 由 reaper 只报告不删（资产边界，`lib/reaper.js:8-10` 头注）。唯独 `records.jsonl` **完全没有策略**。

**失败模式 D（恢复成本与磁盘无上界）**：按典型 5 事件/任务计，日均 20 个任务一年约 36,500 行；daemon 每次启动（含 standby 接管，`server.js:654-667` `onTakeover` 再 recover）与每次 `--local` 执行（`bin/zsw.js:1015`）都全量重放。文件线性增长 → 启动恢复时间线性变慢，没有任何机制封顶。当前无报警、无上限、无清理路径。

**根因**：事件溯源形态（append-only + 全量重放）被选中的理由是崩溃安全与多进程安全，但事件溯源的标配——**compaction**（把已终结的历史折叠/截断出热路径）——从未跟上。这不是缺一个清理脚本，是台账实现缺了半条生命周期。

### 2.4 物理数据流（现状 → 目标对照）

**帧路径（收口前后形态不变，实现位置变）**：

```
CLI argv ──组参──> params ──encodeFrame──> NDJSON 帧 ──daemon.sock──> daemon
  daemon: createFrameDecoder 流式解码 ──> dispatch ──> handler[tool][action]
    现状: handler 返回 okContent(业务对象) ──buildDaemonHandlers: unwrap──> 业务对象
    目标: handler 直接返回业务对象（throw = 错误）
  ──> resp {id, ok, result|error} ──encodeFrame──> socket ──> CLI: toResult 剥 id ──> 打印
  codec 实现位置: 现状 daemon-socket.js / cli-client.js 各一份 + 测试 replica
                 目标 lib/frame-codec.js 单源，两生产文件 + 测试 import
```

**record 路径（compact 插在 rebuild 之后）**：

```
manager 写路径: append(event) ──writeEvent──> appendFileSync >> ~/.zcode/zsw/records.jsonl
恢复路径（现状与目标同）: daemon 启动/接管 或 --local ──> rebuildFromLog: readFileSync 全量逐行重放
  ──> 终态照抄 / 非终态标 lost（内存）──> recover 探活（daemon only）
目标新增（仅 daemon 角色确定后 / onTakeover，索引已建好）: ──超阈值?──> compact: 终态 run 按 keep-N 截断
  ──> temp 文件（同目录 + pid 后缀）+ rename 原子替换 ──> 文件收敛「活跃全量 + 最近 N 终态」
status/list 消费: 内存索引（rebuild + 运行时 fold 维护）──> CLI / MCP 面
```

## 3. 解决方案

### 3.1 终态（先看行为，再看机制）

**使用者视角：三个收口都零行为变化。** 验收基准就是「与收口前逐命令一致」（§4 场景 A1/A3/A4 的比对法）。

**维护者视角的终态走查**（三条线各一个场景）：

- **改帧语法**（例如给响应帧加一个字段）：只改 `lib/frame-codec.js` 一处 + `test/frame-codec.test.js` 的单元锚。`daemon-socket.js` / `cli-client.js` / 各测试 import 同一源，无第二处可漏。两处头注的「帧协议契约」段收敛为指向 frame-codec 的单点引用（S8 定论的「须两文件同步改」代价句删除）。
- **加一个 zsub action**（例如 `purge`）：在 `lib/zsub-actions.js` 的 action 表加一项（执行 = manager 调用或端口消费；错误 = throw 可操作消息；业务校验加在 manager 层——见 D4 的分层归属）。CLI 组参 switch 加 argv 翻译一行；daemon handler 与 CLI `--local` **查同一张表**，无各自实现可漂移。action 不存在的报错消息（「不支持的 action …支持：…」）由表自生成，名单不再手抄。
- **长期使用**：`records.jsonl` 稳态收敛在「活跃 run 事件全量 + 最近 1000 个终态 run」，daemon 重启恢复成本 O(活跃 + 1000×5) 封顶；超过 keep 的终态 run 从台账退场（其 `outputs/` 产物不受影响——那是独立目录，reaper 边界不动）。

### 3.2 多方案对比

#### 线 A：帧 codec 单源化

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A1：独立 `lib/frame-codec.js`**（encodeFrame + createFrameDecoder 导出；daemon-socket / cli-client / 测试 import） | 语法单源；传输层职责（listen/accept/锁/看门狗）留在 daemon-socket 不动——S8 的职责分离保持，只是「语法」从「传输层」里拆出来成为可 import 的最小面 | 新文件 ~80 行（从两处搬运合并）+ 两个生产文件接线 + 测试 replica 替换；同步更新两处头注的互指段 | 低：纯搬运合并，行为锚（半包/坏行/UTF-8 切分）已有现成回归测试 | ✅ |
| A2：daemon-socket 扩展导出（`module.exports = { startDaemon, encodeFrame, createFrameDecoder }`） | 不新建文件；但语法仍寄生在传输层模块上——client import daemon-socket 即拖入其 require 闭包；「测试 import 生产模块」的粒度也粗（测试只为 codec 却要面对整个模块面） | 最小（改一行导出 + 测试 import） | 低；但 S8 头注当初不导出的表述（「对外仅暴露 startDaemon」）被直接推翻而非精化，模块边界叙事变差 | ❌ |
| A3：维持现状，仅测试侧约定 replica 必须逐字复制 | 零改动 | 零 | 失败模式 A 原样保留；且「约定」无机械保障，69f71eb 已经演示过 replica 会语义漂移（丢半包） | ❌ |

**A2 被否的代价可感知化**：若用 A2，§3.1 第一个走查场景变成「改 daemon-socket.js 内的 codec」——语法演进仍与传输层同文件，`cli-client.js` import 传输层模块的关系与 S8 头注「客户端不复用它」直接冲突，头注叙事要改成「复用但只用 codec 符号」，依赖面比 A1 的独立最小模块宽。

#### 线 B：zsub action 面收口

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **B1：`lib/zsub-actions.js` 深模块**（action 表：name → exec(manager, params, ctx)；错误 = throw 可操作消息；两入口查表） | action 面单一深模块；两入口一致性由结构保证；校验单源于 manager 层；包装/拆包弯路与 wait 死分支一并清除 | 新文件 ~150 行（从两处 switch 提炼）+ `bin/zsw.js` / `dist/mcp/server.js` 接线改造 + `server.test.js` 相关面调整 | 中：触两入口主干，靠「行为零变化」比对验收兜底 | ✅ |
| B2：仅提取共享校验函数（不动分发结构） | 分发仍三份，失败模式 B 原样保留；只消了校验重复 | 小 | 低；但收口目标（两入口一致性）没达成，是安慰性改进 | ❌ |
| B3：收口到 bin/zsw.js（镜像 D-4/D-E3 对 zflow 的做法，server 反向 require） | 消除分发重复，但把「CLI 入口文件当共享库」的反向依赖再加厚一层（「zflow 面抽出」重构要拆的正是这个形态） | 中 | 方向与已识别的架构债（dist→bin 反向 require）同向叠加 | ❌ |

**B3 被否的代价可感知化**：若用 B3，§3.1 第二个走查场景里 daemon handler 变成 `require('../../bin/zsw.js')` 查表——zsub 线复制 zflow 线的反向 require 形态，「zflow 面抽出」重构（依赖方向正转）落地时要拆两份而不是一份。

#### 线 C：record compact

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **C1：keep-N 整 run 截断**（daemon 角色确定后按 run 分组，活跃 run 事件全保 + 终态 run 按最新事件 ts 取前 N，其余 run 的行整体删除；temp + rename 原子重写） | 删行后文件 = 原事件流的**行子集**，仍是完全合法的事件流——旧代码（升级窗口内的旧 daemon / 任何版本）重放行为可精确推理，零新语法、零迁移；interface 完全不动（D-E4「暂不下沉」裁决内） | `record-store.js` 内一个 `compact({keep})` 方法 ~60 行 + 调用点两处判断 + 测试 | 中：文件重写引入并发窗口（§3.3 D9 专项处理） | ✅ |
| C2：快照折叠（新事件型 `snapshot`，终态 run 折叠为 1 行全量快照） | 压缩率最优（5 行→1 行）；但引入新事件型 = 新语法：旧代码 `applyEvent` 走 default 分支 skipped（已核实不炸，`record-store.js` default case 返回 bad → strict=false 计 skipped）——升级窗口内旧 daemon 对已折叠 run **索引不可见**（list 消失，数据还在文件里） | `applyEvent` 加 case + 快照生成（合并全部 patch 字段、endedAt/startedAt 保真）+ 兼容论证 | 高：快照生成的字段合并是新的出错面（生成错 = 重放后状态错，且静默）；升级窗口行为分叉要靠「插件升级必重启 zcode」论证兜底 | ❌ |
| C3：显式 `zsw compact` 子命令（不自动） | 并发面收窄（用户主动触发）；但封顶责任交给用户——忘记跑 = 失败模式 D 回归，且「无上界」问题的自愈性没有 | 小 | 低；但目标 3（成本有上界）达成度打折 | ❌ |

**C2 被否的代价可感知化**：若用 C2，§2.4 的恢复路径里 rebuild 会遇到两类行（事件/快照），每条 fold 规则都要双形态维护；且升级窗口内（旧 daemon + 新 CLI 已跑过 compact）旧 daemon 重启后 `list` 突然少一批任务——用户可感知的不一致，正是「同一 run 可见性取决于调用模式」批评的模式（架构审查已识别的 --local 拓扑问题）在 compact 线上复刻。C1 的行子集没有这个问题：任何版本的代码重放子集文件，得到的就是索引子集，不多不少。

**减法记录（准则 8）**：C1 相对 C2 砍掉了「快照格式」这个新机制；相对「每事件写后即 compact」砍掉了高频重写——compact 只在 rebuild 后（daemon 启动/接管）跑一次，稳态下文件已达上限则秒级跳过。

### 3.3 关键决策与权衡

**D1：帧 codec 以独立最小模块 `lib/frame-codec.js` 落地（选定）**
- **采用**：`encodeFrame(obj)` + `createFrameDecoder({ onBadLine })` 从 `daemon-socket.js` 原样迁出（Buffer 版完整状态机为唯一实现）；`daemon-socket.js` / `cli-client.js` / 构帧测试全部 import。`cli-client.js` 的宽容过滤（跳过无 `ok` 行、取首个响应帧）**留在 client 侧**——那是「单请求单响应」的 client 语义，不是帧语法。
- **被否**：A2（daemon-socket 扩展导出——语法仍寄生传输层，client 依赖面变宽）；A3（维持现状——失败模式 A 保留）。
- **证据**：S8 定论原文两处头注（§2.1 引述）；`daemon-socket.test.js:427-432` 自认留债注释；回归锚测试（半包 :401 起 / 坏行 :434 起 / 粘包三切 :458 起）已存在，迁移后直接复用。
- **效果**：目标 1 成立；S8 的「帧语法变更须两文件同步改」代价句被消除，「传输层 vs 客户端最小实现」的职责分离叙事保持（头注改写为「传输层留在本模块，帧语法单源在 frame-codec」）。

**D2：测试构帧分两类处理——协议 replica 删除，测试替身的简化解析可留（选定）**
- **采用**：`daemon-socket.test.js` / `server-daemon.test.js` 的 encodeFrame/decoder 副本改 import frame-codec（69f71eb 留下的债清偿）；假 daemon 测试（cli-client / cli-daemon-zsub / cli-workflow-daemon）构**响应**帧改 import `encodeFrame`。假 daemon 侧的「一行一解、粘包丢第二帧」**简化解析保留**并注释定性：它是测试替身对「CLI 只发单请求帧」已知输入的简化，不复制协议权威，不承诺解码一般性。
- **被否**：把假 daemon 也升级为完整 decoder——替身不需要一般性，升级是纯成本。
- **证据**：`test/daemon-socket.test.js:24-28` 头注已把「replica 仅作响应侧解析」与「生产 decoder 回归锚经传输层驱动」分得很清——本决策沿同一条线。
- **效果**：协议演进时测试侧零同步成本；回归锚形态（传输层字节级驱动）不退。

**D3：zsub action 面落 `lib/zsub-actions.js`，两入口查表（选定）**
- **采用**：action 表 `{ name: { exec(params, ctx, deps) } }`；exec 错误一律 throw 可操作消息（消息文本 = 现状各层消息，逐字保留）。`deps` 注入 `{ manager, waitHandler, ports }`——`ports` 承载非 manager 依赖（agents 的 resolver、models 的 modelRouter/allProviders）。`bin/zsw.js --local` 与 `dist/mcp/server.js` 的 zsub handler 都查这张表；「不支持的 action」错误消息由表键生成，**文本与现状 `server.js:244-248` 逐字一致**——生成式为 `'不支持的 action "${action}"。支持：' + 表键 join(' | ') + '。' + '恢复指引：action 必须取 inputSchema 中的枚举值。'`（含现状尾句；尾句是 MCP 面时代措辞、socket 面无 inputSchema，**文案修订不属于本设计**——零行为变化基准优先，A1/A3 验收比对覆盖）。CLI 组参 switch 保留（argv → params 翻译是 CLI 特有职责）。
- **被接管段逐段归属**（替换 `server.js:162-249` zsub 分支时，分支内每段的去向）：

  | 现状段（server.js） | 归属 | 说明 |
  |---|---|---|
  | nested 拒绝门禁（:145-149，`ZSW_NESTED` 检查防递归） | **留 daemon 入口包装层**，不进 action 表 | 进程级门禁先于一切 action 分发；项目 AGENTS.md 开发红线「嵌套调用防护」，丢失即违规 |
  | manager 未初始化检查（:151-153） | **留 daemon 入口包装层** | 表 exec 的契约前提（deps.manager 已就绪），守卫先于查表 |
  | start/list/status/cancel/message/close 直调段（:162-249 各分支主体） | **迁入 action 表 exec**（deps.manager 直调） | 逻辑与消息原样迁移 |
  | wait 分支（:182-185，lazy `createWaitHandler`） | **迁入 action 表**（deps.waitHandler，lazy 初始化保持在 daemon 侧装配） | wait 语义单点不动 |
  | agents 分支（:194-201：resolver 端口守卫 + `agentListView` 视图映射） | **迁入 action 表 exec**（deps.ports.agentResolver） | 非 manager 直调——表模型经 deps.ports 承载；视图拼装逻辑原样迁移 |
  | models 分支（:208-243：modelRouter/allProviders 端口守卫 + guidance 拼装 + `--all` 分支） | **迁入 action 表 exec**（deps.ports.modelRouter 等） | 同上 |

- **被否**：B2（只提校验——漂移面保留）；B3（收进 bin/zsw.js——反向 require 加厚，与候选「zflow 面抽出」方向相撞）。
- **证据**：D-4/D-E3 对 zflow 线的同类裁决先例（「防两入口漂移」目标一致，但落点选 lib 避免反向 require）；三份 switch 现状（§2.2）。
- **效果**：目标 2 成立；`start` 的 wait 参数两入口有意分叉（daemon 不传 / `--local` 恒 true）**显式保留**——分叉点从「两处实现各自写」变为「两入口各传各的参数、exec 单一」，有意分叉在调用点可见。**`--local` 入口查表但保持现状可用的 action 子集**（start/list/status/message/cancel/close）——agents/models/wait 在 `--local` 维持「未知子命令」现状输出（两入口能力面差异是既有现状，零行为变化基准下不收口；由入口侧在查表前过滤实现）。

**D4：校验分层归属声明——现状三层全保留，新增 action 的校验单点进 manager 层（选定）**
- **采用**：现状三层各自服务不同失败面，全部原样保留：① CLI `usage()`（`bin/zsw.js:828/:1029`，argv 层快速用法提示——缺参时打印用法，不组装 manager 即可报错）；② daemon 面 handler 前置校验（`server.js:173-175` message text 等，迁移后随 exec 原样保留在对应表项内）；③ manager 入口校验（`manager.js:117-142/:343-388`，业务权威层）。**收敛的是增量**：新增 action 的业务校验只加 manager 层（一处），action 表与两入口不加自己的校验副本——「加 action 只动一处 + manager」由结构保证。
- **被否**：删除 `:828/:1029` 或 `:173-175`（本设计 R1 前版本的方案）——`:828/:1029` 正是「缺参打印 usage」的实现，删除后缺参输出从 usage 变 manager throw 消息，是使用者可见的输出变化，直接违反 §1 目标 4「零行为变化」基准（A1 逐行比对会 FAIL）。该方案被「零回归优先于校验去重」的基准击穿，记入被否谱系。
- **证据**：`bin/zsw.js:828`（`if (!args.task || !args.slug) usage();`）与 manager 校验消息原文（§2.2 引述）；两入口缺参输出现状即 A1 基线的组成部分。
- **效果**：校验不增不减（现状保留、增量单点）；错误消息零变化；「重复校验」的漂移面在增量维度关闭。**已声明的边缘对齐**：`--local` 的 status/cancel/close/message 不带 `--id` 时，错误消息从收口前的 manager 层劣质形态（`subagent "undefined" 不存在`——undefined 被拼进用户消息）变为表内前置校验的可操作形态（「缺少必填参数 subagentId…」，与 daemon 路径现状逐字一致）——这是 D3「前置校验随 exec 保留在表项内」的结构必然，两入口语义对齐正是目标 2 的达成方向，属有意变化非回归。

**D5：删除 okContent/unwrapContentResult 对，handler 直返业务对象（选定）**
- **采用**：`buildToolHandlers` 的 zsub/zflow 各分支直接 `return` 业务对象（错误直接 throw，由 daemon-socket dispatch 统一映射 `ok:false` 帧——该映射现状已存在，`daemon-socket.js:371-372`）；`buildDaemonHandlers` 的 unwrap 包装层随之删除（两函数合并为单一 daemon handler 构建）。`errContent` **保留**：MCP 面 `dispatchToolCall` 拒绝路径（server.js:437-441）仍消费它。`okContent` 删除（唯一消费者是 unwrap）。
- **被否**：保留包装对「以备 MCP 面复活」——MCP zero-tool 是 D1 终态决策，为已死协议保留管道违反减法原则；真要复活时 content 包装属于 MCP 传输层适配，届时在 MCP 面边界重新引入才是对的层。
- **证据**：帧负载已是业务裸 result 的两端代码证据（§2.2：server.js:390 unwrap 在落帧前 + cli-client.js:60-63 只剥 id）；适配器头注自认「content 包装对 CLI 是泄漏」。
- **效果**：失败模式 C 消除；daemon 内部管道少两跳；**socket 线上协议零变化**（帧形态前后逐字节一致——验收 A1 帧级比对）。

**D6：删除 CLI `--local` message 的整段不可达内联（选定）**
- **采用**：`bin/zsw.js:1064-1076` 的 busy 早退分支与 `await pending.catch(...)` 段**一并删除**——两者在 `--local` 入口均不可达（`--local` rebuild 后非终态全标 lost，busy 闸要求 running/created，见 §2.2 修正后的事实链）。删除后 `--local` message 收敛为纯错误路径，可达输出与现状完全一致（三类 throw：id 不存在 / 非 conversation / 状态非 idle——由 `manager.message` 原样提供）。P3 冷续聊回归时的重建方向：续聊 wait 语义统一走 `lib/wait-handler.js`（daemon 面）——本删除正是「wait 语义单点」的完成态，P3 回归不再回接 CLI 内联实现。
- **被否**：保留 busy 早退分支作可达路径（本设计 R1 前版本的方案）——被 `--local` 视角状态域击穿：rebuild 标 lost 后内存态不含 running/created，busy 闸永不命中，保留 = 保留另一段死代码（与本设计清死分支的目标自相矛盾），记入被否谱系。保留死分支作 P3 锚——P3 的正确锚是 wait-handler 的接口与测试，不是不可达代码。
- **证据**：`manager.js:359`（busy 闸条件）与 `:380-388`（续聊线移除 throw）；`record-store.js:147-149`（非终态标 lost）；`bin/zsw.js:1009-1014`（`--local` rebuild 注释自认视角状态）。
- **效果**：`--local` message 行为 = 三类 throw（与现状可达路径逐字一致，验收 A9 比对）；wait 语义单点化落在 wait-handler。

**D7：引擎收口三份不动（显式裁决）**
- **采用**：`server.js:699-715`（stdin end 钩子）/ `assemble.js:177-186`（runner 收割组合）/ `bin/zsw.js:606-616`（exitAfterEngineShutdown）维持现状。
- **被否**：抽「优雅退出」共享层——三处触发点与兜底语义各有真实差异（§1 out-of-scope 论证），抽象层收益低于扰动。
- **证据**：三处头注各自的职责注释（B4 侦查）。
- **效果**：scope 收敛；「统一 run 台账」与「zflow 面抽出」落地时若确需统一再评估。

**D8：record compact = keep-N 整 run 截断 + temp/rename 原子重写（选定）**
- **采用**：`RecordStore.compact({ keep })`：按 `subagentId`（事件首字段 `subagentId` 或 `id`）分组 → 活跃态（非 `TERMINAL_STATUSES`，含 `lost`）run 的行**全部保留** → 终态 run 按组内最后事件 `ts` 降序取前 `keep` 个保留 → 其余 run 的行删除 → 剩余行按原文件顺序写 `${filePath}.compact-${process.pid}.tmp`（同目录保证同文件系统，pid 后缀防多进程 temp 互踩）→ `fs.renameSync` 原子替换 → 返回 `{ removedRuns, removedLines, keptRuns }`。**不在内存索引的行组**（created 行损坏导致重放全 skipped 的孤儿行）：保守保留并跳过（无法判态，删错 = 丢可能在跑的 run；占比极小）。**触发点 = daemon 角色确定后**：`server.js` main 序列的 `manager.recover()`（:581）位于 startDaemon 竞选（:646）**之前**且 standby 实例同样执行——compact **不得**挂在 recover 之后；正确挂点是「startDaemon 角色确定后判 `role==='daemon'`」与「`onTakeover`（:656，再 recover 之后）」两处（实施期按 startDaemon 实际回调形态接线，索引此时已由前面的 recover/rebuild 建好）。`ZSW_RECORD_KEEP` env（正整数，缺省/非法回落 `1000`，非法值 stderr 警告——对齐 `ZSW_STATE_KEEP` 的 `resolveStateKeep` 家族语义）。
- **被否**：C2 快照折叠（新语法 + 升级窗口行为分叉 + 生成出错面，§3.2 已否）；C3 显式子命令（封顶责任外推，目标 3 打折）；挂在 `manager.recover()` 后（本设计 R1 前版本的方案）——被 server.js 实际结构击穿：该调用在竞选前且 standby 也跑，挂此 = standby 并发 compact（temp 互踩 + 复查盲区），或挂 onTakeover 则首竞选 daemon 永不 compact，两处字面挂点均不成立，记入被否谱系。
- **证据**：截断子集的合法性 by construction（每行独立 JSON，删任意行集不影响保留行重放）；`pruneWorkflowState` 先例（同族 keep-N 语义、单调用点论证）；server.js main 序列与 standby 初始化的实际顺序（审查 R1 核实）。
- **效果**：目标 3 成立；`~/.zcode/zsw/records.jsonl` 稳态 ≤（活跃 + lost 遗留 + 1000 终态）× 每任务事件数。**已知缺口声明**：lost 态 run 属活跃语义（可能被探活纠正回）永不淘汰，而 `manager.recover` 每次重启为每条 lost run 追加 update 落盘（manager.js:492-506）——崩溃遗留的 lost run 行数随重启次数线性增长且不在 keep-N 控制内。接受理由：产生前提是「崩溃遗留 + 用户不清理」，正常使用不产生，量级远小于终态主项；lost 语义的重构属于候选「统一 run 台账」（`zsw-manager-convergence.md` 立案）的范围，本设计不越界处理 manager 侧写入行为。interface（create/transition/update/append/get/list/rebuildFromLog）零变化——D-E4「暂不下沉」裁决完好。

**D9：compact 的多进程并发语义 = daemon 单属主 + 乐观检测 + 失败模式兜底（选定）**
- **采用**：三层防线。① compact 只在 daemon 角色确定后执行——「单属主」由**挂点**保证（D8：角色确定点 + onTakeover，standby 不挂；`--local` 的 rebuild 不 compact）：daemon 是常态唯一写者，recover 到 compact 同步串行，同进程无并发；② 重写用「读 → 记录读取时 size → 变换 → 写 temp（pid 后缀唯一名）→ **stat 复查原文件 size 与记录值相等** → rename」——复查发现原文件 size 不等（并发 append 变大，或他者进程 compact 已 rename 缩小）则**放弃本次 compact**（删除自己的 temp、stderr 日志一行、下次启动再试）；③ 残余微窗（复查点与 rename 之间的新 append）的失败模式 = 该行丢失 → 下次 rebuild 该 run 因引用缺失/坏行计入 skipped——与既有「尾部截断防御」（record-store.js:125-151 注释）同一错误类别，**不产生新炸点**，daemon 索引少一个 `--local` 写入的 run。
- **被否**：跨进程文件锁（每 append 过锁——为毫秒级窗口给所有写路径加常驻开销与复杂度，违反减法）；「compact 期间冻结 --local」（需要跨进程通知机制，同罪）。
- **证据**：`--local` 是调试后门的低频定位（bin/zsw.js 头注）；daemon 角色确定后立即 compact，与 `--local` 并发的窗口为毫秒级且方向单一；OCC 放弃路径幂等（下次启动重试）；temp pid 后缀消除多进程半成品互踩。
- **效果**：并发正确性不靠概率——常态路径 by construction（挂点保证单属主 + 单写者串行），异常路径有检测（size 双向复查）与兜底（skipped 类别既存防御），最坏后果有界且可自愈（丢失 run 下次可见性 = 该 run 自己的 skipped，不污染其他 run）。
- **诚实声明**：③ 的微窗在 POSIX 无锁文件操作下无法彻底闭合（除非引入 D9 被否的锁机制）。本设计接受它的理由：触发前提是「`--local` 在 daemon compact 的毫秒窗内恰好 append」+ 后果是「该 run 从索引消失（文件行也可能没了）」——后者与崩溃截断尾部同级，且 `--local` 的产出（任务结果 stdout 已打印、outputs/ 产物在独立目录）不依赖 records.jsonl 存活。

### 3.4 探针清单

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P-frame | codec 迁移后 daemon/client 往返行为不变（半包/坏行/UTF-8 切分/粘包） | 既有回归锚（daemon-socket.test.js 传输层字节级驱动组）迁移后原样跑绿 + 新增 frame-codec 单元锚（decoder 直接 push 驱动） | ⛔ U1 完成前 | 失败 → 迁移回退（git revert 单元），对照 diff 找语义漂移点 |
| P-roundtrip | D5 后 socket 帧逐字节一致（业务对象 → 帧） | 收口前后同命令帧捕获比对（`--local` 与 daemon 各跑一遍，diff 帧文本） | ⛔ U2 完成前 | 失败 → 定位 handler 返回形态差异（如 undefined 字段往返语义），修正后重比 |
| P-compact-equiv | compact 后 rebuild 等价（保留 run 的索引/顺序一致） | 预置混合台账（活跃+终态>keep）→ compact → rebuild → 与 compact 前的保留子集索引逐字段比对 | ⛔ U3 完成前 | 失败 → compact 行分组/排序逻辑修正；不影响其他单元 |
| P-occ | D9② 放弃路径真实可走（含双向复查：并发 append 变大 + 他者 compact rename 缩小两种检测面） | 测试内双进程（或同进程模拟并发 fd）：compact 读文件后、复查前追加一行 → 断言放弃 + temp 清理 + 日志留痕；再造「复查前他者已 rename 缩小文件」形态 → 同样放弃 | ⛔ U3 完成前 | 失败 → 放弃路径修复；若 stat 复查粒度不够（mtimeNs 需要），升级为 size+mtime 双检 |
| P-mount | D8 挂点单属主：standby 实例不触发 compact、首竞选 daemon 与接管路径都触发 | 预置超阈值台账（临时 ZSW_ROOT）后双 MCP server 进程并发启动，观察 stderr：仅 daemon 角色出现 compact 日志行；随后 kill daemon 进程 → standby 看门狗接管（onTakeover）→ 超阈值场景下接管路径同样出现 compact 日志行 | ⛔ U3 完成前 | 失败 → 挂点接线错位，回到 startDaemon ready 判 role 处重接 |
| P-atomic | rename 原子性前提（temp 与目标同文件系统） | by construction：temp 写在 `${filePath}.compact-${process.pid}.tmp`（同目录 + pid 后缀）| 无需探针（结构保证） | — |
| P-keep-env | `ZSW_RECORD_KEEP` 家族语义（正整数生效/非法回落+警告） | 单元级（对齐 resolveStateKeep 既有测试形态） | ⛔ U3 完成前 | 失败 → 直接修，无方案影响 |

## 4. 验收（真实场景，非单测）

改动规模：大（三线结构收口，触两入口主干与存储层）。验收基准 = **行为零变化 + 上界达成**，以下场景全部真实执行（真实 daemon、真实文件系统、真实 CLI 进程），单测仅作回归辅助不计入验收。

| # | 场景（谁/上下文/做什么/看到什么） | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| A1 | 维护者在插件目录验证 CLI 双路径不回归 | `node bin/zsw.js list`（daemon 往返）与 `node bin/zsw.js list --local` 各跑一遍；再各跑 `agents`、`models`；对照收口前同命令输出 | 全部命令成功，stdout 与收口前逐行一致（错误消息文本亦一致——用 message 拒绝路径各验一条：`message --id sa-nonexist --text x`） | 目标 4 |
| A2 | 维护者验证帧语义回归锚不退 | `node --test test/daemon-socket.test.js test/cli-client.test.js`（含半包/坏行/UTF-8/粘包锚）全绿；grep 测试目录确认 encodeFrame/createFrameDecoder 的手写副本已删（假 daemon 替身简化解析除外，见 D2） | 测试绿 + replica 清零 | 目标 1 |
| A3 | 维护者验证两入口 action 面一致 | 对 start/status/cancel/close/message（拒绝路径）在 `--local` 与 daemon 两入口各执行一遍（start 用 `--wait` 真跑一个小任务，如 `--task "输出 ok" --slug acc-test`）；比对成功输出与错误消息 | 同一 action 两入口输出/错误语义一致；start 的 wait 分叉保持（daemon 路径返回启动态、`--local` 等终态——D3 显式保留项）；**缺参输出与现状一致**（`zsw start` 不带 task/slug 仍打印 usage——D4 保留项）；「不支持的 action」消息与现状逐字一致（表生成） | 目标 2、4 |
| A4 | 维护者验证 MCP 冒烟不回归 | 按 AGENTS.md 冒烟命令：initialize + notifications/initialized + tools/list 喂给 `dist/mcp/server.js` | `tools/list` 恒空、`tools/call` 拒绝消息含 errContent 文本（zero-tool 终态不回归） | 目标 4 |
| A5 | 用户长期使用场景的封顶验证 | 预置 `ZSW_ROOT` 指向临时目录，构造 1050 个终态 run + 1 个活跃 run 的 records.jsonl（fixture 生成器）；设 `ZSW_RECORD_KEEP=100`；启动 MCP server（daemon 角色确定后触发 compact——D8 挂点） | 文件收敛到 101 个 run 的行（100 终态 + 1 活跃）；daemon 日志含 compact 结果行（removedRuns=950）；`zsw list`（daemon）可见最近 100 终态 + 活跃 run；`zsw status --id <活跃 run>` 正常；被截断 run 的 status 返回「不存在」类错误（与从未存在过的 run 同消息） | 目标 3 |
| A6 | 用户重启后恢复等价 | A5 之后再次重启 daemon | rebuild 计数与 A5 compact 后状态一致（applied = 保留行数、records = 101）；list 顺序（startedAt 倒序）不变 | 目标 3 |
| A7（负面） | `--local` 不触发 compact | A5 场景后再造 1050 终态 + 1 活跃台账，跑 `node bin/zsw.js list --local` | `--local` 执行后文件**不变**（mtime/size 不变）；list 输出正常（rebuild 只读） | 目标 3（D9 单属主语义） |
| A8（负面） | compact 不删活跃/lost run | A5 的 fixture 里活跃 run 与 1 个 lost 态 run（created 后无终态事件）均处于文件中部（前后都是超龄终态 run） | compact 后两个 run 的全部事件行仍在文件中，status 可查、状态字段无损（lost 属活跃语义，D8 保真范围） | 目标 3 |
| A9 | wait 行为锚（验证缺口如实登记） | wait-handler 既有单测全绿（daemon 面 wait 唯一面）；`--local` message 三类可达错误路径实测：对不存在 id（id 不存在 throw）、对终态 run（状态非 idle throw）、对非 conversation run（非 conversation throw——fixture 用 conversation 字段缺失的终态 run 构造） | 三类输出的错误消息与收口前逐字一致（busy 早退与 await 段已删且本就不可达——D6）。**缺口声明**：busy/续聊的真实场景难以稳定构造（`--local` 视角状态域不含 busy），P3 冷续聊回归时补真实续聊场景验收 | 目标 2、4 |

## 5. 下一层拆分

### 实施路径（三个独立单元，任意序可并行；推荐 U1 → U2 → U3 串行，每单元独立验收后提交）

**U1：帧 codec 单源化**（线 A，~半天）
- 新建 `lib/frame-codec.js`：`encodeFrame` + `createFrameDecoder`（从 daemon-socket.js:67-104 原样迁出，含头注）+ `module.exports`。
- `lib/daemon-socket.js`：删内部实现改 import；头注 S8 段改写（「帧语法单源在 frame-codec；本模块只留传输层职责」）。
- `lib/cli-client.js`：`extractResponseFrame` 的解码基座改用 `createFrameDecoder`（宽容过滤语义保留在 client 侧包装，见 D1）；请求帧构造改用 `encodeFrame`；头注互指段改写。
- 测试：`daemon-socket.test.js` / `server-daemon.test.js` replica → import；三个假 daemon 测试的构帧 → import `encodeFrame`（替身简化解析保留 + 注释定性，D2）；新增 `test/frame-codec.test.js` 单元锚（decoder 直接 push 驱动：跨 chunk UTF-8 / 坏行 / 裸值 / 半包）。
- 验收锚：P-frame + A1 + A2。
- justification：风险最低、无行为变化、先做可为 U2 的 handler 改造提供稳定传输层基座。

**U2：zsub action 面收口**（线 B，~1 天）
- 新建 `lib/zsub-actions.js`：action 表（start/list/status/cancel/message/close/agents/models/wait——wait 挂 wait-handler；start 等直调 deps.manager，agents/models 消费 deps.ports——D3 归属表；「不支持的 action」表驱动消息与现状逐字一致）。
- `bin/zsw.js`：`--local` switch（:1027-1086）改查表；message 内联段（busy 早退 + await pending）整段删除（D6）；usage() 与组参校验原样保留（D4）。
- `dist/mcp/server.js`：zsub handler 的 **nested 门禁（:145-149）与 manager 未初始化检查（:151-153）留在入口包装层**（D3 归属表——进程级门禁先于查表）；`buildToolHandlers` zsub 分支（:162-249）改查表（分支内校验随 exec 原样保留，D4）；`okContent` 删除、`unwrapContentResult`/`buildDaemonHandlers` 包装层拆除，handler 直返业务对象（zflow 分支 :255-352 同步改返回形态，zflow 逻辑不动——scope 边界）；`errContent` 保留（MCP 拒绝面）。
- 测试：`server.test.js` 相关面调整（handler 表新入口形态 + nested 门禁/未初始化守卫的保留断言——丢了守卫测试仍绿是 D3 归属表的验收点）；`zsw` CLI 两入口行为比对测试（A3 场景的自动化版本：同一 action 两入口输出一致断言）。
- 验收锚：P-roundtrip + A1 + A3 + A4。
- justification：单独成单元是因为它触两入口主干，「行为零变化」的比对验收要独立成立；与 U1 解耦（action 面不碰帧语法）。

**U3：record compact**（线 C，~半天）
- `lib/record-store.js`：`compact({ keep })` 方法（D8 形态：分组/保活跃与 lost/keep-N 截断/孤儿行组保守保留/pid 后缀 temp + rename/size 双向复查放弃路径 D9）。
- `dist/mcp/server.js`：**compact 触发接线挂 daemon 角色确定点（startDaemon 后判 role==='daemon'）与 onTakeover 两处**（D8——不得挂 main 序列 `manager.recover()`（:581，竞选前、standby 也跑）之后）+ 结果日志；run 数 ≤ keep 时跳过。
- `lib/config.js`（或对齐 `resolveStateKeep` 所在处）：`ZSW_RECORD_KEEP` 解析（正整数/缺省 1000/非法警告回落）。
- 测试：新增 compact 单元测试（等价性 P-compact-equiv（含孤儿行组 fixture）/ OCC 放弃 P-occ（含他者缩小面）/ keep-env P-keep-env / 活跃与 lost 保真 A8 的单元版）。
- 验收锚：P-mount + P-compact-equiv + P-occ + P-keep-env + A5-A9。
- justification：独立单元因为它是唯一引入新运行时行为的线（尽管 interface 不动）；挂点接线依赖 server.js 侧 ready 返回值判 role + onTakeover 的实测（P-mount 单独成探针），独立交付可回滚。

### 文件改动地图

| 文件 | 动作 | 单元 |
|---|---|---|
| `lib/frame-codec.js` | 新建（codec 迁出） | U1 |
| `lib/daemon-socket.js` | 改（import codec + 头注） | U1 |
| `lib/cli-client.js` | 改（解码基座 import + 头注） | U1 |
| `test/frame-codec.test.js` | 新建 | U1 |
| `test/daemon-socket.test.js` / `test/server-daemon.test.js` / `test/cli-client.test.js` / `test/cli-daemon-zsub.test.js` / `test/cli-workflow-daemon.test.js` | 改（replica/构帧 import 化） | U1 |
| `lib/zsub-actions.js` | 新建（action 表） | U2 |
| `bin/zsw.js` | 改（--local 查表 + message 不可达内联整段删；usage 与校验原样保留） | U2 |
| `dist/mcp/server.js` | 改（zsub 查表 + 包装对拆除 + compact 触发接线；nested 门禁与前置校验原样保留） | U2/U3 |
| `lib/record-store.js` | 改（compact 方法） | U3 |
| `lib/config.js` | 改（ZSW_RECORD_KEEP 解析） | U3 |
| `test/server.test.js` | 改（handler 入口形态） | U2 |
| `test/zsub-actions.test.js` / `test/record-compact.test.js` | 新建 | U2/U3 |

不动：`lib/manager.js`（校验权威层原样）、`lib/wait-handler.js`（已是单点）、`lib/assemble.js`（引擎收口 D7 不动；pruneWorkflowState 不动）、`lib/reaper.js`、`lib/orchestration-host.js` 及 zflow 业务逻辑、`lib/core-ref.js`。

### 待验证检查点（诚实标注）

- ⛔ P-roundtrip 的「帧逐字节一致」比对基线：收口前需先固化当前帧捕获（实施期第一步，否则没有比对基准）。
- ⛔ `--local` 下 `start --wait` 与 daemon 下 `start` 的输出一致性口径：A3 通过标准里「wait 分叉保持」的具体输出形态以现状实测为准（实施期先录基线再比对）。
- D9③ 残余微窗：设计层面接受（论证见 D9 诚实声明），无实施期探针可闭合——若实施期发现 `--local` 并发 compact 的实际可构造复现，升级回设计重议（触发条件：P-occ 之外发现新的丢失行场景）。

## 变更历史

| 日期 | 事件 |
|---|---|
| 2026-09-02 | 初稿（三线收口：帧 codec / zsub action 面 / record 生命周期；来源为会话内架构审查的三候选，本文档自包含其问题定义） |
| 2026-09-02 | R1 修订（对抗审查 4 must-fix + 3 suggestion 全修）：①D6 修正——`--local` 视角 busy 早退同样不可达（rebuild 标 lost），整段内联一并删除；②D8/D9 修正——compact 挂点从「recover 后」改为「daemon 角色确定后 + onTakeover」（main 序列 recover 在竞选前且 standby 也跑），temp 加 pid 后缀、复查改 size 双向；③D4 重写——现状三层校验全保留（删 `:828/:1029` 会使缺参输出从 usage 变 manager 消息，违反零行为变化基准），收敛改为「增量单点进 manager 层」；④D3 补被接管段逐段归属表（nested 门禁/未初始化检查留入口包装层，agents/models 经 deps.ports 承载）；⑤D8 补 lost run 上界缺口声明与孤儿行组保守保留规则；⑥新增 P-mount 探针、A8 扩 lost run、A9 改三类可达错误实测 |
| 2026-09-02 | R2 修订（复审 1 must-fix + 3 suggestion 全修，R1 四项修复经源码核实闭合）：①§5 文件改动地图两行「校验删」改为「原样保留」（R1-D4 重写的执行层联动遗漏）；②D3「不支持的 action」生成式补现状尾句「恢复指引：action 必须取 inputSchema 中的枚举值。」并声明文案修订不属本设计（零行为变化基准）；③候选编号残留 5 处全改描述性；④P-mount 补 kill daemon 构造 onTakeover 接管步骤、P-atomic temp 路径带 pid 后缀 |
| 2026-09-02 | R3 修订（复审 0 must-fix + 1 suggestion + 2 info 全修，设计就绪）：①P-mount 第一段补「预置超阈值台账」前提（否则 compact 零成本跳过无日志，断言无从观测）；②「§3-C」锚点两处改「§3.2 线 C」；③「角色回调」措辞三处改实装形态（startDaemon ready 返回值判 role + onTakeover）。审查循环 3 轮收敛：4+3 → 1+3 → 0+1 |
