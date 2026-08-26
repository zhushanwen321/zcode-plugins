---
name: ztf-usage
description: Use when you need to use an MCP tool listed in the injected <available-custom-tools> manifest, when mcp__<server>__call_tool reports a schema/args error, or when you cannot find a tool and need to search the catalog. Covers the three-hop protocol (manifest → get_tool_details → call_tool), search_tools fallback, and pinned direct-call tools.
---

# z-tool-finder 托管 MCP 工具使用指引

被 z-tool-finder 接管的 MCP server 只暴露 meta 工具，真实工具按需加载。

## 三跳协议（标准用法）

1. **清单**：读会话注入的 `<available-custom-tools>` 清单，按每行 when-to-use 选工具（形如 `document-skills:xlsx — 读写 xlsx…`）。
2. **详情**：调 `mcp__<server>__get_tool_details(tool="left_click")`，返回完整 description、inputSchema（每参数含说明）与最小调用示例。**调 call_tool 前先做这一跳**，一次填对参数。
3. **调用**：调 `mcp__<server>__call_tool(tool="left_click", args={...})` 执行。

## 找不到工具

清单外或记不清名字：调 `mcp__plugin_z-tool-finder_z-tool-finder__search_tools(query="关键词", limit?)` 全局检索 catalog（关键词 + BM25），跨所有被接管 server。

## call_tool 报错解读与恢复

| 报错 | 含义 | 恢复动作 |
|------|------|----------|
| `args.x: expected string, got number（schema: …）` | 参数校验失败 | 重新调 `get_tool_details` 看对应参数段，修正 args |
| `failed to start underlying server: <command>，stderr 摘要：…` | 底层 server 启动失败 | 提示用户跑 `node <插件>/bin/tf.js doctor <server>` 诊断或 `restore <server>` 还原 |
| get_tool_details 未命中 | catalog 过期 | wrapper 会自动实时 tools/list 兜底并回写；按返回内容重试 |

## pinned 工具

registry 中 `pinned` 的工具不走三跳——原工具名（`mcp__server__tool`）仍直接可调。
