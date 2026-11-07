#!/usr/bin/env node
// zsession-wait：监控某个 zcode 会话是否「完全停止」的外部旁观 CLI。
//
// 判定条件（全部满足、连续 N 轮）：
//   1. 会话及其全部子会话（subagent / workflow actor）db 静默超 quiet-period
//   2. 会话树无在途工具调用（tool_usage.status='running'）
//   3. 会话树无在飞 workflow run（dwf_run 非终态）且无存活的 workflow 沙箱进程
//   4. 宿主 app-server 进程树中无 shell 后代（后台 bash 的唯一外部可见证据；
//      workspace 级信号，可用 --ignore-shells 关闭）
//
// 宿主进程消失时：db 里的 running 行按崩溃残留处理（与官方 reconcile 语义
// 一致），只有沙箱孤儿 / 孤儿 shell（--strict-orphan）仍会阻塞判定。
//
// 退出码：0=已停止  1=超时  2=会话不存在/db 不可读  3=参数错误  4=采集连续失败

import { collectDbSignals, loadSessionRow, DEFAULT_DB_PATH } from "../lib/db-signals.mjs";
import { collectProcessSignals } from "../lib/process-signals.mjs";
import { judgeRound, formatIdle } from "../lib/verdict.mjs";

const USAGE = `usage: zsession-wait <sessionId> [options]

options:
  --interval <sec>       轮询间隔（默认 15）
  --quiet-period <sec>   db 静默阈值，防模型思考空窗误判（默认 180）
  --rounds <n>           连续全绿轮数（默认 3）
  --timeout <sec>        总超时，0 表示不限（默认 7200）
  --json                 最终报告以 JSON 输出到 stdout（进度行始终在 stderr）
  --ignore-shells        跳过宿主 shell 后代信号（workspace 有并发会话时用）
  --strict-orphan        孤儿 shell（PPID=1）升级为阻塞信号（默认只提示）
  --db <path>            db 路径（默认 ~/.zcode/cli/db/db.sqlite）
  -h, --help             显示本帮助`;

function parseArgs(argv) {
  const opts = {
    sessionId: null,
    intervalSec: 15,
    quietPeriodSec: 180,
    rounds: 3,
    timeoutSec: 7200,
    json: false,
    ignoreShells: false,
    strictOrphan: false,
    dbPath: DEFAULT_DB_PATH,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--interval") opts.intervalSec = Number(next());
    else if (a === "--quiet-period") opts.quietPeriodSec = Number(next());
    else if (a === "--rounds") opts.rounds = Number(next());
    else if (a === "--timeout") opts.timeoutSec = Number(next());
    else if (a === "--json") opts.json = true;
    else if (a === "--ignore-shells") opts.ignoreShells = true;
    else if (a === "--strict-orphan") opts.strictOrphan = true;
    else if (a === "--db") opts.dbPath = next();
    else if (a.startsWith("--")) throw new Error(`unknown option: ${a}`);
    else positional.push(a);
  }
  if (positional.length > 1) throw new Error(`unexpected extra argument: ${positional[1]}`);
  opts.sessionId = positional[0] ?? null;
  return opts;
}

