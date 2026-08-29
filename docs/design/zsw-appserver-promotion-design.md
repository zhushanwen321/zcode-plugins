# zsw appserver（apc）主通道化 — 技术设计

> **一句话结论**：把 zsw 的默认执行通道从「每轮 spawn 一个 zcode CLI 进程」翻转为「常驻 app-server（apc 协议）引擎」——与 ZCode GUI 底层同一架构；以「默认翻转 + 显式回退开关 + probe 降级链保留」控制风险，分四阶段交付（前置收口 → 默认翻转 → 能力增量 → 可选 workflow 接入），恢复序与协议漂移检测是两个硬前置。

**层性质声明**：当前层 = 通道架构切换技术方案；下一层 = 可实施的代码任务（单元拆分见 §5）。前置调研（协议源码全景 / zsw 现状盘点 / 7 项真机探针 P1-P6b）见 `/Users/zhushanwen/Code/zcode-plugin-workspace/fix-review-fix-loop/docs/research/zsw-appserver-promotion-research.md`（下称「调研文档」），本文不重述全部证据、只引结论与关键证据指针。

## 1. 背景目标

### SCQA

- **S**：zsw（z-subagent-workflow 插件）有两条例程化执行通道（`RunnerPort` 策略位）：spawn（每轮 spawn `zcode --json --prompt` 独立进程，冷启动 1-2s）与 appserver（常驻 `zcode app-server` 子进程，apc 协议 stdio NDJSON）。当前默认硬编码 spawn，appserver 仅 `ZSW_RUNNER=appserver` env 可启用。
- **C**：调研证实 apc 功能面全面占优——per-session 模型/思考等级/工具白名单、零冷启动续聊、事件流进度；且 ZCode GUI 底层就是同款架构（同一个 zcode.cjs 的 app-server，GUI = Electron 壳 + 每 workspace 一个引擎进程，GUI 的 subagent 也是同进程 child session）。故障连坐面（单进程多会话）与 GUI 相当，用户已裁决可接受。但协议无公开契约、无版本协商，且 zsw 的 appserver 实现只有 happy path（无恢复序、无漂移检测），7 项真机探针中 2 项推翻了既往假设（send-while-running 是硬错误；崩溃恢复 resume 链卡在 -32031——后者已由 F0 探针解出，见 §2.2 事实 2）。
- **Q**：如何在「协议无契约、两个假设刚被推翻」的前提下，安全地把默认通道翻到 apc，并拿到它的独有能力？
- **A（答案）**：本设计——先收口硬前置（恢复序探针 + 漂移信号分类），再翻转默认（保留 `ZSW_RUNNER=spawn` 显式回退与 probe 自动降级），最后接入 apc 独有能力（thinking / 工具白名单）。spawn 不删除，退为回退位。

### 系统是什么

zsw 是 zcode 的外挂编排插件（无进程内 extension API，能力经 CLI/MCP/hooks 注入）：`zsw start` 派无头 zcode 子代理执行任务，`zsw workflow` 跑多阶段编排（如 review-fix-loop）。两条 runner 通道都最终驱动同一个 zcode 引擎二进制（`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`）：

```
 spawn 通道（现状默认）                    appserver 通道（本设计主通道）
┌──────────────────────┐                ┌──────────────────────────────┐
│ 每轮: spawn zcode     │                │ 常驻: zcode app-server        │
│  --json --prompt ...  │                │  (stdio NDJSON, apc 协议)     │
│ 模型路由=per-model     │                │ 模型/思考/工具= session/create │
│  隔离 HOME 池          │                │  参数；HOME=单一隔离目录        │
│ 每轮 1-2s 冷启动       │                │ 会话驻留引擎内存+SQLite 持久化  │
└──────────┬───────────┘                └──────────┬───────────────────┘
           └─────────────┬─────────────────────────┘
                         ▼
              同一个 zcode 引擎（模型调用/工具执行/会话记录）
```

**apc 协议**（本文反复用到的关键概念）：app-server 暴露的 JSON-RPC 风格 stdio 协议。客户端发 `{id,method,params}`（**不带 jsonrpc 字段**，探针实证拒收未知键），服务端回 `{id,result|error}`、推送 `{method,params}`、反向请求（客户端必须应答，15s 不答断连）。核心方法：`session/create|subscribe|send|stop|close|list|resume|setModel|read`。无 initialize 握手、无版本协商——schema 全 strict 校验，升级漂移以 `-32601`（方法消失）/`-32602`（参数变形）报错。

### 设计目标

| # | 目标（使用者体验倒推） | 判定标准 |
|---|------------------------|----------|
| G1 | 默认通道 = appserver：`zsw start` 不带任何 env 即走常驻引擎，任务与 conversation 续聊正常完成，冷启动开销消失 | record.runnerKind='appserver'；第二轮 send 无进程重建 |
| G2 | 断链自愈：空闲驱逐（引擎驻留池 10min）或进程崩溃后，conversation 下一次交互自动恢复或以诚实错误降级 | -32004 触发自动 resume 重试一次；不可恢复时报「会话弃用+重试指引」而非裸错误码 |
| G3 | 协议漂移可发现：ZCode 升级导致的协议不兼容被识别为「版本问题」并给出恢复指引，不伪装成普通任务失败 | -32601/-32602 分类为 protocol-drift；升级冒烟脚本本地手动一键可跑（CI 不含真机 e2e） |
| G4 | thinking 可调：`zsw start --thinking <level>` 生效且非法值容错 | 引擎 stderr 落盘（D3 新增实时落盘）thoughtLevel 命中；非法值 warn 跳过不失败 |
| G5 | apc 独有安全面接入：per-session 工具白/黑名单；隔离环境遥测关闭 | create 参数携带工具限制；子进程 env 无遥测标识写入 |
| G6 | 回退与可观测：`ZSW_RUNNER=spawn` 显式回退旧路径；probe 失败自动降级；每个任务如实标注实际通道 | 降级日志 + record.runnerKind 与实际一致 |

### In / Out of scope

