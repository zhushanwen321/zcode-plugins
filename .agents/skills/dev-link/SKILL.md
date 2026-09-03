---
name: dev-link
description: >-
  Use when 在本仓库（zcode-plugin-workspace）插件的 worktree dev 版（inline）与
  已发布正式版（marketplace 安装）之间切换，或检查插件安装状态冲突。
  触发词："dev link"、"dev-link"、"装 dev 版"、"切到本地"、"link 插件"、
  "unlink 插件"、"恢复正式版"、"卸载 dev 版"、"插件双装"、"dev prod 冲突"。
  不用于 npm 发版（scripts/release.js）、marketplace 登记、pi extension link
  （xyz-agent 项目另有同名 skill）、GUI 插件管理教学。
---

# dev-link — 插件 dev 版 / 正式版一键切换

管理本仓库插件在本机 zcode 的两种安装形态间切换，脚本自带防重复与冲突检查：

| 命令 | 作用 |
|------|------|
| `bash .agents/skills/dev-link/link-dev.sh <plugin> [<plugin>...]` | 装 dev 版（inline 注册）+ **先卸载同名正式版**（防双装） |
| `bash .agents/skills/dev-link/unlink-dev.sh <plugin> [<plugin>...]` | 移除 inline 注册 + **恢复正式版**（未发布则跳过安装） |
| `bash .agents/skills/dev-link/status.sh` | 状态总览 + 冲突检测（只读，不联网） |

包名支持 `z-subagent-workflow` / `@zhushanwen/z-subagent-workflow`；多插件空格并列。
插件映射 SSOT = 各插件 `.zcode-plugin/plugin.json` 的 `name`（扫描 worktree 顶层动态构建，新插件零改动自动进映射）。**改配置后需重启 ZCode**（GUI 仅启动时扫描插件配置）。

## 机制（数据面，实测 zcode 0.16.5）

| 数据面 | 位置 | 操作 |
|--------|------|------|
| inline dev 版 | `~/.zcode/cli/config.json` → `plugins.dirs[]` + `plugins.enabledPlugins["<name>@inline"]` | 脚本原子改写（备份 + tmp/rename） |
| 正式版安装记录 | `~/.zcode/cli/plugins/installed_plugins.json`（id = `<name>@zcode-plugin-workspace`） | 卸载走官方 CLI；安装模拟（CLI 无 install 子命令） |
| 正式版文件 | `~/.zcode/cli/plugins/cache/zcode-plugin-workspace/<name>/<version>/` | 从 marketplace clone 按插件 package.json `files` 白名单复制（npm 发布面语义） |
| marketplace 源 | `~/.zcode/cli/plugins/marketplaces/zcode-plugin-workspace/`（gitee main 分支 clone） | unlink 时 git fetch 更新；`marketplace.json` 在列 = 已发布 |
| zcode CLI | app 内 `zcode.cjs`（自动探测，PATH 优先） | `plugins list`（验证闭环）/ `plugins uninstall --force`（卸载优先通道） |

unlink 恢复正式版 = 模拟 GUI 安装：更新 clone → marketplace.json 在列判定 → files 白名单复制进 cache → 写 installed 条目 → `plugins list` 验证，**失败自动回滚**并提示 GUI Discover 手动安装兜底。

## 冲突检查（防重复核心）

| 场景 | 行为 |
|------|------|
| link 时已 inline 注册同目录 | 幂等跳过（补设 enabledPlugins，修半注册态） |
| link 时已 inline 注册**其他目录**（跨 worktree） | 拒绝并指引先 unlink（防互相遮蔽） |
| link 时正式版在装（含孤儿条目） | 自动卸载正式版再注册（消解双装；幂等重跑同样消解） |
| unlink 时正式版已装且 cache 完整 | 幂等跳过安装 |
| unlink 时插件未发布 | 跳过安装（黄色提示） |
| config dirs 悬空（worktree 已删） | status 标红；unlink 可清（basename 匹配兜底） |
| installed 孤儿条目（cache 缺失） | status 标红；link 清条目、unlink 走重装修复 |

## 约束

- **删 worktree / 合并回 main 前先 unlink**：inline 指向 worktree 路径，worktree 删了 zcode 加载报错。merge skill 阶段 6a 已自动执行此步骤（status.sh 检测 + unlink-dev.sh 恢复正式版）。
- 恢复正式版需联网更新 marketplace clone（gitee 直连）；失败降级用本地现状（版本可能落后）。
- 所有 JSON 改写前自动备份（`config.json.bak-dev-link-<ts>` / `installed_plugins.json.bak-dev-link-<ts>`），反复运行会累积备份文件，可定期清理。
- 脚本兼容 macOS 自带 bash 3.2。已知坑：`$var` 后紧跟全角字符会被 bash 3.2 吃进变量名（unbound variable），改脚本时用 `${var}` 形式。

## 常见错误

| 症状 | 原因与处理 |
|------|-----------|
| link/unlink 后 zcode 行为没变 | 未重启 ZCode（仅启动时扫描）；或当前 session 已加载旧版 |
| plugins list 未见恢复的正式版 | unlink 已自动回滚，按提示走 GUI Discover 手动安装兜底 |
| unlink 报「未发布」 | marketplace.json（main 分支）不含该插件——先合并发版再恢复，或维持 dev 形态 |
| link 报「跨 worktree 冲突」 | 同名插件 inline 已注册到别的 worktree，先 `unlink-dev.sh <plugin>` 再回来 link |
| 手工排障总入口 | `docs/extensions/local-dev-guide.md` + 官方 zcode-guide `diagnosing-plugins` skill |
