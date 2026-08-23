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
 */

const ModelRouter = require('../model-router');
const driver = require('../driver');

// INFO-17：prepareRunEnv 的 per-model 互斥链（poolMutex）是模块级 Map
// （model-router.js），多实例共享同一条链——同模型的并发阶段天然排队走同链
// （防 bootstrap 交错），不依赖此处是否单例。ModelRouter 本身无解析状态，
// 模块级单例只为避免各处重复构造。
const modelRouter = new ModelRouter();

/**
 * 运行单个阶段（= 一次 zcode 无头 session）。
 * @param {object} opts
 * @param {string} opts.prompt      完整阶段 prompt
 * @param {string} opts.cwd         阶段运行目录
 * @param {string} opts.modelRef    已 resolve 的模型全名（provider/model）
 * @param {number} [opts.timeoutMs] 缺省由 driver 落 config.DEFAULTS.timeoutMs
 * @returns {Promise<{ok:boolean, sessionId:string|null, response:string|null,
 *   usage:object|null, exitCode:number|null, timedOut:boolean,
 *   error?:string, stderrTail:null}>}
 */
async function runPhase({ prompt, cwd, modelRef, timeoutMs }) {
  if (!modelRef || typeof modelRef !== 'string') {
    throw new Error(
      `runPhase: modelRef 必填（收到 ${JSON.stringify(modelRef)}）。` +
      '恢复指引：先经 ModelRouter.resolve() 得到模型全名再调用。'
    );
  }
  const { env } = await modelRouter.prepareRunEnv(modelRef, 'spawn');
  const result = await driver.runHeadless({ home: env.HOME, cwd, prompt, timeoutMs });

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
  // timeout / error / cancelled → ok:false。error 文案由 driver 生成（含恢复
  // 指引）；cancelled 为防御性映射——当前调用面未暴露 cancel 句柄，后续批次
  // 若加取消能力无需改这里的消费方。
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
