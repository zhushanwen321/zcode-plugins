# zcode session 管理机制调研（session-manager MCP 前置调研）

> 调研日期：2026-08-26。目标：为 zcode 开发 session-manager MCP 插件建立知识基座——让 agent 能
> ①列出全部会话（含归档、排除已删除，对标侧边栏）②创建会话（必带提示词，支持 skill/文件插入）
> ③删除会话 ④重命名会话。
>
> 方法：本机权威源交叉验证（ZCode.app v3.9.1 asar 解包逆向 + 引擎 zcode.cjs v0.16.5 静态分析 +
> 沙箱 app-server 活体探针 + 运行时双库只读查询），不靠网络搜索。
> 结论分级：【实测】= grep 锚点验证 / 活体探针 / SQL 实查；【推断】= 推理结论待验证。
>
> 详细子报告（锚点级证据）：
> - [engine-cli.md](./engine-cli.md)——引擎协议面、创建链路、part 表示法、改名/归档/删除实现（49 锚点全机器复现）
> - [host-bundle.md](./host-bundle.md)——tasks-index.sqlite 生命周期、GUI↔host 通道、host↔引擎关系（84 锚点全复核）
> - [renderer-and-db.md](./renderer-and-db.md)——GUI 能力矩阵、@/#/$ mention 表示法、双库交叉实测

---

## 0. 一句话总结

**zcode 的 session 是「双库双进程」架构：引擎（zcode.cjs）持有权威会话库 `~/.zcode/cli/db/db.sqlite`，
GUI host 进程自建侧边栏索引 `~/.zcode/v2/tasks-index.sqlite`；两者之间只有单向订阅流（引擎→host），
没有反向通知。外部 MCP 插件的可行集成面 = 直读索引库 + 引擎 app-server NDJSON 协议（list/create/send/rename 可走协议，
archive/硬删无协议通道只能直写 sqlite）。**

---

## 1. 三层进程架构与数据流

```
┌─────────────────────────────────────────────────────────────────┐
│ ZCode.app (Electron)                                            │
│                                                                 │
│  renderer ──MessagePort(Theia RPC)──┐                           │
│    │ zcode:service-port             │ channel: zcode-task 等     │
│    ▼                                ▼                           │
│  preload ──ipcRenderer── main ──utilityProcess.fork──► host      │
│                                        host 写 tasks-index.sqlite│
│                                          │ spawn (每 workspace 1 个)│
│                                          ▼                       │
│                              zcode.cjs app-server --stdio        │
│                                  (ELECTRON_RUN_AS_NODE=1)        │
│                                  权威写 ~/.zcode/cli/db/db.sqlite │
└─────────────────────────────────────────────────────────────────┘
```

- **host 进程**（`out/host/index.js`）：tasks-index.sqlite 的唯一写方（WAL + busy_timeout=5000，
  每 workspace 一条写队列串行化）；对 GUI 暴露 Theia 风格 channel 多路复用 RPC（服务名
  `zcode-task`/`zcode-agent`/`window-controller` 等约 30 个）。【实测】
- **引擎进程**：`process.execPath [zcode.cjs, app-server, --stdio, --surface, desktop]`，
  **每 workspace 一个长驻进程、多会话复用**。【实测】
- **数据流向**：引擎写 db.sqlite → 经 `sessions-index/<workspaceId>` v4 订阅主题推 delta 给 host →
  host 聚合投影后写 tasks-index.sqlite 并向 renderer 广播 `task.upserted/task.removed`。
  反向（GUI 归档/删除）只改 tasks-index，引擎无感知。【实测】
- 外部插件**搭不上 GUI↔host 的 MessagePort 私有通道**（utilityProcess 内部拓扑）；可用的是
  ①直接读写两个 sqlite 文件 ②自己 spawn 引擎 app-server 走公开 NDJSON 协议。

## 2. 双库结构与字段语义（核心事实）

