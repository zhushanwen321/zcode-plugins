# ADR-0001：放弃 z-smart-context 插件，收口为调研沉淀

- 状态：已接受（2026-08-27）
- 决策人：仓库所有者
- 关联调研：[docs/research/zcode-compact-trigger-research.md](../research/zcode-compact-trigger-research.md)

## 背景与上下文

z-smart-context（原名 z-auto-compact）目标是对齐 pi smart-context：上下文用量 3 档提醒（UserPromptSubmit hook + additionalContext 注入）、用量自查 CLI、agent 自决策触发压缩。已完成并验证：

- **v1**：hook 提醒 + 回落自愈 + `zsc usage` 自查（M0 探针 13 条定案后落地，含「Stop 注入不进请求 → 检测点翻 UPS」「`computed_total_tokens` 为轮内累计口径 → 数据源换 `model_usage` 末行」等探针驱动的修正）。
- **v2.1**：agent 自决策压缩——GUI 会话粘贴交接（agent 组织 retention → 用户 Cmd+V 执行）、非活跃会话 `zsc compact` 外部执行器（app-server 协议链端到端实证：52s 真实压缩 + noop + 防呆拒绝）、无头场景 config 预写（`modelCatalog.overrides` 驱动内建 autoCompact）。105 单测全绿。

## 决策

**停止开发并移除全部插件代码**，仅保留调研文档与本文。不发布 npm、不登记 marketplace。

## 不做的原因

1. **核心价值主张被平台能力封顶，低于预期**。插件的存在理由是「agent 在压缩边界自主决策并触发压缩、纯后台完成」——探针穷尽（调研 §4 矩阵）证明 **GUI 活跃会话不存在任何纯后台触发通道**：会话活动性是持有引擎进程的内存态，外部实例 `-32004` 挡死全部协议方法；runtime 窗口字段被 strict schema 拒收；热改 config 不重读；外部 resume 压缩对持有者无感知（双持分裂）。可达上限只剩两条：CUA 操纵输入框（占用/扰动前台 GUI，且实测非前台 AX 全 mismatched——产品否决）与「agent 组织指令 + 用户手动粘贴」（v2.1 形态）。后者保留了 retention 组织增益，但「仍需用户手动执行」使产品价值退化为一条更好的提醒，撑不起一个常驻插件。
2. **生态方向转移**。同期 main 合入的 z-tool-finder（MCP 工具渐进式加载，per-server wrapper 中间人）覆盖了同源的「上下文预算优化」诉求，且其形态（wrapper 接管 + 清单注入 + 按需三跳）是平台现状下可长期演进的路线；压缩触发类能力依赖平台开口，继续投入边际价值低。
3. **等待官方通道是更合理的路径**。调研 §7 列出四个官方开口点（跨实例 compact 授权 / mailbox 命令白名单 / hook compact 触发键 / runtimeModel 窗口字段），任一落地后协议链与判据可从调研文档直接重启。

## 保留物

- `docs/research/zcode-compact-trigger-research.md`：三轮探针（M0 / v2 / bg-compact，P1-P21 + BP-1..BP-9）全部结论——压缩机制事实、注入通道语义、数据源口径、触发通道死活矩阵、非活跃会话压缩协议链（含凭据三坑）。
- 本 ADR。

## 后果与清理

- 删除 `z-smart-context/` 目录与 `marketplace.json` 条目；曾 dev-link 安装的本机环境需在 `~/.zcode/cli/config.json` 的 `plugins.dirs` 移除该路径并重启 ZCode（`unlink-dev.sh` 或手工）。
- 未发布过 npm 包，无下游影响。
- 若未来重启：v2.1 的粘贴交接与外部执行器设计（`.tmp` 探针报告随工作区保留，不入库）可按调研文档 §5 协议链重写；重开分支需用户授权（仓规）。
