# 项目开发规范

> 本仓 zcode 插件的项目级规范。强约束（命名/manifest/注册流程）在
> [extensions/extension-conventions.md](extensions/extension-conventions.md)，本文管技术栈、代码、测试与 git。

## 技术栈约束

- **plain Node CJS，零 npm 依赖优先**。插件 package.json 仅作 npm 发布清单（name/version/
  files/bin 等），**不得声明 dependencies**（`scripts/check-sync.js` 强制）。inline 加载与
  marketplace 副本两种形态下都零安装成本。引入依赖前必须评估：①marketplace 副本
  是否含 node_modules（不含 → 依赖须 bundle 进 dist）；②是否破坏「无构建链安装」。确需引入时
  package.json 必须声明 `packageManager` 字段（全局 lock 纪律）。
- **源码 `lib/`（CJS .js）+ 打包入口 `dist/mcp/server.js` + CLI 薄壳 `bin/`**。MCP server 是插件
  的程序化能力唯一落点（zcode 无进程内 API，见调研文档 §1）。
- Node 版本跟随本机 LTS；不使用 ESM 顶层 await（CLI 入口需 12+ 兼容写法保持简单）。
- 禁止 TypeScript 构建链（与零依赖原则冲突）；需要类型表达力时用 JSDoc 注释。

## vendored 核心包消费

- **动机**：插件三形态（inline 直载 / marketplace 副本 / npm 包内容）都没有 node_modules
  解析面，npm 包 `@zhushanwen/subagent-core` 只能以**构建期 vendored 副本**形态进插件目录
  （`z-subagent-workflow/lib/vendor/subagent-core/`，与 `shared/` 构建期 vendor 同一模式）；
  运行时 node_modules 解析面仍然禁止，插件 package.json 不得声明 dependencies（红线不变）。
- **流程**：workspace 根执行 `node scripts/vendor-subagent-core.js --npm <version>`（registry
  tarball 源，npm pack 带超时）或 `--local <core-checkout-path>`（本地构建源）。脚本幂等
  （先清空目标目录再拷），拷贝后逐文件 sha256 与源比对自检，并把溯源信息落盘产物目录的
  `VENDOR-MANIFEST.json`（`source` / `fetchedAt` / `capabilities` / 逐文件 `files[].sha256`）；
  vendored `package.json` 仅重写 name/version 两个字段，依赖声明绝不 vendor 进来。运行时消费
  统一走插件内 `lib/core-ref.js` 单一解析点（`workflowAssetPath` / `requireCore` /
  `vendorManifest`），禁止消费方自行拼路径。
- **升级路径**：升 registry 版本 = 换 `--npm <version>` 重跑；core 本地开发验证 = `--local`
  指向 core checkout（源存在 `dist.bundle/index.cjs` 时优先拷 bundle，统一落位 vendored
  `dist/`）。vendored 主入口为**自包含形态**（`dist.bundle` 优先落位 vendored `dist/`，
  `capabilities.selfContainedIndex=true`，无 ajv/yaml/proper-lockfile 外部依赖），
  `requireCore()` 直接可用；workflow 资产（`workflows/*.js|.cjs`，零依赖自包含）不受
  形态影响，`workflowAssetPath` 直接可用。**版本口径**：0.2.0（npm 被同号不同物占用）与
  0.3.0（本地基线、永不单独发布——2026-08-30 用户裁决）为历史形态；0.4.0 曾为首个
  registry 可用版本；**当前 vendored 基线 0.6.0**（2026-09-08 `--npm` 通道刷新；
  0.5.1 阶段变更：zcode turn 两计时器（旧固定 300s 墙钟误杀修复）+ settled 两段
  重锚 + timeout abort 链，详见插件 README「超时行为与调优」节；0.6.0 阶段：
  sync-collect v2 契约面（pi 宿主工具面，zsw CLI 形态不消费，可选字段零迁移）
  + 引擎 dispose 修复；引擎形态同 0.5.0：zcode 引擎单一 app-server + 共享宿主
  HOME）。**`--npm` 通道自 0.6.0 起恢复可用**（发版流程补跑 `build:bundle`，
  dist.bundle/ 入 tarball）；0.4.0/0.5.1 两版 tarball 缺 dist.bundle（常规档 dist
  外留 ajv/yaml/proper-lockfile 依赖，vendoring 不可消费）——若后续版本再度丢失
  dist.bundle，自包含探针会如实标 false，退回 `--local` + 源仓 `build:bundle`
  （tsup 档 2，与 `lib/core-ref.js` 刷新指引同口径）。

