/**
 * 注入文案与 UserPromptSubmit hook 输出渲染。
 * 文案是周期性注意力触发，不是新规则：规则本体在全局 AGENTS.md 规则 15
 * 「产物与汇报自包含」与「用语纪律」节，此处只复述要点并指向权威，避免同一规则出现两份副本各自演化。
 */
'use strict';

const REMINDER_TEXT = [
  '[reader-reminder 周期提醒] 对即将给出的回复生效（每 3 条用户消息注入一次；规则本体见全局 AGENTS.md 规则 15「产物与汇报自包含」与「用语纪律」节）：',
  '1. 回复或产出文档中，本对话尚未出现过的概念（领域术语、机制名、编号、缩写）先用一两句话交代它是什么、为什么在这里出现，再使用；编号带中文类型词与指向（写「问题登记 2（F1-13）」，不裸写编号）。',
  '2. 汇报与裁决请求按「读者只读过任务开局目标与自己最近一条消息」的标准写：首句先定位现在处于什么状态、正在做什么，不依赖会话早前的解释。',
  '3. 用语遵守全局 AGENTS.md「用语纪律」：已裁决替换表中的词按表执行；拿不准的词换平实说法。',
  '4. 已解释过的概念不重复展开，保持原有信息密度。',
].join('\n');

const EMPTY_OUTPUT = '{}';

function renderHookOutput(text) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  });
}

module.exports = { REMINDER_TEXT, EMPTY_OUTPUT, renderHookOutput };
