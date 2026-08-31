'use strict';
/**
 * zsw 侧编排宿主（回接计划 2b）：把 zsw 自有 workflow 运行时整体替换为
 * vendored @zhushanwen/subagent-core orchestration。
 *
 * 职责分层（对齐 pi 壳 E 壳接线模式，extensions/universal/subagent-workflow
 * /src/index.ts 的 configureCore 时序 + makeDeps 组装参照）：
 * 1. 进程级初始化：ensureConfigured() 幂等调 core.configureCore——dataRoot
 *    取 lib/config 的 zswRoot 语义（= ~/.zcode/zsw，ZSW_ROOT 可覆盖），log 桥
 *    到 stderr + <zswRoot>/logs/workflow-core.log（MCP stdout 是 JSON-RPC
 *    通道，人读日志绝不走 stdout），discoveryRoots 注入 zsw 用户级特有根
 *    ~/.zsw/workflows（借 core hostRoots 的 user-pi 槽位——core 只透传不
 *    解释宿主标签）。
 * 2. Infra 组装：FileRunStore（落 <dataRoot>/workflow-state/）+ 真实
 *    WorkerHostImpl + zsw 包装 registry（vendored 内置资产 + core 发现面 +
 *    <ws>/.zsw/workflows 手工根）。内置资产 scriptPath 必须指向 vendored
 *    workflows/ 内的绝对路径——worker 以 scriptPath 目录锚定 require
 *    _shared/review-fix-loop-utils，缺失即 core_module_load_failed（设计 D1
 *    硬前提，资产自身 fail-fast 守卫）。
 * 3. 对外面（MCP zflow 六 action / CLI workflow 子命令）：run / runAndWait /
 *    abort / status / list / scripts / lint + daemon 生命周期钩子
 *    （recoverOrphans / shutdown）。
 *
 * 与旧 WorkflowManager 的行为差异（README 回接说明登记）：
 * - run 状态不再写 zsw record 事件流（recordType:'workflow' 线退役）；新
 *   状态面 = 内存 runs Map（done 保留 MAX_RETAINED_DONE_RUNS 条）+
 *   <dataRoot>/workflow-state/<runId>.jsonl append-only 快照。
 * - 完成通知不再投 mailbox（旧 WorkflowManager 的 notifyCompletion 线随
 *   record 线退役）；CLI run 恒同步等终态，daemon 异步 run 用 status 查询。
 * - workdir 不再是 workflow 参数：core RunSpec 无 cwd 字段，workdir 经
 *   per-run 构造的 AgentRunner 适配器闭包成为 agent() 调用的 fallback cwd。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');
const coreRef = require('./core-ref');
const { createAgentRunnerAdapter } = require('./agent-runner-adapter');

/** vendored 内置 workflow 资产名（= core workflows/ 目录文件名 stem）。 */
const BUILTIN_WORKFLOW_NAMES = [
  'chain',
  'parallel',
  'map-reduce',
  'scatter-gather',
  'review-fix-loop',
];

/** zflow run 参数中不进 $ARGS 的保留键（RunSpec/宿主消费或已废弃映射位）。 */
const RESERVED_PARAM_KEYS = new Set([
  'workflow', 'task', 'workdir', 'model', 'timeoutMs', 'maxConcurrent',
  'timeoutMsPerPhase', 'subtaskCount', 'wait', 'reviewers', 'reviewTarget',
]);

/** stderr + 文件双通道的 core 日志桥。debug 不刷 stderr（daemon 常驻防刷屏）。 */
function makeCoreLogBridge(logDir) {
  const file = path.join(logDir, 'workflow-core.log');
  return (level, component, message, data) => {
    const line = `[${new Date().toISOString()}] [${component}] ${message}`
      + (data === undefined ? '' : ` ${JSON.stringify(data)}`)
      + '\n';
    if (level === 'warn' || level === 'error') process.stderr.write(`[zsw-core] ${line}`);
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(file, `[${level}] ${line}`);
    } catch { /* 落盘失败不阻断编排 */ }
  };
}

// 进程级 configureCore 幂等标记（设计要求：防重复 configure；重复调用本身
// 是覆盖式无害，但 flag 保证 discoveryRoots/dataRoot 闭包不被后到的 host
// 实例漂移）。测试用 resetCoreConfig 重建。
let coreConfigured = false;

