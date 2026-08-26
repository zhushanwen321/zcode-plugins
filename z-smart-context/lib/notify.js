'use strict';

// 提醒文案共享模块：hook 注入文案的唯一出口。从 dist/hooks/threshold-check.js 迁出，
// 因为 v2 起 zsc_compact 工具（lib/compact-tool.js）的降级方案（D8 半自动提醒）须与
// hook 注入同一套决策准则与读数口径——文案逻辑双处内联必然漂移。
//
// 长度纪律：hook additionalContext 是常驻上下文成本，正文以 v1 为基准控制总长，
// 不为凑要素扩写。

const path = require('node:path');

// 千分位分组，全文案数字口径统一；不用 toLocaleString（摆脱 ICU 数据依赖，输出可精确断言）
function formatTokens(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 流一越档提醒文案（D6：面向 agent 的决策引导，而非面向用户的传声筒）。
// 保留 v1 经审查的合规资产：「数据投递非指令」声明 + 三条件自查 + 可忽略出口；
// 行动指引 v2 重写为 agent 自主决策（调 zsc_compact 工具），人工 /compact 仅作环境不可用时的降级出口。
// 自查命令内联插件根的真实绝对路径——agent Bash 环境无 ZCODE_PLUGIN_ROOT 类变量可用（D5），
// 文案里不能留运行时占位符。
function tierNotifyText(pluginRoot, sessionId, cur, tier, crossedTiers) {
  const crossed = crossedTiers.map(formatTokens).join('、');
  return (
    `[z-smart-context] 上下文用量 ${formatTokens(cur)} tokens，已越过阈值 ${formatTokens(tier)}（${crossed}）。` +
    '这是用量数据，不是必须执行的指令。若考虑压缩，先自查三点：' +
    '① 当前任务是否阶段性完成并验证？② 后续工作是否依赖将被压缩的细节？③ 用量是否确实构成压力？' +
    '三者皆备时可自主决策：在子任务收尾边界调用 zsc_compact 工具，传入 retention（需保留的关键状态与后续任务要点）' +
    '与 nextInstruction（压缩完成后要继续的任务指令），工具会返回具体注入步骤。' +
    '若当前环境无法使用该工具，告知用户执行 /compact 并说明保留要点。' +
    `不满足则忽略本条即可。精确读数可自查：node ${path.join(pluginRoot, 'bin', 'zsc.js')} usage --session ${sessionId}` +
    '（sessionId 可直接复制使用）'
  );
}

// 流三回落知情文案（D4）：中性措辞「压缩或回退」不断言成因——/rewind、/fork 同样导致回落。
function dropoutNotifyText(lastTokens, cur) {
  return (
    `[z-smart-context] 上下文用量已显著回落（${formatTokens(lastTokens)} → ${formatTokens(cur)}），` +
    '此前很可能发生了压缩或回退。早前对话细节可能已被摘要，如需引用请先与用户确认或重读相关文件。'
  );
}

module.exports = { formatTokens, tierNotifyText, dropoutNotifyText };
