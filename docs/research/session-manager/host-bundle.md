# ZCode 桌面端 host bundle 逆向报告：tasks-index.sqlite 生命周期 / GUI↔host 通道 / host↔引擎关系 / meta_json

> 调研对象：ZCode.app（Electron）解包产物。
> 文件代号：`H` = `/tmp/zc-asar/out__host__index.js`（host 进程 bundle，2.2MB）；`M` = `/tmp/zc-asar/out__main__index.js`（Electron main）；`C1` = `/tmp/zc-asar/out__host__chunk-I75T2SQ3.js`（共享 chunk，zod schema + 服务描述符）；`C2` = `/tmp/zc-asar/out__host__chunk-B3PKELMK.js`（window-controller schema）；`R` = `/tmp/zc-asar/out__renderer__assets__styles-DIQgZMVI.js`（renderer 大 chunk）；`S` = `/tmp/zc-asar/out__scheduler__index.js`；`P` = `/tmp/zc-research/extracted/index.cjs`（从 app.asar 提取的 `out/preload/index.cjs`）；`Z` = `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`（引擎，app-server 模式）。
> 标注：【实测】= 锚点已逐条 `grep -cF` 验证非零；【推断】= 推理结论，待验证。
> 复核脚本：`/tmp/zc-research/scripts/verify_anchors.sh`（锚点逐条 grep 验证）；上下文切片工具 `/tmp/zc-research/scripts/ctx.js`。

---

## 1. 结论摘要

1. `tasks-index.sqlite`（`~/.zcode/v2/tasks-index.sqlite`，支持 `ZCODE_DATA_BASE_DIR` 覆盖）由 **host 进程**用 Node 内置 `node:sqlite` `DatabaseSync` 打开（WAL + busy_timeout=5000）；`tasks` 表 DDL + `ensureColumn` 渐进迁移均在 host。
2. GUI 的增删改查全部走 **Electron utilityProcess + MessagePort 直连 RPC**：main 用 `utilityProcess.fork(out/host/index.js)` 起 host，`AttachServicePort` 消息把 MessagePort 传给 host，preload 通过 `zcode:service-port` channel 把另一端交给 renderer；RPC 是 Theia 风格的 channel 多路复用（channel 名 `zcode-task` 等）。
3. `sess_<uuid>` 由**引擎 zcode.cjs 生成**：`sess_${crypto.randomUUID()}`——**UUIDv4，不是 uuidv7**（host 里的 uuidv7 用于别处）。host 的 `createTask` 调引擎 v4 `createSession` 命令拿 sessionId 后才写 tasks 表。
4. 改名 = host `renameTask`：sqlite upsert（`title_overridden=1`）+ 同步引擎 `renameSession` 命令；自动标题走 `applyAgentPatch`，**title_overridden=1 时忽略引擎标题**，互斥成立。
5. 归档/置顶/未读 = upsert 更新对应布尔列；**删除是软删（deleted=1）**，全库无任何面向 GUI 删除的 `DELETE FROM tasks`/VACUUM 物理清理（仅 legacy ACP 迁移内部有一条 DELETE）。
6. `searchable_text` 由 host 从引擎会话快照文本生成（assistant 只取最后一段文本，上限 200000 字符），在任务索引缺失重建、Claude 导入等场景写入。
7. 会话正文（messages）由**引擎**写入 `~/.zcode/cli/db/db.sqlite`；host 按 workspace spawn 引擎：`process.execPath [zcode.cjs, app-server, --stdio, --surface, desktop]`，env `ELECTRON_RUN_AS_NODE=1`，**每 workspace 一个进程、多会话复用**，非每 session 一进程。
8. renderer 侧还有 v4 订阅协议：topic `controller/workspaces` / `controller/tasks-index`，snapshot/delta 帧（`task.upserted`/`task.removed`），logEpoch+seq 恢复。
9. `meta_json` 写入方只有 host（`JSON.stringify(meta)`），字段全集来自 zod schema（taskId/traceId/title/.../target）。
10. scheduler 进程打开**同一个** sqlite 文件，但只建/写 `automations`、`automation_runs`、`off_peak_tasks` 表；不写 `tasks` 表。

---

## 2. 存储生命周期逐项

### 2.1 数据库打开与 DDL（谁建表）

