---
name: pr-cr-fix
description: >-
  分支对抗式审查-修复-提PR skill（zcode/pi 双引擎适配）：static gate → 多维 review
  （agent.md checklist 驱动，zsw CLI review-fix-loop 统一通道）→ 聚合 must-fix →
  修复 → 重审 → pre-merge 终验 → push + 开 PR。触发词："review"、"审查代码"、
  "code review"、"对抗式审查"、"review and fix"、"pr-cr-fix"、
  "审查分支变更"、"开 PR"、"review 完开 PR"。不用于 纯 git 操作、push 排查、
  单文件快速自查（主会话直接读代码即可）、合并回 main（merge skill）。
---

# 对抗式审查-修复-提 PR Skill

static gate → review-fix-loop（多维 review → 聚合 → 修复 → 重审到 clean）→ pre-merge
终验 → push + 开 PR。移植自 xyz-agent 的 pr-cr-fix，按本项目（zcode 插件工作区，bare repo
+ worktree + npm tag 直发管线）裁剪调优。

**zcode / pi 双引擎适配**：本仓可从任一引擎会话驱动，全流程引擎无关——阶段 1/3 是纯
bash + 纯 Node 脚本（quality-gate 无依赖、双引擎同构）；阶段 2 收敛到 zsw CLI 单通道
（CLI 引擎无关，zsw 的 reviewer/fix 阶段是它自己 spawn 的无头 zcode 执行体，与当前会话
引擎解耦）。zcode/pi 会话均具备 review-fix-loop 执行能力：pi 原生 workflow 虽存在但
reviewer 契约不兼容（见差异表），**两引擎统一走 zsw CLI**——无分支处理。

## 与 xyz-agent 版的差异（调优声明）

| 差异点 | xyz-agent 版 | 本项目版 | 原因 |
|--------|--------------|---------|------|
| 阶段 2 执行通道 | 路径 1 pi 原生 workflow（batch1 传 agent 路径）/ 路径 2 zflow MCP + `script:pr-review-fix` 移植脚本 / 路径 3 手工兜底 | zsw CLI `workflow --workflow review-fix-loop`（zcode/pi 双引擎统一单通道） | zsw 1.0.0（M1）起 MCP 工具面恒空，CLI 是唯一入口且引擎无关；zsw 已原生内置 review-fix-loop，无需移植脚本；pi 原生版 reviewer 契约不兼容（见下行），禁用 |
| PR/push 阶段 | 阶段 1 开 PR / 阶段 3 推 PR | 阶段 3（review 闭环后一次性 push + 开 PR） | 远端 2026-08-23 绑定（zhushanwen321/zcode-plugins）后补齐；review 前不开 PR（review 中分支还会变） |
| 度量/覆盖率门禁 | fallow metrics-gate + vitest coverage-gate | quality-gate.js（零依赖：单测执行 + 增量覆盖率 ratchet + 新增函数圈复杂度 fail + CRAP warn 靶子） | 零依赖红线：NODE_V8_COVERAGE 原生产物 + V8 函数区间 decision-point 启发式（口径与取舍见脚本头部声明）；不搬死代码/循环依赖/重复检测（需依赖图分析，单插件仓收益不抵成本） |
| changeset 门禁 | changeset 检查（extensions 发布流） | check-sync + check-pack + check-release-needed | 本仓发布走 tag 直发（非 changesets）：三件套一致性 + 包内容 + 改动-发版关联检测（UNDECLARED 等价物） |
| reviewer 输出契约 | YAML frontmatter + structured-output tool | json 围栏块（review-fix-loop 的 extractJsonObject 契约） | 两套 workflow 的解析器不同；本项目 v2 契约不匹配 = parseFail 即 review-failed 结构化终止（响亮失败，不静默漏审）；pi 原生版才是 parseFail 按 clean 处理（禁用原因，见阶段 2 MANDATORY 节） |
| agent.md 消费方式 | pi workflow batch1 传 agent 路径 | 批次值即 agent .md 路径（reviewer 实体）+ task 内映射表指引 Read 对应 checklist | 两引擎同构：zsw CLI batch1 值 = agent .md 绝对路径，agent.md 是审查契约本体 |
| 审查维度 | 8 维（含 electron-build/extension-api 等） | 5 维（zsw 领域重划） | 本仓是零依赖 Node CLI/MCP server，无 Electron/monorepo |

