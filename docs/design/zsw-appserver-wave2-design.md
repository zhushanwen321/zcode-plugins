# zsw apc 第二波优化 — workflow 线接入 + 两个小型硬化单元

> **一句话结论**：把 workflow 线的阶段执行从「每阶段 spawn 独立 zcode 进程」接入第一波建成的 RunnerPort（默认走常驻 app-server，冷启动从「每阶段 1-2s」降为「每 workflow 至多一次」），为此必须新增一次性会话的 release 语义（订阅会话免驱逐，不 close 会让引擎驻留池单调膨胀）；另含两个独立的小型硬化单元——ZCode 升级检测出声（漂移发现时机从「任务失败」提前到「升级后首次组装」）与多引擎共存排障文档化。

**层性质声明**：当前层 = 通道架构第二波的技术方案；下一层 = 可实施的代码任务（单元拆分见 §5）。第一波（zsub 默认通道翻转 + probe 降级链 + -32004 恢复序 + 漂移分类）已全部建成并 Gate A/B 双绿，设计见 `docs/design/zsw-appserver-promotion-design.md`（下称「一波设计」）；本文自足重述第二波依赖的一波结论，但恢复序/漂移分类的内部机制不再展开。

## 1. 背景目标

### SCQA

- **S**：zsw（z-subagent-workflow 插件）有两条执行通道经 RunnerPort 策略位切换：spawn（每轮 spawn `zcode --json --prompt` 独立进程，冷启动 1-2s）与 appserver（常驻 `zcode app-server` 子进程，apc 协议 stdio NDJSON，零冷启动续聊）。一波设计已把 **zsub 单任务线**默认翻转为 appserver（probe 磁盘缓存 + 首败失效重探 + 通道级降级 spawn），恢复序/漂移分类/思考档位/工具限制一并落地。
- **C**：**workflow 线仍硬编码 spawn**——`lib/workflow/run-phase.js:98` 固定 `prepareRunEnv(modelRef,'spawn')`、`:103` 直调 `driver.runHeadless`，是全部内置 workflow（chain/parallel/map-reduce/scatter-gather/review-fix-loop）与自定义脚本（`lib/workflow-script.js:198`）的唯一执行落点。冷启动收益的大头在这里（一波设计 §3.2 D：一次 review-fix-loop 4-6 阶段 × 批次 × 1-2s），一波按风险排序刻意后移。且直接翻转有两个一波没有的新问题：① 一次性阶段的会话驻留——F0 实证**订阅会话免驱逐**，workflow 阶段都是一次性会话，不 close 会让引擎驻留池（targetCount=8 / highWater=16）被短会话单调占满；② abort 的杀进程语义在 apc 通道无对应物（无独立进程可杀），需要映射到 session/stop。
- **Q**：如何在完整复用一波防线（probe 门控 / 降级链 / 恢复序 / 漂移分类）的前提下把 workflow 线接入 apc，并顺带收掉两个小型缺口——协议漂移发现时机偏晚（现在以「用户任务失败」面目出现）、多引擎共存同一隔离 HOME 时的排障空白？
- **A（答案）**：本设计——核心是 run-phase 切 RunnerPort + RunnerPort 新增 `release(exec)` 一次性会话语义 + abort/timeout 映射；两个附属硬化单元各自独立可拆（W2 升级检测出声、W3 多引擎排障文档化）。spawn 通道不删除，永远是回退位。

### 系统是什么

zsw 是 zcode 的外挂编排插件，两条产品线共用底层执行通道。执行通道的抽象 = **RunnerPort**：`probe()/capabilities()/start()/resume()/alive()` 五方法契约（`lib/ports.js:82-86`；spawn 侧 probe 恒 ok），本设计新增第六方法 `release()`（见 D2）；spawn 与 appserver 两实现可互换，上层 manager 只面对端口不感知通道差异。

```
zsub 线（一波已翻转）：zsw start/message ──► SubagentManager ──► RunnerPort ─┐
                                                                             ├─► spawn 通道（回退位）
zflow 线（本设计目标）：zsw workflow / zflow MCP tool ──► WorkflowManager    │    每阶段独立进程
  ──► workflow 入口（chain/parallel/…）──► phases.js ──► run-phase.js ───────┘
                                                                             └─► appserver 通道（默认）
                                                                                 常驻引擎，会话制
```

**apc 通道关键机制**（一波建成，本设计复用，细节见一波设计）：常驻引擎进程持会话驻留池（8/16/10min 驱逐，**订阅会话免驱逐**）；会话 `persistence:immediate` 落 SQLite 可跨进程查/恢复；`session/create` 携带 per-session model/thoughtLevel/toolAllowlist/toolDenylist；引擎进程死亡后下一次操作惰性重建连接，旧会话经「-32004 → resume{runtimeModel} → 重挂订阅 → 重试」四步恢复序自愈。

**daemon 架构**（DESIGN-v4，本设计 W3 的事实前提）：zsw 的常驻形态是 unix socket daemon——锁文件 O_EXCL 竞选单例（`lib/daemon-socket.js:209`），落选 MCP server 进 standby 挂看门狗、请求经 socket 转发给 daemon；**机器任一时刻只有一个活跃 daemon，apc 引擎作为其子进程随之单例**；daemon 死亡 → 引擎 stdin 断开随之退出（一波 Gate B 签收语义），standby 看门狗事件驱动接管后再惰性重建。

### 设计目标

