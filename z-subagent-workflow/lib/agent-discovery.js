'use strict';
/**
 * agent .md 发现（W6a：切 vendored subagent-core 的 discoverResources，
 * 退役自写的四根递归 resolver——旧模块已随本切换删除）。
 *
 * 根映射（core 优先级低→高序，设计 subagent-core-convergence D-2a）：
 *   ~/.zcode/agents        → user-pi 槽（借槽：core 无通用 user-host 槽，user-pi
 *                            序位最低，恰好维持 zsw 现语义 HOME .agents > .zcode）
 *   ~/.agents/agents       → user-agents 槽（core 硬编码槽，本体根由 core 自建）
 *   <plugin>/lib/vendor    → npm 槽（一级子项 = 包目录：subagent-core/agents/
 *                            约定目录被扫中——vendored 内置 10 角色。序位 user
 *                            两级之上、project 两级之下：内置遮 user 级同名，
 *                            project 级保留用户逃生门，与 pi 内置模板同向）
 *   <wsRoot>/.zcode/agents → project-host 槽（core 宿主项目槽，project-agents 之下）
 *   <wsRoot>/.agents/agents → project-agents 槽（core 硬编码槽，项目级最高）
 *
 * hostRoots 为什么 per-call 传而不经 configureCore 的 discoveryRoots().agents：
 * project 两根随调用方 cwd 变化（workspaceRoot 每次推导），进程级回调闭包不了
 * per-call 状态；且 core 无 agents 发现包装层（discoverWorkflows 只服务 workflows
 * kind），本模块直接调 discoverResources({kind:'agents'})，hostRoots 是其显式
 * 参数。workflow 线的 discoveryRoots().workflows 注入（~/.zsw/workflows 借
 * user-pi 槽）与本路径互不相干（kind 分面）。
 *
 * 目录 symlink 展开预处理（D-2 展开段，zsw 宿主层）：core 扫描单层不递归，
 * 对四根下的一级「目录 symlink」动态展开——链接目标作为同标签额外扫描根注入，
 * 每次 discover 时重展开（库更新可持续）；realpath 已访问集合防环（**含四根
 * 本身的 realpath**，防「根 A 的链接指回根 B」的重复注入）；展开深度一层
 * （库内子目录与嵌套链接不可见，库内容需平铺库根一层——相对旧递归是声明过的
 * 行为收窄）。注入序（关键，与直觉相反）：core 合并 last-writer-wins 靠后者
 * 胜，而 zsw 现语义同根内字典序靠前者胜（本体胜）——所以**本体根必须注入在
 * 展开目标之后**；硬编码槽（user-agents/project-agents）core 自动把硬编码根
 * 排在同标签注入条目之后，同为「本体在后」。
 *
 * 与旧 resolver（递归 MAX_DEPTH=16 + node_modules/.git 排除）的声明差异：
 * - 单层扫描：子目录内 .md 不再可见（迁移方式：平铺或建目录 symlink，展开
 *   预处理保整库一链形态不断档）；
 * - node_modules 风险随单层自然消解（目录永不进入单层清单）；
 * - core isTargetFile 额外排除 `_` 前缀草稿与 `.chain.md`（pi 生态约定）；
 * - 合并键从 frontmatter name 改为文件名 stem（core 语义；名字与 stem 不一致
 *   的跨根遮蔽不再发生，两文件按各自 stem 独立成条）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const coreRef = require('./core-ref');

/** 手写 frontmatter mini 解析的消费字段白名单（其余字段忽略，避免污染 profile）。 */
const CONSUMED_KEYS = new Set([
  'name', 'description', 'when', 'model', 'tools', 'disallowedTools', 'skills', 'maxTurns',
]);

/**
 * zsw 四根定义（label = core 扫描槽位标签）。返回顺序仅供遍历确定性，
 * 遮蔽序由 core buildScanTargets 的槽位次序决定。
 */
