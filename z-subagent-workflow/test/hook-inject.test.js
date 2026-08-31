'use strict';
/**
 * hook-inject 纯函数单测（W7：core 三段 XML 渲染形态——renderResourcesBlock
 * 零 fs，v2/条目数据全为传入对象）。
 *
 * 覆盖 W7 验收条款：三段 tag 名/字段集（<available_subagents> /
 * <available_workflows> / <available_provider_models>）、agent 条目
 * name/description/when/location、models 段 contextWindow/reasoning 档位
 * （v2 config 真实形态 fixture）+ input 缺席守卫（ModelEntry 并集）、分段
 * 条目预算边界（subagents 15/16、workflows 10/11）、20+ agents 码点序截尾
 * + 兜底指引 + models 段完整、内置条目无截断豁免（D-3 红线）、空输入降级
 * （空清单段缺席不抛）。
 *
 * 无 HOME 隔离：W7 起本模块渲染链零 fs（model-router 谓词纯函数消费、
 * core format 不触盘），旧两层 models 渲染的 listModels 交叉锚定随默认标记
 * 机制退役（当前默认改由 models guide 承载，见 modelsGuide 用例）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  renderResourcesBlock,
  AGENTS_MAX_ENTRIES,
  WORKFLOWS_MAX_ENTRIES,
  modelsGuide,
} = require('../lib/hook-inject');
const { PROVIDER_ID } = require('../lib/model-router');

assert.equal(AGENTS_MAX_ENTRIES, 15, 'D-3a：subagents 段条目预算 15（开箱 10 内置 + 5 用户余量）');
assert.equal(WORKFLOWS_MAX_ENTRIES, 10, 'D-3a：workflows 段条目预算 10');

const NOW = '2026-08-29T12:00:00.000Z';
const DEFAULT_REF = `${PROVIDER_ID}/GLM-5.3-Flash`;

/** 标准 fixture：默认 provider（重量模型带 label/窗口/推理档位 + 轻量裸模型）+ 三种形态的其他 provider。 */
function mkBaseV2() {
  return {
    provider: {
      [PROVIDER_ID]: {
        models: {
          // v2 config 真实形态（model-router.modelEntries 同构字段面）
          'GLM-5.3': {
            label: 'GLM 重量档',
            limit: { context: 200000 },
            reasoning: { variants: ['high', 'medium', 'low'], defaultVariant: 'medium' },
          },
          'GLM-5.3-Flash': {}, // 无任何附加维度的裸模型
        },
      },
      'prov-a': { options: { apiKey: 'k-a' }, models: { m1: {}, m2: {} } },
      'prov-no-key': { models: { ghost: {} } }, // 无 apiKey：其余 provider 面必须过滤
      'prov-no-models': { options: { apiKey: 'k-nm' }, models: {} }, // 无模型：同上
    },
  };
}

function agent(name, extra = {}) {
  return { name, description: `desc of ${name}`, filePath: `/abs/agents/${name}.md`, ...extra };
}

function workflow(name, description = `wf ${name}`) {
  return { name, description, path: `/abs/workflows/${name}.js` };
}

function render(overrides) {
  return renderResourcesBlock({
    v2: mkBaseV2(),
    cliModelMain: DEFAULT_REF,
    agents: [agent('a1'), agent('a2')],
    workflows: [workflow('w1'), workflow('w2')],
    nowIso: NOW,
    ...overrides,
  });
}

