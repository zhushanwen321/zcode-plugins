# z-tool-finder — zcode MCP 工具渐进式加载插件

> 一句话：把已注册 MCP server 的工具从「全量常驻上下文」改为「名字 + when-to-use 清单常驻、详情与调用按需代理」——per-server wrapper 中间人接管 + SessionStart hook 自动化，不改任何 MCP server 源码，一键可还原。

## 是什么 / 为什么

zcode 会话启动即连接所有已注册 MCP server 并把**全部工具定义**（description + inputSchema）注入模型上下文，常驻整个会话。本机实测（2026-08-26）：仅官方插件就常驻 37 个 MCP 工具定义（zcode-cua 31 个、node-repl 3 个等），占约 1 万+ token——即使本次任务一个 MCP 工具都不会用。zcode 无 defer_loading、无 per-tool 静态裁剪，用户没有任何调节手段；想省 token 只能禁用整个插件，连带失去 skills/commands。

z-tool-finder 通过「per-server 中间人 wrapper + SessionStart hook 自动接管 + additionalContext 清单注入」解决：接管后每个 server 只对模型暴露 `get_tool_details` / `call_tool` 两个 meta 工具，工具清单（每工具一行 when-to-use）经 hook 注入对话，底层真实 server 懒启动、空闲 5 分钟自动回收。目标常驻开销降幅 ≥60%。

## 安装与生效时序（「两次重启」）

inline 开发形态：

1. 把 `z-tool-finder` 目录绝对路径追加进 `~/.zcode/cli/config.json` 的 `plugins.dirs` 数组 → **重启 ZCode（第 1 次）**。
2. 会话 1 打开：SessionStart hook 自动扫描并接管用户级与插件自带的 stdio server，会话内注入接管提示（含还原命令与 per-tool 治理失配提示）；catalog 预扫描在后台进行（就绪前 wrapper 走实时兜底）。
3. **重启 ZCode（第 2 次）**。此后 wrapper 生效：本机实测工具区从 37 个工具变为 3 server × 2 meta 工具 + 1 个全局 `mcp__z-tool-finder__search_tools` = 7 个。

正式形态走 marketplace 安装（marketplace.json 登记），生效时序相同。

验证：终端跑 `zcode plugins list` 应见 z-tool-finder enabled；`node <插件>/bin/tf.js status` 查看接管状态。

## 使用者视角工作流

**自动接管范围**：

- 用户级（`~/.zcode/cli/config.json` 的 mcp.servers）与插件自带 stdio server：hook **自动**接管。插件 server 不动 cache 副本，而是在用户 config 写全命名空间覆盖条目（`plugin:<plugin>:<server>`，裸名无效）。
- workspace 级 server（`<repo>/.zcode/config.json`，团队共享文件）：**不自动接管**，仅 `tf takeover <server>` 显式支持。
- SSE/HTTP 型 server：不支持。

**agent 三跳协议**：

1. 模型看到 hook 注入的 `<available-custom-tools>` 清单（每工具一行 when-to-use）。
2. 选中工具后调 `mcp__<server>__get_tool_details(tool)` 获取完整 description + inputSchema + 最小调用示例。
3. 调 `mcp__<server>__call_tool(tool, args)` 执行——wrapper 按 schema 校验 args，按 registry 策略校验 allow/deny，首次调用懒启动底层原命令并转发。

清单外的模糊需求用全局 `mcp__z-tool-finder__search_tools(query, limit?)` 检索 catalog（关键词 + BM25）兜底。

## 配置（`~/.zcode/z-tool-finder/registry.json`）

| 字段 | 作用 |
|------|------|
| `servers.<name>.pinned` | 高频直通白名单（默认空）：pinned 工具不进渐进加载，直调原工具名 |
| `servers.<name>.excluded` | 排除清单：该 server 不被接管 |
| `overrides` | when-to-use 覆写，如 `{"browser-use:xlsx_read": "读 Excel/CSV 数据文件时使用"}`（默认取工具 description 首句） |
| `policies` | per-tool allow/deny，如 `{"browser-use:execute_js": "deny", "zcode-cua:*": "allow"}`。这是从引擎迁移来的 per-tool 治理承接：接管后引擎侧 per-tool 级管控必然失配（见下节），由 wrapper 在转发前自执行 |

## CLI 命令（`node <插件>/bin/tf.js`）

