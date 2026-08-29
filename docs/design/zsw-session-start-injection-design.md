# zsw 会话启动资源注入（available-models / agents / workflows）

> **一句话结论**：给 zsw 增加 SessionStart hook，在会话启动时把三份资源清单（可运行模型、agent .md、workflow）作为快照注入主 agent 上下文（`<zsw-resources>` 块），使路由决策零工具调用可得；快照可能过期，`zsw models` 等查询命令保留为权威兜底。这是 pi `before_agent_start` injector 在 zcode 平台的等价落地。

- **当前层 → 下一层**：功能设计（行为 + 机制 + 验收）→ 实现单元拆分（hook 注册 / 纯函数组装 / CLI 子命令 / SKILL.md 联动）。不跨到函数级代码设计。
- **层性质**：技术方案设计类（涉及运行时行为、数据流、错误处理），准则 5/6/7 全适用。

## 1. 背景目标

**SCQA**：

- **S（情境）**：zsw（z-subagent-workflow 插件）通过 `zsw start --model <名>` 支持逐任务指定模型、四根发现 agent .md、内置 + 脚本 workflow；编排 skill 要求 agent「按任务档位选模型」。
- **C（冲突）**：做路由决策所需的三份清单（哪些模型可跑、哪些 agent 存在、哪些 workflow 存在）**都不在 agent 上下文里**——主 agent 与子 agent 都看不到，只能靠临时跑 `zsw models` / `zsw agents` 查询，或按 AGENTS.md 路由表里的模型名硬编码派发（该表已漂移，其中 `zai-coding-cn/glm-5.3-flash` 在当前 v2 config 中不可解析，实传必错）。
- **Q（问题）**：怎么让 agent 在**不做额外工具调用**的情况下，就拿到与当前环境一致的路由决策信息？
- **A（答案）**：会话启动时由 SessionStart hook 注入三清单快照，查询命令保留为过期兜底。

**系统是什么**（给没用过 zsw 的读者）：zsw 是 zcode 插件，提供两个东西——① 后台子代理生命周期管理（`zsw start`，支持 `--model` 逐任务指定模型、agent .md 四根发现、worktree 隔离）；② 多阶段 workflow（内置 chain/parallel/map-reduce/scatter-gather/review-fix-loop 五种 + `script:<名>` 自定义）。模型路由的解析链是 `start 入参 --model > agent .md frontmatter model > 默认模型`，校验依据是 `~/.zcode/v2/config.json` 中 provider 的模型清单；**真正可运行**还要求 provider 已配 `options.apiKey`（无凭据在启动前 bootstrap 阶段即拒绝）。**当前默认模型**（cli config `model.main`）是 `builtin:bigmodel-coding-plan/GLM-5.3-Flash`——轻量档。

**设计目标**（从使用者体验倒推）：

1. **G1 路由信息零调用可得**：主 agent 在新会话里不跑任何命令，就能回答「现在有哪些模型可跑 / 默认是哪个 / 短名和全名各自怎么用」，且与权威源一致（一致性口径见 D3：默认 provider 段按**模型名单 + 默认标记**与 `zsw models` 一致，字段粒度不做要求；其余 provider 为全名形态的并集展示）。
2. **G2 路由决策一步到位**：agent 派发 zsub 任务时直接从上下文取模型引用，省掉「先 `zsw models` 再 start」的两步。
3. **G3 快照过期能自愈**：会话中途环境变化（GUI 停用 provider 等）导致快照失真时，agent 有明确的兜底路径且不会因传错模型名而卡死（传错会收到带可用清单的可操作报错——既有行为，注入块让它更少发生）。
4. **G4 无害性**：未启用插件的会话零影响（无 hook 可言）；启用插件的会话注入硬预算快照（≤45 行），不报错、hook 执行延迟 <500ms（hook 内联执行，延迟计入会话启动，故设 500ms 性能门 + 5s 超时上限）；被 spawn 的嵌套子会话不注入。（会话启动时无法预判该会话是否使用 zsw——SessionStart 的 matcher 值域只有启动源，故「装了插件但全程没用 zsw」的会话也付这份 token，这是 §3.2 已声明的方案代价，由预算硬上限约束。）

