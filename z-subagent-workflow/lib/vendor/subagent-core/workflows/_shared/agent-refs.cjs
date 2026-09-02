// workflows/_shared/agent-refs.cjs
//
// 编排 workflow 共用的 agentRef 参数解析（S4 路径统一）。
//
// agentRef = .md 绝对路径（注入段 <available_subagents> 的 <location>）。
// agents 参数 = 逗号分隔的 agentRef 列表，按阶段顺序一一映射。
// 缺省（未传/空）= 不指定 agent（默认执行者）——编排骨架不强制指定执行者。
//
// 注意：本模块只做「字符串 → 路径数组」的纯解析，不读文件。agent 内容的加载
// 由主线程 resolveAgentOpts（agent-call 时按路径读 + systemPrompt 注入）统一完成。
"use strict";

/**
 * 解析 agents 参数为 agentRef 路径数组。
 *
 * @param raw 逗号分隔字符串（如 "/a/x.md,/b/y.md"）；undefined/null/空 → []
 * @returns 路径数组（trim + 去空项）
 */
function parseAgentRefs(raw) {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "string") return [];
  const refs = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return refs;
}

/**
 * 按阶段索引取 agentRef（缺省 undefined = 不指定 agent）。
 *
 * @param refs   parseAgentRefs 结果
 * @param index  阶段索引（0-based）
 * @returns agentRef 或 undefined
 */
function agentRefAt(refs, index) {
  return refs.length > index ? refs[index] : undefined;
}

module.exports = { parseAgentRefs, agentRefAt };
