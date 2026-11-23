#!/usr/bin/env node
/**
 * zqw-watch —— quota-wait 守望 wrapper，由 agent 以 Bash run_in_background 起后台任务。
 *
 * 职责：
 *  ① 无 --until 时先跑 quota-wait CLI 的 --dry-run，取当前 5h 窗口结束时刻 +60s 作为 until
 *    （+1 分钟防窗口边界竞争，对齐 quota-wait 技能模式 B 的检查点公式）；
 *  ② 挂起 quota-wait CLI 直到窗口结束 +1 分钟（或额度提前恢复）退出；
 *  ③ 转发子进程 stdout（完成通知到达时 agent 可读末行 JSON）并把结果摘要落盘
 *    到会话状态目录 result.json（供 hook 的失败冷却判定）。
 *
 * 退出码透传 CLI（0 正常 / 3 首查失败 / 4 轮询失败 / 5 无窗口数据）。
 * 命令行携带 --session <id>，是 hook 侧 ps 扫描的会话归属标记。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { QUOTA_WAIT_CLI, STATE_DIR } = require('../lib/config');
const { sanitizeSessionId } = require('../lib/detect');

const USAGE = '用法: zqw-watch.js --session <id> [--agent zcode] --provider <名> [--until <ISO|HH:mm|+3h>]';

function parseArgs(argv) {
  const opts = { session: undefined, agent: 'zcode', provider: undefined, until: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[++i];
    if (v === undefined) fail(2, '缺少 ' + a + ' 的值\n\n' + USAGE);
    if (a === '--session') opts.session = v;
    else if (a === '--agent') opts.agent = v;
    else if (a === '--provider') opts.provider = v;
    else if (a === '--until') opts.until = v;
    else fail(2, '未知参数：' + a + '\n\n' + USAGE);
  }
  if (!opts.session || !opts.provider) fail(2, '缺少 --session 或 --provider\n\n' + USAGE);
  return opts;
}

function fail(code, message) {
  process.stderr.write('[zqw-watch] ' + message + '\n');
  process.exit(code);
}

/** 收集子进程 stdout，返回末行可解析 JSON（无则 null）。 */
function collectStdout(child) {
  return new Promise((resolve) => {
    let buf = '';
    child.stdout.on('data', (c) => {
      buf = (buf + c).slice(-65536);
      process.stdout.write(c);
    });
    child.on('close', () => {
      const lines = buf.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const j = JSON.parse(lines[i]);
          if (j && typeof j.reason === 'string') return resolve(j);
        } catch { /* 非 JSON 行继续往前找 */ }
      }
      resolve(null);
    });
  });
}

/** dry-run 查当前 5h 窗口结束时刻，+60s 作为 until 的 ISO 串。 */
async function deriveUntil(cliPath, agent, provider) {
  console.log('[zqw-watch] 未指定 --until，先查询当前 5h 窗口结束时刻');
  const child = spawn(process.execPath, [cliPath, '--agent', agent, '--provider', provider, '--dry-run'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const summary = await collectStdout(child);
  if (child.exitCode !== 0 || !summary || !summary.nextFiveHourReset) {
    fail(3, 'dry-run 查询窗口结束时刻失败（exit=' + child.exitCode + '）。恢复指引：按上面 stderr 的指引处理（如去 taiji 设置页刷新凭证），处理后可重跑本命令');
  }
  const until = new Date(Date.parse(summary.nextFiveHourReset) + 60_000);
  console.log('[zqw-watch] 窗口结束时刻 ' + summary.nextFiveHourResetLocal + '，守望到 +1 分钟（' + until.toLocaleString('sv-SE') + '）');
  return until.toISOString();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const untilIso = opts.until || (await deriveUntil(QUOTA_WAIT_CLI, opts.agent, opts.provider));

  const key = sanitizeSessionId(opts.session);
  const dir = path.join(STATE_DIR, key);
  fs.mkdirSync(dir, { recursive: true });

  const startedAtMs = Date.now();
  const child = spawn(process.execPath, [
    QUOTA_WAIT_CLI, '--agent', opts.agent, '--provider', opts.provider, '--until', untilIso,
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  // 被 TaskStop 杀掉时把信号传导给 CLI 子进程，防孤儿查询进程
  for (const sig of ['SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { child.kill(sig); } catch { /* 已退出 */ } });
  }
  const summaryPromise = collectStdout(child);
  // 被 signal 杀死（如 TaskStop）时 close 第一个参数为 null：记 killed 供冷却判定区分主动终止
  const { code, signal } = await new Promise((resolve) =>
    child.on('close', (c, s) => resolve({ code: c, signal: s })));
  const summary = await summaryPromise;
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
    session: key,
    startedAtMs,
    finishedAtMs: Date.now(),
    exitCode: code,
    killed: Boolean(signal),
    until: untilIso,
    reason: summary ? summary.reason : null,
    nextFiveHourResetLocal: summary ? summary.nextFiveHourResetLocal : null,
  }, null, 2) + '\n');
  if (signal) process.exit(0); // 主动终止不是失败
  process.exitCode = code;
}

main().catch((err) => {
  process.stderr.write('[zqw-watch] ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exitCode = 3;
});
