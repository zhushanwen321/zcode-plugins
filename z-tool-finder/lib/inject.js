/**
 * lib/inject.js — SessionStart hook 注入清单的渲染。
 * 只读本地 catalog / registry（毫秒级），满足 hook 15s 预算（DESIGN.md D2/D7、§7 预扫描预算）。
 */
'use strict';

// 工具总数超过此阈值时按 server 折叠，防清单 token 失控（§7 截断策略）
const FOLD_THRESHOLD = 300;

const FOOTER_LINES = [
  '- 先调对应 server 的 get_tool_details 获取完整用法，再调 call_tool 执行',
  '- 清单外需求可用 mcp__z-tool-finder__search_tools 检索',
];

const PINNED_NOTE = '(pinned, 原生工具直调，未接管)';

// overrides 键形态 'server:tool' → 文本（D7：when-to-use 覆写优先于 catalog 默认值）
function resolveWhenToUse(reg, serverKey, tool) {
  const overrides = (reg && reg.overrides) || {};
  const hit = overrides[serverKey + ':' + tool.name];
  if (typeof hit === 'string' && hit.trim()) return hit;
  return tool.whenToUse || '';
}

function isPinned(reg, serverKey) {
  return Boolean(reg && reg.servers && reg.servers[serverKey] && reg.servers[serverKey].pinned);
}

/**
 * 渲染 <available-custom-tools> 清单（纯函数）。
 * - 每工具一行 `serverKey:tool — whenToUse`（overrides 优先）
 * - pinned 的 server 标注 PINNED_NOTE
 * - 工具总数 > FOLD_THRESHOLD 时按 server 折叠为一行
 * - catalog 无 server 时返回带说明的短标签（不报错——catalog 未就绪是正常态）
 */
function renderManifest({ cat, reg } = {}) {
  const servers = (cat && cat.servers) || {};
  const serverKeys = Object.keys(servers).sort();

  if (serverKeys.length === 0) {
    return (
      '<available-custom-tools>\n' +
      '（z-tool-finder catalog 尚未就绪或暂无已索引工具，工具照常可用）\n' +
      '</available-custom-tools>'
    );
  }

  const lines = [];
  let totalTools = 0;
  for (const key of serverKeys) {
    const tools = Array.isArray(servers[key].tools) ? servers[key].tools : [];
    totalTools += tools.length;
  }

  for (const key of serverKeys) {
    const tools = Array.isArray(servers[key].tools) ? servers[key].tools : [];
    const pinnedNote = isPinned(reg, key) ? ' ' + PINNED_NOTE : '';
    if (totalTools > FOLD_THRESHOLD) {
      lines.push(`- ${key} — ${tools.length} tools (search_tools 可查)${pinnedNote}`);
      continue;
    }
    for (const tool of tools) {
      if (!tool || !tool.name) continue;
      const when = resolveWhenToUse(reg, key, tool);
      lines.push(`- ${key}:${tool.name} — ${when}${pinnedNote}`);
    }
  }

  return '<available-custom-tools>\n' + lines.concat(FOOTER_LINES).join('\n') + '\n</available-custom-tools>';
}

/**
 * 渲染 SessionStart hook 的 stdout 契约（M0 探针实证格式）：
 * {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
 */
function renderHookOutput(manifestText) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: manifestText,
    },
  });
}

module.exports = { renderManifest, renderHookOutput, FOLD_THRESHOLD };
