# z-tool-finder 插件设计：MCP 工具渐进式加载（wrapper 接管 + hook 自动化）

> **一句话结论**：为 zcode 新增 `z-tool-finder` 插件——通过「per-server 中间人 wrapper + SessionStart hook 自动接管 + additionalContext 清单注入」把已注册 MCP server 的工具从全量常驻上下文改为「名字+when-to-use 清单常驻、详情与调用按需代理」，不改任何 MCP server 的源码，一键可还原。

## 开篇（SCQA）

- **S（情境）**：zcode 桌面端通过 `.mcp.json` / config.json 静态注册 MCP server，会话启动即连接并 `tools/list`，把全部工具定义（description + inputSchema）注入模型上下文。
- **C（冲突）**：本机仅官方插件就常驻 37 个 MCP 工具定义（zcode-cua 31 个），每个含完整参数 schema，占约 1 万+ token；zcode 无进程内 API、无 defer_loading、hook 无工具列表拦截点，用户无法压缩这块开销。
- **Q（问题）**：如何在不改 MCP server 源码、尽量零人工配置的前提下，让 zcode 已注册的 MCP 工具变成 skill 式渐进加载？
- **A（答案）**：插件提供 wrapper 进程替换每个 server 条目的 command（对 zcode 只暴露 get_tool_details / call_tool 两个 meta 工具），SessionStart hook 自动检测并重写配置、把工具清单经 additionalContext 注入对话；底层真实 server 懒启动、调用转发，CLI 一键还原。

> 层声明：本设计的下一层产物是**可实现的接口/数据模型/技术方案**（准则 5/6/7 全适用）。调研依据见对话沉淀的三份材料：市面方案调研（Anthropic TST / KGT24k mcp-tool-search 等）、pi Dynamic Tool Loading（`~/GitApp/pi-ecosystem/pi-mono/packages/coding-agent/docs/extensions.md:2233`）、zcode 能力对标（本仓 `docs/research/zcode-vs-pi-extension-capabilities.md`）。

## 1. 背景：被设计的系统是什么

**本章结论**：zcode 插件是「声明式资源 + MCP 外挂进程」形态；本设计聚焦其中的 MCP 消费链路，用外挂形态重建渐进式披露。

zcode 是类 Claude Code 的桌面 coding agent。插件（本仓 `z-subagent-workflow` 即范例）由 `.zcode-plugin/plugin.json` manifest + 根 `.mcp.json`（MCP server 注册）+ `hooks/hooks.json`（7 事件 shell hook）+ `skills/` + `bin/`（CLI）组成，程序化能力只能走 MCP server（stdio 外挂进程）或 hooks。MCP server 的消费链路完全由 zcode 引擎控制：启动时扫描配置 → 连接 → `tools/list` → 全量工具定义进模型上下文 → 模型直接调用 `mcp__<server>__<tool>`。**外部插件无法介入「哪些工具定义进上下文」这一步**——这是本设计所有取舍的根源。

读者假设：会用 zcode、装过插件、了解 MCP 基本概念（stdio server、tools/list、tools/call），但不了解 zcode 插件内部机制。

## 2. 设计目标

**本章结论**：五个目标，从使用者体验倒推。

1. **G1 token 压缩**：MCP 工具区常驻开销从「全部工具完整定义」降为「每工具一行 when-to-use 清单」，目标降幅 ≥60%（对标 KGT24k 85-96%、Anthropic -85% 的下界留余量）。
2. **G2 低成本自动化**：安装插件 + **至多两次重启**后，用户级与插件自带的 stdio server 自动变为动态加载，无需逐个配置；workspace 级 server 仅支持显式接管（团队共享文件，见 D5）。
3. **G3 可逆**：一条命令（或卸载插件后的独立还原入口）恢复所有 server 到接管前原状，原工具名（`mcp__server__tool`）重新可用；并发会话下同样可还原。
4. **G4 治理迁移而非退化**：per-server 粒度的 PreToolUse hook matcher 与命名空间**保留**；per-tool 粒度的引擎治理（如 matcher `mcp__computer-use__left_click`、`--disallowed-tools` 条目）接管后**必然失配**，由 wrapper 内置的 per-tool allow/deny 策略层承接（插件自执行，非引擎执行）；首次接管时向用户显式提示已有 per-tool 条目失配。
5. **G5 故障可见可恢复**：底层 server 起不来、参数校验失败、catalog 过期等错误均返回可操作信息（含恢复命令），不静默吞掉。

**In-scope**：用户级 config 与插件自带的 stdio MCP server 的自动接管；全局工具搜索；清单注入；接管/还原 CLI；错误规格。
**Out-of-scope**：SSE/HTTP 型 MCP server；workspace 级 server 的**自动**接管（团队共享文件，见决策 D5，仅支持显式接管）；embedding 语义检索（零依赖红线，首版关键词+BM25）；对 zcode 引擎行为的任何依赖性修改。

## 3. 现状：使用者眼里是什么样的

**本章结论**：现状是「装多少 MCP、吃多少 token」，用户没有任何调节手段。

