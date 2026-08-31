'use strict';
/**
 * SubagentManager —— zsub 编排内核（DESIGN-v3 §3.1 编排层）。
 *
 * 只依赖构造注入的端口实例（ports.js 契约），不 import 任何 runner/notifier
 * 具体实现（record-store / config 为声明的固定域层依赖，INFO-14 措辞如实化）；
 * prompt-builder 是纯函数（域层，无平台依赖），直接引入不破坏「决策可换」。
 * 更换执行引擎 / 回流通道 / 入口形态（三个正交决策位）时本文件零改动。
 *
 * 数据流（对齐设计 §3.3 七步，bg start + mailbox 主通道）：
 *
 *   MCP tools/call zsub(start)   ← ctx {targetSessionId(取自 _meta, Z3), cwd}
 *                                  （历史形态；现入口 = CLI/daemon socket）
 *    ①  notifyMode 探测：notifier.capabilities().mode
 *        （mailbox|polling；env 探测在 createRuntime，本层只消费）
 *    ②  resolver.resolve(agent, cwd)            agent .md 路径解析（D-4a 收紧：
 *                                               仅绝对路径，名字拒；缺省走
 *                                               resolveDefault = general-purpose）
 *    ③  模型引用原始透传（校验归 core 引擎 preparer，回接 2c）
 *        + promptBuilder.buildPrompt            拼装角色/工具约束/任务/schema/技能（D7）
 *        + worktree.prepare（可选）             任务 cwd 切到隔离目录（D12）
 *        + records.create                       append-only 事件流（D9）
 *    ④  后台执行体（不 await）：slots.acquire（D11 深度分层）→ created→running
 *        → runner.start(taskCtx)（core 引擎经公共 nesting-guard 注入嵌套标记，D10）
 *    ⑤  wait=false 立即返回句柄 {subagentId, status:'running', notify, guidance?}
 *    ⑥  done 回调：outputs.writeResult（worktree 再 collectPatch 回填 patchFile）
 *        → record 终态 closed/error/timeout（conversation 首轮置 idle）→ 释放槽位
 *    ⑦  notifier.notifyCompletion(record, summary)
 *        （mailbox：tmp+rename 原子投递；polling：无操作，靠 ⑤ 的指引兜底）
 *
 * worktree 为何是注入式 noOp：W2-S5（worktree/reaper/CLI）并行开发中，manager
 * 不能硬依赖未交付模块——缺失注入时以 noOpWorktree 占位，prepare 抛可操作
 * 错误（fail-fast，调用方立刻知道「不传 worktree 即可继续」），W3 接线真
 * 实现时 manager 零改动。这是有意的解耦决策，不是遗漏。
 *
 * 与 W1 record-store 状态机的接线：CAS 转移表支持 running→idle，因此
 * conversation 首轮完成走 running→idle + closedReason:'round-complete'——
 * 不是先进 closed 再改 idle（closed 是硬终态无出边，进去就续不了聊）。
 */

const crypto = require('node:crypto');
const config = require('./config');
const { buildPrompt, toolList } = require('./prompt-builder');
const { TERMINAL_STATUSES } = require('./record-store');
const { extractJsonObject } = require('./jsonout');
const {
  normalizeAgentRef, invalidAgentRefMessage, agentFileNotFoundMessage,
} = require('./agent-discovery');

/** 通知文案里 response 的截断长度：mailbox 消息进上下文，500 字符够判断去向。 */
const SUMMARY_HEAD_CHARS = 500;

/**
 * maxTurns → timeoutMs 换算系数（MUST_FIX-3）：对齐 pi watchdog 语义
 * （每 turn 预算 5 分钟）。zcode 无头 CLI 无 turn 计数通道（--max-turns 拒收），
 * 只能以总时长近似「轮数上限」——maxTurns × 5min 作为该任务的超时预算。
 */
const MS_PER_TURN = 300_000;

/**
 * worktree 端口占位实现（缺省兜底：正常接线后不会被命中——server/CLI 注入
 * worktree-adapter 真实现；占位仅保留给「显式不想要 worktree 能力」的组装场景）。
 */
const noOpWorktree = {
  noOp: true,
  async prepare() {
    throw new Error(
      'worktree 能力未注入（组装时未提供 worktree 端口实现）。'
      + '恢复指引：start 时不要传 worktree:true；或检查入口组装是否遗漏 worktree-adapter。'
    );
  },
  async collectPatch() {
    throw new Error(
      'worktree 能力未注入，无法收集 patch。'
      + '恢复指引：prepare 已拒绝 worktree 任务，不应到达此路径；若手动构造了 record 请先 close。'
    );
  },
  // cleanup 刻意不抛：close 的收尾不应被占位端口卡死
  async cleanup() {},
};

