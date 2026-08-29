# zsw review-fix-loop v2.1：终局审查差距修复 — 技术设计

> **一句话结论**：以「定向修复 + 统一对账清单视图」修复终局对抗审查发现的 5 条 major（base 锁定未落地、escalate 链断裂、契约校验弱致假终态、MF id 撞号、rawAllClean 浪费聚合）与 9 条 minor，全部修复以 pi 语义为权威；审查用的运行时探针场景全部转为回归测试。

**层性质声明**：当前层 = 修复方案设计；下一层 = 可实现的修复代码任务。前置：v2 设计（[zsw-review-fix-loop-v2-design.md](zsw-review-fix-loop-v2-design.md)）已实施并通过双级验收，本设计是其差距修复，不重述 v2 全貌。

## 1. 背景目标

### SCQA

- **S**：v2 已交付（433/433 测试绿 + 真机 7 场景 pass），主干语义（批次/聚合裁决/对账/降级链/防注入）经两轮一致性审查与终局对抗审查逐行核实成立。
- **C**：终局对抗审查（实现 vs 设计文档、实现 vs pi 版双维度）发现 **5 条 major 差距**——全部位于单测与真机场景未覆盖的深水区边界，其中两条构成**假终态路径**（假 clean / 误 fix-failed），一条是「设计声称落地、实现实质分叉」（base 锁定）。
- **Q**：为什么 Gate A/B 双绿仍有 major 差距？因为测试与验收场景覆盖的是主干路径，而差距在状态机边界（escalate 复活、fallback 轮 minor、dormant 占号、契约缺失输出）——这类差距只能靠对抗审查的探针发现，发现后必须修，否则 v2 的 clean 终态可信度存疑。
- **A（答案）**：本设计——5 条 major 定向修复 + 9 条 minor 归组修复 + 审查探针场景测试化；修复策略上吸收重构方案的精华（对账清单统一为 status 过滤单一视图），但不做整体重构。

### 设计目标

| # | 目标 | 判定标准 |
|---|------|----------|
| GF1 | 审查范围语义与 pi 一致（base 锁定 + 按 targetType 指令构造） | git-diff target=main 时 reviewer 收到 `git diff <锁定hash>...HEAD` + 未提交改动条款 |
| GF2 | escalate→open 闭环成立，clean 终态不被 open 残留污染 | escalate 后条目持续出现在对账清单直到 fixed/再次降级；任何成功终态出口断言无 open/regressed 残留 |
| GF3 | 无假终态：契约校验与 fallback 队列对齐 pi 严格性 | 缺契约字段的 reviewer 输出 → 终止而非 clean；fallback 轮 minor 合法 defer → 循环继续而非 fix-failed |
| GF4 | MF-N 键空间唯一（issues ∪ dormant 联合计数） | dormant 占号不被新条目复用（探针场景转测试） |
| GF5 | 成本与可观测：rawAllClean 轮零聚合调用；终报附残留清单与人读 runDir | 断言见 §4 |

### In / Out of scope

**In**：上轮审查的全部 gap_major（5）+ gap_minor（9，其中 2 条并入 major 修复）+ doc_side（4 条随本文档更新 v2 设计措辞）+ 探针场景测试化。

**Out**（维持 v2 的 Out-of-scope 决策，理由不变）：calls[]/usage 采集（CLI 参数探针前置）；scores 打分；聚合输入改 read-file 通道（终局审查已确认「内联」为合理刻意差异）；对账引擎整体重构（见 §3.2 方案 B 被否理由）。

## 2. 现状与问题分析

### 2.1 五条 major 的机理（锚点均经运行时探针实证）

