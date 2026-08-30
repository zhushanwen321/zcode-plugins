'use strict';
/**
 * core AgentRunner port → zsw RunnerPort 桥接（回接计划 2b）。
 *
 * core 的 workflow worker 每次调 agent() 都会经 dispatchAgentCall →
 * executeAgentCall → runner.run(opts, signal)，本模块把该调用桥到 zsw
 * 现有执行通道（appserver / spawn，经 ports.createRuntime 组装）。旧
 * lib/workflow/run-phase.js 的「三行范式」调用知识（runner 面向
 * capabilities().kind 分流 + prepareRunEnv 备环境 + start 传最小 taskCtx）
 * 随该文件删除整体吸收进这里——它是阶段执行唯一落点的承接者。
 *
 * 字段映射（core AgentCallOpts → zsw taskCtx）：
 *   prompt        → prompt（经 buildPrompt 拼 agent .md 角色段 + MANDATORY
 *                   schema 契约段——zsw 无进程内 system prompt 通道，与
 *                   manager.start 同一拼装器，两入口不各拼一份）
 *   agent         → resolver.resolve 四根发现（内置资产传入的是 .md 绝对
 *                   路径；名字形态同样兼容）
 *   model         → modelRouter.resolve（run 级 $MODEL 已在 worker 层 fallback
 *                   进 per-call opts.model，到这里必是最终请求值或 undefined）
 *   thinkingLevel → prepareRunEnv sessionOpts.thinking（F4 通道，appserver 落
 *                   create.thoughtLevel，spawn 无通道自动忽略）
 *   cwd           → per-call 工作目录；undefined 回落 adapter 绑定的
 *                   fallbackCwd（= 本 run 的 workdir——core RunSpec 无 cwd
 *                   字段，workdir 经 per-run 构造 adapter 闭包传入）
 *   timeoutMs     → taskCtx.timeoutMs（zsw runner 内部实施超时/宽限杀链）
 *   schema        → buildPrompt 契约段 + done 后 jsonout 三级容错提取为
 *                   parsedOutput（core 语义：schema 提供且输出可解析才有）
 *   skill / scene / engine / maxTurns / fork / worktree / returnMeta 等
 *                   zsw 通道无对应面，静默不消费（差异清单见 README 回接
 *                   说明；engine 路由属 U4）
 *
 * AbortSignal 契约（对齐 run-phase 旧语义）：启动前 aborted → 直接回
 * AbortError（core 的 dispatchCall 预检分支按 name 判定跳过记错）；运行中
 * abort → handle.cancel()（端口内部分流 apc session/stop / spawn 杀进程链），
 * listener 逐 call 摘除防泄漏。zsw runner 无事件流，onEvent 不接（port 可选参）。
 */

const crypto = require('node:crypto');
const { buildPrompt } = require('./prompt-builder');
const { extractJsonObject } = require('./jsonout');

/** zsw usage（snake_case，zcode 引擎原生形态）→ core AgentUsage（camelCase）。 */
function toCoreUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_tokens),
    cacheWrite: num(usage.cache_write_tokens),
    turns: num(usage.turns),
  };
}

/** RunResult → AgentResult。error 仅非 closed 终态携带（core 据此判 call 失败）。 */
function toAgentResult(result, { schema }) {
  const ok = result && result.status === 'closed';
  const content = ok && typeof result.response === 'string' ? result.response : '';
  const agentResult = {
    content,
    usage: ok ? toCoreUsage(result.usage) : undefined,
    sessionId: ok && typeof result.sessionId === 'string' ? result.sessionId : undefined,
  };
  if (ok && schema) {
    // zsw 无 structured-output 工具通道：schema 经 prompt MANDATORY 段约束 +
    // jsonout 容错提取（与 manager 首轮收尾同款两级防线）
    const parsed = extractJsonObject(content);
    if (parsed !== undefined) agentResult.parsedOutput = parsed;
  }
  if (!ok) {
    agentResult.error = (result && result.error) || `阶段执行失败（status=${result ? result.status : 'unknown'}）`;
  }
  return agentResult;
}

function abortError() {
  const err = new Error('Operation aborted before start');
  err.name = 'AbortError';
  return err;
}

/**
 * 构造 core AgentRunner 适配器。
 * @param {object} opts
 * @param {object} opts.runner        zsw RunnerPort（assemble 组装，与 zsub 线共享同一实例）
 * @param {object} opts.modelRouter   ModelRouter（resolve / prepareRunEnv）
 * @param {object} [opts.resolver]    agent .md 四根发现（lib/agent-md-resolver 类或模块）
 * @param {string} [opts.fallbackCwd] opts.cwd 缺省时的工作目录（= run 的 workdir）
 * @returns {{ run(opts: object, signal: AbortSignal) => Promise<object> }}
 */
