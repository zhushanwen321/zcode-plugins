# z-sw 插件下沉消费收口设计（zcode-plugin-workspace 侧）

> 一句话结论：core 下沉批次（xyz-agent 仓 subagent-core-sink-design）交付新导出面后，本插件一次性完成消费改造——退役全部复刻实现、收紧两处安全/预算行为、统一 workflow ref 契约、裁决 record-store 归属，并随 zsw 2.0.0 单次发版消化全部行为变更。

- 层声明：技术方案层 → 下一层 = 可实现接口与实施单元（消费改造单元 + 发版步骤）。
- 依赖：core 新导出面契约以姊妹文档 `subagent-core-sink-design.md` §3.3/§5.2 为准（本文档 §3.0 完整转载消费面清单，自包含可读）。
- 审查基线：feat-app-server-refactor 分支（下沉审查 RT2 逐文件报告 + RT1/RT3 对照，2026-08-31）。

## 1 背景目标

### 1.1 SCQA

- **S（情境）**：z-sw 插件经 vendored 副本消费 subagent-core。历史收口已完成四大域（资产/发现/渲染/创作管线），但 core barrel 未导出的域仍在插件层各持一份实现。
- **C（冲突）**：下沉审查证实本插件 24 个 lib 文件中 5 个为 mixed、1 个 pure-portable（`worktree.js` 全文件纯 git 逻辑）；20 条下沉候选中本插件涉及 17 条。其中 3 处已发生**对本插件用户可见的语义漂移**：`maxTurns: 2` 实际 10 分钟被杀（pi 侧 30 分钟，floor 丢失）；`..` 路径引用放行（pi 侧同放行，安全双缺失）；agent .md frontmatter **解析能力缺失**——zsw 手写 parser 不支持 block-scalar 等标准 YAML 形态（pi 侧经 core yaml 解析器完整支持；现 vendored 内置 10 角色均为单行 description 故内置资产暂未受害，风险作用于用户自建资产与资产演进）。另有无声恶化项：`workflow-state/` 目录因无 prune 无限累积。
- **Q（问题）**：core 下沉批次交付后，本插件如何一次完成消费改造，使复刻清零、漂移修复、行为变更可控可发布？
- **A（答案）**：本设计给出 17 条候选的逐条消费动作（改调 barrel / 退役复刻 / 行为变更登记）、两处契约裁决（workflow ref、record-store）、发版时序（随 core 0.4.0 刷新、zsw 2.0.0 消化 break）。

### 1.2 系统是什么（受众认知补足）

z-sw（`z-subagent-workflow/`）是 zcode 平台的子代理编排插件：CLI（zsub/zflow 两域九 action）+ SessionStart hook 注入 + daemon socket + MCP 壳（tools/list 恒空）。运行时实体 = vendored core 副本（`lib/vendor/subagent-core/`，vendor 脚本按 **barrel 导出面**拷贝 + sha256 manifest 自检）+ 插件自有 lib（宿主适配层）。三种安装形态：marketplace 副本 / inline dev / npm 包——vendored 设计保证三形态行为一致。

### 1.3 设计目标

| # | 目标 | 验证锚点 |
|---|---|---|
| G1 | **复刻清零**：审查点名的复刻实现全部退役（worktree.js 289 行 → 锚点适配层、agent-discovery parser/normalizeAgentRef 退役、slots 收敛、normalizeRunParams 白名单退役），lib 总行数净减 | §4 S1 |
| G2 | **漂移修复落地**：30min floor、`..` 收紧、block-scalar/maxTurns 口径三项用户可见修复生效 | §4 S2 |
| G3 | **契约统一**：workflow ref 走 core `normalizeWorkflowRef` 单一权威；record-store 归属有裁决结论 | §4 S3 |
| G4 | **三形态不破**：marketplace 副本 / inline dev / npm 包行为一致，vendored 自检防「半刷新」 | §4 S4 |
| G5 | **发版一次到位**：全部行为变更（含 break）随 zsw 2.0.0 单版本消化，release notes 完整 | §4 S5 |

### 1.4 Scope

