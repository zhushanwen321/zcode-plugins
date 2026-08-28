# zsw（z-subagent-workflow）对标 pi-subagent-workflow：全面对齐差距分析

日期：2026-08-29 · 分支：fix-review-fix-loop
对比对象：
- **zsw**：本仓 `z-subagent-workflow/`（zcode 插件，外部进程形态：CLI + daemon + 已下线的 MCP 工具面）
- **pi 版**：xyz-agent 仓 `extensions/universal/subagent-workflow/`（pi 进程内扩展，下称 **pi 版**）

平台级差异（进程内 API vs 声明式资源）的完整论证见
[zcode-vs-pi-extension-capabilities.md](zcode-vs-pi-extension-capabilities.md)，本文不重复，只引用其结论。

## 结论先行

| 对齐度 | 数量 | 典型项 |
|--------|------|--------|
| **已对上**（语义等价） | ~15 | 5 个内置 workflow 骨架、subagent 生命周期 action 面、worktree 隔离 + patch、conversation 续聊、record 持久化、skip-clean 语义（本次修复）、AbortSignal 中止契约、嵌套防护（双方都有，策略不同） |
| **可对上**（纯编排层工作，无平台阻碍） | ~14 | review-fix-loop 的批次/LLM 聚合/ID 对账/收敛检测/state 落盘、fallowScan、aggregatorModel 降档、stuckThreshold 参数化、workflow 脚本 parallel 原语、token 预算 |
| **弱形式可对上**（能力存在但可靠性/形态打折） | ~7 | 结构化输出（prompt 级 vs 引擎级 ajv）、fixAgent/agentRef 注入（依赖无头 CLI 参数探针）、多 provider 模型路由、完成通知直达会话 |
| **对不上**（zcode 平台能力缺失，不可优化） | ~6 | 工具面常驻注入（1.0.0 刻意下线，见「刻意不对齐」）、GUI 面板与消息渲染、fork 会话上下文继承、thinkingLevel per-call、事件 hooks（session 生命周期 9 类）、进程内跨扩展 API（`pi.__workflowRun`） |

另有 **刻意不对齐** 3 项（zsw 有意的设计决策，非缺口）：工具面下线（token 成本）、无 autoCommit 默认（改动留给用户）、嵌套直接拒绝（pi 允许 10 层，zsw 双门禁拒绝）。

一句话判断：**编排层语义（workflow 内部状态机）基本都能对上，只是工作量与输出可靠性问题；入口与体验层（工具面、GUI、通知直达、会话继承）受平台架构限制，最多弱形式对上。**

---

## 1. 架构前提：为什么有些永远对不上

| | pi 版 | zsw |
|---|---|---|
| 运行形态 | pi 引擎进程内 TS 扩展，直接调 runtime API | 外部进程：CLI（`bin/zsw.js`）+ 常驻 daemon + MCP server（stdio） |
| 可用能力 | tools/commands/messageRenderer 注册、9 类事件 hook、注入段、`sendMessage(triggerTurn)`、会话树/fork、GUI | 仅声明式资源（skills/commands/hooks/MCP/plugins）+ 两个程序化出口：MCP server 进程、7 事件 hooks |
| 后果 | 工具零摩擦常驻、通知直达会话并渲染、可继承父会话上下文 | 一切交互经 Bash 调 CLI；通知依赖 `run_in_background` 原生唤醒；无当前会话访问权 |

这一前提直接决定第 5 节「对不上」清单的每一条。

## 2. 外层 API 对照

### 2.1 入口面

