'use strict';
/**
 * lib/agent-discovery 单测（W6a：agent 发现切 vendored core discoverResources，
 * 旧自写四根递归 resolver 退役）。
 *
 * 覆盖面（对应设计 D-2 与验收 A7/序位探针）：
 * - 根映射序位：user 级 < vendored 内置 < project 级（user 级同名被内置遮蔽、
 *   project 级同名遮蔽内置——逃生门成立）
 * - 四根级联：ws/.agents > ws/.zcode > ~/.agents > ~/.zcode（非内置名逐级下移）
 * - 目录 symlink 整库展开：库内 .md 与同根本体散 .md 同时可发现（不互相顶掉）；
 *   同 stem 撞名 → 本体胜（注入序语义：本体根注入在展开目标之后）
 * - symlink 环正常终止（防环集合含四根本身 realpath）；跨根链接不重复注入
 * - 文件级 symlink 可发现（core async 扫描 follow）；broken link 跳过
 * - resolve 名字/路径/缺省各形态
 * - parseAgentMd 解析语义（自旧 resolver 原样迁移的回归锁定）
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
const { parseAgentMd } = discovery;

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

/** 用户根条目视图（剔除 vendored 内置，精确断言四根行为）。 */
const userEntries = (list) => list.filter((p) => p.source !== 'npm');

// ------------------------------------------------------------- 序位（验收探针）

test('序位：user 级同名被 vendored 内置遮蔽（user < 内置）', async (t) => {
  const { home, ws } = setupFixture(t);
  mkAgent(path.join(home, '.zcode', 'agents'), 'reviewer', 'description: user-old\n');
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
    mkAgent(r, 'cascade-probe', `description: from root ${i}\n`);
  });
  // 逐级删除高优先级文件，验证胜出顺序逐级下移
  for (let i = 0; i < roots.length; i++) {
    const p = await discovery.resolveAgent('cascade-probe', ws, { homeDir: home });
    assert.ok(p, `第 ${i} 级应有 cascade-probe`);
    assert.equal(p.description, `from root ${i}`);
    assert.equal(p.filePath, path.join(roots[i], 'cascade-probe.md'));
    fs.rmSync(path.join(roots[i], 'cascade-probe.md'));
  }
  const miss = await discovery.resolveAgent('cascade-probe', ws, { homeDir: home });
  assert.equal(miss, null, '四根删空返回 null（非内置名无 vendored 回落）');
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

  // 按名字解析：库内独有条目可命中
  const hit = await discovery.resolveAgent('lib-helper', ws, { homeDir: home });
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
  assert.equal(linked.body.trim(), 'body-coder-ext');
  assert.ok(users.some((p) => p.name === 'local'));
  assert.ok(!users.some((p) => p.name === 'nested'), '子目录 .md 单层不可见（迁移：平铺或目录 symlink）');
  assert.equal(users.filter((p) => p.name === 'coder-ext').length, 1,
    '链接与真实文件不同根（根外文件本体不在任何根内），清单只此一条');
});

test('resolve：绝对/相对路径、名字带 .md、stem 兜底、vendored 内置名、未命中 null', async (t) => {
  const { home, ws } = setupFixture(t);
  const file = mkAgent(path.join(ws, '.agents', 'agents'), 'custom-agent');
  assert.equal((await discovery.resolveAgent(file, ws, { homeDir: home })).filePath, file);
  assert.equal((await discovery.resolveAgent('./.agents/agents/custom-agent.md', ws, { homeDir: home })).name, 'custom-agent');
  assert.equal((await discovery.resolveAgent('custom-agent.md', ws, { homeDir: home })).name, 'custom-agent');
  // vendored 内置名回落（旧 resolver 无此行为——内置资产接入后的设计语义）
  const gp = await discovery.resolveAgent('general-purpose', ws, { homeDir: home });
  assert.ok(gp.filePath.includes(path.join('vendor', 'subagent-core', 'agents', 'general-purpose.md')));
  assert.equal(await discovery.resolveAgent('not-exist', ws, { homeDir: home }), null);
  assert.equal(await discovery.resolveAgent(path.join(ws, 'nope.md'), ws, { homeDir: home }), null);
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

// ------------------------------------------------- parseAgentMd（旧 resolver 迁移）

test('frontmatter: 正常全字段（行数组 + 行内数组 + maxTurns 数值化）', () => {
  const md = [
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
  ].join('\n');
  const p = parseAgentMd(md, '/x/reviewer.md');
  assert.equal(p.name, 'reviewer');
  assert.equal(p.description, '代码审查员');
  assert.equal(p.model, 'glm-5.3');
  assert.deepEqual(p.tools, ['read', 'bash']);
  assert.deepEqual(p.disallowedTools, ['web-search', 'mcp']);
  assert.deepEqual(p.skills, ['/path/to/skill/SKILL.md']);
  assert.equal(p.maxTurns, 25);
  assert.equal(p.body, '\n正文内容');
  assert.equal(p.filePath, '/x/reviewer.md');
});

test('frontmatter: 缺 name 取文件名；maxTurns 字符串数值化；engine 透传', () => {
  const p = parseAgentMd('---\ndescription: d\nmaxTurns: "8"\nengine: zcode\n---\n\nb', '/x/impl-helper.md');
  assert.equal(p.name, 'impl-helper');
  assert.equal(p.maxTurns, 8);
  assert.equal(p.engine, 'zcode');
  assert.equal(p.tools, undefined);
});

test('frontmatter: 无 frontmatter / 围栏未闭合 / maxTurns 非法值', () => {
  const noFm = parseAgentMd('# hi\n\nbody', '/x/a.md');
  assert.equal(noFm.name, 'a');
  assert.equal(noFm.description, '');
  assert.equal(noFm.body, '# hi\n\nbody');

  const unclosed = parseAgentMd('---\nname: x\n没有闭合行', '/x/b.md');
  assert.equal(unclosed.name, 'b');
  assert.ok(unclosed.body.includes('name: x'));

  const badTurns = parseAgentMd('---\nname: c\nmaxTurns: abc\n---\nb', '/x/c.md');
  assert.equal(badTurns.maxTurns, undefined, '非法 maxTurns 丢弃');
});

test('frontmatter: when 字段可选透出', () => {
  const withWhen = parseAgentMd(
    '---\nname: reviewer\ndescription: d\nwhen: 代码审查、修复方案验证\n---\n\nb',
    '/x/reviewer.md',
  );
  assert.equal(withWhen.when, '代码审查、修复方案验证');
  const noWhen = parseAgentMd('---\nname: a\ndescription: d\n---\n\nb', '/x/a.md');
  assert.equal(noWhen.when, undefined);
  const arrWhen = parseAgentMd('---\nname: b\nwhen:\n  - x\n---\nb', '/x/b.md');
  assert.equal(arrWhen.when, undefined);
});

// ------------------------------------------------------------- 工厂注入形态

test('createAgentDiscovery：端口形态 { homeDir, list, resolve }（async 契约）', async (t) => {
  const { home, ws } = setupFixture(t);
  const instance = discovery.createAgentDiscovery({ homeDir: home });
  assert.equal(typeof instance.list, 'function');
  assert.equal(typeof instance.resolve, 'function');
  assert.equal(instance.homeDir, home);
  const rows = await instance.list(ws);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.some((p) => p.name === 'reviewer'), 'vendored reviewer 在场');
  const hit = await instance.resolve('reviewer', ws);
  assert.ok(hit.filePath.includes('vendor'));
});
