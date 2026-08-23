---
name: pr-cr-fix
description: >-
  zsub 分支对抗式审查-修复 skill：多维 review（agent.md checklist 驱动）→ 聚合
  must-fix → 修复 → 重审到 clean。触发词："review"、"审查代码"、"code review"、
  "对抗式审查"、"review and fix"、"pr-cr-fix"、"审查分支变更"。
  不用于 纯 git 操作、push 排查、单文件快速自查（主会话直接读代码即可）。
---

# zsub 对抗式审查-修复 Skill

审查分支变更（`git diff main...HEAD`）→ 5 维并行 review → 聚合 must-fix → 修复 → 重审，循环到 clean。移植自 xyz-agent 的 pr-cr-fix（源头 `~/Code/xyz-agent-workspace/main/.agents/skills/pr-cr-fix/`），按 zsub 项目裁剪调优。

## 与 xyz-agent 版的差异（调优声明）

| 差异点 | xyz-agent 版 | zsub 版 | 原因 |
|--------|--------------|---------|------|
| PR/push 阶段 | 开 PR → pre-merge → push | 无 | 本仓库无 gh remote，本地 bare+worktree；push 遵循全局授权规则 |
| 度量/覆盖率门禁 | fallow metrics-gate + vitest coverage-gate | 无 | zsub 零依赖纯 Node，无对应基础设施；static gate 由 `node --test` 全量承接 |
| changeset 门禁 | 有（extensions 发布流） | 无 | 非 npm 发布仓库 |
| reviewer 输出契约 | YAML frontmatter + structured-output tool | json 围栏块（zsub review-fix-loop 的 extractJsonObject 契约） | 两套 workflow 的解析器不同；契约不匹配 = parseFail 按 clean 处理，静默漏审 |
| agent.md 消费方式 | pi workflow batch1 传 agent 路径 | task 内映射表 + reviewer 自行 Read | zsub reviewers 是视角名（非 agent .md 引用），prompt 模板不挂 agent |
| 审查维度 | 8 维（含 electron-build/extension-api/monorepo-impact） | 5 维（zsub 领域重划） | zsub 是单包 Node CLI/MCP server，无 Electron/monorepo |

## 前置条件 [MANDATORY]

- 分支相对 main 有 commits（`git log main..HEAD` 非空）
- 工作区 clean（fix 阶段会写文件，脏工作区混入认知外改动）
- node ≥ 18（node --test 需要）

## 阶段 1：static gate（主 agent 直接跑）

```bash
# 全量单测（typecheck/lint 的等价物：零依赖项目语法错即测试挂）
cd <repo>/zsub && node --test $(ls test/*.test.js | grep -v 'e2e\.test\.js$')
# 入口语法
node --check bin/zsub.js && node --check dist/mcp/server.js
```

e2e.test.js 是真机 + 真实模型调用（成本高、账户限流敏感），不进 static gate——需要真机验收时单独跑 `node --test test/e2e.test.js`。

**Gate-1**（硬 gate）：全绿才进阶段 2。FAIL 按失败用例派 worker 修复后重跑。禁止跳过任何用例。

## 阶段 2：review-fix-loop（主 agent 直接派 workflow，禁止 subagent 封装）

用本项目自产的 `run_workflow` MCP tool（dogfooding；无 MCP 环境时 CLI 等价：`node z-subagent-workflow/bin/zsub.js workflow --workflow review-fix-loop ...`）：

```
run_workflow(action="run",
  workflow="review-fix-loop",
  task=<下方模板，含 agent.md 映射表>,
  workdir=<仓库绝对路径>,
  reviewTarget="git diff main...HEAD 的全部变更（分支整体，含 z-subagent-workflow/lib、z-subagent-workflow/bin、z-subagent-workflow/dist、z-subagent-workflow/test、z-subagent-workflow/skills；design/ 文档变更一并审查）",
  reviewers=["arch-boundary", "concurrency", "business-logic", "mcp-contract", "test-coverage"],
  maxRounds=3)
```

### task 模板 [MANDATORY 结构]

```
审查 zsub 插件分支（feat-zcode-subagent-plugin）相对 main 的全量变更。

## 审查者 → checklist 映射（开始审查前必须 Read 对应文件并严格执行其 checklist）
- 审查者「arch-boundary」→ Read <repo>/.agents/skills/pr-cr-fix/agents/review-arch-boundary.md
- 审查者「concurrency」→ Read <repo>/.agents/skills/pr-cr-fix/agents/review-concurrency.md
- 审查者「business-logic」→ Read <repo>/.agents/skills/pr-cr-fix/agents/review-business-logic.md
- 审查者「mcp-contract」→ Read <repo>/.agents/skills/pr-cr-fix/agents/review-mcp-contract.md
- 审查者「test-coverage」→ Read <repo>/.agents/skills/pr-cr-fix/agents/review-test-coverage.md

只执行自己维度对应的 checklist；其他维度的问题留给对应审查者，不跨维度报。
```

`<repo>` 替换为仓库绝对路径（reviewer 的 cwd 是 workdir，但用绝对路径防歧义）。