**in-scope**：zsw 插件新增 SessionStart hook 及注入内容格式；`zsw` CLI 新增 `hook session-start` 子命令；编排 SKILL.md 路由纪律联动更新；发版（minor）。

**out-of-scope**：模型路由策略本身（档位表在用户全局 AGENTS.md，属用户配置）；向 zsub spawn 的子代理会话注入（见 D4，有意不做）；MCP 工具面复活；zcode 引擎侧任何改动。

## 2. 现状与问题分析

**现状：三份清单只存在于文件系统与 CLI 查询里，agent 上下文一片空白。**

三个清单的物理数据源（现状，均经本机实测）：

```
~/.zcode/v2/config.json            provider 注册表（含 options.apiKey 凭据 + models 清单）
        │  过滤 apiKey 非空且模型清单非空 ───►  可运行模型集
        │  （本机实测：10 provider 总 / 6 个带 apiKey，其中 1 个无模型出局，
        │    实际可跑 5 provider / 7 模型）
        ▼
~/.zcode/cli/config.json           model.main = 当前默认模型（本机 builtin:bigmodel-coding-plan/GLM-5.3-Flash）
        │
<cwd>/.agents/agents/  <cwd>/.zcode/agents/    agent .md 四根发现（agent-md-resolver.list()，
~/.agents/agents/      ~/.zcode/agents/          本机本项目 6 个：context-builder/oracle/researcher/
        │                                      reviewer/tech-design-review/worker）
        ▼
zsw lib/workflow-manager.js        内置 workflow 5 种 + workflow-script.js 四根 script: 发现（本机 0 个）
```

agent 想用这些信息只有两条路，各有失败模式：

- **失败模式 A（查询成本 + daemon 依赖）**：跑 `node bin/zsw.js models`——但该子命令走常驻 daemon，daemon 未运行时报 `connect ~/.zcode/zsw/daemon.sock 失败：ENOENT`（本会话实测；`models` 无 `--local` 后门），用户要先开一个启用了插件的 zcode 会话才能查。每次路由决策重复支付一次工具调用。
- **失败模式 B（硬编码漂移）**：编排 skill 与用户全局 AGENTS.md 里的模型路由表写着具体模型名（如 `zai-coding-cn/glm-5.3-flash`），但这些名字在当前 v2 config 中**不可解析**——agent 照表派发，`--model` 直接被 resolve 层拒绝（报错本身可操作，但任务已经走了一段弯路）。模型集随 GUI 套餐/登录变化，静态表必然漂移。变体：skill 档位纪律「重量任务不传 model，跟随默认主模型」隐含「默认 = 重量模型」假设——当前默认实为轻量 Flash，照纪律执行会把重任务派到轻模型。

**子代理侧同样空白**（真机探针实证）：spawn 一个 zsub 并直接问它「你上下文里有可用模型清单吗」，回答是「没有，只有 AGENTS.md 路由表里零散出现的模型名，不是可调用清单」。

**根因**：zsw 的资源暴露只有 **pull 通道**（agent 主动查 CLI），没有 **push 通道**（环境主动把信息放进上下文）。路由决策是几乎每个会话都要做的高频动作，pull 的成本与失败模式被反复支付。pi 的 subagent-workflow 用 `before_agent_start` 事件在会话开始时注入 `<available_subagents>` / `<available_workflows>` / `<available_provider_models>` 三块（dev-0.9.11 `src/index.ts:205-207`，injector 注释原话：「让 LLM 知道有哪些 agent/workflow 可用」）——zcode 无进程内 extension API，但存在等价通道（见 §3.2）。

## 3. 解决方案

### 3.1 终态（使用者视角）

**成功路径**——重启 ZCode 后新会话，用户说「帮我派两个后台子任务：一个深度调研用重模型，一个格式转换用轻模型」：