| 维度 | tasks-index.sqlite（GUI 索引） | db.sqlite（引擎权威库） |
|------|------|------|
| 路径 | `~/.zcode/v2/tasks-index.sqlite` | `~/.zcode/cli/db/db.sqlite` |
| 写方 | 仅 host 进程 | 仅引擎进程 |
| 本机规模 | 601 行（139 workspace） | 5931 session / 29 万 message / 112 万 part |
| 范围 | **仅 GUI interactive 任务**（对标侧边栏） | 全部会话：interactive 607 + **subagent_child 5338** + fork/side_chat |
| 主键 | (workspace_key, task_id) | id |
| id 形态 | `sess_<uuid>`（透传引擎） | interactive=`sess_<uuid>`；子代理=`sess_subagent_agent_<uuid>` |
| 标题 | title + title_overridden(0/1) | title + title_source(default/first_input/generated/custom) |
| 归档 | archived 0/1（**真实归档状态在此**） | time_archived 列存在但**引擎零写入**（实测全 NULL） |
| 删除 | deleted 0/1（软删标志） | 无对应物（无 DELETE FROM session 语句，正文永不物理删） |
| 置顶 | pinned 0/1 | 无对应物 |

关键规则【实测】：
- `task_id` = 引擎生成 `sess_${crypto.randomUUID()}`（**UUIDv4**）。
- `workspace_key` = `(workspaceIdentity || "").trim() || workspacePath`（**明文路径字符串**）。⚠️ 勘误：host bundle 内确有 sha256-截12位函数（`getWorkspaceHash`），曾误判为 workspace_key 算法；运行时实测数据（tasks-index 中 workspace_key 为完整路径）与官方 restore 插件写入逻辑双重证明 tasks-index 用明文，hash-12 实际用于 legacy 快照目录名（`~/.zcode/sessions/<hash12>/`）。
- `project_id`（db.sqlite）= `proj_` + slugify(工作目录).slice(0,80)。
- provider 必须写 `"glm"`，否则任务被列表过滤（官方 restore 插件注释原话）。
- 改名互斥保护：tasks-index 侧 `title_overridden=1` 后 host 丢弃引擎自动标题；
  db.sqlite 侧自动标题带 CAS（`expectedTitleSources:["default","first_input","generated"]`）不覆盖 custom。

## 3. 用户需求逐项映射

### 3.1 列出所有 session（含归档，排除已删除）

| 方案 | 做法 | 对齐度 | 备注 |
|------|------|--------|------|
| A. 读 tasks-index（推荐） | 只读打开 sqlite，`WHERE deleted=0`，三分类照抄 host：timeline=`pinned=0 AND archived=0`、pinned=`pinned=1 AND archived=0`、archived=`archived=1` | 与侧边栏完全一致 | WAL 模式支持多读并发；搜索可复用 `LOWER(title) LIKE ? OR LOWER(searchable_text) LIKE ?` |
| B. 引擎协议 | spawn app-server 发 `session/list {includeArchived:true}` | 不完全对齐 | 读的是 db.sqlite：需自行过滤 subagent 子会话（roots 过滤基本有效：5338/5338 子会话都有 parent_id）；但 GUI 归档状态不在引擎库里（time_archived 全 NULL），**includeArchived 当前实际列不出任何归档会话** |

结论：列表以方案 A 为准（含归档天然正确）；方案 B 可作历史读取的补充。

### 3.2 创建 session（必带提示词 + skill/文件）

**为什么必须带提示词**【实测】：引擎是懒持久化——`session/create` 只建进程内记录不落库，
首条 prompt 才触发 `ensureSessionPersisted` INSERT；且 host 有 `hasUserVisibleContent` 门控，
无用户可见内容的会话不入侧边栏索引。「创建必带提示词」与引擎语义天然吻合。

**推荐创建路径**（B 为主、A 补索引）：
1. spawn `zcode.cjs app-server --stdio`（NDJSON 行协议，非 JSON-RPC 2.0，`jsonrpc` 字段会被拒；无握手连上即用）
2. `{"id":"1","method":"session/create","params":{"sessionId":null,"workspace":{"workspaceKey":<sha256 前12位>,"workspacePath":<绝对路径>},"persistence":"immediate","mode":"build"}}`
   - 注意：create 会阻塞等待**服务端→客户端请求** `session/requestRuntimePreferences`
     （应答 `{"nativeSearchEnhancementsEnabled":false}` 即可；或回错误码 `-32601`，引擎有默认值兜底）