**In**：默认翻转与回退开关；恢复序；漂移检测与冒烟；thinking/工具限制/遥测接线；测试与文档翻转；发版判定。
**Out**（明确不做，理由见 §3.2/§5）：workflow 线（zflow/review-fix-loop 的 `run-phase.js` 硬编码 spawn）接入 runner 端口——独立后续设计；GUI 层重写 / v4 订阅面（GUI 专属）逆向；共享主 HOME（三次被否：凭据污染、会话写用户主库、setThoughtLevel 全局副作用）；`session/setThoughtLevel` RPC 的任何使用（写 user 级全局设置，探针 P1 实证）。

## 2. 现状与问题分析

### 2.1 zsw 侧现状（file:line 取自本仓 worktree，commit 1b9f053 时点；README 行号已按当前 HEAD d7b8c48 重定位）

- 默认 runner 硬编码：`lib/assemble.js:64-65` `opts.runnerKind || (process.env.ZSW_RUNNER === 'appserver' ? 'appserver' : 'spawn')`；`lib/ports.js:130` 同款兜底。无 config 键、无 CLI flag。
- probe 门控：`lib/assemble.js:30-52`——env 推断 appserver 时先 `probe()`（create 探针会话 + close，10s 预算），失败降级 spawn 并 stderr 出声；显式注入则不探测。
- appserver 实现：`lib/runner-appserver.js`（RunnerPort 五方法全实现）——惰性启动单连接、单进程承载全部会话；`_handleExit` 后 reject 全部 pending，**下一次操作时重建新连接，但旧会话不迁移**（resume 撞 -32004 只提示重新 start，:834-839）。
- 四个协议假设标注待收口（头注 A2/A4/A5/A6）：本轮探针已收口 A5（send-while-running）、A6（session/list 形态）；A2（多会话推送归因）、A4（read/messages 形态）仍未收。
- `idleConversationTtlMs` 预留常量未接线（`lib/config.js:78`）；README:99「单 provider」文档已过时——**两者均已在实施中解决（F2 删常量 / F3 顺修 README），本行保留为实施前现状快照**。
- **workflow 线不走 runner 端口**：`lib/workflow/run-phase.js:98` 硬编码 `prepareRunEnv(modelRef,'spawn')` + `driver.runHeadless`。

### 2.2 协议面关键事实（调研文档 §2.1，本节只列影响设计的）

1. **-32004 是常态不是异常**：引擎驻留池（targetCount=8 / highWater=16 / idleTimeout=10min）会驱逐空闲会话出内存；进程重启同理。被驱逐会话的恢复路径是 `session/resume`（从 SQLite 重建）——不恢复直接 send 就是 -32004。**F0 实证补充**：订阅会话免驱逐——zsw 现实形态（start 即 subscribe）下空闲驱逐几乎不可命中，-32004 的主来源是引擎进程死亡与 close；`idleTimeoutMs` 无 env/CLI/config 覆盖面（驻留池参数仅 GUI host 进程内注入），真机驱逐加速用 high_water_lru 洪泛（16+ 个 `persistence:immediate`、不订阅、**且 `titleGenerationEnabled:false`** 的会话——标题生成后台工作 hasResidencyBlockingWork 会阻止驱逐，缺此参数洪泛不生效，F0 附加实证 2）秒级触发。
2. **resume 链已走通（F0 收口，推翻 P6/P6b 的无解印象）**：plain resume 成功返回完整快照（warning 在快照 `projection.lastError.message` 直接可见），但随后 plain send 必挂 `-32031`（ZCODE_RUNTIME_MODEL_UNAVAILABLE）。**F0 三线实证**：驱逐（进程存活）与崩溃（进程死亡）走同一冷恢复路径、**同设 restoreWarning**——「驱逐自愈、崩溃报错」的分支划分不存在。清除候选三可用一不可用：① `session/send` 直传 `runtimeModel`（硬闸前应用+清 warning）✓；② **`session/resume {sessionId, runtimeModel}` 最优**（warning 根本不设置；runtimeModel 是 resume params 的原生可选字段，与 create 无关）✓；③ `session/updateRuntimeModelConfig {sessionId, runtimeModel}` ✓；④ provider registry 就绪等待 ✗（独立无头引擎无 registry arrival 时机，等 12s 仍 -32031，等待线从恢复序删除）。runtimeModel 形态（schema strict 逐字段实测）：`{revision, generatedAt, model:{providerId,modelId}, provider:{providerId, kind:"anthropic"|"openai-compatible"|"openai", label?, source:"custom", baseURL, apiKey:{source:"inline",value}, models:[{modelId}…]}}`（另含可选 `thoughtLevel?`——zsw 恢复序不消费该字段），provider 须忠实携带传输配置（会被注册进 workspaceModelCatalogs 成为后续 turn 的 overlay 配置来源）；构造器 `buildRuntimeModel()` 已随探针归档（test/e2e-tp1-recovery.test.js）。**附带事实（接种效应）**：runtimeModel 一旦在引擎进程内应用，同进程后续 plain resume 不再设 warning（随进程死亡消失）——恢复序应无条件每次 resume 带（runner 无法得知引擎是否被外部重启，构造成本为零）。
3. **send-while-running 是硬错误**（探针 P3）：`-32010 "A prompt is already running"`，不排队不打断。GUI 的边跑边打字走的是 v4 输入准入层（引擎 turn-steer），RPC 面没有。**结论：message/steering 能力两通道等价，apc 优势清单不含此项**。`session/stop` 是唯一绕过请求串行队列的方法（运行期取消可靠）。
4. **thoughtLevel 合法值按模型动态**：来自 model catalog（GLM-5.3 = `low|high|max`，**默认 max**，budget 8k/16k/32k）；运行时校验源 = `workspace/readState` 的 `thoughtLevel.available`。create 的 `thoughtLevel` 入参生效路径走 `setThoughtLevel`，**副作用是写 user 级全局设置**（探针 P1：池 HOME db 出现 `reasoningLevel={"level":"high"}`）——隔离 HOME 内无害。
5. **协议无版本协商**：漂移只以 -32601/-32602 出现；另有 -32004（不活跃）/ -32009（revision 冲突）/ -32010 / -32031（恢复失败）。
6. **per-session 隔离面现成**：create 支持 `toolAllowlist` / `toolDenylist` / `mcpServers` / `persistence`（`immediate|deferred`；要可恢复+list 可见须显式 immediate）。
7. **遥测默认开**：引擎启动即写遥测标识（`ZCODE_MODEL_TELEMETRY_ENABLED=false` 可关）。
8. **GUI 同构证明主线地位、不证明外挂稳定**：GUI 是第一方客户端，协议演进时随版本原子升级；zsw 是外挂，升级窗口内无人同步改 zsw——「GUI 也用这个协议」的价值是「该协议为官方主线重度使用的面、整体废弃是小概率事件」，变更是常态。对称事实：spawn 通道并非免维护的避风港——CLI 参数面同样无契约（本仓 AGENTS.md 已录 `--allowed-tools` 拒收、`--settings`/`--max-turns` help 漂移两起），两通道是逆向维护成本大与小之差，不是有与无之差。

