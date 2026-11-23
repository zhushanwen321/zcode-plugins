# gen-metrics

在 ZCode 输入框状态插槽（composer.status，工具栏、上下文用量圆环左侧）显示
主轮生成指标：

- **token 速度**（tok/s）：服务端 usage 折算的准确值，`输出 token 数 × 1000 ÷
  （总耗时 − 首 token 延迟）`
- **首 token 延迟**（TTFT）：请求发出（含并发排队）到首个有内容输出的耗时

## 设计口径

- 只显示**请求结束的准确值**；流式期间的字符估算不上屏，插槽保持上一次请求
  的准确值（2026-11-23 裁决，与上游官方示例插件 context-inspector 一致——
  避免估算值跳变误导）。
- 按会话作用域独立显示；会话没有完成过主轮请求时不显示。
- 数据源是宿主 `models.onDidGenerate` 能力（GenerationMetrics 事件），引擎每次
  主轮请求完成推送；本插件零采集、零落盘。
- 点击插槽把最近一次指标详情写进日志（`~/.zcode/v2/logs/<日期>.log`，搜
  `gen-metrics:`）。

## 安装（本地 dirs 加载，不走 marketplace/npm）

1. `~/.zcode/cli/config.json` 的 `plugins.dirs` 数组加本目录绝对路径：
   `<workspace>/main/gen-metrics`
2. 命令中心执行「重新加载扩展」（`reloadExtensions`）；不生效则重启 ZCode。

升级零维护：插件只依赖官方扩展 API（`engines.zcode: ^1.4.0`，能力版本兼容由
宿主管理），ZCode 升级不需要任何重装动作。目录无 package.json（`.mjs` 入口
天然 ESM），check-sync 按「无 package.json 的目录」自动跳过，不进
marketplace/npm 发布链。

## 测试

```bash
node --test gen-metrics/test/smoke.test.mjs
```

mock 宿主 ctx 验证：final-only 门控、会话作用域、格式化（整数/一位小数、
ms/s 双档）、中英文案、超长截断。