| 能力 | pi 版 | zsw | 对齐 |
|------|-------|-----|------|
| 编排 tool | `subagent`（5 action）+ `workflow`（3 action）+ `workflow-script`（5 action）常驻注入 | 工具面 1.0.0 下线（tools/list 恒空）；走 CLI `zsw` 十子命令 + skill 引导 | 刻意不对齐（Z1 实测：MCP tool schema 全量常驻注入每个请求，token 线性上涨；pi 用同样的「一行索引常驻、正文按需读」策略应对） |
| slash command | `/subagents`（面板/cancel/message/start）、`/workflows`（面板/abort） | 无。可低成本补一个 `/zsw` 引导命令（zcode 支持 commands 资源，zsw 未声明） | 可对上（弱形式：引导性 command，非交互面板） |
| GUI 面板/消息渲染 | TUI 面板 + `subagent-bg-notify` 紫色渲染 + batch 合并 | 无（zcode 无 messageRenderer/TUI API） | **对不上** |
| skill | `subagent-ext-config`（引擎路由配置）+ `workflow-script-format`（脚本格式） | `zsub-zflow-orchestration`（总纲：分流/纪律/脚本节内联） | 形态不同、覆盖面相近；脚本格式可拆独立 skill 对齐 |
| 跨扩展 API | `pi.__workflowRun` 进程内直启 | 无对应（外部进程无此需求场景） | 对不上（无进程内模型） |

### 2.2 subagent 编排面（action 级）

| pi `subagent` action | zsw CLI | 对齐 |
|---------------------|---------|------|
| `start`（13 字段） | `zsw start`（task/slug/agent/model/schema/worktree/conversation/timeout-ms/--wait） | 骨架对上；缺 fork、thinkingLevel、appendSystemPrompt、maxTurns+graceTurns、idleTimeoutMs、engine（见第 5 节） |
| `list` / `cancel` / `message` / `close` | 同名四命令 | 对上（pi `message` 有 interrupt 标志，zsw 无） |
| —（通知制无需等待） | `wait`（多 id 挂起、partial exit 2） | zsw 特有，配合 `run_in_background` 构成唤醒闭环 |
| —（注入段 `<available_subagents>`） | `zsw agents`（四根发现，五字段索引） | 功能等价（注入式 vs 查询式——外部进程做不了注入） |
| —（注入段 `<available_provider_models>`） | `zsw models` | 同上 |

### 2.3 workflow 面（action 级）

| pi `workflow` / `workflow-script` | zsw `zsw workflow` | 对齐 |
|-----------------------------------|--------------------|------|
| run / status / abort | run / abort / status / list | 对上（pi 的 status 列 runs ≈ zsw list） |
| workflow-script generate / save / delete | 无（agent 直接写四根目录的 .js + `lint` 校验） | 功能等价度较高（AI 写脚本闭环靠 skill 引导），管理面弱 |
| workflow-script lint / list | lint / scripts | 对上 |
| run 参数：tokens/time 预算 | 无 | 可对上（timeoutMs 已有；token 预算需 usage 采集） |
| run 参数：model/thinkingLevel run 级覆盖 | `--model` 有；thinkingLevel 无 | 部分对上 |

## 3. 内层实现对照

### 3.1 执行引擎

- pi 版：进程内 Worker + 双引擎（pi/zcode）路由（`execution/engine/`），agent .md 的 engine 字段可选执行引擎；structured output 走引擎级 ajv 校验 + returnMeta（usage/durationMs/sessionId 透传）。
- zsw：无头 zcode CLI spawn（每轮冷启动 1-2s，已知边界）或 appserver 常驻（conversation 场景）；输出靠 json 围栏提取（`lib/jsonout.js`）；subagent 面的 schema 是 prompt 注入 + 收尾提取（`lib/manager.js:557-568`，promptBuilder 拼 prompt），非引擎校验。
- 判断：**双引擎路由对不上**（zsw 只有 zcode 一个引擎）；**结构化输出弱形式可对上**（机制已存在，workflow 面可复用 promptBuilder 的 schema 注入，畸形输出兜底靠 parseFail 单列——zsw review-fix-loop 已有该防御）。

### 3.2 完成通知

