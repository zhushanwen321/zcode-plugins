# z-subagent-workflow — zcode subagent 编排 + workflow 插件

> 两条能力线，1.0.0 起统一走 CLI（`node bin/zsw.js`，默认连常驻 daemon thin client；MCP 工具面已下线——tools/list 恒空、tools/call 指引走 CLI）：
> **zsub** — 无头 subagent 生命周期管理（start/list/status/cancel/message/close/wait/agents/models）。补足引擎原生后台 agent 缺少的能力：worktree 文件隔离、schema 结构化输出、conversation 续聊、四根 agent .md 发现（复用 pi 生态）、per-start 模型路由、跨窗口 record。
> **zflow** — 确定性多阶段编排（`zsw workflow` 子命令，六 action：run/abort/status/list/scripts/lint）：内置 5 种（chain/parallel/map-reduce/scatter-gather/review-fix-loop）+ 自定义 `script:<名>` 脚本扩展；run 同步阻塞出报告（配 Bash run_in_background 即完成原生唤醒）。review-fix-loop v2 内置质量内核：LLM 聚合裁决（审查噪声降级不进修复队列）+ 跨轮 ID 对账 + 批次依赖 + 收敛/needs-redesign 状态机 + state 落盘（过程可观测）。自 dynamic-workflow v0.2.0 移植并入（原插件已卸载，本插件是唯一一套）。
> 简单纯后台任务请直接用原生 `@agent`（frontmatter `background: true`，独立 turn 唤醒 + goal gate）——分流指引见 skill `zsub-zflow-orchestration`。

## 架构（端口/适配器内核）

```
入口层   CLI（node bin/zsw.js，默认 daemon thin client）+ skill——MCP 工具面恒下线
         （tools/list 恒空、tools/call 恒拒并指引走 CLI；zsub 九 action / zflow 六 action
          保留为语义层名，见 CONTEXT.md）
编排层   SubagentManager（subagent 生命周期，只依赖 lib/ports.js 契约）
         WorkflowManager（workflow run 生命周期，共享 records/outputs/notifier）
         lib/workflow/（内置 5 种确定性管线）+ workflow-script（自定义脚本四根发现/执行/校验）
端口层   RunnerPort        NotifierPort        ModelRouterPort
          ├ SpawnRunner      ├ MailboxNotifier    ├ home-pool（spawn 配套）
          └ AppServerRunner  └ PollingNotifier    └ per-session（apc 配套）
域层     resolver / prompt-builder / record-store / output-store / worktree / jsonout
         workflow/: run-phase（共享执行辅助）+ chain/parallel/map-reduce/
                    scatter-gather/review-fix-loop + report
```

三个决策位（执行引擎 / 回流通道 / 入口形态）正交且各自可换——更换实现不动 manager。执行引擎缺省 appserver（D1 翻转；`ZSW_RUNNER=spawn` 显式回退），平台版本漂移被限制在端口实现内部消化（`interpretEvent` 等单点防洪堤）。

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

workflow 管理面（zflow 面六 action 的 CLI 入口；record/outputs 同源。abort/status/list/scripts 默认经 daemon——跨进程 record 一致、abort 经 daemon 句柄真停 daemon 侧 run；run/lint 恒本地）：

```bash
# run（--action 缺省；恒本地同步执行，执行体 = CLI 进程，跑到终态退出并打报告。
# 阶段默认走常驻引擎通道（apc），一次性进程每 run 付一次引擎惰性启动 ~1-2s；
# 中止 = 进程级（Ctrl-C 时引擎随亡），详见「已知边界」。
# 需要「派发后做别的、完成唤醒」时用 Bash run_in_background 包裹整条命令，CLI 退出即引擎原生通知）
node bin/zsw.js workflow --workflow chain --task "分析并总结 README" --workdir <绝对路径>
node bin/zsw.js workflow --workflow map-reduce --task "..." --workdir <绝对路径> \
  --operation "提取每个文件的导出" --items '["a.ts","b.ts"]'
node bin/zsw.js workflow --workflow script:my-wf --task "..." --workdir <绝对路径>   # 自定义脚本

# abort / status / list / scripts / lint
node bin/zsw.js workflow --action list
node bin/zsw.js workflow --action status --id wf-xxxxxxxx
node bin/zsw.js workflow --action abort --id wf-xxxxxxxx
node bin/zsw.js workflow --action scripts          # 内置 5 + 自定义脚本清单
node bin/zsw.js workflow --action lint --file <脚本路径>
```

