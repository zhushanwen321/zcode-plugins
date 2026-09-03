---
name: zsub-zflow-orchestration
description: Use when delegating tasks to subagents via the zsw CLI (`node bin/zsw.js`, pure local one-shot processes since 2.0.0 — no resident daemon; long tasks are carried by Bash run_in_background), deciding between zsub and engine-native background agents, or running multi-step workflows via the zsw workflow subcommand (run/abort/status/list/scripts/lint plus the script-generate/save/delete creative loop; vendored subagent-core orchestration since the 2b rewire — core-contract scripts with @pi-meta + top-level agent(), referenced by absolute .js path). Covers task decomposition, model routing, worktree isolation, completion notification semantics, the no-polling rule, workflow selection (chain / parallel / map-reduce / scatter-gather / review-fix-loop / custom scripts by path), and the script creative loop (generate → lint → save → run → delete). 触发词：subagent 编排、后台委派、zsub、并行子任务、worktree 隔离、agent 派发、workflow 编排、zflow、多阶段流水线、多视角审查、审查修复循环、map-reduce、scatter-gather、自定义 workflow 脚本、workflow 脚本、脚本创作、script-generate。
whenToUse: 主 agent 需要委派后台子任务、需要文件隔离或结构化输出的委派、需要多轮拆解委派子任务（续聊通道当前不可用——拆多次 start）、需要跨窗口管理 subagent 记录、需要确定性多阶段编排（无需中途干预）、或需要创作/固化自定义 workflow 脚本时。
---

# zsub/zflow 编排指南

## 分流决策：先用原生，再考虑 zsub

派发子任务前先判断需求，**不要无脑用 zsub**：

| 需求 | 用什么 |
|------|--------|
| 简单纯后台任务（审查/调研/生成，不需要隔离和结构化输出） | 引擎原生 `@agent`（frontmatter 写 `background: true`）——原生提供独立 turn 完成唤醒 + goal gate 等待，语义更强 |
| 文件改动需要隔离（worktree + patch 回传） | zsub |
| 需要结构化 JSON 输出（schema——zsw 壳层为可解析 JSON 提取，非 schema 校验） | zsub |
| 需要多轮协作（审查-修复往复、长间隔追问——拆多次 start，续聊通道当前不可用） | zsub |
| agent 定义在 `.agents/agents/`（pi 生态目录，引擎不扫） | zsub |
| 需要逐次指定模型（per-start model 路由） | zsub |
| 需要跨窗口/跨会话查看历史 subagent 记录 | zsub |

## zsub CLI 速查（2.0.0 起：纯本地一次性执行，无常驻 daemon；`node bin/zsw.js` 是唯一入口）

本文 `node bin/zsw.js` 为示意路径；实际执行以 SessionStart 注入段给出的 `node "<绝对路径>/bin/zsw.js"` 形态为准。

```
node bin/zsw.js start --task "<自包含任务描述>" --slug "<短名>"
     [--agent "<agent .md 绝对路径>"] [--model "<模型短名>"]
     [--worktree] [--conversation] [--timeout-ms <n>] [--wait]  → 终态结果（start 恒阻塞到本轮完成；--wait 接受但无差异）
node bin/zsw.js list                          → 全部 record（含 running/idle/终态）
node bin/zsw.js status --id <id>              → 单条详情 + 结果路径
node bin/zsw.js message --id <id> --text "<追问>"  → 续聊不可用（EnginePort 契约无 resume 入口，投递即报可操作错误）；多轮需求拆多次 start
node bin/zsw.js cancel --id <id>              → 取消（SIGTERM→SIGKILL）
node bin/zsw.js close --id <id>               → 关闭会话并清理 worktree
node bin/zsw.js agents                        → 可用 agent .md 清单（name/description/when/location/file/source，四根+vendored 内置）
node bin/zsw.js models [--all]                   → 可用模型清单（默认 provider 明细：短名/上下文窗口/推理档位/默认标记；--all = 全部带凭据 provider 全名视图）
```