- pi 版：`sendMessage({triggerTurn:true, display:true})` 直达会话 + notify-ledger 账本（重启/压缩恢复重放）+ busy 退避到 idle。
- zsw：mailbox 通道为 legacy（工具面下线后恒无 targetSessionId，必不投递，`lib/manager.js:666-669`）；现役主路径 = CLI 阻塞进程作 Bash `run_in_background` 任务，完成触发引擎原生 `<task-notification>`（idle 会话也能唤醒）。
- 判断：**唤醒能力等价**（task-notification 覆盖面不差），**无条件投递对不上**（agent 忘了 run_in_background 包裹则无唤醒；pi 是扩展侧保证投递）。这是双方用户体验差异最大的单点。

### 3.3 生命周期与可恢复性

- pi 版：workflow 一次性生命周期（running→done，session 切换/关闭即作废，worker 崩溃自动重建重试 3 次）；sessions-index.json 索引加速冷扫描。
- zsw：daemon 独立于会话——record `created→running→closed|error|timeout|cancelled|lost` append-only 落盘（`~/.zcode/zsw/records.jsonl`）+ outputs 报告；recover 探活（死进程标 dead、活进程标 orphan）；reaper 清扫。
- 判断：zsw 在**跨窗口/跨会话可查性上强于 pi 版**（pi workflow 绑 session）；**自动重建重试弱于 pi**（recover 只标 lost，不重跑）。各有胜负，非缺口。

### 3.4 模型路由

- pi 版：`provider/modelId[:thinkingLevel]` 三层解析（调用参数 > agent frontmatter > 继承主 agent 当前模型），零宽容全等裁决 + Did-you-mean。
- zsw：同三层概念（参数 > frontmatter > config `model.main` > 兜底 GLM-5.3），未知模型可操作报错 + 可用清单；**单 provider 限制**（非 `builtin:bigmodel-coding-plan` 提前报错）；无 thinkingLevel 后缀语法。
- 判断：**默认模型来源是近似对齐**（外部进程读不到「主 agent 当前模型」，只能读 config——物理限制）；**多 provider 与 thinkingLevel 可对上**（config 已多 provider 时放开校验 + 探针 thinking 参数）；**零宽容裁决哲学已对齐**。

### 3.5 agent .md 体系

- pi 版：10 个内置角色（agents/ 目录随包分发）；ref 唯一形态 = 绝对路径（名字只是展示标签）；frontmatter 消费 name/description/when/notFor/tools/model/thinkingLevel/engine/defaultBackground/color/examples。
- zsw：无内置 agent；四根发现（`.agents/agents` > `.zcode/agents` 双层级，显式 follow symlink 补 zcode 引擎跳过 symlink 的缺口）；名字/路径双 ref；frontmatter 子集（name/description/when/model/tools/disallowedTools/skills/maxTurns）。
- 判断：**内置角色可对上**（插件目录带 agents/ + resolver 加插件内根；注意 zcode manifest 的 `agents` 字段「记录不执行」，必须走 resolver 自发现）；**engine/examples/color 等字段无意义对不上**（单引擎/无 GUI）；**ref 形态 zsw 更宽松**（名字 + 路径都认），不算缺口。

### 3.6 嵌套与递归

- pi 版：递归 subagent 允许，硬上限 10 层，配套递归可见性设计（docs/design/recursive-subagent-visibility）。
- zsw：双门禁直接拒绝（隔离 HOME 物理隔离 + `ZSW_NESTED=1` 拒绝），SKILL 明确「树形深度任务改用 zflow」。
- 判断：**刻意不对齐**。zcode 场景无进程内可见性、无头 spawn 冷启动成本高，递归编排风险收益比差。若未来放开，需 daemon 侧 depth 计数 + per-model HOME 池避让，成本高。

## 4. review-fix-loop 专项对照