### 2.3 真实失败模式（现状默认=spawn，以下均为 appserver 通道启用时已真实存在的问题）

| # | 失败模式 | 触发条件 | 现状后果 |
|---|----------|----------|----------|
| F1 | 空闲驱逐断链 | `ZSW_RUNNER=appserver` + conversation 两轮间隔 >10min（或引擎进程重启；F0 补注：订阅会话免驱逐，现实主触发是进程死亡/close） | 第二轮 send 收 -32004，runner 直接报错；无 resume 尝试（`runner-appserver.js:834-839` 只提示重新 start）——**已由 F2 恢复序解决** |
| F2 | 协议漂移伪装成任务失败 | ZCode 升级改了方法名/参数 | probe 可能仍通过（create/close 未变而 send 变形）→ 任务以 -32602「内部错误」面目失败，用户不知道该跑升级冒烟——**已由 F1 漂移分类解决** |
| F3 | 崩溃恢复不可用 | 引擎进程崩溃后旧会话续聊 | plain resume 后 send 卡 -32031（P6b）；**F0 已解**：恢复序 resume 携带 runtimeModel（见 §2.2 事实 2） |
| F4 | thinking 不可调 + 默认档位无人知晓 | 用户想省预算跑 low 档（GLM 默认 max） | 无参数面；「apc 通道默认已 max」这一事实也无处沉淀——**已由 F4 单元解决（--thinking 接线）** |

**根因**：① 协议无公开契约，一切语义靠逆向沉淀（本仓已有头注/探针传统，但缺系统性漂移防线）；② 通道实现只做了 happy path（连接、create、send、收事件），「非活跃恢复」「版本漂移」两类常态异常无语义；③ 默认通道选型使 apc 能力面（thinking/工具白名单/零冷启动）从未被消费。

### 2.4 物理数据流（apc 通道现状 → 目标差异点加粗）

```
zsw CLI/daemon ──spawn──▶ node zcode.cjs app-server --cwd <dir>
   (HOME=~/.zcode/zsw/home-appserver, ZSW_NESTED=1)
        │  stdio NDJSON（{id,method,params} / 推送 / 反向请求）
        ▼
   引擎进程：会话驻留池(8/16/10min) ──驱逐/重启──▶ 会话仅存
        │                                    ~/.zcode/zsw/home-appserver/.zcode/cli/db/db.sqlite
        │  session/create{model,thoughtLevel?,persistence?,toolAllowlist?...}
        │  session/send → turn 后台执行 → session/event(part.delta/…)
        ▼                                     ▲
   模型 API（anthropic effort+thinking / reasoningEffort）   **恢复路径（目标）：resume ← SQLite**
```

目标态新增的流：**① -32004 → session/resume → 重试 send 的自愈环**；**② -32601/-32602 → protocol-drift 分类 → 冒烟脚本指引**；**③ `--thinking` → create.thoughtLevel → readState 校验**。

## 3. 解决方案

### 3.1 终态（使用者视角）

**成功路径**——用户在 zcode 会话里让 agent 派子代理：

```
> zsw start --task "调研 X 库的许可证" --model flash --thinking low
[zsw] 任务 sa-xxxx 已启动（runner: appserver, model: GLM-5.3-Flash, thinking: low）
> zsw status --id sa-xxxx
  状态: done | 实际通道: appserver | 耗时 41s（其中冷启动 0ms）
```

conversation 第二轮——**分支一：会话被引擎回收（空闲驱逐或进程重启，F0 实证两者同路径）**：

```
> zsw message --id sa-xxxx --text "再补充 iOS 侧"
[zsw] 会话曾被引擎回收，已自动恢复（resume 携带 runtimeModel）并投递   ← G2 自愈（F0 实证）
```

**失败路径 1——恢复序仍失败（-32031 兜底分支 B，F0 后仅剩罕见场景如凭据失效）**：

```
> zsw message --id sa-xxxx --text "继续"
[zsw] 错误: 会话恢复失败（-32031 历史模型不可用，引擎限制，见 <调研文档 TP-1>）。
      恢复指引: 该会话不可续；用 zsw start 重建任务（record 已保留历史输出），
      或设 ZSW_RUNNER=spawn 走旧通道（每轮独立进程，无此恢复问题）。
```

**失败路径 2——协议漂移**：

```
> zsw start --task "..."
[zsw] 错误: 协议漂移（protocol-drift）: session/send → -32602（字段 issues 见 stderr）。
      这通常意味着 ZCode 版本更新改了 apc 协议。
      恢复指引: 跑升级冒烟 `node test/e2e.test.js --name apc-smoke` 核对漂移面；
      确认不兼容期间设 ZSW_RUNNER=spawn 回退。
```

**busy 语义（-32010，负面行为）**：运行中的会话再投递 → 立即返回 busy 报错「上一轮仍在执行，等待完成（zsw wait）或 zsw cancel 取消」（CLI 实际子命令为 cancel，无 stop——初稿「zsw stop」为笔误，一致性审查修复批次已按真实命令落地）——**不排队不打断**（探针 P3 实证），与 spawn 通道行为一致。