## 前置条件 [MANDATORY]

- 分支相对 main 有 commits（`git log main..HEAD` 非空）
- 工作区 clean（fix 阶段会写文件，脏工作区混入认知外改动）
- node ≥ 20（node --test 需要）
- zsw CLI 链路可用：zcode CLI 在场（reviewer/fix 阶段 spawn 无头 zcode；路径可用
  `ZSW_ZCODE_CLI` 覆盖）。workflow run 恒本地执行、不依赖 daemon——zcode 会话天然
  满足，pi 会话/纯终端同样可跑（CLI 引擎无关）。不可用时走降级路径

## 阶段 1：static gate（主 agent 直接跑）

quality-gate 承接单测执行与三项质量判定（测试执行就是覆盖率的产生过程，合一避免重复跑），加 npm 管线 gate：

```bash
# 1. quality-gate：单测执行（e2e* 排除，与 ci.yml 同构）+ 增量覆盖率 + 新增函数圈复杂度 + CRAP 靶子
node .agents/skills/pr-cr-fix/scripts/quality-gate.js --base main

# 2. npm 三件套 gate：版本三处一致 / 包名规范 / 零依赖红线 + 包内容完整
node scripts/check-sync.js && node scripts/check-pack.js
```

quality-gate 判定（exit 0 = pass / 1 = fail / 2 = 工具错误；exit 2 场景——产物缺失、git 异常——绝不静默 pass）：

| 判定 | 语义 | 动作 |
|------|------|------|
| 测试失败 | 任一插件单测 FAIL | 按失败用例派 worker 修复后重跑 |
| 增量覆盖率 < 40%（ratchet 起步值，终态 80） | 新代码没测到 | 按 `.review/quality.json` 的 uncoveredFiles（missed 降序）派测试 worker 补测试 → 重跑，上限 3 轮 |
| 新增函数圈复杂度 > 15 | 结构性超标（fail 只追溯新增函数——新增行占函数 ≥50%；存量函数不追溯原罪，经 CRAP 靶子交 review） | 拆函数后重跑 |
| CRAP ≥ 30 | warn 靶子，不阻塞 | 进阶段 2 由 test-coverage 审查者消费 |

**Gate-1**（硬 gate）：quality-gate exit 0 且 check-sync/check-pack 绿才进阶段 2。
check-sync 的版本漂移禁手工单改文件对齐——见失败恢复表。禁止跳过任何用例；调低
`--min-coverage` / 调高 `--max-complexity` 绕过 = skip 开关等效，禁。

### 产物消费（阶段 2 输入）

`.review/quality.json`（quality-gate 产出，已 gitignore）：`uncoveredFiles`（实测增量覆盖
缺口，missed 降序）/ `filesWithoutCoverage`（零加载盲区）/ `complexityFail` / `highCrap`
（CRAP 降序，`kind` 区分 new/modified）——由 review-test-coverage 审查者按其 agent.md
「输入」节消费（机器定位缺口，reviewer 判定缺口质量与断言强度）；降级路径的手工
subagent task 同样要求消费。

## 阶段 2：review-fix-loop（zsw CLI 单通道，zcode / pi 双引擎同构）

用本项目自产的 zsw workflow（dogfooding）。**zsw 1.0.0（M1）起 MCP 工具面恒空——
tools/list 恒空、tools/call 恒拒绝并指引走 CLI，`zflow(action=...)` 形态已失效**，
`node z-subagent-workflow/bin/zsw.js workflow` 是唯一通道。CLI 引擎无关：zcode 会话、
pi 会话、纯终端执行完全同构（zsw 的 reviewer/fix 阶段是它自己 spawn 的无头 zcode
执行体，与当前会话引擎解耦），因此双引擎下无需分支处理。

