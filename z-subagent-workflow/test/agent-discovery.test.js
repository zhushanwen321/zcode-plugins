'use strict';
/**
 * lib/agent-discovery 单测（W6a：agent 发现切 vendored core discoverResources；
 * V2p C7/C8：装配循环退役改 core discoverAgents、解析族退役改 core
 * parseAgentProfile + getCachedParsed）。
 *
 * 覆盖面（对应设计 D-2 与验收 A7/序位探针）：
 * - 根映射序位：user 级 < vendored 内置 < project 级（user 级同名被内置遮蔽、
 *   project 级同名遮蔽内置——逃生门成立）
 * - 四根级联：ws/.agents > ws/.zcode > ~/.agents > ~/.zcode（非内置名逐级下移）
 * - 目录 symlink 整库展开：库内 .md 与同根本体散 .md 同时可发现（不互相顶掉）；
 *   同 stem 撞名 → 本体胜（注入序语义：本体根注入在展开目标之后）
 * - symlink 环正常终止（防环集合含四根本身 realpath）；跨根链接不重复注入
 * - 文件级 symlink 可发现（core async 扫描 follow）；broken link 跳过
 * - 引用契约（W6b，D-4a 收紧 + D-4 缺省统一）：resolve 仅路径形态
 *   （~/ 展开）；名字/相对路径/非 .md 拒（normalizeAgentRef = core
 *   normalizeRef 单源薄委托）；`..` 段引用拒绝且报错带恢复指引（V1a C2
 *   行为变更：复刻版无 .. 闸）；resolveDefault = general-purpose（vendored
 *   兜底 + project 级遮蔽胜）
 * - 装配语义（V2p C7）：去重键 = frontmatter name（声明行为变更：异 stem
 *   同 name 资产互遮蔽、后位根胜——旧 stem 键下两文件独立成条）；输出码点
 *   序；IF1 装配闸（frontmatter 不通过的 .md 不进清单，执行面路径直达仍可
 *   解析）
 * - 解析语义（V2p C8，经 parseFile → core parseAgentProfile 宽松解析）：
 *   全字段/缺省 stem/无 frontmatter/未闭合 legacy fallback/block-scalar
 *   description 完整支持（fixture t-sink.md）
 *
 * 隔离：HOME env 指临时目录（core 硬编码 user-agents 槽与本文档模块的
 * homeDir 基准都在调用期读 $HOME，两侧同源）；vendored npm 槽是插件目录
 * 绝对路径，测试环境恒在场——精确断言用户根条目时按 source!=='npm' 过滤。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const discovery = require('../lib/agent-discovery');
const { parseFile } = discovery;

/** vendored 内置 10 名（= lib/vendor/subagent-core/agents/ 文件 stem）。 */
const BUILTIN_NAMES = [
  'analyst', 'coder', 'debugger', 'doc-reviewer', 'explorer',
  'general-purpose', 'orchestrator', 'planner', 'researcher', 'reviewer',
];

/**
 * 临时 HOME + ws fixture：env HOME 指临时目录（t.after 恢复），返回
 * { tmp, home, ws }。homeDir 显式注入与 env HOME 同值——core 硬编码槽
 * （user-agents/project-agents 本体）读进程 HOME，两侧必须一致。
 */
function setupFixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-agent-disc-'));
  const home = path.join(tmp, 'home');
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(ws, '.agents', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.zcode', 'agents'), { recursive: true });
  const prev = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { tmp, home, ws };
}

/** 在 dir 下写一个 agent .md（自动建父目录），返回文件绝对路径。 */
function mkAgent(dir, name, extra = '') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: d-${name}\n${extra}---\n\nbody-${name}\n`);
  return file;
}

/**
 * 自定义 frontmatter 行的 agent .md（extra 参数会产生重复 description 行，
 * core IF1 校验拒重复 key——需要覆盖 description 等自定义字段时用本函数）。
 */
function mkAgentFm(dir, stem, fmLines) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stem}.md`);
  fs.writeFileSync(file, `---\n${fmLines.join('\n')}\n---\n\nbody-${stem}\n`);
  return file;
}

/** 用户根条目视图（剔除 vendored 内置，精确断言四根行为）。 */
const userEntries = (list) => list.filter((p) => p.source !== 'npm');

// ------------------------------------------------------------- 序位（验收探针）

