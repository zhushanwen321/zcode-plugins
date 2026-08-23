'use strict';

/**
 * 第一批 workflow 移植测试：chain / parallel / map-reduce。
 *
 * 隔离原则（同 test/workflow-base.test.js）：禁止真跑 zcode.cjs、禁止碰真实 ~/.zcode。
 * - ZSW_ZCODE_CLI    → 临时 fake CLI
 * - ZSW_ROOT         → 临时目录（per-model HOME 池落这里）
 * - ZCODE_MAILBOX_ROOT → 临时目录（隔离防意外触真实根）
 * - HOME              → 临时目录（config.V2_CONFIG_PATH = $HOME/.zcode/v2/config.json）
 * 四者必须在 require 任何 lib 之前设置：config.js 在模块加载期冻结路径。
 *
 * fake CLI 行为（见下方脚本内注释）：
 * - response 完整回显 prompt —— 测试据此断言「后阶段 prompt 拼接了前阶段
 *   输出」「聚合/reduce 阶段收到全部视角与条目结果」。
 * - FAKE_FAIL_MATCH：prompt 命中子串 → 非零退出（模拟 CLI 崩溃，注入阶段失败）。
 * - FAKE_CONCURRENCY_DIR + FAKE_WORK_MS：每个 fake 进程写 [start,end] 时间戳
 *   文件（文件名含 pid，无读改写竞态），测试侧按区间重叠算实际最大并发。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-wfa-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsub-root');
process.env.ZCODE_MAILBOX_ROOT = path.join(TMP, 'mailbox');
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

// ---- fake zcode CLI：模拟 `zcode --json` 无头单轮 ----
const FAKE_CLI = path.join(TMP, 'fake-zcode.cjs');
fs.writeFileSync(FAKE_CLI, `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const prompt = String(flag('--prompt') || '');

if (process.env.FAKE_FAIL_MATCH && prompt.includes(process.env.FAKE_FAIL_MATCH)) {
  console.error('fake CLI simulated crash for matched prompt');
  process.exit(3);
}

const concDir = process.env.FAKE_CONCURRENCY_DIR;
if (concDir) fs.writeFileSync(path.join(concDir, 's-' + process.pid), String(Date.now()));
const workMs = Number(process.env.FAKE_WORK_MS || 0);
setTimeout(() => {
  if (concDir) fs.writeFileSync(path.join(concDir, 'e-' + process.pid), String(Date.now()));
  console.log(JSON.stringify({
    sessionId: 'sess_fake_' + Math.random().toString(36).slice(2, 10),
    response: prompt,
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
}, workMs);
`);
process.env.ZSW_ZCODE_CLI = FAKE_CLI;

// env 隔离完成后才允许 require lib（见文件头注释）
const config = require('../lib/config');
const { runChain } = require('../lib/workflow/chain');
const { runParallel, DEFAULT_PERSPECTIVES } = require('../lib/workflow/parallel');
const { runMapReduce } = require('../lib/workflow/map-reduce');
const { buildMarkdownReport } = require('../lib/workflow/report');

/** 写入测试用 v2 config（model-router resolve/bootstrap 的数据源）。 */
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

/** 扫描并发观测目录，按各进程活跃区间重叠数求实际最大并发。 */
function maxConcurrency(dir) {
  const spans = new Map();
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^([se])-(\d+)$/);
    if (!m) continue;
    const t = Number(fs.readFileSync(path.join(dir, f), 'utf8'));
    const span = spans.get(m[2]) || {};
    span[m[1]] = t;
    spans.set(m[2], span);
  }
  let max = 0;
  for (const a of spans.values()) {
    if (a.s == null || a.e == null) continue;
    let n = 0;
    for (const b of spans.values()) {
      if (b.s == null || b.e == null) continue;
      if (b.s < a.e && a.s < b.e) n++; // 开区间重叠判定（含自身）
    }
    max = Math.max(max, n);
  }
  return max;
}

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// --------------------------------------------------------------------- chain

