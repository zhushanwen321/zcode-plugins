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
 * 另有两面 core 硬编码/环境面被动进入扫描（不在 zsw 注入清单，但实际扫描面
 * 含它们；zsw 用户目录通常缺席，命中时按 core 槽位标签透传，标签映射见
 * dist/mcp/server.js 的 agentSourceLabel）：
 *   <wsRoot>/.pi/agents     → project-pi 槽（core 硬编码槽，pi 生态项目级布局）
 *   XYZ_EXTENSION_PATHS 下 agents/ → user-extension-paths 槽（扩展安装面，env 驱动）
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
 * - 去重两层（V2p C7 起）：discoverResources 资源层按文件名 stem 后写胜，
 *   discoverAgents 装配层按 frontmatter name 后写胜（声明行为变更：名字与
 *   stem 不一致的异 stem 资产现在互为遮蔽，后位根胜——测试钉住）；
 * - 装配清单只收 frontmatter 通过 core IF1 校验的条目（yaml 可解析且
 *   name/description 齐备，discoverAgents 内建闸）：无 frontmatter / 缺
 *   name/description / 字段类型不过的 .md 不进清单（`---` 开头时 core warn），
 *   但执行面 parseFile（core parseAgentProfile 宽松解析，legacy fallback 只保
 *   执行字段）按路径直达仍可用——清单收窄不影响显式引用解析。
 *
 * 解析消费（V2p C8：zsw 手写解析族 parseAgentMd/parseFrontmatter/scalar/
 * toProfile 退役）：parseFile 改 core parseAgentProfile（宽松：name 缺省
 * stem、body/执行字段全量、warnings[] 不抛；执行字段 model/tools/engine/
 * thinkingLevel/defaultBackground/maxTurns/disallowedTools/skills 直接取，
 * block-scalar description 等真 YAML 形态从「mini parser 脏值」修正为完整
 * 支持）+ getCachedParsed 获 mtime 缓存；filePath 是 zsw 消费契约投影字段
 * （core 以入参传递不落产物）。清单装配（V2p C7）改 core discoverAgents
 * （发现→解析→frontmatter name 去重后写胜→码点序），AgentEntry 无执行
 * 字段与 source/filePath——执行字段场景（resolveDefaultAgent）按 path
 * 二次 parseFile 全量取；source 按条目 path 前缀归属反查（zsw 层薄投影，
 * 标签映射仍归 dist/mcp/server.js agentSourceLabel 消费）。
 *
 * 引用契约（W6b：D-4a 收紧，与 pi 侧对齐）：agent 引用唯一形态 = .md 绝对
 * 路径（支持 ~/ 展开）；名字形态的「四根查找」已删除，传名由消费方经
 * invalidAgentRefMessage 拒绝。归一化与报错文案均消费 vendored core（V1a
 * C1/C2 收口：normalizeRef 内建 `..` 段拒绝——安全收紧，绝对路径含 `..` 从
 * 放行改拒绝；文案经 core invalidAgentRefMessage 工厂注入 zsw 恢复指引）。
 * agent 参数缺省 = general-purpose 内置角色（D-4 缺省段，resolveDefaultAgent
 * ——遮蔽序胜者，project 级可覆写）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zswCliPath } = require('./config');
const coreRef = require('./core-ref');

/** agent 参数缺省角色名（D-4 缺省语义统一：两侧同走 general-purpose 内置角色）。 */
const DEFAULT_AGENT_NAME = 'general-purpose';

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

/**
 * 稳定 parse 闭包池：core getCachedParsed 以 parse 函数引用为缓存桶键，
 * 同一 filePath 必须恒定同一闭包引用缓存才可命中（每次新建闭包 → 桶查不到
 * → 每次全量重 parse 且 parsedCache 无限增长）。池随 uniq filePath 增长，
 * 量级 = 磁盘上 agent .md 数；闭包无可变状态（filePath 常量），core
 * invalidateCache 清内层条目后闭包可继续复用。
 */
const parseFnPool = new Map();