**review-fix-loop v2（批次外环 + 质量内核）**：唯一会写文件的内置 workflow（fix 阶段）。批次外环：`--batch1..--batchN` 串行，前一批 clean 后一批才启动，跨批 clean 且无 fix 的维度自动跳过。每轮并行 review → LLM 聚合裁决（臆测/无证据条目降级，不进修复队列）→ 结构化契约 fix → R2 起逐条 ID 对账（fixed/not-fixed/regressed）→ 收敛/needs-redesign 状态机；全程 state 落盘 `~/.zcode/zsw/rfl/<runId>/state.json`（每轮发生了什么、为什么终止可查证）。

```bash
node bin/zsw.js workflow --workflow review-fix-loop \
  --task "审查 PR：重构 auth 中间件" --workdir <绝对路径> \
  --target-type git-diff --target main \
  --batch1 "correctness,security" --batch2 "robustness,performance" \
  --stuck-threshold 3 --aggregator-model <模型短名>
```

参数面全集见 `node bin/zsw.js workflow --help`（`--target-type`/`--target`、`--batch1..N`/`--batch-names`、`--max-rounds` 默认 10、`--stuck-threshold` 默认 3、`--skip-clean-agents`、`--recheck-after-fix`、`--converge-new-issues`/`--converge-rounds`、`--max-fix-attempts`、`--aggregator-model`、`--review-prompt`/`--fix-prompt`、`--fallow-scan`、`--auto-commit` 等）。老参数兼容：`--reviewers` 等价单批 sugar（无 batchN 时包装为 `[reviewers]`）；`--review-target <text>` 等价 `--target-type text --target <text>`；target 系全缺省 = text / "git 未提交改动"。

v1→v2 行为差异（老参数调用者需知：参数兼容、语义刻意对齐 pi，非回归；完整清单见源仓库（github.com/zhushanwen321/zcode-plugins）根 `docs/design/zsw-review-fix-loop-v2-design.md` §4.1）：

| # | 差异 | v1 | v2 |
|---|------|----|----|
| 1 | reviewer 失败容忍 | 部分失败容忍（parseFail 按 clean 并告警） | 任一 reviewer 无效即 review-failed 结构化终止 |
| 2 | max-rounds 默认 | 5 | 10 |
| 3 | stuck-threshold | 硬编码 2、不可调 | 默认 3、`--stuck-threshold` 可调 |
| 4 | 修复范围 | 仅 must-fix，minor 不阻塞收敛 | 全等级修复，成功类终止要求 suggestion 归零 |
| 5 | 修复者输出 | 自由 markdown | 结构化契约（fixes/deferred 硬校验，违规 fix-failed） |
| 6 | 聚合 | JS 标题去重 | LLM 聚合裁决优先，JS 降级链兜底 |

**自定义 workflow 脚本**：内置 5 种之外的编排用 `script:<名>` 扩展。脚本按四根发现（`<ws>/.agents/workflows` > `<ws>/.zsw/workflows` > `~/.agents/workflows` > `~/.zsw/workflows`，只扫顶层 `*.js`），契约 `{name, description, run(ctx)}`；`ctx.runAgent({...})` 每次 = 一个独立无头 zcode 阶段（与内置阶段同一执行落点），返回 `{markdown, json}` 双段报告。完整契约与示例见 skill `zsub-zflow-orchestration` 与 `lib/workflow-script.js` 头注；写完先 `lint` 校验再运行。

`--local` 模式下 CLI 是一次性进程（本地执行，调试后门：无续聊/限流，CLI 退出即丢执行体）：start/message 一律阻塞到本轮完成再退出（无 `--no-wait`——CLI 进程退出即丢执行体，record 会卡 running）。bash `run_in_background` 场景直接让 CLI 阻塞到完成，由引擎跟踪该 bash 任务并在完成时唤醒。异步启动 + 聚合等待（`wait` / `start --wait`）走默认 daemon 模式（见下节）。

## CLI 默认形态：daemon thin client（1.0.0 起）

1.0.0 起 CLI 默认即常驻 daemon thin client（不加任何 flag；unix socket；sock 默认 `~/.zcode/zsw/daemon.sock`，env `ZSW_SOCK` 可覆盖，测试隔离用）。执行体由 daemon 持有——CLI 退出不丢，`start` 默认异步启动，`start --wait` 为 start+wait sugar；`wait` 子命令：`zsw wait --id a [--id b ...] [--timeout-ms n]`（无 `--local` 形态——本地一次性进程没有可挂起的等待方），等待在 daemon 侧内存挂起（零轮询），多 id 全部终态才返回，`--timeout-ms` 到点回 partial 结果并以 exit 2 退出。