3. `session/send {sessionId, content:<提示词>, attachments:[...]}` —— 这一步落库（session 行 + user message + parts）
4. **补写 tasks-index**（否则侧边栏看不到，见 §4 已知风险）：按官方 restore 插件同款 upsert 写入
   task 行（title 取首条输入截 60 字符规则或自定义、provider:"glm"、meta_json 按 host schema hT 字段全集拼）

**skill 插入表示法**【实测】：引擎无 skill 专属 part。两种形态——
- CLI/TUI `/skill <name> <task>` 展开为纯文本 prompt：「Use the skill named `<name>` … First call the `Skill` tool with name `<name>` …」+ 用户任务原文
- GUI 输入框 `$` 触发 skill mention，导出到 text 为 markdown 链接 `[$handoff](/Users/.../SKILL.md)`
- → MCP 创建时在提示词文本里内嵌同样指令即可（推荐抄引擎 `/skill` 展开模板，语义最正）

**文件插入表示法**【实测】：
- part 类型全集 13 种，**附件统一落 `file` part**（无独立 image 类型）：`{type:"file", mime, filename, url, source:{kind:"local_file",path,sizeBytes,sha256}, metadata:{artifactUri,...}}`
- 协议路径：先 `v4/attachment/begin→chunk→commit`（20MB 上限、512KB/块）拿 `ref`，再 send 时 `attachments:[{ref,fileName,mime,bytes}]`
- headless CLI 路径：`--attach <path>`（可重复），按扩展名推断 image/video/file，二进制经 artifactStore 转 `zcode-artifact://` URI

### 3.3 删除 session

**GUI 语义 = 纯软删**【实测】：host `deleteTask` 仅三步（内存 overlay → upsert `{deleted:true}` → 广播），
不调引擎 `deleteSession`、不删 db.sqlite 正文、无 VACUUM 物理清理路径。
→ MCP 照做：tasks-index upsert `deleted=1` 即与 GUI 完全等价。（引擎 `v4/command deleteSession`
只是关进程内记录，且要求 session 在该进程激活，对外部场景无用。）

### 3.4 重命名 session

GUI 是**双写**【实测】：① tasks-index upsert `title + title_overridden=1`（乐观 overlay 先行）；
② 同步引擎 `v4/command {type:"renameSession", payload:{title}}`（失败仅告警不回滚）。

MCP 推荐做法：
- 最小实现：只直写两库——tasks-index `title+title_overridden=1`；db.sqlite `UPDATE session SET
  title=?, title_source='custom', time_title_updated=now WHERE id=?`。两侧互斥守卫都会生效
  （host applyAgentPatch 尊重 title_overridden；引擎自动标题 CAS 尊重 custom），不会被打回。
- 保真实现：spawn app-server → `session/resume {sessionId}` → `v4/command renameSession` → 再补 tasks-index。
  成本高（resume 会物化整个会话进内存）；除非需要引擎事件流，不建议。

### 3.5 顺带能力（协议已探明，未来可加）

`session/list`（limit/搜索）、`session/read|messages`（读历史，需先 resume 激活）、`session/fork`、
`session/compact`、`session/setModel/setMode/setThoughtLevel`、`automation/*`（cron 任务）、
隐藏 CLI：`agent-server`（app-server 别名）、`hooks trust *`、`__internal-search`、`__zcode-plugin-host`。

## 4. 实现路径对比与推荐

| 路径 | 描述 | 优点 | 缺点/风险 |
|------|------|------|-----------|
| P1 纯直写双库 | 所有操作直接 node:sqlite 读写两个库（官方 restore-legacy-sessions 插件即此形态，零依赖 DatabaseSync） | 零常驻进程；实现简单；官方先例证明可行性 | ①新会话 GUI 运行中可能不实时出现（host 内存投影无感知，最坏重启后可见）②绕过引擎校验，message/part 契约要自己维护对 ③多写方 WAL 并发（busy_timeout=5000 缓解）④searchable_text 要自己拼 |
| P2 纯协议编排 | 全部操作 spawn app-server 走 NDJSON 协议 | 语义最保真（引擎生成 id/title/事件流） | ①create 链路复杂（requestRuntimePreferences 应答、模型物化可能联网）②rename/delete 要求会话在本进程 resume 激活（-32004）③**archive 无协议通道**，仍得直写库 ④每操作起进程开销大 |
| **P3 混合（推荐）** | list/delete/rename = 直写（P1 式，秒级无进程）；create = 协议 create+send（P2 式，保证 id/persistence 正确）+ 回填 tasks-index 行 | 各取所长：读操作零开销，创建语义保真，删除/归档与 GUI 等价 | 仍需处理 create 后侧边栏实时性（接受「下次刷新/重启可见」，或探测 host resync 时机） |