/**
 * 读单个文件并解析（V2p C8：core getCachedParsed（mtime 缓存）+
 * parseAgentProfile 宽松解析）；不可读/目录/已删除返回 null——core 缓存对
 * statSync/readFileSync 失败（目录 readFileSync 抛 EISDIR 同样失败）统一回
 * null，与旧 statSync().isFile() 预检等值。
 */
function parseFile(absPath) {
  const core = coreRef.requireCore();
  let fn = parseFnPool.get(absPath);
  if (!fn) {
    fn = (content) => {
      const profile = core.parseAgentProfile(content, absPath);
      // zsw 消费契约投影：core AgentProfile 的 filePath 以入参传递不落产物，
      // 而 hook-inject/server 清单投影与 resolve 链按 profile.filePath 消费
      profile.filePath = absPath;
      return profile;
    };
    parseFnPool.set(absPath, fn);
  }
  return core.getCachedParsed(absPath, fn);
}

/**
 * path → 来源槽位标签的候选根索引（C7 装配改 core discoverAgents 后的 zsw
 * 薄投影：AgentEntry 不含 source，按条目 path 前缀归属反查）。候选根两股：
 * zsw 注入面（agentScanRoots 产物 hostRoots：user-pi / project-host 本体与
 * symlink 展开目标、npm vendored、user-agents / project-agents 展开目标）+
 * core 硬编码面（buildScanTargets 自建根：user-agents / project-agents 本体、
 * project-pi、XYZ_EXTENSION_PATHS——与 core 同式构造，防标签透传断链；
 * 须与 buildScanTargets 的槽位/展开式保持同步，漂移时清单 source 标签会错）。
 */
function buildSourceIndex({ hostRoots, home, workspaceRoot }) {
  const roots = hostRoots.map((r) => ({ dir: r.dir, source: r.source }));
  roots.push({ dir: path.join(home, '.agents', 'agents'), source: 'user-agents' });
  roots.push({ dir: path.join(workspaceRoot, '.pi', 'agents'), source: 'project-pi' });
  roots.push({ dir: path.join(workspaceRoot, '.agents', 'agents'), source: 'project-agents' });
  const raw = process.env.XYZ_EXTENSION_PATHS;
  if (raw) {
    for (const p of raw.split(path.delimiter).map((s) => s.trim()).filter((s) => s !== '')) {
      // ~ 前缀展开与 core readExtensionPaths 同式（slice(1) 拼 home）
      roots.push({ dir: p.startsWith('~') ? path.join(home, p.slice(1)) : p, source: 'user-extension-paths' });
    }
  }
  return roots;
}

/** 条目 path 的来源标签：最长前缀归属（根互不嵌套时唯一），无命中回空串。 */
function agentSourceForPath(filePath, roots) {
  let source = '';
  let bestLen = -1;
  for (const r of roots) {
    if ((filePath === r.dir || filePath.startsWith(r.dir + path.sep)) && r.dir.length > bestLen) {
      source = r.source;
      bestLen = r.dir.length;
    }
  }
  return source;
}

/**
 * core discoverAgents → 清单条目[]（frontmatter name 去重后写胜 + 码点序，
 * 输出稳定）。装配循环（发现→逐个 parseFile→去重→排序）随 C7 退役改调
 * core 单点；本层只做 AgentEntry → zsw 清单投影：filePath（消费契约字段）、
 * source（path 前缀归属反查，server agentSourceLabel 的槽位标签源）、
 * name/description/when 索引字段透传——执行字段（body/model 等）不投影，
 * 需要处（resolveDefaultAgent）按 path 二次 parseFile 全量取。
 * @param {string} cwd 项目目录（workspaceRoot 推导基准）
 * @param {object} [opts] { homeDir?, workspaceRoot? }（测试注入）
 */
async function listAgents(cwd, opts = {}) {
  const core = coreRef.requireCore();
  const { hostRoots, workspaceRoot, home } = agentScanRoots({
    cwd,
    homeDir: opts.homeDir,
    workspaceRoot: opts.workspaceRoot,
  });
  const entries = await core.discoverAgents(workspaceRoot, hostRoots);
  const sourceIndex = buildSourceIndex({ hostRoots, home, workspaceRoot });
  return entries.map((e) => ({
    name: e.name,
    description: e.description,
    ...(e.when !== undefined ? { when: e.when } : {}),
    filePath: e.path,
    source: agentSourceForPath(e.path, sourceIndex),
  }));
}

