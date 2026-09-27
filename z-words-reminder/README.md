# z-words-reminder

zcode 的周期性易读性提醒插件：`UserPromptSubmit` hook 按会话计数用户消息，每第 3 条注入一次提醒——要求助手对回复中本对话首次出现的概念先铺垫背景再使用、编号带中文类型词、用语遵守全局 AGENTS.md 词表。

## 为什么需要它

长会话中助手会自然演化出内部压缩词汇（编号、机制简称），规则（全局 AGENTS.md 规则 15 与「用语纪律」节）虽然 always-on，但生成瞬间模型的注意力在任务正确性上，合规没有触发点——结果是与用户的沟通反复出现「深入但缺背景」「黑话/裸编号」，用户只能事后逐次纠正。本插件把防线前移到生成前：周期性注入提醒，触发模型在写回复时完成一次「为没读过中间过程的读者重写」的注意力切换。它是注意力触发器，不是新规则——规则本体始终在全局 AGENTS.md，文案只复述要点并指向权威，避免同一规则出现两份副本各自演化。

## 机制

```
用户消息 → UserPromptSubmit hook（node bin/zwr.js hook user-prompt-submit）
         → 嵌套防护（ZSW/ZSUB/TF/ZWR_NESTED 任一存在则跳过：无头子会话无真实用户输入）
         → 会话计数 +1（状态文件 ~/.zcode/z-words-reminder/state/<session-id>.json）
         → 计数 % 3 == 0 时输出 {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext": 提醒文案}}
           否则输出 {}（空输出，会话照常）
```

- 计数按会话隔离（`CLAUDE_SESSION_ID` 环境变量，hook 运行器注入）；缺失时降级为 `default` 单键全局计数。
- 状态文件保留 7 天，写入时惰性清理过期文件。
- hook 任何异常都输出 `{}` 以退出码 0 结束——提醒功能故障不阻断会话（辅助功能降级原则）。
- 注入文案见 `lib/reminder.js` 的 `REMINDER_TEXT`：概念首现铺垫、编号带类型词、汇报按「读者只读过开局目标与自己最近一条消息」写、遵守用语纪律词表、不重复展开已解释概念。

## 安装

marketplace（zcode-plugin-workspace）方式：

```
zcode plugins update-marketplace zcode-plugin-workspace
zcode plugins install z-words-reminder@zcode-plugin-workspace
```

安装后**重启 ZCode**（GUI 只在启动时扫描插件配置）。inline 本地开发注册见 `docs/extensions/local-dev-guide.md`。

## 调试

```
ZWR_DATA_DIR=/tmp/zwr-debug node bin/zwr.js status   # 查看计数（指定隔离目录）
node bin/zwr.js status                               # 查看真实数据目录计数
node bin/zwr.js reset                                # 清空计数状态
```

hook 执行记录（触发/超时/失败）在 ZCode 日志中查看。

## 验收手册（真机 GUI）

| 场景 | 步骤 | 通过标准 |
|------|------|----------|
| 周期注入 | 新会话连发 3 条消息，第 3 条后观察助手回复 | 回复对新概念有一句话铺垫、编号带中文类型词；前 2 条无变化 |
| 会话隔离 | 会话 A 发 2 条后切到会话 B 发 1 条 | 会话 B 不触发注入（独立计数） |
| 计数落盘 | 发 1 条消息后跑 `node bin/zwr.js status` | 出现本会话 id 且 count=1 |
| 不阻断 | 正常对话 | hook 异常时（可临时改坏 ZWR_DATA_DIR 权限验证）会话照常，仅 ZCode 日志有失败记录 |

## 已知边界

- 注入是注意力触发不是强制：对「遵守词表」的最终保证仍在模型与 AGENTS.md 判据，本插件提高命中率而非 100% 拦截。
- 每 3 条计数包含「继续」「好」等短消息（语义上它们也是用户消息）。
- `CLAUDE_SESSION_ID` 缺失的环境下降级为全局计数：多个并发会话共享计数，注入节奏变为「所有会话合计每 3 条一次」。
- 提醒文案引用全局 AGENTS.md 规则 15 与「用语纪律」节：若该文件结构变化（规则改号、词表迁移），文案里引用的规则编号指向需同步更新。