### 3.1 现状的真实样子

以本机为例（2026-08-26 实测）：`~/.zcode/cli/config.json` 的 `mcp.servers` 为空，MCP server 全部来自官方 marketplace 插件的 `.mcp.json`（如 `~/.zcode/cli/plugins/cache/zcode-plugins-official/zcode-cua/0.5.10/.mcp.json`）。会话启动后，模型工具区出现 37 个 `mcp__computer-use__*`（31 个）、`mcp__node_repl__*`（3 个）等工具，每个含数百 token 的完整描述与参数 schema——即使用户本次任务只是改一行代码、一个 MCP 工具都不会用。

skill 已经是渐进式的（SKILL.md frontmatter 的 name+description 常驻，正文按需 read），MCP 工具没有对应机制。这就是「skill 的渐进式加载，一开始只注入 available-custom-tools 标签」要补的缺口。

### 3.2 怎么出错

- **失败模式 A（token 浪费）**：装 3-5 个带 MCP 的插件后，工具区常驻 1-3 万 token，挤占任务上下文、稀释注意力（RAG-MCP 论文 "Less (Choice) is More (Attention)"：工具过多降低选择准确率）。
- **失败模式 B（无处裁剪）**：zcode 的治理面只有 server 级开关与 `--disallowed-tools` denylist（CLI），无 per-tool 静态裁剪，无按需加载。
- **失败模式 C（卸载即全失）**：用户想省 token 只能禁用整个插件，连带失去 skills/commands。

### 3.3 根因

工具定义的注入发生在 zcode 引擎内部（连接后消费 tools/list 结果），外部可介入点——MCP server（只能决定自己暴露什么）、hooks（PreToolUse 只能放行/拦截调用、additionalContext 只能加内容）、AGENTS.md/skills（只能加文本）——没有任何一个能**减少**已注册 server 的工具注入。结论：只要 server 按原样注册，工具必然全量进上下文；**让原工具定义消失的唯一开关是注册配置本身**。因此方案必须动注册配置（重写 command），且必须做到机械、幂等、可还原。

## 4. 根因 + 物理数据流

**本章结论**：症状共同根因是「zcode 静态全量消费 MCP 注册」，方案在注册层插入中间人。

> **wrapper（中间人）** = 一个由本插件提供的 stdio MCP server 进程，替换原 server 条目的 command。它对 zcode 只暴露 meta 工具，背后 spawn 原 command 并转发真实调用。就是 §3.1 例子中 `mcp__computer-use__left_click` 变成 `mcp__computer-use__call_tool` 的那个替换层。
>
> **catalog** = 全部被接管 server 的工具元数据缓存（`~/.zcode/z-tool-finder/catalog.json`），含工具名、when-to-use、完整 schema，供清单注入与全局搜索使用，避免每次会话真实拉起 server。

当前数据流：

```
GUI 启动 → 扫描 config/插件 .mcp.json → spawn N 个 server 进程 → 各自 tools/list
        → 37 个工具定义全量注入模型上下文（常驻整个会话）
```

目标数据流：

```
磁盘：~/.zcode/z-tool-finder/{registry.json, catalog.json, launcher/, logs/}
     <插件根>/{dist/mcp/proxy.js, dist/mcp/server.js, bin/tf.js}

会话启动：
  zcode → spawn wrapper（每被接管 server 一个，command 已被 hook 重写）
       → wrapper 对 tools/list 只返回 get_tool_details / call_tool（底层真实 server 未启动）
  SessionStart hook → node bin/tf.js hook session-start
       → 读 registry+catalog 生成 <available-custom-tools> 清单 → stdout additionalContext 注入对话
任务中：
  模型按清单选中 mcp__<server>__get_tool_details("left_click")
       → catalog 命中 → 返回完整 description + inputSchema + 示例
  模型调 mcp__<server>__call_tool("left_click", {...})
       → wrapper 按 schema 校验 args → 首次调用懒启动底层原 command → 转发 tools/call → 返回结果
       → 底层空闲 5 分钟自动回收
```

## 5. 终态：使用者眼里将是什么样的

**本章结论**：用户装完插件重启两次后进入动态模式；agent 按「清单 → 详情 → 调用」三跳使用工具；出问题每一步都有恢复动作。

### 5.1 成功路径（真实交互样例）

安装（inline 开发形态，正式形态走 marketplace）：

```
1. 用户把 z-tool-finder 目录注册进 ~/.zcode/cli/config.json 的 plugins.dirs → 重启 ZCode（第 1 次）
2. 会话 1 打开：SessionStart hook 自动扫描，发现 3 个未接管 stdio server
   → 自动改写注册（细节见 D2/D5）+ 提示预扫描已在后台进行（catalog 就绪前 wrapper 走实时兜底）
   → 会话内注入提示：「z-tool-finder 已接管 3 个 MCP server（browser-use、zcode-cua、node-repl），
      重启 ZCode 后生效；还原运行 node <插件>/bin/tf.js restore --all。
      注意：你原有的 per-tool 级 hook matcher / --disallowed-tools 条目（如 mcp__x__y）将失配，
      per-tool 管控请改用 registry 策略（tf status 查看）」
3. 重启（第 2 次）。会话 2 起：wrapper 生效，工具区从 37 个工具变为
   3 server × 2 meta 工具 + 1 个全局 mcp__z-tool-finder__search_tools = 7 个
```

