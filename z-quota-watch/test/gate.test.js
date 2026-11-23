'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// sh 门控端到端：从 hooks.json 取真实 command，替换插件根与计数目录为测试隔离路径，
// 连续触发验证计数超过 20 才 exec node（夹具写 marker）且触发后计数清零。
const hooksJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
const rawCommand = hooksJson.hooks.PreToolUse[0].hooks[0].command;

const fixturePluginRoot = path.join(__dirname, '..', 'fixtures', 'fake-plugin');
const countDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zqw-gate-'));
const marker = path.join(countDir, 'marker');

function fireGate() {
  const command = rawCommand
    .replace(/\$\{ZCODE_PLUGIN_ROOT\}/g, fixturePluginRoot)
    .replace('d="$HOME/.zcode/z-quota-watch/state/count"', 'd="' + countDir + '"');
  return execFileSync('/bin/sh', ['-c', command], {
    env: {
      ...process.env,
      CLAUDE_SESSION_ID: 'sess_gate-test',
      ZQW_TEST_MARKER: marker,
      ZCODE_PLUGIN_ROOT: fixturePluginRoot,
    },
    timeout: 10_000,
  }).toString();
}

test('门控：计数超过 20 触发一次 node 检测并清零计数', () => {
  let triggeredAt = null;
  for (let i = 1; i <= 21; i++) {
    const out = fireGate();
    if (i <= 20) assert.strictEqual(out, '', '计数 1..20 直通不应有输出');
    if (fs.existsSync(marker)) { triggeredAt = i; break; }
  }
  assert.strictEqual(triggeredAt, 21, '第 21 次（>20）才触发 node');
  // 触发后计数器清零
  assert.strictEqual(fs.readFileSync(path.join(countDir, 'sess_gate-test.count'), 'utf8').trim(), '0');
  fs.unlinkSync(marker);
  let again = null;
  for (let i = 22; i <= 42; i++) {
    fireGate();
    if (fs.existsSync(marker)) { again = i; break; }
  }
  assert.strictEqual(again, 42, '清零后下一周期仍是第 21 次触发');
});

test('门控：会话隔离（不同 session id 各自计数）', () => {
  fs.rmSync(countDir, { recursive: true, force: true });
  fs.mkdirSync(countDir, { recursive: true });
  const command = rawCommand
    .replace(/\$\{ZCODE_PLUGIN_ROOT\}/g, fixturePluginRoot)
    .replace('d="$HOME/.zcode/z-quota-watch/state/count"', 'd="' + countDir + '"');
  execFileSync('/bin/sh', ['-c', command], { env: { ...process.env, CLAUDE_SESSION_ID: 'sess_a' }, timeout: 10_000 });
  execFileSync('/bin/sh', ['-c', command], { env: { ...process.env, CLAUDE_SESSION_ID: 'sess_b' }, timeout: 10_000 });
  execFileSync('/bin/sh', ['-c', command], { env: { ...process.env, CLAUDE_SESSION_ID: 'sess_a' }, timeout: 10_000 });
  assert.strictEqual(fs.readFileSync(path.join(countDir, 'sess_a.count'), 'utf8').trim(), '2');
  assert.strictEqual(fs.readFileSync(path.join(countDir, 'sess_b.count'), 'utf8').trim(), '1');
});

test('门控：CLAUDE_SESSION_ID 缺失降级 default 键', () => {
  fs.rmSync(countDir, { recursive: true, force: true });
  fs.mkdirSync(countDir, { recursive: true });
  const command = rawCommand
    .replace(/\$\{ZCODE_PLUGIN_ROOT\}/g, fixturePluginRoot)
    .replace('d="$HOME/.zcode/z-quota-watch/state/count"', 'd="' + countDir + '"');
  const env = { ...process.env };
  delete env.CLAUDE_SESSION_ID;
  execFileSync('/bin/sh', ['-c', command], { env, timeout: 10_000 });
  assert.ok(fs.existsSync(path.join(countDir, 'default.count')));
});