**In scope**：core 新面消费改造（17 条）；`..` 校验收紧（行为变更）；workflow ref 契约统一（含 saved 裸名放行裁决）；record-store 归属裁决与路径注入参数化；宿主内清理（modelEntries 双份、格式函数）；vendored 刷新时序；2.0.0 发版与 breaking notes。

**Out of scope**：core 侧改造（姊妹文档，本插件只消费）；zsw record 状态机到 core 模型的物理迁移（本设计裁决「暂不下沉 + 参数化」，物理迁移另立项）；zsub ledger/reaper/mailbox/jsonout 等 7 项已裁决平台绑定面（维持现状）；workflow 线并发配额（已裁决文档化，不加门闩）。

## 2 现状与问题分析

### 2.1 复刻与漂移现状（使用者视角真实例子）

**例 1（预算）**：用户 agent 写 `maxTurns: 2`。`manager.js:53-58` `MS_PER_TURN=300_000` 自算 10 分钟超时，无 floor；core watchdog 同语义为 `max(30min, 5min/turn)`。用户在 pi 与 zcode 两平台跑同一资产，一个 30 分钟一个 10 分钟。

**例 2（安全双缺失）**：模型产出 agent 引用 `/tmp/x/../../home/u/.md`。`agent-discovery.js:202-212` 只查绝对路径与 `.md` 后缀——`..` 穿越放行；pi 侧同参数**同样放行**（`assertSafeStartPath` 仅两处调用点均不涉 agent 参数，`subagent-tool.ts:316-317` 只守 skillPath/cwd）。两宿主对该引用均无防御——本下沉批次经 core normalizeRef 统一收紧（对两宿主均为行为变更）。

**例 3（无声累积）**：每次 workflow run 在 `<zswRoot>/workflow-state/` 落一个状态文件。core FileRunStore 无 prune（grep 零命中已核实）、插件 reaper 职责边界不覆盖（`reaper.js:5-11` 头注声明只管 outputs/），长期使用目录无限增长。pi 侧同域有 `pruneStateFilesBeyondCap`。

**例 4（复刻面）**：`worktree.js` 289 行为纯 git 封装（SAFE_ID_RE、GIT_TIMEOUT_MS=30_000、intent-to-add、保真读与 core 逐字同源）；`orchestration-host.js:114-143` 注释自认「core 未导出 WorkflowScript 类」而手工拼鸭子实体——导出面缺口逼出的实现，core 演进即失配。

### 2.2 消费改造全清单（17 条 → 动作映射）