/**
 * agent 引用归一化（D-4a：仅绝对路径）——core normalizeRef 单源薄委托（V1a
 * C1/C2：旧「core 口径复刻」退役；领地外 agent-runner-adapter 仍按本签名
 * 消费，包装登记待 V3w 随该面收口退役）。语义：trim → `~/` 前缀展开 →
 * 绝对路径校验 → `.md` 后缀校验 + `..` 段拒绝（C2 安全收紧，行为变更：复刻
 * 版无此闸，绝对路径含 `..` 曾放行）。相对路径 / 名字 / `..` / 非 .md 一律 null。
 * @param {string} ref 原始引用（注入段 location / 工具参数值）
 * @param {object} [opts] { homeDir? }（`~/` 展开基准，缺省进程 HOME——core
 *        展开固定读 os.homedir()；homeDir 显式注入（测试隔离面）时在此预展开，
 *        展开产物交 core 只做 `..` 段/绝对路径/后缀校验）
 */
function normalizeAgentRef(ref, opts = {}) {
  // core 对非 string 抛 TypeError（ref.trim）；插件契约非 string → null，
  // 消费方落 invalidAgentRefMessage 可操作报错（既有行为等值）
  if (typeof ref !== 'string') return null;
  const core = coreRef.requireCore();
  let candidate = ref;
  if (opts.homeDir !== undefined) {
    const trimmed = candidate.trim();
    if (trimmed.startsWith('~/')) {
      // 字符串级拼接而非 path.join：join 会规范化消解 `..` 段，令注入路径
      // 逃过 core 的 `..` 闸（core 对进程 HOME 的 `~/../x` 同样拒——检查在
      // 展开前，两侧必须同拒）
      const base = opts.homeDir.endsWith(path.sep) ? opts.homeDir : opts.homeDir + path.sep;
      candidate = base + trimmed.slice('~/'.length);
    }
  }
  return core.normalizeRef(candidate, core.AGENT_REF_EXT);
}

/**
 * 按路径解析单个 agent（D-4a 收紧后唯一解析形态）。
 * 非法引用（名字/相对路径/`..` 段/非 .md）与文件不可读统一返回 null——两类
 * 失败的报错文案由消费方（manager.start / agent-runner-adapter）经
 * invalidAgentRefMessage / agentFileNotFoundMessage 区分给出（core 同源）。
 */
async function resolveAgent(ref, cwd, opts = {}) {
  void cwd; // 路径唯一形态下无相对解析基准（与 core normalizeRef 同口径）
  const norm = normalizeAgentRef(ref, opts);
  if (norm === null) return null;
  return parseFile(norm);
}

/**
 * 缺省角色解析（D-4 缺省段：agent 参数缺省 → general-purpose 内置角色）。
 * 经发现清单取遮蔽序胜者（project 级同名 .md 遮蔽 vendored 内置——逃生门
 * 与 pi 同向）；清单条目是索引投影（AgentEntry 无执行字段），命中后按
 * path 二次 parseFile 全量取（getCachedParsed 缓存命中，无二次 IO），
 * source 随条目透传（执行面不消费，保持与旧 listAgents 产物字段等值）；
 * 清单异常/miss（含 IF1 闸把覆写挡在清单外）时直读 vendored 资产兜底
 * （插件残缺读不到则 null，调用方退化为无角色裸跑并如实留 record.agent=null）。
 */
async function resolveDefaultAgent(cwd, opts = {}) {
  try {
    const list = await listAgents(cwd, opts);
    const hit = list.find((p) => p.name === DEFAULT_AGENT_NAME);
    if (hit) {
      const profile = parseFile(hit.filePath);
      if (profile) return { ...profile, source: hit.source };
    }
  } catch { /* 发现面异常（根不可读等）：走 vendored 直读兜底 */ }
  return parseFile(path.join(coreRef.vendorDir(), 'agents', `${DEFAULT_AGENT_NAME}.md`));
}