- **结论**：host 进程内 `TaskIndexRepo`（minified 类）负责建库建表。路径解析链：`getDataBaseDir()`（`ZCODE_DATA_BASE_DIR` → 其他 env → homedir）→ `.zcode` → `v2` → `tasks-index.sqlite`。驱动是 Node 内置 `node:sqlite` 的 `DatabaseSync`，PRAGMA：`journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000`。
- **tasks 表完整 DDL**（`CREATE TABLE IF NOT EXISTS tasks (...)`，含列 workspace_key/workspace_path/workspace_identity/task_id/title/task_status/provider/mode/model/migration_source/forked_from_task_id/created_at/updated_at/unread_at/last_unread_at/pinned/archived/deleted/title_overridden/meta_json，PK=(workspace_key, task_id)，两个部分索引 WHERE deleted=0）+ `task_groups`/`task_group_members`/`task_group_view_node_orders`/`task_group_workspace_bootstraps` 同批创建。
- **渐进迁移**：`ensureColumn("tasks","title_overridden","INTEGER NOT NULL DEFAULT 0")`、`ensureColumn("tasks","searchable_text","TEXT NOT NULL DEFAULT ''")`、`ensureColumn("tasks","cron_automation_id","TEXT")`、`ensureColumn("tasks","off_peak_task_id","TEXT")`——即 searchable_text/title_overridden 等列靠 ALTER TABLE ADD COLUMN 补齐（还有一个 `acp_session_id` 列按需补，见 2.7）。
- **锚点【实测】**（H）：
  - `CREATE TABLE IF NOT EXISTS tasks (`
  - `ensureColumn("tasks","title_overridden"` / `ensureColumn("tasks","searchable_text","TEXT NOT NULL DEFAULT `
  - `getTasksIndexDatabasePath`（路径函数名注解 `s(Il,"getTasksIndexDatabasePath")`）
  - `PRAGMA busy_timeout = 5000`（3 处）
  - `node:sqlite` / `DatabaseSync`（各 3 处）
  - `getWorkspaceHash`（workspace_key 生成，见 2.2）
- **置信**：【实测】

### 2.2 workspace_key 与 task_id 生成规则

- **workspace_key**：`getWorkspaceHash(workspacePath, workspaceIdentity)` = `sha256( identity?.trim() || path ).digest("hex").slice(0,12)`——12 个 hex 字符。写入方与读取方（host/scheduler）实现一致。
  - 锚点【实测】（H）：`").update(Rhe(e,t)).digest("hex").slice(0,12)`（完整形态 `("sha256").update(Rhe(e,t)).digest("hex").slice(0,12)`，1 处）；scheduler 侧同构函数 `getTasksIndexDatabasePath` 文件内 `gu(...)`
- **task_id**：格式 `sess_<uuid>`。
  - **引擎侧生成【实测】**（Z）：`function Cl(e){return`sess_${e??crypto.randomUUID()}`}`（1 处）——`crypto.randomUUID()` 是 **UUIDv4**。同文件还有 `turn_${...}`、`evt_${...}` 同构函数。校验正则 `/^sess_[A-Za-z0-9._-]+$/`（Z 内 `sess_[A-Za-z0-9._-]` 2 处）。
  - **host 侧只消费不生成【实测】**（H）：`var Efe="sess_"` + `normalizeRepoSnapshotSessionId`（剥前缀用，1 处）。host 全文件 `sess_` 仅 1 处，即此函数；main/renderer 的 `sess_` 命中均为 `#sess_xxx` @提及语法或标题清洗（R：`ak(e)` 剥 `^#sess_[...]` 前缀）。
  - host bundle 内存在 uuidv7 实现（`s(x8,"uuidv7")`，48bit 时间戳+version 7+IETF variant，标准 UUIDv7），但**不用于 session id**——`sess_` 前缀的 id 只由引擎的 `crypto.randomUUID()`（v4）产生。【推断】uuidv7 用于 host 内部 commandId/requestId 等场景（`Oa(...)` 包装命令时可见 `host-services-${x8()}` 等）。
- **结论**：task_id = 引擎 v4 session id（UUIDv4）。GUI「创建会话」时序：renderer → host `createTask` → 引擎 `createSession`（返回 sessionId）→ host `syncTaskMeta` upsert 到 tasks 表 → 广播 `task_created`。
- **置信**：【实测】

