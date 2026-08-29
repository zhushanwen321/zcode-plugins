'use strict';

/**
 * 自定义 workflow 脚本：发现（listScripts/findScript）、执行（runScript）、
 * 校验（lintScript）。内置 5 种 workflow（chain/parallel/...）之外的编排由
 * 用户脚本扩展，入口形态 `workflow: "script:<name>"`（WorkflowManager 分发）。
 *
 * ## 脚本契约（skill 层文档由后续 agent 展开，此处是权威定义）
 *
 *   module.exports = {
 *     name: 'my-wf',              // 脚本名，建议与文件名一致（lint 校验非空）
 *     description: '一句话说明',   // listScripts 展示用（lint 校验非空）
 *     run: async (ctx) => ({ markdown: '报告正文', json: {...} }),
 *   };
 *
 *   // ctx = { task, cwd, model, signal, timeoutMs,
 *   //         runAgent: async ({prompt, cwd?, model?, timeoutMs?}) =>
 *   //              {ok, sessionId, response, usage, exitCode, timedOut, error?, aborted?, stderrTail},
 *   //         log: (text) => void,   // 进度留痕（manager 侧收集，status() 可查）
 *   //         params: object }       // start 透传的 per-workflow 参数
 *   //
 *   // 返回 {markdown, json} 或字符串（当 markdown）；抛错 = workflow failed。
 *   // markdown 是人读报告正文；json 是机器数据（可选，报告落盘时以 ```json
 *   // 围栏附加，形态对齐内置 workflow 的 report.buildContentBlocks 双段）。
 *
 * ## 发现（四根，同构 agent .md 惯例；同名高优先级胜出）
 *
 *   <ws>/.agents/workflows/  >  <ws>/.zsw/workflows/
 *   >  ~/.agents/workflows/  >  ~/.zsw/workflows/
 *
 *   只扫各根顶层 *.js（不递归）。ws 侧根由调用方传入的 cwd 决定。
 *
 * ## require 语义（重要：脚本在 server 进程内执行，与 zcode 阶段子进程不同）
 *
 * - fresh require：每次执行前 delete require.cache[入口文件]，防止热更新
 *   残留（脚本文件改动后必须重新加载）；仅入口模块 fresh，入口自己 require
 *   的依赖走 Node 默认缓存——完全隔离依赖树的代价高于收益（脚本通常无
 *   本地依赖）。
 * - 副作用隔离边界：脚本的顶层代码与 run() 都在本进程跑，无进程级隔离。
 *   契约层面要求脚本不维护跨 run 的可变全局态；信任模型与「用户主动放进
 *   四根目录的代码」一致（见 lintScript 头注的同类权衡）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const ModelRouter = require('./model-router');
const { runPhase } = require('./workflow/run-phase');

// resolve() 无解析状态；模块级单例保持与 run-phase.js 相同的实例化习惯
const modelRouter = new ModelRouter();

/** 脚本名合法集：字母数字开头，可含 . _ -。同时是路径穿越防线（不含分隔符与 ..）。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** lint 的 node --check 子进程超时：正常语法检查毫秒级，10s 只防子进程挂死。 */
const LINT_CHECK_TIMEOUT_MS = 10_000;

/** 四根优先级文案（错误信息复用，与 scriptRoots 保持同一顺序）。 */
const ROOTS_DESC = '<ws>/.agents/workflows > <ws>/.zsw/workflows > ~/.agents/workflows > ~/.zsw/workflows';

/**
 * 四根根目录（按优先级序）。
 * HOME 侧用 os.homedir()：POSIX 上优先读 $HOME（Node 语义），测试改 HOME 即可隔离。
 */
