# subagent-core 能力收口与双插件契约统一设计

**一句话结论**：把「平台无关的共享面」——内置 agent 模板资产、agent/workflow 发现、注入渲染、workflow 脚本创作闭环——从 pi 插件层（或 zsw 自有实现）收口到 `@zhushanwen/subagent-core` npm 包，两侧插件只保留平台接线壳；同时统一两侧的引用契约（agent = 绝对路径；workflow = 内置名或绝对路径），让 zcode 与 pi 用户提供完全对齐的编排能力。

**层声明**：当前层 = 收口边界与契约设计（子系统/接口层）；下一层 = 两个仓库的实施单元拆分（见 §5）。不跨层到函数级实现细节。

**状态**：Approved（四轮对抗审查收敛：R1 4 MF/7 S/3 DE → R2 复审 1 MF/5 S/3 DE → R3 复审 1 MF/2 S/1 DE → R4 复审 0 MF「设计就绪」+ 2 S 当轮修完（R5 收口）。终态 0 must-fix / 0 遗留，可进入 §5 实施）。

---

## 1 背景目标

### 1.1 SCQA

- **S（情境）**：xyz-agent 的 pi 插件（`extensions/universal/subagent-workflow`，下称 **pi-sw**）与 zcode-plugin-workspace 的 zsw 插件（`z-subagent-workflow`，下称 **zsw**）自 2026-08 起共同消费 `@zhushanwen/subagent-core`（下称 **core**）：pi-sw 进程内 require，zsw 构建期 vendor 副本（`lib/vendor/subagent-core/`，sha256 校验）。workflow 编排引擎、脚本契约、内置 5 个 workflow 资产已同源。
- **C（冲突）**：core 的收口边界从未显式定义——「该两侧共用的能力」散落在 pi-sw 插件层（10 个内置 agent 模板、注入渲染纯函数、脚本创作校验管线）和 zsw 自有实现（agent 四根发现、注入块渲染）里，形成双实现与单侧缺失。用户在 zcode 里没有内置 agent 模板可用，引用契约与 pi 侧不一致（zsw 按名，pi 按绝对路径），注入块格式两套。
- **Q（问题）**：哪些能力应该收口 core 两侧共用？哪些没收进去？以什么判据划分收口边界？统一契约朝哪个方向收敛？
- **A（答案）**：判据 = 「平台无关 且 两侧语义相同」→ core；「平台机制绑定」→ 插件层端口。按此判据，本设计新增五项收口（资产/发现/渲染/创作闭环/中立字段），统一两项契约，明确六类不收口项。

### 1.2 系统是什么（受众认知补足）

两插件是同一编排能力在两个 agent 平台的宿主壳：

```
┌─────────────────────┐   ┌─────────────────────┐
│ pi-sw（pi 平台）      │   │ zsw（zcode 平台）     │
│ 进程内 extension      │   │ MCP server + hooks    │
│ before_agent_start   │   │ SessionStart hook     │
│ triggerTurn 回注      │   │ mailbox 通知          │
│ ModelRegistry        │   │ ~/.zcode/v2/config    │
└────────┬────────────┘   └────────┬────────────┘
         │ require                 │ vendored 副本（构建期，sha256）
         ▼                         ▼
┌────────────────────────────────────────────────┐
│ @zhushanwen/subagent-core                       │
│ workflow 引擎/脚本契约/内置 5 workflow/zcode engine│
└────────────────────────────────────────────────┘
```

两个平台的关键差异（本设计必须尊重的约束）：

| 差异点 | pi | zcode |
|---|---|---|
| 插件形态 | 进程内 extension API | MCP server（stdio）+ 7 个 hook 事件 |
| 注入时机 | 每 turn `before_agent_start` | 仅 SessionStart hook（GUI 启动时扫描，改配置须重启） |
| 完成通知 | `triggerTurn` 唤醒主对话 | 无对应机制，用 mailbox 文件通知 |
| 模型数据源 | `ctx.modelRegistry`（内存权威快照） | `~/.zcode/v2/config.json`（每次重读） |
| 工具白名单 flag | `--tools a,b,c`（allowlist 存在） | `--allowed-tools` 拒收，仅 denylist `--disallowed-tools` |
| 子进程输出结构化 | structured-output 工具指令 | 无工具面，靠 prompt 契约 + jsonout 三级容错 |
| agent 参数缺省 | 加载 `general-purpose` 内置角色 | 无角色裸跑（缺省继承主 agent 通用行为）——本设计随 D-4 统一为前者的语义 |

### 1.3 设计目标

从使用者（两个平台上的主 agent 模型 + 插件维护者）体验倒推：

- **G1 资产同源**：内置 agent 模板与内置 workflow 一样，一处维护（core 包）、两侧同版本分发。zcode 用户开箱即用 reviewer/orchestrator 等 10 个角色。
- **G2 契约统一**：两平台的引用契约一致——subagent 的 `agent` 参数 = .md 绝对路径；workflow 引用 = 内置名或 .js 绝对路径。模型在任一平台学到的用法可无损迁移。
- **G3 注入对齐**：会话启动时两平台注入同构的资源清单段（subagents/workflows/models），字段口径统一（含 location 路径、模型窗口/能力标记）。
- **G4 创作闭环**：workflow 脚本的 generate→lint→save→delete 管线 core 化，zcode 侧同等可用（落盘目录按宿主布局）。
- **G5 双实现收敛**：agent 发现只剩 core 一套实现；zsw 自有 resolver 退役。
- **G6 维护成本**：新增一个内置角色/一次注入格式调整，只改 core 一处 + 版本发布，两插件随消费面自然获得。

### 1.4 In / Out of scope

**In scope**：
- core 包新增资产（agents/）与新增导出面（渲染器、workflow-files、generate 管线、发现防环加固）
- pi-sw 与 zsw 各自的接入改造（含 pi-sw 资产迁移、zsw 契约收紧）
- 引用契约统一与迁移说明

**Out of scope**（明确不做）：
- 平台固有差异的强行对齐：triggerTurn vs mailbox、每 turn vs 一次性注入、双引擎切换、TUI/GUI 面差异
- zsub 生命周期/ledger、reaper、slots、jsonout、prompt 拼装措辞（已有 D6 分段决策，维持插件层——见 §2.3）
- core 的引擎/编排内核行为变更（本设计不动引擎）
- pi-sw 的 fork/conversation/idleTimeout 等会话级参数向 zsw 的移植（spawn 单轮通道语义不同，属未来独立设计；执行通道的终态演进见 [zcode-engine-appserver-decision-record.md](zcode-engine-appserver-decision-record.md)——app-server 常驻化在 core engine 层实施后，此项的语义基础随之变化）

---

## 2 现状与问题分析

### 2.1 收口现状盘点（全清单）

**已收口 core（两侧共用，✅）**：

