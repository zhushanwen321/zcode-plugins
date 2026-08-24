---
name: zsub-zflow-orchestration
description: Use when delegating tasks to background subagents via the zsub tool, deciding between zsub and engine-native background agents, or running multi-phase workflows via the zflow tool (run/abort/status/list/scripts/lint). Covers task decomposition, model routing, worktree isolation, completion notification semantics, the no-polling rule, and workflow selection (chain / parallel / map-reduce / scatter-gather / review-fix-loop / custom script:<name> via four-root discovery). 触发词：subagent 编排、后台委派、zsub、并行子任务、worktree 隔离、agent 派发、workflow 编排、zflow、多阶段流水线、多视角审查、审查修复循环、map-reduce、scatter-gather、自定义 workflow 脚本、workflow 脚本。
whenToUse: 主 agent 需要委派后台子任务、需要文件隔离或结构化输出的委派、需要续聊追问子任务、需要跨窗口管理 subagent 记录、或需要确定性多阶段编排（无需中途干预）时。
---

# zsub/zflow 编排指南

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

## zsub 八 action 速查（start/list/status/cancel/message/close/agents/models）

```
zsub(action="start", task="<自包含任务描述>", slug="<短名>",
     agent="<agent 名或 .md 路径,可选>", model="<模型短名,可选>",
     worktree=<bool>, conversation=<bool>, wait=<bool>)   → subagentId（wait=false 立即返回）
zsub(action="list")                                       → 全部 record（含 running/idle/终态）
zsub(action="status", subagentId="<id>")                  → 单条详情 + 结果路径
zsub(action="message", subagentId="<id>", text="<追问>")   → 续聊一轮（仅 conversation 且 idle）
zsub(action="cancel", subagentId="<id>")                  → 取消（SIGTERM→SIGKILL）
zsub(action="close", subagentId="<id>")                   → 关闭会话并清理 worktree
zsub(action="agents")                                     → 可用 agent .md 清单（name/description/when/file/source，四根发现）
zsub(action="models")                                     → 可用模型清单（短名/上下文窗口/推理档位/默认标记）
```

start 前不确定有哪些 agent 可用时，先 `zsub(action="agents")` 查清单（四根发现，pi 生态 `.agents/agents/` 也在内；返回 name/description/when/来源根/文件路径）——这是平台按需查询等价物，代替 pi 的每 turn 常驻 agent 索引。

## daemon 等待模式（CLI，插件 ≥0.2.0）——首选等待姿势

`bin/zsw.js` 子命令加 `--daemon` 走常驻 daemon（unix socket thin client，sock 默认 `~/.zcode/zsw/daemon.sock`，`ZSW_SOCK` 可覆盖）：执行体由 daemon 持有（CLI 退出不丢），`start` 默认异步启动。**需要等待完成时，这是 0.2.0 起的首选姿势**——用 Bash 工具 `run_in_background=true` 包裹 CLI：

```bash
# 派发 + 等待一步到位（--wait 是 start+wait 的 sugar）
node bin/zsw.js start --daemon --wait --task "<自包含任务书>" --slug <短名>

# 异步派发后聚合等待（多 id 全部终态才返回；--timeout-ms 到点回 partial，exit 2）
node bin/zsw.js start --daemon --task "..." --slug a    # 前台，立即返回 subagentId
node bin/zsw.js wait --daemon --id sa-xxxx --id sa-yyyy  # run_in_background=true

# 管理面加 --daemon 即走 daemon（list/status/message/cancel/close 同构）
node bin/zsw.js list --daemon
```