**[MANDATORY] 禁止 pi 原生 review-fix-loop 通道**：pi 原生版的 reviewer 契约是
YAML frontmatter（verdict/must_fix）+ structured-output tool，与本 skill agent .md 的
json 围栏块契约不匹配——pi workflow 解析失败会按 clean 处理，静默漏审（契约差异见
差异表）。agent .md 也不做双契约混写（两边都可能 parseFail，代价同样是漏审）。

**执行姿势**（主 agent 直接跑，禁止 subagent 封装——subagent 内的 bash 一样要同步
等 CLI 退出，只多一层中转）：run 是同步阻塞命令（恒本地执行，不依赖 daemon），
多轮 × 5 审查者可达数十分钟——用 Bash `run_in_background=true` 包裹整条命令，CLI
退出即引擎原生 task-notification 唤醒（zcode/pi 同理），禁止轮询 status。

```bash
AGENTS="<仓库绝对路径>/.agents/skills/pr-cr-fix/agents"
node z-subagent-workflow/bin/zsw.js workflow \
  --workflow review-fix-loop \
  --task "<下方模板>" --workdir <仓库绝对路径> \
  --batch1 "$AGENTS/review-arch-boundary.md,$AGENTS/review-concurrency.md,$AGENTS/review-business-logic.md,$AGENTS/review-mcp-contract.md,$AGENTS/review-test-coverage.md" \
  --target-type git-diff --target main \
  --max-rounds 3 \
  --review-prompt "执行纪律（引擎层 turn 时长约束，与审查标准无关）：单个 turn 内不要连续做长时间工作——每读完 2-3 个文件就结束当前 turn 输出阶段性结论，下一 turn 继续；报告主体写完后立即收尾输出结构化 json 围栏块，不要在报告完成后再做额外探查。审查覆盖面与 checklist 标准不打折。"
# 契约（2026-09-02 实测校准）：批次值 = agent .md 绝对路径（逗号分隔多 agent，一批 =
# 并行 review → 聚合 → fix → 重审）；旧 --reviewers 参数已被 CLI 拒收（fail-fast）。
# --target-type git-diff --target main = 审查分支全量变更（--review-target 是 text
# 类型老 sugar，不用于 git-diff 场景）
# [MANDATORY] 不传 --timeout-per-phase / --timeout-ms：体系默认无超时（config.DEFAULTS
# .timeoutMs=null、timeoutMsPerPhase 缺省无、CLI 不传则无）。review/fix 是时长不可
# 预测的 LLM 长任务，死线超时到期 = SIGKILL 毁掉全部在途工作（fix 半成品灾难，
# 2026-08-29 run2 实证：20min 死线杀掉完成度 90% 的 fixer）。仅用户明确要求死线
# （如 CI 硬预算）时才由用户显式传参
# --model 不传：review/fix 是重量任务，跟随默认主模型（纪律见 zsub-zflow-orchestration skill）
# --review-prompt 推荐传：core 引擎 turn 计时是两计时器（2026-09 vendored 0.5.1
# 起：idle 30min 事件刷新主判 + 总上界 60min 固定，env XYZ_ZCODE_TURN_* 可调可关，
# 旧 300s 固定墙钟已退役——2026-09-02 run1 实证的「报告写完但收尾帧迟到被判死」
# 误杀面已收窄）。残余风险 = 单 turn 超 60min 总上界仍被杀（engine_run_failed，
# 整轮 review-failure）；分步纪律（每 2-3 文件收尾一轮 + 报告完成后立即输出
# 围栏块）对此仍是有效缓解且成本为零，故保留注入。调优面见插件 README
# 「超时行为与调优」节；禁直改 vendored dist（sha256 自检）
```

### task 模板 [MANDATORY 结构]

