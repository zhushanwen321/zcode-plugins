'use strict';

/**
 * WorkflowManager —— workflow 生命周期的 record 化管理（N2-a）。
 *
 * ## 为什么是独立类而不是塞进 SubagentManager
 *
 * 两者生命周期机械相似（created→running→终态、abort 句柄、recover、
 * mailbox 通知），但语义不同：subagent 管的是「一个 zcode 进程句柄 + 轮次 +
 * worktree/patch」，workflow 管的是「一次编排入口调用 + 整体报告 + AbortSignal
 * 中止语义」。状态字段（slug/agent/conversation/exec vs workflow/workdir/
 * phases）、完成产物（response 全文 vs markdown+JSON 双段报告）、超时模型
 * （每轮 vs 整体）都不同——硬塞进同一个类会把 manager.js 推向千行上帝类，
 * 两套语义互相污染。共享的部分（RecordStore/OutputStore/Notifier 端口、
 * handles/pending 模式）通过注入同一批端口实例复用。
 *
 * ## record 判别字段为什么是 recordType 而不是 type（重要偏差说明）
 *
 * 任务书要求 record 加 `type` 字段，但 record-store 的事件流顶层 `type` 是
 * 元字段（'created'/'transition'/'update'）：create() 的 `...rest` 展开在
 * `type:'created'` 之后，init 携带 type 会覆盖事件 type 被 applyEvent 以
 * 「未知事件类型」拒收；update/transition 的 patch 解构又把 type 剥掉。
 * 即不动 record-store.js（本批次文件边界）时 record 级 `type` 无法持久化
 * （已用探针实证）。故改用 `recordType: 'workflow'`：create/transition/
 * update 三条路径都能透传，旧 record（无 recordType）rebuild/list 行为零
 * 变化。后续若 record-store 显式支持 record 级 type 默认，可平移改名。
 *
 * subagent 侧的 list 过滤（SubagentManager.list 不见 wf record）需要改
 * manager.js——超出本批次文件边界，留给 server 接线 agent；过滤条件即
 * `r.recordType === undefined || r.recordType === 'subagent'`。
 *
 * ## 并发模型（README 已声明双池独立）
 *
 * workflow runs 不占 subagent slots：内部默认自带并发池（createSlots），
 * 上限 WORKFLOW_MAX_CONCURRENT=2。单 workflow 内部并发仍由各入口自己的
 * maxConcurrent（默认 3）控制——不设全局上限时 5 个并发 workflow × 3 阶段
 * = 15 个 zcode 进程足以打爆开发机，2 × 3 = 6 与 subagent 池满载同级。
 *
 * ## abort / 超时 / recover 语义
 *
 * - abort 三分支（对齐 SubagentManager.cancel）：①有句柄（本进程内存中的
 *   AbortController）→ abort signal，workflow 入口按 run-phase.js 头注契约
 *   返回 status:'aborted'（已完成阶段保留在报告里），record 落 'cancelled'；
 *   ②无句柄 + created（还在等并发槽）→ 直接终态化，执行体拿到槽位后发现
 *   终态已定、不再启动；③无句柄 + running/lost（server 重启后句柄随进程
 *   内存丢失）→ 直接终态化 + note。cancelled 不发完成通知（对齐 subagent
 *   的 cancel 不通知语义）。
 * - timeoutMs：workflow 整体超时（不传则无超时限制；单阶段超时看各 workflow
 *   实现的 timeoutMsPerPhase，缺省同为无超时）。超时 = abort signal + record 落
 *   'timeout'（区别于用户 abort 的 'cancelled'）。timer unref：不拖住 server/CLI/测试进程。
 * - recover：workflow 执行体在 server 进程内（不是子进程），重启即死、无
 *   进程可探活——非终态 record 全部保持 lost（rebuildFromLog 已标）并注明
 *   原因；terminal 照抄。subagent record 本层不碰（SubagentManager.recover
 *   负责探活）。
 *
 * ## server 接线接口（下一 agent 消费）
 *
 *   const wfManager = new WorkflowManager({
 *     records,        // 与 SubagentManager 共享同一 RecordStore 实例
 *     outputs,        // lib/output-store
 *     notifier,       // 与 SubagentManager 共享（mailbox/polling）
 *     // slots 可选：缺省独立池（limit 2）；workflows 可选：测试注入 fake
 *     // runner 可选（wave2 D1）：assembleManager 注入（可能被降级包装过的）
 *     //   RunnerPort，经 _invokeEntry 挂进入口 opts / 脚本 ctx——阶段执行从
 *     //   spawn 直调切到 RunnerPort；缺省 undefined 时入口保持 spawn 直调旧行为
 *   });
 *   await wfManager.recover();            // server 启动时（与 subagent recover 并存，
 *                                         //   rebuild 幂等，先到的标记不会被后到的推翻）
 *   await wfManager.start({ workflow, task, workdir, model?, timeoutMs?,
 *     ...perWorkflow参数, wait? }, { targetSessionId?, cwd });  // cwd = workspace 根，
 *                                         //   script: 前缀的脚本发现以它为 ws 侧根
 *   wfManager.list() / wfManager.status(runId) / await wfManager.abort(runId);
 *   wfManager.listScripts(ctx.cwd);       // 便捷转发 lib/workflow-script.listScripts
 *
 * start 返回：wait=false → {runId, workflow, status:'running', notify, guidance?}；
 * wait=true → 终态 + 报告全文 {runId, workflow, status, report, outputFile, error}。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TERMINAL_STATUSES } = require('./record-store');
const { createSlots } = require('./slots');
const { buildMarkdownReport } = require('./workflow/report');
const workflowScript = require('./workflow-script');

/** workflow record 的判别字段值（见头注「为什么不是 type」）。 */
const RECORD_TYPE = 'workflow';

