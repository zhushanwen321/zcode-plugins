# z-quota-watch

zcode 的额度守望兜底插件。PreToolUse hook 按会话内工具调用计数门控（计数超过
20 触发一次检测并清零，即每 21 次工具调用检测一次），检测到「会话模型为 GLM
套餐模型 且 没有存活的 quota-wait 守望后台任务」时，注入一条现成命令让 agent
用 Bash `run_in_background` 起一个守望任务——守到当前 5 小时窗口结束 +1 分钟
退出，完成通知回会话后按 quota-wait 技能模式 B 的检查点语义续接。

## 检测链（hook 子命令）

```
PreToolUse（每次工具调用）
  └─ sh 门控：会话计数 +1，超过 20 才起 node（写回 0；其余调用 ~5ms 直通）
      └─ zqw.js hook pre-tool-use
          1. 嵌套无头子会话（ZSW_NESTED 等）→ 跳过
          2. 叫停抑制（suppress）或失败冷却（10min）未过期 → 跳过
          3. 模型判定：db message 表该会话最近 modelId → 回落 config.json model.main
             非 GLM 系或非 account: 套餐 provider（自配 key 型无 5h 窗口）→ 跳过
          4. ps 扫描本会话守望进程（zqw-watch.js --session <id> 标记）→ 已存活则跳过
          5. 注入 additionalContext：给出可直接执行的 zqw-watch.js 后台命令
```

## 为什么 hook 不直接 spawn 等待进程

zcode 会话的后台任务完成通知（退出唤醒会话）只覆盖 agent 用 Bash 工具
`run_in_background` 起、注册进 app-server 内存任务表的任务；hook 进程自己 spawn
的进程注册表进不去，退出无声无息。因此本插件采用「hook 检测 + 注入命令 +
agent 起任务」的形态，保住到点唤醒语义。

## zqw-watch.js（守望 wrapper）

- `--until` 缺省时先跑 quota-wait CLI 的 `--dry-run` 查当前窗口结束时刻，+60 秒
  作为目标时刻（防窗口边界竞争）；
- 转发 CLI stdout（完成通知可读末行 JSON 摘要），结果摘要落盘
  `~/.zcode/z-quota-watch/state/<session>/result.json`；
- 被 TaskStop 杀掉时信号传导给 CLI 子进程，防孤儿。

## CLI

```
node bin/zqw.js status                                   # 各会话计数 / 守望进程
node bin/zqw.js suppress --session <id> [--for +2h]      # 叫停注入（默认 24h）
node bin/zqw.js reset                                    # 清空状态
```

## 依赖与边界

- 依赖本机 quota-wait 技能 CLI（默认 `~/.agents/skills/quota-wait/scripts/quota-wait.mjs`，
  可用 env `ZQW_QUOTA_WAIT_CLI` 覆盖）及其 taiji 凭证链——离开本机环境安装时
  需先装该技能，否则 wrapper 启动即失败（hook 有 10 分钟失败冷却，不会反复催起）。
- 模型判定依赖 `~/.zcode/cli/db/db.sqlite`（只读）与 `config.json`；db 不可读时
  hook 静默降级，永不阻断会话。
- 注入只是提醒：agent 不执行时，下一个 20 次计数周期会再次注入（自愈）；无
  100% 硬保证。
- subagent 子会话不触发 hook（zcode 引擎不为其构造 hook runner）；workflow 沙箱
  无 hook，同样不在覆盖面内。

## 测试

```
node --test          # 插件目录内
```