**agent 参数契约（与 pi 平台统一）**：`--agent` 只收 **.md 绝对路径**（支持 `~/` 前缀展开）。传名字（如 `reviewer`）会被拒，报错 `Invalid agent ref: ...`（与 pi 侧同源）并给路径指引——路径取 agents 清单的 `location`/`file` 列。缺省不传 = 加载 `general-purpose` 内置角色（通用兜底；project 级同名 .md 可遮蔽覆写）；不想要角色时显式传自定义 .md 路径。

（`--local` 是 1.x daemon/本地双形态的遗产 flag：2.0 起本地是唯一形态，接受但忽略——旧脚本零改动迁移。）

start 前不确定有哪些 agent 可用时，优先看会话上下文 `<available_subagents>` 段（SessionStart 注入，core 发现：vendored 内置 10 角色 + 用户根，每个条目带 `<location>` 绝对路径，快照在场即免查询；内置遮用户级同名、project 级同名可遮蔽内置）；快照缺席或疑过期时再 `node bin/zsw.js agents` 查清单（vendored 内置 10 角色 + 用户根发现，pi 生态 `.agents/agents/` 也在内；返回 name/description/when/来源根/路径）——这是平台按需查询等价物，代替 pi 的每 turn 常驻 agent 索引。

## 等待与完成唤醒——首选姿势

2.0 起无常驻 daemon，start 的执行体就是 CLI 进程本身（进程活着任务才活着，命令阻塞到任务终态）。**长任务必须用 Bash 工具 `run_in_background=true` 包裹 CLI**——前台 Bash 有工具超时（默认 120s、上限 10 分钟），会被杀掉并丢失结果：

```bash
# 派发 + 等待一步到位（阻塞到完成；run_in_background 包裹后完成即原生通知）
node bin/zsw.js start --task "<自包含任务书>" --slug <短名>

# 管理面查询（瞬时命令，前台直跑）
node bin/zsw.js list
```

- **为什么配 `run_in_background=true`**：CLI 阻塞进程成为引擎进程内 background 任务，完成即触发引擎原生 `<task-notification>` 唤醒会话（idle 会话也唤醒）——这是唯一可靠的完成唤醒通道，勿用 `sleep N && status` 轮询替代。
- start 终态 exit code：closed / idle（conversation 本轮完成）→ 0；cancelled/error/timeout/lost → 1。
- 执行体生命周期 = CLI 进程生命周期：会话关闭等导致后台 bash 进程死亡时任务随亡（record 已落盘，下次 list/status 可见非终态），必要时重新派发。

## 核心纪律

1. **task 必须自包含**：子任务看不到主会话上下文。把必要背景（文件路径、行号、验收标准）内联进 task，不要写"如前所述"。
2. **禁止轮询**：启动后不要反复查 list/status 等结果，不要发明 `sleep N && status` 循环。完成唤醒走「等待与完成唤醒」节姿势：`Bash(run_in_background=true)` 包裹 `zsw start`，完成即引擎原生 task-notification 自动唤醒（不依赖 mailbox——那是 MCP 工具面时代的 legacy 投递通道，CLI 面恒无投递目标）。未包裹等待就结束 turn 的任务典型运行 3-10 分钟，先做别的，稍后做一次性 status 查询（`node bin/zsw.js status --id <id>`）。
3. **通知即确认**：收到 `[subagent 完成]` 消息后直接处理结果，不要再调 status"二次确认"。
4. **并发克制**：默认并发上限 3；嵌套当前不支持（防递归门禁直接拒绝，depth 恒 0），分层为预留能力——不要试图绕过。
5. **模型路由（环境无关）**：模型引用优先取自会话上下文的 `<available_provider_models>` 段（SessionStart 注入，与 pi 同构；`<id>` 即全名 `<provider>/<model>`，默认 provider 的模型可短名直传；段引导文案含当前默认模型与快照时戳，能力标记 `<caps>reasoning</caps>` 与 `<contextWindow>` 标注档位/窗口；另含 `<available_subagents>` / `<available_workflows>` 清单），免查询直接派发。默认档位以段引导文案的当前默认为准，**不假设「不传 model = 重量」**：默认是轻量模型时，重量任务（设计/架构/深度调研/复杂修复）必须显式传重量模型；简单任务（探索/计数/格式转换/测试）跟随默认即可。模型名不要凭记忆硬编码。快照缺失或疑似过期（GUI 中途改过配置）时走两条兜底：优先直接尝试——传错模型名会在报错中收到可用清单，按清单重传（零依赖权威兜底）；或主动现查 `node bin/zsw.js models`（默认 provider 明细；跨 provider 用 `--all` 全名视图）。模型名以快照与报错内清单为准，静态路由表（AGENTS.md 等）中的具体名字可能过期。
6. **worktree 任务收到完成通知后**：通知里含 `patchFile` 路径——需要落地改动时执行 `git apply <patchFile>`；不需要则明确告知用户改动保留在 patch 中未应用。
7. **嵌套不支持**：zsub 不支持嵌套派发（子任务的 subagent 会被防递归门禁拒绝）；树形/多层的深度任务改用 zflow（review-fix-loop / scatter-gather），它们的阶段是编排不是嵌套。