| # | 能力 | core 新面（姊妹文档单元） | 本插件动作 |
|---|---|---|---|
| C1 | agent-ref 面 | `normalizeRef/AGENT_REF_EXT/WORKFLOW_REF_EXT/displayAgentName` + 报错文案工厂 | `normalizeAgentRef` 退役改调；`expandHome`/`stem` 复刻删除；错误文案改工厂注入 `howToList` 尾巴 |
| C2 | `..` 安全校验 | normalizeRef 内建拒绝 | **行为变更**：放行 → 拒绝（错误含恢复指引） |
| C3 | WorkflowScript 工厂 | `loadWorkflowScriptByPath` + 类导出 | `loadScriptFromPath` 鸭子实体退役，registry 收缩为差异合并层 |
| C4 | watchdog | `maxTurnsToWatchdogMs` | `MS_PER_TURN` 退役，决策链改调（**行为变更**：floor 恢复） |
| C5 | 并发池 | `createConcurrencyPool({ maxConcurrent, queuePolicy })` | `slots.js` 收敛为薄配置（strict-fifo 注入）或退役 |
| C6 | worktree git 内核 | `worktree-git-ops`（锚点抽象） | `worktree.js` 收缩为锚点实现（sidecar 持久锚点）+ 布局/孤儿策略层 |
| C7 | agents 装配 | `discoverAgents`（core U2 已裁决交付） | `listAgents` 装配循环退役改调 |
| C8 | parseAgentProfile | 宽容解析 + AgentMeta 执行字段 | `parseAgentMd/parseFrontmatter/scalar/toProfile` 退役；`parseFile` 改 `getCachedParsed` 获缓存 |
| C9 | 模型切分原语 | `splitZcodeModelRef/DEFAULT_PROVIDER_ID/ZCODE_FALLBACK_DEFAULT_MODEL/hasApiKey` | `splitModelRef` 改薄包装；`hasProviderCredentials` 与 core `hasApiKey` 统一为非空 string 裁决 |
| C10 | isProcessAlive | barrel 导出 | `runner-core.alive()` spawn 分支与 `daemon-socket.probeLockHolder` 改调 |
| C11 | SLUG_MAX_LENGTH | barrel 导出 | `manager` slug 校验补长度闸（**行为变更**：超长拒绝，错误含恢复指引） |
| C12 | 崩溃恢复 | `recoverCrashedRuns` | `recoverOrphans` 改调 core（错误文案参数传入） |
| C13 | prune | `FileRunStore.pruneStateFilesBeyondCap` | daemon 启动/session start 接线 + env 上限透传（**无声恶化项修复**） |
| C14 | runSummary/isScriptRunning | barrel 导出 | `runSummary` 投影改 core 单源 + 宿主扩展字段（model）；`runningScriptPredicate` 改调 |
| C15 | 原子写 | `shared/atomic-write.ts` | `output-store.atomicWrite` 与 `notifier-mailbox` tmp+rename 改调 |
| C16 | schema 助手 | `normalizeArgsByMeta/argKeysFromMeta/findFlattenedArgKeys` | `normalizeRunParams` 白名单段（:326-334 + review-fix-loop 17 键）退役改喂 meta；CLI `buildWorkflowRunParams` consumedArgs 同步 meta 驱动；组 args 前接平铺检测 |
| C17 | workflow ref | `normalizeWorkflowRef(ref, {knownNames})` | `validateWorkflowRef` 三处口径（bin 入口/orchestration-host/daemon-MCP）统一改调，knownNames 策略注入（见 D-E3 裁决） |

### 2.3 根因（本插件视角）

复刻不是实施错误，是 core 导出面缺口的必然沉淀——`agent-discovery.js:194-197`、`orchestration-host.js:114-116` 注释均自认「core 未导出故复刻」。因此本设计的正确姿势是**退役而非重构**：core 面到位后，复刻代码直接删除，不保留插件层第二实现。

### 2.4 数据流（改造后 vendored 通道）

```
core 0.4.0 dist ──vendor --npm──▶ lib/vendor/subagent-core（barrel 导出面 + sha256 manifest）
                                     │
   插件 lib 适配层（config/daemon/hook/manager 壳）──消费──▶ 新导出面（ref/watchdog/pool/worktree 内核/…）
                                     │
                       core-ref 符号守卫（test/core-ref.test.js 扩展）拦截「core 已发、vendored 未刷新」的半刷新态
```

## 3 解决方案

### 3.0 依赖契约（core 新导出面，转载自姊妹文档 §3.3/§5.2，已按其 R1 修订版对齐）

消费面签名（本插件视角）：`normalizeRef(ref, ext)`（含 `..` 拒绝——**对两宿主均为行为变更**，现状两宿主均放行）、`normalizeWorkflowRef(ref, {knownNames})`（名/路径二分 + 保留字裁决 + 内置名优先策略）、`parseAgentProfile(text, filePath): AgentProfile`（宽松：name 缺省 stem、body/执行字段全量）、`discoverAgents(workspaceRoot, hostRoots): Promise<AgentEntry[]>`（发现→解析→去重→码点序装配）、`maxTurnsToWatchdogMs(maxTurns)`（floor=30min 内聚）、`createConcurrencyPool({ maxConcurrent, queuePolicy })`（工厂形态，queuePolicy: 'priority' | 'strict-fifo'）、worktree-git-ops 函数族（`collectWorktreePatch(anchor): Promise<{ patchFile, written, patchIncomplete?: boolean }>` 等返回结构即留痕载体，anchor 为基线锚点抽象；锚点缺失/损坏或 add 步骤失败 → warn + 降级裸 diff + `patchIncomplete: true`）、`recoverCrashedRuns(store, runs, reason, hooks?)`、`pruneStateFilesBeyondCap`（FileRunStore 方法）、`runSummary(run)`/`isScriptRunning(runs, name)`、`atomicWriteFileSync(file, text)`、`normalizeArgsByMeta(params, meta): {args, warnings}`、`findFlattenedArgKeys(params, meta)`、`loadWorkflowScriptByPath(path)` + WorkflowScript 类、模型切分原语四件（splitZcodeModelRef/DEFAULT_PROVIDER_ID/ZCODE_FALLBACK_DEFAULT_MODEL/hasApiKey）、`isProcessAlive(pid)`、`SLUG_MAX_LENGTH`。

