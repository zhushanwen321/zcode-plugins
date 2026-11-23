'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { renderInjection, watchCommand } = require('../lib/inject');

test('renderInjection：PreToolUse additionalContext 形态与可执行命令', () => {
  const command = watchCommand('/fake/plugin-root', 'sess_a', 'account:bigmodel-individual-coding-plan');
  assert.strictEqual(
    command,
    'node "/fake/plugin-root/bin/zqw-watch.js" --session "sess_a" --agent zcode --provider "account:bigmodel-individual-coding-plan"',
  );
  const out = JSON.parse(renderInjection({
    modelId: 'GLM-5.3',
    providerId: 'account:bigmodel-individual-coding-plan',
    sessionId: 'sess_a',
    command,
    pluginRoot: '/fake/plugin-root',
  }));
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  const text = out.hookSpecificOutput.additionalContext;
  assert.ok(text.includes('GLM-5.3'));
  assert.ok(text.includes(command));
  assert.ok(text.includes('run_in_background'));
  assert.ok(text.includes('suppress'));
  // 会话 id 出现在叫停命令里，保证 agent 可直接复制执行
  assert.ok(text.includes('--session "sess_a"'));
});

test('provider 名含空格时命令引号完整', () => {
  const command = watchCommand('/fake/root', 'sess_a', 'account:two words');
  assert.ok(command.includes('--provider "account:two words"'));
});