test('序位：user 级同名被 vendored 内置遮蔽（user < 内置）', async (t) => {
  const { home, ws } = setupFixture(t);
  mkAgentFm(path.join(home, '.zcode', 'agents'), 'reviewer', ['name: reviewer', 'description: user-old']);
  const list = await discovery.listAgents(ws, { homeDir: home });
  const reviewer = list.find((p) => p.name === 'reviewer');
  assert.ok(reviewer, 'reviewer 在场');
  assert.equal(reviewer.source, 'npm', 'vendored 内置胜出');
  assert.ok(reviewer.filePath.includes(path.join('vendor', 'subagent-core', 'agents')),
    `location 指向 vendored 路径: ${reviewer.filePath}`);
});

test('序位：project 级同名遮蔽 vendored 内置（逃生门成立）', async (t) => {
  const { home, ws } = setupFixture(t);
  const projFile = mkAgent(path.join(ws, '.agents', 'agents'), 'reviewer');
  const list = await discovery.listAgents(ws, { homeDir: home });
  const reviewer = list.find((p) => p.name === 'reviewer');
  assert.equal(reviewer.filePath, projFile, 'project 级同名胜出（内置被遮蔽）');
  assert.equal(reviewer.source, 'project-agents');
});

test('序位：vendored 内置 10 个全部可发现（npm 槽注入）', async (t) => {
  const { home, ws } = setupFixture(t);
  const list = await discovery.listAgents(ws, { homeDir: home });
  const vendored = list.filter((p) => p.source === 'npm');
  assert.deepEqual(vendored.map((p) => p.name), BUILTIN_NAMES.slice().sort(),
    '内置 10 名齐且按码点序');
  for (const p of vendored) {
    assert.ok(p.filePath.endsWith(path.join('vendor', 'subagent-core', 'agents', `${p.name}.md`)),
      `vendored location: ${p.filePath}`);
    assert.equal(p.available, undefined); // profile 形态无 available 字段（已过滤占位）
  }
});

test('四根级联：ws/.agents > ws/.zcode > ~/.agents > ~/.zcode（非内置名）', async (t) => {
  const { tmp, home, ws } = setupFixture(t);
  const roots = [
    path.join(ws, '.agents', 'agents'),
    path.join(ws, '.zcode', 'agents'),
    path.join(home, '.agents', 'agents'),
    path.join(home, '.zcode', 'agents'),
  ];
  roots.forEach((r, i) => {
    mkAgentFm(r, 'cascade-probe', ['name: cascade-probe', `description: from root ${i}`]);
  });
  // 逐级删除高优先级文件，验证胜出顺序逐级下移（D-4a 后引用仅路径形态，
  // 遮蔽序断言走 listAgents——resolveAgent 不再做名字四根查找）
  for (let i = 0; i < roots.length; i++) {
    const list = await discovery.listAgents(ws, { homeDir: home });
    const p = list.find((x) => x.name === 'cascade-probe');
    assert.ok(p, `第 ${i} 级应有 cascade-probe`);
    assert.equal(p.description, `from root ${i}`);
    assert.equal(p.filePath, path.join(roots[i], 'cascade-probe.md'));
    // 命中路径再经 resolveAgent 路径形态解析（消费方实际链路）
    const hit = await discovery.resolveAgent(p.filePath, ws, { homeDir: home });
    assert.equal(hit.filePath, p.filePath);
    fs.rmSync(path.join(roots[i], 'cascade-probe.md'));
  }
  const list = await discovery.listAgents(ws, { homeDir: home });
  assert.equal(list.find((x) => x.name === 'cascade-probe'), undefined,
    '四根删空后清单无此条（非内置名无 vendored 回落）');
  void tmp;
});

// ------------------------------------------------------- 目录 symlink 展开（A7）