/** 提取 subagents 段内的条目 name 序（断言码点序排布用）。 */
function agentNames(ctx) {
  return [...ctx.matchAll(/<agent><name>([^<]+)<\/name>/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// 三段结构：tag 名 / 段序 / 旧形态退役
// ---------------------------------------------------------------------------

test('三段结构：tag 名各恰一次、闭合标签在场、段序 subagents → workflows → models、旧 <zsw-resources> 退役', () => {
  const ctx = render();
  for (const tag of ['available_subagents', 'available_workflows', 'available_provider_models']) {
    assert.equal(ctx.split(`<${tag}>`).length - 1, 1, `<${tag}> 开标签恰一次`);
    assert.ok(ctx.includes(`</${tag}>`), `</${tag}> 闭合在场`);
  }
  const order = [
    ctx.indexOf('<available_subagents>'),
    ctx.indexOf('<available_workflows>'),
    ctx.indexOf('<available_provider_models>'),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order, '三段按 subagents → workflows → models 序拼接');
  assert.ok(!ctx.includes('zsw-resources'), '旧单块 <zsw-resources> 形态不得残留');
});

test('段引导（guide 宿主注入）：三段各自引导文案在场（models guide 含默认模型与时戳）', () => {
  const ctx = render();
  assert.ok(ctx.includes('The following subagents are available.'), 'subagents guide 在场');
  assert.ok(ctx.includes('The following workflows are available.'), 'workflows guide 在场');
  const guide = modelsGuide(NOW, DEFAULT_REF);
  assert.ok(ctx.includes(guide), 'models guide（动态拼接产物）在场');
  assert.ok(guide.includes(`Current default model: ${DEFAULT_REF}`), 'guide 含当前默认模型');
  assert.ok(guide.includes(`Snapshot generated ${NOW}`), 'guide 含快照时戳句');
  assert.ok(guide.includes('zsw models --all'), 'guide 含现查兜底指引');
});

// ---------------------------------------------------------------------------
// agent 条目：字段集 name/description[/when]/location + XML 转义
// ---------------------------------------------------------------------------

test('agent 条目字段集：name/description/when/location；when 缺席条目不渲染 <when>', () => {
  const ctx = render({
    agents: [
      agent('with-when', { when: '用户要求审查代码时', description: '审查角色' }),
      agent('no-when'),
    ],
  });
  assert.ok(
    ctx.includes('<agent><name>with-when</name><description>审查角色</description><when>用户要求审查代码时</when><location>/abs/agents/with-when.md</location></agent>'),
    'when 条目完整字段序：name → description → when → location',
  );
  const noWhen = ctx.match(/<agent><name>no-when[\s\S]*?<\/agent>/);
  assert.ok(noWhen, 'no-when 条目在场');
  assert.ok(!noWhen[0].includes('<when>'), '无 when 的条目不得渲染空 when 元素');
});

test('agent 条目 XML 转义：name/description 含 <>&" 原样不破坏段结构', () => {
  const ctx = render({ agents: [agent('x<y>&"z', { description: 'a<b>&c' })] });
  assert.ok(ctx.includes('<name>x&lt;y&gt;&amp;&quot;z</name>'), 'name 转义');
  assert.ok(ctx.includes('<description>a&lt;b&gt;&amp;c</description>'), 'description 转义');
});

test('agents 投影：AgentProfile.filePath → location；无名条目丢弃；description 不截断（旧 20 码点截断随单块退役）', () => {
  const long = '一'.repeat(60); // 旧形态会截 20 码点
  const ctx = render({ agents: [agent('long-desc', { description: long }), { description: '无名的丢弃' }, null] });
  assert.ok(ctx.includes(`<description>${long}</description>`), '长描述完整保留（core AgentEntry 口径）');
  assert.ok(!ctx.includes('无名的丢弃'), '无名条目丢弃');
});

// ---------------------------------------------------------------------------
// workflow 条目：字段集 name/description/location + 长描述截断
// ---------------------------------------------------------------------------

test('workflow 条目字段集：name/description/location；description 超 160 码点截断（summarizeDescription）', () => {
  const short = '短描述。';
  const long = '这是第一句。' + '补'.repeat(200) + '。';
  const ctx = render({ workflows: [workflow('short', short), workflow('long', long)] });
  assert.ok(
    ctx.includes('<workflow><name>short</name><description>短描述。</description><location>/abs/workflows/short.js</location></workflow>'),
    '完整条目字段序：name → description → location',
  );
  const longDesc = ctx.match(/<workflow><name>long<\/name><description>([^<]*)<\/description>/);
  assert.ok(longDesc, 'long 条目在场');
  assert.ok(longDesc[1].length <= 160 + 1, `长描述截断到 ≤161 码点（实际 ${longDesc[1].length}）`);
  assert.ok(longDesc[1].includes('这是第一句。'), '截断优先在句末标点断句');
});

// ---------------------------------------------------------------------------
// models 段：v2 真实形态投影（contextWindow / reasoning 档位 / provider 范围）
// ---------------------------------------------------------------------------

test('models 段字段：id 全名 provider/model、name、caps=reasoning（variants 档位对象）、contextWindow；裸模型无 caps/contextWindow', () => {
  const ctx = render();
  assert.ok(
    ctx.includes(`<model><id>${PROVIDER_ID}/GLM-5.3</id><name>GLM-5.3</name><caps>reasoning</caps><contextWindow>200000</contextWindow></model>`),
    '重量模型完整字段序：id → name → caps → contextWindow',
  );
  assert.ok(
    ctx.includes(`<model><id>${PROVIDER_ID}/GLM-5.3-Flash</id><name>GLM-5.3-Flash</name></model>`),
    '裸模型无 caps/contextWindow 元素',
  );
  assert.ok(ctx.includes('<model><id>prov-a/m1</id><name>m1</name></model>'), '其余合格 provider 全名 id');
});

test('ModelEntry 并集守卫（红线 5）：zsw 投影永不填 input，渲染不炸且不渲染 vision；label 进投影不进输出', () => {
  const ctx = render();
  assert.ok(!ctx.includes('vision'), 'input 缺席（zsw 投影口径）不得触发 vision 标记，更不得抛错');
  assert.ok(!ctx.includes('GLM 重量档'), 'label 透传进 ModelEntry 并集但 core 渲染面暂不消费（不出现在输出）');
});

test('provider 范围口径：默认 provider 不筛凭据全列；其余只列「带凭据且清单非空」（qualifiedProviders 单源）', () => {
  const ctx = render();
  assert.ok(ctx.includes(`${PROVIDER_ID}/GLM-5.3`), '默认 provider 恒列（不筛 apiKey）');
  assert.ok(ctx.includes('prov-a/m1') && ctx.includes('prov-a/m2'), '带凭据 provider 全模型');
  assert.ok(!ctx.includes('prov-no-key'), '无凭据 provider 不得出现');
  assert.ok(!ctx.includes('prov-no-models'), '空清单 provider 不得出现');
});

test('UUID provider：全名 id 渲染（可复制引用形态；旧单块的 8 位缩写展示机制退役）', () => {
  const uuid = '5c5bb493-035c-4214-8a75-0563fba60394';
  const v2 = {
    provider: {
      [PROVIDER_ID]: { models: { 'GLM-5.3': {} } },
      [uuid]: { options: { apiKey: 'k' }, models: { 'MiniMax-M3': {} } },
    },
  };
  const ctx = render({ v2 });
  assert.ok(ctx.includes(`<id>${uuid}/MiniMax-M3</id>`), 'UUID provider 以全名渲染（引用即所载）');
});

test('models 段排序：provider 归组、组内 id 码点序（core compareModelEntries）', () => {
  const v2 = { provider: { 'z-prov': { options: { apiKey: 'k' }, models: { b: {}, a: {} } }, 'a-prov': { options: { apiKey: 'k' }, models: { y: {}, x: {} } } } };
  const ids = [...render({ v2 }).matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['a-prov/x', 'a-prov/y', 'z-prov/a', 'z-prov/b'], 'provider 码点序归组 + 组内 id 码点序');
});

// ---------------------------------------------------------------------------
// modelsGuide：默认模型句 / 时戳句的在场性边界
// ---------------------------------------------------------------------------

test('modelsGuide：cliModelMain 空/缺省不加默认句；nowIso 空不加时戳句', () => {
  for (const cliModelMain of [null, undefined, '', '   ']) {
    const g = modelsGuide(NOW, cliModelMain);
    assert.ok(!g.includes('Current default model:'), `cliModelMain=${JSON.stringify(cliModelMain)} 无默认句`);
  }
  assert.ok(!modelsGuide('', DEFAULT_REF).includes('Snapshot generated'), 'nowIso 空无时戳句');
  assert.ok(modelsGuide(NOW, DEFAULT_REF).includes('Current default model:'), '双参齐备两句俱在');
});

// ---------------------------------------------------------------------------
// 分段条目预算：码点序 + 截尾 + 兜底指引 + 内置无豁免
// ---------------------------------------------------------------------------

test('预算边界（subagents）：恰 15 条不截（无兜底行）；16 条截尾（前 15 在、第 16 不在、兜底行在场）', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => agent(`a-${String(i).padStart(2, '0')}`));
  const exact = render({ agents: mk(15) });
  assert.equal(agentNames(exact).length, 15, '恰预算：全量保留');
  assert.ok(!exact.includes('完整清单：zsw agents'), '未截断不得出现兜底行');

  const over = render({ agents: mk(16) });
  const names = agentNames(over);
  assert.equal(names.length, 15, '16 条 → 保留 15');
  assert.ok(names.includes('a-14') && !names.includes('a-15'), '码点序尾部条目被裁');
  assert.ok(over.includes('完整清单：zsw agents'), '截断态兜底指引在场');
});

test('预算边界（workflows）：恰 10 条不截；11 条截尾 + 「完整清单：zflow scripts」兜底', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => workflow(`wf-${String(i).padStart(2, '0')}`));
  assert.ok(!render({ workflows: mk(10) }).includes('完整清单：zflow scripts'), '恰预算不截');
  const over = render({ workflows: mk(11) });
  const names = [...over.matchAll(/<workflow><name>([^<]+)<\/name>/g)].map((m) => m[1]);
  assert.equal(names.length, 10, '11 条 → 保留 10');
  assert.ok(names.includes('wf-09') && !names.includes('wf-10'), '尾部裁');
  assert.ok(over.includes('完整清单：zflow scripts'), '兜底指引在场');
});

