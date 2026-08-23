# 术语表（glossary）

> 本仓文档与 zcode 生态高频术语。按主题分组；括号内为首次出现语境。

## zcode 资源与发现

- **五类扩展资源**：zcode 官方定义的 skills / slash commands / hooks / MCP servers / plugins
  （+ AGENTS.md 指令文件）。无进程内 extension API。
- **六层发现顺序**：显式配置 roots → 用户 `~/.zcode` → 用户 `~/.agents` → 工作区 `.zcode` →
  工作区 `.agents` → 插件 roots（最低）。同名 skill/command 首个被发现者胜出，其余被**遮蔽**
  （shadows）。
- **限定名**：插件 skill 暴露为 `plugin:<plugin>:<skill>`，插件 MCP server 为
  `plugin:<plugin>:<server>`（工具名 `mcp__<plugin>__<tool>`）。
- **AGENTS.md 指令文件**：用户级（`~/.zcode/AGENTS.md`）先注入、工作区级（`<repo>/AGENTS.md`）
  后注入，后者可收窄前者。

## 插件与分发

- **manifest**：`.zcode-plugin/plugin.json`（探测顺序 `.zcode-plugin` > `.claude-plugin` >
  `.codex-plugin`）。必需字段仅 `name`；`agents` 等字段「记录但不执行」。
- **inline 插件**：经 config.json `plugins.dirs` 注册的本地插件，身份 `<name>@inline`，从工作区
  原位加载（不复制）。
- **marketplace**：插件分发层。注册表 `~/.zcode/cli/plugins/known_marketplaces.json`；清单文件
  `marketplace.json`（`{name, plugins[]}`，source 支持 zip/git/git-subdir/目录/filesystem，
  **不支持 npm/pip**）。
- **安装副本**：marketplace 插件完整复制到 `~/.zcode/cli/plugins/cache/<marketplace>/<plugin>/<version>/`
  （多版本并存；带 `.zcode-plugin-seed.json` 完整性标记）。**插件根路径逃逸会被拒**——共享代码
  必须 vendor。
- **双 manifest**：`.zcode-plugin/plugin.json` + 同内容 `.claude-plugin/plugin.json`（Claude Code
  兼容探测位）。

## 运行形态

- **无头（headless）**：`zcode --json --prompt` 形态驱动的无 UI 子进程；**无公开契约**，help 会
  漂移，须冒烟探针防波。
- **HOME 隔离**：无头子进程固定读 `$HOME/.zcode/cli/config.json`，故把 `HOME` 指向隔离目录以
  注入插件自己的 provider 配置（零污染用户配置）。
- **嵌套标记**：spawn 链路传 `ZSUB_NESTED` / `DWF_NESTED` 类 env，嵌套环境下 MCP server 不注册
  工具，防递归编排。
- **mailbox（完成通知）**：外部进程向引擎会话 mailbox 投递消息，主 agent 下次活动时
  （UserPromptSubmit/PostToolUse/Stop）被动注入——idle 期间滞留，是外挂形态的物理上限。
- **四根发现**（agent .md）：`<cwd>/.agents/agents/` > `<cwd>/.zcode/agents/` >
  `~/.agents/agents/` > `~/.zcode/agents/`（zsub 自建 resolver；引擎原生只认 `.zcode/agents`
  双根且跳过 symlink）。
- **worktree 隔离**：subagent 改动落独立 git worktree，完成后回传 patch + `git apply` 指引，
  主树保持干净。

## pi 侧（对标语境）

- **ExtensionAPI**：pi 进程内扩展入口，`export default (pi) => {}` 工厂 + 事件钩子 + `register*`
  API + `ctx.ui`。zcode 无对应物。
- **`pi.extensions/skills/prompts/themes`**：pi manifest 唯一四个资源字段（`readPiManifest` 只认
  这四个）。**`pi.agents` / `pi.workflows` 是 xyz-agent 封装的私有字段**，pi 宿主不解析。
- **RPC 模式**：`pi --mode rpc`，stdin/stdout JSONL 协议；zcode 对应物是无头 `--json`（无契约）。
- **project trust**：pi 的项目资源门控（`~/.pi/agent/trust.json`）；zcode 无对应门控。

## 本仓流程

- **bare repo + worktree**：`origin` = 本地 `.bare`，每插件一 feature worktree
  （`feat-zcode-<插件>-<主题>`），main 聚合。
- **vendor**：共享代码构建期复制/内联进各插件 dist（运行时禁跨插件根引用）。
- **验收手册**：插件 README 的真机 GUI 场景验收表（场景/步骤/通过标准；zsub M1-M5 样式）。