```
[会话启动] SessionStart hook 静默执行（<500ms），上下文头部出现：

<zsw-resources snapshot="2026-08-29T12:00:00+08:00">
zsw 可用资源快照（会话启动时生成，GUI 中途改动后可能过期）
models：
  默认 provider builtin:bigmodel-coding-plan（短名直接可传）：GLM-5.3, GLM-5.3-Flash（默认）
  其他可运行 provider（跨 provider 必须用全名 <provider>/<model>）：
    builtin:bigmodel-start-plan/GLM-5.3-Flash
    5c5bb493…/MiniMax-M3 · 5c5bb493… 即 5c5bb493-035c-4214-8a75-0563fba60394
    e512d53e…/mimo-v2.5-pro · e512d53e…/mimo-v2.5 · e69643b0…/k3-256k
agents（四根发现，同名高优先级根胜出）：context-builder（需求分析与元提示生成）· oracle（高上下文决策一致性守护）· …（6 个）
workflows：内置 chain / parallel / map-reduce / scatter-gather / review-fix-loop；script:<名> 自定义（当前 0 个）
兜底：传错模型名时报错自带可用清单（零依赖权威兜底）；主动现查 zsw models / zsw agents（需 daemon 在跑——任一启用插件的会话）
</zsw-resources>

[用户] 派两个后台子任务，重的调研、轻的格式转换
[agent] （零工具调用）从注入块取：重 → --model GLM-5.3（显式，因默认是轻量 Flash 不能裸跟随）；轻 → 不传，跟随默认 GLM-5.3-Flash
[agent] node bin/zsw.js start --task "…" --slug research --model GLM-5.3
[agent] node bin/zsw.js start --task "…" --slug fmt
[zsw] 两任务受理，模型解析一次通过
```

对比现状：省掉两次 `zsw models` 调用及其 daemon 未运行风险；模型引用来自快照而非可能漂移的静态表；默认档位（轻/重）不再靠纪律假设而是明示在块内。

**失败路径 1（快照过期）**——用户会话中途在 GUI 停用了某 provider，随后让 agent 用该 provider 的模型派发：

```
[agent] node bin/zsw.js start --model <已停用模型> …
[zsw] 错误: 未知模型 "…"（provider … 下可用: …）。恢复指引：改用该 provider 下的模型…或先在 ZCode 桌面端启用目标模型后重试。
[agent] （按报错内的清单重传，或跑 zsw models 现查）→ 任务受理
```

快照失真不产生新故障面：resolve 层校验是既有行为，报错自带可用清单（错误 → 权威源 → 重试闭环已存在；且此报错**零依赖**——不要求 daemon 在跑）。

**失败路径 2（hook 自身出错）**——v2 config 被临时破坏、或任一数据源读取抛异常：

```
[hook] 捕获一切异常 → stdout 输出 {}，exit 0，stderr 记一行诊断
[会话] 照常启动，只是上下文没有 <zsw-resources> 块；agent 行为退回现状（pull 查询）
```

降级即现状——注入是纯增益通道，任何故障最坏回到今天的行为。

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. SessionStart hook 注入快照**（选定） | 高：hook 是 zcode 官方插件契约（七事件之一）；注入 = 单 hook 单 JSON 输出，by construction 确定；数据源复用现有三个纯读模块，零新扫描逻辑 | 低：~1 个 hooks.json + 1 个纯函数模块 + 1 个 CLI 子命令分支 | 快照过期（有兜底）；所有装了插件的会话付 token（有硬预算）；resume 场景重复注入待探针（P-resume-dup） | ✅ |
| B. MCP server 工具 description 动态生成 | 低：zsw 1.0.0 起 MCP 工具面已刻意下线为 CLI thin client，此路逆架构方向；description 语义是「工具说明」不是「环境快照」 | 中：要复活 server 侧生成逻辑 | 与「工具面下线」决策直接冲突；GUI 只在启动扫描，同样有快照问题 | ❌ |
| C. 只改 SKILL.md 写死当前模型名 | 无：不解决根因（信息仍不在上下文），静态表必漂移（失败模式 B 已实证） | 极低 | 与 AGENTS.md 路由表同病，下次套餐变化即错 | ❌ |
| D. UserPromptSubmit 每轮注入 | 中：信息永远新鲜 | 低 | 每 turn 重复支付 token，比 A 贵一个数量级；pi 也不这么做 | ❌ |

**被否方案若被采用，§3.1 的例子会怎样**：方案 B 下 agent 仍需先调 MCP 工具列表才能看到清单（且该面已下线，等于不可用）；方案 C 下 agent 第一步仍要 `zsw models`（失败模式 A 原样保留）；方案 D 下每次用户消息都带一遍 20+ 行清单，长会话 token 浪费严重。

### 3.3 关键决策与权衡

