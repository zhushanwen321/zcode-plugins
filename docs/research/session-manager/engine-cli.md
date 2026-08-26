# zcode 引擎 CLI（zcode.cjs）逆向分析报告

> 分析对象：`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`（12,491,401 字节，3258 行 minified CJS，v0.16.5，`apps/zcode-cli/packages/cli/dist/zcode.cjs` 打包产物）
> 分析方法：node 切片脚本（`/tmp/zc-research/scripts/engine/{ctx.js,grep-o.js}`）+ 沙箱 app-server 活体探针（`/tmp/zc-research/scripts/engine/probe*.js|sh`）。所有「锚点」均可直接 `grep -F` / node 脚本在文件中复现。
> 结论分级：【实测】= 源码定位或活体探针验证；【推断】= 由代码结构合理推断、未逐一跑通。
> 本机文件只读约束：所有探针经 `HOME`/`ZCODE_STORAGE_DIR` 重定向到 `/tmp/zc-research/fakehome` 沙箱；唯一直连真实库的探针（session/list）为读语义。⚠️ 诚实披露：SQLite 以 WAL 模式打开，探针进程退出时引擎可能对 `~/.zcode/cli/db/db.sqlite-wal` 做了 checkpoint（观测到 wal 文件 mtime 变化）；未做任何 DELETE/UPDATE/INSERT 语义的数据变更。后续探针均改走沙箱。

---

## 1. 结论摘要

| # | 结论 | 级别 |
|---|------|------|
| 1 | `zcode app-server` 是自定义 **NDJSON 行协议**（每行一个 JSON 对象），**不是 JSON-RPC 2.0**（`jsonrpc` 字段被 zod strict 拒绝）；envelope：请求 `{id, method, params, trace?}`、通知 `{method, params, trace?}`、响应 `{id, result}` / `{id, error:{code,message,data?}}`。无握手，连上即用 | 【实测】 |
| 2 | 协议有两层 method 面：`session/*`+`workspace/*`+`plugins/*`+`automation/*`+`usage/*`（rr 枚举，30+ 方法）和 `v4/*`（Dc 枚举：conversation 订阅/attachment 上传/command 通道）。**session 管理五件套的落点**：list=`session/list`（支持 `includeArchived`）、create=`session/create`、改名=`v4/command {type:"renameSession", payload:{title}}`、删除=`v4/command {type:"deleteSession"}`、发消息=`session/send` | 【实测】 |
| 3 | **协议层没有 archive/unarchive 方法**；`v4 deleteSession` 在 app-server 语境只「关闭进程内会话记录」，不删 db 行。引擎侧**没有任何代码写 `time_archived`**（`updateSession` SQL 支持该列但全库 0 个调用点传 `timeArchived`）；也无 `DELETE FROM session` 硬删语句。归档/真删只能由 GUI 侧直接操作 db.sqlite（【推断】） | 【实测】（负结论） |
| 4 | `session/create` 会触发**服务端→客户端请求** `session/requestRuntimePreferences`，客户端必须应答（或回 `-32601` 错误，引擎有默认值兜底）；`session/read`/`session/messages`/`v4/command` 只对**本进程内激活（create/resume 过）的 session** 有效，否则 `-32004 Session is not active` | 【实测】（探针验证） |
| 5 | session 行在 create 时**不落库**，首条用户 prompt / 外部活动时由 `ensureSessionPersisted` 懒 INSERT；id=`sess_`+UUIDv4（`crypto.randomUUID()`），slug=slugify(sessionId)，project_id=`proj_`+slugify(工作目录).slice(0,80)，title 初值=首条输入截 60 字符（空则 "Untitled session"），title_source 缺省 `first_input` | 【实测】 |
| 6 | part 类型枚举（13 种）：`text/reasoning/file/tool/step-start/step-finish/snapshot/patch/compaction/timeline/subagent/agent/retry`。**没有独立 image 类型**——图片/视频/PDF 统一落 `file` part（mime 区分）；`--attach` 按扩展名推断 `image`/`video`/`file`，二进制内容经 artifactStore 存为 `zcode-artifact://` URI，part.url 指向该 URI。skill 引用没有专属 part：`/skill X task` 展开为纯文本 prompt（指示先调 `Skill` 工具） | 【实测】 |
| 7 | 隐藏 CLI 面：`agent-server`（app-server 别名）、`hooks`（trust status/review/grant/revoke）、`__internal-search`（find/grep 内嵌搜索）、`__zcode-plugin-host`（插件 server 宿主）均不在 `--help`；另有 `automation/*` 协议方法（cron 任务体系） | 【实测】 |
| 8 | 双库关系：`~/.zcode/cli/db/db.sqlite` 是引擎权威存储；GUI 通过 app-server 的 `v4/conversation/subscribe` 订阅 `sessions-index/<workspaceId>` 主题（快照+delta：`session.upserted`/`session.removed`）获得实时索引，`~/.zcode/v2/tasks-index.sqlite` 是 GUI 侧自建索引持久化（引擎 bundle 中**无** `tasks-index.sqlite` 字符串，只有 `controller/tasks-index` 主题常量） | 【实测】+【推断】（GUI 落库细节属另一子任务） |
| 9 | 对 session-manager MCP 插件的直接含义：**list（含归档）可直接读 db.sqlite 或调 `session/list`；create+必带 prompt 需起 app-server 进程走 create+send；rename 需走 v4/command（要求 session 在该进程内激活）；archive/delete 引擎协议不支持，插件只能直写 sqlite（有 WAL 并发风险）或接受「仅引擎视角关闭」语义** | 综合结论 |

---

## 2. app-server 协议清单

### 2.1 启动与传输

