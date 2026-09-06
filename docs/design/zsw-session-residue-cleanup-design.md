# zsw 会话残留：存量清理与周期维护设计

> **一句话结论**：在 zsw 插件内建 `zsw doctor`（只读体检）+ `zsw doctor clean`（停机窗口执行：识别 → 快照备份 → 双库联动删除 → VACUUM → 文件面清理），配套周期维护档位与自检命令，把已堆积的 ~9.1GB 会话残留安全回收，并让残留不再单调堆积。

**层声明**：当前层 = 技术方案；下一层 = 实现计划（zsw 插件内新命令 + 测试）。涉及运行时行为/数据流/错误处理，层敏感准则 5/6/7 全部适用。
**受众假设**：读者会用 zsw CLI、知道 ZCode 桌面端存在，但不懂 zcode 引擎内部存储结构——关键概念在 §2 补背景。

---

## 1. 背景目标

**SCQA**

- **S（情境）**：zsw（z-subagent-workflow 插件）的 zcode 引擎自 2.0 起与 ZCode GUI 共享宿主 HOME——zsw 每跑一个任务/子代理，引擎就把会话写入真实 `~/.zcode/cli/db/db.sqlite`，与 GUI 共库。一轮源码分析已定位侧边栏污染根因，**源头止血**（`session/create` 传 `parentSessionId` + `titleGenerationEnabled:false`，均已实测验证）由另一任务在 zsw 插件侧实施中。
- **C（冲突）**：源头止血只止血不回收——二轮分析发现存量已堆积 **~9.1GB**（DB 6.7GB + artifacts 1.8GB + log ~0.46GB + exec 0.14GB），且清理远比「删一个库」复杂：侧边栏数据源是**另一个库**（GUI 私有 `tasks-index.sqlite`），伴生写入面还有 `model_usage` 统计表与三个文件目录；引擎**没有任何归档/删除 RPC**；更麻烦的是 zsw 存量会话在引擎库里**外观与真实用户会话完全无法区分**（都是 `interactive`、无 parent、标题正常）。
- **Q（问题）**：如何把存量残留**安全**清掉（不误删真实会话、可预览、可回滚），并建立周期维护让残留不再堆积？
- **A（答案）**：zsw 插件内建 `zsw doctor` / `zsw doctor clean` 命令族：白名单交叉识别（records 白名单 ∩ 引擎库 + zsw 自测试目录特征两类识别源）→ 快照备份 → 双库联动删除 → VACUUM 回收 → 文件面按龄清理；周期维护为手动档位（删除类操作不自动化）；GUI 自动归档作为 index 层兜底建议。

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
  │  + 引擎库内引用 session 的全部 13 张表（sqlite_master 穷举，R2 按 FK 列粒度分类——
  │    分类是删除动作依据，必须列级精确，按表归类会错）：
  │    · 直接 FK→session 且 CASCADE 的列（8 张表）：message / todo / session_entry /
  │      session_input / session_target / model_usage / turn_usage / tool_usage 的 session_id 列
  │      （turn_usage 含 input/output/reasoning 全维度 token 统计，比 model_usage 更细，
  │        孤儿行同样污染统计面——遗漏即单调累积）
  │    · part：直接 FK 指向 message（CASCADE），随 message 级联——非 session 直接 FK，核对清单标注间接
  │    · session_task_link 双 FK 混合表：child_session_id（NOT NULL + CASCADE）+
  │      parent_session_id（SET NULL）——按列分别处理，当前 0 行
  │    · SET NULL 列 2：workflow_run.parent_session_id、workflow_activity.child_session_id
  │      （注意列名是 child 不是 parent；当前 0 行，仍纳入联动口径防增长）
  │    · 无 FK 1 张：input_history（session_id 可空列；GUI 手输与 RPC session/send 均写——
  │      R2 实测探针会话也有行；删除集命中行随删，时点 16 行·全删除集口径，活库漂移以实时为准）
  │  实测（2026-09-05 晚；库活跃写入，各面计数存在 <1% 时点漂移，实施以 doctor 实时查询为准）：
  │       session ~7,280 行（interactive 840 含 zsw、subagent_child 6,425）；
  │       subagent_child 占 message 57%、part 60%、todo 84%、tool_usage 74%；
  │       model_usage ~134.5K 行，其中 sess_subagent_agent_% 来源 71%
写入面 ② GUI 索引库 ~/.zcode/v2/tasks-index.sqlite
  │  GUI 重启/切换 workspace 时由 host 同步器调引擎 session/list（过滤：directory 匹配
  │  AND parent_id IS NULL AND time_archived IS NULL，按 time_updated 倒序取 50）重建
  │  （limit 50 与 parent 过滤已在引擎 session/list handler 实测锚定：`limit ?? 50`、`roots:true`）
  │  实测：修正删除集（C6 构造式白名单∩库 ∪ subagent_child ∪ 特征目录类）命中 tasks 33 行（全部已归档），
  │       1 条漏网 subagent（live-merge 入镜后 index 行未回收）
  │  同库姊妹表（均无对 tasks 的外键——只删 tasks 会留孤儿，R1 审查补齐）：
  │       task_group_members（11 行，FK 仅指 task_groups）、automations.target_task_id
  │       （6 行非空）、off_peak_tasks（0 行，注意无 task_id 列，命中按 session_id 匹配）；
  │       修正口径下当前命中 members 0 / automations 0（R2 曾测得 1/1，系 targetSessionId
  │       污染白名单所致——真实用户会话 fc9b87dc 误入删除集，被冲突机制碰巧拦下，见 C6 被否谱系）
写入面 ③ ~/.zcode/cli/artifacts/（1.8GB）
  │  实测：3,700+ 个目录（目录名 = session id），82% 属 subagent 会话，单目录最大 27M
