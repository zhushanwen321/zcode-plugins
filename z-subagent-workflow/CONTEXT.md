# CONTEXT.md — 命名规范与术语表

> 本文件是 z-subagent-workflow 插件命名体系的**唯一权威源**（SSOT）。新增代码、文档、
> 配置、测试时按此选择 token；发现不统一的表述以本文件为准修正。
> 历史背景：插件前身叫 `zsub`（曾含 run_workflow tool），2026-08 重构为
> `z-subagent-workflow` + 双 tool（zsub/zflow）+ env 前缀 ZSW_。旧 token 在
> 「指代插件整体」的场合一律视为过时。

## 命名层级（三层）

| 层 | token | 适用场合 |
|----|-------|---------|
| **全名** | `z-subagent-workflow` | 人读的插件标识：marketplace.json 的 name/source、插件目录名、`.zcode-plugin/plugin.json` 的 name、`.mcp.json` 的 server key、文档标题、git 分支名（`feat-zcode-subagent-workflow-*`） |
| **缩写** | `zsw` | 机器读的短标识：env 前缀（`ZSW_ROOT`、`ZSW_NESTED`、`ZSW_ZCODE_CLI`、`ZSW_SOCK`、`ZSW_E2E_*`）、数据根 `~/.zcode/zsw/`、CLI 命令 `bin/zsw.js`、MCP server 名（SERVER_INFO.name）、workflow 脚本发现根 `.zsw/workflows`（workspace 与 HOME 两侧）、内部函数（`zswRoot()`）、日志前缀 `[zsw]` |
| **tool 名** | `zsub` / `zflow` | 仅 MCP tool 语义层：`zsub` = subagent 生命周期（七 action），`zflow` = workflow 管理面（六 action）。skill 名 `zsub-zflow-orchestration` 由两者组合。CLI/文档中提到「MCP zsub tool」「zflow 的 run action」用这些名 |

## 判定规则

一个 token 要出现在新场合时，先问**指代什么**：

1. 指代**插件整体**（安装单元）→ 人读场合用全名；机器读场合（env/路径/命令）用 `zsw`。
2. 指代**某个 MCP tool** → 只能用 `zsub` 或 `zflow`，且与该 tool 的 action 语义一致。
3. 指代**数据/运行时产物** → `zsw`（数据根下）或语义前缀（record id：`sa-` subagent / `wf-` workflow run；worktree 目录 `wt-<id>`；home 池 `home-<provider>-<model>`）。

禁止混用：`zsub` 不再作为插件总品牌（旧用法）；`zsw` 不用于 tool 名；数据目录不出现 `zsub` 字样。

## 数据目录布局（`~/.zcode/zsw/`，`ZSW_ROOT` 可覆盖）

```
~/.zcode/zsw/
├── records.jsonl                 append-only record 事件流（subagent + workflow 共享）
├── outputs/<id>.md               结果全文（worktree 任务另有 <id>.patch）
├── daemon.sock                   daemon 控制面 unix socket（0.2.0+，ZSW_SOCK 可覆盖）
├── daemon.sock.lock              daemon 竞选锁文件（sockPath + '.lock'，O_EXCL 原子裁决）
├── wt-<subagentId>/              worktree 隔离目录（listOrphans 按前缀认领）
├── home-<provider>-<modelShort>/ spawn per-model 隔离 HOME 池
└── home-appserver/               appserver runner 单一隔离 HOME
```

> 迁移说明：2026-08 重构前数据根为 `~/.zcode/zsub/`。插件 0.1.0 未发布、无外部
> 用户，不做自动迁移；旧目录若存在属于历史残留，可人工删除。

## 外部接口名（不属于本插件命名体系，引用时照抄）

- 引擎 env：`ZCODE_MESSAGE_ENABLED`（宿主引擎 mailbox 开关）、`ZCODE_MAILBOX_ROOT`
- 引擎 v2 config：`~/.zcode/v2/config.json`（provider/模型清单）
- zcode CLI：`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`（`ZSW_ZCODE_CLI` 可覆盖）

## 设计决策索引（架构演进决策，详细论证以 design 文档为准）

| 时间 | 决策 | 详文 |
|------|------|------|
| 2026-08 · 0.2.0（M0） | daemon 化第一步：MCP server 进程竞选单例 daemon（sock 同目录锁文件 `O_EXCL` 原子裁决 + 看门狗接管），unix socket 控制面（`daemon.sock`，`ZSW_SOCK` 可覆盖）；CLI 加 `--daemon`（thin client，默认仍本地执行）与 `wait` 子命令（daemon 侧内存挂起、零轮询、partial exit 2）；推荐等待姿势 = `Bash(run_in_background=true)` + `zsw start --daemon --wait` / `zsw wait --daemon --id`（借引擎原生 background 通知，完成即唤醒含 idle）。MCP 双 tool 面行为不变（双面并存） | [design/DESIGN-v4.md](../design/DESIGN-v4.md)（§6 D1-D7 决策、§9 M0/M1 版本台阶） |
| 2026-08 · 1.0.0（M1） | M1 终态：MCP 工具面恒下线（tools/list 恒空、tools/call 恒拒绝并指引走 CLI——agent 交互全走 CLI，`zsub`/`zflow` 保留为语义层名）；CLI 默认翻转为 daemon thin client（不加 flag 即 daemon），本地一次性执行改为显式 `--local` 调试后门（无续聊/限流，CLI 退出即丢执行体），原 daemon flag 删除；`ZSW_TOOLS_DISABLED` 灰度开关删除（自用单用户无灰度对象，默认翻转与工具摘除两项 breaking 在 1.0.0 一个 major 一次到位） | [design/DESIGN-v4.md](../design/DESIGN-v4.md)（§6 D1/D5/D7 决策、§9 M1 版本台阶） |

## 自查清单（提交前）

- [ ] 新 env 变量用 `ZSW_` 前缀（引擎的 `ZCODE_*` 除外，那是宿主的）
- [ ] 新路径落在 `zswRoot()` 下，不硬编码 `~/.zcode/zsub`
- [ ] 文档里「插件」指代用全名或 zsw；`zsub`/`zflow` 只在 tool 语境出现
- [ ] CLI 示例命令写 `node bin/zsw.js ...`
- [ ] workflow 脚本发现描述写 `.zsw/workflows`
- [ ] marketplace.json / plugin.json / .mcp.json 三处 name 同步（全名）
