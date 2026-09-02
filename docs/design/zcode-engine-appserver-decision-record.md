# zcode engine app-server 决策留档

**一句话结论**：zcode 执行通道的终态形态是 **app-server 常驻模式**，实施位置在 **core（`@zhushanwen/subagent-core`）zcode engine 的 launcher 层内部**；当前生产形态 spawn 单轮是 D-010 确认的首期过渡，不是方向变更；zsw 宿主层**永不私连** app-server（1.x 私连通道已按 D6-⑥ 退役，接入点收归 engine 层正是本决策的要求）。

**性质**：决策记录（decision record），非实施设计——实施拆分另行立项。2026-08-30 用户确认「要用 app-server」，本文为该指令的留档。

---

## 1. 术语澄清：三个「app-server」相关物

| 名称 | 是什么 | 状态 |
|---|---|---|
| zcode 平台 app-server 形态 | zcode 自身的常驻会话服务形态（会话级交互、流式事件） | 平台侧存在，无公开契约文档（见 §4 风险承接） |
| zsw 1.x 宿主私连通道 | zsw 的 runner-appserver.js 直接对接上述内部接口（含自建格式漂移检测/探针缓存/降级链） | **已退役**（zsw P2 D6-⑥，commit 84b63a0，净删约 6500 行） |
| core engine 内部常驻化 | ZcodeEngine 的 launcher 层内部以 app-server 形态跑任务，EnginePort 接口不变 | **终态方向，待实施**（本文档留档的决策） |

## 2. 决策链全貌（跨两仓，均有原始档）

| # | 决策 | 来源 | 状态 |
|---|---|---|---|
| C1 | MVP 引擎集 = { pi, zcode }；zcode 首期只做 spawn 单轮，app-server/conversation 不进首期；抽象按六引擎全集设计防返工 | xyz-agent `.xyz-harness/subagent-engine-abstraction/decisions.md` D-010 | confirmed（无 revisit） |
| C2 | app-server 常驻模式 = **引擎内部优化项**，不是接口语义；不进首期接口实现 | xyz-agent `docs/architecture/subagent-engine-abstraction.md` §1 scope-out + §2.2 观察一 | 架构定位 |
| C3 | EnginePort 的 `onEvent` 回调 + `AbortSignal` 已按常驻友好设计——**引擎内部换常驻实现时接口不动** | 同上 §3 D1 | 升级路径预留（已落地在 core 接口） |
| C4 | app-server 常驻化后 `capabilities.eventGranularity` 由 `coarse` 升 `stream`——**声明升级必须先改链路再改声明** | core `src/execution/engine/engines/zcode/zcode-engine.ts` capabilities 头注 | 升级挂钩 |
| C5 | relay 基建（GUI 实时通道）对 app-server 常驻形态**模式可复制**：launcher 层加环境分支即可复用，无需提前建设 | xyz-agent `docs/architecture/subagent-realtime-channel.md` §2 论证 | 可复制性论证 |
| C6 | zsw 宿主私连通道退役，执行链统一走 core zcode engine（首期 spawn） | zsw `docs/design/zsw-subagent-core-rebind.impl-plan.md` D6-⑥（commit 84b63a0） | 已实施 |
| C7 | **终态确认：要用 app-server**；实施位置 = core zcode engine launcher 层；zsw 宿主层永不私连 | 本文（2026-08-30 用户指令留档） | 本文档 |

## 3. 升级收益（app-server 常驻化相对 spawn 单轮）

| 能力 | spawn 单轮（现状） | app-server 常驻化（终态） |
|---|---|---|
| 运行中插话（steer） | `unsupported`（argv-only，无插话通道） | 引擎原生交互面（capabilities 可升级） |
| 事件流粒度 | `coarse`（stdout 终态单 JSON） | `stream`（C4 挂钩；GUI 实时抽屉/relay 通道解锁，C5） |
| 会话生命周期 | `--resume` 冷续聊（每次冷启动） | 热会话 idle 复用（conversation 能力面升级路径） |
| 进程托管 | 每任务一进程，退出即终 | runtime 持有常驻进程，崩溃/退出时注册表清理无孤儿 |

## 4. 风险承接：为什么接入点必须在 engine 层而非宿主层

zsw 1.x 宿主私连的核心教训：app-server 无公开契约，**平台升级即格式漂移**，宿主层为对冲漂移背了一整套防御工事（格式漂移检测、探针结论落盘缓存、首败失效重探、通道级降级链、升级检测标记——P2 净删约 6500 行即此物）。

该教训在 core 侧已有结构性承接：**probe 体系**（golden 样本干跑回归 + 引擎版本留痕；zcode 升级后首个任务启动即真探）。app-server 常驻化在 engine 内实施时：

1. 漂移检测走 probe 体系（一处建设，双宿主受益）；
2. 能力变化走 capabilities 声明 + D11 四级处置（自动仿真/显示降级/调用前拒绝/入口拦截），下游（pi-sw GUI、zsw 壳）按声明自适应，无需各自防御；
3. 接入验收走 D12 engine conformance 契约套件（C1-C8）+ golden 样本库；
4. EnginePort 接口不动（C3 预留），宿主零改动获得升级。

## 5. 与其他工作的关系

- **与收口设计正交**：`subagent-core-convergence-design.md`（W1-W9）不涉及执行通道形态，app-server 常驻化不改变其拆分与依赖序。
- **与双引擎正交**：pi engine 接入 zsw（zsw 侧待产品决策）与 zcode engine 内部形态演进互不影响。
- **发版语义**（预定，实施时复核）：常驻化属 engine 行为变更——若 capabilities 声明升级（steer/eventGranularity）构成消费方可见语义变化，按 minor/major 评估（zsw 侧消费 capabilities 的面在实施时盘点）。

## 6. 实施立项边界（本文不展开）

app-server 常驻化的实施设计（协议对接细节、常驻进程池管理、会话复用策略、capabilities 逐项升级序、conformance 扩充）待立项时另出设计文档，经对抗式审查后实施。本文仅锁定方向、位置、接口不变性与风险承接机制。
