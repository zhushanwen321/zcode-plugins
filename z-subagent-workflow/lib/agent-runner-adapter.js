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
 *   agent         → resolver.resolve 路径解析（D-4a：仅 .md 绝对路径，~/ 可
 *                   展开；名字拒——文案与 core agent-registry 同源。缺省走
 *                   resolveDefault = general-purpose 内置角色）
 *   model         → modelRef 原始透传（run 级 $MODEL 已在 worker 层 fallback
 *                   进 per-call opts.model；校验与兜底归 core 引擎 preparer）
 *   engine        → taskCtx.engine（core 路由三层最优先层，U4 接线——之前
 *                   静默不消费）
 *   cwd           → per-call 工作目录；undefined 回落 adapter 绑定的
 *                   fallbackCwd（= 本 run 的 workdir——core RunSpec 无 cwd
 *                   字段，workdir 经 per-run 构造 adapter 闭包传入）
 *   timeoutMs     → taskCtx.timeoutMs（runner-core 计时 abort → core 杀链）
 *   schema        → buildPrompt 契约段 + done 后 jsonout 三级容错提取为
 *                   parsedOutput（core 语义：schema 提供且输出可解析才有）
 *   thinkingLevel / skill / scene / maxTurns / fork / worktree / returnMeta 等
 *                   zsw 通道无对应面，静默不消费（差异清单见 README「回接 2b
 *                   break 变更」节内「workflow agent() opts 差异清单」小节）
 *
 * AbortSignal 契约（对齐 run-phase 旧语义）：启动前 aborted → 直接回
 * AbortError（core 的 dispatchCall 预检分支按 name 判定跳过记错）；运行中
 * abort → handle.cancel()（runner-core 转 AbortSignal → core 杀链），listener
 * 逐 call 摘除防泄漏。zsw runner 无事件流，onEvent 不接（port 可选参）。
 */

const crypto = require('node:crypto');
const coreRef = require('./core-ref');
const { zswCliPath } = require('./config');
const { buildPrompt } = require('./prompt-builder');
const { extractJsonObject } = require('./jsonout');
const { agentFileNotFoundMessage } = require('./agent-discovery');

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
 * @param {object} [opts.resolver]    agent .md 发现（lib/agent-discovery 类或模块，
 *        async resolve 契约——W6a 起 core discoverResources 接线）
 * @param {string} [opts.fallbackCwd] opts.cwd 缺省时的工作目录（= run 的 workdir）
 * @returns {{ run(opts: object, signal: AbortSignal) => Promise<object> }}
 */
function createAgentRunnerAdapter({ runner, resolver, fallbackCwd } = {}) {
  if (!runner || typeof runner.start !== 'function') {
    throw new Error(
      'createAgentRunnerAdapter 需要 runner（zsw RunnerPort，含 start）。'
      + '恢复指引：经 lib/assemble.js 组装注入，勿手工构造。'
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

      // agent .md 解析（D-4a 收紧 + D-4 缺省统一，W6b）：引用唯一形态 = .md
      // 绝对路径（~/ 展开同 core normalizeRef 口径）——名字/相对路径/非 .md 抛
      // invalidAgentRefMessage，路径合法但不可读抛 agentFileNotFoundMessage
      // （V2p C3：ref 归一化与报错文案改直调 vendored core，不再经
      // agent-discovery 薄包装；invalidAgentRefMessage 仍注入 zsw 双出口
      // howToList，错误消息契约与 V1a 后形态逐字一致——agent-discovery 与
      // 本处的 howToList 同文，manager 面薄包装退役归 V3w）。非 string 防御
      // 保留：core normalizeRef/工厂对非 string 抛 TypeError，插件契约回落
      // 可操作报错（String() 化进工厂，旧 zsw 包装同款）。缺省（opts.agent
      // 未传）走 resolveDefault = general-purpose 内置角色（与 pi 侧
      // session-runner 的 DEFAULT_AGENT_NAME 语义对齐；遮蔽序胜者可覆写）。
      // resolver.resolve 是 async（W6a 起 core discoverResources）；sync 注入的
      // resolver 经 await 透明兼容。找不到直接抛——比带着空角色跑完再发现
      // 用错 agent 便宜（manager.start 同款决策）
      let profile = null;
      const res = resolver || require('./agent-discovery');
      if (opts.agent != null && opts.agent !== '') {
        const core = coreRef.requireCore();
        const norm = typeof opts.agent === 'string'
          ? core.normalizeRef(opts.agent, core.AGENT_REF_EXT)
          : null;
        if (norm === null) {
          throw new Error(core.invalidAgentRefMessage(String(opts.agent), {
            howToList: `<available_subagents>, or run node "${zswCliPath()}" agents to list paths`,
          }));
        }
        profile = await res.resolve(norm, cwdBase);
        if (!profile) {
          throw new Error(agentFileNotFoundMessage(norm));
        }
      } else {
        profile = await res.resolveDefault(cwdBase) || null;
      }

      // 三行范式承接（2c 起执行链 = core zcode engine）：模型原始透传（校验归
      // 引擎 preparer），无环境准备步骤（隔离 HOME 池归引擎）
      const modelRef = typeof opts.model === 'string' && opts.model.trim() !== ''
        ? opts.model.trim()
        : (profile && typeof profile.model === 'string' && profile.model.trim() !== '' ? profile.model.trim() : undefined);
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
        timeoutMs: Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : undefined,
        conversation: false,
        // core 路由三层：调用参数 engine 最优先（U4 接线，之前静默不消费）；
        // frontmatter engine 随 profile 透传（agentEngine）
        engine: typeof opts.engine === 'string' && opts.engine.trim() !== '' ? opts.engine.trim() : undefined,
        agentEngine: profile && typeof profile.engine === 'string' && profile.engine.trim() !== ''
          ? profile.engine.trim()
          : undefined,
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
        // release 为 no-op（与 runner-core/ports 契约一致）：appserver 会话由
        // 引擎内部退订，本层无 per-record 释放面——仍按契约统一调用，
        // best-effort，失败不波及结果映射
        try {
          if (typeof runner.release === 'function') await runner.release(handle.exec);
        } catch { /* best-effort */ }
      }
      return toAgentResult(result, { schema: opts.schema });
    },
  };
}

module.exports = { createAgentRunnerAdapter };