1. **base 锁定与审查指令未落地**（vs pi 最高优先级）：`review-fix-loop.js:653` 的 baseHash 锁的是 run 起点 HEAD；pi 锁 `git rev-parse <target>`（pi utils `lockReviewBase`）。reviewer/fixer prompt 只传裸 target 字符串（:799/:1292），pi 的 `git diff <hash>...HEAD` + 未提交改动审查条款及 file/dir/text 模板缺失。后果：git-diff target=main 时漏审分支已提交变更；autoCommit=false 下各轮对「修复在工作区是否属审查范围」理解不一。
2. **escalate 链断裂**：escalate→open 后条目 (a) 不进 fix 队列（fixQueue 仅聚合条目，:1078）(b) `lastActiveRound` 停滞 → `activeIssuesForPrompt` 按 `lastActiveRound===max` 过滤（:361-367）下一轮将其移出对账清单——reviewer 永远看不到它 (c) rawAllClean/A4 出口（:1115/:1239）不检查 state.issues，可带 open 残留判 clean。
3. **契约校验弱的两条假终态**：(a) JS fallback 汇总不按 severity 过滤（:375-396），minor 进 fixQueue 后 `validateFixResult` 的 mustFixIds 取全队列（:1340，与 :1080 mustFixCount 只数 critical/major 口径不一致）——合法 defer 一个 minor 即误判 must-fix-not-fixed → 整 run fix-failed；(b) reviewer 输出含合法 JSON 但缺契约字段（如 `{"ok":true}`）时 `issues=[] → clean=true`（:846-859）——假 clean；title 畸形条目被静默剔除（:849-851）后同理。
4. **MF id 计数器不扫 dormant**：`alignIssueToState` 新号分配只扫 issues 与 used（:270-276），dormant 占号可被复用；撞号后 dormant 同题重报经标题匹配命中活跃条目 → revived 永不置位 + upsert 覆盖活跃条目身份。
5. **rawAllClean 轮照跑聚合**（:1005 聚合无条件执行，rawAllClean 检查在 :1115）：每个成功批收尾轮多付一次聚合调用，且聚合幻觉条目会落盘误导性 aggregated.md（状态机不受污染，merge 在 break 后）。

### 2.2 根因

三个共同根因：(1) **边界场景无测试**——单测构造的都是「契约遵从的主干路径」，对抗审查靠探针才发现的边界（escalate 后、fallback 轮 defer、缺字段输出、dormant 占号）没有对应断言；(2) **同名概念双口径**——「活跃条目」在 fixQueue/mustFixCount/对账清单三处口径不同，「无效输出」在 D3 的哲学（防假结论）与 parseFail 的实现（仅围栏解析失败）间有缝；(3) **v2 设计描述与 pi 语义的粒度差**——「重新进修复队列」「fix 队列照常建立」这类短语在实现时被从宽解读。

### 2.3 minor 差距清单（归组）

| 组 | 条目 |
|----|------|
| 报告完备（M1） | 人读报告无 runDir 指针；fixed-unverified/max-rounds/stuck/converged 终报不附残留 issue 清单与 deferred 清单 |
| 对账链补全（M2） | 幽灵 defer 条目缺 lastActiveRound/openStreak（并入 GF2 修复）；recheckAfterFix scope 缺 affected_files 并集、scoped reviewer 不产出 reconciliation |
| 参数与防御（M3） | convergeNewIssues 下限 0（pi 为 1）；畸形 severity 回落 minor（pi 回落 major——must-fix 保守方向）；phaseTimings 相位级时长缺失 |

## 3. 解决方案

### 3.1 终态（修复后行为）

- git-diff run（target=main）的每轮 reviewer prompt 含确定性审查指令：`git diff <rev-parse main 的锁定 hash>...HEAD` + 「同时用 git status --porcelain && git diff 审查未提交改动（修复可能在工作区）」；rev-parse 失败降级原 ref + WARN 一行（锁定结果落 state.meta.baseHash 可追溯）。
- escalate 复活的条目：下一轮起持续出现在 reviewer 对账清单（按状态过滤，不按轮次），reviewer 可 not-fixed/regressed/escalate 它；全员 clean 但存在 open 残留时**不判 clean**——继续轮（该条目随清单注入，直到被修复确认或重新降级）。
- fallback 轮：fix 队列只含 critical/major（minor 走 suggestion 明细通道）；fixer 合法 defer 一个 minor → 循环继续。reviewer 输出 `{"ok":true}` 这类缺契约字段 → review-failed 终止（报告指明 reviewer 与缺失字段）。
- dormant MF-3 占号后，新问题分配 MF-4 起——issues ∪ dormant 联合计数。
- 全员原始 clean 的轮：零聚合调用，直接批收尾。
- 终报：fixed-unverified/stuck/converged/max-rounds 附残留 issue 清单（id+title+status）与 deferred 清单；markdown 头部含 `runDir` 行。

### 3.2 方案对比（主轴：修复策略）

