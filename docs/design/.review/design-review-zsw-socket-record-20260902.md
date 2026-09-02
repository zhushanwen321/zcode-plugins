# 对抗式审查报告：zsw-socket-record-convergence-design.md

审查日期：2026-09-02。审查对象：`docs/design/zsw-socket-record-convergence-design.md`（帧 codec 单源化 / zsub action 面收口 / record keep-N compact 三线）。

事实核实范围：文档引用的全部行号与引文（daemon-socket.js、cli-client.js、dist/mcp/server.js、bin/zsw.js、manager.js、record-store.js、assemble.js、wait-handler.js、reaper.js、config.js、6 个测试文件）已逐一 read 源码比对；既有裁决（S8=DESIGN-v4.md:350、D-E4=zsw-manager-convergence.md:7 引 zsw-sink-adoption-design.md、D1 zero-tool=server.js:26-29/461-464、reaper 只报告不删=reaper.js:8-11、pruneWorkflowState=assemble.js:90-102）全部真实存在且引述准确。

## Summary

4 must-fix, 3 suggestions.

行号与引文的总体准确度异常高（30+ 处引用全部命中，含头注逐字引文），方案对比/探针/验收框架达标。4 个 must-fix 集中在：一个被两处源码否证的行为论断（D6 busy 可达）、一个与 server.js 实际 recover/竞选顺序错位的挂点描述（D8/U3 compact 触发点）、一处文档内部自相矛盾且牵动验收基准的决策（D4 删 usage 触发条件）、一处接管段未逐段归属（D3/U2 守卫段，含嵌套防递归门禁）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §2.2 / §3.3 D6 / §4 A9 | P0-11 事实（影响决策） | 「--local message 只剩 busy 早退路径可达」被源码否证：`--local` 路径 rebuild 后所有非终态标 lost（record-store.js:147-149；bin/zsw.js:1009-1014 注释自认「非终态 record 在 CLI 视角显示 lost」），内存态只可能是 {closed,cancelled,error,timeout,lost}，而 busy 闸要求 status 为 running/created（manager.js:359）——busy 早退同样不可达；idle 亦不存在，故「续聊暂不可用」throw（manager.js:383-387）在 --local 也不可达。连带后果：D6「busy 早退分支保留」= 保留另一段死代码（与本设计清死分支的目标矛盾）；A9 为不可达路径建「busy 早退单测锚」锚的是假场景；D6 效果陈述「= busy 早退 或 unavailable 错误」错误（真实可达输出只有三类 throw：id 不存在 / 非 conversation / 状态非 idle）。 | read 源码复核后：busy 早退与 `await pending` 段一并删除（--local message 收敛为纯错误路径），或给出保留 busy 早退的真实可达论证；同步修正 D6 效果陈述与 A9 场景（busy 锚改为 daemon 面或删除） |
| MUST_FIX | §3.3 D8/D9 / §5 U3 | P0-12 副作用 + P0-16 断言根基 | compact 触发点描述与 server.js 实际结构错位：U3 写「recover 链（`manager.recover()` 后）加 compact 触发判断」，但 server.js 的 `manager.recover()` 有两处调用——main 启动序列 :581 位于 startDaemon 竞选（:646）**之前**，standby 实例同样执行（头注 :22「standby 的 manager 照常初始化」）；onTakeover :656 仅接管路径触发。按文档字面实施：挂 :581 后 → standby 也 compact，多 MCP server 同时启动（如重启交叠/多会话）即双进程并发 compact——temp 固定名 `${filePath}.compact-tmp` 互踩（半成品 temp 可被 rename 提成正式文件），stat 复查只防「变大」防不了「他者 compact 已 rename 缩小」，D9①「daemon 单属主、常态 by construction」被击穿；挂 :656 → 首竞选 daemon 永不 compact（daemon-socket.js:132-134「仅接管路径触发」），A5「启动 daemon 触发 recover+compact」场景不成立。正确挂点（role 确定后：startDaemon ready 且 `role==='daemon'` 处 + onTakeover）需要新接线，文档未给出。 | U3 改写 compact 触发点：显式挂在角色确定后（startDaemon ready 判 role==='daemon' + onTakeover 两处），并写明「main 启动 recover 在竞选前、standby 也跑」这一结构事实；D9① 论证随之补「standby 不 compact」的前提如何由挂点保证；可顺带把 temp 路径唯一化（如加 pid 后缀）作纵深防御 |
| MUST_FIX | §3.3 D4（对照 §1 目标 4 / §3.1 / §4 A1/A3） | P0-12 自相矛盾（改 A 影响 B） | D4 内部直接冲突：「CLI usage() = argv 层用法提示（缺参数时打印用法，**保留**）」与「**删除** `bin/zsw.js:828/:1029` 的 `!args.task \|\| !args.slug`」——后两行正是「缺参数时打印 usage」的实现（:828/:1029 均 `usage()` 调用），删了它缺参就不再走 usage。且删除后缺参报错从 usage 输出变为 manager throw 消息（经 ok:false 帧），是使用者可见的输出变化，与 §1 目标 4「错误消息文本……全部不回归」、§3.1「三个收口都零行为变化」矛盾；而 A3「manager 错误消息直达用户（无 usage 降级）」又暗示预期该变化——三处口径不一致，验收比对基准（A1「逐行一致」）会 FAIL 或被静默放水。 | 二选一并全文对齐：①保留 :828/:1029（usage 语义不变，D4 删除清单去掉这两处）；②显式声明「缺参报错形态有意从 usage 改为 manager 消息」为设计变更，修订目标 4 的「零回归」表述与 A1/A3 比对基准（收口前先录缺参输出基线） |
| MUST_FIX | §3.3 D3 / §5 U2 | P0-12 接管段未逐段归属 | U2 用 action 表替换 `buildToolHandlers` zsub 分支（:162-249），但该分支内多个行为段未声明归属：① nested 拒绝门禁（:145-149，防递归第二重——漏掉即违反项目 AGENTS.md 开发红线「嵌套调用防护」）；② manager 未初始化检查（:151-153）；③ agents 的 resolver 端口守卫 + agentListView 视图映射（:194-201 + :518-547，不是 manager 方法直调）；④ models 的 modelRouter/allProviders 端口守卫 + guidance 拼装 + --all 分支（:208-243，同非直调）。D3 的表模型「exec 直调 manager」字面放不下 agents/models 的实际形态（端口消费 + 视图拼装）。D4 只逐段归属了「删除」项，保留段无一归属；A1/A3 验收比对正常 manager 路径，端口缺失守卫丢了测试仍绿。 | D3/U2 补「被接管段逐段归属」：nested 门禁/manager 检查留入口包装层还是进 zsub-actions；agents/models 的 exec 形态（端口守卫 + 视图拼装）如何在表内表达；错误文案（含「不支持的 action」表生成消息与现状 :244-248 逐字比对口径）逐段写明复刻或声明放弃 |
| SUGGESTION | §3.3 D8 效果 | P0-10 边缘（目标 3 达成度） | lost 态 run 的上界缺口：manager.recover 每次重启为每条非终态 run 探活并 `records.update` **落盘** dead/orphan/lostReason（manager.js:492-506），compact 按活跃全保 → 崩溃遗留的 lost run 行数随 daemon 重启次数线性增长且永不淘汰（lost 非终态），「稳态 ≤（活跃+1000 终态）×每任务事件数」的封顶声明在有 lost run 时不成立。增长慢（需崩溃遗留 + 用户不清理），但与失败模式 D 同构。 | 显式声明该边界及接受理由，或给 lost run 附加行数/条数上限（如 lost run 保最近 M 条）；A5-A8 验收可补一条 lost run fixture 场景 |
| SUGGESTION | §3.3 D8 | P0-12 边界遗漏（低概率） | 索引不可见行组的 compact 处理未定义：created 行损坏（尾部截断/坏行）而同 run 后续 transition/update 行存活时，重放全 skipped、索引无此 run，compact 分组得到「无状态组」，无法判活跃/终态——文档未说保留（垃圾永存）还是删除。 | D8 补一句边界规则：不在内存索引的行组按终态竞争处理（或保守保留并声明），P-compact-equiv 测试可加该 fixture |
| SUGGESTION | §1 In-scope / 变更历史 | P1-3 受众背景 | 「架构报告候选 4/2/5」的来源文档在本 worktree 检索不到（docs/ 与 design/ 均无），候选 1-7 编号不可追溯；其余裁决（S8/D1/D-4/D-E3/D-E4）均有文档锚点，唯此份缺。 | 给出架构报告的路径引用，或将候选清单（含一句描述）内联到 §1 |