function fourRoots({ homeDir, workspaceRoot }) {
  const home = homeDir || os.homedir();
  return [
    { label: 'user-pi', dir: path.join(home, '.zcode', 'agents') },
    { label: 'user-agents', dir: path.join(home, '.agents', 'agents') },
    { label: 'project-host', dir: path.join(workspaceRoot, '.zcode', 'agents') },
    { label: 'project-agents', dir: path.join(workspaceRoot, '.agents', 'agents') },
  ];
}

/**
 * 单根下的一级目录 symlink 展开：返回额外扫描根（链接路径，保扫描产物的
 * 路径落在根命名空间内，与旧 resolver 的 walk(linkPath) 产出一致）。
 *
 * visited 是跨根共享的 realpath 集合（调用方先种入四根本身的 realpath）：
 * 既防环（a→b→a 在首遇即剪枝），也防不同根的链接指向同一库导致重复注入，
 * 还防「根 A 的链接指回根 B」——B 本就作为自身本体被扫，重复注入是纯冗余。
 * broken symlink / 不可读根 / 链到文件（非目录）一律跳过不报错（用户目录里
 * 坏链不该炸掉发现）。展开深度一层：不递归进入展开目标。
 */
function expandRootExtras(rootDir, visited) {
  const extras = [];
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return extras; // 根不存在 / 不可读 = 无展开
  }
  const links = entries.filter((e) => e.isSymbolicLink()).map((e) => e.name).sort();
  for (const name of links) {
    const linkPath = path.join(rootDir, name);
    let real;
    try {
      real = fs.realpathSync(linkPath);
    } catch {
      continue; // broken symlink
    }
    if (visited.has(real)) continue;
    let st;
    try {
      st = fs.statSync(real);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue; // 文件级 symlink 由 core scanDirectory follow，无需预处理
    visited.add(real);
    extras.push(linkPath);
  }
  return extras;
}

/**
 * 构造 agents kind 的完整扫描输入（hostRoots 已含目录 symlink 展开 + 本体后置）。
 * 纯读 fs（readdir/realpath/stat）+ core.findWorkspaceRoot，无发现副作用——
 * 导出供测试直接断言注入序。
 */
function agentScanRoots({ cwd, homeDir, workspaceRoot } = {}) {
  const core = coreRef.requireCore();
  const wsRoot = workspaceRoot || core.findWorkspaceRoot(cwd || process.cwd());
  const roots = fourRoots({ homeDir, workspaceRoot: wsRoot });
  // 防环集合种入四根本身的 realpath（存在者才种；不存在 = 该根无内容也无处可环）
  const visited = new Set();
  for (const r of roots) {
    try {
      visited.add(fs.realpathSync(r.dir));
    } catch { /* 根不存在：跳过 */ }
  }
  const hostRoots = [];
  for (const r of roots) {
    const extras = expandRootExtras(r.dir, visited);
    // 注入序：展开目标在前、本体在后（core last-writer-wins 靠后者胜 → 本体胜，
    // 对齐 zsw 旧语义同根内字典序靠前者胜）。user-agents/project-agents 两槽的
    // 本体由 core 硬编码自建且自动排在注入条目之后（buildScanTargets 实现语义），
    // 此处只注入展开目标。
    if (r.label === 'user-agents' || r.label === 'project-agents') {
      for (const dir of extras) hostRoots.push({ dir, source: r.label });
    } else {
      for (const dir of extras) hostRoots.push({ dir, source: r.label });
      hostRoots.push({ dir: r.dir, source: r.label });
    }
  }
  // vendored 内置资产：npm 槽（dir 的一级子项 = 包目录，subagent-core/agents/
  // 约定目录被 processPackage 扫中；同目录的 VENDOR-MANIFEST.json 等非包文件
  // 按「无 manifest 的包解析」处理，无害）。无 symlink 展开（构建产物无链）。
  hostRoots.push({ dir: path.dirname(coreRef.vendorDir()), source: 'npm' });
  return { hostRoots, workspaceRoot: wsRoot, home: homeDir || os.homedir() };
}