| 能力 | core 面 | 两侧消费形态 |
|---|---|---|
| workflow 编排引擎 | runAndWait/lifecycle/嵌套/Budget | pi 进程内 / zsw vendored |
| workflow 脚本契约 | @pi-meta parser、lintScript、RegistryImpl | 同上 |
| 内置 5 个 workflow 资产 | `workflows/`（chain/parallel/map-reduce/scatter-gather/review-fix-loop + _shared + rfl-utils） | pi 经 npm 约定目录扫描 / zsw vendored scriptPath 锚定 |
| zcode 执行引擎 | registerZcodeEngine/createZcodeEngine/killAllSpawnedChildren | pi 双引擎之一 / zsw 唯一引擎 |
| workflow 状态面 | FileRunStore（workflow-state/） | 两侧同构 |
| workflow 线 agent() 解析 | agent-opts-resolver（schema/skill） | 两侧同构 |

**未收口（本设计主张应收，❌）**：

| # | 能力 | pi-sw 现状 | zsw 现状 | 双实现/缺失 |
|---|---|---|---|---|
| N1 | 内置 agent 模板（10 个 .md） | 插件层 `agents/` 目录，经 `pi.agents` manifest 进 npm-dev 发现源 | **零**——无资产也无发现根 | zcode 侧缺失 |
| N2 | agent .md 发现 | core `resource-discovery` 七源（user-pi→user-agents→npm→npm-dev→ext-paths→project-pi→project-agents） | 自写 `agent-md-resolver` 四根（项目 .agents→.zcode→HOME 同构），**完全绕开 core** | 双实现，语义有差（见 2.2 例 4） |
| N3 | 注入渲染 | 三个 format 纯函数在 **pi-sw 插件层**（`formatAgentList/ formatWorkflowList/ formatModelList`），core 仅有 `xml-injection` 原语且未出 barrel | 自写 `hook-inject` 单块 `<zsw-resources>`（45 行预算，agents 无路径，models 无窗口/能力） | 双实现，格式两套 |
| N4 | workflow 脚本创作闭环 | generate 的校验管线+tmp 写盘在 **插件层**（`.pi/workflows/.tmp` 硬编码）；save/delete 在 core 但 **未出 barrel**；`getTmpDir/getSavedDir` 模块私有不可注入 | zflow 仅有 scripts/lint，**无 generate/save/delete** | 部分在 core 不可达 + zcode 侧缺失 |
| N5 | frontmatter `tools` 字段中立化 | `AgentConfig.tools` → pi `--tools` allowlist flag 生效 | core 引擎路径（zcode）**无 allowlist 通道，静默丢弃**；且 zcode 平台本身 `--allowed-tools` 拒收 | 共享资产的平台断裂 |
| N6 | 模型条目口径 | `ModelEntry`：`reasoning: boolean`、`input[]`（vision 推导）、contextWindow | zsw 条目：`reasoning.variants` 档位数组、contextWindow、**无 input[]** | 字段集不同构，N3 收口的前置 |

**不收口（平台绑定，判据见 §3.0，维持插件层，➖）**：

| 能力 | 归属 | 不收口理由 |
|---|---|---|
| 事件接线（before_agent_start vs SessionStart hook） | 各插件 | 平台事件面绑定 |
| 模型数据源读取（ModelRegistry vs v2 config） | 各插件 | 平台配置面绑定；core 只吃普通数据数组 |
| 完成通知通道（triggerTurn vs mailbox） | 各插件 | pi 有唤醒机制，zcode 无 |
| prompt 拼装措辞（--append-system-prompt vs --prompt+MANDATORY） | 各插件 | 注入通道与约束强度平台不同（zsw 头注已如实声明） |
| jsonout 三级容错提取 | zsw | zcode 子进程无 structured-output 工具面 |
| slots（任务槽）/ zsub ledger / reaper | zsw | D6 分段既有决策（deviation #2/#3/#13），语义是 zsub 生命周期非编排 |
| CLI / MCP server / hook 壳 | 各插件 | 平台交付形态 |

### 2.2 真实失败模式（使用者视角）

**例 1（N1，zcode 用户）**：用户在 zcode 会话里让主 agent「派 reviewer 审查这段代码」。pi 用户 `agent` 参数传 `<location>/reviewer.md` 即可（注入段里有 10 个内置角色的路径）；zcode 用户 `zsw agents` 查四根——一个内置角色都没有，只能无角色裸跑或手工把 .md 拷进 `~/.agents/agents/`。同一 npm 生态的「开箱角色库」在 zcode 缺席。

**例 2（N5，资产跨平台断裂）**：用户把 pi 侧的 `orchestrator.md` 拷到 zcode 四根目录。该模板 frontmatter 写着 `tools: todo, goal_control, workflow, subagent, ask_user`（pi 平台工具名），body 里写「你只有以下 5 个工具」。在 zcode 侧：机制层 frontmatter tools **静默丢弃**（core 引擎路径无 allowlist 通道，无任何报错）；prompt 层 body 宣称的工具集与 zcode 实际工具面（Read/Bash/Grep…）完全错乱——角色被引导去用不存在的工具。

**例 3（N3+N6，注入口径分裂）**：同一个 GLM-5.3 模型，在 pi 会话看到 `<available_provider_models>` 带 contextWindow 与 caps（reasoning/vision）；在 zcode 会话看到 `<zsw-resources>` 单块——无窗口数据（尽管 zsw 的 model-router 明明有 `contextWindow` 和 `reasoning.variants` 数据，`zsub models` action 都能查到，只是注入块没渲染）。模型做「长上下文任务是否可委派」的路由决策时两平台信息量不等。

**例 4（N2，双实现行为漂移）**：用户在 `~/.agents/agents/` 里用 symlink 指向个人技能库的 agent .md（pi 生态常见布局）。zsw 自写 resolver 用 `realpathSync` 递归去重防环（`agent-md-resolver.js:128,135-138`）；core 的 sync 扫描**不做 realpath 去重/防环**，靠文件名 stem 部分兜底——多链指同文件或 symlink 环时两侧行为不同。两套实现各自修 bug 互不可见。

**例 5（N4，创作能力单侧）**：pi 用户对模型说「写个 workflow 脚本做三路审查」，模型调 `workflow-script generate` → lint → save 落盘 `.pi/workflows/`，下次 `workflow run` 直接用。zcode 用户没有 generate 面，只能自己手写 .js、自己放对目录（`~/.zsw/workflows/` 或 `<ws>/.zsw/workflows/`）、自己保证 @pi-meta 格式正确——脚本契约的知识负担全在用户。

### 2.3 根因分析

五个失败模式指向同一根因：**core 的定位被隐含为了「编排内核」，而「平台无关的共享面」——资产分发、资源发现、清单渲染、创作管线——从未被显式划入收口范围**。每次两侧需要同一能力时（发现、渲染），实现者就地写了平台版本（zsw 的 resolver/hook-inject），或留在了先出现的插件层（pi-sw 的 injector 渲染、generate 管线、agents 资产）。双实现不是一次性成本，是持续漂移源（例 4）。

次级根因（契约分裂）：agent/workflow 的引用形态在两侧独立决策——pi 侧 D1 设计刻意收紧为「路径唯一」（防遮蔽歧义：名字只是展示标签），zsw 侧沿用了早期「名字或路径」宽松契约。两者没对过齐，注入段格式随之分叉（zsw 按名引用不需要 location，pi 按路径引用必须带 location）。

### 2.4 物理数据流（注入链现状对照）