### zcode 引擎单一 app-server 形态（core 0.5.0 起，2026-09 用户拍板）

- **只走 app-server RPC，不走 CLI spawn**：`zcode --json --prompt` 单轮链、probe 冒烟
  门控、protocol-drift 首败降级、`XYZ_ZCODE_MODE` 钉扎全部删除；协议漂移直接报可操作
  错误（提示核对版本/重启/改用 pi 引擎）。
- **共享宿主 HOME + fs 拦截凭据供数**：引擎 spawn env 不覆写 HOME，app-server 直接
  消费宿主 `~/.zcode/`；会话写入真实 `~/.zcode/cli/db/db.sqlite`（与 GUI 共写同一
  SQLite，WAL 并发安全）。**凭据供数走 fs 拦截 wrapper**（core `appserver-launcher`）：
  spawn 的是落盘于 `engines/zcode/appserver-launcher.cjs` 的 wrapper，它 patch
  `fs.readFileSync/fsPromises.readFile` 把 `~/.zcode/cli/config.json` 精确路径的读取
  重定向为「真实文件 + v2 provider 注入」的内存合并结果——CLI 形态 app-server 只认
  该文件的 provider 字段（bundle 实测：GUI 内嵌走 modelConfig 直传，外部进程无
  env/argv/协议注入通道），wrapper 是 GUI 传参的进程外等价复刻。漂移面：zcode 升级
  改配置读取路径 → `missing baseURL` 明确报错（与协议漂移同级姿态）。
- **journal 分组**：poolKey 恒 `'shared'`（与 pi 引擎同构），journal 落
  `<ZSW_ROOT>/engines/zcode/shared/journal-*.jsonl`；旧 home-appserver*/home-provider-model
  池目录废弃（存量无害可手工清理）。
- **exec/sessionRef 契约**：`exec.kind` 恒 `'appserver'`、`pid` 恒 undefined
  （`alive()` 保留 spawn 分支仅为旧 records 兼容读取）；`sessionRef.dbPath` 为宿主
  绝对路径。
- **已接受代价**：GUI 会话列表可见 headless 会话；登录态轮换后常驻连接需引擎进程
  重启；worker 继承用户 MCP/plugins/hooks。收益：HOME 依赖副作用（pnpm store 随
  HOME 翻转等）根治。
- **与 check-sync 的关系**：check-sync 规则 4（零依赖红线，查插件 package.json 的依赖声明）
  不受本节影响——vendored 副本是构建期产物不是依赖声明；vendored `package.json` 已精简为
  name/version，不会被误读为引入依赖。

## 代码规范

1. **注释解释为什么**（约束、坑、决策理由），不复述代码在做什么。涉及逆向结论（如引擎行为）
   注明证据来源（文件路径/探针命令）。
2. **错误信息必须可操作**：指向恢复动作（具体命令/下一步），「错误 → 权威源 → 重试」闭环
   （zsub 模型路由对不可用 provider 的报错即范例：列出可用清单）。
3. **外部平台行为断言必须先验证**：声称 zcode CLI/引擎行为前先跑探针或引用书面证据，禁止靠
   推理声称（CLI help 会漂移，0.16.3 `--settings`/`--max-turns` 拒收即案例）。
