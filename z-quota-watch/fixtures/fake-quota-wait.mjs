#!/usr/bin/env node
// zqw-watch 测试夹具：模拟 quota-wait CLI。
// --dry-run：输出一行日志 + 末行 JSON（nextFiveHourReset = now + 2min）；
// 否则：输出一行日志 + 末行 JSON（reason=deadline）后 exit 0。
const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const val = (f) => args[args.indexOf(f) + 1];
const windowEnd = new Date(Date.now() + 2 * 60_000);
if (hasFlag('--dry-run')) {
  console.log('[fake] 首查：5h 已用 42%，距窗口结束 2分钟');
  console.log(JSON.stringify({
    reason: 'dry-run',
    nextFiveHourReset: windowEnd.toISOString(),
    nextFiveHourResetLocal: windowEnd.toISOString(),
  }));
} else {
  console.log('[fake] 等待中 until=' + val('--until'));
  console.log(JSON.stringify({
    reason: 'deadline',
    nextFiveHourReset: windowEnd.toISOString(),
    nextFiveHourResetLocal: windowEnd.toISOString(),
  }));
}
