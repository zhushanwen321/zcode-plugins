# z-subagent-workflow — zcode subagent 编排 + workflow 插件

> 两条能力线，1.0.0 起统一走 CLI（`node bin/zsw.js`，默认连常驻 daemon thin client；MCP 工具面已下线——tools/list 恒空、tools/call 指引走 CLI）：
> **zsub** — 无头 subagent 生命周期管理（start/list/status/cancel/message/close/wait/agents/models）。补足引擎原生后台 agent 缺少的能力：worktree 文件隔离、schema 结构化输出、conversation 续聊、agent .md 发现（core 发现面：vendored 内置 10 角色 + 项目/HOME 用户根，与 pi 生态同源）、per-start 模型路由、跨窗口 record。agent 参数只收 .md 绝对路径（与 pi 平台契约统一），缺省加载 `general-purpose` 内置角色。
> **zflow** — 确定性多步编排（`zsw workflow` 子命令，九 action：run/abort/status/list/scripts/lint + 创作闭环 script-generate/script-save/script-delete）。回接 2b 起 workflow 运行时整体替换为 vendored `@zhushanwen/subagent-core` orchestration：内置 5 种（chain/parallel/map-reduce/scatter-gather/review-fix-loop，资产来自 core `workflows/`）+ core 契约自定义脚本（`@pi-meta` + top-level `agent()`，按 .js 绝对路径引用；`script-generate → lint → save → run → delete` 创作闭环全链 CLI 可用，W8/D-6）；run 同步阻塞出 scriptResult（配 Bash run_in_background 即完成原生唤醒）。**契约统一是行为 break——迁移对照见「subagent-core 收口 break 变更」节。**
> 简单纯后台任务请直接用原生 `@agent`（frontmatter `background: true`，独立 turn 唤醒 + goal gate）——分流指引见 skill `zsub-zflow-orchestration`。

## 架构（端口/适配器内核）

```
入口层   CLI（node bin/zsw.js，默认 daemon thin client）+ skill——MCP 工具面恒下线
         （tools/list 恒空、tools/call 恒拒并指引走 CLI；zsub 九 action / zflow 九 action
          保留为语义层名，见 CONTEXT.md）
编排层   SubagentManager（subagent 生命周期，只依赖 lib/ports.js 契约）
         orchestration-host（workflow 编排宿主 = vendored subagent-core orchestration：
         configureCore 宿主端口 + FileRunStore + WorkerHostImpl + registry 内置资产注册，
         AgentRunner port 经 lib/agent-runner-adapter.js 桥回 zsw RunnerPort）
端口层   RunnerPort                  NotifierPort        ModelRouterPort
         └ runner-core（core zcode    ├ MailboxNotifier    └ 清单器（2c 瘦身，执行
            engine spawn 单轮适配；    └ PollingNotifier      解析归 core 引擎
            appserver 通道已退役）                            preparer）
域层     resolver / prompt-builder / record-store / output-store / worktree / jsonout
         vendored core（lib/vendor/subagent-core/）：runWorkflow/lifecycle/error-recovery
         + workflows/ 内置 5 资产（chain/parallel/map-reduce/scatter-gather/review-fix-loop）
```

三个决策位（执行引擎 / 回流通道 / 入口形态）正交且各自可换——更换实现不动 manager。执行引擎 = vendored subagent-core 的 zcode 引擎（回接 2c，`lib/runner-core.js` 适配；appserver 通道已退役），平台版本漂移被限制在 core 引擎与端口实现内部消化（探针 golden 回归 + 引擎版本留痕）。

core 资产消费形态：对 npm 包 `@zhushanwen/subagent-core` 的消费（当前面为其 `workflows/*` 资产）采用构建期 vendored 副本（`lib/vendor/subagent-core/`，`scripts/vendor-subagent-core.js` 刷新 + `lib/core-ref.js` 单一解析点，VENDOR-MANIFEST.json 溯源），运行时不依赖 node_modules 解析面。规范见 workspace 仓 `docs/standards.md`「vendored 核心包消费」节。

## 安装（一次性）

1. 注册插件目录：`~/.zcode/cli/config.json` 的 `plugins.dirs` 数组追加本插件绝对路径（`<repo>/z-subagent-workflow`），重启 ZCode。
2. 验证：终端跑 `zcode plugins list` 应见 `z-subagent-workflow` enabled；再在任一 zcode 会话内用 Bash 跑 `node <插件绝对路径>/bin/zsw.js list`，能返回 JSON（首次为空列表）即 CLI→daemon 链路通。注意 MCP 工具面 1.0.0 起恒下线——会话内工具列表**不会**出现 `zsub`/`zflow`，这是预期形态而非安装失败。

（legacy）宿主引擎的 mailbox 开关 `ZCODE_MESSAGE_ENABLED=1` 无需设置：该通道只对 MCP 工具面时代的会话定向通知有效，工具面下线后 CLI/daemon 面恒无投递目标（句柄 notify 如实标 `none`）。env 仍影响 notifier 档位文案（未启用时 polling 档附轮询指引），完成唤醒不依赖它——唯一路径见「已知边界」第一条。

## 使用

agent 与人类都走 CLI `node bin/zsw.js`（zsub 面九 action：start/list/status/cancel/message/close/wait/agents/models；下例为常用子集）：

```bash
node bin/zsw.js start --task "审查 src/ 的错误处理" --slug review-1 --model <模型短名>   # 传未知模型名会在报错中列出可用清单
node bin/zsw.js list
node bin/zsw.js status --id sa-xxxx
node bin/zsw.js message --id sa-xxxx --text "补充：重点看重试逻辑"   # 投递即回，完成经 wait 收（--local 下才阻塞到本轮完成）
node bin/zsw.js cancel --id sa-xxxx
```

workflow 管理面（zflow 面九 action 的 CLI 入口；状态面 = `<zsw 数据根>/workflow-state/`。abort/status/list/scripts/script-save/script-delete 默认经 daemon——跨进程状态一致、abort 经 daemon 侧 core `abortRun` 真停 run、script-delete 的「运行中拒绝」由 daemon 侧 runs 真实状态裁决；run/lint/script-generate 恒本地）：

