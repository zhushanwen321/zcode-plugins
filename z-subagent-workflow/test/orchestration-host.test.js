'use strict';
/**
 * orchestration-host 单测（回接计划 2b 验收①）。
 *
 * 覆盖面（任务书要求）：
 * - fake AgentRunner + 真实 WorkerHostImpl 的全链路（worker thread 真启动）；
 * - scriptPath 注入语义：临时脚本经 workerData.scriptPath 锚定 require 同目录
 *   dep.cjs 跑通（设计 D1 硬前提——锚定缺失即 core_module_load_failed）；
 * - runAndWait 完成（reason completed + scriptResult）；
 * - abort 生效（running → done,aborted）；
 * - FileRunStore 落盘形状（append-only JSONL，末行终态快照）；
 * - 孤儿 run 恢复标记（遗留 running 快照 → done,failed）；
 * - 内置 workflow（chain）经 fake runner 冒烟：三段 agent() 全走通 +
 *   vendored 资产 scriptPath 锚定（chain require _shared/agent-refs.cjs）。
 *
 * 隔离：ZSW_ROOT 每用例指向独立临时目录（FileRunStore 落盘面随 dataRoot 闭包
 * 现取 env 即时切换）；registry 用真实 createRegistry——被测分支（内置名 /
 * 绝对路径）不触发 HOME 侧用户根扫描。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createOrchestrationHost,
  createRegistry,
  normalizeRunParams,
  loadScriptFromPath,
  buildKnownWorkflowNames,
} = require('../lib/orchestration-host');
const coreRef = require('../lib/core-ref');
const zswBin = require('../bin/zsw.js');

/** 每 test 独立 ZSW_ROOT（dataRoot 现取 env，无需 reset configureCore）。 */
function freshRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-wfhost-'));
  process.env.ZSW_ROOT = dir;
  return dir;
}

/** HOME 切换守卫（遮蔽/knownNames 用例注入 discoveryRoots 的 ~/.zsw/workflows 根）。 */
function withHome(home, fn) {
  const prev = process.env.HOME;
  process.env.HOME = home;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    });
}

function freshScriptDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-wfscript-'));
}

/** AbortError 构造（core dispatchCall 的预检分支按 name 判定）。 */
function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * fake core AgentRunner：按 description 分派固定 parsedOutput；
 * hang 模式挂起至 signal abort（abort 用例）。
 */
function makeFakeAgentRunner({ hang = false } = {}) {
  const calls = [];
  const runner = {
    async run(opts, signal) {
      calls.push({ prompt: opts.prompt, description: opts.description, model: opts.model, schema: Boolean(opts.schema) });
      if (hang) {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
      }
      const byDesc = {
        'chain-analyze': { insights: 'ins-1', keyPoints: ['kp-1'] },
        'chain-transform': { plan: 'plan-1', actions: ['act-1'] },
        'chain-synthesize': { summary: 'sum-1', recommendation: 'rec-1' },
        anchored: { ok: true },
      };
      const parsed = byDesc[opts.description] || { ok: true };
      return { content: JSON.stringify(parsed), parsedOutput: parsed, usage: { input: 10, output: 5 } };
    },
  };
  runner.__calls = calls;
  return runner;
}

/** 最小合法脚本：@pi-meta 块 + 锚定 scriptPath 目录 require dep.cjs + 单次 agent()。 */
function writeAnchoredScript(dir) {
  fs.writeFileSync(path.join(dir, 'dep.cjs'), 'module.exports = { msg: "anchored-dep-loaded" };\n');
  const file = path.join(dir, 'anchored.js');
  fs.writeFileSync(file, [
    '/* @pi-meta',
    'name: anchored',
    'description: 最小锚定验证脚本',
    'phases: [run]',
    '*/',
    'const path = require("path");',
    '// 锚定断言：worker eval 沙箱内 require 相对路径以 cwd 为基准，必须经',
    '// workerData.scriptPath 定位脚本同目录（core worker 契约 D1）',
    'if (typeof workerData === "undefined" || typeof workerData.scriptPath !== "string") {',
    '  throw new Error("workerData.scriptPath missing");',
    '}',
    'const dep = require(path.dirname(workerData.scriptPath) + "/dep.cjs");',
    '// agent() 返回 runner 结果的 parsedOutput ?? content（worker 契约，非包装对象）',
    'const r = await agent({ prompt: "echo " + dep.msg, description: "anchored" });',
    'return { got: dep.msg, agentSaw: r && r.ok === true };',
    '',
  ].join('\n'));
  return file;
}

function makeHost(agentRunner) {
  return createOrchestrationHost({ agentRunner });
}