agent 侧推荐组合：Bash 工具 `run_in_background=true` 包裹 `zsw start --wait …` 或 `zsw wait --id …`——CLI 阻塞进程成为引擎进程内 background 任务，完成即触发引擎原生 task-notification 唤醒会话（idle 也唤醒），不依赖 mailbox env、无需 sleep 轮询。

生命周期：daemon 由启用插件的 zcode 会话自动拉起（MCP server 进程竞选，无额外安装步骤），挂靠任一会话的插件进程——**所有会话关闭则 daemon 退场**，其持有执行体的任务终止（record 已落盘，由下一次接管实例 recover 探活标记 orphan/dead，不产生静默僵尸）。daemon 不在场时 CLI 报错并给恢复指引（稍候重试，其他实例接管需 1-2s；在任一 zcode 会话确认插件已启用；或加 `--local` 走本地一次性执行——调试后门：无续聊/限流，CLI 退出即丢执行体）。`zsw workflow` 的 abort/status/list/scripts 管理面默认同走 daemon（跨进程 record 一致）；run/lint 恒本地——run 执行体 = CLI 进程本身，abort 对本地 run 只终态化 record、不停执行体，取消本地 run（bg bash 形态）用引擎 TaskStop。

## 从 dynamic-workflow 迁移

原 dynamic-workflow 插件已卸载（config.json 的 plugins 注册已移除），全部能力并入本插件：5 个 workflow 逻辑零漂移（review-fix-loop 除外——其后升级 v2 批次外环与质量内核，见上文），tool 名曾从 `mcp__dynamic-workflow__zflow` 改为 `mcp__zsw__zflow`（MCP 工具面时代命名；1.0.0 工具面下线后入口为 CLI `zsw workflow` 子命令），报告品牌为 `# zsw ·`（命名体系见 CONTEXT.md）。旧插件目录保留在原 worktree 作历史归档。

结果全文落 `~/.zcode/zsw/outputs/<id>.md`；worktree 任务的 patch 落 `<id>.patch`（完成通知含 `git apply` 指引）。

## 状态与目录

```
~/.zcode/zsw/
├── records.jsonl        append-only 事件流（崩溃后重放恢复）
├── outputs/             结果全文 + patch
├── rfl/<runId>/         review-fix-loop v2 run 目录（state.json + 各轮 reviewer 报告；非全员 clean 轮另有该轮 aggregated.md，发生修复的轮另有 fix 结果；全员 clean 轮不产 aggregated.md、轮摘要标注未聚合）
├── daemon.sock          daemon 控制面 unix socket（0.2.0+，ZSW_SOCK 可覆盖）
├── daemon.sock.lock     daemon 竞选锁文件（O_EXCL 原子裁决）
├── logs/                appserver 引擎 stderr 实时落盘（异常诊断面，引擎正常时零输出；thinking 档位/协议交互取证面为引擎自有日志 home-appserver/.zcode/cli/log/）
├── probe-cache.json     appserver probe 结论缓存（键 = CLI 路径 + mtime，只缓存 ok）
├── home-<provider>-<modelShort>/  per-model 隔离 HOME 池（spawn 回退通道模型路由）
├── home-appserver/      appserver 默认通道单一隔离 HOME（遥测已关闭）
└── wt-<id>/             worktree 隔离目录（任务期存在）
```

## 已知边界（如实声明）