**方案 A：定向修复 + 局部统一（推荐）**——每条差距最小修补；唯一结构性动作是把「对账清单注入」从 `lastActiveRound===max` 改为按 status 过滤的单一函数（吸收方案 B 的核心收益）。

| 维度 | 评估 |
|------|------|
| 长期合理性 | 高：修复全部以 pi 语义为权威，不引入新概念；状态过滤单视图消除双口径根因 (2) 的一半 |
| 短期成本 | 中低：估算净改 ~300 行（含 ~150 行测试），全部在既有函数边界内 |
| 风险 | 低：每条修复独立可测；探针场景先转测试（红）再修（绿），防回归 |

**方案 B：对账引擎重构（被否）**——把 fixQueue 构成 / 对账清单 / 出口断言统一为 issue-set 视图层（单一 `activeView(state)` 驱动一切）。长期最净，但状态机刚经两轮审查稳定，重构面 ~600 行且所有既有断言重写——在「修复 5 个已知缺陷」的目标下引入新回归面的风险不对称。B 的精华（单一视图）已由 A 的 status 过滤函数吸收；若未来再有双口径类缺陷，升级为 B 的信号。

### 3.3 关键决策

- **D1（GF1）base 锁定与审查指令构造**：引入 `buildReviewInstruction(targetType, lockedBase)`（对齐 pi utils 同名函数语义）：git-diff → `git diff <hash>...HEAD` + 未提交改动条款；file → 审查指定文件内容；dir → 遍历审查目录；text → 按 target 描述自由审查。baseHash 改锁 `git rev-parse <target>`（仅 git-diff；失败降级原 ref + WARN，落 state.meta.baseHash）。reviewer/fixer/fallow prompt 统一消费指令段与锁定值。被否：维持裸 target 透传——即现状，RC-6 缺失。**pi 差异声明（终审验真补注）**：①落盘值——pi 对非 git-diff 与降级场景 `baseHash` 一律落空串，zsw 落 run 起点 HEAD / 降级原 ref（可追溯性更高，刻意差异）；②fixer 消费指令段为 zsw 扩展（pi 的 fixer prompt 无审查范围段，指令只进三型 reviewer prompt）。
- **D2（GF2）对账清单改按 status 过滤 + 出口断言 + open/regressed 的 fixed 转换**：`activeIssuesForPrompt` 过滤条件改为 `status ∈ {open, regressed, fix-attempted, deferred}`，不再依赖 lastActiveRound（字段保留为元数据，escalate→open 时编排层刷新为当前 round；幽灵 defer 建条目时补齐该字段）。清单内 deferred 条目带语义标注（「[deferred——仅本轮 fix 改变其上下文时 escalate，否则无需判定]」）——对齐 pi 的 known-remaining 抑制语义，避免与对账清单段「每条必须判定」的指令矛盾（实现将幽灵 defer 建条目补齐 lastActiveRound/openStreak 与 title——fixer deferred 契约无标题字段，title 取 reason 首段截断）。fix 队列构成不变（仅聚合活跃条目）——escalate 条目「重新进修复队列」的准确路径 = 经对账清单被 reviewer 重报 → 聚合进队列（pi 同构），而非直接塞队列。rawAllClean/A4/converged 三个成功出口统一前置断言：`state.issues` 无 open/regressed 残留，有则不 break、继续轮（清单注入保证下轮可见）。**配套转换（出口断言的消除路径，审查 MF 补全）**：vendor reconcileIssues 只有 fix-attempted→fixed/regressed 转换，open/regressed 条目无消除通道会空转到 maxRounds——编排层在 reconcile 后补充转换：open/regressed 条目被 reconciliation 声明 `fixed`（带 evidence）→ 转 fixed（reviewer 明确确认已修即信）；未声明则保持（经清单注入 → 重报进聚合 → fixer 修 → fix-attempted → 常规链消除）。被否：escalate 直接并入 fix 队列——pi 的 re-open 是「进对账可见面」而非「直接派修」。**pi 差异声明与终审演进（终审验真补注）**：①出口断言为 zsw 超出 pi 的加强——pi 仅 converged 出口有 activeIssues 检查，其 all-clean/A4 出口自身存在「reviewer 漏重报 open 条目→带残留判 clean」同型缺口，zsw 三出口统一设防；②known-remaining 抑制的呈现结构与 pi 不同构——pi 把 deferred 移出对账判定面（独立抑制段），zsw 留在清单内靠 note 豁免 + 独立知悉段（容差等价：reconcileIssues 对 deferred 只认 escalate 声明）；③终审行为收紧：rawAllClean 残留回填处消费 reconcileIssues 的 stuck 判定——「全员 clean 但残留持续 not-fixed 达 stuckThreshold」判 stuck 终态（诚实停滞，早于 maxRounds 空转；此前该形态只能 fall-through 到 max-rounds，与「残留+新上报」路径的停滞终态不一致）。
- **D3（GF3）契约校验双修**：(a) `jsAggregateFallback` 按 severity 拆分——minor 不进 fixQueue（suggestion 明细通道已存在），与 LLM 聚合契约同形；(b) `validateFixResult` 调用侧 mustFixIds 只传 `severity ∈ MUST_FIX_SEVERITIES` 的条目（与 mustFixCount 口径对齐，双保险）；(c) reviewer parseFail 判定扩展：`status` 缺失或非 {clean,issues}、`status=issues` 而 issues 非数组、**`status=clean` 而 issues 有效条目 >0（矛盾输出，按 :855 现实现会判 clean=true 丢条目——假 clean 同类机理，审查补全）**、`suggestion_count` 不可数值化、issues 内 title 畸形条目被剔除后有效条目为 0 且原始条目数 >0——任一命中即 parseFail 走 D3 终止（报告指明 reviewer 名与具体缺失/矛盾字段）。**终审扩展两形态（行为收紧）**：`suggestion_count` 显式 null 视同缺失（null 不再被 Number(null)=0 宽容放行）；`status=issues` 而 issues 为数组但有效条目为 0（空 issues 矛盾形态，与 clean+条目对称）。**pi 差异声明（终审验真补注）**：(a)「与 LLM 聚合契约同形」指 zsw 自家聚合契约（minor 恒为 suggestion）；pi 契约允许 minor 进 must_fix_ids 且为必修条目——zsw 契约本身即对 pi 的刻意语义收窄（v2 既定决策）；(b) D3b 的 mustFixIds 口径为刻意分叉——pi 的 validateFixResult 用非降级条目全集（含 minor），zsw 收窄为 critical/major 子集（自家契约下防误杀合法 defer 的防御性收窄）。被否：放宽 fixer 校验（deferred minor 视为已处理）——治标，且会让 LLM 聚合违约把 minor 塞 must_fix_ids 的路径继续无设防。
- **D4（GF4）联合计数**：`alignIssueToState` 新号扫描集 = `Object.keys(state.issues) ∪ state.dormant[].id ∪ 本次 used`。被否：dormant 改独立 D-N 前缀——ID 空间分裂，复活对账（prev_id 匹配）复杂化。
- **D5（GF5）rawAllClean 上移**：全员原始 clean（各 reviewer 契约级 must-fix 与 suggestion 双零）判定移至 review 解析后、聚合 phase 前——对齐 pi 时序，收尾轮零聚合调用。上移后该轮不产 aggregated.md（报告轮次摘要标注「全员 clean，未聚合」）。**连带更新（审查 MF 补全）**：v2 设计 S5 与 README 验收手册中「各轮 aggregated.md 齐全」的断言措辞需同步改为「非全员 clean 轮齐全；全员 clean 轮标注未聚合」（勘误：README 实无「各轮齐全」原文，实际同步对象为 README「状态与目录」树行，见 impl-plan 偏差登记表 F4）；受影响既有测试断言 = workflow-b 中 S2/S5 相关用例的 aggregated.md 存在性断言（改条件断言），在 F4 一并更新。
- **D6（M1）报告完备**：`buildMarkdownReport` 头部元信息增 `runDir` 行（有值时）；fixed-unverified/max-rounds/stuck/converged 终报段从 state.issues 渲染残留清单（id/severity/title/status）+ knownRemaining（deferred 及理由）。**终审补注**：①stuck/fix-failed/max-rounds 终报段的 final 文本在 residualIssues 非空时追加残留计数行（与残留清单一口径——此前「剩余 must-fix 0 个」用 fixQueue 残值计数，与清单并存时自相矛盾；needs-redesign/aborted 分支维持原文本不追加）；②多批 run 的残留/deferred 清单以末批为界（批隔离语义：state.issues 批启动重置，pi 同构）——跨批汇总需设计层决策，本轮接受现状。
- **D7（M2）recheck 模式补全**：fix 消费处把 `fixes[].affected_files` 归并入第二清单 `state.fixImpactFiles`；scoped prompt 的 scope 改 `lastModifiedFiles ∪ fixImpactFiles` 并追加对账清单段（scoped reviewer 也产出 reconciliation）。仅影响显式开启 recheckAfterFix 的可选模式。
- **D8（M3）参数与防御**：`convergeNewIssues` coerceInt 下限改 1（对齐 pi）；畸形 severity 回落改 major（对齐 pi normalizeSeverity 的 must-fix 保守方向——仅对将进活跃追踪的条目；suggestion 明细通道的畸形 severity 条目维持排除行为——非 minor 不入明细，审查 S 补注）；roundRecord 增 `phaseTimings {review, aggregate?, fix?}`（Date.now 差值，聚合可跳过时为 null）。**pi 差异声明与终审补注（终审验真补注）**：①下限违例处理——pi 为 schema minimum 拒绝路径（m3 args-validator），zsw 为 clamp 静默修正（无引擎层 schema 校验的等价实现）；MCP schema（dist/mcp/server.js）的 `minimum` 随本决策同步改 1（终审修复，此前漂移为 0）；②phaseTimings 值形态为 zsw 选择（毫秒差值），pi 为 `[t0,t1]` 起止区间对，刻意不同构；③畸形 title 条目的「原始条目数」口径 = issues 数组长度（非对象元素计入，触发方向保守——宁误杀违约输出，不假 clean）。
- **D9（doc 同步）**：v2 设计文档 6 处措辞修正（按位点计；聚合 runFail 也走降级链；abort 检查点合并描述；D7 fallow 探测主体；D4 目录布局 batch/round 子路径；**v2 :198「escalate→open（重新进修复队列）」与 :144「fix 队列照常建立」两个从宽解读源头短语按 D2/D3 准确路径改写**——审查 S 补全），v2 S5 措辞随 D5 更新，并在 §6 变更历史记 v2.1 一笔。