test('scriptPath 注入语义 + runAndWait 完成（fake runner + 真实 WorkerHostImpl）', async () => {
  freshRoot();
  const dir = freshScriptDir();
  const scriptFile = writeAnchoredScript(dir);
  const runner = makeFakeAgentRunner();
  const host = makeHost(runner);

  const result = await host.runAndWait({ workflow: scriptFile, task: 't', workdir: dir }, {});
  assert.equal(result.reason, 'completed', `expect completed, got: ${JSON.stringify(result)}`);
  assert.equal(result.status, 'done');
  assert.deepEqual(result.scriptResult, { got: 'anchored-dep-loaded', agentSaw: true });
  assert.match(result.runId, /^wf-/);
  // fake runner 收到的 prompt 含锚定 dep 的值（require 真跑通才能拼进 prompt）
  assert.ok(runner.__calls.some((c) => c.prompt.includes('anchored-dep-loaded')),
    `agent() prompt should carry dep value loaded via scriptPath anchor: ${JSON.stringify(runner.__calls.map((c) => c.prompt))}`);
});

test('FileRunStore 落盘形状：append-only JSONL，末行终态快照', async () => {
  const root = freshRoot();
  const dir = freshScriptDir();
  const scriptFile = writeAnchoredScript(dir);
  const host = makeHost(makeFakeAgentRunner());

  const result = await host.runAndWait({ workflow: scriptFile, task: 't', workdir: dir }, {});
  const stateFile = path.join(root, 'workflow-state', `${result.runId}.jsonl`);
  assert.ok(fs.existsSync(stateFile), `state file should exist: ${stateFile}`);
  const lines = fs.readFileSync(stateFile, 'utf8').split('\n').filter((l) => l.trim() !== '');
  assert.ok(lines.length >= 2, 'append-only: at least running + done snapshots');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.runId, result.runId);
  assert.equal(last.spec.scriptName, 'anchored');
  assert.equal(last.spec.scriptPath, scriptFile);
  assert.equal(last.state.status, 'done');
  assert.equal(last.state.reason, 'completed');
  assert.equal(typeof last.state.scriptResult, 'object');
  assert.equal(last.state.calls.length, 1, 'one agent call persisted');
});

test('abort 生效：running run → done,aborted 且落盘', async () => {
  freshRoot();
  const dir = freshScriptDir();
  // hang 脚本：单次 agent() 挂起，等 abort
  const scriptFile = path.join(dir, 'hang.js');
  fs.writeFileSync(scriptFile, [
    '/* @pi-meta',
    'name: hang',
    'description: 挂起脚本',
    'phases: [run]',
    '*/',
    'await agent({ prompt: "hang", description: "hang" });',
    'return { done: true };',
    '',
  ].join('\n'));
  const host = makeHost(makeFakeAgentRunner({ hang: true }));

  const started = await host.run({ workflow: scriptFile, task: 't', workdir: dir }, {});
  assert.equal(started.status, 'running');
  // 轮询至内存可见 running（store.save 完成后）
  await waitFor(() => host.status(started.runId).status === 'running', 2000);
  await host.abort(started.runId);
  const fin = host.status(started.runId);
  assert.equal(fin.status, 'done');
  assert.equal(fin.reason, 'aborted');
  // 重复 abort 对 done no-op（core 语义）
  await host.abort(started.runId);
});

test('孤儿 run 恢复标记：遗留 running 快照 → done,failed', async () => {
  const root = freshRoot();
  const stateDir = path.join(root, 'workflow-state');
  fs.mkdirSync(stateDir, { recursive: true });
  const orphanRunId = 'wf-1700000000000-orphan1';
  const snapshot = {
    runId: orphanRunId,
    spec: {
      scriptSource: 'await agent({ prompt: "x" });',
      args: { task: 'x', _runId: orphanRunId },
      scriptName: 'gone-script',
      scriptPath: '/gone/gone-script.js',
    },
    state: {
      status: 'running',
      budget: { usedTokens: 0, usedCost: 0, totalCallCount: 0 },
      calls: [],
      trace: [],
      errorLogs: [],
    },
    meta: { startedAt: new Date().toISOString() },
  };
  fs.writeFileSync(path.join(stateDir, `${orphanRunId}.jsonl`), `${JSON.stringify(snapshot)}\n`);

  const host = makeHost(makeFakeAgentRunner());
  const rec = await host.recoverOrphans();
  assert.equal(rec.orphaned, 1);
  assert.equal(rec.recovered, 1);
  const fin = host.status(orphanRunId);
  assert.equal(fin.status, 'done');
  assert.equal(fin.reason, 'failed');
  assert.match(fin.error, /daemon takeover/);
  // 恢复终态落盘：末行快照为 failed
  const lines = fs.readFileSync(path.join(stateDir, `${orphanRunId}.jsonl`), 'utf8')
    .split('\n').filter((l) => l.trim() !== '');
  assert.equal(JSON.parse(lines[lines.length - 1]).state.reason, 'failed');
});