class SubagentManager {
  /**
   * @param {object} ports 注入的端口实例（契约见 ports.js）
   * @param {object} [ports.worktree] 缺省 noOpWorktree 占位（见头注）
   */
  constructor(opts = {}) {
    const missing = ['runner', 'modelRouter', 'notifier', 'resolver', 'records', 'outputs', 'slots']
      .filter((k) => !opts[k]);
    if (missing.length > 0) {
      throw new Error(
        `SubagentManager: 缺少端口注入 ${missing.join(', ')}。`
        + '恢复指引：经 ports.createRuntime 或测试夹具组装完整运行时后再构造。'
      );
    }
    this.runner = opts.runner;
    this.modelRouter = opts.modelRouter;
    this.notifier = opts.notifier;
    this.resolver = opts.resolver;
    this.records = opts.records;
    this.outputs = opts.outputs;
    this.slots = opts.slots;
    this.worktree = opts.worktree || noOpWorktree;
    /** subagentId -> RunHandle：cancel 依据。进程重启即丢（recover 路径兜底）。 */
    this.handles = new Map();
    /** subagentId -> 执行体 promise：cancel 时等终态落盘，避免返回早于 record。 */
    this.pending = new Map();
    /** subagentId -> 操作串行链（R2）：message/cancel/close 同 id 并发到达时按
     *  到达序串行执行——daemon socket 面的 handler 并行分发（对照 MCP 面的
     *  tools/call 串行队列），check-then-act 跨 await 段的交错不再可能。 */
    this._locks = new Map();
    this._mode = this.notifier.capabilities().mode;
  }

  // ------------------------------------------------------------- start

