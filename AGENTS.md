# zcode-plugin-workspace AGENTS.md

zcode 桌面端插件工作区（bare repo + worktree 模式）。**main 分支聚合所有插件，整体作为一个
marketplace 分发**（根目录 `marketplace.json` 是权威清单）；每个插件在独立 feature worktree
开发。能力边界与设计动机见 [docs/research/zcode-vs-pi-extension-capabilities.md](docs/research/zcode-vs-pi-extension-capabilities.md)。

## 目录结构

| 路径 | 职责 |
|------|------|
| `marketplace.json` | marketplace 清单，合入 main 时登记插件条目 |
| `<plugin>/` | 每插件一个顶层目录（`z-` 前缀 kebab-case），含 `.zcode-plugin/plugin.json` + 根 `.mcp.json` + `package.json`（npm 发布清单）+ `skills/` + `bin/` + `lib/` + `dist/` + `test/` |
| `gen-metrics/` | 本地扩展插件（**不在 marketplace/npm 发布链**）：经 `~/.zcode/cli/config.json` 的 `plugins.dirs` 指向本目录加载，走 zcode 扩展宿主（plugin.json `extension` 键 + `slots` 键），在输入框状态插槽显示生成指标。目录无 package.json（`.mjs` 入口天然 ESM），check-sync 自动跳过 |
| `patch-zcode-app/` | ZCode.app 本地补丁统一工具（顶层子项目：补丁定义 `patches/` + zsem 模块 + 测试），见「zcode 桌面端 patch 体系」节 |
| `scripts/` | 发布链工具：`check-sync.js`（版本/包名一致性）、`check-pack.js`（npm 包内容）、`check-release-needed.js`（改动-发版关联）、`release.js`（发版入口）、`vendor-subagent-core.js` + `check-vendor-manifest.js`（vendored 核心包刷新与校验）、`zcode-auto-allow.mjs`（用户级自动放行 hook，symlink 安装到 `~/.agents/scripts/`，供 `~/.zcode/cli/config.json` hooks 引用；`AskUserQuestion` 在排除清单不走自动放行） |
| `.githooks/` | git hooks 源（`pre-commit` + `install-hooks.sh`）；`.bare/hooks/post-checkout` 在 worktree add / checkout 时自动安装到 worktree gitdir，切分支即随分支刷新 |
| `.github/workflows/` | CI（`ci.yml`：单测+一致性+包内容）与 npm 发布（`release-npm.yml`：tag 触发） |
| `docs/standards.md` | 项目开发规范（技术栈/代码/测试/git） |
| `docs/extensions/` | 插件开发文档体系：development-guide（指南）· extension-conventions（强约束）· local-dev-guide（注册调试）· logging-conventions（日志）· glossary（术语） |
| `docs/research/` | 调研文档（zcode vs pi extension 能力对标） |

## 架构边界（改插件代码前必读）

1. **zcode 程序化能力三条路**（4.0.0 核实，扩展宿主为新增第三条）：**MCP server 外挂进程**（stdio，
   根 `.mcp.json` 注册，`${ZCODE_PLUGIN_ROOT}` 定位自身）、**hooks**（shell 命令，仅 7 个事件）、
   **扩展宿主 extension API**（plugin.json `extension` 键声明 JS 入口，`activate(ctx)` 跑在宿主
   utilityProcess；能力含 `composer.status` 等五插槽、`models.onDidGenerate` 生成指标事件、
   `context`/`env`/`workbench`/`settings` 订阅；版本兼容由 `engines.zcode` 对照宿主
   EXTENSION_API_VERSION 管理，4.0.0 为 1.4.0）。参照实装：`gen-metrics/`。
2. **marketplace 安装 = 完整副本**进 `~/.zcode/cli/plugins/cache/`，inline 开发 = 直接从工作区路径
   加载。因此插件**运行时禁止引用插件根之外的任何路径**（manifest 组件路径逃逸插件根直接判 invalid；
   共享代码在构建期复制/内联进各插件）。CLI 直跑入口（`bin/`）与 skill 内脚本同理须自包含。
3. **引擎 agent .md 发现只认 `.zcode/agents` 双根（项目级 + 用户级 `~/.zcode/agents/`）且扫描跳过
   symlink**——软链形态一律不可见，只能放真实文件副本（z-subagent-workflow 的四根 resolver 即为补此缺口）。
4. **zcode CLI 无公开契约**：`--allowed-tools` 拒收（只有 denylist `--disallowed-tools`）；
   `--settings` / `--max-turns` 在 help 中存在但解析器拒收（help 漂移）。升级 zcode 后先跑冒烟
   探针再改代码（探针命令见 local-dev-guide）。
5. **GUI 只在启动时扫描插件配置**：改 `config.json` 或插件文件后必须重启 ZCode 才生效。

## 常用命令

