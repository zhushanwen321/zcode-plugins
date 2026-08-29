'use strict';
/**
 * hook-inject 纯函数单测（fixture 驱动，零 IO——被测模块本身不触 fs）。
 *
 * 覆盖 impl-plan u1 验收条款：两层结构、默认标记、apiKey 过滤口径
 * （默认段不过滤 / 其余段过滤）、UUID 缩写对照、agents 描述截断、
 * ≤45 行预算截断序（agents 先截 → workflows 后截 → models 永不截）、
 * 空输入降级。渲染口径与 lib/model-router.js 同源（PROVIDER_ID 直接
 * require 断言，防双源漂移）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderResourcesBlock } = require('../lib/hook-inject');
const { PROVIDER_ID } = require('../lib/model-router');

const NOW = '2026-08-29T12:00:00+08:00';
const BUILTINS = ['chain', 'parallel', 'map-reduce', 'scatter-gather', 'review-fix-loop'];

/** 标准 fixture：默认 provider（2 模型）+ 三种形态的其他 provider。 */
function mkBaseV2() {
  return {
    provider: {
      [PROVIDER_ID]: { models: { 'GLM-5.3': {}, 'GLM-5.3-Flash': {} } },
      'prov-a': { options: { apiKey: 'k-a' }, models: { 'm1': {}, 'm2': {} } },
      'prov-no-key': { models: { 'ghost': {} } }, // 无 apiKey：其余段必须过滤
      'prov-no-models': { options: { apiKey: 'k-nm' }, models: {} }, // 无模型：其余段必须过滤
    },
  };
}

function render(overrides) {
  return renderResourcesBlock({
    v2: mkBaseV2(),
    cliModelMain: `${PROVIDER_ID}/GLM-5.3-Flash`,
    agents: [],
    scripts: [],
    builtinWorkflows: BUILTINS,
    nowIso: NOW,
    ...overrides,
  });
}

const linesOf = (s) => s.split('\n');

// ---------------------------------------------------------------------------
// 两层结构与默认标记
// ---------------------------------------------------------------------------

test('两层结构：默认段名单+默认标记；其余段只含 apiKey 非空且模型非空的 provider（全名形态）', () => {
  const out = render();
  const lines = linesOf(out);

  // 外层单块 + snapshot 注入
  assert.equal(lines[0], `<zsw-resources snapshot="${NOW}">`);
  assert.equal(lines[lines.length - 1], '</zsw-resources>');
  assert.equal(lines.filter((l) => l.includes('<zsw-resources')).length, 1, '只允许一个外层标签');

  // 默认 provider 段：名单 + （默认）标记（cliModelMain = PROVIDER_ID/GLM-5.3-Flash 可解析）
  const defLine = lines.find((l) => l.includes(`默认 provider ${PROVIDER_ID}`));
  assert.ok(defLine, '应有默认 provider 行');
  assert.equal(
    defLine,
    `  默认 provider ${PROVIDER_ID}（短名直接可传）：GLM-5.3, GLM-5.3-Flash（默认）`
  );

  // 其余段：header + 只含 prov-a（全名形态，同行 · 连接）
  const headerIdx = lines.findIndex((l) => l.includes('其他可运行 provider'));
  assert.ok(headerIdx > 0, '应有其他可运行 provider header');
  assert.match(lines[headerIdx], /跨 provider 必须用全名 <provider>\/<model>/);
  const otherLines = lines.slice(headerIdx + 1).filter((l) => l.startsWith('    '));
  assert.deepEqual(otherLines, ['    prov-a/m1 · prov-a/m2'], '其余段只列 prov-a，全名 · 连接');

  // apiKey 过滤：无 key / 无模型的 provider 不得出现在其余段
  assert.ok(!out.includes('prov-no-key'), '无 apiKey provider 不得出现');
  assert.ok(!out.includes('prov-no-models'), '模型清单为空的 provider 不得出现');
});

test('默认标记口径：cliModelMain 不可被默认 provider 清单解析时不标（短名未知 / 指向其他 provider / 缺省）', () => {
  for (const cliModelMain of ['no-such-model', 'prov-a/m1', null, undefined]) {
    const out = render({ cliModelMain });
    assert.ok(!out.includes('（默认）'), `cliModelMain=${String(cliModelMain)} 不应产生默认标记`);
    assert.ok(out.includes('GLM-5.3, GLM-5.3-Flash'), '名单照常渲染');
  }
  // 反例锚定：短名形态可解析时照常标记
  assert.ok(render({ cliModelMain: 'GLM-5.3' }).includes('GLM-5.3（默认）'), '短名可解析应标记');
});

