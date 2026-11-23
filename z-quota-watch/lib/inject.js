/**
 * 注入文案与 PreToolUse hook 输出渲染。
 * additionalContext 只复述要点并给出可直接执行的命令，等待语义的权威在
 * quota-wait 技能（模式 B 检查点），此处不做第二份副本。
 */
'use strict';

const EMPTY_OUTPUT = '{}';

function watchCommand(pluginRoot, sessionId, providerId) {
  return (
    'node ' + JSON.stringify(pluginRoot + '/bin/zqw-watch.js') +
    ' --session ' + JSON.stringify(sessionId) +
    ' --agent zcode' +
    ' --provider ' + JSON.stringify(providerId)
  );
}

function renderInjection({ modelId, providerId, sessionId, command, pluginRoot }) {
  const text = [
    '[quota-watch 守望兜底] 本会话模型为 ' + modelId + '（provider：' + providerId +
      '），检测到没有存活的 quota-wait 守望后台任务。请在方便时立即补上，起完继续手头工作：',
    '1. 用 Bash 工具（run_in_background: true）执行：',
    '   ' + command,
    '   wrapper 会先查询当前 5 小时窗口的结束时刻，然后守到该时刻 +1 分钟退出（额度提前恢复则提前退出）。退出时完成通知会回到本会话，末行 JSON（reason / nextFiveHourResetLocal）是续下一个检查点还是收工的依据（语义见 quota-wait 技能模式 B）。',
    '2. 若启动立即失败（stderr 带恢复指引），按指引处理并汇报用户，不要反复重试。',
    '（用户明确叫停守望时：执行 node ' + JSON.stringify(pluginRoot + '/bin/zqw.js') +
      ' suppress --session ' + JSON.stringify(sessionId) + ' 可让本检测静默 24 小时。）',
  ].join('\n');
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: text,
    },
  });
}

module.exports = { EMPTY_OUTPUT, watchCommand, renderInjection };