```bash
# workspace 根（cwd = 仓库 worktree 根）
node scripts/check-sync.js                        # 版本三件套/包名/零依赖一致性检查
node scripts/check-pack.js                        # npm 包内容完整性（files 白名单漏文件拦截）
node scripts/check-release-needed.js              # 改动-发版关联：列出改了但版本未 bump 的插件
node scripts/release.js <plugin> <patch|minor|major>   # 发版：bump 三处版本 + commit + tag（不 push）

# 插件目录内（cwd = <plugin>/）
node --test                                      # 全量测试（node 内置 test runner，禁 node:test 之外框架引入需评估；须用无参形态——Node v24 下 `node --test test/` 会把 test/ 当模块解析报 MODULE_NOT_FOUND）
node bin/<cli>.js <cmd> --task "..." --workdir /tmp/xxx   # CLI 直跑（不经 MCP）

# MCP server 冒烟（握手 + 工具列表）
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | node dist/mcp/server.js

# 注册/验证（改 ~/.zcode/cli/config.json 后重启 ZCode）
zcode plugins list                               # 应见 <name>@inline [enabled]
```

真机 e2e（真实无头 zcode + 真实模型，注意 token 消耗）按各插件 `test/e2e.test.js` 与 README 验收手册执行。

## 开发红线

- **零依赖 plain Node CJS 优先**：插件 package.json 仅作 npm 发布清单（name/version/files/bin），
  **不得声明 dependencies**（check-sync 强制）。引入依赖需评估对「inline 加载 + marketplace 副本 +
  无构建链安装」三种形态的影响，见 docs/standards.md。

  例外（构建期 vendored 核心包副本）：允许以 `z-subagent-workflow/lib/vendor/subagent-core/`
  目录形态消费 `@zhushanwen/subagent-core`——由 `scripts/vendor-subagent-core.js` 构建期刷新
  （产物入 git，VENDOR-MANIFEST.json 溯源 + 逐文件 sha256 自检），运行时统一经插件内
  `lib/core-ref.js` 单一解析点访问。运行时仍然禁止解析 node_modules；package.json
  不得声明 dependencies 的红线不变。流程与升级路径见 docs/standards.md「vendored 核心包消费」节。
  **zcode 引擎语义（core 0.5.0 起，2026-09 拍板）**：只走 app-server RPC（无 CLI spawn
  降级链，协议漂移直接报错）；共享宿主 HOME（不覆写 HOME，会话写真实
  `~/.zcode/cli/db/db.sqlite`，与 GUI 共写——WAL 并发安全）；凭据供数 = fs 拦截
  wrapper（appserver-launcher 拦 cli/config.json 读取注入 v2 provider）；无 HOME
  池/pidfile；poolKey 恒 `'shared'`。详规见 standards.md「zcode 引擎单一
  app-server 形态」节。
- 插件 manifest 必需字段仅 `name`（`^[a-z0-9][a-z0-9._-]{0,127}$`）；`agents` 字段当前「记录不执行」。
  字段规范见 development-guide。
- MCP server 的 **stdout 是 JSON-RPC 通道**：人读日志/进度一律走 stderr 并落盘
  `~/.zcode/<plugin>/`（规范见 logging-conventions.md）。
- 嵌套调用防护：被插件 spawn 的无头 zcode 子进程必须带嵌套标记 env（如 `ZSW_NESTED=1`，
  `DWF_NESTED=1`），嵌套环境下 MCP server 不注册工具，防递归编排。
- 同名遮蔽：插件 skills/commands 在发现顺序中优先级最低（用户级/工作区级同名资源会遮蔽插件资源），
  命名带插件前缀，降低命名冲突。

## zcode 桌面端 patch 体系（patch-zcode-app）

对 ZCode.app（Electron 桌面版）的一切本地补丁，统一收编在
`patch-zcode-app/`（`patches/` 目录即补丁清单），**禁止在工具之外手工改
app 内文件**——散落修改无基线、无升级覆盖、不可回滚。

```bash
node patch-zcode-app/patch-zcode-app.js status    # 基线与各补丁状态（只读）
node patch-zcode-app/patch-zcode-app.js apply     # 应用全部补丁（幂等，可重跑）
node patch-zcode-app/patch-zcode-app.js restore   # 回滚为 pristine 基线
node patch-zcode-app/patch-zcode-app.js install   # 安装 zsem symlink（幂等）
node patch-zcode-app/patch-zcode-app.js autopatch-install   # 装升级自动重打（LaunchAgent + TCC 载体）
```

### autopatch：升级自动重打（三条铁律，新增补丁必须全部满足）

ZCode 自动升级覆盖 app 后，**LaunchAgent `dev.zsw.zcode-autopatch` 自动触发
`autopatch` 子命令重打全部补丁**，无需人工跑 apply。三条铁律（2026-11-21 用户裁决）：