**推荐 P3**，插件形态照 workspace 惯例：目录 `z-session-manager/`，MCP server 单 tool 粗粒度 action
（`list/create/delete/rename`），stdout 只走 JSON-RPC、日志落 stderr + `~/.zcode/z-session-manager/`，
嵌套调用防护 env 标记，零依赖 plain Node CJS（node:sqlite 内置模块够用，restore 插件同款）。

## 5. 已知风险与未解问题

1. **create 后侧边栏实时性**：host 通过订阅引擎 sessions-index 主题增量维护索引，但那是它自己那个
   app-server 进程的事件流；我们 spawn 的进程写的库行不会触发它 resync。【推断】GUI 下次全量刷新
   （搜索/过滤切换/重启）时可见。待实测确认刷新时机；缓解：文档声明 + create 返回里给出 taskId 供用户手动定位。
2. **tasks-index 并发写**：host 用 busy_timeout=5000 + 每 workspace 写队列；我们的写也要包
   BEGIN IMMEDIATE + 重试，避免 SQLITE_BUSY。（官方插件先备份再 IMMEDIATE 事务，值得照抄。）
3. **版本升级脆弱性**：双库 schema 与协议均无公开契约（AGENTS.md 已知 help 漂移问题）；升级 zcode 后
   需跑冒烟探针（本调研的锚点速查表可直接当冒烟断言用）。
4. **引擎 time_archived 未使用**：若未来 zcode 版本把归档同步进引擎库，方案 A/B 的归档语义要对齐复查。
5. **沙箱 create 全链路未跑通**：模型物化阶段在无凭据沙箱挂起（疑似等网络重试）；renameSession/
   deleteSession 端到端止步于 envelope 校验与代码级 handler 链。P3 落地前需在有凭据环境补一次真实验证。

## 5. 探针验证结果（2026-08-26 实机全流程）

在真实环境（GUI 运行中 + 真实 GLM 凭据）跑通 list → create → rename → archive → unarchive → delete 全流程，每步经用户在 GUI 实际核对。

### 5.1 验证通过的完整创建配方（GUI 同款语义，唯一可行路径）

```
1. spawn node zcode.cjs app-server --stdio --surface desktop
   env 必须带 ANTHROPIC_API_KEY=<key>（从 ~/.zcode/v2/config.json
   provider['builtin:bigmodel-coding-plan'].options.apiKey 读取；
   引擎 resolveApiKey 对 anthropic kind 的 env 回退通道，信封注入不可靠）
2. workspace/upsertModelProvider { workspace:{workspaceKey,workspacePath},
   provider:{providerId:'builtin:bigmodel-coding-plan', kind:'anthropic',
             baseURL, models:[{modelId:'GLM-5.3'}]} }   ← 不带 apiKey 字段
3. v4/command { commandId, clientId, sessionId:null, type:'createSession',
   payload:{ workspaceId:<路径>, firstInput:{text:<提示词>, attachments:[]},
             config:{ mode:'build' } }, issuedAt:Date.now() }
   ← sessionId 从 result.sessionId 取；回合自动开始（delivery:startNow）
4. 等待完成：轮询引擎库 assistant 的 text part 出现（勿用 session/list 轮询，有竞态）
5. session/close { sessionId }
6. 回填 tasks-index 行（restore 插件同款 upsert；meta_json 按 host zod schema hT 全字段：
   taskId/traceId/title/titleOverridden/workspacePath/createdAt/updatedAt/mode/
   model/thoughtLevel/provider/status）
```

### 5.2 关键实证结论（修正/补充 §3 与风险清单）