  /**
   * 启动一次 subagent 任务。
   * @param {object} params {task, slug, agent?, model?, schema?, worktree?,
   *                         conversation?, wait?, timeoutMs?}
   * @param {object} ctx    {targetSessionId?, cwd} 由入口层传入（MCP：_meta + env）
   */
  async start(params = {}, ctx = {}) {
    const { task, slug } = params;
    if (typeof task !== 'string' || task.trim() === '') {
      throw new Error(
        'start 需要 task（非空字符串）。task 必须自包含：子进程看不到当前会话上下文，'
        + '请把目标、背景、验收标准、关键文件路径全部写进 task。'
      );
    }
    if (typeof slug !== 'string' || slug.trim() === '') {
      throw new Error('start 需要 slug（任务短名，用于通知文案与 worktree 分支命名）。');
    }
    if (typeof ctx.cwd !== 'string' || ctx.cwd.trim() === '') {
      throw new Error(
        'start 需要 ctx.cwd（任务运行目录）。'
        + '恢复指引：入口层应传 ZCODE_PROJECT_DIR 或 process.cwd()。'
      );
    }

    // ② agent 解析（D-4a 收紧 + D-4 缺省统一，W6b）：
    //    - 引用唯一形态 = .md 绝对路径（~/ 展开同 core normalizeRef 口径）。
    //      名字/相对路径/非 .md → invalidAgentRefMessage（与 core agent-registry
    //      的 Invalid agent ref 文案同源——报错同源基准）；路径合法但不可读 →
    //      agentFileNotFoundMessage（core 同款）。找不到立刻报错比带着空角色
    //      跑完再发现用错 agent 便宜。
    //    - 缺省不再无角色裸跑：resolveDefault 解析 general-purpose 内置角色
    //      （遮蔽序胜者，project 级可覆写）；解析面异常退化 null = 诚实裸跑
    //      （record.agent 如实 null）。不想要角色的用户显式传自定义 .md 路径。
    //    resolver.resolve/resolveDefault 是 async（W6a 起 core discoverResources）；
    //    sync 注入的测试 fake resolver 经 await 透明兼容。
    let profile = null;
    if (params.agent != null && params.agent !== '') {
      const norm = normalizeAgentRef(params.agent);
      if (norm === null) {
        throw new Error(invalidAgentRefMessage(params.agent));
      }
      profile = await this.resolver.resolve(norm, ctx.cwd);
      if (!profile) {
        throw new Error(agentFileNotFoundMessage(norm));
      }
    } else {
      profile = await this.resolver.resolveDefault(ctx.cwd) || null;
    }

    // ③ 模型解析链 requested > agent frontmatter > 默认链（2c 起：原始请求透传，
    // 校验与兜底归 core 引擎 preparer——resolveZcodeModelRef 短名/全名/兜底全支持；
    // 默认链产物仅服务 record.model 台账展示，与历史形态一致）
    const modelRef = (typeof params.model === 'string' && params.model.trim() !== ''
      ? params.model.trim()
      : (profile && typeof profile.model === 'string' && profile.model.trim() !== ''
        ? profile.model.trim()
        : this.modelRouter.resolveDefault()));
    const runnerKind = this.runner.capabilities().kind;
    // F4 per-session 能力参数（D5/D6）：thinking 与 CLI 工具限制。2c 后唯一通道是
    // spawn 单轮：无 flag 通道（行为不变），请求值随 record 落盘、终态标注降级
    const thinking = typeof params.thinking === 'string' && params.thinking.trim() !== ''
      ? params.thinking.trim()
      : undefined;
    const allowTools = toolList(params.allowTools);
    const denyTools = toolList(params.denyTools);
    const prompt = buildPrompt({
      agentProfile: profile,
      task,
      schema: params.schema,
      skillRefs: profile ? profile.skills : undefined,
    });

    // worktree 隔离（可选）：成功后任务 cwd 换到隔离目录。
    // subagentId 先于 prepare 生成——worktree 目录/分支名需要它（wt-<id>/zsub/<id>）
    const subagentId = `sa-${crypto.randomUUID().slice(0, 8)}`;
    let runCwd = ctx.cwd;
    let worktreeDir = null;
    let worktreeMeta = null;
    if (params.worktree === true) {
      const wt = await this.worktree.prepare({ slug, subagentId, cwd: ctx.cwd });
      worktreeDir = wt.dir;
      worktreeMeta = { dir: wt.dir, branch: wt.branch, mainRepo: wt.mainRepo };
      runCwd = wt.dir;
    }
    const conversation = params.conversation === true;
    // timeoutMs 决策链（MUST_FIX-3）：显式 params.timeoutMs > profile.maxTurns
    // 换算（×5min，对齐 pi watchdog，见 MS_PER_TURN 注释）> 全局默认。
    // 显式值优先于 agent 约定——调用方带 timeoutMs 即表示覆盖 agent .md。
    const timeoutMs = Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? params.timeoutMs
      : (profile && Number.isFinite(profile.maxTurns) && profile.maxTurns > 0
        ? profile.maxTurns * MS_PER_TURN
        : config.DEFAULTS.timeoutMs);
    const createInit = {
      subagentId,
      slug,
      agent: profile ? profile.name : null,
      model: modelRef,
      targetSessionId: typeof ctx.targetSessionId === 'string' ? ctx.targetSessionId : null,
      runnerKind,
      notifyMode: this._mode,
      conversation,
      timeoutMs,
      worktree: worktreeDir, // 隔离目录路径，close 时 cleanup 依据
      worktreeMeta,          // {dir, branch, mainRepo}：cleanup 参数（适配层消费）
      cwd: ctx.cwd,          // 任务发起目录（诊断 + worktree 兜底定位主仓）
      rounds: 0,
    };
    // schema 是 record 级契约（首轮声明、每轮收尾的提取依据，SUGGESTION-4），
    // 随事件流持久化——resume 轮与崩溃恢复后仍可提取
    if (params.schema !== undefined && params.schema !== null && params.schema !== '') {
      createInit.schema = params.schema;
    }
    // thinking 请求值随创建落盘（F4/D5）：运行中 status 可见请求意图；终态时由
    // _completeRun 覆盖为实际生效标注（生效档位 / null / 'null (请求未生效：引擎通道未映射)'）
    if (thinking !== undefined) {
      createInit.thinking = thinking;
    }
    this.records.create(createInit);

    // taskCtx.disallowedTools：与 CLI toolDenylist 在 runner-core 并集去重后落
    // core 引擎 --disallowed-tools flag（硬约束）；白名单（tools）无 flag 通道，
    // 已由 buildPrompt 拼软约束段。engine（frontmatter）经 taskCtx.agentEngine
    // 进 core 路由三层（V3-①）
    const taskCtx = {
      subagentId, slug, prompt, cwd: runCwd, modelRef, timeoutMs, conversation,
      agentEngine: profile && typeof profile.engine === 'string' && profile.engine.trim() !== ''
        ? profile.engine.trim()
        : undefined,
      disallowedTools: profile && Array.isArray(profile.disallowedTools) ? profile.disallowedTools : undefined,
      thinking,
      toolAllowlist: allowTools.length > 0 ? allowTools : undefined,
      toolDenylist: denyTools.length > 0 ? denyTools : undefined,
    };

    // ④⑤ 后台执行体不 await（wait=true 除外）
    const p = this._runFirstRound(subagentId, taskCtx);
    if (params.wait === true) {
      const fin = await p;
      const finRec = fin.record;
      return {
        subagentId,
        slug,
        status: finRec ? finRec.status : 'error',
        notify: this._notifyLabel(ctx.targetSessionId), // MF6：同 wait=false 句柄语义
        result: fin.result && typeof fin.result.response === 'string' ? fin.result.response : '',
        outputFile: fin.outputFile,
        patchFile: fin.patchFile,
        error: finRec ? finRec.error : null,
        usage: fin.result ? fin.result.usage : null,
        // rounds 完成计数（E3）：wait=true 面与 record 同读——conversation 首轮
        // 成功即 1（终态 idle），失败/取消轮不计
        rounds: finRec ? finRec.rounds : undefined,
        // SUGGESTION-4：schema 提取产物（closed 轮才提取；失败见 schemaParseFailed）
        structured: finRec && finRec.structured !== undefined ? finRec.structured : undefined,
        schemaParseFailed: finRec && finRec.schemaParseFailed === true ? true : undefined,
      };
    }
    // wait=false 后台路径：执行体失败已落 record（error 终态），挂 no-op catch
    // 防 unhandledRejection 击穿 server 进程（同 message() 续聊轮处理）
    p.catch(() => {});
    const handle = {
      subagentId, slug, status: 'running',
      notify: this._notifyLabel(ctx.targetSessionId), // MF6：按实际回流通道而非组装档位
      conversation,
    };
    // polling 档结果不会自动回流（Z5 物理上限），必须当场给轮询指引
    if (this._mode === 'polling' && typeof this.notifier.pollingGuidance === 'function') {
      handle.guidance = this.notifier.pollingGuidance(subagentId);
    }
    return handle;
  }

  // ------------------------------------------------------ list / status