```bash
# run（--action 缺省；恒本地同步执行，执行体 = CLI 进程，跑到终态退出并打报告。
# agent() 每次调用 spawn 一个独立无头 zcode 进程（core zcode engine 单轮，~1-2s 冷启动/次）。
# 需要「派发后做别的、完成唤醒」时用 Bash run_in_background 包裹整条命令，CLI 退出即引擎原生通知）
# workflow 引用 = 内置名 或 .js 绝对路径（~/ 前缀可展开；script:<名>/裸名已废弃拒收，D-4）
node bin/zsw.js workflow --workflow chain --task "分析并总结 README" --workdir <绝对路径>
node bin/zsw.js workflow --workflow map-reduce --task "..." --workdir <绝对路径> \
  --operation "提取每个文件的导出" --items '["a.ts","b.ts"]'
node bin/zsw.js workflow --workflow ~/.zsw/workflows/my-wf.js --task "..." --workdir <绝对路径>   # 自定义脚本按路径引用

# abort / status / list / scripts / 创作闭环
node bin/zsw.js workflow --action list
node bin/zsw.js workflow --action status --id wf-xxxxxxxx
node bin/zsw.js workflow --action abort --id wf-xxxxxxxx
node bin/zsw.js workflow --action scripts          # vendored 内置 5 + 用户脚本清单（含 path 列）
node bin/zsw.js workflow --action lint --file <脚本路径>

# 创作闭环（W8 / D-6：core 五道闸校验管线，落盘目录 = zsw 布局 ~/.zsw/workflows）
node bin/zsw.js workflow --action script-generate --name my-wf --script "<完整 JS 源码：@pi-meta 块 + top-level agent()>"
                                    # 校验（ESM 拒/meta 必需/agent() 必需/语法/@pi-meta round-trip 含行列）
                                    # → 合法落 ~/.zsw/workflows/.tmp/my-wf.js；非法 exit 1 + core 同源报错
node bin/zsw.js workflow --action script-save --name my-wf     # tmp → ~/.zsw/workflows/ 固化（重名拒绝；默认经 daemon）
node bin/zsw.js workflow --action script-delete --name my-wf   # 删 tmp/已固化脚本（运行中拒绝；默认经 daemon）
```

**review-fix-loop（批次外环 + 质量内核，资产来自 core）**：唯一会写文件的内置 workflow（fix 阶段）。批次外环：`--batch1..--batchN` 串行（**值 = agent .md 绝对路径**，逗号分隔多 agent），前一批 clean 后一批才启动。每轮并行 review → LLM 聚合裁决（臆测/无证据条目降级，不进修复队列）→ 结构化契约 fix → R2 起逐条 ID 对账（fixed/not-fixed/regressed）→ 收敛/needs-redesign 状态机；run 目录由 core 资产自管（`~/.review-fix-loop/<repo-slug>/<runId>/`，含 state.json 与各轮报告）。

```bash
node bin/zsw.js workflow --workflow review-fix-loop \
  --task "审查 PR：重构 auth 中间件" --workdir <绝对路径> \
  --target-type git-diff --target main \
  --batch1 "/abs/path/correctness-reviewer.md,/abs/path/security-reviewer.md" \
  --stuck-threshold 3 --aggregator-model <模型短名>
```

参数面全集见 `node bin/zsw.js workflow --help`（`--target`（必填）、`--target-type`（缺省 text）、`--batch1..N`（agent .md 路径）/`--batch-names`、`--max-rounds` 默认 10、`--stuck-threshold` 默认 3、`--skip-clean-agents`、`--recheck-after-fix`、`--converge-new-issues`/`--converge-rounds`、`--max-fix-attempts`、`--aggregator-model`、`--review-prompt`/`--fix-prompt`、`--fallow-scan`、`--auto-commit` 等）。老参数兼容：`--review-target <text>` 等价 `--target-type text --target <text>`；`--task` 在 review-fix-loop 场景作为 target 回退。**`--reviewers`（自由文本维度）已废弃**——core 契约批次值 = agent .md 路径，传入显式报错；无 agent .md 的自由文本维度场景改用自定义脚本（`script-generate` 创作后按 .js 绝对路径引用）。

**自定义 workflow 脚本（core 契约，绝对路径引用）**：内置 5 种之外的编排用 core 契约脚本扩展，run 按 .js 绝对路径引用（`~/` 前缀可展开；`script:<名>` 与裸名已废弃拒收——D-4 契约与 pi 平台统一）。发现面 = core 发现面（`~/.zsw/workflows` + `~/.agents/workflows` + `<ws>/.pi/workflows` + `<ws>/.agents/workflows`）+ zsw 特有根 `<ws>/.zsw/workflows`；脚本契约 = `/* @pi-meta */` meta 块 + top-level `agent()`/`parallel()`/`pipeline()`，参数经 `$ARGS`，返回值即 scriptResult。创作走闭环：`script-generate`（core 五道闸校验 + tmp 落盘）→ `lint` → `script-save`（固化 `~/.zsw/workflows/`）→ run 按路径引用 → `script-delete` 清理；完整契约与示例见 skill `zsub-zflow-orchestration`（旧契约迁移对照见下方「回接 2b break 变更」节）。

`--local` 模式下 CLI 是一次性进程（本地执行，调试后门：无续聊/限流，CLI 退出即丢执行体）：start/message 一律阻塞到本轮完成再退出（无 `--no-wait`——CLI 进程退出即丢执行体，record 会卡 running）。bash `run_in_background` 场景直接让 CLI 阻塞到完成，由引擎跟踪该 bash 任务并在完成时唤醒。异步启动 + 聚合等待（`wait` / `start --wait`）走默认 daemon 模式（见下节）。

## 回接 2b break 变更（workflow 线换 vendored subagent-core orchestration）

zsw 自有 workflow 运行时（WorkflowManager + lib/workflow/ 管线 + workflow-script 旧契约）已整体退役，编排层换成 vendored `@zhushanwen/subagent-core`（`lib/orchestration-host.js` 宿主 + `lib/agent-runner-adapter.js` 执行桥）。**以下是调用方可见的行为 break，旧用法按本表迁移**：

**D6-⑧ 旧 `script:<name>` 脚本契约废弃**（daemon 内 fresh-require CJS、`ctx = {task, cwd, model, runAgent, log, params}` → 返回 `{markdown, json}`），新契约为 core worker 脚本（`@pi-meta` meta 块 + top-level `agent()`，在 core worker 线程执行）。迁移对照表：