agent 使用（真实任务样例：用户要求「把这个 CSV 转成带图表的 xlsx」）：

```
模型看到（hook 注入的清单，常驻，约 600 token）：
<available-custom-tools>
以下 MCP 工具按需加载：先调对应 server 的 get_tool_details 获取完整用法，
再调 call_tool 执行。清单外需求可用 mcp__z-tool-finder__search_tools 检索。
- document-skills:xlsx — 读写 xlsx/xlsm/csv/tsv，电子表格为主输入输出的任务
- zcode-cua:zoom — 截图局部放大，目标过小时使用
- ...
</available-custom-tools>

模型：调 mcp__document-skills__get_tool_details(tool="create_spreadsheet")
  ← 返回：完整 description、inputSchema（sheet/data/styles…每参数含说明）、一个最小调用示例
模型：调 mcp__document-skills__call_tool(tool="create_spreadsheet",
        args={ path:"out.xlsx", sheets:[...] })
  ← wrapper 校验通过 → 懒启动 @zhushanwen/... 原命令 → 转发 → 返回「已创建 out.xlsx」
```

### 5.2 失败路径（带恢复指引）

| 失败 | 表现 | 恢复动作（错误信息中直接给出） |
|---|---|---|
| 底层 server 启动失败 | call_tool 返回：`failed to start underlying server: <原 command>，stderr 摘要：…` | `node <插件>/bin/tf.js doctor <server>` 诊断；`…restore <server>` 单个还原该 server |
| 参数校验失败 | call_tool 返回：`args.sheets[0].name: expected string, got number（schema: …）` | 提示重新查看 get_tool_details 对应参数段 |
| catalog 过期（server 新增了工具） | get_tool_details 返回未命中 | wrapper 自动实时 tools/list 兜底并回写 catalog，同时提示 `tf catalog refresh` 可主动全量刷新 |
| 插件升级后 wrapper 路径失效 | zcode 连接该 server 失败 | stable launcher（见 D4）自动解析最新版本目录；launcher 自身不可用时 `node ~/.zcode/z-tool-finder/launcher/restore.js --all` 还原全部 |
| hook 超时 | 清单未注入，会话照常 | 清单生成只读本地 catalog（毫秒级）；超时属异常，`tf doctor` 输出日志路径 |
| 嵌套无头会话（zsub spawn） | hook 检测 `TF_NESTED`/`ZSW_NESTED` env 标记 → 跳过注入与自动接管 | 无需恢复——设计行为：子会话不重复注入，wrapper 照常服务调用 |

## 6. 关键决策与权衡

**本章结论**：7 个决策，共同把现状变成终态；三个 P0 探针是方案成立的实施期门。

### 6.1 D1：wrapper 中间人接管（选定） vs registry 聚合迁移 vs 等官方能力

- **采用**：per-server wrapper——每个被接管 server 条目的 command 重写为 `node ~/.zcode/z-tool-finder/launcher/proxy-launcher.js <server-id> -- <原 command> <原 args…>`，原定义同时完整存入 registry.json。插件另有一个自己的主 server（`mcp__z-tool-finder__search_tools` 全局检索 catalog）。
- **被否 1（registry 聚合迁移）**：把 server 定义复制进 registry、原条目禁用、统一由单进程 tool-finder spawn。劣势：server 命名空间坍缩成单一 `z-tool-finder`，连 per-server 的 PreToolUse matcher（如 `mcp__browser-use__.*`）也失效，per-server 治理一并丢失（方案 A 保留 per-server，per-tool 治理两种方案下都需迁移到插件策略层，见 G4 改述）；且失去 zcode 原生 per-server 连接状态可见性。
- **被否 2（等 zcode 官方 defer_loading / 环境级劫持如 NODE_OPTIONS preload）**：官方无时间表；环境劫持覆盖不全（仅 node 系 command）、影响面失控，属于三个月后会被骂的短期方案。
- **证据**：市面调研（对话沉淀）——KGT24k/mcp-tool-search 是 registry 形态的同构先例但无 zcode 的 per-server 治理约束；Anthropic TST 证明「清单常驻+详情按需」配方有效（-85% token、选择准确率反升）。
- **效果**：G1/G2/G4 成立的架构基础。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. wrapper 接管 | 高：server 身份/matcher 保留，接管对称可还原 | 中：每 server 常驻一个 wrapper 进程，失去懒启动收益 | 插件 server 需覆盖条目（探针 P2） | ✅ |
| B. registry 聚合 | 中：单进程+懒启动优雅，但治理坍缩 | 中 | 改动面更大（禁用+迁移+回滚三态） | ❌ |
| C. 静态裁剪 | 低：不解决「按需」 | 低 | token 收益有限 | ❌ |