### 2.3 创建会话（INSERT 路径）

- **结论**：唯一写入口是 `writeRecord(t)` 的 **upsert**：`INSERT INTO tasks (...) VALUES (@...) ON CONFLICT(workspace_key, task_id) DO UPDATE SET ...`（23 列全量；冲突时除 unread_at/last_unread_at 有条件逻辑外全部覆盖；`unread_at = CASE WHEN @write_unread_at = 1 THEN excluded.unread_at ELSE tasks.unread_at END`、`last_unread_at = MAX(...)`）。
- **createTask（ZCodeTaskService facade，host）流程**：
  1. v4 路径：`sendConversationCommandV4({envelope:{type:"createSession",sessionId:null,payload:{workspaceId, config:{provider/model/thought/mode}, runtimeModel?, mcpServers?}}})` → 引擎返回 sessionId；`readSession` 读回完整会话。锚点【实测】（H）：`type:"createSession",sessionId:null`。
  2. legacy 路径：`zcodeAgentService.createSession({...E,sessionTraceId:_l(),mode,model,thoughtLevel, ...automationId||deferPersistenceUntilFirstPrompt?{persistence:"deferred"}:{}, ...automationId?{titleGenerationEnabled:!1}:{}})`——**cron 自动化任务禁用标题生成**（`titleGenerationEnabled:!1`【实测】）。
  3. `buildMetaFromSnapshot`（快照→meta，含 provider:"glm"）→ `syncTaskMeta({meta})` → `writeRecord` upsert → `initializeGroupedTaskAtTop`（分组置顶初始序）→ 广播 `"task_created"`。
- **锚点【实测】**（H）：`INSERT INTO tasks (`（1 处）、`ON CONFLICT(workspace_key, task_id) DO UPDATE SET`（3 处）、`write_unread_at = 1`（2 处）、`buildMetaFromSnapshot`、`provider:"glm"`（4 处）、`initializeGroupedTaskAtTop`（3 处）、`"task_created"`（2 处）、`sendConversationCommandV4`（2 处）。
- **写串行化**：所有写经 `enqueueWrite`（每 workspace 一条写队列）【实测，6 处】；含删除/unread 的写包 `BEGIN IMMEDIATE` 事务。
- **置信**：【实测】

### 2.4 改名（title 更新 + title_overridden）

- **结论**：host `ZCodeTaskService.renameTask(params)`：
  1. `st(y,{title})`——内存 overlay 先行（乐观更新，`setOverlay`【实测】）；
  2. `Qr(y,{title, updatedAt:Date.now(), titleOverridden:!0})` → `updateIndexedTaskState` → store `updateTaskState({patch})` → `writeRecord` upsert（title_overridden=1 落库）；
  3. **同步引擎**：`sendConversationCommandV4({envelope:{type:"renameSession",sessionId:y.taskId,payload:{title:y.title}}})`，失败仅告警（「同步 task rename 到 v4 session store 失败，保留…」），不回滚 sqlite。
  4. 广播 task 列表变更。
- **自动标题与手动改名互斥**：
  - 引擎侧事件 `session_info_update`（title 由引擎生成）→ host `applyAgentPatch({patch:{title,...}})`；`applyAgentPatch` 内 `r = n.title_overridden !== 1; title: r && t.patch.title ? t.patch.title : o.title`——**title_overridden=1 时丢弃引擎标题**。
  - `updateTaskState`（GUI 路径）不受此守卫：`title: t.patch.title ?? l.title`（GUI 改名显式带 titleOverridden:true）。
  - 另有 `deriveTitleFromSnapshot`（索引缺失重建时从快照 title/首条用户消息推导标题）。
- **锚点【实测】**（H）：`async renameTask`（2 处）、`type:"renameSession",sessionId:y.taskId`、`updateIndexedTaskState`、`applyAgentPatch`（3 处）、`titleGenerationEnabled:!1`、`session_info_update`（2 处）、`deriveTitleFromSnapshot`（2 处）、`setOverlay`。
- **置信**：【实测】

### 2.5 归档 / 置顶 / 删除