## 通过项摘要（对抗后仍放行的）

- P0-1/2/3（结构）：五段骨架完整；SCQA + 一句话结论 + 各章首句结论齐备；变更历史仅在附录，正文无 delta 链。
- P0-4/10（问题定义与根因）：三线各自有独立根因小节（语法与传输层捆绑 / action 面从未模块化 / 事件溯源缺 compaction），方案与根因因果链闭合；out-of-scope 逐候选显式防 scope creep。
- P0-5/6（受众/术语）：§1「系统是什么」+ §3.1 维护者走查三场景；「帧/codec」首次出现即定义。
- P0-7/8/9（方案对比）：三线各 3 候选，长期架构/短期成本/风险三栏齐全，被否方案均有「代价可感知化」段。
- P0-11（其余事实）：D5「删包装对不是线上协议变更」两端证据成立——unwrap 确在落帧前（server.js:377-394 包 :162-249，daemon-socket.js:370 直接消费 unwrap 后返回值组帧）、CLI toResult 只剥 id（cli-client.js:61-63）；okContent 唯一消费者确为被删的包装路径，errContent 的 MCP 拒绝面消费者（server.js:437-441）属实；pretty-print 往返（stringify(v,null,2)+parse）对最终帧无影响（undefined/Date 两形态前后等价）。C2 的 applyEvent default→skipped 论据属实（record-store.js:197-198）。D6 删除 await pending 段的决策本身仍成立（该段确不可达，见 MUST_FIX-1）。
- P0-16/17/18（层敏感）：探针清单 6 条带 ⛔ 与降级路径；D9③ 微窗在「待验证检查点」诚实声明；§2.4 两张物理数据流图；新增错误面（compact 放弃/失败）均有 stderr 留痕与恢复动作（下次启动重试）。
- P0-13/14/15（验收）：9 场景全部真实进程/真实文件系统、步骤与通过标准 testable、每场景回溯目标编号、负面场景 2 个（A7/A8）；A5 的 fixture 构造数据对 compact 线合理（真实跑 1050 任务不可行，daemon/文件系统均真实）；大改动投入匹配。A9 的单测锚 + 缺口声明属诚实降级（wait-handler 不在改动面），但其 busy 锚需随 MUST_FIX-1 修正。
- P1-1/2/4/5/6/9/10：各决策四件套 item 化、U1-U3 有 justification、有「减法记录」段、负面行为有反向验收。
- 项目红线：零依赖纯 Node CJS（frame-codec.js/zsub-actions.js 均无依赖面）、依赖方向 dist→lib/bin 正向（B3 被否避免加重反向 require）、嵌套防护与 stdout JSON-RPC 通道不受影响（U2 改动需保 nested 门禁，见 MUST_FIX-4）。