### 3.1 终态（使用者视角）

**成功路径**：用户 agent 写 `maxTurns: 2` → 实际 30 分钟 floor；用户自建含 block-scalar description 的 agent .md 放入四根任一目录 → `zsw agents` 清单 description 完整（解析能力修复——现状 vendored 内置 10 角色均为单行 description，block-scalar 风险作用于用户自建与资产演进，非内置资产正在受害）；`zsw workflow run --workflow <saved 名>` 与 pi 一致可用（D-E3 裁决后）；长期使用 workflow-state 目录稳定在上限内。

**失败路径带恢复指引**：
- 引用含 `..`：`无效 agent 引用 /x/../y.md：路径段 ".." 不允许 —— 请传入绝对路径（可经 SessionStart 注入段查询）`。
- slug 超长：`task-slug 超过 35 字符上限（SLUG_MAX_LENGTH）—— 请缩短后重试`。
- vendored 半刷新（**开发者/CI 形态受众**）：`vendored core 缺少导出符号 parseAgentProfile —— 重跑 node scripts/vendor-subagent-core.js --npm 0.4.0 刷新`；npm 包 / marketplace 形态用户的对应恢复指引 = **升级插件包版本**（该形态无 vendor 脚本与 workspace 根，守卫报错措辞按形态分流）。

### 3.2 方案对比（关键裁决）

**E1：`..` 校验收紧时机**

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 与 pi 共同收紧（core normalizeRef 内建 `..` 拒绝，两宿主同步生效——现状两宿主均放行，非对齐既有差异） | 安全面单源，两平台契约一致 | 低（改调即得） | 存量用户若真有含 `..` 的合法用法会 break——评估：合法工作流无理由用 `..`（绝对路径/`~`/注入段路径均覆盖），实际 break 面趋零 | ✅ |
| 维持放行 + 仅文档声明 | 零 break | 零 | 安全面**双缺失**长存（现状两宿主均无防御），防御-in-depth 持续缺位 | ❌ |

**E2：vendored 刷新时序**

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 随 core 0.4.0 `--npm` 刷新 | 走发布面权威源（npm 同源补验 A8 遗产），manifest 溯源干净 | 等 core 发版 | 无——本插件消费改造代码可与 core 发版并行开发、以 `--local` 冒烟，最终切换 `--npm` | ✅ |
| 先 `--local` 永久锚定 | 快 | 低 | manifest source 记 local 路径，脱离本机不可复现（VENDOR-MANIFEST 溯源纪律） | ❌（--local 仅作开发期冒烟） |

**E3：workflow ref 契约——saved 裸名是否放行**

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 对齐 pi：knownNames = 内置 5 名 + 发现面 saved 名，`normalizeWorkflowRef` 统一裁决 | 两平台同一 ref 语义（G3），`script:` 废弃裁决不变 | 低（core 原语 + knownNames 策略注入；knownNames 为 async 发现面，三入口校验点异步化或预取，cwd 口径统一 = run 命令的工作目录） | saved 与内置同名——**维持现状「内置优先」+ 新增 warning 提示 saved 同名脚本被遮蔽并列出双路径**（现状 `resolveScriptPath` 即内置优先 `orchestration-host.js:150-152`，不新造报错行为） | ✅ |
| 维持入口仅内置名+绝对路径 | zsw CLI flag 语义严格 | 零 | 用户可见契约继续分叉（pi 可按名 run saved、zsw 必须绝对路径），违背 G3 | ❌ |