**D1：注入通道 = SessionStart hook 的 `additionalContext`（选定）**
- **采用**：插件 `hooks/hooks.json` 注册 SessionStart → `node "${ZCODE_PLUGIN_ROOT}/bin/zsw.js" hook session-start`，hook 以严格 JSON（`hookSpecificOutput.additionalContext`）输出注入文本。
- **被否**：进程内事件监听（zcode 无 extension API）；MCP description（见方案 B）；UserPromptSubmit（每轮重复）。
- **证据**：本仓 z-tool-finder 插件同款 hook 生产在跑——其 `<available-custom-tools>` 块在本会话上下文可见（活证据）；官方 hook 契约文档（七事件、严格 schema、`${ZCODE_PLUGIN_ROOT}` 模板变量、插件 hook 自动启用 runner）。
- **效果**：G1/G2 成立的机制载体；插件形态安装与 inline 开发两种加载方式都走同一 hooks.json。

**D2：matcher 省略（四种 source 都注入），resume 重复交探针把关（选定）**
- **采用**：不设 matcher，`startup` / `resume` / `clear` / `compact` 四种会话启动源都注入。`compact` 后重注入是**特性**（压缩会丢细节，新快照恰好补位）。
- **被否**：只匹配 `startup|compact`——resume 会话（重启 ZCode 恢复会话）将完全没有块，G1 在 resume 场景失效。
- **证据**：z-tool-finder 先例即省略 matcher；SessionStart 的 matcher 值域为 startup/resume/clear/compact（官方契约）。
- **效果**：resume 会话也有快照；重复注入风险由 P-resume-dup 探针实测，失败则降级收窄 matcher。
- **代价声明**：若引擎在 resume 时重放历史注入块，会出现两份块（token 翻倍但无正确性影响）；此为运行时断言，未实测不写死结论——见探针 P-resume-dup。

**D3：单外层标签 `<zsw-resources>` 内分三段；models 段两层展示（默认 provider 短名明细 + 其余 provider 全名）；硬预算（选定）**
- **采用**：一次 hook 输出一个块，内分 models / agents / workflows 三段 + 兜底行。models 段两层：**默认 provider**（短名解析的 target，与 `zsw models` 输出同口径）只渲染**模型名单 + 默认标记**两个字段（`zsw models` 返回的结构化条目含 label/contextWindow 等，注入块不做字段级对齐，一致性按名单+默认标记判定），且**不筛 apiKey**（锚定 `zsw models` 口径；默认 provider 凭据被 GUI 中途删除属快照过期，由 G3 报错兜底覆盖）；**其他 apiKey 非空且模型清单非空的 provider** 只以**全名** `<provider>/<model>` 列出（短名跨 provider 本就不可解析，展示短名等于诱导传错）。agents 段列 name + 截断 20 字描述；workflows 段列内置 5 名 + script 数量。UUID 形态 provider 首次出现给 `UUID 前 8 位…` 缩写并附全名对照。硬预算：**全文 ≤ 45 行**；超限**优先保留 models 段**，依次截 agents 段、workflows 段；截断标注与被截段对应（截 agents 段 → 标注「完整清单：zsw agents」；截 workflows 段 → 标注「完整清单：zsw workflow --action scripts」）。
- **被否**：① 三个独立 XML 标签（pi 形态）——zcode 引擎对同事件多 hook 输出的拼接顺序无契约保证，单块 by construction 确定；② models 段平铺所有 provider 的裸短名——非默认 provider 短名直传必被拒（model-router.js 短名只按默认 provider 解析），正是失败模式 B 的翻版；③ 列全部 provider（含无凭据的）——会诱导传必被拒的模型名。
- **证据**：本机实测规模：5 个可运行 provider / 7 模型 / 6 agents / 0 script → 两层结构渲染约 15-20 行，预算内；apiKey 过滤逻辑已存在（driver.js:167 同判定）；「与 `zsw models` 一致」的口径锚定——daemon 侧 `models` action 只返回默认 provider 明细（dist/mcp/server.js），故一致性定义为：**默认 provider 段与 `zsw models` 完全一致；其余 provider 段为全名形态的并集补充**。
- **效果**：G1 的一致性口径成立且可验收；块内展示形态与 resolve 解析语义严格对齐（短名=默认 provider、跨 provider=全名），G2 的「一步到位」不会引向错误引用。

