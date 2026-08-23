# zcode 插件开发指南

> 从零写一个 zcode 插件的完整路径。强约束（命名/manifest 纪律）见
> [extension-conventions.md](extension-conventions.md)；本机注册调试见
> [local-dev-guide.md](local-dev-guide.md)。能力边界的「为什么」见
> [../research/zcode-vs-pi-extension-capabilities.md](../research/zcode-vs-pi-extension-capabilities.md)。

## 插件解剖

zcode 插件 = **声明式内容 + 可选的 MCP 外挂进程**。官方文档只定义五类资源（skills / commands /
hooks / MCP servers / plugins manifest）+ AGENTS.md，**没有进程内 extension API**——程序化逻辑
全部落 MCP server（stdio 子进程）或 hooks（shell 命令）。

标准目录布局（zsub / dynamic-workflow 实证形态）：

```
<plugin>/
├── .zcode-plugin/plugin.json    # zcode manifest（必需；探测顺序 .zcode-plugin > .claude-plugin > .codex-plugin）
├── .claude-plugin/plugin.json   # Claude Code 兼容副本（可选，内容与上完全相同）
├── .mcp.json                    # MCP server 注册（官方推荐位置，替代 manifest 内嵌 mcpServers）
├── skills/<skill>/SKILL.md      # 技能（frontmatter: name + description 必需）
├── bin/<cli>.js                 # CLI 直跑入口（与 MCP tool 等价能力的调试通道）
├── lib/                         # 源码（plain Node CJS）
├── dist/mcp/server.js           # MCP server 打包入口（随 git 提交，安装零构建）
├── test/                        # node --test 测试
└── README.md                    # 架构、安装、验收手册
```

## manifest（`.zcode-plugin/plugin.json`）

| 字段 | 必需 | 说明 |
|------|------|------|
| `name` | 是 | `^[a-z0-9][a-z0-9._-]{0,127}$` |
| `version` | 否 | 缺省 `0.0.0`（建议显式写，git/目录源常缺顶层 version 导致检测不到更新） |
| `description` / `description_i18n` | 否 | i18n 支持 `en` / `zh-CN` |
| `commands` / `skills` / `hooks` / `mcpServers` | 否 | 组件目录声明（字符串或数组）；**路径禁止绝对路径或逃逸插件根**，否则判 invalid |
| `userConfig` | 否 | type ∈ string/number/boolean/directory/file；注意 `sensitive: true` 目前无安全存储，勿用于凭据 |
| `author` / `keywords` / `category` | 否 | marketplace 展示用 |
| `agents` / `channels` / `lspServers` / `outputStyles` / `settings` | — | **记录但不执行**（勿依赖） |

不写 `skills` 字段时约定目录 `skills/` 仍会被扫描（官方插件 browser-use 用显式声明，zsub 用约定
目录——两者都有效，显式声明更稳）。

## MCP server 开发

- 注册：根目录 `.mcp.json`（官方推荐），server 命名空间化为 `plugin:<plugin>:<server>`：

```json
{
  "mcpServers": {
    "zsub": {
      "type": "stdio",
      "command": "node",
      "args": ["${ZCODE_PLUGIN_ROOT}/dist/mcp/server.js"],
      "enabled": true,
      "timeoutMs": 60000
    }
  }
}
```

- `${ZCODE_PLUGIN_ROOT}` / `${ZCODE_PROJECT_DIR}` 模板变量**仅插件 MCP server 展开**。
- schema 严格：未知顶层键 → server 静默丢弃；`command` 必须字符串。
- **stdout 是 JSON-RPC 通道**：进度、日志一律 stderr（详见 [logging-conventions.md](logging-conventions.md)）。
- 设计模式（zsub 实证）：一个 server 暴露少量多 action 工具（`zsub` 七 action + `run_workflow`
  六 action），优于大量细粒度工具——主 agent 认知负担低，action 参数自带路由。
- **防递归**：插件若 spawn 无头 zcode 子进程，必须传嵌套标记 env（如 `ZSUB_NESTED=1`），且嵌套
  环境下 MCP server 的 `tools/list` 返回空——防止阶段 agent 再调编排工具。
- **HOME 隔离**：无头子进程固定读 `$HOME/.zcode/cli/config.json`；`HOME=<隔离目录>` 是注入插件
  自己 provider 配置的唯一干净手段，零污染用户配置。
- 运行时数据落 `~/.zcode/<plugin>/`（records/outputs/日志），不落插件目录（marketplace 副本在
  cache 内，不可写语义不明）。

## 声明式资源编写

- **skills**：`skills/<name>/SKILL.md`，frontmatter 必需 `name` + `description`（触发词放
  description 前 250 字符内）；调用名 `plugin:<plugin>:<skill>`。插件 skill 优先级最低（会被
  用户级/工作区级同名遮蔽），命名带插件前缀避让。
- **commands**：`commands/<name>.md`，文件名即命令名（`^[a-z0-9][a-z0-9_:-]{0,63}$`）；frontmatter
  键用连字符形式（`allowed-tools` 非 `allowed_tools`）；`description` 或非空 body 二者必有。
- **hooks**：`hooks/hooks.json`（插件形态外层包 `hooks`）；仅 7 事件；matcher 大小写敏感正则；
  输出走严格 JSON schema（多余键直接 failed）；脚本可用 `bash "${ZCODE_PLUGIN_ROOT}/hooks/x.sh"`
  绕开执行位问题。

## 测试

分三层（详见 [../standards.md](../standards.md)「测试规范」）：

```bash
node --test test/          # domain 单测 + MCP 协议测试
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | node dist/mcp/server.js    # MCP 冒烟（握手 + 工具列表）
node test/e2e.test.js      # 真机 e2e（token 消耗注意）
```

README 附真机 GUI 验收手册（场景/步骤/通过标准表格）。

## 新插件脚手架清单

1. 用户授权后开 worktree + 分支 `feat-zcode-<plugin>-<topic>`。
2. 建目录骨架（上文「插件解剖」），复制 zsub 的 `.zcode-plugin/plugin.json` / `.mcp.json` 作模板改字段。
3. 决定能力落点：纯内容（skills/commands）还是带 MCP server（写 `lib/` + `dist/mcp/server.js` + `bin/` CLI 薄壳）。
4. 按 [local-dev-guide.md](local-dev-guide.md) 注册到本机，重启验证。
5. 测试三层齐备 + README（架构图 / 安装 / 使用 / 已知边界 / 验收手册）。
6. 合入 main：`marketplace.json` 登记 + README 插件表更新 + `--no-ff` merge。

## 发布路径

当前形态：本地 marketplace（本仓根 `marketplace.json`，目录源）+ inline 注册开发。
远端分发（git / zip 源 marketplace）待实际需要再建设——marketplace 的 `source` 支持
`git-subdir` / `url`(zip) / 相对目录，**不支持 npm / pip**。
