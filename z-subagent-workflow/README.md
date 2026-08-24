# z-subagent-workflow — zcode subagent 编排 + workflow 插件

> 两个 MCP tool：
> **`zsub`** — 无头 subagent 生命周期管理（start/list/status/cancel/message/close/agents/models）。补足引擎原生后台 agent 缺少的能力：worktree 文件隔离、schema 结构化输出、conversation 续聊、四根 agent .md 发现（复用 pi 生态）、per-start 模型路由、跨窗口 record。
> **`zflow`** — 确定性多阶段编排（六 action：run/abort/status/list/scripts/lint）：内置 5 种（chain/parallel/map-reduce/scatter-gather/review-fix-loop）+ 自定义 `script:<名>` 脚本扩展；run 后台化（立即返回 runId，完成自动通知）。自 dynamic-workflow v0.2.0 移植并入（原插件已卸载，本插件是唯一一套）。
> 简单纯后台任务请直接用原生 `@agent`（frontmatter `background: true`，独立 turn 唤醒 + goal gate）——分流指引见 skill `zsub-zflow-orchestration`。

## 架构（端口/适配器内核）

```
入口层   MCP 双 tool：zsub（八 action）+ zflow（六 action）+ skill + CLI 薄壳
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

三个决策位（执行引擎 / 回流通道 / 入口形态）正交且各自可换——更换实现不动 manager。平台版本漂移被限制在端口实现内部消化（`interpretEvent` 等单点防洪堤）。

## 安装（一次性）

1. 注册插件目录：`~/.zcode/cli/config.json` 的 `plugins.dirs` 数组追加本插件绝对路径（`<repo>/z-subagent-workflow`），重启 ZCode。
2. 启用完成通知（推荐）：`ZCODE_MESSAGE_ENABLED=1` 是**宿主引擎**（ZCode 桌面端）的 mailbox 开关——插件只是投递方，引擎不开启 drain 就没有通知回流，插件自动降级为 polling 模式（start/run 返回轮询指引），功能不受损、体验降档。按平台设置（作用目标是启动 ZCode 的那个图形会话环境）：

   | 平台 | 操作（持久） | 立即生效 |
   |------|-------------|---------|
   | macOS | 建 LaunchAgent：`~/Library/LaunchAgents/com.user.zsw.message-enabled.plist`，内容为 RunAtLoad 执行 `launchctl setenv ZCODE_MESSAGE_ENABLED 1`，然后 `launchctl load` 该 plist | `launchctl setenv ZCODE_MESSAGE_ENABLED 1` 后重启 ZCode（仅当前开机会话有效） |
   | Windows | 系统设置 → 环境变量 → 用户变量新增 `ZCODE_MESSAGE_ENABLED=1`（或 `setx ZCODE_MESSAGE_ENABLED 1`），注销重登 | 同左（设置后重启 ZCode） |
   | Linux | `~/.config/environment.d/zsw.conf` 写 `ZCODE_MESSAGE_ENABLED=1`（systemd 用户会话；或桌面环境自启脚本内 export） | 当前会话 `export` 后从终端启动 ZCode |

   设置后**重启 ZCode**（MCP server 是引擎子进程，必须在变量生效后启动才继承）。长期期望 ZCode 官方提供 settings 内的开关，消除 env 继承链依赖。
3. 验证：主会话问「列出可用 MCP 工具」，应出现 `zsub` 与 `zflow`。

## 使用

主 agent 调用 `zsub`（八 action：start/list/status/cancel/message/close/agents/models）与 `zflow`（六 action：run/abort/status/list/scripts/lint）两个 tool；人类可直接调试：

```bash
node bin/zsw.js start --task "审查 src/ 的错误处理" --slug review-1 --model <模型短名>   # 可用模型查 MCP zsub(action="models")
node bin/zsw.js list
node bin/zsw.js status --id sa-xxxx
node bin/zsw.js message --id sa-xxxx --text "补充：重点看重试逻辑"   # 阻塞到本轮完成再退出
node bin/zsw.js cancel --id sa-xxxx
```

workflow 管理面（MCP `zflow` 六 action 的 CLI 等价；record/outputs/通知同源）：

```bash
# run（--action 缺省；同步等完成 + 报告。异步 runId + 完成通知走 MCP zflow）
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

不加 `--daemon` 时 CLI 是一次性进程（本地执行模式）：start/message 一律阻塞到本轮完成再退出（无 `--no-wait`——CLI 进程退出即丢执行体，record 会卡 running；异步启动与完成通知走 MCP `zsub` / `zflow` tool）。bash `run_in_background` 场景直接让 CLI 阻塞到完成，由引擎跟踪该 bash 任务并在完成时唤醒。0.2.0 起另有 daemon 模式（见下节）。

## daemon 模式（0.2.0+，CLI thin client）

子命令加 `--daemon` 走常驻 daemon（unix socket thin client；sock 默认 `~/.zcode/zsw/daemon.sock`，env `ZSW_SOCK` 可覆盖，测试隔离用）。执行体由 daemon 持有——CLI 退出不丢，`start` 默认异步启动，`start --daemon --wait` 为 start+wait sugar；新增 `wait` 子命令：`zsw wait --daemon --id a [--id b ...] [--timeout-ms n]`，等待在 daemon 侧内存挂起（零轮询），多 id 全部终态才返回，`--timeout-ms` 到点回 partial 结果并以 exit 2 退出。

agent 侧推荐组合：Bash 工具 `run_in_background=true` 包裹 `zsw start --daemon --wait …` 或 `zsw wait --daemon --id …`——CLI 阻塞进程成为引擎进程内 background 任务，完成即触发引擎原生 task-notification 唤醒会话（idle 也唤醒），不依赖 mailbox env、无需 sleep 轮询。

