#!/usr/bin/env node
'use strict';

// UserPromptSubmit hook 入口 —— Wave 1 空壳版：仅打通 stdin/env → stdout 冒烟回环，
// 主流程由 Wave 2 在 run() 的 TODO 处填充。
//
// 超时双保险关系（§3.4）：
// - watchdog（2500ms）：覆盖异步等待类挂起（stdin 未闭合、stdout 回调不到来等）；正常路径 clearTimeout。
// - hooks.json 条目级 timeoutMs: 3000：真正的硬上限。同步调用阻塞主线程时（如 sqlite 同步查询
//   卡死），事件循环停摆、watchdog 回调同样得不到执行——这层只有引擎到点杀进程能救。
//   因此 watchdog 是快路径自救，timeoutMs 是最终兜底，两层缺一不可。

const fs = require('node:fs');

const WATCHDOG_MS = 2500;
const SMOKE_PREFIX = '[z-auto-compact][SMOKE]';

const watchdog = setTimeout(() => {
  try {
    fs.writeSync(2, `[z-auto-compact] watchdog ${WATCHDOG_MS}ms 触发，自杀退出\n`);
  } catch {
    // stderr 不可用时静默
  }
  process.exit(1);
}, WATCHDOG_MS);

function finish(payload) {
  const line = `${JSON.stringify(payload)}\n`;
  try {
    // writeSync 而非 process.stdout.write + exit：引擎侧 stdout 是 pipe（异步写入），
    // write 后立刻 exit 可能截断输出；同步写保证注入字节先落管道。
    fs.writeSync(1, line);
  } catch {
    // stdout 已关闭：本次注入丢弃即可，会话不受影响
  }
  clearTimeout(watchdog);
  process.exit(0);
}

function run(rawStdin) {
  let stdinPayload = {};
  try {
    stdinPayload = JSON.parse(rawStdin);
  } catch {
    // 空/坏 stdin：Wave 1 不设失败分支，session 记 unknown 继续冒烟
  }

  // session 定位双通道：env CLAUDE_SESSION_ID（官方契约面）优先，stdin.session_id 兜底（实测同值）
  const sessionId =
    (typeof process.env.CLAUDE_SESSION_ID === 'string' && process.env.CLAUDE_SESSION_ID) ||
    (typeof stdinPayload.session_id === 'string' && stdinPayload.session_id) ||
    'unknown';

  // TODO(Wave 2)：主流程填充点，数据流顺序见设计 §2.3（全部组合 lib/ 各模块实现）：
  //   1. 嵌套双判静默 —— lib/state.isNestedSession(process.env, db.getSessionParentId(...))，
  //      命中任一即零输出 exit 0（子会话不产生 state 与提醒）
  //   2. 读数 —— lib/config.readConfig → lib/db.openDb(dbPath) + getLatestCompletedUsage
  //      （SQL-1，status='completed' 过滤是硬要求）
  //   3. 回落自愈 —— lib/state.detectDropout 命中则清 firedTiers + 注入知情通知
  //      （中性措辞：压缩「或回退」，不断言成因）
  //   4. 判档 —— lib/state.pickTier 越新档位则组三档提醒文案（数据投递非指令，D6；
  //      context_exceeded=1 仅记日志不注入不判档，D8）
  //   5. 注入 —— 仅越档/知情时输出顶层 {"additionalContext": ...}，未越档零输出零打扰（G4）
  //   6. 日志 —— lib/log 记录每轮动作与全链路耗时（P7 实测义务：均值 <200ms）
  //   全程 try/catch 兜底：任何失败 stderr 落日志后零输出 exit 0（§3.4 静默降级）。

  void stdinPayload;
  finish({ additionalContext: `${SMOKE_PREFIX} hook chain ok for session ${sessionId}` });
}

function main() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => run(chunks.join('')));
  process.stdin.on('error', () => run(chunks.join('')));
}

main();