| 项 | 内容 | 锚点（可 grep） |
|---|------|-----------------|
| CLI 入口 dispatch | `agent-server` 与 `app-server` 同 case，走 `M8i` | `case"agent-server":case"app-server":return await M8i` |
| 入口函数 | `M8i` → `runZCodeProtocolAgent`（`qcn`），stdin/stdout 直连 | `runZCodeProtocolAgent)({cwd:i,env:o,input:e.stdin` |
| 服务器类 | `MPe`（`ZCodeProtocolAgentServer`），持有 sessions Map、v4Gateway | `MPe=class{static{s(this,"ZCodeProtocolAgentServer")}` |
| 传输类 | `OPe`（`ZCodeProtocolNdjsonConnection`）：按 `\n` 切帧、逐行 JSON | `OPe=class{static{s(this,"ZCodeProtocolNdjsonConnection")}` |
| envelope zod | `MSt=f.union([kyn,Syn,Iyn,Tyn])`（请求/通知/成功/失败响应，均 `.strict()`） | `MSt=f.union([kyn,Syn,Iyn,Tyn])` |
| 服务端→客户端请求 | id 形如 `server-1`（`this.nextClientRequestId++`），客户端用 `{id, result}` 应答 | `let m=`server-${this.nextClientRequestId++}`` |
| 【实测】活体验证 | 无握手；`{"jsonrpc":"2.0",...}` 被拒：`-32600 Invalid ZCode Protocol message`（zod 报 `Unrecognized key: "jsonrpc"`）；未知方法 `-32601`；参数错 `-32602`（data 里带 zod issues 明细）；未知 session `-32004` | 探针输出见 §2.5 |
| 已知错误码 | `-32004` sessionUnavailable；`-32010` prompt 已在跑；`-32020/-32021/-32022` 客户端请求未挂起/取消/超时；`-32031` restoreWarning；标准 `-32600/-32601/-32602` | `YL={sessionUnavailable:-32004}`；`new Wa(-32010,"A prompt is already running` |

### 2.2 第一层 method（rr 枚举）

锚点（枚举定义处，line ~43）：`sessionCreate:"session/create",sessionResume:"session/resume"`

| method | handler | params schema | 说明 |
|--------|---------|---------------|------|
| `session/create` | `W4e` | `QSt`：`{sessionId?(仅 importedHistory), workspace{workspaceKey必填,workspacePath}, parentSessionId?, mode?, model?, runtimeModel?, persistence?("immediate"\|"deferred"), thoughtLevel?, titleGenerationEnabled?, mcpServers?, toolAllowlist?, toolDenylist?, importedHistory?}` | 先发 SRV→CLI `session/requestRuntimePreferences`；成功返回 session snapshot（k8e） |
| `session/resume` | `lsn` | `YSt`：`{sessionId, workspace?, runtimeModel?, thoughtLevel?, mcpServers?, toolAllowlist?, toolDenylist?}` | 会做 legacy remote workspace 修复；resume 后才可 read/send |
| `session/list` | `csn` | `XSt`：`{workspace?, includeArchived?(默认 false), limit?}`（缺省 limit=50, roots=true 只列根会话） | 【实测】直接读 sessionStore，不要求激活；含 in-process deferred 会话 |
| `session/subagents` | `H4e` | `eIt`：`{sessionId, endedCursor?, endedLimit?(默认20,max100)}` | 子代理树（parent=当前 session） |
| `session/read` | `dsn` | `nIt`：`{sessionId, deliveryKind?, messageLimit?, afterSeq?}` | 要求进程内激活，否则 -32004【实测】 |
| `session/messages` | `msn` | `oIt`：`{sessionId, afterMessageId?, limit?}` | 同上【实测】 |
| `session/events` | `fsn` | `iIt`：`{sessionId, afterSeq?, limit?}` | 事件回放 |
| `session/subscribe` | `hsn` | `KSt`：`{sessionId, deliveryKind?, afterSeq?, includeSnapshot?}` | legacy 流订阅 |
| `session/send` | `gsn` | `uIt`：`{sessionId, inputId?, queryId?, content, attachments?[], browserAmbientContext?, expectedRevision?, expectedProviderRevision?, expectedModelRuntimeRevision?, runtimeModel?, automationId?, offPeakTaskId?, offPeakRunType?, botDeliveryTarget?, toolDenylist?}` | attachments 为 `f.record` 透传（实际消费见 §4）；有 prompt 在跑则 -32010；返回 `{accepted:true, stateRevision, modelRuntimeRevision?}` |
| `session/stop` | `xsn` | `pIt`：`{sessionId}` | abort activeAbortController；顺带 pause 活动 goal |
| `session/cancelBackgroundTask` | `bsn` | `fIt`：`{sessionId, taskId}` | 取消 bash/subagent 后台任务 |
| `session/fork` | `vsn` | `lIt`：`{sessionId, target?(turn\|message\|checkpoint\|latestCheckpoint,默认 latest), expectedRevision?}` | 走 `forkFromCheckpoint`，返回 forkedSessionId |
| `session/compact` | `_sn` | `cIt`：`{sessionId, inputId?, instructions?, expectedRevision?, runtimeModel?}` | 等价 `/compact`，返回 `{response,snapshot,compact:{state}}` |
| `session/goal` | `ysn` | `dIt`：`{sessionId, inputId?, action(show/set/replace/pause/resume/clear), objective?, expectedRevision?}` | goal/target 管理 |
| `session/close` | `Csn` | `vIt`：`{sessionId, expectedPersistence?}` | 仅关进程内记录+app.close，不动 db |
| `session/setModel` | `wsn` | `hIt`：`{sessionId, model{providerId,modelId}, runtimeModel?, expectedRevision?, persistAsWorkspaceLastUsed?}` | |
| `session/setThoughtLevel` | `ksn` | `gIt`：`{sessionId, thoughtLevel?, runtimeModel?, expectedRevision?}` | |
| `session/updateRuntimeModelConfig` | `Isn` | `_It`：`{sessionId, runtimeModel, applyModelSelection?}` | |
| `session/setMode` | `Tsn` | `yIt`：`{sessionId, mode(build/edit/plan/yolo), expectedRevision?}` | |
| `session/usage` | `w2t` | — | 单会话用量 |
| `usage/stats` | `v2t` | `tIt`：`{range, timeZone?}` | 全局用量统计 |
| `workspace/readState` | `uan` | `xIt`：`{workspace, runtimeModel?, preferWorkspaceDefaults?}` | 【实测】workspace 必填（workspaceKey） |
| `workspace/hooks/trustGrant` | — | `eB`：`{workspace, bundleDigest, hookDeclarationDigest}` | |
| `workspace/upsertModelProvider` 等 | `can/lan/dan/...` | `CIt`：`{workspace, provider{providerId,kind(anthropic/openai/openai-compatible),baseURL,apiKey?,models[{modelId}]}, expectedWorkspaceRevision?}` | 【实测】沙箱注入 dummy provider 成功 |
| `workspace/setDefaultModel/ThoughtLevel/Mode`、`updateInteractionPreferences`、`updateModelIoPreferences`、`updateProviderRegistry`、`removeModelProvider` | `pan/man/fan/cun/pun/lan/dan` | | 工作区偏好 |
| `workspace/generateText`、`workspace/cancelGenerateText` | `Esn` / cancel | | 无会话一次性生成 |
| `mcp/list` | `uun` | | |
| `plugins/*`（17 个） | | `pluginsList/install/uninstall/update/setEnabled/marketplace add|remove|update/configure/validate/describe/overview/referenceCatalog/restoreBuiltin/cancelOperation/resolveSuggestedReference`，`skills/referenceCatalog` | |
| `automation/create/update/list/delete/checkTaskBinding` | | `IUi/TUi/oTt`：cron 表达式+prompt+targetTaskId，automation 会在 CronCreate 后 `setCustomSessionTitle` 冻结标题 | 隐藏能力面 |
| `interaction/requestPermission` 等（SRV→CLI） | | `interaction/requestPermission, interaction/requestUserInput, interaction/requestProviderRuntimeHeaders, interaction/requestOfficialMcpAuthHeaders, interaction/browserList, interaction/browserExecute` + `session/requestRuntimePreferences` | 锚点：`interactionRequestPermission:"interaction/requestPermission"` |