test('内置 workflow 冒烟：chain 三段 agent() 全走通（vendored 资产 scriptPath 锚定）', async () => {
  freshRoot();
  const runner = makeFakeAgentRunner();
  const host = makeHost(runner);
  const cwd = process.cwd();

  const result = await host.runAndWait({ workflow: 'chain', task: 'demo task', workdir: cwd }, { cwd });
  assert.equal(result.reason, 'completed', JSON.stringify(result));
  assert.equal(result.scriptResult.status, 'ok');
  assert.deepEqual(result.scriptResult.phases_run, ['analyze', 'transform', 'synthesize']);
  assert.equal(result.scriptResult.final.summary, 'sum-1');
  // 三段调用都经 fake runner（_shared/agent-refs.cjs 被 vendored scriptPath 锚定加载）
  const descs = runnerCallsDescs(runner);
  assert.deepEqual(descs, ['chain-analyze', 'chain-transform', 'chain-synthesize']);
});

test('list/status 视图 + done run 内存 cap 淘汰', async () => {
  freshRoot();
  const dir = freshScriptDir();
  const scriptFile = writeAnchoredScript(dir);
  const host = makeHost(makeFakeAgentRunner());

  const r1 = await host.runAndWait({ workflow: scriptFile, task: 't', workdir: dir }, {});
  const list = host.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].runId, r1.runId);
  assert.equal(list[0].status, 'done');
  assert.equal(list[0].workflow, 'anchored');
  const st = host.status(r1.runId);
  assert.equal(st.reason, 'completed');
  assert.equal(st.steps.length, 1);
  // 淘汰窗口外查询给可操作错误（含状态文件路径）
  host._runs.delete(r1.runId);
  assert.throws(() => host.status(r1.runId), /不在内存保留窗口/);
});

test('normalizeRunParams：reviewers 显式报错 / 旧 sugar 映射 / 无法映射 flag 出 warning', async () => {
  freshRoot();
  const core = coreRef.requireCore();
  const rflMeta = (await loadScriptFromPath(coreRef.workflowAssetPath('review-fix-loop.js'), core)).meta.parameters;
  const chainMeta = (await loadScriptFromPath(coreRef.workflowAssetPath('chain.js'), core)).meta.parameters;
  const parallelMeta = (await loadScriptFromPath(coreRef.workflowAssetPath('parallel.js'), core)).meta.parameters;
  const mapReduceMeta = (await loadScriptFromPath(coreRef.workflowAssetPath('map-reduce.js'), core)).meta.parameters;
  // reviewers → 显式报错（新契约批次值 = agent .md 路径）
  assert.throws(
    () => normalizeRunParams({ workflow: 'review-fix-loop', task: 't', reviewers: ['correctness'] }, rflMeta),
    /不再支持 --reviewers/,
  );
  // reviewTarget sugar → target；task 兜底；batchN csv join
  const n1 = normalizeRunParams({ workflow: 'review-fix-loop', reviewTarget: 'rt' }, rflMeta);
  assert.equal(n1.args.targetType, 'text');
  assert.equal(n1.args.target, 'rt');
  const n2 = normalizeRunParams({ workflow: 'review-fix-loop', task: 'tk', batch1: ['a.md', 'b.md'] }, rflMeta);
  assert.equal(n2.args.target, 'tk');
  assert.equal(n2.args.batch1, 'a.md,b.md');
  // 无法映射的通用 flag：显式 warning，不静默
  const n3 = normalizeRunParams({ workflow: 'chain', task: 't', maxConcurrent: 4, timeoutMsPerPhase: 1000, subtaskCount: 3 }, chainMeta);
  assert.ok(n3.warnings.some((w) => w.includes('max-concurrent')));
  assert.ok(n3.warnings.some((w) => w.includes('timeout-per-phase')));
  assert.ok(n3.warnings.some((w) => w.includes('subtask-count')));
  // timeoutMs → budgetTimeMs；model → 透传
  const n4 = normalizeRunParams({ workflow: 'chain', task: 't', timeoutMs: 5000, model: 'glm-x' }, chainMeta);
  assert.equal(n4.budgetTimeMs, 5000);
  assert.equal(n4.model, 'glm-x');
  // parallel：target 回退 task；map-reduce：items 数组直传
  const n5 = normalizeRunParams({ workflow: 'parallel', task: 'the-target' }, parallelMeta);
  assert.equal(n5.args.target, 'the-target');
  const n6 = normalizeRunParams({ workflow: 'map-reduce', operation: 'op', items: ['a', 'b'] }, mapReduceMeta);
  assert.deepEqual(n6.args.items, ['a', 'b']);
  // U3：script: 剥壳残迹已删（直调导出面与头注契约一致）——带前缀 ref 不再
  // 剥壳，原样走 isBuiltin=false 用户脚本分支（meta 契约缺失：白名单外透传 +
  // task 并入），scriptRef 原样保留不剥
  const n7 = normalizeRunParams({ workflow: 'script:mine', task: 't', customKey: 'v', workdir: '/w' }, undefined);
  assert.equal(n7.scriptRef, 'script:mine');
  assert.equal(n7.args.task, 't');
  assert.equal(n7.args.customKey, 'v');
  assert.equal(n7.args.workdir, undefined);
  // C16：内置未知键 warning（meta 驱动键集）——消费键清单来自 meta properties
  // 剔除信封保留键后的 exact 集（chain = agents；task 属信封键不入清单，与
  // 退役前手写 known=['agents'] 同口径）
  const n8 = normalizeRunParams({ workflow: 'chain', task: 't', typoKey: 1 }, chainMeta);
  assert.ok(n8.warnings.some((w) => w.includes('"typoKey"') && w.includes('消费键：agents')), JSON.stringify(n8.warnings));
});