```
pi 会话（每 turn）:
  before_agent_start → setup*Injector → core discoverResources + ctx.modelRegistry
    → [插件层 format*List] → renderXmlSection → systemPrompt 链式叠加
    → <available_subagents>/<available_workflows>/<available_provider_models>

zcode 会话（仅 session start）:
  SessionStart hook → bin/zsw.js hook → v2 config 重读 + agent-md-resolver 四根扫描
    → [zsw hook-inject renderResourcesBlock]（45 行预算截断）
    → <zsw-resources> 单块（models/agents/workflows 三段挤在一块）
```

收口后（终态见 §3.1）：两个箭头中段的「格式渲染」都换成 core 的同一组渲染函数，前段（数据获取）保持各平台端口。

---

## 3 解决方案

### 3.0 收口判据（本设计的边界法则）

一个能力收口 core，当且仅当同时满足：

1. **平台无关**：不依赖 pi extension API / zcode MCP+hook 形态（数据输入是普通数据或已有 core 端口）；
2. **两侧语义相同**：两平台对它的期望行为一致（允许参数化差异，如落盘目录、行数预算）；
3. **资产或算法**：是内容资产（.md/.js 模板）或纯算法（解析/渲染/校验），而非平台机制绑定。

不满足任一条 → 留插件层（宿主端口注入差异）。§2.1 的三张表即按此判据划分的结果。

### 3.1 终态（使用者视角）

**zcode 用户的开箱体验（改造后）**：

```
会话启动注入（SessionStart hook 产出，格式与 pi 同构）：
<available_subagents>
  <agent><name>reviewer</name><description>…</description><when>…</when>
    <location>/path/to/vendored/subagent-core/agents/reviewer.md</location></agent>
  …（内置 10 个 + 用户四根里的自定义）
</available_subagents>
<available_workflows>
  <workflow><name>chain</name><description>…</description>
    <location>/path/to/vendored/subagent-core/workflows/chain.js</location></workflow>
  …（内置 5 + 用户脚本，带 location）
</available_workflows>
<available_models>
  <model><id>builtin:bigmodel-coding-plan/GLM-5.3</id><name>…</name>
    <caps>reasoning</caps><contextWindow>200000</contextWindow></model>
  …
</available_models>

主 agent 委派（契约与 pi 完全一致）：
  zsub start task="审查 X" slug="review-x" agent="/path/to/…/agents/reviewer.md"
  zflow run workflow="review-fix-loop" batch1="/path/to/…/agents/reviewer.md"
  zflow run workflow="/abs/path/my-flow.js"        ← 自定义脚本传路径

创作闭环：
  zflow script-generate name="tri-review" script="<JS 源码>"   ← 校验+落 tmp
  zflow script-lint file="<tmp 路径>"
  zflow script-save name="tri-review"                          ← tmp → ~/.zsw/workflows/
  zflow run workflow="~/.zsw/workflows/tri-review.js"
```

**失败路径（契约收紧后）**：

```
主 agent 按旧习惯传名字：zsub start … agent="reviewer"
→ 报错：Invalid agent ref: "reviewer". Agent refs must be absolute paths to .md files.
  恢复指引：用 <location> from <available_subagents>，或 zsw agents 查路径清单。
  （与 pi 侧 agent-registry 的报错文案同源——core 单一实现）

主 agent 给自定义脚本传名字：zflow run workflow="script:tri-review"
→ 报错：workflow 引用仅接受内置名（chain/parallel/map-reduce/scatter-gather/
  review-fix-loop）或 .js 绝对路径。自定义脚本路径见 <available_workflows> 的
  <location>，或 zflow scripts 查清单。
```

### 3.2 决策对比（六项）

#### D-1 内置 agent 模板放哪

| 候选 | 长期合理性 | 短期成本 | 风险 |
|---|---|---|---|
| **a. 下沉 core 包 `agents/` 约定目录（推荐）** | 高——与 workflows/ 资产同模式，一处维护双侧分发（G1/G6）；pi 经 npm 源自动发现，zsw vendor 天然带上 | 中——迁移 10 个文件 + pi manifest 清理 + zsw 发现接入 | pi 侧遮蔽语义不变（内置经 npm-dev 源，序位**高于 user 两级、低于 project 两级**——内置遮蔽 user 级同名，project 级同名可遮蔽内置，见 D-2 根映射）；zsw 侧 vendored 根须注入同序位；需同步处理 D-5 的 tools 字段 |
| b. zsw 仓库复制一份 | 低——双份维护必漂移（正是本设计要消灭的模式） | 低 | 角色定义分叉，N1 问题复发 |
| c. core 导出 `getBuiltinAgents()` API，两侧显式注册 | 中——资产进包但发现不走约定目录，两插件各自接线 | 中 | 每新增宿主都要写一遍注册逻辑，与 workflows/ 的目录模式不一致（同一包两种资产两种消费模式） |

**被否 b**：三个月后 reviewer 角色要改提示词，两个仓库各改一次，漏一处即行为分叉——§2.2 例 4 的漂移模式在资产上重演。
**被否 c**：core 已有「约定目录资产」先例（workflows/），再造并行模式增加认知成本，无对应收益。

#### D-2 agent 发现统一（zsw 退役自写 resolver）

| 候选 | 长期合理性 | 短期成本 | 风险 |
|---|---|---|---|
| **a. zsw 接 core `discoverResources({kind:'agents'})`，根经 hostRoots 注入（推荐）** | 高——单实现单语义（G5），防环等加固一处受益 | 中——zsw 根映射 + 测试迁移 | core 现状三个缺口需先补：① **async 发现链**（生产调用方；pi 与 zsw 消费均走 async `discoverResources`，sync 链在 core 无非测试调用方）无 realpath 去重——多链同文件（两个不同名 symlink 指同一 .md）在合并层靠 stem 去重防不住；文件级 symlink 链的 ELOOP 已被 `stat().catch` 吞除（已核实安全）；② hostRoots 无 project 级槽位（zsw 四根含项目级 `.zcode/agents`，core 的 project 槽只有 project-pi/project-agents）——需 core 加 project host 槽；③ 遍历语义差异——core 扫描**单层不递归、无 node_modules 排除**，zsw resolver **递归 MAX_DEPTH=16 且排除 node_modules/.git**（真机实测 `~/.zcode/agents` 下有 node_modules，递归会把依赖包 README 灌进清单）。统一决策：**core 维持单层**（pi 现状即契约，改递归动 pi 已验收行为）；node_modules 风险在单层语义下自然消解（目录不进单层清单）；**目录 symlink 形态由 zsw 宿主层预处理展开**（见根映射段——R2 版的「symlink 平铺迁移指引」对整库一链形态不可执行，被审查击穿：用户需逐个建链且库更新后不可持续，agent 静默消失无兜底） |
| b. 维持双实现 | 低——漂移持续 | 零 | §2.2 例 4 |
| c. 把 zsw 四根语义搬进 core 默认布局 | 低——core 默认布局是 pi 生态约定，混入 zcode 布局污染中性 | 中 | 两平台默认根集耦合 |

**被否 b/c** 后，若用它，§2.2 例 4 会变成：symlink 环场景在 zsw 被 realpath 守卫拦住、在 pi 侧 core 扫描继续漏防——同一 core 包在不同宿主下行为不一致，违背「同源同行为」目标。

