'use strict';
/**
 * SessionStart hook 注入块渲染纯函数（设计：docs/design/zsw-session-start-injection-design.md §3.1 样例 + D3）。
 *
 * 零 fs/网络：输入均为调用方解析后的普通对象（v2 config 对象 / cli 主模型名 /
 * agent 清单 / 脚本名 / 内置 workflow 名 / 快照时间戳），文件读取在
 * bin/zsw.js hook session-start 侧完成。本模块不触碰任何 IO。
 *
 * 渲染口径与 lib/model-router.js 严格同源：
 * - 默认 provider = model-router 的 PROVIDER_ID（即其内部 DEFAULT_PROVIDER_ID，
 *   短名解析的 target）；
 * - 模型清单 = provider.models 对象键集（availableModels 同款语义）；
 * - 默认标记 = cliModelMain 按全名/短名口径可被默认 provider 清单解析时才标
 *   （resolvableInV2 同款切分：含 "/" 按 lastIndexOf 切 provider，否则归默认 provider）；
 * - apiKey 判定 = e.options.apiKey truthy（driver.js bootstrapIsolatedHome 同款）。
 *
 * 两层 models（D3）：默认 provider 段只渲染模型名单 + 默认标记，且不筛
 * apiKey（锚定 zsw models 口径，凭据缺失属快照过期由报错兜底覆盖）；其余
 * provider 须 apiKey 非空且模型清单非空，只以全名 <provider>/<model> 列出。
 * UUID 形态 provider（36 位带连字符）缩写为前 8 位 + …，首次出现附全名对照。
 *
 * 硬预算 ≤45 行（D3）：超限优先保留 models 段（永不截断），依次截 agents 段
 * （裁条目 + 「完整清单：zsw agents」标注）、workflows 段（丢自定义名单 +
 * 「完整清单：zsw workflow --action scripts」标注）。models 自身超常时以
 * models 优先击穿预算——provider 数是 GUI 配置量级（个位数），不设防。
 *
 * agents 段为「段头行 + 每 agent 一行」形态而非 §3.1 样例的单行省略示意：
 * D3 证据「两层渲染约 15-20 行」（6 agents 实测规模）与「构造大量 agents 使
 * 45 行爆掉」的截断序验收均要求 agents 行数随数量增长，且超长单行违背
 * G4 的 token 预算意图。
 */

const { PROVIDER_ID } = require('./model-router');

const HARD_BUDGET_LINES = 45;
const SNAPSHOT_HEADER = 'zsw 可用资源快照（会话启动时生成，GUI 中途改动后可能过期）';
const FALLBACK_LINE =
  '兜底：传错模型名时报错自带可用清单（零依赖权威兜底）；主动现查 zsw models / zsw agents' +
  '（需 daemon 在跑——任一启用插件的会话）';
const AGENTS_HEADER = 'agents（四根发现，同名高优先级根胜出）：';
const OTHER_PROVIDERS_HEADER = '  其他可运行 provider（跨 provider 必须用全名 <provider>/<model>）：';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** provider 下模型名单（model-router.availableModels 同款：models 对象键集）。 */
function availableModelsOf(v2, provider) {
  const e = v2 && v2.provider && v2.provider[provider];
  return Object.keys((e && e.models) || {});
}

/** 模型引用切分（resolvableInV2 同款：含 "/" 按 lastIndexOf 切，短名归默认 provider）。 */
function splitModelRef(ref) {
  const s = String(ref);
  return s.includes('/')
    ? { provider: s.slice(0, s.lastIndexOf('/')), model: s.slice(s.lastIndexOf('/') + 1) }
    : { provider: PROVIDER_ID, model: s };
}

/** 默认标记的模型短名：cliModelMain 可被默认 provider 清单解析时返回短名，否则 null。 */
function defaultMarkerShort(v2, cliModelMain) {
  if (typeof cliModelMain !== 'string' || !cliModelMain.trim()) return null;
  const { provider, model } = splitModelRef(cliModelMain.trim());
  if (provider !== PROVIDER_ID) return null;
  return availableModelsOf(v2, provider).includes(model) ? model : null;
}

/**
 * 其余可运行 provider 行（每 provider 一行）：apiKey 非空且模型清单非空才列；
 * 模型以全名 <provider>/<model> 列出；UUID 形态 provider 缩写为前 8 位并附
 * 「<缩写> 即 <全名>」对照（紧跟首个模型条目，§3.1 样例形态）。
 */
function otherProviderLines(v2) {
  const lines = [];
  for (const [id, e] of Object.entries((v2 && v2.provider) || {})) {
    if (id === PROVIDER_ID) continue;
    if (!(e && e.options && e.options.apiKey)) continue; // driver.js:167 同款判定
    const models = Object.keys((e && e.models) || {});
    if (!models.length) continue;
    const isUuid = UUID_RE.test(id);
    const abbr = isUuid ? id.slice(0, 8) + '…' : id;
    const items = models.map((m) => `${abbr}/${m}`);
    if (isUuid) items.splice(1, 0, `${abbr} 即 ${id}`);
    lines.push('    ' + items.join(' · '));
  }
  return lines;
}