## 判定统计

P0 清单 18 项：4 项不通过（P0-11×1、P0-12×3，其中一项叠加 P0-16），其余通过。P1 清单 10 项：3 项建议（P1-3×1、边界类×2），其余通过。

---

# R2 复审（2026-09-02，第 1 轮修订后）

复审范围：R1 的 4 must-fix + 3 suggestion 修复是否成立（重点攻击三个指定点）+ 交叉引用一致性终检。已确认项不重查。

## R1 修复判定（逐条）

| R1 项 | 判定 | 核实证据 |
|---|---|---|
| MUST_FIX-1（D6 busy 不可达） | **修复成立** | §2.2 事实链重写与源码一致（record-store.js:147-149 标 lost + manager.js:359 busy 闸条件）；D6 改整段删除且旧方案记入被否谱系。攻击点 c 核实：`--local` 三类 throw 统一冒泡至 bin/zsw.js 模块尾 `main().catch`（stderr `[zsw] 错误: <message>` + exit 1），出口机制不在本设计改动面，删除前后呈现逐字一致自动成立；A9 改三类可达错误实测，fixture 构造正确（conversation 闸先于 idle 闸，三类构造顺序核实无误） |
| MUST_FIX-2（compact 挂点） | **修复成立** | 攻击点 a 核实：挂点实装真实存在——startDaemon 返回 ready promise，resolve 值 `{role, stop}`（daemon-socket.js:162-168、:417 finishReady('daemon')），main 在 `await startDaemon(...)` 后可判 `daemon.role`（server.js:646-673 先例）；role 是首竞选快照、接管不回填（daemon-socket.js:136-138 头注）+ onTakeover 仅 wasStandby 路径触发（:410-416）→ 「首竞选 daemon（role 判定）+ 接管（onTakeover）」两处覆盖 MECE、无双跑；standby 不挂。temp pid 后缀、size 双向复查、P-mount、U3/A5/§2.4 五处联动齐 |
| MUST_FIX-3（D4 自相矛盾） | **修复成立，但有一处联动遗漏**（见 R2 Findings #1） | 攻击点 b 核实：「随 exec 原样保留」消息路径零变化成立——现状 `errContent(text)` → unwrap isError → throw(text) → dispatch ok:false 帧，与迁移后 exec throw(text) → dispatch ok:false 帧形态逐字节一致（消息文本两侧同为「message 需要 text（非空字符串，续聊消息内容）。」）；A3 补「缺参输出与现状一致」口径。但 §5 文件改动地图未同步（下表 #1） |
| MUST_FIX-4（接管段归属） | **修复成立** | D3 归属表六段覆盖 zsub 分支全部行为段（nested 门禁/未初始化检查留包装层、直调段迁 exec、wait 挂 deps.waitHandler、agents/models 经 deps.ports）；U2 补包装层保留 + server.test.js 守卫保留断言；requireSubagentId/agentListView 随分支主体迁移无外部消费者阻隔（server.js 导出面不含它们）。一处新刺：消息生成式与「逐字一致」声明不符（下表 #2） |
| S1（lost 上界） | 修复成立 | D8 效果改「≤（活跃 + lost 遗留 + 1000 终态）」+ 缺口声明与接受理由（lost 重构归 zsw-manager-convergence 范围，不越界）；A8 扩 lost run 断言，构造语义准确（created 后无终态事件 → rebuild 标 lost） |
| S2（孤儿行组） | 修复成立 | D8 补「保守保留并跳过」+ 理由（删错 = 丢可能在跑的 run）；U3 测试行含孤儿行组 fixture |
| S3（候选编号） | **部分修复** | In-scope/Out-of-scope/D3/D8 已改描述性；但正文残留 5 处「候选 N」编号（下表 #3） |

