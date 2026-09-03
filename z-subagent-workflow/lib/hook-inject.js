'use strict';
/**
 * SessionStart hook 注入块渲染（W7：改调 vendored subagent-core 三段 XML 渲染，
 * 设计 subagent-core-convergence §3.2 D-3a——旧单块 <zsw-resources> 45 行预算
 * 形态随本切换退役）。
 *
 * 三段（同一 core format 函数产物，tag/字段集与 pi 侧逐字节同构——A4 注入
 * 对齐的机制保证）：
 *   <available_subagents>       formatAgentList    name/description[/<when>]/<location>
 *   <available_workflows>       formatWorkflowList name/description/<location>
 *   <available_provider_models> formatModelList    <id>（全名 provider/model）/<name>
 *                                                  [/<caps>][/<contextWindow>]
 * （models 段 tag 用 core 实现名 available_provider_models——设计 §3.1 样例
 * 曾用简写，终态已统一。）
 *
 * 分段条目预算（D-3a R2 决策）：subagents 段 15（开箱 10 内置 + 5 用户余量）、
 * workflows 段 10；条目按 name 码点序排（core sortByCodepoint，非 locale 序）、
 * 超预算截尾部条目 + 截断兜底指引行；models 段完整永不截（formatModelList 无
 * 预算参数，设计钉死）。内置条目无截断豁免（显式红线，不做「内置优先保留」
 * 两段式）：码点序统一截尾行为可预测，兜底指引可恢复。
 *
 * guide 文案（宿主注入——core 不内嵌平台文案，D-3 guide 参数化）：subagents/
 * workflows 段为静态常量；models 段 guide 由 modelsGuide 动态拼（快照时戳 +
 * 当前默认模型——旧块的「当前默认：」行与快照过期警示并入 guide，default
 * 标记机制随旧两层渲染退役）。
 *
 * 本模块仍零 fs/网络（数据组装在 lib/hook-source.js）：v2 config 对象经
 * model-router 消费（qualifiedProviders 谓词 + toModelEntries 字段提取单一
 * 实现，provider 范围与旧块两层口径等价——默认 provider 不筛凭据、其余筛
 * 「带凭据且清单非空」）；渲染函数经 lib/core-ref requireCore 消费（禁深路径，
 * vendor 布局调整单点吸收）。cliModelMain 由调用方传 defaultModelRef(v2) 回退链
 * 产物，本模块不触 fs。
 */

const { PROVIDER_ID, qualifiedProviders, toModelEntries: projectModelEntries } = require('./model-router');
const { zswCliPath } = require('./config');
const coreRef = require('./core-ref');

/** subagents 段条目预算（D-3a：开箱 10 内置 + 5 用户余量）。 */
const AGENTS_MAX_ENTRIES = 15;
/** workflows 段条目预算（D-3a：内置 5 + 自定义余量）。 */
const WORKFLOWS_MAX_ENTRIES = 10;

/**
 * zsw CLI 完整可执行形态（F12）：注入段给主 agent 的指引必须「照抄即可执行」
 * ——marketplace/inline 形态下裸 `zsw` 不在 PATH；路径经单源 config.zswCliPath
 * （ZCODE_PLUGIN_ROOT > 模块相对），双引号包裹防路径含空格。
 */
const ZSW_CLI = zswCliPath();

/** 截断兜底指引（段末追加行；文案与 zsw CLI 查询面对齐，命令为完整可执行形态）。 */
const AGENTS_TRUNCATION_NOTICE = `  …（截断，完整清单：node "${ZSW_CLI}" agents）`;
const WORKFLOWS_TRUNCATION_NOTICE = `  …（截断，完整清单：node "${ZSW_CLI}" workflow --action scripts）`;

/**
 * zsw 版 subagents 段引导（agent 参数契约 = W6b 收紧后语义：仅 .md 绝对路径，
 * 缺省 general-purpose——与 pi 版 SUBAGENT_LIST_GUIDE 同构、按 zsw CLI 语境改写）。
 */
const SUBAGENTS_GUIDE =
  'The following subagents are available. PRIORITY: when a task involves reading 3+ files,'
  + ' writing 100+ lines, parallel research, or specialized review, delegate to a matching subagent'
  + ' FIRST instead of doing it yourself — this keeps your context focused on orchestration.'
  + ` When starting one via node "${ZSW_CLI}" start, pass the <location> path (absolute .md path) as the`
  + ' --agent param — bare names are rejected. If no agent matches your task, omit --agent'
  + ' (a general-purpose agent is used) and put all role-specific instructions in the task text.'
  + ' Blocking calls (start / workflow run — both synchronous until completion) MUST run via the'
  + ' Bash tool with run_in_background=true:'
  + ' a foreground Bash call is killed by the tool timeout and loses the result, while a background'
  + ' task wakes you via task-notification on completion (no polling). Instant queries'
  + ' (status/list/agents/models) may run in the foreground.';

