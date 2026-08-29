#!/usr/bin/env node
'use strict';
/**
 * SessionStart hook 专用极薄入口（hooks/hooks.json 指向此处，无参数）。
 *
 * 为什么不经 bin/zsw.js：后者顶层 require assemble 全链，链上任一插件文件
 * 缺失 → 入口加载即 exit 1 → 每会话启动 raise error（D5 降级承诺违规）。
 * 本入口只 require lib/hook-source（其自身顶层零 require、函数体依赖全 try
 * 包裹），并在最外层再包一层 try 兜 hook-source 模块级损坏：任何失败都
 * 输出 {} 且自然退出（exit 0，不 process.exit——防 stdout 未 flush），绝不
 * 阻断会话启动。诊断与数据组装逻辑在 lib/hook-source.js；修改 hook 行为去
 * 那里，本文件只做入口兜底。
 */
try {
  require('../lib/hook-source').runSessionStartHook();
} catch (e) {
  // hook-source 加载/执行本身的意外抛出（正常降级路径在其内部已消化）：
  // stdout 是协议通道，必须给引擎一个合法帧；诊断尽力写 stderr
  try { process.stdout.write('{}\n'); } catch { /* stdout 不可写则无从协议 */ }
  try { process.stderr.write(`[zsw:hook] entry failure: ${e && e.message || e}\n`); } catch { /* 尽力 */ }
}