### 3.2 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|----------------|--------------|------|------|
| **A 分阶段翻转 + 降级链保留**（S0 收口硬前置 → S1 翻默认 → S2 能力增量） | 高：默认拿到 apc 全部收益；spawn 保留为回退位与降级落点，退出路径永远存在；漂移/恢复语义先建后翻，翻转时风险面已收敛 | 中：S0 一轮探针 + 恢复序/分类两个机制，S1 是小 diff（默认值+测试+文档） | 低：翻转点有 probe 降级 + 显式回退双保险；-32031 若 S0 无解则以「会话弃用+指引」降级语义收尾，不阻塞翻转 | ✅ |
| B 直接翻转 + 删除 spawn 通道 | 低：删掉唯一回退路径；漂移发生时用户无路可退；spawn 的「每轮进程故障隔离」是 apc 没有的性质，永久丢失 | 低（删比改快） | 高：F2 漂移一旦发生即全员不可用；F3 无解时 conversation 场景无兜底 | ❌ 若用它：§3.1 失败路径 2 的用户没有 `ZSW_RUNNER=spawn` 可退，唯一选项是等插件发版 |
| C 不翻默认，只加 `--runner appserver` flag | 低：默认体验不变，能力面（thinking/工具白名单/事件流）消费率趋近零，「长线主路线」永久停留纸面。注：冷启动成本对 A/C **等价**——两案的 workflow 线均在 scope 外（`run-phase.js:98` 硬编码不动），「review-fix-loop ×N 阶段放大」不构成 A 的相对优势 | 低 | 低（但目标 G1 未达成） | ❌ 若用它：§3.1 成功路径第一行永远要用户手动带 flag |
| D workflow-first：先接 workflow 线（冷启动收益大头），zsub 面后行 | 中：按收益排序最优（一次 review-fix-loop 4-6 phase × 1-2s 冷启动，zsub 单任务只付一次）；但按风险排序最差——workflow 接入涉及嵌套防护与 `prepareRunEnv` 语义迁移（§5），改动面最大，在 D2/D3 防线未建未验时先翻高强度路径 | 高 | 中高：防线本设计才建立，D 序无法复用已真机验证的恢复序/漂移分类 | ❌ 作为起点否决；其收益由 A 之后的 workflow 独立设计承接（直接复用 A 建成并验证过的防线） |
| E 等官方公开 apc 契约/版本协商后再翻 | 不可评估：官方公开无已知时间表，机会成本无限期；且 spawn 通道 CLI 参数面同样无契约（本仓 AGENTS.md 已录 `--allowed-tools` 拒收、`--settings`/`--max-turns` help 漂移两起），等待并不能摆脱逆向依赖，只是把逆向面从协议换成 flag | 零 | 近期零、远期高（能力面无限期冻结） | ❌ 实质退化为 C 加一个无时间表的触发条件 |

**推荐 A**。核心权衡：接受「S0 先花一轮探针/机制成本」换取「翻转点风险面收敛 + 永久退出路径」。**zsub 先于 workflow 是风险排序而非收益排序**：zsub 翻转是最小 diff（一个默认值），以最小面先建恢复序/漂移防线并真机验证，改动面最大的 workflow 接入直接复用防线成果；若 workflow 先行（D 案），等于在无防线时先翻高强度路径。冷启动收益大头（review-fix-loop ×N 阶段）由后续 workflow 设计承接，不在本设计记账。

### 3.3 关键决策与权衡

**D1：默认值翻转 + 显式回退开关（选定）**
- **采用**：`assemble.js`/`ports.js` 缺省 `spawn` → `appserver`；`ZSW_RUNNER=spawn` 成为显式回退；probe 失败自动降级 spawn 保留（probe 语义随之从「env 推断校验」变为「默认通道健康检查」）。
- **被否**：B（删 spawn）；「config 文件键替代 env」——现状 env 面已有（ZSW_RUNNER），加 config 键是第二事实源，违反本仓单源惯例。
- **证据**：`lib/assemble.js:64-65`、`lib/ports.js:130`；probe 降级链 `lib/assemble.js:30-52`；GUI 同构（调研文档 §2.1；辨析见 §2.2 事实 8——同构证明协议主线地位、降低整体废弃概率，不构成对 zsw 外挂的稳定性保证）。
- **效果**：G1、G6。注意 daemon 在 MCP server 进程启动时读一次 env 定死——发布说明注明「重启 ZCode 生效」。
- **接管检查（副作用枚举）**：默认翻转后，所有原本隐式走 spawn 的路径（`zsw start` 默认、conversation、`--local` 调试后门、daemon 全部任务）改走 apc——runner 端口以下无差异（manager/slots/notifier 对两通道对称，调研文档 §2.2）；`--local` 路径组装期 probe 开销需缓解——**probe 结果落盘缓存**（`~/.zcode/zsw/probe-cache.json`，键 = CLI 路径 + mtime）：执行模型核实，`--local` 每条命令都是一次性 CLI 进程、daemon 只在启动时组装一次，「进程内缓存」在两个形态下都无命中面；落盘缓存使 daemon 与 --local 共享结论。**只缓存 ok=true 的结果；失败不落盘**——每次组装重探（故障期才付此代价），避免一次暂时性故障让 mtime 不变期间持续走 spawn 丢掉 apc 全部能力。**缓存命中不等于持续健康**：probe 通过除 CLI 可用外还依赖隔离 HOME 的 provider 配置（`lib/assemble.js:33-36` 注释：无配置时 `session/create` 直接 -32603），配置在 CLI mtime 不变期间变坏（目录被清理/配置失效）会让「CLI 路径+mtime」键错误命中旧 ok 结论、降级链失效——故**缓存命中后首次 `session/create` 失败（-32603/-32601/-32602）即失效缓存并重探一次**：真实故障时才多付一次探针，覆盖全部变坏路径，优于在键内追配配置指纹（枚举不全则同样有窗）。

