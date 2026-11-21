'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const patch = require('../patches/provider-sem');

// 按 zcode.cjs 真实形态(verifier-slices.txt:34)构造最小合成文件。
// 体内局部变量名避开形参名(真实形态:形参 e、体内 t;合成里参数化形参,
// 体内用 __ 前缀变量防冲突)。
function synth({ fnName = 'Kyt', param = 'e' } = {}) {
  return (
    '"use strict";' +
    `async function ${fnName}(${param}){if(${param}.admission===void 0)return nba;let __tv=typeof ${param}.admission.tryAcquire=="function",n=__tv?${param}.admission.tryAcquire({model:${param}.model}):void 0;if(n===void 0){n=await ${param}.admission.acquire({model:${param}.model})}let o=!1;return{ticket:n,release(){o||(o=!0,n.release())}}}` +
    `var nba,Zyt=(()=>{"use strict";nba={release(){}};r(wwo,"readAdmissionRetryCooldownMs");r(${fnName},"admitAttempt")});` +
    'async function other(x){if(x.admission===void 0)return null;return 1}'
  );
}

test('transform 注入:trampoline 出现在函数体首句前,形参名替换正确', () => {
  const src = synth();
  const { content, note } = patch.transform(src, 'zcode.cjs');
  assert.equal(note, 'patched');
  const expected =
    'async function Kyt(e){try{var __z=globalThis.__ZSEM__??(globalThis.__ZSEM__=require(require("os").homedir()+"/.zcode/cli/zsem/entry.js"));var __w=await __z.admit(e);if(__w)return __w}catch(__e){if(__e&&__e.__zsemCancel)throw __e}if(e.admission===void 0)';
  assert.ok(content.includes(expected), '注入行应精确出现在函数体开头');
  // 语法有效(注入后全文可被 async 包裹 parse)
  new Function('return (async()=>{' + content + '})');
});

test('transform 容忍 minified 名漂移(函数名/形参名变化)', () => {
  const src = synth({ fnName: 'Xq9', param: 't' });
  const { content, note } = patch.transform(src, 'zcode.cjs');
  assert.equal(note, 'patched');
  assert.ok(content.includes('await __z.admit(t);'), '形参名 t 应被替换进注入行');
  new Function('return (async()=>{' + content + '})');
});

test('isApplied:注入后识别 already-applied,重复 transform 跳过', () => {
  const once = patch.transform(synth(), 'zcode.cjs').content;
  assert.equal(patch.isApplied(once), true);
  assert.equal(patch.isApplied(synth()), false);
  const again = patch.transform(once, 'zcode.cjs');
  assert.equal(again.note, 'already-applied');
  assert.equal(again.content, once);
});

test('锚点异常:admitAttempt 标注缺失/多处 → 可操作错误', () => {
  assert.throws(() => patch.transform('const a=1', 'zcode.cjs'), /admitAttempt.*命中 0 处/);
  const two = synth() + synth({ fnName: 'Kt2' });
  assert.throws(() => patch.transform(two, 'zcode.cjs'), /命中 2 处/);
});

test('结构校验:函数名命中但函数体首句形态变化 → 可操作错误', () => {
  const broken = synth().replace('if(e.admission===void 0)return nba;', 'let q=1;');
  assert.throws(() => patch.transform(broken, 'zcode.cjs'), /未能按结构定位/);
});
