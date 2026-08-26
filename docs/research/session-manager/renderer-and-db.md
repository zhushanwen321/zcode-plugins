# ZCode 渲染层 + 运行时数据库逆向调研报告

> 调研日期：2026-08-26
> 调研范围：ZCode.app asar 渲染层（GUI 能力清单）+ 运行时双库交叉验证
> 结论分级：【实测】= 实际 grep/查询验证 / 【推断】= 基于代码模式推断

---

## 1. GUI 操作 × 通道矩阵

### 1.1 侧边栏会话操作清单

所有操作均通过 `zcodeTaskService` 接口发起（RPC 调用，非直接 IPC invoke）。核心 chunk：**`styles-DIQgZMVI.js`**（4.3MB，含状态机 + 全部业务逻辑）。

| 操作 | 方法名 | 触发点代码锚点 | 备注 |
|------|--------|---------------|------|
| **新建会话** | `createTask`（通过 `createSession` command） | `quickPick.command.newTask` / `sidebar.newTask` / `titleBar.menu.file.newTask` | 快捷键 `N`，支持预热（draft-prewarm） |
| **打开/切换** | 直接 `taskId` 路由 | `data-row-id` / `data-row-kind` | 点击 sidebar 行 |
| **改名** | `renameTask({taskId, workspacePath, title, ...})` | `onStartRenameTask` | 行内编辑，commit 后调 RPC |
| **归档** | `archiveTask({taskId, workspacePath, ...})` | `onArchiveTask` / `taskList.archive`（确认对话框） | 二次确认弹窗 |
| **取消归档** | `unarchiveTask({taskId, workspacePath, ...})` | `taskGroup.ungroup` context menu | 无确认 |
| **置顶** | `setTaskPinned({taskId, workspacePath, pinned, ...})` | `onPinTask` toggle | pinned=!pinned 切换 |
| **删除** | `deleteTask({taskId, workspacePath, ...})` | `taskList.deleteConfirmTitle` + `taskList.deleteConfirmDescription` | **二次确认弹窗**，软删除（见 §4） |
| **标记未读** | `setTaskUnread({taskId, workspacePath, unread, ...})` | `onMarkTaskAsUnread` | |
| **分组** | `createGroup` / `renameGroup` / `updateGroupColor` / `ungroupGroup` | `taskGroup.newTask` / `taskGroup.renameAction` / `taskGroup.changeColor` / `taskGroup.ungroup` | 支持拖拽排序 |
| **搜索** | 本地过滤（title.toLocaleLowerCase） | `e.search ? t.title.toLocaleLowerCase().includes(e.search)` | 前端过滤，非服务端搜索 |

**【实测】锚点验证**：
- `quickPick.command.newTask` → offset 322875
- `onArchiveTask` → offset 2824768
- `deleteTask` → offset 2905034
- `setTaskPinned` → offset 2828281
- `renameTask` → offset 2824093
- `taskGroup.newTask` → offset 3064556

### 1.2 IPC/协议通道

**【实测】** ZCode 不使用传统 `ipcRenderer.invoke` 模式，而是基于 **MessagePort + 二进制 RPC 协议**：

- 传输层：`port.postMessage(buffer)` / `port.postMessage({__zcodeRpcControl: 'connection-flow-v1', state: e})`
  - 锚点：`this.port.postMessage(e.buffer)` (offset 233437)
  - 锚点：`__zcodeRpcControl` (offset 233486)
- RPC 方法：通过 `Bl({method: 'v4/conversation/frame', params: e})` 序列化
  - 锚点：`v4/conversation/frame` (offset ~92429)
- 任务列表获取：通过 `Host Controller channel` 的 `list(b,t,y)` 方法
  - 锚点：`window Host Controller channel unavailable` (offset 380711)
- 设置同步：`t.send({channel: zee, payload: n})`
  - 锚点：`channel:zee,payload:n` (offset 600808)

### 1.3 任务状态机

**【实测】** `styles-DIQgZMVI.js` offset 113902-113977：

```
kind ∈ {timeline, pinned, archived, active}

筛选函数 tu(e, kind):
  - pinned:   return e.pinned && !e.archived
  - archived: return e.archived
  - timeline: return !e.pinned && !e.archived
  - active:   return !e.archived
```

**【实测】** `liveStatus` 枚举（offset 113480-113523）：
```
liveStatus: Pa(['idle', 'running', 'waiting', 'completed', 'error'])
```