| # | 结论 | 级别 |
|---|------|------|
| 1 | 协议层 `session/create` + `session/send` 是死路：create 只建进程内记录，send 被接受但回合不执行、永不落库。**必须走 v4/command createSession 携带 firstInput** | 【实测】 |
| 2 | v4 `sendText` 发给未持久化会话报 FOREIGN KEY constraint failed——持久化挂在 v4 网关路径上 | 【实测】 |
| 3 | apiKey 信封 `{source:'inline'}` 注入后认证失败（401）；env 变量回退可靠。curl 双形态验证 key 本身 x-api-key/Bearer 均有效，问题在引擎侧解析 | 【实测】 |
| 4 | **侧边栏可见性：分组模式下回填索引行即时生效（无需重启）**；项目模式只渲染当前打开项目的任务（GUI 本身范围语义）。调研风险①解除 | 【实测】 |
| 5 | 改名双写：侧边栏标题即时更新；会话内标题跟随引擎进程内存态，重启该工作区引擎后才同步（外部进程无法触发 GUI 引擎实例的 titleUpdated 事件） | 【实测】 |
| 6 | archive/unarchive/delete 直写索引列：查询刷新后生效（重启/搜索触发重查即时）；无 delta 推送是预期边界（外部直写不产生广播） | 【实测】 |
| 7 | 自动标题管线对探针会话正常工作（turn 后 title_source 变 generated），rename 后置 custom 可永久锁定 | 【实测】 |
| 8 | task_id 幂等性：v4 createSession 每次生成新 sess_<uuid>；探针调试产生的空会话留在引擎库永不可见（不入索引即不存在于任何 UI） | 【实测】 |
| 9 | workspace_key 为明文路径字符串（勘误 §2 原 sha256 结论；bundle 内 hash-12 函数实为 legacy 快照目录名用途） | 【实测】 |

### 5.3 更新后的风险清单

- ~~风险① create 后侧边栏实时性~~ 已解除（§5.2 #4）
- ~~风险⑤ create 全链路未跑通~~ 已解除（§5.1 配方实测）
- 风险② tasks-index 并发写仍需 BEGIN IMMEDIATE + busy_timeout（探针全程未遇 SQLITE_BUSY，但样本量小）
- 风险③ 版本升级脆弱性不变；探针脚本可当冒烟用例（已归档 docs/research/session-manager/probe/）
- 新增边界：rename 的会话内标题同步依赖目标工作区引擎重启；如需强一致可在插件内文档声明或探索 resume+renameSession 协议补写（对 GUI 实例无效，仅自证）

## 6. 证据索引（快速定位）

完整锚点见三份子报告附录，最高频使用的入口：

| 要查什么 | 去哪 |
|----------|------|
| app-server method 全集 / envelope / 错误码 | engine-cli.md §2（锚点 `sessionCreate:"session/create"` 等） |
| v4/command 32 个命令 type（含 renameSession/deleteSession） | engine-cli.md §2.4（锚点 `renameSession:f.object({title:f.string()}),deleteSession:f.object({})`） |
| session 创建链路（id/slug/project_id/title/懒持久化） | engine-cli.md §3 |
| part 类型全集 / 附件 / skill 展开模板 | engine-cli.md §4（锚点 `S8e=f.discriminatedUnion("type"` / `No additional user request was provided. Load the skill`） |
| tasks DDL / upsert 语句 / 软删函数体 / 三分类 WHERE | host-bundle.md §2（锚点 `CREATE TABLE IF NOT EXISTS tasks (` / `deleteTask(y){st(y,{deleted:!0})` / `pinned = 1","archived = 0"`） |
| GUI 操作×RPC 方法矩阵 / createSession payload / mention 表示法 | renderer-and-db.md §1-§3（锚点 `quickPick.command.newTask` / `prompt-mention` / `attachmentBeginV4`） |
| 官方直写双库参考实现 | `~/.zcode/cli/plugins/cache/zcode-plugins-official/restore-legacy-sessions/0.1.0/skills/restore-legacy-sessions/scripts/restore-conversation.mjs`（648 行，upsert 保护/CAS/事务姿势全在里面） |
