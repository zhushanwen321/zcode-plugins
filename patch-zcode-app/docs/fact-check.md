# 事实核查文档

分类三值:**事实**(已核实,证据=文件:行号 或 .run/probes/ 探针输出)、
**推断**(合理推导未核实)、**虚构**(无依据臆断——标「作废」并删除依赖分支)。
zcode.cjs 为 minified 单行文件,证据以 .run/probes/ 探针切片为准(切片头部标注
zcode.cjs 字节偏移;grep -ob 与 node 字符偏移在 4.3M 前一致,其后文件含多字节
字符会错位,以切片原文为准)。

## 论据三分类表

| 编号 | 论据 | 分类 | 证据 | 说明 |
|---|---|---|---|---|
| A1 | 全部 provider LLM HTTP 请求(流式/非流式/探针)汇合到唯一准入函数 Kyt(admitAttempt),调用方仅 Wwo 与 Qwo 两处,无旁路(无 embedding/countTokens 路径) | 事实 | .run/probes/verifier-slices.txt:34 .run/probes/seed-probes.txt:4 | P4=admitAttempt 标注;切片 34=Kyt 函数体 |
| A2 | 主会话(observer 入口)、subagent(subagent_child)、workflow actor(workflow_child)三种运行时的模型请求都经过 Kyt | 事实 | .run/probes/verifier-slices.txt:1(observer),:4(subagent),:7(workflow) | G2 的机制根基 |
| A3 | Kyt 形参 e 含 `model:{providerId,modelId}`、`signal`(abort)、`admission`;函数 async | 事实 | .run/probes/verifier-slices.txt:34(Kyt 函数体) | 注入行依赖的字段 |
| A4 | zcode.cjs 顶层作用域原生 require 可用(139 处 `require("node:` 使用,无 require 重定义) | 事实 | .run/probes/seed-probes.txt:5(P2 计数),:7(P3 空输出) | trampoline require 前提 |
| A5 | require 经 symlink 目录加载模块可用 | 事实 | .run/probes/seed-probes.txt:15(P9 symlink require: ok) | G4 安装形态前提 |
| A6 | 锚点结构串 `tryAcquire({model:e.model}):void 0` 当前版本全文件唯一 | 事实 | .run/probes/seed-probes.txt:11(P6 计数=1) | 升级后 minified 名漂移由 transform 正则容忍 |
| A7 | `r(<fn>,"admitAttempt")` 函数名标注存在,可两步定位(标注提取函数名 → `function <name>(` 定位定义) | 事实 | .run/probes/seed-probes.txt:4(P4),:9(P5 偏移) | 函数名 Kyt 是 minified 名,升级会变 |
| A8 | zcode.cjs 是 asar 外裸文件(Resources/glm/zcode.cjs,15.8MB),asar 重打包机制不适用,需 loose-file 目标类型 | 事实 | .run/probes/seed-probes.txt:13(P7 ls 输出) | 框架扩展动因 |
| A9 | patch-zcode-app 框架现况:补丁定义协议(isApplied/transform)、幂等 apply、pristine 基线 + 升级自动重采纳已实现(asar 内文件) | 事实 | patch-zcode-app.js:53(loadPatches),:174(ensureBase),:244(buildPlan) | G5 复用面 |
| A10 | Kyt 返回 `{ticket:n, release(){…幂等守卫}}`;原生无 admission 时返回空 ticket 兜底 `nba={release(){}}` | 事实 | .run/probes/verifier-slices.txt:34(Kyt 函数体) | 原生自己的 ticket=undefined 先例 |
| A12 | Kyt 调用方对 ticket 零深度消费:唯一去向 = ticket 存在则透传 admissionTicket 并调 `ticket.publish(event)`(缺失仅一条 warn,Promise.allSettled 不影响主流程)。外部最小返回 = `{ticket: undefined, release}`(调用方豁免路径,零耦合零噪音) | 事实 | .run/probes/verifier-slices.txt:10(Ice 豁免三元式),:16(Wwo 调用与 catch) | ticket 形状定案 |
| A13 | 取消判定:`signal.aborted===true` 或错误 `name==="AbortError"` 或 `code==="ABORT_ERR"` → cancelled 语义(retryable:false 不重试);其他错误落普通失败分支(可能进重试预算)。entry.js 取消等待时 reject `signal.reason`(abort 时恒有值)即与原生中止对齐 | 事实 | .run/probes/verifier-slices.txt:13(Ebo 三条件) | 取消语义定案 |
| A14 | 调用方对 release 是多点模式(每侧三个调用点:重试分支显式调 + finally 兜底调 + 空完成重试函数 evt 内的 admission.release,后者 Wwo/Qwo 两侧各一),同一 ticket 会被 release 2 次以上 → 外部 release 必须自身幂等(once 守卫) | 事实 | .run/probes/verifier-slices.txt:22(Wwo 双点1),:25(Wwo 双点2),:28(Qwo 双点1),:31(Qwo 双点2);evt 第三点=基线 zcode.cjs 偏移 4246777(e.admission?.release()),Wwo/Qwo 分别以 admission 传入(偏移 4261533/4276726) | 硬要求;修剪阶段补登第三点 |
| A15 | trampoline 完全接管后,原生 `onQueued`/`onAdmitted` 事件不会自发产生;workflow actor 状态机(YAi)依赖这两个事件推进 queued→executing 相位 → entry.js 排队时须自行 `await e.onQueued?.()` 与 `await e.onAdmitted?.(排队毫秒)`,立即准入不调(与原生 tryAcquire 命中路径一致) | 事实 | .run/probes/verifier-slices.txt:19(kyt 装配回调) | entry.js 义务 |

