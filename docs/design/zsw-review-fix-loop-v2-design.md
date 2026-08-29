# zsw review-fix-loop v2：对齐 pi 版质量内核 — 技术设计

> **一句话结论**：把 pi 版 review-fix-loop 的质量内核（LLM 聚合裁决、跨轮 ID 对账、批次依赖、收敛检测、state 落盘）以「纯函数整批 vendor + 聚合 phase 新增 + 参数面对齐」的方式移植进 zsw，同时保持现有调用方式零回归；低风险项（stuckThreshold 参数化、/zsw command）随行。

**层性质声明**：当前层 = 技术方案设计；下一层 = 可实现的代码任务（接口/数据模型/状态机已定到可实现粒度）。

## 1. 背景目标

### SCQA

- **S（情境）**：zsw 的 review-fix-loop 是 pi 版的简化移植——循环骨架（并行 review → 聚合 → fix → 重审）已对齐，skip-clean 语义已修复（commit 9069acc）。
- **C（冲突）**：简化时丢掉了 pi 版的质量内核：无 LLM 聚合裁决（审查噪声直进修复队列）、无跨轮 ID 对账（修没修对全靠下一轮全量重审发现）、无批次依赖（前置检查场景表达不了）、无 state 落盘（过程不可观测）、stuckThreshold 硬编码。
- **Q（问题）**：审查-修复循环的**结论可信度**（噪声不降）与**收敛可控性**（停滞/复发不可判定）不足，使用者必须人工消化噪声、人工判断该不该继续跑。
- **A（答案）**：本设计——整批移植 pi 版已验证的状态机纯函数，新增 LLM 聚合 phase 与 state 落盘，参数面与 pi 对齐；无 ajv 的可靠性缺口用「JS 聚合降级链」兜底。

### 系统是什么（受众补认知）

zsw 是 zcode 的外部进程插件（CLI `zsw` + 常驻 daemon），`zsw workflow --action run --workflow review-fix-loop` 启动审查-修复循环：每个「审查者」（correctness/robustness 等视角名）是一个无头 zcode 会话（spawn 子进程），输出含 json 围栏的审查报告；聚合后把 must-fix（critical/major）喂给修复者会话；循环到全 clean 或熔断。pi 版是同一循环的进程内实现（xyz-agent 仓），经过 PR #193 等真实场景打磨，其状态机纯函数（对账/收敛/降级）抽取在 `review-fix-loop-utils.cjs`，无框架依赖。

真实使用样例（现状）：

```bash
node bin/zsw.js workflow --workflow review-fix-loop \
  --task "审查本分支变更" --workdir /path/to/repo \
  --reviewers "correctness,robustness,security" --max-rounds 5
```

### 设计目标（使用者体验倒推）

| # | 目标 | 使用者体验 |
|---|------|-----------|
| G1 | 审查噪声被裁决消化 | 臆测/无证据条目在聚合时降级，不进修复队列，不浪费 fix 轮次 |
| G2 | 修复效果可对账 | R2 起每条上轮 issue 有 fixed/not-fixed/regressed 判定，复发即升级处理 |
| G3 | 前置依赖可表达 | 静态检查等前置批次先跑完，后续审查批才有意义 |
| G4 | 过程可观测 | run 目录有 state.json + 各轮报告，结束后可回答「每轮发生了什么、为什么终止」 |
| G5 | 参数面与 pi 一致 | pi 用户零学习成本（stuckThreshold/converge*/maxFixAttempts 等同名同默认值） |
| G6 | 老调用参数兼容 | 老命令行（--reviewers/--review-target）仍被接受、正常完成出报告；语义差异有清单可查（见 §4.1） |
| G7 | 入口可发现 | GUI 里 /zsw 命令引导到编排 skill |

### In / Out of scope

**In**：批次（batchN）+ 跨批 skip；LLM 聚合 phase（裁决/降级/guidance）+ JS 聚合降级链；reviewer 输出契约扩展（reconciliation/suggestion 计数）；对账/收敛/needs-redesign 状态机；state 落盘与 run 目录布局；targetType/target + base 锁定；stuckThreshold/maxRounds/收敛参数；aggregatorModel 降档；fallowScan 前置批；autoCommit（默认 false）；修复范围全等级对齐；/zsw command。

**Out**（依据对比文档 4.2/5 节，本次不做）：fixAgent 与 agentRef systemPrompt 注入（待无头 CLI 参数探针）；thinkingLevel/usage 透传（同前）；内置 agent 角色集；workflow 脚本 parallel/pipeline 原语；scores 打分 rubric（pi 侧也标注「可选、尚未落地」的弱信号，等真实需求）；GUI 面板类（平台不可行）。

## 2. 现状与问题分析

### 2.1 使用者视角的现状与真实失败模式

结论先行：现状有五个真实失败模式，全部源于质量内核缺失，其中前两个（噪声、修复黑盒）直接消耗 fix 轮次与使用者人工判定成本。以下模式源自 xyz-agent 仓 PR #193 的 review-fix-loop run2 等真实场景（pi 版机制在场的对照见括号）：

