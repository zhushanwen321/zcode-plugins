# z-subagent-workflow — zcode subagent 编排 + workflow 插件

> 两条能力线，1.0.0 起统一走 CLI（`node bin/zsw.js`，默认连常驻 daemon thin client；MCP 工具面已下线——tools/list 恒空、tools/call 指引走 CLI）：
> **zsub** — 无头 subagent 生命周期管理（start/list/status/cancel/message/close/wait/agents/models）。补足引擎原生后台 agent 缺少的能力：worktree 文件隔离、schema 结构化输出、conversation 续聊、四根 agent .md 发现（复用 pi 生态）、per-start 模型路由、跨窗口 record。
> **zflow** — 确定性多步编排（`zsw workflow` 子命令，六 action：run/abort/status/list/scripts/lint）。回接 2b 起 workflow 运行时整体替换为 vendored `@zhushanwen/subagent-core` orchestration：内置 5 种（chain/parallel/map-reduce/scatter-gather/review-fix-loop，资产来自 core `workflows/`）+ core 契约 `script:<名>` 脚本扩展（`@pi-meta` + top-level `agent()`）；run 同步阻塞出 scriptResult（配 Bash run_in_background 即完成原生唤醒）。**本替换是行为 break——旧契约/旧状态面的迁移对照见「回接 2b break 变更」节。**
> 简单纯后台任务请直接用原生 `@agent`（frontmatter `background: true`，独立 turn 唤醒 + goal gate）——分流指引见 skill `zsub-zflow-orchestration`。

## 架构（端口/适配器内核）

```
入口层   CLI（node bin/zsw.js，默认 daemon thin client）+ skill——MCP 工具面恒下线
         （tools/list 恒空、tools/call 恒拒并指引走 CLI；zsub 九 action / zflow 六 action
          保留为语义层名，见 CONTEXT.md）
编排层   SubagentManager（subagent 生命周期，只依赖 lib/ports.js 契约）
         orchestration-host（workflow 编排宿主 = vendored subagent-core orchestration：
         configureCore 宿主端口 + FileRunStore + WorkerHostImpl + registry 内置资产注册，
         AgentRunner port 经 lib/agent-runner-adapter.js 桥回 zsw RunnerPort）
端口层   RunnerPort        NotifierPort        ModelRouterPort
          ├ SpawnRunner      ├ MailboxNotifier    ├ home-pool（spawn 配套）
          └ AppServerRunner  └ PollingNotifier    └ per-session（apc 配套）
域层     resolver / prompt-builder / record-store / output-store / worktree / jsonout
         vendored core（lib/vendor/subagent-core/）：runWorkflow/lifecycle/error-recovery
         + workflows/ 内置 5 资产（chain/parallel/map-reduce/scatter-gather/review-fix-loop）
```

三个决策位（执行引擎 / 回流通道 / 入口形态）正交且各自可换——更换实现不动 manager。执行引擎缺省 appserver（D1 翻转；`ZSW_RUNNER=spawn` 显式回退），平台版本漂移被限制在端口实现内部消化（`interpretEvent` 等单点防洪堤）。

core 资产消费形态：对 npm 包 `@zhushanwen/subagent-core` 的消费（当前面为其 `workflows/*` 资产）采用构建期 vendored 副本（`lib/vendor/subagent-core/`，`scripts/vendor-subagent-core.js` 刷新 + `lib/core-ref.js` 单一解析点，VENDOR-MANIFEST.json 溯源），运行时不依赖 node_modules 解析面。规范见 workspace 仓 `docs/standards.md`「vendored 核心包消费」节。

## 安装（一次性）

1. 注册插件目录：`~/.zcode/cli/config.json` 的 `plugins.dirs` 数组追加本插件绝对路径（`<repo>/z-subagent-workflow`），重启 ZCode。
2. 验证：终端跑 `zcode plugins list` 应见 `z-subagent-workflow` enabled；再在任一 zcode 会话内用 Bash 跑 `node <插件绝对路径>/bin/zsw.js list`，能返回 JSON（首次为空列表）即 CLI→daemon 链路通。注意 MCP 工具面 1.0.0 起恒下线——会话内工具列表**不会**出现 `zsub`/`zflow`，这是预期形态而非安装失败。

（legacy）宿主引擎的 mailbox 开关 `ZCODE_MESSAGE_ENABLED=1` 无需设置：该通道只对 MCP 工具面时代的会话定向通知有效，工具面下线后 CLI/daemon 面恒无投递目标（句柄 notify 如实标 `none`）。env 仍影响 notifier 档位文案（未启用时 polling 档附轮询指引），完成唤醒不依赖它——唯一路径见「已知边界」第一条。

## 使用

