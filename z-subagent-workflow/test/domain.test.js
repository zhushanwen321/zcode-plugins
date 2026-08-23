'use strict';
/**
 * 域层单测：agent-md-resolver / prompt-builder / record-store / output-store。
 *
 * 隔离原则：所有落盘走临时目录（mkdtemp），record/output 经 ZSW_ROOT 指向
 * 临时目录，resolver 经 homeDir 注入临时 HOME——绝不触碰真实 ~/.zcode。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentMdResolver, parseAgentMd } = require('../lib/agent-md-resolver');
const { buildPrompt } = require('../lib/prompt-builder');
const { RecordStore } = require('../lib/record-store');
const outputStore = require('../lib/output-store');

/** 每个测试独立 ZSW_ROOT 临时目录，结束后恢复 env 并清理。 */
function setupRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-domain-'));
  const prev = process.env.ZSW_ROOT;
  process.env.ZSW_ROOT = root;
  t.after(() => {
    if (prev === undefined) delete process.env.ZSW_ROOT;
    else process.env.ZSW_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** 在 rootDir 下写一个 agent .md（自动建父目录）。 */
function mkAgent(rootDir, rel, content) {
  const file = path.join(rootDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// ---------------------------------------------------------------------------
// agent-md-resolver
// ---------------------------------------------------------------------------

test('resolver: 四根优先级 ws/.agents > ws/.zcode > ~/.agents > ~/.zcode', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-res-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  const home = path.join(tmp, 'home');
  const roots = [
    path.join(ws, '.agents', 'agents'),
    path.join(ws, '.zcode', 'agents'),
    path.join(home, '.agents', 'agents'),
    path.join(home, '.zcode', 'agents'),
  ];
  roots.forEach((r, i) => {
    mkAgent(r, 'reviewer.md',
      `---\nname: reviewer\ndescription: from root ${i}\n---\n\nbody-root-${i}\n`);
  });
  const resolver = new AgentMdResolver({ homeDir: home });

  // 逐级删除高优先级文件，验证胜出顺序逐级下移
  for (let i = 0; i < roots.length; i++) {
    const p = resolver.resolve('reviewer', ws);
    assert.ok(p, `第 ${i} 级应有 reviewer`);
    assert.equal(p.description, `from root ${i}`);
    assert.equal(p.filePath, path.join(roots[i], 'reviewer.md'));
    assert.equal(p.body.trim(), `body-root-${i}`);
    fs.rmSync(path.join(roots[i], 'reviewer.md'));
  }
  assert.equal(resolver.resolve('reviewer', ws), null, '四根删空应返回 null');
});

test('resolver: 文件级 symlink 指向根外文件可被发现（引擎扫描会跳过，本模块不能）', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-res-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'ws', '.agents', 'agents');
  mkAgent(root, 'local.md', '---\nname: local\ndescription: d\n---\n\nlocal body\n');
  const outside = mkAgent(path.join(tmp, 'lib'), 'impl/coder.md',
    '---\nname: coder\ndescription: via symlink\n---\n\nsymlinked body\n');
  fs.symlinkSync(outside, path.join(root, 'coder.md'));

  const resolver = new AgentMdResolver({ homeDir: path.join(tmp, 'home') });
  const names = resolver.list(path.join(tmp, 'ws')).map((p) => p.name);
  assert.deepEqual(names.sort(), ['coder', 'local']);
  const coder = resolver.resolve('coder', path.join(tmp, 'ws'));
  assert.equal(coder.description, 'via symlink');
  assert.equal(coder.body.trim(), 'symlinked body');
});

test('resolver: 目录级 symlink 递归展开且 realpath 去重不重复收集', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-res-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const wsRoot = path.join(tmp, 'ws', '.agents', 'agents');
  mkAgent(wsRoot, 'own.md', '---\nname: own\ndescription: d\n---\n\nb\n');
  const libImpl = path.join(tmp, 'lib', 'impl');
  mkAgent(libImpl, 'deep.md', '---\nname: deep\ndescription: nested\n---\n\nb\n');
  // 目录链接 + 同一文件的第二个链接（去重验证：deep 只出现一次）
  fs.symlinkSync(libImpl, path.join(wsRoot, 'sub'));
  fs.symlinkSync(path.join(libImpl, 'deep.md'), path.join(wsRoot, 'deep-alias.md'));

  const resolver = new AgentMdResolver({ homeDir: path.join(tmp, 'home') });
  const profiles = resolver.list(path.join(tmp, 'ws'));
  const deepOnes = profiles.filter((p) => p.name === 'deep');
  assert.equal(deepOnes.length, 1, '同一真实文件经多链接只收集一次');
  assert.equal(profiles.filter((p) => p.name === 'own').length, 1);
  // 目录链接内的文件可按名字解析
  assert.equal(resolver.resolve('deep', path.join(tmp, 'ws')).description, 'nested');
});