**E4：record-store 归属**

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 暂不下沉 + 构造路径参数化（`new RecordStore({ filePath })`），待动作层消费后随 zsw manager 收敛另立项迁移 | 不做单消费方的推测性下沉；解耦免费收益先行 | 极低 | record 四态模型与 core running/closed 模型差异长存（登记为 D1 第二步依赖） | ✅ |
| 现在下沉 core | 台账语义单源 | 中（+迁移 manager 消费） | 单消费方下沉属推测性功能（全局红线「不加推测性功能」）；且与 record 状态机统一裁决耦合 | ❌ |

**E5：slots 收敛形态**

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| `slots.js` 收敛为 ConcurrencyPool 的 strict-fifo 配置薄层（createSlots 内部改 core 池，导出签名不变） | 分层公式/下限单源，FIFO 策略差异保留为参数 | 低 | core 池 priority 缺省——显式传 strict-fifo，测试锚定排队语义 | ✅ |
| 保留 slots 独立实现 | 零改动 | 零 | 公式双份漂移持续 | ❌ |

**E6：patch 基线锚点——sidecar 保留为持久锚点实现，降级语义显式化**

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| `worktree.js` 收缩为「sidecar 持久锚点实现 + zsw 布局/孤儿策略」，patch 收集/清理/保真读改调 core git-ops；**降级语义显式化**：锚点缺失/损坏 → 显著 warn + 降级裸 diff（仅未提交改动）+ outcome 留痕 `patchIncomplete: true`（对齐 core 契约；prepare 写锚点失败不阻断任务启动，维持现可用性语义）；**add 失败 → 裸 diff（core 契约；较 zsw 现状 `diff <base>` 多丢已提交改动，由 `patchIncomplete` 留痕可判断）**，非致命语义对齐现状、降级形态按 core 机制重定义 | git 语义单源；跨 daemon 重启的基线持久化（sidecar 真实需求）保留；两处静默降级补可见信号（现状 `worktree.js:164-169` 写失败不阻断、`:188-201` 读失败裸 diff 均静默——静默本身是缺陷） | 中（对照验证三铁律场景 + 锚点丢失/add 失败分支） | patch 产物从 intent-to-add 机制切到 core add -A+cached 机制——产物语义等价（同解 MF#2）需对照验证（姊妹文档 ⛔3）；降级行为从「静默」变「warn+留痕」为信号增强非 break | ✅ |
| core 内核参数化支持两种 patch 机制 | 兼容零风险 | 高（把分叉固化进 core 抽象） | 两种机制长存即分叉长存 | ❌ |
| 锚点丢失改 fail-fast（姊妹文档初版方案） | 强一致 | 低 | prepare 写 sidecar 前崩溃的真实命中场景从「部分 patch」变「任务作废」，损害大于收益（姊妹文档已被其审查 MF-4 击穿改裁决，本文档同步） | ❌ |

### 3.3 关键决策与权衡（四件套）

**D-E1：`..` 校验随 2.0.0 收紧（选定）**
- **采用**：消费 core normalizeRef（内建拒绝），zsw 侧零额外开关；错误消息带恢复指引（§3.1）。
- **被否**：文档声明维持放行——安全面**双缺失**长存（例 2）。
- **证据**：两宿主现状对 agent ref `..` 均放行（pi `subagent-tool.ts:316-317` 仅守卫 skillPath/cwd；zsw `agent-discovery.js:202-212` 无校验）；RT2-F4/RT3-F4 双报告独立坐实。
- **效果**：G2 安全项；§4 S2 场景成立。