### conversation 何时开

- **续聊暂不可用**（EnginePort 契约无 resume 入口）：conversation 任务首轮照常（完成置 idle），`message` 续聊即报可操作错误——多轮需求（审查-修复往复、长间隔追问）**拆成多次 start**，每轮 task 自包含：上轮结论/结果路径写进下一轮 task（结果全文在 `~/.zcode/zsw/outputs/<subagentId>.md`，可作下轮输入）。
- conversation 标志当前只剩 record 状态机语义（首轮完成置 idle），单次探索/查询默认 one-shot 即可。

## 结果去向

- 完成唤醒走 `zsw start` + `run_in_background`（CLI 阻塞进程退出即引擎原生 task-notification）；全文在 `~/.zcode/zsw/outputs/<subagentId>.md`。
- 终态 record 的 error/timeout 字段含失败原因与恢复指引（如调大 timeoutMs、拆小任务）。

## workflow 编排（zsw workflow 子命令，九 action；回接 2b 起 = vendored subagent-core orchestration）

确定性多步编排：每次 `agent()` 调用一个独立 agent 会话（经 zsw runner 通道），脚本在 core worker 线程内编排，主会话只收最终 scriptResult（markdown + JSON 双段渲染打 stdout）。**run 是同步阻塞命令**（执行体 = CLI 进程，跑到终态才退出）——用 Bash `run_in_background=true` 包裹整条命令（前台会被工具超时杀死），CLI 退出即引擎原生通知（不要轮询）。

**workflow 引用契约（与 pi 平台统一，D-4/D-E3）**：`--workflow` 收内置名、saved 裸名（script-save 落盘的发现面脚本）或 .js 绝对路径（`~/` 前缀可展开）；`script:<名>` 前缀拒收——报错自带恢复指引；与内置同名的 saved 脚本按名 run 时跑内置并出遮蔽 warning（含双路径），按路径消歧或改名；路径取 `--action scripts` 清单的 `path` 字段或注入段 `<available_workflows>` 条目的 `<location>`。

run 状态面（与旧版差异）：内存索引 + `<zsw 数据根>/workflow-state/<runId>.jsonl` append-only 快照（`status` 返回 `stateFile` 路径）；不再写 zsw record 事件流，也不再投 mailbox 完成通知——异步 run 的结果查询用 `--action status`（done run 内存保留有上限，淘汰后按 stateFile 提示读快照文件）。一次性 CLI 进程不重水合历史 run——历史快照在 `<zsw 数据根>/workflow-state/*.jsonl` 直读。