推荐 a 的根映射（zsw 四根 → core 扫描面，序位对齐 core 优先级低→高序，复刻 pi 内置模板序位）：

- `~/.zcode/agents` 与 `~/.agents/agents` → user 级槽：`~/.agents/agents` 用 core 自带的 user-agents 槽（硬编码，不收注入）；`~/.zcode/agents` **借 user-pi 标签注入**（core 无通用 user-host 槽；user-pi 序位低于 user-agents，恰好维持 zsw 现语义 HOME `.agents` > `.zcode`；与 workflow 线借槽同理，discoveryRoots 按 kind 分数组注入互不冲突），**最低段**；
- vendored core agents → 注入 **npm 槽**：注入 dir = `<plugin>/lib/vendor/`（npm 槽语义要求一级子项 = 包目录，`lib/vendor/subagent-core/` 即包目录，其 `agents/` 约定目录被扫中；同目录的 VENDOR-MANIFEST.json 等非包文件被当包解析失败、无害——机制已核实）。序位**高于 user 两级、低于 project 两级**——内置遮蔽 user 级同名（防用户旧版同名 .md 意外遮蔽内置新版），project 级保留用户逃生门，与 pi 内置模板（npm-dev 源）同向；
- 项目 `.agents/agents` → project-agents 槽（现成，**最高**）；
- 项目 `.zcode/agents` → 新增 project host 槽（插在 project-agents 之下，维持 zsw 现语义 `.agents` > `.zcode`）。

**目录 symlink 展开（zsw 宿主层预处理，R3 补/R4 修正）**：zsw 现递归 resolver 对目录 symlink 会跟进（整库一链如 `agents/my-lib -> ~/Code/personal-agents/` 现在全库可见），core 单层扫描对该形态既不递归也不展开。预处理方案：zsw 在构造扫描根列表时，对四根下的一级目录 symlink 做**动态展开**——链接目标作为同标签额外扫描根注入，realpath 已访问集合防环（**集合含四根本身的 realpath**——防「根 A 的链接指回根 B」导致 B 重复注入的冗余扫描），展开深度一层（**声明：库内子目录与库内嵌套链接不可见，库内容需平铺在库根一层**——相对 zsw 现递归是行为收窄，迁移说明明写）；库更新可持续（每次发现时重新展开）。**需要 core 配套扩面（非「core 不动」，R4 修正——R3 版的「core 不动」声明被 core 源码击穿）**：core `buildScanTargets` 对 hostRoots 的消费是 `new Map(source→dir)`（每标签恰好一个 dir，同标签多条目靠后者整体覆盖前者），且 user-agents/project-agents 两槽硬编码自建不查 hostRoots——「原根 + N 个展开目标挤同标签」的注入形态现行机制不支持（平凡场景即触发：`~/.zcode/agents` 本体 + 一个库链接 = 两条 user-pi，本体 .md 整体消失）。配套工作项见 W2 缺口④：hostRoots 消费 Map→列表（同标签多 dir 依注入序同序位扫描）+ 硬编码槽与 hostRoots 同标签注入合并——core 内部消费逻辑扩面，端口形态（宿主提供根数组）不变。**注入序语义（R5 补，防实施排错）**：core 合并是 last-writer-wins（靠后者胜），而 zsw 现语义是同根内字典序靠前者胜（本体胜）——要对齐「本体胜」，**本体根必须注入在展开目标之后**（与直觉的「本体在前」相反）；硬编码槽合并同理（硬编码根排注入目标之后）；⛔ 探针与 A7 补「同 stem 撞名（本体 x.md vs 库内同名 x.md）→ 本体胜」维度。文件级 symlink 不需预处理（core async 扫描已 follow）。

#### D-3 注入渲染收口（三段 XML 统一）

| 候选 | 长期合理性 | 短期成本 | 风险 |
|---|---|---|---|
| **a. 三个 format 纯函数 + xml-injection 下沉 core 并出 barrel，zsw hook-inject 改调 core 渲染（推荐）** | 高——渲染纯函数已零 pi 依赖（核实点 5），下沉是搬运非重写；两平台格式天然一致（G3） | 中——zsw 注入块重写 + 截断策略参数化 | zsw 的 token 成本约束不能沿用原 45 行总预算：三段 XML 每条目是多行块（agent 4 行：name/description/when/location；workflow 3 行），开箱 10 内置 agents ≈ 42 行 + workflows 5+ ≈ 18 行 + models 段——45 行必爆（R1 版未做此估算，被审查击穿）。决策：**分段条目预算 + 码点序排 + 截尾**——subagents 段条目预算 15（开箱 10 内置 + 5 用户余量）、workflows 段条目预算 10、models 段完整永不截；条目先按 name 码点序排（与 pi 侧 `sortByCodepoint` 同口径，排序函数随 W3 下沉 core——不排序时条目序 = core 合并 Map 的低优先级源先入序，截尾会系统性裁掉 project 级高优先级条目），超预算截尾部条目 + 「完整清单：zsw agents / zflow scripts」兜底指引。**内置条目无截断豁免（显式声明，R4）**：混合场景（用户条目超余量且码点序靠前）下内置角色可能被裁出注入段——开箱场景（G1 主场景，无用户条目）不触发，且码点序统一截尾行为可预测、兜底指引可恢复；两段式豁免（内置优先保留）引入额外截断序复杂度且 pi 侧无此概念，不做。开箱总量 ≈ 100 行（对比 pi 侧每 turn 注入同量级，zcode 仅 session start 一次，成本可接受）；具体值 W7 实测微调 |
| b. 格式各写各的，只统一字段口径 | 低——格式双实现，视觉/结构漂移 | 低 | N3 不解决 |
| c. zsw 单块格式反向推广给 pi | 低——pi 的分段 XML 是多 injector 链式叠加的结构基础，压成单块破坏 pi 侧扩展性 | 高 | pi 侧 injector 生态被锁死 |

**ModelEntry 口径并集（N6 前置）**：`{ id, name, label?, contextWindow?, reasoning?: { variants?, defaultVariant? } | boolean, input?[] }`——pi 投影填 boolean+input[]，zsw 投影填 variants 数组与 label、input 缺席。**渲染守卫是显式工作项而非自然降级**（R1 版误标「已核实降级行为」，被审查击穿）：现 `formatCaps` 对 `entry.input.includes("image")` 直调（`model-list-injector.ts:73`），input undefined 抛 TypeError；`contextWindow` 直渲染同样有 undefined → "undefined" 垃圾输出隐患——W3 必须对全字段 optional 消费点做守卫。两侧数据面零改动，投影函数各自适配。

#### D-4 引用契约统一方向

