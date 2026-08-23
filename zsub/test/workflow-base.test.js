'use strict';

/**
 * workflow 基建测试：lib/workflow/{run-phase,phases,report}。
 *
 * 隔离原则（同 test/execution.test.js）：禁止真跑 zcode.cjs、禁止碰真实 ~/.zcode。
 * - ZSUB_ZCODE_CLI    → 临时 fake CLI（读 --prompt，输出单行 JSON）
 * - ZSUB_ROOT         → 临时目录（per-model HOME 池落这里）
 * - ZCODE_MAILBOX_ROOT → 临时目录（本链路不经过 mailbox，隔离防意外触真实根）
 * - HOME              → 临时目录（config.V2_CONFIG_PATH = $HOME/.zcode/v2/config.json）
 * 四者必须在 require 任何 lib 之前设置：config.js 在模块加载期冻结路径。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-wf-'));
process.env.ZSUB_ROOT = path.join(TMP, 'zsub-root');
process.env.ZCODE_MAILBOX_ROOT = path.join(TMP, 'mailbox');
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

// ---- fake zcode CLI：模拟 `zcode --json` 无头单轮 ----
// FAKE_SLEEP_MS>0：先吐一行提示再挂起（超时测试）；FAKE_GARBAGE=1：输出非 JSON。
const FAKE_CLI = path.join(TMP, 'fake-zcode.cjs');
fs.writeFileSync(FAKE_CLI, `'use strict';
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const prompt = flag('--prompt');

if (process.env.FAKE_GARBAGE === '1') {
  console.log('this is not json at all');
} else if (Number(process.env.FAKE_SLEEP_MS || 0) > 0) {
  console.log(JSON.stringify({ note: 'sleeping before exit' }));
  setTimeout(() => process.exit(0), Number(process.env.FAKE_SLEEP_MS));
} else {
  console.log(JSON.stringify({
    sessionId: 'sess_fake_' + Math.random().toString(36).slice(2, 10),
    response: 'echo:' + String(prompt).slice(0, 20),
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
}
`);
process.env.ZSUB_ZCODE_CLI = FAKE_CLI;

// abort 契约测试用：spawn 即写 marker 文件（FAKE_SPAWN_MARKER 指定路径），
// 用于直接证明「预置中止 → 零 spawn」而非仅靠结果形态推断
const MARKER_CLI = path.join(TMP, 'marker-zcode.cjs');
fs.writeFileSync(MARKER_CLI, `'use strict';
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_SPAWN_MARKER, String(Date.now()));
console.log(JSON.stringify({
  sessionId: 'sess_fake_marker',
  response: 'echo',
  usage: { input_tokens: 1, output_tokens: 1 },
}));
`);

// env 隔离完成后才允许 require lib（见文件头注释）
const config = require('../lib/config');
const { runPhase } = require('../lib/workflow/run-phase');
const phases = require('../lib/workflow/phases');
const report = require('../lib/workflow/report');
const { runChain } = require('../lib/workflow/chain');

const MODEL_REF = 'builtin:bigmodel-coding-plan/GLM-4.7-Flash';

/** 写入测试用 v2 config（model-router bootstrap 的数据源）。 */
function writeV2Config(patch = {}) {
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
  fs.writeFileSync(config.V2_CONFIG_PATH, JSON.stringify({ ...base, ...patch }, null, 2));
}

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// ---------------------------------------------------------------- run-phase