- **结论**（全部经 `Qr`→`updateTaskState`→upsert，无专门的单列 UPDATE 语句）：
  - `archiveTask(y)`：`Qr(y,{archived:!0})` → 广播 `"task_archived"`；
  - `unarchiveTask(y)`：`Qr(y,{archived:!1})` → `"task_unarchived"`；
  - `setTaskPinned(y)`：`Qr(y,{pinned:y.pinned})` → `"task_unpinned"/"task_pinned"`；
  - `setTaskUnread(y)`：unread ? `unreadAt=Date.now()` : `clearTaskUnreadIfMatches`（带 `expectedUnreadAt` CAS 防丢失并发未读）→ `"task_meta_changed"`；
  - **`deleteTask(y)`：软删**。函数体仅三步：`st(y,{deleted:!0}); Qr(y,{deleted:!0}); Dt(y,E,"task_deleted")`。**不调用引擎 deleteSession、不删会话正文、不删文件**。
- **物理清理路径**：
  - `DELETE FROM tasks WHERE workspace_key = ? AND task_id = ?` **仅存在于 legacy ACP 迁移**（`migrateLegacyAcpTaskIds`：把 task_id 从旧 ACP id 迁到引擎 session id 时的行合并/删除），不是 GUI 删除路径。
  - 无 VACUUM（H 全文 0 处）。
  - `cleanupDeletedTaskGroupingReferences`：只为 `deleted=1` 的任务清 task_group_members/视图排序引用，不动 tasks 行。
  - **自动归档**：`archiveStaleTasks({olderThanDays})`——条件 `deleted=0 AND archived=0 AND pinned=0 AND unread_at IS NULL AND updated_at < ? AND task_status='completed'` → 批量 `SET archived = 1`。
  - 【推断】软删行的最终物理清理未在 H/M/S 中发现，可能依赖用户手动清目录或未来版本。
- **锚点【实测】**（H）：`async archiveTask`、`async unarchiveTask`、`async setTaskPinned`、`async setTaskUnread`、`async deleteTask`（3 处）、`DELETE FROM tasks WHERE workspace_key = ? AND task_id = ?`、`archiveStaleTasks`（2 处）、`task_status = 'completed'`、`SET archived = 1`（1 处）、`migrateLegacyAcpTaskIds`（2 处）、`async deleteTask(y){st(y,{deleted:!0})`（函数体开头，grep `deleteTask(y){st(y,{deleted:!0})` 可命中）。
- **置信**：【实测】

### 2.6 查询（GUI 列表三分类）

- **结论**：`queryTaskList({workspaceScopes, kind, search, sortBy, limit})`，WHERE 基线 `deleted = 0`：
  - `kind="pinned"` → `pinned = 1 AND archived = 0`
  - `kind="archived"` → `archived = 1`（归档优先于置顶）
  - 默认（timeline）→ `pinned = 0 AND archived = 0`
  - 搜索：`LOWER(title) LIKE ? OR LOWER(searchable_text) LIKE ?`，排序 `updated_at DESC, created_at DESC, task_id DESC`（或 created 优先）。
  - 搜索摘要：`buildSearchSnippets`（每命中 ≤140 字符 `normalizeSearchSnippetText`，前/后文窗口 20/72，最多 20 段）。
- **锚点【实测】**（H）：`queryTaskList`（2 处）、`pinned = 1","archived = 0"`、`LOWER(title) LIKE ? OR LOWER(searchable_text) LIKE ?`。
- **置信**：【实测】

### 2.7 searchable_text

- **结论**：由 host 生成，两个来源：
  1. **引擎快照**（主路径）：`buildSearchableTextFromSnapshot(e)`——遍历投影后消息的 text parts；**assistant 消息只取最后一段 text**，其余角色取全部；累计到 200000 字符（`NG=2e5`）截断。
  2. **Claude Code 导入**（legacy）：`buildSearchableTextFromMessages`（每条消息 content 全文拼接，上限同为 2e5）。
- **写入时机**：
  - 索引缺失按需重建（`Qr` 失败降级 `wn(await kr(y))` → `syncTaskMeta({meta, searchableText})`）；
  - Claude 导入 `persistImportedClaudeTask`；
  - `writeRecord` 中若调用方未传 `searchableText`，则**保留库中原值**（`n?.searchable_text ?? ""`）；传入时 `slice(0, B_e)`（`B_e=2e5`）。即常规 title/status 更新不会重算 searchable_text。
