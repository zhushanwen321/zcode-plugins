# zsw review-fix-loop v2 实施计划

基线: 本 commit | 来源设计: docs/design/zsw-review-fix-loop-v2-design.md（定稿 47719dc，must-fix 清零） | 日期: 2026-08-29

> 用户授权记录：用户显式指示「完成审查和修复问题后，直接进入开发，不用我来确认」——本计划跳过 plan.md 的用户评审门，直接基线开工。DAG/单元切分源自设计 §5 并经对抗式审查确认。

## 0 章节映射

| 内容 | 设计文档实际位置 |
|------|-----------------|
| 背景/目标 | §1 背景目标（SCQA、目标表 G1-G7、In/Out of scope） |
| 终态/机制 | §2.3 物理数据流；§3.1 终态（CLI 样例+失败路径表）；§3.2 方案对比；§3.3 决策 D1-D10；§3.4 接口与数据模型（CLI 参数面/reviewer/聚合/fixer 契约/state 字段/terminated 权威源/abort 检查点/ID 对齐/escalate 映射/aggregator-failure 触发） |
| 验收场景表 | §4（S1-S8 场景表 + §4.1 v1→v2 行为差异清单） |
| 下一层拆分 | §5（U1-U4 单元表 + 待验证检查点 3 条 + 发版 minor） |
| 待验证检查点 | §5「待验证检查点」（reconciliation 遵循率/聚合提取率/commands 字段双形态） |

所有 subagent task 的坐标从本表取，禁止自猜编号。

## 1 目标快照（摘录自设计 §1，逐字）

设计目标（使用者体验倒推）：

| # | 目标 | 使用者体验 |
|---|------|-----------|
| G1 | 审查噪声被裁决消化 | 臆测/无证据条目在聚合时降级，不进修复队列，不浪费 fix 轮次 |
| G2 | 修复效果可对账 | R2 起每条上轮 issue 有 fixed/not-fixed/regressed 判定，复发即升级处理 |
| G3 | 前置依赖可表达 | 静态检查等前置批次先跑完，后续审查批才有意义 |
| G4 | 过程可观测 | run 目录有 state.json + 各轮报告，结束后可回答「每轮发生了什么、为什么终止」 |
| G5 | 参数面与 pi 一致 | pi 用户零学习成本（stuckThreshold/converge*/maxFixAttempts 等同名同默认值） |
| G6 | 老调用参数兼容 | 老命令行（--reviewers/--review-target）仍被接受、正常完成出报告；语义差异有清单可查（见 §4.1） |
| G7 | 入口可发现 | GUI 里 /zsw 命令引导到编排 skill |

Out of scope（不做）：fixAgent 与 agentRef systemPrompt 注入（待无头 CLI 参数探针）；thinkingLevel/usage 透传；内置 agent 角色集；workflow 脚本 parallel/pipeline 原语；scores 打分 rubric；GUI 面板类。

## 2 单元列表

| Unit | 职责 | 领地（精确文件路径，均在 z-subagent-workflow/ 下） | 依赖 | 隔离 | 验收条款 |
|------|------|------|------|------|----------|
| u-foundation | vendor 14 个纯函数（从 pi 仓 review-fix-loop-utils.cjs 复制适配：剥离宿主耦合、'use strict'、CJS 导出）+ 契约常量（severity 集合/状态枚举/终态枚举）+ 单测 | `lib/workflow/review-fix-loop-utils.js`（新）、`test/review-fix-loop-utils.test.js`（新） | 无 | plain | node --test test/review-fix-loop-utils.test.js 全绿；14 函数导出齐；零 require 外部依赖（node 内置除外） |
| U1 参数与批次骨架 | CLI 参数面全集+白名单校验+batchN/reviewers sugar+targetType/target+base 锁定+批次外环+跨批 skip+runId 注入（manager _invokeEntry + _finalize runDir） | `lib/workflow/review-fix-loop.js`、`lib/workflow-manager.js`、`bin/zsw.js`、`dist/mcp/server.js`、`test/workflow-b.test.js` | u-foundation | plain | 设计 §4 S1/S4/S7 对应单测断言（批次时序用 state rounds 时间戳、跨批 skip 用 agents[] 记录、老参数 sugar 映射）；workflow-b 全绿 |
| U2 聚合 phase 与输出契约 | reviewer 契约扩展（suggestion_count/reconciliation）+parseFail/runFail 语义（D3）+LLM 聚合 phase+JS 降级链（D1 fallback 规格）+ID 对齐双路径同规+wrapUntrusted 全通道防注入（D10） | `lib/workflow/review-fix-loop.js`、`test/workflow-b.test.js`（可新增用例文件） | U1 | plain | 设计 §4 S2/S3/S8 对应单测断言（降级条目不进 fix 队列、对账转换链、fallback 轮 degraded 标记+ID 沿用）；workflow-b 全绿 |
| U3 对账/收敛状态机 + state 落盘 | 状态机接线（reconcile/convergence/needsRedesign/dormant/knownRemaining）+fixer 契约硬校验+state.json 原子写+修复范围全等级+fallowScan/autoCommit+escalate 映射 | `lib/workflow/review-fix-loop.js`、`lib/workflow/review-fix-loop-utils.js`（如需适配层）、`test/workflow-b.test.js` | U2 | plain | 设计 §4 S3/S5 对应单测断言（fixed/regressed 转换、state 落盘可读、terminated 权威源）；workflow-b 全绿 |
| U4 /zsw command + 文档 | commands/zsw.md + plugin.json commands 字段 + README/SKILL.md 参数表 + §4.1 差异清单入 README | `commands/zsw.md`（新）、`.zcode-plugin/plugin.json`、`README.md`、`skills/zsub-zflow-orchestration/SKILL.md` | U1-U3 | plain | 设计 §4 S6（本地校验：manifest 字段/文件存在/格式对齐官方示例；GUI 冒烟留验收阶段）；check-sync/check-pack 绿 |