test('20+ agents：subagents 段码点序截尾（非 locale 序）+ 兜底指引；workflows/models 段不受影响完整在场', () => {
  // 乱序输入 + 码点序敏感名（大写 < 小写：'A' 65 < 'Z' 90 < 'a' 97）
  const base = ['b-agent', 'A-agent', 'a-agent', 'Z-agent'].map((n) => agent(n));
  const many = [...base, ...Array.from({ length: 22 }, (_, i) => agent(`m-${String(i).padStart(2, '0')}`))];
  assert.equal(many.length, 26, 'fixture：26 条 > 预算 15');

  const v2 = mkBaseV2();
  const workflows = Array.from({ length: 4 }, (_, i) => workflow(`keep-${i}`));
  const ctx = render({ agents: many, workflows });

  const names = agentNames(ctx);
  assert.equal(names.length, 15, 'subagents 段恰 15 条');
  // 码点序断言：A-agent 与 Z-agent 均小于一切 m-*/a-/b- 小写名，必在保留集且排最前
  assert.deepEqual(names.slice(0, 2), ['A-agent', 'Z-agent'], '码点序（大写排前），非 locale 序（locale 常将大小写混排）');
  assert.ok([...names].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)).every((n, i) => n === names[i]), '保留集整体码点有序');
  assert.ok(ctx.includes('完整清单：zsw agents'), 'subagents 兜底指引在场');

  // workflows 段不受 agents 超预算影响：4 条全在、无截断行
  const wfNames = [...ctx.matchAll(/<workflow><name>([^<]+)<\/name>/g)].map((m) => m[1]);
  assert.equal(wfNames.length, 4, 'workflows 段独立预算，完整在场');
  // models 段完整永不截：3 条模型（默认 2 + prov-a 1 条取 m1）——fixture 全集在场
  for (const id of [`${PROVIDER_ID}/GLM-5.3`, `${PROVIDER_ID}/GLM-5.3-Flash`, 'prov-a/m1', 'prov-a/m2']) {
    assert.ok(ctx.includes(`<id>${id}</id>`), `models 段完整：${id} 在场`);
  }
});