test('runChain：三阶段串行，后阶段 prompt 拼接前阶段输出；报告含阶段条目', async () => {
  writeV2Config();
  const plans = [];
  const events = [];
  const result = await runChain({
    task: '示例任务：分析并改造某个模块的中文测试样例',
    workdir: TMP,
    onPhase: (e) => events.push({ ...e }),
    onPlan: (n) => plans.push(n),
  });
  assert.equal(result.ok, true);
  assert.equal(result.workflow, 'chain');
  // 默认模型解析走 ModelRouter.resolve：回落 v2 config 的 model.main
  assert.equal(result.model, 'builtin:bigmodel-coding-plan/GLM-5.3');
  assert.deepEqual(plans, [3]);
  assert.equal(result.phases.length, 3);
  const [analyze, transform, synthesize] = result.phases;
  assert.ok(analyze.ok && transform.ok && synthesize.ok);
  // fake CLI 回显 prompt → 后阶段 prompt 内嵌前阶段完整输出（未超 16000 不截断）
  assert.ok(transform.response.includes(analyze.response));
  assert.ok(synthesize.response.includes(analyze.response));
  assert.ok(synthesize.response.includes(transform.response));
  assert.equal(result.final, synthesize.response);
  // onPhase 事件序列：每阶段 running → done
  assert.deepEqual(
    events.map((e) => e.phase),
    ['analyze', 'analyze', 'transform', 'transform', 'synthesize', 'synthesize']
  );
  assert.equal(events[0].status, 'running');
  assert.equal(events[events.length - 1].status, 'done');
  const md = buildMarkdownReport(result);
  assert.ok(md.includes('| 1 | analyze |'));
  assert.ok(md.includes('| 2 | transform |'));
  assert.ok(md.includes('| 3 | synthesize |'));
  assert.ok(md.includes('## 最终结论'));
});

