'use strict';

/**
 * provider-sem 补丁:在 zcode.cjs 的 LLM 请求准入唯一收口(admitAttempt)函数体
 * 开头注入一行 trampoline(转发到外部 zsem 模块,见 zsem/entry.js)。
 *
 * 设计约束(design.md G3):注入行不含任何策略——分桶/上限/排队/取消/日志全部
 * 在本仓 zsem/ 模块;zsem 缺位或异常时注入行自身 fail-open(异常吞掉走原生),
 * 仅「取消」错误(挂 __zsemCancel 标记)rethrow 保持原生 cancelled 语义
 * (fact-check.md A13/A15)。
 *
 * 锚点策略(升级稳定性):
 * 1. `r(<fn>,"admitAttempt")` 函数名标注提取当前版本的 minified 函数名(名字随
 *    版本漂移,标注字符串是 bundler 稳定产物);
 * 2. `function <fn>(<p1>…){` 定位定义,行内结构校验「admission===void 0 return」
 *    防误锚;
 * 3. 注入行内的形参名动态替换(<p1> 当前版本为 e);
 * 4. already-applied 检测 = 文件含 __ZSEM__ 标记。
 */

const ZSEM_REQUIRE = 'require(require("os").homedir()+"/.zcode/cli/zsem/entry.js")';
const INJECT_TEMPLATE =
  'try{var __z=globalThis.__ZSEM__??(globalThis.__ZSEM__=' +
  ZSEM_REQUIRE +
  ');var __w=await __z.admit(<P1>);if(__w)return __w}catch(__e){if(__e&&__e.__zsemCancel)throw __e}';

const TARGET = { looseFile: 'glm/zcode.cjs' };
// 函数名标注:`r(Kyt,"admitAttempt")` 形态(带可选空格容忍)
const NAME_ANCHOR_RE = /r\((\w+),"admitAttempt"\)/g;
// 函数定义 + 形参 + 行内结构校验(admission===void 0 return 是该函数体首句)
function definitionRegex(fnName) {
  return new RegExp(
    'function ' + fnName + '\\((\\w+)(?:,\\w+)*\\)\\{(if\\(\\1\\.admission===void 0\\)return)',
  );
}

function isApplied(content) {
  // 强标记:注入模板的完整特征前缀(惰性单例装配语句),裸串 `globalThis.__ZSEM__`
  // 在文件他处自然出现(注释/字符串字面量)不得误判为已应用——误判会导致静默
  // 跳过注入且升级后拒绝重采纳基线(修剪 ATK-B2)
  return content.includes('var __z=globalThis.__ZSEM__??(globalThis.__ZSEM__=require(');
}

function transform(content, filePath) {
  if (isApplied(content)) return { content, note: 'already-applied' };

  const names = content.match(NAME_ANCHOR_RE);
  if (!names || names.length !== 1) {
    throw new Error(
      `provider-sem 锚点(函数名标注 admitAttempt)在 ${filePath} 命中 ${names ? names.length : 0} 处(要求恰好 1 处)。` +
        '常见原因:ZCode 升级后该标注形态变了。恢复动作:重新逆向定位 LLM 请求准入函数(admitAttempt)并更新本补丁的锚点正则。',
    );
  }
  const fnName = names[0].match(/^r\((\w+),/)[1];
  const defMatch = content.match(definitionRegex(fnName));
  if (!defMatch) {
    throw new Error(
      `provider-sem 未能按结构定位 ${fnName} 的函数定义(${filePath})。` +
        '常见原因:ZCode 升级后准入函数的形参或函数体首句变了。恢复动作:对照新版本 zcode.cjs 更新 definitionRegex 的结构校验。',
    );
  }
  const param1 = defMatch[1];
  const inject = INJECT_TEMPLATE.replaceAll('<P1>', param1);
  const injectAt = defMatch.index + defMatch[0].length - defMatch[2].length; // 插在 `{ 之后、首句(if 段)之前
  const next = content.slice(0, injectAt) + inject + content.slice(injectAt);

  // 语法自检:注入后全文做编译级校验(new Function 只编译不执行)。
  // 注入行含 await,须以 async 函数体环境 parse——把全文包进 async 函数体;
  // shebang 只在文件首行合法,包裹前剥掉。
  try {
    const body = next.replace(/^#![^\n]*\n/, '\n');
    // eslint-disable-next-line no-new-func
    new Function('return (async()=>{' + body + '})');
  } catch (err) {
    throw new Error(
      `provider-sem 注入后语法自检失败:${err.message}。恢复动作:带 PATCH_DEBUG=1 重跑并报告注入点上下文。`,
    );
  }
  return { content: next, note: 'patched' };
}

module.exports = {
  name: 'provider-sem',
  description: 'LLM 请求准入点注入 zsem trampoline(provider 维度并发上限+排队,核心逻辑在 zsem/ 外部模块)',
  target: TARGET,
  isApplied,
  transform,
};