**被否若用（B）**：§5.1 中 agent 调用变为 `mcp__z-tool-finder__call_tool(server="document-skills", tool=…)`——多一层寻址尚可接受，但用户现有的 `PreToolUse` matcher（按 `mcp__browser-use__` 匹配审批）全部失效，AGENTS.md 中的工具名也彻底不可追溯。

### 6.2 D2：注入通道 = SessionStart hook 的 additionalContext

- **采用**：插件自带 `hooks/hooks.json`，SessionStart 事件（matcher 覆盖 `startup|resume|clear|compact` 四来源）执行 `node ${ZCODE_PLUGIN_ROOT}/bin/tf.js hook session-start`，stdout 输出 `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<available-custom-tools>…"}}`。compact 后清单凭 compact 来源重注入。
- **被否**：插件 AGENTS.md（zcode 插件无此通道）；UserPromptSubmit 每条注入（token 重复）；skill 描述承载（容量有限且不结构化）。
- **证据**：官方 superpowers 5.1.0 `hooks/session-start` 即此形态的活先例（`~/.zcode/cli/plugins/cache/zcode-plugins-official/superpowers/5.1.0/hooks/session-start:49-51`，嵌套格式对 Claude Code/zcode 兼容）；diagnosing-hooks/SKILL.md:36 确认 additionalContext 注入契约。
- **效果**：G1 的「清单常驻」半边；G2 的自动化触发点（同一 hook 顺带执行自动接管）。
- 探针：~~⛔ P0-1~~ **✅ 已通过（M0，2026-08-26，无头真实会话实证）**——嵌套格式生效，无需顶层字段降级。

### 6.3 D3：meta 工具面（每 wrapper 2 个 + 全局 1 个）

- **采用**：wrapper 暴露 `get_tool_details(tool)` 与 `call_tool(tool, args)`（名称与 schema 全局统一，靠 server 命名空间区分归属）；主 server 暴露 `search_tools(query, limit?)`（关键词+BM25，读 catalog）。`call_tool` 按底层 inputSchema 校验 args，**并按 registry 的 per-tool allow/deny 策略（`policies` 字段）先于转发校验**——承接 G4 中从引擎迁移过来的 per-tool 治理。
- **被否**：每 wrapper 再加 list_tools（hook 清单已覆盖，省工具面）；`search_tools` 也下沉到每 wrapper（跨 server 搜索无法实现）。
- **证据**：KGT24k 四工具面（search/get_schema/call/list_servers）的实证裁剪；Anthropic「搜索结果 = 完整可执行信息」原则 → get_tool_details 必须含每参数说明 + 最小示例，使模型一次填对参数。
- **效果**：G1 按需半边；G5 的校验失败可操作报错。

### 6.4 D4：stable launcher 隔离版本路径

- **采用**：接管条目的 command 指向 `~/.zcode/z-tool-finder/launcher/proxy-launcher.js`（数据目录下的稳定路径），launcher 内部按以下优先级解析插件本体：inline `plugins.dirs` 中已启用的 `z-tool-finder@inline` 目录 > marketplace cache 中**最高版本**目录（多版本共存时）。hook 每次运行时自检并刷新 launcher 副本；launcher 目录同时放独立 `restore.js`。**插件卸载/本体不存在时**：launcher 不再尝试转发，对 zcode 的连接直接失败并在 stderr 给出「插件已卸载，运行 `node ~/.zcode/z-tool-finder/launcher/restore.js --all` 还原全部接管」（cache 中可能残留旧版本，故意不回退使用——避免僵尸版本静默续跑）。
- **被否**：直接物化插件版本绝对路径进接管条目（插件升级即全量失效）；运行时自愈重写（时序不可控）。
- **证据**：marketplace 副本机制（本仓 AGENTS.md 架构边界 2：cache/<marketplace>/<plugin>/<version>/）。
- **效果**：G3——插件卸载/升级后接管条目仍可运行或可还原（restore.js 不依赖插件存在）。

### 6.5 D5：自动接管的边界（user 级与插件 server 自动；workspace 级仅显式）

- **采用**：hook 自动接管两类——① 用户级 `~/.zcode/cli/config.json` 的 server：原位改写 command；② 插件自带 server：**不动 cache 副本**（更新会覆盖、且有完整性标记），改为在用户 config 写同名覆盖条目（user > 插件的覆盖顺序）。workspace 级 server 与一切 SSE/HTTP 类型：不自动接管，仅 `tf takeover <server>` 显式支持。排除清单（registry `excluded`）+ 高频直通白名单（`pinned`，默认空）可配置。
- **被否**：全自动接管 workspace server——`<repo>/.zcode/config.json` 是版本管理文件，自动改写会污染团队仓库的 PR。
- **证据**：zcode-configuration-guide「MCP: merge」的覆盖顺序；marketplace 副本 + seed 完整性标记机制。**探针实证（2026-08-26，`test/probes/PROBE-RESULTS.md`）**：覆盖 key 必须用全命名空间 `plugin:<plugin>:<server>`（裸名无效）；`enabled:false` 禁用原注册有效；`enabled:true` + 替换 command 的接管形态下工具变为 meta 工具且 server 命名空间保持原名（`mcp__plugin_<plugin>_<server>__<tool>`）。
- **效果**：G2（用户感知的「所有 MCP」即用户级+插件级）且不引入团队协作副作用。
- 探针：~~⛔ P0-2~~ **✅ 已通过（M0，2026-08-26）**——覆盖机制成立，无需降级路径。