**Gate-2**：run 终态 `ok`（clean）→ 完成；`fixed-unverified` → 再跑一轮确认；`stuck` / `fix-failed` → 看报告区分误报与真问题，真问题人工介入。

### 降级路径（无 workflow 能力时）

主 agent 用 Agent tool 手工派 5 个 reviewer（并行 ≤3 分两批），每个 task 含：workdir 绝对路径 + agent.md 绝对路径（subagent 须复读原文）+ 审查范围 + 输出格式（Findings 表格：优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向）。聚合去重后派 worker 修 MUST_FIX，修完重审一轮。上限 2 轮。

## 维度 → Agent 映射（两路径共用）

Agent 定义位于本 skill 目录 `agents/review-<维度>.md`（不全局暴露，仅审查流程内部引用；不进 `.zcode/agents/`——它们是 reviewer checklist 不是引擎 subagent 实体）。

| 维度 | Agent 实体 | 审查焦点 |
|------|-----------|---------|
| 架构边界 | `agents/review-arch-boundary.md` | 端口/适配器边界（ports.js 契约单向依赖、三决策位可换性、平台漂移限制在端口实现内、manager 与入口薄壳分离、workflow/subagent 双 manager 职责） |
| 并发与资源 | `agents/review-concurrency.md` | AbortSignal 全链传播（spawn 前预检/运行中杀停/编排检查点）、slots 深度分层、reaper 孤儿清理、worktree 泄漏、进程/定时器句柄泄漏、record 终态一致性 |
| 业务逻辑 | `agents/review-business-logic.md` | 编排正确性（状态机转换、错误路径、部分完成语义、边界条件、文本截断、停滞检测、cleanReviewers 重审语义） |
| MCP 契约与 IO | `agents/review-mcp-contract.md` | tool schema/description 一致性、必填性与模式语义、json 围栏提取鲁棒性、文件写入原子性、错误消息可操作性闭环 |
| 测试覆盖 | `agents/review-test-coverage.md` | 新增逻辑有测试、node --test 合规、断言强度（修前红修后绿）、abort/超时/并发边界用例、单测与 e2e 边界 |

## 严重度分级（对齐 zsub review-fix-loop 聚合器）

| 本 skill 语义 | workflow severity | 聚合器判定 |
|---------------|-------------------|-----------|
| MUST_FIX（阻塞：架构违规 / 会出 bug / 违反 [HISTORICAL] 规则） | `critical` 或 `major` | 计入 must-fix，进 fix 阶段 |
| SUGGESTION（强烈建议：可维护性） | `minor` | 不阻塞 |
| INFO（可选：风格/文档） | `minor` | 不阻塞 |

reviewer 只在真 must-fix 时给 critical/major；风格问题一律 minor——workflow 聚合对 minor 不触发修复，报错级别会浪费 fix 轮次。

## 关键约束 [MANDATORY]

1. **阶段顺序不可调换**：Gate-1（测试全绿）→ 阶段 2（review-fix-loop）。
2. **主 agent 不亲自做维度审查**：review 委托 workflow（或降级路径的 subagent）；主 agent 只编排 + gate 校验。
3. **fix 后测试必须重跑**：review-fix-loop 的 fix 阶段会改文件，Gate-1 读数过期——run 终态 clean 后重跑 `node --test test/`，FAIL 则从阶段 1 重来。
4. **agent.md 是审查契约**：reviewer 未按 checklist 执行的输出视为无效，重派。
5. **不提交认知外改动**：fix 阶段改动逐条核对归属后按全局提交策略 commit。

## 反模式

| 反模式 | 后果 |
|--------|------|
| reviewer 不读 agent.md 直接凭感觉审 | 维度漂移，checklist 形同虚设 |
| agent.md 输出格式写成 YAML frontmatter（xyz-agent 契约） | zsub workflow parseFail → 按 clean 处理 → 静默漏审 |
| 风格问题标 major/critical | 聚合器误触发 fix 轮次，浪费 |
| subagent 封装 run_workflow 调用 | 多一层无增益中转 |
| 脏工作区跑审查 | fix 改动与认知外改动混淆 |
| 删/改 agents/ 下的 review agent | 破坏 review 维度完整性 |

## 失败恢复

| 失败 | 动作 |
|------|------|
| Gate-1 测试 FAIL | 按失败用例派 worker 修复后重跑 |
| workflow run error 终态 | 看 record 的 error 字段恢复指引（超时调大 timeoutMs / 拆小范围） |
| Gate-2 `stuck` | 看报告剩余 must-fix：误报人工 ack，真问题人工介入 |
| reviewer parseFail 告警 | 重跑该维度（输出格式漂移，检查 agent.md 输出契约节） |
| 修复后测试回归 | 从阶段 1 重来（Gate-1 → 阶段 2） |

## [OPTIONAL] prompt 文本质量审查（CoT Leakage）

diff 触及 `z-subagent-workflow/skills/`、agent.md、prompt-builder、workflow prompt 模板时，加载 `references/cot-leakage.md` 的分类法补充审查（泄漏 vs 引用）。zsub 大量产物是 prompt 文本本身，此项对它尤其相关。

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
| `[OPTIONAL]` | 可选步骤 | 可根据实际情况决定 |
