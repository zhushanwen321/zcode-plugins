---
name: zsc-cua-compact
description: 收到 zsc_compact MCP 工具返回后执行 GUI 压缩编排的操作手册：返回 mode=gui-active（或 unknown 时自选 GUI 路径）时，用 computer-use 定位 ZCode 聊天输入框，注入 /compact 保留指令与压缩后继续消息，结束回复等待压缩 turn，再按 verifyHint 核验。仅限主 agent。触发词：zsc_compact 返回、GUI 编排执行、computer-use 注入 /compact、自动压缩、压缩 turn、gui-active、plan、CUA_PERMISSION_REQUIRED、fallback、verifyHint、输入框注入、上下文压缩。
---

# zsc-cua-compact — 经 computer-use 执行 zsc_compact 的 GUI 压缩编排

**Main-agent-only**：本 skill 依赖 `mcp__computer-use__*` 工具面，该工具面只在主 agent 会话存在；subagent 没有 GUI 工具面，不可加载或代为执行本文任一步骤。

本 skill 是操作手册，不替代 `mcp__zsc__zsc_compact` 的决策：何时压、保留什么都以其返回的 `plan` 字段为准，你只负责忠实执行。

## 1. 何时进入

满足其一即进入：

- 调用 `mcp__zsc__zsc_compact` 后返回 `"mode": "gui-active"`：当前 GUI 会话可实时压缩，`plan` 为三步编排，直接按第 3 节执行。
- 返回 `"mode": "unknown"`（形态判定不了）且你能确认自己运行在 ZCode 桌面 GUI 会话（工具面具备 computer-use 能力）：此时 `plan` 是「路径 A（GUI）/ 路径 B（无头）」双路径说明，你选定 GUI 路径后，取路径 A 内的具体步骤同样按第 3 节执行。

返回 `"mode": "headless-active"` 时与本 skill 无关：当前是无头/subagent 会话，按返回的 `guidance` 处理，禁止尝试 GUI 注入。

## 2. 前置校验

1. computer-use 就绪状态未知时，可先调 `mcp__computer-use__request_access` 一次（仅一次，不做循环探测）。
2. 任一 computer-use 调用报 `CUA_PERMISSION_REQUIRED`，或 readiness 结果明确显示 Accessibility / Screen Recording 为 denied：立即停止 GUI 路径，把返回值 `fallback` 字段文本原样转告用户（其中含可整段复制的手动压缩指令，以及 TCC 一次性授权路径：系统设置 → 隐私与安全性 → 辅助功能，为 ZCode 宿主授权），随后结束本轮等待用户。禁止反复重试 computer-use，禁止在未发生任何压缩的情况下宣称「已压缩」。授权完成后，后续会话重走正常流程即可。

## 3. 编排序列

每步注入文本**逐字取自 plan 字段原文**（含署名行与指令行，保留换行）；你与本 skill 都不拼装、不改写、不截断 retention。retention 超过软上限（2000 字符）时 plan 已自带「前置建议」条目，照办即可。

1. **定位**：`mcp__computer-use__get_app_state` 观察 ZCode，从辅助功能树中找到聊天输入框 element，记下 state_id 与 index（element target，不用屏幕坐标）。
2. **注入第一条**：`mcp__computer-use__type` 以上述 element 为 target，输入 plan 第 1 条给出的整段消息——首行为署名「（由 agent 经 zsc 自动压缩流程注入）」（plan 要求勿删，用于 transcript 溯源），第二行为 `/compact 保留：<retention 原文>`；retention 缺省时即为裸 `/compact`，照抄。
3. **回车**：`mcp__computer-use__key` 发送 return，发出该消息。
4. **注入第二条**（仅当 plan 含第 2 条，即你传入过 nextInstruction）：紧接前两步同法注入 `<nextInstruction 原文>` 并 return，两条消息靠 GUI 忙时排队保持先后顺序。
5. **收尾**：按 plan 第 3 条结束当前回复（压缩 turn 只在 agent turn 结束后由引擎排队执行）；此后不再发送任何消息，等待压缩发生。

## 4. 输入框定位失败

按序降级，每级至多一次；对可能已送达的动作不做盲重放（computer-use 安全规则）：

- element 找不到或 type 失败：重新 `mcp__computer-use__get_app_state` 取新鲜界面状态，从新状态选新 target 再试一次。
- 仍失败：`mcp__computer-use__screenshot` 截图一次，从最新返回图像取坐标按 coordinate target 操作。
- 再失败：转入 `fallback` 半自动流程（转告方式同第 2 节第 2 条），如实告知用户自动注入未成功。

## 5. 压缩后任务未自动继续（顺序异常兜底）

第二条消息能否排在压缩 turn 之前依 GUI 忙时排队顺序执行，此点属实施期假设（设计门 P-G1，未真机验证）。若压缩 turn 已结束但剩余任务没有自动开始：不要空等，也不要让用户补发任务描述——在你下一次被唤起时（收到 z-smart-context 用量回落知情通知，或用户的任意新消息）先按第 6 节核验压缩已生效，然后基于压缩摘要继续执行剩余任务；任务要点本就写在 retention 里随摘要保留。全程用户无需干预。

## 6. 事后核验

执行返回值 `verifyHint` 字段给出的命令（形如 `node <插件根>/bin/zsc.js usage --session <sessionId>`，会话 id 即返回值的 `sessionId` 字段）：输出 `contextTokens` 相比压缩前显著回落即压缩生效。无回落则压缩未发生，向用户说明现状并改走 `fallback` 手动路径。