test('runChain：阶段失败 → 终止后续阶段 + 失败条目与原因进报告', async () => {
  writeV2Config();
  process.env.FAKE_FAIL_MATCH = '实现者'; // 仅 transform 阶段 prompt 命中
  try {
    const result = await runChain({
      task: '触发第二阶段失败的示例任务描述', workdir: TMP, timeoutMsPerPhase: 30000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.phases.length, 2); // synthesize 未启动
    assert.equal(result.phases[0].ok, true);
    assert.equal(result.phases[1].ok, false);
    assert.equal(result.final, null);
    assert.match(result.error, /阶段 transform（实现）失败/);
    assert.match(result.error, /退出码/);
    const md = buildMarkdownReport(result);
    assert.ok(md.includes('❌ 失败'));
    assert.ok(md.includes('## 失败原因'));
    assert.ok(md.includes('| 2 | transform |'));
    assert.ok(!md.includes('| 3 | synthesize |'));
  } finally {
    delete process.env.FAKE_FAIL_MATCH;
  }
});

test('runChain：未知模型 → ModelRouter.resolve 可操作错误透传', async () => {
  writeV2Config();
  await assert.rejects(
    () => runChain({ task: 'x', workdir: TMP, model: 'no-such-model' }),
    (err) => /未知模型/.test(err.message) && err.message.includes('恢复指引')
  );
});

// ------------------------------------------------------------------ parallel

test('runParallel：3 视角并发（各自 prompt 含视角标记）+ 聚合收到全部结果', async () => {
  writeV2Config();
  const plans = [];
  const events = [];
  const result = await runParallel({
    task: '并行审查目标示例：lib/foo.js 的三个维度中文描述',
    workdir: TMP,
    model: 'GLM-4.7-Flash', // 短名 → resolve 全名
    onPhase: (e) => events.push({ ...e }),
    onPlan: (n) => plans.push(n),
  });
  assert.deepEqual(DEFAULT_PERSPECTIVES, ['security', 'performance', 'maintainability']);
  assert.equal(result.ok, true);
  assert.equal(result.workflow, 'parallel');
  assert.equal(result.model, 'builtin:bigmodel-coding-plan/GLM-4.7-Flash');
  assert.deepEqual(plans, [4]);
  assert.equal(result.phases.length, 4); // 3 analyze + 1 aggregate
  const [s1, s2, s3, agg] = result.phases;
  // 各视角条目带 label，prompt（回显）含各自的视角标记
  const marks = {
    security: [s1, '「security」视角的分析者'],
    performance: [s2, '「performance」视角的分析者'],
    maintainability: [s3, '「maintainability」视角的分析者'],
  };
  for (const [p, [entry, mark]] of Object.entries(marks)) {
    assert.equal(entry.phase, 'analyze');
    assert.equal(entry.label, `视角: ${p}`);
    assert.equal(entry.ok, true);
    assert.ok(entry.response.includes(mark), `analyze(${p}) prompt 缺视角标记`);
  }
  // 聚合 prompt（回显）内嵌全部视角输出 → 三个视角标记都在
  assert.equal(agg.phase, 'aggregate');
  for (const [, [, mark]] of Object.entries(marks)) {
    assert.ok(agg.response.includes(mark), `aggregate prompt 缺视角输出: ${mark}`);
  }
  assert.equal(result.final, agg.response);
  for (const p of DEFAULT_PERSPECTIVES) {
    assert.ok(result.sections[0].body.includes(`### ${p}`));
  }
  // onPhase：段首 running x3 + 各视角完成 + aggregate done
  assert.equal(events[0].phase, 'analyze');
  assert.equal(events[0].status, 'running x3');
  assert.deepEqual(events[events.length - 1], { phase: 'aggregate', status: 'done' });
  const md = buildMarkdownReport(result);
  assert.ok(md.includes('| 1 | analyze |'));
  assert.ok(md.includes('| 4 | aggregate |'));
  assert.ok(md.includes('## 各视角原始结论'));
});

test('runParallel：maxConcurrent=2 时实际最大并发为 2（第 3 个视角排队）', async () => {
  writeV2Config();
  const concDir = path.join(TMP, 'conc-limit2');
  fs.rmSync(concDir, { recursive: true, force: true });
  fs.mkdirSync(concDir, { recursive: true });
  process.env.FAKE_CONCURRENCY_DIR = concDir;
  process.env.FAKE_WORK_MS = '250'; // 放大活跃区间，保证重叠可观测
  try {
    const result = await runParallel({
      task: '并发上限观测任务', workdir: TMP, maxConcurrent: 2, timeoutMsPerPhase: 30000,
    });
    assert.equal(result.ok, true);
    assert.equal(maxConcurrency(concDir), 2);
  } finally {
    delete process.env.FAKE_CONCURRENCY_DIR;
    delete process.env.FAKE_WORK_MS;
  }
});

test('runParallel：perspectives 解析后为空 → 可操作错误', async () => {
  writeV2Config();
  await assert.rejects(
    () => runParallel({ task: 'x', workdir: TMP, perspectives: ['  ', ''] }),
    /perspectives 解析后为空/
  );
});

// ---------------------------------------------------------------- map-reduce

test('runMapReduce：3 items 各自进 map prompt + reduce 收全；报告含阶段条目', async () => {
  writeV2Config();
  const items = ['item-alpha 模块甲', 'item-beta 模块乙', 'item-gamma 模块丙'];
  const result = await runMapReduce({
    items, operation: '统计每个条目的中文名称并给出结论', task: '附加上下文样例', workdir: TMP,
  });
  assert.equal(result.ok, true);
  assert.equal(result.workflow, 'map-reduce');
  assert.equal(result.phases.length, 4); // 3 map + 1 reduce
  const maps = result.phases.slice(0, 3);
  maps.forEach((m, i) => {
    assert.equal(m.phase, 'map');
    assert.equal(m.ok, true);
    assert.ok(m.response.includes(items[i]), `map[${i}] prompt 缺 item`);
    assert.ok(m.label.startsWith(`item[${i}]:`));
  });
  const reduce = result.phases[3];
  assert.equal(reduce.phase, 'reduce');
  // reduce prompt（回显）内嵌全部 map 输出 → 每个 item 都在
  for (const item of items) {
    assert.ok(reduce.response.includes(item), `reduce prompt 缺 item: ${item}`);
  }
  assert.equal(result.final, reduce.response);
  assert.ok(result.sections[0].body.includes('### item[0]: item-alpha 模块甲'));
  const md = buildMarkdownReport(result);
  assert.ok(md.includes('| 1 | map |'));
  assert.ok(md.includes('| 4 | reduce |'));
  assert.ok(md.includes('## 各条目 map 结果'));
});

test('runMapReduce：空 items / 缺 operation → 可操作错误', async () => {
  writeV2Config();
  await assert.rejects(
    () => runMapReduce({ items: [], operation: 'x', workdir: TMP }),
    /map-reduce 需要非空 items 数组/
  );
  await assert.rejects(
    () => runMapReduce({ items: ['a'], workdir: TMP }),
    /map-reduce 需要 operation/
  );
});

test('runMapReduce：单个 map 失败（非全部）→ reduce 继续，缺失标注进 sections', async () => {
  writeV2Config();
  // 用 map prompt 独有的「## 本次条目」标题精确命中 item[1]；reduce prompt 里
  // 的条目是「### item[1]: ...」形态，不会命中
  process.env.FAKE_FAIL_MATCH = '## 本次条目\nitem-beta 模块乙';
  try {
    const result = await runMapReduce({
      items: ['item-alpha 模块甲', 'item-beta 模块乙', 'item-gamma 模块丙'],
      operation: '部分失败语义验证的操作指令', workdir: TMP, timeoutMsPerPhase: 30000,
    });
    assert.equal(result.ok, true); // 非全部失败 → reduce 照跑
    assert.equal(result.phases.length, 4);
    assert.equal(result.phases[0].ok, true);
    assert.equal(result.phases[1].ok, false);
    assert.equal(result.phases[2].ok, true);
    assert.ok(result.sections[0].body.includes('(map 失败，缺结果)'));
  } finally {
    delete process.env.FAKE_FAIL_MATCH;
  }
});

test('runMapReduce：全部 map 失败 → 终止且 error 汇总首个失败原因', async () => {
  writeV2Config();
  process.env.FAKE_FAIL_MATCH = 'mapper'; // 所有 map prompt 均含（reduce prompt 为 reducer 不含）
  try {
    const result = await runMapReduce({
      items: ['a1', 'b2'], operation: '全失败语义验证', workdir: TMP, timeoutMsPerPhase: 30000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.phases.length, 2); // reduce 未启动
    assert.match(result.error, /全部 2 个 map 失败/);
    assert.equal(result.final, null);
  } finally {
    delete process.env.FAKE_FAIL_MATCH;
  }
});

// ------------------------------------------------------ abort（signal 契约）

test('runParallel：signal 预置 aborted → 零阶段启动，status=aborted', async () => {
  writeV2Config();
  const concDir = path.join(TMP, 'conc-abort-pre');
  fs.rmSync(concDir, { recursive: true, force: true });
  fs.mkdirSync(concDir, { recursive: true });
  process.env.FAKE_CONCURRENCY_DIR = concDir;
  try {
    const controller = new AbortController();
    controller.abort(); // 预置：任何阶段启动前
    const result = await runParallel({
      task: '预置中止任务', workdir: TMP, signal: controller.signal, timeoutMsPerPhase: 30000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'aborted');
    assert.equal(result.abortedAtPhase, 'analyze');
    assert.deepEqual(result.phases, []); // 零阶段启动
    assert.equal(result.final, null);
    assert.match(result.error, /已中止/);
    assert.equal(fs.readdirSync(concDir).length, 0); // 未 spawn 任何 fake CLI
  } finally {
    delete process.env.FAKE_CONCURRENCY_DIR;
  }
});

test('runParallel：批中部分完成时 abort → 已完成保留、未启动不启动、聚合不执行', async () => {
  writeV2Config();
  const concDir = path.join(TMP, 'conc-abort-mid');
  fs.rmSync(concDir, { recursive: true, force: true });
  fs.mkdirSync(concDir, { recursive: true });
  process.env.FAKE_CONCURRENCY_DIR = concDir;
  try {
    const controller = new AbortController();
    const result = await runParallel({
      task: '批中部分完成中止任务', workdir: TMP,
      perspectives: ['p1', 'p2', 'p3'],
      maxConcurrent: 1, // 串行取件：第 1 个完成后 worker 才会取第 2 个
      signal: controller.signal, timeoutMsPerPhase: 30000,
      // 第 1 个视角完成的回调里同步 abort：p1 已到终态（保留），p2/p3 尚未启动
      onPhase: (e) => {
        if (String(e.status).startsWith('done')) controller.abort();
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'aborted');
    assert.equal(result.abortedAtPhase, 'analyze'); // 批内有未启动条目 → 中止点记批次
    assert.equal(result.phases.length, 3);
    // 已启动的跑到终态并保留
    assert.equal(result.phases[0].ok, true);
    assert.equal(result.phases[0].aborted, undefined);
    // 未启动的由 runPhase 预检返回契约形态的 aborted 条目，不 spawn
    for (const e of result.phases.slice(1)) {
      assert.equal(e.ok, false);
      assert.equal(e.aborted, true);
      assert.equal(e.error, 'aborted');
    }
    assert.equal(fs.readdirSync(concDir).filter((f) => f.startsWith('s-')).length, 1);
    // 聚合阶段未启动
    assert.ok(!result.phases.some((p) => p.phase === 'aggregate'));
    assert.equal(result.final, null);
  } finally {
    delete process.env.FAKE_CONCURRENCY_DIR;
  }
});

test('runParallel：signal 存在但未触发 → 行为不变（status=ok，聚合照跑）', async () => {
  writeV2Config();
  const result = await runParallel({
    task: 'signal 未触发回归任务', workdir: TMP,
    signal: new AbortController().signal, timeoutMsPerPhase: 30000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.phases.length, 4); // 3 analyze + aggregate 照跑
  assert.equal(result.abortedAtPhase, undefined);
  assert.ok(result.final);
});

test('runMapReduce：map 批全部完成后 abort → reduce 不启动，map 结果保留', async () => {
  writeV2Config();
  const items = ['m1 甲', 'm2 乙', 'm3 丙'];
  const controller = new AbortController();
  let doneCount = 0;
  const result = await runMapReduce({
    items, operation: 'reduce 边界中止的操作指令', workdir: TMP,
    signal: controller.signal, timeoutMsPerPhase: 30000,
    // 最后一个 map 完成回调里同步 abort：批次已收尾、reduce 未启动
    onPhase: (e) => {
      if (String(e.status).startsWith('done')) {
        doneCount++;
        if (doneCount === items.length) controller.abort();
      }
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'aborted');
  assert.equal(result.abortedAtPhase, 'reduce'); // 批内无未启动条目 → 中止点记下一阶段
  assert.equal(result.phases.length, 3);
  assert.ok(result.phases.every((p) => p.ok)); // 已完成的 map 全部保留
  assert.ok(!result.phases.some((p) => p.phase === 'reduce'));
  assert.equal(result.final, null);
  assert.match(result.error, /已中止/);
});

test('runMapReduce：signal 预置 aborted → 零阶段启动', async () => {
  writeV2Config();
  const controller = new AbortController();
  controller.abort();
  const result = await runMapReduce({
    items: ['a', 'b'], operation: '预置中止操作', workdir: TMP,
    signal: controller.signal, timeoutMsPerPhase: 30000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'aborted');
  assert.equal(result.abortedAtPhase, 'map');
  assert.deepEqual(result.phases, []);
  assert.equal(result.final, null);
  assert.match(result.error, /已中止/);
});