```
审查 zcode 插件工作区分支（<分支名>）相对 main 的全量变更。

## 审查者 → checklist 映射（开始审查前必须 Read 对应文件并严格执行其 checklist）
- 审查者「arch-boundary」→ Read <repo>/.agents/skills/pr-cr-fix/agents/review-arch-boundary.md
- 审查者「concurrency」→ Read <repo>/.agents/skills/pr-cr-fix/agents/review-concurrency.md
- 审查者「business-logic」→ Read <repo>/.agents/skills/pr-cr-fix/agents/review-business-logic.md
- 审查者「mcp-contract」→ Read <repo>/.agents/skills/pr-cr-fix/agents/review-mcp-contract.md
- 审查者「test-coverage」→ Read <repo>/.agents/skills/pr-cr-fix/agents/review-test-coverage.md

只执行自己维度对应的 checklist；其他维度的问题留给对应审查者，不跨维度报。
```

`<repo>` 替换为仓库绝对路径（reviewer 的 cwd 是 workdir，但用绝对路径防歧义）。

**Gate-2**（按 CLI 输出 JSON 摘要段的 `loop.status` 判读；markdown 报告段含轮次明细
与剩余 must-fix）：

**失败停机归因总则 [MANDATORY]**：workflow 以非 clean 终态（尤其 `review-failed` /
`fix-failed`）退出时，**禁止直接重跑**——先停下做根因三分类，否则同类失败无限重放：

1. **基础设施故障**（provider 错误/流中断/网络）：特征是 runFail 或输出截断（围栏未闭合）。
   单 phase 级瞬时故障可重跑一次；重复出现说明是调用形态问题（如并发巨上下文会话），
   归入第 3 类。
2. **参数不适配**：特征是明确的参数错误。校准参数后重跑（注意：超时不在此列——
   体系默认无超时，见阶段 2 参数纪律）。
3. **脚本自身缺陷**：dogfooding 暴露的 zsw/review-fix-loop 缺陷（错误分类误导、
   半成品无处置、上下文注入架构放大故障面等）。**停下来修脚本**——本仓跑 pr-cr-fix
   的分支往往正是在修这条链路，workflow 的失败就是分支工作项的直接证据。修复后
   从阶段 1 重来。

| `loop.status` | 动作 |
|---------------|------|
| `clean`（exit 0） | 全审查者无 must-fix → 进阶段 3 |
| `fixed-unverified` | 轮数耗尽且最后一步是修复成功、未复核 → 再跑一轮确认 |
| `stuck` | 问题连续 3 轮未收敛（stuckThreshold 缺省 3，对齐 pi）→ 读报告逐条判定：误报人工 ack，真问题人工介入 |
| `review-failed` / `fix-failed` | 按上方「失败停机归因总则」三分类处置；禁止未归因直接重跑 |
| `aborted` | 被 abort：确认是否有意为之，无意则重跑 |

### 降级路径（zsw CLI 链路不可用时）

zsw CLI 不可用 = zcode CLI 缺失/损坏或 workflow run 报环境错（本仓日常不触发；典型
场景 CI 容器）。主 agent 改用**当前引擎原生 subagent**（zcode 用 Agent tool，pi 用其
subagent 工具，task 结构两引擎等价）手工派 5 个 reviewer（并行 ≤3 分两批），每个 task
含：workdir 绝对路径 + agent.md 绝对路径（subagent 须复读原文）+ 审查范围 + 输出格式
（Findings 表格：优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向——降级路径不经 zsw
解析器，主 agent 直接读报告，无 json 围栏契约要求）+ `.review/quality.json` 存在时
要求消费（test-coverage 维度）。聚合去重后派 worker 修 MUST_FIX，修完重审一轮。上限 2 轮。

worker 纪律（与 zsw workflow 内置 fixer 的拒绝理由机制对齐）：

- **每条先验证真实性再修**：worker 逐条读代码证实 review 断言；不成立的（误报）在
  报告列「已验证不成立 + 证据（file:line + 逻辑）」，不盲改