| 旧契约（lib/workflow-script.js） | 新契约（core worker） |
|----------------------------------|----------------------|
| `module.exports = { name, description, run(ctx) }` | `/* @pi-meta name/description/phases */` 块注释 + top-level await 脚本（lint 强校验 `agent()`/`parallel()`/`pipeline()` 入口） |
| `ctx.runAgent({prompt, cwd, model, timeoutMs})` | `agent({prompt, model, timeoutMs, agent, schema, ...})`（每次调用一个独立 agent 会话） |
| `ctx.log(text)` | `log(text)` / `console.log`（core worker log 通道） |
| `ctx.params`（run 透传参数） | `$ARGS`（白名单外 flag 全进 `$ARGS`；`$ARGS.task` 恒并入） |
| 返回 `{markdown, json}` 或字符串 | `return <scriptResult>`（任意可结构化克隆值；CLI 渲染为「message 行 + JSON 块」双段） |
| 四根发现（`.agents/workflows` > `.zsw/workflows` 两级 × ws/HOME） | core 发现面（`.pi/workflows`、`.agents/workflows` × ws/HOME、`~/.zsw/workflows`）+ `<ws>/.zsw/workflows` 手工根；旧根大多保留但同名遮蔽优先级变化 |
| 脚本同目录 require 相对路径（进程 cwd） | 必须 `require(path.dirname(workerData.scriptPath) + "/dep.cjs")` 锚定（worker eval 沙箱相对路径以 cwd 为基准） |

**迁移对照完整示例**（任务「统计 src/ 代码量并总结质量」，`--subdirs` 自定义参数透传，无需特殊工具的形态）：

