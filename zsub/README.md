# zsub — zcode subagent 编排插件

> 无头 subagent 生命周期管理：start / list / status / cancel / message / close。
> 补足引擎原生后台 agent 缺少的能力：worktree 文件隔离、schema 结构化输出、conversation 续聊、四根 agent .md 发现（复用 pi 生态）、per-start 模型路由、跨窗口 record。
> 简单纯后台任务请直接用原生 `@agent`（frontmatter `background: true`，独立 turn 唤醒 + goal gate）——分流指引见 skill `zsub-orchestration`。

## 架构（端口/适配器内核）

```
入口层   MCP 单 tool `zsub`（粗粒度）+ skill zsub-orchestration（渐进式）+ CLI 薄壳
编排层   SubagentManager —— 只依赖 lib/ports.js 契约
端口层   RunnerPort        NotifierPort        ModelRouterPort
          ├ SpawnRunner      ├ MailboxNotifier    ├ home-pool（spawn 配套）
          └ AppServerRunner  └ PollingNotifier    └ per-session（apc 配套）
域层     resolver / prompt-builder / record-store / output-store / worktree / jsonout
```

三个决策位（执行引擎 / 回流通道 / 入口形态）正交且各自可换——更换实现不动 manager。平台版本漂移被限制在端口实现内部消化（`interpretEvent` 等单点防洪堤）。

## 安装（一次性）

1. 注册插件目录：`~/.zcode/cli/config.json` 的 `plugins.dirs` 数组追加本插件绝对路径（`<repo>/zsub`），重启 ZCode。
2. 启用完成通知（推荐）：`launchctl setenv ZCODE_MESSAGE_ENABLED 1` 后重启 ZCode。未启用时 zsub 自动降级为 polling 模式（start 返回轮询指引），功能不受损、体验降档。
3. 验证：主会话问「列出可用 MCP 工具」，应出现 `zsub`。

## 使用

主 agent 调用 `zsub` tool（五 action）；人类可直接调试：

```bash
node bin/zsub.js start --task "审查 src/ 的错误处理" --slug review-1 --model GLM-4.7-Flash
node bin/zsub.js list
node bin/zsub.js status --id sa-xxxx
node bin/zsub.js message --id sa-xxxx --text "补充：重点看重试逻辑"
node bin/zsub.js cancel --id sa-xxxx
```

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

## 验收手册（真机 GUI，安装后逐项执行）

| # | 场景 | 步骤 | 通过标准 |
|---|------|------|----------|
| M1 | mailbox 注入 | 启用 env 重启 → 主会话让 LLM `zsub(action="start", task="数一下 README 有多少行", wait=false)`，随后让主 agent 做别的事 1-2 轮 | 后续轮次上下文出现 `[subagent 完成]`，模型主动转达结果 |
| M2 | 多窗口定向 | 两个窗口开不同项目，窗口 A start(bg)，窗口 B 做 1-2 次 tool 调用 | 完成通知出现在 A 的会话，B 不出现 |
| M3 | 降级 | 关闭 env 重启，同样 start(bg) | 返回含轮询指引；list 能拿到终态；全程无 mailbox 写入 |
| M4 | worktree | 干净主树 `start(worktree=true, task="在 src/ 新增 hello.ts")` | 主树干净；通知含 patchFile；`git apply --check <patch>` 通过 |
| M5 | appserver runner | `ZSUB_RUNNER=appserver`（或配置）后 conversation 两轮 | 探针通过则零冷启动续聊；失败自动降级 spawn 且 record.runnerKind 如实标注 |

无头 e2e（H1-H10）见 `test/e2e.test.js`，`node --test test/e2e.test.js` 自动运行（真实 zcode 无头进程，注意模型 token 消耗）。
