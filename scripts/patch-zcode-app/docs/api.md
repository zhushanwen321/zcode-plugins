# API 文档(交付物自身的对外接口)

## 命令

patch-zcode-app.js(新增动作与既有动作语义):

- `node patch-zcode-app.js install` — 建立 `~/.zcode/cli/zsem` → 本仓
  `scripts/patch-zcode-app/zsem` 的 symlink(幂等:已存在且指向一致则跳过)。
  只装链接不打 patch,apply 仍由显式命令触发。
- `apply / restore / status` — 语义不变;restore 扩展为同时回滚 asar 内补丁与
  asar 外裸文件补丁(zcode.cjs)。

zsem CLI:

- `node zsem/bin/zsem.js status [--log <路径>]` — 读 zsem JSONL 日志,输出各
  provider 的 grant/release 配对统计与在途数(只读,不连进程)。

## 工具

不适用:理由——zsem 无 MCP/工具面,唯一消费方是 zcode.cjs 注入行与本仓 CLI。

## 配置

`~/.zcode/cli/zsem-config.json`(注意:不在 zsem symlink 目录内,避免写进本仓):

```json
{ "providers": { "<providerId>": { "limit": 10 } } }
```

- 键 = providerId(与 Kyt 形参 `model.providerId` 一致,如
  `account:bigmodel-individual-coding-plan`);
- 缺失文件/JSON 损坏/provider 未登记 → 该 provider 不限流(admit 返回 undefined,
  走原生),并记一条 failopen 事件;
- 读取时机:每次 admit 读(mtime 缓存,改配置即时生效,无需重启)。

## 存储

- `~/.zcode/cli/zsem-log.jsonl`:观测日志,追加写(appendFileSync,单行 JSON);
  事件类型 `acquire/grant/queue/release/cancel/failopen/reject`;
  损坏行跳过(status 只解析合法行);删除文件无副作用(重新追加)。
- patch 基线:`<Resources>/glm/zcode.cjs.bak-zcode-patch-base` + 同名 `.json`
  sidecar(版本/sha256),与 asar 基线同款机制。

## 挂点

- **唯一挂点:zcode.cjs 的 Kyt(admitAttempt)函数体开头**,注入单 try 块
  trampoline:`globalThis.__ZSEM__ ??= require(<zsem>/entry.js)`;
  `await entry.admit(payload)` 返回真值即 `return`(完全替代本次原生准入),
  `undefined`/异常则走原生。职责边界:trampoline 不含任何策略;分桶、上限、
  排队、取消、日志全在 zsem/entry.js。降级行为 = fail-open(见配置节)。
- entry.js 导出 `admit(payload)`:payload 即 Kyt 形参对象(含
  `model:{providerId,modelId}`、`signal`)。返回 `{ticket: undefined, release}`
  (release 自带幂等守卫——调用方对同一 ticket 会 release 两次)或 `undefined`
  (不接管走原生)。排队时先 `await payload.onQueued?.()`,放行前
  `await payload.onAdmitted?.(排队毫秒)`(workflow actor 状态机依赖);排队中
  `signal` abort 时 reject `payload.signal.reason`(与原生取消语义对齐,见
  fact-check.md A13/A15)。