**D-E2：发版时序 = core 0.4.0 发布后 `--npm` 刷新，zsw 2.0.0 单版消化（选定）**
- **采用**：消费改造与 core 发版并行（开发期 `--local` 冒烟、CI 门禁仍守 vendored sha256 自检）；core 0.4.0 发布后切 `--npm 0.4.0` + 全量回归；随后 `node scripts/release.js z-subagent-workflow major`（2.0.0）。
- **被否**：先 2.0.0 后刷新——发布面出现「声明消费新面但 vendored 缺符号」必炸；`--local` 永久锚定——溯源断裂。
- **证据**：core-ref 符号守卫（`test/core-ref.test.js:68-79` 模式）可机械拦截半刷新；W9 链条（core 0.4.0 → vendor → zsw 2.0.0）既有裁决。
- **效果**：G4/G5；§4 S4/S5。

**D-E3：workflow ref 对齐 pi（saved 裸名放行，选定）**
- **采用**：knownNames = 内置 5 + 发现面 saved 名（async 获取，三入口校验点异步化或预取，cwd 口径统一为 run 命令工作目录）；同名冲突**维持内置优先现状 + 新增 warning 列出双路径**；`script:` 前缀维持废弃拒收（D-4 既有裁决不变）。daemon 缓存无障碍已核实：core 发现无进程缓存且 scriptSaveAction 已 invalidateCache 联动（`bin/zsw.js:365`），save 后立即 run 可见。
- **被否**：维持仅内置名——两平台用户可见契约继续分叉（pi `tool-workflow.ts:66` schema 明示 name 可为 saved 名）；冲突改报错——现状内置优先直接跑内置，报错是新造行为，warning 已足够可观察。
- **证据**：RT1-F4 契约分叉坐实；用户裁决「尽量能下沉的都下沉」含契约统一。
- **效果**：G3；§4 S3。

**D-E4：record-store 暂不下沉、路径参数化（选定）**
- **采用**：`RecordStore` 构造增 `filePath` 注入；归属问题与 zsw manager 收敛（动作层消费 core 后）同窗另立项——**立案锚：本设计交付时在 zsw 仓建占位文档 `docs/design/zsw-manager-convergence.design.md`（TODO 形态）登记依赖与范围，防遗忘**。
- **被否**：现在下沉——单消费方推测性下沉 + 与状态机统一裁决耦合。
- **证据**：RT2-F6 contested 判定；全局红线「不加推测性功能」；record 现状无参构造 + config 路径直取（`record-store.js:33-36`）证实参数化是新增。
- **效果**：裁决闭环（G3 后半），D1 第二步依赖显式登记且有案可查。

**D-E5：行为变更登记为 2.0.0 breaking notes（选定）**
- **采用**：release notes 列六项：① `..` 拒绝；② slug 长度闸；③ maxTurns floor 恢复（超时可能变长）；④ saved workflow 按名 run 放宽（内置优先维持，新增遮蔽 warning）；⑤ **workflow-state 历史文件按上限自动清理**（prune 接线后旧文件会被删除，含 env 上限配置说明——用户数据删除行为必须告知）；⑥ patch 收集降级路径新增 warn + `patchIncomplete` 留痕（信号增强，非行为 break，如实标注类别）。patch 机制切换（intent-to-add → add -A+cached）标注为内部等价重构（产物对照验证背书，⛔A）。
- **被否**：拆 patch 版渐进——六项均依赖同一 core 面，拆开发版面碎；漏报 ⑤/⑥——数据删除与信号变更不可不告（审查 F6/F7 击穿初版四项）。
- **证据**：W9 既有 2.0.0 major 窗口裁决；check-release-needed 已报 UNRELEASED；pi 侧 evict 不动磁盘 + 显式 prune 的先例语义（`index.ts:605-607`）。
- **效果**：G5。

**错误规格（新增/变更失败路径）**

| 失败 | 消息/行为 | 恢复指引 |
|---|---|---|
| agent ref 含 `..` | 拒绝 + 「路径段 .. 不允许」 | 传绝对路径或注入段路径 |
| slug 超长 | 拒绝 + 上限值 | 缩短 task-slug |
| saved 名与内置名冲突 | 跑内置 + 遮蔽 warning 列出双路径 | 按路径消歧或改名 saved 脚本 |
| vendored 缺新符号（半刷新） | core-ref 守卫抛错 | 开发者/CI：`node scripts/vendor-subagent-core.js --npm 0.4.0`；npm/marketplace 用户：升级插件包版本（守卫措辞按形态分流） |
| 平铺 args（zflow run） | 平铺检测拦截 + 「子字段请放 args 对象」 | 按 @pi-meta parameters 结构传参 |