agent 与人类都走 CLI `node bin/zsw.js`（zsub 面九 action：start/list/status/cancel/message/close/wait/agents/models；下例为常用子集）：

```bash
node bin/zsw.js start --task "审查 src/ 的错误处理" --slug review-1 --model <模型短名>   # 传未知模型名会在报错中列出可用清单
node bin/zsw.js list
node bin/zsw.js status --id sa-xxxx
node bin/zsw.js message --id sa-xxxx --text "补充：重点看重试逻辑"   # 投递即回，完成经 wait 收（--local 下才阻塞到本轮完成）
node bin/zsw.js cancel --id sa-xxxx
```

workflow 管理面（zflow 面六 action 的 CLI 入口；状态面 = `<zsw 数据根>/workflow-state/`。abort/status/list/scripts 默认经 daemon——跨进程状态一致、abort 经 daemon 侧 core `abortRun` 真停 run；run/lint 恒本地）：

```bash
# run（--action 缺省；恒本地同步执行，执行体 = CLI 进程，跑到终态退出并打报告。
# agent() 调用默认走常驻引擎通道（apc），一次性进程每 run 付一次引擎惰性启动 ~1-2s。
# 需要「派发后做别的、完成唤醒」时用 Bash run_in_background 包裹整条命令，CLI 退出即引擎原生通知）
node bin/zsw.js workflow --workflow chain --task "分析并总结 README" --workdir <绝对路径>
node bin/zsw.js workflow --workflow map-reduce --task "..." --workdir <绝对路径> \
  --operation "提取每个文件的导出" --items '["a.ts","b.ts"]'
node bin/zsw.js workflow --workflow script:my-wf --task "..." --workdir <绝对路径>   # core 契约脚本

# abort / status / list / scripts / lint
node bin/zsw.js workflow --action list
node bin/zsw.js workflow --action status --id wf-xxxxxxxx
node bin/zsw.js workflow --action abort --id wf-xxxxxxxx
node bin/zsw.js workflow --action scripts          # vendored 内置 5 + 用户脚本清单
node bin/zsw.js workflow --action lint --file <脚本路径>
```

**review-fix-loop（批次外环 + 质量内核，资产来自 core）**：唯一会写文件的内置 workflow（fix 阶段）。批次外环：`--batch1..--batchN` 串行（**值 = agent .md 绝对路径**，逗号分隔多 agent），前一批 clean 后一批才启动。每轮并行 review → LLM 聚合裁决（臆测/无证据条目降级，不进修复队列）→ 结构化契约 fix → R2 起逐条 ID 对账（fixed/not-fixed/regressed）→ 收敛/needs-redesign 状态机；run 目录由 core 资产自管（`~/.review-fix-loop/<repo-slug>/<runId>/`，含 state.json 与各轮报告）。

```bash
node bin/zsw.js workflow --workflow review-fix-loop \
  --task "审查 PR：重构 auth 中间件" --workdir <绝对路径> \
  --target-type git-diff --target main \
  --batch1 "/abs/path/correctness-reviewer.md,/abs/path/security-reviewer.md" \
  --stuck-threshold 3 --aggregator-model <模型短名>
```

参数面全集见 `node bin/zsw.js workflow --help`（`--target-type`/`--target`（必填）、`--batch1..N`（agent .md 路径）/`--batch-names`、`--max-rounds` 默认 10、`--stuck-threshold` 默认 3、`--skip-clean-agents`、`--recheck-after-fix`、`--converge-new-issues`/`--converge-rounds`、`--max-fix-attempts`、`--aggregator-model`、`--review-prompt`/`--fix-prompt`、`--fallow-scan`、`--auto-commit` 等）。老参数兼容：`--review-target <text>` 等价 `--target-type text --target <text>`；`--task` 在 review-fix-loop 场景作为 target 回退。**`--reviewers`（自由文本维度）已废弃**——core 契约批次值 = agent .md 路径，传入显式报错；无 agent .md 的自由文本维度场景改用 `script:` 自定义脚本。

**自定义 workflow 脚本（core 契约）**：内置 5 种之外的编排用 `script:<名>` 扩展。发现面 = core 发现面（`<ws>/.pi/workflows` + `<ws>/.agents/workflows` + `~/.agents/workflows` + `~/.zsw/workflows`）+ zsw 特有根 `<ws>/.zsw/workflows`；脚本契约 = `/* @pi-meta */` meta 块 + top-level `agent()`/`parallel()`/`pipeline()`，参数经 `$ARGS`，返回值即 scriptResult。完整契约与示例见 skill `zsub-zflow-orchestration`（旧契约迁移对照见下方「回接 2b break 变更」节）；写完先 `lint` 校验再运行。