/** 幂等初始化 vendored core 宿主端口。 */
function ensureConfigured() {
  if (coreConfigured) return;
  const core = coreRef.requireCore();
  core.configureCore({
    dataRoot: () => config.zswRoot(),
    log: makeCoreLogBridge(config.logsDir()),
    discoveryRoots: () => ({
      // zsw 用户级特有根借 user-pi 槽位注入（core 的 hostRoots 按标签查表，
      // user-pi 是宿主自定义语义槽）；<ws>/.zsw 与 <ws>/.agents 两根由 core
      // 的 project 扫描面（cwd 参数推导 workspaceRoot）覆盖度见 listUserScripts
      workflows: [{ dir: path.join(os.homedir(), '.zsw', 'workflows'), source: 'user-pi' }],
    }),
  });
  coreConfigured = true;
}

/** 测试隔离：清幂等标记（下次 ensureConfigured 重新 configureCore 覆盖）。 */
function resetCoreConfig() {
  coreConfigured = false;
}

/** 文件名 stem（无目录无扩展名）——meta 提取失败时的 name 回退。 */
function stem(filePath) {
  const base = filePath.split('/').pop() || filePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 展开 ~/ 前缀（getWorkflowByPath 的 normalizeRef 认这个形态）。 */
function expandHome(ref) {
  if (typeof ref === 'string' && ref.startsWith('~/')) {
    return path.join(os.homedir(), ref.slice(2));
  }
  return ref;
}

/**
 * 绝对路径 → 鸭子 WorkflowScript（core 未导出 WorkflowScript 类；port 契约
 * 只需要 name/path/sourceCode/meta/available/validate()/toExecutable()）。
 * meta 经 core.getWorkflowByPath 解析（@pi-meta 块，任意绝对路径可载）；
 * 读取/解析失败退化为 stem 名 + available=false（loader never-throws 同语义）。
 */
async function loadScriptFromPath(file, core) {
  let meta;
  try {
    meta = await core.getWorkflowByPath(file);
  } catch { meta = undefined; }
  let sourceCode = '';
  try {
    sourceCode = fs.readFileSync(file, 'utf8');
  } catch { /* 文件不可读：available=false */ }
  const available = Boolean(meta && meta.available) && sourceCode !== '';
  const name = (meta && meta.name) || stem(file);
  return {
    name,
    source: 'saved',
    path: file,
    sourceCode,
    meta: meta || { kind: 'workflow', name, description: '', phases: [], path: file, available: false, source: 'saved' },
    available,
    // core.lintScript 吃源码字符串，同步返回 {valid, findings}
    validate: () => core.lintScript(sourceCode),
    // @pi-meta 是块注释（合法 JS），可执行源 = 原文（core WorkflowScript.toExecutable 同语义）
    toExecutable: () => sourceCode,
  };
}

/**
 * zsw Registry：core WorkflowScriptRegistry port 的包装实现。
 *
 * 发现面合并（同名先到先得，外层层级序即优先级序；第 2 层内部遮蔽序 =
 * core buildScanTargets 实际扫描序，user 级先于 workspace 级）：
 * 1. vendored 内置 5 资产（scriptPath 锚定 vendored 目录，D1 硬前提；内置名
 *    不可被用户脚本遮蔽——run "chain" 恒跑 vendored 资产，行为可预期）；
 * 2. core 发现面 discoverWorkflows({ cwd })，遮蔽序：~/.zsw/workflows（经
 *    discoveryRoots 注入，借 user-pi 槽，先于 core 自带根）>
 *    ~/.agents/workflows > <wsRoot>/.pi/workflows（+tmp）>
 *    <wsRoot>/.agents/workflows；
 * 3. <cwd>/.zsw/workflows 手工根（zsw workspace 级特有根，core 扫描布局无
 *    此槽位；byName 兜底末位，不覆盖前两层已有名；meta 退化走
 *    getWorkflowByPath 的 stem fallback）。
 */
function createRegistry(core) {
  const zswWsRoot = (cwd) => path.join(cwd, '.zsw', 'workflows');

  /** 手工根条目：只列名与路径（加载走 loadScriptFromPath 统一 meta 语义）。 */
  function listZswRootEntries(cwd) {
    const out = [];
    try {
      for (const e of fs.readdirSync(zswWsRoot(cwd), { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.js')) out.push({ name: e.name.slice(0, -3), file: path.join(zswWsRoot(cwd), e.name) });
      }
    } catch { /* 根不存在 = 无脚本 */ }
    return out;
  }

  async function listUserScripts(cwd) {
    // core 发现面（cwd 决定 workspaceRoot；hostRoots 经 configureCore 注入）
    const coreMetas = await core.discoverWorkflows({ cwd });
    const byName = new Map();
    for (const m of coreMetas) {
      byName.set(m.name, { name: m.name, path: m.path, available: m.available === true, source: 'core' });
    }
    // 手工根兜底（不覆盖 core 面已有名——project 根优先级高于 .zsw 根）
    for (const entry of listZswRootEntries(cwd)) {
      if (!byName.has(entry.name)) byName.set(entry.name, { name: entry.name, path: entry.file, available: true, source: 'workspace-zsw' });
    }
    return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async function resolveScriptPath(ref, cwd) {
    const expanded = expandHome(ref);
    // 绝对路径原样（含 vendored 资产路径与用户任意位置脚本）
    if (typeof expanded === 'string' && path.isAbsolute(expanded)) return expanded;
    const name = typeof ref === 'string' ? ref.replace(/^script:/, '') : ref;
    if (BUILTIN_WORKFLOW_NAMES.includes(name)) return coreRef.workflowAssetPath(`${name}.js`);
    // 用户脚本：core 面优先，再 .zsw 手工根（与 listUserScripts 同优先级序）
    const users = await listUserScripts(cwd);
    const hit = users.find((s) => s.name === name);
    if (hit) return hit.path;
    return undefined;
  }

  return {
    async loadAll(cwd) {
      const out = [];
      for (const name of BUILTIN_WORKFLOW_NAMES) {
        out.push(await loadScriptFromPath(coreRef.workflowAssetPath(`${name}.js`), core));
      }
      for (const s of await listUserScripts(cwd)) {
        out.push(await loadScriptFromPath(s.path, core));
      }
      return out;
    },
    async get(name, cwd) {
      const p = await resolveScriptPath(name, cwd);
      return p ? loadScriptFromPath(p, core) : undefined;
    },
    async getPath(ref, cwd) {
      return this.get(ref, cwd);
    },
    invalidate() {
      core.invalidateCache();
    },
    listUserScripts,
    resolveScriptPath,
  };
}

/**
 * zflow run params → { scriptRef, args($ARGS), model, budgetTimeMs, warnings }。
 *
 * 内置 5 严格按 vendored 资产实际消费的 $ARGS 键组装（多余键不进 $ARGS 并出
 * warning——review-fix-loop 有运行时白名单，错键会被资产报「未知参数」，
 * 这里前置拦截给出更可操作的提示）；script: 用户脚本白名单外全透传（脚本
 * 自己的 parameters schema 是唯一权威）。无法映射的旧 flag 显式报错
 * （reviewers——语义已从自由文本维度变为 agent ref 批次）或降级 warning
 * （maxConcurrent / timeoutMsPerPhase / subtaskCount——core RunSpec 无对应面）。
 */
function normalizeRunParams(params) {
  const warnings = [];
  const workflow = typeof params.workflow === 'string' ? params.workflow : '';
  if (workflow === '') {
    throw new Error('run 需要 workflow（内置名 / script:<脚本名> / 脚本绝对路径）。恢复指引：先经 scripts action 查可用清单。');
  }
  const name = workflow.replace(/^script:/, '');
  const isBuiltin = BUILTIN_WORKFLOW_NAMES.includes(name);
  const task = typeof params.task === 'string' ? params.task : '';

  // review-fix-loop 旧 sugar：无法映射的显式报错（新契约批次值 = agent .md
  // 路径，旧自由文本维度没有等价物，静默映射会跑错对象）
  if (name === 'review-fix-loop' && Array.isArray(params.reviewers)) {
    throw new Error(
      'review-fix-loop 已不再支持 --reviewers（旧语义 = 自由文本审查维度）。'
      + '新契约：批次 batch1..batchN，值 = agent .md 绝对路径（逗号分隔多 agent）。'
      + '恢复指引：zsw workflow --workflow review-fix-loop --target-type <t> --target <t> '
      + '--batch1 "/abs/path/reviewer.md"；无 agent .md 时用 script: 自定义脚本传自由文本维度。'
    );
  }
  for (const key of ['maxConcurrent', 'timeoutMsPerPhase']) {
    if (params[key] !== undefined) {
      warnings.push(`--${key === 'maxConcurrent' ? 'max-concurrent' : 'timeout-per-phase'} 已不再支持（core 编排无对应面），已忽略。`);
    }
  }
  if (params.subtaskCount !== undefined) {
    warnings.push('--subtask-count 已不再支持（scatter-gather 资产自适应拆分），已忽略。');
  }

  const args = {};
  const model = typeof params.model === 'string' && params.model !== '' ? params.model : undefined;
  const budgetTimeMs = Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : undefined;

  const num = (v) => (v !== undefined ? Number(v) : undefined);
  const bool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);
  const csvJoin = (v) => (Array.isArray(v) ? v.join(',') : v);

  if (isBuiltin) {
    if (name === 'chain' || name === 'scatter-gather') {
      if (!task) throw new Error(`${name} 需要 task（自包含任务书）。恢复指引：--task "<描述>"。`);
      args.task = task;
      if (params.agents !== undefined) args.agents = csvJoin(params.agents);
    } else if (name === 'parallel') {
      const target = params.target !== undefined ? params.target : task;
      if (!target) throw new Error('parallel 需要 target（分析目标；--target 或 --task 均可作为来源）。');
      args.target = target;
      if (Array.isArray(params.perspectives)) args.perspectives = params.perspectives;
      if (params.agents !== undefined) args.agents = csvJoin(params.agents);
    } else if (name === 'map-reduce') {
      if (!params.operation) throw new Error('map-reduce 需要 operation（对每个 item 做什么）。');
      args.operation = params.operation;
      if (Array.isArray(params.items)) args.items = params.items.map(String);
      else if (typeof params.itemsJson === 'string') args.itemsJson = params.itemsJson;
      else throw new Error('map-reduce 需要 items（字符串数组）。恢复指引：--items \'["a","b"]\' 或 a,b。');
      if (params.agents !== undefined) args.agents = csvJoin(params.agents);
    } else if (name === 'review-fix-loop') {
      const target = params.target !== undefined ? params.target
        : params.reviewTarget !== undefined ? params.reviewTarget
          : task;
      if (!target) {
        throw new Error(
          'review-fix-loop 需要 target（审查目标）。恢复指引：--target <目标>（配 --target-type git-diff 时传 base ref 如 main）。'
        );
      }
      args.targetType = params.targetType !== undefined ? params.targetType : 'text';
      args.target = target;
      // batchN 动态键：值统一逗号分隔串（core parameters patternProperties type string）
      for (const [key, value] of Object.entries(params)) {
        if (/^batch([1-9]\d*)$/.test(key)) args[key] = csvJoin(value);
      }
      if (params.agents !== undefined) args.agents = csvJoin(params.agents);
      if (params.batchNames !== undefined) args.batchNames = csvJoin(params.batchNames);
      if (params.reviewPrompt !== undefined) args.reviewPrompt = params.reviewPrompt;
      if (params.fixPrompt !== undefined) args.fixPrompt = params.fixPrompt;
      if (params.autoCommit !== undefined) args.autoCommit = bool(params.autoCommit);
      if (params.maxRounds !== undefined) args.maxRounds = num(params.maxRounds);
      if (params.stuckThreshold !== undefined) args.stuckThreshold = num(params.stuckThreshold);
      if (params.skipCleanAgents !== undefined) args.skipCleanAgents = bool(params.skipCleanAgents);
      if (params.recheckAfterFix !== undefined) args.recheckAfterFix = bool(params.recheckAfterFix);
      if (params.fallowScan !== undefined) args.fallowScan = bool(params.fallowScan);
      if (params.fixAgent !== undefined) args.fixAgent = params.fixAgent;
      if (params.maxFixAttempts !== undefined) args.maxFixAttempts = num(params.maxFixAttempts);
      if (params.convergeNewIssues !== undefined) args.convergeNewIssues = num(params.convergeNewIssues);
      if (params.convergeRounds !== undefined) args.convergeRounds = num(params.convergeRounds);
      if (params.aggregatorModel !== undefined) args.aggregatorModel = params.aggregatorModel;
    }
    // 内置形态的未知键前置拦截（比资产白名单报错更可操作）
    for (const key of Object.keys(params)) {
      if (RESERVED_PARAM_KEYS.has(key) || /^(batch([1-9]\d*))$/.test(key)) continue;
      const known = name === 'review-fix-loop'
        ? ['targetType', 'target', 'batchNames', 'agents', 'reviewPrompt', 'fixPrompt', 'autoCommit', 'maxRounds',
          'stuckThreshold', 'skipCleanAgents', 'recheckAfterFix', 'fallowScan', 'fixAgent', 'maxFixAttempts',
          'convergeNewIssues', 'convergeRounds', 'aggregatorModel']
        : name === 'parallel' ? ['perspectives', 'agents']
          : name === 'map-reduce' ? ['items', 'itemsJson', 'agents']
            : ['agents'];
      if (!known.includes(key)) warnings.push(`参数 "${key}" 不被内置 workflow "${name}" 消费（消费键：${known.join('/')} 或见 scripts action 的 meta），已忽略。`);
    }
  } else {
    // 用户脚本：白名单外全透传 + task 并入（脚本侧 $ARGS.task 直接可用）
    if (task) args.task = task;
    for (const [key, value] of Object.entries(params)) {
      if (RESERVED_PARAM_KEYS.has(key) || value === undefined) continue;
      args[key] = value;
    }
  }

  return { scriptRef: workflow, args, model, budgetTimeMs, warnings };
}

/** WorkflowRun → zflow status/list 视图（CLI/MCP 两面共用的单一映射）。 */
function runSummary(run, store) {
  const spec = run.spec || {};
  const state = run.state || {};
  return {
    runId: run.runId,
    workflow: spec.scriptName,
    status: state.status,
    reason: state.reason === undefined ? null : state.reason,
    error: state.error === undefined ? null : state.error,
    model: spec.model || null,
    startedAt: run.meta && run.meta.startedAt,
    completedAt: run.meta && run.meta.completedAt ? run.meta.completedAt : null,
    stateFile: store ? store.stateFilePath(run.runId) : undefined,
  };
}

/**
 * 构造编排宿主实例。
 * @param {object} opts
 * @param {object} opts.runner       zsw RunnerPort（assemble 组装注入；与 zsub 线共享）
 * @param {object} [opts.modelRouter] ModelRouter（缺省模块级 new）
 * @param {object} [opts.resolver]   agent .md 发现（缺省 lib/agent-discovery 模块，
 *                                   async resolve——W6a 起 core discoverResources）
 * @param {object} [opts.agentRunner] core AgentRunner（缺省经 adapter 从 runner 桥接；测试注入 fake）
 * @param {object} [opts.registry]   脚本 registry（缺省 createRegistry；测试注入 fake）
 * @param {object} [opts.store]      RunStore（缺省 FileRunStore；测试注入内存实现）
 * @param {(msg: string) => void} [opts.log] 诊断通道（缺省 stderr）
 */
function createOrchestrationHost(opts = {}) {
  ensureConfigured();
  const core = coreRef.requireCore();
  const log = opts.log || ((msg) => process.stderr.write(`[zsw-wfhost] ${new Date().toISOString()} ${msg}\n`));
  const modelRouter = opts.modelRouter || new (require('./model-router'))();
  const resolver = opts.resolver || require('./agent-discovery');
  const registry = opts.registry || createRegistry(core);
  const store = opts.store || new core.FileRunStore();
  const workerHost = new core.WorkerHostImpl();
  const runs = new Map();
  // runId → workdir（嵌套 workflow() 的子 run 继承父 run 工作目录；RunSpec 无
  // cwd 字段，host 侧记账）
  const runWorkdirs = new Map();

  /** per-run 依赖（E 壳 makeDeps 对应物）：runner 绑定本 run 的 workdir。 */
  function makeDeps(workdir) {
    const agentRunner = opts.agentRunner
      || createAgentRunnerAdapter({ runner: opts.runner, modelRouter, resolver, fallbackCwd: workdir, log });
    const deps = {
      store,
      workerHost,
      runner: agentRunner,
      runs,
      registry,
      onRunDone: (run) => {
        // 顺序固化为 evict（zsw 无通知线；E 壳的 notify → track 环节随 record 线退役）
        const evicted = core.evictDoneRunsBeyondCap(runs, core.MAX_RETAINED_DONE_RUNS);
        if (evicted > 0) log(`done run 内存淘汰 ${evicted} 条（keep=${core.MAX_RETAINED_DONE_RUNS}）`);
      },
      scheduleTimeBudget: (runId, budgetTimeMs) => core.scheduleTimeBudget(runId, deps, budgetTimeMs),
      onWorkflowCall: (name, args, parentRun) => {
        // 嵌套子 run 的 fallbackCwd 继承父 run 的 workdir（未知时回落 adapter 缺省链）
        const childDeps = makeDeps(runWorkdirs.get(parentRun.runId) || workdir);
        return core.executeNestedWorkflow(name, args, parentRun, childDeps);
      },
      log: (level, component, message, data) => {
        if (level === 'debug') return;
        log(`[core:${component}] ${message}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`);
      },
    };
    return deps;
  }

  /** run 参数公共前置：normalize + 脚本解析 → { spec 组装原料, script, warnings }。 */
  async function resolveRun(params, cwd) {
    const norm = normalizeRunParams(params);
    const workdir = typeof params.workdir === 'string' && params.workdir !== ''
      ? path.resolve(params.workdir)
      : (cwd || process.env.ZCODE_PROJECT_DIR || process.cwd());
    const script = await registry.get(norm.scriptRef, cwd || workdir);
    if (!script) {
      throw new Error(
        `workflow "${norm.scriptRef}" 未找到（内置 ${BUILTIN_WORKFLOW_NAMES.join('/')} 或 script:<名>；可用清单经 scripts action 查询）。`
      );
    }
    if (!script.available) {
      throw new Error(
        `workflow 脚本不可用（meta 解析失败或文件不可读）: ${script.path}。`
        + '恢复指引：core 契约脚本需带 /* @pi-meta name/description */ 块；先用 lint action 校验。'
      );
    }
    return { norm, script, workdir };
  }

  function buildSpec(script, norm) {
    return {
      scriptSource: script.toExecutable(),
      args: norm.args,
      model: norm.model,
      budgetTimeMs: norm.budgetTimeMs,
      scriptName: script.name,
      scriptPath: script.path,
      description: script.meta && script.meta.description,
      parameters: script.meta && script.meta.parameters,
    };
  }

  return {
    /** 异步启动（daemon 面）：立即返回 runId，终态经 status 查询。 */
    async run(params, ctx = {}) {
      const { norm, script, workdir } = await resolveRun(params, ctx.cwd);
      const deps = makeDeps(workdir);
      const runId = await core.runWorkflow(buildSpec(script, norm), deps);
      runWorkdirs.set(runId, workdir);
      return {
        runId,
        workflow: script.name,
        status: 'running',
        stateFile: store.stateFilePath(runId),
        warnings: norm.warnings,
        guidance: `完成查询：node bin/zsw.js workflow --action status --id ${runId}（CLI run 恒同步等终态，本形态主要服务 socket 面）`,
      };
    },

    /** 同步等终态（CLI 面）：core.runAndWait(name=绝对路径 ref)。
     *
     * keepAlive：core 轮询的 timer 是 unref 形态（设计给 pi 常驻进程——事件
     * 循环恒有句柄，unref 不影响触发）。zsw CLI 是一次性进程：worker 线程
     * 退出后事件循环变空，unref timer 不阻止退出——run 已 done 但 poll 的
     * 下个 500ms tick 永不到来，进程带着 exitCode 0 静默溜走（实测复现）。
     * 这里挂一个 ref'd interval 撑住事件循环，finally 清理。daemon/MCP 形态
     * 恒有句柄，keepAlive 无行为影响（纯多余句柄，随 finally 消失）。
     */
    async runAndWait(params, ctx = {}, { signal, timeoutMs } = {}) {
      const { norm, script, workdir } = await resolveRun(params, ctx.cwd);
      const deps = makeDeps(workdir);
      const keepAlive = setInterval(() => {}, 2_147_000_000);
      let result;
      try {
        result = await core.runAndWait(script.path, norm.args, deps, signal,
          Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined);
      } finally {
        clearInterval(keepAlive);
      }
      runWorkdirs.set(result.runId, workdir);
      return { ...result, warnings: norm.warnings, stateFile: result.runId ? store.stateFilePath(result.runId) : undefined };
    },

    async abort(runId) {
      if (typeof runId !== 'string' || runId === '') {
        throw new Error('abort 需要 runId（wf- 前缀）。恢复指引：先经 list action 查全部 run id。');
      }
      // abortRun 对 done no-op；用 baseDeps（runs 共享 Map）
      await core.abortRun(runId, makeDeps(undefined));
      return { runId, aborted: true };
    },

    status(runId) {
      if (typeof runId !== 'string' || runId === '') {
        throw new Error('status 需要 runId（wf- 前缀）。恢复指引：先经 list action 查全部 run id。');
      }
      const run = runs.get(runId);
      if (!run) {
        throw new Error(
          `run "${runId}" 不在内存保留窗口（done run 超过 ${core.MAX_RETAINED_DONE_RUNS} 条被淘汰，或属上一代 daemon）。`
          + `恢复指引：读状态文件 ${store.stateFilePath(runId)}（JSONL 最后一条有效行是终态快照）。`
        );
      }
      const state = run.state || {};
      return {
        ...runSummary(run, store),
        scriptResult: state.scriptResult === undefined ? null : state.scriptResult,
        steps: (state.trace && typeof state.trace.toArray === 'function' ? state.trace.toArray() : []).map((n) => ({
          stepIndex: n.stepIndex, agent: n.agent, status: n.status,
          phase: n.phase === undefined ? null : n.phase,
          error: n.error === undefined ? null : n.error,
        })),
      };
    },

    list() {
      return [...runs.values()].map((r) => runSummary(r, store))
        .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
    },

    /** scripts action：内置 vendored 资产 + 用户脚本发现面。 */
    async scripts(cwd) {
      const builtin = [];
      for (const name of BUILTIN_WORKFLOW_NAMES) {
        const script = await loadScriptFromPath(coreRef.workflowAssetPath(`${name}.js`), core);
        builtin.push({
          name,
          description: (script.meta && script.meta.description) || '',
          path: script.path,
          source: 'core-vendored',
        });
      }
      const users = await registry.listUserScripts(cwd || process.env.ZCODE_PROJECT_DIR || process.cwd());
      return { builtin, scripts: users };
    },

    /** lint action：文件路径 → core.lintScript（源码级校验）。 */
    async lint(file) {
      if (typeof file !== 'string' || file.trim() === '') {
        throw new Error('lint 需要 file（脚本文件路径）。恢复指引：先 scripts 查已发现脚本的 path 字段，或直接给绝对路径。');
      }
      const abs = path.resolve(expandHome(file.trim()));
      let source;
      try {
        source = fs.readFileSync(abs, 'utf8');
      } catch (e) {
        throw new Error(`lint 无法读取脚本文件 ${abs}: ${e && e.message || e}。恢复指引：检查路径拼写与读权限。`);
      }
      return core.lintScript(source);
    },

    /**
     * daemon 接管/启动恢复：FileRunStore.loadAll 重水合上一代遗留快照，running
     * 标终态 failed（worker 随旧进程死亡，无进程可探活），全部进内存后按 cap 裁剪。
     */
    async recoverOrphans() {
      const loaded = await store.loadAll();
      let orphaned = 0;
      for (const run of loaded) {
        if (run.state.status === 'running') {
          run.state.error = 'daemon takeover: worker died with previous process';
          run.transition('done', 'failed');
          await store.save(run);
          orphaned++;
        }
        runs.set(run.runId, run);
      }
      core.evictDoneRunsBeyondCap(runs, core.MAX_RETAINED_DONE_RUNS);
      return { recovered: loaded.length, orphaned };
    },

    /** daemon 退出：全部 running run 转 done,failed 落盘（对齐 E 壳 session_shutdown 语义）。 */
    async shutdown() {
      await core.terminateRunningRuns(makeDeps(undefined), 'daemon shutdown: run terminated');
    },

    /** 测试/内部面：runs Map 直读。 */
    _runs: runs,
  };
}

module.exports = {
  createOrchestrationHost,
  createRegistry,
  normalizeRunParams,
  loadScriptFromPath,
  ensureConfigured,
  resetCoreConfig,
  BUILTIN_WORKFLOW_NAMES,
  RESERVED_PARAM_KEYS,
  /** hook/注入面的 name-only 发现（SessionStart 快照用；见 lib/hook-source.js）。 */
  async listWorkflowNames(cwd) {
    ensureConfigured();
    const core = coreRef.requireCore();
    const users = await createRegistry(core).listUserScripts(cwd);
    return users.map((s) => s.name);
  },
};