**D4：嵌套会话不注入（选定）**
- **采用**：hook 子命令入口检查 `ZSW_NESTED=1` → 直接输出 `{}` 返回。
- **被否**：向 zsub spawn 的子代理注入——子代理不做路由决策（任务书由主 agent 构造）；且子代理运行在隔离 HOME（`~/.zcode/zsw/home-*`），该环境本就不加载用户插件，注入无从谈起。
- **证据**：driver.js:280（spawn 路径）与 runner-appserver.js:317（appserver 路径）都强制注入 `ZSW_NESTED=1`（D10 防递归）；z-tool-finder hook 同款嵌套防护先例（检查 `TF_NESTED || ZSW_NESTED`）。
- **效果**：G4 成立；与 pi 的差异（pi 对每个 agent 会话都注入）是有意偏差——zsw 的子代理上下文由主 agent 的任务书控制，职责边界更干净。

**D5：hook 任何异常静默降级，绝不阻断会话（选定）**
- **采用**：try/catch 包裹全部数据读取与渲染；异常 → stdout `{}` + exit 0 + stderr 一行诊断。hook 超时设 `timeoutMs: 5000`（引擎超时杀进程也不阻断会话，hook 结果只是被丢弃）。
- **被否**：fail-fast 报错退出——hook 非零退出会污染会话启动日志且对用户无收益（缺块的最坏结果 = 现状）。
- **证据**：z-tool-finder 同款降级先例（`catch → {}` + 会话照常）；官方契约「hooks always run inline」（hook 延迟直接计入会话启动，故 500ms 性能门 + 5s 超时上限均有必要）。
- **效果**：G4 成立；§3.1 失败路径 2 的行为保证。

**D6：数据读取复用现有纯读模块；项目级根以 `ZCODE_PROJECT_DIR` 定位（选定）**
- **采用**：models 段读 v2 config（复用 model-router 的读取与默认模型解析口径）；agents 段调 `agent-md-resolver.list(projectDir)`；workflows 段调 `workflow-script.listScripts(projectDir)` + 内置五名常量。三者均为纯文件读，无 daemon 依赖（本机实测可独立运行）。**projectDir 解析链：环境变量 `ZCODE_PROJECT_DIR`（官方 hook 契约确认模板变量「also injected as environment variables」，hook 进程内可用）→ 回退 `process.cwd()`**。cwd 回退仅保底——hook 由引擎 spawn，其 cwd 无契约保证，靠 cwd 定位项目级四根（`<cwd>/.agents/agents/` 等两根 + ws 侧 script 两根）会静默漏条目或混入错误目录。
- **被否**：① hook 内独立实现一遍扫描——两套口径必然漂移（正是失败模式 B 的翻版）；② 仅用 `process.cwd()`——cwd 无契约，项目级发现不可靠（错数据比缺数据更难察觉）。
- **证据**：三个模块本机直跑成功（6 agents / 0 script / 5 可运行 provider）；官方契约 SKILL.md:35 确认 `${ZCODE_PROJECT_DIR}` 会以环境变量形式注入 hook 进程；本仓生产代码已依赖该注入——bin/zsw.js:366、596 两处 `process.env.ZCODE_PROJECT_DIR || process.cwd()`（workflow 本地路径的 ws 侧根定位依赖它）；「注入确实发生」的直接观测由探针 P-cwd 闭环验证。
- **效果**：「注入块与 CLI 查询同一数据源」的单一事实来源；hook 冷启动 < 500ms（纯本地读）；项目级 agent/script 在 hook 环境下定位正确。

**D7：SKILL.md 路由纪律同步更新（选定）**
- **采用**：编排 skill 的模型路由段从「不要硬编码名字，先 `zsw models` 查清单」改为：① 优先使用上下文 `<zsw-resources>` 快照；② **默认模型档位以块内标记为准，不假设「不传 = 重量」**——当前默认是轻量 Flash，重任务须显式传重量模型短名；③ 块缺失或怀疑过期（GUI 中途改过配置）时再 `zsw models` 现查（daemon 前置：任一启用插件的会话），或直接尝试并依赖报错内清单重传。
- **被否**：只加注入不改 skill——skill 会继续教 agent 先跑查询与「重量不传 model」的失真假设，G2 收益落空。
- **证据**：现行 skill 原文即「不要凭记忆硬编码名字——路由决策前先 `node bin/zsw.js models` 查当前清单」；其档位纪律「重量任务不传 model，跟随默认主模型」在默认 = Flash 的当前环境下与事实相反（§2 失败模式 B 变体）。
- **效果**：G2 完整成立；注入块与 skill 纪律不打架；修掉一处现存失真。

