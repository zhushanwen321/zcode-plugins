'use strict';
/**
 * model-router 纯函数单测（V0b：modelEntries 消重为 toModelEntries 单实现）。
 *
 * 覆盖统一实现的逐字段产出锚（deepStrictEqual）：label 去空格透出、contextWindow
 * 正数闸、reasoning.variants（含/缺 defaultVariant 两态）、default 标记（defShort
 * 命中/不命中/不传三态）、withProvider 升格（core ModelEntry 形态 provider/id/name）、
 * 空/缺清单 provider 容忍。零 fs：直接消费导出的纯函数。
 *
 * 执行侧视图（listModels / allProviders 经临时 v2 config 的 fs 面）与 hook 投影
 * （renderResourcesBlock 渲染串）分别在 test/server.test.js / test/hook-inject.test.js
 * 锚定；三面对同一 fixture 产出已在 V0b 消重时做过改造前后逐字节对照。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { toModelEntries } = require('../lib/model-router');

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