写入面 ④ ~/.zcode/cli/log/（~460MB，无轮转）
  │  实测：仅 7 个日文件，最早 2026-08-30，单日最高 ~117MB；只增不减
  │  （当前超 14 天文件 0 个——log 面可回收量随执行日推移自然增长，按增速约 50-110MB/天累积）
写入面 ⑤ ~/.zcode/cli/exec/（138MB）
  │  实测：~5,870 个目录（绝大多数以 sess_ 前缀命名），抽样几乎全为空壳（会话结束不回收）；
  │  含非会话目录（实测 bash-startup）——按龄清空壳必须限定 sess_ 前缀，防误删引擎自有目录
```

### 2.2 真实失败模式

| # | 失败模式 | 触发条件 |
|---|---|---|
| F1 | 侧边栏被 zsw 会话涌入 | ZCode 重启/切换 workspace 后 GUI 全量 re-seed（zsw 会话活在独立 app-server 进程，运行期 GUI 内存态看不见——所以是「重启后涌现」而非实时可见） |
| F2 | 磁盘单调累积，无任何清理通道 | 引擎无 archive/delete RPC（已枚举全部 session/* 方法确认）；GUI「归档」只写自己的 index 库，不回写引擎库 |
| F3 | 手工清理误删真实会话 | zsw 存量会话在引擎库里无识别特征（见 2.1 面①）；直接按目录/标题猜会误伤 |
| F4 | 只清引擎库，侧边栏照样显示 | 侧边栏读 tasks-index.sqlite（面②），与引擎库无 FK 联动 |
| F5 | 标题生成的隐性模型调用浪费 | R1 时点 45/45 个可追溯 zsw 会话全部触发引擎后台 `session_title_generation`（zsw 未传 `titleGenerationEnabled:false`，引擎默认开；计数随库活跃漂移，以实时为准）——源头止血已含此修复，本文不再处理 |

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
| C6 | zsw 会话的权威识别源只有 zsw 自己的 `~/.zcode/zsw/records.jsonl`——**构造式（显式定义）**：文件内全部 `"sessionId"` 字符串值（含嵌套 `exec.sessionId` / `sessionRef.sessionId` 层），**仅此一类**。两个口径必须分离：**白名单总数**（实测 143）≠ **白名单∩引擎库**（实测 **47**，随库活跃写入缓增）。引擎库内无特征可反查 | R2 实证；同文件不同 grep 层级曾数出 128 / 137 / 142——口径不定义则 dry-run 计数与验收对照无基准 |
| C6-被否 | 构造式并入 `"targetSessionId"` 值——R2 实测击穿：targetSessionId 是 zsw **调用方宿主会话**（用户真实会话；manager.js 头注「ctx {targetSessionId(取自 _meta)}」即通知投递目标），8 个唯一值 **8/8 在库**且与 sessionId∩库零交集、样本为真实任务（真实目录 + 用户分组 + 自动化）。并入 = 白名单∩库虚增到 55，其中 7 个用户会话将被直接误删、1 个（sess_fc9b87dc）靠 automations 冲突机制碰巧保留——G2 零误删被系统性击穿 | R2 主审三重证据（zsw 源码 / 8/8 实测 / 样本行为）；**`outputs/` 目录名是 `sa-` run id 不是 session id，亦不入式** |
| C7 | **白名单存在结构性盲区**：zsw 的 e2e / 探针执行路径不写 records（e2e.test.js 直连引擎），其会话照常落库——directory 含 `zsub-e2e-` mkdtemp 前缀（e2e.test.js:39 生成）或位于已知探针目录（`/tmp/zsw-sidebar-probe`、`/tmp/pz2-work`）。实测 47 个此类 interactive 会话 **0/47 命中白名单**，按「不在白名单不动」将永久滞留（含转录与伴生 artifacts/exec 目录） | R1 实证：records 最早记录（08-23）早于库中此类会话出现，证明是执行路径缺口而非历史遗留 |

---

## 3. 解决方案

### 3.1 终态（使用者视角）

```text
$ zsw doctor                       # 只读体检，任何时刻可跑
zsw 会话残留体检（2026-09-XX，实时查询）
  引擎库会话行    白名单∩库 47 个（白名单总数 143）/ 特征目录类 47 个 /
                  subagent_child 6,425 个（其中 >7 天 ~6,200）
  引擎库引用表    13 表逐表行数（message/todo/session_entry/session_input/session_target/
                  model_usage/turn_usage/tool_usage/session_task_link/workflow_run/
                  workflow_activity/part/input_history——A-6 逐面核对面）
  引擎库体积      6.7GB（预估库内可回收 ~N = 删除集粗口径 N/M × 库体积；粗估，真实以执行后 du 为准；文件面另计 ~1.6GB）
  GUI 索引行      tasks 命中 33 行（全部已归档）；姊妹表冲突：members 0 / automations 0 / off_peak 0
                  （括注表规模供观测——冲突命中在前，样张口径）
  artifacts/      3,050+ 个 subagent 目录（~1.5GB）
  log/            超 14 天日志 0 个（当前回收 0；随执行日 ~50-110MB/天累积）
  exec/           sess_ 前缀空壳目录 ~5,700 个（~130MB）
备份状态          上次清理备份：无
👉 预览删除清单：zsw doctor clean --dry-run