- **mailbox 完成通知是 legacy 通道（仅 MCP 工具面时代有效）**：mailbox 投递需要会话定向（targetSessionId），只有 MCP 工具调用携带；1.0.0 工具面下线后 CLI/daemon 面恒无投递目标，notifyCompletion 必不投递（句柄 notify 字段如实标 `none`，不写 `mailbox` 误导「会自动回流」）。M1 默认形态（CLI daemon）任务的完成唤醒唯一路径 = CLI 阻塞进程（`wait` / `start --wait`）配 Bash `run_in_background`，成为引擎进程内 background 任务、完成即触发原生 `<task-notification>`（idle 也唤醒，不依赖任何 env）。需要「完成即唤醒 + goal gate」的简单任务仍可直接用原生 `@agent`。
- **默认执行通道 = appserver（常驻 `zcode app-server`，apc 协议；subagent 任务与 workflow 阶段同走）**：`zsw start` 与 workflow 的每个阶段不带任何 env 即走常驻引擎。冷启动代价按形态摊薄：daemon 形态下引擎全进程共享——每个引擎进程只惰性启动一次（~1-2s，首个任务/阶段付出），之后 subagent 会话零冷启动续聊、后续 workflow 阶段零进程重建；`zsw workflow run`（本地一次性进程）每 run 付一次引擎惰性启动。组装前 probe 健康检查失败自动降级 spawn。probe ok 结论落盘 `~/.zcode/zsw/probe-cache.json`（键 = CLI 路径 + mtime，只缓存 ok；CLI 更新即失效重探）——`--local` 每条命令是一次性进程、daemon 启动只组装一次，落盘让两形态共享探针结论；缓存命中后首次会话创建失败（-32603/-32601/-32602）会失效缓存并重探一次，重探失败则本任务转 spawn 重跑且 record 如实改标；降级为**通道级**——daemon 生命周期内后续任务直接走 spawn 免重探，重启 ZCode 后重新组装、恢复探测。workflow 阶段条目落 `channel` 字段（`appserver`|`spawn`），降级混跑的报告可直接对照各阶段实际通道。断链自愈：会话被引擎驱逐或引擎进程崩溃后，下一次交互自动 `session/resume`（携带 runtimeModel）重试一次；不可恢复时报「会话弃用 + `zsw start` 重建指引」而非裸错误码。-32004 的主来源是引擎进程死亡与 close（订阅会话免空闲驱逐）。协议漂移（-32601/-32602）分类为 protocol-drift 并给升级冒烟指引（`node test/e2e.test.js --name apc-smoke`）。
- **workflow 中止语义按形态如实区分**：daemon 形态（zflow 派发、执行体在 daemon 进程内）的 `abort` 是 runner 侧取消——报告立即落 `status:'aborted'`、后续阶段不再启动；但引擎侧在飞轮**不被打断**（`session/stop` 对 RPC 在飞轮无打断能力，已真机实证），该轮会跑到自然完成——这部分 token 已消耗，属 apc 通道相对 spawn 立停的已知代价。`zsw workflow run` 本地一次性进程的中止是进程级：Ctrl-C/SIGTERM 下 CLI 与其拉起的引擎子进程一同退出（引擎随亡，不走 session/stop）；`zsw workflow --action abort` 对本地 run 只终态化 record、停不掉执行体（取消 bg bash 形态的本地 run 用引擎 TaskStop）。
- **`ZSW_RUNNER=spawn` 显式回退旧通道**：subagent 每轮、workflow 每阶段各自 spawn 独立 zcode 进程（~1-2s 冷启动），故障隔离与翻转前一致。daemon 在进程启动时读一次 env——改 `ZSW_RUNNER` 后需重启 ZCode 生效。
- **running 会话不可插话（busy，两通道同语义）**：message 投递到 running 中的会话立即返回 busy 结果（stdout JSON `busy:true` + exit 0，非报错退出；appserver 侧 `-32010` 硬错误，探针实证；不排队不打断），等待本轮完成（`zsw wait --id <id>`）或 `zsw cancel --id <id>` 取消后再投递。
- **工具黑名单是引擎级硬拦截（两来源并集），`tools` 白名单维持软约束**：黑名单 = CLI `--deny-tools`（逗号分隔裸工具名）∪ agent .md frontmatter `disallowedTools`——默认 appserver 通道经 `session/create` 的 `toolDenylist` 引擎级拦截，spawn 回退通道维持 `--disallowed-tools` flag 硬拦截（frontmatter 来源生效，CLI 来源不消费）；`--allow-tools` 白名单同理落 `toolAllowlist`（仅 appserver）。frontmatter `tools` 白名单维持 prompt 软约束（两通道一致）：zcode CLI 无 allowlist flag（`--allowed-tools` 拒收），白名单只能约束意图不能拦截行为。
- **subagent 与 workflow 的并发池相互独立**：subagent 池默认 3；workflow 池默认 2（单 workflow 内部阶段并发默认 3，maxConcurrent 可调）——双池互不占位，满载 3 + 2×3 最多 9 个并发阶段（默认 apc 通道下阶段共享常驻引擎、不新增进程；spawn 回退档下即 9 个 zcode 进程；workflow 池 slot 粒度 = 整个 run）。
- **并发深度分层当前为预留**：嵌套环境（ZSW_NESTED）被双门禁直接拒绝，实际 depth 恒 0——分层逻辑保留给未来放开受限嵌套服务时使用。
- **mailbox 引擎侧语义（legacy 通道的如实现记录）**：drain 单次最多 20 条（本插件用单调文件名防挤窗）；会话 mailbox 内若有外部坏 envelope 文件会永久阻塞该会话 drain（引擎无 quarantine，本插件投递已用原子写 + 写前自检规避）。通道在工具面下线后不再有投递方，条目留作历史与 notifier-mailbox.js 的实现依据。

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
