# z-subagent-workflow — zcode subagent 编排 + workflow 插件

> 两条能力线，1.0.0 起统一走 CLI（`node bin/zsw.js`，默认连常驻 daemon thin client；MCP 工具面已下线——tools/list 恒空、tools/call 指引走 CLI）：
> **zsub** — 无头 subagent 生命周期管理（start/list/status/cancel/message/close/wait/agents/models）。补足引擎原生后台 agent 缺少的能力：worktree 文件隔离、schema 结构化输出、conversation 续聊、四根 agent .md 发现（复用 pi 生态）、per-start 模型路由、跨窗口 record。
> **zflow** — 确定性多阶段编排（`zsw workflow` 子命令，六 action：run/abort/status/list/scripts/lint）：内置 5 种（chain/parallel/map-reduce/scatter-gather/review-fix-loop）+ 自定义 `script:<名>` 脚本扩展；run 同步阻塞出报告（配 Bash run_in_background 即完成原生唤醒）。自 dynamic-workflow v0.2.0 移植并入（原插件已卸载，本插件是唯一一套）。
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

**自定义 workflow 脚本**：内置 5 种之外的编排用 `script:<名>` 扩展。脚本按四根发现（`<ws>/.agents/workflows` > `<ws>/.zsw/workflows` > `~/.agents/workflows` > `~/.zsw/workflows`，只扫顶层 `*.js`），契约 `{name, description, run(ctx)}`；`ctx.runAgent({...})` 每次 = 一个独立无头 zcode 阶段（与内置阶段同一执行落点），返回 `{markdown, json}` 双段报告。完整契约与示例见 skill `zsub-zflow-orchestration` 与 `lib/workflow-script.js` 头注；写完先 `lint` 校验再运行。

`--local` 模式下 CLI 是一次性进程（本地执行，调试后门：无续聊/限流，CLI 退出即丢执行体）：start/message 一律阻塞到本轮完成再退出（无 `--no-wait`——CLI 进程退出即丢执行体，record 会卡 running）。bash `run_in_background` 场景直接让 CLI 阻塞到完成，由引擎跟踪该 bash 任务并在完成时唤醒。异步启动 + 聚合等待（`wait` / `start --wait`）走默认 daemon 模式（见下节）。

## CLI 默认形态：daemon thin client（1.0.0 起）

1.0.0 起 CLI 默认即常驻 daemon thin client（不加任何 flag；unix socket；sock 默认 `~/.zcode/zsw/daemon.sock`，env `ZSW_SOCK` 可覆盖，测试隔离用）。执行体由 daemon 持有——CLI 退出不丢，`start` 默认异步启动，`start --wait` 为 start+wait sugar；`wait` 子命令：`zsw wait --id a [--id b ...] [--timeout-ms n]`（无 `--local` 形态——本地一次性进程没有可挂起的等待方），等待在 daemon 侧内存挂起（零轮询），多 id 全部终态才返回，`--timeout-ms` 到点回 partial 结果并以 exit 2 退出。

agent 侧推荐组合：Bash 工具 `run_in_background=true` 包裹 `zsw start --wait …` 或 `zsw wait --id …`——CLI 阻塞进程成为引擎进程内 background 任务，完成即触发引擎原生 task-notification 唤醒会话（idle 也唤醒），不依赖 mailbox env、无需 sleep 轮询。

生命周期：daemon 由启用插件的 zcode 会话自动拉起（MCP server 进程竞选，无额外安装步骤），挂靠任一会话的插件进程——**所有会话关闭则 daemon 退场**，其持有执行体的任务终止（record 已落盘，由下一次接管实例 recover 探活标记 orphan/dead，不产生静默僵尸）。daemon 不在场时 CLI 报错并给恢复指引（稍候重试，其他实例接管需 1-2s；在任一 zcode 会话确认插件已启用；或加 `--local` 走本地一次性执行——调试后门：无续聊/限流，CLI 退出即丢执行体）。`zsw workflow` 的 abort/status/list/scripts 管理面默认同走 daemon（跨进程 record 一致）；run/lint 恒本地——run 执行体 = CLI 进程本身，abort 对本地 run 只终态化 record、不停执行体，取消本地 run（bg bash 形态）用引擎 TaskStop。

## 从 dynamic-workflow 迁移

