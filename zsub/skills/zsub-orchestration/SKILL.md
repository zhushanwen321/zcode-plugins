---
name: zsub-orchestration
description: Use when delegating tasks to background subagents via the zsub tool, deciding between zsub and engine-native background agents, or running multi-phase workflows via the run_workflow tool (run/abort/status/list/scripts/lint). Covers task decomposition, model routing, worktree isolation, completion notification semantics, the no-polling rule, and workflow selection (chain / parallel / map-reduce / scatter-gather / review-fix-loop / custom script:<name> via four-root discovery). 触发词：subagent 编排、后台委派、zsub、并行子任务、worktree 隔离、agent 派发、workflow 编排、run_workflow、多阶段流水线、多视角审查、审查修复循环、map-reduce、scatter-gather、自定义 workflow 脚本、workflow 脚本。
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

## zsub 七 action 速查（start/list/status/cancel/message/close/agents）

```
zsub(action="start", task="<自包含任务描述>", slug="<短名>",
     agent="<agent 名或 .md 路径,可选>", model="<模型短名,可选>",
     worktree=<bool>, conversation=<bool>, wait=<bool>)   → subagentId（wait=false 立即返回）
zsub(action="list")                                       → 全部 record（含 running/idle/终态）
zsub(action="status", subagentId="<id>")                  → 单条详情 + 结果路径
zsub(action="message", subagentId="<id>", text="<追问>")   → 续聊一轮（仅 conversation 且 idle）
zsub(action="cancel", subagentId="<id>")                  → 取消（SIGTERM→SIGKILL）
zsub(action="close", subagentId="<id>")                   → 关闭会话并清理 worktree
zsub(action="agents")                                     → 可用 agent .md 清单（name/description/file/source，四根发现）
```

start 前不确定有哪些 agent 可用时，先 `zsub(action="agents")` 查清单（四根发现，pi 生态 `.agents/agents/` 也在内；返回 name/description/来源根/文件路径）——这是平台按需查询等价物，代替 pi 的每 turn 常驻 agent 索引。

## 核心纪律

1. **task 必须自包含**：子任务看不到主会话上下文。把必要背景（文件路径、行号、验收标准）内联进 task，不要写"如前所述"。
2. **禁止轮询**：`wait=false` 启动后不要反复调 list/status 等结果。mailbox 模式下完成通知会自动注入；polling 模式下按 start 返回里的指引做一次性查询。通知到达前去做别的事，或结束当前轮次。
3. **通知即确认**：收到 `[subagent 完成]` 消息后直接处理结果，不要再调 status"二次确认"。
4. **并发克制**：默认上限 3。嵌套 subagent 深度越深可用并发越少（自动分层），不要试图绕过。
5. **模型路由**：默认 GLM-5.3（builtin:bigmodel-coding-plan 当前唯一启用模型）。不要凭记忆传其他短名——传错会收到「未知模型」错误并列出实际可用清单，按清单重传即可。
6. **worktree 任务收到完成通知后**：通知里含 `patchFile` 路径——需要落地改动时执行 `git apply <patchFile>`；不需要则明确告知用户改动保留在 patch 中未应用。

## 结果去向

- 完成通知（mailbox 注入）含结果摘要；全文在 `~/.zcode/zsub/outputs/<subagentId>.md`。
- 终态 record 的 error/timeout 字段含失败原因与恢复指引（如调大 timeoutMs、拆小任务）。

## workflow 编排（run_workflow tool，六 action）

确定性多阶段管线：每阶段独立无头 session，中间结论自动链接/合并，主会话只收最终报告（markdown + JSON 双段，落 `outputs/<runId>.md`）。**run 是后台任务**：立即返回 runId（`wf-` 前缀），完成自动通知本会话——与 zsub start 同一纪律，不要轮询；`wait=true` 同步等终态 + 报告全文（MCP 30s 超时约束，仅测试用）。

```
run_workflow(action="run", workflow="<名>", task="<自包含任务书>", workdir="<绝对路径>",
             [model, maxConcurrent, timeoutMsPerPhase, timeoutMs, per-workflow 参数])  → {runId, status:"running", notify}
run_workflow(action="abort", runId="<id>")     → 中止运行中 run（状态落 cancelled；已完成阶段保留在报告）
run_workflow(action="status", runId="<id>")    → run 详情 + 报告路径 + 脚本进度留痕（progress）
run_workflow(action="list")                    → 全部 workflow run
run_workflow(action="scripts")                 → 内置 5 + 自定义脚本清单（name/description/source/file）
run_workflow(action="lint", file="<脚本路径>") → 校验脚本（node --check 语法 + name/description/run 契约形状）
```

