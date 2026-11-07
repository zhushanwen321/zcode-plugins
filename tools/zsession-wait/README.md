# zsession-wait

监控某个 zcode 会话是否「完全停止」的外部旁观 CLI。给定会话 id，轮询判定以下条件是否全部满足并保持稳定，满足则退出码 0：

1. 会话及其全部子会话（subagent / workflow actor）db 静默超过 `--quiet-period`
2. 会话树无在途工具调用（`tool_usage.status='running'`）
3. 会话树无在途 workflow run（`dwf_run` 非终态）且无存活的 workflow 沙箱进程
4. 宿主 app-server 进程树中无 shell 后代（后台 bash 的唯一外部可见证据）

## 为什么是「旁观」而不是查询

zcode 的活状态（正在跑的 turn、后台 bash 任务注册表）只存在于 app-server 进程内存里，db 不记录运行中标志，也没有供外部进程 attach 的 RPC 通道。因此本工具组合三层数据源做推断：

- **db（`~/.zcode/cli/db/db.sqlite`，只读短连接）**：`session.parent_id` 递归得会话子树；静默判定看 `max(time_updated)`；在途证据看 `tool_usage` / `dwf_run` / `session_input`（排队输入）
- **进程表**：宿主 app-server 每 workspace 一个（打包态 ps 里显示为 `zcode-cli`，靠 `lsof` 取 cwd 与会话 `directory` 比对定位）；workflow 沙箱是独立进程（命令行含 `dwfrun-<uuid>.mjs`），按 db 活跃 run id 交集计数；后台 bash 是宿主的 detached 后代，只能扫进程树
- **静默稳定期**：单轮全绿只是「此刻无在途工作」的快照——采样有竞态窗口、轮次间隙有短暂全绿、后台任务结束到回送消息之间有间隙。连续 N 轮全绿（默认 3）跨过秒级窗口；`--quiet-period`（默认 180s）跨过模型长思考的写库空窗

宿主进程消失时，db 里的 `running` 行按崩溃残留处理（zcode 崩溃不写终态，官方只在宿主下次启动时收敛，见 `dynamic-workflow-run-reconcile.ts`），此时只有沙箱孤儿 / 孤儿 shell（`--strict-orphan`）仍阻塞判定。

## 用法

```sh
node bin/zsession-wait.mjs <sessionId> [options]
# 或 npm link 后：zsession-wait <sessionId> [options]
```

| 选项 | 默认 | 说明 |
|------|------|------|
| `--interval <sec>` | 15 | 轮询间隔 |
| `--quiet-period <sec>` | 180 | db 静默阈值，防模型思考空窗误判 |
| `--rounds <n>` | 3 | 连续全绿轮数 |
| `--timeout <sec>` | 7200 | 总超时（0 = 不限） |
| `--json` | - | 最终 JSON 报告输出到 stdout，进度行始终在 stderr |
| `--ignore-shells` | - | 跳过宿主 shell 后代信号（见下） |
| `--strict-orphan` | - | 孤儿 shell（PPID=1）升级为阻塞信号，默认只提示 |
| `--db <path>` | `~/.zcode/cli/db/db.sqlite` | db 路径 |

退出码：`0` 已停止 / `1` 超时 / `2` 会话不存在或 db 不可读 / `3` 参数错误 / `4` 采集连续失败。

## shell 信号的语义边界

宿主树下的 shell 无法归属到具体会话（同 workspace 多会话共享一个 app-server），因此它是 **workspace 级保守信号**：

- 目标会话自己挂的后台 bash 在跑 → 判红（正确行为；后台 bash 运行期间 db 完全静默，没有这个信号会误判完成）
- 目标会话已停但常驻型后台脚本（永不结束的监控脚本）还挂着 → 永远判红，此时用 `--ignore-shells` 明示「不把常驻脚本算作未完成」
- 同 workspace 兄弟会话的后台 bash 在跑 → 也会判红；需要并发监控时同样用 `--ignore-shells`

「停止」不等于「成功」：最终报告带出 `last_outcome`（completed / error / interrupted）与最后一条消息的 `finish`，由调用方裁决成败。

## 判定信号与数据源对照

| 信号 | 数据源 | 阻塞条件 |
|------|--------|---------|
| `running_tools` | db `tool_usage`（会话树） | 宿主存活时 > 0 |
| `active_runs` | db `dwf_run`（`parent_session_id` 在会话树） | 宿主存活时 > 0 |
| `sandbox_procs` | ps + db 活跃 run id 交集 | 任何时候 > 0（沙箱独立于宿主死活） |
| `pending_inputs` | db `session_input`（`status='admitted'`） | 宿主存活时 > 0 |
| `host_shells` | 宿主进程树扫描 | 宿主存活时 > 0（`--ignore-shells` 关闭） |
| `quiet_period` | db `max(time_updated)` | 静默不足阈值 |
| `orphan_shells` | ps（PPID=1 的 shell） | 仅 `--strict-orphan` |

## 已验证场景（zcode 3.16.x / macOS）

- 已停止会话（宿主存活、后台脚本在跑）：`host_shells` 判红，进程扫描抓到 db 完全看不到的后台任务
- 同一 workspace 其他会话的 workflow 沙箱在跑：识别为非阻塞提示，不影响目标会话判定
- 活会话：`running_tools` 判红，宿主定位正确，超时退出码 1
- `--ignore-shells` + 已停会话：连续轮全绿后退出码 0，报告 `last_outcome=completed`

## 依赖

Node >= 22.5（`node:sqlite`，实验特性仅警告）；本机需有 `ps` / `lsof`（macOS / Linux）。零 npm 依赖。
