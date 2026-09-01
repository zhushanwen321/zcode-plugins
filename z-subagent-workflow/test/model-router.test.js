'use strict';
/**
 * model-router 纯函数单测（V0b：modelEntries 消重为 toModelEntries 单实现；
 * V5e：splitModelRef 收缩为 core splitZcodeModelRef 薄包装 + 凭据裁决统一）。
 *
 * 覆盖统一实现的逐字段产出锚（deepStrictEqual）：label 去空格透出、contextWindow
 * 正数闸、reasoning.variants（含/缺 defaultVariant 两态）、default 标记（defShort
 * 命中/不命中/不传三态）、withProvider 升格（core ModelEntry 形态 provider/id/name）、
 * 空/缺清单 provider 容忍。零 fs：直接消费导出的纯函数。
 *
 * V5e 增补：splitModelRef 含 "/" 分支与 core 原语逐例同输入同输出（等值锚）、
 * 短名归默认 provider 的包装层决策、缺省常量与 core 对齐全等断言（漂移即红）、
 * qualifiedProviders 凭据裁决的非空 string 语义（畸形形态不算凭据）。
 *
 * 执行侧视图（listModels / allProviders 经临时 v2 config 的 fs 面）与 hook 投影
 * （renderResourcesBlock 渲染串）分别在 test/server.test.js / test/hook-inject.test.js
 * 锚定；三面对同一 fixture 产出已在 V0b 消重时做过改造前后逐字节对照。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const modelRouter = require('../lib/model-router');
const { toModelEntries, splitModelRef, qualifiedProviders, PROVIDER_ID } = modelRouter;
const core = require('../lib/core-ref').requireCore();

const V2 = {
  provider: {
    'prov-x': {
      models: {
        full: {
          label: '  重量档  ',
          limit: { context: 200000 },
          reasoning: { variants: ['high', 'low'], defaultVariant: 'high' },
        },
        'no-variant-default': { reasoning: { variants: ['low', 'high'] } },
        'zero-ctx': { limit: { context: 0 } }, // 非正数不透出
        bare: {}, // 裸模型：无任何可选维度
      },
    },
  },
};

test('toModelEntries: 字段提取逐字段锚（label trim/contextWindow 闸/reasoning 两态/裸模型不造默认值）', () => {
  assert.deepEqual(toModelEntries(V2, 'prov-x'), [
    {
      name: 'full',
      label: '重量档',
      contextWindow: 200000,
      reasoning: { variants: ['high', 'low'], defaultVariant: 'high' },
    },
    { name: 'no-variant-default', reasoning: { variants: ['low', 'high'] } },
    { name: 'zero-ctx' },
    { name: 'bare' },
  ]);
});

test('toModelEntries: defShort 命中加 default 标记，不命中/不传（hook 零 fs 形态）无标记', () => {
  const [hit, miss] = toModelEntries(V2, 'prov-x', { defShort: 'full' });
  assert.equal(hit.default, true);
  assert.equal('default' in miss, false, '非命中条目不带 default 字段');

  const [first] = toModelEntries(V2, 'prov-x', { defShort: '不在清单' });
  assert.equal('default' in first, false, 'defShort 不在清单内不误标');

  const [noMark] = toModelEntries(V2, 'prov-x');
  assert.equal('default' in noMark, false, '不传 defShort（hook 侧）恒无标记');
});

test('toModelEntries: withProvider 升格 core ModelEntry 形态（provider/id/name 前置）', () => {
  assert.deepEqual(toModelEntries(V2, 'prov-x', { withProvider: true, defShort: 'bare' }), [
    {
      provider: 'prov-x',
      id: 'full',
      name: 'full',
      label: '重量档',
      contextWindow: 200000,
      reasoning: { variants: ['high', 'low'], defaultVariant: 'high' },
    },
    { provider: 'prov-x', id: 'no-variant-default', name: 'no-variant-default', reasoning: { variants: ['low', 'high'] } },
    { provider: 'prov-x', id: 'zero-ctx', name: 'zero-ctx' },
    { provider: 'prov-x', id: 'bare', name: 'bare', default: true },
  ]);
});

test('toModelEntries: 空/缺清单 provider 容忍（hook 多 provider 迭代跳过语义）', () => {
  assert.deepEqual(toModelEntries({ provider: { 'p-empty': { models: {} } } }, 'p-empty'), []);
  assert.deepEqual(toModelEntries({ provider: { 'p-none': {} } }, 'p-none'), []);
});

// ------------------------------------------------------------ V5e：splitModelRef 薄包装 + 常量对齐

test('splitModelRef: 含 "/" 全名与 core splitZcodeModelRef 逐例同输入同输出（等值锚）', () => {
  // 覆盖标准全名 / provider 含 ":" "." / 多 "/"（lastIndexOf 切）/ 空 provider 段 / 空 model 段
  const refs = [
    'builtin:bigmodel-coding-plan/GLM-5.3',
    'prov-x/model.full',
    'builtin:zai-coding-cn/glm-5.3-flash',
    'router/ns/deep/m',
    '/leading-empty-provider',
    'trailing-empty-model/',
  ];
  for (const ref of refs) {
    const want = core.splitZcodeModelRef(ref);
    assert.deepEqual(
      splitModelRef(ref),
      { provider: want.providerId, short: want.modelId },
      `等值失败: ${ref}`,
    );
  }
});

test('splitModelRef: 短名（无 "/"）归默认 provider——包装层决策，core 原语不做缺省归位', () => {
  assert.deepEqual(splitModelRef('GLM-5.3'), { provider: PROVIDER_ID, short: 'GLM-5.3' });
  assert.deepEqual(splitModelRef('glm-5.3-flash'), { provider: PROVIDER_ID, short: 'glm-5.3-flash' });
  // 对照：core 原语对无 "/" 输入按 lastIndexOf=-1 产出畸形 provider 段（'GLM-5.'），
  // 缺省归位必须留在本包装——这是薄包装唯一保留的自有分支
  const raw = core.splitZcodeModelRef('GLM-5.3');
  assert.notDeepEqual(raw, { providerId: PROVIDER_ID, modelId: 'GLM-5.3' });
});

test('缺省锚与 core 常量对齐（V5e 收口：PROVIDER_ID 消费 core 常量，漂移即红）', () => {
  assert.equal(PROVIDER_ID, core.DEFAULT_PROVIDER_ID);
  // FALLBACK_DEFAULT_MODEL = core.ZCODE_FALLBACK_DEFAULT_MODEL（实现直接消费，
  // 无独立导出）；其 provider 段经 PROVIDER_ID 对齐全等间接受保护
  assert.equal(core.ZCODE_FALLBACK_DEFAULT_MODEL, `${core.DEFAULT_PROVIDER_ID}/GLM-5.3`);
});

test('qualifiedProviders: 凭据裁决统一 core hasApiKey 非空 string 语义（畸形形态不算凭据）', () => {
  const v2 = {
    provider: {
      'p-string-key': { options: { apiKey: 'sk-live' }, models: { m: {} } },
      'p-numeric-key': { options: { apiKey: 123 }, models: { m: {} } }, // 旧 Boolean 版误判，core 裁决淘汰
      'p-empty-key': { options: { apiKey: '' }, models: { m: {} } },
      'p-no-options': { models: { m: {} } },
      'p-null-entry': null, // 外部文件畸形条目：容忍为无凭据，不 throw
    },
  };
  assert.deepEqual(qualifiedProviders(v2), ['p-string-key']);
});
