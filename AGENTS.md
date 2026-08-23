# zcode-plugin-workspace AGENTS.md

zcode 桌面端插件工作区（bare repo + worktree 模式）。**main 分支聚合所有插件，整体作为一个
marketplace 分发**（根目录 `marketplace.json` 是权威清单）；每个插件在独立 feature worktree
开发。能力边界与设计动机见 [docs/research/zcode-vs-pi-extension-capabilities.md](docs/research/zcode-vs-pi-extension-capabilities.md)。

## 目录结构

| 路径 | 职责 |
|------|------|
| `marketplace.json` | marketplace 清单，合入 main 时登记插件条目 |
| `<plugin>/` | 每插件一个顶层目录（kebab-case），含 `.zcode-plugin/plugin.json` + 根 `.mcp.json` + `skills/` + `bin/` + `lib/` + `dist/` + `test/` |
| `shared/` | 跨插件共享能力库源码（**构建期 vendor 进各插件 dist**，禁止运行时跨插件根引用，原因见架构边界） |
| `docs/standards.md` | 项目开发规范（技术栈/代码/测试/git） |
| `docs/extensions/` | 插件开发文档体系：development-guide（指南）· extension-conventions（强约束）· local-dev-guide（注册调试）· logging-conventions（日志）· glossary（术语） |
| `docs/research/` | 调研文档（zcode vs pi extension 能力对标） |

## 架构边界（改插件代码前必读）

1. **zcode 无进程内 extension API**（官方文档只定义 skills/commands/hooks/MCP/plugins 五类声明式
   资源 + AGENTS.md，无 JS 代码入口）。程序化能力只能走两条路：**MCP server 外挂进程**（stdio，
   根 `.mcp.json` 注册，`${ZCODE_PLUGIN_ROOT}` 定位自身）或 **hooks**（shell 命令，仅 7 个事件）。
2. **marketplace 安装 = 完整副本**进 `~/.zcode/cli/plugins/cache/`，inline 开发 = 直接从工作区路径
   加载。因此插件**运行时禁止引用插件根之外的任何路径**（manifest 组件路径逃逸插件根直接判 invalid；
   共享代码在构建期复制/内联进各插件）。CLI 直跑入口（`bin/`）与 skill 内脚本同理须自包含。
3. **引擎 agent .md 发现只认 `.zcode/agents` 双根（项目级 + 用户级 `~/.zcode/agents/`）且扫描跳过
   symlink**——软链形态一律不可见，只能放真实文件副本（z-subagent-workflow 的四根 resolver 即为补此缺口）。
4. **zcode CLI 无公开契约**：`--allowed-tools` 拒收（只有 denylist `--disallowed-tools`）；
   `--settings` / `--max-turns` 在 help 中存在但解析器拒收（help 漂移）。升级 zcode 后先跑冒烟
   探针再改代码（探针命令见 local-dev-guide）。
5. **GUI 只在启动时扫描插件配置**：改 `config.json` 或插件文件后必须重启 ZCode 才生效。

## 常用命令

```bash
# 插件目录内（cwd = <plugin>/）
node --test test/                                # 全量测试（node 内置 test runner，禁 node:test 之外框架引入需评估）
node bin/<cli>.js <cmd> --task "..." --workdir /tmp/xxx   # CLI 直跑（不经 MCP）

# MCP server 冒烟（握手 + 工具列表）
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | node dist/mcp/server.js

# 注册/验证（改 ~/.zcode/cli/config.json 后重启 ZCode）
zcode plugins list                               # 应见 <name>@inline [enabled]
```

真机 e2e（真实无头 zcode + 真实模型，注意 token 消耗）按各插件 `test/e2e.test.js` 与 README 验收手册执行。

## 开发红线

- **零依赖 plain Node CJS 优先**：z-subagent-workflow（前身 zsub / dynamic-workflow）无 package.json。引入依赖需评估对
  「inline 加载 + marketplace 副本 + 无构建链安装」三种形态的影响，见 docs/standards.md。
- 插件 manifest 必需字段仅 `name`（`^[a-z0-9][a-z0-9._-]{0,127}$`）；`agents` 字段当前「记录不执行」。
  字段规范见 development-guide。
- MCP server 的 **stdout 是 JSON-RPC 通道**：人读日志/进度一律走 stderr 并落盘
  `~/.zcode/<plugin>/`（规范见 logging-conventions.md）。
- 嵌套调用防护：被插件 spawn 的无头 zcode 子进程必须带嵌套标记 env（如 `ZSW_NESTED=1`，
  `DWF_NESTED=1`），嵌套环境下 MCP server 不注册工具，防递归编排。
- 同名遮蔽：插件 skills/commands 在发现顺序中优先级最低（用户级/工作区级同名资源会遮蔽插件资源），
  命名带插件前缀降低冲突面。

## Git 规范（bare repo worktree 模式）

- `origin` = 本地 `.bare`，工作区根不是 git repo；每 worktree 一分支，分支名 `feat-zcode-<插件>-<主题>`。
- **新分支/worktree 必须用户明确授权**（全局规则 17）；merge 用 `--no-ff` 保留分支历史。
- commit 英文 conventional 风格（scope 用插件缩写，如 `feat(zsw): ...`）；完成即提交，禁留脏工作区。
- 合入 main 时同步更新 `marketplace.json` 条目与 README「现有插件」表。

## 新插件脚手架

目录骨架、manifest 字段、注册流程、验收清单见 [docs/extensions/development-guide.md](docs/extensions/development-guide.md)
「新插件脚手架清单」一节；强约束（命名/版本/双 manifest/vendor 纪律）见
[docs/extensions/extension-conventions.md](docs/extensions/extension-conventions.md)。