- **为什么配 `run_in_background=true`**：CLI 阻塞进程成为引擎进程内 background 任务，完成即触发引擎原生 `<task-notification>` 唤醒会话（idle 会话也唤醒）——这是唯一可靠的完成唤醒通道，勿用 `sleep N && status` 轮询替代。
- `wait` 必须带 `--daemon`（本地一次性进程没有可挂起的等待方）；等待在 daemon 侧内存挂起，零轮询。
- 失败恢复（按 CLI 实际报错文案）：
  - **daemon 不在场**：报 `daemon 未运行（connect ~/.zcode/zsw/daemon.sock 失败：<errno>）`。按报错内指引：稍候重试（多会话下其他实例接管需 1-2s）；仍失败则在任一 zcode 会话确认插件已启用；或去掉 `--daemon` 走本地执行（一次性进程语义，无续聊/限流）。
  - **wait 期间 daemon 随宿主会话死亡**：报 `daemon 连接中断，未收到响应帧`（任务执行体随 daemon 终止）——任务状态稍后用 status 查询（record 由接管实例 recover 落盘），必要时重新派发。
- daemon 挂靠任一会话的插件进程：会话全关则 daemon 退场，其持有执行体的任务终止（record 已落盘，接管实例探活标记，不产生静默僵尸）。
- 不加 `--daemon` 保持本地一次性执行语义（start/message 阻塞到本轮完成；存量用法无感）。MCP `zsub`/`zflow` tool 面行为不变（双面并存）；`zsw workflow` 子命令无 daemon 形态。

## 核心纪律

1. **task 必须自包含**：子任务看不到主会话上下文。把必要背景（文件路径、行号、验收标准）内联进 task，不要写"如前所述"。
2. **禁止轮询**：`wait=false` 启动后不要反复调 list/status 等结果，不要发明 `sleep N && status` 循环。等待姿势按入口选：CLI daemon 面（≥0.2.0，首选）按「daemon 等待模式」节用 `Bash(run_in_background=true)` 等待，完成通知自动唤醒；MCP 面保持既有姿势——mailbox 模式下完成通知自动注入，polling 模式下任务典型运行 3-10 分钟，先做别的或结束当前轮次，稍后按 start 返回里的指引做一次性 status 查询。
3. **通知即确认**：收到 `[subagent 完成]` 消息后直接处理结果，不要再调 status"二次确认"。
4. **并发克制**：默认上限 3。嵌套 subagent 深度越深可用并发越少（自动分层），不要试图绕过。
5. **模型路由（环境无关）**：档位原则——重量任务（设计/架构/深度调研/复杂修复）不传 model，跟随默认主模型；简单任务（探索/计数/格式转换/测试）显式传轻量模型（`model="<轻量模型短名>"`）降成本。可用模型集随 v2 config 变化，不要凭记忆硬编码名字——路由决策前先 `zsub(action="models")` 查当前清单（短名/上下文窗口/推理档位/默认标记）；传未知模型名也会在报错中收到可用清单，按清单重传即可。
6. **worktree 任务收到完成通知后**：通知里含 `patchFile` 路径——需要落地改动时执行 `git apply <patchFile>`；不需要则明确告知用户改动保留在 patch 中未应用。
7. **嵌套不支持**：zsub 不支持嵌套派发（子任务的 subagent 会被防递归门禁拒绝）；树形/多层的深度任务改用 zflow（review-fix-loop / scatter-gather），它们的阶段是编排不是嵌套。

### conversation 何时开

- ✅ 适用：多轮协作（审查-修复往复）、长间隔追问（>5min 后还要继续同一任务）。
- ❌ 不适用：单次探索/查询——默认 one-shot 即可，开了 conversation 反而占住会话资源。

## 结果去向

- 完成通知（mailbox 注入）含结果摘要；全文在 `~/.zcode/zsw/outputs/<subagentId>.md`。
- 终态 record 的 error/timeout 字段含失败原因与恢复指引（如调大 timeoutMs、拆小任务）。

## workflow 编排（zflow tool，六 action）

确定性多阶段管线：每阶段独立无头 session，中间结论自动链接/合并，主会话只收最终报告（markdown + JSON 双段，落 `outputs/<runId>.md`）。**run 是后台任务**：立即返回 runId（`wf-` 前缀），完成自动通知本会话——与 zsub start 同一纪律，不要轮询；`wait=true` 同步等终态 + 报告全文（MCP 30s 超时约束，仅测试用）。

