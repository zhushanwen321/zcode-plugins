# zsw review-fix-loop v2.1 差距修复 实施计划

基线: （本计划自身 commit，见变更历史） | 来源设计: [zsw-review-fix-loop-v2.1-gap-fixes-design.md](zsw-review-fix-loop-v2.1-gap-fixes-design.md) | 日期: 2026-08-29

> 来源设计的对抗式审查证据：设计文档 §6 变更历史第 2 行（4 must-fix + 4 suggestion 全部修复后落盘），
> commits `c0bae81`（审查修订）+ `62d7e8d`（FS2 交叉引用补全）。must_fix == 0，预检门 0.3 通过。
>
> 用户评审豁免依据：用户既定指令「完成审查和修复问题后，直接进入开发，不用我来确认，你直接完成
> 开发和验证即可」+ 本轮明确指令「开始开发」。设计 §5 拆分表已经对抗式审查确认，本计划单元表
> 与其 1:1 镜像（仅补精确路径与可验收检查点），无新增切分决策。

## 0 章节映射

| 内容 | 设计文档实际位置 |
|------|------------------|
| 背景/目标 | §1 背景目标（SCQA；设计目标 GF1-GF5 表；In / Out of scope） |
| 终态/机制 | §3 解决方案：§3.1 终态（修复后行为清单）；§3.2 方案对比；§3.3 关键决策 D1-D9（含实现锚点 file:line） |
| 验收场景表 | §4 验收（FS1-FS7：场景/步骤/通过标准/回溯） |
| 下一层拆分 | §5 下一层拆分（F1-F4 单元表 + 串行说明） |
| 待验证检查点 | §5 末段「待验证检查点」（FS1 reviewer 对锁定 hash 指令的遵循度） |

补充权威源（实现语义对齐用，只读）：
- pi 版语义权威：`/Users/zhushanwen/Code/xyz-agent-workspace/dev-0.9.11/extensions/universal/subagent-workflow/workflows/review-fix-loop.js` 及同目录 `review-fix-loop-utils.cjs`（D1 对齐 `lockReviewBase`/`buildReviewInstruction`；D2 对齐 known-remaining 抑制；D3 对齐 fallback severity 口径）
- 本仓 vendor（禁改）：`z-subagent-workflow/lib/workflow/review-fix-loop-utils.js`（reconcileIssues、MUST_FIX_SEVERITIES 等契约常量）

## 1 目标快照（逐字摘录）

**GF1** 审查范围语义与 pi 一致（base 锁定 + 按 targetType 指令构造）——git-diff target=main 时 reviewer 收到 `git diff <锁定hash>...HEAD` + 未提交改动条款。
**GF2** escalate→open 闭环成立，clean 终态不被 open 残留污染——escalate 后条目持续出现在对账清单直到 fixed/再次降级；任何成功终态出口断言无 open/regressed 残留。
**GF3** 无假终态：契约校验与 fallback 队列对齐 pi 严格性——缺契约字段的 reviewer 输出 → 终止而非 clean；fallback 轮 minor 合法 defer → 循环继续而非 fix-failed。
**GF4** MF-N 键空间唯一（issues ∪ dormant 联合计数）——dormant 占号不被新条目复用。
**GF5** 成本与可观测：rawAllClean 轮零聚合调用；终报附残留清单与人读 runDir。

**Out of scope**（维持 v2 决策）：calls[]/usage 采集；scores 打分；聚合输入改 read-file 通道；对账引擎整体重构（方案 B 被否）。

