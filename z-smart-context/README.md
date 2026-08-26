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
| 1 | 内部错误（db 打不开/查询失败、引擎配置坏 JSON 等；排查 `tail ~/.zcode/z-smart-context/log/hook.log`） |
| 2 | 用法错误（未知子命令/参数非法/`--latest` 反查无命中/override 未登记该 owner，报错附用法示例） |

## zsc_compact MCP 工具

插件根 `.mcp.json` 注册 stdio MCP server（`dist/mcp/server.js`，客户端内全名 `mcp__zsc__zsc_compact`），供 agent 在收到越档提醒后自主决策发起压缩。改完需重启 ZCode 生效（GUI 只在启动时扫描插件配置）。

输入契约（retention 与 nextInstruction 至少其一必填，压缩后继续任务的编排依赖 nextInstruction）：

| 参数 | 类型 | 说明 |
|------|------|------|
| `retention` | string | 压缩保留指令，拼入 `/compact 保留：…`；任务语义由 agent 提供 |
| `nextInstruction` | string | 压缩完成后注入的继续消息 |
| `sessionId` | string | 可选；缺省链：显式入参 → env `CLAUDE_SESSION_ID` → db 按 cwd 反查最近活跃主会话 |

返回按会话形态分派（best-effort 判定：env `ZSC_HEADLESS=1` → 进程树父链 GUI host 特征 → unknown 兜底）：

| mode | 含义 | 返回 |
|------|------|------|
| `gui-active` | GUI 会话可实时压缩 | `plan` 三步编排（computer-use 向输入框 element 注入 `/compact 保留：<retention 原文>` → 紧接注入 `<nextInstruction 原文>` 靠 GUI 忙时排队 → 结束回复等压缩 turn）、`verifyHint`（`zsc usage --session <sid>` 事后核实 contextTokens 回落）、`fallback` 半自动降级文案 |
| `headless-active` | 无头 mid-run（引擎运行中不热重读 config） | 诚实降级指引：本会话无法实时压缩，主控下次 spawn 前调 `zsc override apply` 预备 config 覆盖；绝不含空 plan 假装成功 |
| `unknown` | 形态无法判定 | 双路径说明（GUI 编排 + 无头预备），agent 按处境自选 |

前置条件与降级链：GUI 实时压缩依赖 computer-use 类工具的系统 TCC 授权（一次性授权；未授权时调用报 `CUA_PERMISSION_REQUIRED`），此时按返回的 `fallback` 走半自动降级——引导用户手动执行 `/compact 保留：…`（附原文可整段复制，v1 行为兜底）。注入消息建议带署名前缀「（由 agent 经 zsc 自动压缩流程注入）」，便于 transcript 回看溯源。

嵌套防护：被编排插件 spawn 的子会话 env 带 `*_NESTED` 键时，server 的工具面为空列表（tools/list 返回 `[]`），防递归编排。人读日志与 hook、CLI 同落 `~/.zcode/z-smart-context/log/hook.log`。

## 无头场景集成（spawn 前 override 预备）

GUI 会话内插件无法实时触发本会话压缩（压缩只发生在持有会话的引擎进程内）；但**无头/subagent
会话**可以在 spawn 前改引擎配置，让引擎内建 autoCompact 提前到指定阈值自动触发（实测：
`phase=pre_request`，请求间触发成立），进程退出后还原。

```bash
# spawn 前预备：把 model 的 autoCompact 阈值拉到 200K（由编排主控执行）
node bin/zsc.js override apply --model <modelId> --threshold 200000 --owner <task-id>
# ... spawn 无头 agent 干活 ...
node bin/zsc.js override revert --owner <task-id>          # 进程退出后注销并还原
node bin/zsc.js override status                            # 只读对账：owners/备份/config 现场
```

- **34000 公式**：`contextWindow = thresholdTokens + 34000`。引擎 autoCompact 阈值的构成是
  `contextWindow − 21000 outputReserve − 13000 buffer`，两者相抵恰好等于 thresholdTokens。
  写入位置为 `~/.zcode/cli/config.json` 的 `modelCatalog.overrides[<modelId>].contextWindow`，
  只动这一个叶子：用户其他顶层配置、同模型其他字段、其他模型条目全部保真。
- **owner 引用计数**：同一 ownerId 重复 apply 幂等；多个 owner 叠加时 refcount 递增，
  最后一个 owner revert 时才真正按首见备份还原（防并发编排下的栈式还原污染）。未知 owner
  会报错并列出现存 owners。
- **崩溃救援**：无头进程 kill -9 后锁内 owner 残留时，人工核对后用
  `zsc override revert --owner <id> --force` 跳过匹配直接还原。owners 为空的确定性残留
  （还原落盘与删锁之间崩溃的半途态）由库函数 `lib/config-override.js` 的 `healResidue`
  自动处理。

### 窗口期副作用声明（如实告知）

override 写在用户真实全局配置上，生效窗口 = 从 apply 到 refcount 归零（无头任务全程，
可能小时级）。窗口期内若用户重启 GUI，新引擎进程读到低 contextWindow，**所有同模型会话
的 autoCompact 阈值被临时拉低**；且长驻引擎不热重读配置，已被低窗口启动的进程只能重启恢复
——自愈只到文件层为止。这是本方案的已知代价，四条缓解措施：

1. **owner refcount**：多个无头任务交错 apply/revert 不会互相踩还原；
2. **窗口最短化**：spawn 前才写、进程退出立即 revert；
3. **revert --force 救援**：还原失败或主人失联时可强制归零还原，错误信息指向具体命令；
4. **healResidue 自愈到文件层为止**：owners 空残留按备份机械还原；坏 JSON 一律拒绝操作
   并指向手工修复路径（绝不在用户坏配置之上做覆盖或「聪明」还原）。

### 编排主控（zsw 等）使用位置建议

```
准备 spawn 无头 agent 前一刻        → zsc override apply --model M --threshold T --owner <taskId>
子进程退出/终止回收之后立即         → zsc override revert --owner <taskId>
异常退出兜底                        → zsc override status 看 residue，再决定 revert --force
```

apply 与 spawn 之间的间隔越短越好（缩小低阈值暴露窗口）；ownerId 建议带任务标识便于日志对账。

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
├── override-lock.json       无头场景 catalog override 登记锁（_zscManaged 标记 + owners 引用计数 + 备份）
└── log/hook.log             hook 与 CLI 运行日志（排查入口）
```