## 4 验收

真实依赖真实路径，禁 mock。回溯标注见各场景。

**S1 复刻清零与行为等值（G1）**：改造分支上 ① 按 §5.3 退役/收缩清单的**全符号集**驱动 grep 归零（normalizeAgentRef/parseAgentMd/parseFrontmatter/toProfile/scalar/stripQuotes/expandHome/stem/MS_PER_TURN/splitModelRef/hasProviderCredentials/SAFE_ID_RE/GIT_TIMEOUT_MS/loadScriptFromPath 鸭子实体——符号清单随 V8 的 core-ref.test.js 符号清单文件维护，以该文件为准防漏）；② 全量单测绿（基线 349+）；③ 真机跑一轮 `zsw start --worktree`（worktree 链路走 core git-ops）+ `zsw workflow --workflow review-fix-loop`（批次解析走 meta 驱动），行为与改造前对照记录一致。回溯 G1。

**S2 漂移修复三连（G2）**：① `maxTurnsToWatchdogMs(2) ≥ 1_800_000` 函数级断言 + `maxTurns: 2` 真机派发断言 watchdog 挂载时长日志；② `zsw start --agent /x/../evil.md` 被拒且消息含恢复指引；③ 自建 block-scalar 测试资产 `t-sink.md`（含多行 `- item` tools 列表）放入 `~/.zcode/agents/`，`zsw agents` 清单 description 与 tools 投影完整（内置 10 角色均单行 description，块标量样例须自建——对齐姊妹文档 S1 同一资产）。回溯 G2。

**S3 ref 契约（G3）**：① `zsw workflow --action script-save` 保存脚本后按名 run 成功；② saved 名与内置名同名时 run 跑内置 + 输出遮蔽 warning 列出双路径；③ `script:` 前缀仍拒收；④ 三入口（CLI/daemon/MCP）knownNames 构建的 cwd 口径一致。回溯 G3。

**S4 三形态一致（G4）**：① inline dev 真机全量单测绿 + core-ref 符号守卫绿；② `node scripts/check-pack.js` 绿（files 白名单含新 vendored）；③ 人为回退 vendored 一个文件触发守卫报错（负面验证半刷新拦截）。回溯 G4。

**S5 发版与累积修复（G5）**：① `node scripts/release.js z-subagent-workflow major` 产出 2.0.0 三处同步 + release notes 六项（D-E5）；② 造 25 个历史 workflow-state 文件，**其中 10 个按改造前格式（无 v 字段）构造**——daemon 启动后目录收敛至上限内，且 loadAll/recover 对全部 25 个（含无 v 存量）可读、状态不丢（覆盖姊妹文档 D4 的存量可恢复断言）。回溯 G5 + 例 3。

## 5 下一层拆分

### 5.1 实施路径

两阶段：阶段一（V1-V8 消费改造）→ 阶段二（V9 回归与发版）。前置：姊妹文档 U1-U10 合入；core 0.4.0 未发布期间以 `--local` 冒烟并行开发（CI 门禁仍守 vendored sha256 自检），发布后切 `--npm 0.4.0` 终态——D-E2 保证发版前必为 --npm 态，无 `--local` 态发版路径。

### 5.2 拆分清单