`--local` 模式下 CLI 是一次性进程（本地执行，调试后门：无续聊/限流，CLI 退出即丢执行体）：start/message 一律阻塞到本轮完成再退出（无 `--no-wait`——CLI 进程退出即丢执行体，record 会卡 running）。bash `run_in_background` 场景直接让 CLI 阻塞到完成，由引擎跟踪该 bash 任务并在完成时唤醒。异步启动 + 聚合等待（`wait` / `start --wait`）走默认 daemon 模式（见下节）。

## 回接 2b break 变更（workflow 线换 vendored subagent-core orchestration）

zsw 自有 workflow 运行时（WorkflowManager + lib/workflow/ 管线 + workflow-script 旧契约）已整体退役，编排层换成 vendored `@zhushanwen/subagent-core`（`lib/orchestration-host.js` 宿主 + `lib/agent-runner-adapter.js` 执行桥）。**以下是调用方可见的行为 break，旧用法按本表迁移**：

**D6-⑧ 旧 `script:<name>` 脚本契约废弃**（daemon 内 fresh-require CJS、`ctx = {task, cwd, model, runAgent, log, params}` → 返回 `{markdown, json}`），新契约为 core worker 脚本（`@pi-meta` meta 块 + top-level `agent()`，在 core worker 线程执行）。迁移对照表：

| 旧契约（lib/workflow-script.js） | 新契约（core worker） |
|----------------------------------|----------------------|
| `module.exports = { name, description, run(ctx) }` | `/* @pi-meta name/description/phases */` 块注释 + top-level await 脚本（lint 强校验 `agent()`/`parallel()`/`pipeline()` 入口） |
| `ctx.runAgent({prompt, cwd, model, timeoutMs})` | `agent({prompt, model, timeoutMs, agent, schema, ...})`（每次调用一个独立 agent 会话） |
| `ctx.log(text)` | `log(text)` / `console.log`（core worker log 通道） |
| `ctx.params`（run 透传参数） | `$ARGS`（白名单外 flag 全进 `$ARGS`；`$ARGS.task` 恒并入） |
| 返回 `{markdown, json}` 或字符串 | `return <scriptResult>`（任意可结构化克隆值；CLI 渲染为「message 行 + JSON 块」双段） |
| 四根发现（`.agents/workflows` > `.zsw/workflows` 两级 × ws/HOME） | core 发现面（`.pi/workflows`、`.agents/workflows` × ws/HOME、`~/.zsw/workflows`）+ `<ws>/.zsw/workflows` 手工根；旧根大多保留但同名遮蔽优先级变化 |
| 脚本同目录 require 相对路径（进程 cwd） | 必须 `require(path.dirname(workerData.scriptPath) + "/dep.cjs")` 锚定（worker eval 沙箱相对路径以 cwd 为基准） |

**D7 旧 wf- record 不可读**：旧 WorkflowManager 把 run 状态写 `~/.zcode/zsw/records.jsonl`（`recordType:'workflow'` 事件流）+ 报告落 `outputs/<runId>.md`，该线已退役——新 run 的状态面是 `<zsw 数据根>/workflow-state/<runId>.jsonl`（core FileRunStore append-only 快照，`status` action 的 `stateFile` 字段即此路径），报告不落盘（CLI stdout 直出 scriptResult）。旧 record/报告文件留在原位可人工查阅，但 CLI/MCP 不再解析。

**daemon 重启恢复语义**：上一代 daemon 遗留的 `running` run 在新 daemon 启动/接管时统一标 `done,failed`（error = "daemon takeover: worker died with previous process"）——core worker 线程随宿主进程死亡，无进程可探活、不尝试续跑；这与 zsub 线 subagent 的探活/孤儿标记语义不同，是两线故意的差异。done run 内存保留上限 20 条（core `MAX_RETAINED_DONE_RUNS`），淘汰后 `status` 报可操作错误并指向 stateFile。

**run 参数面变化**：`--timeout-ms` 映射 RunSpec `budgetTimeMs`（整体墙钟预算，到期 `done,time_limited`）；`--model` 映射 `RunSpec.model`（run 级，agent() per-call 可覆盖）。`--max-concurrent` / `--timeout-per-phase` / `--subtask-count` 已废弃（core 编排无对应面），传入 stderr 显式 warning 不静默。review-fix-loop 的 `--reviewers` 显式报错（见上文）。

**通知面变化**：workflow 完成不再投 mailbox 通知（旧 WorkflowManager 的 notifyCompletion 线随 record 线退役）——CLI run 恒同步等终态，socket 面异步 run 用 `--action status` 查询。

## CLI 默认形态：daemon thin client（1.0.0 起）