### 2.3 第二层 method（Dc 枚举，v4/*）

锚点：`conversationSubscribe:"v4/conversation/subscribe"`

| method | 说明 |
|--------|------|
| `v4/connection/flow` | 连接流控状态（saturated/drained/closed） |
| `v4/controller/subscribe|resync|unsubscribe` | controller 主题（`controller/workspaces`、`controller/tasks-index`） |
| `v4/conversation/subscribe\|resync\|unsubscribe` | 主题订阅：`conversation/<sid>`、`sessions-index/<wid>`、`workspace-config/<wid>`；返回 `{ack:{subscriptionId,mode(snapshot/resume),logEpoch}}`，初始帧随后以 post-response batch 送出 |
| `v4/conversation/rowsRange` | 行分页回放（limit≤200） |
| `v4/conversation/plans / fileChanges / fileRewindPreview` | 计划/文件变更/回滚预览 |
| `v4/usage/stats`、`v4/conversation/usage` | 用量 |
| `v4/attachment/begin\|chunk\|commit\|abort\|read` | 附件分块上传（20MB 上限、512KB/块、≤64 块）后拿 `ref`，供 sendText/session-send attachments `{ref,fileName,mime,bytes}` 引用。锚点：`attachmentBegin:"v4/attachment/begin"`；限额 `attachmentMaxBytes:20*1024*1024` |
| `v4/commands/query`、`v4/command` | 命令通道（见 §2.4） |

通知（服务器→客户端，无 id）：`v4/conversation/frame`（主题帧）、`v4/telemetry/event`、`process/resourceSample`、`state.updated`（scope server/workspace/session + patch）、legacy `session/event`（事件信封）。锚点：`zq={conversationFrame:"v4/conversation/frame"`；`processResourceSample:"process/resourceSample"`；`q$i=f.object({type:f.literal("state.updated")`；`notify({method:"session/event"`。

session 事件枚举（`session/events`/`session/subscribe` 载荷，25 种）：锚点 `ru("session.created",evn)` → `session.created/resumed/updated/titleUpdated/closed, turn.started/steerQueued/steerDrained/completed/failed, message.upserted/removed, part.started/delta/upserted/removed, model.streaming, tool.updated, permission.requested/resolved, userInput.requested/resolved, checkpoint.created, rewind.triggered, streamRecovery.updated`。

### 2.4 v4/command 命令通道（rename/delete 的唯一协议入口）

