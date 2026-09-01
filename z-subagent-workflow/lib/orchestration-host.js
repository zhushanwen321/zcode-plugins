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
 * 3. 对外面（zflow 九 action = daemon socket 与 CLI workflow 子命令共用；本
 *    对象承接 run / runAndWait / abort / status / list / scripts / lint，
 *    script-* 三 action 创作闭环由 bin/zsw.js 实现经 server handler 消费）
 *    + daemon 生命周期钩子（recoverOrphans / shutdown）。
 *
 * V4o 消费收口（设计 C12/C14/C16）：崩溃恢复线改调 core recoverCrashedRuns
 * （reason 传 zsw 接管文案，hooks 计数）；status/list 投影改调 core
 * runSummary + 宿主扩展字段叠加；run 参数白名单改 core args-meta 三件套
 * meta 驱动（RUN_ENVELOPE_KEYS 信封保留键注入，直参组装 + args 对象基座 +
 * 平铺拦截），每资产手写 known 键集（review-fix-loop 17 键）退役。
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

/**
 * run 调用信封顶层保留键（C16 reservedKeys，消费方契约——pi 先例 77a600d3d
 * 的 zsw 对应物）：这些键属 zsw run 信封/宿主消费面，永不进 $ARGS，也不参与
 * 平铺判定（meta 参数键与信封键撞名时以信封为准）。清单从现调用构造点 grep
 * 收口（原 11 键逐一保留语义，仅 +args/+action）：
 * - bin/zsw.js buildWorkflowRunParams 的 params 字面量组（workflow/task/
 *   workdir/model/timeoutMs 固定面 + maxConcurrent/timeoutMsPerPhase 废弃位）
 * - dist/mcp/server.js run 分支（action 剥离 + wait 同步/异步分流）
 * - 本文件 resolveRun（workdir）与 normalizeRunParams（reviewers 报错、
 *   reviewTarget/target 的 sugar、subtaskCount 废弃 warning）
 * - args：pi 宿主语法的 args 对象信封键（C16 新兼容面，作 $ARGS 基座）
 */