| 候选 | 长期合理性 | 短期成本 | 风险 |
|---|---|---|---|
| **a. agent = 仅绝对路径；workflow = 内置名或绝对路径（推荐）** | 高——与 pi 既有 D1 设计（agent 路径唯一，名字只是展示标签）对齐，防遮蔽歧义；内置 workflow 名是稳定 API 面（`run chain` 的人机友好性保留），自定义脚本路径唯一消除 script:/裸名的多源同名歧义 | 中——zsw 两处收紧是 breaking（2.0.0 major 窗口内做，README 迁移表）；pi workflow run 放开内置名（run 入口从仅 getPath 改为先查内置名，registry 的 get(name) 面现成） | zsw 用户旧习惯（按名传 agent）被打断——靠报错内恢复指引 + 注入段 location 兜底 |
| b. 全部放开按名或路径（zsw 超集推广给 pi） | 中——名字引用对模型更自然？否——pi D1 已论证名字引用在多源遮蔽下有歧义（用户同名 .md 覆盖内置时，名字指向哪个取决于扫描序，模型不可见） | 中 | 推翻 pi 侧已收敛的设计决策，且把歧义面引入 pi |
| c. 维持分歧 | 低——G2 不达成，两平台技能不可迁移 | 零 | 契约分裂永久化 |

**被否 b**：若用它，§3.1 失败路径会变成——用户 `.agents/agents/chain…reviewer.md` 遮蔽内置 reviewer 后，`agent="reviewer"` 在两侧各自按扫描序解析，模型无法预知命中哪个；路径引用则无此歧义（所指即所载）。
**被否 c**：本设计 G2 直接落空。

迁移表（zsw 侧 breaking，进 README 迁移章节）：

| 旧用法（zsw ≤2.0） | 新用法 | 说明 |
|---|---|---|
| `agent="reviewer"` | `agent="<location 路径>"` | 报错文案给恢复指引；`zsw agents` 输出补路径列 |
| `agent` 缺省（不传） | 行为变化：裸跑 → 加载 general-purpose 内置角色 | 子进程 prompt 注入约 30 行角色 body；record.agent 展示名从 null 变 general-purpose（仅展示面）；不想要角色时显式传自定义 .md 路径 |
| `workflow="script:tri-review"` | `workflow="/abs/…/tri-review.js"` | 注入段/zflow scripts 输出补 location |
| `workflow="tri-review"`（裸名） | 同上 | 同上 |
| `workflow="chain"`（内置名） | 不变 | 保留 |

workflow 路径口径：**.js 绝对路径，支持 `~/` 前缀展开**（core `normalizeRef` 认 `~/` 形态，zsw run 面同口径；`~` 展开后即绝对路径语义）。

#### D-5 共享资产 frontmatter `tools` 字段的中立化

| 候选 | 长期合理性 | 短期成本 | 风险 |
|---|---|---|---|
| **a. 共享模板 frontmatter 去除 `tools` 字段 + body 文案去平台化（推荐）** | 高——共享资产不应硬编码单平台工具清单；工具约束回归「宿主派发决策」（调用方显式传 denyTools/白名单），资产只描述角色职责 | 低——10 个 .md 编辑 | pi 侧行为变化：orchestrator 原靠 frontmatter tools 落 `--tools` 白名单，去除后该 flag 不再传（权限放开到默认面）；需 pi CHANGELOG 显式说明 + 想要白名单的用户可在 **project 级**（`<ws>/.agents/agents/`）同名 .md 覆写（保留 tools；user 级覆写会被内置遮蔽，见 D-2 序位） |
| b. core 补 allowTools 中立字段，pi 映射 --tools、zcode 映射 prompt 软约束 | 中——字段中立了，但 zcode 无 allowlist flag，映射面是弱约束，语义不对等（pi 硬/zcode 软），且共享模板的 tools 值仍是 pi 工具名，zcode 侧照样要清洗 | 高——core 引擎链扩面 + 两引擎映射 | 「中立字段、不对等语义」是新的隐性陷阱 |
| c. 值域按引擎过滤（未知工具名忽略+warn） | 低——静默降级语义丢失（orchestrator 在 zcode 拿不到工具约束），warn 日志模型看不见 | 中 | 例 2 的「静默失效」换成「带日志的失效」，问题仍在 |

**被否 b**：若用它，§2.2 例 2 变成——zcode 侧 tools 经 prompt 软约束注入「只允许 todo, goal_control…」，而这些工具名在 zcode 根本不存在，模型被引导调用不存在的工具，比静默丢弃更糟。
**被否 c**：失效方式从静默变有日志，模型视角的语义错乱不变。
**配套修订（R2）**：逃生门在 **project 级**而非 user 级——core 序位下 npm-dev（内置源）高于 user 两级，user 级同名 .md 会被内置遮蔽；想要白名单的 pi 用户应在 `<ws>/.agents/agents/`（project-agents 槽，唯一稳定高于 npm-dev 的用户可控源）放同名 .md 覆写。

配套：`ask_user` 的 RPC 指引追加逻辑（`session-runner.ts:1079`）是 pi 派发层行为，不进共享资产——去 tools 化后该分支自然不再命中共享模板，无需改动。

#### D-6 workflow 脚本创作闭环收口

| 候选 | 长期合理性 | 短期成本 | 风险 |
|---|---|---|---|
| **a. generate 校验管线（ESM 拒绝/meta 必需/agent() 必需/语法/round-trip）+ tmp 写盘下沉 core；`getTmpDir/getSavedDir` 参数化为宿主注入；save/delete 出 barrel（推荐）** | 高——管线单实现（G4/G6），目录布局是宿主差异正好走参数化（pi 传 `.pi/workflows`，zsw 传 `~/.zsw/workflows`） | 中——core 扩面 + pi-sw 改消费 + zsw 新增三个 action | 校验规则演进（如未来支持 ESM）两侧同步 |
| b. zsw 自写 generate 管线 | 低——校验规则双实现，与 lintScript（core）规则漂移就是放行不一致脚本 | 低 | 「core lint 说合法、zsw generate 说非法」的漂移 |
| c. 不做 zcode 侧创作面 | 低——G4 落空，zcode 用户继续手写脚本 | 零 | 例 5 持续 |

**被否 b**：校验管线与 lintScript 是同一契约的两个入口，分家后规则漂移只是时间问题——pi 侧收紧了 meta 格式，zsw 侧 generate 还放行旧格式，脚本在两平台「合法域」不同。

zsw 侧新增 action 面：`zflow` 扩 `script-generate/script-save/script-delete`（与既有 scripts/lint 同前缀语义；zsw 的 action 面自 1.0.0 走 CLI——MCP 工具面已下线，tools/list 恒空、tools/call 指引走 CLI——实施面 = CLI + commands/zsw.md + skill 文档三处同步）。

**缺省语义统一（R2 补，suggestion 采纳）**：agent 参数缺省时两侧同走 `general-purpose` 内置角色（pi 现状即此，record 显示名缺省 general-purpose）；zsw 现为「无角色裸跑」（缺省继承主 agent 通用行为），接入内置资产后对齐为加载 vendored `general-purpose.md`（project 级遮蔽生效）。此差异列入 §1.2 差异表并随 D-4 一并统一。

### 3.3 关键权衡汇总

| 决策 | 选择 | 核心被否项 | 一句话理由 |
|---|---|---|---|
| D-1 资产位置 | core `agents/` 约定目录 | zsw 复制 / API 注册 | 与 workflows/ 同模式，一处维护 |
| D-2 agent 发现 | zsw 接 core（hostRoots 注入） | 维持双实现 | 单实现单语义，防环守卫上移 |
| D-3 注入渲染 | format 三函数下沉 core + 守卫/guide/排序参数化 | 各写各的 | 纯函数下沉 + 显式守卫，格式两侧一致 |
| D-4 引用契约 | agent 路径唯一；workflow 内置名+路径 | 全放开按名 / 维持分歧 | 对齐 pi D1 防遮蔽歧义；内置名是稳定 API |
| D-5 tools 中立化 | 共享模板去 tools 化 | 中立字段+双引擎映射 | 硬编码平台工具名是资产的平台断裂根源 |
| D-6 创作闭环 | 管线+tmp 下沉 core，目录参数化 | zsw 自写 | 契约双入口必须同实现 |