#### 6.5.1 接管覆盖面与不可接管项（2026-08-26 GUI 首验实证）

首次 GUI 验收暴露两个扫描缺口与一组不可接管边界，均已实证定位：

**已修缺口**：

1. `enabledPlugins` 真实形态是对象 `{ "name@marketplace": true }`（zcode 实写），代码按数组
   `for...of` 遍历导致 hook 每次启动即崩（`TypeError: enabled is not iterable`），接管数恒为 0。
2. 插件 server 有**两种定义位置**：根 `.mcp.json` 与 `.zcode-plugin/plugin.json` 的 `mcpServers`
   字段（zcode-cua 的 computer-use 只有后者）。扫描层双读（manifest 优先覆盖同名）。
   官方 skill（diagnosing-mcp）为权威依据。（扫描层可见 ≠ 可接管——zcode-cua 随后在下述
   硬边界中被排除，但其他 manifest 形态插件可正常接管。）
3. 官方 marketplace 插件**默认启用但不写 enabledPlugins**（引擎 `defaultEnabled` 硬编码在
   zcode.cjs，实证：zcode-cua/browser-use/document-skills/skill-creator/zcode-guide 默认启用，
   android-emulator/ios-simulator/superpowers/restore-legacy-sessions 默认不启用）。磁盘上唯一
   可读的「引擎实际加载过」信号是 `~/.zcode/cli/plugins/data/<name>@<marketplace>/` 目录存在。
   取误报（已停用插件的残留 data 目录导致多接管）不取漏报。
4. 插件 server 的 `${ZCODE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_ROOT}` 模板只在 zcode 插件层展开，
   wrapper 条目位于 user config 层（官方规则：配置文件不展开模板）——接管时展开为插件根
   绝对路径；插件升级/定义漂移由 applyTakeover 的 taken 刷新逻辑重写（对比期望 wrapper 与
   config 现值）。`${CLAUDE_PROJECT_DIR}` 等会话级变量无上下文，保留字面量（用到它的
   android-emulator 默认不启用）。wrapper 同时透传 `timeoutMs`/`cwd`（computer-use 90s）。
5. user config 中已是 wrapper 形态的条目再次扫描会递归包裹——扫描层按形态识别跳过
   （`args = [proxy-launcher.js, key, '--', ...]`），其原始定义只存在于 registry.original。

**不可接管项（引擎内置/运行时注入，记录边界不追）**：

- `node_repl`（zcode.cjs 硬编码，browser-use 的 hostMcpServerNames）、`web_reader`、`4_5v_mcp`
  等由引擎按模型套餐运行时注入，不落任何配置文件——无配置条目可改写，天然无法接管。
- **zcode-cua（computer-use）**：server 定义在 plugin.json manifest `mcpServers`，但其完整启动
  依赖引擎运行时注入的 `--permission-broker-socket`（GUI 动态生成，引擎
  `injectZCodeCuaBrokerMcpServers` 机制 + `resolveTrustedOfficialCuaServerNames` 特权白名单）。
  静态 wrapper 快照启动直接报 `plugin launcher requires --permission-broker-socket`
  （2026-08-26 实证）——代码级硬边界排除（`ENGINE_INJECTED_PLUGINS`），status 可见。
- 期望接管对象中 http 型插件 server（如 document-skills image_search，`${ZCODE_BASE_URL}`
  远端）按 D5 排除（仅 stdio）。

**对接管收益的影响（本机实证）**：本机活跃 server 中引擎内置（node_repl/web_reader/4_5v_mcp）、
特权注入（computer-use）、http 型（image_search）占绝大多数，可接管对象实际仅剩 zsw（其
1.1.0 工具面本就 offline、0 工具）——**本机 token 压缩收益趋近于零**。ztf 的价值场景是
「用户自配多个 stdio MCP server」的环境；A2 验收若以本机为样本无法达标，需在有多 server
环境重测或调整验收口径。

**未覆盖扫描源（低优先 TODO）**：workspace 级 `zcode.json` 变体、仓库根到 cwd 的逐级目录
读取、user 级 fallback `~/.agents/mcp.json`（仅当 cli/config.json 无 server 时生效，接管后
user config 必有 wrapper 条目，fallback 自动失效，无实际影响）。

#### 6.5.2 卸载/禁用无引擎钩子——restore 是唯一还原路径（2026-08-26 zcode.cjs 源码定论）

「能否在插件卸载/禁用时自动还原接管」的引擎源码级排查结论（引擎 bundle
`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`，12.5MB，2026-08-23 构建）：

