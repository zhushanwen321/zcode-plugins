# patch-zcode-app

ZCode 桌面版（Electron DMG）`app.asar` 的统一补丁工具：所有本地补丁集中在
`patches/` 目录管理，一条命令查状态 / 应用 / 回滚。

```bash
node scripts/patch-zcode-app/patch-zcode-app.js status          # 查看基线与各补丁状态
node scripts/patch-zcode-app/patch-zcode-app.js apply           # 应用全部补丁（幂等，可重跑）
node scripts/patch-zcode-app/patch-zcode-app.js apply --patch yolo,quota-auto-reset
node scripts/patch-zcode-app/patch-zcode-app.js restore         # 回滚为 pristine 基线
```

`--app <ZCode.app 路径>` 可指定非默认安装位置（默认 `/Applications/ZCode.app`）。
apply / restore 后**重启 ZCode 生效**；对运行中的 ZCode 执行是安全的（rename 替换
不动旧 inode，正在运行的实例继续用旧文件）。

## 补丁清单

| 补丁 | 行为 | 目标 |
|------|------|------|
| `yolo` | 新建会话默认权限模式 `build` → `yolo`（等宽替换） | 宿主 `/out/host/index.js` |
| `quota-auto-reset` | 5 小时额度重置机会距过期 <5 分钟时自动消耗该机会执行重置（方案 1：无用量阈值；周额度机会不自动用） | 渲染层 `/out/renderer/assets/styles-*.js` |

`quota-auto-reset` 的运行形态：注入后渲染层每 30 秒自查一次重置状态（后台标签页
被节流到约 1 分钟粒度，仍远快于 5 分钟窗口），命中即将过期机会就调宿主 RPC
`useCodingPlanReset`。幂等键由机会的 `expireAt` 推导（`zsw-auto-five_hour-<时间戳>`），
同一机会重试复用同键，服务端幂等去重，不会重复消耗。触发与结果都打
`[zsw-quota-auto-reset]` 前缀日志（DevTools console 可见）。

## 机制

- **基线备份**：首次 apply 在 `Contents/Resources/` 下建立 pristine 基线
  `app.asar.bak-zcode-patch-base`（+ 同名 `.json` sidecar 记录版本/来源/sha256）。
  工具接管前的旧格式手工备份（`app.asar.bak-*`）会被核验（版本一致 + 无补丁痕迹）
  后**改名收编**为统一基线。
- **重打包写入**：补丁可以是等宽替换或插入式注入。写入采用「区段搬移式重打包」：
  未改文件字节原地保留（integrity 哈希继续有效），重排受影响文件之后的偏移并
  重写 header；全部写进 stage 临时文件，回读校验（未改条目逐个核 integrity、
  改写条目逐字节比对）通过后才原子 rename 替换在线 asar，任一步失败在线文件不动。
- **幂等**：补丁变换自带 already-applied 检测（marker），重复 apply 自动跳过。
- **ZCode 升级**：升级会整体覆盖 app.asar（补丁消失、基线版本过期）。apply 时
  版本比对，发现升级且在线 asar 无补丁痕迹 → 自动采纳新 asar 为新基线再打补丁。

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

测试全部跑在合成 asar 夹具上（`test/helpers.js` 按真实磁盘布局构造微型归档），
不触碰真实 `/Applications/ZCode.app`，不发任何网络请求。
