---
name: zsub-zflow-orchestration
description: Use when delegating tasks to background subagents via the zsw CLI (`node bin/zsw.js`, the default daemon thin client since 1.0.0 — the zsub/zflow MCP tool face is offline, tools/call rejects and points to the CLI), deciding between zsub and engine-native background agents, or running multi-phase workflows via the zsw workflow subcommand (run/abort/status/list/scripts/lint). Covers task decomposition, model routing, worktree isolation, completion notification semantics, the no-polling rule, and workflow selection (chain / parallel / map-reduce / scatter-gather / review-fix-loop / custom script:<name> via four-root discovery). 触发词：subagent 编排、后台委派、zsub、并行子任务、worktree 隔离、agent 派发、workflow 编排、zflow、多阶段流水线、多视角审查、审查修复循环、map-reduce、scatter-gather、自定义 workflow 脚本、workflow 脚本。
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

## zsub CLI 速查（1.0.0 起：MCP 工具面已下线，`node bin/zsw.js` 是唯一入口；默认连常驻 daemon）

```
node bin/zsw.js start --task "<自包含任务描述>" --slug "<短名>"
     [--agent "<agent 名或 .md 路径>"] [--model "<模型短名>"]
     [--worktree] [--conversation] [--timeout-ms <n>] [--wait]  → subagentId（无 --wait 立即返回）
node bin/zsw.js list                          → 全部 record（含 running/idle/终态）
node bin/zsw.js status --id <id>              → 单条详情 + 结果路径
node bin/zsw.js message --id <id> --text "<追问>"  → 续聊一轮（仅 conversation 且 idle；投递即回，完成经 wait 收）
node bin/zsw.js cancel --id <id>              → 取消（SIGTERM→SIGKILL）
node bin/zsw.js close --id <id>               → 关闭会话并清理 worktree
node bin/zsw.js wait --id <id> [--id <id2> ...] [--timeout-ms <n>]  → 聚合等待到完成（终态，或 conversation 的 idle 本轮完成；partial → exit 2）
node bin/zsw.js agents                        → 可用 agent .md 清单（name/description/when/file/source，四根发现）
node bin/zsw.js models                        → 可用模型清单（短名/上下文窗口/推理档位/默认标记）
```

（`--local` 后门走一次性本地执行，仅调试用——无续聊/限流，CLI 退出即丢执行体。）

start 前不确定有哪些 agent 可用时，先 `node bin/zsw.js agents` 查清单（四根发现，pi 生态 `.agents/agents/` 也在内；返回 name/description/when/来源根/文件路径）——这是平台按需查询等价物，代替 pi 的每 turn 常驻 agent 索引。

## CLI 模式（默认，1.0.0 起）——首选等待姿势

1.0.0 起 MCP 工具面已下线（tools/list 恒空，工具列表无 `zsub`/`zflow`；tools/call 恒拒绝并指引走 CLI），agent 交互全走 `bin/zsw.js`——**不加 flag 即常驻 daemon thin client**（unix socket，sock 默认 `~/.zcode/zsw/daemon.sock`，`ZSW_SOCK` 可覆盖）：执行体由 daemon 持有（CLI 退出不丢），`start` 默认异步启动。**需要等待完成时，这是首选姿势**——用 Bash 工具 `run_in_background=true` 包裹 CLI：

```bash
# 派发 + 等待一步到位（--wait 是 start+wait 的 sugar）
node bin/zsw.js start --wait --task "<自包含任务书>" --slug <短名>

# 异步派发后聚合等待（多 id 全部完成才返回——终态或 conversation 的 idle；--timeout-ms 到点回 partial，exit 2）
node bin/zsw.js start --task "..." --slug a    # 前台，立即返回 subagentId
node bin/zsw.js wait --id sa-xxxx --id sa-yyyy  # run_in_background=true

# 管理面默认同走 daemon（list/status/message/cancel/close 同构）
node bin/zsw.js list
```