$ zsw doctor clean --dry-run       # 预览，不写任何东西
将删除（不写库）：
  引擎库 session 47（白名单∩库）+ 47（特征目录类）+ ~6,200（超龄 subagent_child）行；
    按 FK 列级联（8 张 CASCADE 表 + part 经 message 间接级联 + session_task_link.child），
    model_usage/turn_usage 统计行随之级联；input_history 命中 16 行随删（GUI 手输与 RPC send 均写该表）
  污染哨兵：删除集 ∩ targetSessionId 值域 = 0（非 0 中止——污染或嵌套合法重叠，逐条核查）
  删除集 directory 分布（口径：仅 interactive 识别类——白名单∩库 + 特征目录类，共 ~94；
    排除 subagent_child——其 directory 全为工作区类且识别键是 task_type，纳入只会稀释红灯）：
    workspace 类 ~47 / 临时类（特征目录）47
    人工审红灯（机械阈值）：临时类占比 > 30%，或特征表之外的临时目录命中数非 0 → 停手核查
    （临时类判定 = OS 临时目录前缀：/tmp/、/var/folders/、os.tmpdir()；特征表外命中按白名单
    会话口径——特征类按构造必匹配特征表，落在临时目录的白名单会话即污染信号）
  GUI 索引 tasks 33 行（当前无姊妹表冲突；冲突机制保留为安全网）
  artifacts ∈删除集 ~3,000 目录；exec ∈删除集 + 超龄空壳（限 sess_ 前缀）；log 超龄 0 文件
  档位：--stale 时输出档位行（三类识别统一按 --older-than 过滤；文件面档位不跟随——
    log 保留 14 天 / exec 空壳 7 天各自固定）
    ⚠ 红灯触发时输出占比与特征表外命中数明细（人工审信号，非硬阻断）
预估回收 ~N（粗估，真实以执行后 du 为准 = 删除集占比 × 库体积；log 面随执行日增长；库内空间需 VACUUM 后生效）
👉 确认执行：退出 ZCode 后跑 zsw doctor clean

$ zsw doctor clean                 # 执行（自动先做前置校验）
✓ 前置校验：ZCode GUI / zcode app-server / 嵌套标记子进程（ZSW_NESTED、XYZ_AGENT_SUBAGENT）均未运行；双库独占开锁成功；
  磁盘三段校验过（备份前 ≥ 库×1.1；删除前「剩余−备份」≥ 1GB；VACUUM 前「剩余−备份」≥ 库×1.1）；
  SQLITE_TMPDIR 已钉死与库同卷
✓ 污染哨兵：删除集 ∩ targetSessionId 值域 = 0（该哨兵把 R2 审查发现的 targetSessionId
  污染模式固化为防线——当时 8 个调用方会话被误并入白名单，1 个靠冲突机制碰巧保留）
✓ 索引冲突预检：members / automations / off_peak 命中 0 条（机制保留：命中即冲突会话从双库删除集整体剔除 + 报告）
✓ 快照备份：~/.zcode/zsw/maintenance/backup-<ts>/ 内双库三件套（*.sqlite + -wal + -shm）
✓ 引擎库：分块删除（32 批 × ≤200 会话，批间 checkpoint）session ~6,290 行 + 13 表列级联动
  （input_history 随删 16 行）；VACUUM 完成（6.7GB→~2.5-3GB，真实会话约 40% 数据保留）
✓ GUI 索引：删除 tasks 33 行
✓ 文件面：artifacts 3,050+ 目录、log 按龄 0 文件、exec sess_ 空壳 ~5,700 目录
完成。如有异常，还原：①退出 ZCode；②删除原位 db.sqlite/-wal/-shm 与
tasks-index.sqlite/-wal/-shm；③将备份目录三件套整组 cp 回原路径（半套覆盖会产生
WAL 不一致）。确认无异常后 zsw doctor clean --purge-backup 释放备份空间。
```

失败路径示例（恢复指引）：

```text
$ zsw doctor clean
✗ 前置校验失败：检测到 ZCode 进程（PID 1234）正在运行。
  运行中清理会与 GUI 内存态冲突。👉 退出 ZCode（含菜单栏常驻）后重跑本命令。
✗ 前置校验失败：VACUUM 前剩余空间不足——备份已占 6.7GB，剩余 3GB < 需要 7.4GB（库 6.7GB×1.1）。
  【中流状态（实现显式标注）】此失败发生在删除已提交、VACUUM 未执行之后——备份保留原位，
  回滚安全网仍在；「删除备份目录」指引仅在确认放弃回滚后执行。
  备份 + VACUUM 临时空间峰值 ≈ 2× 库体积（分阶段校验见 D4）。👉 删除备份目录后先跑
  zsw doctor clean --fs-only 清文件面（当前约 1.6GB）腾空间，再重跑全量 clean。
  注意 --fs-only 同样执行全量停机校验——artifacts 删除会破坏运行中会话的转录引用，
  log 删除破坏写入句柄，不停机一样不安全，不设豁免。
✗ 污染哨兵失败：删除集 ∩ targetSessionId 值域 = 2（sess_xxx / sess_yyy）。
  命中可能是识别器污染（C6-被否：targetSessionId 是 zsw 调用方宿主会话=用户真实会话），
  也可能是嵌套调用的合法重叠（zsw 会话充当另一次 zsw 调用的宿主）。👉 中止不改库；
  逐条核查命中会话的 directory/标题后，把 dry-run 清单交维护者判定。