**运行时断言与探针状态**：
- ✅（已测）core resource-discovery **async** 扫描显式 follow symlink→文件、`stat().catch` 吞 ELOOP；npm 槽注入语义（一级子项 = 包目录 + 无 manifest 扫约定目录）对 `lib/vendor/` 布局成立（核实点 1 + R2 复审核实；zsw/pi 生产消费均走 async 链，sync 链无非测试调用方）；
- ✅（已测）三个 format 函数零 pi 依赖、入参纯数据（核实点 5）；
- ✅（已测）zsw model 数据含 contextWindow/reasoning.variants、无 input[]（核实点 3，`model-router.js:147-166`）；
- ⛔（实施期门）core hostRoots 加 project 槽后，zsw 四根映射的遮蔽序与现 resolver 行为一致——实施时用对照探针（同目录集两实现并跑 diff 清单）验收，探针目录集须含「子目录布局」「含 node_modules 的根」「同 stem 撞名（本体 vs 库内同名 → 本体胜）」三个维度（对应 D-2 缺口③ + R5 序语义）；
- ⛔（实施期门，双探针）vendored core agents 根序位（user 级 < vendored 内置 < project 级）在 zsw 侧成立——实施时 user 级放同名 .md 验证**内置胜**（防注入槽位把序弄反），project 级放同名 .md 验证**用户胜**（逃生门成立）；
- ⛔（实施期门）pi 侧去 tools 化后 `--tools` flag 不再传——实施时抓子进程 argv 探针确认（行为可接受性另见验收 A9，argv 探针只证 flag 未传）。

---

## 4 验收

实施完成后的真实场景验证（真实依赖、真实平台、非单测非 mock）。每个场景回溯 §1.3 目标。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|---|
| A1 | zcode 开箱角色库 | 在干净 zcode 环境（无用户 agent .md）装 zsw dev 版，新开会话看注入块；让主 agent 派 reviewer 审查一个真实文件 | 注入段 `<available_subagents>` 在条目预算内含全部 10 个内置角色（开箱默认 10 < 预算 15，不触发截断）且每个带 `<location>`；`zsub start agent=<reviewer 路径>` 真实跑完，产出审查意见；`zsw agents` 列出同 10 个 | G1 |
| A2 | pi 侧回归 | pi dev 链接新 core 后正常会话；`/subagents` 面板；跑一个 `workflow run`（内置名）；再模拟已装 8.7.0 用户经 npm 升级 pi-sw 的路径 | 注入三段格式与改造前**除 location 字段外逐字节等价**（快照对比；location 豁免**仅限 10 个内置角色的路径前缀变化**——用户/项目资源的 location 不豁免，防同 stem 遮蔽翻向只表现为 location 变化而被放过）；内置 workflow 按名可跑；10 个角色仍可发现（来源变 core 包）；升级路径下 10 角色仍在（pi-sw 对 core ≥0.4.0 的依赖下限生效，资产随依赖到达） | G1/G2/G6 |
| A3 | 契约统一（正反例） | zcode 与 pi 两侧各跑：agent 传名字（应拒+恢复指引）；agent 传路径（应成）；agent 缺省（两侧同走 general-purpose 角色）；workflow 传内置名（应成）；workflow 传自定义脚本路径（应成）；zsw 侧传 `script:名`（应拒+指引）；核对 skill（zsub-zflow-orchestration）与 commands/zsw.md 的契约描述 | 两侧报错文案同源（core 单实现）；成功路径行为一致；缺省两侧同角色；恢复指引里的命令真实可执行；skill/commands 文档与实际报错文案一致（契约变更三面同步） | G2 |
| A4 | 注入对齐 | 同一机器两平台会话注入块对照 | 三段 tag 名/字段集一致；models 段 zcode 侧出现 contextWindow 与 reasoning 档位（来自 v2 config 真实数据）；agents 段带 location；zsw 侧分段条目预算截断行为保留（构造 20+ agents 验证：subagents 段码点序截尾 + 「完整清单：zsw agents」兜底、被裁条目 = 码点序尾部而非 project 级优先被裁、workflows 段同理、models 段完整） | G3 |
| A5 | 创作闭环 | zcode 会话：让主模型写一个三路审查脚本 → `script-generate`（故意先写个带 import 的错误版本验证报错）→ 修正 → lint → save → run 真实执行 | ESM 版被拒且报错指出行列；合法版落盘 `~/.zsw/workflows/`；run 按路径引用真实跑通；`script-delete` 清理 | G4 |
| A6 | 双实现退役 | zsw 仓 grep `agent-md-resolver` 零引用；`lib/hook-inject.js` 的渲染逻辑替换为 core 调用；两仓测试套件绿 | 代码级验证 + `node --test` 全绿（zsw）/ vitest 全绿（pi-sw + core） | G5 |
| A7 | symlink 防环 | 构造 symlink 环（a→b→a）与多链同文件目录，两平台各跑一次 agent 发现；另构造**目录 symlink 整库**形态（`agents/my-lib -> 外部库目录`，同根下并存散 .md 本体文件**与本体同名 .md**）与子目录布局 | 两侧都正常终止、清单无重复条目、无未捕获异常（core realpath 守卫生效）；zsw 侧目录 symlink 整库形态下**库内 .md 与同根本体散 .md 同时可发现**（展开预处理不顶掉本体——W2④ 多根语义生效）；**同 stem 撞名时本体胜**（本体 reviewer.md vs 库内 reviewer.md → 前者胜出，注入段 location 指向本体路径）；子目录布局经验收的迁移路径处理后可发现 | G5 |
| A8 | 同源校验 | `node scripts/vendor-subagent-core.js --npm <ver>` 后，vendored agents/ 与 npm 包内容 sha256 一致；VENDOR-MANIFEST capabilities 含 agentsAssets | 脚本校验自过；两侧跑 A1/A2 | G1/G6 |
| A9 | pi 侧 D-5 行为验收 | pi 侧真实派发一次 orchestrator 委派（去 tools 化后），观察子进程完成情况与产出 | 子进程正常完成、产出质量无肉眼劣化、无异常工具调用行为（argv 探针只证 `--tools` 未传，行为可接受性需真实场景确认） | G1/G6 |

---

## 5 下一层拆分

### 5.1 实施单元（两仓三线）