/**
 * zsw 版 workflows 段引导（workflow 引用契约：内置名或 .js 绝对路径——
 * script:<名> 形态已拒，与 pi 版 WORKFLOW_LIST_GUIDE 同构、按 zsw CLI 语境改写）。
 * F8-zsw 追加双引擎语法声明：脚本头 usage 示例是 pi 宿主 `--args k=v` 语法，
 * zsw CLI 用直参 flag——不声明会让照抄 usage 的调用被 CLI 拒收。
 */
const WORKFLOWS_GUIDE =
  'The following workflows are available. Run them via the zsw CLI workflow subcommand'
  + ` (node "${ZSW_CLI}" workflow --workflow <name-or-.js-path> --task "<task>" --workdir <abs-dir> ...):`
  + ' built-in names are passed to --workflow <name> directly; custom scripts must be passed'
  + ' by their <location> absolute .js path (script:<name> refs are rejected).'
  + ' For parameter details, read the <location> script file (header @pi-meta has parameters + usage).'
  + ' Note: the `workflow run <name> --args k=v` form in the script header usage is pi-host syntax —'
  + ' the zsw CLI takes direct flags instead (e.g. --task/--workdir plus per-workflow flags);'
  + ' see the @pi-meta parameters in the script header for parameter semantics.'
  + ' `workflow run` is a synchronous blocking command that can run for many minutes — ALWAYS wrap it'
  + ' in a Bash call with run_in_background=true (a foreground call is killed by the tool timeout);'
  + ' completion delivers a task-notification automatically, so no polling.';

/**
 * zsw 版 models 段引导（动态：快照时戳 + 当前默认模型）。旧块的「当前默认：」
 * 恒显行、快照过期警示与模型兜底指引（报错自带权威清单 / zsw models 现查）
 * 并入本 guide——三段形态下默认标记机制退役，guide 是唯一承载面。
 * @param {string} nowIso   快照时间戳（空串则不加时戳句）
 * @param {string} cliModelMain 默认模型引用（defaultModelRef 回退链产物；空则不加默认句）
 */
function modelsGuide(nowIso, cliModelMain) {
  let g = `The following models are available. Use these ids when passing --model to node "${ZSW_CLI}" start / node "${ZSW_CLI}" workflow:`
    + ' cross-provider refs must use the full <provider>/<model> id exactly as shown'
    + ` (short names only work for the default provider ${PROVIDER_ID}).`
    + ' Match the model to the task — strong reasoners for design/architecture/deep research,'
    + ' light models for exploration/formatting/counting.';
  const def = typeof cliModelMain === 'string' ? cliModelMain.trim() : '';
  if (def) {
    g += ` Current default model: ${def}. Do NOT assume "no --model = heavyweight" —`
      + ' when the default is a light model, heavy tasks MUST pass an explicit stronger model.';
  }
  if (nowIso) g += ` Snapshot generated ${nowIso} at session start; GUI config changes mid-session may make it stale.`;
  g += ' On a wrong model name the error output includes the authoritative available list;'
    + ` or run node "${ZSW_CLI}" models (default provider) / node "${ZSW_CLI}" models --all (all qualified providers) to refresh.`;
  return g;
}

/**
 * agent-discovery AgentProfile[] → core AgentEntry[]（投影层：filePath→path、
 * when 透传、无名条目丢弃——旧 agentEntries 同语义）。description 不截断
 * （对齐 pi 侧 AgentEntry 原样渲染；旧块 20 码点截断随单块形态退役）。
 */
function toAgentEntries(agents) {
  const out = [];
  for (const p of Array.isArray(agents) ? agents : []) {
    if (!p) continue;
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!name) continue; // 无名条目丢弃（旧语义）
    const entry = {
      name,
      description: typeof p.description === 'string' ? p.description : '',
      // AgentProfile 契约字段是 filePath（无生产者产 path），不设回退
      path: String(p.filePath || ''),
    };
    if (typeof p.when === 'string' && p.when.trim()) entry.when = p.when.trim();
    out.push(entry);
  }
  return out;
}