```

### 3.2 方案对比

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. zsw 内建 `zsw doctor clean`**（选） | 归属正确——zsw 是残留的主要制造者，清理能力长在污染源侧可复用为周期维护；双库+文件面一处联动 | 中（新命令族 + 识别器 + 备份/回滚 + 测试） | 误删真实会话 → 白名单识别 + dry-run + 快照备份三重兜底（D1/D3） | ✅ |
| B. 一次性手工 SQL/命令手术（文档化 checklist） | 差——每次堆积重来一遍，无维护形态；知识留在文档里腐烂 | 最低 | 手跑容错最低，恰恰在最危险的操作上无防护 | ❌ |
| C. 只开 GUI 自动归档，不碰存量 | 差——`taskAutoArchive` 只归档 index 层且不回写引擎库，磁盘分文不回收，G1 不达成 | 零 | 零，但等于不做 | ❌（作配套兜底保留，D5） |

**推荐 A**。若用 B，§2.2 的 F3（误删）将无 dry-run/备份兜底，且三个月后残留再堆积时一切重来；若用 C，§2.1 的 9.1GB 存量永远在线。

### 3.3 关键决策与权衡

**D1：识别策略——五类目标分治，白名单只认精确构造式（选定，R2 修订）**
- **采用**：
  ① `subagent_child`（引擎 Agent tool 子会话）：按 `task_type='subagent_child'` 精确识别，默认只清 `time_created` 早于 7 天的（GUI 会话详情页的子代理视图可能引用近期记录）；
  ② zsw 存量 interactive 会话：只认 C6 构造式（**仅 sessionId 值，不含 targetSessionId**）的 records 白名单 **∩ 引擎库**（实测 47），**不在白名单的 interactive 一律不动**——宁可漏清，不可误删；
  ③ **特征目录类（R1 新增，消解 C7 盲区）**：directory 匹配 zsw 自测试/探针目录特征表——**路径段匹配**（directory 按 `/` 分段后存在以 `zsub-e2e-` 开头的段，e2e.test.js:39 mkdtemp 前缀生成，自然覆盖其下 e1-proj / zsw-root / wt-* 子路径）或**整串相等**（`/tmp/zsw-sidebar-probe`、`/tmp/pz2-work`，分析期探针目录，人工确认）。特征表为**闭集清单**（代码内常量数组，新增条目必须附来源注释），不做子串模糊匹配——路径段/整串语义防止误伤目录名恰好含特征片段的真实项目；此类目录只会被 zsw 测试代码/探针创建，真实用户项目不可能位于 OS 临时目录的该前缀下。当前命中 47；
  ④ 文件面（artifacts/exec）按目录名（= session id）匹配 ①②③ 删除集；exec 空壳目录另按年龄档清理，**限定 sess_ 前缀**（排除 bash-startup 等引擎自有目录，实测存在）；
  ⑤ 双库联动删除：引擎库覆盖**全部 13 张 session 引用表，按 FK 列粒度执行**（2.1 面①清单：8 张直接 CASCADE 表 + part 经 message 间接级联 + session_task_link 按 child/parent 两列分别处理 + 2 个 SET NULL 列 + input_history）；`input_history` 命中行**随删**并报告计数（GUI 手输与 RPC session/send 均写该表，R2 实测证明「零命中断言」前提不成立而废除；全删除集口径时点命中 16 行，活库漂移以实时为准——R3 订正，原 13 只数了白名单桶）；tasks-index = tasks 行 + `task_group_members` 行同事务删除（附属关系无独立价值）；`automations.target_task_id` / `off_peak_tasks`（匹配列：`session_id ∈ 删除集 ∨ tasks.off_peak_task_id 关联`）命中删除集时**冲突会话从双库删除集整体剔除并逐条报告**——引擎 session 行与 index tasks/member 行**均保留**（只留 index 删引擎 = 侧边栏幽灵任务指向已删会话，「安全网」名不副实；R3 作用域闭合），下次 clean 重查后自然纳入；修正口径下当前命中 0/0——R2 实测的 1/1 冲突正是 targetSessionId 污染产物）。**污染哨兵（R2 引入、R3 归因中性化）**：dry-run 与执行前断言「删除集 ∩ records 全部 targetSessionId 值域 = 0」（**对冲突剔除前的原始删除集断言**——冲突机制可能碰巧掩盖污染，C6-被否的 sess_fc9b87dc 即靠冲突碰巧保留），非 0 中止不改库——命中可能是识别器污染（见 C6-被否）**或嵌套调用的合法重叠**（zsw 会话充当后续 zsw 调用宿主时，该 session 合法地既是 sessionId 又是 targetSessionId），错误信息按此中性表述、逐条核查后处理。
- **被否**：构造式并入 targetSessionId——见 C6-被否（8/8 为用户真实会话，系统性击穿 G2）。按目录/标题特征**模糊反查** zsw 会话——zsw 正常任务会话外观与真实会话无区分特征，模糊特征必误伤（F3）；③ 的特征表是闭集路径段匹配 + 来源注释，与被否的模糊反查不是一类。「清全部 subagent_child 不留 7 天」——近期子代理详情页引用会被打断，收益（约 0.3GB）不抵体验损失。「automations 冲突静默联动删」——自动化是用户创建的调度，代删越权。「input_history 零命中硬中止」——R2 实测 session/send 也写该表（探针会话有行），零命中前提不成立，硬中止将永久阻断 clean。
- **证据**：C6/C6-被否（构造式与污染三重证据）、C7（盲区 47 个）、`session/subagents` RPC 存在（GUI 有子代理视图）；R2 修正口径实测（∩库 47 / index 33 / 姊妹表冲突 0 / input_history 时点 16，活库漂移以实时为准）。
- **效果**：G2「零误删」成立（sessionId-only 构造式 + targetSessionId 污染哨兵 + 特征表闭集 + automation 冲突保留，四重兜底）；F3 被拦截；C7 盲区消解（47 个滞留会话纳入清理）。

**D2：停机窗口执行，前置校验强制且探测目标集显式化（选定，R1 修订）**
- **采用**：clean（**含 `--fs-only`**）执行前四项校验必须全过：① ZCode GUI 进程（Electron 主进程，含菜单栏常驻形态）；② 命令行含 `zcode.cjs app-server` 的 node 进程（zsw 引擎进程，进程名可能被改写，须按命令行匹配而非进程名）；③ ps 命令行文本含嵌套标记（ZSW_NESTED=1 / XYZ_AGENT_SUBAGENT=1）字样的子进程（检出面与局限见实现头注 P3③）（zsw 后台 Bash agent 跑引擎任务的形态）；④ 双库 `BEGIN EXCLUSIVE` 独占开锁（兜底：捕获无进程名的持库 fd / crash 残留句柄）。任一不满足即拒绝并给恢复指引（见 3.1 失败样例）。
- **被否**：运行时在线清理——C3/C5，与 GUI 内存态和同步器打架，删了也可能被同步器重建索引。「`--fs-only` 豁免停机校验」——artifacts 删除会破坏运行中会话的转录引用、log 删除破坏写入句柄，文件面不停机一样不安全。
- **证据**：C5；WAL 锁语义；R1 影响面审指出的漏网形态（ZSW_NESTED 子进程、crash 残留 fd）。
- **效果**：G1 的「安全」前提成立，探测盲区显式收敛。

**D3：快照备份再动手；还原按三件套整组覆盖（选定，R1 修订）**
- **采用**：每次 clean 先把双库**三件套**（`*.sqlite` + `-wal` + `-shm`——WAL 库必须连伴生文件一起快照才一致）复制到 `~/.zcode/zsw/maintenance/backup-<时间戳>/`；还原 = 退出 ZCode → 删除原位三件套 → 备份三件套**整组** cp 回原路径（半套覆盖会产生 WAL 不一致）；报告打印完整还原步骤；备份只保留最近一份，用户确认无异常后 `--purge-backup` 释放。
- **回滚边界（R1 补）**：整库回滚会抹掉「clean 之后 → 回滚之前」窗口内新产生的真实会话且无二级备份——代价显式登记于 §3.4；窗口超 7 天建议放弃整库回滚，改从备份库挑行恢复。
- **被否**：不备份直接删（B 案形态）——删除集涉及 83 万行级联，不可逆操作无安全网不可接受。只 cp 主库不 cp `-wal`/`-shm`——半套备份还原后 WAL 状态不一致。
- **证据**：C1/C2/C3；R1 影响面审（回滚窗口抹新会话 + 三件套完整性两处缺口）。
- **效果**：G1 的「可回滚」成立且破坏边界显式；A-7 验收此路径。

**D4：删除分块提交 + 磁盘三段校验（选定，R3 修订）**
- **采用**：删除按**分块多事务**执行——删除集按 ≤200 会话/批切分（~6,290 行 ≈ 32 批），每批一个事务，批间 `wal_checkpoint(PASSIVE)`，单批 WAL 峰值有界（~百 MB 级；停机窗口无读者竞争，PASSIVE 每批可完整 checkpoint 并复用 frame 空间；注意 PASSIVE 不截断 `-wal` 文件——文件保留峰值体积直至连接关闭，实现/验收时勿以 `-wal` 文件大小判断 checkpoint 失效，以 `PRAGMA integrity_check`（或 quick_check）与批级行数对账为准）；随后 `VACUUM`（C2）。磁盘校验三段（R3 修正——R2 的两段校验漏掉了删除阶段的 WAL 峰值：备份落盘 6.7GB 后余量仅 ~0.7GB，而单事务删 ~83 万行的脏页在提交前全写 `-wal`，GB 级峰值可能中途断粮）：① 备份前「剩余 ≥ 库×1.1」（库 = 双库三件套合计，与备份实占同口径）；② 删除前「剩余 − 备份 ≥ 1GB」（基准时点 = 备份完成后；分块后 WAL 峰值有界，此为兜底）；③ VACUUM 前「剩余 − 备份 ≥ 库×1.1」（基准时点 = 删除完成后、VACUUM 开始前；VACUUM 完成前原库不缩，临时空间约等量）。clean 进程设置 `SQLITE_TMPDIR` 指向与 `~/.zcode` 同卷的临时目录（SQLite 临时文件落盘卷由 SQLITE_TMPDIR/TMPDIR 决定，不必然与库同卷——分卷环境下校验的卷和断粮的卷可能不是同一个）。任一不足即报错并指引先跑 `--fs-only` 清文件面腾空间。
- **被否**：单一门槛 ×1.2（R2 已否）与两段校验（R3 否——漏删除阶段 WAL 峰值，第三段算术不闭合）。删除整体单事务——WAL 峰值无界。维护窗口切 `journal_mode=DELETE`——journal_mode 持久化在库文件头，clean 中途崩溃会把宿主库留在 DELETE 模式，改宿主状态且恢复语义变化。`PRAGMA auto_vacuum=INCREMENTAL`——改宿主库全局配置，侵入宿主。
- **证据**：C2/C3；R3 影响面审峰值算术（备份 1× + 删除 WAL + VACUUM 临时 1×）。
- **效果**：G1 磁盘回收真实到账，备份/删除/VACUUM 三阶段均不断粮，且临时卷显式钉死与库同卷。

**D5：周期维护为手动档位，不自动 cron（选定）**
- **采用**：`zsw doctor clean --stale --older-than 30d` 为手动维护档（识别集缩到超龄部分：三类识别统一按 `time_created` 严格早于 cutoff 过滤，恰等不算、空值保守保留）；**`--older-than` 仅作用于会话识别集**，不作用于文件面阈值（log 保留 14 天 / exec 空壳 7 天各自固定——一个 flag 不暗改两处安全阈值）；非法 `--older-than` 值（如 `30x`）拒绝执行（fail-fast，不回落缺省档——回落会静默扩大删除集）；删除类操作默认不自动化（授权边界）；同时建议用户在 ZCode 设置中开启「任务自动归档」（`taskAutoArchiveEnabled`，默认关，归档条件：已完成 + 未置顶 + 无未读 + 超 7 天）作为 index 层兜底——它不回收磁盘，只保持侧边栏干净。
- **被否**：launchd/cron 自动周期清理——删除操作无人值守 + 停机窗口要求（D2）无法自动保证，自动化会变定时炸弹。
- **证据**：GUI 设置 schema 含 `taskAutoArchiveEnabled/taskAutoArchiveOlderThanDays`（默认 false/7 天，实测默认未开启）。
- **效果**：G3 成立；L4 兜底归位。

**D6：model_usage 跟随会话删除（选定）**
- **采用**：删除集内 session_id 的 `model_usage` 行同事务删除——保留 = 用户用量页永久混入工具用量（当前 71% 是 subagent 产生），统计面失真比「历史工具用量不可再查」更伤。
- **被否**：保留统计行——见上；只删 zsw 部分不删 subagent_child 部分——同一语义面两种标准，徒增规则。
- **证据**：2.1 面①实测（sess_subagent_agent_% 来源 ~95K / ~134.5K 行，占比 71%；计数随时点漂移）。
- **效果**：F2 的统计维度闭合；代价登记见 3.4。

**D7：文件面清理范围与口径（选定，R1 修订）**
- **采用**：artifacts 只删目录名 ∈ 删除集的目录；exec 只删 sess_ 前缀目录（前缀为「∈ 删除集」与「超龄空壳」两通道的**共同前置**——防删除集 id 与引擎自有目录名碰撞误删，bash-startup 等非前缀目录一律不动），空壳判定保守（目录树内含任一文件即保留）；log 只按文件年龄整文件删除（默认保留 14 天），不解析不截断内容——log 是引擎全局诊断面，动内容会破坏当日写入句柄。log 面回收量按执行日实时计算（当前超龄 0 文件 ≈ 0 回收，随 ~50-110MB/天增速累积，见 2.1 面④）。
- **被否**：log 全清——当日活跃日志文件被删会导致引擎持有失效 fd 继续写不可见数据。「exec 空壳不分前缀按龄清」——目录里混有引擎自有目录（实测 bash-startup），无差别按龄清会误删。
- **证据**：2.1 面④⑤实测（R1 复核）。
- **效果**：G1 文件面回收当前 ~1.6GB（log 面随执行日自然增长）；副作用归零。

### 3.4 已接受代价（量化四要素）

| 代价 | 量级 | 恢复路径 | 重审触发条件 | 判定 |
|---|---|---|---|---|
| 超 7 天的 subagent_child 转录删除后，历史 GUI 会话的子代理详情不可再查 | ~6,200 会话 / 约 80 万 part 行 | 备份保留期内可整库回滚（D3） | 出现一次「需要翻历史子代理详情」的真实调试需求 | 可接受 |
| zsw 白名单会话的逐字转录删除 | 白名单∩库 47 个（zsw records 仍保留 outcome 摘要）；**含用户曾 resume 追加的输入**——GUI 打开续聊过的 zsw 会话，其追加内容随会话一并删除（G2「零误删」的语义边界：不删的是从未被 zsw 拥有的会话，被 resume 过的 zsw 会话仍属 zsw 会话） | 同上 | 出现需要逐字回溯 zsw 任务过程（含用户续聊内容）的调试场景 | 可接受（边界显式） |
| 特征目录类会话删除（zsw 自测试/探针产物） | 47 个会话及伴生 artifacts/exec | 同上 | e2e 结果需跨清理期回溯（重跑 e2e 即可再生产） | 可接受（无保留价值） |
| 整库回滚抹掉回滚窗口内的新真实会话 | = 窗口期新会话数（无二级备份） | 覆盖前可先从原库导出新会话，或放弃回滚改挑行恢复 | 回滚窗口 > 7 天（建议放弃整库回滚） | 可接受（边界显式） |
| automations / off_peak 冲突任务保留不删 | 当前 0 条（修正构造式后；R2 实测 1/1 系污染产物） | 用户在 GUI 删除/改绑调度后，下次 clean 自然纳入 | 冲突条数持续增长（>10） | 可接受（机制为安全网——R2 曾拦下 targetSessionId 污染） |
| input_history 删除集命中行随删 | 时点 16 行·全删除集口径（活库漂移以实时为准；GUI 手输与 RPC send 双写面；消费面为引擎 CLI 按 **project 维度**跨会话召回（`recallPreviousInputHistory({projectID})`，R3 bundle 核实），删除影响 = 该 project 召回列表少 N 条 zsw 机器输入） | 备份保留期内可整库回滚（D3） | 需要跨清理期回查输入历史 | 可接受（量级极小且多为噪音输入） |
| 14 天前的引擎日志删除 | 执行日实时计算（当前 0 文件；增速 ~50-110MB/天） | 无（日志性质决定） | 需要跨 14 天以上的协议漂移取证 | 可接受 |
| 备份占用一倍库体积直至 purge | 清理前约 6.7GB 峰值 | `--purge-backup` 即释放 | 磁盘告警 | 可接受（临时性） |

### 3.5 运行时断言与探针

| ID | 断言 | 探针 | 状态 | 失败时降级 |
|---|---|---|---|---|
| P1 | 全部引用表可按 FK 列级联删除 | `PRAGMA foreign_keys=ON` 后删一个测试 session 行，查 8 张直接 CASCADE 表计数归零、part 经 message 间接归零、session_task_link 双列与 2 个 SET NULL 列行为符合预期 | ✅ C1 已实证（R1 补齐 13 表口径，R2 订正为 FK 列粒度） | 实现为 fail-closed 中止（`PRAGMA foreign_keys` 未生效即中止不改库）；手工逐表 DELETE 序列仅作人工预案，子表先删、session 最后删（顺序：part→message→session_entry→session_input→session_target→todo→tool_usage→turn_usage→model_usage→session_task_link→input_history→session；SET NULL 列所在行置空） |
| P2 | VACUUM 回收空间 | 删除后 `du` 对比库体积 | ✅ C2 实证 auto_vacuum=0 | 无 VACUUM 则只逻辑删除，报告如实标注「空间未回收」 |
| P3 | 停机窗口可探测 | 进程探测 + 独占开库 | ✅ 已实证（2026-09-06 真机拒绝链 pass：①②④ 本机活体拦截；③ 检出面 = argv 字样形态、env 段可见性不可靠——尽力检出，见 lib/clean-exec.js 头注 P3 节与实现双标记口径） | 探测不可靠 → 降级为要求用户手动确认「已退出 ZCode」再执行 |
| P4 | 引擎对已删 subagent_child 的容错 | 删除后重启 ZCode 打开含子代理的历史会话 | ⛔ 用户域待执行（验收手册 verification/session-cleanup-acceptance-manual.md §4 已落盘；副本侧机制前提已验证：删除集外近期 child 保留） | 不容错 → D1 改全量保留 subagent_child，只清 zsw 白名单 |

---

## 4. 验收（真实场景，回溯 §1 目标）

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|---|
| A-1 | 全量清理真实跑 | 退出 ZCode → `zsw doctor` → `clean --dry-run` → `clean` | 报告各面删除计数与 dry-run 一致；VACUUM 后 `du` 实测回收 ≥3.5GB（真库副本演练实测回收 3.64GB；预估口径见 §3.1 粗估公式）；无报错 | G1 |
| A-2 | **宿主表面不变量** | 清理后重启 ZCode，逐个打开常用 workspace | 侧边栏只剩真实会话；无 `sess_subagent_agent_%` 与白名单会话；真实会话可正常打开恢复；任务分组视图无幽灵条目（task_group_members 无孤儿）；**8 个 targetSessionId 调用方会话全部完好** | G2 |
| A-3 | 零误伤抽查 | 抽 5 个非 zsw 的真实历史 interactive 会话打开读消息；检查 tasks-index 中 pinned/未读行；若有姊妹表冲突任务则核对其与引用它的 automation/off_peak 完好 | 消息完整可读；pinned/未读状态不变；冲突任务与其调度引用无损 | G2 |
| A-4 | dry-run 准确性 | 对比 dry-run 报告与实际执行报告 | 各面计数一致（差异为 0；白名单按 C6 构造式、双口径分别计数） | G1 |
| A-5 | 周期档位 | 清理后跑 1-2 个真实 zsw 任务产生新数据 → `clean --stale --older-than 1d`（小档位真实验证，不造数、不等待） | 只清新产生的超龄部分；7 天内 subagent_child 与近期文件不受影响 | G3 |
| A-6 | 体检可观测 | `zsw doctor` 输出与 sqlite 直查逐面核对——引擎库 13 张引用表 + 白名单双口径（总数/∩库）+ 索引 tasks 与姊妹表（members/automations/off_peak） | 各面数字一致 | G4 |
| A-7 | 备份回滚 | 清理后产生 1 个新真实会话 → 按 D3 三件套整组还原（先删原位三件套再整组 cp）→ 重启 ZCode | 清理前状态完整恢复（含被删会话）；新会话被抹除属已声明边界（D3 回滚边界）；再 `--purge-backup` 释放空间 | G1 安全网 |

## 5. 下一层拆分

| 单元 | 内容 | 领地 | 依赖 | 验收 |
|---|---|---|---|---|
| F1 | `zsw doctor` 只读体检：五面量级采集 + 识别集计数（白名单双口径）+ 预估回收 | lib/doctor.js（新）、bin/zsw.js 接线 | 无 | A-6 |
| F2 | 识别器 + dry-run：C6 白名单构造式、特征目录表（闭集常量 + 来源注释）、五类目标分治、污染哨兵（targetSessionId 值域零交集）、directory 分布红灯（口径见 §3.1：仅 interactive 识别类，排除 subagent_child）、索引冲突预检、删除集清单输出 | lib/doctor.js、lib/clean-identify.js（新） | F1 | A-4 |
| F3 | 执行器：四项停机校验（GUI / app-server 命令行 / 嵌套标记（双标记）子进程 / 双库独占开锁，`--fs-only` 同样执行）→ 三段磁盘校验 + `SQLITE_TMPDIR` 同卷 → 三件套备份 → 引擎库分块删除（≤200 会话/事务 + 批间 checkpoint）+ 13 表列级联动 + GUI 索引 tasks/members 联动（冲突会话双库整体剔除）→ VACUUM → 报告 | lib/clean-exec.js（新） | F2 | A-1/A-2/A-3 |
| F4 | 回滚与备份管理：三件套整组还原指引、`--purge-backup` | lib/clean-exec.js | F3 | A-7 |
| F5 | 文件面清理：artifacts 按 id 匹配 + exec sess_ 前缀限定 + log 按龄整文件删 + `--fs-only` 档 | lib/clean-fs.js（新） | F2 | A-1 |
| F6 | 周期档位 `--stale --older-than` + README/skill 文档 + 测试 | bin/zsw.js、README.md、test/ | F3/F5 | A-5 |

**实施路径**：F1 → F2（识别正确性先行，识别错全错）→ F3/F4 → F5 → F6。

**待验证检查点（实施期门）**：① P3 停机探测可靠性——✅ 已实证（2026-09-06 真机拒绝链，见 §3.5 P3；③ 嵌套标记检出面订正记录在实现头注）；② P4 引擎容错——⛔ 用户域待执行（手册 §4 已落盘）；③ log 按龄删除与写入句柄——✅ 停机窗口语义下引擎无活跃写入句柄，演练通过（真机停机窗口执行时按手册 §1 步骤 6 观察一日）。

**文件改动地图**：新增 `lib/doctor.js`、`lib/clean-identify.js`、`lib/clean-exec.js`、`lib/clean-fs.js`；改 `bin/zsw.js`（子命令注册）；新增 `test/doctor.test.js`、`test/clean-identify.test.js`、`test/clean-exec.test.js`、`test/clean-fs.test.js`；README 维护章节。

---

## 6. 变更历史

| 日期 | 变更 | 触发 |
|---|---|---|
| 2026-09-05 | 初版 | zcode 子代理会话残留二轮分析（写入面穷举补齐）后的存量清理与维护设计；源头止血（parentSessionId）由并行任务实施 |
| 2026-09-05 | R1 审查修订 | 双审 6 must-fix + 7 suggestion 当轮全修：主审——白名单盲区（新增 C7 + 特征目录识别类）、「141」口径错误（C6 构造式 + 总数/∩库双口径）、log「240MB」无实证（改公式化）；影响面审——引擎库引用表穷举补齐 13 表、GUI 索引姊妹表联动（members 随删 / automations 冲突保留）、回滚边界与三件套还原；suggestion——A-5 改小档位真实验证、exec 限定 sess_ 前缀、`--fs-only` 停机校验、limit-50 锚定 |
| 2026-09-05 | R2 审查修订 | 双审 4 must-fix + 6 suggestion 当轮全修：主审——**构造式剔除 targetSessionId**（R1 修复引入的致命伤：8/8 为调用方真实会话，新增 C6-被否谱系 + 污染哨兵断言，口径 143/47）、input_history「零命中断言」前提证伪（session/send 也写，改随删）；影响面审——FK 分类改列粒度（part 间接 / session_task_link 双列 / workflow_activity 列名订正）、磁盘门槛分阶段（峰值 ≈2×，×1.2 击穿）；suggestion——off_peak 匹配列、A-1 门槛对齐 3.5GB、F5/D6 旧数字同步、特征目录路径段匹配、A-2 加调用方会话完好检查 |
| 2026-09-05 | R3 审查修订 | 主审归零（3 suggestion + 2 INFO）、影响面审 2 must-fix + 2 suggestion，当轮全修：删除阶段 WAL 第三段峰值（D4 改分块多事务 + 批间 checkpoint + 磁盘三段校验 + SQLITE_TMPDIR 同卷）、冲突保留作用域闭合（冲突会话从双库删除集整体剔除）；suggestion/INFO——哨兵归因中性化（嵌套合法重叠）、input_history 全删除集口径 16 行 + project 维度召回措辞、dry-run 增 directory 分布人工审红灯、白名单代价行显式 resume 边界、面②删除集定义式补特征类 |
| 2026-09-05 | R4 终检收尾 | 双报告归零（主审 0M+3S、影响面审 0M+2S），全部 suggestion/INFO 当轮修完：F2 拆分残留的「input_history 零命中断言」清除并补污染哨兵与 directory 红灯、D1 证据行第六处 13→16 同步、directory 红灯声明口径（仅 interactive 识别类）与机械阈值（临时类 >30% 或特征表外临时目录非空）、分块批数算术订正 32、PASSIVE 不截断 -wal 的验收观测说明、三段校验基准时点显式化、时点数字加活库漂移标记 |
| 2026-09-06 | 实现一致性同步（dev-flow 阶段 3/4） | 双区一致性审查（识别域/执行域独立分区）：doc_error 1 处当轮修正——执行样张把引擎库表 input_history 误挂「✓ GUI 索引」行（移入「✓ 引擎库」行，与实现渲染一致）；合理演化 9 条同步正文——哨兵对冲突剔除前原始集断言（D1⑤）、体检样张补 13 表行与姊妹表冲突/表规模双口径（§3.1）、dry-run 文件面行改删除集口径与红灯触发行/档位行（§3.1）、红灯临时类判定式与特征表外白名单口径（§3.1）、D5 补 --older-than 仅作用会话识别集/文件面档位不跟随/非法值 fail-fast、P1 降级实现为 fail-closed 中止（§3.5）、失败样例补中流状态注记（§3.1）、D4① 补双库三件套合计口径、D7 补 sess_ 前缀为 exec 两通道共同前置；unreasonable 8 条实现侧当轮全修（核心：A-4 dry-run 文件面与执行 counts 改由 clean-fs plan 同源对账；--older-than 非法值 fail-fast；SQLITE_TMPDIR 拒绝路径临时目录清理；dry-run 单 filePlan 口径消解双轨），报告在 `.review/` 会话记录 |
| 2026-09-06 | design-code-sync 第 1 轮同步 | 终态全量双区审查 15 findings（6 must-fix/medium + 6 suggestion + 3 info）当轮全修：样张预估回收行改粗估公式（§3.1 两处 + A-1 括注联动）、`wal_integrity_check` 悬空 pragma 订正为 `integrity_check`（D4 + 实现头注）、§3.5 P3 状态改已实证（③ 嵌套标记检出面 = argv 字样形态、env 段可见性不可靠——尽力检出，①②④ 为真实防线）与 P4/§5 检查点改用户域完成态、执行样张前置行双标记化（ZSW_NESTED + XYZ_AGENT_SUBAGENT，与实现 isNestedCommand 口径一致）；impl-plan 偏差 #2 状态、§7 残留风险完成态、变更历史补行、.review 不入库括注；实现侧注释 MF-N 悬空编号内联自描述化（全仓 14 处）与归因订正 |