### 3.4 物理数据流（终态）

```
[ZCode 会话启动]
   │ SessionStart 事件（startup/resume/clear/compact）
   ▼
[zsw hooks/hooks.json] ──spawn──► node bin/zsw.js hook session-start  （ZSW_NESTED=1 ? → 输出 {} 退出）
   │                                  │  项目目录 = env ZCODE_PROJECT_DIR（契约注入）> process.cwd() 回退
   │                                  ├─ 读 ~/.zcode/v2/config.json（apiKey + 模型清单过滤 + 默认模型标记）
   │                                  ├─ agent-md-resolver.list(projectDir)（四根 .md 发现）
   │                                  └─ workflow-script.listScripts(projectDir) + 内置五名
   │                                  ▼
   │                            lib/hook-inject.js 渲染（预算 ≤45 行，超限截断）
   │                                  ▼
   │                       stdout: {"hookSpecificOutput":{"hookEventName":"SessionStart",
   │                                "additionalContext":"<zsw-resources …>…</zsw-resources>"}}
   ▼                                  │（任一步异常 → {} + exit 0，stderr 诊断）
[引擎把 additionalContext 注入会话上下文头部]
   ▼
[主 agent 读 <zsw-resources> 块 → 路由决策零工具调用]   ←—— G1/G2 落点
```

对比 §2 现状数据流：同一批数据源，新增的只有「渲染 + 注入」一段；pull 通道（`zsw models` 等）原样保留为权威源。

### 3.5 探针清单

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P-hook-contract | SessionStart hook + additionalContext 契约有效 | z-tool-finder 同款 hook 生产运行中，其块在本会话上下文可见；对照官方 hook 契约文档 | ✅ 已测 | — |
| P-nested-guard | 嵌套会话不注入 | driver.js:280 / runner-appserver.js:317 实读确认两条 spawn 路径都强制 `ZSW_NESTED=1`；实施后以 `ZSW_NESTED=1 node bin/zsw.js hook session-start` 断言**输出 `{}` 且 exit code 0**（只验输出不验 exit code 会漏掉 exit 1 违规形态——非零退出会在会话启动 raise error） | ✅ 代码实证 / ⛔ 实施期复跑 | 失败 → 修检查逻辑（单点，无方案性影响） |
| P-data-source | 三数据源无 daemon 可用且规模可控 | 本机直跑三个模块（实测命令：`node -e "require('./lib/agent-md-resolver')…list(cwd)"` 等）：5 可运行 provider / 7 模型 / 6 agents / 0 script，两层渲染约 15-20 行 | ✅ 已测 | — |
| P-cwd | hook 进程拿到 ZCODE_PROJECT_DIR，项目级根定位正确 | e2e：在含项目级 agent 的仓库开会话，断言注入块含该 agent 名；并 `ZCODE_PROJECT_DIR=… node bin/zsw.js hook session-start` 手跑对照 | ⛔ e2e 门 | 失败 → 项目级两根改为从 hook stdin 输入（若引擎提供 workspace 字段）或退化为仅用户级两根并标注 |
| P-resume-dup | resume 会话不产生重复注入块 | e2e：建会话 → resume → 在会话文件中计数 `<zsw-resources>` 出现次数 ≤ 1 | ⛔ e2e 门 | 失败 → matcher 收窄为 `startup\|compact`（resume 无块，G1 在 resume 场景放弃，可接受） |
| P-isolated-home | 隔离 HOME 子会话不触发本 hook | e2e：spawn 一个 zsub 任务，令其报告上下文是否含 `<zsw-resources>`；同时确认隔离 HOME 的插件配置不含 zsw | ⛔ e2e 门 | 失败 → D4 的 ZSW_NESTED 防线已兜底（双保险结构，单层失效无正确性影响） |
| P-cold-start | hook 不拖慢会话启动 | 实施后 `time node bin/zsw.js hook session-start` 三次取中位 < 500ms（契约确认 hook 内联执行，延迟直接计入会话启动） | ⛔ 实施期门 | 失败 → 减少扫描根（agents 段退化为仅项目级两根）或加 60s 结果缓存 |
| P-token-budget | 注入块 token 在预算内 | 实施后对渲染输出测 token 数 ≤ 700（45 行中文快照的保守上限） | ⛔ 实施期门 | 失败 → 收紧截断（agents 描述行降为仅 name） |