/**
 * hook-source 组装的 workflow 条目（name/description/path）→ core WorkflowEntry：
 * description 经 core summarizeDescription 截 160 码点（与 pi 侧同口径——内置
 * review-fix-loop 等资产描述较长，全量注入膨胀 prompt）。name/path 不动。
 */
function toWorkflowEntries(workflows) {
  const core = coreRef.requireCore();
  const out = [];
  for (const w of Array.isArray(workflows) ? workflows : []) {
    if (!w) continue;
    const name = typeof w.name === 'string' ? w.name.trim() : '';
    if (!name) continue;
    out.push({
      name,
      description: core.summarizeDescription(typeof w.description === 'string' ? w.description : ''),
      path: String(w.path || ''),
    });
  }
  return out;
}

/**
 * v2 config → core ModelEntry[]（D-3 ModelEntry 并集口径的 zsw 投影：填
 * reasoning.variants 档位对象与 label，input 永不填——core formatCaps 对
 * input 缺席经 optional chaining 守卫不炸，W3 红线 5）。provider 字段恒给
 * → <id> 渲染为全名 <provider>/<model>（跨 provider 引用唯一可复制形态）。
 *
 * provider 范围 = 旧块两层口径等价：默认 provider 全列（不筛凭据——凭据缺失
 * 属快照过期，报错兜底覆盖）+ 其余 qualifiedProviders（带凭据且清单非空，
 * model-router 单一实现）。字段提取（label/limit.context/reasoning.variants）
 * 消费 model-router.toModelEntries 单一实现（设计 V8 消重；withProvider 升格
 * ModelEntry 形态，defShort 不传 → 零 fs 且无默认标记——当前默认由 models
 * guide 文案承载，本模块只做 provider 范围迭代）。
 */
function toModelEntries(v2) {
  if (!v2 || !v2.provider) return [];
  const ids = [PROVIDER_ID, ...qualifiedProviders(v2).filter((id) => id !== PROVIDER_ID)];
  const out = [];
  for (const id of ids) {
    const models = v2.provider[id] && v2.provider[id].models;
    if (!models) continue; // 无清单 provider 跳过（原语义）
    out.push(...projectModelEntries(v2, id, { withProvider: true }));
  }
  return out;
}

/**
 * 渲染三段 XML 注入文本（各段由 core renderXmlSection 以空行分隔开头，空清单
 * 段返回空串不注入——与 pi 侧「空列表不注入」同语义）。
 * @param {object} input
 *   - v2 {object|null}          解析后的 ~/.zcode/v2/config.json 对象（可缺省/畸形，降级渲染）
 *   - cliModelMain {string}     默认模型引用（defaultModelRef(v2) 回退链产物，进 models guide）
 *   - agents {Array}            agent-discovery AgentProfile[]（含 vendored 内置 + 用户四根）
 *   - workflows {Array}         hook-source 组装的 [{name, description, path}]（内置 vendored
 *                               资产 + 用户脚本，location = 绝对路径）
 *   - nowIso {string}           快照时间戳（进 models guide 的时戳句）
 * @returns {string} 三段拼接（subagents → workflows → models；空段自然缺席）
 */
function renderResourcesBlock(input) {
  const core = coreRef.requireCore();
  const v2 = (input && input.v2) || null;
  const cliModelMain = input ? input.cliModelMain : null;
  const agents = input ? input.agents : [];
  const workflows = input ? input.workflows : [];
  const nowIso = (input && input.nowIso) || '';

  const sections = [
    core.formatAgentList(toAgentEntries(agents), {
      guide: SUBAGENTS_GUIDE,
      maxEntries: AGENTS_MAX_ENTRIES,
      truncationNotice: AGENTS_TRUNCATION_NOTICE,
    }),
    core.formatWorkflowList(toWorkflowEntries(workflows), {
      guide: WORKFLOWS_GUIDE,
      maxEntries: WORKFLOWS_MAX_ENTRIES,
      truncationNotice: WORKFLOWS_TRUNCATION_NOTICE,
    }),
    core.formatModelList(toModelEntries(v2), {
      guide: modelsGuide(nowIso, cliModelMain),
    }),
  ];
  return sections.join('');
}

// guide/截断文案常量不导出（无外部消费者）：仅 renderResourcesBlock 内部消费
module.exports = {
  renderResourcesBlock,
  AGENTS_MAX_ENTRIES,
  WORKFLOWS_MAX_ENTRIES,
  modelsGuide,
};