- **为什么配 `run_in_background=true`**：CLI 阻塞进程成为引擎进程内 background 任务，完成即触发引擎原生 `<task-notification>` 唤醒会话（idle 会话也唤醒）——这是唯一可靠的完成唤醒通道，勿用 `sleep N && status` 轮询替代。
- `wait` 无 `--local` 形态（本地一次性进程没有可挂起的等待方，显式报错）；等待在 daemon 侧内存挂起，零轮询。
- 失败恢复（按 CLI 实际报错文案）：
  - **daemon 不在场**：报 `daemon 未运行（connect ~/.zcode/zsw/daemon.sock 失败：<errno>）`。按报错内指引：稍候重试（多会话下其他实例接管需 1-2s）；仍失败则在任一 zcode 会话确认插件已启用；或加 `--local` 走本地一次性执行（调试后门：无续聊/限流，CLI 退出即丢执行体）。
  - **wait 期间 daemon 随宿主会话死亡**：报 `daemon 连接中断，未收到响应帧`（任务执行体随 daemon 终止）——任务状态稍后用 status 查询（record 由接管实例 recover 落盘），必要时重新派发。
- daemon 挂靠任一会话的插件进程：会话全关则 daemon 退场，其持有执行体的任务终止（record 已落盘，接管实例探活标记，不产生静默僵尸）。
- `--local` 显式走本地一次性执行（调试后门：start/message 阻塞到本轮完成，无续聊/限流，CLI 退出即丢执行体）；`zsw workflow` 的 run/lint 恒本地（见 workflow 节），abort/status/list/scripts 管理面默认同走 daemon。

## 核心纪律

1. **task 必须自包含**：子任务看不到主会话上下文。把必要背景（文件路径、行号、验收标准）内联进 task，不要写"如前所述"。
2. **禁止轮询**：异步启动后不要反复查 list/status 等结果，不要发明 `sleep N && status` 循环。完成唤醒走「CLI 模式（默认，1.0.0 起）」节姿势：`Bash(run_in_background=true)` 包裹 `zsw wait` / `zsw start --wait`，完成即引擎原生 task-notification 自动唤醒（不依赖 mailbox——那是 MCP 工具面时代的 legacy 投递通道，CLI/daemon 面恒无投递目标）。未包裹等待就结束 turn 的任务典型运行 3-10 分钟，先做别的，稍后做一次性 status 查询（`node bin/zsw.js status --id <id>`）。
3. **通知即确认**：收到 `[subagent 完成]` 消息后直接处理结果，不要再调 status"二次确认"。
4. **并发克制**：默认上限 3。嵌套 subagent 深度越深可用并发越少（自动分层），不要试图绕过。
5. **模型路由（环境无关）**：档位原则——重量任务（设计/架构/深度调研/复杂修复）不传 model，跟随默认主模型；简单任务（探索/计数/格式转换/测试）显式传轻量模型（`--model <轻量模型短名>`）降成本。可用模型集随 v2 config 变化，不要凭记忆硬编码名字——路由决策前先 `node bin/zsw.js models` 查当前清单（短名/上下文窗口/推理档位/默认标记）；传未知模型名也会在报错中收到可用清单，按清单重传即可。
6. **worktree 任务收到完成通知后**：通知里含 `patchFile` 路径——需要落地改动时执行 `git apply <patchFile>`；不需要则明确告知用户改动保留在 patch 中未应用。
7. **嵌套不支持**：zsub 不支持嵌套派发（子任务的 subagent 会被防递归门禁拒绝）；树形/多层的深度任务改用 zflow（review-fix-loop / scatter-gather），它们的阶段是编排不是嵌套。

### conversation 何时开

- ✅ 适用：多轮协作（审查-修复往复）、长间隔追问（>5min 后还要继续同一任务）。
- ❌ 不适用：单次探索/查询——默认 one-shot 即可，开了 conversation 反而占住会话资源。

## 结果去向

- 完成唤醒走 `zsw wait` / `zsw start --wait` + `run_in_background`（CLI 阻塞进程退出即引擎原生 task-notification）；全文在 `~/.zcode/zsw/outputs/<subagentId>.md`。
- 终态 record 的 error/timeout 字段含失败原因与恢复指引（如调大 timeoutMs、拆小任务）。

## workflow 编排（zsw workflow 子命令，六 action）

确定性多阶段管线：每阶段独立无头 session，中间结论自动链接/合并，主会话只收最终报告（markdown + JSON 双段，落 `outputs/<runId>.md`）。**run 是同步阻塞命令且恒本地执行**（执行体 = CLI 进程，跑到终态才退出，报告打 stdout）——需要「派发后做别的、完成唤醒」时，用 Bash `run_in_background=true` 包裹整条命令，CLI 退出即引擎原生通知（与 zsub wait 同一纪律，不要轮询）。

