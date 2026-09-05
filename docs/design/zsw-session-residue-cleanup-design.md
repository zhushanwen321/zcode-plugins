# zsw 会话残留：存量清理与周期维护设计

> **一句话结论**：在 zsw 插件内建 `zsw doctor`（只读体检）+ `zsw doctor clean`（停机窗口执行：识别 → 快照备份 → 双库联动删除 → VACUUM → 文件面清理），配套周期维护档位与自检命令，把已堆积的 ~9.1GB 会话残留安全回收，并让残留不再单调堆积。

**层声明**：当前层 = 技术方案；下一层 = 实现计划（zsw 插件内新命令 + 测试）。涉及运行时行为/数据流/错误处理，层敏感准则 5/6/7 全部适用。
**受众假设**：读者会用 zsw CLI、知道 ZCode 桌面端存在，但不懂 zcode 引擎内部存储结构——关键概念在 §2 补背景。

---

## 1. 背景目标

**SCQA**

- **S（情境）**：zsw（z-subagent-workflow 插件）的 zcode 引擎自 2.0 起与 ZCode GUI 共享宿主 HOME——zsw 每跑一个任务/子代理，引擎就把会话写入真实 `~/.zcode/cli/db/db.sqlite`，与 GUI 共库。一轮源码分析已定位侧边栏污染根因，**源头止血**（`session/create` 传 `parentSessionId` + `titleGenerationEnabled:false`，均已实测验证）由另一任务在 zsw 插件侧实施中。
- **C（冲突）**：源头止血只止血不回收——二轮分析发现存量已堆积 **~9.1GB**（DB 6.7GB + artifacts 1.8GB + log 448MB + exec 138MB），且清理远比「删一个库」复杂：侧边栏数据源是**另一个库**（GUI 私有 `tasks-index.sqlite`），伴生写入面还有 `model_usage` 统计表与三个文件目录；引擎**没有任何归档/删除 RPC**；更麻烦的是 zsw 存量会话在引擎库里**外观与真实用户会话完全无法区分**（都是 `interactive`、无 parent、标题正常）。
- **Q（问题）**：如何把存量残留**安全**清掉（不误删真实会话、可预览、可回滚），并建立周期维护让残留不再堆积？
- **A（答案）**：zsw 插件内建 `zsw doctor` / `zsw doctor clean` 命令族：白名单交叉识别（只认 zsw 自己 records 里可追溯的会话）→ 快照备份 → 双库联动删除 → VACUUM 回收 → 文件面按龄清理；周期维护为手动档位（删除类操作不自动化）；GUI 自动归档作为 index 层兜底建议。

**系统是什么（30 秒认知）**：ZCode 桌面端的会话状态分布在两处——引擎库 `~/.zcode/cli/db/db.sqlite`（会话全文转录，GUI 引擎与 zsw 的 app-server 共写）和 GUI 私有索引库 `~/.zcode/v2/tasks-index.sqlite`（侧边栏列表的数据源，由 GUI 定期从引擎库同步）。此外引擎每次运行还写三个文件目录：`artifacts/`（产物）、`log/`（运行日志，无轮转）、`exec/`（每会话执行目录）。

**设计目标**（从使用者体验倒推）：

| # | 目标 |
|---|---|
| G1 | 用户跑一次命令即可安全回收存量残留：先体检报告、再 dry-run 预览清单、确认后执行，执行结果逐项报数，出错有恢复路径 |
| G2 | 清理后宿主产品表面完好：重启 ZCode 侧边栏只剩真实会话，真实历史会话可正常打开恢复，零误删 |
| G3 | 残留不再堆积：存在周期维护档位（手动触发，按龄清理），默认行为明确 |
| G4 | 防回归可观测：一条命令随时报告当前各面残留量级，与直查数据库结果一致 |