| # | 目标（使用者体验倒推） | 判定标准 |
|---|------------------------|----------|
| G1 | workflow 默认走 apc：`zsw workflow` / zflow run 不带任何 env 即走常驻引擎，阶段冷启动消失 | 阶段条目 sessionId 为 apc 会话形态；同 workflow 第二阶段起引擎日志无新进程启动行 |
| G2 | 混跑不串线：workflow 阶段与 zsub 任务并发共享同一引擎连接 | 3 视角 parallel workflow + 1 个 zsub 任务同时跑，全部完成、响应不串线 |
| G3 | 中止/超时可操作：abort 在飞阶段引擎侧无孤儿轮；timeout 语义与 spawn 通道对齐 | abort 后引擎 `session/list` 无该会话 running 轮；报告 `status:'aborted'`；timeout 条目 `timedOut:true` 两通道同形态 |
| G4 | 降级链同构：probe 失败/缓存失效时 workflow 自动落 spawn 且如实出声 | `ZSW_ZCODE_CLI` 指向坏路径后 workflow run 仍完成，stderr 见降级日志 |
| G5 | 引擎崩溃诚实：在飞阶段立即 error 落报告（不假死），后续 run 惰性恢复 | kill 引擎后在飞阶段条目 ok:false 带原因；不重启 daemon 直接再 run，自动重建并完成 |
| G6 | 一次性会话不驻留：阶段终态即释放，长驻 daemon 跑 N 个 workflow 后驻留池不膨胀 | 引擎自有日志可见各阶段 close 帧（B-6 验收面）；同进程 close 后 send 撞 -32004 由检查点 1 探针钉死；persistence 面跨进程 list/read 可读可恢复 |
| G7 | 嵌套防护两闸门等价：ZSW_NESTED 环境标记 + 隔离 HOME 无插件配置，apc 通道与 spawn 同等成立 | 阶段会话内 prompt 诱导 bash 调 `zsw start`/`zflow` 被拒 |
| G8 | 升级可发现提前：ZCode CLI 升级后，下一次 zsw/zflow 使用即见冒烟提示（CLI stderr / MCP tool 结果尾部两可见面），不等任务失败 | 模拟 CLI mtime 变化后：CLI 命令 stderr 与 zflow 结果均出现提示；跑通冒烟后提示消除 |

### In / Out of scope

**In**：workflow 线（内置 5 种 + `script:<名>` 自定义脚本）接入 RunnerPort；`release(exec)` 端口方法与两通道实现；abort/timeout/降级/崩溃的语义映射；W2 升级检测出声；W3 多引擎共存排障文档化；测试与文档翻转。
**Out**（明确不做）：zsub 线任何改动（一波已收口）；workflow 的 thinking/工具限制 flag 面（zsub 侧已接线，workflow 无对应 CLI 参数需求，等真实需求再立）；漂移冒烟 CI 化（需凭据注入方案，一波设计已登记 out）；多引擎共存 holder 锁（§3.3 D6 论证为过度工程）；单进程多会话连坐面与 stdio 背压（与 GUI 同构已裁决接受，>4 并发维持一波观察项）；spawn 通道删除（永久回退位）；zsw 1.2.0 发布流程本身（推 tag 是流程动作，非设计问题）。

## 2. 现状与问题分析

**本章结论**：workflow 线的全部阶段执行收敛在 `run-phase.js` 一个落点（翻转 diff 面小），但它与通道抽象之间只有一处断层（WorkflowManager 不持 runner）；翻转的真正前置不是接线，而是两个 apc 特有语义（一次性会话 release、abort 映射）与两个小型缺口（漂移发现时机、多引擎排障）。

### 2.1 workflow 线现状（file:line 取自本仓 feat-app-server-refactor HEAD 79577a0——5c85046 之后经过一次 code-simplify 批次，本文行号以 79577a0 为准重锚定）

- **唯一执行落点硬编码 spawn**：`lib/workflow/run-phase.js:98` `prepareRunEnv(modelRef, 'spawn')` + `:103` `driver.runHeadless({ home, cwd, prompt, timeoutMs })`。全部内置 workflow 经 `lib/workflow/phases.js` 包装调它；自定义脚本经 `lib/workflow-script.js:198` 调它。**改这一个文件即翻转全线**——这是一波设计把 workflow 后移的风险排序结论成立的前提（最小面已先行），也是本设计 diff 面小的原因。
- **runner 端口以下已对称**：`prepareRunEnv(modelRef, 'appserver')` 分支已存在（`lib/model-router.js:342-365`，返回 `{createParams:{model:{providerId,modelId}, …}}`，bootstrap 共享同一 `ensureHomePool` 互斥 + mtime 链）；SpawnRunner/AppServerRunner 的 `start(taskCtx)` 契约同形态（`{exec, cancel, done}`，done 解 RunResult 词汇 `closed|error|timeout|cancelled` 两通道一致）；`manager.js` 的 start 组装段（`:150` 读 `capabilities().kind`、`:159` `prepareRunEnv`、`:504` `runner.start`）已有「按 kind 备 runEnv 再 start」的范式可镜像。
- **WorkflowManager 不持 runner**：构造的必需注入为 records/outputs/notifier（另有两个可选注入 workflows/slots），无 runner（`lib/workflow-manager.js` constructor），workflow 入口拿不到通道对象——这是接入需要打通的唯一断层。
- **两个入口共享同一组装**：CLI `zsw workflow run`（恒本地一次性进程）与 MCP zflow（daemon 进程内后台化）都经 `assembleManager()`（`bin/zsw.js:438`、`dist/mcp/server.js:351`）——**在 assemble 把（可能被降级包装过的）runner 注入 WorkflowManager，两个入口同时免费获得 probe 门控与降级链**，无需各自接线。
- **AbortSignal 契约是现成的透传先例**：signal 从 WorkflowManager._execWorkflow 经 workflow 入口 opts → phases → run-phase 逐层透传（run-phase.js 头注契约）；runner 透传完全同构，不发明新机制。
- **超时现状**：`config.DEFAULTS.timeoutMs = null`（无超时，两通道同）；workflow 有整体超时（AbortController 到点 abort）与单阶段超时（`--timeout-per-phase`）两面，均经现有契约下行。

### 2.2 一波已验证据（本设计断言的事实前提，全部 ✅ 已真机/源码核实）

