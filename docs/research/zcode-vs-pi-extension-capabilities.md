# zcode 能力调研：全面对标 pi extension 能力

> 调研日期：2026-08-23。方法：本地权威源交叉验证，不靠网络搜索。
> zcode 侧来源：官方内置 `zcode-guide` 插件 v0.1.0（`~/.zcode/cli/plugins/cache/zcode-plugins-official/zcode-guide/0.1.0/skills/` 六份 SKILL.md）+ 本机实例（`~/.zcode/cli/config.json`、官方 marketplace.json、zsub / dynamic-workflow 插件实体）。
> pi 侧来源：`~/GitApp/pi-ecosystem/pi-mono/packages/coding-agent/`（`docs/extensions.md` 2891 行、`docs/packages.md`、`docs/skills.md`、`docs/settings.md`、`docs/rpc.md`、源码 `loader.ts` / `package-manager.ts` / `types.ts`）+ xyz-agent 项目对 pi extension 开发的成熟总结（`~/Code/xyz-agent-workspace/main/docs/extensions/`）。

## 结论先行

| | pi coding agent | zcode 桌面端 |
|---|---|---|
| 扩展模型 | **进程内 TS extension**：`export default (pi: ExtensionAPI) => {}` 工厂 + 30+ 事件钩子 + 8 类 `register*` API + `ctx.ui` 全家 | **声明式内容 + 外挂进程**：五类资源（skills / commands / hooks / MCP servers / plugins）+ AGENTS.md 指令文件；**无任何进程内 extension API**（官方文档未覆盖，manifest 无 main/entry 字段） |
| 程序化能力的落点 | extension 模块本身（jiti 加载 TS，无需编译） | **MCP server（stdio 外挂进程）** + hooks（shell 命令，仅 7 事件，JSON 输出契约） |
| 分发 | npm / git / 本地路径（`pi install`，装到 `~/.pi/agent/npm|git/`） | marketplace（zip / git / 目录；**npm、pip 源不支持**）；本地开发走 config.json `plugins.dirs` inline 注册 |
| 本工作区的对策 | — | 程序化能力全部走 MCP 外挂（zsub 即此形态：双 MCP tool + skill + CLI 薄壳），声明式资源做触发与文档 |

一句话：**pi 是「宿主内 API」模型，zcode 是「内容 + 外挂进程」模型**。zsub 的存在意义就是用外挂形态补齐 zcode 缺失的编排类能力（详见第 5 节）。

---

## 1. zcode 扩展能力全景

### 1.1 资源类型与配置位置

| 资源 | 用户级 | 工作区级 | 插件内 |
|------|--------|----------|--------|
| Skills | `~/.zcode/skills/`、`~/.agents/skills/` | `<repo>/.zcode/skills/`、`<repo>/.agents/skills/`（逐层向上） | `<pluginRoot>/skills/` |
| Slash commands | `~/.zcode/commands/`、`~/.agents/commands/` | `<repo>/.zcode/commands/`、`<repo>/.agents/commands/` | `<pluginRoot>/commands/` |
| Hooks | `~/.zcode/cli/config.json` 顶层 `hooks` | `<repo>/.zcode/config.json` / `zcode.json` 的 `hooks` | `<pluginRoot>/hooks/hooks.json` 或 manifest `hooks` 字段 |
| MCP servers | `~/.zcode/cli/config.json` 的 `mcp.servers`（fallback `~/.agents/mcp.json` 顶层 `mcpServers`） | `<repo>/.zcode/config.json` / `zcode.json` 的 `mcp.servers`（fallback `.agents/mcp.json`） | `<pluginRoot>/.mcp.json`（**官方推荐位置**）或 manifest `mcpServers` |
| Plugins | — | 无工作区级插件配置位 | manifest `<pluginRoot>/.zcode-plugin/plugin.json`（探测顺序 `.zcode-plugin` → `.claude-plugin` → `.codex-plugin`） |
| AGENTS.md 指令 | `~/.zcode/AGENTS.md` | `<repo>/AGENTS.md`（向上搜索至项目根；后注入、可收窄用户级） | — |