- **bug 类修复带回归测试**：修前红修后绿——回归测试在旧代码上必须 fail、新代码上
  pass，证明测试真能抓 bug 而非凑数；测试类问题派独立测试 worker，与修复 worker 分离
- 修复后跑 quality-gate（阶段 1 命令）确认不回归，再进重审

## 阶段 3：pre-merge 终验 + push + 开 PR

### 3a — 终验（review-fix-loop 的 fix 阶段改过代码，Gate-1 读数已过期）

重跑阶段 1 全部命令（quality-gate + check-sync + check-pack），并要求干净工作区
（全部改动已 commit——修复 worker 在途会污染覆盖率读数）。
**Gate-3a**：全绿才进 3b；FAIL 派 worker 修复后从 3a 头部重跑。

**3a.5 发版面自动分类（软 gate，歧义才问）**：跑 `node scripts/check-release-needed.js`。
主 agent 按 diff + 分支 conventional commits **自动分类**，不弹窗（判断信息全在 diff 里；
xyz-agent 2026-08-23 [HISTORICAL] 教训：每次弹窗打断执行、多数是噪声）：

- **待发版**（fix→patch / feat→minor / BREAKING→major，多插件逐个记）：PR body 写明
  「待发版插件 + 建议类型」，实际 bump 在合 main 后走 merge skill 阶段 5 / release.js
- **首次发版固定 0.0.1，不询问**：插件从未发布过 npm（无 `<plugin>@<version>` tag）时，
  首次发版版本一律 0.0.1——release.js 只支持 bump 不支持首 tag，首次发版走「三处版本
  统一改 0.0.1（check-sync 验证一致）+ 合 main 后手工 tag `<plugin>@0.0.1` 触发发布」，
  PR body 记录该形态即可，不弹窗询问（2026-08-26 z-tool-finder 首发确立）
- **不发版**（纯文档/测试/零行为差重构/`test-only`）：PR body 列明「插件 + 跳过原因 + 证据」
- **歧义**（type 无法从 commits 判定 / `SHARED_CHANGED` 涉及 vendored 传播）：才问用户
  （zcode AskUserQuestion / pi ask_user，措辞等价）

不阻塞流程——防 bug fix 静默丢失，终判权在 merge 阶段的用户。

**3a.6 真机 e2e 触发判定（CI 与单测双双排除 e2e，此为唯一防线）**：按路径匹配判定
push 前的 e2e 义务（配额 gate 的 skip 输出 ≠ 验收通过，对齐 e2e-daemon 头部成本纪律；
历史教训 eef596a：对抗式审查漏网的 6 个 bug 全是 e2e 抓的——单测全绿 ≠ 协议正确）：

| diff 触及（`git diff main...HEAD --name-only`） | e2e 义务 |
|---|---|
| `z-subagent-workflow/lib/**` | push 前本地过 e2e.test.js + e2e-daemon.test.js（真机+真实模型，按 README 验收手册）；跑不了（凭据/配额窗口关）→ PR body 明示未跑 + 原因 + 补跑计划 |
| `z-subagent-workflow/bin/zsw.js`、`dist/` | e2e-daemon.test.js（daemon/CLI 多进程链路） |
| 仅 `test/`、`docs/`、`skills/`、`.agents/`、workspace `scripts/` | 不触发 |

e2e 义务未履行且 PR body 未声明 = 终验不完整，不得进 3b。

### 3b — PR title/body 自动生成 + push（需用户授权）+ 建 PR

**[MANDATORY] push 前必须获得用户明确授权**——告知审查与终验结果，等确认。

PR 内容从分支 commits 自动生成（英文，无需用户提供）：