- **hook 事件全集恰好 7 个**：`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PermissionRequest`/
  `PostToolUse`/`PostToolUseFailure`/`Stop`。`"SessionStart"` 在 bundle 中全部 6 处出现均为
  zod 枚举、运行时常量表或 hooks.json 解析白名单（无分发点形态）；全文 grep
  `PluginUninstall`/`PluginDisable`/`SessionEnd`/`Shutdown` 等零命中。hook runner 按
  `event === hookEventName` 过滤执行，机制上不存在第八种事件的入口。
- **卸载路径是纯文件操作**：CLI 确认框 → `uninstallZCodeMarketplacePlugin`（引擎注记名）→
  底层删除函数（splice installed.json 条目 + `rm -rf` 安装目录与 cache 目录，`removeCache`
  默认 true）+ 从 config 的 `plugins.enabledPlugins`/`plugins.options` 移除条目。全程零 hook
  触发、零插件代码执行，且**不写 `mcp.servers`**——接管条目卸载后必然残留。禁用路径
  （`setZCodePluginEnabled`）同样只写 enabledPlugins 一个布尔值。
- **inline 形态连卸载链都不经过**：inline 插件不在 installed.json（卸载函数查不到直接返回
  null），「卸载」= 从 config `plugins.dirs` 删路径，同样无任何触发点。
- **设计推论**：自动还原在引擎机制上不可能——hook 由插件注册，插件移除后 hook 亦不再
  执行（鸡生蛋）。唯一还原路径是手动 restore：插件在装时 `tf restore --all`；插件已卸载时
  数据目录 `launcher/restore.js --all`（零依赖单文件，为此场景设计）。卸载默认删 cache 目录
  使 proxy-launcher 四级插件解析全部落空，走「插件本体不存在 → exit 1 + stderr 打印 restore
  指引」降级（D4）——该兜底覆盖的是卸载流程真实会制造的场景。用户文档须写明操作顺序：
  **先 restore 再禁用/卸载**。

### 6.6 D6：检索 = 自实现关键词 + BM25

- **采用**：对 catalog 内 `server:tool + when-to-use + description` 建 BM25 索引（内存，规模 <1k 工具毫秒级）。
- **被否**：embedding 检索（零依赖红线：插件 package.json 禁 dependencies，本仓 check-sync 强制）；引入本地二进制。
- **证据**：仓库规范（AGENTS.md 开发红线）；pi 官方示例同样以 keyword 为起点；Stacklok 数据表明混合检索更优但属后续增强。
- **效果**：清单外模糊查找兜底，不破红线。

### 6.7 D7：when-to-use 元数据 + 嵌套防护 + 日志

- **采用**：when-to-use 默认取工具 description 首句，registry 支持 per-server / per-tool 覆写（对齐 skill frontmatter description 的语义）；嵌套标记 `TF_NESTED`（及识别 `ZSW_NESTED`）下 hook 跳过注入与自动接管，wrapper 照常工作；日志按本仓 logging-conventions 落 `~/.zcode/z-tool-finder/logs/`，stdout 严格保留给 JSON-RPC。
- **被否**：让用户手写全部 when-to-use（G2 零感破坏）；清单注入进嵌套子会话（与 zsub 提示词冲突风险）。
- **效果**：G2 体验完整；符合仓库红线（嵌套防护、日志纪律）。

## 7. 实现机制（把终态落到代码层）

**本章结论**：三层组件——接管层（hook + CLI + registry）、代理层（launcher + proxy）、目录层（主 server + catalog）。

```
z-tool-finder/
├── .zcode-plugin/plugin.json        # name: z-tool-finder, version 0.1.0
├── .mcp.json                        # 注册主 server（search_tools），stdio，${ZCODE_PLUGIN_ROOT}
├── hooks/hooks.json                 # SessionStart → node bin/tf.js hook session-start（process 型）
├── bin/tf.js                        # CLI: status/takeover/restore/catalog/doctor/hook 七个子命令
├── lib/
│   ├── registry.js                  # 接管状态机：扫描(config-io)→改写→记录（幂等）
│   ├── config-io.js                 # user config 读写（原子写：tmp+rename）、插件 .mcp.json 只读扫描
│   ├── catalog.js                   # 预扫描（临时 spawn→tools/list→落盘）、读取、回写
│   ├── mcp-client.js                # 极简 stdio MCP client（initialize/tools-list/tools-call）
│   ├── bm25.js                      # 检索
│   ├── inject.js                    # 清单渲染（截断策略：全部列出，>300 工具时按 server 折叠）
│   └── takeover.js                  # wrapper 条目构造 + launcher 刷新
├── dist/mcp/server.js               # 主 MCP server（search_tools）
├── dist/mcp/proxy.js                # wrapper：meta 工具面 + 懒启动 + 校验 + 转发 + 5min 空闲回收
├── skills/ztf-usage/SKILL.md        # agent 侧使用指引兜底（带插件前缀避让遮蔽）
├── package.json                     # @zhushanwen/z-tool-finder，零 dependencies
└── test/                            # node --test：registry 幂等/catalog/校验/bm25 单测 + e2e 手册
```