function scriptRoots(cwd) {
  return [
    { base: path.join(cwd, '.agents', 'workflows'), source: 'workspace-agents' },
    { base: path.join(cwd, '.zsw', 'workflows'), source: 'workspace-zsw' },
    { base: path.join(os.homedir(), '.agents', 'workflows'), source: 'user-agents' },
    { base: path.join(os.homedir(), '.zsw', 'workflows'), source: 'user-zsw' },
  ];
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** fresh require：先删 cache 再加载（热更新语义，见模块头注）。 */
function freshRequire(file) {
  const resolved = require.resolve(file);
  delete require.cache[resolved];
  return require(resolved);
}

/**
 * 读取脚本 description（listScripts/findScript 用）。
 * 权衡：取 description 必须执行模块顶层代码（真 require）——与 lintScript
 * 同一决策：脚本本来就是用户信任代码，静态解析 module.exports（正则/AST）
 * 对 CJS 的动态导出不可靠。加载失败不炸 list，降级为可诊断文案。
 */
function loadDescription(file) {
  try {
    const mod = freshRequire(file);
    if (mod && typeof mod.description === 'string' && mod.description.trim() !== '') {
      return mod.description;
    }
    return '(未提供 description)';
  } catch (e) {
    return `(加载失败: ${String(e && e.message || e).slice(0, 120)})`;
  }
}

/**
 * 列出全部可用脚本（四根合并，同名高优先级胜出，按名排序保证输出稳定）。
 * @param {string} cwd workspace 根（ws 两根的定位基准）
 * @returns {{name:string, description:string, file:string, source:string}[]}
 */
function listScripts(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error(`listScripts 需要 cwd（workspace 根，用于定位 ${ROOTS_DESC} 中的 ws 侧两根）。`);
  }
  const byName = new Map();
  for (const root of scriptRoots(cwd)) {
    let entries;
    try {
      entries = fs.readdirSync(root.base, { withFileTypes: true });
    } catch {
      continue; // 根不存在/不可读 = 该根无脚本，不是错误
    }
    for (const e of entries) {
      // 不递归：withFileTypes 只看顶层，子目录条目直接跳过
      if (!e.isFile() || !e.name.endsWith('.js')) continue;
      const name = e.name.slice(0, -3);
      if (byName.has(name)) continue; // 高优先级根先扫，同名先到先得
      const file = path.join(root.base, e.name);
      byName.set(name, { name, description: loadDescription(file), file, source: root.source });
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 列出全部脚本名（name-only 版 listScripts）。
 *
 * 仅 readdir 四根收集顶层 *.js 的文件名去扩展名——与 listScripts 的 name
 * 来源完全一致（listScripts 的 name 取 `e.name.slice(0, -3)`，来自文件名而
 * 非模块导出的 name 字段），故结果是 listScripts 名单的安全子集。
 * 同名高优先级根胜出 = Set 去重（与 listScripts 先到先得同语义），按名排序
 * 与 listScripts 同序。绝不 require 脚本、不读文件内容：listScripts 会
 * freshRequire 每个脚本读 description（触发脚本体顶层副作用），只需名单的
 * 场景（如注入块、只读诊断）应走本函数。
 *
 * @param {string} cwd workspace 根（ws 两根的定位基准）
 * @returns {string[]} 按名排序
 */
function listScriptNames(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error(`listScriptNames 需要 cwd（workspace 根，用于定位 ${ROOTS_DESC} 中的 ws 侧两根）。`);
  }
  const names = new Set();
  for (const root of scriptRoots(cwd)) {
    let entries;
    try {
      entries = fs.readdirSync(root.base, { withFileTypes: true });
    } catch {
      continue; // 根不存在/不可读 = 该根无脚本，不是错误
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.js')) continue;
      names.add(e.name.slice(0, -3));
    }
  }
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 按名查单个脚本（四根优先级）。
 * @returns {{name, description, file, source} | null} 名字非法或不存在返回 null
 */
function findScript(name, cwd) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  for (const root of scriptRoots(cwd)) {
    const file = path.join(root.base, `${name}.js`);
    if (isFile(file)) {
      return { name, description: loadDescription(file), file, source: root.source };
    }
  }
  return null;
}

/**
 * ctx.runAgent 封装：脚本的每次 agent 调用 = 一个 zcode 无头阶段，内部走
 * lib/workflow/run-phase 的 runPhase——与内置 workflow 阶段同一执行落点
 * （AbortSignal 契约、SIGTERM→SIGKILL 超时链、结果形态完全一致）。
 * model 解析链：per-call model > 脚本级 ctx.model > ModelRouter 默认。
 * signal 透传：脚本级 signal 原样传给每个阶段（预置中止 → 零 spawn）。
 */
async function runAgent({ prompt, cwd, model, timeoutMs } = {}, baseCtx) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error(
      'runAgent 需要 prompt（非空字符串，该次 agent 调用的自包含任务描述）。'
      + '恢复指引：脚本内把目标/背景/验收拼进 prompt 后再调用 ctx.runAgent。'
    );
  }
  const modelRef = modelRouter.resolve(model !== undefined ? model : baseCtx.model);
  return runPhase({
    prompt,
    cwd: cwd || baseCtx.cwd, // 双缺省时 runPhase 侧落到进程 cwd（driver 语义）
    modelRef,
    timeoutMs,
    signal: baseCtx.signal,
  });
}