1.0.0 起 CLI 默认即常驻 daemon thin client（不加任何 flag；unix socket；sock 默认 `~/.zcode/zsw/daemon.sock`，env `ZSW_SOCK` 可覆盖，测试隔离用）。执行体由 daemon 持有——CLI 退出不丢，`start` 默认异步启动，`start --wait` 为 start+wait sugar；`wait` 子命令：`zsw wait --id a [--id b ...] [--timeout-ms n]`（无 `--local` 形态——本地一次性进程没有可挂起的等待方），等待在 daemon 侧内存挂起（零轮询），多 id 全部终态才返回，`--timeout-ms` 到点回 partial 结果并以 exit 2 退出。

agent 侧推荐组合：Bash 工具 `run_in_background=true` 包裹 `zsw start --wait …` 或 `zsw wait --id …`——CLI 阻塞进程成为引擎进程内 background 任务，完成即触发引擎原生 task-notification 唤醒会话（idle 也唤醒），不依赖 mailbox env、无需 sleep 轮询。

生命周期：daemon 由启用插件的 zcode 会话自动拉起（MCP server 进程竞选，无额外安装步骤），挂靠任一会话的插件进程——**所有会话关闭则 daemon 退场**，其持有执行体的任务终止（record 已落盘，由下一次接管实例 recover 探活标记 orphan/dead，不产生静默僵尸）。daemon 不在场时 CLI 报错并给恢复指引（稍候重试，其他实例接管需 1-2s；在任一 zcode 会话确认插件已启用；或加 `--local` 走本地一次性执行——调试后门：无续聊/限流，CLI 退出即丢执行体）。`zsw workflow` 的 abort/status/list/scripts 管理面默认同走 daemon（跨进程 record 一致）；run/lint 恒本地——run 执行体 = CLI 进程本身，abort 对本地 run 只终态化 record、不停执行体，取消本地 run（bg bash 形态）用引擎 TaskStop。

## 从 dynamic-workflow 迁移

原 dynamic-workflow 插件已卸载（config.json 的 plugins 注册已移除），全部能力并入本插件；回接 2b 起 workflow 线进一步整体替换为 vendored subagent-core orchestration（5 个内置形态名保留、实现换 core 资产；旧 `script:<名>` 契约与 wf- record 状态面 break，迁移对照见「回接 2b break 变更」节）。tool 名曾从 `mcp__dynamic-workflow__zflow` 改为 `mcp__zsw__zflow`（MCP 工具面时代命名；1.0.0 工具面下线后入口为 CLI `zsw workflow` 子命令），命名体系见 CONTEXT.md。旧插件目录保留在原 worktree 作历史归档。

结果全文落 `~/.zcode/zsw/outputs/<id>.md`；worktree 任务的 patch 落 `<id>.patch`（完成通知含 `git apply` 指引）。

## 状态与目录

```
~/.zcode/zsw/
├── records.jsonl        append-only 事件流（zsub subagent 线；崩溃后重放恢复。回接 2b 起
│                        workflow 线不再写入——旧 wf- record 留存可读但无消费方）
├── workflow-state/      workflow run 状态快照（core FileRunStore：<runId>.jsonl append-only，
│                        末行有效行 = 最新状态；daemon 启动/接管时重水合孤儿 run）
├── outputs/             subagent 结果全文 + patch（workflow 报告线已退役，CLI stdout 直出）
├── daemon.sock          daemon 控制面 unix socket（0.2.0+，ZSW_SOCK 可覆盖）
├── daemon.sock.lock     daemon 竞选锁文件（O_EXCL 原子裁决）
├── logs/                appserver 引擎 stderr 实时落盘 + core 编排日志（workflow-core.log）
├── probe-cache.json     appserver probe 结论缓存（键 = CLI 路径 + mtime，只缓存 ok）
├── home-<provider>-<modelShort>/  per-model 隔离 HOME 池（spawn 回退通道模型路由）
├── home-appserver/      appserver 默认通道单一隔离 HOME（遥测已关闭）
└── wt-<id>/             worktree 隔离目录（任务期存在）

（review-fix-loop 的 run 目录由 core 资产自管：~/.review-fix-loop/<repo-slug>/<runId>/，
 含 state.json 与各轮 reviewer 报告——不在 zsw 数据根下。）
```

## 已知边界（如实声明）