/**
 * workflow 级并发上限（见头注「并发模型」：防多个 3 并发 workflow 叠加
 * 打爆机器；与 subagent 池相互独立）。
 */
const WORKFLOW_MAX_CONCURRENT = 2;

/** 脚本 ctx.log 的进度留痕上限：环形裁剪防长脚本把内存写爆。 */
const PROGRESS_MAX_LINES = 50;

/** start 入参中不属于 per-workflow 参数的字段（不透传给入口/脚本）。 */
const STRIP_PARAM_KEYS = ['workflow', 'task', 'workdir', 'model', 'timeoutMs', 'wait', 'signal'];

/** 内置 workflow 名 → 入口映射（与 dist/mcp/server.js 的分发同源；构造可注入 fake）。 */
function defaultWorkflows() {
  return {
    chain: require('./workflow/chain').runChain,
    parallel: require('./workflow/parallel').runParallel,
    'map-reduce': require('./workflow/map-reduce').runMapReduce,
    'scatter-gather': require('./workflow/scatter-gather').runScatterGather,
    'review-fix-loop': require('./workflow/review-fix-loop').runReviewFixLoop,
  };
}

/**
 * 内置 workflow 结果 → 双段报告文本（markdown + ```json 围栏），形态对齐
 * report.buildContentBlocks（outputs 落盘是单文件，两段拼一起）。
 * markdown 生成失败不吞结果：降级为说明行 + JSON 段（报告是完成产物，
 * 入口返回形态异常时机器数据仍是权威）。
 */