## 2 单元列表

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 |
|------|------|----------------------|------|------|----------|
| F1 | D1：新增 `buildReviewInstruction(targetType, lockedBase)`（四种 targetType 指令段，对齐 pi utils 同名语义）；baseHash 改锁 `git rev-parse <target>`（仅 git-diff；失败降级原 ref + WARN 一行，锁定结果落 `state.meta.baseHash`）；reviewer/fixer/fallow prompt 统一消费指令段与锁定值（替换 :799/:1292 裸 target 透传） | `z-subagent-workflow/lib/workflow/review-fix-loop.js`、`z-subagent-workflow/test/workflow-b.test.js` | 无 | plain | ① 红→绿测试：git-diff 指令段含锁定 hash 与「未提交改动审查」条款；file/dir/text 三型指令段断言；rev-parse 失败降级路径 + WARN 断言 ② `state.meta.baseHash` 落盘断言 ③ 增量测试全绿 |
| F2 | D2：`activeIssuesForPrompt` 过滤改 `status ∈ {open, regressed, fix-attempted, deferred}`（弃用 lastActiveRound 过滤；escalate→open 时编排层刷新 lastActiveRound；幽灵 defer 建条目补 lastActiveRound/openStreak）；deferred 清单条目带「[deferred——仅本轮 fix 改变其上下文时 escalate，否则无需判定]」标注；rawAllClean/A4/converged 三成功出口前置断言 `state.issues` 无 open/regressed 残留（有则不 break 继续轮）；reconcile 后编排层补充转换：open/regressed 被 reconciliation 声明 `fixed`（带 evidence）→ 转 fixed | 同 F1 | F1（同文件领地 → 串行） | plain | FS2 全链：R1 issue→defer(minor)→R2 escalate→R3 对账清单仍含该条目→R4 not-fixed openStreak 累计；分支 b：全员 clean 但 open 残留→不判 clean 循环继续；分支 c：open 残留被 reconciliation 声明 fixed（带 evidence）→转 fixed 出口放行 |
| F3 | D3：(a) `jsAggregateFallback` 按 severity 拆分，minor 不进 fixQueue（走 suggestion 明细通道）(b) `validateFixResult` 调用侧 mustFixIds 只传 `severity ∈ MUST_FIX_SEVERITIES` (c) reviewer parseFail 扩展四形态：status 缺失/非 {clean,issues}、status=issues 而 issues 非数组、status=clean 而 issues 有效条目>0（矛盾输出）、suggestion_count 不可数值化、全畸形 title 被剔除后有效 0 而原始>0——任一命中 review-failed 终止（报告指明 reviewer 名与具体缺失/矛盾字段）。D4：`alignIssueToState` 新号扫描集 = issues ∪ dormant[].id ∪ 本次 used。D5：rawAllClean 判定（契约级 must-fix 与 suggestion 双零）上移至 review 解析后、聚合 phase 前——零聚合调用；该轮不产 aggregated.md，轮摘要标注「全员 clean，未聚合」 | 同 F1 | F2（出口断言依赖清单视图） | plain | FS3a：FAKE_AGG_GARBAGE + 1 major + 1 minor → fixer 修 major 合法 defer minor → 循环继续（非 fix-failed），fix 队列 prompt 只含 major，minor 在 suggestion 段；FS3b：`{"ok":true}` / `status:"maybe"` / issues 非数组 / clean+issues 四形态 → review-failed + reviewer 名与字段；FS4：issues={MF-1,MF-2}+dormant MF-3 → 新条目 MF-4，dormant MF-3 复活走原 id；FS5：双维首轮全 clean → 聚合调用计数 0 + 摘要标注 |
| F4 | D6：`lib/workflow/report.js` buildMarkdownReport 头部增 runDir 行（有值时）；fixed-unverified/max-rounds/stuck/converged 终报段渲染残留清单（id/severity/title/status）+ deferred 清单（及理由）。D7：fix 消费处归并 `fixes[].affected_files` 入 `state.fixImpactFiles`；scoped prompt scope 改 `lastModifiedFiles ∪ fixImpactFiles` + 追加对账清单段（scoped reviewer 产出 reconciliation）。D8：convergeNewIssues coerceInt 下限 1；畸形 severity 回落 major（仅活跃通道；suggestion 明细通道畸形条目维持排除）；roundRecord 增 `phaseTimings {review, aggregate?, fix?}`。D9：v2 设计 5+1 处措辞修正（§3.3 D9 清单）+ v2 §6 记 v2.1 一笔；README 验收手册「各轮 aggregated.md 齐全」改「非全员 clean 轮齐全；全员 clean 轮标注未聚合」；workflow-b 既有 S2/S5 aggregated.md 存在性断言改条件断言 | `z-subagent-workflow/lib/workflow/review-fix-loop.js`、`z-subagent-workflow/lib/workflow/report.js`、`z-subagent-workflow/test/workflow-b.test.js`、`docs/design/zsw-review-fix-loop-v2-design.md`、`z-subagent-workflow/README.md` | F1-F3 | plain | FS6：max-rounds run 的 markdown 头部含 runDir 行 + 终报含残留与 deferred 清单；`node scripts/check-sync.js` 与 `node scripts/check-pack.js` 双绿（repo 根执行） |

共用约束：**vendor `review-fix-loop-utils.js` 禁改**（14 个 pi 原函数逐字 vendor，F4 领地刻意排除）；
`bin/zsw.js` 与 `dist/mcp/server.js` 不在领地（本设计无 CLI/schema 参数面变更，发现必须改 → blockers 上报）。

## 3 DAG 图

```mermaid
graph LR
    F1[F1 D1 指令构造+base 锁定] --> F2[F2 D2 对账清单+出口断言]
    F2 --> F3[F3 D3 契约校验+D4 联合计数+D5 上移]
    F3 --> F4[F4 D6-D8 报告/recheck/参数+D9 文档同步]
```

串行理由：F1-F3 同文件领地（review-fix-loop.js）互斥；F3 出口断言依赖 F2 清单视图；F4 是收口。
无 u-foundation 单元：契约根（utils vendor）已存在且本设计禁改。