test('runPhase：成功 → 旧扁平形态全字段映射 + HOME 池已 bootstrap', async () => {
  writeV2Config();
  const result = await runPhase({
    prompt: '工作流基础测试提示词超过二十个字符', cwd: TMP, modelRef: MODEL_REF,
  });
  assert.equal(result.ok, true);
  assert.ok(result.sessionId.startsWith('sess_fake_'));
  assert.ok(result.response.startsWith('echo:'));
  assert.deepEqual(result.usage, { input_tokens: 1, output_tokens: 1 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, undefined);
  assert.equal(result.stderrTail, null);
  // per-model HOME 池由 prepareRunEnv bootstrap（model.main = modelRef）
  const poolCfg = path.join(config.homePoolDir('GLM-4.7-Flash'), '.zcode', 'cli', 'config.json');
  assert.equal(JSON.parse(fs.readFileSync(poolCfg, 'utf8')).model.main, MODEL_REF);
});

test('runPhase：modelRef 缺失/非字符串 → reject 可操作错误（不 resolve ok:false）', async () => {
  writeV2Config();
  await assert.rejects(
    () => runPhase({ prompt: 'x', cwd: TMP }),
    (err) => /modelRef 必填/.test(err.message) && err.message.includes('恢复指引')
  );
  await assert.rejects(() => runPhase({ prompt: 'x', cwd: TMP, modelRef: 42 }), /modelRef 必填/);
});

test('runPhase：v2 config 缺 provider → prepareRunEnv 链路可操作错误', async () => {
  writeV2Config({ provider: {} });
  await assert.rejects(
    () => runPhase({ prompt: 'x', cwd: TMP, modelRef: MODEL_REF }),
    (err) => /provider/.test(err.message) && err.message.includes('恢复指引')
  );
  writeV2Config(); // 还原数据源，避免影响后续用例
});

test('runPhase：CLI 非零退出 → ok:false + error 含退出码', async () => {
  writeV2Config();
  const saved = process.env.ZSUB_ZCODE_CLI;
  process.env.ZSUB_ZCODE_CLI = path.join(TMP, 'not-exist.cjs'); // node 报 module not found，退出码 1
  try {
    const result = await runPhase({ prompt: 'x', cwd: TMP, modelRef: MODEL_REF, timeoutMs: 15000 });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, null);
    assert.match(result.error, /退出码/);
  } finally {
    process.env.ZSUB_ZCODE_CLI = saved;
  }
});

test('runPhase：输出不可解析 → ok:false + error 指向解析失败', async () => {
  writeV2Config();
  process.env.FAKE_GARBAGE = '1';
  try {
    const result = await runPhase({ prompt: 'x', cwd: TMP, modelRef: MODEL_REF, timeoutMs: 15000 });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, false);
    assert.match(result.error, /无法解析/);
  } finally {
    delete process.env.FAKE_GARBAGE;
  }
});

test('runPhase：超时 → timedOut:true + error 含超时说明，response 带 stdout 尾部', async () => {
  writeV2Config();
  process.env.FAKE_SLEEP_MS = '600000';
  try {
    const result = await runPhase({ prompt: '挂住', cwd: TMP, modelRef: MODEL_REF, timeoutMs: 300 });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.match(result.error, /超时/);
    assert.ok(result.response.includes('sleeping before exit'));
  } finally {
    delete process.env.FAKE_SLEEP_MS;
  }
});

// ------------------------------------------------------------------ phases

test('phases.runPhase：包装出报告条目（phase/label/durationMs/timedOut）', async () => {
  writeV2Config();
  const entry = await phases.runPhase({
    name: 'analyze', label: '分析', prompt: '阶段条目包装测试提示词', cwd: TMP, modelRef: MODEL_REF,
  });
  assert.equal(entry.phase, 'analyze');
  assert.equal(entry.label, '分析');
  assert.equal(entry.ok, true);
  assert.ok(entry.sessionId.startsWith('sess_fake_'));
  assert.ok(entry.response.startsWith('echo:'));
  assert.equal(entry.usage.input_tokens, 1);
  assert.equal(entry.timedOut, false);
  assert.equal(entry.error, undefined);
  assert.ok(Number.isFinite(entry.durationMs) && entry.durationMs >= 0);
});

test('phases.runPhase：label 缺省回落 name；失败条目带 error 不抛', async () => {
  writeV2Config();
  process.env.FAKE_GARBAGE = '1';
  try {
    const entry = await phases.runPhase({
      name: 'analyze', prompt: 'x', cwd: TMP, modelRef: MODEL_REF, timeoutMs: 15000,
    });
    assert.equal(entry.label, 'analyze');
    assert.equal(entry.ok, false);
    assert.equal(entry.timedOut, false);
    assert.match(entry.error, /无法解析/);
  } finally {
    delete process.env.FAKE_GARBAGE;
  }
});

test('phases.shortSession：sess_ 前缀取 5..17 位，其余取前 12 位，空值为 -', () => {
  assert.equal(phases.shortSession(null), '-');
  assert.equal(phases.shortSession(''), '-');
  assert.equal(phases.shortSession('sess_abcdefghijklmnop'), 'abcdefghijkl');
  assert.equal(phases.shortSession('odd-id-1234567890'), 'odd-id-12345');
});

// --------------------------------------------------------- AbortSignal 契约
// 契约正文见 lib/workflow/run-phase.js 头注；此处覆盖契约 1/2/3/4 四条语义。