- **锚点【实测】**（H）：`buildSearchableTextFromSnapshot`、`B_e=2e5`、`NG=2e5`、`searchableText:t.searchableText`（syncTaskMeta 透传处）。
- **置信**：【实测】；「何时全量重算」中除上述两场景外是否有周期任务【推断：无】。

### 2.8 scheduler 与 tasks-index.sqlite

- **结论**：scheduler（utilityProcess，`out/scheduler/index.js`）内 `AutomationRepo` 与 `OffPeakTaskRepo` 的 `resolveDbPath()` 默认指向**同一个** `~/.zcode/v2/tasks-index.sqlite`，在该库建/写 `automations`、`automation_runs`、`off_peak_tasks` 表；对 `tasks` 表只有 `backfillOffPeakTaskMarkers` 类的 host 侧回填（`UPDATE tasks SET off_peak_task_id = (...)`，在 H），scheduler 本身 0 处 INSERT/UPDATE/DELETE tasks。多进程并发访问靠 WAL。
- **锚点【实测】**（S）：`getTasksIndexDatabasePath`、`AutomationRepo`（2 处）、`OffPeakTaskRepo`（2 处）、`controller/workspaces`。
- **置信**：【实测】

---

## 3. 通道协议（GUI → host）

### 3.1 进程拓扑与传输层

- **renderer → preload → main → host 全链路**：
  1. main `spawnHostProcess`（minified `oq`）：`utilityProcess.fork(BA, [], {serviceName, execArgv, env:{...ZCODE_PROCESS_LABEL,...}})`，`BA = join(import.meta.dirname, "../host/index.js")`。
  2. main 收到 host ready 后创建 `MessageChannel`，向 host 发 utilityProcess 消息 `{type:"attach-service-port", requestId, attachmentId, clientMode:"desktop-continuous", scope:{kind:"local"}}` + `[port2]`；同时 `webContents.postMessage("zcode:service-port", null, [port1])` 把另一端给 renderer。
  3. preload：`ipcRenderer.on("zcode:service-port", ...)` → `window.postMessage("zcode:service-port","*",[port])` 转交 renderer（remote 场景另有 `zcode:scoped-service-port` + `zcode:scoped-service-port-ready`）。
  4. host 收 `AttachServicePort` → `exposeServicesOnMessagePort`：在 MessagePort 上建 Theia 风格 ChannelServer（`new D4(d)`），按 channelName 暴露服务；renderer 侧 `createServiceDescriptor(name)→{channelName}` + `toService(multiplexer.getChannel(name))` 生成代理。
- **RPC 语义**：channel 多路复用 + JSON-RPC 式请求/响应/事件（Theia message-rpc 家族；`A4` 心跳/keepalive 1000ms、`O4` 日志层）。方法名即服务方法名，参数为普通对象（structured clone 序列化）。
- **服务 channel 名注册表【实测】**（C1 `PF` 对象）：`ZCodeTask:"zcode-task"`、`ZCodeAgent:"zcode-agent"`、`ZCodeSession:"zcode-session"`、`WindowController:"window-controller"`、`File:"file"`、`Terminal:"terminal"`、`Git:"git"`、`Broadcast:"broadcast"`、`Plugins`、`Subagents`、`OffPeakTask:"off-peak-task"` 等约 30 个。
- **renderer 拿到的 zcodeTaskService 是 host 侧代理**（`createControllerRoutedTaskService`）：`archiveTask/unarchiveTask/deleteTask/setTaskPinned/setTaskUnread` 被劫持改道 controller mutation 投影（本地或远程 source 统一路由），其余方法（`renameTask`/`listTasks`/...）直通真实服务。
- **锚点【实测】**：
  - （M）`BA=gt(import.meta.dirname,"../host/index.js")`、`[spawnHostProcess] forked host process`、`AttachServicePort,requestId`
  - （C1）`AttachServicePort:"attach-service-port"`、`ZCodeTask:"zcode-task"`、`WindowController:"window-controller"`
  - （P）`exposeInMainWorld("zcode"`、`Ve.ServicePort,t=>{let[n]=t.ports`（preload 转发处）；channel 表 `Ve={ServicePort:"zcode:service-port",ScopedServicePort:"zcode:scoped-service-port",ScopedServicePortReady:"zcode:scoped-service-port-ready",...}`
  - （H）`exposeServicesOnMessagePort`、`createControllerRoutedTaskService`、`la.attach({requestId` / `scope:{kind:"local"}`（attach 调用）