- **mailbox 完成通知是 legacy 通道（仅 MCP 工具面时代有效）**：mailbox 投递需要会话定向（targetSessionId），只有 MCP 工具调用携带；1.0.0 工具面下线后 CLI/daemon 面恒无投递目标，notifyCompletion 必不投递（句柄 notify 字段如实标 `none`，不写 `mailbox` 误导「会自动回流」）。M1 默认形态（CLI daemon）任务的完成唤醒唯一路径 = CLI 阻塞进程（`wait` / `start --wait`）配 Bash `run_in_background`，成为引擎进程内 background 任务、完成即触发原生 `<task-notification>`（idle 也唤醒，不依赖任何 env）。需要「完成即唤醒 + goal gate」的简单任务仍可直接用原生 `@agent`。
- **默认执行通道 = appserver（常驻 `zcode app-server`，apc 协议；subagent 任务与 workflow 阶段同走）**：`zsw start` 与 workflow 的每个阶段不带任何 env 即走常驻引擎。冷启动代价按形态摊薄：daemon 形态下引擎全进程共享——每个引擎进程只惰性启动一次（~1-2s，首个任务/阶段付出），之后 subagent 会话零冷启动续聊、后续 workflow 阶段零进程重建；`zsw workflow run`（本地一次性进程）每 run 付一次引擎惰性启动。组装前 probe 健康检查失败自动降级 spawn。probe ok 结论落盘 `~/.zcode/zsw/probe-cache.json`（键 = CLI 路径 + mtime，只缓存 ok；CLI 更新即失效重探）——`--local` 每条命令是一次性进程、daemon 启动只组装一次，落盘让两形态共享探针结论；缓存命中后首次会话创建失败（-32603/-32601/-32602）会失效缓存并重探一次，重探失败则本任务转 spawn 重跑且 record 如实改标；降级为**通道级**——daemon 生命周期内后续任务直接走 spawn 免重探，重启 ZCode 后重新组装、恢复探测。workflow 阶段条目落 `channel` 字段（`appserver`|`spawn`），降级混跑的报告可直接对照各阶段实际通道。断链自愈：会话被引擎驱逐或引擎进程崩溃后，下一次交互自动 `session/resume`（携带 runtimeModel）重试一次；不可恢复时报「会话弃用 + `zsw start` 重建指引」而非裸错误码。-32004 的主来源是引擎进程死亡与 close（订阅会话免空闲驱逐）。协议漂移（-32601/-32602）分类为 protocol-drift 并给升级冒烟指引（`node test/e2e.test.js --name apc-smoke`）。
- **workflow 中止语义（回接 2b 后）**：daemon 形态（socket 面派发、执行体 = daemon 进程内 core worker 线程）的 `abort` 走 core `abortRun`——worker 线程 terminate、run 立即落 `done,aborted` 并写快照；但引擎侧在飞的 agent() 轮**不被打断**（`session/stop` 对 RPC 在飞轮无打断能力，已真机实证），该轮会跑到自然完成——这部分 token 已消耗，属 apc 通道相对 spawn 立停的已知代价。`zsw workflow run` 本地一次性进程的中止是进程级：Ctrl-C/SIGTERM 下 CLI 与 worker 线程/引擎子进程一同退出；取消 bg bash 形态的本地 run 用引擎 TaskStop。
- **`ZSW_RUNNER=spawn` 显式回退旧通道**：subagent 每轮、workflow 每阶段各自 spawn 独立 zcode 进程（~1-2s 冷启动），故障隔离与翻转前一致。daemon 在进程启动时读一次 env——改 `ZSW_RUNNER` 后需重启 ZCode 生效。
- **running 会话不可插话（busy，两通道同语义）**：message 投递到 running 中的会话立即返回 busy 结果（stdout JSON `busy:true` + exit 0，非报错退出；appserver 侧 `-32010` 硬错误，探针实证；不排队不打断），等待本轮完成（`zsw wait --id <id>`）或 `zsw cancel --id <id>` 取消后再投递。
- **工具黑名单是引擎级硬拦截（两来源并集），`tools` 白名单维持软约束**：黑名单 = CLI `--deny-tools`（逗号分隔裸工具名）∪ agent .md frontmatter `disallowedTools`——默认 appserver 通道经 `session/create` 的 `toolDenylist` 引擎级拦截，spawn 回退通道维持 `--disallowed-tools` flag 硬拦截（frontmatter 来源生效，CLI 来源不消费）；`--allow-tools` 白名单同理落 `toolAllowlist`（仅 appserver）。frontmatter `tools` 白名单维持 prompt 软约束（两通道一致）：zcode CLI 无 allowlist flag（`--allowed-tools` 拒收），白名单只能约束意图不能拦截行为。
- **subagent 并发池与 workflow 并发治理已分治（回接 2b 后）**：subagent 池默认 3（`ZSW_MAX_CONCURRENT` 可调）仅约束 zsub start 线；workflow 线的并发由 core 资产内部形态决定（`parallel()` 共享 core 配额池、顺序编排逐个执行），zsw 侧不再有独立 workflow 槽位池，`--max-concurrent` 已废弃。
- **并发深度分层当前为预留**：嵌套环境（ZSW_NESTED）被双门禁直接拒绝，实际 depth 恒 0——分层逻辑保留给未来放开受限嵌套服务时使用。
- **mailbox 引擎侧语义（legacy 通道的如实现记录）**：drain 单次最多 20 条（本插件用单调文件名防挤窗）；会话 mailbox 内若有外部坏 envelope 文件会永久阻塞该会话 drain（引擎无 quarantine，本插件投递已用原子写 + 写前自检规避）。通道在工具面下线后不再有投递方，条目留作历史与 notifier-mailbox.js 的实现依据。