**D2：-32004 自愈恢复序（选定）**
- **采用**：runner 内对 send/message 遇 `-32004` 自动执行四步恢复序——① **`session/resume {sessionId, runtimeModel}`**（F0 结论固化：resume 携带 runtimeModel 是最优形态——warning 根本不设置，驱逐与崩溃两类通吃；**每次无条件携带**，接种效应不可依赖，见 §2.2 事实 2）→ ② **重挂 `session/subscribe{sessionId, deliveryKind:"desktop-continuous"}`**（订阅是 per-session 的，连接重建/resume 不自动恢复订阅；缺此步则 send accepted 但 turn 终态事件不达，恢复变假死）→ ③ 重试一次原 send → ④ 断言恢复后事件流可达（收到 turn 终态推送；**等待窗口 = 该轮任务 timeoutMs 预算，窗口耗尽即判「终态不达」→ `session/stop` 清场**（stop 是唯一绕过请求串行队列的方法，§2.2 事实 3，防引擎侧 turn 继续跑成孤儿）**→ 按分支 B 收尾**，不留实施期自由裁量）。resume 或重试仍失败 → 按 D2 分支 B 收尾。-32010 不重试（busy 语义如实上报）。
- **被否**：「永久 keep-alive 轮询防驱逐」——每会话心跳是把引擎驻留池策略顶在头上，多会话下浪费且仍防不了进程重启。
- **证据**：-32004 常态性（引擎驻留池 8/16/10min，调研文档 §2.1；F0 补：订阅免驱逐，主来源为进程死亡/close）；resume 快照成功（探针 P6）；**F0 三线实测**（test/e2e-tp1-recovery.test.js）：plain resume 快照可见 warning 且 plain send 必挂 -32031、resume{runtimeModel} 后 send ok + turn.terminal 可达、updateRuntimeModelConfig 可用、registry 等待 12s 仍 -32031；订阅 per-session（设计时点 `runner-appserver.js:752` start 订阅、`:815-817` resume 无订阅直接 send——同连接时可行，跨连接重建时是缺口；**该缺口已由恢复序②修复**，实施后行号已漂移，现状见 lib 头注）。
- **效果**：G2。**分支判定已收口（F0）**：解除条件已探明（resume 带 runtimeModel）→ **自愈覆盖驱逐与崩溃两类，无双分支**；分支 B 降级为兜底语义——仅在 resume{runtimeModel} 或重试仍失败时出现，报「会话弃用 + `zsw start` 重建指引 + record 历史保留说明」（§3.1 失败路径原文），**禁止裸错误码**。
- **接管检查**：恢复序接管了「连接重建后旧会话续用」职责——原 `_ensureConnection`（设计时点 `runner-appserver.js:534-546`，实施后行号已漂移）只重建连接不认旧会话、不重挂订阅，D2 在其上补会话层（resume+subscribe）；进程重启场景 = `_ensureConnection` 重建连接 + D2 四步叠加覆盖。
- **多会话边界**：恢复序加 runner 级全局互斥（同一时刻至多一路恢复序在执行）——引擎崩溃时 N 个 running 会话同时被击落，N 路恢复并发打刚重启的引擎存在恢复风暴面；**F0 C 线实证**：串行化不解 -32031 本身（串行对照臂同样双双 -32031，warning 的唯一解是 resume 带 runtimeModel），互斥的价值是防风暴压垮刚重启的引擎、非防连坐——互斥保留，且每路恢复都必须带 runtimeModel。并发恢复行为列入 A-8 观察项。

**D3：协议漂移显式分类 + 升级冒烟（选定）**
- **采用**：runner 错误分类新增 `protocol-drift`（-32601 方法不存在 / -32602 参数校验失败），record 与 stderr 双落点，错误信息含恢复指引（冒烟命令 + 回退开关）；冒烟脚本 = probe 扩面（create + send 极小任务 + 关键响应字段断言：sessionId 路径/turn.terminal/response 非空/toolDenylist 生效），随插件发布、**升级后本地手动跑**——冒烟含真实模型调用，属真机 e2e 级，本仓 CI 明确排除 e2e（`.github/workflows/ci.yml:7-8` 注释「无凭据必挂且烧 token」、`:51-57` find 排除 `e2e*.test.js`），CI 化需凭据注入方案、超出本 scope 另行设计。「stderr 落点」的物理形态 = 引擎子进程 stderr **实时落盘** `~/.zcode/zsw/logs/`（对齐 logging-conventions）：现状仅内存滚动缓冲 `_stderrTail`、进程退出时输出尾部 400 字符（设计时点 `lib/runner-appserver.js:323-324,328-330`，实施后行号已漂移），运行中日志无落盘面——该落盘同时是 A-5 thinking 档位的观测面与漂移 issues 的取证面，随 F2 建成。
- **被否**：「把 -32602 当普通错误重试」——重试必然再失败且掩盖根因；「全量协议快照测试」——无公开契约，快照维护成本高于收益。
- **证据**：无版本协商、strict schema、错误码全集（调研文档 §2.1 §8）。
- **效果**：G3；A2/A4 假设随冒烟脚本建设顺带收口（send/read 路径被冒烟覆盖）。

**D4：create 参数显式化（选定）**
- **采用**：`session/create` 固定携带 `persistence:"immediate"`（可恢复 + list 可见）；`mode:"yolo"` 维持。
- **被否**：依赖 deferred 默认——deferred 会话 list 不可见且语义为临时会话，与「崩溃后 session/list 排障」诉求相反。
- **证据**：persistence 枚举与 deferred 升级语义（调研文档 §2.1）。
- **效果**：G2 的排障面（zsw list 跨进程可见全部任务会话）。