  /** 精简视图：给主 agent 扫一眼用，全量走 status。 */
  list() {
    return this.records.list()
      // recordType 过滤：workflow record（wf- 前缀，N2-a 起写入）不经 zsub 面
      // 露出——双池独立（README 已知边界）；旧 record 无该字段视为 subagent
      .filter((r) => r.recordType === undefined || r.recordType === 'subagent')
      .map((r) => ({
      subagentId: r.subagentId,
      slug: r.slug,
      agent: r.agent === undefined ? null : r.agent,
      model: r.model === undefined ? null : r.model,
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt === undefined ? null : r.endedAt,
      error: r.error === undefined ? null : r.error,
      patchFile: r.patchFile === undefined ? null : r.patchFile,
    }));
  }

  status(id) {
    const rec = this._mustGet(id);
    return { ...rec, outputFile: this.outputs.pathFor(id) };
  }

  // ------------------------------------------------------------- message

  /**
   * 同 id 操作串行化（R2）：fn 排在 id 现有链尾执行；链尾吞掉前驱 rejection
   * （失败不堵后续操作），链空时自清。返回 fn 自身的 promise（rejection 透传
   * 给调用方）。不同 id 互不阻塞。
   */
  _withLock(id, fn) {
    const prev = this._locks.get(id) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this._locks.set(id, tail);
    tail.then(() => { if (this._locks.get(id) === tail) this._locks.delete(id); });
    return run;
  }

  /**
   * 向 conversation 任务投递续聊消息（仅 idle 可投递，busy 语义对齐 spawn 单轮）。
   * 不等待本轮完成（与 start 后台语义一致），完成后再通知。
   * 同 id 并发安全经 _withLock（R2）。
   */
  async message(id, text) {
    return this._withLock(id, () => this._messageLocked(id, text));
  }

  async _messageLocked(id, text) {
    const rec = this._mustGet(id);
    if (rec.conversation !== true) {
      throw new Error(
        `subagent "${id}" 不是 conversation 任务（start 时未传 conversation:true），不支持续聊。`
        + '恢复指引：需要多轮交互请重新 start 并声明 conversation:true。'
      );
    }
    if (rec.status === 'running' || rec.status === 'created') {
      // A-9：busy 报错必须给两条出路（等待 / 取消）且命令完整可执行——
      // config.zswCliPath 绝对路径形态（marketplace/inline 下裸 `zsw` 不在
      // PATH，主 agent cwd 是项目目录，照抄短命令即 ENOENT）
      return {
        busy: true,
        message: `该 subagent 正在运行，仅 idle 状态可投递。`
          + `等待当前轮完成（node "${config.zswCliPath()}" wait --id ${id}）`
          + `或 node "${config.zswCliPath()}" cancel --id ${id} 取消后再投递`,
      };
    }
    if (rec.status !== 'idle') {
      throw new Error(
        `subagent "${id}" 当前状态 ${rec.status}，仅 idle 可投递。`
        + '恢复指引：status 查看详情；终态任务请重新 start。'
      );
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error('message 需要 text（非空字符串，续聊消息内容）。');
    }
    // CAS 同步占位：running 期间后续 message 走 busy 分支，天然单轮在飞。
    // rounds 计数统一在 _completeRun 收尾时 +1（完成计数语义：首轮 done → 1，
    // 续聊轮 done → 2）；此处只返回「即将开始的轮号」，不预置写盘——预置会让
    // 失败轮虚增计数，且与 _completeRun 的 +1 双计。
    this.records.transition(id, 'idle', 'running');
    const round = (rec.rounds || 0) + 1;
    const p = this._runResumeRound(id, text);
    p.catch(() => {}); // 错误已落 record（error 终态），后台路径不产生 unhandledRejection
    // notify 语义同 start 句柄（MF6）：targetSessionId 取 record（create 时已随
    // ctx 落盘，null = 无回流通道）——续聊轮与首轮句柄不漂移
    return { subagentId: id, status: 'running', round, notify: this._notifyLabel(rec.targetSessionId) };
  }

  // ------------------------------------------------------- cancel / close

  async cancel(id) {
    return this._withLock(id, () => this._cancelCore(id));
  }

  async _cancelCore(id) {
    const rec = this._mustGet(id);
    if (TERMINAL_STATUSES.has(rec.status)) {
      return { subagentId: id, status: rec.status, cancelled: false, note: '已是终态，无需取消' };
    }
    const handle = this.handles.get(id);
    if (handle) {
      // 有句柄：杀进程 → done 落 cancelled → 执行体完成终态落盘；等它再返回，
      // 保证 cancel 响应里的 status 与 record 一致（端口契约保证 cancel 必然
      // 唤醒 done：core 引擎杀链 SIGTERM→grace→SIGKILL）
      handle.cancel();
      const pending = this.pending.get(id);
      if (pending) await pending.catch(() => {});
      return { subagentId: id, status: this.records.get(id).status, cancelled: true };
    }
    // 无句柄：created（排队中）/ idle（轮间无进程）/ lost | running（server 重启后，
    // record 仍在 running 但句柄随进程内存丢失——两者都要注明进程可能残留）
    const note = rec.status === 'created'
      ? '排队中被取消，进程未启动'
      : (rec.status === 'idle'
        ? 'idle 会话无进程，直接终态化'
        : '句柄丢失（server 重启），进程可能残留；确认请 ps 检查后手工清理');
    this.records.transition(id, rec.status, 'cancelled', { closedReason: note });
    return { subagentId: id, status: 'cancelled', cancelled: true, note };
  }