管理面边界（abort 语义）：全部 action 恒本地——一次性进程只有本进程创建的 run 视图（abort/status 对历史 run 报「不存在」，历史快照直读 workflow-state/*.jsonl）。取消运行中的 run（bg bash 形态）用引擎 TaskStop 终止该 bash 任务即可（进程死即 worker 死）；script-delete 无「运行中拒绝」闸（单执行体约定下并发冲突不存在）。

```
node bin/zsw.js workflow --workflow <内置名|脚本绝对路径> --task "<自包含任务书>" --workdir <绝对路径>
     [--model <短名>] [--timeout-ms <ms>] [--json]
     [per-workflow 参数]                                  → 同步跑完出报告 + run 摘要（exit 0 = reason completed）
node bin/zsw.js workflow --action abort  --id <runId>     → 中止本进程运行中 run（历史 run 不可 abort，用 TaskStop 杀 bg bash）
node bin/zsw.js workflow --action status  --id <runId>    → run 详情（reason/error/scriptResult/steps/stateFile）
node bin/zsw.js workflow --action list                    → 全部 workflow run（精简视图）
node bin/zsw.js workflow --action scripts                 → vendored 内置 5 + 用户脚本（name/path/available/source）
node bin/zsw.js workflow --action lint --file <脚本路径>  → 校验脚本（core lintScript：agent() 入口等契约）
node bin/zsw.js workflow --action script-generate --name <名> --script "<JS 源码>"   → 五道闸校验 + tmp 落盘（恒本地）
node bin/zsw.js workflow --action script-save --name <名>     → tmp 固化 ~/.zsw/workflows/（重名拒绝）
node bin/zsw.js workflow --action script-delete --name <名>   → 删 tmp/已固化脚本
```

内置 5 种速查与选择（资产来自 vendored subagent-core workflows/，参数经 $ARGS 传入）：

| 场景 | workflow | 形态与参数 |
|------|----------|-----------|
| 已知 items 数组逐个处理再归总 | `map-reduce` | `--operation` + `--items` 必填，并行 map → 单 agent reduce |
| 单一目标多视角审查后聚合 | `parallel` | `--task`（作 target）或显式 `--target`；默认 security/performance/maintainability，可传 `--perspectives` |
| 大任务先拆分再并行再合并 | `scatter-gather` | `--task` 必填（自适应拆分，无 subtask-count 参数） |
| 批次审查 → 聚合裁决 → 修复 → 对账重审到 clean | `review-fix-loop` | 唯一写文件的工作流（fix 阶段）。`--batch1..--batchN`（值 = agent .md 绝对路径，逗号分隔；至少一个批次）、`--target` 必填（git-diff 传 base ref）、`--target-type` 缺省 text、`--max-rounds`（默认 10）/`--stuck-threshold`（默认 3）/`--skip-clean-agents`（默认 true）/`--recheck-after-fix`（默认 false）/`--aggregator-model` 等可调，参数全集 `zsw workflow --help`。旧 `--reviewers`（自由文本维度）已废弃，显式报错 |
| 固定 分析 → 变换 → 综合 管线 | `chain` | `--task` 必填，三步顺序链，上阶段结论注入下阶段 |

通用参数：run 的 `--workflow` / `--task` / `--workdir` 必填（绝对路径，agent() 调用在其下工作）；`--model`（模型引用优先取上下文 `<available_provider_models>` 段；快照缺失或疑过期再现查 `node bin/zsw.js models`）/ `--timeout-ms`（整体墙钟预算 RunSpec.budgetTimeMs，不设则无限制）。`--max-concurrent` / `--timeout-per-phase` / `--subtask-count` 已废弃（core 编排无对应面）——传入会 stderr 显式 warning，不静默。运行可达数分钟——run_in_background 包裹时完成通知自动到达。

### 自定义 workflow 脚本（绝对路径引用 + 创作闭环）

内置 5 种之外的编排用 core 契约脚本扩展，run 按 **.js 绝对路径**或 **saved 裸名**引用（`~/` 前缀可展开；`script:<名>` 前缀拒收；saved 裸名与内置同名时内置优先 + 遮蔽 warning——路径引用是最无歧义形态）。发现面按下序遮蔽（同名先到先得，即列表序；序 = vendored core buildScanTargets 实际扫描序 + host 注入序；ref 解析时内置名恒优先于一切发现面）：

```
vendored 内置 5（名不可被遮蔽——registry 内置优先于一切发现面）
> ~/.zsw/workflows/  >  ~/.agents/workflows/               （core user 级发现面；前者经 discoveryRoots 注入、借 user-pi 槽，先于 core 自带 user 根）
> <ws>/.pi/workflows/  >  <ws>/.pi/workflows/.tmp/  >  <ws>/.agents/workflows/   （core workspace 级发现面，cwd 推导 workspace 根）
> <ws>/.zsw/workflows/                                      （zsw workspace 级特有根，host 手工扫，byName 兜底末位——不遮蔽前面任何根）
```

脚本契约（**core worker 契约**，权威定义在 vendored `workflows/chain.js` 等资产源码；与旧 zsw 契约不兼容，迁移对照见 README）：

```js
/* @pi-meta
name: my-wf
description: 一句话说明（必填）
phases: [run]
*/
// top-level await 脚本（非 CJS module.exports）：core worker 线程内执行
// 可用全局：agent(opts) / parallel(promises) / pipeline(fns) / phase(name) / log(text)
//          workflow(name, args)（嵌套）/ $ARGS（run 参数）/ $WORKSPACE / $BUDGET
const task = $ARGS.task;                       // run 透传参数（白名单外 flag 全进 $ARGS）
log('进度留痕（core log 通道，stderr + 落盘）');
const r = await agent({
  prompt: '<自包含 prompt：该次 agent 调用的目标/背景/验收标准>',  // 必填
  model: '<可选，缺省继承 run 级 --model>', timeoutMs: 600000,
  agent: '<可选 agent .md 绝对路径；缺省 = general-purpose 内置角色>', schema: { /* 可选 JSON Schema；zsw 壳层仅做可解析 JSON 提取，不校验 schema 符合性——关键字段消费方自行校验 */ },
});
// r = agent() 返回值 = 该次调用的 parsedOutput ?? content（schema 传入且输出可解析 JSON 时才有 parsedOutput——仅保证可解析，不校验 schema 符合性）
return { summary: '结果' };                     // scriptResult（任意可结构化克隆值）
```

**创作闭环（推荐路径——不用手写文件再找目录）**：`script-generate`（把源码交给 core 五道闸校验：ESM 拒绝 / meta 必需 / agent() 必需 / 语法 / @pi-meta round-trip，非法报错含行列可自纠正；合法自动落 tmp）→ `lint` 复核（可选）→ `script-save` 固化到 `~/.zsw/workflows/`（save 后 `scripts` 清单可见）→ run 按绝对路径引用 → `script-delete` 清理：

```bash
node bin/zsw.js workflow --action script-generate --name my-wf --script "<完整 JS 源码>"
node bin/zsw.js workflow --action lint --file ~/.zsw/workflows/.tmp/my-wf.js
node bin/zsw.js workflow --action script-save --name my-wf
node bin/zsw.js workflow --workflow ~/.zsw/workflows/my-wf.js --task "..." --workdir <绝对路径>
node bin/zsw.js workflow --action script-delete --name my-wf
```

要点：

- `agent()` 每次调用 = 一个独立 agent 会话（经 zsw runner 通道 = core zcode engine，同 zsub 线：单一 app-server 常驻引擎复用，共享宿主 HOME——直接消费宿主 `~/.zcode/` 凭据/模型配置/会话 db）；模型解析链 per-call model > run 级 `--model` > 默认。
- 脚本抛错 / worker 崩溃 = run 落 `done,failed`（core error-recovery 含崩溃重试）；abort 后 pending 的 agent() 调用立即拒绝。
- 脚本同目录依赖用 `require(path.dirname(workerData.scriptPath) + "/dep.cjs")` 锚定（worker eval 沙箱内相对路径以 cwd 为基准，不能写相对 require）。
- 手工放置形态：写好 .js 直接放进发现根（上表目录）→ `scripts` 确认被发现 → run 按路径引用；或走上方创作闭环。
- 脚本在 worker 线程内执行：不要维护跨 run 的可变全局态；信任前提与「用户主动放进发现根的代码」一致。

### 何时用 workflow vs subagent（zsub start）

| 特征 | 选择 |
|------|------|
| 固定多阶段管线、阶段间自动串联、无需中途干预 | zflow |
| 已知批量 items 的并行变换 | zflow（map-reduce） |
| 长驻任务、多轮拆解（拆多次 start，续聊通道当前不可用）、需要完成通知异步唤醒主会话 | zsub start |
| 需要 worktree 改动隔离 + patch 回传、structured JSON 输出（可解析对象提取，非 schema 校验）、agent .md 生态 | zsub start |
| 琐碎单文件修改、纯问答 | 都不用——直接做 |
