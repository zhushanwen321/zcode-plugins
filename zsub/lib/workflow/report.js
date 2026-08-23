'use strict';

/**
 * markdown 人读报告生成器。
 * run_workflow 的 MCP 返回双段：content[0] = 本报告（GUI 里 react-markdown 渲染），
 * content[1] = ```json 围栏的完整机器数据。
 *
 * 原样移植自 dynamic-workflow/lib/report.js：require('./phases') 在
 * lib/workflow/ 同目录下解析，无需改路径。
 */

const { shortSession } = require('./phases');

function clip(text, max) {
  if (!text) return '(空)';
  return text.length <= max ? text : `${text.slice(0, max)}\n\n…(已截断，原文 ${text.length} 字符)`;
}

/**
 * @param {object} result 各 runXxx 的统一返回（含 workflow/ok/task/phases/sections 等）
 * @returns {string} markdown
 */
function buildMarkdownReport(result) {
  const lines = [];
  const ok = result.ok;

  lines.push(`# dynamic-workflow · ${result.workflow} 报告`);
  lines.push('');
  lines.push(`- **状态**: ${ok ? '✅ 成功' : `❌ 失败${result.error ? ` — ${result.error}` : ''}`}`);
  lines.push(`- **任务**: ${clip(result.task, 300)}`);
  lines.push(`- **工作目录**: \`${result.workdir}\``);
  lines.push(`- **模型**: ${result.model || '-'}`);
  lines.push(`- **总耗时**: ${((Date.parse(result.finishedAt) - Date.parse(result.startedAt)) / 1000).toFixed(1)}s · **总 tokens**: ${sumTokens(result.phases)} · **阶段数**: ${result.phases.length}`);

  // 工作流自定义附加段（审查轮次、items 明细等）
  for (const s of result.sections || []) {
    lines.push('', `## ${s.title}`, '', clip(s.body, s.maxChars || 4000));
  }

  lines.push('', '## 阶段明细', '', '| # | 阶段 | 说明 | 状态 | 耗时 | tokens | session |', '|---|------|------|------|------|--------|---------|');
  result.phases.forEach((p, i) => {
    const status = p.ok ? '✅' : `❌${p.timedOut ? '(超时)' : ''}`;
    lines.push(`| ${i + 1} | ${p.phase} | ${escapeCell(clip(p.label, 60))} | ${status} | ${(p.durationMs / 1000).toFixed(1)}s | ${p.usage?.totalTokens ?? '-'} | ${shortSession(p.sessionId)} |`);
  });

  if (result.final) {
    lines.push('', '## 最终结论', '', clip(result.final, 4000));
  }
  if (!ok && result.error) {
    lines.push('', '## 失败原因', '', result.error);
  }
  lines.push('');
  return lines.join('\n');
}

/** MCP content 双段打包：人读 markdown + 机器 JSON（围栏保护，防 markdown 渲染器吞换行）。 */
function buildContentBlocks(result) {
  return [
    { type: 'text', text: buildMarkdownReport(result) },
    { type: 'text', text: '```json\n' + JSON.stringify(result, null, 2) + '\n```' },
  ];
}

function sumTokens(phases) {
  return (phases || []).reduce((acc, p) => acc + (p.usage?.totalTokens || 0), 0);
}

function escapeCell(s) { return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

module.exports = { buildMarkdownReport, buildContentBlocks };