test('resolver: symlink 环与 broken link 不挂起不报错', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-res-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'ws', '.agents', 'agents');
  mkAgent(root, 'ok.md', '---\nname: ok\ndescription: d\n---\n\nb\n');
  fs.symlinkSync(root, path.join(root, 'loop')); // 指向自身的目录环
  fs.symlinkSync(path.join(tmp, 'no-such.md'), path.join(root, 'broken.md'));

  const resolver = new AgentMdResolver({ homeDir: path.join(tmp, 'home') });
  const names = resolver.list(path.join(tmp, 'ws')).map((p) => p.name);
  assert.deepEqual(names, ['ok'], '环被剪枝、broken 被跳过、正常文件保留');
});

test('resolver: 递归子目录收集 + 无 frontmatter 文件按文件名命名', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-res-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'ws', '.agents', 'agents');
  mkAgent(root, 'team/impl-helper.md', '# 只有正文\n\n没有 frontmatter\n');
  const resolver = new AgentMdResolver({ homeDir: path.join(tmp, 'home') });
  const p = resolver.resolve('impl-helper', path.join(tmp, 'ws'));
  assert.equal(p.name, 'impl-helper');
  assert.equal(p.description, '');
  assert.ok(p.body.startsWith('# 只有正文'));
});

test('resolver: resolve 支持绝对路径 / 相对路径 / 名字带 .md 后缀 / 未命中返回 null', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-res-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  const root = path.join(ws, '.agents', 'agents');
  const file = mkAgent(root, 'reviewer.md', '---\nname: reviewer\ndescription: d\n---\n\nb\n');
  const resolver = new AgentMdResolver({ homeDir: path.join(tmp, 'home') });

  assert.equal(resolver.resolve(file, ws).filePath, file); // 绝对路径
  assert.equal(resolver.resolve('./.agents/agents/reviewer.md', ws).name, 'reviewer'); // 相对路径
  assert.equal(resolver.resolve('reviewer.md', ws).name, 'reviewer'); // 名字带 .md
  assert.equal(resolver.resolve('not-exist', ws), null); // 未命中
  assert.equal(resolver.resolve(path.join(ws, 'nope.md'), ws), null); // 路径不存在
});

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
  assert.equal(p.description, '代码审查员'); // 引号被去除
  assert.equal(p.model, 'glm-5.3');
  assert.deepEqual(p.tools, ['read', 'bash']); // 行数组
  assert.deepEqual(p.disallowedTools, ['web-search', 'mcp']); // 行内数组
  assert.deepEqual(p.skills, ['/path/to/skill/SKILL.md']);
  assert.equal(p.maxTurns, 25); // 数值化
  assert.equal(p.body, '\n正文内容');
  assert.equal(p.filePath, '/x/reviewer.md');
});

test('frontmatter: 缺 name 取文件名（去 .md）；maxTurns 字符串数值化', () => {
  const p = parseAgentMd('---\ndescription: d\nmaxTurns: "8"\n---\n\nb', '/x/impl-helper.md');
  assert.equal(p.name, 'impl-helper');
  assert.equal(p.maxTurns, 8);
  assert.equal(p.tools, undefined);
  assert.equal(p.disallowedTools, undefined);
  assert.equal(p.skills, undefined);
});

test('frontmatter: 无 frontmatter / 围栏未闭合 / maxTurns 非法值', () => {
  const noFm = parseAgentMd('# hi\n\nbody', '/x/a.md');
  assert.equal(noFm.name, 'a');
  assert.equal(noFm.description, '');
  assert.equal(noFm.body, '# hi\n\nbody');

  // 未闭合围栏：整体当 body（宽容，不抛错）
  const unclosed = parseAgentMd('---\nname: x\n没有闭合行', '/x/b.md');
  assert.equal(unclosed.name, 'b');
  assert.ok(unclosed.body.includes('name: x'));

  const badTurns = parseAgentMd('---\nname: c\nmaxTurns: abc\n---\nb', '/x/c.md');
  assert.equal(badTurns.maxTurns, undefined, '非法 maxTurns 丢弃');
});

