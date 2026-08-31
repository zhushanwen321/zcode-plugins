'use strict';
/**
 * Prompt 拼装（D7）——纯函数，无 fs / 平台依赖。
 *
 * 固定顺序：①角色设定（agent .md 正文）→ ②工具约束 → ③任务 →
 * ④MANDATORY 输出契约 → ⑤参考技能。
 * 与 pi 的差异如实标注：这里拼的是 --prompt 文本而非真 system prompt，约束权重略低，
 * 因此契约段用 MANDATORY 措辞强压 + jsonout 三级容错提取兜底（不是丢给运气）。
 *
 * 工具约束的诚实分层（MUST_FIX-3，zcode 平台 flag 决定）：
 * - denylist（disallowedTools）= 硬约束：经 lib/runner-core.js mergeDenyTools
 *   并集去重后落引擎 `--disallowed-tools` flag，平台强制拦截。此处仍在段中
 *   重申是双保险——flag 拦行为、prompt 约束意图，模型读到禁用清单可主动
 *   绕开（少触发拒绝路径）。
 * - 白名单（tools）= 软约束：zcode 无 allowlist flag（--allowed-tools 拒收），
 *   只能靠 prompt 约束——声明「只允许使用这些工具」，无平台级强制力，
 *   越权与否取决于模型遵循度。如实声明而非伪装硬约束。
 */

/**
 * @param {object} [opts]
 * @param {import('./ports').AgentProfile} [opts.agentProfile]  缺省时省略角色设定段
 * @param {string} [opts.task]                                  任务原文
 * @param {string | object} [opts.schema]                       输出契约：字符串直接嵌入；对象 JSON 序列化嵌入
 * @param {string[]} [opts.skillRefs]                           参考 skill 路径列表
 * @returns {string}
 */
function buildPrompt(opts = {}) {
  const { agentProfile, task, schema, skillRefs } = opts;
  const parts = [];

  if (agentProfile && typeof agentProfile.body === 'string' && agentProfile.body.trim() !== '') {
    const label = agentProfile.name ? `（agent: ${agentProfile.name}）` : '';
    parts.push(`## 角色设定${label}\n\n${agentProfile.body.trim()}`);
  }

  const toolLines = buildToolConstraint(agentProfile);
  if (toolLines) parts.push(toolLines);

  if (typeof task === 'string' && task.trim() !== '') {
    parts.push(`## 任务\n\n${task.trim()}`);
  }

  if (schema !== undefined && schema !== null && schema !== '') {
    const schemaText = typeof schema === 'string'
      ? schema.trim()
      : JSON.stringify(schema, null, 2);
    parts.push(
      `## MANDATORY 输出契约\n\n`
      + `你的最终回复必须只包含一个 JSON 对象，除此之外不要输出任何文字、解释或 markdown 围栏。\n`
      + `该 JSON 对象必须符合以下结构描述：\n\n${schemaText}`,
    );
  }

  if (Array.isArray(skillRefs) && skillRefs.length > 0) {
    const list = skillRefs.filter((s) => typeof s === 'string' && s.trim() !== '')
      .map((s) => `- ${s.trim()}`)
      .join('\n');
    if (list) {
      parts.push(
        `## 参考技能\n\n`
        + `以下技能文档可能对任务有帮助。按需用 read 工具读取，不要一次性全部读取：\n\n${list}`,
      );
    }
  }

  return parts.join('\n\n');
}

/** 过滤出非空字符串工具名（frontmatter 解析已规范化，这里防御直接构造的 profile）。 */
function toolList(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => t.trim());
}

/**
 * 工具约束段（MUST_FIX-3）。profile 无任一工具字段时返回 null（不拼段）。
 * 文案分层见头注：白名单声明 + denylist 重申（denylist 的硬约束在引擎
 * --disallowed-tools flag，经 runner-core mergeDenyTools 落）。
 */
function buildToolConstraint(agentProfile) {
  const allowed = agentProfile ? toolList(agentProfile.tools) : [];
  const disallowed = agentProfile ? toolList(agentProfile.disallowedTools) : [];
  if (allowed.length === 0 && disallowed.length === 0) return null;

  const lines = ['## 工具约束', ''];
  if (allowed.length > 0) {
    lines.push(`本次任务只允许使用以下工具，禁止使用名单之外的任何工具：`);
    for (const t of allowed) lines.push(`- ${t}`);
  }
  if (disallowed.length > 0) {
    if (allowed.length > 0) lines.push(''); // 两清单间空一行分隔
    lines.push(`以下工具已被明确禁用（不得调用，平台层亦会拦截）：`);
    for (const t of disallowed) lines.push(`- ${t}`);
  }
  return lines.join('\n');
}

module.exports = { buildPrompt, toolList };