数据契约（关键文件 schema）：

```jsonc
// ~/.zcode/z-tool-finder/registry.json
{
  "servers": {
    "browser-use": {
      "scope": "plugin",                    // user | workspace | plugin
      "original": { "command": "node", "args": ["${ORIG}"], "env": {} },  // 接管前原样
      "wrapperEntry": { "command": "node", "args": ["~/.zcode/z-tool-finder/launcher/proxy-launcher.js", "browser-use", "--", "<original...>"] },
      "pinned": false, "excluded": false,
      "takenOverAt": "2026-08-26T12:00:00Z"
    }
  },
  "overrides": { "browser-use:xlsx_read": "读 Excel/CSV 数据文件时使用" },  // when-to-use 覆写
  "policies": { "browser-use:execute_js": "deny", "zcode-cua:*": "allow" }   // per-tool allow/deny（G4 承接）
}

// ~/.zcode/z-tool-finder/catalog.json
{ "servers": { "browser-use": { "fetchedAt": "...", "tools": [
    { "name": "open_page", "whenToUse": "打开并导航网页", "description": "...", "inputSchema": {...} }
] } } }
```

接管幂等状态机（hook 与 CLI 共用）：`扫描三源 → 对每个未接管且在自动范围内的 stdio server：写 wrapper 条目 + 原始定义入 registry →（首次）预扫描 catalog → 输出变更摘要`。restore 为逆操作：从 registry.original 恢复条目、删除覆盖条目、清理 registry 记录。

**并发防护（must）**：多个 zcode 窗口/并行会话可同时触发 SessionStart hook。接管与 restore 全路径持单实例锁——`~/.zcode/z-tool-finder/registry.lock` 以 `open(..., 'wx')` 创建，存在且 PID 存活则本次 hook 降级为「只读清单注入、跳过接管」（下个会话再接管），写锁超过 30s 视为 stale 强制接管。所有写操作遵循「持锁 → re-read → 记录级合并（按 server 名 merge，不整文件覆盖）→ 原子写」——tmp+rename 只防损坏，防 last-writer-wins 必须靠锁+re-read+合并。

**预扫描预算**：catalog 预扫描（spawn 真实 server + tools/list，冷启动可达数秒×N）**不在 hook 同步路径内**——hook 只触发后台预扫描（daemon 化，独立日志）并立即返回清单（catalog 未就绪的 server 在清单中临时省略）。catalog 为空/未命中时 wrapper 对 get_tool_details/call_tool 走实时 tools/list 兜底并回写，功能不缺失。

## 8. 验收（真实场景，非单测非 mock）

**本章结论**：6 个真实场景覆盖 G1-G5；三个 P0 探针先行，是方案成立的门。

### 8.1 改动规模

大改动（新插件、改变 MCP 消费行为）——多场景验收，且须在真实 GUI + 真实官方插件 server 上执行。

### 8.2 验收场景

前置探针（**已于 2026-08-26 全部执行并通过**，方法与四轮记录见 `test/probes/PROBE-RESULTS.md`）：
- **P0-1** ✅：嵌套 additionalContext 的 SessionStart hook 在真实无头 zcode 会话注入生效，模型能原样引用注入内容。
- **P0-2** ✅（带修正）：user config 用全命名空间 key `plugin:<plugin>:<server>` 写覆盖条目，`enabled:false` 成功禁用插件 server；`enabled:true` + 替换 command 的接管形态下工具变为 meta 工具且命名空间保持原名。
- **P0-3** ✅：tools/list 只返回 2 个 meta 工具的 server 正常连接注册，zcode 无最小工具数假设。

| 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| A1 安装自动接管（含并发） | G2 | inline 注册插件 → 重启 → 会话 1 收到接管提示 → 再重启；**另开第二个 zcode 窗口与首窗口同时启动会话（并发触发 hook）** | 会话 2 起被接管 server 只剩 2 个 meta 工具；清单注入可见；重复重启无重复接管动作；并发场景下 registry 与 config 一致、无「已改写但无记录」的孤儿条目、restore --all 可完整还原 |
| A2 token 压缩 | G1 | 以 zcode-cua（31 工具）+ browser-use 为对象，对比接管前「工具区完整定义」与接管后「meta 工具定义 + hook 注入清单合计」（两者均按 char/4 估算，两笔原始数据记录于验收记录） | 常驻开销合计缩减 ≥60% |
| A3 渐进完成真实任务 | G1、G5 | 真实会话让 agent 用被接管 server 完成「CSV 转 xlsx」类任务 | agent 按清单→get_tool_details→call_tool 三跳完成，无需人工提示流程 |
| A4 还原闭环 | G3 | `tf restore --all` → 重启；再在 GUI 中**真实卸载**插件后跑 `~/.zcode/z-tool-finder/launcher/restore.js --all` → 重启 | 原 `mcp__server__tool` 全部恢复可调；config 无残留 wrapper 条目；卸载后 launcher 给出还原指引而非静默失败 |
| A5 compact 韧性 | G2 | 会话中执行 compact | compact 后清单仍在（SessionStart:compact 重注入），agent 仍能按清单取用 |
| A6 故障恢复 | G5 | 手动改坏一个底层 server 的原始 command（registry.original 中改错路径）→ agent 调用 | call_tool 报错含 stderr 摘要 + `tf doctor`/`restore` 指引；restore 后恢复 |