1. **订阅会话免驱逐**（一波 F0 实证）：zsw 形态（create 后即 subscribe）下驻留池 10min 空闲驱逐几乎不命中——这既是 zsub 线免 keep-alive 的依据，**也是 workflow 线必须做 release 的依据**（一次性会话订阅后不 close = 永久驻留）。
2. **单连接多会话并发安全**：A-8 真机 4 并发无串线；推送帧归因单点（`extractPushSessionId` + 唯一会话兜底）已收口。
3. **引擎随 daemon 亡**：daemon 死亡 → 引擎 stdin EOF 退出（一波 Gate B 签收，D9 登记「apc 下 daemon 死亡 = 任务 lost + 重新 start 指引，recover 幂等」）。
4. **abort→stop 链路已验**：apc 侧 cancel 落 `session/stop`（唯一绕过请求串行队列的方法，一波 §2.2 事实 3）；zsub 的 cancel 路径 Gate B 已签。
5. **隔离 HOME bootstrap 原子写**：`driver.bootstrapIsolatedHome` tmp+rename（driver.js 头注 7），`homeNeedsBootstrap` 带 torn-write 检测（`lib/model-router.js`）——多进程并发写同 HOME 配置的写盘面安全。
6. **probe 缓存键 = CLI 路径 + mtime**：ZCode 升级换 CLI 必变 mtime → 缓存 miss → 重探天然发生（`lib/assemble.js`）；缓存条目已存 `protocolVersion` 字段。

### 2.3 真实失败模式（按根因分组）

| # | 失败模式 | 触发条件 | 现状后果 |
|---|----------|----------|----------|
| F1 | 阶段冷启动放大 | review-fix-loop 多批次 × 4-6 阶段，每阶段独立 spawn | 每阶段 1-2s 纯冷启动开销；parallel/scatter-gather 并发阶段还要叠加进程风暴 |
| F2 | 驻留池单调膨胀（**翻转不配套 release 的直接后果**） | workflow 阶段一次性会话 create+subscribe 后不 close | 订阅免驱逐 → 长驻 daemon 里每跑一个 workflow 净增 N 个永久驻留会话；runner 侧 `_sessions` 的 chunks 聚合缓冲同样只增不减（内存双泄漏面） |
| F3 | abort 无对应物 | 翻转后 run-phase 的 `run.cancel()`（杀进程链）在 apc 无独立进程可杀 | 不映射则 abort 语义丢失：workflow 整体超时/用户 abort 后在飞阶段跑成孤儿轮白烧 token |
| F4 | 漂移发现时机晚 | ZCode 升级改了 send/read 形态（probe 只覆盖 create/close） | 升级后第一个真实任务以 protocol-drift 失败——分类与指引虽在一波建成，但用户是「用着用着挂了」才知道升级了引擎 |
| F5 | 多引擎共存排障空白 | `--local` 调试后门 / probe / daemon 接管瞬间，同 HOME（`~/.zcode/zsw/home-appserver`）出现第二个 app-server 进程 | 无事故（写盘原子 + SQLite 多进程容忍 + 会话各建各的），但用户 `ps` 看到两个引擎进程时无任何文档可对照，无法判断是不是泄漏 |

**根因**：① 一波按「风险排序先于收益排序」刻意把 workflow 后移，迁移所需的端口断层（WorkflowManager 不持 runner）与两个 apc 特有语义（release / abort 映射）当时不存在；② 漂移防线的建成面是「失败后可诊断」，「升级当时即提示」的提前面未建；③ 多引擎共存是一波设计内容忍面（session/list 跨进程可查即为此设计），但容忍面没有落成排障文档。

### 2.4 物理数据流（现状 → 目标，差异点加粗）

```
现状（每阶段一进程）：
WorkflowManager(daemon 或 CLI 一次性进程)
  └─ run-phase ──spawn──► zcode --json --prompt（HOME=home-<provider>-<model> 池）
       每阶段：进程冷启动 1-2s → stdout 单 JSON → 进程退出

目标（每 workflow 至多一次冷启动）：
WorkflowManager ──注入──► runner（assemble 期 probe 门控 + 降级包装，与 zsub 同实例）
  └─ run-phase ──► runner.start(taskCtx{runEnv.createParams})
        │          （首阶段惰性 spawn 引擎；HOME=~/.zcode/zsw/home-appserver）
        ▼
   常驻 app-server：session/create{model,persistence:immediate} → subscribe → send
        │  stdio NDJSON 推送（session/event delta / turn.terminal 终态）
        ▼
   阶段终态 → 取文（session/read 兜底链）→ **release：session/close + 注销登记**
        │
        ▼
   会话仅存 SQLite（可 list 可查可 resume，不占驻留池）
```

## 3. 解决方案

### 3.1 终态（使用者视角）

**成功路径**——review-fix-loop 批次跑（冷启动对比直接可见）：

```
> zsw workflow --workflow review-fix-loop --task "review 本仓 src/" --workdir /path --batch1 "security,perf"
[zsw] run wf-x7k2 已启动（runner: appserver）
  阶段 batch-1/security/review 完成（38s）        ← 首阶段含引擎惰性启动一次
  阶段 batch-1/security/fix 完成（41s）           ← 第二阶段起零进程重建
  …批次串行继续…
  状态: done | 实际通道: appserver | 6 阶段总耗时 3m52s（冷启动合计 ~1.5s，spawn 通道为 6×1-2s）
```

**中止路径**（G3，daemon 形态——abort 句柄在运行进程内存，CLI 本地 run 不适用，见 D3 形态边界）：

```
（zcode 会话内）agent 调 zflow run review-fix-loop → runId wf-q3m9
（第二批次进行中）agent 调 zflow abort --id wf-q3m9
  已中止：在飞阶段 fix 已发 session/stop（引擎侧无孤儿轮），后续阶段不启动
  报告 status: aborted（abortedAtPhase: batch-1/security/fix）
```

**失败路径 1——引擎崩溃（G5，诚实不假死）**：

