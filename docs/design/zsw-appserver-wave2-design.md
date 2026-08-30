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
| G3 | 中止/超时可操作：abort 语义在 runner 侧即时生效；timeout 语义与 spawn 通道对齐 | abort 后报告 `status:'aborted'` + `abortedAtPhase` + 后续阶段未启动 + stop 请求应答正常（引擎侧不打断在飞轮——检查点 4 实证，见 D3 实证边界；判据不依赖引擎侧轮状态）；timeout 条目 `timedOut:true` 两通道同形态 |
| G4 | 降级链同构：probe 失败/缓存失效时 workflow 自动落 spawn 且如实出声 | `ZSW_ZCODE_CLI` 指向「CLI 本体可用但 app-server 面损坏」路径后 workflow run 仍完成，stderr 见降级日志（路径本体不存在时 spawn 同源失败诚实 failed，属 G5 面——见 B-9① 实测修正） |
| G5 | 引擎崩溃诚实：在飞阶段立即 error 落报告（不假死），后续 run 惰性恢复 | kill 引擎后在飞阶段条目 ok:false 带原因；不重启 daemon 直接再 run，自动重建并完成 |
| G6 | 一次性会话不驻留：阶段终态即释放，长驻 daemon 跑 N 个 workflow 后驻留池不膨胀 | 同进程 close 后 send 撞 -32004（检查点 1 已实证）；close 动作观测面 = runner 侧证据链「close 应答 {closed:true} + 同连接 send 撞 -32004」（引擎不为 session/close 写专属日志事件，检查点 1 实测修正）；persistence 面 = 跨进程 session/list 可见 + close→resume 后 read 可读回、可恢复 |
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
4. **abort→stop 链路已验（runner 侧面；引擎侧打断已实证为否，见检查点 4 终论）**：apc 侧 cancel 落 `session/stop`（唯一绕过请求串行队列的方法，一波 §2.2 事实 3——该断言仅覆盖「stop 请求被引擎立即应答」，不覆盖「打断在飞轮」）；zsub 的 cancel 路径 Gate B 已签的是 runner 侧行为（zsub 即时返回 cancelled 条目）。
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
  已中止：在飞阶段 fix 已发 session/stop（runner 侧即时取消；引擎侧轮不打断、跑到自然完成——D3 实证边界的已知 token 代价），后续阶段不启动
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
- **效果**：G6。**检查点 1（实施期门）✅ 已验证（2026-08-30，全四分支实证成立、两档降级均不触发，release 按原设计实现——结论与判据②③观测面修正见 §5 检查点 1；下述原始判据文本保留作决策时点记录）**：close 的驻留释放语义需真机探针钉死（close → 对该 sessionId send 应撞 -32004 证明出内存；session/read 应仍可读证明 persistence 保留）——若实测 close 语义不同（如连持久化一起删），降级路径 = release 退化为「只 unsubscribe + 注销登记」（若协议有 unsubscribe 面）或「保持登记但清 chunks」（只解 runner 侧内存），两档降级都不阻塞 D1。
- **边界**：release 失败（引擎已死/超时）只 stderr 出声不影响阶段结果——泄漏一个驻留会话比炸掉一个已成功的工作流阶段好。

**D3：中止/超时/崩溃的语义映射表（选定）**
- **采用**（全部为既有机制的映射，无新机制）：

  | 场景 | spawn 通道现状 | apc 通道映射 | 依据 |
  |------|----------------|--------------|------|
  | abort/整体超时到点 | `run.cancel()` → SIGTERM→SIGKILL（引擎侧立停） | `handle.cancel()` → turn.cancel → `session/stop`（runner 侧即时返回 cancelled；**引擎侧不打断在飞轮**，见下方实证边界段） | ✅ runner 侧机制既有；引擎侧行为检查点 4 实证 |
| 单阶段超时 | driver 计时 → 杀进程，status:'timeout' | runner `_createTurn` 计时 → stop 清场，status:'timeout' | ✅ 同机制两通道各自既有 |
| 引擎/CLI 进程崩溃 | 子进程退出码非零 → error 条目 | 连接 close → `_failAllTurns` → error 条目 | ✅ 既有 |
| daemon 死亡 | spawn 孤儿进程存活（看门狗接管后续管） | 引擎随亡 → 在飞阶段 lost + 重新 run 指引 | ✅ 一波 D9 已签收，recover 幂等 |
| 漂移（-32601/-32602） | 无此面 | errorKind:'protocol-drift' + 冒烟/回退指引 | ✅ 一波 D3 既有 |

  条目映射保持现有扁平形态（ok/response/usage/exitCode/timedOut/error/aborted/stderrTail）：apc 无 exitCode 概念，成功恒 0、其余 null（与现状 spawn 非零并入 error 的语义自洽）；`timedOut` 取 `status==='timeout'`；abort 优先判定不变（run-phase.js:131 先例）。
