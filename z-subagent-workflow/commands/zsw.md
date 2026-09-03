---
description: 用 zsw CLI 派发后台 subagent 或确定性多阶段 workflow（zsub/zflow 编排）。
argument-hint: "[任务描述，如：后台审查当前分支的变更]"
skills: zsub-zflow-orchestration
---

加载 `zsub-zflow-orchestration` skill，按其 CLI 纪律（`node bin/zsw.js`，2.x 纯本地一次性进程，执行引擎 = core zcode engine——app-server 常驻、共享宿主 HOME；长任务用 Bash `run_in_background` 包裹）处理这个请求：

$ARGUMENTS