// ----------------------------- C16：meta 驱动对照集 + 平铺拦截（V4o ⛔C）

/** 内置资产 meta.parameters 载入（对照集共用，带缓存）。 */
async function builtinParamsMeta(core, asset, cache = new Map()) {
  if (!cache.has(asset)) {
    cache.set(asset, (await loadScriptFromPath(coreRef.workflowAssetPath(`${asset}.js`), core)).meta.parameters);
  }
  return cache.get(asset);
}

test('⛔C 对照集：现有全部合法调用参数集在 meta 驱动下零 warning + args 组装等值', async () => {
  freshRoot();
  const core = coreRef.requireCore();
  const metaCache = new Map();
  const metaOf = (asset) => builtinParamsMeta(core, asset, metaCache);
  const cases = [
    { name: 'chain 直参基础', asset: 'chain', params: { workflow: 'chain', task: 'demo task' } },
    { name: 'chain agents 字符串', asset: 'chain', params: { workflow: 'chain', task: 't', agents: '/a.md,/b.md' } },
    { name: 'chain agents 数组（CLI csv 形态）', asset: 'chain', params: { workflow: 'chain', task: 't', agents: ['/a.md', '/b.md'] } },
    { name: 'scatter-gather 直参', asset: 'scatter-gather', params: { workflow: 'scatter-gather', task: 'big task' } },
    { name: 'parallel target', asset: 'parallel', params: { workflow: 'parallel', target: 'lib/' } },
    { name: 'parallel task sugar', asset: 'parallel', params: { workflow: 'parallel', task: 'lib/' } },
    { name: 'parallel 全键', asset: 'parallel', params: { workflow: 'parallel', target: 'lib/', perspectives: ['a', 'b'], agents: '/a.md' } },
    { name: 'map-reduce items', asset: 'map-reduce', params: { workflow: 'map-reduce', operation: 'op', items: ['a', 'b'] } },
    { name: 'map-reduce itemsJson', asset: 'map-reduce', params: { workflow: 'map-reduce', operation: 'op', itemsJson: '/tmp/items.json' } },
    { name: 'map-reduce agents', asset: 'map-reduce', params: { workflow: 'map-reduce', operation: 'op', items: ['a'], agents: ['/m.md', '/r.md'] } },
    { name: 'review-fix-loop 最小批次', asset: 'review-fix-loop', params: { workflow: 'review-fix-loop', targetType: 'git-diff', target: 'main', batch1: '/r1.md,/r2.md' } },
    { name: 'review-fix-loop 全 17 键 + batch2/batch3', asset: 'review-fix-loop', params: {
      workflow: 'review-fix-loop', targetType: 'file', target: 'x.js', batch1: '/r.md', batch2: '/r2.md', batch3: '/r3.md',
      batchNames: 'b1,b2,b3', agents: '/a.md', reviewPrompt: 'rp', fixPrompt: 'fp', autoCommit: true, maxRounds: 5,
      stuckThreshold: 2, skipCleanAgents: false, recheckAfterFix: true, fallowScan: true, fixAgent: '/f.md',
      maxFixAttempts: 3, convergeNewIssues: 2, convergeRounds: 3, aggregatorModel: 'glm-lite',
    } },
    { name: 'review-fix-loop reviewTarget sugar', asset: 'review-fix-loop', params: { workflow: 'review-fix-loop', reviewTarget: 'rt' } },
    { name: 'review-fix-loop task sugar', asset: 'review-fix-loop', params: { workflow: 'review-fix-loop', task: 'tk' } },
    { name: 'review-fix-loop CLI 字符串形态（bool/num 归一）', asset: 'review-fix-loop', params: {
      workflow: 'review-fix-loop', targetType: 'git-diff', target: 'main', batch1: '/r.md',
      autoCommit: 'true', maxRounds: '5', skipCleanAgents: 'false', stuckThreshold: '2',
    } },
    { name: '用户脚本无契约透传（含信封键）', asset: null, params: { workflow: '/abs/user-script.js', task: 't', customKey: 'v', workdir: '/w', model: 'm', timeoutMs: 1000, wait: true, args: undefined } },
    { name: 'args 对象形态（pi 宿主语法）', asset: 'chain', params: { workflow: 'chain', args: { task: 't', agents: '/a.md' } } },
    { name: 'args 对象形态（review-fix-loop batchN）', asset: 'review-fix-loop', params: { workflow: 'review-fix-loop', args: { targetType: 'text', target: 'x', batch1: '/r.md' } } },
  ];
  for (const c of cases) {
    const norm = normalizeRunParams(c.params, c.asset ? await metaOf(c.asset) : undefined);
    assert.deepEqual(norm.warnings, [], `[${c.name}] 期望零 warning，实得 ${JSON.stringify(norm.warnings)}`);
  }

  // 组装等值抽查（对照集附带断言，白名单退役后的行为锚点）
  const rfl = normalizeRunParams({
    workflow: 'review-fix-loop', targetType: 'file', target: 'x.js', batch1: ['/r.md'],
    autoCommit: 'true', maxRounds: '5',
  }, await metaOf('review-fix-loop'));
  assert.equal(rfl.args.autoCommit, true, 'meta boolean → bool 归一');
  assert.equal(rfl.args.maxRounds, 5, 'meta integer → num 归一');
  assert.equal(rfl.args.batch1, '/r.md', 'patternProperties 键数组值 → csv');
  assert.equal(rfl.args.targetType, 'file');
  const pr = normalizeRunParams({ workflow: 'parallel', target: 'lib/', perspectives: ['a', 'b'] }, await metaOf('parallel'));
  assert.deepEqual(pr.args.perspectives, ['a', 'b'], 'array 型参数保持数组（元素字符串化）');
  const sg = normalizeRunParams({ workflow: 'scatter-gather', task: 't' }, await metaOf('scatter-gather'));
  assert.deepEqual(sg.args, { task: 't' });
  const argsBase = normalizeRunParams({ workflow: 'chain', args: { task: 't', agents: '/a.md' } }, await metaOf('chain'));
  assert.deepEqual(argsBase.args, { task: 't', agents: '/a.md' }, 'args 对象基座整体透传为 $ARGS');
});

