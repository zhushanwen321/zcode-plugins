# z-smart-context

把 zcode 内建 auto-compact 的上下文用量变得可见：越 3 档软阈值时经 `additionalContext` 提前提醒、用量显著回落时注入知情通知并重置档位、agent 随时可自助查用量——不替代、不干扰内建压缩，只补上「可见性」这一环。

## 架构

```
用户提交 prompt
  → UserPromptSubmit hook（dist/hooks/threshold-check.js；<200ms，hooks.json timeoutMs 3000 + 脚本内 watchdog 双保险）
      → 只读打开 ~/.zcode/cli/db/db.sqlite，查 model_usage 末行 input+cache_read（上一轮用量）
      ├─ 越新档位 → stdout {"additionalContext": ...} 注入分档提醒（随本请求生效，模型当轮可见）
      └─ 用量显著回落 → 判定压缩已发生，清空 fired 档位并注入知情通知
agent 自助面：bin/zsc.js usage（CLI 直查同一只读库）+ skills/zsc-usage（解读与压缩引导）
档位状态：~/.zcode/z-smart-context/state/<sessionId>.json（fired 去重，与引擎零共享）
```

要点：检测点仅 `UserPromptSubmit` 单事件（Stop 事件的 additionalContext 实测不进模型请求）；判档/回落/求交为纯函数（`lib/state.js`），sqlite 与文件 IO 只做薄壳；配置面 mtime+size 缓存热加载（`lib/config.js`）。零 npm 依赖，plain Node CJS；`node:sqlite` 为内置模块，要求 node >=22.5.0。

## 安装（inline 注册）

1. `~/.zcode/cli/config.json` 的 `plugins.dirs` 数组追加本插件目录绝对路径（`<repo>/z-smart-context`）。
2. 重启 ZCode（GUI 只在启动时扫描插件配置，改完必须重启才生效）。
3. 验证：终端跑 `zcode plugins list` 应见 `z-smart-context` enabled。

详见仓库根 docs/extensions/local-dev-guide.md。

## CLI：用量自查

```bash
node bin/zsc.js usage [--session <sessionId>]
```

- 默认 `--latest`：按 cwd 精确匹配反查当前项目最近活跃主会话（agent Bash 环境无 sessionId 环境变量，在项目目录下直接跑默认即可）。
- `--session <sessionId>` 显式指定会话（id 见提醒文案或会话 UI）。
- stdout 输出单行 JSON：`{"sessionId":...,"contextTokens":...,"firedTiers":[...],"nextTier":...,"note":"..."}`。字段解读与压缩建议姿势见 skill `zsc-usage`。

Exit code 语义：

| code | 含义 |
|------|------|
| 0 | 成功（含会话尚无已完成请求的正常态，`contextTokens` 为 null） |
| 1 | 内部错误（db 打不开/查询失败等；排查 `tail ~/.zcode/z-smart-context/log/hook.log`） |
| 2 | 用法错误（未知子命令/参数非法/`--latest` 反查无命中，报错附用法示例） |

## 配置

`~/.zcode/z-smart-context/config.json`（可选，无文件用默认；坏 JSON 回退默认并记 warn；mtime+size 缓存热加载，改完下一轮生效）：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enabled` | boolean | `true` | 插件总开关 |
| `tiers` | number[] | `[200000, 400000, 600000]` | 3 档提醒阈值（token 绝对数）；normalize：滤非正数→升序→截 3 档，空回退默认 |
| `dbPath` | string | `~/.zcode/cli/db/db.sqlite` | 引擎私有库路径（只读打开；指到不可读路径可做故障注入测试） |

**档位必须按当前模型窗口校准**：内建 auto 压缩线 ≈ 窗口 × 95%，首档应 <= 内建线 × 0.75，否则内建先压、档位永不触发。

| 模型窗口 | 推荐档位 | 内建线参考 |
|----------|----------|------------|
| 1M | `[200000, 400000, 600000]`（默认即可） | ≈ 950K |
| 200K | `[80000, 140000, 180000]` | ≈ 190K |
| 128K | `[50000, 90000, 115000]` | ≈ 121.6K |

## 已知边界

- **turn 内实时预警不做**：检测点 = 用户提交 prompt 的时刻，单次长 turn 中途无检查点，由 agent 按 zsc-usage skill 主动自查补盲。
- **小窗口模型必须显式校准 tiers**（见上表），否则默认档位高于内建压缩线、永不触发。
- **压缩知情在下一次用户 prompt 时感知**（回落自愈机制），延后一个交互轮属预期。
- **/rewind、/fork 同样导致用量回落并触发知情通知**（文案写「很可能发生了压缩或回退」，不断言成因）。

## 测试与验收

- 单测：插件目录内 `node --test test/*.test.js`（纯函数 + CLI/hook fixture 临时库，不碰生产库；e2e 默认 skip）。
- 无头 e2e（真实 zcode app-server + 真实模型，隔离 HOME + fixture 越档，一次覆盖 V1/V2/V3 数据层证据）：`ZSC_E2E=1 node test/e2e-headless.test.js`（消耗少量模型 token；zcode 升级后建议重跑，防 hooks 契约漂移）。
- 真机验收手册（V1-V6 六场景）见仓库根 `.tmp/auto-compact-design.md` §4。

## 数据目录

```
~/.zcode/z-smart-context/
├── config.json              用户配置（可选）
├── state/<sessionId>.json   每会话档位状态（firedTiers/lastTokens；7 天孤儿自动清理）
└── log/hook.log             hook 与 CLI 运行日志（排查入口）
```
