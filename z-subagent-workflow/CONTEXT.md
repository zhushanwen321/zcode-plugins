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
| **缩写** | `zsw` | 机器读的短标识：env 前缀（`ZSW_ROOT`、`ZSW_NESTED`、`ZSW_SOCK`、`ZSW_E2E_*`；`ZSW_RUNNER` 已退役——见「执行通道」节）、数据根 `~/.zcode/zsw/`、CLI 命令 `bin/zsw.js`、MCP server 名（SERVER_INFO.name）、workflow 脚本发现根 `.zsw/workflows`（workspace 与 HOME 两侧）、内部函数（`zswRoot()`）、日志前缀 `[zsw]` |
| **tool 名** | `zsub` / `zflow` | 语义层名（1.0.0 起 MCP 工具面下线，无实际 tool，叙事沿用）：`zsub` = subagent 生命周期（九 action：start/list/status/cancel/message/close/wait/agents/models），`zflow` = workflow 管理面（六 action：run/abort/status/list/scripts/lint）。skill 名 `zsub-zflow-orchestration` 由两者组合。CLI/文档中提到「zsub 面」「zflow 的 run action」用这些名 |

## 判定规则

一个 token 要出现在新场合时，先问**指代什么**：

1. 指代**插件整体**（安装单元）→ 人读场合用全名；机器读场合（env/路径/命令）用 `zsw`。
2. 指代 **zsub/zflow 语义面**（action 语境；1.0.0 起无实际 MCP tool）→ 只能用 `zsub` 或 `zflow`，且与该面的 action 语义一致。
3. 指代**数据/运行时产物** → `zsw`（数据根下）或语义前缀（record id：`sa-` subagent / `wf-` workflow run；worktree 目录 `wt-<id>`；引擎 journal 目录 `engines/zcode/shared/`——旧 home 池 token `home-<provider>-<modelShort>` 随引擎 0.5.0 共享宿主 HOME 废弃）。

禁止混用：`zsub` 不再作为插件总品牌（旧用法）；`zsw` 不用于 tool 名；数据目录不出现 `zsub` 字样。

## 数据目录布局（`~/.zcode/zsw/`，`ZSW_ROOT` 可覆盖）

```
~/.zcode/zsw/
├── records.jsonl                 append-only record 事件流（zsub subagent 线；回接 2b 起
│                                 workflow 线不再写入——旧 wf- record 留存可读但无消费方）
├── workflow-state/<runId>.jsonl  workflow run 状态快照（回接 2b：core FileRunStore
│                                 append-only，末行有效行 = 最新状态；daemon 接管时重水合）
├── outputs/<id>.md               结果全文（worktree 任务另有 <id>.patch）
├── daemon.sock                   daemon 控制面 unix socket（0.2.0+，ZSW_SOCK 可覆盖）
├── daemon.sock.lock              daemon 竞选锁文件（sockPath + '.lock'，O_EXCL 原子裁决）
├── logs/                         core 编排日志（workflow-core.log）
├── engines/zcode/shared/         core zcode 引擎 journal（0.5.0 起共享宿主 HOME：无隔离池/
│                                 pidfile/派生目录，journal-*.jsonl 分组 poolKey 恒 'shared'；
│                                 会话写宿主真实 ~/.zcode/cli/db/db.sqlite，与 GUI 共写）
├── wt-<subagentId>/              worktree 隔离目录（listOrphans 按前缀认领）
└── home-*/                       旧 spawn/appserver 池目录（已退役；engines/zcode/ 下旧
                                  home-<prov>-<m>/、home-appserver(-N)/ 池目录同废，存量残留可清理）
```

## 执行通道（2026-09 引擎 0.5.0 起：单一 app-server 形态，共享宿主 HOME）

