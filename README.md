# zcode-plugin-workspace

zcode 桌面端插件工作区：**一个 marketplace + 每目录一个插件 + 共享能力库 + 统一文档**。

本仓是 bare repo + worktree 模式（`origin` = 本地 `.bare`）：每个插件在独立 feature worktree
（`feat-zcode-<插件>-<主题>`）中开发，merge 回 main 后由根目录 `marketplace.json` 聚合分发。
设计动机与能力边界见 [docs/research/zcode-vs-pi-extension-capabilities.md](docs/research/zcode-vs-pi-extension-capabilities.md)
（对 pi coding agent extension 能力的全面对标）。

## 目录结构

```
zcode-plugin-workspace/          # main 分支聚合形态
├── marketplace.json             # marketplace 清单（权威在 main；feature 分支上引用的目录可能尚未存在）
├── AGENTS.md                    # 工作区指令（agent 必读）
├── README.md                    # 本文件
├── docs/
│   ├── standards.md             # 项目开发规范（技术栈/代码/测试/git）
│   ├── research/                # 调研文档
│   │   └── zcode-vs-pi-extension-capabilities.md
│   └── extensions/              # 插件开发文档体系（对标 xyz-agent docs/extensions/）
│       ├── development-guide.md       # 开发指南（manifest/MCP/skills/hooks/测试/发布）
│       ├── extension-conventions.md   # 强约束约定
│       ├── local-dev-guide.md         # 本地注册/调试/卸载全流程
│       ├── logging-conventions.md     # 日志规范（stdout/stderr 通道纪律）
│       └── glossary.md                # 术语表
├── shared/                      # 共享能力库（跨插件复用源码，构建期 vendor 进各插件）
└── <plugin>/                    # 每插件一个顶层目录（kebab-case），如 zsub/
    ├── .zcode-plugin/plugin.json    # zcode 插件 manifest（必需）
    ├── .claude-plugin/plugin.json   # Claude Code 兼容副本（可选，与上同内容）
    ├── .mcp.json                    # MCP server 注册（官方推荐位置）
    ├── skills/<skill>/SKILL.md      # 插件技能
    ├── bin/                         # CLI 直跑入口（调试用）
    ├── lib/                         # 源码（plain Node CJS）
    ├── dist/                        # 打包产物（MCP server 入口等，随 git 提交）
    └── test/                        # node --test 测试
```

## 现有插件

| 插件 | 能力 | 状态 |
|------|------|------|
| `zsub` | 无头 subagent 生命周期管理 + 确定性多阶段 workflow（MCP 双工具 `zsub` / `run_workflow`） | 活跃（吸收了已归档的 dynamic-workflow，见其 README 迁移节） |

## 快速开始（本地开发）

1. 在插件 worktree 中开发（新 worktree/分支需用户授权，见 AGENTS.md）。
2. 切换到 dev 版（自动卸载同名正式版、防双装，改后**重启 ZCode**）：
   `bash .agents/skills/dev-link/link-dev.sh <plugin>`；切回正式版用
   `unlink-dev.sh`，状态与冲突检查用 `status.sh`（详见 `.agents/skills/dev-link/SKILL.md`）。
3. 验证：主会话问「列出可用 MCP 工具」；或 `zcode plugins list` 看 `<name>@inline [enabled]`。
4. 详细流程与排错：[docs/extensions/local-dev-guide.md](docs/extensions/local-dev-guide.md)。

## 新增插件

按 [docs/extensions/development-guide.md](docs/extensions/development-guide.md) 的「新插件脚手架清单」执行；
合入 main 时在 `marketplace.json` 的 `plugins[]` 登记条目。
