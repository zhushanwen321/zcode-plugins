# shared/ — 共享能力库

> 状态：**占位**（2026-08-23 建）。当前无实际共享模块——zsub 与已归档的 dynamic-workflow 均为
> 零依赖、各自 `lib/` 自包含。本文件定义提升标准与使用纪律，待第一个真实共享模块出现时生效。

## 为什么必须「构建期 vendor」而不是运行时引用

zcode marketplace 安装 = 把**单个插件目录**完整复制进
`~/.zcode/cli/plugins/cache/<marketplace>/<plugin>/<version>/`，manifest 组件路径禁止逃逸插件根。
因此 `require("../../shared/xxx")` 在安装态必然断裂——共享代码只能在**构建期**复制或内联进各
插件的 `dist/`，产物自包含。

## 提升标准

某段逻辑**第二次**在插件间出现时才提升到 `shared/`（一次性需求就地放插件 `lib/`，不加推测性
抽象）。候选判据：

1. ≥2 个插件逐字重复，且修复需双向同步（如容错 JSON 提取、并发池、无头驱动）；
2. 与单一插件无强绑定（离开任何一方仍有独立价值）；
3. 接口稳定（以被 ≥2 处消费验证过为限）。

## 目录约定（首个模块落地时启用）

```
shared/
├── README.md            # 本文件
└── <module>/            # 每模块一目录，plain Node CJS，零依赖
    ├── <module>.js
    └── <module>.test.js # node --test，随提升一并迁入
```

- 模块零 npm 依赖（与插件零依赖原则一致）；确需依赖时先在 standards.md 重新评估。
- **消费方式**：各插件构建步骤将所需模块复制进 `<plugin>/lib/vendor/<module>.js`（复制即
  fork，升级靠重新复制 + 各插件测试兜底）。长期方案（模块多到复制同步成本过高时）：抽 npm
  包 + 构建期 bundle——到那一步再建，现在不建。
- `shared/` 下的测试由各插件 vendor 后的副本间接覆盖；`shared/` 自身不单独注册为任何加载源。