  async close(id) {
    return this._withLock(id, () => this._closeLocked(id));
  }

  async _closeLocked(id) {
    let rec = this._mustGet(id);
    if (!TERMINAL_STATUSES.has(rec.status)) {
      if (this.handles.has(id)) {
        await this._cancelCore(id); // 运行中：借取消链杀进程 + 终态落盘（同锁内直调，避免重入自等）
      } else {
        const note = rec.status === 'lost'
          ? 'closed（句柄丢失，进程可能残留）'
          : 'closed-by-user';
        this.records.transition(id, rec.status, 'closed', { closedReason: note });
      }
      rec = this.records.get(id);
    }
    // worktree 清理失败不回滚终态（任务已完成），错误显式进返回值与 record
    let worktreeCleaned = null;
    if (rec.worktree) {
      try {
        await this.worktree.cleanup({
          dir: rec.worktree,
          subagentId: id,
          meta: rec.worktreeMeta,
        });
        worktreeCleaned = true;
        this.records.update(id, { worktreeCleaned: true });
      } catch (e) {
        worktreeCleaned = false;
        this.records.update(id, { worktreeCleaned: false, worktreeError: String(e && e.message || e) });
      }
    }
    const fin = this.records.get(id);
    return {
      subagentId: id,
      status: fin.status,
      worktreeCleaned,
      worktreeError: fin.worktreeError === undefined ? null : fin.worktreeError,
    };
  }

  // ------------------------------------------------------------- recover

  /**
   * 启动恢复（server 重启入口）：重建 record 索引 + 对非终态逐条探活。
   * W1 设计：rebuildFromLog 把非终态标 lost（内存标记，不落盘，幂等收敛）；
   * 这里补语义——探活死进程补 lostReason 说明，活进程标 orphan（句柄已丢、
   * 无法重挂 done 回调，建议 cancel 后重发）。lost 不写 transition 事件：
   * lost→lost 不在 CAS 合法转移表内，且 rebuild 本身幂等，落盘无增益。
   */
  async recover() {
    const rebuild = this.records.rebuildFromLog();
    const dead = [];
    const orphan = [];
    for (const rec of this.records.list()) {
      if (TERMINAL_STATUSES.has(rec.status)) continue; // 终态无需探活
      // recordType 过滤（与 list() 同款）：共享 store 时 workflow record 不进
      // subagent 探活循环——wf record 无 exec 字段会被误判死进程并写入
      // subagent 语义的 lostReason update 事件（事件流 append-only，永久污染）
      if (rec.recordType !== undefined && rec.recordType !== 'subagent') continue;
      // alive 契约为同步 boolean（ports.js RunnerPort；runner-core 按 exec 形态
      // 分支：spawn = pid 探活、appserver 形态 = 引擎语义保守判定）——此处
      // await 为防御未来异步实现，同步值 await 无害
      const alive = rec.exec ? await this.runner.alive(rec.exec) : false;
      if (alive) {
        orphan.push(rec.subagentId);
        // appserver 形态的 alive 是保守判定（core 未暴露任务级探活面，见
        // runner-core.alive 注释）——文案如实区分「进程在跑」与「进度未知」
        const appserverExec = rec.exec && rec.exec.kind === 'appserver';
        this.records.update(rec.subagentId, {
          orphan: true,
          lostReason: appserverExec
            ? '孤儿会话：server 重启丢失句柄（appserver 常驻模式，任务进度未知——保守按存活处置），结果无法回流。建议 cancel 后重发任务'
            : '孤儿进程：server 重启丢失句柄，进程仍在运行，结果无法回流。建议 cancel 后重发任务',
        });
      } else {
        dead.push(rec.subagentId);
        // dead 标记是 wait 的收敛依据（R2）：探活已死的 lost 永无外部推进，
        // wait-handler 据此立即收编，防无 timeout 挂死。内存字段，不落盘
        // 语义与 lost 相同（重启后 rebuild 重探活，幂等）。
        this.records.update(rec.subagentId, {
          dead: true,
          lostReason: '进程已死（探活失败）：server 停机期间退出，终态未落盘，结果可能不完整。建议重新 start',
        });
      }
    }
    return { rebuild, dead, orphan };
  }

  // ------------------------------------------------- 内部：轮执行体

  /** 首轮：占 pending（cancel 等待用），完成后清理句柄表。 */
  _runFirstRound(id, taskCtx) {
    const p = this._execRound(id, { kind: 'first', taskCtx })
      .finally(() => { this.pending.delete(id); this.handles.delete(id); });
    this.pending.set(id, p);
    return p;
  }

  /**
   * 续聊轮：resume 句柄经 onHandle 挂入 handles（S-6① 接线，取消可杀轮进程，
   * 同 start 的 pending 句柄管理）；runner 无句柄时维持无句柄路径。
   */
  _runResumeRound(id, text) {
    const p = this._execRound(id, { kind: 'resume', text })
      .finally(() => { this.pending.delete(id); this.handles.delete(id); });
    this.pending.set(id, p);
    return p;
  }