| 命令 | 作用 |
|------|------|
| `tf status` | 查看接管状态与策略 |
| `tf takeover <server>` | 显式接管单个 server（workspace 级唯一入口） |
| `tf restore [--all \| <server>]` | 还原：从 registry.original 恢复条目、删除覆盖条目、清理记录（逆操作，幂等） |
| `tf catalog refresh` | 主动全量刷新 catalog |
| `tf doctor [<server>]` | 诊断，输出日志路径（`~/.zcode/z-tool-finder/logs/`） |
| `tf hook session-start` | hook 入口（SessionStart 事件：startup/resume/clear/compact 四来源），一般由引擎自动调用 |

## 治理提示（重要披露）

接管后 per-server 粒度的 PreToolUse hook matcher 与命名空间**保留**；但 **per-tool 粒度的引擎治理必然失配**——如 matcher `mcp__computer-use__left_click`、`--disallowed-tools` 条目 `mcp__x__y`。per-tool 管控请改用 registry 的 `policies` 字段（`tf status` 查看）。首次接管时 hook 会显式提示已有 per-tool 条目失配。

## 还原与卸载

- 插件在装：`node <插件>/bin/tf.js restore --all`（或 `restore <server>` 单个还原）→ 重启 ZCode，原 `mcp__server__tool` 工具名全部恢复可调。
- 插件已卸载：接管条目 command 指向数据目录下的稳定 launcher（`~/.zcode/z-tool-finder/launcher/proxy-launcher.js`）。插件本体不存在时连接会失败并在 stderr 给出指引：跑 `node ~/.zcode/z-tool-finder/launcher/restore.js --all` 还原全部接管（restore.js 不依赖插件存在）。还原后 config 无残留 wrapper 条目。

## FAQ

- **hook 超时怎么办？** 清单生成只读本地 catalog（毫秒级），超时属异常——清单未注入但会话照常。跑 `tf doctor` 查看日志路径。
- **catalog 过期（server 新增了工具）？** `get_tool_details` 返回未命中时 wrapper 自动实时 tools/list 兜底并回写 catalog；也可 `tf catalog refresh` 主动全量刷新。
- **嵌套无头会话（如 zsub spawn）行为？** hook 检测 `TF_NESTED` / `ZSW_NESTED` env 标记即跳过清单注入与自动接管（设计行为，无需恢复）；wrapper 照常服务调用。
- **并发多窗口会同时触发接管吗？** 接管与 restore 全路径持单实例锁（`~/.zcode/z-tool-finder/registry.lock`），锁被存活进程持有时本次 hook 降级为只读清单注入、跳过接管（下个会话再接管）。

## 验收手册（真机 GUI，安装后逐项执行）

| # | 场景 | 步骤 | 通过标准 |
|---|------|------|----------|
| A1 | 安装自动接管（含并发） | inline 注册插件 → 重启 → 会话 1 收到接管提示 → 再重启；另开第二个 zcode 窗口与首窗口同时启动会话（并发触发 hook） | 会话 2 起被接管 server 只剩 2 个 meta 工具；清单注入可见；重复重启无重复接管；并发下 registry 与 config 一致、无孤儿条目；`restore --all` 完整还原 |
| A2 | token 压缩 | 以 zcode-cua（31 工具）+ browser-use 为对象，对比接管前完整定义与接管后「meta 工具定义 + 清单」合计（char/4 估算） | 常驻开销合计缩减 ≥60% |
| A3 | 渐进完成真实任务 | 真实会话让 agent 用被接管 server 完成「CSV 转 xlsx」类任务 | agent 按清单 → get_tool_details → call_tool 三跳完成，无需人工提示流程 |
| A4 | 还原闭环 | `tf restore --all` → 重启；再在 GUI 真实卸载插件后跑 `node ~/.zcode/z-tool-finder/launcher/restore.js --all` → 重启 | 原 `mcp__server__tool` 全部恢复可调；config 无残留 wrapper 条目；卸载后 launcher 给出还原指引而非静默失败 |
| A5 | compact 韧性 | 会话中执行 compact | compact 后清单仍在（SessionStart:compact 重注入），agent 仍能按清单取用 |
| A6 | 故障恢复 | 手动改坏一个底层 server 的原始 command（registry.original 中改错路径）→ agent 调用 | call_tool 报错含 stderr 摘要 + `tf doctor`/`restore` 指引；restore 后恢复 |

设计与决策依据见 `docs/DESIGN.md`。