const RUN_ENVELOPE_KEYS = new Set([
  'workflow', 'task', 'workdir', 'model', 'timeoutMs', 'wait',
  'args', 'action',
  'maxConcurrent', 'timeoutMsPerPhase', 'subtaskCount',
  'reviewers', 'reviewTarget',
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
// 实例漂移）。
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

/** 展开 ~/ 前缀（lint 入口的路径形态归一；ref 校验/加载面由 core normalizeRef 承担）。 */
function expandHome(ref) {
  if (typeof ref === 'string' && ref.startsWith('~/')) {
    return path.join(os.homedir(), ref.slice(2));
  }
  return ref;
}

/**
 * 路径 → core WorkflowScript 实体（C3：手工拼鸭子实体已退役——core 已导出
 * WorkflowScript 类与 loadWorkflowScriptByPath，构造/加载/meta 全走 core）。
 * meta 解析（@pi-meta 块，任意绝对路径可载）与读取失败退化（stem 名 +
 * available=false）都是 core loader 语义。
 *
 * 返回 undefined = 引用非法（core normalizeRef：非绝对路径 / 非 .js 后缀 /
 * 含 ".." 段），调用方必须显式处理。兼容性注记：lib/hook-source.js（注入段
 * 组装）消费本函数的 name/meta/path/available 面，其输入恒为绝对 .js 路径，
 * 不会触达 undefined 分支。签名 (file, core) 保持——hook-source 按位传参。
 */
async function loadScriptFromPath(file, core) {
  return core.loadWorkflowScriptByPath(file);
}

/**
 * knownNames 构建（C17/D-E3 单一权威）：内置 5 名在前（同名冲突时 core
 * normalizeWorkflowRef 的 knownNames 遍历先命中内置 = 内置优先序）+ 发现面
 * saved 名（保序去重）。CLI 入口（bin/zsw.js）与 host registry 的
 * resolveScriptPath 都经本函数构建——同一目录集三入口产出同一 knownNames 集
 * （⛔D 一致性断言落点）。saved 裸名放行（D-E3 裁决）由消费方判 known 命中
 * 体现，本函数只负责集合。
 */
async function buildKnownWorkflowNames(core, cwd, registry) {
  const users = registry
    ? await registry.listUserScripts(cwd)
    : await createRegistry(core).listUserScripts(cwd);
  const names = [...BUILTIN_WORKFLOW_NAMES];
  for (const u of users) {
    if (!names.includes(u.name)) names.push(u.name);
  }
  return names;
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
 *    此槽位；byName 兜底末位，不覆盖前两层已有名）。
 *
 * 引用解析口径（C17）：统一走 core normalizeWorkflowRef——路径分支（含
 * / \ 或 ~ 前缀）零发现面扫描纯同步判定（~/ 展开 + ".." 拒收 + .js 严格
 * 后缀）；裸名分支按 knownNames（buildKnownWorkflowNames，内置优先 + saved
 * 名放行）判定后按名单落路径。旧「script: 前缀剥壳放行」退役：入口三面
 * （CLI/daemon-MCP 壳）已拒收，host 层收紧为 unknown（嵌套 workflow() 调用
 * 传 script: 同拒）。
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
    const raw = typeof ref === 'string' ? ref.trim() : ref;
    // 路径形态：normalizeWorkflowRef 路径分支（knownNames 不参与，零扫描）
    if (typeof raw === 'string' && (raw.includes('/') || raw.includes('\\') || raw.startsWith('~'))) {
      const verdict = core.normalizeWorkflowRef(raw);
      return verdict.kind === 'path' ? verdict.path : undefined;
    }
    // 裸名：knownNames = 内置 5 + 发现面 saved 名（与 CLI 入口同一构建函数，
    // cwd 口径一致——⛔D）
    const knownNames = await buildKnownWorkflowNames(core, cwd, api);
    const verdict = core.normalizeWorkflowRef(String(raw), { knownNames });
    if (verdict.kind !== 'name') return undefined;
    // 内置优先：命中内置名落 vendored 资产路径（saved 同名被遮蔽，warning 在 resolveRun）
    if (BUILTIN_WORKFLOW_NAMES.includes(verdict.name)) return coreRef.workflowAssetPath(`${verdict.name}.js`);
    const users = await listUserScripts(cwd);
    const hit = users.find((s) => s.name === verdict.name);
    return hit ? hit.path : undefined;
  }

  const api = {
    async get(name, cwd) {
      const p = await resolveScriptPath(name, cwd);
      // undefined = 引用非法或发现面无此名（normalizeWorkflowRef invalid /
      // known 未命中），调用方（resolveRun）出可操作报错
      return p ? loadScriptFromPath(p, core) : undefined;
    },
    async getPath(ref, cwd) {
      return this.get(ref, cwd);
    },
    listUserScripts,
    resolveScriptPath,
  };
  return api;
}

/**
 * workflow 引用缺失的统一报错（resolveRun 前置校验与本函数内校验共用，防
 * 两处文案漂移）。
 */
function workflowRequiredError() {
  return new Error('run 需要 workflow（内置名或 .js 绝对路径，后者可经 script-generate 创作）。恢复指引：先经 scripts action 查可用清单。');
}

/**
 * zflow run params → { scriptRef, args($ARGS), model, budgetTimeMs, warnings }。
 *
 * C16：参数白名单段退役，改 core args-meta 三件套 meta 驱动——meta = 脚本
 * @pi-meta parameters（core WorkflowScript 已携带，resolveRun 加载脚本后传
 * 入）。键集（哪些参数被消费）、消费键清单文案、batchN 动态键全部来自 meta
 * 的 properties/patternProperties，不再手写每资产 known 数组（review-fix-loop
 * 17 键硬编码随之退役）；值的类型归一（bool/num/csv）同样从 meta 类型驱动。
 * 契约缺失（meta 无 parameters，如旧用户脚本）= 不校验全透传，由资产侧运行
 * 时白名单 fail-fast 兜底（review-fix-loop 的 VALID_ARG_KEYS 即此形态）。
 *
 * zsw 宿主直参形态（CLI/MCP 现行面）：per-workflow 参数平铺在信封顶层，由
 * 本函数组装进 args——信封键（RUN_ENVELOPE_KEYS）永不参与组装与平铺判定。
 * pi 宿主 args 对象形态同步兼容：params.args 为对象时作 $ARGS 基座，此时
 * 顶层再出现 meta 参数键（且 args 无同名）= 平铺错误，经 core
 * findFlattenedArgKeys 检测（normalizeArgsByMeta 的 flattened_args warning）
 * 升级为拦截 + 「子字段请放 args 对象」恢复指引（错误规格表口径）；无 args
 * 对象的直参调用恒不触发该检测。
 *
 * zsw 特有 sugar/required 校验（特制文案，键集无关）保留：reviewers 显式
 * 报错（语义已变）、废弃 flag warning（maxConcurrent/timeoutMsPerPhase/
 * subtaskCount）、target 的 reviewTarget/task 兜底、task 并入。
 */
function normalizeRunParams(params, meta) {
  const warnings = [];
  const workflow = typeof params.workflow === 'string' ? params.workflow : '';
  if (workflow === '') throw workflowRequiredError();
  // U3：script: 剥壳已退役（本文件头注 registry 段契约：入口三面拒收，host
  // 层收紧）——直调导出面不再剥壳放行，带前缀 ref 原样参与判定（不命中内置
  // 名 → isBuiltin=false 用户脚本分支），与入口拒收口径一致，不留第二套口径
  const name = workflow;
  const isBuiltin = BUILTIN_WORKFLOW_NAMES.includes(name);
  const task = typeof params.task === 'string' ? params.task : '';
  const model = typeof params.model === 'string' && params.model !== '' ? params.model : undefined;
  const budgetTimeMs = Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : undefined;

  // review-fix-loop 旧 sugar：无法映射的显式报错（新契约批次值 = agent .md
  // 路径，旧自由文本维度没有等价物，静默映射会跑错对象）
  if (name === 'review-fix-loop' && Array.isArray(params.reviewers)) {
      throw new Error(
        'review-fix-loop 已不再支持 --reviewers（旧语义 = 自由文本审查维度）。'
        + '新契约：批次 batch1..batchN，值 = agent .md 绝对路径（逗号分隔多 agent）。'
        + `恢复指引：node "${config.zswCliPath()}" workflow --workflow review-fix-loop --target-type <t> --target <t> `
        + '--batch1 "/abs/path/reviewer.md"；无 agent .md 时改用自定义脚本（.js 绝对路径，可经 script-generate 创作）传自由文本维度。'
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

  // ── C16 meta 驱动面（core args-meta 单源）────────────────────────
  const core = coreRef.requireCore();
  const effectiveMeta = meta && typeof meta === 'object' ? meta : undefined;
  const { exact, patterns } = core.argKeysFromMeta(effectiveMeta, { reservedKeys: RUN_ENVELOPE_KEYS });
  const isKnownArg = (key) => exact.has(key) || patterns.some((re) => re.test(key));
  // 参数 schema 查找：properties 精确命中优先，patternProperties 兜底
  // （batchN 动态键的类型归一依据；非法正则 core argKeysFromMeta 已 warn 跳过）
  const propSchemaFor = (key) => {
    if (!effectiveMeta) return undefined;
    const props = effectiveMeta.properties;
    if (props && Object.prototype.hasOwnProperty.call(props, key)) return props[key];
    const pp = effectiveMeta.patternProperties;
    if (pp && typeof pp === 'object') {
      for (const [pat, schema] of Object.entries(pp)) {
        try { if (new RegExp(pat).test(key)) return schema; } catch { /* 非法正则 */ }
      }
    }
    return undefined;
  };

  // args 对象基座（pi 宿主语法）+ 平铺拦截：仅 params.args 为对象时走此分支。
  // flat 拦截升级为 throw（错误规格表口径）；no_parameter_contract 不透出
  // （契约缺失 = 不校验，与直参形态同口径，否则旧脚本全量 warning）
  let args;
  if (params.args !== null && typeof params.args === 'object' && !Array.isArray(params.args)) {
    const { args: base, warnings: metaWarnings } = core.normalizeArgsByMeta(
      params, effectiveMeta, { reservedKeys: RUN_ENVELOPE_KEYS },
    );
    const flat = metaWarnings.find((w) => w && w.code === 'flattened_args');
    if (flat) {
      throw new Error(
        `参数 ${(flat.keys || []).map((k) => `"${k}"`).join('、')} 与 args 对象同时给出且被平铺在调用顶层。`
        + '子字段请放 args 对象：{"workflow": "...", "args": {"<参数名>": "<值>"}}；'
        + '或去掉 args 对象改用 zsw 直参形态（--参数名 值），两种形态不混用。',
      );
    }
    args = { ...base };
  } else {
    args = {};
  }

  // ── sugar/required 层（特制文案原样保留；取值统一直参优先、args 基座兜底）──
  const arg0 = (key) => (params[key] !== undefined ? params[key] : args[key]);
  const handled = new Set();
  const setArg = (key, value) => { args[key] = value; handled.add(key); };
  const num = (v) => (v !== undefined ? Number(v) : undefined);
  const bool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);
  // 内置参数的类型归一（meta 类型驱动）：boolean/integer 收 CLI 字符串形态；
  // 数组值按参数类型分流——string 型收数组 = csv 串（CLI csv() 同构），
  // string[] 型数组 = 元素字符串化（items 旧行为）
  const coerce = (key, value) => {
    const prop = propSchemaFor(key);
    const t = prop && prop.type;
    if (t === 'boolean') return bool(value);
    if (t === 'integer' || t === 'number') return num(value);
    if (Array.isArray(value)) {
      if (t === 'array' && prop.items && prop.items.type === 'string') return value.map(String);
      return value.join(',');
    }
    return value;
  };

  if (isBuiltin) {
    if (name === 'chain' || name === 'scatter-gather') {
      const taskArg = typeof arg0('task') === 'string' ? arg0('task') : '';
      if (!taskArg) throw new Error(`${name} 需要 task（自包含任务书）。恢复指引：--task "<描述>"。`);
      setArg('task', taskArg);
    } else if (name === 'parallel') {
      const target = arg0('target') !== undefined ? arg0('target') : task;
      if (!target) throw new Error('parallel 需要 target（分析目标；--target 或 --task 均可作为来源）。');
      setArg('target', coerce('target', target));
    } else if (name === 'map-reduce') {
      if (!arg0('operation')) throw new Error('map-reduce 需要 operation（对每个 item 做什么）。');
      setArg('operation', coerce('operation', arg0('operation')));
      const items = arg0('items');
      const itemsJson = arg0('itemsJson');
      if (Array.isArray(items)) setArg('items', items.map(String));
      else if (typeof itemsJson === 'string') setArg('itemsJson', itemsJson);
      else throw new Error('map-reduce 需要 items（字符串数组）。恢复指引：--items \'["a","b"]\' 或 a,b。');
    } else if (name === 'review-fix-loop') {
      const target = arg0('target') !== undefined ? arg0('target')
        : arg0('reviewTarget') !== undefined ? arg0('reviewTarget')
          : task;
      if (!target) {
        throw new Error(
          'review-fix-loop 需要 target（审查目标）。恢复指引：--target <目标>（配 --target-type git-diff 时传 base ref 如 main）。'
        );
      }
      setArg('targetType', arg0('targetType') !== undefined ? arg0('targetType') : 'text');
      setArg('target', coerce('target', target));
    }
  } else if (task) {
    // 用户脚本：task 并入（脚本侧 $ARGS.task 直接可用）
    args.task = task;
  }

  // ── 通用组装层（meta 驱动白名单）─────────────────────────────────
  for (const [key, value] of Object.entries(params)) {
    if (RUN_ENVELOPE_KEYS.has(key) || handled.has(key) || value === undefined) continue;
    if (!isKnownArg(key)) {
      if (isBuiltin && effectiveMeta) {
        // 内置 + 有契约：未知键前置拦截，消费键清单从 meta 生成（比资产白名单
        // 报错更可操作）
        const knownList = [...exact].join('/')
          + (patterns.length > 0 ? ` 及 ${patterns.map((p) => p.source).join('/')}` : '');
        warnings.push(`参数 "${key}" 不被内置 workflow "${name}" 消费（消费键：${knownList} 或见 scripts action 的 meta），已忽略。`);
        continue;
      }
      // 无契约（用户脚本/内置资产缺 parameters 声明）：透传，资产侧运行时
      // 白名单兜底——契约缺失不校验（现状等值：用户脚本白名单外全透传）
      args[key] = value;
      continue;
    }
    args[key] = isBuiltin ? coerce(key, value) : value;
  }

  return { scriptRef: workflow, args, model, budgetTimeMs, warnings };
}

/**
 * WorkflowRun → zflow status/list 视图（CLI/MCP 两面共用的单一映射）。
 *
 * C14：核心投影单源 core.runSummary（runId/name/slug/status/reason/startedAt/
 * completedAt/error），zsw 扩展字段在 core 投影上叠加——workflow（scriptName
 * 别名，bin 谓词与 CLI summary 的消费面，等值保留）、model、stateFile；null
 * 归一（zsw 面 reason/error/completedAt 恒 null 非 undefined，JSON 序列化
 * 面等值）也在此层做。core 投影新增 name（= scriptName，与 workflow 同值）
 * 与 slug（zsw spec 无此字段，序列化缺席）随叠加透出。
 */
function runSummary(run, store) {
  const base = coreRef.requireCore().runSummary(run);
  const spec = run.spec || {};
  return {
    ...base,
    workflow: spec.scriptName,
    reason: base.reason === undefined ? null : base.reason,
    error: base.error === undefined ? null : base.error,
    completedAt: base.completedAt === undefined ? null : base.completedAt,
    model: spec.model || null,
    stateFile: store ? store.stateFilePath(run.runId) : undefined,
  };
}

/**
 * 构造编排宿主实例。
 * @param {object} opts
 * @param {object} opts.runner       zsw RunnerPort（assemble 组装注入；与 zsub 线共享）
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
      || createAgentRunnerAdapter({ runner: opts.runner, resolver, fallbackCwd: workdir, log });
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

  /**
   * 遮蔽 warning（C17/D-E3）：saved 与内置同名时内置优先（registry 内置名
   * 短路在前，core 名命中即返回），宿主层显式列出双路径（warning 属 zsw 侧，
   * core 无此面）。仅裸名命中内置时触发；发现面异常不阻断 run。
   */
  async function warnShadowedBuiltin(scriptRef, cwd) {
    const bare = typeof scriptRef === 'string' ? scriptRef.trim() : '';
    if (!BUILTIN_WORKFLOW_NAMES.includes(bare)) return;
    if (!registry || typeof registry.listUserScripts !== 'function') return;
    let builtinPath;
    try {
      builtinPath = coreRef.workflowAssetPath(`${bare}.js`);
    } catch { return; }
    try {
      const shadow = (await registry.listUserScripts(cwd)).find((s) => s.name === bare);
      if (shadow) {
        log(`workflow 名遮蔽："${bare}" 同时命中内置资产（${builtinPath}，优先生效）与已保存脚本（${shadow.path}，被遮蔽不执行）。恢复指引：给 saved 脚本换名，或显式传内置资产路径（scripts action 可查）。`);
      }
    } catch { /* 发现面不可用不阻断 run */ }
  }

  /**
   * run 参数公共前置：脚本解析 → normalize（meta 驱动）→ { spec 组装原料, script, warnings }。
   *
   * C16 起 get 先于 normalize：meta = 脚本 @pi-meta parameters（core
   * WorkflowScript 携带，60s TTL mtime 缓存，单次解析）。workflow 必填校验
   * 前置（文案单源 workflowRequiredError——registry.get('') 的「未找到」
   * 文案不可操作）。行为差异（V4o 登记）：「引用未找到 + reviewers 非法」
   * 组合非法输入的报错优先级从 reviewers 变为未找到。
   */
  async function resolveRun(params, cwd) {
    if (typeof params.workflow !== 'string' || params.workflow === '') throw workflowRequiredError();
    const workdir = typeof params.workdir === 'string' && params.workdir !== ''
      ? path.resolve(params.workdir)
      : (cwd || process.env.ZCODE_PROJECT_DIR || process.cwd());
    const script = await registry.get(params.workflow, cwd || workdir);
    if (!script) {
      throw new Error(
        `workflow "${params.workflow}" 未找到（内置 ${BUILTIN_WORKFLOW_NAMES.join('/')}、已保存脚本名或自定义脚本 .js 绝对路径，后者可经 script-generate 创作；可用清单经 scripts action 查询）。`
      );
    }
    const norm = normalizeRunParams(params, script.meta && script.meta.parameters);
    await warnShadowedBuiltin(norm.scriptRef, cwd || workdir);
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
        guidance: `完成查询：node "${config.zswCliPath()}" workflow --action status --id ${runId}（CLI run 恒同步等终态，本形态主要服务 socket 面）`,
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
        if (!script) continue; // 引用非法防御：workflowAssetPath 恒为绝对 .js，实际不触达
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
     * daemon 接管/启动恢复（C12）：恢复线单源 core.recoverCrashedRuns——
     * loadAll 重水合 + running 标终态 failed（worker 随旧进程死亡）+ 落盘 +
     * 按 cap 裁剪，全部由 core 承担；zsw 的接管文案经 reason 传入（error
     * 字段值与手写线逐字节一致），hooks.onRunRecovered 接 orphaned 计数。
     * recovered 契约（dist/mcp/server.js 启动日志）= 重水合条数，core 恢复
     * 线无返回值，这里预读一次 store.loadAll 只取条数（幂等只读；fromSnapshot
     * 的畸形行 warn 会双份，为已知代价）。
     */
    async recoverOrphans() {
      const loaded = await store.loadAll();
      let orphaned = 0;
      await core.recoverCrashedRuns(store, runs, 'daemon takeover: worker died with previous process', {
        onRunRecovered: () => { orphaned++; },
      });
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
  buildKnownWorkflowNames,
  ensureConfigured,
  BUILTIN_WORKFLOW_NAMES,
};