function buildDualReport(result) {
  let md;
  try {
    md = buildMarkdownReport(result);
  } catch (e) {
    md = `# zsw · ${result && result.workflow ? result.workflow : 'workflow'} 报告\n\n`
      + `（markdown 报告生成失败: ${String(e && e.message || e)}，完整数据见下方 JSON 段）`;
  }
  return `${md}\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
}

class WorkflowManager {
  /**
   * @param {object} ports
   * @param {object} ports.records   RecordStore 实例（可与 SubagentManager 共享）
   * @param {object} records.outputs lib/output-store
   * @param {object} records.notifier NotifierPort（mailbox/polling）
   * @param {object} [ports.slots]    并发池（缺省独立池 limit=WORKFLOW_MAX_CONCURRENT）
   * @param {object} [ports.workflows] 内置入口映射（测试注入 fake 用）
   * @param {object} [ports.runner]   RunnerPort（wave2 D1：assemble 注入，与
   *                                  SubagentManager 同实例；缺省 undefined =
   *                                  阶段保持 spawn 直调旧行为）
   */
  constructor(opts = {}) {
    const missing = ['records', 'outputs', 'notifier'].filter((k) => !opts[k]);
    if (missing.length > 0) {
      throw new Error(
        `WorkflowManager: 缺少端口注入 ${missing.join(', ')}。`
        + '恢复指引：server 组装时传入与 SubagentManager 共享的 records/outputs/notifier 实例后再构造。'
      );
    }
    this.records = opts.records;
    this.outputs = opts.outputs;
    this.notifier = opts.notifier;
    this.workflows = opts.workflows || defaultWorkflows();
    this.slots = opts.slots || createSlots({ limit: WORKFLOW_MAX_CONCURRENT });
    // runner 可选注入（wave2 D1）：runner 是有状态对象（持连接/会话登记），
    // 不做模块级单例——构造注入保证测试隔离与 standby→daemon 接管语义清晰
    // （D1 被否项的镜像：可变全局态让降级翻转变隐晦）
    this.runner = opts.runner;
    /** runId -> AbortController：abort 依据。进程重启即丢（recover 路径兜底）。 */
    this.handles = new Map();
    /** runId -> 执行体 promise：abort 时等终态落盘，避免返回早于 record。 */
    this.pending = new Map();
    /** runId -> string[]：脚本 ctx.log 进度留痕（status() 暴露）。 */
    this.progress = new Map();
    this._mode = this.notifier.capabilities().mode;
  }

  // ------------------------------------------------------------- start

  /**
   * 启动一次 workflow run。
   * @param {object} params {workflow, task, workdir, model?, timeoutMs?,
   *                         ...perWorkflow参数（perspectives/items/operation/
   *                         subtaskCount/reviewTarget/reviewers/maxRounds/
   *                         maxConcurrent/timeoutMsPerPhase）, wait?}
   * @param {object} ctx    {targetSessionId?, cwd}——cwd 是 workspace 根
   *                        （script: 前缀的脚本发现 ws 侧根），非运行目录
   */
  async start(params = {}, ctx = {}) {
    const { workflow, task } = params;
    if (typeof task !== 'string' || task.trim() === '') {
      throw new Error('start 需要 task（非空字符串）。workflow 各阶段靠它自包含执行，请写全目标与验收标准。');
    }
    if (typeof workflow !== 'string' || workflow.trim() === '') {
      throw new Error(
        'start 需要 workflow（内置名或 script:<脚本名> 前缀）。'
        + `恢复指引：内置 ${Object.keys(this.workflows).join(' / ')}；自定义脚本先 listScripts 查看。`
      );
    }
    if (typeof ctx.cwd !== 'string' || ctx.cwd.trim() === '') {
      throw new Error(
        'start 需要 ctx.cwd（workspace 根：script: 脚本发现的 ws 侧根 + 诊断定位）。'
        + '恢复指引：入口层传 ZCODE_PROJECT_DIR 或 process.cwd()。'
      );
    }
    if (typeof params.workdir !== 'string' || params.workdir.trim() === '') {
      throw new Error('start 需要 workdir（workflow 运行目录，绝对路径）。');
    }
    const workdir = path.resolve(params.workdir);
    if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
      throw new Error(`workdir 不存在或不是目录: ${workdir}。恢复指引：传 workdir 参数（绝对路径）。`);
    }

    // 入口解析先于 record 创建（fail fast：拼错 workflow 名不产生孤儿 record）
    const entry = this._resolveEntry(workflow, ctx.cwd);
    // 整体超时：不传则无限制。与 per-workflow 的 timeoutMsPerPhase（单阶段预算，
    // 随 workflowParams 透传，各 workflow 实现缺省亦为无超时）是两个独立字段
    // timeoutMs 为 null 或 0 表示无超时限制
    const timeoutMs = Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? params.timeoutMs
      : null;
    const workflowParams = {};
    for (const [k, v] of Object.entries(params)) {
      if (!STRIP_PARAM_KEYS.includes(k) && v !== undefined) workflowParams[k] = v;
    }

    const runId = `wf-${crypto.randomUUID().slice(0, 8)}`;
    const targetSessionId = typeof ctx.targetSessionId === 'string' ? ctx.targetSessionId : null;
    this.records.create({
      subagentId: runId, // record-store 主键字段名（跨 type 统一）；值带 wf- 前缀
      recordType: RECORD_TYPE,
      workflow,
      task,
      workdir,
      model: typeof params.model === 'string' ? params.model : null,
      targetSessionId,
      notifyMode: this._mode,
      timeoutMs,
      cwd: ctx.cwd,
      ...(Object.keys(workflowParams).length > 0 ? { workflowParams } : {}),
    });

    const p = this._runWorkflow(runId, {
      workflow, entry, task, workdir, model: params.model, workflowParams, timeoutMs,
    });
    if (params.wait === true) {
      const fin = await p;
      return {
        runId,
        workflow,
        status: fin.record ? fin.record.status : 'error',
        report: fin.report,
        outputFile: fin.outputFile,
        error: fin.record && fin.record.error !== undefined ? fin.record.error : null,
      };
    }
    const handle = {
      runId, workflow, status: 'running',
      // MF6 延伸（同 SubagentManager）：按实际回流通道而非组装档位——socket/CLI
      // 面恒无 targetSessionId，mailbox 档写 'mailbox' 会误导「会自动回流」
      notify: this._notifyLabel(targetSessionId),
    };
    if (this._mode === 'polling') {
      // polling 档结果不会自动回流（Z5 物理上限），必须当场给轮询指引
      handle.guidance = [
        `workflow run ${runId} 已提交，mailbox 通知通道未启用，结果不会自动回流本会话。`,
        `查询状态：status(runId="${runId}")——完成后 status 变为 closed/error/timeout。`,
        `报告全文：完成后落在 outputs 文件（status 返回中带路径），用 Read 工具读取。`,
      ].join('\n');
    }
    return handle;
  }

  // ------------------------------------------------------ list / status

  /** 精简视图（只含 workflow record；subagent record 不入列，反之亦然）。 */
  list() {
    return this.records.list()
      .filter((r) => r.recordType === RECORD_TYPE)
      .map((r) => ({
        runId: r.subagentId,
        workflow: r.workflow,
        task: r.task,
        model: r.model === undefined || r.model === null ? null : r.model,
        status: r.status,
        startedAt: r.startedAt,
        endedAt: r.endedAt === undefined ? null : r.endedAt,
        error: r.error === undefined ? null : r.error,
      }));
  }

  status(runId) {
    const rec = this._mustGet(runId);
    return {
      ...rec,
      runId: rec.subagentId,
      outputFile: this.outputs.pathFor(runId),
      progress: this.progress.get(runId) || [],
    };
  }

  /** 便捷转发：脚本发现（server 接线的 scripts 列表 action 直接可用）。 */
  listScripts(cwd) {
    return workflowScript.listScripts(cwd);
  }

  // ------------------------------------------------------------- abort

  /**
   * 中止一次 run（三分支语义见头注）。返回的 status 与 record 终态一致。
   */
  async abort(runId) {
    const rec = this._mustGet(runId);
    if (TERMINAL_STATUSES.has(rec.status)) {
      return { runId, status: rec.status, aborted: false, note: '已是终态，无需中止' };
    }
    const controller = this.handles.get(runId);
    if (controller) {
      // 有句柄：abort signal → 入口按契约返回 status:'aborted' → 执行体
      // 收尾落 'cancelled'；等 pending 保证响应里的 status 已落盘
      controller.abort();
      const pending = this.pending.get(runId);
      if (pending) await pending.catch(() => {});
      return { runId, status: this.records.get(runId).status, aborted: true };
    }
    // 无句柄：created = 还在等并发槽（执行体拿到槽后会自查终态、不再启动）；
    // running/lost = server 重启后句柄随内存丢失——workflow 执行体在 server
    // 进程内，重启即死，无残留进程可清理（与 subagent 的进程残留不同）
    const note = rec.status === 'created'
      ? '排队中被中止，执行体未启动'
      : '句柄丢失（server 重启），执行体已随进程消亡，无残留进程';
    this.records.transition(runId, rec.status, 'cancelled', { closedReason: note });
    return { runId, status: 'cancelled', aborted: true, note };
  }

  // ------------------------------------------------------------- recover

  /**
   * 启动恢复：rebuild + 对非终态 workflow record 全部标 lost 并注明。
   * 无进程可探活（执行体在 server 进程内，见头注）；subagent record 由
   * SubagentManager.recover 负责，本方法跳过（共享 store 时两个 recover
   * 并存安全：rebuild 幂等，各自的 update 事件只写自己的 record）。
   */
  async recover() {
    const rebuild = this.records.rebuildFromLog();
    const lost = [];
    for (const rec of this.records.list()) {
      if (rec.recordType !== RECORD_TYPE) continue;
      if (TERMINAL_STATUSES.has(rec.status)) continue;
      // rebuildFromLog 已把非终态标 lost（内存标记）；这里补持久化说明
      lost.push(rec.subagentId);
      this.records.update(rec.subagentId, {
        // dead 标记：wait 收敛依据（R2）——workflow 执行体随 server 进程消亡，
        // 永无外部推进，wait 据此立即收编防无 timeout 挂死
        dead: true,
        lostReason: 'workflow 执行体在 server 进程内，重启即死（无进程可探活），结果未落盘。建议核对产出后重跑',
      });
    }
    return { rebuild, lost };
  }

  // ------------------------------------------------- 内部：执行体

  /** 占 pending（abort 等待用），完成后清理句柄表（progress 保留供 status 诊断）。 */
  _runWorkflow(runId, plan) {
    const p = this._execWorkflow(runId, plan)
      .finally(() => {
        this.pending.delete(runId);
        this.handles.delete(runId);
        // progress 不随执行体清理：完成后 status() 仍能看到脚本进度留痕
        // （有 PROGRESS_MAX_LINES 环形上限，内存量级与 record 本身同级）
      });
    this.pending.set(runId, p);
    return p;
  }

  /**
   * 执行体：拿槽 → 自查终态（排队期被 abort 则不启动）→ 句柄挂表 → 超时
   * 计时 → 调入口 → 统一收尾。永不 reject：wait=false 路径无人 await，
   * unhandledRejection 会拖垮 server 进程；错误一律落 record.error 后以
   * 返回值形态交出（wait=true 调用方看 status:'error' + error 字段）。
   */
  async _execWorkflow(runId, plan) {
    let release;
    try {
      release = await this.slots.acquire();
      const cur = this.records.get(runId);
      if (!cur || cur.status !== 'created') {
        // 排队期间被 abort/close：终态已定，不再启动入口（槽位照常释放）
        return { record: cur, report: '', outputFile: null };
      }
      const controller = new AbortController();
      this.handles.set(runId, controller);
      this.records.transition(runId, 'created', 'running'); // CAS：抢占执行权
      // 整体超时从执行开始计时（排队耗时不是 workflow 自身的开销）
      let timedOut = false;
      // timeoutMs 为 null 时不设置超时
      let timer = null;
      if (plan.timeoutMs != null && plan.timeoutMs > 0) {
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, plan.timeoutMs);
        if (typeof timer.unref === 'function') timer.unref(); // 不拖住进程退出
      }

      let invocation;
      try {
        invocation = await this._invokeEntry(runId, plan, controller.signal);
      } catch (err) {
        // 入口抛错（模型校验/参数校验等可操作错误）也走统一收尾：报告降级
        // 为错误说明 + JSON 段，record 落 error
        invocation = {
          threw: true,
          error: String(err && err.message || err),
          reportText: `# zsw · ${plan.workflow} 异常\n\n`
            + `入口执行抛错：${String(err && err.message || err)}\n`
            + '\n```json\n' + JSON.stringify({ ok: false, workflow: plan.workflow, task: plan.task, error: String(err && err.message || err) }, null, 2) + '\n```',
        };
      } finally {
        if (timer != null) clearTimeout(timer);
      }
      return await this._finalize(runId, invocation, { timedOut });
    } catch (err) {
      // 兜底：未预期异常也要把 record 从活跃态救出，否则悬挂 running 永远占语义
      const cur = this.records.get(runId);
      let fin = { record: cur, report: '', outputFile: null };
      if (cur && !TERMINAL_STATUSES.has(cur.status) && cur.status !== 'lost') {
        try {
          const msg = String(err && err.message || err);
          const outputFile = this.outputs.writeResult(runId, `【workflow 异常】${msg}`);
          const rec = this.records.transition(runId, cur.status, 'error', {
            closedReason: 'error',
            error: msg,
            outputFile,
          });
          fin = { record: rec, report: `【workflow 异常】${msg}`, outputFile };
        } catch { /* CAS 竞态：另一路径（如 abort）已终态化，尊重先到者 */ }
      }
      return fin;
    } finally {
      if (release) release();
    }
  }

  /** 解析并调用入口（内置 / 脚本），产出统一 invocation {result?, reportText}。 */
  async _invokeEntry(runId, plan, signal) {
    if (plan.entry.kind === 'builtin') {
      const result = await plan.entry.run({
        ...plan.workflowParams,
        task: plan.task,
        workdir: plan.workdir,
        model: plan.model,
        // D4：runId 注入（review-fix-loop v2 据此建 ~/.zcode/zsw/rfl/<runId>/ 并在
        // 结果带回 runDir；其他内置 workflow 不认识该字段，解构忽略，无害透传）
        runId,
        signal,
        // wave2 D1：RunnerPort 与 signal 同链透传（入口 → phases → run-phase
        // 三行范式执行）。review-fix-loop 经 INFRA_PARAM_KEYS 白名单放行；
        // undefined 时入口保持 spawn 直调旧行为
        runner: this.runner,
      });
      return { kind: 'builtin', result, reportText: buildDualReport(result) };
    }
    // script 分支：发现已在 _resolveEntry 完成（fail fast），这里传描述符，
    // 把「发现根 = workspace cwd」与「运行 cwd = workdir」解耦
    const ret = await workflowScript.runScript({
      script: plan.entry.script,
      ctx: {
        task: plan.task,
        cwd: plan.workdir,
        model: plan.model,
        signal,
        runner: this.runner,
        timeoutMs: plan.timeoutMs,
        params: plan.workflowParams,
        log: (text) => this._log(runId, text),
      },
    });
    const jsonFence = ret.json !== undefined && ret.json !== null
      ? '\n```json\n' + JSON.stringify(ret.json, null, 2) + '\n```'
      : '';
    return {
      kind: 'script',
      // 脚本正常返回即成功（抛错路径已在 runScript 内前置为可操作错误）
      result: { ok: true, status: 'ok', model: typeof plan.model === 'string' ? plan.model : null },
      reportText: ret.markdown + jsonFence,
    };
  }

  /** done 之后的统一收尾：报告落盘 → 终态转移 → 通知（cancelled 不通知）。 */
  async _finalize(runId, invocation, { timedOut }) {
    const res = invocation.threw ? null : invocation.result;
    let status;
    let closedReason;
    let error;
    if (timedOut) {
      status = 'timeout';
      closedReason = 'timeout';
      error = 'workflow 整体超时（上限 ' + (this.records.get(runId)?.timeoutMs ?? '?') + 'ms），已中止执行体；已完成阶段保留在报告中';
    } else if (invocation.threw) {
      status = 'error';
      closedReason = 'entry-threw';
      error = invocation.error;
    } else if (res.status === 'aborted') {
      status = 'cancelled';
      closedReason = 'cancelled-by-user';
      error = res.error;
    } else if (res.status === 'ok') {
      status = 'closed';
      closedReason = 'completed';
    } else {
      status = 'error';
      closedReason = res.status || 'failed';
      error = res.error || 'workflow 失败（入口未提供错误详情）';
    }

    // error/timeout/cancelled 也落盘：报告里的已完成阶段/失败原因是诊断依据
    const outputFile = this.outputs.writeResult(runId, invocation.reportText);
    const before = this.records.get(runId);
    this._transitionOrSkip(runId, 'running', status, {
      closedReason,
      error,
      model: (res && res.model) || before.model,
      outputFile,
      ...(res && Array.isArray(res.phases) ? { phaseCount: res.phases.length } : {}),
      // D4：runDir 指针（review-fix-loop v2 在结果中带出；其他 workflow 无该字段不落）
      ...(res && typeof res.runDir === 'string' && res.runDir ? { runDir: res.runDir } : {}),
    });

    // 完成通知：cancelled 是调用方主动行为（abort 响应已回），不再通知。
    // 门卫同时看 record 当前终态：abort 走无句柄路径已终态化后，迟到的
    // 收尾不得补发通知（对齐 SubagentManager._completeRun 的 S-6② 语义）
    const cur = this.records.get(runId);
    if (status !== 'cancelled' && cur && cur.status !== 'cancelled') {
      const summary = this._buildSummary(cur, outputFile);
      try {
        const r = await this.notifier.notifyCompletion(cur, summary);
        if (r && r.delivered) {
          this.records.update(runId, { notified: true });
        } else {
          this.records.update(runId, {
            notified: false,
            notifyNote: '投递未命中（无有效 targetSessionId 或 polling 档），结果需主动 status 查询',
          });
        }
      } catch (e) {
        // 通知失败不波及终态（record 已落盘）；失败原因留档可查
        this.records.update(runId, { notified: false, notifyError: String(e && e.message || e) });
      }
    }
    return { record: this.records.get(runId), report: invocation.reportText, outputFile };
  }

  /** transition 的取消竞态容忍：执行期间被 abort（终态已定）时跳过而非炸穿。 */
  _transitionOrSkip(runId, from, to, patch) {
    try {
      return this.records.transition(runId, from, to, patch);
    } catch (e) {
      const cur = this.records.get(runId);
      if (cur && cur.status === 'cancelled') return cur;
      throw e;
    }
  }

  /**
   * 通知文案：任务书规定格式 `[workflow 完成] <workflow> runId=<id>。状态:
   * <status>。报告: <路径>`（status 用 record 终态，主 agent 据此与 status
   * 查询对账）；失败/超时附原因与恢复指引。
   */
  _buildSummary(rec, outputFile) {
    let s = `[workflow 完成] ${rec.workflow} runId=${rec.subagentId}。状态: ${rec.status}。报告: ${outputFile}`;
    if (rec.status === 'error' || rec.status === 'timeout') {
      s += `\n原因: ${rec.error || '未知'}`;
      s += '\n恢复指引: 读取报告定位失败阶段，修正 task/参数后重跑；不再需要的运行用 abort 中止。';
    }
    return s;
  }

  /** workflow 值解析：内置 5 名（this.workflows 映射）或 script:<name>（四根发现）。 */
  _resolveEntry(workflow, cwd) {
    if (workflow.startsWith('script:')) {
      const name = workflow.slice('script:'.length).trim();
      const script = workflowScript.findScript(name, cwd);
      if (!script) {
        const avail = workflowScript.listScripts(cwd).map((s) => s.name).join(', ') || '（无）';
        throw new Error(
          `未找到 workflow 脚本 "${name}"（四根发现：<ws>/.agents/workflows > <ws>/.zsub/workflows > ~/.agents/workflows > ~/.zsub/workflows）。当前可用: ${avail}。`
          + '恢复指引：检查脚本名拼写，或先创建脚本（lintScript 校验）后重试。'
        );
      }
      return { kind: 'script', script };
    }
    const run = this.workflows[workflow];
    if (typeof run !== 'function') {
      throw new Error(
        `不支持的 workflow "${workflow}"（内置: ${Object.keys(this.workflows).join(' / ')}；自定义脚本用 script:<name> 前缀）。`
        + '恢复指引：workflow 必须取内置名或 script:<脚本名>。'
      );
    }
    return { kind: 'builtin', run };
  }

  /** 脚本进度留痕：环形裁剪（PROGRESS_MAX_LINES 上限），status() 暴露。 */
  _log(runId, text) {
    const buf = this.progress.get(runId) || [];
    buf.push(`${new Date().toISOString()} ${String(text)}`);
    if (buf.length > PROGRESS_MAX_LINES) buf.splice(0, buf.length - PROGRESS_MAX_LINES);
    this.progress.set(runId, buf);
  }

  /** 查 record 并校验归属：subagent record 不能经 workflow 面查询（反之亦然）。 */
  _mustGet(runId) {
    const rec = this.records.get(runId);
    if (!rec) {
      throw new Error(`workflow run "${runId}" 不存在。恢复指引：用 list 查看全部 workflow run id（前缀 wf-）。`);
    }
    if (rec.recordType !== RECORD_TYPE) {
      throw new Error(
        `"${runId}" 不是 workflow record（recordType=${JSON.stringify(rec.recordType) ?? 'undefined'}）。`
        + `恢复指引：subagent 任务请用 CLI 查询：node ${path.join(process.env.ZCODE_PLUGIN_ROOT || path.join(__dirname, '..'), 'bin', 'zsw.js')} status --id <subagentId>。`
      );
    }
    return rec;
  }

  /**
   * 句柄 notify 字段（MF6 延伸，与 SubagentManager._notifyLabel 同构）：
   * 按实际回流通道而非组装档位输出。mailbox 档但无 targetSessionId
   * （socket/CLI 面恒无——CLI 驱动的 run 不经 MCP 会话，ctx 的
   * targetSessionId 为 null）时完成通知必 delivered:false，写 'none'
   * （无回流通道，等待走 CLI wait / run_in_background 原生通知）——写
   * 'mailbox' 会误导「会自动回流」。polling 档无通道语义差异，恒
   * 'polling'（guidance 已附轮询指引）。mailbox + 有 target（MCP 面遗留：
   * 工具面 1.0.0 起恒拒不可达，但保持逻辑完备）仍 'mailbox'。
   */
  _notifyLabel(targetSessionId) {
    if (this._mode !== 'mailbox') return this._mode;
    return typeof targetSessionId === 'string' && targetSessionId !== '' ? 'mailbox' : 'none';
  }
}

module.exports = {
  WorkflowManager,
  RECORD_TYPE,
  WORKFLOW_MAX_CONCURRENT,
};