/** agents 条目：name（description 截 20 字）；无描述只列 name；无名条目丢弃。 */
function agentEntries(agents) {
  const out = [];
  for (const a of Array.isArray(agents) ? agents : []) {
    const name = a && String(a.name || '').trim();
    if (!name) continue;
    const desc = a && String(a.description || '').trim().slice(0, 20);
    out.push(desc ? `${name}（${desc}）` : name);
  }
  return out;
}

/**
 * agents 段渲染（预算驱动）。budget = 本段可用行数。
 * 返回 { lines, truncated }；lines.length 恒 ≤ max(budget, 1)。
 */
function renderAgents(agents, budget) {
  const entries = agentEntries(agents);
  const n = entries.length;
  if (!n) return { lines: [AGENTS_HEADER + '（无）'], truncated: false };
  if (budget >= n + 1) {
    return { lines: [AGENTS_HEADER, ...entries.map((s) => '  ' + s)], truncated: false };
  }
  const visible = Math.max(0, budget - 2); // 预留给段头行 + 标注行
  if (visible >= 1) {
    return {
      lines: [
        AGENTS_HEADER,
        ...entries.slice(0, visible).map((s) => '  ' + s),
        '  …（截断，完整清单：zsw agents）',
      ],
      truncated: true,
    };
  }
  return { lines: [AGENTS_HEADER + '（截断，完整清单：zsw agents）'], truncated: true };
}

/** workflows 行：内置名单 + script 计数（>0 时列名）；截断态丢名单换标注。 */
function workflowLine(builtinWorkflows, scripts, truncated) {
  const builtins = (Array.isArray(builtinWorkflows) ? builtinWorkflows : []).map(String);
  const names = (Array.isArray(scripts) ? scripts : []).map(String);
  const builtinPart = builtins.length ? `内置 ${builtins.join(' / ')}` : '内置（无）';
  let scriptPart;
  if (!names.length) {
    scriptPart = 'script:<名> 自定义（当前 0 个）';
  } else if (truncated) {
    scriptPart = `script:<名> 自定义（当前 ${names.length} 个，完整清单：zsw workflow --action scripts）`;
  } else {
    scriptPart = `script:<名> 自定义（当前 ${names.length} 个：${names.join(' · ')}）`;
  }
  return `workflows：${builtinPart}；${scriptPart}`;
}

/**
 * 渲染 <zsw-resources> 注入块。
 * @param {object} input
 *   - v2 {object|null}      解析后的 ~/.zcode/v2/config.json 对象（可缺省/畸形，降级渲染）
 *   - cliModelMain {string} 默认模型引用（调用方传 model-router.defaultModelRef(v2) 回退链产物：cli.main 可解析 → v2 顶层 model.main → 内置回退；与 zsw models 默认标记同口径，可缺省）
 *   - agents {Array}        [{name, description}]
 *   - scripts {Array}       自定义 workflow 脚本名
 *   - builtinWorkflows {Array} 内置 workflow 名（内置五名由调用方传）
 *   - nowIso {string}       快照时间戳（写入 snapshot 属性）
 * @returns {string} 多行文本（\n 连接），行数 ≤ 45（models 超常时以 models 优先击穿）
 */
function renderResourcesBlock(input) {
  const v2 = (input && input.v2) || null;
  const cliModelMain = input ? input.cliModelMain : null;
  const agents = input ? input.agents : [];
  const scripts = input ? input.scripts : [];
  const builtinWorkflows = input ? input.builtinWorkflows : [];
  const nowIso = (input && input.nowIso) || '';

  const lines = [];
  lines.push(`<zsw-resources snapshot="${nowIso}">`);
  lines.push(SNAPSHOT_HEADER);
  lines.push('models：');

  // 默认 provider 段：名单 + 默认标记，不筛 apiKey
  const defModels = availableModelsOf(v2, PROVIDER_ID);
  const defShort = defaultMarkerShort(v2, cliModelMain);
  const defList = defModels.length
    ? defModels.map((m) => (m === defShort ? `${m}（默认）` : m)).join(', ')
    : '（无可用模型清单）';
  lines.push(`  默认 provider ${PROVIDER_ID}（短名直接可传）：${defList}`);

  // 其余可运行 provider 段：apiKey 非空且模型非空，全名形态
  const others = otherProviderLines(v2);
  if (others.length) {
    lines.push(OTHER_PROVIDERS_HEADER);
    lines.push(...others);
  }

  // 预算分配：models 已定型（永不截），剩余给 agents + workflows（workflows 保底 1 行）
  const remaining = HARD_BUDGET_LINES - (lines.length + 2); // +2 = 兜底行 + 闭合标签
  const agentsRes = renderAgents(agents, Math.max(1, remaining - 1));
  lines.push(...agentsRes.lines);
  lines.push(workflowLine(builtinWorkflows, scripts, remaining - agentsRes.lines.length < 1));

  lines.push(FALLBACK_LINE);
  lines.push('</zsw-resources>');
  return lines.join('\n');
}

module.exports = { renderResourcesBlock };