4. 模块边界：编排逻辑放 manager 层，平台交互（spawn/协议解析）收敛在 runner/adapter 单点
   （「防洪堤」模式，平台版本漂移只改一处）——参照 zsub 的 ports/adapters 结构。
5. **运行时禁引插件根之外的路径**（marketplace 副本会脱离本仓）；共享代码走 `shared/` 构建期
   vendor。文件路径动态推导（`os.homedir()` 等），禁止写死绝对路径。
6. spawn 无头子进程必须带嵌套标记 env 并在嵌套环境下停注册 MCP 工具（防递归编排）。

## 日志规范

按 [extensions/logging-conventions.md](extensions/logging-conventions.md) 执行。核心：MCP server
stdout 是 JSON-RPC 通道，人读输出一律 stderr + 落盘 `~/.zcode/<plugin>/`。

## 测试规范

- **框架**：`node --test`（Node 内置），测试文件 `test/*.test.js`，从插件目录运行。不引入
  第三方测试框架（零依赖原则的推论）。
- **分层**（参照 zsub 的 13 个测试文件）：
  1. **domain 单测**（纯逻辑，无进程）：编排、解析、聚合——必须 majority。
  2. **MCP 协议测试**：对 `dist/mcp/server.js` 走 stdio JSON-RPC（initialize → tools/list →
     tools/call），可用 printf 管道冒烟。
  3. **e2e 真机**（真实无头 zcode + 真实模型）：放 `test/e2e.test.js`，**注意 token 消耗与限流**，
     不并入默认测试命令时须在 README 声明运行方式。
- **验收手册**：面向真机 GUI 的场景验收（zsub README M1-M5 表格式样）——每个面向用户的插件
  README 必须有，步骤可复现、通过标准可判定。
- 契约类断言（如 agent .md frontmatter 字段）用 fixtures 固定样本。

## Git 规范

- bare repo + worktree 模式：git 目录在 `.bare/`，`origin` = GitHub `zhushanwen321/zcode-plugins`，
  工作区根不是 git repo。
- 分支命名 `feat-zcode-<插件>-<主题>`；**新分支/worktree 必须用户明确授权**（全局规则）。
- commit 英文 conventional：`feat(zsub): ...` / `fix(zsub): ...` / `docs: ...`。
- merge 回 main 用 `--no-ff`；合入时同步 `marketplace.json` 条目与 README 插件表。
- 完成即提交：改完验证通过后必须 commit，禁留脏工作区；pre-commit 检出问题全部正面修复，
  禁 `--no-verify` / `SKIP_*`。
- 归档语义：插件废弃时不删目录（历史归档），在 README 标注状态与迁移去向（dynamic-workflow
  → zsub 即先例）。

## 版本与发布

- 插件版本从 `0.0.1` 起（首版即用户指定的起始号，2026-08-23 用户决策），语义化；**同一版本号存在于三处**（`<plugin>/package.json` ↔
  `<plugin>/.zcode-plugin/plugin.json` ↔ 根 `marketplace.json` 条目），bump 只用
  `node scripts/release.js <plugin> <patch|minor|major>`（一次改三处 + commit + tag，
  绝不手工单改——pre-commit 与 CI 均拦截漂移）。
- **npm 发布**：tag `<plugin>@<semver>` 推上远端触发 `.github/workflows/release-npm.yml`
  （校验 tag↔版本一致 + check-sync 后 `npm publish --access public --provenance`）；
  完整流程与包命名规范见根 AGENTS.md「npm 发布规范」。
- **CI**（`.github/workflows/ci.yml`，push/PR 触发）：check-sync 一致性 + 插件单测
  （排除 e2e——CI 无真实 zcode 凭据，真机 e2e 按插件 README 验收手册本地跑）+
  check-pack 包内容。
- 分发形态 = 本地 marketplace（目录源）+ inline 注册 + npm 包（`@zhushanwen/z-*`）三种。
