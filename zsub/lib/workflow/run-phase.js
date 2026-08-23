'use strict';

/**
 * workflow 共享执行辅助：后续所有 workflow（chain/parallel/map-reduce/
 * scatter-gather/review-fix-loop）运行单个阶段的唯一 driver 入口。
 * ModelRouter.resolve 不在此做——调用方（各 workflow / MCP 层）已持有 modelRef。
 *
 * 与源插件 dynamic-workflow 旧 driver.runHeadlessPhase 的三点差异：
 * 1. HOME 参数化走 model-router：不再用固定 ~/.zcode/dynamic-workflow/home，
 *    而是 prepareRunEnv(modelRef,'spawn') 返回 per-model HOME 池
 *    （config.homePoolDir(short)）；bootstrap 与 mtime 条件重写也由
 *    model-router 负责，本模块不碰隔离 HOME 的写盘。
 * 2. 防递归标记 ZSUB_NESTED=1 替代旧 DWF_NESTED=1：driver.runHeadless 强制
 *    注入（第一重门禁），叠加隔离 HOME 配置不含 plugins（第二重门禁），
 *    zsub 入口检测到该标记即拒绝再起嵌套任务。
 * 3. 超时语义：SIGTERM → killGraceMs(config.DEFAULTS) → SIGKILL，终态
 *    status:'timeout' 且携带 stdout 尾部；旧版只有 timedOut 布尔 + 固定 5s
 *    宽限（旧 SIGKILL 分支还有 killed 守卫死代码 bug，新版已修）。
 *
 * 返回值保持旧 runHeadlessPhase 的扁平形态（ok/response/usage/error 字段
 * 语义不变），旧 workflow 代码零适配即可迁移。两个字段的落地说明：
 * - exitCode：成功恒 0；新 driver 把非零退出码并入 error 文本前缀
 *   （"zcode CLI 退出码 N: ..."）不再单独暴露，故其余终态为 null。
 * - stderrTail：恒 null 占位。旧实现同样从未赋值（stderr 尾部并入 error
 *   文本），保持一致，避免后续批次依赖假字段。
 *
 * 错误约定：编程错误（modelRef 缺失）与环境准备失败（v2 config 缺 provider）
 * reject 可操作错误；阶段运行失败（CLI 崩溃/超时/输出不可解析）resolve 为
 * ok:false 条目，是否中断 workflow 由调用方决定。
 *
 * ## AbortSignal 契约（所有 workflow 入口统一实现，本文件是唯一执行落点）
 *
 * 所有 workflow 入口函数的 opts 增加 signal?: AbortSignal：
 *   runChain({task, cwd, model, ..., signal})
 * 语义（对齐 pi 的 abort：提前停止、已完成阶段保留在报告里）：
 * 1. 每次调用 phases.runPhase({..., signal}) 前，signal.aborted 为 true →
 *    该阶段不启动，条目记 {ok:false, error:'aborted', aborted:true}；
 * 2. 阶段运行中收到 abort → kill 子进程（run-phase 内监听 signal，调 driver
 *    run.cancel()），条目记 {ok:false, error:'aborted', aborted:true}；
 * 3. workflow 编排层：发现 aborted 条目后不再启动后续阶段，整体返回报告加
 *    {status:'aborted', abortedAtPhase:'<阶段名>'} 字段（成功/失败语义保持
 *    不变）；status 为增量字段，取值 'ok' | 'failed' | 'aborted'；
 * 4. signal 缺省时行为与现在完全一致（向后兼容）。
 *
 * error 恒用 'aborted' 字面值（不写长文案）：aborted:true 是机器判定字段，
 * 编排层靠它停后续阶段；恢复动作（是否重跑）由上层决定。
 */

const ModelRouter = require('../model-router');
const driver = require('../driver');

// INFO-17：prepareRunEnv 的 per-model 互斥链（poolMutex）是模块级 Map
// （model-router.js），多实例共享同一条链——同模型的并发阶段天然排队走同链
// （防 bootstrap 交错），不依赖此处是否单例。ModelRouter 本身无解析状态，
// 模块级单例只为避免各处重复构造。
const modelRouter = new ModelRouter();