1. **噪声直进修复队列**：reviewer 报「可能存在竞态」类无证据条目（severity=major），zsw 聚合只做标题归一去重——该条直接成为 must-fix，fixer 花一轮去「修复」一个不存在的问题。（pi 版：aggregator 裁决 adjudication=downgraded，条目保留在报告但不进修复队列。）
2. **修复效果黑盒**：fixer 声称「已修复」，下一轮 reviewer 若换种说法重报同一问题，zsw 无法识别是「同一问题没修好」还是「新问题」——只能靠 must-fix 计数停滞（连续 2 轮不降）粗粒度熔断。（pi 版：R2 起 reviewer 输出 reconciliation 表，逐条对账 fixed/not-fixed/regressed/escalate。）
3. **前置检查表达不了**：用户想「先跑 fallow 静态分析，再跑语义审查」——zsw 只有一个扁平 reviewers 列表，表达不了先后依赖，只能分两次手工 run 并人工衔接。（pi 版：batch1/batch2 串行 + 跨批 clean skip。）
4. **过程不可观测**：run 结束只有一份 outputs/<runId>.md 报告；「第 3 轮为什么终止」「哪些 issue 被降级过」无处查证。（pi 版：state.json + runDir 各轮报告落盘。）
5. **参数不可调**：stuckThreshold 硬编码 2（pi 默认 3 且可调）；maxRounds 默认 5（pi 默认 10）。

### 2.2 根因分析

移植时把 pi 版 677→1400 行的实现压缩到 ~280 行，保留的只是**循环骨架**（并行/聚合/修复/重审）；被裁掉的部分恰好都是**质量与可观测机制**，且裁剪没有架构必然性——它们是纯编排层状态机 + 一次额外的 LLM 聚合调用，zsw 的执行原语（spawn 无头会话 + json 围栏提取）完全承载得了。唯一的真差异（无 ajv 引擎级 schema 校验）影响的是输出契约的可靠性，可以用降级链管理，而不是放弃语义。

### 2.3 物理数据流（现状 → 终态）

```
现状：
CLI 调用 → WorkflowManager.start（record: ~/.zcode/zsw/records.jsonl）
  → runReviewFixLoop 每轮：spawn 无头 zcode ×N（并发 3）
      reviewer stdout → json 围栏提取（内存）→ JS 标题归一去重（内存）
      → fix spawn → git diff 实测 →（内存状态，run 结束即蒸发）
  → 报告落 ~/.zcode/zsw/outputs/<runId>.md → task-notification 唤醒

终态（新增/变更加粗）：
CLI 调用 → WorkflowManager.start（record 不变）
  → **批 1..N 串行**，批内每轮：spawn reviewer ×N
      reviewer stdout → json 围栏提取（**扩展契约**）→ **落盘 <runDir>/batch-i/round-j/<reviewer>.md**
      → **聚合 phase spawn（aggregatorModel）→ aggregated.md 落盘 + 裁决降级**
      → 对账/收敛状态机（**纯函数，内存 + state.json 落盘**）
      → fix spawn → git diff 实测 → **state.json 原子落盘**
  → 报告 outputs/<runId>.md（不变）+ **state.json 指针** → task-notification 唤醒
```

runDir 位置见 §3.3 决策 D4。

## 3. 解决方案

### 3.1 终态（使用者视角）

**成功路径**（多批次 + 噪声裁决 + 对账收敛的一次 run）：

```bash
node bin/zsw.js workflow --workflow review-fix-loop \
  --task "审查 PR：重构 auth 中间件" --workdir /path/to/repo \
  --target-type git-diff --target main \
  --batch1 "correctness,security" --batch2 "security,performance" \
  --stuck-threshold 3 --aggregator-model glm-5.3-flash
```

- 批 1（correctness/security）先跑；批 1 clean 后批 2（security/performance）才启动；security 在批 1 已 clean 且批 1 无 fix → 批 2 跨批跳过（只派 performance）。
- R1：correctness 报 3 条（其中 1 条无证据臆测）；聚合裁决后 aggregated.md 中该条 `adjudication: downgraded`，修复队列只含 2 条活跃条目。
- R2：reviewer 输出 reconciliation 表（1 fixed、1 not-fixed）；state.json 中 issue MF-2 状态 `fix-attempted → regressed`，fixAttempts+1。
- R3：全 clean 且 suggestion 归零 → terminated=clean；报告含「轮次摘要 / 每轮维度明细 / 修复说明 / runDir 指针」。
- 任意时刻：`cat ~/.zcode/zsw/rfl/<runId>/state.json` 可回答每轮每维度发生了什么。

**失败路径与恢复**：

