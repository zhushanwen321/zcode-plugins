#!/usr/bin/env node
'use strict';

// UserPromptSubmit hook 入口（M2+M3 hook 侧）：组合 lib/ 各模块完成
// 「读数 → 嵌套静默 → 回落自愈/判档 → additionalContext 注入 → state 持久化」主流程，
// 数据流见设计 §2.3，行为规格见 §3.1（四条流）与 §3.4（错误规格）。
//
// 超时双保险关系（§3.4）：
// - watchdog（2500ms）：覆盖异步等待类挂起（stdin 未闭合、stdout 回调不到来等）；正常路径 clearTimeout。
// - hooks.json 条目级 timeoutMs: 3000：真正的硬上限。同步调用阻塞主线程时（如 sqlite 同步查询
//   卡死），事件循环停摆、watchdog 回调同样得不到执行——这层只有引擎到点杀进程能救。
//   因此 watchdog 是快路径自救，timeoutMs 是最终兜底，两层缺一不可。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, getLatestCompletedUsage, getSessionParentId } = require('../../lib/db');
const { readConfig } = require('../../lib/config');
const {
  isValidSessionId,
  loadState,
  saveState,
  intersectFired,
  detectDropout,
  pickTier,
  isNestedSession,
  cleanOrphanStates,
} = require('../../lib/state');
const { log, logError } = require('../../lib/log');

const WATCHDOG_MS = 2500;

