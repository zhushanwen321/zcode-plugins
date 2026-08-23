# 插件强约束约定（extension-conventions）

> 违反即返工的红线清单。开发流程见 [development-guide.md](development-guide.md)。
> 结构对标 xyz-agent 的 extension-conventions.md，内容按 zcode 实际形态重写。

## 命名

1. 插件目录名 = manifest `name` = marketplace 条目 `name`，kebab-case，匹配
   `^[a-z0-9][a-z0-9._-]{0,127}$`。
2. skill 名带插件前缀（`zsub-orchestration`，不是 `orchestration`）——插件资源在发现顺序中
   优先级最低，裸通用名极易被用户级/工作区级同名资源遮蔽且难排查。
3. MCP tool 命名少而聚合（多 action 单工具优先，见 development-guide「设计模式」）。
4. 运行时数据目录固定 `~/.zcode/<plugin>/`，与插件名一致。

## manifest 纪律

5. 双 manifest 策略：`.zcode-plugin/plugin.json` 必需；`.claude-plugin/plugin.json` 为同内容
   副本（Claude Code 兼容探测位）。两者**逐字节一致**，改必同步（长期方案：构建脚本校验一致性，
   在此之前 review 时人工核对）。
6. `version` 显式声明（缺省 0.0.0 会导致更新检测失效）；语义化版本，破坏行为变更 bump minor。
7. 禁止依赖「记录但不执行」字段（`agents` / `channels` / `lspServers` / `outputStyles` /
   `settings`）。
8. 组件路径（`skills` / `commands` / `hooks` / `mcpServers` 字段）禁绝对路径、禁逃逸插件根。

## 隔离与自包含

9. **运行时禁引插件根之外的路径**：marketplace 安装是完整副本（脱离本仓），`require`/读取相对
   上级目录（`../../shared/...`）在安装态必坏。共享代码构建期 vendor 进各插件（见
   `shared/README.md`）。
10. 插件 spawn 的无头 zcode 子进程：HOME 隔离 + 嵌套标记 env + 嵌套环境 MCP 不注册工具，三件套
    缺一不可（防污染用户配置、防递归编排）。
11. 无外部绝对路径硬编码；路径动态推导（`os.homedir()` / env）。
12. 插件产物（`dist/`、fixtures）随 git 提交——安装态无构建链，marketplace 副本拿到的就是
    完整可运行实体。

## 注册与分发

13. 本机注册唯一入口：`~/.zcode/cli/config.json` 的 `plugins.dirs` + `enabledPlugins`，改前备份、
    改后重启（流程见 [local-dev-guide.md](local-dev-guide.md)）。禁止手工向
    `~/.zcode/cli/plugins/cache/` 复制插件（cache 由 marketplace 机制管理，手工副本会被 seed
    校验/覆盖行为不确定）。
14. 合入 main 必须同步：`marketplace.json` 条目 + README「现有插件」表；插件废弃不删目录，
    README 标注归档与迁移去向。
15. 同一能力只保留一个活跃插件载体（先例：dynamic-workflow 并入 zsub 后卸载原插件，tool 更名
    `mcp__zsub__run_workflow`）。

## 变更守则

16. 改 manifest / `.mcp.json` / 注册配置后必须重启 ZCode 验证，禁凭「应该生效」宣布完成。
17. 涉及 zcode CLI / 引擎行为断言，先跑探针（命令见 local-dev-guide §4）再改码；探针结论回写
    到本文档或插件 README（注明日期与版本线索）。
18. 插件间共享逻辑第二次出现时才提升 `shared/`（规则三：不加推测性功能；一次出现就地放插件
    `lib/`）。