/**
 * 中止条目（契约 1/2 的固定形态）。response 仅运行中中止时携带 stdout 尾部
 * （driver cancelled 终态返回），预置中止时为 null。
 */
function abortedEntry(response = null) {
  return {
    ok: false,
    sessionId: null,
    response,
    usage: null,
    exitCode: null,
    timedOut: false,
    error: 'aborted',
    aborted: true,
    stderrTail: null,
  };
}

/**
 * 运行单个阶段（= 一次 zcode 无头 session）。
 * @param {object} opts
 * @param {string} opts.prompt      完整阶段 prompt
 * @param {string} opts.cwd         阶段运行目录
 * @param {string} opts.modelRef    已 resolve 的模型全名（provider/model）
 * @param {number} [opts.timeoutMs] 缺省由 driver 落 config.DEFAULTS.timeoutMs
 * @param {AbortSignal} [opts.signal] 中止信号（契约见文件头；缺省行为不变）
 * @returns {Promise<{ok:boolean, sessionId:string|null, response:string|null,
 *   usage:object|null, exitCode:number|null, timedOut:boolean,
 *   error?:string, aborted?:true, stderrTail:null}>}
 */
async function runPhase({ prompt, cwd, modelRef, timeoutMs, signal }) {
  if (!modelRef || typeof modelRef !== 'string') {
    throw new Error(
      `runPhase: modelRef 必填（收到 ${JSON.stringify(modelRef)}）。` +
      '恢复指引：先经 ModelRouter.resolve() 得到模型全名再调用。'
    );
  }
  // 契约 1：启动前已中止 → 不做环境准备、不 spawn
  if (signal?.aborted) return abortedEntry();

  const { env } = await modelRouter.prepareRunEnv(modelRef, 'spawn');
  // prepareRunEnv 是 await 点，中止可能落在该窗口内；abort 事件对已 aborted
  // 的 signal 不会再触发，必须 spawn 前复查兜住这个缺口
  if (signal?.aborted) return abortedEntry();

  const run = driver.runHeadless({ home: env.HOME, cwd, prompt, timeoutMs });
  // 契约 2：运行中收到 abort → 复用 driver 的 cancel 杀进程链
  // （SIGTERM → killGraceMs → SIGKILL，终态 status:'cancelled'）
  let abortRequested = false;
  const onAbort = () => { abortRequested = true; run.cancel(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  let result;
  try {
    result = await run;
  } finally {
    // signal 生命周期（整个 workflow）长于单阶段，listener 必须逐阶段摘除
    // 防泄漏（once 只保证触发一次，不保证从已 settled 阶段摘掉引用）
    signal?.removeEventListener('abort', onAbort);
  }

  if (result.status === 'closed') {
    return {
      ok: true,
      sessionId: result.sessionId || null,
      response: result.response ?? '',
      usage: result.usage || null,
      exitCode: 0,
      timedOut: false,
      stderrTail: null,
    };
  }
  // 本阶段 abort 触发的 cancel → 契约 2 的 aborted 条目。若 timeout 先到，
  // killReason 已被占用、终态为 timeout，仍按超时条目处理（中止仅是巧合撞上）
  if (abortRequested && result.status === 'cancelled') {
    return abortedEntry(result.response ?? null);
  }
  // timeout / error / cancelled → ok:false。error 文案由 driver 生成（含恢复
  // 指引）；cancelled 为防御性映射——正常中止路径已在上方转 aborted 条目，
  // 走到这里说明 cancel 来自本层之外的句柄（当前无此调用方）。
  return {
    ok: false,
    sessionId: null,
    response: result.response ?? null,
    usage: null,
    exitCode: null,
    timedOut: result.status === 'timeout',
    error: result.status === 'cancelled'
      ? '阶段被外部取消（cancel）。恢复指引：确认是否被上层主动取消，需要重跑再发起。'
      : result.error,
    stderrTail: null,
  };
}

module.exports = { runPhase };
