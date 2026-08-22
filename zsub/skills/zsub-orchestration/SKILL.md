---
name: zsub-orchestration
description: Use when delegating tasks to background subagents via the zsub tool and deciding between zsub and engine-native background agents. Covers task decomposition, model routing, worktree isolation, completion notification semantics, and the no-polling rule. 触发词：subagent 编排、后台委派、zsub、并行子任务、worktree 隔离、agent 派发。
whenToUse: 主 agent 需要委派后台子任务、需要文件隔离或结构化输出的委派、需要续聊追问子任务、或需要跨窗口管理 subagent 记录时。
---

# zsub 编排指南

## 分流决策：先用原生，再考虑 zsub

派发子任务前先判断需求，**不要无脑用 zsub**：

| 需求 | 用什么 |
|------|--------|
| 简单纯后台任务（审查/调研/生成，不需要隔离和结构化输出） | 引擎原生 `@agent`（frontmatter 写 `background: true`）——原生提供独立 turn 完成唤醒 + goal gate 等待，语义更强 |
| 文件改动需要隔离（worktree + patch 回传） | zsub |
| 需要结构化 JSON 输出（schema） | zsub |
| 需要对子任务续聊追问（conversation） | zsub |
| agent 定义在 `.agents/agents/`（pi 生态目录，引擎不扫） | zsub |
| 需要逐次指定模型（per-start model 路由） | zsub |
| 需要跨窗口/跨会话查看历史 subagent 记录 | zsub |

## zsub 五 action 速查

```
zsub(action="start", task="<自包含任务描述>", slug="<短名>",
     agent="<agent 名或 .md 路径,可选>", model="<模型短名,可选>",
     worktree=<bool>, conversation=<bool>, wait=<bool>)   → subagentId（wait=false 立即返回）
zsub(action="list")                                       → 全部 record（含 running/idle/终态）
zsub(action="status", subagentId="<id>")                  → 单条详情 + 结果路径
zsub(action="message", subagentId="<id>", text="<追问>")   → 续聊一轮（仅 conversation 且 idle）
zsub(action="cancel", subagentId="<id>")                  → 取消（SIGTERM→SIGKILL）
zsub(action="close", subagentId="<id>")                   → 关闭会话并清理 worktree
```

## 核心纪律

1. **task 必须自包含**：子任务看不到主会话上下文。把必要背景（文件路径、行号、验收标准）内联进 task，不要写"如前所述"。
2. **禁止轮询**：`wait=false` 启动后不要反复调 list/status 等结果。mailbox 模式下完成通知会自动注入；polling 模式下按 start 返回里的指引做一次性查询。通知到达前去做别的事，或结束当前轮次。
3. **通知即确认**：收到 `[subagent 完成]` 消息后直接处理结果，不要再调 status"二次确认"。
4. **并发克制**：默认上限 3。嵌套 subagent 深度越深可用并发越少（自动分层），不要试图绕过。
5. **模型路由**：重量任务（设计/架构/深度调研）用默认模型；简单任务（探索/调研/测试）显式传 `model="GLM-4.7-Flash"` 降成本。
6. **worktree 任务收到完成通知后**：通知里含 `patchFile` 路径——需要落地改动时执行 `git apply <patchFile>`；不需要则明确告知用户改动保留在 patch 中未应用。

## 结果去向

- 完成通知（mailbox 注入）含结果摘要；全文在 `~/.zcode/zsub/outputs/<subagentId>.md`。
- 终态 record 的 error/timeout 字段含失败原因与恢复指引（如调大 timeoutMs、拆小任务）。