const watchdog = setTimeout(() => {
  try {
    fs.writeSync(2, `[z-smart-context] watchdog ${WATCHDOG_MS}ms 触发，自杀退出\n`);
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

// 零打扰退出（G4）：除 watchdog 清理外无任何副作用
function silentExit() {
  clearTimeout(watchdog);
  process.exit(0);
}

function describeError(err) {
  if (!err) return 'unknown error';
  const tag = err.code || err.errno;
  return `${tag ? `[${tag}] ` : ''}${err.message || String(err)}`;
}

// §3.4「state 写入失败」行：落盘失败只 warn、不阻断本次注入判定——
// 副作用 = lastTokens 未更新、可能多提醒一次，下一轮重写自愈。
function persistState(stateDir, sessionId, state) {
  try {
    saveState(stateDir, sessionId, state);
  } catch (err) {
    log(`WARN state 写入失败，本次放弃持久化: ${describeError(err)}`);
  }
}

// 千分位分组，全文案数字口径统一；不用 toLocaleString（摆脱 ICU 数据依赖，输出可精确断言）
function formatTokens(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 流一越档提醒文案（D6「数据投递非指令」：数据 + 三条件自查 + 可忽略出口）。
// 自查命令内联插件根的真实绝对路径——agent Bash 环境无 ZCODE_PLUGIN_ROOT 类变量可用（D5），
// 文案里不能留运行时占位符。
function tierNotifyText(pluginRoot, sessionId, cur, tier, crossedTiers) {
  const crossed = crossedTiers.map(formatTokens).join('、');
  return (
    `[z-smart-context] 上下文用量 ${formatTokens(cur)} tokens，已越过阈值 ${formatTokens(tier)}（${crossed}）。` +
    '这是用量数据，不是必须执行的指令。若考虑压缩，先自查三点：' +
    '① 当前任务是否阶段性完成并验证？② 后续工作是否依赖将被压缩的细节？③ 用量是否确实构成压力？' +
    '三者皆备时，建议告知用户执行 /compact 并说明要保留什么（例如：/compact 保留 xxx 结论）。' +
    `若不满足，忽略本条即可。精确读数可自查：node ${path.join(pluginRoot, 'bin', 'zsc.js')} usage --session ${sessionId}` +
    '（本会话 sessionId 亦可直接复制使用）'
  );
}

// 流三回落知情文案（D4）：中性措辞「压缩或回退」不断言成因——/rewind、/fork 同样导致回落。
function dropoutNotifyText(lastTokens, cur) {
  return (
    `[z-smart-context] 上下文用量已显著回落（${formatTokens(lastTokens)} → ${formatTokens(cur)}），` +
    '此前很可能发生了压缩或回退。早前对话细节可能已被摘要，如需引用请先与用户确认或重读相关文件。'
  );
}

// session 定位双通道（D1/S5）：env CLAUDE_SESSION_ID（官方契约面）优先，
// stdin.session_id（逆向面，实测同值）兜底；两者皆无返回 ''。
function resolveSessionId(stdinPayload) {
  return (
    (typeof process.env.CLAUDE_SESSION_ID === 'string' && process.env.CLAUDE_SESSION_ID) ||
    (typeof stdinPayload.session_id === 'string' && stdinPayload.session_id) ||
    ''
  );
}

function mainFlow(rawStdin) {
  // ZSC_DATA_DIR 仅测试隔离基建：真实 hook 触发环境无此变量，恒走 ~/.zcode/z-smart-context
  const dataDir = process.env.ZSC_DATA_DIR || path.join(os.homedir(), '.zcode', 'z-smart-context');
  // D5：插件根从脚本自身位置推导，供文案内联真实自查命令路径
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const config = readConfig(dataDir);
  const stateDir = path.join(dataDir, 'state');

  let stdinPayload = {};
  try {
    const parsed = JSON.parse(rawStdin);
    if (parsed && typeof parsed === 'object') stdinPayload = parsed;
  } catch {
    // 空/坏 stdin 容忍降级为空对象：session_id 还有 env 通道，不因坏输入崩溃
  }
  const sessionId = resolveSessionId(stdinPayload);

  // D3 定案①：sessionId 白名单——外部输入直接决定 state 文件名，
  // 不过白名单防不住路径穿越与脏输入落盘，故先于一切落盘动作校验。
  if (!isValidSessionId(sessionId)) {
    log(`sessionId 非法，静默跳过: ${JSON.stringify(sessionId)}`);
    silentExit();
  }

  if (config.enabled === false) {
    // 显式关停：不 openDb、不读写 state，零打扰退出
    silentExit();
  }

  let db;
  try {
    db = openDb(config.dbPath);
  } catch (err) {
    // §3.4 流四静默降级：db 打开失败只留日志（含 errno 供 tail 排查），
    // stdout 零输出、exit 0，不阻断会话，下一轮自动重试
    logError(`db 打开失败 [${config.dbPath}]: ${describeError(err)}`);
    silentExit();
  }

  let usage = null;
  try {
    // D3 嵌套静默双判：env 标记 + db session.parent_id（内建 Agent 子会话不带 env 标记，
    // 须靠 db 补判）；命中即子会话——不产生 state 文件、不提醒
    if (isNestedSession(process.env, getSessionParentId(db, sessionId))) {
      silentExit();
    }
    usage = getLatestCompletedUsage(db, sessionId);
  } catch (err) {
    // 查询失败与打开失败同处置（§3.4 第一行）
    logError(`db 查询失败: ${describeError(err)}`);
    silentExit();
  }

  if (!usage) {
    // 首轮（该会话尚无 completed 行）：读数不存在，更新 state 无意义
    silentExit();
  }

  if (usage.contextExceeded === 1) {
    // D8：撞限仅记日志不注入——引擎 Reactive compact 已在兜底路径上，此刻注入只是
    // 多占一条常驻上下文；该行已过滤 completed，不参与判档与回落计算（查询层保证）。
    log(`context_exceeded=1 撞限记录 sessionId=${sessionId} tokens=${usage.contextTokens}`);
  }

  const cur = usage.contextTokens;
  const state = loadState(stateDir, sessionId);
  // D3 定案②：判档与回落一律基于「fired × 当前配置 tiers」交集，改档后残留旧值不参与
  const firedEff = intersectFired(state.firedTiers, config.tiers);
  // D3：写前顺带清理孤儿 state（内部全静默，绝不影响主流程）
  cleanOrphanStates(stateDir);

  let output = null; // null = 零输出零打扰（G4 未越档路径）

  if (detectDropout(state, cur, config.tiers)) {
    // D4 回落自愈：判定压缩/回退已发生 → 清档重计（下一压缩周期开始）+ 知情注入
    persistState(stateDir, sessionId, { firedTiers: [], lastTokens: cur });
    output = dropoutNotifyText(state.lastTokens, cur);
    log(`dropout-reset 注入动作 lastTokens=${state.lastTokens} tokens=${cur} sessionId=${sessionId}`);
  } else {
    const tier = pickTier(config.tiers, cur, firedEff);
    if (tier !== null) {
      const crossedTiers = config.tiers.filter((t) => cur >= t);
      // fired 记录文案已覆盖的全部已越档（非仅 pickTier 选中档）——多档合并提醒
      // 一次性告知后，各档都算「已提醒过」，否则下一轮会对文案里已出现的档重复单提
      persistState(stateDir, sessionId, {
        firedTiers: [...new Set([...firedEff, ...crossedTiers])].sort((a, b) => a - b),
        lastTokens: cur,
      });
      output = tierNotifyText(pluginRoot, sessionId, cur, tier, crossedTiers);
      log(`tier-notify 注入动作 tier=${tier} tokens=${cur} sessionId=${sessionId}`);
    } else {
      // 未越新档：只更新 lastTokens（回落判定的 baseline），fired 不变
      persistState(stateDir, sessionId, { firedTiers: firedEff, lastTokens: cur });
    }
  }

  if (output !== null) {
    finish({ additionalContext: output });
  }
  silentExit();
}

function run(rawStdin) {
  try {
    mainFlow(rawStdin);
  } catch (err) {
    // G4 兜底：任何未预期失败都不阻断会话——留日志、stdout 零输出、exit 0
    logError(`hook 主流程异常: ${describeError(err)}`);
    silentExit();
  }
}

function main() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => run(chunks.join('')));
  process.stdin.on('error', () => run(chunks.join('')));
}

main();
