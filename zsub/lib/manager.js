'use strict';
/**
 * SubagentManager —— zsub 编排内核（DESIGN-v3 §3.1 编排层）。
 *
 * 只依赖构造注入的端口实例（ports.js 契约），不 import 任何端口具体实现；
 * prompt-builder 是纯函数（域层，无平台依赖），直接引入不破坏「决策可换」。
 * 更换执行引擎 / 回流通道 / 入口形态（三个正交决策位）时本文件零改动。
 *
 * 数据流（对齐设计 §3.3 七步，bg start + mailbox 主通道）：
 *
 *   MCP tools/call zsub(start)   ← ctx {targetSessionId(取自 _meta, Z3), cwd}
 *    ①  notifyMode 探测：notifier.capabilities().mode
 *        （mailbox|polling；env 探测在 createRuntime，本层只消费）
 *    ②  resolver.resolve(agent, cwd)            四根 agent .md 发现（D6）
 *    ③  modelRouter.resolve + prepareRunEnv     模型链解析 + 隔离 HOME（D5）
 *        + promptBuilder.buildPrompt            拼装角色/任务/schema/技能（D7）
 *        + worktree.prepare（可选）             任务 cwd 切到隔离目录（D12）
 *        + records.create                       append-only 事件流（D9）
 *    ④  后台执行体（不 await）：slots.acquire（D11 深度分层）→ created→running
 *        → runner.start(taskCtx)（spawn 侧由 driver 注入 ZSUB_NESTED=1，D10）
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
const { buildPrompt } = require('./prompt-builder');
const { TERMINAL_STATUSES } = require('./record-store');

/** 通知文案里 response 的截断长度：mailbox 消息进上下文，500 字符够判断去向。 */
const SUMMARY_HEAD_CHARS = 500;

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

    // ② agent 解析（可选）：找不到立刻报错比带着空角色跑完再发现用错 agent 便宜
    let profile = null;
    if (params.agent != null && params.agent !== '') {
      profile = this.resolver.resolve(params.agent, ctx.cwd);
      if (!profile) {
        throw new Error(
          `未找到 agent "${params.agent}"（四根发现：项目 .agents/agents > .zcode/agents，`
          + '再到 HOME 下同名两根；支持名字或 ./ 相对路径 / 绝对路径）。'
          + '恢复指引：检查名字拼写，或改用 agent .md 的绝对路径。'
        );
      }
    }

    // ③ 模型解析链 requested > agent frontmatter > 默认；再准备运行环境
    const modelRef = this.modelRouter.resolve(params.model, profile ? profile.model : undefined);
    const runnerKind = this.runner.capabilities().kind;
    const runEnv = await this.modelRouter.prepareRunEnv(modelRef, runnerKind);
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
    const timeoutMs = Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? params.timeoutMs
      : config.DEFAULTS.timeoutMs;
    this.records.create({
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
    });

    const taskCtx = { subagentId, slug, prompt, cwd: runCwd, modelRef, timeoutMs, conversation, runEnv };

    // ④⑤ 后台执行体不 await（wait=true 除外）
    const p = this._runFirstRound(subagentId, taskCtx);
    if (params.wait === true) {
      const fin = await p;
      return {
        subagentId,
        slug,
        status: fin.record ? fin.record.status : 'error',
        notify: this._mode,
        result: fin.result && typeof fin.result.response === 'string' ? fin.result.response : '',
        outputFile: fin.outputFile,
        patchFile: fin.patchFile,
        error: fin.record ? fin.record.error : null,
        usage: fin.result ? fin.result.usage : null,
      };
    }
    const handle = { subagentId, slug, status: 'running', notify: this._mode, conversation };
    // polling 档结果不会自动回流（Z5 物理上限），必须当场给轮询指引
    if (this._mode === 'polling' && typeof this.notifier.pollingGuidance === 'function') {
      handle.guidance = this.notifier.pollingGuidance(subagentId);
    }
    return handle;
  }

  // ------------------------------------------------------ list / status

  /** 精简视图：给主 agent 扫一眼用，全量走 status。 */
  list() {
    return this.records.list().map((r) => ({
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
   * 向 conversation 任务投递续聊消息（仅 idle 可投递，busy 语义对齐 spawn 单轮）。
   * 不等待本轮完成（与 start 后台语义一致），完成后再通知。
   */
  async message(id, text) {
    const rec = this._mustGet(id);
    if (rec.conversation !== true) {
      throw new Error(
        `subagent "${id}" 不是 conversation 任务（start 时未传 conversation:true），不支持续聊。`
        + '恢复指引：需要多轮交互请重新 start 并声明 conversation:true。'
      );
    }
    if (rec.status === 'running' || rec.status === 'created') {
      return { busy: true, message: '该 subagent 正在运行，仅 idle 状态可投递' };
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
    // CAS 同步占位：running 期间后续 message 走 busy 分支，天然单轮在飞
    this.records.transition(id, 'idle', 'running');
    const rounds = (rec.rounds || 0) + 1;
    this.records.update(id, { rounds });
    const p = this._runResumeRound(id, text);
    p.catch(() => {}); // 错误已落 record（error 终态），后台路径不产生 unhandledRejection
    return { subagentId: id, status: 'running', round: rounds, notify: this._mode };
  }

  // ------------------------------------------------------- cancel / close

  async cancel(id) {
    const rec = this._mustGet(id);
    if (TERMINAL_STATUSES.has(rec.status)) {
      return { subagentId: id, status: rec.status, cancelled: false, note: '已是终态，无需取消' };
    }
    const handle = this.handles.get(id);
    if (handle) {
      // 有句柄：杀进程 → done 落 cancelled → 执行体完成终态落盘；等它再返回，
      // 保证 cancel 响应里的 status 与 record 一致（端口契约保证 cancel 必然
      // 唤醒 done：driver 的 SIGTERM→SIGKILL 链）
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
    let rec = this._mustGet(id);
    if (!TERMINAL_STATUSES.has(rec.status)) {
      if (this.handles.has(id)) {
        await this.cancel(id); // 运行中：借取消链杀进程 + 终态落盘
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
      const alive = rec.exec ? this.runner.alive(rec.exec) : false;
      if (alive) {
        orphan.push(rec.subagentId);
        this.records.update(rec.subagentId, {
          orphan: true,
          lostReason: '孤儿进程：server 重启丢失句柄，进程仍在运行，结果无法回流。建议 cancel 后重发任务',
        });
      } else {
        dead.push(rec.subagentId);
        this.records.update(rec.subagentId, {
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

  /** 续聊轮：resume 无 cancel 句柄（端口契约），取消走无句柄直接终态化路径。 */
  _runResumeRound(id, text) {
    const p = this._execRound(id, { kind: 'resume', text })
      .finally(() => { this.pending.delete(id); });
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
        const handle = this.runner.start(plan.taskCtx);
        this.handles.set(id, handle);
        // exec 随 running 事件持久化（此刻无 sessionId；done 后由 _completeRun
        // 重写回填版——重启后 resume 依赖它）
        this.records.transition(id, 'created', 'running', { exec: handle.exec });
        try {
          result = await handle.done;
        } finally {
          this.handles.delete(id);
        }
      } else {
        result = await this.runner.resume(cur.exec, plan.text, { timeoutMs: cur.timeoutMs });
      }
      const record = await this._completeRun(id, result, { conversation: cur.conversation === true });
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
  async _completeRun(id, result, { conversation }) {
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
    this._transitionOrSkip(id, 'running', to, {
      closedReason,
      error: result ? result.error : undefined,
      sessionId: (result && result.sessionId) || before.sessionId,
      tokens: (result && result.usage) || before.tokens,
      // exec 重写持久化：spawn 语义是 done 后回填 exec.sessionId，而 running
      // 转移事件序列化于 done 之前——不重写的话重启后 resume 句柄丢失
      exec: before.exec,
      outputFile,
      patchFile,
    });

    // 完成通知：cancelled 是调用方主动行为（cancel 响应已回），不再通知
    if (status !== 'cancelled') {
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

  _mustGet(id) {
    const rec = this.records.get(id);
    if (!rec) {
      throw new Error(`subagent "${id}" 不存在。恢复指引：用 list 查看全部任务 id。`);
    }
    return rec;
  }

  /** 嵌套深度（D11）：本 server 若运行在 ZSUB_NESTED=1 环境，子任务算 depth 1。 */
  _depth() {
    return config.NESTED ? 1 : 0;
  }
}

module.exports = { SubagentManager, noOpWorktree };
