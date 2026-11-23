'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');
const FAKE_CLI = path.join(__dirname, '..', 'fixtures', 'fake-quota-wait.mjs');
const WATCH = path.join(PLUGIN_ROOT, 'bin', 'zqw-watch.js');

function runWatch(args) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zqw-watch-'));
  const res = spawnSync(process.execPath, [WATCH, ...args], {
    env: { ...process.env, ZQW_DATA_DIR: dataDir, ZQW_QUOTA_WAIT_CLI: FAKE_CLI },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { res, dataDir };
}

test('zqw-watch：dry-run 推导 until = 窗口结束 +60s，转发输出并落盘 result', () => {
  const { res, dataDir } = runWatch(['--session', 'sess_w1', '--provider', 'account:bigmodel-individual-coding-plan']);
  assert.strictEqual(res.status, 0, 'stderr: ' + res.stderr);
  // 夹具 nextFiveHourReset = 启动时刻 +2min；until 应为其 +60s
  const result = JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'sess_w1', 'result.json'), 'utf8'));
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.reason, 'deadline');
  assert.ok(result.until.endsWith('Z'), 'until 为 ISO 串');
  const untilMs = Date.parse(result.until);
  assert.ok(untilMs > Date.now() + 2 * 60_000 - 5_000, 'until 在窗口结束后（夹具窗口=+2min）');
  assert.ok(untilMs < Date.now() + 4 * 60_000, 'until 不超过窗口+缓冲');
  // 转发的 stdout 里能读到末行 JSON（完成通知可读的前提）
  const lastLine = res.stdout.trim().split('\n').pop();
  assert.strictEqual(JSON.parse(lastLine).reason, 'deadline');
});

test('zqw-watch：--until 直通时不做 dry-run，直接传给 CLI', () => {
  const { res, dataDir } = runWatch(['--session', 'sess_w2', '--provider', 'account:p', '--until', '+5s']);
  assert.strictEqual(res.status, 0, 'stderr: ' + res.stderr);
  assert.ok(!res.stdout.includes('dry-run'), '显式 --until 跳过 dry-run');
  const result = JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'sess_w2', 'result.json'), 'utf8'));
  assert.strictEqual(result.until, '+5s');
});

test('zqw-watch：缺 --session / --provider 时 exit 2 带用法', () => {
  const res = spawnSync(process.execPath, [WATCH, '--provider', 'account:p'], {
    env: { ...process.env, ZQW_QUOTA_WAIT_CLI: FAKE_CLI },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.strictEqual(res.status, 2);
  assert.ok(res.stderr.includes('用法'));
});