## 外部接口核实表

| 接口 | 形态 | 依据 | case |
|---|---|---|---|
| Kyt(admitAttempt)函数体注入点 | 在 `function <fn>(<p1>,<p2>){` 后插入单 try 块;p1 即 payload(e);结构校验含 tryAcquire({model: 模式 | .run/probes/verifier-slices.txt:34;seed-probes.txt:11 | T1, T3, T9 |
| admit(payload) 协议(entry.js) | admit(e) 返回 {ticket:undefined, release 幂等} 或 undefined 或 Promise;排队时先 onQueued 后 onAdmitted 回调;取消 reject e.signal.reason | .run/probes/verifier-slices.txt:1 .run/probes/verifier-slices.txt:10 .run/probes/verifier-slices.txt:13 .run/probes/verifier-slices.txt:19 | T2, T2c, T9 |
| require(homedir() 拼路径加载 entry.js) | trampoline 惰性单例 globalThis.__ZSEM__;异常吞掉走原生 | .run/probes/seed-probes.txt:5 .run/probes/seed-probes.txt:15 | T3, T5 |
| patch-zcode-app 补丁定义协议 | name/description/target/isApplied/transform 五字段;loose-file 目标为本次框架扩展 | patch-zcode-app.js:53 | T1, T6, T8 |
| app-server NDJSON 真实会话(仅 T9 验收用) | spawn node zcode.cjs app-server --cwd 目录,stdio 按行 JSON 请求/应答帧 | .run/probes/verifier-slices.txt:37 | T9 |

## 未核实风险

- Oy(ModelRequestCancelled)冒泡到 runtime 适配层之后的上层消费特判未追踪
  (核实者声明):影响面仅限遥测字段名(exceptionType 记 Error 或 AbortError),
  cancelled 语义由 Ebo/AL 消费侧兜住——触发条件:上层有按错误 name 分支的逻辑
  且行为差异可观察。
- 多窗口跨进程不共享(design.md 显式不做):两个 ZCode 窗口并行时总量可达 2×N
  ——触发条件:同时开多窗口且都满载。