管理面边界（abort 语义）：abort/status/list/scripts 默认走 daemon——跨进程 record 一致，abort 经 daemon 侧句柄真停 daemon 持有的 run（signal 中止，已完成阶段保留在报告）。run/lint 恒本地：**abort 对本地 run 只终态化 record、不停执行体**——取消本地 run（bg bash 形态）用引擎 TaskStop 终止该 bash 任务，再（必要时经 daemon）补 abort 收尾 record。

```
node bin/zsw.js workflow --workflow <名> --task "<自包含任务书>" --workdir <绝对路径>
     [--model <短名>] [--max-concurrent <n>] [--timeout-per-phase <ms>] [--timeout-ms <ms>] [--json]
     [per-workflow 参数]                                  → 同步跑完出报告 + run 摘要（exit 0 = closed）
node bin/zsw.js workflow --action abort  --id <runId>     → 中止运行中 run（经 daemon 句柄真停；本地 run 只终态化 record，见「管理面边界」）
node bin/zsw.js workflow --action status  --id <runId>    → run 详情 + 报告路径 + 脚本进度留痕（progress）
node bin/zsw.js workflow --action list                    → 全部 workflow run
node bin/zsw.js workflow --action scripts                 → 内置 5 + 自定义脚本清单（name/description/source/file）
node bin/zsw.js workflow --action lint --file <脚本路径>  → 校验脚本（node --check 语法 + name/description/run 契约形状）
```

内置 5 种速查与选择：

| 场景 | workflow | 形态 |
|------|----------|------|
| 已知 items 数组逐个处理再归总 | `map-reduce` | items + operation 必填，并行 map → 单 agent reduce |
| 单一目标多视角审查后聚合 | `parallel` | 默认 security/performance/maintainability，可传 perspectives |
| 大任务先拆分再并行再合并 | `scatter-gather` | scatter 拆 2-4 份 → 并行 process → gather |
| 并行审查 → 聚合 must-fix → 修复 → 重审到 clean | `review-fix-loop` | 唯一写文件的工作流（fix 阶段）；reviewers/maxRounds 可调 |
| 固定 分析 → 实现 → 总结 管线 | `chain` | 三步顺序链，上阶段结论注入下阶段 |

通用参数：run 的 `--workflow` / `--task` / `--workdir` 必填（绝对路径，阶段在其下工作）；`--model`（可用清单先查 `node bin/zsw.js models`——模型集随环境变化，勿硬编码）/ `--max-concurrent`（默认 3）/ `--timeout-per-phase`（默认 600000）/ `--timeout-ms`（整体超时，默认 1800000）。运行可达数分钟——run_in_background 包裹时完成通知自动到达，通知到达前去做别的事。

### 自定义 workflow 脚本（script:<name>）

内置 5 种之外的编排用脚本扩展，调用形态 `--workflow script:<脚本名>`。脚本发现四根（同构 agent .md 惯例；同名高优先级胜出，只扫各根顶层 `*.js`）：

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
- 开发流程：写脚本 → `lint` 校验 → `scripts` 确认被发现 → `node bin/zsw.js workflow --workflow script:<名> --task ... --workdir ...`。
- 脚本在 server 进程内执行（fresh require，改动即生效）：不要维护跨 run 的可变全局态；信任前提与「用户主动放进四根目录的代码」一致。

CLI 入口（agent 与人类同款）：`node bin/zsw.js workflow --workflow <名> --task "..." --workdir <绝对路径> [--json]`（`--action` 缺省 run，本地同步执行到终态——「后台」用 Bash `run_in_background` 包裹即原生唤醒）；管理面 `node bin/zsw.js workflow --action <abort|status|list|scripts|lint> [--id <runId> | --file <脚本>]`（abort/status/list/scripts 默认经 daemon，lint 恒本地）。用法详见 `node bin/zsw.js workflow --help`。

### 何时用 workflow vs subagent（zsub start）

| 特征 | 选择 |
|------|------|
| 固定多阶段管线、阶段间自动串联、无需中途干预 | zflow |
| 已知批量 items 的并行变换 | zflow（map-reduce） |
| 长驻任务、需要续聊追问（conversation）、需要完成通知异步唤醒主会话 | zsub start |
| 需要 worktree 改动隔离 + patch 回传、schema 结构化输出、agent .md 生态 | zsub start |
| 琐碎单文件修改、纯问答 | 都不用——直接做 |
