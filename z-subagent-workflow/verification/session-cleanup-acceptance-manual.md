# zsw 会话残留清理 · 用户停机窗口验收手册

> 本手册自包含，命令可直接复制执行。与 README「会话残留维护」节互补：README 写命令语义与安全网机制，本手册写停机窗口的执行顺序与逐项检查清单。
> 来源：Gate B 真库副本演练（2026-09-06，6.71GB 快照删 5,776 会话回收 3.64GB，86 项断言全过）之后，覆盖副本无法覆盖的用户域环节。
> 插件绝对路径（下称 `<zsw>`）：`/Users/zhushanwen/Code/zcode-plugin-workspace/feat-agent-not-in-left-sidebar/z-subagent-workflow`

## 0. 前提（执行前核对一次）

```bash
node --version                          # ≥22.5（推荐 24，node:sqlite 必需）
df -h ~ | tail -1                       # 剩余 ≥ 2×库体积+1GB（6.7GB 库约需 15GB；三段磁盘校验会自动拦）
cd <zsw> && node bin/zsw.js doctor | tee ~/zsw-doctor-baseline-$(date +%Y%m%d).txt   # 基线留档（只读零风险）
node bin/zsw.js doctor clean --dry-run | tee ~/zsw-dryrun-$(date +%Y%m%d).txt        # 预览留档（A-4 对账基准）
```

dry-run 三道安全网审查（任一不过 → 停手，勿执行）：

- **污染哨兵**：删除集 ∩ targetSessionId 值域必须 = 0；非 0 时 exit 1 并列出命中 id——逐条核查 directory/标题（可能是识别器污染，也可能是嵌套调用合法重叠），把清单交维护者判定。
- **索引冲突预检**：命中 >0 时冲突会话已自动整体剔除并逐条列出——确认剔除清单均为「被分组/自动化引用的会话」即可继续。
- **目录分布红灯**：⚠ 触发时核对「特征表外临时目录命中」数——为 0 即无污染信号（本机 2026-09-06 实测：临时类占比 69.2% 触发机械阈值，但全部来自特征表内、表外命中 0，人工审通过后可执行）。

## 1. 真实 clean 操作步骤（A-1/A-4 真机执行）

1. **完全退出 ZCode**：Cmd+Q（含菜单栏常驻图标退出）。复核无残留进程：

```bash
ps axeww -o pid=,command= | grep -E 'ZCode|zcode.cjs.*app-server|ZSW_NESTED=1|XYZ_AGENT_SUBAGENT=1' | grep -v grep
# 期望：无输出。有输出则逐个确认退出（GUI 主进程裸名 ZCode / Helper 含 /Applications/ZCode.app/）
```

2. **执行清理**（四项停机校验 + 三段磁盘校验自动跑，任一不过自动拒绝并给指引，不会半做）：

```bash
cd <zsw> && node bin/zsw.js doctor clean | tee ~/zsw-clean-$(date +%Y%m%d-%H%M%S).txt
```

3. **A-4 对账**：逐行对比步骤 0 的 dry-run 留档与执行报告——引擎库三类行数、input_history 命中、GUI 索引 tasks 行数、文件面 artifacts/exec 两个通道/log 文件数，各面差异必须为 0。
4. **A-1 回收量核验**：`du -sh ~/.zcode/cli/db/db.sqlite*` 对比执行前的库体积——回收应 ≥3.5GB（副本实测 6.7GB→3.1GB 回收 3.64GB）。
5. **A-5 小档位真实验证**（重启 ZCode 使用 1-2 天后执行）：

```bash
node bin/zsw.js doctor clean --stale --older-than 1d --dry-run   # 先预览
node bin/zsw.js doctor clean --stale --older-than 1d             # 仍需停机窗口执行
```

   通过标准：只清新产生的超龄部分（<1 天的会话与子代理全部保留）；报告含「档位：--stale 周期维护」行；文件面档位不跟随（log 仍保留 14 天/exec 空壳仍 7 天）。副本等价验证已过（构造 3 天前 child 入选、0.5 天新行排除）。

6. 观察一个工作日：侧边栏不再涌现 zsw 会话、引擎无报错弹窗。
7. **确认无异常后释放备份**：`cd <zsw> && node bin/zsw.js doctor clean --purge-backup`（备份是回滚唯一安全网，确认前勿删）。

## 2. A-2 重启检查清单（清理后重启 ZCode 逐项勾）

- [ ] 侧边栏只剩真实会话；无 `sess_subagent_agent_…` 形态条目（子代理会话标题形态）。
- [ ] 8 个调用方会话全部完好：逐个在侧边栏搜索或打开恢复。名单生成：`grep -o '"targetSessionId":"[^"]*"' ~/.zcode/zsw/records.jsonl | sort -u`（8 个值；副本实测 8/8 session 行与 index 行清理后完好）。
- [ ] 真实历史会话可正常打开恢复（上下文完整、可继续对话）。
- [ ] 任务分组视图无幽灵条目（空分组/指向不存在会话的条目；task_group_members 已同事务联动删除）。
- [ ] 被自动化/调度引用的任务（automations/off-peak）仍可见可用（冲突会话机制保留，本机命中 0）。

## 3. A-3 零误伤抽查清单