// ---------------------------------------------------------------------------
// prompt-builder
// ---------------------------------------------------------------------------

test('prompt-builder: 四段固定顺序拼装', () => {
  const out = buildPrompt({
    agentProfile: { name: 'reviewer', body: '你是代码审查员。' },
    task: '审查 src/a.js',
    schema: '输出 {"verdict":"pass|fail","reasons":[]}',
    skillRefs: ['/s/a/SKILL.md', '/s/b/SKILL.md'],
  });
  const order = ['角色设定', '审查 src/a.js', 'MANDATORY 输出契约', '参考技能']
    .map((s) => out.indexOf(s));
  assert.ok(order.every((i) => i >= 0), `四段齐全: ${out}`);
  assert.ok(order[0] < order[1] && order[1] < order[2] && order[2] < order[3], '顺序固定');
  assert.ok(out.includes('agent: reviewer'));
  assert.ok(out.includes('你是代码审查员。'));
  assert.ok(out.includes('只包含一个 JSON 对象'));
  assert.ok(out.includes('- /s/a/SKILL.md') && out.includes('- /s/b/SKILL.md'));
});

test('prompt-builder: 无 profile 省略角色段；schema 对象 JSON 序列化；空输入为空串', () => {
  const noProfile = buildPrompt({ task: '做点事' });
  assert.ok(!noProfile.includes('角色设定'));
  assert.ok(noProfile.includes('做点事'));

  const objSchema = buildPrompt({ task: 't', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } });
  assert.ok(objSchema.includes('"type": "object"'));
  assert.ok(!objSchema.includes('参考技能'), '无 skillRefs 省略技能段');

  assert.equal(buildPrompt({}), '');
  assert.equal(buildPrompt(), '');
});

test('prompt-builder: 工具约束段——tools 白名单声明「只允许」+ disallowedTools 重申（MUST_FIX-3）', () => {
  const out = buildPrompt({
    agentProfile: {
      name: 'coder',
      body: '你是编码助手',
      tools: ['read', 'bash'],
      disallowedTools: ['web-search'],
    },
    task: '写代码',
  });
  assert.ok(out.includes('## 工具约束'), '有 tools/disallowedTools 时拼段');
  assert.ok(out.includes('只允许使用以下工具'), '白名单软约束声明');
  assert.ok(out.includes('- read') && out.includes('- bash'));
  assert.ok(out.includes('以下工具已被明确禁用'), 'denylist 在段中重申（双保险）');
  assert.ok(out.includes('- web-search'));
  // 段顺序：角色设定 → 工具约束 → 任务（约束贴着角色，先于任务）
  const order = ['角色设定', '工具约束', '写代码'].map((s) => out.indexOf(s));
  assert.ok(order[0] < order[1] && order[1] < order[2], '角色 < 工具约束 < 任务');
});

test('prompt-builder: 工具约束段两态——只有 denylist / 完全无工具字段不拼段', () => {
  const onlyDeny = buildPrompt({
    agentProfile: { name: 'a', body: 'b', disallowedTools: ['mcp'] },
    task: 't',
  });
  assert.ok(onlyDeny.includes('## 工具约束'));
  assert.ok(!onlyDeny.includes('只允许使用以下工具'), '无 tools 不拼白名单部分');
  assert.ok(onlyDeny.includes('- mcp'));

  const none = buildPrompt({ agentProfile: { name: 'a', body: 'b' }, task: 't' });
  assert.ok(!none.includes('工具约束'), '无任一工具字段不拼段');
  const emptyArr = buildPrompt({ agentProfile: { name: 'a', body: 'b', tools: [], disallowedTools: [] }, task: 't' });
  assert.ok(!emptyArr.includes('工具约束'), '空数组视同未声明');
});

// ---------------------------------------------------------------------------
// record-store
// ---------------------------------------------------------------------------