| 项 | 内容 | 锚点 |
|---|------|------|
| envelope | `{commandId, clientId, sessionId(可 null), baseRevision?, baseLogEpoch?, type, payload, issuedAt(必填毫秒数)}` | `pQo=f.object({commandId:f.string(),clientId:f.string()` |
| 【实测】缺 issuedAt | 返回 `{status:"rejected", reasonCode:"proto.invalidPayload", revisionAtDecision:0}` + zod 明细 | 探针 probe5 |
| 响应 | `{commandId, status(accepted/rejected/stale/duplicate/noop/failed), reasonCode?, message?, revisionAtDecision, result?}` | `fQo=f.object({commandId:f.string(),status:f.enum(["accepted"` |
| CAS 命令 | `mmt` 集合（applyFileRewind/forkAssistant/editUserQuery/retryTurn/setAssistantFeedback/...）必须带 baseRevision+baseLogEpoch | `mmt=new Set(["applyFileRewind","forkAssistant"` |
| 命令 type 全集（32 个） | `createSession{workspaceId,firstInput{text,attachments},config{provider,model,thought,followupMode,mode},runtimeModel,mcpServers}`、`createSelectionSideSession`、`sendText{text,attachments,turnRuntimeModel,automationId,offPeakTaskId,...}`、`sendGoalCommand`、`stop`、`compact`、`forkAssistant{target}`、`applyFileRewind{target}`、`editUserQuery{target,newText,attachments,workspaceMode}`、`retryTurn`、`setAssistantFeedback{like/dislike}`、`sendQueuedNow/editQueueItem/reorderQueueItem/deleteQueueItem`、`setAutoDrain`、`resolveInteraction{interactionId,answer}`、`respondWorkspaceHookReview`、`toggleWorkspaceHookReviewItem`、`revokeWorkspaceHookTrust`、`requestWorkspaceHookReview`、`snoozeInteractionAutoResolution`、`switchModelConfig{provider,model,thought}`、`switchCollaborationMode{mode}`、`setFollowupMode{queue/guide}`、`pauseGoal`、`resumeGoal`、`cancelBackgroundWork{workId}`、**`renameSession{title}`**、**`deleteSession{}`** | `renameSession:f.object({title:f.string()}),deleteSession:f.object({})` |
| rename 处理 | `R3i`：`runtime.setCustomSessionTitle({title})` | `s(R3i,"renameSession")` |
| delete 处理 | `P3i`：要求 host.closeSession 能力，调 `closeSession(sessionId)` | `s(P3i,"deleteSession")` |
| app-server 宿主实现 | closeSession = `d.unsubscribe?.(), d.app.close?.(), v4Gateway.disposeSession(id), sessions.delete(id)` —— **只清进程内态** | `closeSession:s(async c=>{let d=e.sessions.get(c)` |
| 附件引用 | `{ref, fileName, mime, bytes, previewRef?}` | `qL=f.object({ref:f.string(),fileName:f.string()` |

### 2.5 活体探针记录（关键证据）

```text
# 探针1（读真实库，session/list）：
→ {"jsonrpc":"2.0","id":1,"method":"session/list","params":{}}
← {"error":{"code":-32600,...},"id":"invalid-message"}     # jsonrpc 字段被拒
→ {"id":2,"method":"session/list","params":{"limit":3,"includeArchived":true}}
← {"id":2,"result":{"sessions":[{"sessionId":"sess_f611b974-...","title":"...","titleSource":"generated","sessionKind":"interactive","status":"idle","workspace":{...},"createdAt":...,"updatedAt":...},...]}}
→ {"id":4,"method":"no/such-method","params":{}}
← {"error":{"code":-32601,"message":"Method not found: no/such-method"},"id":4}
→ {"id":5,"method":"session/read","params":{"sessionId":"sess_does-not-exist"}}
← {"error":{"code":-32004,"message":"Session is not active: sess_does-not-exist"},"id":5}

# 探针3（沙箱 create）：服务端先发
← {"id":"server-1","method":"session/requestRuntimePreferences","params":{"sessionId":"sess_...","scope":"runtime-materialization"}}
  应答 {} → 报错 nativeSearchEnhancementsEnabled 必填 boolean
  应答 {"nativeSearchEnhancementsEnabled":false} → 通过，进入 model config 检查（沙箱无凭据而失败）

# 探针5（真实库历史 session，未激活）：
session/read   → -32004 Session is not active
session/messages → -32004 Session is not active
v4/command renameSession（缺 issuedAt）→ status:"rejected", reasonCode:"proto.invalidPayload"
```

`requestRuntimePreferences` 的应答 schema 与兜底（客户端回 `-32601`/`-32020` 时引擎用默认值继续，**MCP 集成可直接拒绝该请求**）：
锚点 `sIt=f.object({nativeSearchEnhancementsEnabled:f.boolean()`；兜底锚点 `o.code===-32601||o.code===-32020))return{askUserQuestionAutoResolutionEnabled:!0`。

---

## 3. session 创建链路（id/slug/路径/标题/落库）

全部位于引擎 runtime（line ~2736）与 sqlite store（line ~907-963）：