/**
 * 执行一个脚本（发现 → fresh require → 形状校验 → run(ctx) → 返回归一化）。
 *
 * @param {object} opts
 * @param {string} [opts.name]   按名发现（发现根 = ctx.cwd 的四根）
 * @param {string} [opts.file]   直接给脚本文件路径（优先于 name）
 * @param {object} [opts.script] 已解析的脚本描述符（findScript/listScripts 产物，
 *                               优先于 name/file。WorkflowManager 走此路：它需要
 *                               把「发现根 = workspace cwd」与「运行 cwd = workdir」
 *                               解耦，两个语义在直接调用方（CLI/测试）身上恰好同值）
 * @param {object} [opts.ctx]    {task, cwd, model, signal, timeoutMs, params?, log?}
 * @returns {Promise<{name:string, description:string, markdown:string, json?:object}>}
 * @throws 脚本不存在/形状不合规/run 抛错/返回值不合规——均为可操作错误
 */
async function runScript({ name, file, script, ctx = {} }) {
  let target;
  if (script && typeof script.file === 'string') {
    target = { name: script.name || path.basename(script.file, '.js'), file: script.file };
  } else if (typeof file === 'string' && file.trim() !== '') {
    target = { name: path.basename(file, '.js'), file: path.resolve(file) };
  } else {
    if (typeof ctx.cwd !== 'string' || ctx.cwd.trim() === '') {
      throw new Error(
        'runScript 需要 ctx.cwd（脚本发现的 workspace 根）或直接传 file/script。'
        + `恢复指引：按名执行必须给 cwd（四根发现 ${ROOTS_DESC}）。`
      );
    }
    const found = findScript(name, ctx.cwd);
    if (!found) {
      const avail = listScripts(ctx.cwd).map((s) => s.name).join(', ') || '（无）';
      throw new Error(
        `未找到 workflow 脚本 "${String(name)}"（四根发现：${ROOTS_DESC}）。当前可用: ${avail}。`
        + '恢复指引：检查脚本名拼写（字母数字开头，可含 . _ -），或先创建脚本后重试（lintScript 校验）。'
      );
    }
    target = found;
  }
  if (!isFile(target.file)) {
    throw new Error(`脚本文件不存在或不是文件: ${target.file}。恢复指引：确认路径；发现可用脚本用 listScripts(cwd)。`);
  }

  const mod = freshRequire(target.file);
  if (!mod || typeof mod !== 'object' || Array.isArray(mod)) {
    throw new Error(
      `脚本 "${target.name}" 的 module.exports 必须是对象（实际 ${Array.isArray(mod) ? 'array' : typeof mod}）。`
      + `恢复指引：按 lib/workflow-script.js 头注的脚本契约导出 {name, description, run}。文件: ${target.file}`
    );
  }
  if (typeof mod.run !== 'function') {
    throw new Error(
      `脚本 "${target.name}" 缺少 run 函数（typeof run === '${typeof mod.run}'）。`
      + `恢复指引：module.exports.run = async (ctx) => ({markdown, json})。文件: ${target.file}`
    );
  }

  const fullCtx = {
    task: ctx.task,
    cwd: ctx.cwd,
    model: ctx.model,
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
    params: ctx.params && typeof ctx.params === 'object' ? ctx.params : {},
    log: typeof ctx.log === 'function' ? ctx.log : () => {},
    runAgent: (a) => runAgent(a, ctx),
  };

  let ret;
  try {
    ret = await mod.run(fullCtx);
  } catch (e) {
    throw new Error(`脚本 "${target.name}" 执行失败: ${String(e && e.message || e)}。文件: ${target.file}`);
  }
  const description = typeof mod.description === 'string' ? mod.description : '';
  if (typeof ret === 'string') {
    return { name: target.name, description, markdown: ret };
  }
  if (ret && typeof ret === 'object' && !Array.isArray(ret) && typeof ret.markdown === 'string') {
    if (ret.json !== undefined && ret.json !== null && typeof ret.json !== 'object') {
      throw new Error(
        `脚本 "${target.name}" 返回的 json 必须是对象或 null（实际 ${typeof ret.json}）。文件: ${target.file}`
      );
    }
    return { name: target.name, description, markdown: ret.markdown, json: ret.json };
  }
  throw new Error(
    `脚本 "${target.name}" 的 run() 返回值不合规：需要 {markdown, json?} 或字符串（当 markdown），`
    + `实际 ${ret === null ? 'null' : Array.isArray(ret) ? 'array' : typeof ret}。`
    + '恢复指引：无报告内容的脚本请显式返回 ""，不要返回 undefined。'
  );
}