- **置信**：【实测】

### 3.2 任务相关方法与参数 schema

**直接服务调用（zcode-task channel，renderer→host）**——参数对象在 renderer 侧构造（R 实测调用形态）：

| 方法 | 参数 | 效果 |
|------|------|------|
| `createTask` | `{workspacePath, workspaceIdentity?, provider?, model?, mode?, thoughtLevel?, draftSessionId?, v4Create?, mcpServers?, automationId?, offPeakTaskId?, deferPersistenceUntilFirstPrompt?}` | 引擎建会话 + 索引 upsert，返回含 taskId 的 meta |
| `renameTask` | `{taskId, workspacePath, workspaceIdentity?, title}` | title + titleOverridden=1 + 引擎 renameSession |
| `archiveTask` / `unarchiveTask` | `{taskId, workspacePath, workspaceIdentity?}` | archived=1/0 |
| `deleteTask` | `{taskId, workspacePath, workspaceIdentity?}` | deleted=1（软删） |
| `setTaskPinned` | `{taskId, workspacePath, workspaceIdentity?, pinned}` | pinned 列 |
| `setTaskUnread` | `{taskId, workspacePath, workspaceIdentity?, unread, expectedUnreadAt?}` | unread_at CAS |
| `listTasks` / `listPinnedTasks` / `listArchivedTasks` | `{workspacePath, workspaceIdentity?}` | 三分类列表 |
| `listTaskList` | `{workspaceScopes, kind, search?, sortBy?, limit?}` | 分页搜索列表 |
| `getTaskSnapshot` | `{taskId, workspacePath, workspaceIdentity?}` | 单任务详情 |

（锚点【实测】R：`zcodeTaskService.archiveTask`、`zcodeTaskService.renameTask`；H：各 `async xxxTask` 方法名。）

**controller mutation（window-controller channel，经路由代理间接使用）**：
- `mutateTask({address:{taskId, workspacePath, workspaceIdentity?, remoteSessionId?}, mutation})`；
- mutation kind 全集（host `executeMutation` switch）【实测】（H：`case"archive":I.archived?await H.archiveTask`）：`pin{pinned}`、`archive{archived}`、`delete`、`mark-read{expectedUnreadAt?}`、`mark-unread`、`open`、`resume`（open/resume 为 no-op 透传）。**无 rename kind**——rename 永远走直接服务调用。

**v4 订阅协议（window-controller channel）**：
- `subscribeControllerV4({topic, visibility})` → `{ack:{subscriptionId, mode:"snapshot", logEpoch}}`；topic 枚举【实测】（C2/R/S）：`controller/workspaces`、`controller/tasks-index`；
- 帧格式：`{payload:{kind:"snapshot", snapshot:{...}}}` 或 `{payload:{kind:"deltas", deltas:[{op:"task.upserted",task}|{op:"task.removed",address}|{op:"workspace.upserted",workspace}|...]}, fromSeq, toSeq}`；断流恢复 `resyncControllerV4({subscriptionId})`、退订 `unsubscribeControllerV4({subscriptionId})`（锚点【实测】H：`op:"task.upserted"`、`subscribeControllerV4`、`resyncControllerV4`、`unsubscribeControllerV4`）。
- 底层还有引擎级 `subscribeSessionsIndexV4`（host→引擎，background 订阅 + 逻辑帧组装/故障恢复），host 用它聚合成 controller 投影。

**main↔host utilityProcess 消息类型注册表【实测】**（C1 `wF` 对象）：`init-local`、`connect-remote-workspace`、`attach-service-port`、`detach-service-port`、`dispose`、`broadcast`、`task-realtime-deliver`、`cron-run`、`off-peak-run`、`session-message-deliver` 等；host 侧 parentPort 消息经 zod 校验后分发（主循环含 `case nn.CronRun/nn.OffPeakRun/...`）。