**D5：thinking 接线（选定）**
- **采用**：`zsw start --thinking <level>`（默认不传 = 跟随模型默认，GLM-5.3 即 max）→ `create.thoughtLevel`；合法性校验源 = `workspace/readState` 的 `thoughtLevel.available`（连接级读一次缓存），非法值沿用引擎容错（warn 跳过，探针 P2 实证不失败）。**禁止**调用 `session/setThoughtLevel` RPC。
- **被否**：`session/setThoughtLevel`（运行中改档）——探针 P1 + 源码证实其写 user 级全局设置（`saveGlobalReasoningLevel`），隔离 HOME 内虽无害但该 RPC 的存在诱导未来共享化误用，直接列为禁用面；本地硬编码合法枚举——按模型动态（GLM=low|high|max，DeepSeek=high|max，别家=xhigh…），硬编码必错。
- **证据**：P1（create 入参生效 + 日志 `setInitialThoughtLevelDurationMs`）、P2（非法值容错）、catalog 动态校验链（调研文档 §2.1）。
- **效果**：G4；同时沉淀「默认即 max」事实（README 注明：省预算场景显式传 low）。spawn 降级轮 thinking 不可用——record 标注 `thinking: null (spawn 降级)`。

**D6：per-session 工具白/黑名单接线（选定）**
- **采用**：**两个入口来源**，均落 `create.toolAllowlist/toolDenylist`——① CLI flag：`zsw start --allow-tools <逗号分隔清单>` / `--deny-tools <逗号分隔清单>`（分隔符与 spawn 通道 `--disallowed-tools` 一致）；② agent .md frontmatter：`taskCtx.disallowedTools`（`lib/manager.js:202-206` 组装；现状 spawn 通道经 `lib/driver.js:242` 落 `--disallowed-tools` 引擎级硬拦截，而 appserver runner 现状不消费该字段——grep `disallowed|toolDenylist` 零命中）同样映射 `create.toolDenylist`，与 CLI flag 取并集去重。**frontmatter `tools` 白名单显式决策：维持 buildPrompt 软约束**（`lib/prompt-builder.js:79-95`），不升级为 `toolAllowlist`——对齐 spawn 通道现状语义（白名单一直无 flag 通道、仅软约束，`lib/manager.js:202-203` 注释），且白名单硬约束的误杀面（模型无法用清单外工具补救任务）大于黑名单；软约束段黑名单文案「平台层亦会拦截」（`lib/prompt-builder.js:91`）在来源②接线后两通道均恢复为真。现有 spawn 通道 denylist 经 `--disallowed-tools` 的路径保留为回退位行为。
- **被否**：继续只靠 prompt 软约束白名单（现状 spawn 通道 `--allowed-tools` 被引擎 CLI 拒收，白名单一直缺位）。
- **证据**：create schema 两字段均为 `array(string)`（协议源码 offset 439024），消费点以 `new Set(...)` 匹配工具名（offset 12051550）——**裸工具名形态确定合法**（引擎自身往 Set 里加的就是裸名 "CronCreate"）；zsw 现状条目也是裸名（`test/domain.test.js:160-173`）；括号 spec 形态（`Bash(git *)`）的支持性无源码证据。
- **效果**：G5——**闭环以来源②接线为前提**：若只接 CLI flag 不接 frontmatter，翻转后既有 agent .md 的工具黑名单将从引擎级硬拦截静默退化为 prompt 软约束，G5 判定标准被自身推翻。**格式契约待冒烟收口**（检查点 2）：先按裸工具名落地，spec 形态（含空格）是否被引擎解析由冒烟脚本实测后决定是否放开。

**D7：会话生命周期交给引擎驻留池（选定）**
- **采用**：删除 `idleConversationTtlMs` 预留常量（`lib/config.js:78`）——回收职责归引擎驻留池（10min 驱逐 + resume 可回），zsw 侧只维护「-32004 → D2 恢复序」与 `_sessions` 登记表同步。
- **被否**：zsw 自己实现 TTL 扫描回收——与引擎驻留池双轨制，两头都不知情，比单轨更糟。
- **证据**：驻留池参数与语义（调研文档 §2.1）；常量现状无消费点（调研文档 §2.2）。
- **效果**：G2 简化；README:103 过时条目随之删除。

**D8：隔离环境遥测关闭（选定）**
- **采用**：appserver 子进程 env 注入 `ZCODE_MODEL_TELEMETRY_ENABLED=false`。
- **被否**：保持默认开——隔离 HOME 内写入遥测标识无害但无意义，且污染「隔离目录只含运行必需数据」的排障预期。
- **证据**：遥测 env（调研文档 §2.1）。
- **效果**：G5。

**D9：测试/文档翻转 + 发版 minor（选定）**
- **采用**：`assemble.test.js` 缺省断言反转 + `ZSW_RUNNER=spawn` 显式回退用例；`e2e.test.js` E1-E6/E8 逐场景显式钉 spawn（E4 pid 探活/E6 exec.pid 为 spawn 专有概念），E7 升主链路回归 + 新增多会话并发场景；**`e2e-daemon.test.js` A5（SIGKILL daemon 看门狗接管）同样钉 spawn**——其 victim 断言依赖 `exec.pid` 整数与 orphan 语义（spawn 独立子进程在 daemon 死后仍存活），apc 的 exec 为 `{kind:'apc', sessionId}` 无 pid（Gate A 发现的测试影响面漏项，已修）；apc 下 daemon 死亡语义为引擎随亡 → 任务 lost + 重新 start 指引（看门狗探活走 runner.alive 通道无关，recover 幂等），不与 spawn 的 orphan 语义混同验收；README（:99-103 已知边界重写 + 单 provider 过时条目顺修 + M5 行，行号按当前 HEAD d7b8c48）/CONTEXT.md（env 清单补 ZSW_RUNNER）；发版 **minor**（新增默认路径 + 回退开关保留旧路径，非不兼容删除）。**minor 论证以 D6 来源②接线为前提**：接线后既有 agent .md 黑名单在两通道均为引擎级硬拦截、行为等价；若不接线则构成仓版本准则的「action 行为不兼容变更」，须升 major。
- **被否**：major——无参数/行为不兼容删除面（spawn 路径完整保留），升 major 违反本仓版本准则表。
- **证据**：测试影响面清单（调研文档 §2.2 问题 5）。
- **效果**：G6；发布说明含「重启 ZCode 生效」注意事项。

