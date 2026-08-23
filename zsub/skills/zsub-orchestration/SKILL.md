---
name: zsub-orchestration
description: Use when delegating tasks to background subagents via the zsub tool, deciding between zsub and engine-native background agents, or running multi-phase workflows via the run_workflow tool. Covers task decomposition, model routing, worktree isolation, completion notification semantics, the no-polling rule, and workflow selection (chain / parallel / map-reduce / scatter-gather / review-fix-loop). 触发词：subagent 编排、后台委派、zsub、并行子任务、worktree 隔离、agent 派发、workflow 编排、run_workflow、多阶段流水线、多视角审查、审查修复循环、map-reduce、scatter-gather。
whenToUse: 主 agent 需要委派后台子任务、需要文件隔离或结构化输出的委派、需要续聊追问子任务、需要跨窗口管理 subagent 记录、或需要确定性多阶段编排（无需中途干预）时。
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

## zsub 六 action 速查（start/list/status/cancel/message/close）

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

## workflow 编排（run_workflow tool）

确定性多阶段管线：每阶段独立无头 session，中间结论自动链接/合并，主会话只收最终报告（markdown + JSON 双段）。带 progressToken 时有阶段级进度通知。

五种 workflow 速查与选择：

| 场景 | workflow | 形态 |
|------|----------|------|
| 已知 items 数组逐个处理再归总 | `map-reduce` | items + operation 必填，并行 map → 单 agent reduce |
| 单一目标多视角审查后聚合 | `parallel` | 默认 security/performance/maintainability，可传 perspectives |
| 大任务先拆分再并行再合并 | `scatter-gather` | scatter 拆 2-4 份 → 并行 process → gather |
| 并行审查 → 聚合 must-fix → 修复 → 重审到 clean | `review-fix-loop` | 唯一写文件的工作流（fix 阶段）；reviewers/maxRounds 可调 |
| 固定 分析 → 实现 → 总结 管线 | `chain` | 三步顺序链，上阶段结论注入下阶段 |

通用参数：`workflow` / `task` / `workdir`（必填，绝对路径，阶段在其下工作）；`model` / `maxConcurrent`（默认 3）/ `timeoutMsPerPhase`（默认 600000）。运行可达数分钟——启动后等结果，不要轮询。

CLI 等价入口（脚本化/调试）：`node bin/zsub.js workflow --workflow <名> --task "..." --workdir <绝对路径> [--json]`，用法详见 `node bin/zsub.js workflow`。

### 何时用 workflow vs subagent（zsub start）

| 特征 | 选择 |
|------|------|
| 固定多阶段管线、阶段间自动串联、无需中途干预 | run_workflow |
| 已知批量 items 的并行变换 | run_workflow（map-reduce） |
| 长驻任务、需要续聊追问（conversation）、需要完成通知异步唤醒主会话 | zsub start |
| 需要 worktree 改动隔离 + patch 回传、schema 结构化输出、agent .md 生态 | zsub start |
| 琐碎单文件修改、纯问答 | 都不用——直接做 |