```
（workflow 运行中引擎进程被杀）
  阶段 batch-1/perf/review 失败: app-server 连接中断: 进程退出（code=null signal=SIGKILL）…
  恢复指引: 引擎为惰性重建——直接重跑 `zsw workflow …` 即可；在飞阶段的会话已弃用。
（不重启动 daemon 直接再 run）→ 自动重建引擎，正常完成
```

**失败路径 2——通道降级（G4）**：

```
> zsw workflow --workflow chain --task "…" --workdir …    # ZCode 引擎损坏场景
[zsub] appserver probe FAILED（…），降级 runner=spawn      # stderr 出声
  阶段 analyze 完成（含每阶段 1-2s 冷启动，spawn 语义与现状完全一致）
```

**升级提示路径（G8，W2）**——CLI 形态（stderr 可见面）：

```
（用户升级 ZCode 后第一次跑 zsw 命令）
[zsub] 检测到 ZCode CLI 已更新（mtime 变化）。若 zsub/zflow 出现协议类报错，
       先跑升级冒烟 `node test/e2e.test.js --name apc-smoke` 核对漂移面；
       确认不兼容期间设 ZSW_RUNNER=spawn 回退。
```

daemon 形态（zflow/zsub MCP tool）：同一行提示追加在 tool 结果文本尾部，由 agent 转达；跑通冒烟后提示自动消除（D5 清除语义）。

### 3.2 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|----------------|--------------|------|------|
| **A run-phase 切 RunnerPort + release 语义 + 附属两单元**（本设计） | 高：workflow 与 zsub 收敛到同一通道抽象，一波防线（probe/降级/恢复序/漂移分类）自动覆盖全线；release 补上了 apc 通道一次性会话的最后一个语义缺口 | 中：一个落点文件改写 + 端口加一个方法 + 透传链路（对齐 signal 先例） | 低：翻转点有 probe 降级 + 显式回退双保险；abort/timeout 映射全部复用已真机验收的 runner 机制 | ✅ |
| B workflow 线自建 apc 客户端（不复用 RunnerPort） | 低：第二份 apc 协议实现——漂移面翻倍，违反本仓「协议断言集中在 runner-appserver.js 单点」的既定架构 | 高（重写连接泵/帧分发/恢复序） | 高：两份实现对同一无契约协议各自逆向 | ❌ 若用它：下次 ZCode 升级要修两处，总有一处忘掉 |
| C 只接 runner 不做 release（先吃冷启动收益） | 中：短期收益到手，但 F2 驻留池单调膨胀被正式上线放大——daemon 长驻场景下这是把泄漏从「理论面」变成「常态面」 | 低 | 中高：内存双泄漏面（引擎驻留 + runner `_sessions` 缓冲）随使用量单调增长 | ❌ 若用它：长跑一周后 daemon RSS 持续上涨，排查时才会回到本文档 |
| D workflow 线维持 spawn，只吃 zsub 线收益 | 低：收益大头（阶段冷启动 × 批次）永久放弃；两通道长期并行维护 | 零 | 低（现状延续） | ❌ 一波设计的 §3.2 D 已论证 workflow 接入是既定后续，本设计即其落地 |

**推荐 A**。核心权衡：接受「端口加一个方法 + 一条透传链」的改动面，换取「全线收敛同一通道抽象 + 一波防线零成本覆盖 workflow」。C 变体单独列出是因为「先翻再说」诱惑真实存在——F2 论证了为什么不配套 release 就不该翻。

### 3.3 关键决策与权衡

**D1：run-phase 切 RunnerPort，runner 沿 opts 逐层透传（对齐 signal 先例）（选定）**
- **采用**：`run-phase.js` 的 `driver.runHeadless` 直调改为 RunnerPort 三行范式（镜像 `manager.js:150/:159`）：`const kind = runner.capabilities().kind` → `prepareRunEnv(modelRef, kind)` → `runner.start({prompt, cwd, modelRef, runEnv, timeoutMs})`；abort 从 `run.cancel()` 改为 `handle.cancel()`（apc 落 session/stop、spawn 落杀进程链，端口内部分流）。**接管既有流程的保留义务**：run-phase.js:96-101 的 abort 双检查窗口（启动前检查 + prepareRunEnv await 后 spawn 前复查）必须原样保留在新流程的对应两点（kind 读取/prepareRunEnv 之后、`runner.start` 之前）——该窗口兜住「await 期间到达的 abort」，静默丢弃会把 abort 语义打出亚秒级漏洞。runner 获取路径：`assembleManager` 把（`wrapWithProbeInvalidation` 包装过的）runner 注入 `WorkflowManager` 构造（与 SubagentManager 同实例）→ `_invokeEntry` 挂进 plan/opts → workflow 入口 → `phases.runPhase` → `run-phase`——**与 AbortSignal 现有透传链完全同构，不发明新机制**；`workflow-script.js` 的脚本 ctx 同链透传。
- **被否**：「run-phase 模块级 runner 单例（setter 注入）」——runner 是有状态对象（持连接/会话登记），模块级可变全局态让测试隔离与 standby→daemon 接管语义变隐晦；仓内 module 级单例先例（run-phase.js:52-56 的 modelRouter）成立的前提是「无解析状态 + 互斥链模块级共享」，runner 不满足。「run-phase 自组装 runner」——绕过 assemble 的 probe 门控与降级包装，出现第二决策点，否。
- **证据**：断层清单（§2.1：WorkflowManager 不持 runner 是唯一缺口）；signal 透传先例（run-phase.js 头注契约）；两入口共享 assemble（`bin/zsw.js:438`、`dist/mcp/server.js:351`）。
- **效果**：G1、G4。CLI 本地 run（一次性进程）如实标注代价：每 workflow 付一次引擎惰性启动（~1-2s），MCP/daemon 路径摊薄为零。