## R2 Summary

1 must-fix, 3 suggestions. 新 must-fix 是 R1-MUST_FIX-3 修复的联动遗漏（文件改动地图未同步），非新方案缺陷。

## R2 Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §5 文件改动地图（bin/zsw.js 与 dist/mcp/server.js 两行） | P0-12 修订联动遗漏 | 两行动作列仍写「校验删」（与 R1 版逐字相同、未随修订更新），与重写后的 D4「现状三层全保留」、U2「usage() 与组参校验原样保留」「分支内校验随 exec 原样保留」直接矛盾。实施者按文件地图执行会删除 :828/:1029/:173-175——正是 D4 被否谱系里被「零行为变化基准击穿」的方案，A3「缺参输出与现状一致」验收将 FAIL。R1-MUST_FIX-3 的修复在执行层被架空。 | 文件改动地图两行的「校验删」改为「校验保留（D4 归属）」或直接删去该动作项，与 D4/U2 对齐 |
| SUGGESTION | §3.3 D3（消息生成式） | P0-12 轻度（口径矛盾） | D3 宣称「不支持的 action」消息「与现状 server.js:244-248 逐字一致」，但给出的生成式 `'不支持的 action "${action}"。支持：' + 表键 join(' | ') + '。'` 缺现状尾句「恢复指引：action 必须取 inputSchema 中的枚举值。」（server.js:246-247）——按模板生成必不逐字。且该句是 MCP 面时代措辞（zero-tool 后 socket 面无 inputSchema），「逐字保留过时措辞」与「删句改措辞但违反逐字」二选一未决，A3 比对基准悬空。 | 模板补恢复指引句逐字保留，或显式声明该句废弃并在 A3 基线登记为唯一允许差异（实施期先录基线的既有口径可承载） |
| SUGGESTION | §2.2 末段 / §3.2 B3 与 C2 被否段 / D7 效果 | P1-3（S3 修复不彻底） | 「候选 N」编号残留 5 处：§2.2:118「候选 3 的处理对象」、§3.2:192「候选 3 要拆的正是这个形态」、:194「候选 3（zflow 面抽出、依赖方向正转）」、:204「架构报告候选 6 批评的模式」、D7:261「候选 1/3 落地时」。前 3 处有内联解释可推断；「候选 6」「候选 1」处无解释且来源报告不在 repo（R1-S3 核实），读者不可追溯 | 残留 5 处改描述性表述（对齐 In-scope/Out-of-scope 的改法） |
| SUGGESTION | §3.4 探针表（P-mount / P-atomic） | 探针完备性（P0-16 轻度）+ P1-8 | ① P-mount 断言含「首竞选 daemon 与接管路径**都**触发」，但步骤只构造「双 MCP server 并发启动」——无杀 daemon 构造 standby 接管的环节，断言另一半无验证步骤；② P-atomic 行 temp 路径仍是 `${filePath}.compact-tmp`（无 pid 后缀），与 D8/D9②/§2.4 三处新形态 `${filePath}.compact-${pid}.tmp` 不一致（同目录语义未变，不影响决策，但同文档两形态并存易困惑）。另：D8/P-mount 用「startDaemon 实际回调形态/角色回调」措辞——startDaemon 无角色变化回调，实际形态是 ready 返回值判 role + onTakeover，建议措辞对齐实装 | P-mount 步骤补「杀 daemon 进程 → 观察 standby 接管后的第二条 compact 日志」；P-atomic 行路径更新为 pid 后缀形态；「回调」措辞改「ready 返回值 + onTakeover」 |