| 失败 | 表现 | 恢复指引 |
|------|------|----------|
| 聚合 phase 输出不可解析 | 日志 WARN「aggregator fallback to js-dedup」，该轮按 D1 fallback 规格降级（标题匹配对账、无裁决、aggregated.md 合成并标注 degraded），循环继续 | 无需动作；连续 2 轮 fallback 后改用 `--aggregator-model` 传更强模型重跑 |
| 任一 reviewer 输出无效（parseFail）或执行失败（runFail） | review-failed 结构化终止（对齐 pi，D3），报告指明 reviewer 名与原因 | 按报告指引检查 reviewer 焦点名拼写 / 调大 `--timeout-per-phase`，重跑 |
| 无头会话超时/崩溃 | 现有 runFail 单列路径不变（review-failed） | 调大 `--timeout-per-phase` 重跑 |
| stuck / needs-redesign | terminated=stuck / needs-redesign，报告列残留 ID 与修复历史 | 人工判定残留条目（真问题→改需求或人工修；误报→反馈 reviewer prompt） |
| abort | 现有 AbortSignal 契约不变（abortedAtPhase） | 按 CLI abort 指引 |

**/zsw command**（G7）：GUI 输入 `/zsw 后台审查这个分支` → command 模板引导加载 zsub-zflow-orchestration skill 按纪律走 CLI。

### 3.2 方案对比（主轴：质量内核怎么补）

#### 方案 A：pi 语义整批移植（推荐）

纯函数（reconcileIssues/checkConvergence/findNeedsRedesign/computeKnownRemaining/recordDormant/filterActiveIds/shouldSkipAgent/recordAgentClean/recordAgentDirty/updateStuckState/normalizeFixResult/validateFixResult/findIssueKey/wrapUntrusted，共 14 个纯函数，pi 仓 `workflows/review-fix-loop-utils.cjs`）vendor 进 zsw；新增 LLM 聚合 phase（spawn + json 围栏提取 + JS 聚合降级链）；reviewer/fixer 输出契约扩展；state 落盘。

| 维度 | 评估 |
|------|------|
| 长期架构合理性 | **高**：与 pi 语义零分叉，用户跨引擎心智一致（本设计根本目标）；pi 侧后续打磨可 diff 同步；状态机已有真实场景验证（PR #193 等） |
| 短期实现成本 | 中：vendor 函数近零改动（剥离 `$ARGS` 等宿主耦合）；编排改造集中在 review-fix-loop.js 主循环（批次外环 + 聚合调用点 + 落盘点）；CLI/schema/docs 同步。估算净增 ~800 行 |
| 风险 | 无 ajv 下聚合/reviewer 契约遵循率不确定 → 降级链兜底（fallback 路径 = 现状行为，最坏不劣于今天）；真机遵循率是待验证检查点（§5） |

#### 方案 B：zsw 原生轻量增强（被否）

不做 LLM 聚合（JS 去重 + 冲突标记），对账简化为计数式（issue 标题连续 K 轮重现即 stuck），无 dormant/裁决，无 suggestion 全等级修复。

| 维度 | 评估 |
|------|------|
| 长期架构合理性 | **低**：与 pi 形成两套语义，违背「完全对标」目标；pi 侧演进无法同步 |
| 短期实现成本 | 低（~300 行） |
| 风险 | §2.1 失败模式 1/2 原样存在：臆测条目无裁决通道——按 B 实现，PR #193 式场景（noise must-fix 让 fixer 白跑、循环多 1-2 轮）会以同一形态回归，等于只修了可观测性没修可信度 |

**推荐 A**。B 的唯一优势是省 ~500 行与一次额外 LLM 调用/轮（聚合），但它放弃的恰是本设计的根本目标（G1/G2）。

### 3.3 关键决策与权衡

- **D1 聚合机制：LLM 聚合 + JS 聚合降级链**（被否：纯 JS 增强，见方案 B；被否：双阶段 LLM 聚合[先去重再裁决]——多一次调用无证据收益）。✅ 机制探针已存在：subagent 面 schema 注入即此模式（`lib/prompt-builder.js:43-52` + `lib/manager.js:557-568` 提取校验），workflow 面直接复用 buildPrompt。**注意**：JS fallback 是 zsw 特有降级层——pi 无此层（pi 链 = LLM JSON → aggregated.md 文本解析 → aggregator-failure 结构化终止，pi :849-875）；zsw 加它是因为无头会话无 ajv 兜底、直接终止过于脆。**fallback 轮完整规格**（防半状态机数据不一致）：
  - aggregated.md 由 workflow 用 JS 聚合结果合成落盘，头部标注 `degraded: js-dedup`；
  - **ID 键空间保持 MF-N 单一权威**：JS 聚合去重后逐条与 state.issues 已有条目做标题归一匹配（复用 dedupKey 语义）——命中沿用既有 MF id（视为同一问题），未命中编新 MF-N。fix 队列照常建立（v2.1 D3a 收紧：只收 critical/major，minor 走 suggestion 明细通道，不进队列），fix-attempted/对账链路不断；
  - 无裁决数据 → 该轮**跳过** dormant 记录与 adjudication 相关转换（不造假数据），其余状态机（fix-attempted、标题匹配对账、stuck 计数）照常；
  - suggestion 计数从各 reviewer 契约的 `suggestion_count` 汇总（不依赖聚合输出）；
  - 该轮 state.batches[].rounds[] 记 `degraded: true`，报告轮次摘要注明「降级模式」。
