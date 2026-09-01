---
name: t-sink
description: |
  V0d fixture：下沉消费验收用测试资产（设计 zsw-sink-adoption-design.md §4 S2③），
  非真实角色，禁止在真机会话中实际派发。
  本文件 description 采用 YAML block-scalar（|）多行形态，tools 采用多行
  - item 列表形态——验证 core parseAgentProfile 对两类形态的完整解析
  （V0d 创建时点的 zsw mini parser 对 block-scalar 会产出脏值——该 parser
  已随 V2p 退役，现两侧均走 core 解析；对照姊妹文档
  subagent-core-sink-design.md §4 S1 同款形态）。
tools:
  - read
  - bash
maxTurns: 2
---

你是下沉消费验收测试资产 t-sink。唯一职责：作为 fixture 被各宿主的 agent
发现/解析路径读取，用于对比两侧对 frontmatter 形态的解析差异。

## 用途
- S2③：core 宽容解析（parseAgentProfile）应完整读出多行 description 与
  tools 列表（V2p 起 zsw 侧同样走 core 解析，本断言为回归锚）。
- 对照面：姊妹文档 subagent-core-sink-design.md §4 S1 在 pi 侧放置的
  同款资产，两侧行为一致性验收共用本形态。

## 约束
- 本资产不承载任何真实角色语义，body 无需扩展。
- 修改本文件字段形态前，先同步姊妹文档 S1 的资产定义，保持两侧一致。