- [ ] 随机抽 5 个清理前就存在的真实历史会话，逐个打开读消息——消息完整可读（副本实测 5 个 1,487-2,238 行消息的会话行数零变化）。
- [ ] 检查置顶与会话未读标记：之前置顶的仍置顶、未读红点状态不变（副本实测 pinned 24/unread 8 前后不变）。
- [ ] 如 dry-run 曾报告索引冲突剔除，核对该任务与其引用它的 automation/off-peak 完好（本机命中 0，机制保留）。

## 4. P4 引擎容错检查（已删 subagent_child 不破坏宿主）

- [ ] 重启后打开一个**曾有子代理**的历史会话 → 详情页子代理视图：不 crash、不白屏、不卡死；>7 天子代理不显示属预期（已删），7 天内的子代理仍在（副本实测保留 879 个近期 child）。
- [ ] 发起一个使用 Agent tool 的新任务 → 正常产生子代理并完成（写入面未被破坏）。
- [ ] 打开一个 zsw 曾运行过的项目新起对话 → 引擎正常建会话（`~/.zcode/cli/db/db.sqlite` 写入正常）。

## 5. A-7 整库回滚（清理后异常时；正常路径走 §1 步骤 7）

备份在 `~/.zcode/zsw/maintenance/backup-<时间戳>/`（双库三件套）。三步整组还原——**必须整组，半套覆盖会产生 WAL 不一致**：

```bash
# ① 完全退出 ZCode（含菜单栏常驻），按 §1 步骤 1 复核无进程
# ② 删除原位六文件（三件套 × 双库）
rm ~/.zcode/cli/db/db.sqlite ~/.zcode/cli/db/db.sqlite-wal ~/.zcode/cli/db/db.sqlite-shm \
   ~/.zcode/v2/tasks-index.sqlite ~/.zcode/v2/tasks-index.sqlite-wal ~/.zcode/v2/tasks-index.sqlite-shm
# ③ 备份整组 cp 回（文件名逐个对应；-wal/-shm 不存在则跳过）
cp ~/.zcode/zsw/maintenance/backup-<时间戳>/db.sqlite* ~/.zcode/cli/db/
cp ~/.zcode/zsw/maintenance/backup-<时间戳>/tasks-index.sqlite* ~/.zcode/v2/
# ④ 核对：md5 与备份一致 + 重启 ZCode + 数 session 总数回到清理前基线（副本实测 7,461 精确回归）
md5 -q ~/.zcode/cli/db/db.sqlite ~/.zcode/zsw/maintenance/backup-<时间戳>/db.sqlite
sqlite3 -readonly ~/.zcode/cli/db/db.sqlite 'SELECT COUNT(*) FROM session;'
```

**回滚边界（已声明代价）**：整库回滚抹掉「清理之后→回滚之前」窗口内新产生的真实会话且无二级备份（副本实证：备份后新插入的行被还原精确抹除）。窗口超 7 天建议放弃整库回滚，改从备份库挑行恢复：`sqlite3 -readonly ~/.zcode/zsw/maintenance/backup-<时间戳>/db.sqlite` 后按 session/time_created 定位，ATTACH 导出所需行。

## 6. 还原/逃生路径

- **停机校验拒绝**（最常见）：按文案退出对应进程后重跑。`检测到 ZCode 进程`→ 退出 GUI；`app-server 进程`→ 随 GUI 退出，孤儿时 `ps -eo pid,ppid,command` 看 ppid=1 的 zcode-cli 可 kill；`双库独占开锁失败`→ 全部进程退出仍失败用 `lsof ~/.zcode/cli/db/db.sqlite` 找持锁方（库文件缺失不是锁——校验会跳过并告警，不会因此拒绝）。
- **并发锁拒绝**（`另一个 clean 正在运行`）：等当前 clean 结束；确认无并发（`ps -p <PID>`）后 `rm ~/.zcode/zsw/maintenance/.clean.lock` 再重跑。
- **磁盘不足**：`VACUUM 前剩余空间不足`时备份已保留原位（回滚安全网仍在）——先 `node bin/zsw.js doctor clean --fs-only` 清文件面腾空间（同样需停机），再重跑全量 clean；仍不足才在确认放弃回滚后删备份目录。此拒绝态引擎与索引删除均已生效，重跑即空删除集直达 VACUUM。
- **执行中报错中止**（按失败阶段区分，无统一的「重跑幂等」）：
  - 引擎库删除中止于事务边界（已提交批次保持生效、索引联动尚未执行）：按 §5 整组回滚后重跑（索引面一并重来）；或接受删除现状，对照 --json 报告 `deleteSet.indexTaskIds` 手工核查索引残留——**重跑不补删索引面**（已删会话的 tasks 行不在重跑识别集内）。
  - 引擎与索引删除均完成、仅 VACUUM 失败：无需回滚，排除磁盘/环境问题后直接重跑（删除集为空，直达 VACUUM 重试）。
- **清理后一切正常**：`node bin/zsw.js doctor clean --purge-backup` 释放 ~6.7GB。

## 7. 周期维护（长期）

存量清完后，日常档 = `node bin/zsw.js doctor clean --stale --older-than 30d`（手动触发，禁止 cron/launchd 自动化——删除操作无人值守 + 停机窗口要求无法自动保证）；建议同时开启 ZCode 设置「任务自动归档」（taskAutoArchiveEnabled，index 层兜底不回收磁盘）。