test('目录 symlink 整库：库内 .md 与本体散 .md 同时可发现；同 stem 撞名本体胜', async (t) => {
  const { tmp, home, ws } = setupFixture(t);
  const root = path.join(ws, '.zcode', 'agents');
  const ownScout = mkAgent(root, 'scout'); // 本体散文件
  const lib = path.join(tmp, 'personal-agents');
  mkAgent(lib, 'lib-helper'); // 库内独有
  mkAgent(lib, 'scout'); // 与本体同名（stem 撞名）
  fs.symlinkSync(lib, path.join(root, 'my-lib'));

  const list = await discovery.listAgents(ws, { homeDir: home });
  const users = userEntries(list);
  const scout = users.find((p) => p.name === 'scout');
  const helper = users.find((p) => p.name === 'lib-helper');
  assert.ok(scout && helper, '本体与库内条目同时在清单（不互相顶掉）');
  assert.equal(scout.filePath, ownScout, '同 stem 撞名 → 本体胜（注入序：本体根在展开目标之后）');
  assert.equal(scout.source, 'project-host');
  assert.equal(helper.filePath, path.join(root, 'my-lib', 'lib-helper.md'),
    '库内条目路径落在根命名空间（链接路径前缀）');
  assert.equal(helper.source, 'project-host', '展开目标与本体同标签（同序位扫描）');

  // 按路径解析：库内独有条目可命中（D-4a 后唯一引用形态）
  const hit = await discovery.resolveAgent(path.join(root, 'my-lib', 'lib-helper.md'), ws, { homeDir: home });
  assert.equal(hit.filePath, path.join(root, 'my-lib', 'lib-helper.md'));
});

test('目录 symlink：硬编码槽根（~/.agents/agents）同样展开且本体胜', async (t) => {
  const { tmp, home, ws } = setupFixture(t);
  const root = path.join(home, '.agents', 'agents');
  const own = mkAgent(root, 'guard');
  const lib = path.join(tmp, 'lib2');
  mkAgent(lib, 'guard');
  mkAgent(lib, 'extra');
  fs.symlinkSync(lib, path.join(root, 'my-lib'));

  const list = await discovery.listAgents(ws, { homeDir: home });
  const users = userEntries(list);
  assert.equal(users.find((p) => p.name === 'guard').filePath, own,
    '硬编码槽：core 自动把本体根排在注入展开目标之后 → 本体胜');
  assert.ok(users.find((p) => p.name === 'extra'), '库内条目可发现');
});

test('symlink 环正常终止；指向其他根的链接不重复注入；broken link 跳过', async (t) => {
  const { tmp, home, ws } = setupFixture(t);
  const zcodeRoot = path.join(ws, '.zcode', 'agents');
  const agentsRoot = path.join(ws, '.agents', 'agents');
  mkAgent(zcodeRoot, 'ok');
  mkAgent(agentsRoot, 'other');
  fs.symlinkSync(zcodeRoot, path.join(zcodeRoot, 'loop')); // 指向自身的目录环
  fs.symlinkSync(agentsRoot, path.join(zcodeRoot, 'to-agents-root')); // 指回另一根
  fs.symlinkSync(path.join(tmp, 'no-such-dir'), path.join(zcodeRoot, 'broken'));

  const list = await discovery.listAgents(ws, { homeDir: home });
  const users = userEntries(list);
  const names = users.map((p) => p.name);
  assert.deepEqual(names.sort(), ['ok', 'other'], '环剪枝、跨根链接跳过、broken 跳过、正常文件保留');
  assert.equal(users.filter((p) => p.name === 'other').length, 1, '被指向的根不被重复注入');
});

// --------------------------------------------------------------- 其他发现形态

test('文件级 symlink 指向根外文件可被发现；子目录内 .md 单层不可见（声明收窄）', async (t) => {
  const { tmp, home, ws } = setupFixture(t);
  const root = path.join(ws, '.agents', 'agents');
  mkAgent(root, 'local');
  const outside = mkAgent(path.join(tmp, 'lib'), 'coder-ext');
  fs.symlinkSync(outside, path.join(root, 'linked.md')); // 文件级链（stem=linked）
  fs.mkdirSync(path.join(root, 'subdir'), { recursive: true });
  mkAgent(path.join(root, 'subdir'), 'nested'); // 子目录（单层语义不可见）

  const users = userEntries(await discovery.listAgents(ws, { homeDir: home }));
  // 条目身份按 filePath 斤两：文件级链以链接路径在清单（name 来自目标内容）
  const linked = users.find((p) => p.filePath === path.join(root, 'linked.md'));
  assert.ok(linked, '文件级 symlink 被发现（core async 扫描 follow）');
  assert.equal(linked.name, 'coder-ext', 'name 来自目标文件 frontmatter');
  // 清单条目是索引投影（V2p C7 起 AgentEntry 无 body）——正文断言走
  // resolveAgent 执行面（同 parseFile 链）
  const linkedProfile = await discovery.resolveAgent(linked.filePath, ws, { homeDir: home });
  assert.equal(linkedProfile.body.trim(), 'body-coder-ext');
  assert.ok(users.some((p) => p.name === 'local'));
  assert.ok(!users.some((p) => p.name === 'nested'), '子目录 .md 单层不可见（迁移：平铺或目录 symlink）');
  assert.equal(users.filter((p) => p.name === 'coder-ext').length, 1,
    '链接与真实文件不同根（根外文件本体不在任何根内），清单只此一条');
});

