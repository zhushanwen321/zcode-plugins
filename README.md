# zcode-plugin-workspace

zcode 桌面端插件工作区：**一个 marketplace + 每插件一个顶层目录 + 统一文档 + 本地工具子项目**。

本仓是 bare repo + worktree 模式（git 对象在 `.bare/`，`origin` = GitHub `zhushanwen321/zcode-plugins`）：
每个插件在独立 feature worktree（`feat-zcode-<插件>-<主题>`）中开发，merge 回 main 后由根目录
`marketplace.json` 聚合分发。设计动机与能力边界见
[docs/research/zcode-vs-pi-extension-capabilities.md](docs/research/zcode-vs-pi-extension-capabilities.md)
（对 pi coding agent extension 能力的全面对标）。

## 目录结构

```
zcode-plugin-workspace/          # main 分支聚合形态
├── marketplace.json             # marketplace 清单（权威在 main；feature 分支上引用的目录可能尚未存在）
├── AGENTS.md                    # 工作区指令（agent 必读）
├── README.md                    # 本文件
├── <plugin>/                    # 每插件一个顶层目录（z- 前缀 kebab-case），如 z-subagent-workflow/
│   ├── .zcode-plugin/plugin.json    # zcode 插件 manifest（必需）
│   ├── .mcp.json                    # MCP server 注册（有 MCP server 的插件）
│   ├── package.json                 # npm 发布清单（name/version/files/bin，零依赖）
│   ├── skills/<skill>/SKILL.md      # 插件技能
│   ├── bin/                         # CLI 直跑入口
│   ├── lib/                         # 源码（plain Node CJS）
│   ├── dist/                        # 打包产物（MCP server 入口等，随 git 提交）
│   └── test/                        # node --test 测试
├── gen-metrics/                 # 本地扩展插件（不走 marketplace/npm，经 config.json plugins.dirs 加载）
├── patch-zcode-app/             # ZCode.app 本地补丁统一工具（patches/ + zsem/，见其 README）
├── scripts/                     # 发布链工具（check-sync / check-pack / check-release-needed / release / vendor）
├── docs/
│   ├── standards.md             # 项目开发规范（技术栈/代码/测试/git）
│   ├── adr/                     # 架构决策记录
│   ├── design/                  # 设计文档（zsw 系列 + zsub-legacy/ 归档）
│   ├── research/                # 调研文档
│   └── extensions/              # 插件开发文档体系
│       ├── development-guide.md       # 开发指南（manifest/MCP/skills/hooks/测试/发布）
│       ├── extension-conventions.md   # 强约束约定
│       ├── local-dev-guide.md         # 本地注册/调试/卸载全流程
│       ├── logging-conventions.md     # 日志规范（stdout/stderr 通道纪律）
│       └── glossary.md                # 术语表
└── .githooks/                   # git hooks 源（pre-commit 静态门禁）
```

## 现有插件

| 插件 | 能力 | 状态 |
|------|------|------|
| `z-subagent-workflow` | 无头 subagent 生命周期管理 + 确定性多阶段 workflow，统一走 `zsw` CLI（2.0 起纯本地一次性进程，无常驻 daemon；执行引擎 = core zcode engine 单一 app-server 常驻 + 共享宿主 HOME） | 活跃（吸收了已归档的 dynamic-workflow，见其 README 迁移节） |
| `z-tool-finder` | MCP 工具渐进式加载：per-server wrapper 中间人接管，工具清单常驻、详情与调用按需三跳代理，不改 server 源码一键还原 | 活跃（首发 0.0.1） |
| `z-words-reminder` | 周期性易读性提醒：UserPromptSubmit hook 按会话计数用户消息，每第 3 条注入一次「概念铺垫 + 编号带类型词 + 遵守用语词表」提醒，把沟通合规防线前移到生成前 | 活跃（首发 0.2.0） |
| `z-devflow-guard` | dev-flow 会话守卫：会话进入 dev-flow 执行态后拒绝主会话手工 Agent/Task 派发，强制走 CreateWorkflow，任务终局后自动放行 | 活跃（首发 0.1.0） |
| `z-quota-watch` | 额度守望兜底：PreToolUse hook 按会话计数门控，检测到 GLM 套餐模型无存活守望时注入命令让 agent 起后台 quota-wait | 活跃（首发 0.1.0） |
| `gen-metrics` | 本地扩展（扩展宿主 extension API）：在输入框状态插槽显示生成指标（tok/s、TTFT 等） | 活跃（本地加载，不在 marketplace） |

## 快速开始（本地开发）

1. 在插件 worktree 中开发（新 worktree/分支需用户授权，见 AGENTS.md）。
2. 切换到 dev 版（自动卸载同名正式版、防双装，改后**重启 ZCode**）：
   `bash .agents/skills/dev-link/link-dev.sh <plugin>`；切回正式版用
   `unlink-dev.sh`，状态与冲突检查用 `status.sh`（详见 `.agents/skills/dev-link/SKILL.md`）。
3. 验证：主会话问「列出可用 MCP 工具」；或 `zcode plugins list` 看 `<name>@inline [enabled]`。
4. 详细流程与排错：[docs/extensions/local-dev-guide.md](docs/extensions/local-dev-guide.md)。

## 新增插件

按 [docs/extensions/development-guide.md](docs/extensions/development-guide.md) 的「新插件脚手架清单」执行；
合入 main 时在 `marketplace.json` 的 `plugins[]` 登记条目并更新本 README「现有插件」表。
