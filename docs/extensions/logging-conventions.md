# 日志规范（logging-conventions）

> zcode 插件（MCP server + CLI 双形态）的输出通道纪律。结构对标 xyz-agent 的
> logging-conventions.md，通道模型按 zcode 形态（外挂进程）重定义。

## 通道模型（zcode 外挂形态的三层）

| 通道 | 载体 | 用途 | 禁止 |
|------|------|------|------|
| **AI 实时** | MCP tool result（stdout JSON-RPC 的 result）/ CLI 的 markdown+json 双段输出 | 给主 agent 的即时反馈：结果、block 原因、可操作错误 | 塞调试细节 |
| **人读进度** | **stderr**（MCP）/ stderr（CLI） | 阶段进度、阶段标题、耗时 | 占用 stdout（见红线 1） |
| **落盘排查** | `~/.zcode/<plugin>/` 下文件（records.jsonl 事件流、outputs/ 结果全文、专项日志） | 事后归因、崩溃恢复 | 期望用户去看（默认无人读，是证据不是 UI） |

## 红线

1. **MCP server 的 stdout 是 JSON-RPC 通道**：任何非协议输出（console.log、进度、报错堆栈）
   都会污染协议流导致 client 解析失败。全部人读输出走 stderr。这是外挂进程形态的第一铁律。
2. **禁裸 `console.error` 当排查通道**：stderr 只保证「可见」，不落盘。需要事后追查的信息必须
   写 records / 专项日志文件。
3. **错误信息可操作**：错误文本指向恢复动作（具体命令/下一步），并列出可用选项清单
   （zsub 模型路由报错范式）。
4. **debug 输出默认静默**：约定 `<PLUGIN>_DEBUG=1` env 开启详细日志；无 env 时 stderr 只输出
   阶段级进度（参照 XYZ_AGENT_DEBUG / zsub 先例）。
5. 事件流（records.jsonl）**append-only**：崩溃后重放恢复依赖它，禁止改写历史行。

## 落盘布局

```
~/.zcode/<plugin>/
├── records.jsonl          # append-only 事件流（生命周期事件；崩溃恢复数据源）
├── outputs/<id>.md        # 结果全文（MCP result 只回摘要时，全文在此）
├── outputs/<id>.patch     # worktree 任务的 patch（完成通知含 git apply 指引）
├── home-<model>/          # per-model / per-runner 隔离 HOME（spawn 无头子进程用）
└── wt-<id>/               # worktree 隔离目录（任务期存在，完成清理）
```

命名用 id 关联（`sa-*` / `wf-*` 前缀区分 subagent / workflow），MCP result 摘要里必须带
output/record 路径，形成「摘要 → 全文证据」链路。

## 无头子进程输出

- spawn 的无头 zcode 子进程：`--json` 输出流即事件证据；长任务建议 tee 落盘
  （卡死时的决定性证据，参照 xyz-agent 对 `pi-<date>-<sessionId>.jsonl` 的定位）。
- 子进程 stdout/stderr 不直通主会话——由驱动层解析后按上述三层分流。

## 与 xyz-agent 三层通道的对照

| xyz-agent（pi 进程内） | 本仓（zcode 外挂） |
|---|---|
| tool result（pi 原生） | MCP tool result |
| `pi.appendEntry`（持久化不进上下文） | records.jsonl append |
| logger.debug → `~/.pi/agent/logs/`（debug env） | stderr + `<PLUGIN>_DEBUG=1` + 落盘 |
| `ctx.ui.notify` | 无对应（zcode 无 UI 扩展点）——结果反馈只能并入 tool result |