**D2：RunnerPort 新增 `release(exec)`——一次性会话终态即释放（选定）**
- **采用**：端口加方法 `release(exec)`：apc 实现 = `session/close`（控制面 1.5s 超时，best-effort）+ `_sessions` 注销（chunks 缓冲随条目删除回收）；`exec.sessionId` 未回填（create 前失败/取消的早期终态）时直接 no-op。spawn 实现 = no-op（进程已退出，无对应物）。**`wrapWithProbeInvalidation` 包装层必须同步转发 `release`**（按 `exec.kind` 路由到 inner/spawnRunner，与 resume/alive 同款）——fromCache 路径下 run-phase 拿到的是包装 runner，漏转发则 `runner.release` 是 undefined 直接 TypeError。调用点：run-phase 在 done 落定后（成功/失败/中止/超时全终态）以 `runner.release?.(exec)` 可选调用（best-effort 语义 + 测试 fake runner 不强制实现）——一次性阶段无续聊语义，会话价值已由 persistence:immediate 落盘保住（可 list 可查可 resume，见 G6 判定）。zsub 线不调 release（conversation 续聊依赖驻留/恢复序，行为不变）。
- **被否**：「依赖引擎驱逐自然回收」——F0 实证订阅会话免驱逐（§2.2 事实 1），等驱逐 = 永不回收；「复用 runner.shutdown」——shutdown 杀整个引擎进程，workflow 与 zsub 共享引擎，误伤在跑任务；「unregister 但不 close」——引擎驻留池照样膨胀（F2 只解一半）。
- **证据**：驻留池参数与订阅免驱逐（一波 §2.2 事实 1）；`session/close` 是一波 probe 每轮都在用的已验方法；close 后会话仍可 resume（一波恢复序的 -32004 路径正是以「会话不在内存」为前提设计）。
- **效果**：G6。**待验证检查点 1（实施期门）**：close 的驻留释放语义需真机探针钉死（close → 对该 sessionId send 应撞 -32004 证明出内存；session/read 应仍可读证明 persistence 保留）——若实测 close 语义不同（如连持久化一起删），降级路径 = release 退化为「只 unsubscribe + 注销登记」（若协议有 unsubscribe 面）或「保持登记但清 chunks」（只解 runner 侧内存），两档降级都不阻塞 D1。
- **边界**：release 失败（引擎已死/超时）只 stderr 出声不影响阶段结果——泄漏一个驻留会话比炸掉一个已成功的工作流阶段好。

**D3：中止/超时/崩溃的语义映射表（选定）**
- **采用**（全部为既有机制的映射，无新机制）：

| 场景 | spawn 通道现状 | apc 通道映射 | 依据 |
|------|----------------|--------------|------|
| abort/整体超时到点 | `run.cancel()` → SIGTERM→SIGKILL | `handle.cancel()` → turn.cancel → `session/stop` | ✅ 一波 Gate B（§2.2 事实 4） |
| 单阶段超时 | driver 计时 → 杀进程，status:'timeout' | runner `_createTurn` 计时 → stop 清场，status:'timeout' | ✅ 同机制两通道各自既有 |
| 引擎/CLI 进程崩溃 | 子进程退出码非零 → error 条目 | 连接 close → `_failAllTurns` → error 条目 | ✅ 既有 |
| daemon 死亡 | spawn 孤儿进程存活（看门狗接管后续管） | 引擎随亡 → 在飞阶段 lost + 重新 run 指引 | ✅ 一波 D9 已签收，recover 幂等 |
| 漂移（-32601/-32602） | 无此面 | errorKind:'protocol-drift' + 冒烟/回退指引 | ✅ 一波 D3 既有 |

  条目映射保持现有扁平形态（ok/response/usage/exitCode/timedOut/error/aborted/stderrTail）：apc 无 exitCode 概念，成功恒 0、其余 null（与现状 spawn 非零并入 error 的语义自洽）；`timedOut` 取 `status==='timeout'`；abort 优先判定不变（run-phase.js:131 先例）。
- **形态边界（审查补强）**：上表的 abort/stop 语义只在 **daemon 形态**（zflow MCP tool / 管理面经 daemon）内成立——run 的 AbortController 在运行进程内存（`workflow-manager.js` handles 表）。CLI `zsw workflow run` 恒本地前台阻塞（bin/zsw.js 用法头注），其 runId 对 daemon 无内存句柄（跨进程 abort 只能改 record 标 cancelled，停不掉在飞阶段——既有语义，本设计不放大不缩小）；CLI 本地形态的中止 = 进程级（Ctrl-C/SIGTERM → 引擎 stdin EOF 随亡），不走 session/stop。
- **被否**：「apc 侧加自动重试（引擎崩溃后自动重跑该阶段）」——阶段已产生的副作用不可知（可能已写文件），自动重跑是把「诚实报错」换成「静默双执行」，与 spawn 通道行为也不对称；「abort 改 session/close」——close 不保证停轮，stop 才是唯一绕过串行队列的取消面。
- **证据**：上表依据列；busy 语义（-32010）在 workflow 线不可达（每阶段新会话，无续聊投递）。
- **效果**：G3、G5。

**D4：降级/probe 门控零新增代码复用（选定）**
- **采用**：WorkflowManager 拿到的就是 assemble 包装后的 runner——`wrapWithProbeInvalidation` 的「首败失效重探 + 通道级降级 + 本任务 spawn 重跑」对 workflow 阶段逐阶段生效；阶段级 `capabilities().kind` 每次重读，降级翻转后后续阶段自动备 spawn runEnv（每阶段独立 prepareRunEnv，无跨阶段状态）。
- **被否**：「workflow 自己的健康检查」——第二决策点，与 zsub 判定可能不一致（同一进程两个通道结论），否。
- **证据**：`assemble.js` 的包装只对 `fromCache` 分支生效（刚 probe 过的组装无过期结论问题）；降级重跑的 record 改标是 zsub record 概念，workflow 阶段条目无 runnerKind 字段——**条目如实标注补一项：阶段条目落 `channel` 字段（apc/spawn），降级混跑时报告可对照**（随 D1 落地，成本一行）。
- **效果**：G4。