本次已修复的语义对齐（commit `9069acc`）：`skipCleanAgents`（默认 true，clean 审查者跨轮跳过）+ `recheckAfterFix`（默认 false；true 时 fix 后全批重派、clean 者走限定复检 prompt，scope 取 git diff 实测）。修复同时纠正了两个叠加 bug：clean 集合存对象致 filter 恒不命中、fix 后无条件 clear。

剩余差距按「可否优化到对上」分档：

### 4.1 可对上（纯编排层移植，无平台阻碍）

锚点列均指 pi 版 `workflows/review-fix-loop.js` 行号（2026-08-29 快照）。

| pi 版能力 | 锚点 | zsw 现状 | 移植路径 |
|-----------|------|----------|----------|
| targetType 枚举 + base 锁定 | review-fix-loop.js:188-196 | reviewTarget 自由文本 | lockReviewBase 同款 execSync 模式（本次修复已引入 gitHead/gitModifiedSince，直接扩展） |
| batchN 多批串行 + 跨批 skip | :648-679 | 无批次 | 外层 for + shouldSkipAgent 纯函数移植 |
| LLM aggregator（裁决/降级/guidance） | :819-930 | JS 标题归一去重 | 增一个聚合 phase（spawn + json 围栏提取）；parseFail 已有单列防御 |
| reconciliation ID 对账 + dormant | :933-1057 | 无 | 纯状态机逻辑，无外部依赖 |
| needs-redesign（maxFixAttempts） | :1059-1080 | 无 | fixAttempts 计数 |
| 收敛检测（convergeNewIssues/Rounds） | :1082-1116 | 无 | 新发现率统计 |
| stuckThreshold 参数化（默认 3） | :42 | 硬编码 2 且不可调 | 一行参数化 |
| maxRounds 默认值 | 10 | 5 | 一行（需决策：对齐 10 还是保留 5） |
| fallowScan 前置批 | :202-208 | 无 | fallow CLI 探测 + 前置批 |
| aggregatorModel 降档 | :179-183 | 无 | model-router 多 ref 解析已支持 |
| state.json 落盘仪表（calls/usage/scores/phaseTimings） | :386-504 | outputs 单报告 | 落盘扩展（runId 目录） |
| autoCommit | :1173-1177 | 永不提交 | fix prompt 加 commit 指令；**建议保持默认 false**（与「改动留给用户」哲学一致，pi 默认也是 false） |
| 修复范围全等级（must-fix + suggestion） | :6-7 | must-fix 驱动；minor 不阻塞整体收敛（clean 判定含任何 issue，但聚合只喂 must-fix，整体 must-fix=0 即终止） | 语义差异如实记录；如对齐需 fix prompt 喂全量 + 终止判定加 suggestion===0 |

### 4.2 弱形式可对上（机制存在，可靠性打折）

| pi 版能力 | zsw 阻碍 | 弱形式路径 |
|-----------|----------|------------|
| reviewer/aggregator/fixer 的 ajv schema 强校验输出 | 无头 CLI 无引擎级 schema 通道 | 复用 subagent 面 promptBuilder 的 schema 注入 + 提取校验（`lib/manager.js:557`）；畸形率高于 ajv，需 parseFail 重试策略 |
| fixAgent（.md 指定修复者 + systemPrompt 注入） | 无头 spawn 的 systemPrompt 注入参数无公开契约（AGENTS.md 架构边界 4：zcode CLI 参数面漂移） | 先跑冒烟探针（`--append-system-prompt` 类参数是否被接受）；不可用则退化为 prompt 内联 agent .md 正文（正文拼进 prompt，成本更高但可行） |
| usage 透传（returnMeta，成本观测） | 无头 CLI 输出 JSON 是否含 usage 待验证（fake 测试有该字段，真机待探针） | 探针验证后接入 calls[] 采集 |
| token/time 预算（$BUDGET） | 同上依赖 usage | usage 可得后累加熔断 |

### 4.3 对不上（本 workflow 语境下无对应物）