```js
// ---- 旧契约（lib/workflow-script.js 时代，已废弃）----
// CJS module.exports + run(ctx)，daemon 内 fresh-require 执行
module.exports = {
  name: 'code-stats',
  description: '统计 src/ 代码量并总结质量',
  async run(ctx) {
    ctx.log(`统计目录：${ctx.params.subdirs || 'src'}`);
    const r1 = await ctx.runAgent({                       // r1 = {ok, sessionId, response, usage, ...}
      prompt: `统计 ${ctx.cwd}/${ctx.params.subdirs || 'src'} 下 .js 文件数与总行数，只报数字`,
      cwd: ctx.cwd, model: ctx.model, timeoutMs: 300000,
    });
    const r2 = await ctx.runAgent({
      prompt: `基于统计结果写两句话质量总结：\n${r1.response}`, cwd: ctx.cwd, model: ctx.model,
    });
    return { markdown: `## 代码统计总结\n${r2.response}`, json: { stats: r1.response } };
  },
};
```

```js
// ---- 新契约（core worker 脚本）----
// @pi-meta 块注释 + top-level await，core worker 线程内执行
/* @pi-meta
name: code-stats
description: 统计 src/ 代码量并总结质量
phases: [stats, summarize]
*/
const target = `${$WORKSPACE}/${$ARGS.subdirs || 'src'}`;   // $ARGS = run 透传参数（--subdirs 白名单外 flag 自动进）
const stats = await agent({
  prompt: `统计 ${target} 下 .js 文件数与总行数，只回 JSON：{"files":n,"lines":n}`,
  timeoutMs: 300000,                                        // model 缺省继承 run 级 --model
  schema: { type: 'object', properties: { files: { type: 'number' }, lines: { type: 'number' } },
            required: ['files', 'lines'] },                 // schema 传入 → 返回结构化对象
});
log(`统计完成：${stats.files} 文件 / ${stats.lines} 行`);    // core log 通道（stderr + 落盘）
const summary = await agent({ prompt: `基于统计结果写两句话质量总结：${stats.files} 个文件，共 ${stats.lines} 行` });
return { summary, stats };                                  // scriptResult（任意可结构化克隆值）
```


**D7 旧 wf- record 不可读**：旧 WorkflowManager 把 run 状态写 `~/.zcode/zsw/records.jsonl`（`recordType:'workflow'` 事件流）+ 报告落 `outputs/<runId>.md`，该线已退役——新 run 的状态面是 `<zsw 数据根>/workflow-state/<runId>.jsonl`（core FileRunStore append-only 快照，`status` action 的 `stateFile` 字段即此路径），报告不落盘（CLI stdout 直出 scriptResult）。旧 record/报告文件留在原位可人工查阅，但 CLI/MCP 不再解析。

**daemon 重启恢复语义**：上一代 daemon 遗留的 `running` run 在新 daemon 启动/接管时统一标 `done,failed`（error = "daemon takeover: worker died with previous process"）——core worker 线程随宿主进程死亡，无进程可探活、不尝试续跑；这与 zsub 线 subagent 的探活/孤儿标记语义不同，是两线故意的差异。done run 内存保留上限 20 条（core `MAX_RETAINED_DONE_RUNS`），淘汰后 `status` 报可操作错误并指向 stateFile。

**run 参数面变化**：`--timeout-ms` 映射 RunSpec `budgetTimeMs`（整体墙钟预算，到期 `done,time_limited`）；`--model` 映射 `RunSpec.model`（run 级，agent() per-call 可覆盖）。`--max-concurrent` / `--timeout-per-phase` / `--subtask-count` 已废弃（core 编排无对应面），传入 stderr 显式 warning 不静默。review-fix-loop 的 `--reviewers` 显式报错（见上文）。

**通知面变化**：workflow 完成不再投 mailbox 通知（旧 WorkflowManager 的 notifyCompletion 线随 record 线退役）——CLI run 恒同步等终态，socket 面异步 run 用 `--action status` 查询。

## 回接 2c break 变更（执行链换 vendored core zcode engine；appserver 通道退役）

zsub 执行链（runner/spawn 驱动/模型执行解析）已整体替换为 vendored `@zhushanwen/subagent-core` 的 zcode 引擎（`lib/runner-core.js` 端口适配：`routeEngine` 三层路由 → `EnginePort.run` spawn 单轮）。**appserver 常驻通道按设计 D6-⑥ 显式退役**——统一走 core zcode engine 的 spawn 单轮。以下是调用方可见的行为 break：

**D6-⑥ appserver 通道退役（优势让渡与回归路线）**：appserver 的长驻进程 / 零冷启动续聊 / 实时进度流 / per-session model 设置暂时让渡——按上游设计（subagent-engine-abstraction §1 out of scope），常驻模式属「引擎内部优化项，不进首期接口实现」。回归路线 **P3**：core zcode engine 内部换常驻实现（EnginePort 接口已常驻友好，onEvent 回调式 + AbortSignal），届时 zsw 壳零改动获得全部能力；per-session model 的回收载体单列为 P3 的 core engine 配置面扩展。退役后：
- `ZSW_RUNNER=appserver` 启动即报退役错误（信息含回归路线指引）；`ZSW_RUNNER=spawn` 兼容 no-op（告警一次后忽略——通道本就是 spawn 单轮）；其余未知值一律前置报错。
- 旧 probe 门控 / `probe-cache.json` 落盘缓存 / 首败失效重探 / 通道级降级链 / `upgrade-notice.json` 升级标记（及其 CLI/MCP 投递面）整体删除。格式漂移检测改由 **core 引擎探针**承担（binary 存在 + `--version` 解析 + golden 样本干跑回归，引擎实例内缓存、`routeEngine` 每任务真探；CLI 升级后首个任务即暴露）。
- 常驻会话专属面消失：`session/resume` 断链自愈、`-32004` 会话驱逐恢复序、多会话单连接承载、实时推送帧归因——这些是 appserver 协议面概念，spawn 单轮无对应物。

**引擎数据布局（新）**：per-provider+model 隔离 HOME 池与引擎 journal 归 core，落 `~/.zcode/zsw/engines/zcode/home-<provider 安全化>-<model>/`（目录名经 core 路径段编码，模型名中的 `.` 归一为 `-`，如 `home-builtin-bigmodel-coding-plan-GLM-5-3`；`ZSW_ROOT` 覆盖时随之隔离）。凭据源不变（`~/.zcode/v2/config.json` 桌面登录态，池内 config 按 mtime 免重写）。旧 `home-<provider>-<model>/` 与 `home-appserver/` 池目录随自有 spawn 驱动退役——存量目录无害残留，可手工清理。

**message/close 降级语义（spawn 单轮）**：
- `message`（conversation 续聊）：**明确报错**——core EnginePort 面无 resume 入口（launcher 支持 `--resume` 但接口未透出），旧 spawn 通道的 `--resume` 冷续聊让渡，随 P3 常驻实现回归；错误信息含「重新 start 派发新任务」指引。conversation 任务的**首轮照常可用**（标志作用于 record 状态机：首轮完成置 idle），续聊轮落 error 终态。
- `close`：壳层 record 终态化 + worktree 清理不变；runner 无驻留会话对应物（`release` no-op）。

**模型链归属变化**：执行解析（模型校验 / 隔离 HOME 池 bootstrap / 兜底模型）归 core 引擎 preparer——zsw 的 `model-router` 瘦身为清单器（`zsw models` / SessionStart hook 注入面不变），manager 侧模型引用原始透传（短名/全名均可，未知模型在任务启动时报引擎的可操作错误，文案含可用清单）。**`zsw models` 面不变**。

**agent .md `engine:` 字段（core 路由三层）**：frontmatter `engine:` 现已生效（`lib/agent-md-resolver.js` 解析透传）——调用参数显式 engine（workflow `agent({engine})`）> frontmatter engine > 缺省 `zcode`（zsw 唯一生产引擎）。probe 失败按 core 守卫：调用参数显式指定不兜底（报 `engine_probe_failed`）；frontmatter/缺省来源 fallback 回缺省引擎并在 record 留痕 `engineFallback`；显式 model + 换引擎被守卫拒绝。record 新增 optional 字段 `engine` / `engineFallback`（实际执行引擎与 fallback 事实，旧 record 读取不受影响）。

**zsub 台账（records.jsonl）格式不变**：D7 调研结论——存量 record 全量可读（新增字段均为 optional，record-store 的 fold 是 Object.assign 不会破坏旧事件重放）；旧 spawn/exec 形态（`kind:'spawn'`, pid）与新引擎句柄同构。详查计划文档 `docs/design/zsw-subagent-core-rebind.impl-plan.md` §7 检查点 3 调研记录。

**其他行为差异**：
- 工具 denylist 升级：CLI `--deny-tools` 与 frontmatter `disallowedTools` **并集去重**后落引擎 `--disallowed-tools` flag（旧 spawn 通道只消费 frontmatter 侧；`--allow-tools` 白名单仍无 flag 通道，维持 prompt 软约束）。
- protocol-drift（`errorKind`）分类面随 JSON-RPC 通道消失退役（字段保留兼容旧 record 读取）。
- thinking / allow-tools 请求值在 spawn 单轮下恒不生效，record 维持 `'null (spawn 降级)'` / `toolsNote` 如实标注。
- 嵌套防护升级：core 公共 nesting-guard（`XYZ_AGENT_SUBAGENT=1` + 剥离 `ZSW_NESTED` 旧标记，防孙代误判嵌套层）。

## subagent-core 收口 break 变更（agent 发现 core 化 / 引用契约统一 / 注入三段 XML / 创作闭环）

zsw 的共享面——agent 模板资产与发现、SessionStart 注入渲染、workflow 脚本创作管线——已收口到 vendored `@zhushanwen/subagent-core`（与 pi 平台同源；设计见源仓库 `docs/design/subagent-core-convergence-design.md`）。zcode 侧开箱即得 vendored 内置 10 角色（reviewer/coder/planner 等，随 core 分发），注入块与 pi 同构（三段 XML，见下方「SessionStart 资源注入」节），workflow 脚本创作闭环（generate/lint/save/delete）全链 CLI 可用。**以下是引用契约统一的 breaking 迁移表（D-4：与 pi 平台对齐，zsw 侧收紧）**：

| 旧用法（zsw ≤2.0） | 新用法 | 说明 |
|---|---|---|
| `start --agent "reviewer"`（按名引用） | `start --agent "<location 绝对路径>"` | 按名引用被拒：报错 `Invalid agent ref: ...`（与 pi 侧 core 同源）并自带恢复指引。路径取 `zsw agents` 清单的 `location`/`file` 列，或注入段 `<available_subagents>` 条目的 `<location>` |
| `start` 不传 `--agent`（无角色裸跑） | 行为变化：缺省加载 `general-purpose` 内置角色 | 子进程 prompt 注入角色 body；record 的 agent 展示名从 `null` 变 `general-purpose`（仅展示面，任务书不受影响）；不想要角色时显式传自定义 .md 路径（project 级同名 .md 可遮蔽内置） |
| `workflow --workflow "script:tri-review"` | `workflow --workflow "/abs/path/tri-review.js"` | `script:` 前缀已废弃拒收（报错含恢复指引）；路径取 `zflow scripts` 清单的 `path` 字段或注入段 `<available_workflows>` 的 `<location>`，支持 `~/` 前缀展开 |
| `workflow --workflow "tri-review"`（裸名） | 同上（.js 绝对路径） | 裸名仅保留给内置 5 名——多源同名遮蔽下按名引用有歧义（所指取决于扫描序，模型不可见），路径引用所指即所载 |
| `workflow --workflow "chain"`（内置名） | 不变 | 内置名是稳定 API 面（chain/parallel/map-reduce/scatter-gather/review-fix-loop），保留人机友好形态 |

**agent 发现的两类收窄（W6a 登记，core 单层扫描语义）**——zsw 旧自写 resolver 递归扫描（深度 16、排除 node_modules），收口后 core 扫描**单层不递归**（pi 侧既有契约）：

1. **子目录布局需平铺或建 symlink**：agent .md 放在发现根的子目录里（如 `~/.zcode/agents/refs/reviewer.md`）不再被扫到——平铺到根一层，或对单个 .md 建文件级 symlink（core 扫描 follow 文件级链接）。
2. **目录 symlink 整库：库内容需平铺在库根一层**：发现根下指向个人技能库目录的一级目录 symlink（如 `agents/my-lib -> ~/Code/personal-agents/`）会被宿主层动态展开（同标签额外扫描根，realpath 防环）——但展开深度仅一层，库内子目录与库内嵌套链接不可见；库内容需平铺在库根一层。库更新可持续（每次发现时重新展开）。

## CLI 默认形态：daemon thin client（1.0.0 起）

1.0.0 起 CLI 默认即常驻 daemon thin client（不加任何 flag；unix socket；sock 默认 `~/.zcode/zsw/daemon.sock`，env `ZSW_SOCK` 可覆盖，测试隔离用）。执行体由 daemon 持有——CLI 退出不丢，`start` 默认异步启动，`start --wait` 为 start+wait sugar；`wait` 子命令：`zsw wait --id a [--id b ...] [--timeout-ms n]`（无 `--local` 形态——本地一次性进程没有可挂起的等待方），等待在 daemon 侧内存挂起（零轮询），多 id 全部终态才返回，`--timeout-ms` 到点回 partial 结果并以 exit 2 退出。

agent 侧推荐组合：Bash 工具 `run_in_background=true` 包裹 `zsw start --wait …` 或 `zsw wait --id …`——CLI 阻塞进程成为引擎进程内 background 任务，完成即触发引擎原生 task-notification 唤醒会话（idle 也唤醒），不依赖 mailbox env、无需 sleep 轮询。

生命周期：daemon 由启用插件的 zcode 会话自动拉起（MCP server 进程竞选，无额外安装步骤），挂靠任一会话的插件进程——**所有会话关闭则 daemon 退场**，其持有执行体的任务终止（record 已落盘，由下一次接管实例 recover 探活标记 orphan/dead，不产生静默僵尸）。daemon 不在场时 CLI 报错并给恢复指引（稍候重试，其他实例接管需 1-2s；在任一 zcode 会话确认插件已启用；或加 `--local` 走本地一次性执行——调试后门：无续聊/限流，CLI 退出即丢执行体）。`zsw workflow` 的 abort/status/list/scripts 管理面默认同走 daemon（跨进程 record 一致）；run/lint 恒本地——run 执行体 = CLI 进程本身，前台同步跑到终态，无 abort 面（bg bash 形态的取消用引擎 TaskStop 杀 CLI 进程）；abort 只作用于 daemon 内存中的 run——本地 CLI run 不在 daemon runs 表，经 daemon abort 报 not found。

## 从 dynamic-workflow 迁移

原 dynamic-workflow 插件已卸载（config.json 的 plugins 注册已移除），全部能力并入本插件；回接 2b 起 workflow 线进一步整体替换为 vendored subagent-core orchestration（5 个内置形态名保留、实现换 core 资产；旧 `script:<名>` 契约与 wf- record 状态面 break，迁移对照见「回接 2b break 变更」节）。tool 名曾从 `mcp__dynamic-workflow__zflow` 改为 `mcp__zsw__zflow`（MCP 工具面时代命名；1.0.0 工具面下线后入口为 CLI `zsw workflow` 子命令），命名体系见 CONTEXT.md。旧插件目录保留在原 worktree 作历史归档。

结果全文落 `~/.zcode/zsw/outputs/<id>.md`；worktree 任务的 patch 落 `<id>.patch`（完成通知含 `git apply` 指引）。

## 状态与目录

```
~/.zcode/zsw/
├── records.jsonl        append-only 事件流（zsub subagent 线；崩溃后重放恢复。回接 2b 起
│                        workflow 线不再写入——旧 wf- record 留存可读但无消费方）
├── workflow-state/      workflow run 状态快照（core FileRunStore：<runId>.jsonl append-only，
│                        末行有效行 = 最新状态；daemon 启动/接管时重水合孤儿 run）
├── outputs/             subagent 结果全文 + patch（workflow 报告线已退役，CLI stdout 直出）
├── daemon.sock          daemon 控制面 unix socket（0.2.0+，ZSW_SOCK 可覆盖）
├── daemon.sock.lock     daemon 竞选锁文件（O_EXCL 原子裁决）
├── logs/                core 编排日志（workflow-core.log）
├── engines/zcode/       core zcode 引擎数据（回接 2c：per-provider+model 隔离 HOME 池
│   home-<provider>-<m>/  + journal，布局归 core paths SSOT；目录名路径段编码，'.'→'-'）
├── home-*/              旧 spawn/appserver 池目录（已退役，存量无害残留可手工清理）
└── wt-<id>/             worktree 隔离目录（任务期存在）

