---
name: merge
description: >-
  合并 feature 分支回 main 并收尾（PR CI 确认 → merge commit 合并 → main 同步 →
  post-merge CI → worktree 清理）。触发词："合并"、"merge"、"合入 main"、
  "合并发布"。仅用于 zcode-plugin-workspace（bare repo + worktree）。
  不用于 纯 npm 发版不合并（直接走 scripts/release.js 流程，见 AGENTS.md npm 发布规范）、
  开 PR/审查（pr-cr-fix skill）、跨项目合并。
---

# merge — 合并 feature 分支回 main

7 阶段：前置确认 → 本地终验 → PR 合并 → main 同步 → post-merge CI → 发版决策 → 清理。
**发布与合并解耦**（与 xyz-agent merge skill 的结构差异）：本项目版本三件套
（package.json / plugin.json / marketplace.json）由 `scripts/check-sync.js` 全程守护，
bump + npm 发布是独立动作（`scripts/release.js` + tag），不在本流程内——合并频率与
发版频率不同步，把发布绑进合并会把「合入 main」强行放大成「对外发布」。

## 前置条件 [MANDATORY]

- feature 分支有已 open 的 PR（pr-cr-fix skill 阶段 3 产出；无 PR 先走 pr-cr-fix）
- GitHub CLI 已认证（`gh auth status`）
- main worktree 存在（`$WS_ROOT/main`；缺失时先 `git worktree add main main`）

### cwd 隔离 [MANDATORY]

bash 工具每次调用都是独立 shell，cwd 不跨调用持久（每次 reset 到 session 启动目录，
通常是 feature worktree）。**每条命令自包含 `cd <绝对路径> &&`**：
操作 main worktree 必须 `cd $WS_ROOT/main && <cmd>`，操作 workspace root 必须
`cd $WS_ROOT && <cmd>`——不能依赖上一条命令的 cd。阶段 2 起 feature 分支已合并、
阶段 6 会删除 feature worktree，写操作落在 feature worktree 会污染已合并分支。

## 7 阶段流程

`$WS_ROOT` = workspace 根（含 `.bare/` 的目录），`$WT` = feature worktree 目录名，`$BR` = 分支名。

### 阶段 0: 前置确认

⚠️ 后续所有阶段的操作对象是 **feature worktree**（阶段 1）与 **main worktree**（阶段 3 起）。
`$WT` 绝不能是 `main`——阶段 6 会删除 `$WT` 指向的 worktree，传 main 等于删 main。

```bash
cd $WS_ROOT && git worktree list          # 确认 $WT 与 $BR 存在
gh pr view $BR --repo zhushanwen321/zcode-plugins --json state,number,title   # state 必须 OPEN
```

### 阶段 1: 本地终验（feature worktree 内，零容忍）

与 ci.yml 同构的本地口径 + 合入同步项核对：

```bash
# 1. 工作区 clean（合并前不允许残留未提交改动）
cd $WS_ROOT/$WT && git status --short     # 必须为空

# 2. 单测（排除 e2e——真机+真实模型，按插件 README 验收手册单独跑）+ npm 三件套 gate
cd $WS_ROOT/$WT/z-subagent-workflow && \
  find test -name '*.test.js' ! -name 'e2e.test.js' -print0 | xargs -0 node --test
cd $WS_ROOT/$WT && node scripts/check-sync.js && node scripts/check-pack.js

# 3. 合入同步项（AGENTS.md Git 规范）：新插件/版本变更时 marketplace.json 已登记、
#    根 README「现有插件」表已更新——缺失补在 feature 分支内（本阶段 FAIL 重走）
```

**Gate-1**：三项全过才继续。任何 FAIL 正面修复（禁 `--no-verify` / 跳过用例），修完从阶段 1 头部重跑。

### 阶段 2: PR CI + 合并

```bash
# [HISTORICAL] 禁 `gh pr checks --watch`（无限阻塞，runner 排队时挂死会话——PR #4
# 事故挂 7h+ 跨会话残留；与 pr-cr-fix Gate-3 同源禁令）。有限轮询姿势（60s 间隔、
# 15 分钟上限，pass 即 break，超时上报用户人工接管）。CI 假失败狀置（runner 排队
# 超时回收 → steps 为空数组）见 pr-cr-fix Gate-3：gh run rerun 重跑，不盲修：
cd $WS_ROOT
for i in $(seq 1 15); do
  if gh pr checks <PR号> --repo zhushanwen321/zcode-plugins; then break; fi
  sleep 60
done
gh pr merge <PR号> --repo zhushanwen321/zcode-plugins --merge --delete-branch
```

