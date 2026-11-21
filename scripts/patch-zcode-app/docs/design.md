# 设计文档:provider-sem(zcode LLM 请求准入信号量 patch)

## 背景与目标

provider(如 GLM coding-plan)的 LLM 并发总量是账号级硬限制(如 10)。zcode 的
subagent 派发、workflow actor、主会话请求各自独立打满时,实际并发远超账号上限。
zcode 原生准入控制器按 model 分桶(上限 4..16 由 CPU 推导),既不按 provider 聚合,
多个 zcode 进程间也不共享。本任务给 zcode.cjs 的 LLM 请求准入唯一收口加一个
provider 维度的全局信号量:超过上限的请求排队等待,zcode 视角只是「模型响应慢」。

| 编号 | 目标 | 题面原句(逐字) | 限定词落点 | case/落点 |
|---|---|---|---|---|
| G1 | provider 维度并发上限 + 排队 | 「限制 provider 维度的 subagent 和 workflow agent 的数量,比如我设置只能同时发起10个,超过的就进入排队」;口径修正原句「单个provider的LLM调用总量限制是固定的,比如glm总体并发就是10,subagent和workflow是共用这个限制」 | 机制:请求级准入(provider 限制的本来就是并发请求),上限来自配置文件 | T2, T9 |
| G2 | workflow 与 subagent 共用同一限制 | 「workflow必须加进来并且和subagent一起监控和控制,否则就没有意义了」 | 机制:注入点是全部 LLM 请求的唯一收口,subagent/workflow actor/主会话天然同池 | T2, T9 |
| G3 | patch 只做入口,核心逻辑在受控代码 | 「patch不能做太重的逻辑,否则后续zcode一升级,patch就没用了,patch只能做一个入口,通过入口在其他地方,我们可控制代码稳定的地方,做核心逻辑」 | 机制:patch 注入行仅 trampoline 一行(转发+异常吞掉),信号量/配置/日志全在本仓 zsem/ 模块 | T1, T3 |
| G4 | 本项目开发 + symlink 安装 | 「都开发在本项目中,然后symlink安装到 zcode patch」 | 机制:源码在 main/scripts/patch-zcode-app/zsem/,install 动作建 ~/.zcode/cli/zsem symlink(幂等) | T5 |
| G5 | 统一 patch 框架 + 自动升级覆盖 | 「后续 patch 都走统一自动升级覆盖的逻辑,然后再写patch逻辑」 | 机制:收编进 patch-zcode-app(patches/ 清单+幂等 apply+升级自动重采纳),框架扩展 asar 外裸文件目标类型 | T1, T6, T8 |
| G6 | 排队不干扰 zcode 正常运转 | 「这个排队不影响zcode,zcode会认为 tool 调用已经成功或者已经 block 了,后面会自动排队完进入」 | 机制:排队发生在进程内 await,请求挂起等价于模型响应慢;fail-open 保证 zsem 异常时会话不受影响 | T3 |

## 验收是什么

实机验收重点:①patch 写入后 zcode.cjs 仍可正常启动(注入行语法/运行时零破坏);
②信号量在真实并发下执行上限与 FIFO;③真实 zcode 进程内端到端生效(app-server 起真实
会话,zsem 日志出现 grant/release);④zsem 缺位时 fail-open 链路通。验收判据 =
acceptance.md 的实机 case 全绿。

## 树形拆分

主干文件清单(仓库根相对路径,gate 按此核对;行内不带注释,gate 逐字匹配):
- scripts/patch-zcode-app/patch-zcode-app.js
- scripts/patch-zcode-app/patches/
- scripts/patch-zcode-app/zsem/
- scripts/patch-zcode-app/test/
- scripts/patch-zcode-app/docs/
- scripts/patch-zcode-app/.tree-plant.json
- .gitignore

主干对 patch-zcode-app.js 的改动内容:loose-file 目标类型支持 + provider-sem 收编 + install 动作;.gitignore 仅追加 scripts/patch-zcode-app/.run/ 条目。

| 枝名 | 目标 | 依赖 | 风险级 | 文件 | case |
|---|---|---|---|---|---|
| zsem-observe | 观测面:JSONL 事件日志 + status CLI | 主干 | 中 | scripts/patch-zcode-app/zsem/lib/log.js, scripts/patch-zcode-app/zsem/bin/zsem.js | T4 |
| upgrade-sim | 升级-重打闭环:restore→apply 幂等重打 + 基线重采纳 | 主干 | 高 | scripts/patch-zcode-app/patch-zcode-app.js, scripts/patch-zcode-app/test/ | T6, T8 |
| abort-cancel | 排队中 abort 信号取消 + 名额不泄漏 | 主干 | 高 | scripts/patch-zcode-app/zsem/, scripts/patch-zcode-app/test/ | T2c |

## 非功能设计

| 项 | 类别 | 不做会怎样 | 预计多久出问题 |
|---|---|---|---|
| fail-open(zsem 任何异常/缺位→放行原生链路) | 可靠性 | zsem 缺失或崩溃会拖垮全部 LLM 请求,zcode 不可用 | 立即(zsem 一次异常即触发) |
| 注入行自包含且语法最小(单 try 块) | 业务安全 | patch 面积大→每次 zcode 升级锚点适配成本线性涨 | 每次 zcode 升级 |
| 写入原子性(stage+回读校验+rename) | 可靠性 | 写一半崩溃损坏 zcode.cjs,zcode 起不来 | 首次磁盘异常即触发 |
| 观测日志(zsem-log.jsonl)格式不迁移 | 可靠性 | 格式演进不写迁移:重建代价 = 删除旧日志(status 统计清零,无其他副作用,下一次 grant 重新累计) | 日志格式变更时 |

### 显式不做

- hook 拦截路径(题面初版设想;用户裁决「如果能走 patch,那根本不用 hook」,patch
  直连后 hook 无职责)。
- 多窗口跨进程共享(daemon 化):一期信号量是 zcode 进程内状态;多窗口并行时各自
  限 N,总量最多 窗口数×N。代价已声明;二期可将 zsem 内部裁决器换成 daemon 客户端,
  协议与 patch 不变。
- provider 429 自适应降流:绕过原生 governor 后其自适应降流失效;一期静态上限
  (排队消化超发),不监测 429。
- 非 LLM 请求(world.run 等执行端口调用)不限——不在收口上,题面口径是 LLM 并发。
- 排队上限等待时长配置:原生请求层自有超时/重试语义,不在 zsem 重复设层。