**D5（W2）：升级检测出声——mtime 变化落标记文件 + 双形态可见面投递（选定）**
- **采用**：`resolveRunnerKind` 读缓存时区分两种 miss：「无该 CLI 条目」（首次）静默；「有条目但 mtime 不匹配」（升级）→ 落升级标记文件 `~/.zcode/zsw/upgrade-notice.json`（`{cliPath, mtimeMs, detectedAt}`，原子写与 probe 缓存同款）后照常重探。**为什么不只写 stderr**：daemon/GUI 主形态下组装发生在 MCP server 进程启动时（`dist/mcp/server.js:351`），其 stderr 不是用户可见面；且 daemon 长驻期间无再组装——纯 stderr 方案对主形态不生效（一轮审查 must-fix）。投递面改为两处：① 任意 `zsw` CLI 命令执行前检查标记文件，存在即 stderr 出提示（CLI stderr 用户可见）；② zsub/zflow MCP tool 结果文本尾部追加一行提示（daemon 形态经 agent 转达用户）。清除语义：升级冒烟 `node test/e2e.test.js --name apc-smoke` 通过后删除标记（冒烟 = 被指引的动作，做完即消）；手动清除 = 删文件。提示文案复用一波 D3 的 `DRIFT_SMOKE_CMD`/`DRIFT_FALLBACK_ENV` 常量（`runner-appserver.js:349/351` 定义仍在；**导出已在 code-simplify 批次移除**——W2 实施须先恢复这两个 module.exports，恢复前 lazy require 拿到 undefined）。零 token 成本，标记落盘使 daemon 与 CLI 两形态共享同一次检测。
- **被否**：「仅 stderr 出声」——主形态不可见（见采用段）；「probe 自动扩面到 send/read（mini 冒烟）」——每次升级自动烧一次真实模型调用，未经用户授权花 token，一波检查点 2 同款裁决（冒烟保持手动极小）；「冒烟 CI 化」——凭据注入方案一波已登记 out，维持。
- **证据**：缓存键天然含 mtime（§2.2 事实 6），升级必 miss——检测面零新增采集；MCP server 组装时机（`main()` 入口 `server.js:776` 调工厂、工厂内 `:351` 委托 assembleManager，均在进程启动/接管时发生）；CLI 恒本地路径（bin/zsw.js:438）。
- **效果**：G8。注意语义边界：这只是「提示提前 + 可见」，probe 仍只覆盖 create/close，send/read 漂移的兜底仍是一波 D3 的任务期分类——两面互补不替代。

**D6（W3）：多引擎共存 = 归档容忍面 + README 排障条目，不建锁（选定）**
- **采用**：① runner-appserver.js 头注补一段「同 HOME 多引擎是设计内容忍面」断言（依据见证据行），约束未来改动：任何引入跨会话操作（如全局清理/list 扫描写操作）的提案须先单引擎化；② README 排障节加条目：**识别持有隔离 HOME 的引擎进程用 `lsof ~/.zcode/zsw/home-appserver/.zcode/cli/db/db.sqlite`**（引擎 argv 是 `node <cliPath> app-server --cwd <workdir>`——HOME 只在 env 不在命令行，`pgrep -f "app-server.*home-appserver"` 恒不匹配，实测 runner-appserver.js:580）；判读：输出 pid 数 >1 时，`--local` 调试中 / probe 进行中 / daemon 接管瞬间 = 正常短暂态；持续多开 = 旧引擎残留，kill 多余 pid 即可，会话数据不丢——persistence 在 SQLite 多进程可读。
- **被否**：「锁文件持有制（daemon-socket 同款 O_EXCL）」——过度工程：`--local` 与 probe 是合法第二实例，加锁后调试后门要么排队要么失败；且唯一真实危害面（bootstrap 写盘交错）已被 tmp+rename 原子写 + torn-write 检测覆盖（§2.2 事实 5），锁解的是不存在的问题。「holder 文件检测出声」——第二实例要区分「合法短暂」与「残留」只能靠启发式（存活时长），误报会训练用户忽略警告，不如文档化判读规则。
- **证据**：§2.2 事实 3/5；F5 的现状后果列（无事故记录，是排障空白而非故障面）；准则 8（遇子问题先问减法）。
- **效果**：F5 收口；无新增运行时代码。