`--merge` = merge commit（对齐全局 `--no-ff` 规范，**绝不用 squash**——保留 feature 分支
完整历史）。`--delete-branch` 删远端分支；本地分支由阶段 6 清理。

### 阶段 3: 本地 main 同步

`gh pr merge` 只更新远端，本地 refs 陈旧——bump/发版前必须同步。
用 `--ff-only`：合并后本地 main 与远端恰为同源，出现非 ff 即本地 main 有独有 commit，
必须人工排查（禁 `reset --hard` 掩盖分歧）：

```bash
cd $WS_ROOT/main && git fetch origin main && git merge --ff-only origin/main
```

### 阶段 4: post-merge CI

main 上 ci.yml 会因 push 再跑一次。等它绿（合入的代码在 main 语境下再验一遍）：

```bash
cd $WS_ROOT/main && MAIN_SHA=$(git rev-parse origin/main)
# 轮询拿 run id：只接受 --commit "$MAIN_SHA" 精确匹配（传播延迟下无过滤查询会拿到旧 run，误判成功）
for i in $(seq 1 15); do
  RUN_ID=$(gh run list --workflow=ci.yml --repo zhushanwen321/zcode-plugins \
    --commit "$MAIN_SHA" --limit 1 --json databaseId --jq '.[0].databaseId')
  [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ] && break
  sleep 2
done
gh run watch "$RUN_ID" --repo zhushanwen321/zcode-plugins --exit-status   # 必须 --exit-status
```

FAIL 时：看 run 日志定位 → 修复需新分支重走 pr-cr-fix（main 已含坏提交时先告知用户决策，禁自动 revert main）。

### 阶段 5: 发版决策 [OPTIONAL]

**默认不发版**。仅当用户指令明确要求发布、或本次合并含用户可感知的功能/修复且用户确认时执行：

```bash
cd $WS_ROOT/main && node scripts/release.js <plugin> <patch|minor|major>
# 输出下一步 push 命令 → 需用户授权后执行：
git push origin HEAD && git push origin "<plugin>@<version>"
```

tag push 触发 release-npm.yml。验证（registry 有传播延迟，30s 重试）：

```bash
gh run watch <run-id> --repo zhushanwen321/zcode-plugins --exit-status
curl -s -o /dev/null -w "%{http_code}" \
  "https://registry.npmjs.org/@zhushanwen%2f<plugin>/<version>"   # 200 = 已上线
```

**[MANDATORY] 禁止本地 `npm publish`**：发布由 CI 完成（NPM_TOKEN 在 Actions secret），
本地只做 release.js bump + tag push。

### 阶段 6: 清理（终结阶段）

⚠️ 整个 merge 流程的**最后一步**。执行后立即输出合并总结收尾，禁止再调 bash 做「删除确认」。

**6a. dev-link 恢复正式版（删 worktree 前置，防止 inline 悬空）**：插件若以 dev-link 的
inline 形态注册在本机 zcode（`~/.zcode/cli/config.json` 指向本 worktree），直接删 worktree
会留下悬空 inline 条目（zcode 加载报错）——dev-link skill「约束」节要求删 worktree 前先
unlink。时序在阶段 5 之后天然成立：已发版时 unlink 恢复的正式版含本次改动；未发版则恢复
旧版（脚本黄字提示并跳过安装，维持 dev 形态由用户决定）：

```bash
cd $WS_ROOT/$WT && bash .agents/skills/dev-link/status.sh   # 只读；看目标插件行
# 输出含 "inline: ✓" 或 "✗ 悬空目录" 时（"inline: 无" 则跳过本步）：
cd $WS_ROOT/$WT && bash .agents/skills/dev-link/unlink-dev.sh <plugin>
```

**6b. 删除 worktree 与分支**：

```bash
cd $WS_ROOT && git worktree remove $WT && git branch -d $BR
```

门禁：阶段 4 exit 0（或阶段 5 发版验证 200）后才可执行。