## 4. 验收（真实场景，非单测）

改动规模：中等偏大（新 hook + 新子命令 + SKILL.md 行为变更），用多场景验收。以下全部在真实 ZCode GUI 会话执行（插件 inline 注册，改后重启生效）。涉及与 `zsw models` 对照的场景，前置条件：先开一个启用插件的会话拉起 daemon（或以报错内清单作为对照权威源）。

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| S1 | 主 agent 零调用报清单 | 重启 ZCode 开新会话 → 问「现在哪些模型可跑？默认哪个？短名和全名怎么用？」 | agent 不调任何工具，答出：① 默认 provider 的**模型名单与默认标记**与 `zsw models`（另开终端跑）一致（字段粒度不做要求——`zsw models` 返回结构化条目，注入块只渲染名单+标记）；② 其余可运行 provider 以全名形态列出；③ 短名/全名使用规则与 resolve 语义一致（短名=默认 provider，跨 provider=全名） | G1 |
| S2 | 路由决策一步到位 | 新会话让 agent 派发两个 zsub（一重一轻，见 §3.1 例） | agent 直接按块内引用构造参数（重 → 显式 `--model GLM-5.3`；轻 → 不传跟随默认 Flash），全程未跑 `zsw models`；两任务受理成功 | G2 |
| S3 | 快照过期自愈（负面场景） | 会话中途 GUI 停用一个 provider → 让 agent 用该 provider 模型派发 | 收到既有可操作报错（含可用清单）→ agent 换模型重传成功；无卡死、无静默失败 | G3 |
| S4 | 嵌套会话不污染 | S2 的重任务 task 书里加「报告你上下文是否有 zsw-resources 块」 | 子代理回答没有；主会话块仍存在 | G4 |
| S5 | hook 故障降级 | 关闭其他 zcode 会话 → `chmod 000 ~/.zcode/v2/config.json` → 立即手跑 `node bin/zsw.js hook session-start` 验证输出 `{}` exit 0 → `chmod 644` 恢复 → 重启 ZCode 开新会话 | 手跑降级正确；恢复后会话正常启动无报错弹窗、上下文有块；全程窗口 < 1 分钟 | G4 |
| S6 | resume/compact 行为 | ① resume 一个已注入会话 ② 触发 compact | ① 块出现次数 ≤1（对应 P-resume-dup）② compact 后上下文出现**新快照**（时间戳更新） | G1/G4 |
| S7 | 发版完整性 | `node scripts/check-pack.js` + `check-sync.js` + 装正式版验证 | hooks/ 在 npm 包内；三处版本一致；marketplace 安装版 hook 同样生效 | 发版规范 |

单元测试（hook-inject 纯函数：预算截断、apiKey 过滤、嵌套守卫、异常降级）作为回归辅助纳入 CI，不计入验收。

依赖说明：S1-S6 依赖真实 GUI 与真实插件加载，无法 mock（引擎 hook 触发链是验证对象本身）；token 消耗注意——S2/S4 涉及真实 spawn，用最小任务书。

## 5. 下一层拆分

实施路径：一个 minor 版本内串行交付，每单元可独立验证。