（review-fix-loop 的 run 目录由 core 资产自管：~/.review-fix-loop/<repo-slug>/<runId>/，
 含 state.json 与各轮 reviewer 报告——不在 zsw 数据根下。）
```

## 已知边界（如实声明）

- **mailbox 完成通知是 legacy 通道（仅 MCP 工具面时代有效）**：mailbox 投递需要会话定向（targetSessionId），只有 MCP 工具调用携带；1.0.0 工具面下线后 CLI/daemon 面恒无投递目标，notifyCompletion 必不投递（句柄 notify 字段如实标 `none`，不写 `mailbox` 误导「会自动回流」）。M1 默认形态（CLI daemon）任务的完成唤醒唯一路径 = CLI 阻塞进程（`wait` / `start --wait`）配 Bash `run_in_background`，成为引擎进程内 background 任务、完成即触发原生 `<task-notification>`（idle 也唤醒，不依赖任何 env）。需要「完成即唤醒 + goal gate」的简单任务仍可直接用原生 `@agent`。
- **执行通道 = core zcode engine spawn 单轮（回接 2c；appserver 已按 D6-⑥ 退役，迁移对照见「回接 2c break 变更」节）**：`zsw start` 与 workflow 每阶段各 spawn 一个独立无头 zcode 进程（`--json --mode yolo`，~1-2s 冷启动/轮）。每任务启动经 core `routeEngine` 真探（binary + version + golden 干跑，引擎实例内缓存——进程存活期不重探，CLI 升级后重启进程/首任务即暴露漂移）；引擎 preparer 内做模型校验（凭据源 `~/.zcode/v2/config.json`）与 per-provider+model 隔离 HOME 池引导（落 `<zsw 数据根>/engines/zcode/`），未知模型/缺凭据在任务启动时报含可用清单的可操作错误。取消/超时 = AbortSignal → core 杀链（SIGTERM→5s→SIGKILL）。
- **conversation 续聊暂不可用（core EnginePort 面无 resume 入口）**：conversation 任务首轮照常（完成置 idle），`message` 续聊明确报可操作错误（含「重新 start」指引）；旧 spawn `--resume` 冷续聊让渡，P3 常驻实现回归（见「回接 2c break 变更」节）。busy 语义不变：running 中投递返回 busy 结果。
- **workflow 中止语义（回接 2b 后）**：daemon 形态（socket 面派发、执行体 = daemon 进程内 core worker 线程）的 `abort` 走 core `abortRun`——worker 线程 terminate、run 立即落 `done,aborted` 并写快照；在飞 agent() 轮经 runner-core 的 AbortSignal → 引擎杀链立停（2c 起 spawn 单轮可中断）。`zsw workflow run` 本地一次性进程的中止是进程级：Ctrl-C/SIGTERM 下 CLI 与 worker 线程/引擎子进程一同退出；取消 bg bash 形态的本地 run 用引擎 TaskStop。
- **`ZSW_RUNNER` 已退役（2c）**：'spawn' = 兼容 no-op（告警一次后忽略）；'appserver' / 未知值 = 启动即报错（见「回接 2c break 变更」节）。
- **running 会话不可插话（busy）**：message 投递到 running 中的会话立即返回 busy 结果（stdout JSON `busy:true` + exit 0，非报错退出；不排队不打断），等待本轮完成（`zsw wait --id <id>`）或 `zsw cancel --id <id>` 取消后再投递（2c 起投递即报退役错误，见上）。
- **工具黑名单是引擎级硬拦截（两来源并集去重），`tools` 白名单维持软约束**：黑名单 = CLI `--deny-tools`（逗号分隔裸工具名）∪ agent .md frontmatter `disallowedTools`，并集去重后落引擎 `--disallowed-tools` flag（2c 起两来源等价生效）。`--allow-tools` 白名单与 frontmatter `tools` 白名单均无 flag 通道（zcode CLI 无 allowlist flag，`--allowed-tools` 拒收），只能约束意图不能拦截行为——record 终态 toolsNote 如实标注。
- **subagent 并发池与 workflow 并发治理已分治（回接 2b 后）**：subagent 池默认 3（`ZSW_MAX_CONCURRENT` 可调）仅约束 zsub start 线；workflow 线的并发由 core 资产内部形态决定（`parallel()` 共享 core 配额池、顺序编排逐个执行），zsw 侧不再有独立 workflow 槽位池，`--max-concurrent` 已废弃。
- **并发深度分层当前为预留**：嵌套环境（ZSW_NESTED）被双门禁直接拒绝，实际 depth 恒 0——分层逻辑保留给未来放开受限嵌套服务时使用。
- **mailbox 引擎侧语义（legacy 通道的如实现记录）**：drain 单次最多 20 条（本插件用单调文件名防挤窗）；会话 mailbox 内若有外部坏 envelope 文件会永久阻塞该会话 drain（引擎无 quarantine，本插件投递已用原子写 + 写前自检规避）。通道在工具面下线后不再有投递方，条目留作历史与 notifier-mailbox.js 的实现依据。

## 排障

### ps 里看到多个 zcode 无头进程，是不是泄漏？

回接 2c 后执行体是 spawn 单轮的 `node <zcode路径> --json ...` 短命进程（任务期存在、done 即退出），并发任务数等于进程数（subagent 池默认 3，`ZSW_MAX_CONCURRENT` 可调）。长驻泄漏的判据：任务全部终态后仍有 `--json --prompt` 形态的 zcode 进程存活——用 `pgrep -f 'zcode.cjs --json'` 核对，残留进程 `kill <pid>` 即可（record 已落盘，下一次 recover 会把死 pid 标 lost）。旧 appserver 常驻进程（`app-server --cwd` 形态）已随通道退役，不应再出现。

**怎么判读**（看输出的 PID 列）：

- 只有 1 个 pid：正常（单引擎）。
- pid 数 > 1：先回想刚才是否跑过 `--local` 命令、或刚重启过 ZCode——这类短暂多开会随进程退出自行消失，等几分钟复查即可。
- 持续多开（隔几分钟复查 pid 不减）：旧引擎残留，kill 掉多余 pid 即可（`kill <pid>`，顽固时 `kill -9`）。

**kill 会不会丢数据**：不会。会话记录落在 SQLite 里多进程可读，被杀引擎名下的会话换个引擎仍可 list / resume；运行中的任务会以连接中断如实报错（重跑即可），已完成任务的结果不受影响。

## 验收手册（真机 GUI，安装后逐项执行）

| # | 场景 | 步骤 | 通过标准 |
|---|------|------|----------|
| M1 | 原生唤醒 | GUI 会话让 agent 用 Bash `run_in_background=true` 跑 `node bin/zsw.js start --wait --task "数一下 README 有多少行" --slug count`，随后让 agent 结束 turn | 会话被 `<task-notification>` 自动唤醒（无需用户发言），agent 读取结果并转达 |
| M2 | 跨会话可见 | 窗口 A start（异步），窗口 B `node bin/zsw.js list` / `status --id` | B 能看到 A 派的任务与状态（record 同盘共享） |
| M3 | 降级 | 不设 mailbox env（polling 档，legacy 通道不启用），同样 start（异步） | 返回含轮询指引（时间预期 + CLI 等待姿势）；status 能拿到终态 |
| M4 | worktree | 干净主树 `node bin/zsw.js start --worktree --task "在 src/ 新增 hello.ts" --slug wt` 后 wait | 主树干净；结果含 patchFile；`git apply --check <patch>` 通过 |
| M5 | 执行通道与续聊降级 | 不设任何 env 跑 `node bin/zsw.js start --wait`（单轮任务）；再跑 conversation 任务 + `message` | record.runnerKind='spawn'、record.engine='zcode' 留痕；conversation 首轮 idle、message 续聊报「无 resume 入口」可操作错误（2c 契约，见「回接 2c break 变更」节） |

无头 e2e（E1-E8，真实 zcode 无头进程 + 真实模型）见 `test/e2e.test.js`，`node --test test/e2e.test.js` 自动运行（注意模型 token 消耗与账户限流窗口）；支持单场景入口 `node test/e2e.test.js --name E1`。appserver 专有场景（E9 apc-smoke 冒烟 / E10 多会话并发）已随 D6-⑥ 退役删除——升级漂移核对改由 core 引擎探针（golden 干跑回归）承担；E3/E7 已改 spawn 通道形态（续聊报退役错误）。

## SessionStart 资源注入验收手册（三段 XML 资源清单）

zsw 注册 SessionStart hook，在会话启动时向主 agent 上下文注入三段 XML 资源清单（`<available_subagents>` / `<available_workflows>` / `<available_provider_models>`，W7 起由 core 渲染函数产出——tag/字段集与 pi 平台同构；旧单块 `<zsw-resources>` 形态已退役），模型路由与委派决策零工具调用可得；快照可能过期，`zsw models` 等查询命令保留为权威兜底。设计全文见源仓库（github.com/zhushanwen321/zcode-plugins）根 `docs/design/zsw-session-start-injection-design.md` 与 `docs/design/subagent-core-convergence-design.md`。

### 块形态与生效条件

会话启动时上下文头部出现（示意样例，内容以本机环境实测为准；三段各自带引导文案，空清单段自然缺席）：

```
<available_subagents>
The following subagents are available. PRIORITY: … delegate to a matching subagent FIRST …
pass the <location> path (absolute .md path) as the --agent param — bare names are rejected. …
  <agent><name>analyst</name><description>深度项目分析 agent（只读，产出给人读的报告…）</description><when>深度分析某项目/repo 架构…</when><location>/…/lib/vendor/subagent-core/agents/analyst.md</location></agent>
  <agent><name>reviewer</name><description>代码审查与需求验收 agent（只读含 git diff…）</description><when>用户要求 review/审查代码或 diff…</when><location>/…/lib/vendor/subagent-core/agents/reviewer.md</location></agent>
  …（vendored 内置 10 角色 + 用户四根里的自定义，码点序）