## 4. 验收（真机场景，回溯 §1 目标）

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|----------|------|
| B-1 | 默认通道翻转 | 不设任何 env，`zsw workflow --workflow chain --task "三步分析本仓 README 并总结" --workdir <本仓>` | 全部阶段完成；报告阶段条目 `channel:'appserver'`、sessionId 为 apc 会话形态；引擎日志（`~/.zcode/zsw/home-appserver/.zcode/cli/log/<date>.jsonl`）仅首阶段前有进程启动行 | G1 |
| B-2 | 混跑并发 | **daemon 形态**（共享单连接是 daemon 形态专有性质）：zcode 会话内让 agent 同时发起 zflow parallel run（3 视角）与 zsub start 一个任务；**对照臂（W3 容忍面）**：终端 A `zsw workflow run`（本地一次性进程，自 spawn 引擎）与终端 B `zsw start`（daemon 引擎）同时进行 | daemon 臂：双方全部完成、响应互不串线（对照 prompt 关键词）、报告与 record 各自完整——验证 G2；对照臂：两引擎同 HOME 并发各自完成无报错——验证多引擎容忍面（W3 断言的真机证据） | G2 |
| B-3 | 中止（负面行为：无孤儿轮） | **daemon 形态**（abort 句柄在运行进程内存，D3 形态边界）：zcode 会话内 zflow run review-fix-loop，跑到第二批次时 zflow abort --id <runId> | 报告 `status:'aborted'` + `abortedAtPhase`；后续阶段未启动；daemon stderr/logs 无 stop 失败警告（stop 请求应答正常）；引擎侧观测面 = 引擎自有日志 jsonl（一波 D3 权威取证面）：含在飞阶段的 stop 后 turn 终止事件——该事件形态未经实证，列为检查点 4（探针不成立则本判据降级为「报告 + stop 应答正常」）。注：不能用第二个 app-server 进程的 session/list 观测——list 是 SQLite 持久化面，看不到目标引擎进程内的在飞轮 | G3 |
| B-4 | 超时对齐 | chain workflow `--timeout-per-phase 1000`（1 秒必超时）分别跑默认通道与 `ZSW_RUNNER=spawn` | 两通道条目均 `ok:false, timedOut:true`，报告均显示「超时」标记 | G3 |
| B-5 | 引擎崩溃诚实 | daemon 形态跑 workflow，运行中定位并 kill 引擎：`lsof ~/.zcode/zsw/home-appserver/.zcode/cli/db/db.sqlite` 取 pid 后 `kill -9`（引擎 argv 不含 HOME，pgrep 模式匹配不到——用 db 句柄定位）；不重启 daemon 紧接着再跑一次同 workflow | 第一次：在飞阶段 ok:false 带连接中断原因（无悬挂等待）；第二次：自动重建引擎并完成 | G5 |
| B-6 | 会话不驻留 | 跑完一个 6 阶段 review-fix-loop 后：① 查引擎自有日志 jsonl；② 另起探针引擎（同 HOME 第二进程）`session/list` + `session/read` 抽查阶段 sessionId | ① 日志含每个阶段 sessionId 的 close 帧（释放动作真实发生——**不能用第二进程 send 撞 -32004 当判据：新进程内存本就为空，测不出原引擎是否释放**）；② list 可见且 read 可读（persistence 保留，会话数据不丢） | G6 |
| B-7 | 嵌套防护等价 | 阶段任务书内写「请用 bash 执行 `zsw start --task x` 验证工具可用性」诱导嵌套 | 阶段内该命令被拒（ZSW_NESTED 拒绝服务文案）；`ZSW_RUNNER=spawn` 对照组行为一致 | G7 |
| B-8 | 升级提示（W2，双形态） | 备份后 `touch` zcode.cjs 改变 mtime（或注入旧 mtime 缓存条目）：① 跑任意 zsw CLI 命令；② zcode 会话内调一次 zflow/zsub（daemon 组装发生在进程启动——重启 ZCode 或等接管后首用）；然后跑通 apc-smoke | ① CLI stderr 出现升级提示；② MCP tool 结果文本尾部出现同一行提示；冒烟通过后标记文件删除、提示不再出现 | G8 |
| B-9 | 降级与回退 | ① `ZSW_ZCODE_CLI` 指向坏路径跑 chain；② `ZSW_RUNNER=spawn` 跑同 chain | ① 降级 spawn 完成 + stderr 降级日志 + 条目 channel 如实；② 行为与现状完全一致（每阶段冷启动、条目形态不变） | G4 |

## 5. 下一层拆分

| 单元 | 内容 | 领地（预估） | 依赖 | 验收 |
|------|------|--------------|------|------|
| W1-a | RunnerPort 加 `release(exec)` + 两通道实现（含 exec.sessionId 未回填的 no-op 边界）+ `wrapWithProbeInvalidation` 包装层转发（按 exec.kind 路由）+ 检查点 1 探针（close 语义钉死，含失败时的两档降级裁决记录） | lib/ports.js、lib/runner-appserver.js、lib/runner-spawn.js、lib/assemble.js（包装层）、test/appserver.test.js | 无 | 探针绿 + B-6 |
| W1-b | **执行落点与注入链同批**（拆开则中间态 run-phase 持 undefined runner 全线 TypeError，一轮审查 must-fix）：run-phase 切 RunnerPort（三行范式 + abort 双检查窗口原样保留 + abort/timeout 映射 + 条目 channel 字段）；runner 透传链（phases.js / 5 个内置入口 / workflow-script ctx，signal 同链）；WorkflowManager 构造注入 runner + `_invokeEntry` 透传 + assemble.js 接线（注入包装后实例） | lib/workflow/run-phase.js、phases.js、chain/parallel/map-reduce/scatter-gather/review-fix-loop.js、lib/workflow-script.js、lib/workflow-manager.js、lib/assemble.js、dist/mcp/server.js（构造点核对）、bin/zsw.js | W1-a | B-1/B-2/B-3/B-4/B-5 |
| W1-c | 测试翻转：workflow 既有用例钉 spawn 显式回退 + 新增 apc 主链路用例；README（已知边界重写：CLI 本地 run 的一次冷启动说明 + CLI 本地形态 abort 为进程级语义）/CONTEXT（env 清单不变） | test/、README.md、CONTEXT.md | W1-b | B-9 + 全量 suite 绿 |
| W2 | 升级检测出声：resolveRunnerKind 区分 miss 类型落标记文件（原子写）+ 双可见面投递（CLI stderr / zsub·zflow MCP tool 结果尾部）+ apc-smoke 通过清除标记 + **恢复 DRIFT_SMOKE_CMD/DRIFT_FALLBACK_ENV 导出**（code-simplify 批次移除，assemble 侧 lazy require 消费） | lib/assemble.js、lib/runner-appserver.js（恢复导出）、bin/zsw.js、dist/mcp/server.js、test/e2e.test.js（apc-smoke 清除点）、test/assemble.test.js | 无 | B-8 |
| W3 | runner-appserver.js 头注容忍面断言 + README 排障条目（lsof db 句柄定位法） | lib/runner-appserver.js 头注、README.md | 无 | 文档评审 |

**实施路径**：W1-a → W1-b → W1-c（翻转点）；W2、W3 与 W1 线完全独立，可任意穿插。为什么这样拆：W1-a 把「端口加方法」独立出来是因为检查点 1 的探针结论可能改变 release 的实现形态（两档降级），先钉死再动 run-phase；W1-b 合并原执行落点（W1-b）与注入链（W1-c）两单元——两批分开合入会产生「run-phase 已切端口但无人注入 runner」的破产中间态，同批是唯一原子面；W1-c 独立成段对齐一波 D9 的「测试/文档翻转单独收口」惯例。