## R2 交叉引用一致性终检（五处联动）

正文决策 ↔ §2.4 数据流图 ↔ 错误面 ↔ §4 验收 ↔ §5 拆分与文件地图：D6（§2.2/D6/A9/U2 四处一致）、D8 挂点（D8/D9①/§2.4/A5/U3 五处一致）、temp pid 后缀（D8/D9②/§2.4/U3 一致，P-atomic 除外）、size 双向复查（D9②/P-occ/U3 一致）、lost 缺口（D8 效果/A8 一致）、孤儿行组（D8/U3 一致）——除上表 4 项外全部联动闭合。一句话结论与 §3.1 的「不可达 wait 分支」表述与修订后 D6 语义一致。

## R2 判定统计

R1 四个 must-fix 修复全部成立（挂点经实装形态核实可接线、消息路径经两端帧形态推演零变化、CLI 出口机制经 main().catch 核实不受影响）；新发现 1 must-fix（修订联动遗漏）+ 3 suggestions。修复成立项不再列为阻塞。

---

# R3 复审（2026-09-02，第 2 轮修订后）

复审范围：R2 的 1 must-fix + 3 suggestion 修复判定与质量抽查 + 全文交叉引用扫描（重点 D4/D6/D8 口径的第三处未同步实例）。

## R2 修复判定

| R2 项 | 判定 | 核实证据 |
|---|---|---|
| MUST_FIX（文件地图「校验删」） | **修复成立** | 三处对齐闭合：D4 决策（:239-243「三层全保留」）/ U2 接线（:318「usage() 与组参校验原样保留」、:319「分支内校验随 exec 原样保留」+ nested 门禁留包装层）/ 文件地图（:342「usage 与校验原样保留」、:343「nested 门禁与前置校验原样保留」）。bin/zsw.js 行的动作项也从「wait 死分支删」精化为「message 不可达内联整段删」，与 D6 整段删除口径一致 |
| S1（生成式缺尾句） | **修复成立** | 与 server.js:244-248 现状全文逐字比对：尾句「恢复指引：action 必须取 inputSchema 中的枚举值。」转写无误；`${action}` 与现状 `${String(action)}` 对 JSON 帧来源的 action 值（string/undefined/null/number/object）输出等价；表键序由 U2 :317 的表定义列表（start/list/status/cancel/message/close/agents/models/wait）与现状硬编码名单同序隐性保证。「保留尾句 vs 措辞更新」二选一已显式声明（零行为变化基准优先），A3 口径不再悬空 |
| S2（候选编号残留） | **修复成立** | grep「候选 + 数字」清零（本轮实测 exit=1）；5 处全改描述性。残留「候选『名称』」形态两处（:235 候选『zflow 面抽出』、:267 候选『统一 run 台账』）均带内联名称，且后者有 md 锚点、前者在 §1 out-of-scope 有同名条目——自包含可读，不阻塞 |
| S3（探针两处） | **修复成立，一个新前提缺口**（见 Findings #1） | P-mount 补「kill daemon → standby 看门狗接管（onTakeover）→ 超阈值下接管路径出现 compact 日志」——接管链实装核实可行：kill（SIGKILL/SIGTERM 均可）→ standby 看门狗连接 close（daemon-socket.js:285-316）→ probeLockHolder 探活 dead → sweep → elect → becomeDaemon → wasStandby → `await onTakeover()`（:410-416）→ server.js:654-667 recover 后按 D8 挂点 compact。P-atomic temp 路径已带 pid 后缀，与 D8/D9②/§2.4/U3 四处一致 |