**【实测】** 任务地址 schema（offset 112210-112416）：
```
address = {
  remoteSessionId?: string,  // 可选，远程会话
  workspacePath: string,     // 必填
  workspaceIdentity?: string, // 可选，remote 时必须
  taskId: string             // 必填，格式 sess_<uuid>
}
```

### 1.4 订阅协议（Snapshot/Delta）

**【实测】** offset 83564-83772 / 114646-115265：

```
订阅请求：{
  subscriptionId: string,
  mode: 'snapshot' | 'resume',
  logEpoch: string
}

帧格式：{
  topic: string,           // 'controller/workspaces' | 'controller/tasks-index' | 'sessions-index/<id>'
  subscriptionId: string,
  logEpoch: string,
  fromSeq: number,
  toSeq: number,
  sentAt: number,
  payload: {
    kind: 'snapshot',
    snapshot: {...}        // 全量快照
  } | {
    kind: 'deltas',
    deltas: [...]          // 增量操作
  }
}
```

- Topic 常量：`Xl = 'controller/workspaces'`、`Zl = 'controller/tasks-index'`
- Delta 操作：`workspace.upserted` / `workspace.removed` / `task.upserted` / `task.removed`
- Snapshot 约束：`fromSeq` 必须为 0，`snapshot.logEpoch` 必须等于帧 `logEpoch`

---

## 2. 新建会话流程还原

### 2.1 入口

**【实测】** 三个入口：

1. **快捷键 `N`**：`titleBar.menu.file.newTask` → `run: s.createTask`
   - 锚点：offset 322910
2. **侧边栏按钮**：`sidebar.newTask` → `onCreateTask`
   - 锚点：offset 2465793
3. **Command Palette**：`quickPick.command.newTask`，keywords: `['new', 'task', '任务', '新任务', '新建任务']`
   - 锚点：offset 322875

### 2.2 创建流程

**【实测】** offset 2266151-2266367：

```
1. 用户点击新建 → 触发 createSession command
2. 构造 payload:
   {
     workspaceId: rt,
     firstInput: { text: ..., attachments: [...] },  // 可选，可空
     config: { provider?, model?, thought?, followupMode?, mode? },  // 可选
     runtimeModel: ...,   // 可选
     mcpServers: [...]    // 可选
   }
3. 发送 en('createSession', payload, null)
4. 等待 response.status === 'accepted'
5. 获取 result.sessionId → 路由到新会话
```

**【实测】** 预热机制（draft-prewarm）：
- offset 607605-608380：`v4-draft-prewarm` 流程
- 先创建 draft session，用户输入时直接使用已预热的 session
- 配置可携带：`provider`、`model`、`thought`、`followupMode`、`mode`

### 2.3 能否选 model/mode/thoughtLevel？

**【实测】** 可以。`config` 字段 schema（offset ~102037）：
```
config = {
  provider?: string,
  model?: string,
  thought?: string,
  followupMode?: 'queue' | 'guide',
  mode?: string
}
```

mode 枚举包含：`build`、`edit`、`plan`、`yolo`（offset 1073481）

### 2.4 能否预挂 skill/文件？

**【实测】** 可以通过 `firstInput.attachments` 预挂附件。attachments 类型为 `Fi(lo)`（数组）。skill 通过 mention 方式内联在 text 中（见 §3）。

---

## 3. @ 引用表示法

### 3.1 触发字符

**【实测】** offset 818703：

| 触发字符 | 语义 | 匹配的 category 列表 |
|---------|------|---------------------|
| `@` | 文件/插件/会话/白板 | `['plugins', 'files', 'sessions', 'whiteboards']` |
| `#` | 会话 | `['sessions']` |
| `$` | 技能 | `['skills']` |

### 3.2 Mention 数据结构

**【实测】** offset 803919-805586（Lexical 编辑器节点）：

```typescript
class PromptMentionNode extends TextNode {
  __mentionId: string;
  __category: string;   // 'files' | 'skills' | 'plugins' | 'sessions' | 'whiteboards'
  __value: string;
  __markdown: string;
  __data: object;

  exportJSON(): {
    type: 'prompt-mention',
    version: 1,
    mentionId: string,
    category: string,
    value: string,
    markdown: string,
    text: string,
    data: object
  }
}
```

DOM 渲染：
```html
<span class="prompt-mention {category-class}"
      data-mention-category="{category}"
      data-mention-id="{mentionId}"
      spellcheck="false">
  {label}
</span>
```

