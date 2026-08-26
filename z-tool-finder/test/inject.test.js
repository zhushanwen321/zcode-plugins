'use strict';
// inject 单测：renderManifest（overrides 优先 / pinned 标注 / 折叠阈值 / 空 catalog）
// + renderHookOutput JSON 逐字段断言 + bin/tf.js hook 子命令冒烟（临时 HOME/数据目录）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const { renderManifest, renderHookOutput, engineServerName, SEARCH_TOOLS_NAME, FOLD_THRESHOLD } = require('../lib/inject.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'ztf-inj-'));
}

function makeCat(serverTools) {
  const servers = {};
  for (const [key, tools] of Object.entries(serverTools)) {
    servers[key] = {
      fetchedAt: '2026-08-26T00:00:00Z',
      tools: tools.map(([name, whenToUse]) => ({ name, whenToUse, description: whenToUse })),
    };
  }
  return { servers };
}

test('renderManifest：overrides 优先于 catalog 的 whenToUse', () => {
  const cat = makeCat({ 'doc': [['xlsx', '来自 description 首句']] });
  const reg = { servers: {}, overrides: { 'doc:xlsx': '处理电子表格任务时使用' } };
  const text = renderManifest({ cat, reg });
  assert.ok(text.includes('doc:xlsx — 处理电子表格任务时使用'));
  assert.ok(!text.includes('来自 description 首句'));
});

test('renderManifest：标签包裹 + 尾部两行指引', () => {
  const cat = makeCat({ 'doc': [['xlsx', '电子表格']] });
  const text = renderManifest({ cat, reg: { servers: {} } });
  assert.ok(text.startsWith('<available-custom-tools>'));
  assert.ok(text.endsWith('</available-custom-tools>'));
  assert.ok(text.includes('get_tool_details'));
  assert.ok(text.includes(SEARCH_TOOLS_NAME));
});

test('engineServerName：注入清单与主 server 的指引命名同源（探针实证形态）', () => {
  assert.strictEqual(engineServerName('doc'), 'doc');
  assert.strictEqual(engineServerName('plugin:z-tool-finder:z-tool-finder'), 'plugin_z-tool-finder_z-tool-finder');
  // FOOTER 指引的 search_tools 全名 = 主 server（插件级源）经 engineServerName 映射的结果
  assert.strictEqual(
    SEARCH_TOOLS_NAME,
    'mcp__' + engineServerName('plugin:z-tool-finder:z-tool-finder') + '__search_tools'
  );
  assert.strictEqual(SEARCH_TOOLS_NAME, 'mcp__plugin_z-tool-finder_z-tool-finder__search_tools');
});

test('renderManifest：pinned 的 server 每行标注未接管', () => {
  const cat = makeCat({ 'a': [['t1', 'x'], ['t2', 'y']] });
  const reg = { servers: { a: { pinned: true } } };
  const text = renderManifest({ cat, reg });
  assert.ok(text.includes('a:t1 — x (pinned, 原生工具直调，未接管)'));
  assert.ok(text.includes('a:t2 — y (pinned, 原生工具直调，未接管)'));
});

test('renderManifest：>300 工具按 server 折叠为一行', () => {
  const many = Array.from({ length: 200 }, (_, i) => ['t' + i, 'w' + i]);
  const cat = makeCat({ 's1': many, 's2': many }); // 400 > 300
  const text = renderManifest({ cat, reg: { servers: {} } });
  assert.ok(text.includes('s1 — 200 tools (search_tools 可查)'));
  assert.ok(text.includes('s2 — 200 tools (search_tools 可查)'));
  assert.ok(!text.includes('s1:t0'), '折叠模式下不逐工具列出');
});

test('renderManifest：catalog 无 server 返回短标签不报错', () => {
  const text = renderManifest({ cat: { servers: {} }, reg: { servers: {} } });
  assert.ok(text.startsWith('<available-custom-tools>'));
  assert.ok(text.includes('catalog 尚未就绪'));
  // 阈值常量与设计一致
  assert.strictEqual(FOLD_THRESHOLD, 300);
});

test('renderHookOutput：JSON 形态逐字段断言', () => {
  const out = renderHookOutput('<available-custom-tools>x</available-custom-tools>');
  const parsed = JSON.parse(out);
  assert.deepStrictEqual(Object.keys(parsed), ['hookSpecificOutput']);
  const h = parsed.hookSpecificOutput;
  assert.deepStrictEqual(Object.keys(h).sort(), ['additionalContext', 'hookEventName']);
  assert.strictEqual(h.hookEventName, 'SessionStart');
  assert.strictEqual(h.additionalContext, '<available-custom-tools>x</available-custom-tools>');
});

/* -------- bin/tf.js hook 子命令冒烟（子进程 + 临时 HOME/ZTF_DATA_DIR） -------- */

function runHook(env, cb) {
  const pluginRoot = path.resolve(__dirname, '..');
  execFile(
    process.execPath,
    [path.join(pluginRoot, 'bin', 'tf.js'), 'hook', 'session-start'],
    // ZSW_NESTED 置空：宿主开发环境常设该标记，泄漏会使 hook 走嵌套空路径
    { env: { ...process.env, ...env, ZSW_NESTED: '' }, timeout: 20000 },
    cb
  );
}

test('hook 冒烟：stdout 是单个 JSON 对象且嵌套结构正确', (t) => {
  t.after(() => {
    fs.rmSync(t.home, { recursive: true, force: true });
    fs.rmSync(t.dataDir, { recursive: true, force: true });
  });
  const home = tmpDir('ztf-hook-home-');
  const dataDir = tmpDir('ztf-hook-data-');
  t.home = home;
  t.dataDir = dataDir;
  // user config 一个 stdio server（命令无效也行——prescan 在后台进程，不影响本进程输出）
  fs.mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.zcode', 'cli', 'config.json'),
    JSON.stringify({ mcp: { servers: { alpha: { type: 'stdio', command: 'node', args: ['nope.js'] } } } })
  );

  runHook({ HOME: home, ZTF_DATA_DIR: dataDir, ZTF_NESTED: '', TF_NESTED: '' }, (err, stdout, stderr) => {
    assert.ifError(err);
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines.length, 1, 'stdout 只有一个 JSON 对象（协议契约）');
    const parsed = JSON.parse(lines[0]);
    assert.deepStrictEqual(Object.keys(parsed), ['hookSpecificOutput']);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('<available-custom-tools>'));
    assert.ok(stderr === '' || true); // 人读输出允许在 stderr
  });
});

test('hook 冒烟：TF_NESTED=1 只输出空对象', (t) => {
  const home = tmpDir('ztf-nested-home-');
  const dataDir = tmpDir('ztf-nested-data-');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  runHook({ HOME: home, ZTF_DATA_DIR: dataDir, TF_NESTED: '1' }, (err, stdout) => {
    assert.ifError(err);
    assert.strictEqual(stdout.trim(), '{}');
  });
});