/** 文件名 stem（无目录无扩展名）——core 合并键同构。 */
function stem(filePath) {
  const base = filePath.split('/').pop() || filePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 读单个文件并解析；不可读/不是文件返回 null。 */
function parseFile(absPath) {
  let text;
  try {
    if (!fs.statSync(absPath).isFile()) return null; // symlink 由 stat 跟随，目录不是 agent
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  return parseAgentMd(text, absPath);
}

/**
 * core discoverResources → AgentProfile[]（按 name 码点序，输出稳定）。
 * @param {string} cwd 项目目录（workspaceRoot 推导基准）
 * @param {object} [opts] { homeDir?, workspaceRoot? }（测试注入）
 */
async function listAgents(cwd, opts = {}) {
  const core = coreRef.requireCore();
  const { hostRoots, workspaceRoot } = agentScanRoots({
    cwd,
    homeDir: opts.homeDir,
    workspaceRoot: opts.workspaceRoot,
  });
  const resources = await core.discoverResources({ kind: 'agents', workspaceRoot, hostRoots });
  const profiles = [];
  for (const r of resources) {
    if (r.available === false) continue; // npm manifest 失败占位不进清单
    const profile = parseFile(r.path);
    if (!profile) continue;
    profile.source = r.source; // 来源根标签（core 槽位语义，agents 清单消费）
    profiles.push(profile);
  }
  profiles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return profiles;
}

/**
 * 按名字或路径解析单个 agent。
 * 路径形态（绝对路径 / ./ ../ 前缀）直接读文件；名字形态走 core 发现清单：
 * 先按 frontmatter name 精确匹配（旧 resolver 语义），再按文件名 stem 兜底
 * （与 core 合并键同构），最后按相对路径再试一次（旧兜底行为：agents/x.md）。
 */
async function resolveAgent(nameOrPath, cwd, opts = {}) {
  if (!nameOrPath || typeof nameOrPath !== 'string') return null;
  const isPath = path.isAbsolute(nameOrPath)
    || nameOrPath.startsWith('./') || nameOrPath.startsWith('../');
  if (isPath) {
    return parseFile(path.resolve(cwd, nameOrPath));
  }
  const want = nameOrPath.replace(/\.md$/, '');
  const list = await listAgents(cwd, opts);
  const byName = list.find((p) => p.name === want);
  if (byName) return byName;
  const byStem = list.find((p) => stem(p.filePath) === want);
  if (byStem) return byStem;
  // 兜底：带子目录的相对名（如 agents/reviewer.md）按路径再试一次，不存在则 null
  return parseFile(path.resolve(cwd, nameOrPath));
}

/**
 * 解析 agent .md：frontmatter 围栏提取 + 白名单字段规范化。
 * 无 frontmatter / 围栏未闭合：整个文本当 body，name 取文件名（宽容，不抛错）。
 * （解析函数自旧 resolver 原样迁移——解析语义不随发现切换变化。）
 */
function parseAgentMd(text, filePath) {
  let fm = {};
  let body = text;
  const lines = text.split(/\r?\n/);
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { end = i; break; }
    }
    if (end > 0) {
      fm = parseFrontmatter(lines.slice(1, end));
      body = lines.slice(end + 1).join('\n');
    }
  }
  return toProfile(fm, filePath, body);
}

/**
 * 手写 frontmatter mini 解析（不引依赖）：
 *   key: value           标量（去首尾引号）
 *   key: [a, b]          行内数组
 *   key:                 后跟缩进块
 *   - item               上一个 key 的行数组元素
 * 不支持嵌套对象——消费字段全部是标量/字符串数组，够用。
 */
