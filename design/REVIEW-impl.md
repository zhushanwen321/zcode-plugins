# zsub 实现对抗式审查报告

> 审查对象：`zsub/`（lib/ + lib/workflow/ + dist/mcp/server.js + bin/zsub.js + test/ + fixtures/），对照 `design/DESIGN-v3.md`（含 v2 `DESIGN.md` 附录 24 项对照表）与 pi 蓝本（`~/Code/xyz-agent-workspace/main/extensions/universal/subagent-workflow/`）。
> 审查方法：默认怀疑一切「已实现」声称，逐项读代码找证据证实/证伪；关键 bug 均以运行复现或探针脚本验证；149 个单测本地重跑全绿（e2e E1-E8 含真实模型调用，成本考虑未重跑，采信 DESIGN-v3「全绿」记录并标注）。只审查不修复。
> 审查日期：2026-08-23。

## Summary

**3 must-fix, 9 suggestion, 8 info.**

总体判断：架构兑现度高——端口/适配器声称经逐文件核验成立（manager 零具体实现依赖、assemble 是唯一组装点、换 runner/notifier/入口确为单点改动），Z8 mailbox 四规范逐条落码且有测试，worktree patch 三类覆盖用等价但更强的机制实现，149 单测断言密度高无明显凑数。**must-fix 集中在三类「声称与实现脱节」**：① server 启动序列的孤儿清扫接线字段名写错，整段功能死代码且每次启动必抛异常（已运行复现）；② CLI 的 message 与 `start --no-wait` 在一次性进程语义下必然丢失执行体（README 还在示范这条坏路径）；③ agent .md 的 tools 白名单与 maxTurns 被 resolver 解析后全链路零消费——工具限制这种安全语义静默失效，对照表「近似」档位失实。三者都发生在并行开发接缝或「照源/照文档自述」的区域，恰好是无对抗测试覆盖的地方。

## 一、pi 对照表逐项核验（抽核 16/24 项）

