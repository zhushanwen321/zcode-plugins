'use strict';
/**
 * 域层单测：prompt-builder / record-store / output-store。
 * （agent 发现与 frontmatter 解析的测试自本文件迁出——W6a 切 core 发现面后
 * 落 test/agent-discovery.test.js；旧自写 resolver 已退役。）
 *
 * 隔离原则：所有落盘走临时目录（mkdtemp），record/output 经 ZSW_ROOT 指向
 * 临时目录——绝不触碰真实 ~/.zcode。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

// ---------------------------------------------------------------------------
// agent 发现 + frontmatter 解析：见 test/agent-discovery.test.js（W6a 迁移）
// ---------------------------------------------------------------------------

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

test('prompt-builder: 运行环境段恒在场（F6+F7-zsw）——单轮无派发工具/有 WebSearch/任务书自包含', () => {
  // 有角色、无角色两形态都在场（全部 agent 一致注入，不特判角色）；
  // 环境事实让 core 角色正文的条件句（「若宿主提供派发工具…」「若环境提供内置
  // WebSearch…」）稳定落定分支
  for (const out of [
    buildPrompt({ agentProfile: { name: 'coder', body: '你是编码助手' }, task: 't' }),
    buildPrompt({ task: 't' }),
  ]) {
    assert.ok(out.includes('## 运行环境'), '环境段在场');
    assert.ok(out.includes('没有子代理派发工具') && out.includes('直接产出计划/结果文本'), '单轮无派发工具事实（编排任务直接产出文本）');
    assert.ok(out.includes('内置 WebSearch 类工具'), 'WebSearch 事实（条件检索分支成立）');
    assert.ok(out.includes('任务书自包含') && out.includes('以任务书与注入段为准'), '任务书自包含事实');
  }
  // 段序：角色设定 → 运行环境 → 工具约束 → 任务（环境事实先于约束与任务；
  // 用 '## 任务' 段头定位——环境段正文含「任务」字样，裸词会误配）
  const ordered = buildPrompt({
    agentProfile: { name: 'a', body: 'b', tools: ['read'] },
    task: 't',
  });
  const idx = ['角色设定', '运行环境', '工具约束', '## 任务'].map((s) => ordered.indexOf(s));
  assert.ok(idx[0] < idx[1] && idx[1] < idx[2] && idx[2] < idx[3], '角色 < 运行环境 < 工具约束 < 任务');
});

test('prompt-builder: 无 profile 省略角色段；schema 对象 JSON 序列化；空输入只剩环境段（F6+F7 起环境段恒在场）', () => {
  const noProfile = buildPrompt({ task: '做点事' });
  assert.ok(!noProfile.includes('角色设定'));
  assert.ok(noProfile.includes('做点事'));

  const objSchema = buildPrompt({ task: 't', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } });
  assert.ok(objSchema.includes('"type": "object"'));
  assert.ok(!objSchema.includes('参考技能'), '无 skillRefs 省略技能段');

  // 旧契约「空输入 → 空串」随 F6+F7 环境段推翻：环境事实必须全 agent 一致在场
  //（空任务书的裸跑同样要拿到单轮/无派发工具事实），故空输入 = 仅环境段
  for (const empty of [buildPrompt({}), buildPrompt()]) {
    assert.ok(empty.includes('## 运行环境'), '空输入仍带环境段');
    assert.ok(!empty.includes('## 任务') && !empty.includes('角色设定') && !empty.includes('MANDATORY'), '且仅环境段');
  }
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

test('record-store: list 按 startedAt 倒序；get 返回副本', (t) => {
  setupRoot(t);
  const store = new RecordStore();
  store.create({ subagentId: 'sa-1', slug: 'a', startedAt: 1000 });
  store.create({ subagentId: 'sa-2', slug: 'a', startedAt: 3000 });
  store.create({ subagentId: 'sa-3', slug: 'b', startedAt: 2000 });
  store.transition('sa-1', 'created', 'running');

  assert.deepEqual(store.list().map((r) => r.subagentId), ['sa-2', 'sa-3', 'sa-1']);

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
