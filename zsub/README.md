# zsub — zcode subagent 编排 + workflow 插件

> 两个 MCP tool：
> **`zsub`** — 无头 subagent 生命周期管理（start/list/status/cancel/message/close）。补足引擎原生后台 agent 缺少的能力：worktree 文件隔离、schema 结构化输出、conversation 续聊、四根 agent .md 发现（复用 pi 生态）、per-start 模型路由、跨窗口 record。
> **`run_workflow`** — 5 种确定性多阶段编排（chain/parallel/map-reduce/scatter-gather/review-fix-loop），自 dynamic-workflow v0.2.0 移植并入（原插件已卸载，zsub 是唯一一套）。
> 简单纯后台任务请直接用原生 `@agent`（frontmatter `background: true`，独立 turn 唤醒 + goal gate）——分流指引见 skill `zsub-orchestration`。

## 架构（端口/适配器内核）

```
入口层   MCP 双 tool：zsub（六 action）+ run_workflow（5 种编排）+ skill + CLI 薄壳
编排层   SubagentManager（只依赖 lib/ports.js 契约）/ lib/workflow/（确定性管线）
端口层   RunnerPort        NotifierPort        ModelRouterPort
          ├ SpawnRunner      ├ MailboxNotifier    ├ home-pool（spawn 配套）
          └ AppServerRunner  └ PollingNotifier    └ per-session（apc 配套）
域层     resolver / prompt-builder / record-store / output-store / worktree / jsonout
         workflow/: run-phase（共享执行辅助）+ chain/parallel/map-reduce/
                    scatter-gather/review-fix-loop + report
```

三个决策位（执行引擎 / 回流通道 / 入口形态）正交且各自可换——更换实现不动 manager。平台版本漂移被限制在端口实现内部消化（`interpretEvent` 等单点防洪堤）。

## 安装（一次性）

1. 注册插件目录：`~/.zcode/cli/config.json` 的 `plugins.dirs` 数组追加本插件绝对路径（`<repo>/zsub`），重启 ZCode。
2. 启用完成通知（推荐）：`launchctl setenv ZCODE_MESSAGE_ENABLED 1` 后重启 ZCode。未启用时 zsub 自动降级为 polling 模式（start 返回轮询指引），功能不受损、体验降档。
3. 验证：主会话问「列出可用 MCP 工具」，应出现 `zsub`。

## 使用

主 agent 调用 `zsub`（六 action：start/list/status/cancel/message/close）与 `run_workflow`（编排）两个 tool；人类可直接调试：

```bash
node bin/zsub.js start --task "审查 src/ 的错误处理" --slug review-1 --model GLM-5.3
node bin/zsub.js list
node bin/zsub.js status --id sa-xxxx
node bin/zsub.js message --id sa-xxxx --text "补充：重点看重试逻辑"   # 阻塞到本轮完成再退出
node bin/zsub.js cancel --id sa-xxxx

node bin/zsub.js workflow --workflow chain --task "分析并总结 README" --workdir <绝对路径>
node bin/zsub.js workflow --workflow map-reduce --task "..." --workdir <绝对路径> \
  --operation "提取每个文件的导出" --items '["a.ts","b.ts"]'
```

CLI 是一次性进程：start/message 一律阻塞到本轮完成再退出（无 `--no-wait`——CLI 进程退出即丢执行体，record 会卡 running；异步启动与完成通知走 MCP `zsub` tool）。bash `run_in_background` 场景直接让 CLI 阻塞到完成，由引擎跟踪该 bash 任务并在完成时唤醒。

## 从 dynamic-workflow 迁移

原 dynamic-workflow 插件已卸载（config.json 的 plugins 注册已移除），全部能力并入本插件：5 个 workflow 逻辑零漂移（含 review-fix-loop 的 maxRounds 熔断/stuck 检测/must-fix 聚合语义），tool 名从 `mcp__dynamic-workflow__run_workflow` 变为 `mcp__zsub__run_workflow`，报告品牌改为 `# zsub ·`。旧插件目录保留在原 worktree 作历史归档。

