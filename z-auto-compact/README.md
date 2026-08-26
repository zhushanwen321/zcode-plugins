# z-auto-compact

把 zcode 内建 auto-compact 的上下文用量变得可见：UserPromptSubmit hook 读引擎私有 sqlite（只读）拿上一轮用量，越 3 档软阈值时经 `additionalContext` 注入分档提醒；用量显著回落判定压缩已发生，注入知情通知并重置档位；`bin/zac.js` 提供 agent 用量自查 CLI；skill 教 agent 收到提醒后给出可执行的 `/compact <保留建议>`。

## 架构要点

- **检测点**：仅 `UserPromptSubmit` 单事件（`hooks/hooks.json`，条目级 `timeoutMs:3000` + 脚本内 2500ms watchdog 双保险）——Stop 事件的 additionalContext 实测不进模型请求。
- **数据源**：`~/.zcode/cli/db/db.sqlite` 的 `model_usage` 末行 `input_tokens + cache_read_input_tokens`（readonly 打开；`status='completed'` 过滤是硬要求）。绝不写入引擎库。
- **状态**：插件自有 `~/.zcode/z-auto-compact/state/<sessionId>.json`（fired 去重、回落自愈、7 天孤儿清理），与引擎零共享。
- **判档/回落/求交为纯函数**（`lib/state.js`），sqlite 与文件 IO 只做薄壳；配置面 mtime+size 缓存热加载（`lib/config.js`）。
- 零 npm 依赖，plain Node CJS；`node:sqlite` 为内置模块，要求 node >=22.5.0。

## 验收手册

真实场景验收见 `.tmp/auto-compact-design.md` §4（V1-V6 六场景）；本 README 为 Wave 1 占位，后续 wave 充实安装、配置与使用说明。