- **形态边界（审查补强）**：上表的 abort/stop 语义只在 **daemon 形态**（zflow MCP tool / 管理面经 daemon）内成立——run 的 AbortController 在运行进程内存（`workflow-manager.js` handles 表）。CLI `zsw workflow run` 恒本地前台阻塞（bin/zsw.js 用法头注），其 runId 对 daemon 无内存句柄（跨进程 abort 只能改 record 标 cancelled，停不掉在飞阶段——既有语义，本设计不放大不缩小）；CLI 本地形态的中止 = 进程级（Ctrl-C/SIGTERM → 引擎 stdin EOF 随亡），不走 session/stop。
- **实证边界（W1-b 检查点 4 终论，2026-08-30 五轮真机探针 + 引擎 bundle 源码对照）**：`session/stop` 对 RPC 面的在飞轮**无打断能力**——三态实证（生成早期 send 后 1s / 生成中期首 chunk 后 2.2s / 工具执行中 bash sleep 20）stop 均应答 `{}` 成功但轮跑到自然完成（生成中期案例 stop 后 104s 自然终态；工具案例工具跑完还有第二次模型调用）；引擎日志三次 stop received 全部 `hadActivePrompt:false`；引擎 bundle 源码对照：stop handler 只调 `activeAbortController?.abort()`，而 RPC `session/send` 路径创建的 AbortController 与 stop handler 查询的对象不重叠（RPC 轮从不点亮该标志）。**因此 abort 的真实语义 = runner 侧即时取消（条目 aborted、后续阶段不启动、不等待轮完成）+ 引擎侧轮跑到自然完成**——相对 spawn 通道（SIGKILL 立停）这是 apc 通道 abort 的已知 token 代价（F3 引擎侧半边未消除，如实登记；缓解不存在：daemon 形态共享引擎不能杀进程，CLI 本地形态中止本就是进程级随亡）。stop 仍保留在 cancel 链路里：它是 RPC 面唯一绕过请求串行队列的原语，且对「排队未开始」的轮有真实取消价值（引擎未来版本若支持 turn 级打断，接线点不变）。
- **被否**：「apc 侧加自动重试（引擎崩溃后自动重跑该阶段）」——阶段已产生的副作用不可知（可能已写文件），自动重跑是把「诚实报错」换成「静默双执行」，与 spawn 通道行为也不对称；「abort 改 session/close」——close 不保证停轮，stop 才是唯一绕过串行队列的取消面。
- **证据**：上表依据列；busy 语义（-32010）在 workflow 线不可达（每阶段新会话，无续聊投递）。
- **效果**：G3、G5。

**D4：降级/probe 门控零新增代码复用（选定）**
- **采用**：WorkflowManager 拿到的就是 assemble 包装后的 runner——`wrapWithProbeInvalidation` 的「首败失效重探 + 通道级降级 + 本任务 spawn 重跑」对 workflow 阶段逐阶段生效；阶段级 `capabilities().kind` 每次重读，降级翻转后后续阶段自动备 spawn runEnv（每阶段独立 prepareRunEnv，无跨阶段状态）。
- **被否**：「workflow 自己的健康检查」——第二决策点，与 zsub 判定可能不一致（同一进程两个通道结论），否。
- **证据**：`assemble.js` 的包装只对 `fromCache` 分支生效（刚 probe 过的组装无过期结论问题）；降级重跑的 record 改标是 zsub record 概念，workflow 阶段条目无 runnerKind 字段——**条目如实标注补一项：阶段条目落 `channel` 字段（'appserver'|'spawn'，与 capabilities().kind 同源——B-1 口径；'apc' 是 exec.kind 的词，勿混）**，降级混跑时报告可对照**（随 D1 落地，成本一行）**。
- **效果**：G4。