1. 收集：`git log main..HEAD --format="%s%n%b---"` + `git diff main...HEAD --stat`
2. title：conventional commit 风格（`feat(zsw): ...`，scope 用插件缩写；多主题取最核心）
3. body：`## Summary`（改动目的）+ `## Changes`（逐 commit 关键点，合并相关条目）+
   `## Test plan`（quality-gate 结果：测试通过数 + 增量覆盖率 + CRAP 靶子处置；check-sync/
   check-pack；e2e 按 3a.6 判定结果——已跑给结论，未跑给原因与补跑计划；3a.5 的
   待发版/不发版分类）

```bash
git push origin HEAD
gh pr create --repo zhushanwen321/zcode-plugins \
  --head "zhushanwen321:$(git branch --show-current)" --base main \
  --title "$PR_TITLE" --body "$PR_BODY"
# 已有 PR（重跑场景）：gh pr edit 同名 PR 更新 title/body
```

**Gate-3**：PR URL 匹配 `^https://github\.com/.+/pull/\d+$`；push 后用**有限轮询**等 CI 绿
（禁 `gh pr checks --watch`——无限阻塞命令，GitHub runner 排队时会把会话/后台任务挂死：
2026-08-27 PR #4 事故，PR 侧 run 排队 7h 被 runner 回收成无 step 的假 failure，watch 进程
跨会话残留）。轮询姿势（60s 间隔、15 分钟上限，pass 即 break，超时上报用户人工接管）：

```bash
for i in $(seq 1 15); do
  if gh pr checks <PR编号> --repo zhushanwen321/zcode-plugins; then break; fi
  sleep 60
done
```

CI FAIL 的甄别与处置：`gh run view <runId> --json jobs` 看 jobs[].steps——**为空数组且
conclusion 为 failure 的是 runner 排队假失败**（job 从未启动），`gh run rerun <runId>` 重跑；
有 step 记录的真失败才按日志修复 push 新 commit，直至绿。
PR 合并动作不在本 skill——用户确认后走 merge skill。

## 维度 → Agent 映射（两路径共用）

Agent 定义位于本 skill 目录 `agents/review-<维度>.md`（不全局暴露，仅审查流程内部引用；
不进 `.zcode/agents/`——它们是 reviewer checklist 不是引擎 subagent 实体）。

| 维度 | Agent 实体 | 审查焦点 |
|------|-----------|---------|
| 架构边界 | `agents/review-arch-boundary.md` | 端口/适配器边界（ports.js 契约单向依赖、三决策位可换性、平台漂移限制在端口实现内、manager 与入口薄壳分离、workflow/subagent 双 manager 职责、插件运行时禁引插件根外路径、marketplace 副本自包含） |
| 并发与资源 | `agents/review-concurrency.md` | AbortSignal 全链传播（spawn 前预检/运行中杀停/编排检查点）、slots 深度分层、reaper 孤儿清理、worktree 泄漏、进程/定时器句柄泄漏、record 终态一致性 |
| 业务逻辑 | `agents/review-business-logic.md` | 编排正确性（状态机转换、错误路径、部分完成语义、边界条件、文本截断、停滞检测、cleanReviewers 重审语义） |
| MCP 契约与 IO | `agents/review-mcp-contract.md` | tool schema/description 一致性、必填性与模式语义、json 围栏提取鲁棒性、文件写入原子性、stdout JSON-RPC 通道不被人读输出污染、错误消息可操作性闭环 |
| 测试覆盖 | `agents/review-test-coverage.md` | 新增逻辑有测试、node --test 合规、断言强度（修前红修后绿）、abort/超时/并发边界用例、单测与 e2e 边界 |

workspace 级变更（scripts/、.github/、.githooks/、docs/）由 arch-boundary 维度覆盖其
命名/红线合规（check-sync 规则与 AGENTS.md npm 规范为 checklist 的权威源）。

## 严重度分级（对齐 review-fix-loop 聚合器）

| 本 skill 语义 | workflow severity | 聚合器判定 |
|---------------|-------------------|-----------|
| MUST_FIX（阻塞：架构违规 / 会出 bug / 违反 [HISTORICAL] 规则） | `critical` 或 `major` | 计入 must-fix，进 fix 阶段 |
| SUGGESTION（强烈建议：可维护性） | `minor` | 不阻塞 |
| INFO（可选：风格/文档） | `minor` | 不阻塞 |

