/**
 * lib/inject.js — SessionStart hook 注入清单的渲染。
 * 只读本地 catalog / registry（毫秒级），满足 hook 15s 预算（DESIGN.md D2/D7、§7 预扫描预算）。
 */
'use strict';

// 工具总数超过此阈值时按 server 折叠，防清单 token 失控（§7 截断策略）
const FOLD_THRESHOLD = 300;

/**
 * serverKey → 引擎工具命名空间：plugin:<p>:<s> → plugin_<p>_<s>；user 级裸名
 * （M0 探针实证，DESIGN.md §「关键实证」：引擎对插件级 server 的工具名是
 * `mcp__plugin_<plugin>_<server>__<tool>`）。server.js 与本文件的指引必须同源，
 * 统一从这一份实现取。
 */
function engineServerName(serverKey) {
  if (serverKey.startsWith('plugin:')) {
    const parts = serverKey.split(':'); // ['plugin', p, s]
    if (parts.length === 3) return 'plugin_' + parts[1] + '_' + parts[2];
  }
  return serverKey;
}

// 自身主 server 的检索工具全名（插件级源，非裸名 z-tool-finder）
const SEARCH_TOOLS_NAME =
  'mcp__' + engineServerName('plugin:z-tool-finder:z-tool-finder') + '__search_tools';

const FOOTER_LINES = [
  '- 先调对应 server 的 get_tool_details 获取完整用法，再调 call_tool 执行',
  `- 清单外需求可用 ${SEARCH_TOOLS_NAME} 检索`,
];

// pinned 只影响清单渲染（标注高频优先选用），server 仍被接管、调用仍走 call_tool——
// 措辞不能暗示「原生工具直调」，否则模型会去调不存在的 mcp__server__tool 名（契约漂移）
const PINNED_NOTE = '(pinned, 高频推荐)';

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

module.exports = { renderManifest, renderHookOutput, engineServerName, SEARCH_TOOLS_NAME, FOLD_THRESHOLD };