test('resolve（D-4a 收紧）：绝对路径成；名字/相对路径/非 .md 拒；~/ 展开；未命中 null', async (t) => {
  const { home, ws } = setupFixture(t);
  const file = mkAgent(path.join(ws, '.agents', 'agents'), 'custom-agent');
  assert.equal((await discovery.resolveAgent(file, ws, { homeDir: home })).filePath, file);
  // ~/ 展开形态（core normalizeRef 口径——homeDir 注入隔离）
  const homeFile = mkAgent(path.join(home, '.zcode', 'agents'), 'tilde-agent');
  assert.equal((await discovery.resolveAgent('~/.zcode/agents/tilde-agent.md', ws, { homeDir: home })).filePath, homeFile);
  // 名字形态（含带 .md）一律 null——四根查找已退役，消费方经 invalidAgentRefMessage 拒
  assert.equal(await discovery.resolveAgent('custom-agent', ws, { homeDir: home }), null);
  assert.equal(await discovery.resolveAgent('custom-agent.md', ws, { homeDir: home }), null);
  assert.equal(await discovery.resolveAgent('general-purpose', ws, { homeDir: home }), null,
    '内置名同样不可按名引用（缺省解析走 resolveDefault，显式引用走路径）');
  // 相对路径/非 .md 拒（core normalizeRef 口径）
  assert.equal(await discovery.resolveAgent('./.agents/agents/custom-agent.md', ws, { homeDir: home }), null);
  assert.equal(await discovery.resolveAgent('/abs/custom-agent.txt', ws, { homeDir: home }), null);
  assert.equal(await discovery.resolveAgent(path.join(ws, 'nope.md'), ws, { homeDir: home }), null);
  // `..` 段引用拒（V1a C2 行为变更：即使路径写法上能命中真实文件也不解析）
  assert.equal(await discovery.resolveAgent('/abs/../evil.md', ws, { homeDir: home }), null, '.. 段引用拒');
});

test('normalizeAgentRef：core normalizeRef 单源（trim/~/展开/绝对路径/.md 后缀/.. 拒绝）', () => {
  const N = discovery.normalizeAgentRef;
  assert.equal(N('/a/b/c.md'), '/a/b/c.md');
  assert.equal(N('  /a/b/c.md  '), '/a/b/c.md', '首尾空白 trim');
  assert.equal(N('~/.zcode/agents/x.md', { homeDir: '/H' }), path.join('/H', '.zcode/agents/x.md'));
  assert.equal(N('~/x.md', { homeDir: '/H' }), path.join('/H', 'x.md'));
  // 非法形态全 null
  assert.equal(N('reviewer'), null, '名字');
  assert.equal(N('reviewer.md'), null, '名字带扩展');
  assert.equal(N('./x.md'), null, '相对路径 ./');
  assert.equal(N('../x.md'), null, '相对路径 ../');
  assert.equal(N('/abs/x.txt'), null, '非 .md 后缀');
  assert.equal(N(''), null, '空串');
  assert.equal(N(null), null, '非字符串');
  assert.equal(N(undefined), null, 'undefined');
  // `..` 段拒绝（V1a C2 行为变更：复刻版对绝对路径放行，core normalizeRef 内建拒绝）
  assert.equal(N('/x/../evil.md'), null, '绝对路径含 .. 段');
  assert.equal(N('/a/b/../../etc/passwd.md'), null, '连续 .. 段');
  assert.equal(N('/ok/../x.md'), null, '.. 居中段');
  assert.equal(N('/x/../evil.md', { homeDir: '/H' }), null, 'homeDir 注入路径同样拒');
  assert.equal(N('~/.zcode/../evil.md', { homeDir: '/H' }), null, '~/ 注入展开产物含 .. 段同样拒');
  // 不误伤：段内含点点但非独立 .. 段的合法路径（旧复刻口径等值保留）
  assert.equal(N('/abs/x..md'), '/abs/x..md', '段内点点非独立 .. 段');
  assert.equal(N('/a...b/c.md'), '/a...b/c.md', '三点段名');
});

