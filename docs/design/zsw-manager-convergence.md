# zsw manager 收敛与 record 状态机统一（立案占位）

> 状态：**占位立案，未启动设计**。本文档是 `zsw-sink-adoption-design.md` 裁决 E4 的另立项锚点，防止裁决结论失联；启动时机见「触发条件」。

## 立案来源

- 来源裁决：[zsw-sink-adoption-design.md](zsw-sink-adoption-design.md) **D-E4**（record-store 暂不下沉、构造路径参数化）——「归属问题与 zsw manager 收敛（动作层消费 core 后）同窗另立项」。
- 依赖前提：subagent-core sink 批次动作层下沉（姊妹文档 `subagent-core-sink-design.md` D6/U10）落地、本插件 V3w/V4o（workflow/编排消费单元）完成——即本插件动作层实际消费 core 执行面之后。
- 关联登记：姊妹文档 D1 第二步依赖显式登记；本插件 impl-plan（`zsw-sink-adoption-design.impl-plan.md`）单元 V0c 即本锚点。

## 届时要裁决的问题（种子清单，非结论）

1. zsw record 四态模型（含 rounds 计数、notify 句柄语义）与 core running/closed 模型的归一方案。
2. RecordStore（文件 JSON 台账）与 core FileRunStore（run-snapshot codec）合并或桥接形态。
3. manager 壳在动作层内核（subagent-actions-core）消费后的剩余职责面与是否退役。
4. workflow-state 目录（C13 prune 接线后）与 record 台账两套持久化是否收敛为单一状态源。

## 触发条件

V8n（`--npm` 终态刷新）committed 后、V9s 发版窗口内或紧后——以「本插件动作层已在 vendored 0.4.0 面上运行」为前提。届时走 tech-design 全流程（含对抗式审查），本文档升级为正式设计或并入更大的收敛设计。