reviewer 只在真 must-fix 时给 critical/major；风格问题一律 minor——workflow 聚合对 minor
不触发修复，报错级别会浪费 fix 轮次。

## 关键约束 [MANDATORY]

1. **阶段顺序不可调换**：Gate-1（static gate 全绿）→ 阶段 2（review-fix-loop）→ 阶段 3a（终验）→ 3b（push + PR）。
2. **主 agent 不亲自做维度审查**：review 委托 zsw workflow CLI（或降级路径的引擎原生 subagent）；主 agent 只编排 + gate 校验。
3. **fix 后必须重跑终验**：review-fix-loop 的 fix 阶段会改文件，Gate-1 读数过期——3a 重跑全部 static gate。
4. **agent.md 是审查契约**：reviewer 未按 checklist 执行的输出视为无效，重派。
5. **不提交认知外改动**：fix 阶段改动逐条核对归属后按全局提交策略 commit。
6. **push 必须用户授权**（全局规则）；force-push 场景一律 `--force-with-lease`，裸 `--force` 禁止。
7. **禁 skip 开关**：`--no-verify` / 跳过用例 / 吞 stderr。检查不通过 = 流程中止，唯一出路是修复。

## 反模式

| 反模式 | 后果 |
|------|------|
| reviewer 不读 agent.md 直接凭感觉审 | 维度漂移，checklist 形同虚设 |
| agent.md 输出格式写成 YAML frontmatter（xyz-agent 契约） | 本项目 workflow parseFail → review-failed 结构化终止（响亮停机不漏审，代价是整轮审查作废重跑） |
| pi 会话改走 pi 原生 review-fix-loop（batch1 喂本仓 agent .md） | reviewer 契约不匹配（YAML/structured-output vs json 围栏）→ parseFail 按 clean 处理 → 静默漏审；统一走 zsw CLI |
| agent.md 改双契约混写（json 围栏 + YAML 并存） | 两套解析器都可能取错段，parseFail 风险翻倍 |
| 风格问题标 major/critical | 聚合器误触发 fix 轮次，浪费 |
| 调低 `--min-coverage` / 调高 `--max-complexity` 绕过 Gate-1 | 与 `--no-verify` 等效：门禁形同虚设；阈值变更只能随 ratchet 上调（coverage）或显式重构标准讨论后改 |
| 手工跑 `node --test` 冒充 Gate-1（不经 quality-gate） | 丢了增量覆盖率/复杂度/CRAP 三个判定与 `.review/quality.json` 产物，test-coverage 审查者失去机器靶子 |
| quality-gate exit 2 当 pass 处理 | 工具错误静默放行 = 假 pass（xyz coverage-gate [HISTORICAL] 同型事故）；必须排查后重跑 |
| subagent 封装 zsw workflow CLI 调用 | 多一层无增益中转（subagent 内 bash 一样同步等 CLI 退出） |
| workflow run 后轮询 status 等结果 | run_in_background 完成即原生通知，轮询白耗 |
| `gh pr checks --watch` 等 CI（无限阻塞） | runner 排队时挂死（PR #4 事故挂 7h+ 跨会话残留）；用 Gate-3 的有限轮询姿势 |
| 脏工作区跑审查 | fix 改动与认知外改动混淆 |
| 用旧 token（`run_workflow` tool / `zflow(action=...)` MCP 调用 / `zsub` 目录名 / `bin/zsub.js`） | zflow MCP 面 1.0.0 起恒空；2026-08 改名后失效；命名 SSOT 见 z-subagent-workflow/CONTEXT.md |
| review-fix-loop 传 `--reviewers`（旧自由文本视角名） | CLI 显式报错拒收（fail-fast 不静默）；批次契约值 = agent .md 绝对路径，用 `--batch1`（2026-09-02 实测） |
| reviewer 单 turn 连续长时间工作（读大 diff 不分步） | 超 core turn 总上界（默认 60min，idle 主判 30min 事件刷新）被杀 engine_run_failed → 整轮 review-failure；经 `--review-prompt` 注入分步执行纪律缓解（旧 300s 固定墙钟误杀面已随 vendored 0.5.1 两计时器收窄） |
| review 前先开 PR | review/fix 期间分支会变，PR 描述反复过期；PR 在 3b 一次性开 |
| 删/改 agents/ 下的 review agent | 破坏 review 维度完整性 |