- **D2 reviewer 输出契约扩展**（json 围栏内新增 `suggestion_count` + `reconciliation[]`，对齐 pi reviewerSchema 的字段语义；被否：维持现状契约——则对账与全等级终止都无数据源）。R1 reconciliation=[]（pi 同款，避免轮间契约分叉）；R2+ 每条上轮活跃 issue 必须有条目。
- **D3 parseFail/runFail 语义：任一 reviewer 无效即 review-failed 结构化终止（对齐 pi :728-793，R1 与 R2+ 一致）**（被否：v1 的「部分失败容忍、parseFail 按 clean 处理并告警」——v1 无对账时按 clean 无害，v2 有对账后 reconciliation 缺失会被状态机误读为「未重报 = 已修复」，制造假收敛；被否：仅全员失败才终止——单个无效 reviewer 的缺席让聚合口径不完整，继续跑等于用残缺结论驱动 fix）。终止报告指明失败的 reviewer 名与原因（runFail=CLI 崩溃/超时，parseFail=输出无有效 json 围栏；v2.1 D3c 起围栏解析成功的契约缺失/矛盾输出同计 parseFail——status 缺失或非法、issues 非数组、status=clean 而含有效条目、suggestion_count 缺失/显式 null/不可数值化、title 全畸形、status=issues 而有效条目为 0）。此为 v1→v2 行为差异（见 §4.1）。
- **D4 state 布局：`~/.zcode/zsw/rfl/<runId>/`，runId 由 WorkflowManager 注入**（被否：照抄 pi 的 `~/.review-fix-loop/<repo-slug>/<runId>/`——zsw 全部运行数据统一在 `~/.zcode/zsw/` 数据根（CONTEXT.md 命名 SSOT），另开根违反本仓一致性惯例；被否：塞进 outputs/ 单文件——报告与状态是两种生命周期：报告只读消费、状态会被后续工具查询/续跑）。**接口改动**：runId 现由 WorkflowManager.start 生成（`lib/workflow-manager.js:210`）但不传入 workflow 入口（`_invokeEntry` 只传 workflowParams/task/workdir/model/signal，:429-435）——v2 在 `_invokeEntry` 的调用参数中新增 `runId` 字段注入（对不认识该字段的 workflow 无害，属透传参数面扩展）；record 的终态 transition patch（`_finalize` :493-499）增加 `runDir` 字段（review-fix-loop 在返回结果中带出 runDir，manager 落进 record）。目录内：`state.json`（tmp+rename 原子写）+ `batch-<i>/round-<j>/` 子路径下的 `<reviewer>.md`、`aggregated.md`、`fix-result-<round>.json`（轮产物统一挂 batch/round 两级子目录）。报告与 record 增加 runDir 指针字段。
- **D5 参数兼容：batchN 新增，reviewers 降级为单批 sugar**（被否：破坏性移除 reviewers——违反 G6 参数兼容）。无 batchN 时 `reviewers` 包装为 `[reviewers]` 单批；`--review-target <text>` 等价 `--target-type text --target <text>`；**全缺省映射**：target 系参数一个都不传 → `targetType=text`、`target='git 未提交改动'`（v1 缺省文案）；新参旧参同时传时新参优先并 WARN 一行。maxRounds 默认 5→10、stuckThreshold 默认 3（对齐 pi 值；被否：保留 5/2——G5 要求与 pi 一致，且 pi 值经真实场景校准）。**成本披露**：名义调用上限约为 v1 同维度的 3-4 倍（maxRounds ×2、每轮 +1 聚合调用、批次数乘数、全等级修复延长轮次），skip-clean 生效时实际增量约 1.5-2 倍；成本敏感场景显式传 `--max-rounds 5`。
- **D6 修复范围全等级对齐**（fix prompt 喂 must-fix 优先 + suggestion 附带——明细数据源 = 各 reviewer 契约的 minor issues 按 dedupKey 去重汇总，聚合契约的 suggestion 仅为计数；成功类终止要求 suggestion 也归零——pi 头注与 :801/:1100 明确此语义；被否：保留「minor 不阻塞」——pi 语义是「must-fix 只是终止条件、不是修复范围」，保留旧语义会让建议级问题在收敛出口被静默漏修）。成本：fix 轮平均多处理 1-3 条 minor（计入 D5 成本披露）；换取语义一致。
- **D7 fallowScan / autoCommit / aggregatorModel 随行**：fallowScan=true 仅 git-diff 合法（fallow 安装探测与 audit 执行都由前置批无头会话自己完成——workflow 只规定审查范围与步骤，不做进程内探测；未安装则该批记 clean 并注明）；autoCommit 默认 false（fix prompt 按 flag 注入 commit 指令，对齐 pi 的显式路径 stage 纪律）；aggregatorModel 缺省 = run model（降档是可选项不是默认）。
- **D8 /zsw command**：`commands/zsw.md`（frontmatter：description/argument-hint/skills——skills 键使平台自动挂载 zsub-zflow-orchestration，不依赖正文 prose 的模型自觉；正文保留引导与纪律）+ plugin.json 增 `"commands": "commands"`。✅ 格式已验证：官方 android-emulator 插件同款（commands/*.md + manifest 声明 + skills frontmatter）。
- **D9 嵌套与隔离不变**：聚合 phase 走现有 runPhase（prepareRunEnv 隔离 HOME + ZSW_NESTED），无新进程形态。
- **D10 防注入（对齐 pi wrapUntrusted 三层防御第 1 层）**：vendor `wrapUntrusted`，并规定**全部**上游 LLM 产出嵌入下游 prompt 的通道必须过 wrap。按**通道**枚举（各通道覆盖该通道内全部自由文本字段，防清单式遗漏）：
  1. **reviewer → 聚合 phase**：issues JSON 全字段（title/detail/evidence/reconciliation）；
  2. **聚合 → fixer**：must-fix 条目全字段（含 evidence/guidance）+ fixes_caution；
  3. **reviewer/聚合 → state → 下轮 reviewer**：known-remaining、dormant、修复说明段；
  4. **fixer → 下轮 reviewer**：修复结果（description/self_check）+ 受影响文件清单（`affected_files`，v2.1 D7 起经 state.fixImpactFiles 进 scoped 复检 prompt 的改动文件段——同为 fixer 产出，v2.1 终审补枚举）；
  5. **用户自定义参数**：review-prompt/fix-prompt。
  理由：这些内容是模型产出，含 ``` 围栏或 markdown 标题即可逃逸契约结构（「漏转义 = 标签逃逸 = 围栏失效」）；通道 1 的逃逸会直接推高聚合 parseFail 率、把 fallback 变常态。

### 3.4 接口与数据模型（下一层实现规格）

**CLI 参数面（终态全集）**：`--target-type <git-diff|file|dir|text>`、`--target <t>`（新参二选一，或沿用 `--review-target` sugar；全缺省映射见 D5）、`--batchN "a,b"`（N≥1，缺号报错；或 `--reviewers` 单批 sugar）、`--batch-names "a,b"`（批次命名，数量校验，缺省 batch-1..N）、`--max-rounds 10`、`--stuck-threshold 3`、`--skip-clean-agents true`、`--recheck-after-fix false`、`--converge-new-issues 1`、`--converge-rounds 2`、`--max-fix-attempts 2`、`--aggregator-model <ref>`、`--review-prompt`、`--fix-prompt`、`--fallow-scan false`、`--auto-commit false`。未知参数名报错并列合法清单（对齐 pi 白名单校验，防 batchX 拼错）。

**reviewer 输出契约**（json 围栏内）：

```json
{ "status": "issues|clean",
  "issues": [{ "id": "A1", "severity": "critical|major|minor", "title", "detail", "file" }],
  "suggestion_count": 0,
  "reconciliation": [{ "prev_id": "MF-1", "status": "fixed|not-fixed|regressed|escalate", "evidence": "…" }] }
```

**聚合输出契约**（聚合 phase json 围栏内，对齐 pi aggregatorSchema 语义；title 为 zsw 增补字段——ID 对齐的标题匹配、aggregated.md 表格与 fix 队列都依赖它）：

```json
{ "must_fix": 2, "suggestion": 1,
  "must_fix_ids": [{ "id": "MF-1", "severity": "major", "title": "问题标题", "files": ["a.js"], "evidence": "…",
                     "guidance": "一行修复方向", "adjudication": "evidence|unverified|downgraded", "note": "降级理由" }],
  "fixes_caution": ["高危条目提醒"] }
```

聚合输入策略：reviewer 契约本身是结构化 issues 内联（无报告正文），聚合输入 = 各 reviewer 提取后的 issues JSON + 计数字段——不存在 pi 的「正文双份付费」问题（pi :760 W6），无需 read-file 通道。**ID 对齐（LLM 与 JS 两路径同规）**：R2+ 聚合输入附加 state.issues 当前活跃条目清单（id + title + severity），prompt 指示同一问题沿用既有 MF id；聚合输出侧**不信任** LLM 编号——统一经归一后处理（findIssueKey/dedupKey 语义：与既有条目匹配则沿用其 id，未匹配才从 state 计数器分配新 MF-N），**MF id 分配以 state.issues 为单一权威**。JS fallback 路径的标题匹配（D1）是该后处理的子集，两路径共用同一实现。deferred 条目计入 R2+ 对账清单注入（escalate 通道的触发面就是对 deferred 条目的声明；reconcileIssues 对 deferred 的 seen/not-fixed 天然免疫，注入不产生误转换）。

**fixer 输出契约**（json 围栏内，对齐 pi fixSchema 语义；正文同时保留 `## 修复结果` markdown 段供人读）：

```json
{ "fixed_count": 2,
  "fixes": [{ "issue_id": "MF-1", "description": "一行修法", "self_check": "grep 命令 + 命中数 + 动作", "affected_files": ["a.js"] }],
  "deferred": [{ "issue_id": "MF-3", "reason": "具体成本描述（≥20 字）" }] }
```

fix 结果经 normalizeFixResult 归一 + validateFixResult 硬校验（vendor，同 U3）：deferred 只允许 minor（vendor 逐字保留 pi 源，对追踪表无此 ID 的自报条目另容忍 trivial——编排层对未追踪 defer 一律按 minor 建条目，效果等同）、活跃 must-fix 必须全进 fixes[]（ID 经 findIssueKey 归一匹配，容忍大小写/尾注漂移）——违规即 fix-failure 终止。fix-attempted / deferred 状态、knownRemaining 由此契约驱动（v1 的自由 markdown 输出撑不起 ID 级状态机，此契约为 U3 状态机的数据源）。

**escalate 映射**：reconciliation.status=escalate（deferred 条目上下文被本轮 fix 改变）→ state.issues 该条目 status 转 `open`（回到对账清单可见面；回修路径 = 经下一轮 reviewer 重报 → 聚合进修复队列，见 v2.1 D2——并非直接塞进 fix 队列）+ openStreak 重置 0，fixAttempts 不变（pi reconcileIssues 同语义，vendor 实现原样）。

**aggregator-failure 触发条件**：仅当 JS fallback 自身异常（聚合后处理抛错、无法产出 must_fix 计数）才到达该终态——LLM 聚合 parseFail 与聚合 phase 执行失败（runFail）都不触发（两者都走 D1 降级链：聚合 runFail 的 WARN 会注明「聚合阶段执行失败」）。终态枚举保留它作为降级链完全失效的最后出口。

**state.json 字段**（对齐 pi freshState，zsw 特有字段标注）：`meta{runId, workdir, targetType, target, batches, batchNames, baseHash, startedAt, terminated}`、`agentStatus{}`、`fixCount`、`batches[{index, rounds[{round, startedAt, finishedAt, mustFix, suggestion, degraded?, agents[], modifiedFiles, phaseTimings{review, aggregate?, fix?}}]}]`、`issues{id→{firstSeen, title, severity, status(open|fix-attempted|fixed|regressed|deferred), history[], fixAttempts, openStreak, guidance?, evidence?}}`、`dormant[]`、`knownRemaining[]`、`convergeStreak`、`lastModifiedFiles[]`、`fixImpactFiles[]`（v2.1 D7：批内累积的 fixer 自报 affected_files 并集，批启动重置）。zsw 特有：`abortedAtPhase`（AbortSignal 契约）。rounds 带 startedAt/finishedAt（S1 批次时序验收的数据源）、`phaseTimings`（v2.1 D8：各相位 Date.now 差值毫秒，未执行相位为 null）与 skipped（本轮被跨维/跨批跳过的维度，S4 可证数据源）。issues 条目另含 `lastActiveRound`（R2+ 活跃清单注入的历史元数据）与 `deferredReason`（knownRemaining 的「ID: reason」格式必需）。

**terminated 权威源**：`state.meta.terminated`（每次 saveState 快照落盘；运行中为 null，仅结构化终止时置终值——崩溃窗口「未终止」语义诚实）为唯一权威；返回结果的 `loop.status` 与 record 终态均由它派生。崩溃窗口内 state 可能落后于实际进度（逐轮落盘已尽力覆盖），恢复语义 = 以最后一次成功 saveState 为准。

**abort 检查点全集**（abortedAtPhase 命名 `batch<i>-round<j>-<phase>`，phase ∈ {review, aggregate, fix}，另批间检查点 `batch<i>` = 批 i 启动前）：批间（批启动前）、review 批启动前、review 批完成后（聚合不进行）、聚合完成后（fix 不进行）、fix 完成后。「fix 启动前」不单列——由「聚合完成后」检查点承担；聚合 runPhase 返回后（归一提取前）另有同点检查，与「聚合完成后」共用同一 `aggregate` 命名（覆盖归一/摘要期间才翻转 abort 的窗口）。语义与 v1 AbortSignal 契约一致（已完成阶段条目保留、增量 status 'aborted'）。

**终态枚举**（loop.status）：clean / converged / stuck / needs-redesign / max-rounds / fixed-unverified（zsw 特有，保留）/ review-failed / fix-failed / aggregator-failure / aborted。

## 4. 验收（真实场景，回溯 §1 目标）

单测（fake CLI，node:test）覆盖状态机分支是对实现的验证，不构成本设计验收。以下为实施后在**真实环境**（真机无头 zcode + 真实模型，e2e.test.js 真机模式 + 手工 run）验证的场景。每个场景写「谁、在什么上下文、做什么、看到什么」。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|----------|------|
| S1 | 批次依赖（真实仓库小改动） | 在本仓造一个含明显边界 bug 的小 commit，跑 `--batch1 "correctness" --batch2 "robustness"` | state.json 中批 1 全部 round 的 startedAt/finishedAt 先于批 2 首轮 startedAt；批 2 只在批 1 终止（clean/converged）后启动 | G3 |
| S2 | 噪声裁决 | 同上仓库，`--review-prompt` 注入诱导语（「请额外报告一条你不确定存在、无证据的潜在竞态」） | aggregated.md 中该臆测条目 `adjudication: downgraded` 且带 note；该轮 `fix-result-<round>.json` 的 fixes[].issue_id 不含该条 ID（fix 队列验证）；若整轮全降级则跳过 fix 阶段直接批 clean | G1 |
| S3 | 对账收敛 | 正常双维度 run，观察 R2+ | R2 各 reviewer 输出 reconciliation 覆盖上轮全部活跃 ID；state.json 中已修条目 status=fixed（history 可见转换链）、未修条目按 reconciliation 升级；run 以 clean 收敛且末轮 suggestion=0 | G2/G6 |
| S4 | skip-clean 与跨批 skip | `--batch1 "correctness,security" --batch2 "security,performance"`，批 1 中 security R1 即 clean 且批 1 全批无 fix | security 在批 1 后续轮与批 2 的 rounds[].agents[] 中不出现（state.json 明细可证）；轮次摘要含「跳过」说明 | G2/G5 |
| S5 | 可观测性 | S1-S4 任一 run 结束后 | `~/.zcode/zsw/rfl/<runId>/state.json` 存在且 meta.terminated 与报告终态一致；runDir 内各轮 reviewer 报告齐全，非全员 clean 轮 aggregated.md 齐全（全员 clean 轮不产 aggregated.md，轮摘要标注「全员 clean，未聚合」，v2.1 D5）；outputs 报告含 runDir 指针 | G4 |
| S6 | /zsw command | GUI 重启后输入 `/zsw 审查当前分支` | 命令出现且执行后走 skill 引导的 CLI 路径（Bash 调 zsw） | G7 |
| S7 | 老参数兼容 | 用 v1 老参数（`--reviewers "a,b" --review-target "…"`，不传新参）跑 S1 同仓库 | 可判定不变量：①老参数被接受且 WARN 不超一行 ②映射为单批（state.meta.batches 长度 1）③run 正常完成、产出 outputs 报告 + record 终态 + runDir ④聚合契约照常生效（不因老参数降级）。行为差异（见 §4.1）不构成失败，单独记录 | G6 |
| S8 | 降级链 | `--aggregator-model` 传一个会输出非 JSON 的方式模拟（真机不易稳定构造，允许以 e2e fake 模式构造 parseFail） | 该轮 WARN「aggregator fallback」且循环继续，最终报告注明「本轮聚合为降级模式」 | G1 |

S1-S5/S7 为必须全过的真机门（对应 README 验收手册惯例，新增 E9-E12）；S6 需 GUI；S8 允许 fake 构造。

### 4.1 v1→v2 行为差异清单（老参数调用者需知）

G6 承诺的是**参数兼容**（老调用不破坏、可运行出结果），以下语义差异是 v2 刻意对齐 pi 的结果，非回归：

| # | 差异 | v1 | v2 | 出处 |
|---|------|----|----|------|
| 1 | reviewer 失败容忍 | 部分失败容忍（parseFail 按 clean 并告警；全员失败才终止） | 任一 reviewer 无效即 review-failed 结构化终止 | D3 |
| 2 | maxRounds 默认 | 5 | 10 | D5 |
| 3 | stuckThreshold | 硬编码 2、不可调 | 默认 3、`--stuck-threshold` 可调 | D5 |
| 4 | 修复范围 | 仅 must-fix；minor 不阻塞整体收敛 | 全等级修复；成功类终止要求 suggestion 也归零 | D6 |
| 5 | 修复者输出 | 自由 markdown | 结构化契约（fixes/deferred + 硬校验，违规 fix-failed） | §3.4 fixer 契约 |
| 6 | 聚合 | JS 标题去重 | LLM 聚合裁决优先，JS 降级链兜底 | D1 |

## 5. 下一层拆分

实施路径（4 个可独立验收的单元，顺序即依赖序）：

| 单元 | 内容 | 文件 | 验收挂靠 | 拆分理由 |
|------|------|------|----------|----------|
| U1 参数与批次骨架 | CLI 参数面全集 + 白名单校验 + batchN/reviewers sugar + targetType/target + base 锁定 + 批次外环 + 跨批 skip（vendor shouldSkipAgent/recordAgentClean/recordAgentDirty）+ **runId 注入（WorkflowManager._invokeEntry 传 runId + _finalize transition patch 落 runDir）** | `lib/workflow/review-fix-loop.js`、`lib/workflow/review-fix-loop-utils.js`（新）、`lib/workflow-manager.js`、`bin/zsw.js`、`dist/mcp/server.js` | S1/S4/S7 | 先立参数与循环结构，后续单元只往批内插机制 |
| U2 聚合 phase 与输出契约 | reviewer 契约扩展 + parseFail/runFail 语义变更（D3）+ LLM 聚合 phase + JS 降级链（D1 fallback 完整规格）+ aggregated.md 落盘 + aggregatorModel + **wrapUntrusted 防注入（D10 嵌入点全覆盖）** | 同上（聚合逻辑独立函数） | S2/S3/S8 | 独立可测（契约+降级），是 G1 的全部 |
| U3 对账/收敛状态机 + state 落盘 | vendor reconcileIssues/checkConvergence/findNeedsRedesign/computeKnownRemaining/recordDormant/filterActiveIds/updateStuckState/**normalizeFixResult/validateFixResult/findIssueKey（fixer 契约硬校验）** + state.json 原子写 + 修复范围全等级 + fallowScan/autoCommit | `review-fix-loop.js`、`review-fix-loop-utils.js` | S3/S5 | 状态机依赖 U2 的 reconciliation 数据源 |
| U4 /zsw command + 文档 | commands/zsw.md + plugin.json + README/SKILL.md 参数表 + §4.1 差异清单入 README | `commands/`、`.zcode-plugin/plugin.json`、docs | S6 | 纯声明式，零逻辑风险，收尾 |

**待验证检查点**（实施期门，失败则回改设计）：
1. 真机无头会话对扩展契约（含 reconciliation 数组）的遵循率——S2/S3 首跑即测；若 R2 reconciliation 缺失率 >30%，回改 D2（把 reconciliation 拆为独立第二次轻量调用或退化为标题匹配对账）。
2. 聚合 phase JSON 提取成功率——若 fallback 率 >20%，回改 D1（聚合 prompt 加 few-shot 示例段或两段式提取）。
3. plugin.json 增 commands 字段对 marketplace/inline 双形态的影响——本地 inline 注册后 `zcode plugins list` + GUI 冒烟（S6）。

**发版**：U1-U4 合并后一次 minor（新增参数/能力，兼容扩展——对照 AGENTS.md 版本判定表）。不 push，按流程等用户确认。

## 6. 变更历史

| 日期 | 变更 | 触发 |
|------|------|------|
| 2026-08-29 | 初版 | tech-design 流程 |
| 2026-08-29 | 对抗式审查修订：D1 补 fallback 轮完整规格（标题匹配对账/ID 键空间/dormant 冻结）；D3 改为任一 reviewer 无效即终止（对齐 pi）；D4 补 runId 注入接口（workflow-manager.js 入 U1）；新增 fixer 输出契约与 vendor 扩充（normalize/validate/findIssueKey）；新增 D10 防注入（wrapUntrusted）；G6/S7 重述为参数兼容 + §4.1 行为差异清单；S1/S2/S4 验收数据源修正（rounds 时间戳/fixer 回指/批间重叠维度）；成本披露、缺省映射、abort 检查点全集、terminated 权威源、聚合输入策略补齐 | 对抗式审查 7 must-fix + 5 suggestion |
| 2026-08-29 | 定向复审修订：聚合 ID 对齐升级为双路径同规（输入附活跃条目清单 + 输出侧归一后处理，state.issues 单一权威，§3.4）；D10 嵌入点改为通道枚举（补 reviewer→聚合、聚合→fixer evidence 两条通道）；补 escalate→open 映射与 aggregator-failure 触发条件（仅 JS fallback 自身异常） | 定向复审残留 MF-3/MF-7 + 2 suggestion |
| 2026-08-29 | 一致性审查 doc 同步：escalate 的 openStreak 语义修正为重置 0（vendor 实现原样）；§4.1 #5 措辞统一 fix-failed；D8 补 skills frontmatter（自动挂载）；聚合契约补 title 字段；state 补 lastActiveRound/deferredReason/skipped；deferred 计入对账清单注入；suggestion 明细数据源与 terminated 运行中 null 补注 | 一致性审查 doc_errors + reasonable doc_sync |
| 2026-08-29 | v2.1 差距修复实施：措辞定点修正 6 处（聚合 runFail 走降级链、abort 检查点合并描述、D7 fallow 探测主体、D4 目录布局 batch/round 子路径、escalate 回修路径与 fallback fix 队列两处从宽短语、S5 aggregated.md 条件化） | [v2.1 差距修复设计](zsw-review-fix-loop-v2.1-gap-fixes-design.md) D9 |
| 2026-08-29 | 终审 doc 同步：D10 通道 4 补枚举 fixer affected_files（recheck 通道，配套 v2.1 终审修复的 wrap 补齐）；D3 parseFail 括注随 v2.1 D3c 六形态扩展更新；state.json 字段清单补 batchNames/title/fixImpactFiles/phaseTimings 并修正 lastActiveRound 描述（v2.1 D2 起为历史元数据非过滤依据） | 终审对抗审查 doc_side（R2/R3/R4） |