```
zflow(action="run", workflow="<名>", task="<自包含任务书>", workdir="<绝对路径>",
             [model, maxConcurrent, timeoutMsPerPhase, timeoutMs, per-workflow 参数])  → {runId, status:"running", notify}
zflow(action="abort", runId="<id>")     → 中止运行中 run（状态落 cancelled；已完成阶段保留在报告）
zflow(action="status", runId="<id>")    → run 详情 + 报告路径 + 脚本进度留痕（progress）
zflow(action="list")                    → 全部 workflow run
zflow(action="scripts")                 → 内置 5 + 自定义脚本清单（name/description/source/file）
zflow(action="lint", file="<脚本路径>") → 校验脚本（node --check 语法 + name/description/run 契约形状）
```

内置 5 种速查与选择：

| 场景 | workflow | 形态 |
|------|----------|------|
| 已知 items 数组逐个处理再归总 | `map-reduce` | items + operation 必填，并行 map → 单 agent reduce |
| 单一目标多视角审查后聚合 | `parallel` | 默认 security/performance/maintainability，可传 perspectives |
| 大任务先拆分再并行再合并 | `scatter-gather` | scatter 拆 2-4 份 → 并行 process → gather |
| 并行审查 → 聚合 must-fix → 修复 → 重审到 clean | `review-fix-loop` | 唯一写文件的工作流（fix 阶段）；reviewers/maxRounds 可调 |
| 固定 分析 → 实现 → 总结 管线 | `chain` | 三步顺序链，上阶段结论注入下阶段 |

通用参数：run 的 `workflow` / `task` / `workdir` 必填（绝对路径，阶段在其下工作）；`model`（可用清单先查 `zsub(action="models")`——模型集随环境变化，勿硬编码）/ `maxConcurrent`（默认 3）/ `timeoutMsPerPhase`（默认 600000）/ `timeoutMs`（整体超时，默认 1800000）。运行可达数分钟——后台 run 完成自动通知，通知到达前去做别的事。

### 自定义 workflow 脚本（script:<name>）

内置 5 种之外的编排用脚本扩展，调用形态 `workflow="script:<脚本名>"`。脚本发现四根（同构 agent .md 惯例；同名高优先级胜出，只扫各根顶层 `*.js`）：

```
<ws>/.agents/workflows/  >  <ws>/.zsw/workflows/
>  ~/.agents/workflows/  >  ~/.zsw/workflows/
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
- 开发流程：写脚本 → `lint` 校验 → `scripts` 确认被发现 → `zflow(action="run", workflow="script:<名>", ...)`。
- 脚本在 server 进程内执行（fresh require，改动即生效）：不要维护跨 run 的可变全局态；信任前提与「用户主动放进四根目录的代码」一致。

CLI 等价入口（脚本化/调试）：`node bin/zsw.js workflow --workflow <名> --task "..." --workdir <绝对路径> [--json]`（`--action` 缺省 run，同步等完成——CLI 一次性进程无后台模式）；管理面 `node bin/zsw.js workflow --action <abort|status|list|scripts|lint> [--id <runId> | --file <脚本>]`。用法详见 `node bin/zsw.js workflow --help`。

### 何时用 workflow vs subagent（zsub start）

| 特征 | 选择 |
|------|------|
| 固定多阶段管线、阶段间自动串联、无需中途干预 | zflow |
| 已知批量 items 的并行变换 | zflow（map-reduce） |
| 长驻任务、需要续聊追问（conversation）、需要完成通知异步唤醒主会话 | zsub start |
| 需要 worktree 改动隔离 + patch 回传、schema 结构化输出、agent .md 生态 | zsub start |
| 琐碎单文件修改、纯问答 | 都不用——直接做 |