function hhmmss(date) {
  return date.toTimeString().slice(0, 8);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function die(code, message) {
  process.stderr.write(`zsession-wait: ${message}\n`);
  process.exit(code);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!opts.sessionId) die(3, `session id required.\n\n${USAGE}`);
  for (const [name, v, min] of [
    ["--interval", opts.intervalSec, 1],
    ["--quiet-period", opts.quietPeriodSec, 0],
    ["--rounds", opts.rounds, 1],
    ["--timeout", opts.timeoutSec, 0],
  ]) {
    if (!Number.isFinite(v) || v < min) die(3, `${name} must be a number >= ${min}`);
  }

  let sessionRow;
  try {
    sessionRow = loadSessionRow(opts.dbPath, opts.sessionId);
  } catch (error) {
    die(2, `cannot open db at ${opts.dbPath}: ${error.message}`);
  }
  if (!sessionRow) die(2, `session ${opts.sessionId} not found in ${opts.dbPath}`);

  const quietPeriodMs = opts.quietPeriodSec * 1000;
  const intervalMs = opts.intervalSec * 1000;
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutSec > 0 ? opts.timeoutSec * 1000 : Number.POSITIVE_INFINITY;

  process.stderr.write(
    `zsession-wait: watching ${opts.sessionId} "${sessionRow.title}"\n` +
      `  workspace: ${sessionRow.directory}\n` +
      `  interval=${opts.intervalSec}s quiet-period=${opts.quietPeriodSec}s rounds=${opts.rounds} timeout=${opts.timeoutSec > 0 ? `${opts.timeoutSec}s` : "none"}\n`,
  );

  let greenStreak = 0;
  let round = 0;
  let failures = 0;
  let lastSnapshot = null;
  let lastJudge = null;

  while (true) {
    round++;
    try {
      const now = Date.now();
      const db = collectDbSignals(opts.dbPath, opts.sessionId);
      const procs = await collectProcessSignals({
        directory: sessionRow.directory,
        activeRunIds: db.activeRunIds,
      });
      lastSnapshot = { db, procs };
      lastJudge = judgeRound({
        db,
        procs,
        now,
        quietPeriodMs,
        ignoreShells: opts.ignoreShells,
        strictOrphan: opts.strictOrphan,
      });
      failures = 0;
    } catch (error) {
      failures++;
      process.stderr.write(`zsession-wait: collect failed (${failures}/5): ${error.message}\n`);
      if (failures >= 5) die(4, `collection failed ${failures} times in a row`);
      greenStreak = 0;
      await sleep(intervalMs);
      continue;
    }

    const j = lastJudge;
    const status = j.green ? `green ${greenStreak + 1}/${opts.rounds}` : `RED (${j.red.join(",")})`;
    process.stderr.write(
      `[${hhmmss(new Date())}] #${round} ${status} | host=${j.hostFound ? lastSnapshot.procs.hostPid : "gone"} ` +
        `tools=${lastSnapshot.db.runningTools} runs=${lastSnapshot.db.activeRuns} sandbox=${lastSnapshot.procs.sandboxProcs.length} ` +
        `queue=${lastSnapshot.db.pendingInputs} shells=${lastSnapshot.procs.hostShells.length} idle=${formatIdle(j.idleMs)}\n`,
    );
    for (const w of j.warnings) process.stderr.write(`    warn: ${w}\n`);
    if (lastSnapshot.procs.foreignSandboxes.length > 0) {
      process.stderr.write(
        `    note: ${lastSnapshot.procs.foreignSandboxes.length} workflow sandbox process(es) of other sessions in this workspace (not blocking)\n`,
      );
    }

    greenStreak = j.green ? greenStreak + 1 : 0;
    if (greenStreak >= opts.rounds) break;

    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) break;
    await sleep(intervalMs);
  }

  const stopped = greenStreak >= opts.rounds;
  const elapsedMs = Date.now() - startedAt;
  const report = {
    sessionId: opts.sessionId,
    verdict: stopped ? "stopped" : "timeout",
    greenStreak,
    rounds: round,
    elapsedMs,
    session: {
      title: sessionRow.title,
      directory: sessionRow.directory,
      taskType: sessionRow.task_type,
      subtreeSize: lastSnapshot.db.subtreeSize,
      childCount: lastSnapshot.db.childCount,
      lastOutcome: sessionRow.last_outcome,
      lastActivityMs: lastSnapshot.db.lastActivityMs,
      lastFinish: lastSnapshot.db.lastFinish,
      lastRole: lastSnapshot.db.lastRole,
    },
    finalSignals: {
      hostPid: lastSnapshot.procs.hostPid,
      runningTools: lastSnapshot.db.runningTools,
      activeRuns: lastSnapshot.db.activeRuns,
      activeRunIds: lastSnapshot.db.activeRunIds,
      sandboxProcs: lastSnapshot.procs.sandboxProcs,
      pendingInputs: lastSnapshot.db.pendingInputs,
      hostShells: lastSnapshot.procs.hostShells,
      orphanShells: lastSnapshot.procs.orphanShells,
      foreignSandboxes: lastSnapshot.procs.foreignSandboxes,
      idleMs: lastJudge.idleMs,
      red: lastJudge.red,
      warnings: lastJudge.warnings,
    },
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const outcome = sessionRow.last_outcome ?? "none";
    const finish = lastSnapshot.db.lastFinish ?? "none";
    process.stdout.write(
      (stopped
        ? `session ${opts.sessionId} fully stopped after ${round} rounds (${Math.round(elapsedMs / 1000)}s)\n`
        : `TIMEOUT after ${Math.round(elapsedMs / 1000)}s, last state: red=(${lastJudge.red.join(",")}) green=${greenStreak}/${opts.rounds}\n`) +
        `  last_outcome=${outcome} last_message_finish=${finish} idle=${formatIdle(lastJudge.idleMs)}\n`,
    );
  }
  process.exit(stopped ? 0 : 1);
}

main().catch((error) => die(4, error.stack ?? error.message));