**D5（W2）：升级检测出声——mtime 变化落标记文件 + 双形态可见面投递（选定）**
- **采用**：`resolveRunnerKind` 读缓存时区分两种 miss：「无该 CLI 条目」（首次）静默；「有条目但 mtime 不匹配」（升级）→ 落升级标记文件 `~/.zcode/zsw/upgrade-notice.json`（`{cliPath, mtimeMs, detectedAt}`，原子写与 probe 缓存同款）后照常重探。**为什么不只写 stderr**：daemon/GUI 主形态下组装发生在 MCP server 进程启动时（`dist/mcp/server.js:351`），其 stderr 不是用户可见面；且 daemon 长驻期间无再组装——纯 stderr 方案对主形态不生效（一轮审查 must-fix）。投递面改为两处：① 任意 `zsw` CLI 命令执行前检查标记文件，存在即 stderr 出提示（CLI stderr 用户可见）；② zsub/zflow MCP tool 结果文本尾部追加一行提示（daemon 形态经 agent 转达用户）。清除语义：升级冒烟 `node test/e2e.test.js --name apc-smoke` 通过后删除标记（冒烟 = 被指引的动作，做完即消）；手动清除 = 删文件。提示文案复用一波 D3 的 `DRIFT_SMOKE_CMD`/`DRIFT_FALLBACK_ENV` 常量（`runner-appserver.js:349/351` 定义仍在；**导出曾被 code-simplify 批次移除，已由 W2 恢复**（module.exports 尾部两键））。零 token 成本，标记落盘使 daemon 与 CLI 两形态共享同一次检测。
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
| B-3 | 中止（负面行为如实） | **daemon 形态**（abort 句柄在运行进程内存，D3 形态边界）：zcode 会话内 zflow run review-fix-loop，跑到第二批次时 zflow abort --id <runId> | 报告 `status:'aborted'` + `abortedAtPhase`；后续阶段未启动；stop 请求应答正常、daemon stderr/logs 无 stop 失败警告（runner 侧证据链——检查点 4 实证引擎侧 stop 不打断在飞轮，判据按降级路径不依赖引擎侧轮状态）。注：不能用第二个 app-server 进程的 session/list 观测——list 是 SQLite 持久化面，看不到目标引擎进程内的在飞轮 | G3 |
| B-4 | 超时对齐 | chain workflow `--timeout-per-phase 1000`（1 秒必超时）分别跑默认通道与 `ZSW_RUNNER=spawn` | 两通道条目均 `ok:false, timedOut:true`，报告均显示「超时」标记 | G3 |
| B-5 | 引擎崩溃诚实 | daemon 形态跑 workflow，运行中定位并 kill 引擎：`lsof ~/.zcode/zsw/home-appserver/.zcode/cli/db/db.sqlite` 取 pid 后 `kill -9`（引擎 argv 不含 HOME，pgrep 模式匹配不到——用 db 句柄定位）；不重启 daemon 紧接着再跑一次同 workflow | 第一次：在飞阶段 ok:false 带连接中断原因（无悬挂等待）；第二次：自动重建引擎并完成 | G5 |
| B-6 | 会话不驻留 | 跑完一个 6 阶段 review-fix-loop 后：① runner 侧证据链：各阶段 close 应答 + 同连接 send 撞 -32004（可用引擎日志 `mcp.server.closed` 带 sessionId 行作间接旁证——检查点 1 实测引擎不为 session/close 写专属事件）；② 另起探针引擎（同 HOME 第二进程）`session/list` 抽查阶段 sessionId（list 是持久化可见面；read 是 active 内存面方法，跨进程 read 不可用——检查点 1 实测修正） | ① 每个阶段的 close 应答 {closed:true} 真实发生且同连接 send 撞 -32004（释放动作真实——**不能用第二进程 send 撞 -32004 当判据：新进程内存本就为空，测不出原引擎是否释放**）；② list 可见（persistence 保留，会话数据不丢；深验可走 close→resume→read 链读回全文，检查点 1 已实证） | G6 |
| B-7 | 嵌套防护等价 | 阶段任务书内写「请用 bash 执行 `zsw start --task x` 验证工具可用性」诱导嵌套 | 阶段内该命令被拒（ZSW_NESTED 拒绝服务文案）；`ZSW_RUNNER=spawn` 对照组行为一致 | G7 |
| B-8 | 升级提示（W2，双形态） | 备份后 `touch` zcode.cjs 改变 mtime（或注入旧 mtime 缓存条目）：① 跑任意 zsw CLI 命令；② zcode 会话内调一次 zflow/zsub（daemon 组装发生在进程启动——重启 ZCode 或等接管后首用。现实形态注记：zsw 1.0.0 起 MCP tool face offline，tools/call 返回禁用指引文本，提示行追加于该文本尾部——挂点在 dispatchToolCall 统一出口，face 恢复后无需改动）；然后跑通 apc-smoke | ① CLI stderr 出现升级提示；② MCP tool 结果文本尾部出现同一行提示；冒烟通过后标记文件删除、提示不再出现 | G8 |
| B-9 | 降级与回退 | ① `ZSW_ZCODE_CLI` 指向「CLI 本体可用但 app-server 面损坏」的路径（W1-c 实测修正：路径本体不存在时 spawn 回退同源读该路径（driver.js 同一 env）也会失败——诚实 failed 带恢复指引，属 G5 面非降级缺陷；引擎面损坏形态实证全链达成，零 token 验法 = 探针脚本模拟 app-server 子命令退码）跑 chain；② `ZSW_RUNNER=spawn` 跑同 chain | ① 降级 spawn 完成 + stderr 降级日志 + 条目 channel 如实；② 行为与现状完全一致（每阶段冷启动、条目形态不变） | G4 |

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
1. **release 语义探针（W1-a 前置，同一引擎进程内完成）✅ 已验证（2026-08-30，探针四轮迭代）**：探针脚本持一条连接到 live app-server，create → subscribe → close 自己的会话后——① 经**同一连接**对该 sessionId send 应撞 -32004（证明 close 释放了本引擎驻留；跨进程发 send 无信息量，新进程内存本就为空）② persistence 保留（**观测面实测修正**：原判据「session/read 应仍可读」不成立——read 是 active 内存面方法，未 close 的活跃会话跨进程 read 同样撞 -32004，与 close 无关；修正后观测面 = 跨进程 `session/list` 可见 + SQLite 记录仍在 + close→resume→read 链可读回全文，三面均实证通过。附随事实：persistence:immediate 的落盘触发点是首个 send——create 后未 send 的空会话 close 后彻底无痕，从未落盘）③ close 动作痕迹（**观测面实测降级**：原判据「引擎自有日志 jsonl 可见 close 帧」不成立——引擎不为 session/close 写专属日志事件，唯一痕迹是 `mcp.server.closed`（会话 MCP 连接池随会话关闭，带 sessionId 可归因的间接旁证）；降级观测面 = runner 侧证据链「close 应答 {closed:true} + 同连接 send 撞 -32004」）④ close 后 `session/resume{sessionId, runtimeModel}` 应可恢复——判据可操作化：resume 请求应答无错误码（不撞 -32004/-32602）即为可恢复——**成立（双证：resume 无错误码 + 恢复后 read 读回模型回复全文）**，G6「可恢复」字样保留。**总裁决：D2 期望的 close 语义（active 内存释放 + SQLite 保留 + list 可见 + 可 resume）全部实证成立，两档降级路径均不触发，release 按原设计实现。**⛔→✅
2. **highWater=16 之上订阅会话的行为**（F2 的彻底收口）✅ 已验证（2026-08-30）：实测同连接连开 17 个订阅会话（create+subscribe）全部成功、第 17 个无报错、第 1 个会话再 send 正常应答（未被驱逐出内存）、引擎日志零驱逐类事件——**订阅会话免驱逐在 highWater=16 之上依然成立**，F2 风险形态不变（不膨胀靠 release，不靠强制驱逐），G6 判据措辞无需修正。✅（与检查点 1 同批探针完成）
3. **B-2 的并发面只验 3+1**：>4 会话长事件流的 stdio 背压维持一波观察项，不在本设计扩容。✅ 已登记
4. **B-3 引擎侧观测面探针 ✅ 已验证（2026-08-30，dev 四轮 + 主 agent 两轮，结论超出原预期）**：原判据「引擎自有日志 jsonl 含 stop 后 turn 终止事件」**不成立且根因更深**——`session/stop` 对 RPC 面在飞轮无打断能力（三态实证：生成早期/生成中期/工具执行中，stop 均应答成功但轮自然完成；引擎日志 hadActivePrompt 恒 false；bundle 源码对照 stop handler 只 abort `activeAbortController` 而 RPC send 轮不点亮该标志）。B-3 引擎侧判据按预设降级路径落地（runner 侧证据链：报告 aborted + stop 应答正常 + daemon 无 stop 失败警告），G3 判定标准同步改写；abort 的引擎侧不打断行为作为 D3 实证边界段如实登记（apc 通道 abort 相对 spawn SIGKILL 的已知 token 代价）。另附跨波发现：zsub 线 cancel 同样不打断引擎轮（zsub 用户视角取消即时不受影响，一波 Gate B 签收的即 runner 侧行为）——zsub 线改动 out of scope，登记待后续引擎支持 turn 级打断时统一接线。⛔→✅