| 环节 | 实现 | 锚点 |
|------|------|------|
| session id | `Cl(e)` = `` `sess_${e??crypto.randomUUID()}` ``（UUID **v4**，crypto.randomUUID；前缀 `sess_` 由引擎拼） | `` return`sess_${e??crypto.randomUUID()}` `` |
| msg/part id | `$n`=`msg_`+`${Date.now().toString(36)}_${uuid}`；`On`=`part_`+同款后缀（时间排序友好） | `BAt(){return`${Date.now().toString(36)}_${crypto.randomUUID()}`}` |
| turn/event/tool id | `turn_/evt_/tool_`+uuid；traceId=裸 uuid（`mT`） | `function Kue(e){return`evt_${e??crypto.randomUUID()}`}` |
| slug | `qne`=slugify：小写、`[^a-z0-9._-]+`→`-`、去首尾 `-`、空则 `session`；create 时 `slug:qne(sessionId)`（即 `sess_<uuid>` 原样通过，`_` 在白名单内） | `replace(/[^a-z0-9._-]+/g,"-").replace(/^-+|-\+$/g,"")`（精确串见下） |
| project_id | `QTe(dir)`=`gH(slugify(dir).slice(0,80)\|\|"default")`=`proj_`+路径 slug（截 80）；**由工作目录决定，非随机** | `function QTe(e){return gH(qne(e).slice(0,80)` |
| workspace_id | create 参数 `workspace.workspaceIdentity`，缺省 `config.memory.workspaceIdentity`（远程工作区才有） | `workspaceID:this.config.workspaceIdentity??i` |
| directory/path | `n=config.workspacePath??workingDirectory`，directory 与 path 同值写入 | `slug:qne(this.sessionId),directory:n,path:n,title:o,titleSource:"first_input"` |
| title 初值 | `n8r`=titleFromInput（首条用户输入）：trim+空白折叠；≤60 字符原样；>60 截 57+`...`；空 → `"Untitled session"` | `:"Untitled session"`（完整：`t.length<=60?t:`${t.slice(0,57)}...`:"Untitled session"`） |
| title_source 缺省 | SQL 绑定 `t.titleSource??"first_input"`；enum 校验回落 first_input | `t.titleSource??"first_input"` |
| task_type 缺省 | `t.taskType??"interactive"`（fork 场景写 `fork`/`selection_side_chat`，subagent 子会话 `subagent_child`） | `t.taskType??"interactive"` |
| INSERT 语句 | 25 列，`time_compacting/time_archived` 插 NULL；`on conflict(id) do update`（幂等 upsert）；title 变更时 `time_title_updated` | `insert into session (` + `time_compacting, time_archived` |
| 落库时机 | **懒持久化**：runtime `M$r`（ensureSessionPersisted）在首条用户 prompt/外部活动时 INSERT；协议 `session/create` 只建进程内记录（`k2t` 建记录不写库）；v4 `createSession` 用 `persistence:"deferred"`。证据：沙箱 create 后 `session/list` 返回 `[]`（探针3） | `slug:qne(this.sessionId),directory:n,path:n`；`persistence:"deferred"` |
| 首条 prompt 落库 | ① `eCe` 解析附件（见 §4）→ ② `persistUserPrompt`（`V$r`）：INSERT `message` 行 `{id:msg_.., role:"user", time:{created}, agent:"zcode-agent"??config.agentName, model:{当前默认模型}, semantics:{origin:"real_user",kind:"user_prompt",uiVisibility:"visible",...}, system, tools{...}}` → ③ INSERT parts：text part `{type:"text",text,time:{start,end}}` + 每 附件一个 `{type:"file",mime,filename,url,source,metadata}` → ④ 追加 `session.titleUpdated` 事件（first_input 源） | `semantics:{origin:"real_user",kind:"user_prompt"`；`type:"text",text:t,time:{start:i,end:i}}`；`type:"file",mime:d.mime,filename:d.filename,url:d.url` |
| message/part 表结构 | `message(id, session_id, agent_id?, time_created, time_updated, data, sequence)`；`part(id, message_id, session_id, time_created, time_updated, data, sequence)`；data=part 对象 JSON（`Ua`=JSON.stringify）；sequence=同会话/同消息内 coalesce(max)+1 | `insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)` |
| fork（parent_id） | `Zzr`：`parentID=父sessionId, taskType="fork", slug=`${slugify(父slug)}-fork-${Date.now().toString(36)}`.slice(0,120), title="Fork of ${父title}"（selection_side_chat → "Selection side chat"）, titleSource:"generated"` | `slug:`${qne(t.slug)}-${n}-${o.toString(36)}`.slice(0,120)` |
| imported history | 走 `importedHistory` 分支：title `?.trim()\|\|"Imported session"`，titleSource `custom` | `title:t.title?.trim()||"Imported session",titleSource:"custom"` |
| 自动标题 | 首轮后 LLM 生成：`Joi` —— 若当前 `titleSource==="custom"` 跳过；否则 `updateSession({expectedTitleSources:["default","first_input","generated"], title, titleMessageID, titleSource:"generated"})`（CAS 防覆盖手工标题）+ `session.titleUpdated` 事件 | `expectedTitleSources:Goi`（`Goi=["default","first_input","generated"]`） |

slug 函数精确锚点：`qne(e){return e.toLowerCase().replace(/[^a-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"")||"session"}`

---

## 4. --attach 与 skill 引用的表示法

### 4.1 CLI `--attach` 路径

| 环节 | 实现 | 锚点 |
|------|------|------|
| 参数解析 | `attach:{multiple:!0,type:"string"}`（可重复） | `attach:{multiple:!0,type:"string"}` |
| 类型推断 | `ZDi`=按扩展名：`.gif/.jpeg/.jpg/.png/.webp`→`image`；`.mp4/.m4v/.mov/.webm/.mkv/.avi`→`video`；其余→`file` | `VDi=new Set([".gif",".jpeg",".jpg",".png",".webp"])` |
| 提交形态 | headless 路径 `submitPrompt({text, attachments:[{type, path}]})` | `attachments:r.map(q=>({type:ZDi(q),path:q}))}` |
| 附件解析器 | `eCe`（逐个 `Xei`）：`type:"url"` → `{contentBlock:{type:"resource_link",uri}, mime:"text/uri-list", metadata:{storageKind:"remote_ref"}}`；带 `content`（inline/dataURL）→ 解码+artifactStore；`image/video`+path → 读文件 base64 → artifactStore；纯文本 file → 读文本（>F2 截断，metadata.recoverability=`preview_only`）；二进制 file → 拒入（reason `binary_file`，仅保留占位） | `function eCe(e,t){let r=[];for(let[n,o]of(e??[]).entries()` |
| 图片/视频产物 | contentBlock `{type:"image"\|"video", mediaType, dataUrl, source:{kind:"local_file", path, sizeBytes, sha256}}`；artifact 持久化为 `zcode-artifact://` URI | `source:{id:`turn-attachment-${o+1}`,kind:"local_file"` |
| 落 part | 用户消息 parts：text part + 每 附件 `{type:"file", mime, filename, url:<zcode-artifact://…或 data:>， source, metadata:{originalUrl, sizeBytes, sha256, storageKind, recoverability, artifactUri}}` | `type:"file",mime:d.mime,filename:d.filename,url:d.url` |
| input_history | 附件归一化 `{type:"file"\|"image"\|"url", path?, content?}` 存 input_history.attachments（content 不允许 data: 前缀） | `r.type!=="file"&&r.type!=="image"&&r.type!=="url"` |
| app-server 路径 | 先 `v4/attachment/begin/chunk/commit` 上传拿 `ref`，再 send：`attachments:[{ref,fileName,mime,bytes,previewRef?}]`；协议侧 `sMi`/`uMi` 把 `{ref,fileName,mime,bytes}` 透传给引擎 | `uMi(e){return{...e.ref?{ref:e.ref}:{},fileName:e.fileName` |
| 读回 | `v4/attachment/read`（30MB 读缓存）；tool 结果附件 `zcode-artifact://` 经 `arn` 读回 | `t.readToolResultArtifact({uri:n.content})` |

