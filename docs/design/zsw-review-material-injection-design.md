# zsw review-fix-loop 审查材料注入设计（host-prefetched material injection）

> **一句话结论**：把 reviewer 的审查材料（git diff 全量等）从「每个无头会话自主探索
> 拉取」改为「宿主预取一次、按批注入 prompt」，单会话从 19-32 轮百万 token 长会话
> 降到 ≤8 轮的一次性材料审查——稳定性（故障暴露面）、时长、审查注意力三赢；text
> 型 target 行为零变化，深查能力（Read 任意文件）完整保留。

**层声明**：当前层 = 技术方案设计；下一层 = 实现任务（T1-T6，见 §5）。涉及运行时
行为与数据流，tech-design 准则 5/6/7 全适用；运行时断言一律标注 ✅已测 / ⛔实施期门。

## 1. 背景与目标

**SCQA**：

- **S（情境）**：review-fix-loop 是 zsw 的核心 workflow——5 个维度审查者（arch-boundary
  / concurrency / business-logic / mcp-contract / test-coverage）各 spawn 一个无头 zcode
  会话，对分支全量 diff 做多轮「审查 → 聚合 → 修复 → 复审」循环。
- **C（冲突）**：审查材料靠每个会话自己拉——prompt 只给指令文本（见 §3.1 真实代码），
  每个会话要自己执行 `git diff`、读 checklist、按需读代码。本仓分支实测（59 commits，
  diff 9991 行 / 707KB / 38 文件）：单会话滚到 19-32 次模型请求、95-200 万 input
  tokens、6.9-17.4 分钟。3 并发下这种巨会话在 2026-08-29 的真机 run 中两次撞上
  provider 侧故障（一次 turn 失败、一次输出流被掐断在 1895 字符），另有 20 分钟
  超时杀死 90% 完成度 fixer 的事故（超时策略已另行废止，见 commit f854202）。
- **Q（问题）**：如何在不动审查质量与契约（D2 对账 / D3c 六形态 / json 围栏）的前提下，
  把单 reviewer 会话负载降到稳定区？
- **A（答案）**：宿主（zsw Node 进程）在 run 启动时预取材料一次，直接注入每个
  reviewer 的 prompt——reviewer 从「先探索后审查」变成「面对证据的审查者」，探索轮
  消失，会话轮次与上下文滚雪球同时消除。

**系统是什么**（受众假设：会用 zsw 但不熟内部）：`node bin/zsw.js workflow
--workflow review-fix-loop --target-type git-diff --target main --reviewers "..."
--max-rounds 3` 启动后，宿主进程解析参数（`normalizeParams` 校验 targetType/target，
MF-2 已修条件必填）、锁定 base hash（防 run 期间 base ref 漂移）、按 `maxRounds`
循环派发 reviewer 会话与 fixer 会话，聚合器（LLM）合并各 reviewer 结论
产出 must-fix 队列。reviewer 会话由 `runPhase` spawn 无头 zcode（隔离 HOME 池），返回
文本 response，`extractJsonObject` 提取 ```json 围栏结论。

**设计目标**（从使用者体验倒推）：

1. **G1 稳定性**：大分支（≥9991 行 diff）单轮全 5 维审查零 runFail/parseFail——
   会话模型请求轮次 19-32 → ≤8。
2. **G2 时长与成本**：单轮审查墙钟 ≤8 分钟（现状 15-20）；单 reviewer input tokens
   较 2026-08-29 基线降 ≥60%。
3. **G3 审查质量不减**：注入材料完整覆盖 diff（逐字节一致）；reviewer 深查能力保留
   （可 Read 任意文件看上下文）。
4. **G4 向后兼容**：text 型 target 行为零变化；既有单测全绿。

**In-scope**：review-fix-loop 的 review prompt 材料注入（git-diff 型为主，file/dir 型
顺带）；材料预取、尺寸护栏、注入格式。

**Out-of-scope**：聚合器/fixer 的材料策略（fixer 已有结构化 fixQueue 注入，不缺材料）；
prompt 前缀逐字节稳定化（pi tier-2 方向，zsw 跟进是另立设计，本设计的 D5 与其互补
但不重叠）；provider 侧配置；subagent（非 workflow）链路。

## 2. 现状与问题分析

**本章结论**：材料分发架构缺失是根因——指令驱动 + 自主探索让每个会话重复支付
「拉料 + 滚雪球」成本，5 份重复把 provider 推进不稳定区。

### 2.1 现状的真实样子

reviewer prompt 的审查范围段由 `buildReviewInstruction` 生成（`lib/workflow/review-fix-loop.js:254`，
真实代码）：

```js
case 'git-diff':
  return `Review \`git diff ${lockedBase}...HEAD\` for all committed changes against ${lockedBase}.\n` +
    'ALSO run `git status --porcelain` and `git diff` to review uncommitted working-tree changes ' +
    '(fixes may be uncommitted when autoCommit=false; uncommitted changes ARE in scope).';