## 4. 验收（真机场景，回溯 §1 目标）

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|----------|------|
| A-1 | 默认通道 | 不设任何 env，`zsw start --task "小任务"` ×2 + conversation 第二轮 | 全部完成；record.runnerKind='appserver'；第二轮无进程重建（引擎日志无新进程启动行） | G1 |
| A-2a | 断链自愈（驱逐分支） | **F0 已实证驱逐与崩溃同路径**（同设 warning、同解法），zsw 链路级验收以 A-2b 为准；驱逐线由探针复跑覆盖：`ZSW_TP1_SCENARIOS=A node --test test/e2e-tp1-recovery.test.js`（洪泛驱逐，~23s） | 探针 A 线绿（resume{runtimeModel} 后 send ok + turn.terminal 可达） | G2 |
| A-2b | 断链自愈（崩溃分支，zsw 链路级主验收） | 定位并 kill app-server 引擎子进程 → **不重启 daemon**（连接重建是 runner 下一次操作时惰性自动的，重启 daemon 反而把恢复序测试污染成冷启动测试），直接 `zsw message` | 全自动恢复：resume{runtimeModel} + 订阅重挂 + 重试 send 投递成功，turn 终态事件可达；恢复序仍失败才走分支 B（诚实报错 + 指引）；两种结果均禁止裸错误码与假死（send accepted 但无终态事件超时） | G2 |
| A-3 | 显式回退 | `ZSW_RUNNER=spawn zsw start` 同任务 | 走 spawn 通道，行为与翻转前一致（record.runnerKind='spawn'） | G6 |
| A-4 | probe 降级 | `ZSW_ZCODE_CLI` 指向坏路径后默认 start | 降级 spawn + stderr 降级日志 + record 如实标注 | G6 |
| A-5 | thinking | `--thinking low` 跑 run，另跑 `--thinking ultra` | 前者引擎 stderr 落盘文件（`~/.zcode/zsw/logs/`，D3 实时落盘，zsw 链路内可读）`thoughtLevel:"low"`；后者 warn 跳过、任务不失败（P2 语义）；不带 flag 的 run 落盘 `thoughtLevel:"max"`（GLM 默认档沉淀） | G4 |
| A-6 | 工具限制 + 遥测 | 三来源各验一条：CLI `--deny-tools "Bash"`（裸工具名，格式保底形态）任务里 prompt 诱导跑 git；**agent .md frontmatter `disallowedTools` 声明的工具**（D6 来源②；翻转前该来源在 spawn 下已是引擎级硬拦截，验翻转后等价）同任务诱导；spec 形态（`Bash(git *)`）按冒烟结论追加；随后检查 `~/.zcode/zsw/home-appserver/` 无遥测标识文件 | 工具被拒（引擎层拦截，非 prompt 软约束，两来源同标准）；`--allow-tools` 白名单同理；遥测目录检查为 D8 验收 | G5 |
| A-7 | 漂移检测 | 模拟漂移（monkey-patch fake server 返回 -32602；真机可省）+ 升级冒烟脚本对当前版本跑 | 错误分类为 protocol-drift 且含恢复指引；冒烟脚本输出各关键面判定结果 | G3 |
| A-8 | 并发回归 | 4 个并发任务（默认通道） | 全部完成、响应不串线（P5 双会话已证，扩到 4 验证串行链背压） | G1 |
| A-9 | 负面行为：busy | 会话运行中投递 message | 立即 busy 报错（含等待/stop 指引），不排队不打断、不静默丢失 | G6（诚实语义） |

## 5. 下一层拆分

| 单元 | 内容 | 领地（预估） | 依赖 | 验收 |
|------|------|--------------|------|------|
| F0 | TP-1 探针（场景矩阵 + 排查线）：**A 线·同进程驱逐**（真机驱逐加速用洪泛手法：16+ 个 immediate 不订阅且 titleGenerationEnabled:false 的会话秒级触发，见 §2.2 事实 1 → resume → 重挂订阅 → send → 断言终态事件可达）；**B 线·崩溃恢复**（kill → 重启 → resume → send 复现 -32031）；**C 线·多会话崩溃恢复**（N≥2 会话，kill 引擎 → 重启后并发 resume → 观察 -32031 连坐面与串行化效果，D2 互斥依据）；**排查候选四条**：send 直传 `runtimeModel` / create `runtimeModel` 参数 / `session/updateRuntimeModelConfig` / provider registry 就绪等待（协议源码已见 restoreWarning 三条清除路径，命中率高）。产出物：结论 + 复现脚本归档 test/（e2e 场景化），不再一次性丢弃 | test/ 新探针脚本（结论后归档 e2e） | 无 | **已收口**（2026-08-29 真机三线全绿，归档 test/e2e-tp1-recovery.test.js）：驱逐与崩溃同设 warning（双分支划分不成立）；清除三可用一不可用、resume{runtimeModel} 最优；串行化不解 -32031 但保留防风暴——结论已回填 §2.2 事实 1/2 与 D2 |
| F1 | 漂移分类 + 冒烟脚本：错误分类 protocol-drift（含指引文案）；probe 扩面为冒烟（send/read/toolDenylist 断言）；A2/A4 随之收口 | lib/runner-appserver.js、test/appserver.test.js、test/e2e.test.js | 无 | A-7 |
| F2 | 恢复序 + create 显式化：-32004→**resume{runtimeModel}**→重挂订阅→重试（④ timeoutMs 窗口判据 + stop 清场、runner 级恢复互斥防风暴；registry 等待线已证伪删除；runtimeModel 构造器复用 F0 归档的 buildRuntimeModel）；引擎 stderr 实时落盘 `~/.zcode/zsw/logs/`（D3 观测/取证面）；persistence:immediate；遥测 env；idle TTL 常量删除 | lib/runner-appserver.js、lib/config.js、test/appserver.test.js | F0 | A-2 |
| F3 | 默认翻转 + 回退开关 + probe 缓存：assemble/ports 默认值；ZSW_RUNNER=spawn 语义；测试/文档翻转 | lib/assemble.js、lib/ports.js、test/assemble.test.js、test/e2e.test.js、README.md、CONTEXT.md | F1、F2 | A-1/A-3/A-4/A-8 |
| F4 | 能力增量：`--thinking`（readState 校验源）+ 工具限制双来源（CLI `--allow-tools/--deny-tools` + frontmatter `disallowedTools` → `toolDenylist` 并集，D6）；record 标注 | bin/zsw.js、lib/manager.js、lib/model-router.js、lib/runner-appserver.js、test/ | F3 | A-5/A-6 |
| F5 | 发版与收尾：minor release、发布说明（重启生效）、skill/command 文档复核 | 版本三件套（release.js 流程） | F1-F4 | check-sync/check-pack + check-release-needed 清零 |