### 4.2 part 类型全集（`S8e` discriminatedUnion，13 种）

锚点：`S8e=f.discriminatedUnion("type",[Rf.extend({type:f.literal("text")`

| type | 关键字段 | 备注 |
|------|----------|------|
| `text` | `text, synthetic?, ignored?, metadata?` | 用户/助手文本 |
| `reasoning` | `text` | 思考内容 |
| `file` | `mime, filename?, url, metadata?` | **图片/视频/PDF/附件统一入口**（无独立 image part） |
| `tool` | `callId, tool, state{pending/running/completed/error, input/output/error, attachments?}` | 工具调用 |
| `step-start` / `step-finish` | `snapshot?` / `reason, snapshot?, cost, tokens` | 模型步 |
| `snapshot` | `snapshot` | 上下文快照 |
| `patch` | `hash, files[]` | 文件补丁 |
| `compaction` | `auto, reason?, summaryMessageId?` | 压缩边界 |
| `timeline` | `timelineType(context_compaction/goal_verification/session_fork/model_change), display, trigger, phase...` | 时间线分隔 |
| `subagent` | `prompt, description, agent, model?, command?` | 子代理调用 |
| `agent` | `name` | agent 标记 |
| `retry` | `attempt, error` | 重试 |

model-io 层（发给模型的 content block，line ~65）另有 `image{mediaType,dataUrl}/file{mediaType,data}/resource_link` 三类——是 part→模型内容的投影，非存储形态。锚点：`VH(e){return e.type==="file"&&e.mediaType==="application/pdf"`。

### 4.3 skill 引用