```

这是**指令**不是材料——reviewer 会话收到后自己执行命令、自己读文件。物理数据流：

```
zsw 宿主（Node）
  └─ spawn ×5 无头 zcode 会话（隔离 HOME 池，3 并发槽）
       └─ 会话 i（i=1..5，各自独立重复）：
            R1: 读 agent.md checklist（~200 行）
            R2: 执行 git diff main...HEAD      ← 9991 行 / 707KB，重复 ×5
            R3+: 按维度 Read 相关代码文件        ← 又 5-25 轮
            Rn: 输出 json 围栏结论
            （每轮请求都带全量累积上下文：19-32 次请求，单会话 95-200 万 input tokens）
```

2026-08-29 本仓真机三次 run 的实测（`wf-e3792056` / `wf-449ba4a8` phases usage）：

| 指标 | 实测值 |
|------|--------|
| 单 reviewer 模型请求轮次 | 19 - 32 |
| 单 reviewer input tokens | 95 万 - 200 万 |
| 其中 cache read | ~90%（前缀缓存已高——计费痛点被缓存缓解，**稳定性痛点没有**） |
| 单 reviewer 墙钟 | 6.9 - 17.4 分钟 |
| 全批墙钟 | 15 - 23 分钟 |

### 2.2 失败模式（真实发生，非假设）

- **run1**：business-logic 会话在 433s 报 `Turn execution failed`（provider 侧 turn
  失败）；mcp-contract 会话输出流被掐断在 1895 字符（json 围栏未闭合 → D3c 判
  parseFail → D3 结构化终止）。两者按「失败停机归因总则」归类：**基础设施故障，
  由调用形态诱发**——19-32 轮长会话意味着 19-32 次撞 provider 出错的机会窗口。
- **run2**：fix 阶段被（已废止的）20 分钟死线 SIGKILL——与材料无关，但同根于
  「会话负载无度量、无控制」。

### 2.3 根因分析

「reviewer 自主拉料」继承自 pi 同构（pi 仓 `buildReviewInstruction` 同款指令文本，
`xyz-agent-workspace/dev-0.9.11/.../review-fix-loop-utils.cjs:66`）。pi 的效率路线图
（`docs/todo/review-fix-loop-efficiency/` tier 1-3）做了仪表化、跨轮 prompt 前缀缓存
稳定化、verify 阶段——**但没有任何一项解决「跨 reviewer 重复拉料」与「会话内探索
轮次」**。zsw 的 GLM 真机环境（大分支、3 并发）先撞上了这堵墙。

### 2.4 与 pi 的关系（parity 声明）

本设计是 **deliberate fork**：pi 原版及效率路线均维持「指令驱动 + 自主探索」。fork
理由：zsw 的运行环境（GLM provider、真机大分支 dogfooding）实证了该形态的不稳定，
且材料注入与 pi tier-2（前缀缓存稳定化）互补不冲突——注入后材料位于 prompt 静态
段，base 已锁定，跨轮逐字节稳定，反而为前缀缓存铺路（见 D5）。实施时在
`docs/research/zsw-vs-pi-subagent-workflow-parity.md` 登记偏差条目（T6）。

## 3. 解决方案

**本章结论**：宿主预取材料 + wrapUntrusted 包裹注入 prompt + 尺寸护栏（超阈值按
文件分组、显式声明截断面），深查能力保留；维度→文件映射分片经评估否决（漏审风险）。

### 3.1 终态（使用者视角）

**成功路径**（git-diff 型，本仓规模分支）：

```
$ node bin/zsw.js workflow --workflow review-fix-loop \
    --target-type git-diff --target main \
    --reviewers "arch-boundary,concurrency,business-logic,mcp-contract,test-coverage" \
    --max-rounds 3