| 单元 | 仓库 | 内容 | justification | 验收挂钩 |
|---|---|---|---|---|
| W1-core-assets | xyz-agent | ① 10 个 .md 从 pi-sw `agents/` 迁入 core `agents/`（D-5 去 tools 化 + body 去平台化同步做）② pi-sw `package.json` 移除 `pi.agents` 资产声明与 `files` 白名单的 `agents/` 条目 ③ core package.json `files` 加 `agents/` | 资产先行——两侧接入都依赖它存在 | A1/A2 |
| W2-core-discovery | xyz-agent | ① **async** `discoverResources` 扫描/合并层补 realpath 去重（多链同文件；文件级 symlink 链 ELOOP 已核实被 `stat().catch` 吞除）——生产消费走 async 链，sync 链无非测试调用方，勿修错面（顺带修 `scanDirectorySync:671` 的漂移注释）② hostRoots 加 project 级槽位（插在 project-agents 之下，见 D-2 根映射）③ barrel 导出 discoverResources 的 agents 面补齐（如未全导）④ **hostRoots 同标签多根语义**：`buildScanTargets` 的 hostRoots 消费从 `Map(source→dir)`（每标签一个 dir、同标签后者覆盖前者）扩为列表（同标签多 dir 依注入序同序位扫描）+ 硬编码槽（user-agents/project-agents）与 hostRoots 同标签注入合并——目录 symlink 展开预处理的 core 侧配套（见 D-2 展开段），端口形态不变；**序语义**：合并/注入序统一「原根（硬编码根/本体根）排展开目标之后」（core last-writer-wins 靠后者胜 → 本体胜，对齐 zsw 现语义）；**回归断言**：pi 现单条目形态下改前后 `discoverResources` 输出（含每条 source 标签与胜出路径）逐项一致（对照探针跑 pi 真实 agentDir——Map→列表是行为敏感改动，防标签内扫描序漂移） ⑤ 单层维持的对照探针（目录集含子目录布局、node_modules、**同 stem 撞名（本体 vs 库内同名）**三个维度） | zsw 接入的前置缺口（核实点 1 + D-2 缺口①②③④） | A7 + 实施期门探针 |
| W3-core-render | xyz-agent | ① 三个 format 函数 + Entry 接口从 pi-sw injector 下沉 core ② xml-injection 出 barrel ③ ModelEntry 口径并集（N6，含 label?）④ 渲染器分段条目预算参数（subagents/workflows 各自条目预算 + **码点序排 + 截尾** + 截断兜底指引，models 永不截；`sortByCodepoint` 排序函数随下沉——防不排序时截尾系统性裁掉 project 级条目）⑤ ModelEntry 全字段 optional 守卫（input?/contextWindow?，修 `formatCaps` 对 undefined input 的 TypeError 与 contextWindow 直渲染垃圾输出）⑥ guide 文案参数化（formatAgentList 现内嵌 pi 专属指令「pass systemPrompt alongside the agent name」——zsw 无此机制且该文案在 pi 侧也已过期，改为宿主注入各自 guide） | 纯函数搬运 + zsw 预算需求参数化 + 守卫修复 | A4 |
| W4-core-script-pipeline | xyz-agent | ① generate 校验管线 + tmp 写盘从 pi-sw 下沉 ② getTmpDir/getSavedDir 参数化（宿主注入）③ saveWorkflow/deleteWorkflow/generate 面 + xml-injection 出 barrel | 创作闭环单实现（D-6） | A5（pi 侧回归 A2） |
| W5-pi-rebind | xyz-agent | pi-sw 改消费 core 新面：① injector 调 core format（guide 参数化后传 pi 版文案）② workflow-script 调 core 管线 ③ workflow run 放开内置名（D-4a 的 pi 半边）④ CHANGELOG 记 tools 行为变化（含 project 级覆写逃生门指引）⑤ pi-sw 对 core 的版本下限声明（dependencies `@zhushanwen/subagent-core` ≥0.4.0——已装用户升级 pi-sw 时 agents 资产必然随依赖到达）⑥ core 包 agents/ 进 pi 发现面的接线候选（hostRoots 注入 core 包根、标签 npm-dev/npm——若 §5.3.4 的约定扫描在 dev 工作区拓扑不命中时的降级路径，防 10 角色从 pi 侧静默消失且无兜底） | 宿主接线回改 | A2/A3（pi 半边） |
| W6-zsw-agent-line | zcode-plugin-workspace | ① agent 发现换 core（agent-md-resolver 退役，根映射见 D-2a）② agent 参数收紧为仅路径 + 报错恢复指引 ③ agent 缺省改走 vendored general-purpose 角色（对齐 pi）④ `zsw agents` 输出补 location ⑤ vendored core agents 进发现面（npm 槽注入 dir = `lib/vendor/`，序位 user 级 < 内置 < project 级）⑥ **目录 symlink 宿主层展开预处理**（四根下一级目录 symlink 动态展开为同标签额外扫描根，realpath 防环含根本身、深度一层、库内容须平铺库根一层、**本体根注入在展开目标之后（本体胜，与直觉相反注意）**——保整库一链形态不断档，core 侧配套见 W2④）⑦ skill `zsub-zflow-orchestration/SKILL.md` 契约段更新（agent 参数从「名或路径」改「仅路径」+ 缺省角色语义）⑧ 子目录/目录 symlink 布局迁移说明（README，明写两类收窄：子目录需平铺/symlink、库内容需平铺库根一层） | zsw 侧 agent 线收口 | A1/A3/A6/A7 |
| W7-zsw-inject | zcode-plugin-workspace | hook-inject 改调 core 渲染三段；分段条目预算传参；agents 段带 location；models 段渲染 contextWindow/reasoning；skill 中 `<zsw-resources>` 消费指引同步改三段 XML tag 名 | zsw 侧注入对齐 | A4 |
| W8-zsw-script-face | zcode-plugin-workspace | zflow 扩 script-generate/script-save/script-delete（实施面 = CLI + commands/zsw.md + skill 三处同步；zsw MCP 工具面已下线，tools/list 恒空）；目录 `~/.zsw/workflows`；README 迁移表（D-4 breaking + script: 废弃 + agent 缺省行为变化）；zsw `package.json` description 同步更新（现含将过期的「custom script:\<name\> extension」「four-root agent .md discovery」表述） | zsw 侧创作闭环 + 契约收紧的文档面 | A5/A3 |
| W9-vendor-release | zcode-plugin-workspace | vendor 脚本扩 `capabilities.agentsAssets`；刷 vendor；两仓发版节奏落地（见 5.2） | 分发链闭环 | A8 |

依赖序：W1→(W6,W5)；W2→W6；W3→(W5,W7)；W4→(W5,W8)；W9 最后。W1-W4 可并行（core 仓内互不依赖的扩面，W2/W3/W4 触不同模块）。

### 5.2 版本与发版节奏

- core 当前待发布 0.3.0（host-surface 扩面，已有 changeset）——**先发**，不与本设计混版；
- 本设计全部收口落 **core 0.4.0**（minor：新增资产/导出/参数化，无破坏性导出变更）；
- pi-sw 随 core 0.4.0 同步发版（资产迁移 + tools 行为变化在其 CHANGELOG 标注）；
- zsw 在 core 0.4.0 发布后 `vendor-subagent-core.js --npm 0.4.0` 刷新，随 zsw 2.0.0 一并出（D-4 收紧是 major break，正好同窗）。

### 5.3 待验证检查点（设计阶段无法确定，诚实标注）