内置 5 种速查与选择：

| 场景 | workflow | 形态 |
|------|----------|------|
| 已知 items 数组逐个处理再归总 | `map-reduce` | items + operation 必填，并行 map → 单 agent reduce |
| 单一目标多视角审查后聚合 | `parallel` | 默认 security/performance/maintainability，可传 perspectives |
| 大任务先拆分再并行再合并 | `scatter-gather` | scatter 拆 2-4 份 → 并行 process → gather |
| 并行审查 → 聚合 must-fix → 修复 → 重审到 clean | `review-fix-loop` | 唯一写文件的工作流（fix 阶段）；reviewers/maxRounds 可调 |
| 固定 分析 → 实现 → 总结 管线 | `chain` | 三步顺序链，上阶段结论注入下阶段 |

通用参数：run 的 `workflow` / `task` / `workdir` 必填（绝对路径，阶段在其下工作）；`model` / `maxConcurrent`（默认 3）/ `timeoutMsPerPhase`（默认 600000）/ `timeoutMs`（整体超时，默认 1800000）。运行可达数分钟——后台 run 完成自动通知，通知到达前去做别的事。

### 自定义 workflow 脚本（script:<name>）

内置 5 种之外的编排用脚本扩展，调用形态 `workflow="script:<脚本名>"`。脚本发现四根（同构 agent .md 惯例；同名高优先级胜出，只扫各根顶层 `*.js`）：

```
<ws>/.agents/workflows/  >  <ws>/.zsub/workflows/
>  ~/.agents/workflows/  >  ~/.zsub/workflows/
```

脚本契约（CJS 模块，权威定义在 `lib/workflow-script.js` 头注）：

```js
'use strict';
module.exports = {
  name: 'my-wf',              // 脚本名（建议与文件名一致；lint 校验非空）
  description: '一句话说明',   // scripts 清单展示用；lint 校验非空
  run: async (ctx) => {
    // ctx = { task, cwd(=workdir), model, signal, timeoutMs, params, log, runAgent }
    ctx.log('进度留痕（action=status 的 progress 可查）');
    const r = await ctx.runAgent({
      prompt: '<自包含 prompt：该次 agent 调用的目标/背景/验收标准>',  // 必填
      cwd: '<可选，缺省 workdir>', model: '<可选>', timeoutMs: 600000,
    });
    // r = { ok, sessionId, response, usage, exitCode, timedOut, error?, aborted?, stderrTail }
    return { markdown: '# 报告正文', json: { machine: 'data' } };  // 或返回字符串（当 markdown）
  },
};
```

要点：

- `ctx.runAgent` 每次调用 = 一个独立 zcode 无头阶段，与内置 workflow 阶段同一执行落点（AbortSignal 契约、超时链、结果形态一致）；模型解析链 per-call model > 脚本级 model > 默认。`params` 是 run 调用时 task/workdir 之外的透传参数。
- 脚本抛错 = run 落 error 终态（错误含脚本文件路径）；`signal.aborted` 后再调 runAgent 零 spawn。
- 开发流程：写脚本 → `lint` 校验 → `scripts` 确认被发现 → `run_workflow(action="run", workflow="script:<名>", ...)`。
- 脚本在 server 进程内执行（fresh require，改动即生效）：不要维护跨 run 的可变全局态；信任前提与「用户主动放进四根目录的代码」一致。

CLI 等价入口（脚本化/调试）：`node bin/zsub.js workflow --workflow <名> --task "..." --workdir <绝对路径> [--json]`（`--action` 缺省 run，同步等完成——CLI 一次性进程无后台模式）；管理面 `node bin/zsub.js workflow --action <abort|status|list|scripts|lint> [--id <runId> | --file <脚本>]`。用法详见 `node bin/zsub.js workflow --help`。

### 何时用 workflow vs subagent（zsub start）

| 特征 | 选择 |
|------|------|
| 固定多阶段管线、阶段间自动串联、无需中途干预 | run_workflow |
| 已知批量 items 的并行变换 | run_workflow（map-reduce） |
| 长驻任务、需要续聊追问（conversation）、需要完成通知异步唤醒主会话 | zsub start |
| 需要 worktree 改动隔离 + patch 回传、schema 结构化输出、agent .md 生态 | zsub start |
| 琐碎单文件修改、纯问答 | 都不用——直接做 |
