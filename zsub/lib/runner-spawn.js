'use strict';
/**
 * RunnerPort 的 spawn 实现（DESIGN-v3 D3：MVP 主力执行引擎）。
 *
 * 每轮对话 = 一个独立 `zcode --json` 进程（经 lib/driver.js），冷启动
 * ~1-2s 如实声明（capabilities.coldStartMs）；running 中无法投递消息
 * （steering:'none'，busy 语义）——续聊走 --resume 冷路径。
 *
 * exec 句柄（存入 record.exec，manager 不解读）：
 *   {kind:'spawn', pid, sessionId?, home, cwd}
 *   - pid：首轮进程 pid（结束后探活 false；崩溃恢复用）
 *   - sessionId：首轮 done 后回填（可变引用），--resume 续聊依据
 *   - home/cwd：resume 轮需要同一隔离 HOME 与运行目录，随句柄持久化，
 *     server 重启后从 record 重建仍可续聊
 *
 * stdout 有界收集（头部 4KB + 尾部 64KB）在 driver 层实现——子进程流
 * 由 driver 持有，runner 只消费 RunResult。
 */

const config = require('./config');
const driver = require('./driver');

class SpawnRunner {
  /** spawn 无协议握手依赖（对比 appserver 需探协议往返），恒可用。 */
  async probe() {
    return { ok: true };
  }

  capabilities() {
    return {
      kind: 'spawn',
      steering: 'none',   // 无头 CLI 单轮语义：running 中无法追加消息
      coldStartMs: 1500,  // 每轮一次完整 node 进程 + CLI 启动
    };
  }

  /**
   * 启动一次任务（立即返回，不等待完成）。
   * @param {TaskCtx} taskCtx 需额外携带 runEnv（manager 调 prepareRunEnv 的
   *                           返回值）——HOME 从 taskCtx.runEnv.env.HOME 取。
   * @returns {{exec: object, cancel: function(): void, done: Promise<RunResult>}}
   */
  start(taskCtx) {
    const home = taskCtx?.runEnv?.env?.HOME;
    if (!home) {
      throw new Error(
        'SpawnRunner.start: taskCtx.runEnv.env.HOME 缺失。' +
        '恢复指引：manager 必须先调 ModelRouter.prepareRunEnv(taskCtx.modelRef, "spawn")，' +
        '并把返回的 {env} 放入 taskCtx.runEnv——否则子进程会落到真实 ~/.zcode，污染用户配置。'
      );
    }
    const run = driver.runHeadless({
      home,
      cwd: taskCtx.cwd,
      prompt: taskCtx.prompt,
      timeoutMs: taskCtx.timeoutMs ?? config.DEFAULTS.timeoutMs,
      env: taskCtx.runEnv.env,
    });

    const exec = { kind: 'spawn', pid: run.pid, sessionId: undefined, home, cwd: taskCtx.cwd };
    const done = Promise.resolve(run).then((result) => {
      // sessionId 回填：exec 是可变引用，record 持同一对象，
      // done 之后 manager / resume 读 exec.sessionId 即续聊句柄
      if (result.sessionId) exec.sessionId = result.sessionId;
      return result;
    });

    return {
      exec,
      cancel: () => { run.cancel(); }, // SIGTERM → killGraceMs → SIGKILL，终态 cancelled
      done,
    };
  }

  /**
   * 续聊一轮：--resume <sessionId> --prompt <message>。
   * 不重建 HOME（首轮的隔离 HOME 随 exec.home 持久化）。
   * @param {object} exec record.exec（须首轮已完成，sessionId 已回填）
   * @param {string} message 续聊消息文本
   * @param {object} [opts] {timeoutMs?, cwd?}
   * @returns {Promise<RunResult>} 成功时 status='closed'
   */
  async resume(exec, message, opts = {}) {
    if (!exec || exec.kind !== 'spawn' || typeof exec.sessionId !== 'string' || !exec.sessionId) {
      throw new Error(
        `SpawnRunner.resume: 需要已完成首轮的 spawn 句柄（exec.kind==="spawn" 且 exec.sessionId 已回填）。` +
        `收到 ${JSON.stringify(exec && { kind: exec.kind, hasSessionId: Boolean(exec.sessionId) })}。` +
        `恢复指引：等待首轮 done 后再续聊；跨 runner 的句柄不可混用。`
      );
    }
    if (!exec.home) {
      throw new Error(
        'SpawnRunner.resume: exec.home 缺失（旧版 record 句柄无 HOME 信息）。恢复指引：重新 start 一轮新任务。'
      );
    }
    return driver.runHeadless({
      home: exec.home,
      cwd: opts.cwd || exec.cwd,
      prompt: message,
      resumeSessionId: exec.sessionId,
      timeoutMs: opts.timeoutMs ?? config.DEFAULTS.timeoutMs,
    });
  }

  /**
   * 探活：pid 信号 0 探测（ESRCH → 不存在；EPERM → 存在但属主不同，按存在算）。
   */
  alive(exec) {
    if (!exec || exec.kind !== 'spawn' || !Number.isInteger(exec.pid)) return false;
    try {
      process.kill(exec.pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  }
}

module.exports = SpawnRunner;