</available_subagents>

<available_workflows>
The following workflows are available. Run them via the zsw CLI workflow subcommand: built-in names are
passed to --workflow <name> directly; custom scripts must be passed by their <location> absolute .js path …
  <workflow><name>chain</name><description>通用编排：analyze → transform → synthesize 顺序三步链</description><location>/…/lib/vendor/subagent-core/workflows/chain.js</location></workflow>
  …（内置 5 + 用户脚本，带 location）
</available_workflows>

<available_provider_models>
The following models are available. Use these ids when passing --model to zsub/zflow: …
Current default model: builtin:bigmodel-coding-plan/GLM-5.3-Flash. … Snapshot generated 2026-…Z at session start …
  <model><id>5c5bb493-…/MiniMax-M3</id><name>MiniMax-M3</name><contextWindow>1000000</contextWindow></model>
  <model><id>builtin:bigmodel-coding-plan/GLM-5.3</id><name>GLM-5.3</name><caps>reasoning</caps><contextWindow>1000000</contextWindow></model>
  …（全名 <provider>/<model>；caps/contextWindow 标注推理档位与窗口）
</available_provider_models>
```

（分段条目预算语义：subagents 段条目预算 15、workflows 段 10，条目按 name 码点序排、超预算截尾部条目并追加「完整清单：zsw agents / zflow scripts」兜底指引行；models 段完整永不截。内置条目无截断豁免——码点序统一截尾行为可预测，兜底指引可恢复。旧单块的 45 行总预算与两层渲染已随 W7 退役。）

生效条件：

1. 插件已启用（`zcode plugins list` 见 `z-subagent-workflow` enabled）。
2. hook 注册于 `hooks/hooks.json`：SessionStart → `node "${ZCODE_PLUGIN_ROOT}/bin/zsw-hook.js"`（timeoutMs 5000；hook 内任一异常输出 `{}` + exit 0 静默降级，会话照常启动；`bin/zsw.js hook session-start` 是等价的 CLI 调试面）。
3. **改 hooks 注册或插件文件后必须重启 ZCode 才生效**——GUI 只在启动时扫描插件配置。

### 验收场景（S1-S7）

以下 GUI 场景均需重启 ZCode + 真实 token（S2/S4 涉及真实 spawn，用最小任务书）。S1-S6 依赖真实 GUI 与真实插件加载，无法 mock（引擎 hook 触发链是验证对象本身）；涉及与 `zsw models` 对照的场景，前置条件：先开一个启用插件的会话拉起 daemon（或以报错内清单作为对照权威源）。

| # | 场景 | 步骤 | 通过标准 |
|---|------|------|----------|
| S1 | 主 agent 零调用报清单 | 重启 ZCode 开新会话 → 问「现在哪些模型可跑？默认哪个？短名和全名怎么用？」（④ 的验证需换到含项目级 agent .md 的仓库开会话执行，或按 P-cwd 手册条目在 GUI 场景单独执行） | agent 不调任何工具，答出：① 默认 provider 的**模型名单**与 `zsw models`（另开终端跑）一致，且 models 段引导文案的「Current default model: <全名>」句与之一致（字段粒度不做要求——`zsw models` 返回结构化条目，注入段渲染名单+caps/窗口）；② 其余可运行 provider 以全名形态列出；③ 短名/全名使用规则与 resolve 语义一致（短名=默认 provider，跨 provider=全名）；④ 在含项目级 agent .md 的仓库开会话时，`<available_subagents>` 段含该项目级 agent 名（P-cwd 的 GUI 侧断言落点） |
| S2 | 路由决策一步到位 | 新会话让 agent 派发两个 zsub（一重一轻，见上文样例） | agent 直接按块内引用构造参数（重 → 显式 `--model GLM-5.3`；轻 → 不传跟随默认 Flash），全程未跑 `zsw models`；两任务受理成功 |
| S3 | 快照过期自愈（负面场景） | 会话中途 GUI 停用一个 provider → 让 agent 用该 provider 模型派发 | 收到既有可操作报错（含可用清单）→ agent 换模型重传成功；无卡死、无静默失败 |
| S4 | 嵌套会话不污染 | S2 的重任务 task 书里加「报告你上下文是否有 `<available_subagents>` 等资源注入段」 | 子代理回答没有；主会话三段注入仍在 |
| S5 | hook 故障降级 | 关闭其他 zcode 会话 → `chmod 000 ~/.zcode/v2/config.json` → 立即手跑 `node bin/zsw.js hook session-start` 验证输出 `{}` exit 0 → `chmod 644 ~/.zcode/v2/config.json` 恢复 → 重启 ZCode 开新会话 | 手跑降级正确；恢复后会话正常启动无报错弹窗、上下文有块；全程窗口 < 1 分钟（chmod 000 为最小窗口，验证后必须立即执行恢复命令） |
| S6 | resume/compact 行为 | ① resume 一个已注入会话 ② 触发 compact | ① 块出现次数 ≤1（对应 P-resume-dup）② compact 后上下文出现**新快照**（时间戳更新） |
| S7 | 发版完整性 | `node scripts/check-pack.js` + `node scripts/check-sync.js`（cwd = workspace 根）+ 装正式版验证 | hooks/ 在 npm 包内；三处版本一致；marketplace 安装版 hook 同样生效 |

### 手工探针命令（cwd = 插件目录）

> hook 注册入口是 `bin/zsw-hook.js`（自包含薄入口，插件文件缺失也降级 `{}` + exit 0）；`bin/zsw.js hook session-start` 是等价的 CLI 调试面（delegator）。以下命令两者皆可，以 `bin/zsw-hook.js` 为准。

- **P-cold-start（hook 不拖慢会话启动）**：`time node bin/zsw-hook.js` 跑三次取中位，通过标准 < 500ms（hook 内联执行，延迟直接计入会话启动；耗时与 projectDir 来源在 stderr 可观测行 `[zsw:hook] projectDir=… source=env|cwd … elapsed=<ms>`）。
- **P-cwd（`ZCODE_PROJECT_DIR` 注入生效、项目级根定位正确）**：

  ```bash
  ZCODE_PROJECT_DIR=<含项目级 agent 的仓库（其 .agents/agents/ 或 .zcode/agents/ 下有 agent .md）> \
    node bin/zsw-hook.js
  ```

  通过标准：输出 JSON 的 `additionalContext` 含该仓库的项目级 agent 名，stderr 可观测行 `source=env`（GUI 侧断言 = S1 通过标准 ④；失败降级路径见源仓库设计文档 §3.5 P-cwd）。
- **P-nested-guard（嵌套会话不注入，实施期门复跑）**：`ZSW_NESTED=1 node bin/zsw-hook.js`，期望 stdout 为 `{}` 且 exit code 0（只验输出不验 exit code 会漏掉 exit 1 违规形态——非零退出会在会话启动 raise error）。

### 已知边界（如实声明）

- **快照语义**：三段注入在会话启动时生成，会话中途 GUI 改动（停用 provider、增删 agent/script 等）不反映进已注入的段。兜底两条：传错模型名时报错自带可用清单（零依赖权威兜底）；或主动现查 `zsw models`（默认 provider 明细）/ `zsw models --all`（全部带凭据 provider 全名视图，与 `<available_provider_models>` 段同口径）/ `zsw agents`（需 daemon 在跑——任一启用插件的会话）。与 skill `zsub-zflow-orchestration` 模型路由纪律（快照优先 + 两条兜底）同口径。
- **模型名权威序**：具体模型名以注入块与报错内清单为准（实时快照）；AGENTS.md / SKILL.md 等静态文本中的具体模型名是档位策略参考，可能随环境漂移——按静态名字直传失败时以报错内清单重传。
- **token 代价**：SessionStart 的 matcher 值域只有启动源，会话启动时无法预判该会话是否使用 zsw——装了插件但全程没用 zsw 的会话也注入这份快照（分段条目预算：subagents 15 / workflows 10 / models 完整；开箱场景三段合计约 30-40 行）。这是已声明的方案代价，非缺陷。
- **hook 超时是静默丢块**：引擎在 timeoutMs（本插件 5000ms）到点杀进程，不走 hook 内部降级——表现是上下文没有块、无报错。排查：看 ZCode 日志中 hook 执行记录（outcome=timed-out 与耗时），并手跑 `time node bin/zsw-hook.js` 复现慢源。同类监控点：引擎升级后首会话确认块在场（stdout 截断/事件契约变化都会以「块消失」形态出现）；hook 命令依赖 PATH 上的 node（与 z-tool-finder 同担，GUI 经 Finder 启动时 PATH 形态不同则 exit 127 → 会话启动 raise error）。
- **嵌套子会话不注入**：双保险——① hook 入口 `ZSW_NESTED=1` 守卫直接输出 `{}` + exit 0；② 被 spawn 的 zsub 运行在隔离 HOME（`~/.zcode/zsw/home-*`），该环境本就不加载用户插件。
- **resume 场景块数 ≤1 依赖引擎行为**：hook 未设 matcher（startup/resume/clear/compact 四种启动源都注入；compact 后重注入是特性——压缩丢细节，新快照补位）。resume 是否重放历史注入块属引擎运行时行为，由 P-resume-dup 探针把关（S6①）；若复现两份块属已知现象、非正确性问题（token 翻倍但内容一致），失败时降级路径为 matcher 收窄 `startup|compact`。