原 dynamic-workflow 插件已卸载（config.json 的 plugins 注册已移除），全部能力并入本插件：5 个 workflow 逻辑零漂移（含 review-fix-loop 的 maxRounds 熔断/stuck 检测/must-fix 聚合语义），tool 名曾从 `mcp__dynamic-workflow__zflow` 改为 `mcp__zsw__zflow`（MCP 工具面时代命名；1.0.0 工具面下线后入口为 CLI `zsw workflow` 子命令），报告品牌为 `# zsw ·`（命名体系见 CONTEXT.md）。旧插件目录保留在原 worktree 作历史归档。

结果全文落 `~/.zcode/zsw/outputs/<id>.md`；worktree 任务的 patch 落 `<id>.patch`（完成通知含 `git apply` 指引）。

## 状态与目录

```
~/.zcode/zsw/
├── records.jsonl        append-only 事件流（崩溃后重放恢复）
├── outputs/             结果全文 + patch
├── daemon.sock          daemon 控制面 unix socket（0.2.0+，ZSW_SOCK 可覆盖）
├── daemon.sock.lock     daemon 竞选锁文件（O_EXCL 原子裁决）
├── logs/                appserver 引擎 stderr 实时落盘（漂移取证 / thinking 档位观测面）
├── probe-cache.json     appserver probe 结论缓存（键 = CLI 路径 + mtime，只缓存 ok）
├── home-<model>/        per-model 隔离 HOME（spawn 回退通道模型路由）
├── home-appserver/      appserver 默认通道单一隔离 HOME（遥测已关闭）
└── wt-<id>/             worktree 隔离目录（任务期存在）
```

## 已知边界（如实声明）

- **mailbox 完成通知是 legacy 通道（仅 MCP 工具面时代有效）**：mailbox 投递需要会话定向（targetSessionId），只有 MCP 工具调用携带；1.0.0 工具面下线后 CLI/daemon 面恒无投递目标，notifyCompletion 必不投递（句柄 notify 字段如实标 `none`，不写 `mailbox` 误导「会自动回流」）。M1 默认形态（CLI daemon）任务的完成唤醒唯一路径 = CLI 阻塞进程（`wait` / `start --wait`）配 Bash `run_in_background`，成为引擎进程内 background 任务、完成即触发原生 `<task-notification>`（idle 也唤醒，不依赖任何 env）。需要「完成即唤醒 + goal gate」的简单任务仍可直接用原生 `@agent`。
- **默认执行通道 = appserver（常驻 `zcode app-server`，apc 协议）**：`zsw start` 不带任何 env 即走常驻引擎，conversation 零冷启动续聊；组装前 probe 健康检查失败自动降级 spawn。probe ok 结论落盘 `~/.zcode/zsw/probe-cache.json`（键 = CLI 路径 + mtime，只缓存 ok；CLI 更新即失效重探）——`--local` 每条命令是一次性进程、daemon 启动只组装一次，落盘让两形态共享探针结论；缓存命中后首次会话创建失败（-32603/-32601/-32602）会失效缓存并重探一次，重探失败则本任务转 spawn 重跑且 record 如实改标。断链自愈：会话被引擎驱逐或引擎进程崩溃后，下一次交互自动 `session/resume`（携带 runtimeModel）重试一次；不可恢复时报「会话弃用 + `zsw start` 重建指引」而非裸错误码。-32004 的主来源是引擎进程死亡与 close（订阅会话免空闲驱逐）。协议漂移（-32601/-32602）分类为 protocol-drift 并给升级冒烟指引（`node test/e2e.test.js --name apc-smoke`）。
- **`ZSW_RUNNER=spawn` 显式回退旧通道**：每轮 spawn 独立 zcode 进程（~1-2s 冷启动），故障隔离与翻转前一致。daemon 在进程启动时读一次 env——改 `ZSW_RUNNER` 后需重启 ZCode 生效。
- **running 会话不可插话（busy，两通道同语义）**：message 投递到 running 中的会话立即返回 busy 报错（appserver 侧 `-32010` 硬错误，探针实证；不排队不打断），等待本轮完成或 `zsw stop`。
- **tools 白名单是软约束（prompt 段），denylist 才是硬约束**（`--disallowed-tools` flag）：zcode CLI 无 allowlist flag（`--allowed-tools` 拒收），白名单只能约束意图不能拦截行为。
- **subagent 与 workflow 的并发池相互独立**：subagent 池默认 3；workflow 池默认 2（单 workflow 内部阶段并发默认 3，maxConcurrent 可调）——双池互不占位，满载 3 + 2×3 最多 12 个 zcode 进程。
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

无头 e2e（E1-E8，真实 zcode 无头进程 + 真实模型）见 `test/e2e.test.js`，`node --test test/e2e.test.js` 自动运行（注意模型 token 消耗与账户限流窗口）。