**in-scope**：存量清理（引擎库 + GUI 索引库 + artifacts/log/exec 三个文件面）、周期维护档位、自检命令。
**out-of-scope**：源头止血实现（`parentSessionId` 改造，另一任务在办，本文只依赖其结果不改其设计）；修改 zcode 引擎/GUI 源码（用户约束，排除）；pi 引擎残留；zcode 引擎 `subagent_child` 的**增量**产生（那是 GUI 用户正常使用 Agent tool 的产物，由本设计的周期档位覆盖，不由 zsw 源头负责）。

---

## 2. 现状与问题分析

### 2.1 现状：残留的完整写入面（2026-09-05 实测）

zsw 跑一次任务的完整写入足迹如下（**写入面穷举**，每面附实测量级）：

```
zsw CLI 任务（一个 agent / 一个 workflow step）
  │  node zcode.cjs app-server --cwd <workdir>（zsw spawn 的独立进程）
  │  帧：session/create{persistence:"immediate"} → session/send{content: string}
  ▼
写入面 ① 引擎库 ~/.zcode/cli/db/db.sqlite（6.7GB）
  │  session 行（zsw 的 = task_type:'interactive'、parent_id NULL、标题正常——与真实用户会话无区分特征）
  │  + message / part / session_entry / todo / tool_usage（子会话转录）
  │  + model_usage 行（token 统计，与 GUI 用量同表聚合）
  │  实测：session 共 7245 行（interactive 835 含 zsw、subagent_child 6403）；
  │       subagent_child 占 message 57%（20.6万行）、part 60%（83万行）、todo 84%、tool_usage 74%；
  │       model_usage 共 134,263 行，其中 sess_subagent_agent_% 来源 94,805 行（71%）
写入面 ② GUI 索引库 ~/.zcode/v2/tasks-index.sqlite
  │  GUI 重启/切换 workspace 时由 host 同步器调引擎 session/list（过滤：directory 匹配
  │  AND parent_id IS NULL AND time_archived IS NULL，按 time_updated 倒序取 50）重建
  │  实测：tasks 738 行，其中 32 行为可追溯的 zsw 会话（已全部被用户手动归档），1 条漏网 subagent
写入面 ③ ~/.zcode/cli/artifacts/（1.8GB）
  │  实测：3701 个目录，3052 个（82%）属 subagent 会话，单目录最大 27M
写入面 ④ ~/.zcode/cli/log/（448MB，无轮转）
  │  实测：zcode-2026-09-05.jsonl 单日 109MB；只增不减
写入面 ⑤ ~/.zcode/cli/exec/（138MB）
  │  实测：5867 个目录，抽样几乎全为空壳（会话结束不回收）
```

### 2.2 真实失败模式

