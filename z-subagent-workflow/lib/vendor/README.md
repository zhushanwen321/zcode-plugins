# lib/vendor — vendored 构建期副本（登记）

本目录是构建期 vendor 产物的落位区（产物入 git，唯一刷新入口 = 仓根
`scripts/vendor-subagent-core.js`，溯源与完整性见产物目录内 `VENDOR-MANIFEST.json`）。

## 引擎包目录（W9 登记，owner = 本仓）

subagent-core 协议化外移（xyz-agent 仓 `docs/design/subagent-engine-protocolization.md`
§3.7「npm / zsw vendor 态」）后，引擎不再是 core 内建实现，而是独立 npm 包：

| 引擎 | npm 包 | 说明 |
|------|--------|------|
| pi | `@zhushanwen/pi-subagent-cli` | pi 引擎 CLI（engine-protocol v1 over NDJSON stdio） |
| zcode | `@zhushanwen/zcode-subagent-cli` | zcode app-server 常驻引擎 CLI |

本仓（zsw）vendor 形态的接线约定：

- **目录形态**：引擎包与 `subagent-core/` 并列，落位 `lib/vendor/<engine>-subagent-cli/`
  （构建期拷入 bundle 产物 + 精简 package.json manifest；刷新脚本后续在本仓扩一步，
  当前登记先行）。
- **发现定位（zsw 无 node_modules → L2 失效）**：走设计 §3.6 D8 两条通道之一——
  ① core 相对自身定位 `<coreDir>/../<engine>-subagent-cli`（零配置，与
  `lib/core-ref.js` 同款相对解析）；② 显式注入 env `XYZ_AGENT_ENGINE_ROOTS`
  （path.delimiter 分隔绝对路径列表）。**禁止 cwd 探测**。
- **数据根**：单一 env `XYZ_AGENT_DATA_DIR`（zsw deps 映射 `engineDataDir()` →
  子进程 env；与宿主值不同则 warn + 以显式值为准）。
- **启动执行器**：standalone 形态 = PATH node；引擎 bin 入口为带 shebang 的
  `.mjs`/`.js`，Windows 下若声明 `.cmd` 须用显式 `cmd.exe /c` + 参数数组（禁
  `shell:true`）。
