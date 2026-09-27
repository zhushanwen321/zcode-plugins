'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'zwr.js');

function runHook(env, callback) {
  const child = execFile(
    process.execPath,
    [BIN, 'hook', 'user-prompt-submit'],
    { env: Object.assign({}, process.env, env) },
    (err, stdout) => callback(err, (stdout || '').trim())
  );
  return child;
}

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zwr-hook-'));
}

test('第 3 条用户消息输出注入 JSON，前两条与第 4 条输出空对象', (t, done) => {
  const dataDir = tmpDataDir();
  const env = { ZWR_DATA_DIR: dataDir, CLAUDE_SESSION_ID: 'sess-e2e' };
  const outputs = [];
  const finish = () => {
    try {
      assert.strictEqual(outputs[0], '{}');
      assert.strictEqual(outputs[1], '{}');
      const parsed = JSON.parse(outputs[2]);
      assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
      assert.ok(parsed.hookSpecificOutput.additionalContext.includes('规则 15'));
      assert.deepStrictEqual(JSON.parse(outputs[3]), {});
      fs.rmSync(dataDir, { recursive: true, force: true });
      done();
    } catch (e) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      done(e);
    }
  };
  const steps = [1, 2, 3, 4];
  const next = () => {
    if (!steps.length) return setImmediate(finish);
    runHook(env, (err, stdout) => {
      assert.ifError(err);
      outputs.push(stdout);
      steps.shift();
      next();
    });
  };
  next();
});

test('嵌套标记环境下不注入也不计数', (t, done) => {
  const dataDir = tmpDataDir();
  const env = {
    ZWR_DATA_DIR: dataDir,
    CLAUDE_SESSION_ID: 'sess-nested',
    ZSW_NESTED: '1',
  };
  runHook(env, (err, stdout) => {
    assert.ifError(err);
    assert.strictEqual(stdout, '{}');
    const stateFile = path.join(dataDir, 'state', 'sess-nested.json');
    assert.strictEqual(fs.existsSync(stateFile), false);
    fs.rmSync(dataDir, { recursive: true, force: true });
    done();
  });
});

test('CLAUDE_SESSION_ID 缺失时降级为 default 键计数', (t, done) => {
  const dataDir = tmpDataDir();
  const env = { ZWR_DATA_DIR: dataDir };
  runHook(env, (err, stdout) => {
    assert.ifError(err);
    assert.strictEqual(stdout, '{}');
    assert.strictEqual(fs.existsSync(path.join(dataDir, 'state', 'default.json')), true);
    fs.rmSync(dataDir, { recursive: true, force: true });
    done();
  });
});