| # | 失败模式 | 触发条件 |
|---|---|---|
| F1 | 侧边栏被 zsw 会话涌入 | ZCode 重启/切换 workspace 后 GUI 全量 re-seed（zsw 会话活在独立 app-server 进程，运行期 GUI 内存态看不见——所以是「重启后涌现」而非实时可见） |
| F2 | 磁盘单调累积，无任何清理通道 | 引擎无 archive/delete RPC（已枚举全部 session/* 方法确认）；GUI「归档」只写自己的 index 库，不回写引擎库 |
| F3 | 手工清理误删真实会话 | zsw 存量会话在引擎库里无识别特征（见 2.1 面①）；直接按目录/标题猜会误伤 |
| F4 | 只清引擎库，侧边栏照样显示 | 侧边栏读 tasks-index.sqlite（面②），与引擎库无 FK 联动 |
| F5 | 标题生成的隐性模型调用浪费 | 45/45 个可追溯 zsw 会话全部触发引擎后台 `session_title_generation`（zsw 未传 `titleGenerationEnabled:false`，引擎默认开）——源头止血已含此修复，本文不再处理 |

### 2.3 根因

**共享宿主写入无生命周期管理**。0.5.0 拍板共享宿主 HOME 时，「GUI 会话列表可见 headless 会话」被一句话接受，未枚举完整写入面（一轮只看见面①的 session 行）、未量化累积速率、未确认清理通道存在性（不存在）。二轮分析补齐了写入面清单，本文处理其后果。

### 2.4 手术约束（全部实证）

| # | 约束 | 证据 |
|---|---|---|
| C1 | 子表虽声明 `references session(id) on delete cascade`，但 `pragma foreign_keys=0`——直接 DELETE session 行**不会级联**，须显式 `PRAGMA foreign_keys=ON` 或手工清子表 | 二轮实测 |
| C2 | `auto_vacuum=0`——删行不还空间，必须 `VACUUM`；VACUUM 需要约等量临时磁盘 | 二轮实测 |
| C3 | 引擎库 journal_mode=WAL——`-wal`/`-shm` 伴随文件须一并处理；有进程持库时写操作有锁冲突风险 | 二轮实测 |
| C4 | 两库无 FK 联动——删引擎库行后，tasks-index 对应行必须显式联动删除 | 2.1 面②同步机制 |
| C5 | 引擎/GUI 运行中动共享库会与内存态/同步器打架——必须在 ZCode 完全退出（GUI + 残留 app-server 进程）的停机窗口执行 | 同步机制推断 + WAL 锁语义 |
| C6 | zsw 会话的权威识别源只有 zsw 自己的 `~/.zcode/zsw/records.jsonl`（含每次任务的 sessionId，当前 141 个可追溯）与 `~/.zcode/zsw/outputs/` 等产物——引擎库内无特征可反查 | 二轮实证 |

---

## 3. 解决方案

### 3.1 终态（使用者视角）

```text
$ zsw doctor                       # 只读体检，任何时刻可跑
zsw 会话残留体检（2026-09-XX）
  引擎库会话行    zsw 白名单 141 个 / subagent_child 6403 个（>7天 6200）
  引擎库体积      6.7GB（预估可回收 ~5.5GB）
  GUI 索引行      命中共 33 行
  artifacts/      3052 个 subagent 目录（1.5GB）
  log/            超过 14 天的日志 3 个（240MB）
  exec/           空壳目录 5700 个（130MB）
备份状态          上次清理备份：无
👉 预览删除清单：zsw doctor clean --dry-run

$ zsw doctor clean --dry-run       # 预览，不写任何东西
将删除（不写库）：
  引擎库 session 141+6200 行、级联子表 ~XXX 万行、model_usage ~9.4 万行
  GUI 索引 33 行；artifacts 3052 目录；log 3 文件；exec 5700 目录
预估回收 ~7.3GB（库内空间需 VACUUM 后生效）
👉 确认执行：退出 ZCode 后跑 zsw doctor clean

$ zsw doctor clean                 # 执行（自动先做前置校验）
✓ 前置校验：ZCode 未运行；剩余磁盘 18GB > 引擎库 6.7GB×1.2
✓ 快照备份：~/.zcode/zsw/maintenance/backup-2026-09XX-{db.sqlite*,tasks-index.sqlite*}
✓ 引擎库：删除 session 6341 行 + 子表级联；model_usage 94,805 行；VACUUM 完成（6.7GB→1.1GB）
✓ GUI 索引：删除 33 行
✓ 文件面：artifacts 3052 目录、log 3 文件、exec 5700 目录
完成。如有异常，还原：cp 备份文件回原路径（先退出 ZCode）；确认无异常后
zsw doctor clean --purge-backup 释放备份空间。
```

失败路径示例（恢复指引）：

```text
$ zsw doctor clean
✗ 前置校验失败：检测到 ZCode 进程（PID 1234）正在运行。
  运行中清理会与 GUI 内存态冲突。👉 退出 ZCode（含菜单栏常驻）后重跑本命令。
✗ 前置校验失败：剩余磁盘 5GB < 需要 8GB（库 6.7GB×1.2）。
  VACUUM 需要等量临时空间。👉 先跑 zsw doctor clean --fs-only 清文件面（约 1.9GB），再重跑。
```

### 3.2 方案对比

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. zsw 内建 `zsw doctor clean`**（选） | 归属正确——zsw 是残留的主要制造者，清理能力长在污染源侧可复用为周期维护；双库+文件面一处联动 | 中（新命令族 + 识别器 + 备份/回滚 + 测试） | 误删真实会话 → 白名单识别 + dry-run + 快照备份三重兜底（D1/D3） | ✅ |
| B. 一次性手工 SQL/命令手术（文档化 checklist） | 差——每次堆积重来一遍，无维护形态；知识留在文档里腐烂 | 最低 | 手跑容错最低，恰恰在最危险的操作上无防护 | ❌ |
| C. 只开 GUI 自动归档，不碰存量 | 差——`taskAutoArchive` 只归档 index 层且不回写引擎库，磁盘分文不回收，G1 不达成 | 零 | 零，但等于不做 | ❌（作配套兜底保留，D5） |

**推荐 A**。若用 B，§2.2 的 F3（误删）将无 dry-run/备份兜底，且三个月后残留再堆积时一切重来；若用 C，§2.1 的 9.1GB 存量永远在线。

### 3.3 关键决策与权衡

**D1：识别策略——四类目标分治，zsw 存量只信白名单（选定）**
- **采用**：① `subagent_child`（引擎 Agent tool 子会话）：按 `task_type='subagent_child'` 精确识别，默认只清 `time_created` 早于 7 天的（GUI 会话详情页的子代理视图可能引用近期记录）；② zsw 存量 interactive 会话：只认 `~/.zcode/zsw/records.jsonl` + `~/.zcode/zsw/outputs/` 产物里可交叉到的 sessionId 白名单（当前 141 个），**不在白名单的 interactive 一律不动**——宁可漏清，不可误删；③ 文件面（artifacts/exec）按目录名所含 session id 匹配上述两类删除集，exec 空壳目录另按年龄档清理；④ tasks-index 行按 task_id ∈ 删除集联动删除（C4）。
- **被否**：按目录/标题特征反查 zsw 会话——二轮已实证 zsw 会话外观与真实会话无区分特征，特征法必误伤（F3）；「清全部 subagent_child 不留 7 天」——近期子代理详情页引用会被打断，收益（约 0.3GB）不抵体验损失。
- **证据**：C6；二轮实测白名单 141 个；`session/subagents` RPC 存在（GUI 有子代理视图）。
- **效果**：G2「零误删」成立；F3 被白名单 + dry-run 双重拦截。

**D2：停机窗口执行，前置校验强制（选定）**
- **采用**：clean 执行前必须确认 ZCode GUI 与 app-server 进程均退出（进程探测 + 尝试以独占方式开库探测锁），任一不满足即拒绝并给恢复指引（见 3.1 失败样例）。
- **被否**：运行时在线清理——C3/C5，与 GUI 内存态和同步器打架，删了也可能被同步器重建索引。
- **证据**：C5；WAL 锁语义。
- **效果**：G1 的「安全」前提成立。

**D3：快照备份再动手（选定）**
- **采用**：每次 clean 先把 `db.sqlite`（含 `-wal`/`-shm`）与 `tasks-index.sqlite` 复制到 `~/.zcode/zsw/maintenance/backup-<时间戳>/`，报告打印还原命令；备份只保留最近一份，用户确认无异常后 `--purge-backup` 释放。
- **被否**：不备份直接删（B 案形态）——删除集涉及 83 万行级联，不可逆操作无安全网不可接受。
- **证据**：C1/C2（删除不可级联依赖、不可逆）。
- **效果**：G1 的「可回滚」成立；A-7 验收此路径。

**D4：VACUUM 与磁盘门槛（选定）**
- **采用**：删除后必须 `VACUUM` 引擎库（C2），前置校验剩余磁盘 > 库体积×1.2，不足则报错并指引先跑 `--fs-only` 清文件面腾空间。
- **被否**：`PRAGMA auto_vacuum=INCREMENTAL` 改库配置——改动宿主库的全局配置属侵入宿主，违反「不动 zcode」约束的精神；一次 VACUUM 已够。
- **证据**：C2。
- **效果**：G1 的磁盘回收真实到账，而非仅逻辑删除。

**D5：周期维护为手动档位，不自动 cron（选定）**
- **采用**：`zsw doctor clean --stale --older-than 30d` 为手动维护档（识别集缩到超龄部分）；删除类操作默认不自动化（授权边界）；同时建议用户在 ZCode 设置中开启「任务自动归档」（`taskAutoArchiveEnabled`，默认关，归档条件：已完成 + 未置顶 + 无未读 + 超 7 天）作为 index 层兜底——它不回收磁盘，只保持侧边栏干净。
- **被否**：launchd/cron 自动周期清理——删除操作无人值守 + 停机窗口要求（D2）无法自动保证，自动化会变定时炸弹。
- **证据**：GUI 设置 schema 含 `taskAutoArchiveEnabled/taskAutoArchiveOlderThanDays`（默认 false/7 天，实测默认未开启）。
- **效果**：G3 成立；L4 兜底归位。

**D6：model_usage 跟随会话删除（选定）**
- **采用**：删除集内 session_id 的 `model_usage` 行同事务删除——保留 = 用户用量页永久混入工具用量（当前 71% 是 subagent 产生），统计面失真比「历史工具用量不可再查」更伤。
- **被否**：保留统计行——见上；只删 zsw 部分不删 subagent_child 部分——同一语义面两种标准，徒增规则。
- **证据**：2.1 面①实测 94,805/134,263 行。
- **效果**：F2 的统计维度闭合；代价登记见 3.4。

**D7：文件面清理范围与口径（选定）**
- **采用**：artifacts/exec 只删目录名含删除集 session id 的目录 + exec 超龄空壳；log 只按文件年龄整文件删除（默认保留 14 天），不解析不截断内容——log 是引擎全局诊断面，动内容会破坏当日写入句柄。
- **被否**：log 全清——当日活跃日志文件被删会导致引擎持有失效 fd 继续写不可见数据。
- **证据**：2.1 面④⑤实测。
- **效果**：G1 文件面回收 ~1.9GB；副作用归零。

### 3.4 已接受代价（量化四要素）

| 代价 | 量级 | 恢复路径 | 重审触发条件 | 判定 |
|---|---|---|---|---|
| 超 7 天的 subagent_child 转录删除后，历史 GUI 会话的子代理详情不可再查 | 6200 会话 / 约 80 万 part 行 | 备份保留期内可整库回滚（D3） | 出现一次「需要翻历史子代理详情」的真实调试需求 | 可接受 |
| zsw 白名单会话的逐字转录删除 | 141 个会话（zsw records 仍保留 outcome 摘要） | 同上 | 出现需要逐字回溯 zsw 任务过程的调试场景 | 可接受 |
| 14 天前的引擎日志删除 | 约 240MB、3 个日文件 | 无（日志性质决定） | 需要跨 14 天以上的协议漂移取证 | 可接受 |
| 备份占用一倍库体积直至 purge | 清理前约 6.7GB 峰值 | `--purge-backup` 即释放 | 磁盘告警 | 可接受（临时性） |

### 3.5 运行时断言与探针

| ID | 断言 | 探针 | 状态 | 失败时降级 |
|---|---|---|---|---|
| P1 | 子表可级联删除 | `PRAGMA foreign_keys=ON` 后删一个测试 session 行，查 message/part 计数归零 | ✅ 二轮已实证 C1 | 改手工逐子表 DELETE（顺序：part→message→…→session） |
| P2 | VACUUM 回收空间 | 删除后 `du` 对比库体积 | ✅ C2 实证 auto_vacuum=0 | 无 VACUUM 则只逻辑删除，报告如实标注「空间未回收」 |
| P3 | 停机窗口可探测 | 进程探测 + 独占开库 | ⛔ 实施期门（F3 单元内实测） | 探测不可靠 → 降级为要求用户手动确认「已退出 ZCode」再执行 |
| P4 | 引擎对已删 subagent_child 的容错 | 删除后重启 ZCode 打开含子代理的历史会话 | ⛔ 实施期门（A-2/A-3 验收覆盖） | 不容错 → D1 改全量保留 subagent_child，只清 zsw 白名单 |

---

## 4. 验收（真实场景，回溯 §1 目标）

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|---|
| A-1 | 全量清理真实跑 | 退出 ZCode → `zsw doctor` → `clean --dry-run` → `clean` | 报告各面删除计数与 dry-run 一致；VACUUM 后 `du` 实测回收 ≥4GB；无报错 | G1 |
| A-2 | **宿主表面不变量** | 清理后重启 ZCode，逐个打开常用 workspace | 侧边栏只剩真实会话；无 `sess_subagent_agent_%` 与白名单会话；真实会话可正常打开恢复 | G2 |
| A-3 | 零误伤抽查 | 抽 5 个非 zsw 的真实历史 interactive 会话打开读消息；检查 tasks-index 中 pinned/未读行 | 消息完整可读；pinned/未读状态不变 | G2 |
| A-4 | dry-run 准确性 | 对比 dry-run 报告与实际执行报告 | 各面计数一致（差异为 0） | G1 |
| A-5 | 周期档位 | 清理后造一批超龄测试数据（或自然等待）→ `clean --stale --older-than 30d` | 只清超龄部分，7 天内 subagent_child 与近期文件不受影响 | G3 |
| A-6 | 体检可观测 | `zsw doctor` 输出与 sqlite 直查 `select count(*) ...` 逐面核对 | 各面数字一致 | G4 |
| A-7 | 备份回滚 | 清理后从备份目录复制双库回原路径 → 重启 ZCode | 侧边栏与会话恢复到清理前状态；再 `--purge-backup` 释放空间 | G1 安全网 |

## 5. 下一层拆分

| 单元 | 内容 | 领地 | 依赖 | 验收 |
|---|---|---|---|---|
| F1 | `zsw doctor` 只读体检：五面量级采集 + 识别集计数 + 预估回收 | lib/doctor.js（新）、bin/zsw.js 接线 | 无 | A-6 |
| F2 | 识别器 + dry-run：白名单交叉（records/outputs）、四类目标分治、删除集清单输出 | lib/doctor.js、lib/clean-identify.js（新） | F1 | A-4 |
| F3 | 执行器：前置校验（停机/磁盘）→ 备份 → 双库删除（FK 级联）→ VACUUM → 报告 | lib/clean-exec.js（新） | F2 | A-1/A-2/A-3 |
| F4 | 回滚与备份管理：`--purge-backup`、还原指引文案 | lib/clean-exec.js | F3 | A-7 |
| F5 | 文件面清理：artifacts/exec 按 id 匹配 + log 按龄整文件删 + `--fs-only` 档 | lib/clean-fs.js（新） | F2 | A-1 |
| F6 | 周期档位 `--stale --older-than` + README/skill 文档 + 测试 | bin/zsw.js、README.md、test/ | F3/F5 | A-5 |

**实施路径**：F1 → F2（识别正确性先行，识别错全错）→ F3/F4 → F5 → F6。

**待验证检查点（实施期门）**：① P3 停机探测可靠性；② P4 引擎容错；③ log 按龄删除与引擎当日写入句柄的相处（D7 推断，实施期实测）。

**文件改动地图**：新增 `lib/doctor.js`、`lib/clean-identify.js`、`lib/clean-exec.js`、`lib/clean-fs.js`；改 `bin/zsw.js`（子命令注册）；新增 `test/doctor.test.js`；README 维护章节。

---

## 6. 变更历史

| 日期 | 变更 | 触发 |
|---|---|---|
| 2026-09-05 | 初版 | zcode 子代理会话残留二轮分析（写入面穷举补齐）后的存量清理与维护设计；源头止血（parentSessionId）由并行任务实施 |