生命周期：daemon 由启用插件的 zcode 会话自动拉起（MCP server 进程竞选，无额外安装步骤），挂靠任一会话的插件进程——**所有会话关闭则 daemon 退场**，其持有执行体的任务终止（record 已落盘，由下一次接管实例 recover 探活标记 orphan/dead，不产生静默僵尸）。daemon 不在场时 CLI 报错并给恢复指引（稍候重试，其他实例接管需 1-2s；在任一 zcode 会话确认插件已启用；或去掉 `--daemon` 走本地执行）。`zsw workflow` 子命令无 daemon 形态，仍是一次性同步执行。

## 从 dynamic-workflow 迁移

原 dynamic-workflow 插件已卸载（config.json 的 plugins 注册已移除），全部能力并入本插件：5 个 workflow 逻辑零漂移（含 review-fix-loop 的 maxRounds 熔断/stuck 检测/must-fix 聚合语义），tool 名从 `mcp__dynamic-workflow__zflow` 变为 `mcp__zsw__zflow`，报告品牌为 `# zsw ·`（命名体系见 CONTEXT.md）。旧插件目录保留在原 worktree 作历史归档。

结果全文落 `~/.zcode/zsw/outputs/<id>.md`；worktree 任务的 patch 落 `<id>.patch`（完成通知含 `git apply` 指引）。

## 状态与目录

```
~/.zcode/zsw/
├── records.jsonl        append-only 事件流（崩溃后重放恢复）
├── outputs/             结果全文 + patch
├── daemon.sock          daemon 控制面 unix socket（0.2.0+，ZSW_SOCK 可覆盖）
├── daemon.sock.lock     daemon 竞选锁文件（O_EXCL 原子裁决）
├── home-<model>/        per-model 隔离 HOME（spawn runner 模型路由）
└── wt-<id>/             worktree 隔离目录（任务期存在）
```

## 已知边界（如实声明）

- **MCP 面完成通知是被动注入**：外部进程不能投递引擎的 task-notification；mailbox 消息在主 agent 下次活动（UserPromptSubmit/PostToolUse/Stop）时注入，idle 期间滞留——这是 MCP 面通知的物理上限。0.2.0 起 CLI daemon 模式（`wait` / `start --daemon --wait` 配 Bash `run_in_background`）借引擎原生 background 通知获得「完成即唤醒（含 idle）」。需要「完成即唤醒 + goal gate」的简单任务仍可直接用原生 `@agent`。
- **spawn 模式每轮冷启动 ~1-2s**；conversation 密集场景用 appserver runner（启动探针失败自动降级 spawn）。
- **spawn 模式 running 不可投递**（message 返回 busy）；appserver 模式的 send-while-running 语义待真机探针。
- **模型路由当前仅支持 `builtin:bigmodel-coding-plan` 单 provider**：agent .md 带其他 provider 的 model 会得到可操作错误（列出可用清单）。多 provider 支持待后续读 v2 config 全量 provider 列表。
- **tools 白名单是软约束（prompt 段），denylist 才是硬约束**（`--disallowed-tools` flag）：zcode CLI 无 allowlist flag（`--allowed-tools` 拒收），白名单只能约束意图不能拦截行为。
- **subagent 与 workflow 的并发池相互独立**：subagent 池默认 3；workflow 池默认 2（单 workflow 内部阶段并发默认 3，maxConcurrent 可调）——双池互不占位，满载 3 + 2×3 最多 12 个 zcode 进程。
- **并发深度分层当前为预留**：嵌套环境（ZSW_NESTED）被双门禁直接拒绝，实际 depth 恒 0——分层逻辑保留给未来放开受限嵌套服务时使用。
- **appserver conversation 会话无 idle TTL 回收**：`config.idleConversationTtlMs` 为预留常量，未接线。
- **mailbox 引擎侧语义**：drain 单次最多 20 条（本插件用单调文件名防挤窗）；会话 mailbox 内若有外部坏 envelope 文件会永久阻塞该会话 drain（引擎无 quarantine，本插件投递已用原子写 + 写前自检规避）。

## 验收手册（真机 GUI，安装后逐项执行）

| # | 场景 | 步骤 | 通过标准 |
|---|------|------|----------|
| M1 | mailbox 注入 | 启用 env 重启 → 主会话让 LLM `zsub(action="start", task="数一下 README 有多少行", wait=false)`，随后让主 agent 做别的事 1-2 轮 | 后续轮次上下文出现 `[subagent 完成]`，模型主动转达结果 |
| M2 | 多窗口定向 | 两个窗口开不同项目，窗口 A start(bg)，窗口 B 做 1-2 次 tool 调用 | 完成通知出现在 A 的会话，B 不出现 |
| M3 | 降级 | 关闭 env 重启，同样 start(bg) | 返回含轮询指引；list 能拿到终态；全程无 mailbox 写入 |
| M4 | worktree | 干净主树 `start(worktree=true, task="在 src/ 新增 hello.ts")` | 主树干净；通知含 patchFile；`git apply --check <patch>` 通过 |
| M5 | appserver runner | `ZSW_RUNNER=appserver`（或配置）后 conversation 两轮 | 探针通过则零冷启动续聊；失败自动降级 spawn 且 record.runnerKind 如实标注 |

无头 e2e（E1-E8，真实 zcode 无头进程 + 真实模型）见 `test/e2e.test.js`，`node --test test/e2e.test.js` 自动运行（注意模型 token 消耗与账户限流窗口）。