## 失败恢复

| 失败 | 动作 |
|------|------|
| Gate-1 quality-gate 测试失败 | 按失败用例（TAP 输出）派 worker 修复后重跑 |
| Gate-1 增量覆盖率 < ratchet 阈值 | 按 `.review/quality.json` uncoveredFiles（missed 降序）派测试 worker 补测试 → 重跑（上限 3 轮，超限上报用户） |
| Gate-1 新增函数圈复杂度 > 15 | 拆函数（抽取子函数/早返回/查表）后重跑；不能用调高 `--max-complexity` 绕过 |
| Gate-1 quality-gate exit 2 | 工具错误（V8 产物缺失/git 异常/无 test 目录）：按错误信息排查环境后重跑——不当作 pass 也不当作 fail |
| Gate-1 check-sync 版本漂移 | 禁手改单文件对齐：将要发版 → 用 `scripts/release.js` 统一 bump 三处；不发版 → 以 main 版本为准回退漂移文件 |
| Gate-1 check-pack 包缺文件 | package.json `files` 白名单补齐后重跑 |
| workflow run 环境错（zcode CLI 缺失/崩溃） | 读报告 error 字段恢复指引；重跑一次仍败走降级路径（引擎原生 subagent 手工编排） |
| Gate-2 `stuck` | 看报告剩余 must-fix：误报人工 ack，真问题人工介入 |
| Gate-2 `review-failed` / `fix-failed` | 按阶段 2「失败停机归因总则」三分类处置：基础设施故障重跑一次；重复出现或属脚本缺陷 → 停下修脚本后从阶段 1 重来 |
| reviewer parseFail（终态 `review-failed`，轮次摘要注明「输出解析失败（parseFail）→ 按 D3 结构化终止」） | 按阶段 2「失败停机归因总则」三分类处置：多为输出格式漂移——核对 agent.md 输出契约节后重跑；重复出现按总则归因，禁未归因直接重跑 |
| 修复后测试回归 | 从阶段 1 重来（Gate-1 → 阶段 2） |
| push 冲突 | `git fetch` 后按全局规范 merge（禁 rebase）重试；重写历史后重审未解决的 review 线程 |
| PR CI FAIL（真失败，有 step 记录） | 按日志修复 → push 新 commit → Gate-3 有限轮询直至绿 |
| PR CI FAIL（假失败：`gh run view --json jobs` 的 steps 为空） | runner 排队超时回收，job 从未启动 → `gh run rerun <runId>` 重跑 |

## [OPTIONAL] prompt 文本质量审查（CoT Leakage）

diff 触及 `z-subagent-workflow/skills/`、agent.md、prompt-builder、workflow prompt 模板时，
加载 `references/cot-leakage.md` 的分类法补充审查（泄漏 vs 引用）。本项目大量产物是
prompt 文本本身，此项尤其相关。

## 本 skill 目录结构

```
.agents/skills/pr-cr-fix/
├── SKILL.md              # 本文件
├── agents/               # 5 个维度 review agent（review-<维度>.md，仅本 skill 内部引用）
├── references/           # cot-leakage.md（prompt 文本泄漏审查，触发才 read）
├── scripts/              # quality-gate.js（增量质量门禁）/ validate-skill-yaml.py（frontmatter 校验）
└── test/                 # quality-gate.test.js（纯函数单测，node --test；改动脚本后必跑）
```

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可根据实际情况调整 |