# 宿主日志（stderr）：
[zsw] 材料：git diff main...HEAD 锁定 base 65f42f7，9991 行 / 707KB → 全量注入
[zsw] batch1: starting x5
# reviewer prompt 新结构（注入后）：
#   ## 任务背景 ...
#   ## 审查材料（宿主预取 git diff 65f42f7...HEAD 全量，含未提交工作区改动）
#   <untrusted source="review-diff"> ...9991 行 diff... </untrusted>
#   ## 你的职责 只从本维度焦点审查上述材料；无需再执行 git diff——材料已完整；
#     需要 diff 外上下文时可 Read 任意文件（如被改函数的调用方）。
#   ## 输出格式 ...（json 围栏契约不变）
# 每会话 3-8 轮内输出结论；全批墙钟进入个位数分钟。
```

**失败路径与恢复指引**：

- 预取失败（base ref 不存在 / 非 git 目录）→ run 启动即 fail-fast，可操作错误：
  `git diff base...HEAD 预取失败（<stderr 摘要>）。恢复指引：确认 target 是有效
  ref（git rev-parse <target>）或改用 targetType=text`。
- 材料超尺寸 → 走 D2 护栏（分组注入 + 显式声明），**绝不静默截断**。

### 3.2 多方案对比

| 候选 | 长期架构合理性 | 短期实现成本 | 风险 | 结论 |
|------|---------------|-------------|------|------|
| **A 宿主预取全量注入** | 高：消除 ×5 重复与探索轮，材料静态化利于缓存 | 中：prompt 构建 + 护栏 + 测试 | 超大 diff 超 prompt 预算 / 长材料注意力稀释 | **推荐基座** |
| **B 维度→文件映射分片** | 中：进一步降载，但映射是启发式 | 中：映射表 + 覆盖性验证 | **漏审**：文件→维度归属不可由路径判定（同一处改动可同时属 business-logic 与 concurrency），错分 = 该维度永远看不到 | 否决映射；其「分组」思想并入 A 的尺寸护栏 |
| **C 两阶段（摘要定位→深查）** | 低：新增 LLM 阶段 = 新故障点 + 信息瓶颈（摘要丢细节，审查质量取决于摘要质量） | 高 | 摘要遗漏 = 全体 reviewer 集体漏审 | 否决 |
| **D 现状（自主探索）** | —— pi 同构 —— | 0 | 已实证：不稳定、慢、贵 | 否决（对照组） |

**若用被否方案会怎样**：用 B——§2 的本仓例子中 `review-fix-loop.js` 的一个函数拆分
会被映射给 business-logic，而其中 abort 检查点传播问题属 concurrency——映射表二选一
必漏一个维度；用 C——聚合摘要漏掉某条 wrapUntrusted 包裹细节，5 个 reviewer 集体
不知情，假 clean 比 runFail 更危险。

### 3.3 关键决策与权衡

- **D1 预取时机与 base 锁定**：run 启动时预取一次，用既有 `lockedBase`（base hash
  锁定，v2 已实现）执行 `git diff <hash>...HEAD` + `git status --porcelain` + `git diff`
  （未提交工作区改动并入材料，覆盖 autoCommit=false 的 fix 半成品可见性——保留现
  指令的语义）。被否：每轮预取（材料跨轮漂移，破坏 D5 稳定性）。R2+ 复检轮不重取
  ——base 锁定下 diff 主体不变，fix 后的变化经既有 `recheckScope` / `fix-response`
  段注入，职责不混。
- **D2 尺寸护栏**：阈值 = 材料总字符 > 1.5MB（约 40 万 tokens，为 GLM 上下文留 ≥4
  倍余量）。超阈值 → 按文件字典序分组注入：每个 reviewer prompt 含**全量文件级
  stat 清单**（文件名 ± 行数，明确标注「以下文件 diff 未注入，可 Read 深查」）+
  分到本 reviewer 的文件组全量 diff（组数 = reviewer 数，轮转分配）。被否：任意
  字符截断（静默丢材料 = 假审查）；阈值硬编码不可配（v1 不加参数，YAGNI——实测
  需要时再加）。⛔实施期门：阈值合理性用本仓 707KB（不触发）+ 构造 2MB 仓库
  （触发）两个夹逼用例验证。
- **D3 防注入包裹**：diff 内容是不可信上游产出（代码里可能藏指令文本），注入必须
  过 `wrapUntrusted(material, 'review-diff')`（D10 三层防御第 1 层既有机制，零新增
  代码路径）。⚠️ 注意 diff 中的 `+` 行可能包含 `</untrusted>` 字面量——wrapUntrusted
  的闭合标签转义已覆盖（测试既有）。
- **D4 深查能力保留**：prompt 明示「材料已完整，无需 git diff；可 Read 任意文件」。
  探索能力的减法只删「重复拉已注入材料」的轮次，不删「看 diff 外上下文」的能力
  （G3）。
- **D5 R2+ 材料段稳定**：材料段在 prompt 中的位置固定于任务背景之后、职责段之前，
  且内容跨轮逐字节相同（base 锁定保证）——与 pi tier-2「前缀稳定化」同向，为
  provider 前缀缓存铺路。轮次号、对账清单等变化内容维持在材料段之后（尾部动态段）。
- **D6 targetType 兼容矩阵**：

  | targetType | 材料行为 |
  |------------|---------|
  | git-diff | 预取 diff（锁定 hash）+ 未提交工作区改动，全量注入（超阈值走 D2） |
  | file | 宿主读该文件全文注入（同 wrapUntrusted）；文件不存在 fail-fast |
  | dir | 宿主列目录树（深度上限 3 层）注入清单；reviewer Read 深查 |
  | text | **零变化**：不预取不注入，指令文本原样（自由审查语义，G4） |

- **D7 观测**：phase 记录（state.json rounds）补 `materialChars` 与 `materialTruncated`
  字段——呼应 pi tier-1 仪表化方向，为后续阈值校准提供数据。⛔实施期门：真机 run
  的 state.json 抽查字段在位。

## 4. 验收

**本章结论**：以本仓分支（9991 行 diff）真机单轮为主场景，五个场景回溯 §1 全部目标。

| # | 验证场景（真实，非 mock） | 步骤 | 通过标准 | 回溯 |
|---|---------------------------|------|----------|------|
| 1 | **大 diff 真机审查**：对 fix-review-fix-loop 分支跑 review-fix-loop 单轮（maxRounds=1，5 维） | 真机 run（真实 GLM、真实无头 zcode），读 phases usage 与 loop.status | 零 runFail/parseFail；单 reviewer modelRequestCount ≤8；input tokens 较 2026-08-29 基线（95-200 万）降 ≥60%；墙钟 ≤8 分钟 | G1 G2 |
| 2 | **注入完整性与防注入** | 脚本校验：落盘的 reviewer 原始报告（runDir/batch-1/round-1/<reviewer>.md）中材料段内容与 `git diff <hash>...HEAD` 产物逐字节一致（剥 wrapUntrusted 标签后 diff 校验）；材料段被 `<untrusted source="review-diff">` 包裹 | 逐字节一致 + 包裹在位 | G3 |
| 3 | **深查能力存续** | 场景 1 的真机报告中人工核验：至少一个 reviewer 引用了 diff 之外的上下文（如调用方代码行号/文件），证明 Read 深查未被注入模式废掉 | ≥1 处 diff 外引用（或报告明示无需深查的理由） | G3 |
| 4 | **text 型零回归** | 既有单测全绿 + 一次 text 型真机 run 的 prompt 快照对比 | prompt 结构与 main 基线一致（无材料段） | G4 |
| 5 | **护栏与 fail-fast** | 构造 2MB diff 的临时仓库触发 D2；构造不存在 base ref 触发预取失败 | 护栏：全量 stat 清单在位 + 截断面显式声明 + 各 reviewer 分组无遗漏（组并集 = 全部文件）；预取失败：可操作错误含恢复指引，零 record 副作用 | G1（fail-fast 面）|

单测（实现层回归，非验收主体）：预取逻辑 / 注入格式 / 护栏分组 / text 回归 /
wrapUntrusted 转义，随 T1-T5 各任务交付。

## 5. 下一层拆分

| # | 单元 | 内容 | 文件 | justification（为何独立成单元） |
|---|------|------|------|------|
| T1 | 材料预取器 | `prefetchReviewMaterial(targetType, lockedBase, workdir)`：git-diff/file/dir 三型预取 + fail-fast 错误 | `lib/workflow/review-fix-loop.js`（编排层新函数，utils 不动——预取有 I/O，vendor 纯函数层禁入） | 纯输入面，可独立单测（临时 git 仓库夹逼） |
| T2 | prompt 注入 | buildReviewPhasePrompt 的「审查范围」段改为「审查材料」段（wrapUntrusted 包裹 + 职责段指令改写「无需 git diff，可 Read」） | 同上 + prompt 五段组装函数 | 与 T1 解耦：注入格式变化不影响预取 |
| T3 | 尺寸护栏 | 阈值判定 + 文件分组 + stat 清单 + 截断声明 | 同上 | 独立算法面（分组确定性可表驱动测试） |
| T4 | file/dir 型 + 观测 | D6 矩阵的 file/dir 行为 + materialChars/materialTruncated 落 state | 同上 + record 结构 | 小面收尾，独立验收（场景 5 部分） |
| T5 | 测试与 e2e | 单测四组 + e2e 真机场景 1-5 脚本化（复用 test/e2e.test.js 形态） | `test/` | 与实现分离，修前红修后绿纪律 |
| T6 | parity 登记 | `docs/research/zsw-vs-pi-subagent-workflow-parity.md` 增 deliberate fork 条目（材料注入，含与 tier-2 互补关系） | docs | 流程动作，防 parity 文档漂移 |

**实施顺序**：T1 → T2 → T5（场景 1/2/4 可验）→ T3 → T4 → T5 补（场景 3/5）→ T6。
T1+T2 落地即可解锁本分支 pr-cr-fix 阶段 2 的重跑（主诉求），T3/T4 为护栏完备性。

**待验证检查点**（诚实清单）：① 1.5MB 阈值对 GLM 单 prompt 的实际边界（实施期
夹逼）；② 长材料注意力稀释是否可观测（场景 1 的结论质量对照 run1/run2 既有报告
人工比对一次）；③ 未提交工作区改动并入材料的尺寸（autoCommit=false 的 fix 半成品
可能大，超阈值时与已提交 diff 同一护栏路径）。