## 3 DAG

```mermaid
graph LR
  F[u-foundation] --> U1[U1 参数与批次骨架]
  U1 --> U2[U2 聚合与契约]
  U2 --> U3[U3 状态机与 state]
  U3 --> U4[U4 command 与文档]
```

全串行理由：U1-U3 领地重叠（review-fix-loop.js 与 workflow-b.test.js），并行必冲突；U4 依赖参数面定稿。

## 4 测试策略

- 增量（单元开发期）：`cd z-subagent-workflow && node --test test/review-fix-loop-utils.test.js test/workflow-b.test.js`；涉及 manager/CLI/server 改动时加跑 `test/workflow-manager.test.js test/cli.test.js test/server.test.js`
- 全量（收尾阶段 5）：`cd z-subagent-workflow && node --test test/`（含真机 e2e，约 3.5 分钟；e2e 真机门按 README 验收手册执行）
- workspace 门禁：`node scripts/check-sync.js && node scripts/check-pack.js`（U4 后与收尾各跑一次）

## 5 合理偏差登记表

| Unit | 偏差 | 理由 | 登记时间 |
|------|------|------|----------|
| u-foundation | 额外导出 SEVERITIES/MUST_FIX_SEVERITIES 常量 | U2 聚合判定与 D6 全等级修复的直接消费面，属 §3.4 契约枚举常量化 | 2026-08-29 |
| u-foundation | 依赖闭包 vendor 5 个辅助（parseResult/normIssueId/DORMANT_ADJUDICATIONS/toIdSet/dormantDetail，前两个导出） | 14 函数的内部互引链必需 | 2026-08-29 |
| u-foundation | 函数体逐字保留 pi 源风格（双引号/原注释），仅模块壳遵循 zsw 惯例 | 最小化 vendor 分叉，便于上游 diff 审计 | 2026-08-29 |
| U1 | DECLINE 用例显式钉 maxRounds:5（默认 10 后原路径变 stuck） | 保留 fixed-unverified 意图，stuck 另立用例 | 2026-08-29 |
| U1 | bin/zsw.js 未知 flag 原样透传入口（CLI 不重复维护白名单） | 白名单单一权威在 workflow 入口，防拼错 flag 被 CLI 静默丢弃 | 2026-08-29 |
| U1 | state 骨架多落 agentStatus/fixCount/baseHash/batchNames；loop 返回多带 targetType/target/batches/batchNames/warnings | 均设计 §3.4 state 规格内字段 + S4/S7 断言数据源 | 2026-08-29 |
| U2 | AGGREGATOR_SCHEMA 增补 title 字段；aggregated.md 落 runDir/batch-i/round-j/（非根平铺） | ID 标题匹配/表格/fix 队列必需；防多轮同名覆盖 | 2026-08-29 |
| U2 | fixer 结果落盘与 dormant 接线归 U3（本轮存 loop.fixResult/fixResultParsed） | 设计本就拆在 U3 状态机单元 | 2026-08-29 |
| U2 | fake CLI failList 分支改 parseFail 语义、abort 用例锚点移 aggregate done、prompt 关键词锚点精确化 | v2 聚合为独立阶段后的用例形态对齐 | 2026-08-29 |
| U3 | fixer 提取失败收紧为 fix-failure 终止（以设计 §4.1 差异 #5 为准，覆盖 U2 的降级存续行为） | 结构化契约违规即终止，v2 语义 | 2026-08-29 |
| U3 | stuck 用例改 FAKE_STUCK_RECON（对账驱动 openStreak 累计）；FAKE_DECLINE 留给 fixed-unverified | v2 对账通道优先，计数式 stuck 场景构造需对账数据 | 2026-08-29 |
| U3 | 批级 issue 状态隔离（issues/dormant/knownRemaining/convergeStreak 每批重置；agentStatus/fixCount 全局） | 对齐 pi MF-1/A2，防跨批收敛污染 | 2026-08-29 |
| U3 | filterDormantFromRecon 以 6 行适配实现在编排层（未入 vendor 清单）；A4 全降级轮不补记 clean（不采纳 pi W5） | 前者补位 vendor 缺口；后者保守方向（跨批全价重派优于误 skip） | 2026-08-29 |
| U3 | meta.terminated 运行中快照 null（pi 为乐观默认 clean） | 崩溃恢复「未终止」语义更诚实 | 2026-08-29 |
| U4 | package.json files 主动加 "commands/"（check-pack 不强制但属运行必需件） | plugin.json 已声明 commands 目录，npm 形态缺失则不可发现 | 2026-08-29 |
| U4 | README 迁移段「逻辑零漂移」改排除表述 + 状态目录树补 rfl/ | v2 后原表述失真；S5 可观测性入口 | 2026-08-29 |
| 一致性审查 | state.issues 增补 lastActiveRound/deferredReason，rounds[] 增补 skipped | 活跃清单精确过滤 / knownRemaining 格式 / S4 跳过可证 | 2026-08-29 |
| 一致性审查 | deferred 条目计入 R2+ 对账清单注入 | escalate 通道触发面；reconcileIssues 对 deferred 免疫无误转换 | 2026-08-29 |
| 一致性审查 | validateFixResult 保留 pi 源对未追踪自报条目的 trivial 容忍（编排层按 minor 建条目） | vendor 逐字纪律；行为效果等同 minor | 2026-08-29 |
| 一致性审查 | suggestion 明细从 reviewer minor issues 按 dedupKey 去重汇总（聚合契约仅计数） | D6 全等级修复的数据源 | 2026-08-29 |
| 一致性审查 | fallow 探测与 audit 执行主体 = 无头会话（workflow 只锁 base 与规定步骤） | 与 pi buildFallowReviewCall 同构 | 2026-08-29 |
| 一致性审查 | 防御性归一组（mdCell 转义/title 缺失回填/severity 回落 minor/落盘失败 WARN 不阻断） | 保守防御，不丢真 must-fix | 2026-08-29 |
| 修复轮 1 | 聚合 abort 双检查点（phases.push 后 + 归一摘要后同点保留） | 既有 aggregate-done 用例的 abort 时机在归一后，删同点检查会改变其 abortedAtPhase 语义 | 2026-08-29 |
| 修复轮 1 | dormant 条目 title 由编排层在 recordDormant 返回后补齐 | utils vendor 逐字纪律；标题匹配依赖该字段 | 2026-08-29 |
| 修复轮 1 | fake CLI 修复者分支锚词收紧为「循环中的修复者」 | wrap 警示文案含「修复者」被分支截胡致 9 用例失败 | 2026-08-29 |

