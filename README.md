# zcode-plugin-workspace

ZCode 的插件与补丁合集，任何人都可以装来用。仓库里放两类东西，安装方式和维护方式
都不同：

- **插件**用 ZCode 官方提供给插件的接口起作用。装一次即可，ZCode 升级后不用处理。
- **补丁**直接改写 ZCode 桌面版（macOS）的程序文件，实现官方接口做不到的事。ZCode
  每次升级都会覆盖这些文件，补丁随之消失，需要重新打。本仓带一套升级后自动重打的
  机制，见 [ZCode 升级后补丁如何自动重打](#zcode-升级后补丁如何自动重打)。

## 现有插件

### 插件和补丁是两类东西

| 对比项 | 插件 | 补丁 |
|---|---|---|
| 怎么起作用 | 用 ZCode 官方提供给插件的接口：插件清单、hook、MCP server、扩展 API | 改写 ZCode.app 里的程序文件 |
| 代码在哪 | `z-*/`、`gen-metrics/` | `patch-zcode-app/` |
| 怎么安装 | 在 ZCode 界面里从插件市场安装，或用 `zcode plugins install` | `node patch-zcode-app/patch-zcode-app.js apply` |
| 哪些系统能用 | 见下一张表 | 只有 macOS |
| ZCode 升级后 | 不用处理 | 补丁被覆盖，要重新打 |
| 出问题时 | 插件不加载或功能报错，ZCode 本身正常 | 补丁与新版本不兼容，可能影响 ZCode 的行为或启动；`restore` 可回滚 |

### 支持的系统与依赖

「可用」指在 macOS、ZCode 4.0.0、Node.js 24 上实际运行过。「未实测」指代码里没有
针对该系统的处理，也没有人在该系统上运行过，不等于一定不能用。

| 组件 | 需要另外准备什么 | macOS | Linux | Windows |
|---|---|---|---|---|
| `z-words-reminder` | Node.js | 可用 | 未实测 | 未实测 |
| `z-tool-finder` | Node.js | 可用 | 未实测 | 未实测 |
| `gen-metrics` | 不需要另装；要求 ZCode 的扩展 API 版本为 ^1.4.0 | 可用 | 未实测 | 未实测 |
| `z-subagent-workflow` | Node.js；git；ZCode 引擎文件 `zcode.cjs` | 可用 | 未实测，需先设 `XYZ_ZCODE_CLI` | 未实测，需先设 `XYZ_ZCODE_CLI` |
| `z-quota-watch` | Node.js 22.5 或更高；`quota-wait` 技能 | 可用 | 未实测 | 不可用 |
| `zcode-auto-allow.mjs` | Node.js | 可用 | 未实测 | 未实测 |
| `patch-zcode-app`（补丁） | Node.js；macOS 版 ZCode | 可用 | 不适用 | 不适用 |

各插件的单测在 Linux 上随 CI 运行（见[目录结构与开发](#目录结构与开发)），但上表的
「未实测」指的是实际使用，不只是单测。

各项依赖的说明和安装方法：

- **Node.js**：四个 `z-` 插件、`zcode-auto-allow.mjs` 和补丁工具都是 Node.js 脚本。
  ZCode 执行 hook 时直接用系统 PATH 里的 `node`，不会把自己内置的运行时提供给
  hook，所以要自己装。最低版本 20；`z-quota-watch` 以及 `z-subagent-workflow` 的
  `doctor`、`clean` 子命令要 22.5 或更高。建议直接装 24。安装方法见下表。
- **git**：只有 `z-subagent-workflow` 的 worktree 和分支功能用到。从 GitHub 安装插件
  不需要 git。
- **ZCode 引擎文件**（`z-subagent-workflow` 用）：它靠运行 ZCode 的引擎 `zcode.cjs`
  来启动 subagent。默认路径是 macOS 版的位置
  `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`。ZCode 装在别处或用
  其他系统时，设置环境变量 `XYZ_ZCODE_CLI`，指向
  `<ZCode 安装目录>/resources/glm/zcode.cjs`。
- **`quota-wait` 技能**（`z-quota-watch` 用）：它启动的守望任务来自 `quota-wait`
  技能，默认读取 `~/.agents/skills/quota-wait/scripts/quota-wait.mjs`，可用环境变量
  `ZQW_QUOTA_WAIT_CLI` 改成别的路径。该技能在
  [zhushanwen321/zsw-skills](https://github.com/zhushanwen321/zsw-skills)，它自己的
  运行条件（例如查询额度用的凭证）见该技能的说明。
- **扩展 API 版本**（`gen-metrics` 用）：这里的版本号指 ZCode 提供给扩展的接口
  版本，不是 ZCode 的版本号。ZCode 4.0.0 的扩展 API 版本是 1.4.0，满足要求。
- **`z-quota-watch` 在 Windows 上不可用**：ZCode 在 Windows 上默认用 `cmd.exe` 执行
  hook，而 `z-quota-watch` 的 hook 命令是一段 POSIX shell 脚本。

安装 Node.js 的方法任选一种，装完在终端执行 `node -v` 确认：

| 系统 | 安装方法 |
|---|---|
| macOS | `brew install node`，或从 [nodejs.org](https://nodejs.org/) 下载安装包 |
| Linux | 用发行版的包管理器，或从 [nodejs.org](https://nodejs.org/) 下载二进制包；也可以用 [nvm](https://github.com/nvm-sh/nvm) 这类版本管理器 |
| Windows | 从 [nodejs.org](https://nodejs.org/) 下载安装包，或执行 `winget install OpenJS.NodeJS.LTS` |

### 插件

下表用到三个词：

- **hook**：ZCode 在指定事件发生时自动运行的插件脚本。常见事件有会话启动时
  （SessionStart）、用户提交消息时（UserPromptSubmit）、模型每次调用工具之前
  （PreToolUse）。
- **MCP server**：通过 MCP 协议向模型提供工具的外部程序。
- **subagent**：由主会话派发、独立执行任务的子 agent。

| 插件 | 做什么 |
|---|---|
| `z-subagent-workflow` | subagent 编排与确定性的多阶段 workflow，统一通过 `zsw` 命令行使用：subagent 生命周期管理（worktree 隔离、结构化输出、模型路由）；内置 workflow（chain、parallel、map-reduce、scatter-gather、review-fix-loop）；自定义 workflow 脚本。每个任务是一次性的本地进程，没有常驻后台服务 |
| `z-tool-finder` | MCP 工具按需加载。接管每个 MCP server 后，模型常驻可见的只有两个入口工具：查工具详情（`get_tool_details`）和调用工具（`call_tool`），工具的完整定义用到时再查，不再全部放进模型上下文。另有全局检索工具 `search_tools`。`tf restore` 一键还原 |
| `z-words-reminder` | 周期性易读性提醒。每个会话每收到 3 条用户消息，给模型注入一次提醒：本对话首次出现的概念先用一句话交代背景再使用，编号带上中文类型词，用语遵守全局词表 |
| `z-quota-watch` | 额度守望。按会话内的工具调用次数触发检测（超过 20 次触发一次并清零）：发现当前会话用 GLM 套餐模型、且没有在跑的后台守望任务时，把启动守望的命令注入给 agent。守望任务在后台等到当前 5 小时额度窗口结束，再通知会话 |
| `gen-metrics` | 在输入框状态栏显示生成指标，按会话各自显示：token 速度（tok/s）、首 token 延迟（TTFT，从发出请求到收到第一段内容的耗时）。另显示 provider-sem 补丁的供应商并发数（已用 / 上限，有排队时附排队数），多个 ZCode 进程合计 |

### 补丁

ZCode.app 的程序代码大部分打包在一个归档文件里（`Contents/Resources/app.asar`），
少数文件在归档之外（如 `Resources/glm/zcode.cjs`）。补丁改写的是这两类文件里的
内容。provider 指 ZCode 配置里的模型供应商条目。

| 补丁 | 改了什么行为 | 改哪个文件 |
|---|---|---|
| `yolo` | 新建会话的默认权限模式由 `build` 改为 `yolo`（不再逐项弹审批） | 归档内的主进程代码 `out/host/index.js` |
| `quota-auto-reset` | 自动使用快过期的 5 小时额度重置卡：卡距过期不足 5 分钟，或 5 小时额度窗口剩余不足 5% 时触发。周额度卡和距过期超过 24 小时的卡不自动使用 | 归档内的界面代码 `out/renderer/assets/styles-*.js` |
| `provider-sem` | 给模型请求的准入入口加并发上限：按 provider 分别限流并排队，上限在 `~/.zcode/cli/zsem-config.json` 配置 | 归档外的引擎文件 `Resources/glm/zcode.cjs` |

provider-sem 的限流逻辑不在补丁里，而在本仓的 `patch-zcode-app/zsem/` 模块：补丁只在
引擎文件里注入一行转发代码，并发上限、排队、取消、出错时放行（fail-open）都在 zsem。
这样 ZCode 升级后只需重新注入那一行，限流策略不用跟着改。zsem 缺失或内部出错时，
引擎照常处理请求，只是限流不生效。

补丁工具的完整说明（基线、重复执行、崩溃残留、排障）见
[patch-zcode-app/README.md](patch-zcode-app/README.md)。

### 独立脚本

`scripts/zcode-auto-allow.mjs` 是自动放行权限审批的 hook。它既不是插件也不是补丁：
不改 ZCode 的任何文件，只登记到用户级配置。它在两个事件上应答：PreToolUse（普通
工具审批，在弹窗出现前直接放行）和 PermissionRequest（覆盖 PreToolUse 放行不了的
审批类型）。需要用户先回答问题的工具（`AskUserQuestion`）在排除清单里，不会被
自动放行；静态拒绝规则、plan 模式的限制、guarded 模式下的危险命令确认也不受它影响。
安装方法见[安装独立脚本](#安装独立脚本)。

## 安装使用

### 安装插件：在 ZCode 界面里操作

macOS、Linux、Windows 的步骤相同，不需要克隆本仓库，也不需要 git。

1. 打开 ZCode 的 设置 → 插件。
2. 在「插件市场」一栏点「添加插件市场」，来源填 `zhushanwen321/zcode-plugins`。
   也可以填 Git 地址 `https://github.com/zhushanwen321/zcode-plugins.git`、清单
   文件或本地目录。非官方市场会显示风险提示，勾选确认后校验并添加。
3. 添加后，在「发现」标签页里能看到本仓库的插件，按界面提示安装。

界面文字以 ZCode 4.0.0 的中文界面为准，其他版本可能略有不同。更新时，在同一栏点
「更新插件市场」刷新列表，再更新已安装的插件。

### 安装插件：命令行

对应的命令是 `zcode plugins ...`。桌面版没有单独的 `zcode` 命令，它来自单独发行的
ZCode 命令行版。终端里执行 `zcode --version` 有输出，就直接用 `zcode`。没有的话，
可以借桌面版内置的引擎执行，效果相同。macOS 上先定义一个同名函数（已实测）：

```bash
zcode() {
  ELECTRON_RUN_AS_NODE=1 /Applications/ZCode.app/Contents/MacOS/ZCode \
    /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs "$@"
}
```

Linux 和 Windows 的写法相同：设环境变量 `ELECTRON_RUN_AS_NODE=1`，用 ZCode 主程序
运行 ZCode 安装目录下的 `resources/glm/zcode.cjs`。这两个系统未实测。

然后：

```bash
zcode plugins marketplace add zhushanwen321/zcode-plugins    # 登记插件市场
zcode plugins install z-quota-watch@zcode-plugin-workspace   # 安装插件，一条一个
zcode plugins list --available                                # 确认；--available 同时列出还没装的
```

插件市场的名字 `zcode-plugin-workspace` 取自本仓 `marketplace.json` 的 `name` 字段。
已经克隆了本仓库的话，`marketplace add` 也可以直接给克隆目录。

更新到最新版本：

```bash
zcode plugins marketplace update zcode-plugin-workspace    # 刷新插件市场
zcode plugins update z-quota-watch                        # 更新已安装的插件
```

插件市场登记的是本地目录时，先在该目录里 `git pull`，再执行上面两条。

### 从本地目录加载（gen-metrics 与开发调试）

这种方式需要一份克隆，并且要放在长期保留的位置，因为登记的是目录的绝对路径：

```bash
git clone https://github.com/zhushanwen321/zcode-plugins.git
```

下文用 `<repo>` 指代克隆目录，命令都在 `<repo>` 下执行。

**gen-metrics** 不走插件市场，也不在插件市场的清单里。编辑
`~/.zcode/cli/config.json`，在 `plugins.dirs` 数组里加上 gen-metrics 目录的绝对路径
（Windows 路径里的反斜杠要写成 `\\`，或者改用正斜杠）：

```json
"plugins": {
  "dirs": ["<repo>/gen-metrics"]
}
```

然后在命令中心执行「重新加载扩展」；没生效就重启 ZCode。

**inline 直载**用于调试 `z-` 插件：把插件目录登记到 `plugins.dirs`，ZCode 直接从该
目录加载，改代码后重启即生效。下面的脚本在开发版（inline 直载）和正式版（插件市场
安装）之间切换，需要 bash：

```bash
bash .agents/skills/dev-link/link-dev.sh <plugin>     # 装开发版，同时卸载同名正式版，避免装两份
bash .agents/skills/dev-link/status.sh               # 查看安装状态与冲突
bash .agents/skills/dev-link/unlink-dev.sh <plugin>   # 卸载开发版，恢复正式版
```

### 安装独立脚本

`zcode-auto-allow.mjs` 需要一份克隆。先确认 `~/.zcode/cli/config.json` 里的
`hooks.enabled` 是 `true`（配置文件里的 hook 默认不启用），再分两步安装。

第一步，确定脚本的路径。macOS 和 Linux 可以做一个符号链接（symlink）：

```bash
mkdir -p ~/.agents/scripts
ln -s <repo>/scripts/zcode-auto-allow.mjs ~/.agents/scripts/zcode-auto-allow.mjs
```

Windows 不用做链接，直接用克隆里的路径。

第二步，在 `hooks.events` 下登记两个事件。`command` 里写 node 和脚本各自的绝对
路径：

```json
"hooks": {
  "enabled": true,
  "events": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "<node 路径> <脚本路径>", "enabled": true } ] }
    ],
    "PermissionRequest": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "<node 路径> <脚本路径>", "enabled": true } ] }
    ]
  }
}
```

hook 每次工具调用都会重新启动进程，改脚本后即时生效，不用重启 ZCode。

### 安装补丁（仅 macOS）

前提：macOS，ZCode 桌面版装在 `/Applications/ZCode.app`（装在别处用 `--app <路径>`
指定），装了 Node.js，并按上一节克隆了本仓库。

打补丁前先知道三件事：

- 它改写的是 ZCode 的程序文件，改写后应用的代码签名（code signature）校验会失败。
  实测环境（macOS、ZCode 4.0.0）打补丁后 ZCode 一直正常运行。新装的 ZCode 建议
  先启动一次再打补丁。
- 每个补丁按特定版本的程序文件定位。三个补丁目前都在 ZCode 4.0.0 上验证过，升级
  后能否自动重打见下一节。
- 基线（baseline）是第一次打补丁前保存的原始应用文件。出问题用 `restore` 恢复到
  基线。

```bash
node patch-zcode-app/patch-zcode-app.js status    # 查看当前版本、基线和每个补丁的状态
node patch-zcode-app/patch-zcode-app.js install  # 把 zsem 链接到 ~/.zcode/cli/zsem（provider-sem 要用）
node patch-zcode-app/patch-zcode-app.js apply    # 打全部补丁；可重复执行，已打过的不重打
```

要给某个 provider 限流，再写配置文件 `~/.zcode/cli/zsem-config.json`：

```json
{ "providers": { "<providerId>": { "limit": 10 } } }
```

`<providerId>` 见 `~/.zcode/v2/config.json`，没列出的 provider 不限流。

只打部分补丁用 `apply --patch yolo,quota-auto-reset`。打完**重启 ZCode** 才生效；对
运行中的 ZCode 执行这些命令是安全的。回滚用 `restore`。provider-sem 是否生效可用
`node patch-zcode-app/zsem/bin/zsem.js status` 查看。

### ZCode 升级后补丁如何自动重打

ZCode 升级会用新版本整体替换应用文件，补丁随之消失。手动做法是每次升级后重跑
`apply`。自动做法是启用补丁工具的 autopatch：它把自己注册成 LaunchAgent（macOS 的
用户级后台任务，由系统在登录、定时或指定文件变化时拉起）。

```bash
node patch-zcode-app/patch-zcode-app.js autopatch-install
```

启用后，每次升级依次发生：

1. **触发**。LaunchAgent（标签 `dev.zsw.zcode-autopatch`）监听三个文件的变化：
   `app.asar`、`glm/zcode.cjs`、`Info.plist`，任一变化就触发。另有每 6 小时一次、
   每次登录时一次的定时触发。
2. **等升级程序写完**。每 2 秒采样一次「应用版本号 + app.asar 大小 + zcode.cjs
   大小」，连续两次相同才继续；30 秒内一直不稳定就放弃本次，等下次触发。
3. **换基线**。`apply` 发现版本号变了、且文件里没有补丁痕迹，判定为升级，把新版本
   的文件保存为新基线。
4. **重新打全部补丁**。补丁逐个处理，互不影响。新增补丁只要在 `patches/` 目录加一个
   定义文件，就会自动纳入这一步。
5. **处理失败**。个别补丁失败：立即、10 秒后、60 秒后各重试一轮；三轮后仍失败就
   放弃本次，6 小时后的定时触发会再试。版本冲突、权限不足这类重试无意义的失败：
   不重试，写日志等人工处理。
6. **生效**。补丁写入后要**重启 ZCode** 才生效，自动重打不会替你重启。

有两件事要人工处理：

- **一次性授权**。macOS 的「应用程序管理」权限默认拦截后台任务写 `/Applications`
  下的应用。首次 `autopatch-install` 后，到 系统设置 → 隐私与安全性 → 应用程序管理
  里手动添加 `~/.zcode/cli/zcode-autopatch.app`。
- **锚点失效**。锚点（anchor）是补丁定义里的一小段特征文本，工具靠它在目标文件里
  找到要改的位置。新版本改写了那段代码，锚点就找不到，这个补丁每次都会失败，需要
  重新定位并更新补丁定义里的 `target.contentAnchor`。这是补丁和插件最大的差别：
  插件升级后不用管，补丁能否自动重打取决于锚点在新版本里还在不在。

查状态与排障：`node patch-zcode-app/patch-zcode-app.js status` 看每个补丁是否已打上；
自动重打的日志在 `~/.zcode/cli/patch-autopatch.log`。

### 卸载

```bash
zcode plugins uninstall z-quota-watch                         # 插件
node patch-zcode-app/patch-zcode-app.js restore               # 补丁：恢复原始文件
node patch-zcode-app/patch-zcode-app.js autopatch-uninstall   # 补丁：卸掉自动重打
```

gen-metrics：从 `~/.zcode/cli/config.json` 的 `plugins.dirs` 里删掉对应条目，重启
ZCode。`zcode-auto-allow.mjs`：从 `hooks.events` 里删掉登记的两个事件。

## 目录结构与开发

### 目录结构

```
<repo>/                              # main 分支；bare repo + worktree 形态下就是 main/ 目录
├── marketplace.json                 # 插件市场清单，登记全部 z- 插件
├── z-subagent-workflow/             # 插件
├── z-tool-finder/                   # 插件
├── z-words-reminder/                # 插件
├── z-quota-watch/                   # 插件
├── gen-metrics/                     # 本地扩展插件，不在插件市场
├── patch-zcode-app/                 # 补丁工具
│   ├── patch-zcode-app.js           # 统一入口：status / apply / restore / install / autopatch-*
│   ├── lib/asar.js                  # asar 归档读写
│   ├── patches/                     # 补丁定义，一个补丁一个文件
│   ├── zsem/                        # provider-sem 的外部模块（限流逻辑）
│   ├── test/                        # 单测与实机测试
│   └── docs/                        # 设计、接口、验收文档
├── scripts/                         # 一致性检查、发版、vendor 刷新、用户级 hook 脚本
├── .agents/skills/                  # dev-link / merge / pr-cr-fix
├── .githooks/                       # pre-commit 与安装脚本
├── .github/workflows/               # 持续集成与 npm 发布
├── docs/                            # 规范、设计、调研、插件开发文档
├── AGENTS.md                        # 开发规范
├── LICENSE                          # MIT
└── README.md
```

每个 `z-` 插件目录的结构相同：

```
<plugin>/
├── .zcode-plugin/plugin.json    # 插件清单（必需）
├── package.json                 # npm 发布清单（零依赖）
├── .mcp.json                    # MCP server 注册（带 MCP server 的插件才有）
├── hooks/hooks.json             # hook 注册（用 hook 的插件才有）
├── skills/<name>/SKILL.md       # 技能
├── bin/                         # 命令行入口
├── lib/                         # 源码
├── dist/                        # 随仓库提交的构建产物
└── test/                        # node --test 测试
```

### 脚本、skill 与持续集成

`scripts/` 下的工具：

| 脚本 | 用途 | 什么时候跑 |
|---|---|---|
| `check-sync.js` | 一致性检查：每个插件的 `package.json`、`.zcode-plugin/plugin.json`、`marketplace.json` 三处版本相同；包名为 `@zhushanwen/<目录名>`；不声明依赖 | pre-commit、CI、发版前 |
| `check-pack.js` | npm 包内容检查：打包产物里必须含运行必需的文件 | CI |
| `check-release-needed.js` | 列出「改了已发布文件但版本号没升」的插件 | 发版前 |
| `check-vendor-manifest.js` | 校验 z-subagent-workflow 内置的 subagent-core 副本与 `VENDOR-MANIFEST.json` 记录的 sha256 一致 | CI |
| `vendor-subagent-core.js` | 刷新上面那份 subagent-core 副本 | 升级 subagent-core 时 |
| `release.js` | 发版入口：一次改三处版本号，commit 并打 Git 标签（tag） | 发版 |
| `zcode-auto-allow.mjs` | 自动放行权限审批的用户级 hook，见[安装独立脚本](#安装独立脚本) | 不手动跑 |

「内置副本」指把依赖包的源码直接复制进本仓、随仓库提交（vendored）。插件运行时没有
node_modules 可用，依赖只能这样带进来。

`.agents/skills/` 下是 skill（agent 按触发词加载的操作说明）：

| skill | 做什么 |
|---|---|
| `dev-link` | 在开发版（inline 直载）与正式版（插件市场安装）之间切换，检查是否装了两份 |
| `merge` | 把 feature 分支合回 main 并收尾：确认 CI → 合并 → 同步 main → 清理 worktree |
| `pr-cr-fix` | 审查分支改动、修复问题、开 PR（发起合并请求） |

`.github/workflows/` 下是 CI（持续集成，GitHub 在每次推送后自动跑的检查），在 Linux
上运行：

- `ci.yml`：推送到 main 或 `feat-**` 分支、以及提 PR 时，跑 check-sync、各插件单测
  （不含端到端测试 e2e，它需要真实的 ZCode 和模型）、check-pack、check-vendor-manifest。
- `release-npm.yml`：推送 `z-*` 形式的标签（`<插件目录名>@<版本号>`）时发布 npm 包。

CI 只把含 `package.json` 的一级目录当作插件，所以 `patch-zcode-app` 和 `gen-metrics`
的测试不在 CI 里，要本地跑。

### 开发规范与常用命令

开发前先读 [AGENTS.md](AGENTS.md)。编码规范见 [docs/standards.md](docs/standards.md)，
插件开发流程见 [docs/extensions/development-guide.md](docs/extensions/development-guide.md)，
本地调试见 [docs/extensions/local-dev-guide.md](docs/extensions/local-dev-guide.md)。

本仓开发时用 bare repo + 多个 worktree（同一仓库的多个检出目录）：git 对象在
`.bare/`，主线检出在 `main/`，每个插件在自己的 feature worktree
（`feat-zcode-<插件>-<主题>`）里开发，合回 main 后由根目录 `marketplace.json` 登记。
普通克隆没有这一层，克隆根目录就是 main 分支的内容。

```bash
node scripts/check-sync.js                            # 提交前自查：版本、包名、零依赖
node scripts/check-release-needed.js                  # 看哪些插件改了代码但没升版本
node scripts/release.js <plugin> <patch|minor|major>  # 发版：升三处版本号 + commit + tag

node --test z-quota-watch/test/*.test.js              # 某个插件的单测
node --test 'patch-zcode-app/test/*.test.js'          # 补丁工具
node --test 'patch-zcode-app/zsem/test/*.test.js'     # zsem 模块
node --test gen-metrics/test/smoke.test.mjs           # gen-metrics
```

pre-commit 在提交前检查暂存内容：`.js` 语法、`.json` 可解析、版本三处一致。安装用
`bash .githooks/install-hooks.sh`。

新增插件按 development-guide 的「新插件脚手架清单」做，合入 main 时在
`marketplace.json` 登记条目，并更新本文件的插件表。新增补丁只在
`patch-zcode-app/patches/` 加一个定义文件，自动重打会纳入它；约束见
[patch-zcode-app/README.md](patch-zcode-app/README.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。