// ---------------------------------------------------------------------------
// apiKey 过滤口径：默认段不筛、其余段筛
// ---------------------------------------------------------------------------

test('apiKey 过滤口径：默认 provider 无凭据时名单照常渲染（不筛），且不出现在其余段', () => {
  const v2 = {
    provider: {
      [PROVIDER_ID]: { models: { 'GLM-5.3': {} } }, // 无 options.apiKey
      'prov-b': { options: { apiKey: 'k' }, models: { 'mb': {} } },
    },
  };
  const out = render({ v2 });
  const lines = linesOf(out);
  assert.ok(
    lines.some((l) => l.includes(`默认 provider ${PROVIDER_ID}`) && l.includes('GLM-5.3')),
    '默认段不筛 apiKey：无凭据仍渲染名单'
  );
  const otherLines = lines.filter((l) => l.startsWith('    '));
  assert.deepEqual(otherLines, ['    prov-b/mb'], '其余段不含默认 provider（即使其无凭据）');
});

// ---------------------------------------------------------------------------
// UUID 缩写与对照行
// ---------------------------------------------------------------------------

test('UUID provider：前 8 位…缩写 + 首个条目后附全名对照；非 UUID provider 无对照', () => {
  const uuid = '5c5bb493-035c-4214-8a75-0563fba60394';
  const v2 = {
    provider: {
      [PROVIDER_ID]: { models: { 'GLM-5.3': {} } },
      [uuid]: { options: { apiKey: 'k' }, models: { 'MiniMax-M3': {}, 'M2': {} } },
    },
  };
  const lines = linesOf(render({ v2 }));
  const uuidLine = lines.find((l) => l.includes('5c5bb493…'));
  assert.ok(uuidLine, 'UUID provider 应以 8 位缩写出现');
  assert.equal(
    uuidLine,
    '    5c5bb493…/MiniMax-M3 · 5c5bb493… 即 5c5bb493-035c-4214-8a75-0563fba60394 · 5c5bb493…/M2',
    '对照紧跟首条目（§3.1 样例形态），全名对照仅一次'
  );
  assert.equal(lines.filter((l) => l.includes(' 即 ')).length, 1, '对照只附一次');
});

// ---------------------------------------------------------------------------
// agents 段
// ---------------------------------------------------------------------------

test('agents 描述截断 20 字：超长截断、恰 20 全留、无描述只列 name', () => {
  const agents = [
    { name: 'long', description: '一二三四五六七八九十一二三四五六七八九十一二三四五' }, // 25 字
    { name: 'exact', description: '一二三四五六七八九十一二三四五六七八九十' }, // 20 字
    { name: 'nodesc' }, // 无描述
  ];
  const lines = linesOf(render({ agents }));
  assert.ok(lines.includes('  long（一二三四五六七八九十一二三四五六七八九十）'), '描述截到 20 字');
  assert.ok(!lines.some((l) => l.includes('一）') && l.includes('long')), '不得残留第 21 字');
  assert.ok(lines.includes('  exact（一二三四五六七八九十一二三四五六七八九十）'), '恰 20 字全留');
  assert.ok(lines.includes('  nodesc'), '无描述只列 name');
});

// ---------------------------------------------------------------------------
// 预算截断序：agents 先截 → workflows 后截 → models 永不截
// ---------------------------------------------------------------------------

test('超预算（大量 agents）：agents 先截（标注 + 保留靠前条目），workflows 完整，models 全量，全文 ≤45 行', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ name: `agent-${String(i).padStart(3, '0')}`, description: 'd' }));
  const out = render({ agents: many });
  const lines = linesOf(out);

  assert.ok(lines.length <= 45, `全文硬预算 ≤45 行（实际 ${lines.length}）`);
  assert.ok(lines.some((l) => l.includes('完整清单：zsw agents')), 'agents 段被截时有对应标注');
  assert.ok(!out.includes('完整清单：zsw workflow'), 'agents 先截：workflows 未被截');

  // workflows 完整保留（内置名单 + 0 script 原样）
  const wfLine = lines.find((l) => l.startsWith('workflows：'));
  assert.match(wfLine, /内置 chain \/ parallel \/ map-reduce \/ scatter-gather \/ review-fix-loop/);
  assert.match(wfLine, /（当前 0 个）/);

  // models 永不截：默认段 + prov-a 行原样在
  assert.ok(lines.some((l) => l.includes(`默认 provider ${PROVIDER_ID}`) && l.includes('（默认）')));
  assert.ok(lines.includes('    prov-a/m1 · prov-a/m2'));

  // 保留靠前条目：首个在、末个不在（条目行形态 "  name（desc）"）
  assert.ok(lines.includes('  agent-000（d）'), '首个条目应保留');
  assert.ok(!lines.some((l) => l.includes('agent-099')), '末个条目应被截掉');
});