**[MANDATORY] 6b 前收尾清零**：删除 worktree 前完成本会话所有剩余收尾操作，或明确放弃并告知用户。包括但不限于：阶段 5 发版的 tag push 与验证（处于「用户已确认、尚未执行」状态时禁止删除）、对用户承诺的「确认后执行」动作、外部引用修正。worktree 一旦删除，这些操作在本会话内再也无法执行（原因见下方 [HISTORICAL]）。

**[HISTORICAL] 删除后 bash ENOENT = 删除已成功的最强确认，不是错误；且会话 spawn 层整体瘫痪**：若 session 启动目录在 feature worktree 内，删除后不止 bash 报 cwd 不存在——子代理派发、MCP server 启动等一切依赖 shell spawn 的通道全部 ENOENT，cwd 不可切换（session 启动目录固定），会话内无自救手段。此时不要重试 bash、不要
`git worktree list` 确认——直接输出总结收尾。（脚本明确 exit 非 0 才是业务失败，按输出排查。）删除后用户追加操作（补 tag、查 CI、发版 push 等）时，正确做法是告知执行通道已死并给出可在终端手工执行的命令，而非重试或新派 subagent。

清理后外部引用安全网：若曾把插件以 inline 形态注册进 `~/.zcode/cli/config.json`
（`<path>` 指向被删 worktree），改回 main worktree 路径或删除条目，并重启 ZCode。

## AI 操作步骤

收到合并指令后立即建 todo：

| # | 阶段 | 关键命令 |
|---|------|---------|
| 1 | 前置确认（0） | `gh pr view` state=OPEN |
| 2 | 本地终验（1） | 测试 + check-sync + check-pack |
| 3 | PR 合并（2） | `gh pr merge --merge --delete-branch` |
| 4 | main 同步（3） | `merge --ff-only origin/main` |
| 5 | post-merge CI（4） | `gh run watch --exit-status` |
| 6 | 发版决策（5，默认跳过） | `scripts/release.js` + tag |
| 7 | dev-link 恢复 + 清理 worktree（6，终结） | status.sh 检测 → unlink-dev.sh → 删除后直接总结收尾 |

## 项目特化

- **验证口径**：`node --test`（排除 e2e）+ check-sync + check-pack——零依赖仓无
  typecheck/lint，语法门禁由 pre-commit hook（node --check）承接
- **发布模式**：tag 直发 `<plugin>@<semver>`（非 changesets）；发版与合并解耦，见 AGENTS.md「npm 发布规范」
- **合入同步项**：marketplace.json 条目 + 根 README 插件表（阶段 1 核对）
- **无 Electron / 无双语 release notes**（不适用本项目形态）；**有 dev-link 清理**（6a：inline 形态删 worktree 前先恢复正式版，机制见 dev-link skill）

## 失败恢复

| 失败 | 动作 |
|------|------|
| Gate-1 测试 FAIL | 按失败用例修复后从阶段 1 头部重跑 |
| Gate-1 check-sync 版本漂移 | 禁手改单一文件对齐——三处版本以将要发版的目标为准统一（发版走 release.js；不发版则以 main 版本为准回退漂移文件） |
| 6a unlink 报「未发布」 | GitHub main 的 marketplace.json 不含该插件（从未发版）——询问用户：先补发版再 unlink，或确认维持 dev 形态后手工删 inline 条目再删 worktree |
| PR CI FAIL | 看 checks 日志，修复以新 commit push 进 feature 分支，CI 绿后重走阶段 2 |
| 阶段 3 非 ff | 本地 main 有独有 commit：人工排查后决策（revert 本地或强推），禁自动 reset --hard |
| 阶段 4 post-merge CI FAIL | 新分支修复走 pr-cr-fix；main 已坏时上报用户决策 |
| 阶段 5 npm 发布 CI FAIL | 看 release-npm.yml 日志（常见：tag/版本不一致、NPM_TOKEN 失效、npm 账号未确认邮箱） |
| push 冲突 | `git fetch` 后按全局规范 merge（禁 rebase）重试 |

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 历史事故教训固化的规则（源自 xyz-agent / xyz-pi-extensions / coding-workflow 各项目同源 skill 的事故沉淀） | 不允许删除或削弱，只能补充加强 |
| `[MANDATORY]` | 流程强制要求，违反会导致流程失败 | 必须严格遵守 |
| `[OPTIONAL]` | 可按实际情况决定 | 可调整 |
