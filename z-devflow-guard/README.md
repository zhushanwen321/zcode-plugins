# z-devflow-guard

zcode dev-flow 会话的确定性 workflow 守卫（guard，把关角色：拦截 dev-flow 执行态会话中的违规 subagent 派发；plugin hooks，零依赖）。

## 要解决的问题

dev-flow-wf / tech-design-wf 技能的执行契约要求：任务执行期间主会话的一切 subagent 派发都必须经 workflow 引擎（CreateWorkflow），不允许主 agent 用 Agent 工具单独派发。历史上出现过主 agent 未发起 workflow、手工派 general-purpose 子代理代替契约 workflow 的事故。本守卫把这条约束落在机制层（hook exit 2 deny），不依赖提示词自觉。

## 机制

三个 hook，全部由本 plugin 的 `hooks/hooks.json` 注册（plugin hooks 自动启用，无需配置开关）：

| hook | matcher | 动作 |
|------|---------|------|
| UserPromptSubmit | `[Dd]ev[-_ ]?[Ff]low`（对 prompt 文本做正则） | 命中即为本会话打「已进入 dev-flow 执行态」标记 |
| PreToolUse | `Read\|Bash\|Edit\|Write\|Glob\|Grep\|ApplyPatch\|Skill` | 工具参数含 `skill-data/dev-flow/` 指纹 → 打标记并记录任务目录；Skill 调用 dev-flow-wf → 打标记 |
| PreToolUse | `Agent\|Task` | 拦截判定：派发内容（prompt + description）指向在途 dev-flow 任务时 exit 2 拒绝，stderr 回给主 agent；无关任务的派发一律放行 |

进入执行态的三个来源取 OR：用户输入命中 dev-flow 字样、Skill(dev-flow-wf) 被调用、内容工具触碰 `skill-data/dev-flow/` 产物。中途续跑（用户只说「继续」）靠指纹源命中——恢复上下文必读 status/exec-plan。

## 拦截条件与终局判定

对一次 Agent/Task 派发，拦截需同时满足三条：会话有 dev-flow 执行态标记、标记关联的任务目录中存在在途任务、**派发内容（prompt + description）命中该任务的特征串**。特征串 = 任务目录名 + 各 `*.status.json` 的 `name` 字段——任务书必引用产物路径与任务名（对真实事故会话 16 个手工派发验证 16/16 命中），而无关任务的派发内容不含这些串。subagent 类型名（general-purpose / u-dev 等）不参与判定。

在途/终局判定依据 dev-flow-wf `flow/compile.md` §4，单个 `*.status.json` 满足任一条即终局：

1. `events` 数组含 `run-terminal` 汇总事件（引擎终局时写入，实证 32/32 任务均有）；
2. 防御性补充：全部节点 `status` 已到终值集（`done / blocked / failed / suspended`）。

已终局的任务目录不再产生特征串——复盘/考古类派发（引用已完结任务名）放行。status.json 解析失败按非终态处理（宁可误拦，有豁免通道救济）。任务目录下尚无 status.json（D0 建档前）无特征串，放行——「任务开始前的合法 subagent」不被误杀。

## 状态隔离（按会话）

标记与豁免文件都放在 `~/.zcode/z-devflow-guard/state/`，以会话 id 命名分片（`<sessionId>.json` / `<sessionId>.waive`），文件名经字符消毒。任何会话（含并行会话）只读写自己 id 对应的文件，没有跨会话共享的开关。超过 7 天未更新的状态文件被惰性清理。

无头嵌套会话（`ZDG_NESTED` / `ZWR_NESTED` / `ZSW_NESTED` / `ZSUB_NESTED` / `TF_NESTED` 任一环境变量存在）不参与拦截。

## 误判救济（waive）

守卫只拦「派发内容指向在途任务」的 Agent/Task 调用，不拦主 agent 直接用 Read/Grep/Bash 等工具干活。已知误判形态与救济：

- 派发内容只是引用了在途任务的产物路径（如考古在途任务的修复史），实际工作与该任务的执行无关；
- workflow 发起失败后走合规降级路径。

两种情形写本会话豁免文件后重试原操作（deny 消息里带具体路径）：

```sh
touch ~/.zcode/z-devflow-guard/state/<sessionId>.waive
# 或 CLI：node <plugin>/bin/zdg.js waive
```

豁免按会话隔离，仅对当前会话生效（豁免后守卫在本会话内不再拦截）。

## 已知边界

- 主 agent 不派 subagent、用直接工具自己干活冒充 workflow：物理拦不住，靠事后审计（workflow 有 status 事件与 gate 日志落盘，手工路径没有）。
- 判定异常（fs 故障等）放行并在 stderr 留痕：守卫自身故障不拖垮正常派发，日志可追。

## CLI

```sh
node bin/zdg.js status [sessionId]   # 查看会话标记、各任务目录终局状态、当前裁决
node bin/zdg.js waive [sessionId]    # 写本会话豁免文件
```

## 开发

```sh
node --test test/                    # 单测
node <workspace>/scripts/check-sync.js   # 三清单（package.json / plugin.json / marketplace.json）一致性检查
```