## 排障

### ps 里看到两个 zcode app-server 进程，是不是泄漏？

大概率不是。默认通道下引擎是常驻进程，以下三种场景会出现第二个引擎进程，属正常短暂态：`--local` 调试（CLI 一次性进程自拉引擎）、probe 健康检查（探测用短命引擎）、daemon 接管切换瞬间（旧引擎退出与新引擎启动的窗口）。多引擎共存是设计内容忍面，不是缺陷。

**怎么定位引擎进程**（pgrep 查不到，用 db 句柄反查）：

```bash
lsof ~/.zcode/zsw/home-appserver/.zcode/cli/db/db.sqlite
```

引擎命令行是 `node <zcode路径> app-server --cwd <工作目录>`——HOME 只在环境变量里、不在命令行参数里，所以 `pgrep -f "app-server.*home-appserver"` 恒匹配不到；而每个引擎进程都会打开会话数据库 db.sqlite，按文件句柄反查最可靠。

**怎么判读**（看输出的 PID 列）：

- 只有 1 个 pid：正常（单引擎）。
- pid 数 > 1：先回想刚才是否跑过 `--local` 命令、或刚重启过 ZCode——这类短暂多开会随进程退出自行消失，等几分钟复查即可。
- 持续多开（隔几分钟复查 pid 不减）：旧引擎残留，kill 掉多余 pid 即可（`kill <pid>`，顽固时 `kill -9`）。

**kill 会不会丢数据**：不会。会话记录落在 SQLite 里多进程可读，被杀引擎名下的会话换个引擎仍可 list / resume；运行中的任务会以连接中断如实报错（重跑即可），已完成任务的结果不受影响。

## 验收手册（真机 GUI，安装后逐项执行）

| # | 场景 | 步骤 | 通过标准 |
|---|------|------|----------|
| M1 | 原生唤醒 | GUI 会话让 agent 用 Bash `run_in_background=true` 跑 `node bin/zsw.js start --wait --task "数一下 README 有多少行" --slug count`，随后让 agent 结束 turn | 会话被 `<task-notification>` 自动唤醒（无需用户发言），agent 读取结果并转达 |
| M2 | 跨会话可见 | 窗口 A start（异步），窗口 B `node bin/zsw.js list` / `status --id` | B 能看到 A 派的任务与状态（record 同盘共享） |
| M3 | 降级 | 不设 mailbox env（polling 档，legacy 通道不启用），同样 start（异步） | 返回含轮询指引（时间预期 + CLI 等待姿势）；status 能拿到终态 |
| M4 | worktree | 干净主树 `node bin/zsw.js start --worktree --task "在 src/ 新增 hello.ts" --slug wt` 后 wait | 主树干净；结果含 patchFile；`git apply --check <patch>` 通过 |
| M5 | 默认通道与回退 | 不设任何 env 跑 `node bin/zsw.js start` conversation 两轮；随后 `ZSW_RUNNER=spawn` 复跑同款任务 | 默认 record.runnerKind='appserver'，第二轮无进程重建（零冷启动续聊）；spawn 复跑 record.runnerKind='spawn'；probe 失败自动降级且 stderr 有降级日志、record 如实标注 |

无头 e2e（E1-E10，真实 zcode 无头进程 + 真实模型）见 `test/e2e.test.js`，`node --test test/e2e.test.js` 自动运行（注意模型 token 消耗与账户限流窗口）。E9 为 apc-smoke 升级冒烟（create/send/terminal/read/list/close 协议面八步断言的极小任务），支持单场景入口 `node test/e2e.test.js --name apc-smoke`——zcode 升级后先跑它验证 apc 协议面（与「已知边界」的升级冒烟指引呼应）；E10 为 appserver 多会话并发。

## SessionStart 资源注入验收手册（`<zsw-resources>` 块）

zsw 注册 SessionStart hook，在会话启动时向主 agent 上下文注入一份资源快照 `<zsw-resources>` 块（可运行模型 / agent .md / workflow 三段清单 + 兜底指引），模型路由决策零工具调用可得；快照可能过期，`zsw models` 等查询命令保留为权威兜底。设计全文见源仓库（github.com/zhushanwen321/zcode-plugins）根 `docs/design/zsw-session-start-injection-design.md`。

### 块形态与生效条件

会话启动时上下文头部出现（示意样例，内容以本机环境实测为准）：

