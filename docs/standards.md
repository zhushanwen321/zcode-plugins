# 项目开发规范

> 本仓 zcode 插件的项目级规范。强约束（命名/manifest/注册流程）在
> [extensions/extension-conventions.md](extensions/extension-conventions.md)，本文管技术栈、代码、测试与 git。

## 技术栈约束

- **plain Node CJS，零 npm 依赖优先**。现有插件（zsub、dynamic-workflow）均无 package.json，
  inline 加载与 marketplace 副本两种形态下都零安装成本。引入依赖前必须评估：①marketplace 副本
  是否含 node_modules（不含 → 依赖须 bundle 进 dist）；②是否破坏「无构建链安装」。确需引入时
  package.json 必须声明 `packageManager` 字段（全局 lock 纪律）。
- **源码 `lib/`（CJS .js）+ 打包入口 `dist/mcp/server.js` + CLI 薄壳 `bin/`**。MCP server 是插件
  的程序化能力唯一落点（zcode 无进程内 API，见调研文档 §1）。
- Node 版本跟随本机 LTS；不使用 ESM 顶层 await（CLI 入口需 12+ 兼容写法保持简单）。
- 禁止 TypeScript 构建链（与零依赖原则冲突）；需要类型表达力时用 JSDoc 注释。

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

- bare repo + worktree 模式：`origin` = 本地 `.bare`，工作区根不是 git repo。
- 分支命名 `feat-zcode-<插件>-<主题>`；**新分支/worktree 必须用户明确授权**（全局规则）。
- commit 英文 conventional：`feat(zsub): ...` / `fix(zsub): ...` / `docs: ...`。
- merge 回 main 用 `--no-ff`；合入时同步 `marketplace.json` 条目与 README 插件表。
- 完成即提交：改完验证通过后必须 commit，禁留脏工作区；pre-commit 检出问题全部正面修复，
  禁 `--no-verify` / `SKIP_*`。
- 归档语义：插件废弃时不删目录（历史归档），在 README 标注状态与迁移去向（dynamic-workflow
  → zsub 即先例）。

## 版本与发布

- 插件版本从 `0.1.0` 起，语义化；manifest `version` 与 marketplace.json 条目同步更新。
- 当前分发形态 = 本地 marketplace（目录源）+ inline 注册；远端发布（git/zip 源）待需要时再建，
  不提前建设。