| pi 版能力 | 原因 |
|-----------|------|
| 缓存前缀稳定化（T9：schema 逐字嵌入 appendSystemPrompt 保证消息级缓存命中） | zcode 无头会话的缓存策略不受外部进程控制 |
| report_file 落盘 + aggregator 读文件（省 48% 重复正文，W6） | zsw 可仿（reviewer 输出落盘、聚合 prompt 只给路径），但无头会话无 read 工具约束时的可靠性待验证——列为待验证而非永久对不上 |

## 5. 对不上清单（平台级，含原因）

1. **工具面常驻注入**：pi 主 agent 直接调 tool，zsw 靠 Bash + CLI + skill 纪律。zcode MCP tool schema 全量常驻注入（Z1 实测），zsw 1.0.0 刻意下线。若追求体验对齐可选折中：恢复双 tool 但 description 压到极小（≤1.25KB 同 pi 策略）——但这与 1.0.0 决策冲突，需用户重新决策，不是单向优化。
2. **GUI 面板与消息渲染**：zcode 无 messageRenderer/TUI 面板 API。
3. **fork 会话上下文继承**：外部进程无当前会话访问权；zcode 会话数据无公开读取契约。
4. **thinkingLevel per-call**：zcode CLI 参数面无公开契约（AGENTS.md 架构边界 4）；探针后可升级为弱形式可对上。
5. **appendSystemPrompt / maxTurns / graceTurns per-call**：同上。
6. **9 类事件 hooks（session_start/compact/before_agent_start/model_select/…）**：zcode 仅 7 个 hook 事件且是 shell 命令形态，事件集不重合的部分（compaction 恢复、模型选择、会话树）无对应物。
7. **busy 退避投递 / notify-ledger**：依赖进程内 sendMessage；zsw 的 task-notification 唤醒是唯一等价物。

## 6. 可行动优化清单（按价值排序）

| # | 项 | 档位 | 建议 |
|---|-----|------|------|
| 1 | review-fix-loop 批次 + LLM 聚合 + ID 对账（4.1 前四行打包） | 可对上 | 长期方案；最大语义缺口，纯移植无风险 |
| 2 | stuckThreshold/maxRounds 参数化 | 可对上 | 短期方案；一行成本，立即对齐 pi 参数面 |
| 3 | state.json + usage 仪表落盘 | 可对上（usage 待探针） | 长期方案；先落盘已有的 phase/round 数据 |
| 4 | 无头 CLI 参数探针（thinkingLevel/appendSystemPrompt/usage） | 探针 | 升级 4.2 两项的前提；探针命令见 local-dev-guide |
| 5 | 内置 agent 角色集（插件内 agents/ + resolver 第五根） | 可对上 | 中期；降低用户上手成本 |
| 6 | `/zsw` 引导 command | 可对上 | 短期；低成本提升入口可见性 |
| 7 | workflow 脚本 parallel()/pipeline() 原语 + @pi-meta | 可对上 | 中期；脚本表达力对齐 |
| 8 | fallowScan / aggregatorModel / autoCommit（默认 false） | 可对上 | 低优先；跟随 #1 一起做 |
| 9 | 多 provider 放开 | 可对上 | 等 config 实际出现第二 provider 再做（不做推测性功能） |

## 7. 判断依据与局限

- 事实来源：zsw 侧逐文件读源码（本 worktree 当前状态）；pi 版侧读 workflows/review-fix-loop.js 全文 + index.ts/interface 层调研（2026-08-29 快照）。pi 版 `src/orchestration/` 执行链细节未逐行核对（对齐判断不受影响：差异都发生在接口层与编排层）。
- 「对不上」的判断基于 zcode 官方文档定义的能力面 + 本仓 AGENTS.md 架构边界记录（无进程内 API、CLI 参数漂移、GUI 启动扫描）；若 zcode 后续开放对应能力，第 5 节条目可降级为弱形式可对上。