test('超预算（models 极端多）：agents 截无可截后 workflows 才被截，models 行一个不少', () => {
  const provider = {};
  for (let i = 0; i < 40; i++) provider[`p${String(i).padStart(2, '0')}`] = { options: { apiKey: 'k' }, models: { m: {} } };
  const agents = Array.from({ length: 5 }, (_, i) => ({ name: `ax${i}`, description: 'd' }));
  const out = render({ v2: { provider }, agents, scripts: ['s1', 's2'] });
  const lines = linesOf(out);

  // models 永不截：40 个 provider 行全在
  for (let i = 0; i < 40; i++) assert.ok(lines.some((l) => l.includes(`    p${String(i).padStart(2, '0')}/m`)), `p${i} 行应在`);
  // agents 先截：截到最小形态（零条目 + 单行标注）
  assert.ok(lines.some((l) => l.includes('完整清单：zsw agents')), 'agents 被截应有标注');
  assert.ok(!lines.some((l) => l.includes('ax0')), '预算为零时 agents 零条目');
  // workflows 后截：此极端下才降级（丢名单 + 标注）
  const wfLine = lines.find((l) => l.startsWith('workflows：'));
  assert.match(wfLine, /完整清单：zsw workflow --action scripts/);
  assert.match(wfLine, /当前 2 个/);
  assert.ok(!wfLine.includes('：s1 · s2'), '截断态丢 script 名单');
});

test('未超预算时不产生任何截断标注（正常规模全文 ≤45 行）', () => {
  const agents = Array.from({ length: 6 }, (_, i) => ({ name: `a${i}`, description: `描述${i}` }));
  const out = render({ agents, scripts: ['deploy'] });
  const lines = linesOf(out);
  assert.ok(!out.includes('完整清单：'), '预算内不得出现截断标注');
  assert.ok(lines.length <= 45);
  assert.match(lines.find((l) => l.startsWith('workflows：')), /当前 1 个：deploy/);
  assert.ok(lines.includes('  a0（描述0）') && lines.includes('  a5（描述5）'), 'agents 全量保留');
});

// ---------------------------------------------------------------------------
// 降级渲染
// ---------------------------------------------------------------------------

test('空输入/畸形 v2 降级渲染不抛错：块结构完整、默认段降级、兜底行恒在', () => {
  const cases = [{ v2: null }, { v2: {} }, { v2: { provider: null } }, { v2: { provider: { x: null } } }];
  for (const overrides of cases) {
    const out = render(overrides);
    const lines = linesOf(out);
    assert.ok(lines[0].startsWith('<zsw-resources snapshot='), `case ${JSON.stringify(overrides)}: 开标签`);
    assert.equal(lines[lines.length - 1], '</zsw-resources>');
    assert.ok(
      lines.some((l) => l.includes(`默认 provider ${PROVIDER_ID}`) && l.includes('（无可用模型清单）')),
      '默认 provider 无清单时降级占位'
    );
    assert.ok(lines.some((l) => l.startsWith('兜底：传错模型名时报错自带可用清单')), '兜底行恒在');
    assert.ok(lines.some((l) => l.startsWith('agents（四根发现，同名高优先级根胜出）：（无）')), '空 agents 降级');
    assert.match(lines.find((l) => l.startsWith('workflows：')), /内置 chain/); // builtinWorkflows 仍为 BUILTINS
  }
});

test('builtinWorkflows 缺省与 nowIso 缺省均不抛错', () => {
  const out = renderResourcesBlock({ v2: mkBaseV2(), cliModelMain: null });
  assert.ok(out.startsWith('<zsw-resources snapshot="">'));
  const wfLine = linesOf(out).find((l) => l.startsWith('workflows：'));
  assert.match(wfLine, /内置（无）/);
  assert.match(wfLine, /当前 0 个/);
});