执行链 = vendored `@zhushanwen/subagent-core` 的 zcode 引擎**单一 app-server 常驻形态**
（`lib/runner-core.js` 端口适配；引擎共享宿主 HOME——spawn env 不覆写 HOME，直接
消费宿主 `~/.zcode/` 的凭据（`~/.zcode/v2/config.json`）/模型配置/会话 db，会话写
真实 `~/.zcode/cli/db/db.sqlite`（与 zcode GUI 共写同一 SQLite，WAL 并发安全）；
模型校验归引擎 preparer，stdout 解析归 core parser）。CLI spawn 单轮回退、probe
冒烟门控、protocol-drift 首败降级与引擎模式钉扎 env 已随 0.5.0 删除——协议漂移
直接报可操作错误，无降级链（演进史见 README「回接 2c break 变更」节及其 2026-09 段）。

| env | 取值 | 默认 | 语义 |
|-----|------|------|------|
| `ZSW_RUNNER`（已退役） | `spawn` \| 其他 | 未设置 | 'spawn' = 兼容 no-op（告警一次后忽略——执行统一走 core zcode engine 单一 app-server 形态）；'appserver' = 启动即报退役错误（信息含 D6-⑥ 指引）；其余未知值 = 前置报错 |
| `XYZ_AGENT_SUBAGENT`（core nesting-guard） | `1` | 未设置 | 嵌套防护标记：被引擎 spawn 的无头 zcode 子进程携带，引擎/hook 据此识别嵌套会话（hook 守卫与 `ZSW_NESTED` 双标记判定）；nesting-guard 同时剥离 `ZSW_NESTED` 旧标记防孙代误判 |

> CLI 路径覆盖从 `ZSW_ZCODE_CLI` 改为 core 引擎的 `XYZ_ZCODE_CLI`（ Vendored
> 面约定）；漂移检测 = 探针真探（binary + version + golden 干跑）失败即报可操作
> 错误（0.5.0 起无门控/降级链）。

> 迁移说明：2026-08 重构前数据根为 `~/.zcode/zsub/`。插件 0.1.0 未发布、无外部
> 用户，不做自动迁移；旧目录若存在属于历史残留，可人工删除。

## 外部接口名（不属于本插件命名体系，引用时照抄）

- 引擎 env：`ZCODE_MESSAGE_ENABLED`（宿主引擎 mailbox 开关）、`ZCODE_MAILBOX_ROOT`
- 引擎 v2 config：`~/.zcode/v2/config.json`（provider/模型清单）
- zcode CLI：`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`（core 引擎面 `XYZ_ZCODE_CLI` 可覆盖）

## 设计决策索引（架构演进决策，详细论证以 design 文档为准）

