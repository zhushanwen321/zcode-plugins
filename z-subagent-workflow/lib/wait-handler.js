'use strict';

/**
 * wait 命令 daemon 侧语义（DESIGN-v4 §6.4 D4）。
 *
 * 对给定 id 集合挂起等待：终态者立即收，运行中者等 manager.pending 的执行体
 * promise——事件驱动、零轮询是主路径（D4 否决了 CLI sleep+status 轮询方案，
 * 这里是 daemon 内存挂起的落地）。CLI wait 进程经 socket 挂在本 handler 上，
 * 配引擎 run_in_background 即进原生 task-notification 唤醒链路（设计 F2）。
 *
 * 本模块只实现 wait 语义，挂在 zsub handler 表上：action 分发由集成层做，
 * 这里不检查 params.action。
 *
 * 健壮性边界（全部来自 manager 的真实时序，不是假想的防御）：
 * - pending 可能 reject（执行体失败）：失败原因已落 record（error 终态，
 *   manager._execRound 的 catch 分支），吸收 reject 后以 manager.status 收编，
 *   wait 整体不失败。
 * - pending Map 可能缺条目（极快完成后 .finally 已清除 / daemon 接管后内存
 *   丢失）：一切以 manager.status 为准，每回合重查。
 * - pending 与 record 可能漂移（promise settle 先于终态落盘的极窄窗口，
 *   以及 lost 可经外部 cancel/close 推进终态）：固定间隔轮询兜底防永久挂起
 *   ——interval 可注入（测试用小值），默认 2s。
 *
 * abort 语义（CLI 断连 / TaskStop 杀 CLI）：只取消「等待」，不碰执行体
 * （绝不调 manager.cancel）。race 挂起的衍生 promise 已带 noop handler，
 * abort 之后迟到的 settle/reject 不产生 unhandledRejection。
 */

const { TERMINAL_STATUSES } = require('./record-store');

/**
 * wait 的「完成」集合（R5）：终态 + idle——conversation 任务轮完成是
 * running→idle（round-complete），DESIGN-v4 §5「本轮完成经 wait 收」要求
 * idle 即可收；只认终态会让 start --wait --conversation 与 message 后的
 * wait 永久挂起（idle 无 pending 条目，仅靠轮询兜底空转）。
 */
const WAIT_DONE_STATUSES = new Set([...TERMINAL_STATUSES, 'idle']);
// 带 recover 判定的 lost 立即收编（R2）：dead=true（探活已死，执行体消亡，
// 永无外部推进）或 orphan=true（进程活着但句柄丢失，结果永无法回流）——
// 继续等只会无 timeout 永久挂起；收编让调用方拿到 lost 状态与 lostReason
// 指引自行决定重发。无判定标记的 lost（rebuild 已标但 recover 尚未探完）
// 仍走轮询：recover 探活完成后标记到位，下一回合（≤pollFallbackMs）收敛。
const isWaitDone = (st) => WAIT_DONE_STATUSES.has(st.status)
  || (st.status === 'lost' && (st.dead === true || st.orphan === true));

/** 轮询兜底间隔：正常路径远小于此（pending promise 事件驱动唤醒）。
 *  模块内部缺省值，不导出——自引入起零外部消费，间隔个性化走
 *  createWaitHandler 的 pollFallbackMs 注入。 */
const DEFAULT_POLL_FALLBACK_MS = 2000;

