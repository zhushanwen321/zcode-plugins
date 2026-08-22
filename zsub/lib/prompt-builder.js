'use strict';
/**
 * Prompt 拼装（D7）——纯函数，无 fs / 平台依赖。
 *
 * 固定顺序：①角色设定（agent .md 正文）→ ②任务 → ③MANDATORY 输出契约 → ④参考技能。
 * 与 pi 的差异如实标注：这里拼的是 --prompt 文本而非真 system prompt，约束权重略低，
 * 因此契约段用 MANDATORY 措辞强压 + jsonout 三级容错提取兜底（不是丢给运气）。
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

module.exports = { buildPrompt };