/**
 * 非法 agent 引用报错——core invalidAgentRefMessage 工厂单源（V1a C1：旧
 * 「主句逐字复刻」退役改委托；`..` 段引用由工厂内建 without ".." path
 * segments 拒绝分支承接，C2 行为变更的报错面）。howToList 注入 zsw 双出口
 * 恢复指引（与 SessionStart 注入段出口同源：注入段 <available_subagents>
 * 条目的 <location>，或 zsw agents 查路径清单；查询命令给完整可执行形态
 * ——F12：marketplace/inline 形态下裸 `zsw` 不在 PATH，路径单源
 * config.zswCliPath）。howToList 取值使非 `..` 分支整句与旧复刻文案逐字一致。
 */
function invalidAgentRefMessage(ref) {
  const core = coreRef.requireCore();
  // String() 防御：core 工厂对非 string 抛 TypeError（hasParentSegment 调
  // ref.split），旧宿主模板串任意类型安全——保持等值（非 string 参数同样
  // 落可操作报错而非 TypeError）
  return core.invalidAgentRefMessage(String(ref), {
    howToList: `<available_subagents>, or run node "${zswCliPath()}" agents to list paths`,
  });
}

/**
 * 路径合法但文件不可读的报错（同 core agent-registry 的 Agent file not found
 * 文案，恢复指引同上双出口）。
 */
function agentFileNotFoundMessage(filePath) {
  return `Agent file not found or unreadable: ${filePath}.`
    + ` Use an absolute path from <available_subagents> <location>, or run node "${zswCliPath()}" agents to list paths.`;
}

/**
 * 可注入实例（AgentResolverPort 形态：{ homeDir, list, resolve, resolveDefault }）
 * ——assemble 组装用模块级缺省，测试/隔离 HOME 用工厂注入。注意 list/resolve/
 * resolveDefault 是 **async**（core 发现链是异步 API）：消费方必须 await
 * （manager.start / agent-runner-adapter / server agents action / hook-source
 * 均已 await）。
 *
 * homeDir 基准口径：未显式注入时**每次调用现取** os.homedir()（POSIX 读 $HOME）
 * ——与 core 硬编码槽（user-agents/project-agents 本体根由 core 内部 homedir()
 * 现取）保持同一时点语义，测试用 env HOME 隔离时两侧不会劈叉；显式注入
 * homeDir 只影响本模块的根推导（user-pi 等 hostRoots 注入面与 normalizeRef
 * 的 ~/ 展开），core 硬编码槽仍读进程 HOME——测试须保证两者指向同一目录。
 */
function createAgentDiscovery(opts = {}) {
  const inject = opts.homeDir !== undefined
    ? { homeDir: opts.homeDir, ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}) }
    : (opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {});
  return {
    get homeDir() { return inject.homeDir !== undefined ? inject.homeDir : os.homedir(); },
    list: (cwd) => listAgents(cwd, inject),
    resolve: (ref, cwd) => resolveAgent(ref, cwd, inject),
    resolveDefault: (cwd) => resolveDefaultAgent(cwd, inject),
  };
}

/** 顶层模块对象 = 端口默认实现（真实 HOME；assemble 注入给 manager 与 wfHost）。 */
const defaultDiscovery = createAgentDiscovery();

module.exports = {
  createAgentDiscovery,
  listAgents,
  resolveAgent,
  resolveDefaultAgent,
  agentScanRoots,
  parseFile, // 导出供单测直接验证解析逻辑（V2p C8 起 = core 缓存 + 宽松解析薄投影）
  normalizeAgentRef,
  invalidAgentRefMessage,
  agentFileNotFoundMessage,
  list: (cwd) => defaultDiscovery.list(cwd),
  resolve: (ref, cwd) => defaultDiscovery.resolve(ref, cwd),
  resolveDefault: (cwd) => defaultDiscovery.resolveDefault(cwd),
};