test('models 段完整永不截：30+ 模型全量渲染（无预算参数），subagents 截断不影响', () => {
  const models = {};
  for (let i = 0; i < 30; i++) models[`model-${String(i).padStart(2, '0')}`] = {};
  const v2 = { provider: { [PROVIDER_ID]: { models } } };
  const ctx = render({ v2, agents: Array.from({ length: 30 }, (_, i) => agent(`x-${i}`)) });
  assert.equal([...ctx.matchAll(/<id>[^/]*\/model-\d+<\/id>/g)].length, 30, '30 模型一个不少');
  assert.ok(ctx.includes('完整清单：zsw agents'), 'subagents 照常截断（分段预算互不影响）');
});

test('内置条目无截断豁免（D-3 红线）：内置名码点序排尾部时照常被裁（不做两段式保留）', () => {
  // 'aaa-01'…'aaa-15'（'a' 97 < 'r' 114）全部码点序先于内置 'reviewer' → reviewer 排第 16 被裁
  const agents = [
    agent('reviewer', { filePath: '/vendored/subagent-core/agents/reviewer.md' }),
    ...Array.from({ length: 15 }, (_, i) => agent(`aaa-${String(i).padStart(2, '0')}`)),
  ];
  const ctx = render({ agents });
  const names = agentNames(ctx);
  assert.equal(names.length, 15, '统一截尾到预算');
  assert.ok(!names.includes('reviewer'), '内置 reviewer 无豁免：码点序尾部照裁');
  assert.ok(ctx.includes('完整清单：zsw agents'), '兜底指引可恢复');
});

// ---------------------------------------------------------------------------
// 空输入 / 畸形降级
// ---------------------------------------------------------------------------

test('空清单段缺席不注入：agents 空 → 无 subagents 段；workflows 空 → 无 workflows 段；v2 null → 无 models 段', () => {
  const onlyModels = render({ agents: [], workflows: [] });
  assert.ok(onlyModels.includes('<available_provider_models>'), 'models 段独立在场');
  assert.ok(!onlyModels.includes('<available_subagents>'), '空 agents 段不注入');
  assert.ok(!onlyModels.includes('<available_workflows>'), '空 workflows 段不注入');

  const onlyAgents = render({ v2: null });
  assert.ok(onlyAgents.includes('<available_subagents>'), 'agents 段独立在场');
  assert.ok(!onlyAgents.includes('<available_provider_models>'), '空 models 段不注入');

  assert.equal(renderResourcesBlock({ v2: null, cliModelMain: null, agents: [], workflows: [] }), '', '三段全空 → 空串');
});

test('畸形 v2 不抛：provider null / 条目 null 均降级为该段缺席或部分渲染', () => {
  for (const v2 of [{}, { provider: null }, { provider: { x: null } }]) {
    const ctx = renderResourcesBlock({ v2, cliModelMain: null, agents: [agent('a1')], workflows: [workflow('w1')] });
    assert.ok(ctx.includes('<available_subagents>'), `case ${JSON.stringify(v2)}: agents 段正常`);
    assert.ok(!ctx.includes('undefined'), '不得渲染 undefined 垃圾');
  }
});