**renderer↔main 原生 IPC channel（preload 暴露面）**：任务操作不走这些；仅窗口/系统能力，如 `zcode:select-files`、`zcode:open-in-editor`、`zcode:execute-desktop-command`、`zcode:get-device-id`、更新系列、`zcode:service-port` 等（P 中 `b`/`Ve` 常量表【实测】）。

- **置信**：【实测】（参数字段名以 minified 调用点还原，字段语义部分【推断】）

---

## 4. host ↔ 引擎（zcode.cjs）关系

- **进程模型**：`ZCodeAgentProcessManager` **按 workspace** 维护引擎子进程（`processesByWorkspaceKey`），非按 session。远程工作区（ssh/wsl/docker/server）在远端各起一份，本地 host 直连。
- **spawn 命令解析优先级**（`resolveDefaultZCodeAgentCommand`）：
  1. env `ZCODE_AGENT_SERVER_COMMAND` + `ZCODE_AGENT_SERVER_ARGS_JSON`（默认 `["app-server","--stdio"]`）；
  2. 开发路径 findUp `apps/zcode-cli/packages/cli/dist/zcode.cjs`；
  3. Electron 运行时内嵌：`process.execPath [zcode.cjs, ...spawnArgs]` + env `ELECTRON_RUN_AS_NODE:"1"`；
  4. 已部署二进制。
  桌面形态追加 `--surface desktop`（`applyPresentationSurfaceToCommand`）。生产实测：`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`（`node-bundle-meta.json`：entry zcode.cjs，source `apps/zcode-cli/packages/cli/dist/zcode.cjs`）。
- **协议**：引擎以 `app-server --stdio` 模式运行，JSON-RPC over stdio。host 的 `zcodeAgentService` 提供高层方法：`readSession`、`setModel`、`setThoughtLevel`、`createSession`（legacy）、`sendConversationCommandV4({envelope:{type,sessionId,payload,...}})`（v4 命令信封，含 CAS baseRevision/baseLogEpoch 校验——错误文案引用「10-protocol-spec §6.4」）、`subscribeSessionsIndexV4` 等。
- **引擎 v4 会话命令枚举【实测】**（Z）：`createSession`、`renameSession{title}`、`deleteSession{}`、`forkSession`、`compactSession`、`resumeSession`。**注意：host 的 GUI deleteTask 不调 `deleteSession`**——引擎命令存在但桌面删除止步于索引软删。
- **会话正文存储（谁写）**：
  - 引擎默认配置【实测】（Z）：`storage:{dir:"~/.zcode", sessionDbPath:"~/.zcode/cli/db/db.sqlite"}`；路径函数 `join(homedir(),".zcode","cli","db","db.sqlite")`。**会话 messages/turns 由引擎写 db.sqlite，host 不写正文**。
  - host 侧 legacy 快照路径：`~/.zcode/sessions/<workspaceHash12>/<taskId>.json`（`getLegacyTaskSessionSnapshotPath`，Claude 导入/旧版兼容用）。
- **锚点【实测】**：（H）`resolveBundledWorkspaceZCodeAgentCommand`、`ZCodeAgentProcessManager`、`app-server","--stdio`（3 处）、`ELECTRON_RUN_AS_NODE:"1"`（3 处）、`protocol-spec \xA76.4`（CAS 错误文案）；（Z）`function Cl(e){return`sess_${e??crypto.randomUUID()}`}`、`sessionDbPath:"~/.zcode/cli/db/db.sqlite"`、`".zcode","cli","db","db.sqlite"`。
- **置信**：【实测】

---

## 5. meta_json 写入方与字段全集