| 单元 | 内容 | justification | 验收挂钩 |
|---|---|---|---|
| U1 | `lib/hook-inject.js`：纯函数 `renderResourcesBlock({v2config, cliConfig, agents, scripts, projectDir})` → 文本；两层 models 展示 / 预算截断 / apiKey 过滤全在此 | 纯函数先行，单测覆盖截断与过滤口径，与 IO 解耦 | 单测 + P-token-budget |
| U2 | `bin/zsw.js` 新增 `hook session-start` 子命令：嵌套守卫（**独立于 `ensureNotNested()`——不得复用其 exit 1 路径，非零退出会在会话启动时 raise error，违反 D5；hook 守卫行为 = stdout `{}` + exit 0）→ projectDir 解析（`ZCODE_PROJECT_DIR` > `process.cwd()`，同 bin/zsw.js:366、596 既有惯例）→ 读三源 → U1 渲染 → 严格 JSON 输出；异常降级 | CLI 是既有唯一入口，z-tool-finder 先例同构（`tf.js hook session-start`）；cwd 契约缺口在此闭合 | P-cold-start、P-cwd、S5 |
| U3 | `hooks/hooks.json`（SessionStart 注册）+ package.json `files` 加 `"hooks/"` | hooks/hooks.json 是唯一注册面（官方契约：文件与 manifest 字段二选一；z-tool-finder 先例即仅文件、plugin.json 无 hooks 字段）；files 白名单缺失会被 check-pack 拦截 | S1、S7 |
| U4 | SKILL.md（zsub-zflow-orchestration）路由纪律更新：快照优先 + 默认档位不假设 + 兜底路径（含 daemon 前置说明）；顺手对齐 model-router.js:218 源码注释的「默认标记：重量任务省略 model 即用它」旧假设（与 skill 失真同源，改动一行注释，随本单元走） | D7：不改则 skill 与注入块打架且「重量不传 model」失真假设留存，G2 落空 | S2 |
| U5 | README 验收手册补 S1-S6 场景 + e2e 测试脚本化（S4/S6 可脚本化部分） | 验收可回归，防引擎升级漂移 | S4、S6 |
| U6 | `node scripts/release.js z-subagent-workflow minor` + 合入 main 流程 | 新增 hook + 子命令 = 能力扩展，minor | S7 |

**待验证检查点**（设计阶段无法确定，诚实标注）：P-cwd（`ZCODE_PROJECT_DIR` 在 hook 进程的实际注入值）、P-resume-dup（引擎 resume 是否重放注入块）、P-isolated-home（隔离 HOME 会话的 hook 触发事实）——三者均已有降级路径，不阻塞动工。

## 附录：与 pi 的机制对照

| 维度 | pi subagent-workflow | 本设计 | 差异性质 |
|---|---|---|---|
| 注入时机 | `before_agent_start` 事件（进程内） | SessionStart hook（子进程，stdout JSON） | 平台能力差异，语义等价 |
| 注入范围 | 每个 agent 会话（含子代理） | 仅主会话（嵌套守卫挡掉） | 有意偏差（D4） |
| 标签形态 | 三个独立标签 | 单块三段 | 平台差异（多 hook 拼接顺序无契约） |
| 数据新鲜度 | 事件触发时读 | 会话启动时快照 + CLI 兜底 | pi 略新鲜；zcode 会话生命周期内快照 |

（变更历史：v1 初稿 2026-08-29；v2 同日——第一轮对抗审查后修复：默认模型档位示例反转（must-fix）、hook cwd 来源以 ZCODE_PROJECT_DIR 闭合（must-fix）、models 段两层展示与一致性口径对齐（must-fix）、验收 S1/S5 前置与故障注入窗口收窄、注册面收敛两件套、规模数字修正为实测值（5 可运行 provider / 7 模型）。v3 同日——第二轮对抗审查后修复：G4 改写为可实现表述并如实声明「装了插件未用 zsw 的会话也付 token」代价（must-fix）、S1 一致性比对粒度定义为名单+默认标记、U2 警示嵌套守卫不得复用 ensureNotNested 的 exit 1 路径、D3 截断序措辞澄清与默认段 apiKey 口径补充、D6 补引仓内 ZCODE_PROJECT_DIR 生产惯例（bin/zsw.js:366、596）、U4 纳入 model-router.js:218 同源失真注释对齐。v3.1 同日——第三轮验证审查（must-fix 清零）后修完 3 suggestion + 1 info：G1 一致性措辞对齐 D3/S1 口径、P-nested-guard 补 exit code 0 断言、D3 截断标注按被截段指向对应查询命令（zsw agents / zsw workflow --action scripts）、D6 证据措辞降为「生产代码依赖 + 契约承诺，注入事实由 P-cwd 闭环」。三轮累计：must-fix 3+1+0，全部闭环。）
