'use strict';

/**
 * lib/workflow-script 测试：四根发现与优先级、脚本契约（返回形态/抛错）、
 * ctx.runAgent 经 runPhase 的真链路（fake CLI）、signal 透传、lint 三档、
 * require cache fresh。
 *
 * 隔离原则（同 test/workflow-base.test.js）：禁止真跑 zcode.cjs、禁止碰真实
 * ~/.zcode 与真实 ~/.agents。ZSW_ROOT / ZCODE_MAILBOX_ROOT / HOME 指到临时
 * 目录后再 require lib；ZSW_ZCODE_CLI 指 fake CLI。HOME 侧两根
 * （~/.agents/workflows、~/.zsw/workflows）因 os.homedir() 读 $HOME 而被
 * 一并隔离。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-wfscript-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsw-root');
process.env.ZCODE_MAILBOX_ROOT = path.join(TMP, 'mailbox');
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

// ---- fake zcode CLI：单行 JSON 无头单轮（echo prompt 前缀） ----
const FAKE_CLI = path.join(TMP, 'fake-zcode.cjs');
fs.writeFileSync(FAKE_CLI, `'use strict';
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const prompt = flag('--prompt');
console.log(JSON.stringify({
  sessionId: 'sess_fake_' + Math.random().toString(36).slice(2, 10),
  response: 'echo:' + String(prompt).slice(0, 20),
  usage: { input_tokens: 1, output_tokens: 1 },
}));
`);
process.env.ZSW_ZCODE_CLI = FAKE_CLI;

// env 隔离完成后才允许 require lib（见文件头注释）
const config = require('../lib/config');
const wfScript = require('../lib/workflow-script');

const WS = path.join(TMP, 'ws'); // workspace 侧两根的定位根
fs.mkdirSync(WS, { recursive: true });

const WS_AGENTS = path.join(WS, '.agents', 'workflows');
const WS_ZSUB = path.join(WS, '.zsw', 'workflows');
const USER_AGENTS = path.join(process.env.HOME, '.agents', 'workflows');
const USER_ZSUB = path.join(process.env.HOME, '.zsw', 'workflows');

/** 写一个合法脚本（默认只返回纯文本报告）。 */
function writeScript(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.js`);
  fs.writeFileSync(file, body);
  return file;
}

/** 标准 {name, description, run} 骨架，runBody 是返回表达式。 */
function stdScript(description, runExpr) {
  return `'use strict';\nmodule.exports = {\n`
    + `  name: 'x', description: ${JSON.stringify(description)},\n`
    + `  run: async (ctx) => (${runExpr}),\n`
    + `};\n`;
}

/** 写入测试用 v2 config（ModelRouter 数据源，含两个可用模型）。 */
function writeV2Config() {
  const base = {
    model: { main: 'builtin:bigmodel-coding-plan/GLM-5.3' },
    provider: {
      'builtin:bigmodel-coding-plan': {
        options: { apiKey: 'test-key' },
        models: { 'GLM-5.3': {}, 'GLM-4.7-Flash': {} },
      },
    },
  };
  fs.mkdirSync(path.dirname(config.V2_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(config.V2_CONFIG_PATH, JSON.stringify(base, null, 2));
}

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// ------------------------------------------------------------ 四根发现

test('listScripts：四根优先级 + 同名高优先级胜出 + 只扫顶层 .js', () => {
  // 同名四根全放：workspace-agents 必须胜出
  writeScript(WS_AGENTS, 'dup', stdScript('来自 ws-agents', "'a'"));
  writeScript(WS_ZSUB, 'dup', stdScript('来自 ws-zsw', "'a'"));
  writeScript(USER_AGENTS, 'dup', stdScript('来自 user-agents', "'a'"));
  writeScript(USER_ZSUB, 'dup', stdScript('来自 user-zsw', "'a'"));
  // user 侧两级同名：user-agents 胜 user-zsw
  writeScript(USER_AGENTS, 'shadowed', stdScript('来自 user-agents', "'a'"));
  writeScript(USER_ZSUB, 'shadowed', stdScript('来自 user-zsw', "'a'"));
  // 仅低优先级根存在：照常发现
  writeScript(USER_ZSUB, 'only-user', stdScript('仅 user-zsw', "'a'"));
  // 非 .js 不入列；子目录不递归
  fs.writeFileSync(path.join(WS_AGENTS, 'readme.txt'), 'x');
  writeScript(path.join(WS_AGENTS, 'subdir'), 'nested', stdScript('子目录脚本', "'a'"));

  const list = wfScript.listScripts(WS);
  const names = list.map((s) => s.name);
  assert.ok(names.includes('dup'));
  assert.ok(names.includes('shadowed'));
  assert.ok(names.includes('only-user'));
  assert.ok(!names.includes('nested'), '子目录脚本不递归发现');

  const dup = list.find((s) => s.name === 'dup');
  assert.equal(dup.source, 'workspace-agents');
  assert.equal(dup.file, path.join(WS_AGENTS, 'dup.js'));
  assert.equal(dup.description, '来自 ws-agents');

  const sh = list.find((s) => s.name === 'shadowed');
  assert.equal(sh.source, 'user-agents');
  const only = list.find((s) => s.name === 'only-user');
  assert.equal(only.source, 'user-zsw');

  // 缺 cwd 报可操作错误
  assert.throws(() => wfScript.listScripts(''), /listScripts 需要 cwd/);
});

test('findScript：命中返回描述符；非法名/不存在/缺 cwd 返回 null', () => {
  writeScript(WS_ZSUB, 'findme', stdScript('可发现', "'a'"));
  const hit = wfScript.findScript('findme', WS);
  assert.equal(hit.name, 'findme');
  assert.equal(hit.file, path.join(WS_ZSUB, 'findme.js'));
  assert.equal(hit.description, '可发现');
  assert.equal(wfScript.findScript('nope-not-exist', WS), null);
  assert.equal(wfScript.findScript('../escape', WS), null); // 路径穿越形态直接拒绝
  assert.equal(wfScript.findScript('ok', ''), null);
});

test('listScripts：脚本顶层抛错/缺 description 降级为可诊断文案，不炸列表', () => {
  writeScript(WS_ZSUB, 'broken', `'use strict';\nthrow new Error('boom-top');\n`);
  writeScript(WS_ZSUB, 'nodesc', `'use strict';\nmodule.exports = { name: 'nodesc', run: async () => '' };\n`);
  const list = wfScript.listScripts(WS);
  const broken = list.find((s) => s.name === 'broken');
  assert.match(broken.description, /加载失败: boom-top/);
  assert.equal(list.find((s) => s.name === 'nodesc').description, '(未提供 description)');
});

// ------------------------------------------------------------ 脚本契约

test('runScript：{markdown, json} 返回原样透传；ctx.log/ctx.params 可用', async () => {
  const file = writeScript(WS_ZSUB, 'objret', `'use strict';
module.exports = {
  name: 'objret', description: '对象返回',
  run: async (ctx) => {
    ctx.log('进度一');
    return { markdown: 'MD 正文 + ' + ctx.task, json: { paramsEcho: ctx.params.foo, okFlag: true } };
  },
};`);
  const logs = [];
  const out = await wfScript.runScript({
    file, ctx: { task: 'T1', cwd: WS, params: { foo: 42 }, log: (t) => logs.push(t) },
  });
  assert.equal(out.name, 'objret');
  assert.equal(out.markdown, 'MD 正文 + T1');
  assert.deepEqual(out.json, { paramsEcho: 42, okFlag: true });
  assert.deepEqual(logs, ['进度一']);
});

test('runScript：字符串返回当 markdown（json undefined）', async () => {
  writeScript(WS_ZSUB, 'strret', stdScript('字符串', "'纯文本报告'"));
  const out = await wfScript.runScript({ name: 'strret', ctx: { cwd: WS } });
  assert.equal(out.markdown, '纯文本报告');
  assert.equal(out.json, undefined);
});

test('runScript：抛错 → 可操作错误（含脚本名与文件路径）', async () => {
  const file = writeScript(WS_ZSUB, 'boom', `'use strict';
module.exports = { name: 'boom', description: 'd', run: async () => { throw new Error('脚本内部错误'); } };`);
  await assert.rejects(
    () => wfScript.runScript({ name: 'boom', ctx: { cwd: WS } }),
    (e) => /脚本 "boom" 执行失败: 脚本内部错误/.test(e.message) && e.message.includes(file),
  );
});

test('runScript：形状错（run 非 function / 返回值不合规）→ 可操作错误', async () => {
  writeScript(WS_ZSUB, 'norun', `'use strict';\nmodule.exports = { name: 'norun', description: 'd' };`);
  await assert.rejects(() => wfScript.runScript({ name: 'norun', ctx: { cwd: WS } }), /缺少 run 函数/);

  writeScript(WS_ZSUB, 'badret', `'use strict';
module.exports = { name: 'badret', description: 'd', run: async () => 42 };`);
  await assert.rejects(() => wfScript.runScript({ name: 'badret', ctx: { cwd: WS } }), /返回值不合规/);

  writeScript(WS_ZSUB, 'badjson', `'use strict';
module.exports = { name: 'badjson', description: 'd', run: async () => ({ markdown: 'm', json: 'not-object' }) };`);
  await assert.rejects(() => wfScript.runScript({ name: 'badjson', ctx: { cwd: WS } }), /json 必须是对象/);
});

test('runScript：未知脚本名 → 列出当前可用清单；缺 cwd 拒绝', async () => {
  await assert.rejects(
    () => wfScript.runScript({ name: 'ghost', ctx: { cwd: WS } }),
    (e) => /未找到 workflow 脚本 "ghost"/.test(e.message) && /当前可用/.test(e.message),
  );
  await assert.rejects(
    () => wfScript.runScript({ name: 'ghost' }),
    /需要 ctx.cwd|未找到/,
  );
});

// --------------------------------------------------------- runAgent 链路

test('runScript：ctx.runAgent 真调 runPhase（fake CLI）——模型解析与结果形态', async () => {
  writeV2Config();
  writeScript(WS_ZSUB, 'agent', `'use strict';
module.exports = {
  name: 'agent', description: '调 agent',
  run: async (ctx) => {
    const r = await ctx.runAgent({ prompt: '帮我分析这个模块的结构' });
    const override = await ctx.runAgent({ prompt: '短任务', model: 'GLM-5.3' });
    return {
      markdown: 'ok=' + r.ok + ' resp=' + r.response + ' overrideOk=' + override.ok,
      json: { sid: r.sessionId, timedOut: r.timedOut, exitCode: r.exitCode },
    };
  },
};`);
  const out = await wfScript.runScript({ name: 'agent', ctx: { cwd: WS, model: 'GLM-4.7-Flash' } });
  assert.ok(out.markdown.includes('ok=true'));
  assert.ok(out.markdown.includes('resp=echo:'));          // fake CLI 回显 prompt 前缀
  assert.ok(out.markdown.includes('overrideOk=true'));     // per-call model 覆盖同过解析链
  assert.ok(out.json.sid.startsWith('sess_fake_'));
  assert.equal(out.json.timedOut, false);
  assert.equal(out.json.exitCode, 0);
});

test('runScript：signal 透传到 runAgent——预置 aborted 零 spawn、aborted 条目', async () => {
  writeV2Config();
  writeScript(WS_ZSUB, 'sigpass', `'use strict';
module.exports = {
  name: 'sigpass', description: 'signal 透传',
  run: async (ctx) => {
    const r = await ctx.runAgent({ prompt: '不该被启动的阶段' });
    return 'aborted=' + r.aborted + ' err=' + r.error + ' sid=' + r.sessionId;
  },
};`);
  const controller = new AbortController();
  controller.abort();
  const out = await wfScript.runScript({ name: 'sigpass', ctx: { cwd: WS, signal: controller.signal } });
  assert.ok(out.markdown.includes('aborted=true'));
  assert.ok(out.markdown.includes('err=aborted'));
  assert.ok(out.markdown.includes('sid=null')); // 契约 1：零 spawn
});

test('runScript：runAgent 缺 prompt → 可操作错误（不落到 driver）', async () => {
  writeScript(WS_ZSUB, 'noprompt', `'use strict';
module.exports = {
  name: 'noprompt', description: 'd',
  run: async (ctx) => {
    try { await ctx.runAgent({}); return '不应到达'; } catch (e) { return 'caught:' + e.message.slice(0, 12); }
  },
};`);
  const out = await wfScript.runScript({ name: 'noprompt', ctx: { cwd: WS } });
  assert.ok(out.markdown.startsWith('caught:runAgent 需要'));
});

// ------------------------------------------------------------------ lint

test('lintScript 三档：语法错 / 形状错 / 通过（+ 文件不存在）', async () => {
  // ① 语法错：node --check 失败（只报语法，不重复报 require 失败）
  const syn = writeScript(WS_ZSUB, 'syntax-bad', `'use strict';\nconst x = {\n`);
  const l1 = await wfScript.lintScript(syn);
  assert.equal(l1.ok, false);
  assert.equal(l1.errors.length, 1);
  assert.match(l1.errors[0], /语法检查失败（node --check）/);

  // ② 形状错：语法通过但 name/description/run 不合规，逐项报出
  const shape = writeScript(WS_ZSUB, 'shape-bad', `'use strict';\nmodule.exports = { name: '', description: 42, run: 'no' };\n`);
  const l2 = await wfScript.lintScript(shape);
  assert.equal(l2.ok, false);
  assert.ok(l2.errors.some((e) => /name 必须是非空 string/.test(e)));
  assert.ok(l2.errors.some((e) => /description 必须是非空 string/.test(e)));
  assert.ok(l2.errors.some((e) => /run 必须是 function/.test(e)));

  // ③ 通过
  const good = writeScript(WS_ZSUB, 'lint-good', stdScript('合法脚本', "'ok'"));
  const l3 = await wfScript.lintScript(good);
  assert.equal(l3.ok, true);
  assert.deepEqual(l3.errors, []);

  // 文件不存在
  const l4 = await wfScript.lintScript(path.join(WS_ZSUB, 'nope.js'));
  assert.equal(l4.ok, false);
  assert.match(l4.errors[0], /不存在/);
});

test('lintScript：模块顶层抛错归入形状档（require 失败）', async () => {
  const file = writeScript(WS_ZSUB, 'lint-throw', `'use strict';\nthrow new Error('lint-top');\n`);
  const r = await wfScript.lintScript(file);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /require 失败（模块顶层代码抛错）: lint-top/);
});

// -------------------------------------------------------- require cache

test('require cache fresh：同一脚本多次执行，顶层代码每次重跑（无热更新残留）', async () => {
  const counterFile = path.join(TMP, 'counter.txt');
  // 注意用 file 直连而非 name：按名执行时 findScript 的 loadDescription 也
  // 会 fresh require（发现即执行顶层），会把计数抬高；file 直连每次
  // runScript 恰好一次 require，计数精确等于执行次数
  const file = writeScript(WS_ZSUB, 'counter', `'use strict';
const fs = require('node:fs');
let n = 0;
try { n = Number(fs.readFileSync(${JSON.stringify(counterFile)}, 'utf8')) || 0; } catch (e) {}
fs.writeFileSync(${JSON.stringify(counterFile)}, String(n + 1));
module.exports = { name: 'counter', description: '计数', run: async () => '第 ' + (n + 1) + ' 次加载' };
`);
  const o1 = await wfScript.runScript({ file, ctx: { cwd: WS } });
  const o2 = await wfScript.runScript({ file, ctx: { cwd: WS } });
  assert.equal(o1.markdown, '第 1 次加载');
  assert.equal(o2.markdown, '第 2 次加载'); // 非 fresh 的话这里仍是「第 1 次」
  assert.equal(fs.readFileSync(counterFile, 'utf8'), '2');
});

test('runScript：file 直连 + script 描述符两种入口形态', async () => {
  const file = writeScript(WS_ZSUB, 'byfile', stdScript('file 直连', "'via-file'"));
  const o1 = await wfScript.runScript({ file, ctx: { cwd: WS } });
  assert.equal(o1.markdown, 'via-file');
  assert.equal(o1.name, 'byfile');

  const desc = wfScript.findScript('byfile', WS);
  const o2 = await wfScript.runScript({ script: desc, ctx: { cwd: '/anywhere' } });
  assert.equal(o2.markdown, 'via-file'); // 描述符形态跳过发现，cwd 不再约束
});