1. **统一入口**：所有 patch 从 autopatch 一个入口走——新补丁只需加 `patches/`
   定义（含进 PATCH_ORDER），自动纳入升级重打与 6 小时周期兜底；**禁止为新补丁
   另起独立的 LaunchAgent/自愈脚本**（历史上 `dev.zsw.zcode-patch-mode-yolo`
   的 python 字节级直改路径已退役，双路径并发会互踩）。
2. **patch 逻辑隔离**：单补丁定位/变换失败只影响自己（`buildPlan`/
   `applyLoosePatches` 逐补丁收集 `failed`，不中断其他补丁）；升级后个别锚点
   漂移不连坐其余补丁。部分失败 → autopatch 退避重试（10s/60s 三轮）→ 仍失败
   记日志等人工；系统性冲突（版本不一致且有痕迹、EPERM）不重试直接记日志。
3. **patch 失败不影响 zcode 启动**：三重保障——写入 stage+原子 rename（失败时
   在线文件不动，zcode 以原版启动）；autopatch 是 launchd 独立进程，与 zcode
   启动链零耦合；运行时类补丁（zsem）自身 fail-open。

**鲁棒性机制**：升级器写包中途不盲打（版本+目标文件 size 签名连续两次一致才动
手）；WatchPaths 覆盖 `app.asar` / `glm/zcode.cjs` / `Info.plist` 三路径 +
`StartInterval` 6 小时兜底 + `RunAtLoad` 登录自检；日志
`~/.zcode/cli/patch-autopatch.log`。

**TCC 授权（一次性）**：macOS「应用程序管理」拦截 launchd 上下文写 /Applications
（EPERM）。载体是 `~/.zcode/cli/zcode-autopatch.app`（极简 bundle，shell 壳探测
node 后 exec autopatch）——首次安装后必须在 系统设置→隐私与安全性→应用程序管理
手动添加该 .app 一次（裸 node 二进制加不进列表）。nvm 升级换 node 路径不影响
（壳内动态探测）；autopatch-install 重跑即刷新一切。

- **当前补丁清单**（新增补丁须同步更新 `PATCH_ORDER`、`patches/` 定义、README
  补丁清单表、`test/patches.test.js`）：

| 补丁 | 行为 | 目标 |
|------|------|------|
| `yolo` | 新建会话默认权限模式 `build` → `yolo` | app.asar 内 `/out/host/index.js` |
| `quota-auto-reset` | 自动消耗距过期 24 小时内的 5 小时额度重置卡：卡距过期 <5 分钟，或 5 小时窗口剩余 <5% 时触发；周额度卡与距过期超过 24 小时的卡第一层拦截，不自动使用 | app.asar 内 `/out/renderer/assets/styles-*.js` |
| `provider-sem` | 在 LLM 请求准入唯一入口注入 trampoline，转发 zsem 外部模块做 provider 维度并发上限与排队 | asar 外裸文件 `Resources/glm/zcode.cjs` |

- **补丁定义协议**：`{ name, description, target, isApplied(content),
  transform(content, filePath) }`——只做内容变换;`target` 两类：asar 内文件
  （`pathRegex` + `contentAnchor`）与 asar 外裸文件（`looseFile`）;锚点必须唯一;
  变换幂等（`isApplied` 检测 already-applied）;定位/写入失败错误消息必须带恢复
  动作（重新逆向定位锚点 / restore）。
- **patch 只做入口原则**（provider-sem 起）：注入行不含策略，分桶/上限/排队/
  取消/fail-open 全在受控外部模块（`zsem/`，经 `install` symlink 到
  `~/.zcode/cli/zsem`）;zcode 升级只需重打入口，策略零改动。zsem 配置
  `~/.zcode/cli/zsem-config.json`（providers → limit），观测 `zsem/bin/zsem.js status`。
- **写入安全**：asar 走「区段搬移式重打包」（未改文件字节原地保留，stage 写完
  回读校验后原子 rename）;loose 文件走 stage 全量写 + fsync + 回读比对 + 原子
  rename + rename 前 mtime/size 复查（防并发覆盖）;对运行中的 ZCode 执行安全
  （rename 不动旧 inode），生效需重启。
- 测试：`node --test 'patch-zcode-app/test/*.test.js'`（合成夹具，
  不触碰真实 app）;实机 e2e 探针在 `test/e2e/`（含一次真实 LLM 调用）。

## npm 发布规范

每个插件同时是一个 npm 包，随 workspace 仓统一发布（**不用 changesets**：本项目零依赖、非
workspace 协议、单仓低频发布，tag 直发比 changesets 的 pre.json 状态机更贴合；changesets 适合
高频多包 monorepo。其 workspace 依赖闭包能力在本仓无对应形态（插件间零依赖）；「改了该发版」
检测由 check-release-needed.js 承接——xyz-agent 经验：changesets 的自动版本推算在高价值场景
反被绕开，保留价值仅在声明文件与 changelog，本项目以更轻形态覆盖）。

