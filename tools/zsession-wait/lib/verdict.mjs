// 裁决：单轮红绿判定 + 连续 N 轮绿的状态机。
//
// 信号语义（依据源码与实机核实，见 db-signals.mjs / process-signals.mjs 文件头）：
// - running_tools / active_runs 是 db 在途证据，但宿主进程死掉后是脏数据
//   （崩溃不写终态）——宿主不在且 db 已静默时按「脏数据 + 全部停止」处理，
//   与官方 reconcileOrphanRuns 的语义一致
// - 沙箱进程独立于宿主死活：孤儿沙箱仍在跑，必须单独阻塞判定
// - host_shells 是 workspace 级保守信号（无法归属到具体会话），可用
//   --ignore-shells 关闭；orphan_shells 默认只提示，--strict-orphan 升级为阻塞
// - quiet_period 防「模型思考空窗 / 轮次间隙」误判：zcode 在长推理期间
//   几分钟不写 db 属正常，静默不足阈值时一律视为未停

export function judgeRound({ db, procs, now, quietPeriodMs, ignoreShells, strictOrphan }) {
  const idleMs = db.lastActivityMs > 0 ? Math.max(0, now - db.lastActivityMs) : Number.POSITIVE_INFINITY;
  const red = [];
  const warnings = [];

  const hostFound = procs.hostPid != null;
  // 宿主没扫到但 db 还在动：进程识别可能失效（版本改进程名），按活宿主对待并提示。
  const dbStillMoving = idleMs < quietPeriodMs;
  const dirtyMode = !hostFound && !dbStillMoving;

  if (!hostFound && dbStillMoving) {
    warnings.push("host process not found but db recently active; shell signal unavailable this round");
  }

  if (dirtyMode) {
    warnings.push("host process gone; treating db running rows as stale (crash residue)");
  } else {
    if (db.runningTools > 0) red.push("running_tools");
    if (db.activeRuns > 0) red.push("active_runs");
    // 排队输入：turn 收尾后 queue drain 会提升 admitted 输入开新 turn，
    // 存在即说明还有待消费的工作（含子会话侧）。
    if (db.pendingInputs > 0) red.push("pending_inputs");
    if (hostFound && !ignoreShells && procs.hostShells.length > 0) red.push("host_shells");
  }

  // 沙箱进程与宿主死活无关（独立 ZCode Helper 进程），始终阻塞。
  if (procs.sandboxProcs.length > 0) red.push("sandbox_procs");

  if (strictOrphan && procs.orphanShells.length > 0) red.push("orphan_shells");

  if (idleMs < quietPeriodMs) red.push("quiet_period");

  return {
    green: red.length === 0,
    red,
    warnings,
    dirtyMode,
    hostFound,
    idleMs,
  };
}

export function formatIdle(ms) {
  if (!Number.isFinite(ms)) return "never-active";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
