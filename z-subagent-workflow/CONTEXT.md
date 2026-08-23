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
| **缩写** | `zsw` | 机器读的短标识：env 前缀（`ZSW_ROOT`、`ZSW_NESTED`、`ZSW_ZCODE_CLI`、`ZSW_E2E_*`）、数据根 `~/.zcode/zsw/`、CLI 命令 `bin/zsw.js`、MCP server 名（SERVER_INFO.name）、workflow 脚本发现根 `.zsw/workflows`（workspace 与 HOME 两侧）、内部函数（`zswRoot()`）、日志前缀 `[zsw]` |
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

## 自查清单（提交前）

- [ ] 新 env 变量用 `ZSW_` 前缀（引擎的 `ZCODE_*` 除外，那是宿主的）
- [ ] 新路径落在 `zswRoot()` 下，不硬编码 `~/.zcode/zsub`
- [ ] 文档里「插件」指代用全名或 zsw；`zsub`/`zflow` 只在 tool 语境出现
- [ ] CLI 示例命令写 `node bin/zsw.js ...`
- [ ] workflow 脚本发现描述写 `.zsw/workflows`
- [ ] marketplace.json / plugin.json / .mcp.json 三处 name 同步（全名）