- **无 skill-mention part**。`/skill <name> <task>`（CLI headless 或 TUI）展开为纯文本 prompt（`lae`）：

  ```text
  Use the skill named `<name>` for this turn.
  First call the `Skill` tool with name `<name>` before doing the task.
  After the skill content is loaded, follow its instructions and continue.

  User request:
  <task 或 "No additional user request was provided..."> 
  ```
  锚点：`Use the skill named` + `No additional user request was provided. Load the skill`（`function lae(e,t)`；注意源码为模板串，内部反引号以 `\` 转义）
- 自定义 command 的 skill 依赖同样以文本注入："Required skills: ... Before following the command body, call the Skill tool for ..."。锚点：`Before following the command body, call the Skill tool`
- 引擎的 `Skill` 工具加载 SKILL.md 内容进上下文（`skillPort`，`uA({extraRoots...})`）。锚点：`skillPort:e.configResult.config.features.skill`

---

## 5. 改名 / 归档 / 删除在引擎侧的实现

### 5.1 改名（title 更新）

| 路径 | 实现 | 锚点 |
|------|------|------|
| 协议入口 | `v4/command {type:"renameSession", payload:{title}}` → `R3i` → `app.runtime.setCustomSessionTitle` | `s(R3i,"renameSession")` |
| 引擎实现 | `ozr`（setCustomSessionTitle）：读旧 title → `sessionStore.updateSession({id, title, titleSource:"custom"})` → append `session.titleUpdated` 事件 `{previousTitle, source:"custom", title}` | `await this.sessionStore?.updateSession({id:this.sessionId,title:e.title,titleSource:"custom"})` |
| 自动标题 | `Joi`：`updateSession({expectedTitleSources:["default","first_input","generated"], title, titleMessageID, titleSource:"generated"})`；custom 时不覆盖 | `if(t.titleSource==="custom"){...reason:"custom_title"` |
| updateSession SQL | `update session set ..., title=?, title_source=?, title_message_id=?, ..., time_title_updated=?, time_compacting=?, time_archived=?, time_updated=max(time_updated,?) where id=?`；`expectedTitleSources` 不含当前源则整体跳过（CAS） | `update session set` + `time_archived = ?`（中文注释锚点：`修复原因：路径自愈可能携带并发读取前的旧时间`） |
| time_title_updated | title/titleSource/titleMessageID 任一变化时写 now | `i||t.titleSource!==void 0||t.titleMessageID!==void 0?o:r.time.titleUpdated??null` |

**title_source='custom' 的写者**：仅 `ozr`（rename 命令）与 importedHistory（`titleSource:"custom"`）。【实测】

### 5.2 归档（time_archived）

- 读取侧：【实测】`listSessions` 过滤 `includeArchived||r.push("time_archived is null")`；行映射 `time:{...,archived:e.time_archived??void 0}`；协议投影 `archivedAt:e.session?.time.archived`（`Pie`）。
  锚点：`t.includeArchived||r.push("time_archived is null")`；`archived:e.time_archived??void 0`；`archivedAt:e.session?.time.archived`
- 写入侧：【实测·负结论】`updateSession` SQL 支持写 `time_archived`（绑定 `t.timeArchived===void 0?r.time.archived??null:t.timeArchived`），但**引擎 bundle 中没有任何调用点传 `timeArchived`**（`timeArchived:` 出现 0 次于调用实参；`updateSession({` 全部 3 处均为 title 相关）。也没有任何 archive 命令/方法存在于 rr/Dc 枚举与 v4 command 枚举。
  锚点（复现负结论）：`t.timeArchived===void 0?r.time.archived??null:t.timeArchived`（这是唯一引用）
- 【推断】`time_archived` 由 GUI（桌面端）直接写 db.sqlite，或由 GUI 侧未来版本经协议扩展写入。`sessions-index` 主题的 `membership{pinned,archived,active}`（`VOr` schema，锚点 `membership:f.object({pinned:f.boolean(),archived:f.boolean()`）是 relay 视角的每客户端状态，不入引擎库。

### 5.3 删除

| 层 | 结论 | 锚点 |
|----|------|------|
| SQL | 【实测】全 bundle **无** `DELETE FROM session WHERE ...`（唯一 `delete from session*` 命中是 `session_target` 表）；有 `delete from message`/`delete from part`（compact/fork 清理用，锚点 `delete from message where id = ? and session_id = ?`、`delete from part where id = ? and session_`） | grep `delete from session` 仅 1 处 = session_target |
| 协议 | `v4/command deleteSession` → host `closeSession` → 仅 `sessions.delete(id)`+`app.close()`+`disposeSession`（还会触发 sessions-index 的 `session.removed` delta 通知 GUI） | `closeSession:s(async c=>{let d=e.sessions.get(c)`；`this.indexPublishers.get(o)?.removeSession(t)` |
| 会话数据回收 | 【推断】无硬删路径 ⇒ 删除=GUI 侧直写 sqlite（tasks-index 移除+db 行删除/归档），引擎无对应能力。`restore-legacy-sessions-plugin`（packages/ 目录）仅做旧会话恢复 | `packages/restore-legacy-sessions-plugin` |

---

## 6. 隐藏 CLI 面（--help 未列出）

主入口真实 dispatch（锚点：`if(e.argv[0]==="__internal-search")`）：

| 入口 | 用法 | 锚点 |
|------|------|------|
| `agent-server` | `zcode agent-server` = `app-server` 完整别名（help 只列 app-server） | `case"agent-server":case"app-server"` |
| `hooks` | `zcode hooks trust status/review/grant/revoke [--workspace <path-or-identity>] [--hook-digest <sha256>] [--all-current] [--bundle-digest] [--json]` | `if(e.argv[0]==="hooks")return await Qcn(e,t,HI)`；usage 文本锚点 `zcode hooks trust grant --workspace` |
| `__internal-search` | `zcode __internal-search find|grep <args>`（给内置工具用的原生搜索通道，带 `-G -I --exclude-dir` 注入） | `if(e.argv[0]==="__internal-search")return ndn(` |
| `__zcode-plugin-host` | `zcode __zcode-plugin-host <server.js> [args]`：加载插件 MCP server 入口（`main()` 导出），注入 ZCODE_PLUGIN_* env | `qB="__zcode-plugin-host"` |
| TUI 内部 | 无 positionals 时默认 TUI；`tui` 显式子命令 | `case"tui":return await Smn(` |
| 全局 flag 补充 | `--permission-mode`（legacy 别名）、`--force-mcs`、`--allow-main-worktree-yolo`（兼容 noop）、`--output-format json|stream-json`、`--settings <path>`、`--target-replace`、`-c/--continue`、`--no-browser` | `parseArgs` options 锚点 `attach:{multiple:!0,type:"string"}` 所在对象 |
| 协议级隐藏 | `automation/*`（cron 自动任务）、`interaction/browserExecute`（远程浏览器控制）、`session/requestRuntimePreferences`（SRV→CLI） | `automationCreate:"automation/create"` |

【实测】`--help` 输出（timeout 10s 试跑）确认上表前 4 项均未出现。已知 help 漂移：`--allowed-tools` 在 help 中列出但解析器拒收（既有结论，本次未复测）。

---

## 7. db.sqlite 与 tasks-index.sqlite 的关系

| 维度 | 结论 | 依据 |
|------|------|------|
| source of truth | `~/.zcode/cli/db/db.sqlite`（引擎写：session/message/part/event/permission/todo/session_entry/session_input/…）；路径由 config `storage.sessionDbPath` 决定，默认 `~/.zcode/cli/db/db.sqlite` | 【实测】`storage:{dir:"~/.zcode",sessionDbPath:"~/.zcode/cli/db/db.sqlite"}` |
| 引擎→GUI 通知 | 引擎把会话/消息变更投影为 v4 主题流：`conversation/<sessionId>`（行级 delta：`row.appended/upserted/removed/delta` + `state.updated`）、`sessions-index/<workspaceId>`（快照 `{protocolVersion:1,workspaceId,logEpoch,sessions[]}` + delta `session.upserted`/`session.removed`）、`workspace-config/<wid>`。GUI 作为 `clientMode:"desktop-continuous"` 订阅 `v4/conversation/subscribe` | 【实测】`rOr=f.object({protocolVersion:f.literal(1)`；`nOr=f.discriminatedUnion("op",[{op:"session.upserted"...`；`clientMode:f.enum(["desktop-continuous","web-remote-replayable"])` |
| sessions-index 行字段 | `{sessionId, workspaceId, parentSessionId?, title, titleSource?, phase, sessionEnded, hasBackgroundWork, pendingInteraction?, lastActivityAt, lastAssistantPreview?, createdAt}` —— 不含 archived/pinned（那是 GUI/relay 侧 membership） | 【实测】`tOr=f.object({sessionId:f.string(),workspaceId:f.string()` |
| tasks-index.sqlite | 引擎 bundle 中**不存在** `tasks-index.sqlite` 文件名字符串（仅 `controller/tasks-index` 主题常量与 schema）；该库为 GUI 侧（`~/.zcode/v2/`）自建持久化，由另一子任务分析 | 【实测】grep `tasks-index` 唯一命中 `zOr="controller/workspaces",$Or="controller/tasks-index"` |
| 引擎写库后如何触发 GUI 刷新 | 引擎不直接写 tasks-index；GUI 靠订阅 app-server 的 sessions-index/conversation 主题增量维护内存索引，再自行落盘 tasks-index.sqlite。【推断】GUI 直连 db.sqlite 做 archive/delete 时，引擎无法感知（无反向通知机制；引擎仅在自身变更时发 frame） | 综合上述 |
| 归档可见性 | 引擎 `session/list {includeArchived:true}` 能列出 `time_archived IS NOT NULL` 的行 → 即使 GUI 直写归档，引擎读侧天然兼容 | 【实测】`t.includeArchived||r.push("time_archived is null")` |

---

## 8. 未解问题

1. **time_archived 的真实写者未定位**（引擎负结论已实锤，但 GUI 侧写库代码在 ZCode.app 的桌面层，不在 zcode.cjs 内）——归属 GUI/tasks-index 子任务交叉验证。
2. **沙箱内 session/create 全链路未跑通**：dummy provider（`workspace/upsertModelProvider`，openai-compatible 指向 127.0.0.1:9）注入成功后，create 在模型物化阶段挂起无响应（疑似等待网络重试，network.timeout=180s）。renameSession/deleteSession 的端到端【实测】止步于：命令 envelope 校验 + 拒绝路径 + 代码级 handler 链（R3i/P3i/host closeSession）。补齐方案：接一个本地 mock OpenAI 兼容 server 再跑 probe4。
3. `session/resume` 后引擎是否回写 `time_updated`/`session_entry` 未实测（resume 会 materialize 进程内记录并读持久化消息，`reusePersistedMessages` 路径存在；未验证写副作用，为避免污染真实库未在真实 session 上执行）。
4. GUI（desktop-continuous 客户端）连接 app-server 时对 `session/requestRuntimePreferences` 的实际应答内容未捕获（只拿到 schema 与默认兜底）。
5. `--settings <path>` flag 在解析器中的真实可用性（help 列出但既有调研称解析器拒收 `--settings`/`--max-turns`——本次静态代码见 options 表含 settings 定义，疑与既有结论矛盾，未复测）。锚点：`settings:{type:"string"}`（在 `Emn.parseArgs` options 对象内，紧邻 `attach:{multiple:!0...}` 之后）。
6. 事件表 `session_entry`（model 选择持久化）与 `session_input`（排队输入 promote：`promoteSessionInput({id,sessionID,message,parts})`）的完整 schema 未展开（对 session-manager 插件非必需）。

---

## 附：可复现锚点速查（grep -F 直接用）

```text
case"agent-server":case"app-server":return await M8i
runZCodeProtocolAgent)({cwd:i,env:o,input:e.stdin
OPe=class{static{s(this,"ZCodeProtocolNdjsonConnection")}
MSt=f.union([kyn,Syn,Iyn,Tyn])
sessionCreate:"session/create",sessionResume:"session/resume"
conversationSubscribe:"v4/conversation/subscribe"
renameSession:f.object({title:f.string()}),deleteSession:f.object({})
pQo=f.object({commandId:f.string(),clientId:f.string()
fQo=f.object({commandId:f.string(),status:f.enum(["accepted"
attachmentBegin:"v4/attachment/begin"
interactionRequestPermission:"interaction/requestPermission"
ru("session.created",evn)
q$i=f.object({type:f.literal("state.updated")
processResourceSample:"process/resourceSample"
YL={sessionUnavailable:-32004}
new Wa(-32010,"A prompt is already running
return`sess_${e??crypto.randomUUID()}`
BAt(){return`${Date.now().toString(36)}_${crypto.randomUUID()}`}
function QTe(e){return gH(qne(e).slice(0,80)
:"Untitled session"
t.titleSource??"first_input"
insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)
semantics:{origin:"real_user",kind:"user_prompt"
type:"file",mime:d.mime,filename:d.filename,url:d.url
slug:qne(this.sessionId),directory:n,path:n,title:o,titleSource:"first_input"
slug:`${qne(t.slug)}-${n}-${o.toString(36)}`.slice(0,120)
await this.sessionStore?.updateSession({id:this.sessionId,title:e.title,titleSource:"custom"})
expectedTitleSources:Goi
t.includeArchived||r.push("time_archived is null")
t.timeArchived===void 0?r.time.archived??null:t.timeArchived
archivedAt:e.session?.time.archived
closeSession:s(async c=>{let d=e.sessions.get(c)
s(R3i,"renameSession")
s(P3i,"deleteSession")
VDi=new Set([".gif",".jpeg",".jpg",".png",".webp"])
attachments:r.map(q=>({type:ZDi(q),path:q}))
function eCe(e,t){let r=[];for(let[n,o]of(e??[]).entries()
S8e=f.discriminatedUnion("type",[Rf.extend({type:f.literal("text")
No additional user request was provided. Load the skill
qL=f.object({ref:f.string(),fileName:f.string()
sIt=f.object({nativeSearchEnhancementsEnabled:f.boolean()
o.code===-32601||o.code===-32020))return{askUserQuestionAutoResolutionEnabled:!0
storage:{dir:"~/.zcode",sessionDbPath:"~/.zcode/cli/db/db.sqlite"}
rOr=f.object({protocolVersion:f.literal(1)
nOr=f.discriminatedUnion("op",[f.object({op:f.literal("session.upserted")
membership:f.object({pinned:f.boolean(),archived:f.boolean()
if(e.argv[0]==="__internal-search")
qB="__zcode-plugin-host"
if(e.argv[0]==="hooks")return await Qcn(e,t,HI)
automationCreate:"automation/create"
storage:{dir:"~/.zcode",sessionDbPath:"~/.zcode/cli/db/db.sqlite"}
```