test('C16 平铺拦截：args 对象与顶层平铺参数混用 → 拦截 + 恢复指引原文', async () => {
  freshRoot();
  const core = coreRef.requireCore();
  const chainMeta = await builtinParamsMeta(core, 'chain');
  // 直参形态（无 args 对象）恒不触发平铺检测——现有合法调用不受影响
  const direct = normalizeRunParams({ workflow: 'chain', task: 't', agents: '/a.md' }, chainMeta);
  assert.deepEqual(direct.warnings, []);
  // 混用：agents 在 chain meta 契约内、args 对象存在且无同名 → 拦截
  assert.throws(
    () => normalizeRunParams({ workflow: 'chain', args: { task: 't' }, agents: '/a.md' }, chainMeta),
    (e) => {
      const m = e && e.message || '';
      return m.includes('"agents" 与 args 对象同时给出且被平铺在调用顶层')
        && m.includes('子字段请放 args 对象')
        && m.includes('{"workflow": "...", "args": {"<参数名>": "<值>"}}')
        && m.includes('两种形态不混用');
    },
    '拦截消息必须含键名 + 「子字段请放 args 对象」+ 完整恢复指引',
  );
  // args 基座已有同名键：core filterFlattenedKeys 语义 = 不算平铺（不拦截）；
  // zsw 组装层直参显式覆盖基座（CLI flag 覆盖默认值的直觉）
  const merged = normalizeRunParams({ workflow: 'chain', args: { task: 'from-args' }, task: 'from-top' }, chainMeta);
  assert.equal(merged.args.task, 'from-top');
});

// ----------------------------- C14：core 投影叠加（V4o）