结果全文落 `~/.zcode/zsub/outputs/<id>.md`；worktree 任务的 patch 落 `<id>.patch`（完成通知含 `git apply` 指引）。

## 状态与目录

```
~/.zcode/zsub/
├── records.jsonl        append-only 事件流（崩溃后重放恢复）
├── outputs/             结果全文 + patch
├── home-<model>/        per-model 隔离 HOME（spawn runner 模型路由）
└── wt-<id>/             worktree 隔离目录（任务期存在）
```

## 已知边界（如实声明）

- **完成通知是被动注入**：外部进程不能投递引擎的 task-notification；mailbox 消息在主 agent 下次活动（UserPromptSubmit/PostToolUse/Stop）时注入，idle 期间滞留。这是闭源平台外挂形态的物理上限。需要「完成即唤醒 + goal gate」的简单任务请用原生 `@agent`。
- **spawn 模式每轮冷启动 ~1-2s**；conversation 密集场景用 appserver runner（启动探针失败自动降级 spawn）。
- **spawn 模式 running 不可投递**（message 返回 busy）；appserver 模式的 send-while-running 语义待真机探针。
- **模型路由当前仅支持 `builtin:bigmodel-coding-plan` 单 provider**：agent .md 带其他 provider 的 model 会得到可操作错误（列出可用清单）。多 provider 支持待后续读 v2 config 全量 provider 列表。
- **tools 白名单是软约束（prompt 段），denylist 才是硬约束**（`--disallowed-tools` flag）：zcode CLI 无 allowlist flag（`--allowed-tools` 拒收），白名单只能约束意图不能拦截行为。
- **subagent 与 workflow 的并发池相互独立**（各默认 3）：同时跑 3 个 subagent + 1 个 3 并发 workflow 时最多 6 个 zcode 进程。
- **并发深度分层当前为预留**：嵌套环境（ZSUB_NESTED）被双门禁直接拒绝，实际 depth 恒 0——分层逻辑保留给未来放开受限嵌套服务时使用。
- **appserver conversation 会话无 idle TTL 回收**：`config.idleConversationTtlMs` 为预留常量，未接线。
- **mailbox 引擎侧语义**：drain 单次最多 20 条（zsub 用单调文件名防挤窗）；会话 mailbox 内若有外部坏 envelope 文件会永久阻塞该会话 drain（引擎无 quarantine，zsub 自身投递已用原子写 + 写前自检规避）。

## 验收手册（真机 GUI，安装后逐项执行）

| # | 场景 | 步骤 | 通过标准 |
|---|------|------|----------|
| M1 | mailbox 注入 | 启用 env 重启 → 主会话让 LLM `zsub(action="start", task="数一下 README 有多少行", wait=false)`，随后让主 agent 做别的事 1-2 轮 | 后续轮次上下文出现 `[subagent 完成]`，模型主动转达结果 |
| M2 | 多窗口定向 | 两个窗口开不同项目，窗口 A start(bg)，窗口 B 做 1-2 次 tool 调用 | 完成通知出现在 A 的会话，B 不出现 |
| M3 | 降级 | 关闭 env 重启，同样 start(bg) | 返回含轮询指引；list 能拿到终态；全程无 mailbox 写入 |
| M4 | worktree | 干净主树 `start(worktree=true, task="在 src/ 新增 hello.ts")` | 主树干净；通知含 patchFile；`git apply --check <patch>` 通过 |
| M5 | appserver runner | `ZSUB_RUNNER=appserver`（或配置）后 conversation 两轮 | 探针通过则零冷启动续聊；失败自动降级 spawn 且 record.runnerKind 如实标注 |

无头 e2e（H1-H10）见 `test/e2e.test.js`，`node --test test/e2e.test.js` 自动运行（真实 zcode 无头进程，注意模型 token 消耗）。