**实施路径**：F0/F1 并行 → F2 → F3（翻转点，独立可回滚——一个默认值 diff）→ F4 → F5。workflow 线接入（原 S3）**不在本拆分**：`run-phase.js` 走 RunnerPort 涉及嵌套防护与 prepareRunEnv 语义迁移，独立设计另起。

**待验证检查点（实施期门）**：
1. TP-1（F0）：**已收口（2026-08-29）**——驱逐与崩溃同设 restoreWarning（分支划分不成立）；清除三可用一不可用，resume{runtimeModel} 为最优解并固化为 D2 恢复序①；registry 等待证伪删除；附「订阅免驱逐」「接种效应→每次无条件带」两事实（详见 §2.2 事实 1/2 与 test/e2e-tp1-recovery.test.js 头注）。
2. 工具限制格式契约：裸工具名确定合法（源码证据）；括号 spec 形态（`Bash(git *)`）是否被引擎解析、以及 denylist 引擎级拦截的行为面验证——**均归 A-6 真机验收收口**（裁决：不为此增加冒烟 token 成本——冒烟是升级后高频操作保持极小，行为面验证属一次性验收场景；E9 冒烟仅保留参数面无漂移断言）。
3. 4+ 会话长事件流下 stdio 背压 + 引擎崩溃后多会话并发恢复行为（**F0 C 线已观察：串行化不解决 -32031 连坐、每路带 runtimeModel 才是解**；A-8 扩展观察项，非阻塞门）。

## 6. 变更历史

| 日期 | 变更 | 触发 |
|------|------|------|
| 2026-08-29 | 初版（分阶段翻转方案 A；D1-D9） | appserver 主通道化调研（docs/research/zsw-appserver-promotion-research.md）+ 用户裁决 |
| 2026-08-29 | 审查修订：D2 恢复序补订阅重挂步（缺则恢复变假死）与四步断言；§3.1 成功路径改「驱逐/崩溃」双分支并以 F0 结论为条件；probe 缓存改落盘（进程内缓存在一次性 CLI 与 daemon 两形态下均无命中面）、失败结果不落盘；A-2 拆驱逐/崩溃两场景、崩溃场景去掉设计外的「重启 daemon」动作；F0 补同进程驱逐线与四条排查候选（send 链 restoreWarning 硬闸 + 三条清除路径为审查新增源码证据）、产出物归档化；D6 改裸工具名保底 + spec 形态待冒烟、分隔符定义；A-6 并入 D8 遥测验收 | 对抗式审查 4 must-fix + 5 suggestion |
| 2026-08-29 | 二审修订：D6 补 frontmatter `disallowedTools` → `toolDenylist` 接线（黑名单与 CLI flag 并集；`tools` 白名单显式决策维持软约束）+ A-6 补 frontmatter 场景 + D9 minor 论证挂接该前提（不接线须升 major）；§3.2 补 D workflow-first / E 等公开契约两变体否决记录、C 案否决理由改用 A 真实差异（冷启动对 A/C 等价）、推荐段补 zsub 先行的风险排序论证；D3/G3 冒烟改「升级后本地手动跑」（CI 排除真机 e2e，ci.yml:7-8,51-57）+ 新增引擎 stderr 实时落盘 `~/.zcode/zsw/logs/`（G4/A-5 观测面 + 漂移取证面，F2 建成）；D2 ④ 补 timeoutMs 窗口判据 + session/stop 清场、新增恢复序 runner 级互斥（多会话恢复风暴）+ F0 补 C 线；D1 probe 缓存补命中后首败失效重探；§2.2 补事实 8（GUI 同构辨析 + spawn 同为逆向依赖）；README 行号按 d7b8c48 重定位 | 第二轮对抗式审查 1 must-fix + 8 suggestion |
| 2026-08-29 | F0 探针结论回填：驱逐与崩溃**同设 restoreWarning**（「驱逐自愈+崩溃报错」双分支划分不成立，D2 固化为 resume{runtimeModel} 每次无条件携带，自愈覆盖两类）；清除候选三可用一不可用（registry 等待证伪，从恢复序删除）；D2 多会话边界按 C 线实证修正（串行化不解 -32031，互斥仅防风暴）；新增事实：订阅会话免驱逐（-32004 主来源为进程死亡/close，§2.2 事实 1）与 runtimeModel 接种效应（§2.2 事实 2）；A-2a 改探针复跑覆盖、A-2b 为链路级主验收；§5 检查点 1/3 收口；失败路径 1 降级为兜底场景 | F0 真机探针三线全绿（test/e2e-tp1-recovery.test.js） |
| 2026-08-29 | 一致性审查文档修订：§2.2 事实 2 runtimeModel 形态补可选 `thoughtLevel?`；洪泛驱逐手法补 `titleGenerationEnabled:false` 前提（标题生成后台工作阻止驱逐，F0 附加实证）；§5 F0 行 A 线同步洪泛手法；D2/D3 行号引用加「设计时点」标注（实施后已漂移，订阅缺口已由恢复序②修复）；§2.3 失败模式 F1/F2/F4 行补已解决标注；§1 SCQA 补 -32031 已解指针；§2.4 残留项标注已解决；检查点 2 改记「spec 形态与拦截行为面归 A-6 真机收口」（冒烟保持极小不为此加 token） | 三区一致性审查（区 A 2 unreasonable+2 doc_errors、区 C 文档面） |