1. core hostRoots 加 project 槽的 API 形态（新增槽位 key vs 复用现有槽语义扩展）——W2 实施时定，倾向新增显式槽位（`project-host`）避免借位语义污染；
2. zsw `.zcode/agents` 项目根在 core 扫描布局中的 tmp 排除规则是否需要（core 对 `.tmp` 有专项处理，`.zcode` 无先例）——W6 实施时验证；
3. 分段条目预算（subagents 15 / workflows 10）的量级估算已按开箱场景给出（D-3a），具体值 W7 用真实注入量实测微调；
4. pi-sw `agents/` 迁走后 npm-dev 源对 core 包 `agents/` 的扫描确认（core 包无 pi manifest，走约定目录——机制已证实，dev 工作区拓扑下的实际布局待 A2 实测）。

---

## 附：审查循环记录与被否谱系

### 被否谱系（R1 审查击穿的方案，终局形态）

| 被否方案 | 击穿反例 | 终局方案 |
|---|---|---|
| vendored core agents 注入最低优先级槽（用户全级可遮蔽） | core 源码序 user-pi < user-agents < npm < npm-dev < … < project-agents（`resource-discovery.ts:13,526-579,627-667`，last-writer-wins）——npm 槽并非最低，且「全级可遮蔽」与 pi 内置语义不一致 | vendored 注入 npm 槽序位：user 级 < 内置 < project 级（内置遮 user 级同名，project 级保留逃生门） |
| formatCaps 对 input 缺席自然降级（R1 误标「已核实」） | `entry.input.includes("image")` 对 undefined 抛 TypeError（`model-list-injector.ts:73`）；contextWindow 直渲染输出 "undefined" | W3 显式守卫工作项（全字段 optional 消费点） |
| 注入预算沿用 45 行总预算 | 三段 XML 每条目多行块，开箱 10 内置 agents ≈ 42 行 + workflows ≈ 18 行 + models——45 行必爆，A1/A4 验收互斥 | 分段条目预算（subagents 15 / workflows 10 / models 完整）+ 截断兜底指引 |
| core 扫描改递归以兼容 zsw 子目录布局（D-2 审查期备选） | 改递归动 pi 已验收行为，且需同步引入 node_modules/.git 排除（zsw 真机实测过的灌清单场景） | core 维持单层（pi 契约）+ 宿主层展开预处理（承第 5 行）；node_modules 风险单层下自然消解 |
| 「symlink 平铺迁移」指引本身（R2 版） | 对 symlink→**目录**整库形态不可执行：用户需逐个建文件级链且库更新后不可持续，agent 静默消失（清单里没有，兜底指引只救截断不救消失） | zsw 宿主层目录 symlink 动态展开预处理（链接目标作为同标签额外扫描根，防环含根本身、一层深度），core 侧配套多根语义见下行 |
| 展开预处理「core 不动」声明（R3 版） | core `buildScanTargets` 对 hostRoots 的消费是 `Map(source→dir)`——每标签恰好一个 dir，同标签多条目靠后者整体覆盖前者（`~/.zcode/agents` 本体 + 一个库链接 = 本体 .md 整体消失）；且 user-agents/project-agents 槽硬编码自建不吃注入 | W2④：hostRoots 消费 Map→列表（同标签多 dir 同序位扫描）+ 硬编码槽与 hostRoots 注入合并；A7 补「本体与展开目标共存」断言 |

### 审查循环记录

- **R1**（初版）：tech-design-review 对抗式审查，4 must-fix + 7 suggestion + 3 doc_error。must-fix：①遮蔽方向三处写反（本谱系第 1 行）②遍历语义缺口遗漏（谱系第 4 行）③A1/A4 预算互斥（谱系第 3 行）④formatCaps 假阳性「已核实」（谱系第 2 行）。抽查 15 处 file:line 证据 13 处为真。
- **R2**（第一轮修复）：全量修复 4 MF + 7 S + 3 DE——遮蔽方向重写（D-1a/D-2a/D-5a/§3.3 探针）；D-2 补缺口③与单层统一决策；分段条目预算替代 45 行总预算（A1/A4 对齐）；ModelEntry 守卫转显式工作项 + label? 补齐；缺省语义统一（D-4 补决策 + §1.2 差异表）；MCP 表述改正（CLI + commands + skill 三面）；W1/W3/W5/W6/W7/W8 连带项补齐（files 清理/guide 参数化/依赖下限/skill 联动/description 更新）；A2/A3/A4 扩充 + 新增 A9。
- **R2 复审判定**：4 MF 中 3 条成立（遮蔽方向/预算互斥/formatCaps）；MF-2 被击穿一半——symlink 平铺迁移对目录 symlink 整库形态不可执行（新 must-fix）。新发现 1 MF + 5 S + 3 DE。
- **R3**（第二轮修复）：目录 symlink 改宿主层动态展开预处理（D-2 根映射段 + W6⑥ + A7 断言 + 谱系第 5 行）；W2① 实施对象改 async 链（sync 无生产调用方，防修错面）；分段预算补「码点序排 + 截尾」定义与排序函数下沉（D-3a/W3④/A4——防系统性裁掉 project 级条目）；W5⑥ 补 core 包根接线候选（§5.3.4 降级路径）；vendored 注入 dir（`lib/vendor/`）与 `~/.zcode/agents` 借 user-pi 槽两处落地参数点名（D-2 根映射）；agent 缺省行为变化进 D-4 迁移表 + W8 README 项；workflow 路径口径补「支持 ~/ 展开」；§3.3 D-3 汇总行与 A2 表述矛盾修正。
- **R3 复审判定**：R2 的 8 条 findings 全部成立落地；但目录 symlink 展开的「core 不动」声明被 core 源码击穿（hostRoots Map 单 dir/标签 + 硬编码槽不吃注入——本体被展开目标顶掉）。新发现 1 MF + 2 S + 1 DE。
- **R4**（第三轮修复）：撤「core 不动」——W2 补缺口④（hostRoots 同标签多根语义：Map→列表 + 硬编码槽与注入合并，端口形态不变），D-2 展开段重写可行性声明；防环写明含四根本身 realpath；嵌套不可见显式声明（库内容须平铺库根一层，W6⑧ 迁移说明明写两类收窄）；D-3a 补「内置条目无截断豁免」显式表态（开箱不触发、兜底可恢复、两段式豁免不做）；A7 补「本体 .md 与展开目标共存」断言；被否谱系第 4 行终局修正 + 第 6 行新增。
- **R4 复审判定**：R3 的 4 条 findings 全部成立；**0 must-fix，设计就绪**。附 2 条 suggestion（同标签序语义未定义 + pi 发现层不变性断言缺失），标注随实施处理。
- **R5**（终态收口）：R4 的 2 条 suggestion 当轮修完（修复成本低于实施期踩坑）——注入/合并序语义统一「原根排展开目标之后（本体胜，core last-writer-wins 与 zsw 现语义靠前者胜方向相反，防实施排错）」写进 D-2 展开段/W2④/W6⑥；⛔ 探针与 A7 补「同 stem 撞名 → 本体胜」维度；W2④ 补 pi 单条目形态改前后 discoverResources 输出逐项一致的发现层回归断言；A2 location 豁免收窄（仅限 10 内置角色路径前缀，防遮蔽翻向被放过）。**终态：0 must-fix / 0 遗留 suggestion，设计就绪，可进入 §5 实施。**