- **写入方**：唯一写入方是 host 的 `writeRecord`（`serializeMetaJson` = `JSON.stringify(meta)`）；读取方 `rowToMeta`（`gi`）用 zod `mf` schema 校验解析，非法时降级为基础字段对象。scheduler/引擎不写 meta_json。
- **字段全集**（zod schema `hT`，C1【实测】锚点：`migrationSource` 检索窗口内 `taskId:R,traceId:R,title:t.string(),titleOverridden:t.boolean().optional(),...`；第二形态同构）：
  - 必填：`taskId`、`traceId`、`title`、`workspacePath`、`createdAt`(int≥0)、`updatedAt`(int≥0)、`mode`
  - 可选：`titleOverridden`(bool)、`workspaceIdentity`、`workspacePurpose`("project"|"conversation")、`model`、`thoughtLevel`、`runtimeEpoch`(int≥0)、`provider`（枚举，本引擎固定写入 "glm"）、`migrationSource`（枚举，如 "claudeCode"）、`forkedFromTaskId`、`cronAutomationId`、`offPeakTaskId`、`unreadAt`(int≥0)、`status`("running"|"completed"|"error")、`lastError{code?,detail?,message,traceId?,taskId?,attribution?}`、`repairState{claudeNo...}`（Claude 迁移修复状态）、`target`（goal 投影：`{sessionID,targetID,objective,summaryTitle,status,tokenBudget,tokensUsed,timeUsedSeconds,time:{created,updated}}`，可 null）
- **冗余说明**：列 `cron_automation_id`/`off_peak_task_id` 同时存在于列与 meta_json（读取时 meta 优先、列回退：`n.data.cronAutomationId??e.cron_automation_id`）。
- **锚点【实测】**（H）：`serializeMetaJson`、`rowToMeta`、`buildMetaFromSnapshot`。
- **置信**：【实测】（repairState 内部子字段被 minified 截断，完整子 schema【未完全展开，影响低】）

---

## 6. 未解问题清单

1. **软删行的物理清理**：未发现任何对 `deleted=1` 行的定期 DELETE/VACUUM（仅分组引用清理）。是否由外部工具/未来版本处理——【未解】。
2. **uuidv7 的实际用途**：host 有标准 UUIDv7 实现，但 sess_ id 是 v4。uuidv7 用于哪些内部 id（commandId?）未逐一确认——【推断：内部信封 id】。
3. **引擎 title 自动生成时机**：`session_info_update` 由引擎在何时触发（首 turn 后？后台任务？）、`titleSource` 字段枚举全集——只确认协议存在，生成策略在 Z 内未展开——【未解（对插件影响低）】。
4. **Theia RPC 线上帧的精确二进制格式**（channel 多路复用帧头/心跳编码）：确认了架构（ChannelServer/`A4` 心跳 1000ms），未逐字节还原——对外部插件不必要（插件走 MCP，不走此通道）。
5. **`repairState` 完整子 schema**：minified 中段被压缩，仅见 `claudeNo...` 前缀——【未完全展开】。
6. **多窗口多 host**：每个 BrowserWindow 一个 host 实例（`windowHostProcessMap`），tasks-index.sqlite 多 host 并发写依赖 WAL+busy_timeout，未见跨 host 失效广播（一个窗口改名另一窗口如何实时刷新）——【推断：经 Broadcast channel 消息，未验证】。

---

## 附：对 session-manager MCP 插件的直接启示

1. **列会话** = 直读 `~/.zcode/v2/tasks-index.sqlite`（只读打开即可，WAL 支持多读）；三分类 kind 语义与 WHERE 条件照抄 §2.6；归档列表 `archived=1`（含 pinned），已删除行 `deleted=1` 默认应排除（也可提供 `--include-deleted`）。
2. **创建会话**：插件无法走 GUI 的 host RPC（utilityProcess 私有）；可行路径是 spawn 引擎 `zcode.cjs app-server --stdio`（或 `zcode` CLI）发 `createSession` v4 命令 + 首条 prompt——**必须带提示词**这一点与引擎「deferPersistenceUntilFirstPrompt / hasUserVisibleContent」逻辑吻合：无用户内容的会话可能不入列表（`d9e` 判断有用户可见内容才建索引）。
3. **改名**：双写——tasks 表 `title`+`title_overridden=1` 与引擎 `renameSession`。插件若只改 sqlite，引擎侧 title 仍会通过 `applyAgentPatch` 被 title_overridden 挡住（互斥保护成立），但引擎 db.sqlite 里的会话标题不变（恢复/导出场景不一致）。建议插件直连引擎执行 renameSession 后再改 sqlite，或接受只改索引。
4. **删除**：官方语义就是软删（deleted=1）；插件照做即可，与 GUI「删除」完全等价（引擎正文保留）。
5. **workspace_key**：`sha256(identity?.trim()||path).slice(0,12)`——插件列会话时需要同规则计算 key，或直接 group by 读出的 workspace_path。
