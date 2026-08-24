# 本地开发注册与调试指南（local-dev-guide）

> 插件从写完到在 ZCode GUI 里可用，以及出问题怎么查。zsub / dynamic-workflow 的实测流程总结。

## 1. 注册（推荐 dev-link skill 一键切换）

dev 版与正式版互斥切换（自动防双装/幂等/带冲突检查），在插件 worktree 内：

```bash
bash .agents/skills/dev-link/link-dev.sh <plugin>     # 装 dev 版 + 卸载同名正式版
bash .agents/skills/dev-link/unlink-dev.sh <plugin>   # 移除 dev 版 + 恢复正式版（未发布则跳过）
bash .agents/skills/dev-link/status.sh                # 状态与冲突检查（双装/悬空/孤儿）
```

机制与冲突检查矩阵见 `.agents/skills/dev-link/SKILL.md`。以下手工流程是脚本的行为依据
（脚本 = 自动化的等价操作 + 备份 + 验证闭环），手动改时照此执行：

编辑 `~/.zcode/cli/config.json`（**改前备份**，如 `cp config.json config.json.bak-<plugin>-$(date +%Y%m%d-%H%M%S)`）：

```json
"plugins": {
  "enabled": true,
  "dirs": [
    "/Users/zhushanwen/Code/zcode-plugin-workspace/<worktree>/<plugin>"
  ],
  "enabledPlugins": {
    "<plugin>@inline": true
  }
}
```

多个插件就在 `dirs` 数组并列（历史上 dynamic-workflow 与 zsub 曾并存，后前者卸载）。

**改后必须重启 ZCode**——GUI 只在启动时扫描插件配置。

## 2. 验证

| 层 | 命令/动作 | 通过标准 |
|----|-----------|----------|
| 注册 | `zcode plugins list` | `<plugin>@inline [enabled]` |
| MCP | 主会话问「列出可用 MCP 工具」 | 出现 `mcp__<plugin>__*` 工具 |
| 能力 | 按 README 验收手册逐项执行（zsub M1-M5 样式） | 场景通过 |

诊断资源加载问题的权威文档：官方 zcode-guide 插件（已随官方 marketplace 内置）五份
`diagnosing-*` SKILL.md（plugins / skills / commands / hooks / mcp），症状 → 根因 → 修复都按
检查清单组织，排障先读对应那份。

## 3. 卸载

推荐 `bash .agents/skills/dev-link/unlink-dev.sh <plugin>`（移除 inline + 恢复正式版）。
手工等价：

1. 删除 config.json `plugins.dirs` / `enabledPlugins` 里对应条目（或从改前备份恢复），重启。
2. 残留 `~/.zcode/cli/plugins/data/<plugin>@inline/` 空标记目录可留可删（无功能影响）。
3. 插件运行时数据 `~/.zcode/<plugin>/`（records / outputs）按需保留。

## 4. 冒烟探针（zcode 升级后、改 spawn 类代码前必跑）

zcode CLI 无公开契约（help 会漂移），依赖无头驱动的插件把探针当防波堤：

```bash
# 无头基础形态：应输出含 response 字段的 JSON
HOME=<隔离HOME目录> node <zcode.cjs> --json --cwd /tmp --prompt "ok"

# MCP server 协议冒烟：应返回 tools 列表 JSON
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | node dist/mcp/server.js
```

已知漂移记录（探针发现即回写此处）：

- `--allowed-tools` 拒收（CLI 无 allowlist，只有 denylist `--disallowed-tools`）——白名单只能
  作为 prompt 软约束（zsub 实证）。
- `--settings` / `--max-turns` 在 help 中存在但 0.16.3 解析器拒收。

## 5. 日志与证据链

| 位置 | 内容 |
|------|------|
| `~/.zcode/<plugin>/` | 插件运行时数据：records（事件流）、outputs（结果全文）、per-model 隔离 HOME |
| `~/.zcode/cli/log/` | zcode 客户端日志 |
| MCP server stderr | 进度与调试输出（stdout 被 JSON-RPC 占用，见 logging-conventions） |
| 插件自定义 debug env | 约定 `<PLUGIN>_DEBUG=1` 开详细日志（参照 zsub / XYZ_AGENT_DEBUG 先例） |

卡死/无响应类问题：先看 records 事件流定位最后状态，再看隔离 HOME 下的无头 session 产物
（`pi-*.jsonl` 同位物是 `--json` 输出流，若有 tee 落盘则为决定性证据）。

## 6. 开发迭代节奏

- 改 `lib/` 源码 → 重新打包 `dist/`（当前各插件为手工/脚本打包，无 watch）→ 重启 ZCode 验证。
- CLI 直跑（`node bin/<cli>.js ...`）可绕过 GUI 快速验证核心逻辑——MCP tool 与 CLI 是同一套
  lib 的两个入口，CLI 通而 MCP 不通时问题在协议层/注册层。
- inline 注册的插件直接从 worktree 路径加载，**worktree 里的未提交改动即时可见**（重启后），
  无需复制；但这也意味着脏工作区可能被注册态引用——发布前确保 worktree 干净。