test('.. 引用拒绝消息：core 工厂分支 + zsw 恢复指引（可从哪里查可用 agent）', () => {
  const msg = discovery.invalidAgentRefMessage('/x/../evil.md');
  assert.ok(msg.includes('without ".." path segments'), `含 .. 拒绝语义主句: ${msg}`);
  assert.ok(msg.startsWith('Invalid agent ref: /x/../evil.md.'), `主句携带原始引用: ${msg}`);
  assert.ok(msg.includes('use <location> from <available_subagents>'), `含注入段出口: ${msg}`);
  assert.ok(msg.includes(`node "${process.env.ZCODE_PLUGIN_ROOT || path.join(__dirname, '..', 'bin', 'zsw.js')}" agents`),
    `含清单查询出口（完整可执行 CLI 形态）: ${msg}`);
  // 普通非法引用走非 .. 分支：主句与旧宿主复刻逐字同源（非声明行为等值）
  const plain = discovery.invalidAgentRefMessage('reviewer');
  assert.equal(
    plain,
    `Invalid agent ref: reviewer. Agent refs must be absolute paths to .md files`
      + ` (use <location> from <available_subagents>, or run node "${process.env.ZCODE_PLUGIN_ROOT || path.join(__dirname, '..', 'bin', 'zsw.js')}" agents to list paths).`,
    '非 .. 分支整句 = 旧复刻文案（core 工厂 + howToList 注入后逐字一致）',
  );
});

test('resolveDefault：缺省 = general-purpose（vendored 兜底 + project 级遮蔽胜）', async (t) => {
  const { home, ws } = setupFixture(t);
  // 无用户资产：vendored 内置胜出
  const gp = await discovery.resolveDefaultAgent(ws, { homeDir: home });
  assert.equal(gp.name, 'general-purpose');
  assert.ok(gp.filePath.includes(path.join('vendor', 'subagent-core', 'agents', 'general-purpose.md')));
  assert.ok(gp.body.includes('通用兜底'), '正文可解析（prompt-builder 消费面）');
  // project 级同名遮蔽（逃生门：缺省角色也可被用户覆写；自定义 description
  // 须写合法 frontmatter——IF1 拒重复 key，覆写不进清单会退 vendored 兜底）
  const projFile = mkAgentFm(path.join(ws, '.agents', 'agents'), 'general-purpose', [
    'name: general-purpose',
    'description: my-gp',
  ]);
  const gp2 = await discovery.resolveDefaultAgent(ws, { homeDir: home });
  assert.equal(gp2.filePath, projFile, 'project 级同名胜出');
  assert.equal(gp2.source, 'project-agents');
});

test('agentScanRoots：注入序 = 展开目标在前、本体在后（core last-writer-wins 本体胜）', (t) => {
  const { tmp, home, ws } = setupFixture(t);
  const zcodeRoot = path.join(home, '.zcode', 'agents');
  fs.mkdirSync(zcodeRoot, { recursive: true });
  const lib = path.join(tmp, 'lib3');
  fs.mkdirSync(lib, { recursive: true });
  fs.symlinkSync(lib, path.join(zcodeRoot, 'my-lib'));
  const roots = discovery.agentScanRoots({ cwd: ws, homeDir: home });
  const bySource = {};
  for (const r of roots.hostRoots) {
    (bySource[r.source] = bySource[r.source] || []).push(r.dir);
  }
  // user-pi（~/.zcode/agents 本体注入）：展开目标在前、本体在后
  assert.deepEqual(bySource['user-pi'], [path.join(zcodeRoot, 'my-lib'), zcodeRoot]);
  // user-agents / project-agents：只注入展开目标（本体由 core 硬编码槽后置）
  assert.equal(bySource['user-agents'], undefined);
  assert.equal(bySource['project-agents'], undefined);
  // npm 槽 = 插件 lib/vendor（一级子项 = 包目录）
  assert.deepEqual(bySource.npm, [path.dirname(require('../lib/core-ref').vendorDir())]);
  assert.equal(roots.workspaceRoot, ws);
});

// ------------------------------------------- 装配语义（V2p C7：discoverAgents）

