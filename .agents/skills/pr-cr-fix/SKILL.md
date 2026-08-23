---
name: pr-cr-fix
description: >-
  分支对抗式审查-修复-提PR skill：static gate → 多维 review（agent.md checklist 驱动）
  → 聚合 must-fix → 修复 → 重审 → pre-merge 终验 → push + 开 PR。触发词："review"、
  "审查代码"、"code review"、"对抗式审查"、"review and fix"、"pr-cr-fix"、
  "审查分支变更"、"开 PR"、"review 完开 PR"。不用于 纯 git 操作、push 排查、
  单文件快速自查（主会话直接读代码即可）、合并回 main（merge skill）。
---

# 对抗式审查-修复-提 PR Skill

static gate → review-fix-loop（多维 review → 聚合 → 修复 → 重审到 clean）→ pre-merge
终验 → push + 开 PR。移植自 xyz-agent 的 pr-cr-fix，按本项目（zcode 插件工作区，bare repo
+ worktree + npm tag 直发管线）裁剪调优。

## 与 xyz-agent 版的差异（调优声明）

| 差异点 | xyz-agent 版 | 本项目版 | 原因 |
|--------|--------------|---------|------|
| PR/push 阶段 | 阶段 1 开 PR / 阶段 3 推 PR | 阶段 3（review 闭环后一次性 push + 开 PR） | 远端 2026-08-23 绑定（zhushanwen321/zcode-plugins）后补齐；review 前不开 PR（review 中分支还会变） |
| 度量/覆盖率门禁 | fallow metrics-gate + vitest coverage-gate | 无 | 本仓零依赖纯 Node，无对应基础设施；static gate 由 node --test + npm 三件套 gate 承接 |
| changeset 门禁 | changeset 检查（extensions 发布流） | check-sync + check-pack + check-release-needed | 本仓发布走 tag 直发（非 changesets）：三件套一致性 + 包内容 + 改动-发版关联检测（UNDECLARED 等价物） |
| reviewer 输出契约 | YAML frontmatter + structured-output tool | json 围栏块（review-fix-loop 的 extractJsonObject 契约） | 两套 workflow 的解析器不同；契约不匹配 = parseFail 按 clean 处理，静默漏审 |
| agent.md 消费方式 | pi workflow batch1 传 agent 路径 | task 内映射表 + reviewer 自行 Read | 本项目 reviewers 是视角名（非 agent .md 引用），workflow prompt 模板不挂 agent |
| 审查维度 | 8 维（含 electron-build/extension-api 等） | 5 维（zsw 领域重划） | 本仓是零依赖 Node CLI/MCP server，无 Electron/monorepo |

## 前置条件 [MANDATORY]

- 分支相对 main 有 commits（`git log main..HEAD` 非空）
- 工作区 clean（fix 阶段会写文件，脏工作区混入认知外改动）
- node ≥ 20（node --test 需要）

## 阶段 1：static gate（主 agent 直接跑）

与 CI（ci.yml）同构的本地口径 + npm 管线 gate：

```bash
# 1. 全量单测，排除 e2e（真机+真实模型，成本高/限流敏感；真机验收按插件 README 手册单独跑）
cd <repo>/z-subagent-workflow && \
  find test -name '*.test.js' ! -name 'e2e.test.js' -print0 | xargs -0 node --test

# 2. npm 三件套 gate：版本三处一致 / 包名规范 / 零依赖红线 + 包内容完整
cd <repo> && node scripts/check-sync.js && node scripts/check-pack.js
```

**Gate-1**（硬 gate）：全绿才进阶段 2。FAIL 按失败用例派 worker 修复后重跑；check-sync 的
版本漂移禁手工单改文件对齐——见失败恢复表。禁止跳过任何用例。

## 阶段 2：review-fix-loop（主 agent 直接派 workflow，禁止 subagent 封装）

用本项目自产的 zflow tool（dogfooding；无 MCP 环境时 CLI 等价命令在下方）：

```
zflow(action="run",
  workflow="review-fix-loop",
  task=<下方模板，含 agent.md 映射表>,
  workdir=<仓库绝对路径>,
  reviewTarget="git diff main...HEAD 的全部变更（分支整体，含 z-subagent-workflow/lib、bin、dist、test、skills 与 workspace 级 scripts/、.github/、.githooks/、docs/）",
  reviewers=["arch-boundary", "concurrency", "business-logic", "mcp-contract", "test-coverage"],
  maxRounds=3)
```

CLI 等价（一次性进程，同步等完成输出报告）：

