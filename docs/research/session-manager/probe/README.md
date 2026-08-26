# session-manager 探针脚本（2026-08-26 实机验证用）

零依赖 Node 脚本，验证「外部进程操作 zcode 会话」全链路。运行顺序：
`step-list.js` → `step-create.js` → `step-rename.js "<新标题>"` → `step-state.js archive|unarchive|delete`。

注意事项：
- step-create 会真实调用一次 GLM 模型（探针提示词约 4 output tokens）
- 凭据从 `~/.zcode/v2/config.json` 读取，经 ANTHROPIC_API_KEY env 注入引擎；不落日志
- 写 tasks-index 前请自行备份（调研当日备份：`~/.zcode/v2/tasks-index.sqlite.bak-szm-probe-20260826-130649-consistent`）
- SZM_WORKSPACE 环境变量可覆盖目标工作区路径
- 详细结论见上层目录主文档 §5