### 1.2 发现与优先级规则

- **Skills / commands 六层发现顺序**：显式配置 roots → 用户 `~/.zcode` → 用户 `~/.agents` → 工作区 `.zcode` → 工作区 `.agents` → **已启用插件 roots（最低）**。同名 skill 第一个被发现者胜出（其余被遮蔽）；同名 command 首个胜出。**插件资源永远被本地同名资源遮蔽**。
- 插件 skill 以 `plugin:skill` 限定名暴露（如 `zsub:zsub-orchestration`）；嵌套 command 目录用冒号拼接（`review/code.md` → `/review:code`）。
- MCP 同名 server 覆盖顺序：CLI → 环境变量 → 用户 → 工作区 → 系统默认；插件 server 命名空间化为 `plugin:<plugin>:<server>`。
- hooks 合并：插件 matcher 追加在配置文件 matcher 之后。

### 1.3 插件 manifest 与 marketplace

- manifest 必需字段仅 `name`（`^[a-z0-9][a-z0-9._-]{0,127}$`）；可选 `version`（缺省 0.0.0）/ `description` / `commands` / `skills` / `hooks` / `mcpServers` / `userConfig`；`agents`、`channels`、`lspServers`、`outputStyles`、`settings` 为「**记录但不执行**」。**组件路径禁止绝对路径或逃逸插件根**。
- 插件身份 = `<name>@<marketplace>`；本地 inline 注册即 `<name>@inline`。
- marketplace.json：`{name, plugins[], pluginRoot?, allowCrossMarketplaceDependenciesOn?}`；`plugins[].source` 支持相对路径字符串 / `directory` / `github` / `git` / `git-subdir` / `url`(zip) / `filesystem`；**npm、pip 不支持**。
- **安装形态**：marketplace 插件以**完整副本**落 `~/.zcode/cli/plugins/cache/<marketplace>/<plugin>/<version>/`（多版本并存，副本带 `.zcode-plugin-seed.json` 完整性标记，cache 内零 symlink）；inline 插件**不复制**，直接从工作区路径加载。
- 本地开发注册（zsub / dynamic-workflow 实证）：

```json
"plugins": {
  "enabled": true,
  "dirs": ["<插件目录绝对路径>"],
  "enabledPlugins": { "<name>@inline": true }
}
```

改后**必须重启 ZCode**（GUI 只在启动时扫描插件配置）。

### 1.4 已知坑（对插件开发有直接影响的）

- MCP 配置 schema 严格：未知顶层键 → server **静默丢弃**；`command` 必须是字符串（数组形态会让 Settings 崩溃）。
- 模板变量 `${ZCODE_PLUGIN_ROOT}` / `${ZCODE_PROJECT_DIR}` 等**仅插件 MCP server 展开**，用户/工作区配置文件里的 server 不展开。
- hooks 仅 7 个事件（`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure` / `Stop`）；配置文件 hooks 必须显式 `hooks.enabled: true`；`timeout` 单位是**秒**、`timeoutMs` 是**毫秒**；matcher 是大小写敏感正则（`"bash"` 匹配不了 `Bash` 工具）。
- 引擎 agent .md 发现（`<repo>/.zcode/agents/` + `~/.zcode/agents/` 双根）**扫描时跳过 symlink**——逆向结论，书面证据在 `zsub/lib/agent-md-resolver.js` 头注；zcode-guide 官方文档未覆盖此点（来源差异，注意区分）。
- CLI 无公开契约：`--allowed-tools` 拒收（只有 denylist `--disallowed-tools`）；`--settings` / `--max-turns` help 漂移（0.16.3 解析器拒收）。升级后必须跑冒烟探针。
- 无头子进程固定读 `$HOME/.zcode/cli/config.json` → **HOME 隔离**是注入插件自定义 provider 配置的唯一干净手段（`HOME=<隔离目录>`，dynamic-workflow / zsub 均用此法，零污染用户配置）。