| 单元 | 内容 | 依赖 core 单元 |
|---|---|---|
| V1 | agent-ref 面消费：normalizeAgentRef/expandHome/stem/报错文案退役改调；`..` 收紧；slug 长度闸 | U1 |
| V2 | agent 解析消费：parseAgentMd 族退役、parseFile 走 getCachedParsed、AgentProfile 消费、`listAgents` 装配循环退役改调 `discoverAgents`（U2） | U2 |
| V3 | workflow 面消费：loadScriptFromPath 鸭子退役改工厂、registry 收缩差异合并层、normalizeWorkflowRef 统一三处口径（CLI/daemon/MCP）+ knownNames 异步获取与 cwd 口径统一 + saved 遮蔽 warning（E3） | U1（agent-ref 面）+ U1（normalizeWorkflowRef + WorkflowScript 工厂，均在 U1 契约面批次） |
| V4 | 编排消费：recoverOrphans 改 core、runSummary/isScriptRunning 改调、normalizeRunParams 白名单退役改 meta 驱动 + 平铺检测接线 | U7/U9 |
| V5 | 引擎与进程面：MS_PER_TURN 退役改 maxTurnsToWatchdogMs、isProcessAlive 改调、模型切分原语改薄包装 + hasApiKey 统一 | U3 + U1（模型切分原语四件在 U1 契约面批次） |
| V6 | worktree 收缩：sidecar 持久锚点实现 + git-ops 消费 + 布局/孤儿策略层保留（E6） | U5 |
| V7 | 基础设施：slots 收敛 ConcurrencyPool(strict-fifo)（E5）、atomicWrite 改调、prune 接线（daemon 启动 + env 透传）、record-store 路径参数化（E4） | U4/U6/U7 |
| V8 | 宿主内清理：modelEntries 参数化消重 toModelEntries、vendored 刷新（--local 冒烟 → --npm 终态）+ core-ref 符号守卫扩展（新导出面符号清单） | U6 批 |
| V9 | 回归与发版：全量单测 + 三形态验收（S4）+ 真机场景（S1-S3/S5）+ release.js major + breaking notes | 全部 |

### 5.3 文件改动地图

- 退役：`lib/agent-discovery.js`（parser 族/normalizeAgentRef）、`lib/worktree.js`（收缩至 ~60 行）、`lib/slots.js`（收缩薄层）
- 改造：`lib/orchestration-host.js`（鸭子实体/白名单/恢复/投影）、`lib/manager.js`（MS_PER_TURN/slug 闸）、`lib/runner-core.js`（alive/watchdog）、`lib/model-router.js`（切分原语）、`lib/output-store.js`/`lib/notifier-mailbox.js`（atomicWrite）、`bin/zsw.js`（validateWorkflowRef/buildWorkflowRunParams consumedArgs meta 化）、`lib/daemon-socket.js`（probeLockHolder）
- 新增接线：daemon/session-start 的 prune 调用；core-ref.test.js 符号清单扩展
- vendored：`--npm 0.4.0` 刷新（manifest source 回归 npm 权威源）

### 5.4 待验证检查点

| # | 检查点 | 断言 | 状态 |
|---|---|---|---|
| ⛔A | patch 机制切换对照 | sidecar 场景（新文件+已提交改动+daemon 重启）patch 产物与改造前等价（git apply 目标一致）+ **锚点缺失/损坏与 add 失败分支：warn 发出 + 降级裸 diff + outcome `patchIncomplete` 留痕（与姊妹 ⛔3 同口径）** | 实施期 |
| ⛔B | strict-fifo 排队语义 | slots 现有排队测试在 core 池 strict-fifo 下全绿 | 实施期 |
| ⛔C | meta 驱动白名单等值 | 现有全部合法调用参数集在 meta 驱动下零 warning（对照清单） | 实施期 |
| ⛔D | saved 名遮蔽语义 | 内置优先 + 遮蔽 warning（含双路径）在 daemon/MCP/CLI 三入口一致 + **三入口 knownNames 构建的 cwd 口径一致**（同一目录集三入口产出同一 knownNames 集） | 实施期 |

### 5.5 版本与发版

- zsw 2.0.0（major）：承载 `..` 拒绝、slug 闸、floor 恢复、saved 裸名放宽、workflow-state 自动清理、patch 降级信号六项 release notes（D-E5）+ 全部内部重构；release notes 双语。
- 时序：V1-V8 在 core 0.4.0 未发布期以 `--local` 冒烟并行开发 → core 0.4.0 发布（xyz 仓）→ 切 `--npm 0.4.0` 终态刷新 → V9 回归 → release.js major → push 授权（用户）。