## R3 Summary

0 must-fix, 1 suggestion, 2 info.

## R3 Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | §3.4 P-mount（探针第一段） | 探针可测试性（P0-16 轻度） | 第一段步骤「双 MCP server 并发启动，观察 stderr：仅 daemon 角色出现 compact 日志行」缺「预置超阈值台账」前提——D8/U3 的跳过路径是「run 数 ≤ keep 一次 records.size 判断」零成本跳过、无结果日志，fixture 不超阈值时任何角色都不会出现 compact 日志行，断言无从观测；探针会误判失败并触发降级路径「挂点接线错位 → 回到 startDaemon 角色回调重接」，把排障引向错误方向。第二段已写「超阈值场景下」，第一段漏同款前提 | 第一段步骤补「预置超阈值 fixture（同 A5）」，或规定跳过路径也打一行 skip 日志作为观测面 |
| INFO | §1 :31 与 :39（「§3-C」锚点） | P1-8 锚点失准 | 两处引用「§3-C」（本设计 §2.3/§3-C 的对象 / §3-C 兼容论证的基础）——文档章节号为 §3.1-§3.4，无「§3-C」编号，实指 §3.2 线 C / C1-C2 的升级窗口兼容论证，可推断但不精确 | 改为「§3.2 线 C」或「C1」 |
| INFO | §3.3 D8（:264）/ §3.4 P-mount 降级列 / §5 U3 justification | P1-8 措辞 | 「startDaemon 实际回调形态」「角色回调」措辞三处——startDaemon 无角色变化回调，实装形态是 ready promise 返回值判 `role` + `onTakeover` 回调（R2 已核实）。不影响接线方向，但「回调」字面与实装形态不符 | 统一改为「ready 返回值判 role + onTakeover」 |

## R3 交叉引用一致性终检（全文扫描）

D4 口径（三层全保留）：7 个出现点（§2.2:104 / §3.1:171 / D4:239-243 / A3:296 / U2:318-319 / 地图:342-343）全一致。D6 口径（busy 早退 + await pending 整段删除）：9 个出现点（一句话结论:3 / In-scope:54 / §2.2 标题与事实链:96/:112 / B1:190 / D6:251-255 / A9:302 / U2:318 / 地图:342）全一致。D8/D9 口径（角色确定挂点 / pid 后缀 / size 双向 / lost 缺口 / 孤儿行组）：9 个出现点（§2.4:157-158 / C1:200 / D8:264-267 / D9:270-274 / P-occ/P-mount/P-atomic:283-285 / A5:298 / A8:301 / U3:325-326 / 地图:343-344）全一致。**无第三处未同步实例**。R2 新增内容（生成式尾句声明、P-mount 接管步骤、地图两行）与既有口径自洽；变更历史 R1 行原文保留、R2 行新增，符合溯源规范。

## R3 判定统计

R2 的 1 must-fix 修复成立（三处对齐闭合），3 suggestions 修复全部成立（生成式经逐字比对无转写误差、接管链经实装核实可行、编号清零经 grep 实测）；新发现 0 must-fix + 1 suggestion（P-mount 步骤前提缺口）+ 2 info。设计文档达到可实施状态：五段骨架、方案对比、探针、验收、拆分与文件地图六面联动一致，全部关键事实经源码核实。剩余 1 suggestion 与 2 info 均不阻塞实施。