## 2. pi extension 能力全景

### 2.1 API 面（pi 原生）

- **入口**：`export default function (pi: ExtensionAPI)`（可 async；jiti 加载 TS 无需编译）。工厂可能在无 session 调用中运行，禁止在工厂里启动后台资源。
- **事件钩子 30+**（可拦截/修改）：`project_trust`；`resources_discover`；session 系（`session_start/before_switch/before_fork/before_compact/compact/before_tree/tree/shutdown` 等）；agent 系（`before_agent_start`、`turn_start/end`、`message_start/update/end`、`context`）；provider 系（`before_provider_headers/request`、`after_provider_response`）；tool 系（`tool_execution_*`、`tool_call` 可 block、`tool_result` 可修改结果）；输入系（`input`、`user_bash`）；模型系（`model_select`、`thinking_level_select`）。
- **注册 API 8 类**：`registerTool`（含系统提示注入、自定义渲染、可覆盖内置工具）、`registerCommand`（slash 命令 + 补全；同名冲突全保留加数字后缀）、`registerShortcut`、`registerFlag`、`registerProvider`/`unregisterProvider`（动态 provider + OAuth + 自定义流式）、`registerMessageRenderer`/`registerEntryRenderer`（TUI 渲染）。
- **命令式 API**：`sendMessage`（steer/followUp/nextTurn）、`appendEntry`（持久化且不进 LLM 上下文）、`exec`、`setActiveTools`（动态工具按需加载）、`setModel`、`pi.events`（extension 间事件总线）等。
- **ctx 能力**：`ctx.ui` 全家（select/confirm/input/editor/notify/setStatus/setWidget/custom 全屏组件）、`ctx.sessionManager`（getEntries/getBranch）、`ctx.compact`、`ctx.getContextUsage` 等。
- **四种运行模式**：`tui` / `rpc`（stdin/stdout JSONL）/ `json`（事件流 stdout）/ `print`；守卫规则 `ctx.mode === "tui"` 与 `ctx.hasUI`。

### 2.2 声明式资源与加载（pi 原生）

- package.json `pi` 字段**只有四个**（源码 `readPiManifest`）：`pi.extensions` / `pi.skills` / `pi.prompts` / `pi.themes`（string[]，支持 glob）。无 manifest 时 fallback 约定目录 `extensions/`、`skills/`、`prompts/`、`themes/`。
- **`pi.agents` / `pi.workflows` 不是 pi 原生字段**——是 xyz-agent 的 pi-subagent-workflow extension 私有约定（`src/shared/resource-discovery.ts` 解析七源发现 agent .md / workflow .js；pi 宿主不解析这些字段）。对标时必须区分。
- Extension 自动发现顺序：project `.pi/extensions/` → global `~/.pi/agent/extensions/` → settings.json 显式路径。Skills 发现：`~/.pi/agent/skills/`、`~/.agents/skills/`、项目 `.pi/skills/`、`.agents/skills/`（需 trust）、包内 `pi.skills`、settings、CLI `--skill`。
- **Project trust 门控**：`.pi/` 项目资源仅在项目被信任后加载（`~/.pi/agent/trust.json`）。
- 加载方式：`pi -e ./ext.ts`（npm:/git:/本地路径临时安装）、settings.json `packages`/`extensions`、`pi install/remove/list/update`；自动发现位置支持 `/reload` 热重载。
- 包管理：npm 装到 `~/.pi/agent/npm/`，git 到 `~/.pi/agent/git/`；包去重 identity = npm 包名 / git URL / 本地绝对路径，项目条目胜出。

### 2.3 日志与调试

- pi 宿主**不提供 logger 接口**：extension 的 `console.*` 直进主进程 stdout/stderr，TUI alternate-screen 下污染且不落盘。xyz-agent 为此自建三层通道约定（AI 实时 → tool result；事后排查 → `pi.appendEntry` 持久化不进上下文；开发者调试 → 落盘日志文件 + debug env 开关）+ 共享包 `@zhushanwen/pi-extension-logger`。
- 调试证据链：`pi-<date>-<sessionId>.jsonl`（pi 原始事件流，卡死时决定性证据）、`XYZ_DEBUG_PI_EVENTS=1`。