/** 可取消 sleep：race 输家的 timer 必须清掉，否则挂起 timer 拖住进程退出。 */
function sleepCancellable(ms) {
  let timer;
  const promise = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * @param {object} opts
 * @param {object} opts.manager SubagentManager（或等价 stub：status/pending）
 * @param {number} [opts.pollFallbackMs] 轮询兜底间隔（默认 2000，测试注入小值）
 * @returns {(params: {ids: string[], timeoutMs?: number}, meta: {signal?: AbortSignal}) => Promise<object>}
 */
function createWaitHandler({ manager, pollFallbackMs = DEFAULT_POLL_FALLBACK_MS }) {
  if (!manager) {
    throw new Error(
      'createWaitHandler 需要 manager 注入（消费 status 与 pending）。'
      + '恢复指引：经 assemble 的运行时组装调用，不要手工缺参构造。'
    );
  }
  if (!Number.isFinite(pollFallbackMs) || pollFallbackMs <= 0) {
    throw new Error(`createWaitHandler 的 pollFallbackMs 需为正有限数（毫秒），收到 ${String(pollFallbackMs)}。`);
  }

  return async function wait(params = {}, meta = {}) {
    // ---- params 校验（契约第 1 条：不合法立即抛，不进入任何等待） ----
    const ids = params.ids;
    if (!Array.isArray(ids) || ids.length === 0
      || ids.some((id) => typeof id !== 'string' || id.trim() === '')) {
      throw new Error(
        'wait 需要 ids（非空字符串数组，如 ["sa-a1b2", "sa-c3d4"]）。'
        + '恢复指引：id 来自 start 返回的 subagentId；不确定现有任务时先用 list 可查现有任务 id。'
      );
    }
    let timeoutMs = null;
    if (params.timeoutMs !== undefined && params.timeoutMs !== null) {
      if (typeof params.timeoutMs !== 'number' || !Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0) {
        throw new Error(
          `wait 的 timeoutMs 需为正有限数（毫秒），收到 ${String(params.timeoutMs)}。`
          + '恢复指引：去掉 timeoutMs 表示无限等待，或传如 60000。'
        );
      }
      timeoutMs = params.timeoutMs;
    }

    const signal = meta && meta.signal ? meta.signal : null;
    const deadline = timeoutMs !== null ? Date.now() + timeoutMs : Infinity;

    /** id -> 终态条目（含 outputFile） */
    const collected = new Map();
    /** 未终态 id 集合 */
    const waiting = new Set();

    // ---- 初始分类：逐个 status 校验存在性 + 终态/运行中分拣 ----
    // 存在性错误透传：真 manager 的 _mustGet 已含「用 list 查看全部任务 id」指引。
    // 校验放在任何等待之前——调用方不该为一个 id 等完所有任务才发现拼错。
    for (const id of ids) {
      const st = manager.status(id);
      if (!st || typeof st.status !== 'string') {
        throw new Error(
          `wait 查询 id "${id}" 未得到有效状态（manager.status 返回异常）。`
          + '恢复指引：用 list 可查现有任务 id，确认该 id 存在后重试。'
        );
      }
      if (isWaitDone(st)) {
        collected.set(id, { subagentId: id, status: st.status, outputFile: st.outputFile });
      } else {
        waiting.add(id);
      }
    }

    // ---- abort 唤醒源：整个等待期只挂一次 listener，返回前移除（防泄漏） ----
    let onAbort = null;
    let abortWake = null;
    if (signal) {
      abortWake = new Promise((resolve) => {
        onAbort = () => resolve();
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }

    try {
      while (waiting.size > 0) {
        if (signal && signal.aborted) break;
        const now = Date.now();
        if (now >= deadline) break;

        // 本回合唤醒源：轮询/超时 slice + abort + 各 waiting id 的执行体 promise。
        // 每回合重取 pending.get(id)：settle 后 .finally 会清除条目，且新建/续聊
        // 轮可能换 promise——缓存的引用会错过新执行体。
        const slice = sleepCancellable(Math.min(pollFallbackMs, deadline - now));
        const racers = [slice.promise];
        if (abortWake) racers.push(abortWake);
        for (const id of waiting) {
          const p = manager.pending.get(id);
          if (p) {
            // 衍生 promise 吸收 reject：执行体失败原因已落 record（error 终态），
            // 下方回查 status 收编；且保证 abort 后迟到的 reject 不成 unhandled
            racers.push(p.then(() => {}, () => {}));
          }
          // pending 缺条目（极快完成/接管丢失）：本回合只靠 slice 轮询兜底，
          // 醒后回查 status——防止「无 promise 可等」演变为永久挂起
        }
        await Promise.race(racers);
        slice.cancel(); // 输家 timer 清理

        // 醒来回查：status 为准（终态判定只认 record，不认 promise settle——
        // settle 与终态落盘之间存在极窄窗口，lost 也可经外部 cancel/close 推进）
        for (const id of [...waiting]) {
          const st = manager.status(id);
          if (isWaitDone(st)) {
            collected.set(id, { subagentId: id, status: st.status, outputFile: st.outputFile });
            waiting.delete(id);
          }
        }
      }
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }

    // ---- 组装返回（保持入参 ids 顺序） ----
    if (waiting.size === 0) {
      return { results: ids.map((id) => collected.get(id)) };
    }
    return {
      results: ids.filter((id) => collected.has(id)).map((id) => collected.get(id)),
      partial: true,
      pending: ids.filter((id) => waiting.has(id)).map((id) => {
        const st = manager.status(id);
        return { subagentId: id, status: st.status };
      }),
    };
  };
}

module.exports = { createWaitHandler };