function parseFrontmatter(lines) {
  const fm = Object.create(null);
  let lastKey = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue; // 空行与 # 注释
    const listItem = line.match(/^-\s+(.*)$/);
    if (listItem && lastKey) {
      if (!Array.isArray(fm[lastKey])) fm[lastKey] = [];
      fm[lastKey].push(scalar(listItem[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue; // 无法识别的行忽略（如嵌套对象，白名单外本就不消费）
    const key = kv[1];
    const val = kv[2].trim();
    lastKey = key;
    fm[key] = val === '' ? [] : scalar(val); // 空值占位空数组，等待后续 - item 行填充
  }
  return fm;
}

/** 标量解析：行内数组 → string[]，其余去引号字符串。 */
function scalar(v) {
  const t = v.trim();
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => stripQuotes(s.trim())).filter((s) => s !== '');
  }
  return stripQuotes(t);
}

function stripQuotes(s) {
  if (s.length >= 2
    && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** frontmatter 原始值 → AgentProfile 消费字段（类型不匹配的字段丢弃，不抛错）。 */
function toProfile(fm, filePath, body) {
  const fileName = path.basename(filePath, '.md');
  const profile = {
    name: pickStr(fm.name) || fileName, // name/description 缺失时 name 取文件名
    description: pickStr(fm.description) || '',
    filePath,
    body,
  };
  const model = pickStr(fm.model);
  if (model) profile.model = model;
  // engine（回接 2c）：core 路由三层优先级的 frontmatter 层——runner-core 经
  // taskCtx.agentEngine 透传给 routeEngine；未注册 id 在路由期报 engine_not_found
  //（含已注册清单与来源定位），解析期不做注册表校验（发现层不感知引擎表）
  const engine = pickStr(fm.engine);
  if (engine) profile.engine = engine;
  // when（何时用我）：索引提示字段，pi 的 available_subagents 索引含此字段——
  // 主 agent 挑 agent 时比 description 更直接命中场景
  const when = pickStr(fm.when);
  if (when) profile.when = when;
  for (const key of ['tools', 'disallowedTools', 'skills']) {
    const arr = pickStrArr(fm[key]);
    if (arr) profile[key] = arr;
  }
  const maxTurns = pickInt(fm.maxTurns); // 数值化：'25' / 25 → 25，非法丢弃
  if (maxTurns !== null) profile.maxTurns = maxTurns;
  return profile;
}

function pickStr(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function pickStrArr(v) {
  if (!Array.isArray(v)) return null;
  const arr = v.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  return arr.length ? arr : null;
}

function pickInt(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * 可注入实例（AgentResolverPort 形态：{ homeDir, list, resolve }）——assemble
 * 组装用模块级缺省，测试/隔离 HOME 用工厂注入。注意 list/resolve 是 **async**
 * （core 发现链是异步 API）：消费方必须 await（manager.start /
 * agent-runner-adapter / server agents action / hook-source 均已 await）。
 *
 * homeDir 基准口径：未显式注入时**每次调用现取** os.homedir()（POSIX 读 $HOME）
 * ——与 core 硬编码槽（user-agents/project-agents 本体根由 core 内部 homedir()
 * 现取）保持同一时点语义，测试用 env HOME 隔离时两侧不会劈叉；显式注入
 * homeDir 只影响本模块的根推导（user-pi 等 hostRoots 注入面），core 硬编码
 * 槽仍读进程 HOME——测试须保证两者指向同一目录。
 */
function createAgentDiscovery(opts = {}) {
  const inject = opts.homeDir !== undefined
    ? { homeDir: opts.homeDir, ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}) }
    : (opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {});
  return {
    get homeDir() { return inject.homeDir !== undefined ? inject.homeDir : os.homedir(); },
    list: (cwd) => listAgents(cwd, inject),
    resolve: (nameOrPath, cwd) => resolveAgent(nameOrPath, cwd, inject),
  };
}

/** 顶层模块对象 = 端口默认实现（真实 HOME；assemble 注入给 manager 与 wfHost）。 */
const defaultDiscovery = createAgentDiscovery();

module.exports = {
  createAgentDiscovery,
  listAgents,
  resolveAgent,
  agentScanRoots,
  expandRootExtras,
  fourRoots,
  parseAgentMd, // 导出供单测直接验证解析逻辑
  CONSUMED_KEYS,
  list: (cwd) => defaultDiscovery.list(cwd),
  resolve: (nameOrPath, cwd) => defaultDiscovery.resolve(nameOrPath, cwd),
};