## 3. 逐维度对标

| 维度 | pi | zcode | 差距判定 |
|------|----|----|----------|
| 程序化扩展 | 进程内 TS 工厂 + 事件钩子 + register API | 无；MCP 外挂进程（stdio）+ hooks shell | **根本性差异**。zcode 的 MCP server 是独立进程：拿不到宿主 session 事件、不能改 system prompt、不能拦截工具调用（除 7 个 hook 事件） |
| 自定义工具 | `registerTool`（可覆盖内置、动态加载） | MCP server 暴露 tools（`plugin:<name>:<server>` 命名空间） | 等价能力可达（zsub 双 tool 即此）；但无「按需加载」与系统提示注入的宿主级联动 |
| Slash 命令 | `registerCommand`（带补全、运行时注册） | `commands/*.md` 声明式（文件名即命令名）+ 插件 commands | zcode 是静态声明，无运行时注册/补全 API |
| Skills | `pi.skills` + 多源发现 | 六层发现 + 插件 skills（最低优先级，`plugin:skill` 限定名） | 基本等价；zcode 插件 skill 会被本地同名遮蔽，命名需带前缀避让 |
| 事件/钩子 | 30+ 事件，多数可拦截/修改（tool_call 可 block、message_end 可替换） | 7 个事件，shell 命令 + 严格 JSON stdout 契约（退出码 2 阻断） | **数量与深度差距大**；zcode hooks 适合门禁/审计，不适合做转换器 |
| UI 扩展 | `ctx.ui` TUI 全家 + 自定义渲染/全屏组件 | 无任何扩展点（闭源 GUI） | 无法补齐（zsub 的完成通知只能走 mailbox 被动注入，idle 期间滞留——外挂形态物理上限） |
| Provider/模型 | `registerProvider`（动态 + OAuth + 自定义流式）、`model_select` | 无；无头子进程靠 HOME 隔离注入 provider 配置 | zcode 侧只能绕（HOME 隔离），zsub 模型路由当前限单 provider |
| 子代理/编排 | pi 原生仅示例 + 实验性 pi-orchestrator；xyz-agent 的 subagent-workflow 是自建封装 | 引擎原生后台 `@agent`（background: true，完成唤醒 + goal gate）；**zsub 补齐**：无头生命周期、worktree 隔离、schema 输出、续聊、四根 agent 发现、跨窗口 record、workflow 编排 | zsub 对标的就是 xyz-agent 的 pi-subagent-workflow（非 pi 原生能力） |
| 分发 | npm / git / 本地路径 | marketplace（zip/git/目录/filesystem），**无 npm 源** | 本工作区以本地 marketplace + inline 注册为主 |
| 安装形态 | 包管理器装到统一目录 | marketplace = 完整副本进 cache（组件路径禁逃逸插件根）；inline = 原位加载 | 直接决定本仓「共享库构建期 vendor、禁运行时跨根引用」纪律 |
| 热重载 | `/reload`（自动发现位置） | 无，改配置/插件须重启 GUI | 开发迭代成本差异 |
| RPC/无头 | `--mode rpc`（JSONL）/ `--mode json` / `-p`；SDK 直连 `AgentSession` | `zcode --json --prompt`（无公开契约，help 会漂移） | zcode 无头驱动是逆向使用，需冒烟探针防版本漂移 |
| 指令文件 | AGENTS.md / agent.md 体系 | 用户级 + 工作区级 AGENTS.md 合并注入 | 基本等价 |

## 4. pi 原生 vs xyz-agent 封装边界（对标时易混淆项）