- **命名**：npm 包名 = `@zhushanwen/` + 插件目录名；目录名必须 `z-` 前缀（zcode 插件标识），
  如目录 `z-subagent-workflow` → 包 `@zhushanwen/z-subagent-workflow`。check-sync 强制。
- **package.json 纪律**：只作发布清单（name/version/description/license/type/bin/files/keywords/
  engines/repository/author），**无 dependencies**；`files` 白名单须含插件运行必需件
  （`.zcode-plugin/plugin.json`、`.mcp.json`、`bin/`、`lib/`、`dist/`、`skills/`），check-pack 拦截漏文件。
  license 全仓 MIT（LICENSE 在仓库根，随建仓 Initial commit 引入），插件只声明字段不复制文件。
- **版本三处同步**（同一插件的三个发布位置）：`<plugin>/package.json` ↔
  `<plugin>/.zcode-plugin/plugin.json` ↔ 根 `marketplace.json` 条目。**bump 只用
  `node scripts/release.js <plugin> <patch|minor|major>`**（一次改三处 + commit + tag），
  禁手工单改任一处（pre-commit 拦截漂移提交）。
- **发布流程**（tag 触发 GitHub Actions，本地不碰 npm 凭据）：
  1. `node scripts/release.js <plugin> <patch|minor|major>` → 自动 commit + tag `<plugin>@<version>`
  2. 确认后 `git push origin HEAD && git push origin <plugin>@<version>`
  3. `.github/workflows/release-npm.yml` 校验 tag↔版本一致 + check-sync 后
     `npm publish --access public --provenance`
- **版本 type 判定准则**（release.js 传 patch/minor/major 时的项目概念化标准；发版面由
  `node scripts/check-release-needed.js` 机械化列出——改了 files 白名单内文件但版本未 bump
  的插件即待发版）：

  | type | 准则 |
  |------|------|
  | major | MCP tool 语义/action 行为不兼容变更、CLI 参数不兼容、数据目录布局（`~/.zcode/<plugin>/`）迁移 |
  | minor | 新增 MCP tool/action/skill/CLI 子命令、能力扩展（兼容） |
  | patch | bug 修复、性能优化、内部重构、白名单内文档更新 |

- **多插件操作模式**：每插件独立 package.json + 独立版本 + 独立 tag（`release.js <plugin>` 逐个
  跑），发版节奏互不绑定；批量发版 = 循环多次 release.js（各自 tag 各自 workflow run，天然隔离）。
- **前置条件**：GitHub 仓配 `NPM_TOKEN` secret；首次发布前 scope `@zhushanwen` 的包须
  npm 账号下创建（scoped 公开包每次都要 `--access public`，workflow 已带）。
- 插件首次接 npm：目录加 package.json（字段照 z-subagent-workflow 抄）→ marketplace.json 登记
  → check-sync / check-pack 双绿即可发。

## Git 规范（bare repo worktree 模式）

- `origin` = GitHub 远端 `zhushanwen321/zcode-plugins`（2026-08 绑定；历史沿革：早期仅本地 `.bare`，
  绑定远端时以 merge `--allow-unrelated-histories` 吸收了建仓 Initial commit 带来的根 LICENSE）；
  工作区根不是 git repo（git 目录在 `.bare/`），每 worktree 一分支，分支名 `feat-zcode-<插件>-<主题>`。
- **新分支/worktree 必须用户明确授权**（全局规则 17）；merge 用 `--no-ff` 保留分支历史。
- commit 英文 conventional 风格（scope 用插件缩写，如 `feat(zsw): ...`）；完成即提交，禁留脏工作区。
- **pre-commit hook**（`.githooks/pre-commit`，秒级静态门禁，检查**暂存内容**而非工作区）：
  ① 暂存 .js `node --check` 语法校验 ② 暂存 .json `JSON.parse` 校验 ③ 版本三件套任一暂存时
  跑 `check-sync`。测试不放 pre-commit（全量含真实模型 e2e 约 3.5 分钟），归 CI 与本地验证纪律。
  hook 由 `.bare/hooks/post-checkout` 在 worktree add / checkout 时自动装到 worktree gitdir；
  手动装：`bash .githooks/install-hooks.sh`。
- 合入 main 时同步更新 `marketplace.json` 条目与 README「现有插件」表。

## 新插件脚手架

目录骨架、manifest 字段、注册流程、验收清单见 [docs/extensions/development-guide.md](docs/extensions/development-guide.md)
「新插件脚手架清单」一节；强约束（命名/版本/双 manifest/vendor 纪律）见
[docs/extensions/extension-conventions.md](docs/extensions/extension-conventions.md)。
