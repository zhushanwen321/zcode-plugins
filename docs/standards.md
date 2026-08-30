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
  `dist/`，为 0.3.0 自包含 bundle 预留）。当前 0.2.0 主入口依赖 ajv/yaml/proper-lockfile，
  `capabilities.selfContainedIndex` 如实记录为 false——`requireCore()` 对该形态只提供
  「指向 0.3.0 bundle + `--local` 刷新命令」的可操作报错；workflow 资产（`workflows/*.js|.cjs`，
  零依赖自包含）不受影响，`workflowAssetPath` 直接可用。
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
