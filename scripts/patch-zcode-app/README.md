# patch-zcode-app

ZCode 桌面版（Electron DMG）`app.asar` 的统一补丁工具：所有本地补丁集中在
`patches/` 目录管理，一条命令查状态 / 应用 / 回滚。

```bash
node scripts/patch-zcode-app/patch-zcode-app.js status          # 查看基线与各补丁状态
node scripts/patch-zcode-app/patch-zcode-app.js apply           # 应用全部补丁（幂等，可重跑）
node scripts/patch-zcode-app/patch-zcode-app.js apply --patch yolo,quota-auto-reset
node scripts/patch-zcode-app/patch-zcode-app.js restore         # 回滚为 pristine 基线
node scripts/patch-zcode-app/patch-zcode-app.js install         # 安装 zsem 外部模块 symlink（幂等）
```

`--app <ZCode.app 路径>` 可指定非默认安装位置（默认 `/Applications/ZCode.app`）。
apply / restore 后**重启 ZCode 生效**；对运行中的 ZCode 执行是安全的（rename 替换
不动旧 inode，正在运行的实例继续用旧文件）。

## 补丁清单

| 补丁 | 行为 | 目标 |
|------|------|------|
| `yolo` | 新建会话默认权限模式 `build` → `yolo`（等宽替换） | 宿主 `/out/host/index.js` |
| `quota-auto-reset` | 5 小时额度重置机会距过期 <5 分钟时自动消耗该机会执行重置（方案 1：无用量阈值；周额度机会不自动用） | 渲染层 `/out/renderer/assets/styles-*.js` |
| `provider-sem` | LLM 请求准入唯一收口（admitAttempt）注入一行 trampoline，转发到外部 zsem 模块做 provider 维度并发上限与排队（上限/策略由 `~/.zcode/cli/zsem-config.json` 配置） | asar 外裸文件 `Resources/glm/zcode.cjs` |

`quota-auto-reset` 的运行形态：注入后渲染层每 30 秒自查一次重置状态（后台标签页
被节流到约 1 分钟粒度，仍远快于 5 分钟窗口），命中即将过期机会就调宿主 RPC
`useCodingPlanReset`。幂等键由机会的 `expireAt` 推导（`zsw-auto-five_hour-<时间戳>`），
同一机会重试复用同键，服务端幂等去重，不会重复消耗。触发与结果都打
`[zsw-quota-auto-reset]` 前缀日志（DevTools console 可见）。

## provider-sem 与 zsem 外部模块

patch 只做入口（单 try 块 trampoline），分桶、上限、FIFO 排队、abort 取消、
fail-open 全部在 `zsem/` 模块（本仓受控代码）——zcode 升级只需重跑 apply 重新
注入入口，策略零改动。使用链路：

1. `node patch-zcode-app.js install`（`~/.zcode/cli/zsem` → 本仓 `zsem/` symlink）
2. 写 `~/.zcode/cli/zsem-config.json`：`{"providers": {"<providerId>": {"limit": 10}}}`
   （providerId 见 `~/.zcode/v2/config.json`；未列出的 provider 不限流）
3. `node patch-zcode-app.js apply`（含 provider-sem）并重启 ZCode
4. 观测：`node zsem/bin/zsem.js status`（读 `~/.zcode/cli/zsem-log.jsonl` 的
   grant/release 配对统计）；日志为追加式 JSONL，可随时删除重建

zsem 故障语义 = fail-open：模块缺失/配置损坏/内部异常时注入行吞掉异常走原生
准入（限流失效，会话不受影响）。局限：信号量是 zcode 进程内状态，多个 ZCode
窗口并行时各自限流（总量可达 窗口数×N）。

## 机制

- **两类补丁目标**：asar 内文件（`target.pathRegex` + `contentAnchor`）与 asar
  外裸文件（`target.looseFile`，如 `glm/zcode.cjs`）；loose 的基线与写入见下。
- **基线备份**：首次 apply 建立 pristine 基线
  `app.asar.bak-zcode-patch-base`（+ 同名 `.json` sidecar 记录版本/来源/sha256）；
  loose 目标为 `<文件名>.bak-zcode-patch-base` 同款机制。工具接管前的旧格式手工
  备份（`app.asar.bak-*`）会被核验（版本一致 + 无补丁痕迹）后**改名收编**。
- **写入**：补丁可以是等宽替换或插入式注入。asar 走「区段搬移式重打包」（未改
  文件字节原地保留、stage 回读校验后原子 rename）；loose 走 stage 全量写 +
  回读逐字节比对 + 原子 rename。任一步失败在线文件不动。
- **幂等**：补丁变换自带 already-applied 检测（marker），重复 apply 自动跳过。
- **崩溃残留**：apply/restore 中途被强杀可能残留 `.zcode.cjs.patch-stage-<pid>`
  等隐藏 stage 文件——不影响后续 apply/status/restore（不读不删），属已知取舍；
  确认无 apply 在跑时可手工删除。
- **ZCode 升级**：升级整体覆盖 app 文件（补丁消失、基线版本过期）。apply 时
  版本比对，发现升级且在线文件无补丁痕迹 → 自动采纳为新基线再打补丁（asar 与
  loose 两类同款）。

## 排障

- **`未定位到补丁目标文件` / `锚点命中 N 处`**：ZCode 升级后打包产物变了
  （Vite 文件名哈希、压缩变量名都会漂移）。恢复动作：重新逆向定位新 bundle 的
  目标文件与锚点，更新对应补丁定义的 `target.contentAnchor` / 正则。
- **apply 行为不符合预期**：`PATCH_DEBUG=1` 重跑可看堆栈与区段拷贝细节。
- **补丁后 ZCode 启动异常**：`restore` 回滚基线；若提示基线版本与在线版本不一致，
  说明升级后混用了旧基线，加 `--force` 前先确认。
- **完整性自检**：`status` 输出每个补丁目标的「与 pristine 哈希一致/不一致」；
  不一致 = 该文件被补丁或人工改过（当前 Electron 不校验 per-file integrity，
  补丁可正常运行；若未来版本开启校验导致启动异常，restore 即可恢复）。

## 测试

```bash
node --test 'scripts/patch-zcode-app/test/*.test.js'
```

测试全部跑在合成夹具上（`test/helpers.js` 按真实磁盘布局构造微型归档与 mini app，
含 `glm/zcode.cjs` loose 目标），不触碰真实 `/Applications/ZCode.app`。
`test/e2e/` 下为实机探针（真实 app 的 apply/smoke/升级重打/真实 LLM 链路，
见 `docs/acceptance.md`）。