```
<zsw-resources snapshot="2026-08-29T12:00:00.000Z">
zsw 可用资源快照（会话启动时生成，GUI 中途改动后可能过期）
models：
  当前默认：builtin:bigmodel-coding-plan/GLM-5.3-Flash
  默认 provider builtin:bigmodel-coding-plan（短名直接可传）：GLM-5.3, GLM-5.3-Flash（默认）
  其他可运行 provider（跨 provider 必须用全名 <provider>/<model>）：
    builtin:bigmodel-start-plan/GLM-5.3-Flash
    5c5bb493…/MiniMax-M3 · 5c5bb493… 即 5c5bb493-035c-4214-8a75-0563fba60394
    e512d53e…/mimo-v2.5-pro · e512d53e…/mimo-v2.5 · e69643b0…/k3-256k
agents（四根发现，同名高优先级根胜出）：context-builder（需求分析与元提示生成）· oracle（高上下文决策一致性守护）· …（6 个）
workflows：内置 chain / parallel / map-reduce / scatter-gather / review-fix-loop；script:<名> 自定义（当前 0 个）
兜底：传错模型名时报错自带可用清单（零依赖权威兜底）；主动现查 zsw models / zsw models --all（跨 provider）/ zsw agents（需 daemon 在跑——任一启用插件的会话）。模型名以本块与报错内清单为准（AGENTS.md 等静态路由表中的具体模型名可能过期）
</zsw-resources>
```

（渲染实现与样例的两处已知差异：agents 段为「段头 + 每 agent 一行」而非单行 ` · ` 连接——行数需随清单增长才能被预算截断；UUID provider 缩写对照在该 provider 首次出现处附一次。全文硬预算 ≤45 行，超限优先保留 models 段、依次截 agents/workflows 段并标注对应查询命令。）

生效条件：

1. 插件已启用（`zcode plugins list` 见 `z-subagent-workflow` enabled）。
2. hook 注册于 `hooks/hooks.json`：SessionStart → `node "${ZCODE_PLUGIN_ROOT}/bin/zsw-hook.js"`（timeoutMs 5000；hook 内任一异常输出 `{}` + exit 0 静默降级，会话照常启动；`bin/zsw.js hook session-start` 是等价的 CLI 调试面）。
3. **改 hooks 注册或插件文件后必须重启 ZCode 才生效**——GUI 只在启动时扫描插件配置。

### 验收场景（S1-S7）

以下 GUI 场景均需重启 ZCode + 真实 token（S2/S4 涉及真实 spawn，用最小任务书）。S1-S6 依赖真实 GUI 与真实插件加载，无法 mock（引擎 hook 触发链是验证对象本身）；涉及与 `zsw models` 对照的场景，前置条件：先开一个启用插件的会话拉起 daemon（或以报错内清单作为对照权威源）。

| # | 场景 | 步骤 | 通过标准 |
|---|------|------|----------|
| S1 | 主 agent 零调用报清单 | 重启 ZCode 开新会话 → 问「现在哪些模型可跑？默认哪个？短名和全名怎么用？」（④ 的验证需换到含项目级 agent .md 的仓库开会话执行，或按 P-cwd 手册条目在 GUI 场景单独执行） | agent 不调任何工具，答出：① 默认 provider 的**模型名单与默认标记**与 `zsw models`（另开终端跑）一致，且块内「当前默认：<全名>」行与之一致（字段粒度不做要求——`zsw models` 返回结构化条目，注入块只渲染名单+标记）；② 其余可运行 provider 以全名形态列出；③ 短名/全名使用规则与 resolve 语义一致（短名=默认 provider，跨 provider=全名）；④ 在含项目级 agent .md 的仓库开会话时，注入块 agents 段含该项目级 agent 名（P-cwd 的 GUI 侧断言落点） |
| S2 | 路由决策一步到位 | 新会话让 agent 派发两个 zsub（一重一轻，见上文样例） | agent 直接按块内引用构造参数（重 → 显式 `--model GLM-5.3`；轻 → 不传跟随默认 Flash），全程未跑 `zsw models`；两任务受理成功 |
| S3 | 快照过期自愈（负面场景） | 会话中途 GUI 停用一个 provider → 让 agent 用该 provider 模型派发 | 收到既有可操作报错（含可用清单）→ agent 换模型重传成功；无卡死、无静默失败 |
| S4 | 嵌套会话不污染 | S2 的重任务 task 书里加「报告你上下文是否有 zsw-resources 块」 | 子代理回答没有；主会话块仍存在 |
| S5 | hook 故障降级 | 关闭其他 zcode 会话 → `chmod 000 ~/.zcode/v2/config.json` → 立即手跑 `node bin/zsw.js hook session-start` 验证输出 `{}` exit 0 → `chmod 644 ~/.zcode/v2/config.json` 恢复 → 重启 ZCode 开新会话 | 手跑降级正确；恢复后会话正常启动无报错弹窗、上下文有块；全程窗口 < 1 分钟（chmod 000 为最小窗口，验证后必须立即执行恢复命令） |
| S6 | resume/compact 行为 | ① resume 一个已注入会话 ② 触发 compact | ① 块出现次数 ≤1（对应 P-resume-dup）② compact 后上下文出现**新快照**（时间戳更新） |
| S7 | 发版完整性 | `node scripts/check-pack.js` + `node scripts/check-sync.js`（cwd = workspace 根）+ 装正式版验证 | hooks/ 在 npm 包内；三处版本一致；marketplace 安装版 hook 同样生效 |