## 4 测试策略

| 类型 | 命令 | 说明 |
|------|------|------|
| 增量（F1-F3，每单元） | `cd z-subagent-workflow && node --test test/workflow-b.test.js` | 只跑受影响模块 |
| 增量（F4 附加） | `cd <repo 根> && node scripts/check-sync.js && node scripts/check-pack.js` | 文档/清单改动门禁 |
| 全量（Gate A / FS7） | `cd z-subagent-workflow && node --test 'test/*.test.js'` | 含 e2e 真机用例外的全量；零跳过零容忍 |
| 真机（Gate B / FS1） | 临时仓三态（base commit / 分支第二 commit 含 bug / 未提交改动）+ `node bin/zsw.js workflow --name review-fix-loop ... --target-type git-diff --target main` | 详设计 §4 FS1；真机成本仅此一次 |

注：AGENTS.md 写的 `node --test test/` 在本机 Node v24.11.1 实测 MODULE_NOT_FOUND（上一轮已实证并报告
用户），本计划以 glob 形式为执行口径；AGENTS.md 文本修正待用户裁决，不在本计划领地。

## 5 合理偏差登记表

| 单元 | 偏差 | 理由 | 处置 |
|------|------|------|------|
| F1 | pi 权威路径 dev-0.9.10 → dev-0.9.11（本机实际只有后者） | 路径漂移，同名函数语义一致 | 计划 §0 权威源路径已更正 |
| F1 | 既有 fallow 用例 target 'main..HEAD' → 'HEAD' | 本机 git 无 init.defaultBranch，真锁定语义下 rev-parse('main..HEAD') 必失败降级致断言红；改可解析 ref 后用例意图成立 | 测试修正，非行为回归 |
| F1 | rev-parse「退出 0 无输出」分支无端到端断言 | 真实 git 无法构造该场景；防御分支与非零退出共用同一降级+WARN 路径，非零路径已断言 | 接受 |
| F1 | 非 git-diff 类型 baseHash 维持 gitHead(workdir) 而非 pi 的置空 | D1 条款限定 rev-parse 仅 git-diff 执行；v2 既有行为与断言依赖此值，改动扩大领地面 | 接受（D1 范围内） |
| F1 | 锁定成功不加 pi 的 INFO 行 | 可追溯性由 state.meta.baseHash 承担（设计 §3.1）；最小改动 | 接受 |
| F2 | 出口断言 fall-through 轮 `cleanNames.clear()` | 主 agent 行级裁决（一致性审查 R1/R2 分歧）：skip-clean 默认不清空时下轮 `active.length===0`（review-fix-loop.js:921-922，在轮逻辑与出口断言之前）直接 `status='clean'; break`——假 clean 真实可达；清空保证残留轮 reviewer 真实重派（FS2a calls.length=4 承载） | 实现层必要配套，接受（裁决后原释成立） |
| F2 | 既有 FAKE_RECON_DRIFT 用例终态断言修正（clean → max-rounds 钉轮） | 原断言编码的正是 D2 要消除的假终态（regressed 残留判 clean）；核心断言（regressed 链/fixAttempts）原样保留 | 既有断言随行为修正，接受 |
| F2 | 幽灵 defer 建条目额外补 title（reason 首段截断 40 字） | 对账清单条目与报告渲染需要 title；fixer deferred 契约无标题字段（pi 同构亦无） | 接受 |
| F2 | deferred 抑制标注落条目独立 note 字段而非拼接 title（文案逐字保留设计原文） | 聚合 prompt 复用清单做「ID 权威」提示，拼接 title 会污染 dedupKey 标题对账 | 接受 |
| F3 | D5 行为变更的 10 处既有断言改条件断言（T1-T8/FS2a/b/c 的聚合 phases 计数与 aggregated.md 存在性） | D5 直接测试面（任务书明示随 F3 更新，README/v2 措辞归 F4） | 接受（按计划执行） |
| F3 | T7「聚合阶段 abort」场景重写（挂 R1 非 clean 轮 aggregate running） | 原场景挂 R2 全员 clean 轮聚合 phase，D5 后该轮无聚合、场景结构性消失；检查点断言语义原样 | 接受 |
| F3 | FS3b 覆盖六形态（任务书四形态 + D3c ⑤全畸形 title + 围栏解析失败回归断言） | D3c 决策文本共 5 个命中条件，逐一测入 | 接受（超集覆盖） |
| F3 | FS3a「队列只含 major」以 aggregated-issues 块级断言表达 | 整 prompt 负断言与「minor 在 suggestion 段」自相矛盾 | 接受 |
| F4 | convergeNewIssues 下限语义取 clamp（0 抬 1）而非报错 | 与 zsw coerceInt 既有 clamp 惯例一致（maxRounds 同款）；pi 仅声明 schema minimum=1，报错行为不可证实 | 接受 |
| F4 | phaseTimings.review 记整批墙钟时长（runWithLimit 起止差），非各 reviewer 耗时和 | 与 phases 阶段表耗时口径一致；pi 为 [t0,t1] 时间戳对，zsw 按设计文本「Date.now 差值毫秒」 | 接受 |
| F4 | fixImpactFiles 批内累积去重 + 批启动重置（pi 为每次 fix 整体替换） | 设计文本明确「归并入第二清单」；批作用域隔离与 issues/dormant/convergeStreak 同模式，跨批陈旧触碰面会误导后续批复检范围 | 接受（批作用域为 zsw 模式一致性选择） |
| F4 | deferred 清单数据源取 state.issues 中 status=deferred 条目（id/title/deferredReason）而非 knownRemaining 字符串数组 | knownRemaining 形态「ID: reason」无 title，任务要求三元组；两源由 computeKnownRemaining 保持同步信息等价 | 接受 |
| F4 | README 仅 1 处 aggregated.md 措辞修正（「状态与目录」树行），无「各轮齐全」原文 | README 全文 grep 仅此一处（设计措辞基于 v2 设计 S5 的推测表述）；该处已条件化 | 接受 |
| F4 | impl-plan F4 行「S2/S5 断言改条件断言」经核查为 no-op | F3 偏差表已随行为变更改毕 10 处；现存断言均落非全员 clean 轮语义自洽 | 接受（计划行冗余，无代码动作） |
| 修复批次 | stuck 终态构造未用 FAKE_FS6，改用 FAKE_STUCK_RECON + 新开关 FAKE_STUCK_DEFER | FAKE_FS6 的 R2+ reviewer 为 clean，走 D5 rawAllClean 上移路径到不了 stuck 终态；FAKE_STUCK_RECON + stuckThreshold:2 使残留/deferred 双清单非空，与既有两终态断言同构 | 接受 |