test('去重键变更（V2p 声明）：异 stem 同 frontmatter name 互遮蔽，后位根胜', async (t) => {
  const { home, ws } = setupFixture(t);
  // 同一 frontmatter name 挂在两个不同 stem 文件上（旧 stem 键语义 = 两条
  // 独立条目；V2p 起 name 键 = 一条，discoverResources 槽序靠后者胜）
  const userFile = mkAgentFm(path.join(home, '.zcode', 'agents'), 'stem-a', [
    'name: dup-name', 'description: from user',
  ]);
  const projFile = mkAgentFm(path.join(ws, '.agents', 'agents'), 'stem-b', [
    'name: dup-name', 'description: from project',
  ]);

  const list = userEntries(await discovery.listAgents(ws, { homeDir: home }));
  const dup = list.filter((p) => p.name === 'dup-name');
  assert.equal(dup.length, 1, 'frontmatter name 去重：异 stem 同 name 只剩一条');
  assert.equal(dup[0].filePath, projFile, '后写胜：project-agents（core 槽序靠后）遮蔽 user-pi');
  assert.equal(dup[0].source, 'project-agents');
  assert.equal(dup[0].description, 'from project');
  // 同 stem 撞名（frontmatter name = stem，既有合法集）不回归：仍是本体胜
  const ownScout = mkAgent(path.join(ws, '.zcode', 'agents'), 'scout2');
  const list2 = userEntries(await discovery.listAgents(ws, { homeDir: home }));
  const scout = list2.filter((p) => p.name === 'scout2');
  assert.equal(scout.length, 1, 'name=stem 的既有合法集不受去重键变更影响');
  assert.equal(scout[0].filePath, ownScout);
});

test('装配输出按 name 码点序（discoverAgents sortByCodepoint，含 vendored 混排）', async (t) => {
  const { home, ws } = setupFixture(t);
  // 大写 < 小写 < 中文 的码点序（String 比较），与旧 profiles.sort 同序
  mkAgent(path.join(ws, '.agents', 'agents'), 'zeta');
  mkAgent(path.join(ws, '.agents', 'agents'), 'Alpha');
  mkAgent(path.join(ws, '.agents', 'agents'), '中文角色');
  mkAgent(path.join(ws, '.agents', 'agents'), 'beta');
  const list = await discovery.listAgents(ws, { homeDir: home });
  const names = list.map((p) => p.name);
  assert.deepEqual(names, [...names].sort(), '全清单按 name 码点序（vendored 与用户条目混排）');
  assert.deepEqual(names.filter((n) => ['Alpha', 'beta', 'zeta', '中文角色'].includes(n)),
    ['Alpha', 'beta', 'zeta', '中文角色'], '大写 < 小写 < 中文的码点序抽检');
});

test('IF1 装配闸：frontmatter 不通过的 .md 不进清单；执行面路径直达仍可解析', async (t) => {
  const { home, ws } = setupFixture(t);
  const root = path.join(ws, '.agents', 'agents');
  fs.mkdirSync(root, { recursive: true });
  // 无 frontmatter
  fs.writeFileSync(path.join(root, 'no-fm.md'), '# 只有正文\n');
  // 缺 description（IF1 要求 name+description 齐备）
  fs.writeFileSync(path.join(root, 'no-desc.md'), '---\nname: no-desc\n---\n\nb\n');
  // 合法对照
  mkAgent(root, 'valid');

  const users = userEntries(await discovery.listAgents(ws, { homeDir: home }));
  assert.equal(users.some((p) => p.name === 'no-fm'), false, '无 frontmatter 不进清单');
  assert.equal(users.some((p) => p.name === 'no-desc'), false, '缺 description 不进清单');
  assert.ok(users.some((p) => p.name === 'valid'), '合法条目不受影响');
  // 执行面（resolveAgent → parseFile 宽松解析）路径直达不受装配闸影响
  const noFm = await discovery.resolveAgent(path.join(root, 'no-fm.md'), ws, { homeDir: home });
  assert.equal(noFm.name, 'no-fm', '宽松解析 name 缺省 stem');
  const noDesc = await discovery.resolveAgent(path.join(root, 'no-desc.md'), ws, { homeDir: home });
  assert.equal(noDesc.name, 'no-desc');
  assert.equal(noDesc.description, '', 'IF1 未过的宽松 fallback 不保 description（core 语义）');
});