  async _execRound(id, plan) {
    let release;
    try {
      release = await this.slots.acquire(this._depth());
      const cur = this.records.get(id);
      const expectStatus = plan.kind === 'first' ? 'created' : 'running';
      if (!cur || cur.status !== expectStatus) {
        // 排队期间被 cancel/close：终态已定，不再启动进程（槽位照常释放）
        return { record: cur, result: null, outputFile: null, patchFile: null };
      }
      let result;
      if (plan.kind === 'first') {
        // exec 异步回填的持久化通道（A5 修复）：runner（core 引擎）返回的 exec
        // 是可变引用——pid 在 spawn 后、sessionId 在 done 后才回填，而 running
        // 转换事件序列化于 spawn 之前（无 pid）。不补落盘的话 standby 从磁盘
        // rebuild 后 alive 探活无依据，孤儿进程被误判 dead。经 onExec 钩子在
        // 字段就绪时追加 update 事件，磁盘 exec 与内存保持同步。
        // created 期（transition 前）暂存：update 若先于 running 事件落盘，
        // 会被转换事件携带的旧 exec 覆盖（append-only 按序重放），transition
        // 后立即 flush。当前 runner 的首次 onExec 必在 routeEngine 异步段，
        // 天然晚于同步的 transition——暂存是对未来同步回调实现的防御。
        let stagedExec = null;
        const handle = this.runner.start(plan.taskCtx, {
          onExec: (snapshot) => {
            const cur0 = this.records.get(id);
            if (cur0 && cur0.status === 'created') { stagedExec = snapshot; return; }
            this.records.update(id, { exec: snapshot });
          },
        });
        this.handles.set(id, handle);
        // exec 随 running 事件持久化（此刻无 sessionId；done 后由 _completeRun
        // 重写回填版——重启后 resume 依赖它）
        this.records.transition(id, 'created', 'running', { exec: handle.exec });
        if (stagedExec !== null) this.records.update(id, { exec: stagedExec });
        try {
          result = await handle.done;
        } finally {
          this.handles.delete(id);
        }
      } else {
        // resume 句柄接线（S-6①）：两层取法——①onHandle（SpawnRunner 轮启动
        // 后同步回调 {pid, cancel}）；②onHandle 未触发时兜底看返回 promise
        // 自带的 cancel（runner-spawn 的 resume 双取法同款）。挂入 handles
        // 让 cancel 能杀轮进程（SIGTERM→SIGKILL 链）。appserver 形态的
        // resume 是 async 无句柄（多余参数被忽略、promise 无 cancel 属性）
        // ——两层都取不到时维持无句柄路径（终态化 record + 注明进程可能残留）。
        let handleSet = false;
        const run = this.runner.resume(
          cur.exec,
          plan.text,
          { timeoutMs: cur.timeoutMs },
          (h) => {
            if (h && typeof h.cancel === 'function') {
              handleSet = true;
              this.handles.set(id, { pid: h.pid, cancel: () => h.cancel() });
            }
          },
        );
        if (!handleSet && run && typeof run.cancel === 'function' && typeof run.then === 'function') {
          this.handles.set(id, { pid: run.pid, cancel: () => run.cancel() });
        }
        result = await run;
      }
      const record = await this._completeRun(id, result, {
        conversation: cur.conversation === true,
        // F4/D5：thinking 请求值随首轮下行——终态标注的判定依据（resume 轮无
        // create 面，会话级设置随会话驻留，不改写首轮标注）
        thinkingRequested: plan.kind === 'first' ? plan.taskCtx.thinking : undefined,
        // F4/D6（G6 标注面对称）：CLI 工具限制中 allow 侧请求值随首轮下行——
        // spawn 单轮通道无白名单 flag 通道，请求了 allowlist 即终态落
        // toolsNote 如实标注；deny 侧并集落引擎 --disallowed-tools 硬生效
        // （runner-core mergeDenyTools），无失效面，不参与标注判定
        toolsRequested: plan.kind === 'first'
          ? Boolean(plan.taskCtx.toolAllowlist)
          : undefined,
      });
      return { record, result, outputFile: record.outputFile, patchFile: record.patchFile === undefined ? null : record.patchFile };
    } catch (err) {
      // 兜底：未预期异常也要把 record 从活跃态救出，否则悬挂 running 永远占语义
      const cur = this.records.get(id);
      if (cur && !TERMINAL_STATUSES.has(cur.status) && cur.status !== 'lost') {
        try {
          this.records.transition(id, cur.status, 'error', { error: String(err && err.message || err) });
        } catch { /* CAS 竞态：另一路径（如 cancel）已终态化，尊重先到者 */ }
      }
      throw err; // wait=true 路径要看到失败原因
    } finally {
      if (release) release();
    }
  }