test('C14 runSummary：core 投影单源 + 宿主扩展字段叠加（workflow/model/stateFile + null 归一）', async () => {
  freshRoot();
  const dir = freshScriptDir();
  const scriptFile = writeAnchoredScript(dir);
  const host = makeHost(makeFakeAgentRunner());
  const r = await host.runAndWait({ workflow: scriptFile, task: 't', workdir: dir }, {});
  const st = host.status(r.runId);
  // core 投影字段（单源 core.runSummary）
  assert.equal(st.name, 'anchored');
  assert.equal(st.runId, r.runId);
  assert.equal(st.status, 'done');
  assert.equal(st.reason, 'completed');
  assert.equal(typeof st.startedAt, 'string');
  assert.equal(typeof st.completedAt, 'string');
  // 宿主扩展叠加（等值保留面）
  assert.equal(st.workflow, 'anchored');
  assert.equal(st.stateFile, path.join(process.env.ZSW_ROOT, 'workflow-state', `${r.runId}.jsonl`));
  const listed = host.list()[0];
  assert.equal(listed.workflow, 'anchored');
  assert.equal(listed.name, 'anchored');
  assert.equal(listed.stateFile, st.stateFile);
  // null 归一：无 error/reason 缺席面恒 null 非 undefined（JSON 序列化等值）
  const orphanSnap = {
    runId: 'wf-1700000000000-nullface',
    spec: { scriptSource: 'x', args: {}, scriptName: 'gone', scriptPath: '/gone/g.js' },
    state: { status: 'running', budget: { usedTokens: 0, usedCost: 0, totalCallCount: 0 }, calls: [], trace: [], errorLogs: [] },
    meta: { startedAt: new Date().toISOString() },
  };
  const stateDir = path.join(process.env.ZSW_ROOT, 'workflow-state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'wf-1700000000000-nullface.jsonl'), `${JSON.stringify(orphanSnap)}\n`);
  await host.recoverOrphans();
  const fin = host.status('wf-1700000000000-nullface');
  assert.equal(fin.status, 'done');
  assert.equal(fin.reason, 'failed');
  assert.ok(fin.error !== undefined, 'error 字段存在（接管文案）');
  assert.equal(fin.model, null, 'spec 无 model → null');
  assert.ok('completedAt' in fin, 'completedAt 键恒存在');
});

// ----------------------------- C12：种子夹具恢复实测（V4o，S5② 前置）

test('C12 种子夹具恢复实测：25 历史快照经 recoverCrashedRuns 路径可读、崩溃遗留标终态、状态不丢', async () => {
  const { execFileSync } = require('node:child_process');
  const root = freshRoot();
  // 种子脚本只读/执行消费（领地外文件不改）：生成 25 文件（10 无 v + 15 带 wf-run-v2）
  execFileSync(process.execPath, [
    path.join(__dirname, 'fixtures', 'make-legacy-state-files.js'), root, '--v',
  ], { encoding: 'utf8' });
  const stateDir = path.join(root, 'workflow-state');
  const seedFiles = fs.readdirSync(stateDir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(seedFiles.length, 25, '种子应产出 25 个历史快照');

  // 恢复前基线：逐文件首行可读 + 状态分布（照种子排片表）
  const firstLines = new Map();
  for (const f of seedFiles) {
    const snap = JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8').split('\n')[0]);
    firstLines.set(snap.runId, snap);
  }
  const countBy = (pred) => [...firstLines.values()].filter(pred).length;
  assert.equal(countBy((s) => s.state.status === 'running'), 6, '种子 running = 3 崩溃遗留 + 3 执行中');
  assert.equal(countBy((s) => s.state.status === 'done'), 19, '种子终态 19 条');
  assert.equal(countBy((s) => s.v === 'wf-run-v2'), 15, '带版本标记 15 条');
  assert.equal(countBy((s) => s.v === undefined), 10, '无版本标记 10 条');

  const host = makeHost(makeFakeAgentRunner());
  const rec = await host.recoverOrphans();
  // recovered = 重水合条数（25 全部可读）；orphaned = 遗留 running 全部标终态
  assert.equal(rec.recovered, 25, '25 文件全部重水合');
  assert.equal(rec.orphaned, 6, '遗留 running（崩溃 3 + 执行中 3）全部标终态 failed');

  // 磁盘面：25 文件末行 = 恢复后状态；running → done/failed（core 接管语义），done 组 reason 不丢
  const TAKEOVER = 'daemon takeover: worker died with previous process';
  let crashedMarked = 0;
  for (const [runId, snap0] of firstLines) {
    const lastLine = fs.readFileSync(path.join(stateDir, `${runId}.jsonl`), 'utf8')
      .split('\n').filter((l) => l.trim() !== '').at(-1);
    const fin = JSON.parse(lastLine);
    assert.equal(fin.runId, runId, `末行 runId 一致: ${runId}`);
    if (snap0.state.status === 'running') {
      assert.equal(fin.state.status, 'done', `${runId} running → done`);
      assert.equal(fin.state.reason, 'failed', `${runId} → failed`);
      assert.equal(fin.state.error, TAKEOVER, `${runId} 接管文案逐字节一致`);
      // 快照其余字段不丢：spec/state 骨架保持
      assert.equal(fin.spec.scriptName, snap0.spec.scriptName, `${runId} scriptName 不丢`);
      assert.deepEqual(fin.state.budget.usedTokens, snap0.state.budget.usedTokens, `${runId} budget 不丢`);
      assert.equal(typeof fin.meta.completedAt, 'string', `${runId} 恢复终态带 completedAt（core transition 副作用）`);
      if (snap0.v !== undefined) assert.equal(fin.v, snap0.v, `${runId} 版本标记不丢`);
      crashedMarked++;
    } else {
      // done 组：恢复线不触碰，reason/error/scriptResult 原样
      assert.equal(fin.state.status, 'done', `${runId} 终态保持`);
      assert.equal(fin.state.reason, snap0.state.reason, `${runId} reason 不丢`);
      if (snap0.state.error !== undefined) assert.equal(fin.state.error, snap0.state.error, `${runId} error 不丢`);
      if (snap0.state.scriptResult !== undefined) {
        assert.deepEqual(fin.state.scriptResult, snap0.state.scriptResult, `${runId} scriptResult 不丢`);
      }
    }
  }
  assert.equal(crashedMarked, 6, '6 条遗留 running 全部落终态');

  // 内存面：runs Map 可查（done cap 裁剪到 MAX_RETAINED_DONE_RUNS=20）
  assert.equal(host._runs.size, 20, 'done run 内存 cap 淘汰生效（25 → 20）');
  const sample = [...host._runs.values()][0];
  assert.equal(sample.state.status, 'done');
});

test('lint：合法脚本过 / 缺 agent() 入口报 error', async () => {
  freshRoot();
  const dir = freshScriptDir();
  const good = path.join(dir, 'good.js');
  fs.writeFileSync(good, '/* @pi-meta\nname: good\ndescription: x\nphases: [run]\n*/\nawait agent({ prompt: "x" });\nreturn { ok: 1 };\n');
  const bad = path.join(dir, 'bad.js');
  fs.writeFileSync(bad, '/* @pi-meta\nname: bad\ndescription: x\nphases: [run]\n*/\nconst x = 1;\n');
  const host = makeHost(makeFakeAgentRunner());
  const g = await host.lint(good);
  assert.equal(g.valid, true, JSON.stringify(g));
  const b = await host.lint(bad);
  assert.equal(b.valid, false);
  assert.ok(b.findings.some((f) => f.severity === 'error'));
});

test('scripts action：内置 vendored 5 + 用户脚本发现面', async () => {
  freshRoot();
  // 用户脚本放 <ws>/.zsw/workflows（zsw workspace 级特有根，手工扫描分支）
  const ws = freshScriptDir();
  fs.mkdirSync(path.join(ws, '.zsw', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.zsw', 'workflows', 'mine.js'),
    '/* @pi-meta\nname: mine\ndescription: x\nphases: [run]\n*/\nawait agent({ prompt: "x" });\n');
  const host = makeHost(makeFakeAgentRunner());
  const out = await host.scripts(ws);
  assert.deepEqual(out.builtin.map((b) => b.name),
    ['chain', 'parallel', 'map-reduce', 'scatter-gather', 'review-fix-loop']);
  assert.ok(out.builtin.every((b) => b.path.includes(path.join('vendor', 'subagent-core', 'workflows'))),
    'builtin scriptPath must anchor vendored workflows dir');
  const mine = out.scripts.find((s) => s.name === 'mine');
  assert.ok(mine, `user script discovered: ${JSON.stringify(out.scripts)}`);
  assert.equal(mine.source, 'workspace-zsw');
});

// --------------------------------- C3/D-E3：core 实体 + knownNames 口径（V3w）

/** 最小 @pi-meta 脚本文本（零引擎形态：agent() 挂 $ARGS 条件不触发）。 */
function probeSource(name) {
  return `/* @pi-meta\nname: ${name}\ndescription: ${name} probe\nphases: [run]\n*/\n`
    + 'if ($ARGS.callAgent === true) {\n  await agent({ prompt: "x" });\n}\nreturn { status: "ok" };\n';
}

test('C3：loadScriptFromPath 返回 core WorkflowScript 实体（鸭子拼装退役）+ 非法引用 undefined', async () => {
  freshRoot();
  const core = coreRef.requireCore();
  const dir = freshScriptDir();
  const file = path.join(dir, 'duck.js');
  fs.writeFileSync(file, probeSource('duck'));
  const s = await loadScriptFromPath(file, core);
  // 实体 = core 类实例（构造/meta/加载全走 core，非手工拼鸭子）
  assert.ok(s instanceof core.WorkflowScript, `expect core WorkflowScript instance, got: ${typeof s}`);
  assert.equal(s.name, 'duck');
  assert.equal(s.available, true);
  assert.equal(s.path, file);
  assert.equal(s.toExecutable(), fs.readFileSync(file, 'utf8'));
  assert.equal(s.validate().valid, true);
  // meta 提取失败退化为 available=false + stem 名（core loader fallback 语义）
  const bare = path.join(dir, 'nometa.js');
  fs.writeFileSync(bare, 'const x = 1;\n');
  const s2 = await loadScriptFromPath(bare, core);
  assert.ok(s2 instanceof core.WorkflowScript);
  assert.equal(s2.available, false);
  assert.equal(s2.name, 'nometa');
  // 引用非法（非 .js）显式 undefined——调用方（registry.get）按未找到处理
  assert.equal(await loadScriptFromPath(path.join(dir, 'notes.txt'), core), undefined);
});

test('D-E3 同名遮蔽：saved 与内置同名 → 内置优先生效 + warning 列出双路径', async () => {
  const home = freshScriptDir();
  const savedDir = path.join(home, '.zsw', 'workflows');
  fs.mkdirSync(savedDir, { recursive: true });
  const savedChain = path.join(savedDir, 'chain.js');
  fs.writeFileSync(savedChain, probeSource('chain'));
  await withHome(home, async () => {
    freshRoot();
    const runner = makeFakeAgentRunner();
    const logs = [];
    const host = createOrchestrationHost({ agentRunner: runner, log: (m) => logs.push(m) });
    const cwd = process.cwd();
    // run "chain"：内置名短路命中 vendored 资产（saved chain.js 不执行）
    const result = await host.runAndWait({ workflow: 'chain', task: 'demo task', workdir: cwd }, { cwd });
    assert.equal(result.reason, 'completed', JSON.stringify(result));
    assert.deepEqual(runnerCallsDescs(runner), ['chain-analyze', 'chain-transform', 'chain-synthesize'],
      '内置 chain 三段生效（saved 同名脚本被遮蔽）');
    // warning 属 zsw 侧（core 名命中即返回），双路径都列出
    const warn = logs.find((m) => m.includes('遮蔽'));
    assert.ok(warn, `shadow warning expected, logs: ${JSON.stringify(logs)}`);
    assert.ok(warn.includes(coreRef.workflowAssetPath('chain.js')), `builtin path missing: ${warn}`);
    assert.ok(warn.includes(savedChain), `saved path missing: ${warn}`);
  });
});

test('⛔D knownNames 一致性：CLI 入口与 orchestration-host registry 同目录集产出 deepEqual', async () => {
  const home = freshScriptDir();
  const savedDir = path.join(home, '.zsw', 'workflows');
  fs.mkdirSync(savedDir, { recursive: true });
  fs.writeFileSync(path.join(savedDir, 'alpha.js'), probeSource('alpha'));
  const ws = freshScriptDir();
  fs.mkdirSync(path.join(ws, '.agents', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.agents', 'workflows', 'beta.js'), probeSource('beta'));
  await withHome(home, async () => {
    freshRoot();
    const core = coreRef.requireCore();
    // CLI 入口产出：bin/zsw.js knownWorkflowNames（buildWorkflowRunParams 同源）
    const viaCli = await zswBin.knownWorkflowNames(ws);
    // host 入口产出：registry 内部 resolveScriptPath 消费的同一构建函数
    const reg = createRegistry(core);
    const viaHost = await buildKnownWorkflowNames(core, ws, reg);
    assert.deepEqual(viaCli, viaHost);
    // 集内容：内置 5 在前（内置优先序）+ 两发现根 saved 名
    assert.deepEqual(viaCli.slice(0, 5),
      ['chain', 'parallel', 'map-reduce', 'scatter-gather', 'review-fix-loop']);
    for (const n of ['alpha', 'beta']) {
      assert.ok(viaCli.includes(n), `saved name "${n}" expected in: ${JSON.stringify(viaCli)}`);
    }
    // registry 按同一集解析：saved 名落实际路径、未知名 undefined
    assert.equal(await reg.resolveScriptPath('alpha', ws), path.join(savedDir, 'alpha.js'));
    assert.equal(await reg.resolveScriptPath('beta', ws), path.join(ws, '.agents', 'workflows', 'beta.js'));
    assert.equal(await reg.resolveScriptPath('no-such-name', ws), undefined);
  });
});

// ------------------------------------------------------ helpers

/** 轮询断言辅助（host.run 异步落盘后状态可见）。 */
async function waitFor(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** fake runner 的调用 description 列表（makeFakeAgentRunner 挂在 __calls）。 */
function runnerCallsDescs(runner) {
  return runner.__calls.map((c) => c.description);
}