**【实测】** 实际 payload 示例（`session_input` 表，offset db.sqlite）：
```json
{
  "text": "[$handoff](/Users/zhushanwen/.agents/skills/handoff/SKILL.md)",
  "intent": {
    "sourceCommandId": "019f8848-...",
    "queueItemId": "queue_019f8848-...",
    ...
  }
}
```
→ skill mention 在 text 中以 markdown 链接形式表示，label 为 `$handoff`，路径指向 SKILL.md。

### 3.3 附件（Attachment）协议

**【实测】** offset 462463-463728：

分块上传协议：
1. `attachmentBeginV4` → 创建上传，返回 `{uploadId, ref, state, nextChunkIndex}`
2. `attachmentChunkV4` → 逐块上传 base64 数据
3. `attachmentCommitV4` → 提交
4. `attachmentAbortV4` → 取消

约束：
- `attachmentMaxBytes` / `attachmentChunkMaxBytes` / `attachmentUploadMaxChunks`
- 支持 image/video 媒体类型预览
- checksum: `crypto.subtle.digest` 计算

---

## 4. 双库对照结论

### 4.1 数据库概览

| 库 | 路径 | 大小 | 主要表 |
|----|------|------|--------|
| GUI 侧 | `~/.zcode/v2/tasks-index.sqlite` | 34MB | tasks(601), task_groups(2), task_group_members(6), automations(3), automation_runs(50) |
| 引擎侧 | `~/.zcode/cli/db/db.sqlite` | 4.9GB | session(5931), message(291933), part(1120939), todo(15452), session_entry(34478) |

### 4.2 Schema 对照

| 字段 | tasks-index.tasks | db.sqlite.session | 同步关系 |
|------|-------------------|-------------------|---------|
| 标识 | `task_id` (sess_\<uuid\>) | `id` (sess_\<uuid\>) | **完全一致**，同值 |
| 标题 | `title` | `title` | **大部分一致**，tasks-index 可被用户重命名（`title_overridden=1`） |
| 状态 | `task_status` | 无直接对应 | tasks-index 独有 |
| 归档 | `archived` (0/1) | `time_archived` (NULL/时间戳) | **不一致**：tasks-index 有 7 条 archived=1，db.sqlite 全部 time_archived IS NULL |
| 删除 | `deleted` (0/1) | 无对应字段 | tasks-index 独有，db.sqlite 无删除标记 |
| 置顶 | `pinned` (0/1) | 无对应字段 | tasks-index 独有 |
| 创建时间 | `created_at` | `time_created` | 格式相同（毫秒时间戳） |
| 更新时间 | `updated_at` | `time_updated` | 格式相同 |

### 4.3 交叉验证结果

**【实测】** 查询输出摘录：

```
=== 非删除任务（tasks-index deleted=0）===
tasks-index: 142 条
db.sqlite session: 5931 条

=== Orphan 分析 ===
在 tasks-index 但不在 db.sqlite: 0 条（所有 142 条都有对应 session）
在 db.sqlite 但不在 tasks-index: 5789 条（绝大多数 session 无 tasks-index 条目）
共同存在: 142 条
```

**结论**：tasks-index 是 db.sqlite 的**子集视图**（仅 142/5931 = 2.4% 的 session 被索引）。

### 4.4 软删除/硬删判定

**【实测】**

```
tasks-index deleted=1 的记录: 459 条
其中在 db.sqlite 仍存在: 458 条（99.8%）
其中在 db.sqlite 不存在: 1 条
```

**结论**：**软删除**。删除操作只在 tasks-index 设置 `deleted=1`，db.sqlite 的 session 记录**不被删除**。唯一一条 db.sqlite 不存在的 deleted 记录可能是手动清理或迁移残留。

### 4.5 Archived 对照

**【实测】**

```
tasks-index archived=1 且 deleted=0: 7 条
db.sqlite time_archived IS NOT NULL: 0 条
```

**结论**：archived 状态**仅存于 tasks-index**，db.sqlite 的 `time_archived` 字段当前全部为 NULL，未被同步。

### 4.6 标题一致性

**【实测】** 20 条样本对照：

| 状态 | 数量 | 说明 |
|------|------|------|
| 完全一致 | 16/20 | 大多数标题同步 |
| 不一致 | 4/20 | tasks-index 标题被重命名（`title_overridden=1`） |

不一致示例：
```
DIFF: sess_521358fc | ti='hapi持续修复' | db='https://github.com/tiann/hapi/pull/862 gh cli 看下最新问题...'
DIFF: sess_938e0d00 | ti='前后端衔接' | db='前端运行时集成改造计划'
```