function createAgentRunnerAdapter({ runner, modelRouter, resolver, fallbackCwd } = {}) {
  if (!runner || typeof runner.start !== 'function') {
    throw new Error(
      'createAgentRunnerAdapter 需要 runner（zsw RunnerPort，含 start）。'
      + '恢复指引：经 lib/assemble.js 组装注入，勿手工构造。'
    );
  }
  if (!modelRouter || typeof modelRouter.prepareRunEnv !== 'function') {
    throw new Error(
      'createAgentRunnerAdapter 需要 modelRouter（含 prepareRunEnv）。'
      + '恢复指引：经 lib/assemble.js 组装注入。'
    );
  }
  const cwdBase = typeof fallbackCwd === 'string' && fallbackCwd !== ''
    ? fallbackCwd
    : process.env.ZCODE_PROJECT_DIR || process.cwd();

  return {
    async run(opts, signal) {
      if (!opts || typeof opts.prompt !== 'string' || opts.prompt === '') {
        throw new Error(
          `AgentRunnerAdapter: opts.prompt 必填（收到 ${JSON.stringify(opts && opts.prompt)}）。`
          + '恢复指引：这是 core worker → runner 的内部契约，检查 workflow 脚本的 agent() 调用。'
        );
      }
      // 契约 1：启动前已中止 → 不做环境准备、不启动（AbortError 让 core 的
      // dispatchCall 预检分支按预期跳过记错）
      if (signal && signal.aborted) throw abortError();

      // agent .md 解析（可选）：内置资产传入绝对路径，用户脚本可传名字。
      // 找不到直接抛——比带着空角色跑完再发现用错 agent 便宜（manager.start 同款决策）
      let profile = null;
      if (opts.agent != null && opts.agent !== '') {
        const resolve = resolver
          || require('./agent-md-resolver');
        profile = resolve.resolve(opts.agent, cwdBase);
        if (!profile) {
          throw new Error(
            `workflow agent() 引用的 agent "${opts.agent}" 未找到（四根发现：项目 .agents/agents > .zcode/agents > HOME 同构两根）。`
            + '恢复指引：检查 agent .md 路径，或先经 zsw agents 查名。'
          );
        }
      }

      // 三行范式（run-phase.js 承接）：kind 阶段级重读 → prepareRunEnv → start
      const kind = runner.capabilities().kind;
      const modelRef = modelRouter.resolve(opts.model, profile ? profile.model : undefined);
      const runEnv = await modelRouter.prepareRunEnv(modelRef, kind, {
        thinking: typeof opts.thinkingLevel === 'string' && opts.thinkingLevel !== ''
          ? opts.thinkingLevel
          : undefined,
      });
      // prepareRunEnv 是 await 点：abort 可能落在窗口内，start 前复查（双检查）
      if (signal && signal.aborted) throw abortError();

      const prompt = buildPrompt({
        agentProfile: profile,
        task: opts.prompt,
        schema: opts.schema,
        skillRefs: profile ? profile.skills : undefined,
      });
      const taskCtx = {
        subagentId: `wfcall-${crypto.randomUUID().slice(0, 8)}`,
        slug: typeof opts.description === 'string' && opts.description !== '' ? opts.description : 'workflow-agent-call',
        prompt,
        cwd: typeof opts.cwd === 'string' && opts.cwd !== '' ? opts.cwd : cwdBase,
        modelRef,
        runEnv,
        timeoutMs: Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : undefined,
        conversation: false,
        disallowedTools: profile && Array.isArray(profile.disallowedTools) ? profile.disallowedTools : undefined,
      };
      const handle = runner.start(taskCtx);

      // 契约 2：运行中 abort → handle.cancel()；listener 逐 call 摘除
      const onAbort = () => handle.cancel();
      signal && signal.addEventListener('abort', onAbort, { once: true });
      let result;
      try {
        result = await handle.done;
      } finally {
        signal && signal.removeEventListener('abort', onAbort);
        // D2 全终态一次性会话释放（apc session/close；spawn no-op）：best-effort，
        // 失败不波及结果映射——泄漏一个驻留会话比炸掉已完成调用好
        try {
          if (typeof runner.release === 'function') await runner.release(handle.exec);
        } catch { /* best-effort */ }
      }
      return toAgentResult(result, { schema: opts.schema });
    },
  };
}

module.exports = { createAgentRunnerAdapter, toAgentResult, toCoreUsage };
