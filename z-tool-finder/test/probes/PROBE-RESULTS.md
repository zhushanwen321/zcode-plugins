# M0 探针结果（2026-08-26，zcode 0.16.x 无头实测）

方法：隔离 HOME（复制 zsub per-model HOME 池 `~/.zcode/zsw/home-builtin_bigmodel-coding-plan-GLM-5.3`，含 provider 配置）+ inline 注册两个探针插件（`ztf-probe`：meta-only server + SessionStart hook；`ztf-base`：3 假工具 server），无头驱动 `HOME=<隔离目录> node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs --json --cwd /tmp --prompt ...`。

## 结论

| 探针 | 结果 | 关键实证 |
|---|---|---|
| P0-1 hook 注入 | ✅ 通过 | 嵌套 `hookSpecificOutput.additionalContext`（SessionStart）注入生效，模型能原样引用注入内容（`ZTF_PROBE_MARKER_9f3a`） |
| P0-2 覆盖压插件 server | ✅ 通过（**带修正**） | user config `mcp.servers` 的覆盖 key **必须用全命名空间 `plugin:<plugin>:<server>`**，裸名 `probe-base` 无效；`enabled:false` 成功禁用原注册；`enabled:true` + 替换 command 的「接管形态」下，工具变为替身的 meta 工具且 server 命名空间/工具前缀**保持原名**（`mcp__plugin_ztf-base_probe-base__*`） |
| P0-3 meta-only server | ✅ 通过 | tools/list 只返回 2 个 meta 工具的 server 正常连接注册，zcode 无最小工具数/形状假设；插件 server 工具名形态实证：`mcp__plugin_<plugin>_<server>__<tool>` |

## 四轮运行记录

- run1：基线（两插件注册，无覆盖）→ base_tool_1/2/3 与 meta 工具均出现；marker 可见（P0-1+P0-3）
- run2：`mcp.servers."probe-base".enabled=false` → **无效**，base 工具仍在（裸名 key 不压插件层）
- run3：`mcp.servers."plugin:ztf-base:probe-base".enabled=false` → base 工具全部消失，其余不受影响
- run4：同 key `enabled=true` + command 指向 meta server（wrapper 替身）→ `mcp__plugin_ztf-base_probe-base__{call_tool,get_tool_details}`，命名空间保持

## 复跑（zcode 升级漂移检测）

脚本即本目录 `meta-server.js` / `base-server.js` / `session-start-hook.js`（脚本内无绝对路径依赖，注册时写绝对路径）。步骤照本文件「方法」段：搭隔离 HOME → inline 注册 → 依次写 run2/run3/run4 的覆盖条目跑无头会话比对工具列表。run2 的「裸名无效」是预期行为不是回归信号。

原始产物曾落 `/tmp/ztf-probe/run{1..4}.jsonl`（会话已过期，结论以上表为准）。