test('record-store: 合法转移链 created→running→idle→running→closed + endedAt/closedReason', (t) => {
  setupRoot(t);
  const store = new RecordStore();
  const r = store.create({ subagentId: 'sa-1', slug: 'rev', agent: 'reviewer', model: 'glm-5.3' });
  assert.equal(r.status, 'created');
  assert.ok(Number.isFinite(r.startedAt));

  store.transition('sa-1', 'created', 'running', { exec: { kind: 'spawn', pid: 123 } });
  store.transition('sa-1', 'running', 'idle', { sessionId: 'sess-9' });
  store.transition('sa-1', 'idle', 'running');
  store.transition('sa-1', 'running', 'closed', { closedReason: 'done' });

  const fin = store.get('sa-1');
  assert.equal(fin.status, 'closed');
  assert.equal(fin.closedReason, 'done');
  assert.equal(fin.sessionId, 'sess-9');
  assert.deepEqual(fin.exec, { kind: 'spawn', pid: 123 });
  assert.ok(Number.isFinite(fin.endedAt), '终态自动补 endedAt');

  // 事件落盘：5 条（1 created + 4 transition）
  const lines = fs.readFileSync(require('../lib/config').recordsPath(), 'utf8').trim().split('\n');
  assert.equal(lines.length, 5);
  for (const line of lines) {
    const e = JSON.parse(line);
    assert.ok(e.ts && e.type, '事件形态 {ts, type, ...}');
  }
});

test('record-store: 非法转移抛错（图外边 / 终态出边 / CAS from 不匹配）', (t) => {
  setupRoot(t);
  const store = new RecordStore();
  store.create({ subagentId: 'sa-1' });

  assert.throws(() => store.transition('sa-1', 'created', 'idle'), /非法转移/); // 图外边
  assert.throws(() => store.transition('sa-1', 'created', 'created'), /非法转移/);

  store.transition('sa-1', 'created', 'running');
  // CAS：running→idle 是图内合法边，但当前状态已是 running 之后（伪造 from 不匹配）
  assert.throws(() => store.transition('sa-1', 'created', 'running'), /CAS/); // from 不匹配
  assert.throws(() => store.transition('sa-999', 'running', 'closed'), /不存在/);

  store.transition('sa-1', 'running', 'closed');
  assert.throws(() => store.transition('sa-1', 'closed', 'running'), /非法转移/); // 终态无出边
  // 失败的转移不落盘
  const lines = fs.readFileSync(require('../lib/config').recordsPath(), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3, 'created + running + closed 共 3 条');
});

test('record-store: update 补字段；update/patch 不得携带 status；重复 create 抛错', (t) => {
  setupRoot(t);
  const store = new RecordStore();
  store.create({ subagentId: 'sa-1', slug: 'rev' });
  store.update('sa-1', { patchFile: '/o/sa-1.patch', tokens: { input: 10, output: 5 } });
  const r = store.get('sa-1');
  assert.equal(r.patchFile, '/o/sa-1.patch');
  assert.deepEqual(r.tokens, { input: 10, output: 5 });
  assert.equal(r.status, 'created');

  assert.throws(() => store.update('sa-1', { status: 'running' }), /status/);
  assert.throws(() => store.create({ subagentId: 'sa-1' }), /已存在/);
  assert.throws(() => store.create({}), /subagentId/);
});

test('record-store: list 按 startedAt 倒序 + status/slug 过滤；get 返回副本', (t) => {
  setupRoot(t);
  const store = new RecordStore();
  store.create({ subagentId: 'sa-1', slug: 'a', startedAt: 1000 });
  store.create({ subagentId: 'sa-2', slug: 'a', startedAt: 3000 });
  store.create({ subagentId: 'sa-3', slug: 'b', startedAt: 2000 });
  store.transition('sa-1', 'created', 'running');

  assert.deepEqual(store.list().map((r) => r.subagentId), ['sa-2', 'sa-3', 'sa-1']);
  assert.deepEqual(store.list({ slug: 'a' }).map((r) => r.subagentId), ['sa-2', 'sa-1']);
  assert.deepEqual(store.list({ status: 'running' }).map((r) => r.subagentId), ['sa-1']);
  assert.deepEqual(store.list({ status: 'created', slug: 'a' }).map((r) => r.subagentId), ['sa-2']);

  const got = store.get('sa-1');
  got.status = 'hacked';
  assert.equal(store.get('sa-1').status, 'running', '外部修改不得污染内存索引');
});

