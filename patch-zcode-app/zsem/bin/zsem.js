'use strict';

/**
 * zsem status CLI:读 zsem JSONL 日志,输出各 provider 的 grant/release 配对
 * 统计与在途数(只读;跨进程观测近似——真实在途以 grant-release 配对推算)。
 *
 *   node zsem/bin/zsem.js status [--log <路径>]
 *
 * 输出:
 *   providers=<N>
 *   <providerId>  grants=<n> releases=<n> inFlight=<n> queuedEvents=<n> cancels=<n> failopens=<n>
 *   totals: grants=<n> releases=<n>
 */

const fs = require('node:fs');
const path = require('node:path');
const { defaultLogPath } = require('../lib/log');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--log') args.log = argv[++i];
    else args._.push(argv[i]);
  }
  return args;
}

/** 损坏行跳过(与 api.md 存储节声明一致);FIFO/目录按空日志处理(读它们会挂死/抛错) */
function readEvents(logPath) {
  let stat;
  try {
    stat = fs.statSync(logPath);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        const e = JSON.parse(l);
        return e && typeof e === 'object' && typeof e.type === 'string' ? e : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** 终端显示转义:providerId 等字段里的控制序列(ESC/\r/\n)不得原样进终端 */
function safe(s) {
  return String(s).replace(/[\x00-\x1f\x7f]/g, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : '?'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'status';
  if (cmd !== 'status') {
    console.error(`未知命令 ${cmd}。用法:zsem.js status [--log <路径>]`);
    process.exit(1);
  }
  const logPath = args.log || defaultLogPath();
  const events = readEvents(logPath);
  const byProvider = new Map();
  let totals = { grants: 0, releases: 0 };
  for (const e of events) {
    const id = e.providerId || '(unknown)';
    if (!byProvider.has(id)) byProvider.set(id, { grants: 0, releases: 0, queuedEvents: 0, cancels: 0, failopens: 0 });
    const s = byProvider.get(id);
    if (e.type === 'grant') {
      s.grants += 1;
      totals.grants += 1;
    } else if (e.type === 'release') {
      s.releases += 1;
      totals.releases += 1;
    } else if (e.type === 'queue') s.queuedEvents += 1;
    else if (e.type === 'cancel') s.cancels += 1;
    else if (e.type === 'failopen') s.failopens += 1;
  }
  console.log(`log: ${logPath} (${events.length} events)`);
  console.log(`providers=${byProvider.size}`);
  for (const [id, s] of byProvider) {
    console.log(
      `${safe(id)}  grants=${s.grants} releases=${s.releases} inFlight=${s.grants - s.releases} queuedEvents=${s.queuedEvents} cancels=${s.cancels} failopens=${s.failopens}`,
    );
  }
  console.log(`totals: grants=${totals.grants} releases=${totals.releases}`);
}

main();