| 时间 | 决策 | 详文 |
|------|------|------|
| 2026-08 · 0.2.0（M0） | daemon 化第一步：MCP server 进程竞选单例 daemon（sock 同目录锁文件 `O_EXCL` 原子裁决 + 看门狗接管），unix socket 控制面（`daemon.sock`，`ZSW_SOCK` 可覆盖）；CLI 加 `--daemon`（thin client，默认仍本地执行）与 `wait` 子命令（daemon 侧内存挂起、零轮询、partial exit 2）；推荐等待姿势 = `Bash(run_in_background=true)` + `zsw start --daemon --wait` / `zsw wait --daemon --id`（借引擎原生 background 通知，完成即唤醒含 idle）。MCP 双 tool 面行为不变（双面并存） | [design/DESIGN-v4.md](../design/DESIGN-v4.md)（§6 D1-D7 决策、§9 M0/M1 版本台阶） |
| 2026-08 · 1.0.0（M1） | M1 终态：MCP 工具面恒下线（tools/list 恒空、tools/call 恒拒绝并指引走 CLI——agent 交互全走 CLI，`zsub`/`zflow` 保留为语义层名）；CLI 默认翻转为 daemon 客户端形态（不加 flag 即走 daemon，2.0 起形态再退役为纯本地一次性执行），本地一次性执行改为显式 `--local` 调试后门（无续聊/限流，CLI 退出即丢执行体），原 daemon flag 删除；`ZSW_TOOLS_DISABLED` 灰度开关删除（自用单用户无灰度对象，默认翻转与工具摘除两项 breaking 在 1.0.0 一个 major 一次到位） | [design/DESIGN-v4.md](../design/DESIGN-v4.md)（§6 D1/D5/D7 决策、§9 M1 版本台阶） |
| 2026-08 · 回接 2b（D6-⑧/D7） | workflow 线整体替换为 vendored subagent-core orchestration（`lib/orchestration-host.js` 宿主 + `lib/agent-runner-adapter.js` 桥回 RunnerPort）：内置 5 资产来自 core `workflows/`；`script:<名>` 契约换 core worker 脚本（`@pi-meta` + top-level `agent()`，旧 `module.exports.run(ctx)` 契约废弃）；run 状态面迁 `workflow-state/<runId>.jsonl`（core FileRunStore），旧 wf- record 线与 workflow mailbox 完成通知线退役；zsub 线不受影响 | [docs/design/zsw-subagent-core-rebind.impl-plan.md](../docs/design/zsw-subagent-core-rebind.impl-plan.md)（§4 实施台阶、README「回接 2b break 变更」节） |
| 2026-08 · 回接 2c（D6-⑥） | 执行链切 vendored subagent-core zcode engine（spawn 单轮）：appserver 常驻通道显式退役（`ZSW_RUNNER=appserver` 报错；probe 门控/probe-cache/降级链/升级标记删除，漂移检测归 core 引擎探针）；模型执行解析归引擎 preparer（zsw model-router 瘦身为清单器）；conversation 续聊随 core 面 resume 缺口暂不可用（P3 回归）；引擎数据新布局 `engines/zcode/`；zsub 台账格式不变（D7） | [docs/design/zsw-subagent-core-rebind.impl-plan.md](../docs/design/zsw-subagent-core-rebind.impl-plan.md)（§5 偏差 #3、§7 检查点 3） |
| 2026-08 · appserver 主通道化（D1，已随 2c 退役） | 默认执行引擎从 spawn 翻转为常驻 app-server（apc 协议）：`ZSW_RUNNER` 缺省 = appserver（组装前 probe 健康检查 + 落盘缓存 `probe-cache.json` + 首败失效重探）、`spawn` = 显式回退；spawn 完整保留为回退位；断链自愈（-32004 → resume{runtimeModel} 恢复序）与协议漂移分类（protocol-drift）先行建成再翻转 | [docs/design/zsw-appserver-promotion-design.md](../docs/design/zsw-appserver-promotion-design.md)（§3.3 D1-D9） |
| 2026-09 · 引擎 0.5.0（单一 app-server + 共享宿主 HOME） | vendored subagent-core 0.4.0→0.5.0：zcode 引擎收为单一 app-server 常驻形态（CLI spawn 单轮回退/probe 冒烟门控/protocol-drift 首败降级/模式钉扎 env 全删，漂移直接报可操作错误）；共享宿主 HOME（引擎 spawn env 不覆写 HOME，直接消费宿主 `~/.zcode/` 凭据/模型配置/会话 db；会话写真实 `~/.zcode/cli/db/db.sqlite`，与 GUI 共写同一 SQLite，WAL 并发安全；隔离池/pidfile/派生目录全废弃，journal 落 `engines/zcode/shared/`）；exec.kind 恒 'appserver'、pid 恒 undefined、sessionRef.dbPath 为绝对路径；已接受代价 = GUI 会话列表可见 headless 会话、凭据轮换需重启引擎进程、漂移直接报错 | README「回接 2c break 变更」节「2026-09 引擎 0.5.0 breaking」段 |

## 自查清单（提交前）

- [ ] 新 env 变量用 `ZSW_` 前缀（引擎的 `ZCODE_*` 除外，那是宿主的）
- [ ] 新路径落在 `zswRoot()` 下，不硬编码 `~/.zcode/zsub`
- [ ] 文档里「插件」指代用全名或 zsw；`zsub`/`zflow` 只在 tool 语境出现
- [ ] CLI 示例命令写 `node bin/zsw.js ...`
- [ ] workflow 脚本发现描述写 `.zsw/workflows`
- [ ] marketplace.json / plugin.json / .mcp.json 三处 name 同步（全名）