test('清单投影字段：source 按 path 前缀归属反查（含 core 硬编码槽根）', async (t) => {
  const { home, ws } = setupFixture(t);
  mkAgent(path.join(home, '.agents', 'agents'), 'in-user-agents');
  mkAgent(path.join(ws, '.zcode', 'agents'), 'in-project-host');
  mkAgent(path.join(ws, '.agents', 'agents'), 'in-project-agents');
  const list = userEntries(await discovery.listAgents(ws, { homeDir: home }));
  const byName = Object.fromEntries(list.map((p) => [p.name, p]));
  assert.equal(byName['in-user-agents'].source, 'user-agents', 'core 硬编码槽根的条目标签不丢');
  assert.equal(byName['in-project-host'].source, 'project-host');
  assert.equal(byName['in-project-agents'].source, 'project-agents');
});

// ------------------------------------- 解析语义（V2p C8：core parseAgentProfile）

/** 把 frontmatter 文本写成临时 agent .md，返回 parseFile 投影（不可读 null）。 */
function parseMd(md, dir, stem = 'probe') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stem}.md`);
  fs.writeFileSync(file, md);
  return parseFile(file);
}

test('parseFile（core 宽松解析）：正常全字段（行数组 + 行内数组 + maxTurns 数值化）', (t) => {
  const { tmp } = setupFixture(t);
  const p = parseMd([
    '---',
    'name: reviewer',
    'description: "代码审查员"',
    'model: glm-5.3',
    'tools:',
    '  - read',
    '  - bash',
    'disallowedTools: [web-search, mcp]',
    'skills:',
    '  - /path/to/skill/SKILL.md',
    'maxTurns: 25',
    '---',
    '',
    '正文内容',
  ].join('\n'), path.join(tmp, 'parse-a'));
  assert.equal(p.name, 'reviewer');
  assert.equal(p.description, '代码审查员');
  assert.equal(p.model, 'glm-5.3');
  assert.deepEqual(p.tools, ['read', 'bash']);
  assert.deepEqual(p.disallowedTools, ['web-search', 'mcp']);
  assert.deepEqual(p.skills, ['/path/to/skill/SKILL.md']);
  assert.equal(p.maxTurns, 25);
  assert.equal(p.body, '正文内容', 'core 口径 body trim（旧 mini parser 保留首空白）');
  assert.equal(p.filePath, path.join(tmp, 'parse-a', 'probe.md'), 'zsw 消费契约投影字段');
});

test('parseFile：block-scalar 多行 description 与多行 tools 完整解析（fixture t-sink.md）', () => {
  const p = parseFile(path.join(__dirname, 'fixtures', 't-sink.md'));
  assert.equal(p.name, 't-sink');
  assert.ok(p.description.startsWith('V0d fixture：'),
    `block-scalar 首行完整（旧 mini parser 产出脏值 '|'）: ${p.description.slice(0, 30)}`);
  assert.ok(p.description.split('\n').length >= 5, '多行 description 全量保留');
  assert.deepEqual(p.tools, ['read', 'bash'], '多行 - item 列表');
  assert.equal(p.maxTurns, 2);
});

test('parseFile：frontmatter 合法（name 在场）时 engine/flow 序列透传', (t) => {
  const { tmp } = setupFixture(t);
  const p = parseMd('---\nname: n\ndescription: d\nengine: zcode\ntools: [read]\nskills:\n  - /s/SKILL.md\n---\n\nb', path.join(tmp, 'parse-b'), 'impl-helper');
  assert.equal(p.name, 'n');
  assert.equal(p.engine, 'zcode');
  assert.deepEqual(p.tools, ['read'], 'flow 序列经 core YAML 完整解析');
  assert.deepEqual(p.skills, ['/s/SKILL.md']);
});

test('parseFile：缺 name 走 legacy fallback（stem 缺省；IF1 未过 description 不保）', (t) => {
  const { tmp } = setupFixture(t);
  const p = parseMd('---\ndescription: d\nmaxTurns: 4\n---\n\nb', path.join(tmp, 'parse-b2'), 'impl-helper');
  assert.equal(p.name, 'impl-helper', 'name 缺省 stem（宽松不抛）');
  assert.equal(p.maxTurns, 4, '执行字段经 fallback 保留');
  assert.equal(p.description, '', 'fallback 不保 description（core IF1 语义，登记差异）');
});

test('parseFile：IF1 未过走 legacy fallback——maxTurns 带引号字符串时 description 丢失', (t) => {
  const { tmp } = setupFixture(t);
  // maxTurns: "8"（带引号字符串）不过 IF1 类型校验 → meta=null → fallback 只保
  // 执行字段：maxTurns/engine 数值化透传，description 不保（core 语义，
  // 登记差异：旧 mini parser 口径下 description 保留）
  const p = parseMd('---\ndescription: d\nmaxTurns: "8"\nengine: zcode\n---\n\nb', path.join(tmp, 'parse-c'), 'impl-helper');
  assert.equal(p.name, 'impl-helper', 'fallback name 缺省 stem');
  assert.equal(p.maxTurns, 8, '字符串数值化经 fallback 保留');
  assert.equal(p.engine, 'zcode');
  assert.equal(p.description, '', 'fallback 不保 description（core IF1 语义）');
});

test('parseFile：无 frontmatter / 围栏未闭合 / maxTurns 非法值（宽松不抛）', (t) => {
  const { tmp } = setupFixture(t);
  const dir = path.join(tmp, 'parse-d');
  const noFm = parseMd('# hi\n\nbody', dir, 'a');
  assert.equal(noFm.name, 'a');
  assert.equal(noFm.description, '');
  assert.equal(noFm.body, '# hi\n\nbody');

  // 未闭合：core legacy fallback 从块内单行 key:value 提取 name（行为变更：
  // 旧 mini parser 整体放弃取 stem——core 口径更完整，按其更新断言）
  const unclosed = parseMd('---\nname: x\n没有闭合行', dir, 'b');
  assert.equal(unclosed.name, 'x', 'fallback 从未闭合块提取 name');
  assert.ok(unclosed.body.includes('name: x'), '全文作 body');

  const badTurns = parseMd('---\nname: c\nmaxTurns: abc\n---\nb', dir, 'c');
  assert.equal(badTurns.maxTurns, undefined, '非法 maxTurns 丢弃（fallback 数值化失败）');
});

test('parseFile：when 字段可选透出（列表形态不过 IF1，core 与旧口径同为 undefined）', (t) => {
  const { tmp } = setupFixture(t);
  const dir = path.join(tmp, 'parse-e');
  const withWhen = parseMd(
    '---\nname: reviewer\ndescription: d\nwhen: 代码审查、修复方案验证\n---\n\nb',
    dir, 'reviewer',
  );
  assert.equal(withWhen.when, '代码审查、修复方案验证');
  const noWhen = parseMd('---\nname: a\ndescription: d\n---\n\nb', dir, 'a');
  assert.equal(noWhen.when, undefined);
  const arrWhen = parseMd('---\nname: b\nwhen:\n  - x\n---\nb', dir, 'b');
  assert.equal(arrWhen.when, undefined, 'when 列表（非标量）不透出');
});

test('parseFile：不可读/目录返回 null；缓存 mtime 失效后重解析（getCachedParsed）', (t) => {
  const { tmp } = setupFixture(t);
  const dir = path.join(tmp, 'parse-f');
  const file = path.join(dir, 'cache-probe.md');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(parseFile(path.join(dir, 'missing.md')), null, '文件不存在 null');
  assert.equal(parseFile(dir), null, '目录 null（core 缓存读失败统一 null）');
  fs.writeFileSync(file, '---\nname: v1\ndescription: first\n---\n\nb1\n');
  assert.equal(parseFile(file).description, 'first');
  fs.writeFileSync(file, '---\nname: v1\ndescription: second\n---\n\nb2\n');
  assert.equal(parseFile(file).description, 'second', 'mtime 变化后缓存失效重解析');
});

// ------------------------------------------------------------- 工厂注入形态

test('createAgentDiscovery：端口形态 { homeDir, list, resolve, resolveDefault }（async 契约）', async (t) => {
  const { home, ws } = setupFixture(t);
  const instance = discovery.createAgentDiscovery({ homeDir: home });
  assert.equal(typeof instance.list, 'function');
  assert.equal(typeof instance.resolve, 'function');
  assert.equal(typeof instance.resolveDefault, 'function');
  assert.equal(instance.homeDir, home);
  const rows = await instance.list(ws);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.some((p) => p.name === 'reviewer'), 'vendored reviewer 在场');
  // 路径形态 resolve（D-4a 唯一合法引用；从清单拿 location 再解析）
  const reviewer = rows.find((p) => p.name === 'reviewer');
  const hit = await instance.resolve(reviewer.filePath, ws);
  assert.ok(hit.filePath.includes('vendor'));
  const gp = await instance.resolveDefault(ws);
  assert.equal(gp.name, 'general-purpose');
});