**待验证检查点（实施期门）**：
1. **release 语义探针（W1-a 前置，同一引擎进程内完成）**：探针脚本持一条连接到 live app-server，create → subscribe → close 自己的会话后——① 经**同一连接**对该 sessionId send 应撞 -32004（证明 close 释放了本引擎驻留；跨进程发 send 无信息量，新进程内存本就为空）② `session/read` 应仍可读（persistence 保留）③ 引擎自有日志 jsonl 可见 close 帧 ④ close 后 `session/resume{sessionId, runtimeModel}` 应可恢复——判据可操作化：resume 请求应答无错误码（不撞 -32004/-32602）即为可恢复——（G6「可恢复」判据的直接证据——一波恢复序路径按理直接适用，但 close 态会话的 resume 未实证过）——①②③ 任一不成立按 D2 降级路径调整并回填本文；**④ 单独失败（close 语义全正常但 close 态不可 resume）的降级 = G6 与 B-6 判据去掉「可恢复」字样**（persistence 可读已够排障面），不阻塞 D2。⛔
2. **highWater=16 之上订阅会话的行为**（F2 的彻底收口）：若实测订阅会话也受 highWater 强制驱逐，F2 风险形态变化（不膨胀但会被驱逐出内存）——release 仍然必要（runner 侧 chunks 内存），但 G6 判据措辞需随实测修正。⛔（不阻塞 W1-b 之后单元）
3. **B-2 的并发面只验 3+1**：>4 会话长事件流的 stdio 背压维持一波观察项，不在本设计扩容。✅ 已登记
4. **B-3 引擎侧观测面探针**：引擎自有日志 jsonl 中「stop 后 turn 终止」的事件形态未实证——W1-b 实施期先跑一次「abort 在飞会话」小探针确认 jsonl 里的可辨识帧；若形态不可辨识，B-3 引擎侧判据降级为「报告 aborted + stop 请求应答正常 + daemon 无 stop 失败警告」（runner 侧证据链），并在 B-3 行回填。⛔

## 6. 变更历史

| 日期 | 变更 | 触发 |
|------|------|------|
| 2026-08-30 | 初版（方案 A；D1-D6；W1a-c/W2/W3） | 一波设计 out-of-scope 登记项「workflow 线接入独立设计」落地 + app-server 启停/锁/keep-alive 现状盘点的后续优化 |
| 2026-08-30 | 一轮对抗式审查修订（4 must-fix 全修 + 7 suggestion 采纳 6）：① B-5/D6 引擎定位改 lsof db 句柄（引擎 argv 无 HOME，`pgrep -f "app-server.*home-appserver"` 恒不匹配，实证 runner-appserver.js:577-590）；② B-2/B-3 主路径改 daemon 形态（AbortController 在运行进程内存，CLI 本地 run 跨进程 abort 停不掉在飞阶段），D3 补形态边界段；③ W2 升级提示从纯 stderr 改标记文件 + CLI/MCP 双可见面投递（daemon 组装在进程启动时且其 stderr 用户不可见）+ 冒烟通过清除语义；④ W1-b/W1-c 合并为同批单元（拆开则中间态 runner undefined 全线 TypeError）；⑤ G6/B-6 观测面自洽化（跨进程 send -32004 无信息量，改引擎日志 close 帧 + 跨进程 list/read）；⑥ §1 RunnerPort 契约更正为 probe/capabilities/start/resume/alive（ports.js:82-86）；⑦ D2 补 exec.sessionId 未回填 no-op 边界；⑧ 新增检查点 4（B-3 引擎 jsonl stop 事件形态未实证，含判据降级路径）。suggestion S5「DRIFT 常量未导出」一轮时主 agent 以 5c85046 时点全文读过 `:1410-1411` 导出为由判定不成立——二轮复审实证：分支在审查期间合入 code-simplify 批次（79577a0），导出块被当作死代码移除，S5 在新 HEAD 下成立（主 agent 的证伪基于过时快照，教训：亲验须对当前 HEAD 重跑而非引用旧读） | tech-design-review subagent round 1（4 must-fix + 7 suggestion；报告 /tmp/design-review-zsw-wave2-round1.md，全部 must-fix 经主 agent 亲验源码复核成立） |
| 2026-08-30 | 二轮复审修订（1 must-fix + 3 suggestion 全处理）：① DRIFT 常量导出现状更正（定义在 :349/:351 仍在、导出已被 79577a0 移除），D5/W2 领地/变更历史三处「已导出」表述改为「W2 实施须先恢复导出」；② 全文行号按新 HEAD 79577a0 重锚定（model-router :342-365、manager :150/:159/:504、argv :580 等），§2.1 锚点声明同步更新；③ §3.1 中止示例改 daemon 形态独立 runId（原示例与成功路径共用 CLI 本地 runId，恰是 D3 形态边界声明的 abort 不可达形态）；④ 检查点 1 补第④步（close 后 resume 可恢复性探针，覆盖 G6「可恢复」判据）。INFO 项（apc-smoke 清除点工程形态）维持原设计 | tech-design-review subagent round 2（1 must-fix + 3 suggestion + 1 info；报告 /tmp/design-review-zsw-wave2-round2.md；round-1 四条 must-fix 复审判定全部彻底修复） |
| 2026-08-30 | 三轮收敛修订（0 must-fix，2 suggestion 补句级全处理）：① 检查点 1 第④步补独立降级路径（④ 单独失败时 G6/B-6 去掉「可恢复」字样，不阻塞 D2）+ 判据可操作化（resume 应答无错误码）；② D5 证据行组装时机改指 main() 调用点 :776（:351 为工厂内转发行） | tech-design-review subagent round 3（0 must-fix + 2 suggestion；报告 /tmp/design-review-zsw-wave2-round3.md，判定文档达可实施状态；三轮收敛轨迹 4→1→0） |