  /** done 之后的统一收尾：落盘 → 终态转移 → 通知。 */
  async _completeRun(id, result, { conversation, thinkingRequested, toolsRequested } = {}) {
    const status = ['closed', 'timeout', 'cancelled'].includes(result && result.status)
      ? result.status
      : 'error';
    const response = result && typeof result.response === 'string' ? result.response : '';
    // error/timeout/cancelled 也落盘：尾部输出是诊断依据，不该只活在日志里
    const outputFile = this.outputs.writeResult(
      id,
      response !== '' ? response : `【未完成 ${status}】${(result && result.error) || '无输出'}`
    );

    // worktree patch 收集：失败不阻断终态（任务结果已到手），错误显式进 record。
    // collectPatch 由适配层直接落盘 outputs/<id>.patch 并返回路径（产出方唯一）
    const before = this.records.get(id);
    let patchFile = before.patchFile === undefined ? null : before.patchFile;
    if (before.worktree) {
      try {
        const p = await this.worktree.collectPatch({ dir: before.worktree, subagentId: id });
        if (typeof p === 'string') patchFile = p;
      } catch (e) {
        this.records.update(id, { patchError: String(e && e.message || e) });
      }
    }

    const to = status === 'closed' ? (conversation ? 'idle' : 'closed') : status;
    const closedReason = status === 'closed'
      ? (conversation ? 'round-complete' : 'completed')
      : (status === 'cancelled' ? 'cancelled-by-user' : status);

    // schema 提取（SUGGESTION-4，对照表 #12 兑现）：record 声明了非空 schema 且
    // 本轮成功（closed）才提取——error/timeout/cancelled 的尾部输出不是模型
    // 最终回复，提取无意义。成功进 record.structured（与终态原子落盘，同
    // rounds 的防崩溃中间态理由）；失败落 schemaParseFailed:true——只标记不
    // 改终态：契约违反是质量问题不是运行故障，全文已在 outputs 供人工/主
    // agent 兜底解析。
    const hasSchema = before.schema !== undefined && before.schema !== null && before.schema !== '';
    let structured = null;
    let schemaParseFailed = false;
    if (status === 'closed' && hasSchema && response !== '') {
      structured = extractJsonObject(response);
      if (structured === null) schemaParseFailed = true;
    }

    // F4/D5 thinking 标注：runner 回填优先（生效档位 string / 非法跳过 null）；
    // 请求了但 runner 无回填时按「请求未生效：引擎通道未映射」如实标注（不绑定
    // 引擎形态）；未请求不落字段。**仅在应改写时
    // 携带键**：record-store 内存 fold 是 Object.assign（undefined 会覆盖既有
    // 值，与 JSON 落盘面的 undefined-丢弃不同）——resume 轮不携带键才能保住
    // 首轮标注（thinking 是会话级设置，随会话驻留）
    const transitionPatch = {
      closedReason,
      error: result ? result.error : undefined,
      // F1 移交（D3）：protocol-drift 分类以独立字段落 record——错误类别可查询，
      // 不必从 error 文案反推（2c 后 core 引擎错误不经 JSON-RPC 通道，该字段
      // 仅旧 record 兼容读取面存在）
      errorKind: result ? result.errorKind : undefined,
      sessionId: (result && result.sessionId) || before.sessionId,
      tokens: (result && result.usage) || before.tokens,
      // 引擎留痕（V3-①③，2c 新增 optional 字段）：实际执行引擎 id 与 probe
      // 失败 fallback 事实随终态原子落盘，status 可查、GUI 可警示
      engine: (result && result.engineId) || before.engine,
      engineFallback: (result && result.engineFallback) || before.engineFallback,
      // rounds 完成计数：成功收尾的轮 +1（首轮 0→1，续聊轮 1→2）；失败/取消轮
      // 不计（「成功完成的轮数」语义，与 E3 验收「两轮后 rounds=2」对齐）。
      // 放在 transition patch 里与终态原子落盘，避免「先 update 后 transition」
      // 两事件在崩溃恢复重放时出现中间态。
      rounds: status === 'closed' ? (before.rounds || 0) + 1 : (before.rounds || 0),
      // exec 重写持久化：spawn 语义是 done 后回填 exec.sessionId，而 running
      // 转移事件序列化于 done 之前——不重写的话重启后 resume 句柄丢失
      exec: before.exec,
      outputFile,
      patchFile,
      structured: structured !== null ? structured : undefined,
      schemaParseFailed: schemaParseFailed ? true : undefined,
    };
    if (result && result.thinking !== undefined) {
      transitionPatch.thinking = result.thinking;
    } else if (thinkingRequested !== undefined) {
      // 请求了但 runner 无回填 = 请求值未被引擎通道映射（不绑定引擎形态——
      // 旧「spawn 降级」归因在缺省常驻形态下失真；旧 record 的 null 值仍可读）
      transitionPatch.thinking = 'null (请求未生效：引擎通道未映射)';
    }
    // F4/D6 工具限制标注（G6 与 thinking 标注面对称，同款「仅在应标注时携带
    // 键」纪律）：toolsRequested 已收紧为仅 allowlist 存在——deny-only 在
    // runner-core 并入引擎 --disallowed-tools 硬约束生效，落「未生效」标注
    // 就是失真（缺标注可容忍，错标注不可容忍）；allow 白名单无引擎 flag 通道
    // = 请求未映射，落 toolsNote 如实标注
    if (toolsRequested && before.runnerKind !== 'appserver') {
      transitionPatch.toolsNote = 'null (工具限制未生效：引擎通道未映射)';
    }
    this._transitionOrSkip(id, 'running', to, transitionPatch);

    // 完成通知：cancelled 是调用方主动行为（cancel 响应已回），不再通知。
    // 门卫同时看 record 当前终态：cancel 走无句柄路径已把 record 终态化为
    // cancelled 后，迟到的 done（resume 轮自然完成）不得再补发通知（S-6②）
    const curNotify = this.records.get(id);
    if (status !== 'cancelled' && !(curNotify && curNotify.status === 'cancelled')) {
      const final0 = this.records.get(id);
      const summary = this._buildSummary(final0, { ...result, status }, outputFile, patchFile || undefined);
      try {
        const r = await this.notifier.notifyCompletion(final0, summary);
        if (r && r.delivered) {
          this.records.update(id, { notified: true });
        } else {
          this.records.update(id, {
            notified: false,
            notifyNote: '投递未命中（无有效 targetSessionId 或 polling 档），结果需主动 status 查询',
          });
        }
      } catch (e) {
        // 通知失败不能波及终态（record 已落盘）；失败原因留档可查
        this.records.update(id, { notified: false, notifyError: String(e && e.message || e) });
      }
    }
    return this.records.get(id);
  }