/** 换 marker CLI 并返回 marker 路径（try/finally 里 restoreCli 还原）。 */
function useMarkerCli() {
  const marker = path.join(TMP, `spawn-marker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  process.env.ZSUB_ZCODE_CLI = MARKER_CLI;
  process.env.FAKE_SPAWN_MARKER = marker;
  return { marker, restoreCli: () => {
    process.env.ZSUB_ZCODE_CLI = FAKE_CLI;
    delete process.env.FAKE_SPAWN_MARKER;
  } };
}

test('runPhase：signal 预置 aborted → 零 spawn + aborted 条目（契约 1）', async () => {
  writeV2Config();
  const { marker, restoreCli } = useMarkerCli();
  try {
    const controller = new AbortController();
    controller.abort(); // 调用前已中止
    const result = await runPhase({ prompt: '预置中止', cwd: TMP, modelRef: MODEL_REF, signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'aborted');
    assert.equal(result.aborted, true);
    assert.equal(result.sessionId, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, null);
    assert.equal(result.stderrTail, null);
    // marker CLI 只要被 spawn 就会落文件 → 不存在即零 spawn
    assert.equal(fs.existsSync(marker), false);
  } finally {
    restoreCli();
  }
});

test('runPhase：运行中 abort → kill 子进程 + aborted 条目（契约 2）', async () => {
  writeV2Config();
  process.env.FAKE_SLEEP_MS = '600000'; // 挂住等 abort
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500); // 留足 prepareRunEnv bootstrap 余量，保证打在运行中
    const started = Date.now();
    const result = await runPhase({
      prompt: '运行中中止', cwd: TMP, modelRef: MODEL_REF,
      timeoutMs: 20000, signal: controller.signal, // 若 abort 失效将等到 20s 超时
    });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.equal(result.error, 'aborted');
    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false); // 是被杀，不是超时
    // cancelled 终态携带 stdout 尾部 → 证明子进程确实跑起来后被杀
    assert.ok(String(result.response).includes('sleeping before exit'));
    assert.ok(elapsed < 10000, `abort 后应及时返回（实际 ${elapsed}ms）`);
  } finally {
    delete process.env.FAKE_SLEEP_MS;
  }
});

test('phases.runPhase：透传 signal，aborted 条目落 aborted:true 字段', async () => {
  writeV2Config();
  const controller = new AbortController();
  controller.abort();
  const entry = await phases.runPhase({
    name: 'analyze', label: '分析', prompt: 'x', cwd: TMP, modelRef: MODEL_REF,
    signal: controller.signal,
  });
  assert.equal(entry.phase, 'analyze');
  assert.equal(entry.label, '分析');
  assert.equal(entry.ok, false);
  assert.equal(entry.error, 'aborted');
  assert.equal(entry.aborted, true);
  assert.equal(entry.sessionId, null);
  assert.ok(Number.isFinite(entry.durationMs) && entry.durationMs >= 0);
});

test('runChain：signal 预置 aborted → 零阶段启动 + status=aborted（契约 1/3）', async () => {
  writeV2Config();
  const { marker, restoreCli } = useMarkerCli();
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await runChain({
      task: '预置中止的链式任务', workdir: TMP, timeoutMsPerPhase: 20000,
      signal: controller.signal,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'aborted');
    assert.equal(result.abortedAtPhase, 'analyze');
    assert.equal(result.final, null);
    // 契约 1：analyze 未启动但条目入报告，后续阶段无条目
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0].phase, 'analyze');
    assert.equal(result.phases[0].aborted, true);
    assert.equal(fs.existsSync(marker), false); // 零 spawn
  } finally {
    restoreCli();
  }
});

test('runChain：运行中 abort → 进程被杀、条目 aborted、后续阶段未启动（契约 2/3）', async () => {
  writeV2Config();
  process.env.FAKE_SLEEP_MS = '600000'; // analyze 阶段挂住，abort 打在阶段 1 内
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500); // 打在 analyze 运行中（bootstrap 完成后）
    const events = [];
    const result = await runChain({
      task: '运行中中止的链式任务', workdir: TMP, timeoutMsPerPhase: 20000,
      signal: controller.signal, onPhase: (e) => events.push({ ...e }),
    });
    assert.equal(result.status, 'aborted');
    assert.equal(result.ok, false);
    assert.equal(result.abortedAtPhase, 'analyze');
    assert.equal(result.phases.length, 1); // transform/synthesize 未启动
    const entry = result.phases[0];
    assert.equal(entry.aborted, true);
    assert.equal(entry.ok, false);
    assert.equal(entry.error, 'aborted');
    // 被杀的子进程跑过（stdout 尾部带回），且非超时路径
    assert.ok(String(entry.response).includes('sleeping before exit'));
    assert.equal(entry.timedOut, false);
    // onPhase：analyze running → aborted；无任何 transform 事件
    assert.deepEqual(events, [
      { phase: 'analyze', status: 'running' },
      { phase: 'analyze', status: 'aborted' },
    ]);
  } finally {
    delete process.env.FAKE_SLEEP_MS;
  }
});

test('runChain：无 signal → status=ok 增量字段，条目不带 aborted（契约 4）', async () => {
  writeV2Config();
  const result = await runChain({ task: '无信号回归验证任务', workdir: TMP, timeoutMsPerPhase: 30000 });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.abortedAtPhase, undefined);
  assert.equal(result.phases.length, 3);
  for (const p of result.phases) {
    assert.equal(p.ok, true);
    assert.equal(p.aborted, undefined);
  }
});

test('runChain：阶段失败 → status=failed（现有失败语义映射）', async () => {
  writeV2Config();
  process.env.FAKE_GARBAGE = '1'; // analyze 阶段输出不可解析 → 失败
  try {
    const result = await runChain({ task: '失败状态映射验证', workdir: TMP, timeoutMsPerPhase: 30000 });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.abortedAtPhase, undefined);
    assert.equal(result.phases.length, 1);
    assert.match(result.error, /阶段 analyze（分析）失败/);
  } finally {
    delete process.env.FAKE_GARBAGE;
  }
});

// ------------------------------------------------------------------ report

/** 造一个与 runXxx 统一返回结构一致的样例（runChain 形态）。 */
function sampleResult(overrides = {}) {
  return {
    ok: true, workflow: 'chain', task: '示例任务：做点分析',
    workdir: '/tmp/demo', model: 'builtin:bigmodel-coding-plan/GLM-5.3',
    startedAt: '2026-08-23T00:00:00.000Z', finishedAt: '2026-08-23T00:00:07.000Z',
    phases: [
      { phase: 'analyze', label: '分析', ok: true, sessionId: 'sess_abcdefghijklmnop',
        usage: { totalTokens: 120 }, timedOut: false, durationMs: 2000 },
      { phase: 'transform', label: '实现|含竖线', ok: false, sessionId: null,
        usage: null, timedOut: true, durationMs: 3000, error: '运行超时' },
    ],
    sections: [{ title: '审查轮次', body: '第 1 轮全部通过', maxChars: 100 }],
    final: '最终结论文本',
    ...overrides,
  };
}

test('report.buildMarkdownReport：成功报告含元信息/附加段/阶段表/最终结论', () => {
  const md = report.buildMarkdownReport(sampleResult());
  assert.ok(md.includes('# zsub · chain 报告'));
  assert.ok(md.includes('✅ 成功'));
  assert.ok(md.includes('**总耗时**: 7.0s'));
  assert.ok(md.includes('**总 tokens**: 120'));
  assert.ok(md.includes('## 审查轮次'));
  assert.ok(md.includes('第 1 轮全部通过'));
  assert.ok(md.includes('| 1 | analyze |'));
  assert.ok(md.includes('| 2 | transform |'));
  assert.ok(md.includes('❌(超时)'));        // timedOut 标记（依赖条目带 timedOut 字段）
  assert.ok(md.includes('实现\\|含竖线'));   // 表格单元格竖线转义
  assert.ok(md.includes('abcdefghijkl'));   // shortSession 短 id
  assert.ok(md.includes('## 最终结论'));
  assert.ok(!md.includes('## 失败原因'));
});

test('report.buildMarkdownReport：失败报告带失败状态行与失败原因段', () => {
  const md = report.buildMarkdownReport(sampleResult({ ok: false, error: '阶段 transform 失败', final: null }));
  assert.ok(md.includes('❌ 失败 — 阶段 transform 失败'));
  assert.ok(md.includes('## 失败原因'));
  assert.ok(!md.includes('## 最终结论'));
});

test('report：clip 超限截断并标注原文长度', () => {
  const md = report.buildMarkdownReport(sampleResult({ task: '长'.repeat(301) }));
  assert.ok(md.includes('…(已截断，原文 301 字符)'));
});

test('report.buildContentBlocks：双段结构，JSON 围栏可完整还原', () => {
  const sample = sampleResult();
  const blocks = report.buildContentBlocks(sample);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'text');
  assert.ok(blocks[0].text.startsWith('# zsub'));
  assert.equal(blocks[1].type, 'text');
  assert.ok(blocks[1].text.startsWith('```json\n'));
  assert.ok(blocks[1].text.endsWith('\n```'));
  // 去掉围栏后是完整 JSON，且无损还原（机器段契约）
  assert.deepEqual(JSON.parse(blocks[1].text.slice(8, -4)), sample);
});