### 4.7 孤儿统计

| 方向 | 数量 | 说明 |
|------|------|------|
| tasks-index → db.sqlite | 0 | 所有 tasks-index 记录都有对应 session |
| db.sqlite → tasks-index | 5789 | 绝大多数 session 无 tasks-index 条目（未被用户"打开"或索引） |

---

## 5. config.json 形态

**【实测】** `~/.zcode/cli/config.json` 当前内容：

```json
{
  "plugins": {
    "enabledPlugins": {
      "z-subagent-workflow@zcode-plugin-workspace": true
    }
  }
}
```

**结论**：
- 极简配置，仅记录插件启用状态
- 格式：`{plugin-name}@{source}` → `boolean`
- 无 `mcp.servers` 字段（MCP 配置可能在其他位置或通过 GUI 管理）
- 无 `plugins` 列表声明（插件发现可能依赖文件系统扫描）

---

## 6. 未解问题

### 6.1 渲染层

1. **MCP 配置存储位置**：`mcpStore` 相关代码（offset 311288-311989）提到 `localStorage:zcode-mcp-config` 迁移，但 config.json 中无 MCP 配置。MCP server 配置可能存储在：
   - 浏览器 localStorage（Electron renderer）
   - 其他 JSON 文件
   - 需进一步搜索 `mcp.json` 或 `.mcp.json` 相关代码

2. **任务列表数据源**：`Host Controller channel` 的具体实现位置未找到。`list(b,t,y)` 方法的参数含义待确认。

3. **attachment 类型 `lo`**：在 styles-DIQgZMVI.js 中被引用但未找到定义，可能定义在其他 chunk 中或通过 `import` 引入。

### 6.2 数据库

4. **tasks-index 索引触发条件**：为什么只有 142/5931 的 session 被索引？可能条件：
   - 用户在 GUI 中打开过
   - 有 title_overridden
   - 有 pinned/archived 状态
   - 需进一步统计验证

5. **archived 同步断裂**：db.sqlite 的 `time_archived` 全部为 NULL，但 tasks-index 有 7 条 archived=1。是 bug 还是有意设计？

6. **db.sqlite 大小**：4.9GB 存储 5931 个 session + 1.1M 个 part，平均每 session 189 个 part。是否有清理策略？

### 6.3 架构

7. **渲染层 ↔ 引擎通信链路**：MessagePort + 二进制 RPC 的完整握手流程。`__zcodeRpcControl: 'connection-flow-v1'` 的状态机。

8. **远程会话支持**：`remoteSessionId` + `workspaceIdentity` 的远程任务如何路由？

---

## 附录：关键 grep 锚点索引

| 锚点 | 偏移 | 含义 |
|------|------|------|
| `quickPick.command.newTask` | 322875 | 新建任务 Command Palette 入口 |
| `sidebar.newTask` | 2465793 | 侧边栏新建按钮 |
| `titleBar.menu.file.newTask` | 2797047 | 菜单栏新建 |
| `zcodeTaskService.renameTask` | 2824093 | 改名 RPC |
| `zcodeTaskService.archiveTask` | 2824768 | 归档 RPC |
| `zcodeTaskService.deleteTask` | 2905034 | 删除 RPC |
| `zcodeTaskService.setTaskPinned` | 2828281 | 置顶 RPC |
| `zcodeTaskService.setTaskUnread` | 2829042 | 标记未读 RPC |
| `taskGroup.newTask` | 3064556 | 分组内新建 |
| `taskGroup.renameAction` | 3068070 | 分组重命名 |
| `taskGroup.changeColor` | 3068170 | 分组改色 |
| `taskGroup.ungroup` | 3068597 | 取消分组 |
| `prompt-mention` | 803919 | Mention Lexical 节点 |
| `data-mention-category` | 804770 | Mention DOM 属性 |
| `GAe` | 818784 | 触发字符 → category 映射函数 |
| `controller/workspaces` | 112210 | 订阅 topic 常量 |
| `controller/tasks-index` | 112210 | 订阅 topic 常量 |
| `snapshot` / `deltas` | 83726 | 帧 payload 类型 |
| `logEpoch` | 114082 | 版本追踪字段 |
| `attachmentBeginV4` | 462786 | 附件上传开始 |
| `__zcodeRpcControl` | 233486 | RPC 控制帧 |
| `v4/conversation/frame` | ~92429 | RPC 方法名 |
| `Host Controller channel` | 380711 | 任务列表获取通道 |