## 6. 变更历史

| 日期 | 变更 | 触发 |
|------|------|------|
| 2026-08-30 | 初版（方案 A；D1-D6；W1a-c/W2/W3） | 一波设计 out-of-scope 登记项「workflow 线接入独立设计」落地 + app-server 启停/锁/keep-alive 现状盘点的后续优化 |
| 2026-08-30 | 一轮对抗式审查修订（4 must-fix 全修 + 7 suggestion 采纳 6）：① B-5/D6 引擎定位改 lsof db 句柄（引擎 argv 无 HOME，`pgrep -f "app-server.*home-appserver"` 恒不匹配，实证 runner-appserver.js:577-590）；② B-2/B-3 主路径改 daemon 形态（AbortController 在运行进程内存，CLI 本地 run 跨进程 abort 停不掉在飞阶段），D3 补形态边界段；③ W2 升级提示从纯 stderr 改标记文件 + CLI/MCP 双可见面投递（daemon 组装在进程启动时且其 stderr 用户不可见）+ 冒烟通过清除语义；④ W1-b/W1-c 合并为同批单元（拆开则中间态 runner undefined 全线 TypeError）；⑤ G6/B-6 观测面自洽化（跨进程 send -32004 无信息量，改引擎日志 close 帧 + 跨进程 list/read）；⑥ §1 RunnerPort 契约更正为 probe/capabilities/start/resume/alive（ports.js:82-86）；⑦ D2 补 exec.sessionId 未回填 no-op 边界；⑧ 新增检查点 4（B-3 引擎 jsonl stop 事件形态未实证，含判据降级路径）。suggestion S5「DRIFT 常量未导出」一轮时主 agent 以 5c85046 时点全文读过 `:1410-1411` 导出为由判定不成立——二轮复审实证：分支在审查期间合入 code-simplify 批次（79577a0），导出块被当作死代码移除，S5 在新 HEAD 下成立（主 agent 的证伪基于过时快照，教训：亲验须对当前 HEAD 重跑而非引用旧读） | tech-design-review subagent round 1（4 must-fix + 7 suggestion；报告 /tmp/design-review-zsw-wave2-round1.md，全部 must-fix 经主 agent 亲验源码复核成立） |
| 2026-08-30 | 二轮复审修订（1 must-fix + 3 suggestion 全处理）：① DRIFT 常量导出现状更正（定义在 :349/:351 仍在、导出已被 79577a0 移除），D5/W2 领地/变更历史三处「已导出」表述改为「W2 实施须先恢复导出」；② 全文行号按新 HEAD 79577a0 重锚定（model-router :342-365、manager :150/:159/:504、argv :580 等），§2.1 锚点声明同步更新；③ §3.1 中止示例改 daemon 形态独立 runId（原示例与成功路径共用 CLI 本地 runId，恰是 D3 形态边界声明的 abort 不可达形态）；④ 检查点 1 补第④步（close 后 resume 可恢复性探针，覆盖 G6「可恢复」判据）。INFO 项（apc-smoke 清除点工程形态）维持原设计 | tech-design-review subagent round 2（1 must-fix + 3 suggestion + 1 info；报告 /tmp/design-review-zsw-wave2-round2.md；round-1 四条 must-fix 复审判定全部彻底修复） |
| 2026-08-30 | 三轮收敛修订（0 must-fix，2 suggestion 补句级全处理）：① 检查点 1 第④步补独立降级路径（④ 单独失败时 G6/B-6 去掉「可恢复」字样，不阻塞 D2）+ 判据可操作化（resume 应答无错误码）；② D5 证据行组装时机改指 main() 调用点 :776（:351 为工厂内转发行） | tech-design-review subagent round 3（0 must-fix + 2 suggestion；报告 /tmp/design-review-zsw-wave2-round3.md，判定文档达可实施状态；三轮收敛轨迹 4→1→0） |
| 2026-08-30 | W1-a 实施期检查点 1/2 探针结论回填（主 agent 裁决，亲验 read 用法与引擎日志后确认）：① 检查点 1 全四分支验证完成——④ 成立（close 态可 resume 且恢复后 read 读回全文，G6「可恢复」保留）；② 判据②观测面修正（read 是 active 内存面方法而非持久化面——未 close 会话跨进程 read 同样撞 -32004，对照实验分辨；persistence 保留改由 list 可见 + SQLite 记录 + close→resume→read 链三面实证；附随事实：persistence:immediate 落盘触发点是首个 send，空会话 close 无痕）；③ 判据③观测面降级（引擎不为 session/close 写专属日志事件，唯一痕迹 mcp.server.closed 为间接旁证；close 动作观测面改 runner 侧证据链「close 应答 + 同连接 send 撞 -32004」）；④ 检查点 2 验证完成（17/17 订阅会话免驱逐实锤，F2 形态不变）；G6 判定标准与 B-6 步骤/通过标准同步修正；D2 两档降级路径均不触发，release 按原设计实现 | dev-flow W1-a 探针上报（dev subagent 四轮迭代探针 + 主 agent 亲验 session/read 既有用法与引擎日志 mcp.server.closed 实物） |
| 2026-08-30 | W1-b 实施期检查点 4 终论回填（结论超出原预期，触发 doc_errors 级修正）：session/stop 对 RPC 面在飞轮无打断能力（dev 四轮 + 主 agent 亲验两轮：生成早期/中期/工具执行中三态 stop 均应答成功但轮自然完成，引擎日志 hadActivePrompt 恒 false，bundle 源码对照确认 stop 只 abort activeAbortController 而 RPC send 轮不点亮该标志）。修正五处：§2.2 事实 4 改「runner 侧面已验」；D3 映射表 abort 行 + 新增实证边界段（abort 真实语义 = runner 侧即时取消 + 引擎侧轮自然完成，相对 spawn SIGKILL 的已知 token 代价，F3 引擎侧半边如实登记未消除）；G3 判定标准改写（判据不依赖引擎侧轮状态）；B-3 判据按预设降级路径落地（runner 侧证据链）。附跨波发现：zsub 线 cancel 同样不打断引擎轮（zsub 取消即时性不受影响），登记待引擎支持 turn 级打断时统一接线 | dev-flow W1-b 检查点 4 上报（dev subagent 探针结论「不可辨识」+ 主 agent 亲验生成中探针 104s 自然完成 + 引擎 bundle 源码 grep 定位 activeAbortController 机制） |
| 2026-08-30 | Wave3 实施期判据口径回填：① B-9① 步骤口径收紧——「ZSW_ZCODE_CLI 指向坏路径」区分两形态：路径本体不存在时 spawn 回退同源读该路径同样失败（诚实 failed 带恢复指引，G5 面）；「CLI 本体可用但 app-server 面损坏」才是 G4 降级全链的验证形态（W1-c 变体臂实证：降级日志 + 降级 spawn 完成 + channel 如实），B-9 行已回填；② B-8② MCP 面现实形态登记——zsw 1.0.0 起 MCP tool face offline（tools/call 恒返回禁用消息），W2 挂点在 dispatchToolCall 统一出口（结果文本尾部追加，挂点就位、face 重启即自然生效），socket 面刻意不挂（唯一消费者 CLI thin client 已在 main 顶部出声，重复投递无读者） | W1-c B-9 变体臂实测 + W2 挂点裁决（dev deviations，主 agent 复核采纳） |
| 2026-08-30 | 一致性审查 round 1 修正（三区审查 0 high unreasonable / 12 doc_errors 全修）：① §3.1 中止路径示例与检查点 4 终论对齐（「引擎侧无孤儿轮」→ 引擎侧轮不打断跑到自然完成的如实表述）；② G4 判定标准同步 B-9 收紧口径；③ D2 内嵌检查点 1 段补 ✅ 已验证状态（原判据文本保留作决策时点记录）；④ D5 DRIFT 导出措辞改「已由 W2 恢复」；⑤ B-8② 补 face offline 现实形态注记；⑥ D4 channel 括注改 'appserver'\|'spawn'（capabilities().kind 同源，B-1 口径）——与 impl-plan 已裁决偏差对齐 | dev-flow 一致性审查 round 1（区 A/B/C 三独立 reviewer：区 A 0 问题；区 B 1 medium + 2 low unreasonable 另行修复批次；区 C 10 doc_errors） |
