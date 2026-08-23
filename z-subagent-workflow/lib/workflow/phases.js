'use strict';

/**
 * 统一阶段运行器：所有 workflow 的每次 spawn 都经由 run-phase（唯一 driver
 * 入口），这里在其上补一层「阶段条目」包装（phase/label/durationMs），
 * 供 markdown 报告与 JSON 数据共用。
 *
 * 与源插件 dynamic-workflow/lib/phases.js 的差异（合并说明）：
 * - 原 phases.js = 调旧 driver + 包装条目两件事耦合；zsub 里 driver 调用
 *   （含 model-router 的 per-model HOME 池准备与结果映射）拆到 ./run-phase.js，
 *   本模块只保留条目包装职责，导出名 runPhase/shortSession 不变。
 * - runPhase 新增 modelRef 透传参数（zsub 的 HOME 池按模型隔离，旧版无此概念）。
 * - timeoutMs 不再在本层默认 600000：缺省透传，由 driver 落
 *   config.DEFAULTS.timeoutMs（同值，单一权威来源）。
 * - 条目新增 timedOut 字段：report.js 从源版本起就读 p.timedOut 显示
 *   「超时」标记，但旧条目从未赋值（潜伏不一致），本版补齐使标记真正生效。
 * - 透传 signal（AbortSignal 契约见 run-phase.js 头注）：中止条目额外落
 *   aborted:true 字段，供 workflow 编排层识别并停止后续阶段；非中止条目
 *   不带该字段（保持旧形态）。
 */

const { runPhase: execPhase } = require('./run-phase');

/**
 * 运行单个阶段并产出报告条目。
 * @param {object} opts（prompt/cwd/modelRef/timeoutMs/signal 语义见 run-phase.js）
 * @param {string} opts.name  阶段标识（如 'analyze'）
 * @param {string} [opts.label] 人读说明，缺省回落 name
 * @returns {Promise<{phase:string,label:string,ok:boolean,sessionId:string|null,
 *   response:string|null,usage:object|null,timedOut:boolean,durationMs:number,
 *   error?:string,aborted?:true}>}
 */
async function runPhase({ name, label, prompt, cwd, modelRef, timeoutMs, signal }) {
  const started = Date.now();
  const result = await execPhase({ prompt, cwd, modelRef, timeoutMs, signal });
  return {
    phase: name,
    label: label || name,
    ok: result.ok,
    sessionId: result.sessionId || null,
    response: result.response || null,
    usage: result.usage || null,
    timedOut: result.timedOut === true,
    durationMs: Date.now() - started,
    ...(result.error ? { error: result.error } : {}),
    ...(result.aborted ? { aborted: true } : {}),
  };
}

/** 把阶段条目裁剪成报告表格行所需的短 session id。 */
function shortSession(sessionId) {
  if (!sessionId) return '-';
  return sessionId.startsWith('sess_') ? sessionId.slice(5, 17) : sessionId.slice(0, 12);
}

module.exports = { runPhase, shortSession };