```bash
node z-subagent-workflow/bin/zsw.js workflow \
  --workflow review-fix-loop \
  --task "<同上模板>" --workdir <仓库绝对路径> \
  --reviewers "arch-boundary,concurrency,business-logic,mcp-contract,test-coverage" \
  --review-target "git diff main...HEAD 全部变更" \
  --max-rounds 3
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

**Gate-2**：run 终态 `ok`（clean）→ 进阶段 3；`fixed-unverified` → 再跑一轮确认；
`stuck` / `fix-failed` → 看报告区分误报与真问题，真问题人工介入。

### 降级路径（无 workflow 能力时）

主 agent 用 Agent tool 手工派 5 个 reviewer（并行 ≤3 分两批），每个 task 含：workdir 绝对
路径 + agent.md 绝对路径（subagent 须复读原文）+ 审查范围 + 输出格式（Findings 表格：
优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向）。聚合去重后派 worker 修 MUST_FIX，修完重审
一轮。上限 2 轮。

## 阶段 3：pre-merge 终验 + push + 开 PR

### 3a — 终验（review-fix-loop 的 fix 阶段改过代码，Gate-1 读数已过期）

重跑阶段 1 static gate 全部命令（单测 + check-sync + check-pack）。
**Gate-3a**：全绿才进 3b；FAIL 派 worker 修复后从 3a 头部重跑。

**3a.5 发版面提醒（软 gate，AskUserQuestion）**：跑 `node scripts/check-release-needed.js`。
`UNRELEASED` 非空（改了消费者可见文件但版本未 bump）时问用户：本次发版（记下待发插件，
合 main 后走 merge skill 阶段 5 / release.js）/ 纯内部改动不发版（PR body 注明）。
`SHARED_CHANGED` 警告时确认 vendored 插件是否需要重发。不阻塞流程——防 bug fix 静默丢失，
决策权在用户。

### 3b — PR title/body 自动生成 + push（需用户授权）+ 建 PR

**[MANDATORY] push 前必须获得用户明确授权**——告知审查与终验结果，等确认。

PR 内容从分支 commits 自动生成（英文，无需用户提供）：

1. 收集：`git log main..HEAD --format="%s%n%b---"` + `git diff main...HEAD --stat`
2. title：conventional commit 风格（`feat(zsw): ...`，scope 用插件缩写；多主题取最核心）
3. body：`## Summary`（改动目的）+ `## Changes`（逐 commit 关键点，合并相关条目）+
   `## Test plan`（单测 N 项绿 + check-sync/check-pack 结果；注明 e2e 未跑及原因）

```bash
git push origin HEAD
gh pr create --repo zhushanwen321/zcode-plugins \
  --head "zhushanwen321:$(git branch --show-current)" --base main \
  --title "$PR_TITLE" --body "$PR_BODY"
# 已有 PR（重跑场景）：gh pr edit 同名 PR 更新 title/body
```

**Gate-3**：PR URL 匹配 `^https://github\.com/.+/pull/\d+$`；push 后
`gh pr checks --watch` 等 CI 绿（CI FAIL 按日志修复 push 新 commit，直至绿）。
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
2. **主 agent 不亲自做维度审查**：review 委托 workflow（或降级路径的 subagent）；主 agent只编排 + gate 校验。
3. **fix 后必须重跑终验**：review-fix-loop 的 fix 阶段会改文件，Gate-1 读数过期——3a 重跑全部 static gate。
4. **agent.md 是审查契约**：reviewer 未按 checklist 执行的输出视为无效，重派。
5. **不提交认知外改动**：fix 阶段改动逐条核对归属后按全局提交策略 commit。
6. **push 必须用户授权**（全局规则）；force-push 场景一律 `--force-with-lease`，裸 `--force` 禁止。
7. **禁 skip 开关**：`--no-verify` / 跳过用例 / 吞 stderr。检查不通过 = 流程中止，唯一出路是修复。

## 反模式

| 反模式 | 后果 |
|------|------|
| reviewer 不读 agent.md 直接凭感觉审 | 维度漂移，checklist 形同虚设 |
| agent.md 输出格式写成 YAML frontmatter（xyz-agent 契约） | 本项目 workflow parseFail → 按 clean 处理 → 静默漏审 |
| 风格问题标 major/critical | 聚合器误触发 fix 轮次，浪费 |
| subagent 封装 zflow 调用 | 多一层无增益中转 |
| 脏工作区跑审查 | fix 改动与认知外改动混淆 |
| 用旧 token（`run_workflow` tool / `zsub` 目录名 / `bin/zsub.js`） | 2026-08 改名后失效；命名 SSOT 见 z-subagent-workflow/CONTEXT.md |
| review 前先开 PR | review/fix 期间分支会变，PR 描述反复过期；PR 在 3b 一次性开 |
| 删/改 agents/ 下的 review agent | 破坏 review 维度完整性 |

## 失败恢复

| 失败 | 动作 |
|------|------|
| Gate-1 测试 FAIL | 按失败用例派 worker 修复后重跑 |
| Gate-1 check-sync 版本漂移 | 禁手改单文件对齐：将要发版 → 用 `scripts/release.js` 统一 bump 三处；不发版 → 以 main 版本为准回退漂移文件 |
| Gate-1 check-pack 包缺文件 | package.json `files` 白名单补齐后重跑 |
| workflow run error 终态 | 看 record 的 error 字段恢复指引（超时调大 timeoutMs / 拆小范围） |
| Gate-2 `stuck` | 看报告剩余 must-fix：误报人工 ack，真问题人工介入 |
| reviewer parseFail 告警 | 重跑该维度（输出格式漂移，检查 agent.md 输出契约节） |
| 修复后测试回归 | 从阶段 1 重来（Gate-1 → 阶段 2） |
| push 冲突 | `git fetch` 后按全局规范 merge（禁 rebase）重试；重写历史后重审未解决的 review 线程 |
| PR CI FAIL | 按日志修复 → push 新 commit → `gh pr checks --watch` 直至绿 |

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
└── scripts/              # validate-skill-yaml.py（SKILL.md frontmatter 校验，通用）
```

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可根据实际情况调整 |