## 6 状态表

| Unit | 状态 | 轮次 | 证据指针 |
|------|------|------|----------|
| u-foundation | committed | 1 | utils 34/34 绿；导出面探针 miss=none |
| U1 | committed | 1 | 5 套件 121/121 绿（workflow-b 25 用例） |
| U2 | committed | 1 | workflow-b+utils 64/64 绿（workflow-b 30 用例） |
| U3 | committed | 2 | 修复轮 1 后 7 套件 177/177 绿（workflow-b 43 用例） |
| U4 | committed | 1 | check-sync/check-pack 双绿；npm pack 实测 commands/ 入包 |

## 7 残留风险与变更历史

- 真机遵循率风险（设计 §5 待验证检查点 1/2）：R2 reconciliation 缺失率 >30% 或聚合 fallback 率 >20% 时按设计回改路径执行（D2 拆二次调用 / D1 加 few-shot），登记本表。
- U1 的 workflow-manager.js 改动（runId 注入）触及共享层：_invokeEntry 增字段对其他 4 个内置 workflow 无害（解构风格忽略多余字段，复审已核实），但 workflow-manager.test.js 必须随跑。
- 变更历史：2026-08-29 计划创建（基线 aa00a84）；2026-08-29 一致性审查（A 区 6 unreasonable + B 区 4 unreasonable + 5 doc_errors）→ 修复轮 1 双批次清零（A 区 4 major：reviewer 落盘/修复说明段 wrap/dormant 复活 ID 对齐/聚合 abort 检查点；minor：maxRounds 上限放开/reconciliation 归一；B 区：batchN 数组透传/skills frontmatter/aggregatorModel 文案/测试护栏）+ doc_errors 主 agent 修订。