test('record-store: rebuildFromLog 终态照抄、非终态标 lost', (t) => {
  setupRoot(t);
  const store = new RecordStore();
  store.create({ subagentId: 'sa-done', slug: 'd' });
  store.transition('sa-done', 'created', 'running');
  store.transition('sa-done', 'running', 'closed', { closedReason: 'done' });
  store.create({ subagentId: 'sa-live', slug: 'l' });
  store.transition('sa-live', 'created', 'running');
  store.create({ subagentId: 'sa-idle', slug: 'i' });
  store.transition('sa-idle', 'created', 'running');
  store.transition('sa-idle', 'running', 'idle');

  // 模拟重启：全新实例从日志重建
  const store2 = new RecordStore();
  const stat = store2.rebuildFromLog();
  assert.equal(stat.records, 3);
  assert.equal(stat.applied, 8); // sa-done 3 条 + sa-live 2 条 + sa-idle 3 条
  assert.equal(stat.skipped, 0);

  const done = store2.get('sa-done');
  assert.equal(done.status, 'closed', '终态照抄');
  assert.equal(done.closedReason, 'done');
  assert.ok(Number.isFinite(done.endedAt), 'endedAt 保留');
  assert.equal(store2.get('sa-live').status, 'lost', 'running 非终态标 lost');
  assert.equal(store2.get('sa-idle').status, 'lost', 'idle 非终态标 lost');

  // 探活纠正：lost → running 写盘合法（lost 不设为硬终态的理由）
  store2.transition('sa-live', 'lost', 'running');
  assert.equal(store2.get('sa-live').status, 'running');
});

test('record-store: rebuild 脏数据防御（截断行 / 脏 transition 跳过不炸）', (t) => {
  setupRoot(t);
  const store = new RecordStore();
  store.create({ subagentId: 'sa-1' });
  store.transition('sa-1', 'created', 'running');
  // 手工注入脏数据：半截 JSON 行 + CAS 不匹配的 transition
  fs.appendFileSync(require('../lib/config').recordsPath(),
    '{"ts":1,"type":"transi\n'
    + '{"ts":2,"type":"transition","id":"sa-1","from":"created","to":"closed"}\n'
    + '{"ts":3,"type":"update","id":"sa-ghost","x":1}\n');

  const store2 = new RecordStore();
  const stat = store2.rebuildFromLog();
  assert.equal(stat.skipped, 3);
  assert.equal(stat.records, 1);
  assert.equal(store2.get('sa-1').status, 'lost'); // running 非终态 → lost，脏数据未影响
});

test('record-store: 无日志文件时 rebuild 返回空库', (t) => {
  setupRoot(t);
  const store = new RecordStore();
  const stat = store.rebuildFromLog();
  assert.deepEqual(stat, { applied: 0, skipped: 0, records: 0 });
  assert.equal(store.list().length, 0);
});

// ---------------------------------------------------------------------------
// output-store
// ---------------------------------------------------------------------------

test('output-store: writeResult/writePatch 落盘正确、目录自动创建、pathFor 一致', (t) => {
  const root = setupRoot(t);
  const file = outputStore.writeResult('sa-1', '# 结果全文\n\n内容');
  assert.equal(file, outputStore.pathFor('sa-1'));
  assert.equal(file, path.join(root, 'outputs', 'sa-1.md'));
  assert.equal(fs.readFileSync(file, 'utf8'), '# 结果全文\n\n内容');

  const patch = outputStore.writePatch('sa-1', 'diff --git a/x b/x\n');
  assert.equal(patch, path.join(root, 'outputs', 'sa-1.patch'));
  assert.equal(fs.readFileSync(patch, 'utf8'), 'diff --git a/x b/x\n');
});

test('output-store: tmp+rename 原子写不留残渣', (t) => {
  const root = setupRoot(t);
  for (let i = 0; i < 3; i++) {
    outputStore.writeResult(`sa-${i}`, `body-${i}`);
    outputStore.writePatch(`sa-${i}`, `diff-${i}`);
  }
  const entries = fs.readdirSync(path.join(root, 'outputs'));
  assert.equal(entries.length, 6, '只有最终文件');
  assert.ok(entries.every((f) => !f.includes('.tmp')), '无 tmp 残留');
});