### 手工探针命令（cwd = 插件目录）

> hook 注册入口是 `bin/zsw-hook.js`（自包含薄入口，插件文件缺失也降级 `{}` + exit 0）；`bin/zsw.js hook session-start` 是等价的 CLI 调试面（delegator）。以下命令两者皆可，以 `bin/zsw-hook.js` 为准。

- **P-cold-start（hook 不拖慢会话启动）**：`time node bin/zsw-hook.js` 跑三次取中位，通过标准 < 500ms（hook 内联执行，延迟直接计入会话启动；耗时与 projectDir 来源在 stderr 可观测行 `[zsw:hook] projectDir=… source=env|cwd … elapsed=<ms>`）。
- **P-cwd（`ZCODE_PROJECT_DIR` 注入生效、项目级根定位正确）**：

  ```bash
  ZCODE_PROJECT_DIR=<含项目级 agent 的仓库（其 .agents/agents/ 或 .zcode/agents/ 下有 agent .md）> \
    node bin/zsw-hook.js
  ```

  通过标准：输出 JSON 的 `additionalContext` 含该仓库的项目级 agent 名，stderr 可观测行 `source=env`（GUI 侧断言 = S1 通过标准 ④；失败降级路径见源仓库设计文档 §3.5 P-cwd）。
- **P-nested-guard（嵌套会话不注入，实施期门复跑）**：`ZSW_NESTED=1 node bin/zsw-hook.js`，期望 stdout 为 `{}` 且 exit code 0（只验输出不验 exit code 会漏掉 exit 1 违规形态——非零退出会在会话启动 raise error）。

### 已知边界（如实声明）

- **快照语义**：块在会话启动时生成，会话中途 GUI 改动（停用 provider、增删 agent/script 等）不反映进已注入的块。兜底两条：传错模型名时报错自带可用清单（零依赖权威兜底）；或主动现查 `zsw models`（默认 provider 明细）/ `zsw models --all`（全部带凭据 provider 全名视图，与块内「其他可运行 provider」段同口径）/ `zsw agents`（需 daemon 在跑——任一启用插件的会话）。与 skill `zsub-zflow-orchestration` 模型路由纪律（快照优先 + 两条兜底）同口径。
- **模型名权威序**：具体模型名以注入块与报错内清单为准（实时快照）；AGENTS.md / SKILL.md 等静态文本中的具体模型名是档位策略参考，可能随环境漂移——按静态名字直传失败时以报错内清单重传。
- **token 代价**：SessionStart 的 matcher 值域只有启动源，会话启动时无法预判该会话是否使用 zsw——装了插件但全程没用 zsw 的会话也注入这份快照（硬预算 ≤45 行；本机规模实测约 20 行）。这是已声明的方案代价，非缺陷。
- **hook 超时是静默丢块**：引擎在 timeoutMs（本插件 5000ms）到点杀进程，不走 hook 内部降级——表现是上下文没有块、无报错。排查：看 ZCode 日志中 hook 执行记录（outcome=timed-out 与耗时），并手跑 `time node bin/zsw-hook.js` 复现慢源。同类监控点：引擎升级后首会话确认块在场（stdout 截断/事件契约变化都会以「块消失」形态出现）；hook 命令依赖 PATH 上的 node（与 z-tool-finder 同担，GUI 经 Finder 启动时 PATH 形态不同则 exit 127 → 会话启动 raise error）。
- **嵌套子会话不注入**：双保险——① hook 入口 `ZSW_NESTED=1` 守卫直接输出 `{}` + exit 0；② 被 spawn 的 zsub 运行在隔离 HOME（`~/.zcode/zsw/home-*`），该环境本就不加载用户插件。
- **resume 场景块数 ≤1 依赖引擎行为**：hook 未设 matcher（startup/resume/clear/compact 四种启动源都注入；compact 后重注入是特性——压缩丢细节，新快照补位）。resume 是否重放历史注入块属引擎运行时行为，由 P-resume-dup 探针把关（S6①）；若复现两份块属已知现象、非正确性问题（token 翻倍但内容一致），失败时降级路径为 matcher 收窄 `startup|compact`。