## 6 状态表

| Unit | 状态 | 轮次 | 证据指针 |
|------|------|------|----------|
| F1 | committed | 1 | 47/47 workflow-b 绿（44 既有零回归 + 3 新增）；核验 2026-08-29 主 agent 复跑相符 |
| F2 | committed | 1 | 51/51 workflow-b 绿（47 零回归 + 4 新增，实现前红态 4 fail 实证）；核验 2026-08-29 主 agent 复跑相符 |
| F3 | committed | 1 | 55/55 workflow-b（51 零回归 + 4 新增，红态 14 fail 实证）；非 e2e 全量 431/431；核验 2026-08-29 主 agent 复跑相符 |
| F4 | committed | 1 | 59/59 workflow-b（55 零回归 + 4 新增，红态 0/4 实证）；非 e2e 全量 435/435；check-sync/check-pack 双绿；核验 2026-08-29 主 agent 复跑相符 |

## 7 残留风险与变更历史

### 残留风险

1. FS1 reviewer 对锁定 hash 指令的遵循度（设计 §5 待验证检查点）——真机一次即测；pi 同款指令已被验证，风险低。
2. 发版 type=minor（设计 §5 判定）——发版本身（`node scripts/release.js z-subagent-workflow minor`）是独立用户授权流程，不在本计划内。
3. AGENTS.md `node --test test/` 命令漂移待用户裁决（见 §4 注）。

### 变更历史

| 日期 | 变更 | 触发 |
|------|------|------|
| 2026-08-29 | 计划创建（基线 commit 见 git log 本文档首次提交） | dev-flow 阶段 1 |
| 2026-08-29 | 一致性审查 round 1（2 分区并行）：R1 核心机制区 1 medium（jsAggregateFallback 归一前过滤丢畸形 severity 条目→降级轮假 clean 缺口）+ 1 doc_error（D5 README 引用失实）；R2 测试文档区 2 low（stuck 终态渲染无断言、FS3a 冗余断言）+ 2 low doc_error（README 树行 A4 轮措辞、登记表机理表述）。R1/R2 对 cleanNames.clear 机理分歧由主 agent 读 :920-921 行级裁决（R1 成立） | dev-flow 阶段 3 |
| 2026-08-29 | 修复批次清零：severity 归一前移（红态实证假 clean 机理）+ stuck 终报断言 + 冗余断言删除（dev subagent，61/61）；doc_errors 4 处由主 agent 修订（v2.1 设计 D5 勘误/D2 补注/§6 记录、README 树行、本表机理锚点） | dev-flow 阶段 4 |
| 2026-08-29 | 定向复审：4 项修复全部闭环；新增 2 low（缺失 severity 子路径无断言→续聊原 dev 补；登记表锚点 920-921→921-922 已修） | dev-flow 阶段 4 定向复审 |