| 能力 | 归属 |
|------|------|
| ExtensionAPI 工厂 / 事件 / 8 类 register / ctx.ui / `pi.extensions·skills·prompts·themes` / `--extension` / RPC / `/reload` / project trust | **pi 原生** |
| `pi.agents` / `pi.workflows` 字段 + agent .md / workflow .js 七源统一发现 | **xyz-agent 封装**（pi-subagent-workflow 内 resource-discovery.ts；pi 宿主只认四个资源键） |
| 五源加载链（ExtensionResolver）、`xyz-agent.role` 分组、mandatory-extensions.json | **xyz-agent 封装** |
| 子代理/workflow 编排（SubprocessAgentRunner、ManagedSession） | **xyz-agent 封装**（pi 原生仅示例 + experimental orchestrator） |
| 三层日志通道、pi-extension-logger | **xyz-agent 封装**（pi 宿主无 logger 接口） |
| `PI_CODING_AGENT_DIR` 重定向配置目录 | **pi 原生**（xyz-agent 借它做目录隔离） |

## 5. 能力缺口与补齐现状

zcode 相对 pi 的缺口，按「能否用外挂形态补齐」分三档：

**已补齐（zsub 实现）**：无头 subagent 生命周期管理（对标 pi-subagent-workflow）、确定性多阶段 workflow（chain/parallel/map-reduce/scatter-gather/review-fix-loop + 自定义脚本）、worktree 隔离 + patch 回传、schema 结构化输出（prompt 约定 + 容错提取，因 CLI 无 `--schema`）、agent .md 四根发现（复用 pi 生态，补引擎跳过 symlink 的缺口）、mailbox 完成通知（被动注入，降级 polling）。

**部分绕行**：模型路由（HOME 隔离注入 provider，当前单 provider）、GUI 可见性（无头 session 不进侧栏，sqlite 直写是候选路线）、防递归（嵌套 env 标记 + 嵌套环境 MCP 不注册工具）。

**无法补齐（宿主闭源，无扩展点）**：进程内事件监听/拦截（改 system prompt、block 工具、替换消息）、UI 扩展、动态 provider 注册、热重载。这些是平台能力，等官方开放。

## 6. 对本工作区结构的直接推论

1. 插件 = 声明式资源（skills/commands/hooks）+ MCP 外挂进程（`dist/mcp/server.js`）+ CLI 薄壳（`bin/`，调试与 MCP 等价入口）——zsub 形态即标准模板。
2. marketplace 副本机制 → 共享代码必须构建期 vendor 进各插件，禁止运行时 `require` 越过插件根。
3. 无头驱动无契约 → 每个 spawn 类插件内嵌冒烟探针，zcode 升级先探针后改码。
4. 插件资源优先级最低 → skill/command 命名带插件前缀（如 `zsub-orchestration`）。

## 附：本机权威源清单

| 主题 | 路径 |
|------|------|
| zcode 扩展资源权威文档 | `~/.zcode/cli/plugins/cache/zcode-plugins-official/zcode-guide/0.1.0/skills/`（zcode-configuration-guide + 5 份 diagnosing-*） |
| zcode 插件/市场注册表 | `~/.zcode/cli/config.json`（plugins 块）、`~/.zcode/cli/plugins/known_marketplaces.json`、`~/.zcode/cli/plugins/marketplaces/*/marketplace.json` |
| zcode 插件实例 | 本仓 `zsub/`、`feat-zcode-workflow-plugin` worktree 的 `dynamic-workflow/`（已归档）、`~/.zcode/cli/plugins/demo-plugin/`、官方 cache 下 8 插件 |
| pi extension 权威文档 | `~/GitApp/pi-ecosystem/pi-mono/packages/coding-agent/docs/extensions.md`（+ packages/skills/settings/rpc.md） |
| pi 源码 | 同上 `src/core/extensions/loader.ts`、`src/core/package-manager.ts`（PiManifest:158）、`src/core/extensions/types.ts`（ExtensionAPI） |
| xyz-agent 封装总结 | `~/Code/xyz-agent-workspace/main/docs/extensions/`（development-guide / extension-conventions / logging-conventions / glossary / local-dev-guide） |
