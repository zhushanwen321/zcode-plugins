'use strict';
/**
 * hook-inject 纯函数单测（fixture 驱动——renderResourcesBlock 本身零 fs）+
 * 交叉锚定测试（listModels / listScripts 侧，带 HOME 隔离的受限 IO）。
 *
 * 覆盖 impl-plan u1 验收条款：两层结构、默认标记、apiKey 过滤口径
 * （默认段不过滤 / 其余段过滤）、UUID 缩写对照、agents 描述截断（码点安全）、
 * ≤45 行预算截断序（agents 先截 → workflows 后截 → models 永不截）、
 * 空输入降级、models 段头部「当前默认：」恒显全名行（S1：默认段标记与该行
 * 双重在场）。渲染口径与 lib/model-router.js 单源（谓词直接 require 断言，
 * 防双源漂移）。
 *
 * 隔离：文件顶部先设 HOME 再 require lib——config.js 在 require 期用
 * os.homedir() 冻结 V2_CONFIG_PATH/CLI_CONFIG_PATH（POSIX 读 $HOME），交叉
 * 锚定测试跑 ModelRouter.listModels()（读 v2/cli config）时落在临时目录，
 * 禁碰真实 ~/.zcode。纯函数用例不受该隔离影响。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// HOME 隔离必须先于任何 lib require（见文件头注释）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-hook-inject-'));
const ANCHOR_HOME = path.join(TMP, 'home'); // 交叉锚定的 v2/cli config 与 HOME 侧脚本根
fs.mkdirSync(ANCHOR_HOME, { recursive: true });
process.env.HOME = ANCHOR_HOME;

const { renderResourcesBlock } = require('../lib/hook-inject');
const ModelRouter = require('../lib/model-router');
const { PROVIDER_ID, availableModels, hasProviderCredentials } = ModelRouter;
const { V2_CONFIG_PATH, CLI_CONFIG_PATH } = require('../lib/config');

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

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

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
// 当前默认恒显全名行（修复 2；计入 45 行预算）
// ---------------------------------------------------------------------------

test('当前默认行：models 段头部渲染 defaultModelRef 全名（段头之后、名单行之前）', () => {
  const lines = linesOf(render());
  const cur = lines.find((l) => l.startsWith('  当前默认：'));
  assert.ok(cur, '应有当前默认行');
  assert.equal(cur, `  当前默认：${PROVIDER_ID}/GLM-5.3-Flash`, '恒显回退链产物全名');
  const idxModels = lines.indexOf('models：');
  const idxCur = lines.indexOf(cur);
  const idxDef = lines.findIndex((l) => l.includes(`默认 provider ${PROVIDER_ID}`));
  assert.ok(idxCur === idxModels + 1 && idxDef === idxCur + 1, '当前默认行在 models 段头部');
});

test('S1 双重在场：默认段（默认）标记与当前默认行同块共存；指向其他 provider 时行仍恒显、标记不出现', () => {
  const out = render({ cliModelMain: 'GLM-5.3' });
  assert.ok(out.includes('  当前默认：GLM-5.3'), '当前默认行在场');
  assert.ok(out.includes('GLM-5.3（默认）'), '默认 provider 段标记在场');

  const out2 = render({ cliModelMain: 'prov-a/m1' });
  assert.ok(out2.includes('  当前默认：prov-a/m1'), 'main 指向非默认 provider 时行仍恒显');
  assert.ok(!out2.includes('（默认）'), '非默认 provider 不产生段内标记');
});

test('当前默认行缺席：cliModelMain 空/缺省时不加（无任何可解析默认）', () => {
  for (const cliModelMain of [null, undefined, '', '   ']) {
    const out = render({ cliModelMain });
    assert.ok(!out.includes('当前默认'), `cliModelMain=${JSON.stringify(cliModelMain)} 不应有当前默认行`);
  }
});

// ---------------------------------------------------------------------------
// 交叉锚定：同一 v2 fixture 下 listModels 与 renderResourcesBlock 默认标记一致
// （修复 1 的防漂移锚，覆盖三形态。受限 IO：读写均落在顶部 HOME 隔离目录）
// ---------------------------------------------------------------------------

/** 写入锚定 fixture（cliMain === undefined 表示 cli config 不存在）。 */
function writeAnchorConfigs(v2, cliMain) {
  fs.mkdirSync(path.dirname(V2_CONFIG_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(CLI_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(V2_CONFIG_PATH, JSON.stringify(v2));
  if (cliMain === undefined) fs.rmSync(CLI_CONFIG_PATH, { force: true });
  else fs.writeFileSync(CLI_CONFIG_PATH, JSON.stringify({ model: { main: cliMain } }));
}

/** hook 侧按 bin/zsw.js 的实际形态渲染（cliModelMain = defaultModelRef 回退链产物）。 */
function anchorBlock(v2, cliModelMain) {
  return renderResourcesBlock({
    v2, cliModelMain, agents: [], scripts: [], builtinWorkflows: BUILTINS, nowIso: NOW,
  });
}

test('交叉锚定①：main 在默认 provider → listModels 与注入块标同一模型', () => {
  const v2 = mkBaseV2();
  const main = `${PROVIDER_ID}/GLM-5.3-Flash`;
  writeAnchorConfigs(v2, main);
  const def = new ModelRouter().listModels().find((m) => m.default);
  assert.equal(def && def.name, 'GLM-5.3-Flash', 'listModels 标 GLM-5.3-Flash');
  assert.ok(anchorBlock(v2, main).includes('GLM-5.3-Flash（默认）'), '注入块标同一模型');
  assert.ok(!anchorBlock(v2, main).includes('GLM-5.3（默认）'), '另一模型不标');
});

test('交叉锚定②：main 在非默认 provider → 默认 provider 清单两侧都不标（listModels 旧实现在此错标）', () => {
  const OTHER = 'builtin:bigmodel-start-plan';
  const v2 = {
    provider: {
      [PROVIDER_ID]: { models: { 'GLM-5.3': {}, 'GLM-5.3-Flash': {} } },
      [OTHER]: { models: { 'GLM-5.3-Flash': {} } }, // 跨 provider 同名模型：错标检测点
    },
  };
  const main = `${OTHER}/GLM-5.3-Flash`;
  writeAnchorConfigs(v2, main);
  const listed = new ModelRouter().listModels(); // 默认 provider 清单
  assert.ok(!listed.some((m) => m.default), '默认 provider 清单不得出现默认标记（修复点）');
  const block = anchorBlock(v2, main);
  assert.ok(!block.includes('（默认）'), '注入块同样不标');
  assert.ok(block.includes(`当前默认：${main}`), '当前默认行恒显全名');
  // 目标 provider 自己的清单上标记照常（谓词的 provider 维度正确性）
  assert.equal(new ModelRouter().listModels(OTHER).find((m) => m.default).name, 'GLM-5.3-Flash');
});

test('交叉锚定③：main 不可解析 → 两侧一致落回退链（v2 顶层 model.main，尽头内置回退）', () => {
  const v2 = { model: { main: `${PROVIDER_ID}/GLM-5.3` }, provider: mkBaseV2().provider };
  writeAnchorConfigs(v2, 'no-such-provider/no-such-model'); // cli main 不可解析 → 回退第 2 层
  const def = new ModelRouter().listModels().find((m) => m.default);
  assert.equal(def && def.name, 'GLM-5.3', '回退 v2 顶层 model.main');
  assert.ok(anchorBlock(v2, `${PROVIDER_ID}/GLM-5.3`).includes('GLM-5.3（默认）'), '注入块同口径');

  // 回退链尽头：cli config 缺失 + v2 无 model.main → 内置 FALLBACK，两侧一致
  const v2NoMain = { provider: mkBaseV2().provider };
  writeAnchorConfigs(v2NoMain, undefined);
  const def2 = new ModelRouter().listModels().find((m) => m.default);
  assert.equal(def2 && def2.name, 'GLM-5.3', '内置回退 FALLBACK_DEFAULT_MODEL 短名');
  assert.ok(anchorBlock(v2NoMain, `${PROVIDER_ID}/GLM-5.3`).includes('GLM-5.3（默认）'), '注入块同口径');
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
// 单一谓词语义锚（修复 3）：注入块过滤 ≡ hasProviderCredentials；导出谓词直测
// ---------------------------------------------------------------------------

test('语义锚：其余段在场性 ≡ hasProviderCredentials 且模型非空；导出谓词边界形态', () => {
  const v2 = mkBaseV2();
  const out = render({ v2 });
  for (const [id, e] of Object.entries(v2.provider)) {
    if (id === PROVIDER_ID) continue; // 默认段不筛（D3 口径），等价性只锚其余段
    assert.equal(
      out.includes(id),
      hasProviderCredentials(e) && Object.keys(e.models || {}).length > 0,
      `provider ${id} 在场性应与「有凭据且有模型」等价`
    );
  }
  // 谓词本身边界
  assert.equal(hasProviderCredentials(null), false);
  assert.equal(hasProviderCredentials(undefined), false);
  assert.equal(hasProviderCredentials({}), false);
  assert.equal(hasProviderCredentials({ options: {} }), false);
  assert.equal(hasProviderCredentials({ options: { apiKey: '' } }), false);
  assert.equal(hasProviderCredentials({ options: { apiKey: 'k' } }), true);
  // （splitModelRef 导出面已随执行解析删除——引用切分语义经 defaultModelFor
  // 的 provider 感知判定间接覆盖；清单导出与默认段渲染名单同源）
  assert.deepEqual(availableModels(mkBaseV2(), PROVIDER_ID), ['GLM-5.3', 'GLM-5.3-Flash']);
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

test('agents 描述截断 20 码点：超长截断、恰 20 全留、无描述只列 name', () => {
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

test('agents 描述截断码点安全：emoji surrogate 对不产生乱码尾字符', () => {
  // 'a' + 25 个 emoji：UTF-16 奇数起点，旧 slice(0,20) 会把第 10 个 emoji 切成孤立高位代理
  const agents = [{ name: 'emoji', description: 'a' + '😀'.repeat(25) }];
  const lines = linesOf(render({ agents }));
  const line = lines.find((l) => l.startsWith('  emoji（'));
  assert.ok(line, '条目应在');
  const body = line.slice('  emoji（'.length, -1); // 去掉前缀与收尾全角括号
  assert.equal(body, 'a' + '😀'.repeat(19), '按码点截 20：1 个 BMP 字符 + 19 个完整 emoji');
  assert.equal(Array.from(body).length, 20, '恰 20 码点');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(body), '无孤立高位代理（乱码尾字符）');
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

  // models 永不截：当前默认行 + 默认段 + prov-a 行原样在（当前默认行计入预算）
  assert.ok(lines.includes(`  当前默认：${PROVIDER_ID}/GLM-5.3-Flash`), '当前默认行在场');
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
    const fallback = lines.find((l) => l.startsWith('兜底：传错模型名时报错自带可用清单'));
    assert.ok(fallback, '兜底行恒在');
    assert.ok(fallback.includes('zsw models --all'), '兜底行含 --all 跨 provider 现查指引（与 README 样例同步）');
    assert.ok(fallback.includes('以本块与报错内清单为准'), '兜底行含权威序声明（与 README 样例同步）');
    assert.ok(lines.some((l) => l.startsWith('agents（四根发现，同名高优先级根胜出）：（无）')), '空 agents 降级');
    assert.match(lines.find((l) => l.startsWith('workflows：')), /内置 chain/); // builtinWorkflows 仍为 BUILTINS
  }
});

test('builtinWorkflows 缺省与 nowIso 缺省均不抛错', () => {
  const out = renderResourcesBlock({ v2: mkBaseV2(), cliModelMain: null });
  assert.ok(out.startsWith('<zsw-resources snapshot="">'));
  assert.ok(!out.includes('当前默认'), 'cliModelMain null：当前默认行缺席');
  const wfLine = linesOf(out).find((l) => l.startsWith('workflows：'));
  assert.match(wfLine, /内置（无）/);
  assert.match(wfLine, /当前 0 个/);
});

// ---------------------------------------------------------------------------
// name-only 发现（回接 2b）：orchestration-host.listWorkflowNames 与发现面交叉锚定
// ---------------------------------------------------------------------------

test('listWorkflowNames 与 scripts() 发现面名单一致（name-only 安全子集）且绝不执行脚本', async () => {
  const { listWorkflowNames, createOrchestrationHost } = require('../lib/orchestration-host');
  const ws = path.join(TMP, 'ws-scripts');
  // core 契约脚本 fixture（@pi-meta 块）；bomb.js 顶层 throw——发现面若误执行
  // 脚本体（require/eval）会直接炸测试，零执行行为锚
  const script = (name) =>
    `/* @pi-meta\nname: ${JSON.stringify(name)}\ndescription: d\nphases: [run]\n*/\nawait agent({ prompt: 'x' });\n`;
  const mk = (dir, files) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
  };
  mk(path.join(ws, '.agents', 'workflows'), {
    // core 发现面以 @pi-meta name 为名单键（与旧 zsw「name 取文件名 stem」不同，
    // 行为差异见 README 回接说明）——fixture meta name 与文件名保持一致
    'alpha.js': script('alpha'),
    'beta.js': script('beta'),
    'bomb.js': 'throw new Error("listWorkflowNames MUST NOT execute scripts");\n',
  });
  mk(path.join(ws, '.zsw', 'workflows'), { 'delta.js': script('delta') }); // zsw workspace 特有根（host 手工扫）
  mk(path.join(ANCHOR_HOME, '.agents', 'workflows'), { 'gamma.js': script('gamma') }); // HOME 侧根（core user-agents）

  const names = await listWorkflowNames(ws);
  for (const expected of ['alpha', 'beta', 'bomb', 'delta', 'gamma']) {
    assert.ok(names.includes(expected), `名单缺 ${expected}: ${JSON.stringify(names)}`);
  }
  // 交叉锚定：name-only 与 host.scripts 的发现面同源
  const host = createOrchestrationHost({ agentRunner: { async run() { return { content: '' }; } } });
  const found = await host.scripts(ws);
  assert.deepEqual(names.sort(), found.scripts.map((s) => s.name).sort(), '与 scripts() 发现面名单一致（交叉锚定）');
});

test('listWorkflowNames：发现根全不存在时空数组', async () => {
  const { listWorkflowNames } = require('../lib/orchestration-host');
  const ws = path.join(TMP, 'ws-empty');
  const emptyHome = path.join(TMP, 'empty-home'); // 避开锚定用例写入 HOME 侧根的 fixture
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(emptyHome, { recursive: true });
  const prev = process.env.HOME;
  process.env.HOME = emptyHome; // 发现根运行时读 $HOME（os.homedir 不缓存）
  try {
    const { invalidateCache } = require('../lib/core-ref').requireCore();
    invalidateCache(); // 清 discover 缓存，防上一用例 fixture 残留命中
    assert.deepEqual(await listWorkflowNames(ws), []);
  } finally {
    process.env.HOME = prev;
  }
});
