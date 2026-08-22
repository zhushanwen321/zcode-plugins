# zsub 设计文档对抗式审查报告

> 审查对象：`design/DESIGN.md`（zsub — zcode 平台 subagent 管理插件设计文档）
> 审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`（P0-18 / P1-10）
> 审查方法：平台事实逐条对 zcode.cjs（12.4MB）锚点核验 + CLI 安全实测 + pi 源码（`~/Code/xyz-agent-workspace/main/extensions/subagent-workflow/src/`）交叉核对 + 前序插件（dynamic-workflow）源码核对。只报告不修复。
> 审查日期：2026-08-23。zcode 二进制：/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs（mtime 2026-08-18，CLI 自报 0.16.3）。

## Summary

**3 must-fix, 7 suggestions, 3 info.**

总体判断：方案架构成立——10 条平台事实基线中 9 条经独立核验属实（含多个精确锚点命中与安全实测复现），24 项对照表抽核结论基本与 pi 源码相符，因果链（G1-G4 → §3 → A1-A9）整体闭环且验收为真实环境设计。**must-fix 集中在 D2 通知链路这一个机制上**：B6 事实部分失实（hook 契约错位）、mailbox 投递缺原子写规范（一个坏文件可永久砖死会话通知）、投递目标 sessionId 的多会话/时序语义未定义。三者都发生在「zsub 相对 pi 唯一无先例可抄的新机制」上，恰好印证了设计文档自己把通知列为第二高风险的判断。

## 平台事实基线核验记录（10/10 条，其中 9 条属实、1 条部分失实）

| # | 声明 | 核验方法 | 结论 |
|---|------|----------|------|
| B1 | `--json --cwd --mode --prompt` 无头单轮 | read dynamic-workflow/lib/driver.js `runHeadlessPhase`（spawn 形态完全一致，v0.2.0 生产代码） | ✅ 属实 |
| B2 | `--resume` 可用 | 实测 `HOME=/tmp/... node zcode.cjs --json --resume sess_doesnotexist123 --prompt hi` → 通过 flag 解析（死于 Model config missing 而非 Unknown option，证明 flag 被接受）；resume 语义采信文档实测记录 | ✅ 属实（flag 级实证） |
| B3 | `--disallowed-tools` 可用；`--max-turns`/`--allowed-tools`/`--settings` 拒收 | 三次隔离 HOME 安全实测：三者均输出 `Unknown option '--xxx'`（exit=1）；`--disallowed-tools Bash` 通过解析（报 Model config is missing，错误信息直接给出 `<HOME>/.zcode/cli/config.json` 路径）。help 确实列出这些 flag——漂移真实存在 | ✅ 属实（全部实测复现） |
| B4 | 模型由 `$HOME/.zcode/cli/config.json` 的 `model.main` 决定；HOME 可覆盖 | 实测错误信息原文 `Create /tmp/zsub-review-home/.zcode/cli/config.json with an explicit model provider`；driver.js `bootstrapIsolatedHome` 同款机制 | ✅ 属实 |
| B5 | Session Mailbox 全链路 | zcode.cjs 四锚点核验：① `parseEnvelope`（`$ti`）@11067925 **精确命中**——`version!==1` 或 messageId/fromSessionId/toSessionId/content/createdAt 任一非 string 即 throw；② drain 注册 @10358509 **精确命中**——`[UserPromptSubmit, PostToolUse, Stop]` 三事件、`source:"builtin.sessionMailbox.drain"`、单次 limit 20、注入格式 `<session-message source="mailbox" message_id=... from_session=...>`；③ env gate `dYr`（`ZCODE_MESSAGE_ENABLED==="1"\|\|"true"`）函数存在，实际位置 @11602483（文档写 11766820，漂移）；④ port 消费点 @11029217：`if(!t.sessionMailboxPort) return` 无 port 则不注册 drain。补充发现见 SUGGESTION-7 | ✅ 属实（+3 项文档未记录的补充事实） |
| B6 | hooks：`ZCODE_HOOK_PAYLOAD` env + stdin payload；PostToolUse 可注册；583 dump | zcode.cjs 全文 `ZCODE_HOOK_PAYLOAD` **0 次命中**；3.8.1 实际契约：payload 走 stdin 且字段为 **snake_case**（`session_id`/`hook_event_name`/`tool_name`/`tool_input`/`tool_response`/`tool_use_id`），env 只设 `ZCODE_SESSION_ID`/`CLAUDE_SESSION_ID`/`ZCODE_PROJECT_DIR`/`ZCODE_PLUGIN_*`；`transcript_path` 是临时文件（`zcode-claude-hook-*/transcript.jsonl`）**用后即删**。`~/.zcode/hooks/` 583 个 dump 逐一核对：**全部为 `SessionStart` 事件、全部来自 3.0.0 旧版**，无一 PostToolUse。PostToolUse 事件在 3.8.1 代码中存在（hook 事件枚举 @368446：SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop） | ⚠️ **部分失实**（见 MUST_FIX-1） |
| B7 | MCP client 无 sampling/createMessage | `sampling/createMessage` 全部 20 处命中均在捆绑 MCP SDK 的 zod schema/dispatch 区域（7.15M-7.48M），无应用层 handler 注册或能力声明（`clientInfo:{` 等 concrete 构造点均非 MCP capabilities）；elicitation 有 GUI IPC 层支持（`respond_elicitation` @456702），为表单交互非 LLM 注入 | ✅ 与主张一致（佐证级：schema 存在 ≠ 启用，未找到反例） |
| B8 | 原生后台 Bash `<task-notification>` | @776399 `run_in_background` schema **精确命中**（"Set to true to run this command in the background."）；@7699452 `enqueueBackgroundTaskNotification` + `t.name==="Bash"?{originMeta:{backgroundSource:"bash"...}}` **精确命中** | ✅ 属实 |
| B9 | agent .md frontmatter 字段 | `vct` 解析器 @10260805 **精确命中**：name/description 缺失各出诊断（必填）、model/thoughtLevel/color/permissionMode/maxTurns/memory/mcpServers 均解析 | ✅ 属实 |
| B10 | GUI host 未启用 ZCODE_MESSAGE_ENABLED | 实测 `launchctl getenv ZCODE_MESSAGE_ENABLED` → 空 | ✅ 属实 |

### pi 参考实现抽核（对照表支撑事实）

| pi 侧声明 | 证据 | 结论 |
|-----------|------|------|
| subagent tool 五 action | `interface/subagent-tool.ts:74` `StringEnum(["start","list","cancel","message","close"])` | ✅ 精确 |
| ConcurrencyPool 默认 6（D12） | `execution/config.ts:26` `maxConcurrent: 6` | ✅ 精确 |
| session-runner spawn 模式（D1 引 :650） | `execution/session-runner.ts` ~650 argv 构造 `["--mode","rpc","--session-dir",...]` | ✅ 属实 |
| fork 低频引文（D5） | `subagent-tool.ts:108` "most tasks a plain prompt can describe do NOT need fork" 逐字命中 | ✅ 精确 |
| record-store jsonl 重建模式（D11） | `record-store.ts` "内存只留 running record；终态从 session.jsonl 重建"、append-only | ✅ 属实 |
| message 可投 running（对照表 #16 弱化标注的前提） | `subagent-tool.ts:149` "any running subagent" | ✅ 标注准确 |
| 对照表 #15「mailbox 轮中注入优于 pi 的 turn 边界」 | `notifier.ts` 头注：`pi.sendMessage({deliverAs:"followUp",triggerTurn:true})`——「当前 **turn 结束后**唤醒父 agent」；mailbox 在 PostToolUse（轮中 tool 边界）即注入 | ✅ 判断成立（pi 无 idle 主动唤醒时 zsub 轮中注入确实更早；反向边界文档已如实声明） |
| 对照表 #3「sync start ✅ 完全」 | pi schema 无 `wait` 参数，tool description 明示 "Background only: returns a subagentId immediately"、"DO NOT sleep, busy-wait, or poll — there is no poll action" | ❌ 标注失实（见 SUGGESTION-8） |
| pi patchFile 教训 | `notifier.ts` [MF#1]：「done 时通知文本显式提示 git apply，否则隔离 worktree 的改动静默丢失」 | （转化为 SUGGESTION-6） |

### 前序插件抽核（dynamic-workflow）

| 声明 | 证据 | 结论 |
|------|------|------|
| driver.js 无头驱动 + 隔离 HOME | `lib/driver.js` 全文 | ✅ 属实 |
| 隔离 HOME 无 plugins 配置（D10 第二重门禁来源） | driver.js 注释「刻意只写 {model, provider}（会抹掉 plugins 块）」+ `env: {..., HOME: ISOLATED_HOME, DWF_NESTED: '1'}` | ✅ 属实（D10 双门禁描述成立） |
| timeoutMs 默认 600_000 + SIGTERM/5s SIGKILL（D9） | driver.js `runHeadlessPhase` | ✅ 属实 |
| jsonout 三级容错（D6） | `lib/jsonout.js`：整体 parse → ```json 围栏 → 首个平衡大括号段 | ✅ 属实 |
| pool「取 dynamic-workflow 已验证值 3」（D12） | `lib/pool.js` 注释「对标 pi 的 maxConcurrent 语义（默认 6；我们默认 3）」 | ✅ 属实 |
| **并发写 config.json 的生产先例** | `bootstrapIsolatedHome` 仅在 5 个 workflow 入口各调用一次（chain.js:63 等），pool 启动后不再写——**zsub 的 per-start 重写无生产先例** | ⚠️ 转化为 SUGGESTION-5 |

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §2.2 B6、§3.3 D2、§5 hooks/ | P0-11 关键事实 | **B6 机制描述与证据错位，D2 的 hook 环节建立在失实契约上**。(a) `ZCODE_HOOK_PAYLOAD` 在 3.8.1 二进制全文 0 次出现，583 个 dump（3.0.0 旧版）的 env 段里也没有——payload 实际只走 stdin；(b) 3.8.1 实际 payload 字段是 snake_case（`session_id`/`hook_event_name`/`tool_name`），`transcript_path` 是用后即删的临时文件；(c) 引用的 583 个 dump **全部是 SessionStart 事件**，无一 PostToolUse——「PostToolUse 可注册」在当前版本只有代码枚举存在性（@368446）支撑，无触发实证，更无「PostToolUse 对 MCP tool 调用触发」实证（而这正是 last-session.json 刷新的必要条件）。证据链：`node -e` 读 zcode.cjs 检索 `ZCODE_HOOK_PAYLOAD`（0 命中）、`~/.zcode/hooks/*.log` 583 文件 `grep hookEventName` 全为 SessionStart、@10339623 hook payload 构造函数读出 snake_case 契约 | B6 重写为 3.8.1 实测契约（stdin + `ZCODE_SESSION_ID` env）；hook 脚本按 stdin JSON 或 `$ZCODE_SESSION_ID` 取 sessionId；把「PostToolUse 在 3.8.1 GUI host 真实触发 + 对 MCP tool 调用触发 + matcher 语法」列入 DoR/M2 实施期门探针，与 mailbox drain 探测同批执行；dump 证据行改为注明版本与事件类型 |
| MUST_FIX | §3.3 D2、§3.4 ⑩ | P0-12 副作用 / P0-16 运行时断言 | **mailbox 投递未规定原子写；引擎侧一个坏文件会永久阻塞该会话的 drain**。实测引擎实现（zcode.cjs `NodeSessionMailboxAdapter.drainUnread`，@11067925 后类体）：逐文件先 `parseEnvelope` 再 rename 到 read/，任一文件非法即 throw 中断本轮 drain，坏文件留在 unread/ 且无 quarantine——按文件名字典序处理，排序在其后的所有消息**永远投不进去**（每轮 drain 重新撞同一个坏文件）。zsub 投递若直接 writeFileSync 终名，进程崩溃/磁盘满产生半截 JSON 即永久砖死 G3 主通道，且无任何报错可查（坏文件既不消费也不报错）。这是「mailbox 投递的文件格式校验失败行为」的直接答案：静默阻塞 | D2 补硬性规范：投递必须 tmp 文件 + `rename` 原子落位；envelope 六字段写前自检；M2 探测脚本加一个「故意投坏文件 → 观察引擎行为」用例固化已知语义；可选：server 启动时扫描 unread/ 中己方投递的非原子残留 |
| MUST_FIX | §3.3 D2、§3.4 ②⑩ | P0-12 边界场景 | **投递目标 sessionId 的时序与多会话语义未定义**。last-session.json 由 PostToolUse hook 刷新，而 hook 在 tool call **完成后**才触发——server 在 `subagent(start)` 调用进行中（步骤②）读到的是「上一次任意 tool 调用」刷新的值。单会话且有先前 tool 调用时恰好正确；但 (a) 会话首个 tool call 就是 start(bg) 时读到旧值/文件不存在，通知投错或丢失；(b) A/B 两个 zcode 窗口并发时（multi-workspace 是该用户明文工作习惯），B 窗口的任何 tool 活动都会覆盖 last-session，A 启动的后台任务完成通知投给 B。文档未讨论多会话场景，A3 验收也只覆盖单窗口 | 明确投递语义并写入 D2：如 hook 写「近期活跃会话表」（N 个 sessionId+时间戳）替代单值文件，投递给 start 时刻最近活跃会话（record 快照）或全部活跃会话；或显式声明「单会话假设 + 错投后果 + 检测手段」为已知边界；验收补多窗口场景（两个 GUI 会话，A start → B 活动 → 验证通知归属） |
| SUGGESTION | §1 G3、§4 A3/A4 | P0-10 因果链 | G3「结果**自动**出现在主会话上下文，无需人工提醒」的达成完全押在未验证的 GUI host drain（⛔ 门）上；降级 polling 后 G3 退化为「主 agent 按提示文本轮询 list」——满足的是「结果可获得」而非「自动触达」。pi 源码的 UX 哲学明确反轮询（"DO NOT sleep, busy-wait, or poll — there is no poll action"），zsub 降级模式与之相反且依赖 LLM 自觉。文档已在 A4 回溯「G3（边界）」并如实标注，处理诚实，但 G3 定义处没有分档，验收读者无法区分「主通道达成」与「降级达成」 | G3 定义处显式分档：主通道达成=mailbox 自动注入；降级达成=轮询可见（弱化为「结果可达」）；A3/A4 分别对档，避免验收歧义 |
| SUGGESTION | §3.3 D3 | P0-12 竞态 | per-model HOME 池在**同 model 并发 start** 时会并发重写 `home-<model>/.zcode/cli/config.json`（`writeFileSync` 非原子，torn write 可让 zcode 子进程启动失败）。生产先例核对：dynamic-workflow 的 `bootstrapIsolatedHome` 是每个 workflow 入口调用一次、pool 启动后不再写——**并发重写无先例**。D3 用 per-model 池解决了跨 model 互踩（文档已论证），但同 model 互踩未覆盖 | home-pool 写 config 用 tmp+rename 原子写 + per-model 串行化（mutex），或只在池目录首次创建/apiKey TTL 过期时刷新 |
| SUGGESTION | §3.3 D2、§4 A8 | P0-12 遗漏 | worktree 任务的完成通知文案未承诺携带 patchFile 路径。pi notifier 源码 [MF#1] 教训（逐字）：「done 时通知文本显式提示 `git apply`，否则 background 子 agent 在隔离 worktree 的改动会**静默丢失**——父 LLM 不知 patch 路径，无法应用」。zsub 的 record.patchFile 与 A8 只验证 patch 文件存在 + apply --check，通知文本（§3.1 样例只带 outputs 报告路径）未承诺 patch 路径，重蹈 pi 已踩过的坑 | D2 通知模板规定：worktree=true 的完成通知必须含 patchFile 路径与 apply 指引；A8 通过标准加「mailbox 通知文本含 patch 路径」断言 |
| SUGGESTION | §2.2 B5 | P0-11 补充事实 | 引擎侧两项文档未记录的行为：(a) mailbox 根目录可被 `ZCODE_MAILBOX_ROOT` env 覆盖（@11763070：`e.env.ZCODE_MAILBOX_ROOT ?? "~/.zcode/mailbox"`，`~` 经 `os.homedir()` 解析）——若 GUI host 环境设了该变量，zsub 直投 `~/.zcode/mailbox` 会静默失效（DoR 端到端探测天然能发现，但应知情）；(b) drain 只认 `.json` 后缀且按**文件名字典序**取前 20——`msg-<id>.json` 的 id 若为随机串，积压 >20 条时消费顺序乱序/后到消息饿死 | B5 补记 `ZCODE_MAILBOX_ROOT` 变量与排序语义；msg 文件名用单调前缀（时间戳+序号）保证字典序=时间序 |
| SUGGESTION | 附录、一句话结论、B5 | P1-8 细节事实（不阻塞） | 三处口径/标注误差：① 对照表 #3「sync start ✅ 完全」——pi 实为 background-only（无 wait 参数，明示 DO NOT wait / no poll action），zsub 的 wait=true 是**新增能力**而非复刻，标「完全」误导后来者对照；② 一句话结论「12 项完全复刻、7 项近似、5 项明确放弃」与附录统计「✅11 / 🟡7 / ❌4 / ➖2」口径不一致（12+7+5=24 vs 11+7+4+2=24，分法不同未说明）；③ dYr 锚点漂移：函数实际 @11602483，文档 @11766820 是 port 消费点（`sessionMailboxPort:fe`） | ① #3 改标「➕ zsub 增强」或注明「pi 无此能力」；② 统一两种统计口径或在结论处注明分档规则（如 #23 计入已完成的完全复刻）；③ 锚点改 @11602483 或标注「dYr 定义点」 |
| SUGGESTION | §4 A5/A1 | P1-10 负面行为验收 | 两个已设计的负面/边界行为无验收覆盖：① 「message 投给 running subagent 返回 busy」（§3.1 失败表第 4 行）无场景；② user 级 agent 根（`~/.agents/agents/`，G2 明文承诺「直接可用」）无验收——A1 只测项目级 `.agents/agents/` | A5 加 busy 分支断言（start(bg) 未完成时 message → 期望 busy 文本）；A1 扩 user 级根用例或新增 A1b |
| SUGGESTION | §5 hooks/、D2 | P0-12 性能/正确性（轻） | matcher `*` 使**每次** tool 调用 spawn 一个 hook 进程（~10-50ms，高频会话有感知）；并发 tool 调用下 last-session.json 并发写非原子（部分写入/交错，server 读到损坏 JSON）；B6 证据显示 hook 高频触发（583 dump/数周） | hook 脚本原子写（tmp+rename）+ 损坏时跳过；评估 matcher 收窄为高频只读工具子集（若 3.8.1 matcher 语法支持）；性能纳入 M2 冒烟观察项 |
| INFO | §4 A9 | P0-14 | 「ZSUB_NESTED 或插件未加载**二选一**；主流程不崩」通过标准里「二选一」不可判定——验收者无法区分两种拒绝来源也无须区分 | 改为「子进程 debug 日志含 zsub 拒绝记录（ZSUB_NESTED）或 zsub 工具不可见（插件未加载），任一成立即可，记录实际命中的是哪种」 |
| INFO | 全文 | P0-16 | 运行时断言探针标注规范执行得好（✅/⛔ 区分、⛔ 均有降级或门位），D2 的 GUI drain 门有 A4 降级 + DoR 前置，符合准则——本项通过；但 D2 依赖的 PostToolUse hook 机制本身缺探针（见 MUST_FIX-1，不重复计） | — |
| INFO | pi 源码（非本文档问题） | P1-8 | pi `subagent-tool.ts:63` 注释自称「13 字段」实际 schema 15 字段（task/slug/agent/model/thinkingLevel/skillPath/appendSystemPrompt/schema/maxTurns/graceTurns/fork/worktree/cwd/conversation/idleTimeoutMs）——pi 侧注释 stale。DESIGN.md 未引用该数字，不影响本设计 | 无需动作（记录备查） |

## 因果链专项判定：D2 mailbox → G3 是否单点依赖

结论：**是单点依赖，但已按 P0-16 要求配齐降级路径与前置探测，不构成准则违规；残余风险在 G3 语义分档与 hook 机制证据（见 MUST_FIX-1/SUGGESTION-4）**。

- **⑩→⑪ 的 HOME 一致性**：mailbox 根 = 引擎进程 `ZCODE_MAILBOX_ROOT ?? "~/.zcode/mailbox"`，`~` 经 `os.homedir()`（POSIX 取 `$HOME`）解析。MCP server 由 GUI host spawn、继承其真实 HOME，投递路径与 GUI host 读取路径默认一致。两个反例条件：用户设置了 `ZCODE_MAILBOX_ROOT`（SUGGESTION-7a，DoR 探测天然覆盖）；未来版本沙箱化 host（版本锁定风险，B 系列事实整体共享）。文档「逻辑等价」断言在代码层成立——mailbox port 全文件仅 4 处引用，创建点唯一（`y_t` 工厂内 dYr gate），无旁路注入点，无头与 GUI host 若启用 mailbox 必经同一 gate。
- **drain 条件**：UserPromptSubmit/PostToolUse/Stop 三时机（@10358509 实证），主 agent idle 时消息滞留至下次交互——文档已如实列为已知边界并按此设计 A3 通过标准（「后续轮次上下文」），诚实。
- **降级路径**：A4 polling 完整（无 mailbox 写入断言 + list 可达终态）。降级后 G3 弱化为「结果可达」，需在 G3 定义处显式分档（SUGGESTION-4），避免「验收过了但目标没达成」的争议。

## 通过项（对抗后仍放行的，如实记录）

| Rubric | 判定 | 依据 |
|--------|------|------|
| P0-1/2/3 骨架/delta/结论先行 | 通过 | 五段齐全；初版无 delta 引用残留；一句话结论 + SCQA 开篇 + 各决策条目结论化 |
| P0-4 问题定义触根因 | 通过 | F1-F5 真实失败模式；§2.4 根因「信任边界不同」准确（与逆向证据一致：extension API 同构特权层确实摸不到） |
| P0-5/6 体验视角/术语 | 通过 | §3.1 完整交互样例含失败路径表；Session Mailbox/drain/event sourcing 等均有定义绑例子 |
| P0-7/8/9 方案对比 | 通过 | A/B/C 三方案，各评长期+短期，明确推荐 A + B 退路 + C 排除理由（用 B7/B8 实证排除 C） |
| P0-13/14/15 验收 | 通过 | A1-A9 全部真实 GUI 环境无 mock；通过标准具体可判（git status 干净 / `git apply --check` / ps 无残留 / read/ 目录有已消费文件）；每场景回溯 G 编号；9 场景对 ~10 子系统投入匹配；DoR 前置检查存在 |
| P0-17/18 数据流图/错误恢复 | 通过 | §2.3/§3.4 物理路径全标注；§3.1 失败表 5 项各配具体恢复动作（含 launchctl 命令） |
| P1-1/2/3/4 受众/justification/alternatives | 通过 | 受众补课段、M1-M5 justification 列、D1-D12 全部记录被否方案 |
| P1-6/7/9 减法优先/不跨层/条目化 | 通过 | 放弃清单明确（D5/D8/Out of Scope）；「技术方案层」声明并守住；决策条目「采用/被否/证据/探针/代价」四件套 |
| 对照表 #15「优于 pi 的 turn 边界」 | 通过（实证成立） | pi notifier 为 turn 边界唤醒（源码头注），mailbox PostToolUse 轮中注入确实更早——文档判断与源码相符 |

## 附：审查中执行的核验命令清单（可复现）

1. zcode.cjs 锚点：`node -e "readFileSync('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs')"` + `slice(off-pre, off+post)` 窗口读取（@11067925/@10358509/@11602483/@11763070/@776399/@7699452/@10260805/@368446/@456702）与关键词全文检索（`ZCODE_MESSAGE_ENABLED`/`dYr(`/`sessionMailboxPort`/`sampling/createMessage`/`clientInfo`/`capabilities:{`/`ZCODE_HOOK_PAYLOAD`/`ZCODE_SESSION_ID`/`transcript_path`/`matcher`/`hooks:`）
2. CLI 实测（隔离 HOME 防误触真实会话）：`HOME=/tmp/zsub-review-home node zcode.cjs --json <--max-turns 1 | --settings ... | --allowed-tools ... | --disallowed-tools ... | --resume sess_...> --prompt hi --cwd /tmp`
3. `launchctl getenv ZCODE_MESSAGE_ENABLED`
4. `grep hookEventName ~/.zcode/hooks/*.log | sort | uniq -c`（583 全为 SessionStart）；dump 头部含 `ZCODE_APP_VERSION=3.0.0`
5. pi 源码：`subagent-tool.ts`（:74/:108/:149/ schema 字段）、`config.ts:26`、`session-runner.ts:640-665`、`record-store.ts`、`notifier.ts`、`execution-record.ts`
6. dynamic-workflow：`lib/driver.js`、`lib/pool.js`、`lib/jsonout.js` 全文 + `grep -rn "bootstrapIsolatedHome|runHeadlessPhase" lib/`
7. `~/.zcode/v2/config.json` provider/models 清单（A2 的 GLM-4.7-Flash 确实存在于 builtin:bigmodel-coding-plan 下）