单测（registry 幂等、schema 校验、bm25、config 原子写）照仓库规范另行编写，不替代上表。

## 9. 实施

**本章结论**：分 5 个阶段，探针先行，每阶段可独立验收。

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M0 | 三连探针 P0-1/2/3 | ~~消解方案最大不确定性，定降级路径~~ **已完成（2026-08-26，全部通过，`test/probes/`）** |
| M1 | 脚手架 + 主 server（search_tools）+ catalog 只读目录 + 清单注入 hook（手动 takeover 前，纯只读模式） | G1 的清单半边（不接管也可当目录用） |
| M2 | proxy wrapper + launcher + takeover/restore CLI（手动模式） | G1 全量 + G3 |
| M3 | hook 自动接管（user+插件级）+ 排除/直通配置 | G2 |
| M4 | 错误规格全套 + doctor + 嵌套防护 + 验收 A1-A6 执行 | G5 + 全目标实证 |
| M5 | 收尾：marketplace.json 登记、README、check-sync / check-pack 双绿、`node scripts/release.js z-tool-finder patch` 发版 | 仓库流程强制项（版本三处同步走 release.js，禁手工单改） |

## 10. 下一层拆分

| 单元 | 说明 | justification（为什么这么拆） |
|---|---|---|
| U1 lib/config-io + registry | 配置扫描/原子改写/接管状态机 | 接管正确性的核心，纯函数化易测（幂等性单测集中在此） |
| U2 lib/mcp-client + catalog | 极简 stdio client + 预扫描缓存 | 被 U3/U4/CLI 三方共用的最底层 |
| U3 dist/mcp/proxy.js | meta 工具面 + 校验 + 懒启动 + 回收 | 独立进程职责单一；可用假 server 单测转发逻辑 |
| U4 dist/mcp/server.js + bm25 | 主 server 搜索面 | 依赖 U2，接口小 |
| U5 hooks + inject + 自动接管 | hook 入口、清单渲染、接管编排 | G2 体验层，依赖 U1-U3 全部就绪 |
| U6 bin/tf.js CLI | status/takeover/restore/catalog/doctor/hook | 调试与 MCP 等价入口（zsub 模式：CLI 与 MCP 共享 lib） |
| U7 skills/ztf-usage + 文档 + test | 使用指引、README、单测/e2e 手册 | 仓库规范要求；验收 A3 需 agent 可自发现指引 |

## 11. 待验证检查点

1. ~~⛔ P0-1/2/3 三探针~~ **已全部通过（2026-08-26，见 `test/probes/PROBE-RESULTS.md`）**；P0-2 带修正结论：覆盖 key 必须为 `plugin:<plugin>:<server>` 全命名空间形态。设计文档 v1 的降级路径不再需要，保留探针脚本作为 zcode 升级漂移检测的复跑基线。
2. ~~zcode 对 hook 输出的消费格式是否同时接受顶层与嵌套 additionalContext~~ 已由 P0-1 定案：嵌套格式生效，hook 固定输出嵌套形态（顶层格式兼容性不再需要探测）。
3. 清单规模上限：>300 工具时的折叠策略（按 server 折叠为「server — when-to-use」一行）是否够用，实施期用构造数据验证。
4. 插件 server 覆盖条目在插件自身升级（新版本目录出现）后的行为：覆盖条目仍指向旧接管定义是否需要 hook 重新接管（M3 实测）。
5. marketplace 正式安装形态下 `${ZCODE_PLUGIN_ROOT}` 在 hook 中的展开与 inline 形态差异（local-dev-guide 冒烟流程覆盖）。

## 附录：变更历史

- v1（2026-08-26）：初版。调研依据：市面方案（Anthropic TST / KGT24k / Stacklok / pi Dynamic Tool Loading）、zcode 能力对标（本仓 docs/research/）、superpowers hook 先例。
- v2（2026-08-26）：按对抗式审查修订——G4 改述为「治理迁移」（披露 per-tool 引擎治理失配，由 wrapper policies 承接）；接管/restore 加单实例锁 + re-read + 记录级合并（并发 last-writer-wins 防护）；G2 改述「至多两次重启 + workspace 仅显式」；A2 口径闭环（清单计入常驻开销）；catalog 预扫描移出 hook 同步路径（后台化 + 实时兜底）；launcher 定版本解析优先级与卸载行为；A1 加并发变体、A4 加真实卸载变体；实施计划补 marketplace/check-sync/release.js 收尾阶段。
- v3（2026-08-26）：M0 三探针执行完毕全部通过，结果与脚本归档 `test/probes/`；D5 覆盖 key 修正为 `plugin:<plugin>:<server>` 全命名空间形态（裸名无效，run2 实证）。