| # | pi 功能 | 声称档位 | 核验结论 | 证据 |
|---|---------|---------|----------|------|
| 1 | 五 action | 完全 | **基本属实，表述失准**：实际六 action（多 `status`，pi 无此 action）；server enum/README/SKILL 均写「五 action」但列 6 个 | dist/mcp/server.js:95（enum 6 值）；pi subagent-tool.ts:74（5 值无 status） |
| 2 | agent .md（frontmatter） | 完全（thoughtLevel 除外） | **属实但偏强**：四根+symlink follow 完整（含环/broken link 防御，测试覆盖）；但 pi 消费字段还有 color/permissionMode/memory/mcpServers，zsub 只消费 7 字段——「除 thoughtLevel 外完全」未列其余未消费字段 | lib/agent-md-resolver.js:25-27；pi zcode vct 解析（DESIGN.md B9） |
| 4 | cancel | 完全（SIGTERM+SIGKILL） | **首轮属实、续聊轮不成立**：spawn 首轮 killChain（SIGTERM→5s→SIGKILL）完整且超出 pi（pi 仅 SIGTERM，grep 无 SIGKILL 落码）；appserver 侧 session/stop→killChain 同链完整；但 **resume 轮无 cancel 句柄、exec.pid 不更新**——cancel 只终态化 record 杀不掉进程（跑到 timeout 才死），pi 对任何轮都有进程句柄 | lib/driver.js:219-228（killChain）；lib/runner-appserver.js:432-442（同链）+ :781-825（resume 无句柄）；pi session-runner.ts:776/817（仅 SIGTERM） |
| 6 | conversation 续聊 | 完全（进程级） | **MCP 入口属实（E3/E7 实证），CLI 入口不成立**：CLI `message` 启动 resume 轮后进程退出，轮死、record 卡 running（见 MUST_FIX-2） | test/e2e.test.js:256-285；bin/zsub.js:239 |
| 7 | close | 完全 | **属实**：运行中借 cancel 链、终态清 worktree、cleanup 失败显式落 record（worktreeCleaned:false + worktreeError），重入安全（幂等 cleanup）；lost 边界只终态化不杀进程（有文案提示残留） | lib/manager.js:291-327；test/manager.test.js:452-468 |
| 8 | worktree+patch | 完全 | **属实且局部更强**：三类改动（已提交+未提交+新增）全覆盖——pi 用 `add -A` 全暂存 + `diff --cached base`，zsub 用 `add -A -N`（intent-to-add）+ `git diff base`（工作树 vs 基线 commit，累计差异），机制不同语义等价；基线 commit 落 gitdir 侧车使**跨重启**仍可 diff（pi 是内存 handle）；单测明确覆盖三类 | lib/worktree.js:183-210（MF#2/MF#3）；test/worktree.test.js:104；pi worktree-manager.ts:295-317 |
| 9 | record 恢复 | 完全 | **单 server 场景属实，CLI 并存场景有误判**（见 SUGGESTION-5）：rebuild 脏行防御/终态照抄/非终态标 lost + 探活区分 dead/orphan 与 pi 的 orphan recovery 语义对齐；E6 真机实证 | lib/record-store.js:118-144；lib/manager.js:338-359；test/e2e.test.js:368-403 |
| 10 | 并发池 | 完全（默认 3） | **池属实、深度分层不可达**：slots FIFO+上限+保底有完整单测；但 `effective = max(1, limit - depth)` 的 depth 只来自 ZSUB_NESTED，而 nested 进程被双门禁直接拒绝服务——能服务请求的进程恒 depth=0，分层永远不触发（pi 的 depth 是 fork 深度，zsub 已放弃 fork，动机失去对象） | lib/slots.js:28-31；lib/manager.js:531-534；dist/mcp/server.js:504-506；pi subagent-service.ts:1417 |
| 11 | 防递归 | 完全（双门禁） | **属实**：ZSUB_NESTED 检查（tools/list 空 + tools/call 拒绝）+ 隔离 HOME config 不含 plugins（单测断言）；run_workflow 在嵌套档一视同仁被拒（测试断言零触达入口）——M3 声称成立 | dist/mcp/server.js:453-455/271-275/317-323；test/execution.test.js:142；test/server.test.js:441-460；test/e2e.test.js:461-484 |
| 12 | schema 结构化输出 | 近似（prompt 契约 + jsonout 提取） | **半失实**：MANDATORY 契约段属实；**「jsonout 提取」在 start 链路不存在**——manager 全链无 jsonout require，结果原样返回由调用方自行解析 | lib/prompt-builder.js:31-40 ✅；`grep -rn "jsonout" lib/manager.js lib/prompt-builder.js` 0 命中（jsonout 只被 workflow/ 消费） |
| 13 | model 路由 | 近似（HOME 池） | **机制属实，边界未声明**：per-model HOME 池 + mtime 条件重写 + 模块级互斥链（tmp+rename 原子写）完整；但**仅支持 builtin:bigmodel-coding-plan 单 provider**，其他 provider 显式报错——README 已知边界未声明 | lib/model-router.js:126-143/159-176；test/execution.test.js:208 |
| 14 | tools 白名单 | 近似（prompt 约束 + `--disallowed-tools` 反向表达） | **失实（MUST_FIX-3）**：frontmatter tools/disallowedTools 被 resolver 解析进 profile 后**全链路零消费**——prompt-builder 不拼任何 tools 段；driver 的 argv 无 `--disallowed-tools` flag；工具限制这种安全语义静默无效 | lib/agent-md-resolver.js:237-239（解析）；lib/prompt-builder.js:18-55（不消费）；lib/driver.js:205-207（args 无此 flag） |
| 15 | 完成通知 | 近似（mailbox 轮中注入，无 idle 唤醒） | **属实**：mailbox 投递真实文件级实证（E2）；文案含 results 头 500 字 + outputs 全文路径 + worktree 任务的 patchFile 与 `git apply` 指引（pi [MF#1] 教训已兑现）；失败通知含恢复指引 | lib/manager.js:502-521；test/e2e.test.js:207-252；pi notifier.ts:271-274 |
| 16 | message running 投递 | 弱化（busy） | **属实且如实声明**：running/created 返回 busy、仅 idle 可投、非 conversation 拒绝；README 已声明。pi 侧「any running subagent + one-shot 自动升级 conversation（SP-5）」未复刻——zsub 直接报错（弱化的一部分，文档未细说） | lib/manager.js:240-247；test/manager.test.js:313-326；pi subagent-tool.ts:145-155 |
| 17 | skills 注入 | 近似（SKILL.md 内容拼 prompt） | **属实但实现与表述不一致**：实际拼的是**路径列表 + 「按需 read」指引**（比拼全文更省 token，实现更优），非「内容拼 prompt」 | lib/prompt-builder.js:42-52 |
| 18 | maxTurns 熔断 | 弱化（timeout 兜底） | **失实（归入 MUST_FIX-3）**：profile.maxTurns 解析后零消费——既无 turn 计数也无 maxTurns→timeoutMs 换算，timeoutMs 是与 maxTurns 无关的独立参数 | lib/agent-md-resolver.js:241-242（解析后无任何消费点，grep 全链 0 命中） |
| 23 | workflow 编排 | 已并入 | **属实**：5 个 workflow + run_workflow tool + CLI workflow 子命令 + 双段报告；工具定义/description 照源；dynamic-workflow 已卸载声明一致 | lib/workflow/* 全部经 phases.runPhase 唯一 driver 入口；dist/mcp/server.js:124-196 |

未抽核：#3（sync start，v2 已改标「zsub 增强」属实——wait=true 有测试）、#5（list 状态树，随 #9 属实）、#19-22（放弃项，grep 确认无 fork/thinkingLevel/TUI/goal 代码残留，如实）。

## 二、设计目标 G1-G4 语义达成度

- **G1（生命周期编程式管理）：基本达成**。六 action 在 busy（message→busy 文案）/ idle（message→running 续聊）/ lost（message 报「仅 idle 可投递」+ cancel/close 有 lost 专属 note）/ 重启（recover 重建+探活，E6 实证）四状态下行为正确；排队中 cancel（created 期）有代码路径（manager.js:384-388）但无测试。缺口：resume 轮 cancel 杀不掉进程（见 SUGGESTION-6），「取消」语义在续聊轮只完成一半。
- **G2（四根 + symlink）：达成**。四根优先级、文件级/目录级 symlink follow、realpath 去重防环、broken link 跳过，全部有单测（domain.test.js:45-123）；E1 项目级根真机命中。user 级根（H1b）无 e2e（E1 刻意置空 user 根），单测覆盖。
- **G3（结果回流）：主档与降级均实际可达**。mailbox 档 E2 真实投递（六字段+单调文件名+无 tmp 残留断言）；polling 档 start 返回轮询指引（manager.test.js:434-450）且 PollingNotifier 零写盘有断言。未验证项如实标注（M1/M2 真机手册、引擎 drain 注入——E2 只断言文件合法，未做 H3 承诺的「无头两轮 resume 验证注入」，见 INFO-18）。
- **G4（worktree 生命周期）：主体达成，收尾一环断裂**。prepare（干净校验+分支+侧车）→ run（cwd 切换）→ patch（三类+落 outputs 兄弟目录）→ close（幂等清理）全链 E5 真机实证；close 失败路径代码有（worktreeCleaned:false 落 record）但无测试、失败重入无测试。**启动期孤儿 worktree 清扫（reaper 接线）因 MUST_FIX-1 整段死代码**——崩溃残留的 worktree 只能人工发现。

## 三、端口架构承诺验证（「决策可换」）

- **manager 依赖纯度**：`grep require lib/manager.js` = node:crypto / ./config / ./prompt-builder / ./record-store——后两者是声明的纯域层；无 runner-spawn/notifier-mailbox/runner-appserver 任何具体实现依赖，**声称成立**。轻微瑕疵：直接 import record-store 的 TERMINAL_STATUSES（record-store 声明为「固定实现」，可接受，但与头注「只依赖 ports.js 契约」字面冲突，见 INFO-14）。
- **换 runner（spawn↔appserver）**：实际改动点 = `ZSUB_RUNNER` env / createRuntime 的 runnerKind 分支（ports.js:136-138）+ server main 的探针门控（server.js:508-530）——manager 零改动，**成立**。record.exec 不透明句柄（spawn/apc 两种 kind）manager 不解读，重启后跨 runner 恢复正确（recover 按 exec.kind 探活）。
- **换 notifier**：createRuntime 同模块双实现（ports.js:140-151），capabilities().mode 是 manager 唯一消费点，**成立**。
- **换入口（MCP↔CLI）**：两者都只经 lib/assemble.js 组装，**成立**——但 CLI 的一次性进程语义与 manager 的后台执行体模型冲突产生 MUST_FIX-2（组装点复用了，生命周期语义没区分）。
- **capabilities() 声明 vs 真实行为**：SpawnRunner `steering:'none'` 与 message busy 语义一致（正例）；AppServerRunner `steering:'session-send'` **虚报**——manager 层 message 门禁 idle-only + runner 内 A5 保守 busy，running 中投递从未对外可达（INFO-15）；MailboxNotifier capabilities 与实际一致；`requiresEnv` 声明与 config.mailboxEnabled 探测一致。
- **interpretEvent 单点防洪堤**：终态判定全部收敛在单函数 + fixture 可注入三种形态，声称成立。

## 四、平台事实遵守（Z1/Z3/Z8/Z10/防递归）

- **Z1（常驻注入成本）**：实测 zsub description 715 字符、run_workflow 923 字符，均在「≤1.5KB」声称内；两 tool 合计 name+desc+schema = 4527 字符常驻（run_workflow 并入后 D2 的「收敛为单 tool」成本论证未更新合计口径，INFO 级）。
- **Z3（_meta 容错）**：extractSessionId 对缺 _meta / 类型不对 / 空串均安全返回 undefined（mailbox 自然降级不报错），有专门测试（server.test.js:38-56）。**属实**。
- **Z8（mailbox 四规范）**：逐条落码且与头注一致——①tmp+rename 原子落位（notifier-mailbox.js:126-127）；②envelope 写前自检，version 严格数字 1（字符串 "1" 拒绝，:60-75，关键差异点处理正确）；③单调文件名 `<13位epoch>-<6位seq>-<id>.json` + 时钟回拨防护 + seq 定宽（:100-104）；④sweepStaleTmp 启动清扫（:137-154，server main 接线且只在 mailbox 档调用）。notify.test.js 四条全测。**属实**。
- **Z10（env 透传）**：config.js mailboxEnabled/mailboxRoot 直接读 process.env，与「server 继承引擎 env」事实一致。**属实**。
- **防递归双门禁**：见对照表 #11，**属实**；run_workflow 一视同仁（M3 声称成立，测试断言零触达）。

## 五、并行开发接缝（8 批次开发最易漏的区域）

- **reaper↔server 接线断裂（MUST_FIX-1）**：S5 交付的 `sweepStaleOutputs` 返回 `{stale}`，server 写成 `staleOut.orphans`——每次启动必抛 TypeError 被 catch 吞掉，**孤儿 outputs 报告与后续的 worktree 孤儿清扫整段不可达**，且每次启动 stderr 留一条「reaper 启动清扫失败」日志。接缝无测试（进程级测试只 match `/record 恢复/`），是典型的双侧各自通过单测、接线字段名漂移的接缝事故。
- **worktree-adapter 签名桥**：manager `prepare({slug,subagentId,cwd})` → adapter → 真实现 `{mainRepo,...}`，mainRepo/branch 随 worktreeMeta 持久化进 created 事件，**重启后 close 能拿到 meta**（rebuild 从 created 事件恢复）；旧 record 无 meta 时 cleanup 抛可操作错误含手工清理指引。往返正确，有桥接测试（worktree.test.js:259）。
- **runPhase 接口一致性**：5 个 workflow 全部经 phases.runPhase → run-phase.js 唯一 driver 入口（grep 证实无旁路）。modelRouter 虽在 4 处各自 new 实例，但 per-model 互斥链 poolMutex 是**模块级** Map——多实例共享同一条链，并发正确（run-phase.js:36 注释「挂在实例内」表述不准确，行为更强，INFO-17）。
- **双 tool 注册表**：nested 门禁两边等价（各自定制文案，测试覆盖）；错误包装等价（zsub handler catch → errContent；run_workflow 入口抛错 → `工作流执行失败:` 前缀 isError）。**等价成立**。
- **CLI vs server 生命周期语义（MUST_FIX-2）**：CLI start 默认 wait=true 是对的，但 `message` 子命令启动 resume 轮后立即退出（进程死→轮死→record 卡 running→下次 recover 误标 lost）；`--no-wait` 的头注理由（「进程不退出会阻塞 bash 任务完成通知」）恰好把 run_in_background 的正确用法说反了——阻塞到完成正是想要的语义。
- **AppServerRunner e2e 修正落地**：turn.terminal 终态 / payload.response 全文 / create model strict 对象 / result.session.sessionId 四处修正全部落到实现与 fixture（FAKE_STATE_SHAPE=real），且有真实抓包回归测试；**残留**：单测主路径（并发/resume/cancel/超时）默认跑在 flat 假形态（SUGGESTION-8）、超时文案仍写「（state.updated）」（INFO-16）。

## 六、已知边界如实声明（README vs 代码实际）

README 已声明：被动注入上限 / spawn 冷启动 / running 不可投递 / appserver send-while-running 待测——均如实。**代码存在但文档未声明的额外限制**：

1. CLI `message` 与 `start --no-wait` 丢执行体（MUST_FIX-2，README 还在示范）。
2. model 路由仅支持单 provider（SUGGESTION-10）。
3. `idleConversationTtlMs` 常量（config.js:51）定义后零消费——apc idle 会话永不回收（SUGGESTION-11）。
4. 深度分层实际恒 depth=0（对照表 #10）。
5. workflow 并发池（runWithLimit）与 subagent 并发池（slots）互不感知，可叠加超过 3 进程（SUGGESTION-12）。
6. mailbox drain 20 条窗口/坏文件永久阻塞语义：notifier 头注有防护设计与实现，README 已知边界未提（低风险，INFO-20）。
7. README「无头 e2e（H1-H10）」vs 实际 test/e2e.test.js 为 E1-E8：H1b（user 级根）/H2（双 home 真机）/H6（并发上限+深度分层）/H10（降级）无 e2e 场景（H2/H10 有单测等价物，H6 无任何真实并发验证，见 SUGGESTION-7）。
8. resume 轮 cancel 后到达的完成结果仍会发通知、进程不可杀（SUGGESTION-6）。

## 七、测试质量抽查

**凑数测试**：未发现明显凑数——149 测试断言密度高，「方法签名与契约一致」类浅测试也附带行为断言（如 capabilities 深比较）。E2 的 envelope 断言（六字段逐个 typeof、文件名正则、字典序单调、无 tmp 残留）是真行为断言。

**缺失的关键测试**（对照 pi 语义与本次发现的 bug）：

1. server main 启动序列的 reaper 段无测试——MUST_FIX-1 因此漏网（进程级测试只断言 /record 恢复/ 日志，catch 吞掉的 reaper 错误无人看）。
2. worktree close 失败路径（cleanup 抛错→worktreeCleaned:false→record 留痕）与失败后再 close 重入，无测试。
3. resume 轮 cancel 竞态（cancel 后 late-done 到达的行为——探针证实会补发通知），无测试。
4. slots 排队中 cancel（created 期被取消不启动进程），无测试。
5. e2e 无并发场景（H6：3 并发上限的真实进程验证）。
6. 并发 message 单进程竞态已用探针证实安全（同步 transition 天然串行化），但跨进程（CLI 并发）无防护也无测试说明。
7. appserver real 协议形态下的并发/resume/cancel 回归缺失（SUGGESTION-8）。

**fixture 同步性（任务书点名项）**：fake-appserver 已同步真实协议形态——`FAKE_STATE_SHAPE=real` 推 turn.terminal + session/event payload.response + patch.status running（fixtures/fake-appserver.js:73-98/124-130），且有专门回归测试（appserver.test.js:276-293）。**问题只在默认值**：real 形态不是默认，主路径单测固化的是已被 E7 证伪的 flat 形态（state.updated status:idle）——不会因 interpretEvent 的宽松匹配而出错，但测试保护的是假协议、真实形态漂移时主路径测试仍会全绿。

## Findings

| 级别 | 位置 | 维度 | 描述 | 修复方向 | 证据锚点 |
|------|------|------|------|----------|----------|
| MUST_FIX | dist/mcp/server.js:553 | 接缝/G4 | **孤儿清扫接线字段名错误，整段死代码**：`sweepStaleOutputs` 返回 `{stale}`（lib/reaper.js:70），server 读 `staleOut.orphans.length` 必抛 TypeError，被外层 catch 吞掉——每次启动 stderr 留「reaper 启动清扫失败: Cannot read properties of undefined」；孤儿 outputs 报告与**后续的 worktree 孤儿清扫（reapWorktrees，:556-566）全部不可达**。已运行复现 | 改读 `staleOut.stale`；为 main 启动序列（sweep/recover/reaper 三段）补进程级断言（stderr 不含「清扫失败」/注入孤儿后能报告） | 复现命令见附录 1；lib/reaper.js:55-71 |
| MUST_FIX | bin/zsub.js:239（message）、:227（--no-wait）；README.md:37 | 入口接缝/G1 | **CLI 一次性进程语义下 message/--no-wait 必然丢失执行体**：`manager.message()` 启动 resume 轮后 CLI 进程退出——执行体（driver 子进程）变孤儿、`_completeRun` 永不执行、outputs/通知永不产生、record 卡 running（下次 recover 误标 lost）。`start --no-wait` 头注声称「供 run_in_background 使用」语义说反：run_in_background 正需要进程阻塞到完成（完成即通知+stdout 摘要），立即退出恰制造僵尸任务。README 使用示例还示范 message 命令 | message 子命令等待本轮完成再退出（同 start 默认 wait）；`--no-wait` 要么删除、要么文档改为「仅配合常驻 server 使用（CLI 只写 record，server 收尾）」并在返回值中明示风险 | bin/zsub.js:227-239/254-257；lib/manager.js:372-377（pending 不被 await 即随进程消亡） |
| MUST_FIX | lib/agent-md-resolver.js:237-242；lib/prompt-builder.js:18-55；lib/driver.js:205-207 | 对照表 #14/#18/安全 | **tools 白名单与 maxTurns 解析后全链路零消费**：frontmatter `tools`/`disallowedTools`/`maxTurns` 进 profile 后无人读取——prompt-builder 不拼任何工具约束段（pi 蓝本 prompt 有 tools 约束）；driver argv 无 `--disallowed-tools`（Z3/B3 实测该 flag 可用而未用）；maxTurns 无 turn 计数也无 timeoutMs 换算。对照表「近似（prompt 约束 + --disallowed-tools 反向表达）」失实；工具白名单是限制子 agent 权限的安全语义，静默无效比缺失更糟 | 短期：prompt-builder 拼工具约束段 + driver 传 `--disallowed-tools`（补集）+ maxTurns→timeoutMs 粗换算；或先在 resolve 阶段对这三个字段显式报「暂不支持」（拒绝优于静默忽略）；同步修正对照表档位 | grep 全链消费点仅剩 ports.js JSDoc 声明（`grep -rn "\.tools\b\|maxTurns\|disallowedTools" lib bin dist`） |
| SUGGESTION | lib/manager.js:421-486 | 对照表 #12 | schema「jsonout 提取」未接：D7/对照表声称「prompt 契约 + jsonout 三级容错提取」，start 链路无 jsonout 消费，schema 任务的结果原样返回由主 agent 自行解析 | schema!=null 时用 jsonout.extractJsonObject 尝试提取，成功则 response 换为对象/带 `structured` 字段，失败在通知文案提示「输出未符合 schema」；或修文档为「仅契约注入」 | `grep -rn jsonout lib/`：仅 workflow/ 消费 |
| SUGGESTION | bin/zsub.js:200；lib/manager.js:338-359 | CLI/server 并存 | CLI 每次命令都跑 `manager.recover()`：对 server 正在管理的 running 任务探活为真 → update orphan:true + lostReason「建议 cancel 后重发」**落盘**——健康任务被误标，误导用户 cancel；且 update 事件每次 CLI 调用都追加累积 | CLI 的 recover 跳过探活段（只 rebuild 供 list/status）；或探活前检测 server 进程存活（pidfile）；或 orphan 标记不落盘（内存态） | manager.js:344-351（update 落盘）；record-store.js:195-200 |
| SUGGESTION | lib/manager.js:401-405/466-484；lib/runner-spawn.js:83-103 | G1/cancel 语义 | resume 轮三连弱化：①cancel 走无句柄路径只终态化 record，resume 进程杀不掉（跑到 timeout，默认 10 分钟）；②探针证实 cancel 后 late-done 到达仍补发「[subagent 完成]」通知（`status!=='cancelled'` 检查的是运行结果而非 record 终态，探针 3 封 envelope 复现），违背「取消后不再通知」自注释；③exec.pid 停留在首轮死 pid——resume 轮运行中崩溃恢复会误判「进程已死」 | SpawnRunner.resume 返回 {pid, cancel()} 句柄入 pending/handles；`_completeRun` 发通知前检查 record 当前是否终态（cancelled 则跳过）；resume 启动时 update exec.pid | 探针脚本输出（附录 2）；manager.js:489-497（_transitionOrSkip 只容忍转移、不拦通知） |
| SUGGESTION | lib/slots.js:28-31；lib/manager.js:531-534；test/e2e.test.js（无并发场景）；README.md:77 | 对照表 #10/验收 | 深度分层不可达（nested 被拒 → depth 恒 0，「学 pi 防指数爆炸」失去对象，纯死代码）；e2e 无 H6 并发场景；README 写「H1-H10」而实际 E1-E8（H1b/H2/H6/H10 缺席） | 要么删掉 depth 参数（诚实），要么给 ZSUB_NESTED 进程保留受限服务（只允许深度递减后的并发）使分层真实可达；补 e2e 并发场景或把 H6 明确移交单测并改 README 验收索引 | server.js:504-506（nested 拒绝）与 manager.js:533（depth=NESTED?1:0）矛盾 |
| SUGGESTION | test/appserver.test.js:204-353；fixtures/fake-appserver.js:19-21 | 测试质量 | appserver 单测主路径（start 全流程/并发/resume/cancel/超时）默认跑 flat 假协议形态（state.updated status:idle——E7 抓包已证伪该形态），real 形态仅 1 个专门测试；真实形态下主路径无回归保护 | 把 FAKE_STATE_SHAPE=real 设为 fake 默认（flat/nested 降为显式兼容用例），主路径全部在 real 形态下跑 | fake-appserver.js:93-97（默认 flat） |
| SUGGESTION | dist/mcp/server.js:327-330 | 移植继承 | server 端 run_workflow 未校验 workdir 缺失：`path.resolve(args.workdir \|\| '')` 空值时得进程 cwd，目录存在即通过——若客户端不强制 inputSchema required，fix 类 workflow 可能在 server cwd（插件目录）写文件。CLI 侧有校验（bin/zsub.js:130）、源 dynamic-workflow 同病（照源不豁免） | server 侧补 `if (!args.workdir) return errContent('缺少必填参数 workdir')`，与 task 校验对齐 | 源 dist/mcp/server.js:128-130 同款 |
| SUGGESTION | lib/model-router.js:126-135；README.md:61-66 | 已知边界 | model 路由仅支持 builtin:bigmodel-coding-plan 单 provider（其余显式报错）——README「已知边界」未声明，用户带其他 provider 的 agent .md 会撞可操作错误但无预期 | README 已知边界补一条；或对照 v2 config 支持多 provider 写入隔离 HOME（bootstrap 只写单 provider 的设计决定需要文档化） | model-router.js:129-134 |
| SUGGESTION | lib/config.js:51 | 已知边界 | `idleConversationTtlMs` 定义后零消费（grep 全库唯一命中即定义处）——apc conversation 会话永不回收，长驻 server 下无限累积 | 接线到 AppServerRunner（idle 超时 session/close + record 终态化），或删常量并在文档声明「无 TTL」 | `grep -rn idleConversationTtlMs` 1 命中 |
| SUGGESTION | lib/workflow/*（runWithLimit）；lib/assemble.js:33 | 并发语义 | 双并发池不合并：workflow 用自身 maxConcurrent（默认 3），与 manager slots（3）互不感知——3 个 subagent + 1 个 3 并发 workflow = 6 个 zcode 进程，超出 D11 设计上限且文档未声明 | run_workflow handler 共享 manager.slots（经 createRuntime 注入）；或文档声明「两类通道并发独立」 | server.js:350-355（opts.maxConcurrent 直传 workflow） |
| INFO | dist/mcp/server.js:95；README.md:11 | 表述 | 「五 action」全库表述（README/SKILL/server 头注）vs 实际六 action（多 status，pi 无）——pi 对照应标「完全+增强」，同 v2 对照表 #3 的处理方式 | 文档统一改「六 action（pi 五 action + status）」 | pi subagent-tool.ts:74 |
| INFO | lib/manager.js:37-40 | 端口纯度 | manager 直接 require record-store（TERMINAL_STATUSES）与 config——record-store 是声明的「固定实现」域层，可接受，但与头注「不 import 任何端口具体实现」字面冲突；assemble 仍是唯一组装点，架构承诺主体成立 | TERMINAL_STATUSES 移入 ports.js 导出，或头注放宽措辞 | grep 见 §三 |
| INFO | lib/runner-appserver.js:477 | capabilities 真实性 | AppServerRunner 声明 `steering:'session-send'`，但 manager message 门禁 idle-only + runner 内 A5 保守 busy——running 投递从未对外可达，声明向上虚报（SpawnRunner 的 'none' 是正例） | 声明改 'none'（与实际暴露面一致）或加 `runningDelivery:false` 字段，A5 实测后再升 | runner-appserver.js:794-800 |
| INFO | lib/runner-appserver.js:630 | e2e 修正残留 | 超时文案仍写「未观察到终态（state.updated）」——E7 后权威终态信号是 turn.terminal，文案过时误导诊断 | 文案改为 turn.terminal / state.updated 并列 | 同文件 :159-168（interpretEvent 已修） |
| INFO | lib/workflow/run-phase.js:36 | 注释准确性 | 注释「per-home 互斥链挂在实例内——复用单例让并发排队」不准确：poolMutex 是模块级 Map（model-router.js:66），4 处各自 new 的实例共享同一条链——行为正确且比注释声称的更强 | 修注释为「模块级互斥链」 | model-router.js:66 |
| INFO | test/e2e.test.js:207-252 | 验收覆盖 | E2 只验证 mailbox 文件级合法，H3 承诺的「无头两轮 resume 验证（引擎真实 drain）注入」未做——「投递合规」已证、「注入可达」仍靠 v2 历史实测背书 | 补无头 resume 两轮注入验证，或在 DESIGN 标注该验证由 v2 实测背书 | DESIGN-v3.md §4.1 H3 |
| INFO | README.md:61-66 | 已知边界 | mailbox drain 单次 20 条窗口 + 坏文件永久阻塞语义：notifier 已按单调文件名防挤窗、原子写防毒文件，但 README 已知边界未列（用户侧若手工放置坏文件仍会砖死会话 drain，zsub 无法自愈） | README 已知边界补一句（指向引擎行为，非 zsub 缺陷） | notifier-mailbox.js:30-40 头注已有 |
| INFO | lib/prompt-builder.js:42-52 | 对照表述 | skills 注入实现为「路径列表 + 按需 read 指引」而非对照表所说「SKILL.md 内容拼 prompt」——实现更优（省 token），表述与实现不一致 | 对照表措辞对齐实现 | 对照表 #17 |

## 附：核验中执行的命令与探针（可复现）

1. **MUST_FIX-1 复现**：`printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' | ZSUB_ROOT=$(mktemp -d)/r ZCODE_MAILBOX_ROOT=$(mktemp -d)/m ZSUB_ZCODE_CLI=/nonexistent node dist/mcp/server.js >/dev/null` → stderr 含 `reaper 启动清扫失败（不影响服务）: Cannot read properties of undefined (reading 'length')`。
2. **MUST_FIX-2 / SUGGESTION-6 探针**（/tmp/zsub-probe-race.js，真实 RecordStore + MailboxNotifier + 受控 FakeRunner）：并发两个 message → 第一个 round=2、第二个 busy（单进程 CAS 安全）；message 后 cancel → record cancelled，随后放行 resume done → **第 3 封「[subagent 完成]」通知仍发出**、rounds 虚增为 2。
3. **单测全量**：`node --test test/{domain,execution,manager,notify,server,worktree,appserver,workflow-base,workflow-a,workflow-b}.test.js` → 149 pass / 0 fail（e2e 未跑，真实模型成本）。
4. **Z1 实测**：`node -e "console.log(require('./dist/mcp/server.js').buildTools().map(t=>[t.name,t.description.length,JSON.stringify(t.inputSchema).length]))"` → zsub [715,1063]、run_workflow [923,1810]，合计 4527。
5. **#14/#18 零消费**：`grep -rn "\.tools\b\|maxTurns\|disallowedTools\|disallowed-tools" lib bin dist --include=*.js` → 命中仅 agent-md-resolver.js（解析）与 ports.js（JSDoc）；driver.js:205-207 argv 无 --disallowed-tools。
6. **pi 蓝本**：`main/extensions/universal/subagent-workflow/src/`——subagent-service.ts:1410-1420（深度分层）、session-runner.ts（grep SIGKILL 仅注释，kill 语义为 SIGTERM+watchdog）、worktree-manager.ts:295-317（add -A + diff --cached base）、notifier.ts:271-274（patch hint 文案）、subagent-tool.ts:74/145-155（五 action/message 语义）。