## 4. 验收

每条对应上轮审查的探针场景（先转测试再修复，红→绿）；真机门聚焦 D1（唯一改变 prompt 语义的修复）。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|----------|------|
| FS1 | base 锁定（真机） | 临时仓：base commit → 分支上第二个 commit（含 bug）→ 未提交改动；`--target-type git-diff --target main` 跑 run | ① state.meta.baseHash == rev-parse main 的 hash（≠ HEAD）；② 行为级验证：分支 commit 引入的 bug 被报出（证明未漏审——runDir round-N/*.md 落盘的是 reviewer response 而非 prompt，指令级断言不在此测；指令拼装由单测级断言覆盖于 F1） | GF1 |
| FS2 | escalate 闭环（单测探针） | fake：R1 issue → defer（minor）→ R2 reviewer 声明 escalate → 断言 R3 对账清单仍含该条目 → R4 reviewer 报 not-fixed → openStreak 累计；另两条分支：全员 clean 但 open 残留 → 不判 clean、循环继续；open 残留被 reconciliation 声明 fixed（带 evidence）→ 转 fixed、出口断言放行 | 全链 status/清单断言 + 终态非 clean 直到条目 fixed 或被声明 fixed | GF2 |
| FS3a | fallback minor defer（单测探针） | FAKE_AGG_GARBAGE + reviewer 报 1 major + 1 minor → fixer 修 major、合法 defer minor（≥20 字理由） | 循环继续（非 fix-failed）；fix 队列 prompt 只含 major；minor 出现在 suggestion 段 | GF3 |
| FS3b | 契约缺失输出（单测探针） | reviewer 围栏输出 `{"ok":true}` / `status:"maybe"` / issues 非数组 / `status:"clean"` 但 issues 有条目 四形态 | review-failed 终止，报告指明 reviewer 名与缺失/矛盾字段 | GF3 |
| FS4 | 撞号（单测探针） | issues={MF-1,MF-2}+dormant 含 MF-3 → 下轮全新条目 | 新条目分得 MF-4；dormant MF-3 复活走原 id | GF4 |
| FS5 | rawAllClean 零聚合（单测） | 双维度首轮全 clean run | 聚合调用计数 0；轮次摘要标注「全员 clean，未聚合」 | GF5 |
| FS6 | 报告完备（单测+人读） | 任一 max-rounds/stuck run | markdown 头部含 runDir 行；终报含残留清单与 deferred 清单 | GF5/M1 |
| FS7 | 全量回归 | `node --test 'test/*.test.js'` | 433+ 新增全绿，零跳过 | 全部 |

真机成本控制：仅 FS1 一次真机 run（其余单测探针）；FS1 顺带复验 v2 主干无回归。

## 5. 下一层拆分

| 单元 | 内容 | 领地 | 依赖 | 验收 |
|------|------|------|------|------|
| F1 | D1 指令构造 + base 锁定 | review-fix-loop.js、workflow-b.test.js | 无 | FS1（单测级先建：target 解析/降级/指令段拼装断言） |
| F2 | D2 对账清单 status 过滤 + 出口断言 + 幽灵 defer 补字段 | 同上 | 无（与 F1 并行领地冲突 → 串行） | FS2 |
| F3 | D3 契约校验 + fallback 拆分；D4 联合计数；D5 上移 | 同上 | F2（出口断言依赖清单视图） | FS3a/FS3b/FS4/FS5 |
| F4 | D6/D7/D8 报告/ recheck/参数防御 + D9 文档同步 | review-fix-loop.js、report.js、utils?（否——不动 vendor）、v2 设计文档、README | F1-F3 | FS6 + check-sync/pack |

串行 F1→F2→F3→F4（同文件领地）。全量回归（FS7）与真机 FS1 在 F4 后统一跑。

**待验证检查点**：FS1 的 reviewer 对锁定 hash 指令的遵循度（真机一次即测；若 reviewer 仍自由发挥范围，考虑指令段加围栏示例——不过 pi 同款指令已被验证，风险低）。

**发版 type 判定**：**minor**——含能力扩展（D1 按 targetType 的审查指令构造、D7 recheck scope 增强）与调用方可见判定面变化（D3c 缺字段输出 clean→review-failed、D5 全 clean 轮产物变化），超出 patch 的「bug 修复、内部重构」范畴（对照仓库 AGENTS.md 版本判定表）。

## 6. 变更历史

| 日期 | 变更 | 触发 |
|------|------|------|
| 2026-08-29 | 初版（5 major + 9 minor 差距修复方案，方案 A 定向修复） | 终局对抗审查差距清单 |
| 2026-08-29 | 审查修订：FS1 断言对象修正（.md 落盘 response 非 prompt）；D2 补 open/regressed 的 fixed 补充转换（出口断言消除路径）与 deferred 清单标注；D3c 补矛盾输出形态（clean+issues）与 FS3b 第四形态；D5 补 v2 S5/README/既有断言连带更新；D9 补第 5 处短语改写；发版 type 判定 minor；suggestion 通道排除补注 | 对抗式审查 4 must-fix + 4 suggestion |
| 2026-08-29 | 实施期一致性审查 doc 修订：D5 补 README 勘误注（README 无「各轮齐全」原文，同步对象为目录树行）；D2 幽灵 defer 补 title 回退说明 | dev-flow 一致性审查 doc_errors |
| 2026-08-29 | 终审（交付后三轴对抗审查：D1-D9 机制 / D6-D9 与验收证据 / pi 对齐声明验真）后修复：行为收紧三处（suggestion_count 显式 null 视同缺失；status=issues 空条目矛盾形态入 parseFail；rawAllClean 残留回填消费 stuck 判定）+ recheckScope 通道补 wrap（配套 v2 D10 通道 4 补枚举）+ MCP schema convergeNewIssues minimum 同步改 1 + 终报 final 文本残留计数行 + D7 scoped reconciliation 状态效应断言；补注 pi 差异声明（D1 落盘值/fixer 消费、D2 出口断言加强/呈现结构、D3 同形口径/mustFixIds 分叉、D8 拒绝 vs clamp/phaseTimings 形态）；接受现状三项（多批终报以末批为界、畸形计数保守口径、D9 按位点计 6 处） | 终审对抗审查（3 minor 代码 + 2 minor doc + 6 info） |