/**
 * 校验脚本（两档）：
 *   ① node --check 子进程——纯语法解析，不执行脚本；
 *   ② fresh require + 形状校验——name/description 非空 string、run 是 function。
 *
 * 权衡：②会执行模块顶层代码。接受该风险的理由：脚本本来就是用户主动放进
 * 四根目录的信任代码，运行与 lint 是同一信任级；静态解析导出形态（正则/
 * AST）对 CJS 的 module.exports 动态赋值不可靠，「简单可靠」胜过「零副作用
 * 但可能漏判」。同步死循环无法被任何超时机制保护——这与真跑是同一前提。
 *
 * @param {string} file 脚本文件路径
 * @returns {Promise<{ok:boolean, errors:string[]}>} 语法失败时跳过 ②（require
 *   必然同因失败，重复报错只会稀释根因）
 */
async function lintScript(file) {
  const errors = [];
  if (typeof file !== 'string' || file.trim() === '' || !isFile(path.resolve(file))) {
    return { ok: false, errors: [`脚本文件不存在或不是文件: ${file}`] };
  }
  const abs = path.resolve(file);

  // ① 语法层
  const syntaxErr = await new Promise((resolve) => {
    execFile(
      process.execPath, ['--check', abs], { timeout: LINT_CHECK_TIMEOUT_MS },
      (err, _stdout, stderr) => resolve(err ? String(stderr || err.message).trim() : null),
    );
  });
  if (syntaxErr) errors.push(`语法检查失败（node --check）: ${syntaxErr}`);

  // ② 形状层（仅语法通过时；见头注的执行顶层代码权衡）
  if (!syntaxErr) {
    try {
      const mod = freshRequire(abs);
      if (!mod || typeof mod !== 'object' || Array.isArray(mod)) {
        errors.push(`module.exports 必须是对象（实际 ${Array.isArray(mod) ? 'array' : typeof mod}）`);
      } else {
        if (typeof mod.name !== 'string' || mod.name.trim() === '') errors.push('name 必须是非空 string');
        if (typeof mod.description !== 'string' || mod.description.trim() === '') errors.push('description 必须是非空 string');
        if (typeof mod.run !== 'function') errors.push(`run 必须是 function（实际 ${typeof mod.run}）`);
      }
    } catch (e) {
      errors.push(`require 失败（模块顶层代码抛错）: ${String(e && e.message || e)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { listScripts, listScriptNames, findScript, runScript, lintScript, scriptRoots, NAME_RE };