  /** transition 的取消竞态容忍：轮中被 cancel（终态已定）时跳过而非炸穿执行体。 */
  _transitionOrSkip(id, from, to, patch) {
    try {
      return this.records.transition(id, from, to, patch);
    } catch (e) {
      const cur = this.records.get(id);
      if (cur && cur.status === 'cancelled') return cur;
      throw e;
    }
  }

  /**
   * 通知文案（P3 教训：必须含全文指针；worktree 必须含 patch + git apply 指引）。
   */
  _buildSummary(record, result, outputFile, patchFile) {
    const slug = record.slug;
    if (result.status === 'closed') {
      const text = typeof result.response === 'string' ? result.response : '';
      const head = text.slice(0, SUMMARY_HEAD_CHARS);
      const ellipsis = text.length > SUMMARY_HEAD_CHARS ? '…' : '';
      let s = `[subagent 完成] slug=${slug}。结果：${head}${ellipsis}\n全文: ${outputFile}`;
      // schema 契约回执（SUGGESTION-4）：主 agent 据此决定直接消费 structured
      // 还是自行解析全文——两种结局都明说，不留给调用方猜测
      if (record.structured !== undefined && record.structured !== null) {
        s += `\n已提取结构化输出（status 查询 structured 字段）`;
      } else if (record.schemaParseFailed === true) {
        s += `\n注意: 输出未符合 schema 契约（jsonout 提取失败），全文见上方 outputs 路径`;
      }
      if (patchFile) {
        s += `\n改动 patch: ${patchFile}`;
        s += `\n应用指引: 在主仓库根目录执行 git apply ${patchFile}（先 review 再应用）`;
      }
      return s;
    }
    const kind = result.status === 'timeout' ? '超时' : '失败';
    const reason = (result.error || '未知错误（stdout 无有效输出）');
    let s = `[subagent ${kind}] slug=${slug}。原因: ${reason}\n`
      + `恢复指引: 修正任务描述或调大 timeoutMs 后重新 start；输出尾部与诊断已存 ${outputFile}`;
    if (patchFile) s += `\n改动 patch（可能不完整）: ${patchFile}`;
    return s;
  }

  /**
   * 句柄 notify 字段（MF6 语义修正）：按「实际回流通道」而非组装档位输出。
   * mailbox 档但无 targetSessionId（socket/CLI 面恒无——D6 无会话定向，ctx
   * 落进 record 的 targetSessionId 为 null）时完成通知必 delivered:false，
   * 写 'none'（无回流通道，等待走 CLI wait）——写 'mailbox' 会误导「会自动
   * 回流」。polling 档无通道语义差异，恒 'polling'（guidance 已附轮询指引）。
   * mailbox + 有 target（MCP 面遗留：工具面 1.0.0 起恒拒不可达，但保持逻辑
   * 完备）仍 'mailbox'。
   */
  _notifyLabel(targetSessionId) {
    if (this._mode !== 'mailbox') return this._mode;
    return typeof targetSessionId === 'string' && targetSessionId !== '' ? 'mailbox' : 'none';
  }

  _mustGet(id) {
    const rec = this.records.get(id);
    if (!rec) {
      throw new Error(`subagent "${id}" 不存在。恢复指引：用 list 查看全部任务 id。`);
    }
    // recordType 校验（与 WorkflowManager._mustGet 对称，WorkflowManager 已退役）：
    // workflow record 不经 zsub 面读写——cancel/close 的 transition 语义会越界
    // 落 wf record 终态。旧 record 无该字段视为 subagent。
    if (rec.recordType !== undefined && rec.recordType !== 'subagent') {
      throw new Error(
        `"${id}" 是 ${rec.recordType} record，不经 zsub action 操作。`
        + `恢复指引：wf- 前缀的 runId 请用 CLI \`node "${config.zswCliPath()}" workflow --action abort|status --id <runId>\``
        + '（管理面默认经 daemon，--local 本地）。'
      );
    }
    return rec;
  }

  /** 嵌套深度（D11）：本 server 若运行在嵌套环境（ZSW_NESTED=1 或
   *  XYZ_AGENT_SUBAGENT=1，config.isNestedEnv 判定），子任务算 depth 1。 */
  _depth() {
    return config.NESTED ? 1 : 0;
  }
}

module.exports = { SubagentManager, noOpWorktree };
