'use strict';

/**
 * 第二批 workflow（scatter-gather / review-fix-loop）移植测试。
 *
 * 隔离原则同 workflow-base.test.js：禁止真跑 zcode、禁止碰真实 ~/.zcode。
 * - fake CLI 按 --prompt 关键词分支返回不同响应：scatter 者/处理者/gather 者/
 *   审查者「correctness」/修复者，覆盖两个 workflow 的全部阶段形态。
 * - env 开关：FAKE_GARBAGE（输出非 JSON）、FAKE_SCATTER_BAD（scatter 无 json 块）、
 *   FAKE_DECLINE（review 恒不 clean 且 must-fix 数逐次严格递减 5→1——避开停滞
 *   检测的 stuck 路径；v2 默认 maxRounds=10（设计 D5），递减序列在第 8 轮起触发
 *   连续 3 轮不降的 stuck，因此 fixed-unverified 用例显式传 maxRounds:5 钉住场景）。
 * - FAKE_CALL_LOG 记录每次调用的完整 prompt 供跨阶段断言（子任务分发/收全/fix 输入）；
 *   FAKE_STATE_FILE 存递减计数（子进程间无共享内存，计数必须落盘）。
 * - workdir 一律临时目录：review-fix-loop 的 fix 阶段会写工作目录，scatter-gather
 *   的 process 阶段同样允许写文件。
 * - ZSW_ROOT/ZCODE_MAILBOX_ROOT/HOME 必须在 require 任何 lib 前设置（config 冻结路径）；
 *   review-fix-loop v2 的 runDir（~/.zcode/zsw/rfl/<runId>/，设计 D4）落在 ZSW_ROOT 下，
 *   同样被本文件的 env 隔离覆盖。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-wfb-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsub-root');
process.env.ZCODE_MAILBOX_ROOT = path.join(TMP, 'mailbox');
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

const CALL_LOG = path.join(TMP, 'calls.jsonl');
const STATE_FILE = path.join(TMP, 'decline-count.txt');

// ---- fake zcode CLI：按 prompt 关键词分支（围栏反引号放普通字符串，避免嵌套模板）----
const FAKE_CLI = path.join(TMP, 'fake-zcode.cjs');
fs.writeFileSync(FAKE_CLI, [
  "'use strict';",
  "const fs = require('node:fs');",
  "const args = process.argv.slice(2);",
  "const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };",
  "const prompt = String(flag('--prompt') || '');",
  "const F = '```';",
  'function reply(text) {',
  "  const log = process.env.FAKE_CALL_LOG;",
  '  if (log) { try { fs.appendFileSync(log, JSON.stringify({ prompt }) + \'\\n\'); } catch (e) { /* 日志失败不影响响应 */ } }',
  "  console.log(JSON.stringify({",
  "    sessionId: 'sess_fake_' + Math.random().toString(36).slice(2, 10),",
  "    response: text,",
  "    usage: { input_tokens: 1, output_tokens: 1 },",
  '  }));',
  '}',
  '',
  "if (process.env.FAKE_GARBAGE === '1') {",
  "  console.log('this is not json at all');",
  "} else if (prompt.includes('审查者')) {",
  "  const revisiting = prompt.includes('上一轮修复说明');",
  // FAKE_FAIL_REVIEWERS=名称列表：命中者输出非 JSON → runPhase ok:false（模拟 CLI 崩溃/超时）
  "  const failList = (process.env.FAKE_FAIL_REVIEWERS || '').split(',').map((s) => s.trim()).filter(Boolean);",
  "  if (failList.some((x) => prompt.includes('审查者「' + x + '」'))) {",
  "    console.log('this is not json at all');",
  "  } else if (process.env.FAKE_DECLINE === '1') {",
  "    const f = process.env.FAKE_STATE_FILE;",
  "    const n = Number(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '0') + 1;",
  "    fs.writeFileSync(f, String(n));",
  "    const cnt = Math.max(1, 6 - n); // 第 n 次 review 返回 max(1,6-n) 个 major：5,4,3,2,1,1...",
  "    const issues = [];",
  "    for (let k = 0; k < cnt; k++) issues.push({ id: 'A' + k, severity: 'major', title: '问题-' + n + '-' + k, detail: '递减场景', file: 'x.js' });",
  "    reply(F + 'json\\n' + JSON.stringify({ status: 'issues', issues }) + '\\n' + F);",
  "  } else if (!revisiting && prompt.includes('审查者「correctness」')) {",
  "    reply(F + 'json\\n{\"status\":\"issues\",\"issues\":[{\"id\":\"A1\",\"severity\":\"major\",\"title\":\"样例逻辑错误\",\"detail\":\"边界条件\",\"file\":\"a.js\"}]}\\n' + F);",
  '  } else {',
  "    reply(F + 'json\\n{\"status\":\"clean\",\"issues\":[]}\\n' + F);",
  '  }',
  "} else if (prompt.includes('修复者')) {",
  "  reply('## 修复结果\\nA1 → 已修复（测试模拟修复）。');",
  "} else if (prompt.includes('scatter 者')) {",
  "  if (process.env.FAKE_SCATTER_BAD === '1') {",
  "    reply('我看了下任务，觉得没法拆分，直接说了两大段话，没有任何 json 块。');",
  '  } else {',
  "    reply('拆分思路：一分为二，甲乙互不依赖。\\n' + F + 'json\\n{\"subtasks\":[{\"name\":\"alpha\",\"description\":\"完成甲部分\"},{\"name\":\"beta\",\"description\":\"完成乙部分\"}]}\\n' + F);",
  '  }',
  "} else if (prompt.includes('处理者')) {",
  "  reply('PROC-DONE');",
  "} else if (prompt.includes('gather 者')) {",
  "  reply('## 最终报告\\n全部核对完成，无遗漏。');",
  '} else {',
  "  reply('echo:' + prompt.slice(0, 20));",
  '}',
].join('\n'));
process.env.ZSW_ZCODE_CLI = FAKE_CLI;
process.env.FAKE_CALL_LOG = CALL_LOG;
process.env.FAKE_STATE_FILE = STATE_FILE;

// env 隔离完成后才允许 require lib（见文件头注释）
const config = require('../lib/config');
const { runScatterGather } = require('../lib/workflow/scatter-gather');
const { runReviewFixLoop, DEFAULT_REVIEWERS } = require('../lib/workflow/review-fix-loop');
const report = require('../lib/workflow/report');

const MODEL_REF = 'builtin:bigmodel-coding-plan/GLM-4.7-Flash';
const DEFAULT_MODEL_REF = 'builtin:bigmodel-coding-plan/GLM-5.3'; // v2 config 的 model.main

/** 写入测试用 v2 config（model-router bootstrap 的数据源）。 */
function writeV2Config() {
  const base = {
    model: { main: DEFAULT_MODEL_REF },
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

function readCalls() {
  if (!fs.existsSync(CALL_LOG)) return [];
  return fs.readFileSync(CALL_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function resetCalls() { fs.rmSync(CALL_LOG, { force: true }); }

function makeWorkdir(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// ------------------------------------------------------------ scatter-gather

test('scatter-gather：拆分出 2 个子任务 → 各自分发处理 → gather 收全合并', async () => {
  writeV2Config();
  resetCalls();
  const workdir = makeWorkdir('sg-ok');
  const events = [];
  const plans = [];
  const result = await runScatterGather({
    task: '大任务：演示 scatter-gather 全链路',
    workdir, model: MODEL_REF,
    onPhase: (e) => events.push(e),
    onPlan: (n) => plans.push(n),
  });

  assert.equal(result.ok, true);
  assert.equal(result.workflow, 'scatter-gather');
  assert.equal(result.model, MODEL_REF);
  assert.deepEqual(result.phases.map((p) => p.phase), ['scatter', 'process', 'process', 'gather']);
  assert.ok(result.phases.every((p) => p.ok));
  assert.ok(result.final.includes('## 最终报告'));
  assert.ok(result.sections[0].body.includes('alpha'));
  assert.ok(result.sections[0].body.includes('beta'));

  // 池的有序返回：process 条目按 scatter 拆分顺序对应子任务名
  assert.deepEqual(result.phases.slice(1, 3).map((p) => p.label), ['子任务: alpha', '子任务: beta']);

  // 各子任务 prompt 断言：两个 process 调用各自只带自己的子任务
  const calls = readCalls();
  const processCalls = calls.filter((c) => c.prompt.includes('处理者'));
  assert.equal(processCalls.length, 2);
  const names = processCalls
    .map((c) => (c.prompt.match(/## 你的子任务\n(.+?): /) || [])[1])
    .sort();
  assert.deepEqual(names, ['alpha', 'beta']);

  // gather 收全：两个子任务输出（PROC-DONE ×2）与大任务回顾都进入 gather prompt
  const gatherCall = calls.find((c) => c.prompt.includes('gather 者'));
  assert.ok(gatherCall);
  assert.equal((gatherCall.prompt.match(/PROC-DONE/g) || []).length, 2);
  assert.ok(gatherCall.prompt.includes('## 大任务（回顾）'));

  // 进度回调冒烟：计划数 1+2+1；关键阶段事件齐全
  assert.deepEqual(plans, [4]);
  assert.ok(events.some((e) => e.phase === 'scatter' && e.status === 'running'));
  assert.ok(events.some((e) => e.phase === 'process:alpha' && String(e.status).startsWith('done')));
  assert.ok(events.some((e) => e.phase === 'gather' && e.status === 'done'));

  // 报告条目冒烟
  const md = report.buildMarkdownReport(result);
  assert.ok(md.includes('# zsw · scatter-gather 报告'));
  assert.ok(md.includes('子任务清单（scatter 拆出 2 个）'));
  assert.ok(md.includes('| 4 | gather |'));
});

test('scatter-gather：scatter 输出无 json 块 → 解析不出 subtasks → ok:false 带原文片段', async () => {
  writeV2Config();
  resetCalls();
  process.env.FAKE_SCATTER_BAD = '1';
  try {
    const result = await runScatterGather({
      task: '不可拆任务', workdir: makeWorkdir('sg-bad'), model: MODEL_REF,
    });
    assert.equal(result.ok, false);
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0].ok, true); // 阶段本身成功，失败在输出解析
    assert.match(result.error, /无法解析出 subtasks/);
    assert.ok(result.error.includes('没法拆分')); // 原始输出片段透传，便于诊断
    assert.equal(result.final, null);
  } finally {
    delete process.env.FAKE_SCATTER_BAD;
  }
});

test('scatter-gather：阶段运行失败（输出非 JSON）→ 失败传播 + 报告失败段', async () => {
  writeV2Config();
  resetCalls();
  process.env.FAKE_GARBAGE = '1';
  try {
    const result = await runScatterGather({
      task: '失败传播任务', workdir: makeWorkdir('sg-fail'), model: MODEL_REF,
    });
    assert.equal(result.ok, false);
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0].ok, false);
    assert.match(result.error, /scatter 阶段失败/);
    assert.match(result.error, /无法解析/);
    const md = report.buildMarkdownReport(result);
    assert.ok(md.includes('❌ 失败 — '));
    assert.ok(md.includes('## 失败原因'));
    assert.ok(!md.includes('## 最终结论'));
  } finally {
    delete process.env.FAKE_GARBAGE;
  }
});

// ----------------------------------------------------------- review-fix-loop

test('review-fix-loop：首轮 must-fix → fix → 次轮全 clean → round=2 收敛', async () => {
  writeV2Config();
  resetCalls();
  const result = await runReviewFixLoop({ task: '演示审查修复', workdir: makeWorkdir('rfl-clean') });

  // 默认值断言：审查者默认 correctness+robustness；model 缺省走 v2 的 model.main
  assert.deepEqual(DEFAULT_REVIEWERS, ['correctness', 'robustness']);
  assert.deepEqual(result.loop.reviewers, DEFAULT_REVIEWERS);
  assert.equal(result.model, DEFAULT_MODEL_REF);

  assert.equal(result.ok, true);
  assert.equal(result.loop.status, 'clean');
  assert.equal(result.loop.rounds, 2);
  assert.equal(result.loop.remainingCount, 0);
  // skip-clean 语义（对齐原版 skipCleanAgents=true 默认）：R1 的 robustness 报 clean，
  // fix 后 clean 集合不清空 → R2 只重审 correctness（R1 双审 + fix + R2 单审 = 4）
  assert.equal(result.phases.length, 4);
  assert.ok(result.phases.every((p) => p.ok));

  // fix 阶段确实被调用，且收到聚合后的 must-fix
  const fix = result.phases.find((p) => p.phase === 'fix');
  assert.ok(fix);
  assert.equal(fix.label, 'R1 修复 (1 项)');
  const fixCall = readCalls().find((c) => c.prompt.includes('修复者'));
  assert.ok(fixCall.prompt.includes('样例逻辑错误'));

  assert.ok(result.final.includes('## 审查通过'));
  assert.ok(result.sections[0].body.includes('must-fix 1 个'));
  // 轮次摘要显式记录被跳过的 clean 审查者（可观测：R2 维度消失有解释）
  assert.ok(result.sections[0].body.includes('跳过: robustness'));
  assert.equal(result.error, undefined);

  // 报告条目冒烟：轮次摘要段 + 阶段表末行
  const md = report.buildMarkdownReport(result);
  assert.ok(md.includes('## 轮次摘要'));
  assert.ok(md.includes('| 4 | review |'));
});

test('review-fix-loop：恒不 clean 且逐轮递减 → maxRounds=5 熔断 → fixed-unverified', async () => {
  writeV2Config();
  resetCalls();
  fs.rmSync(STATE_FILE, { force: true }); // 递减计数从 0 起：5,4,3,2,1（严格递减避开停滞检测）
  process.env.FAKE_DECLINE = '1';
  try {
    const result = await runReviewFixLoop({
      task: '永不收敛的任务',
      reviewers: ['correctness'], // 单审查者：每轮 1 次 review，must-fix 5→4→3→2→1
      workdir: makeWorkdir('rfl-maxrounds'),
      model: MODEL_REF,
      // v2 默认 maxRounds=10（设计 D5）：递减序列第 8 轮起触发 stuck（连续 3 轮不降），
      // 走不到轮数熔断——本用例意图是 fixed-unverified 熔断路径，显式钉 5（v1 缺省值）
      maxRounds: 5,
    });
    assert.equal(result.model, MODEL_REF);
    assert.equal(result.ok, false);
    // maxRounds=5 熔断：走满 5 轮、最后一轮 fix 成功且未复核 → 源语义的细分终态
    assert.equal(result.loop.rounds, 5);
    assert.equal(result.loop.status, 'fixed-unverified');
    assert.equal(result.loop.remainingCount, 0);
    assert.equal(result.phases.length, 10); // 5 × (review + fix)
    assert.ok(result.phases.every((p) => p.ok));
    assert.match(result.error, /轮数用尽/);
    assert.ok(result.final.includes('已修复，待复核'));
    assert.ok(result.sections.some((s) => s.title === '最后一轮修复说明'));
  } finally {
    delete process.env.FAKE_DECLINE;
  }
});

// ------------------------------------------------- abort（signal 契约）

test('scatter-gather：signal 预置 aborted → 零阶段启动', async () => {
  writeV2Config();
  resetCalls();
  const controller = new AbortController();
  controller.abort();
  const result = await runScatterGather({
    task: '预置中止的大任务', workdir: makeWorkdir('sg-abort-pre'), model: MODEL_REF,
    signal: controller.signal,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'aborted');
  assert.equal(result.abortedAtPhase, 'scatter');
  assert.deepEqual(result.phases, []);
  assert.equal(result.final, null);
  assert.match(result.error, /已中止/);
  assert.deepEqual(readCalls(), []); // 未 spawn 任何 fake CLI
});

test('scatter-gather：process 批全部完成后 abort → gather 不启动，已完成阶段保留', async () => {
  writeV2Config();
  resetCalls();
  const controller = new AbortController();
  let processDone = 0;
  const result = await runScatterGather({
    task: 'gather 边界中止的大任务', workdir: makeWorkdir('sg-abort-gather'), model: MODEL_REF,
    signal: controller.signal,
    // 最后一个子任务完成回调里同步 abort：process 批已收尾、gather 未启动
    onPhase: (e) => {
      if (e.phase.startsWith('process:') && String(e.status).startsWith('done')) {
        processDone++;
        if (processDone === 2) controller.abort();
      }
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'aborted');
  assert.equal(result.abortedAtPhase, 'gather'); // 批内无未启动条目 → 中止点记下一阶段
  assert.deepEqual(result.phases.map((p) => p.phase), ['scatter', 'process', 'process']);
  assert.ok(result.phases.every((p) => p.ok)); // 已完成阶段全部保留
  assert.equal(result.final, null);
  assert.ok(!readCalls().some((c) => c.prompt.includes('gather 者'))); // gather 未启动
});

test('scatter-gather：signal 存在但未触发 → 行为不变（status=ok）', async () => {
  writeV2Config();
  resetCalls();
  const result = await runScatterGather({
    task: 'signal 未触发的大任务', workdir: makeWorkdir('sg-live-signal'), model: MODEL_REF,
    signal: new AbortController().signal,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.phases.map((p) => p.phase), ['scatter', 'process', 'process', 'gather']);
  assert.equal(result.abortedAtPhase, undefined);
});

test('review-fix-loop：round 1 完成后 abort → round 2 不启动，status=aborted', async () => {
  writeV2Config();
  resetCalls();
  const controller = new AbortController();
  const result = await runReviewFixLoop({
    task: '轮间中止演示', workdir: makeWorkdir('rfl-abort-round'),
    signal: controller.signal,
    // R1 修复完成回调里同步 abort：本轮已完整结束、round 2 尚未启动
    onPhase: (e) => {
      // v2 检查点命名 batch<i>-round<j>-<phase>（设计 §3.4 abort 检查点全集）
      if (e.phase === 'batch1-round1-fix' && e.status === 'done') controller.abort();
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'aborted');
  // fix 完成后检查点命中 → 命名为该轮 fix 阶段（v2 命名；v1 为 round1-fix）
  assert.equal(result.abortedAtPhase, 'batch1-round1-fix');
  assert.equal(result.loop.status, 'aborted');
  assert.equal(result.loop.rounds, 1); // round 1 摘要保留
  assert.equal(result.phases.length, 3); // R1 双审 + fix；round 2 review 未启动
  assert.ok(result.phases.every((p) => p.ok));
  const calls = readCalls();
  assert.equal(calls.filter((c) => c.prompt.includes('审查者')).length, 2); // 仅 R1 双审
  assert.ok(result.final.includes('已中止'));
  assert.match(result.error, /已中止/);
  // 中止时 R1 聚合出的 must-fix 原样保留
  assert.equal(result.loop.remainingCount, 1);
});

test('review-fix-loop：signal 预置 aborted → 零阶段启动', async () => {
  writeV2Config();
  resetCalls();
  const controller = new AbortController();
  controller.abort();
  const result = await runReviewFixLoop({
    task: '预置中止审查', workdir: makeWorkdir('rfl-abort-pre'), signal: controller.signal,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'aborted');
  // 批间检查点（批 1 启动前）最先命中 → v2 命名 batch1（v1 为 round1-review）
  assert.equal(result.abortedAtPhase, 'batch1');
  assert.deepEqual(result.phases, []);
  assert.equal(result.loop.status, 'aborted');
  assert.equal(result.loop.rounds, 0);
  assert.deepEqual(readCalls(), []); // 未 spawn 任何 fake CLI
});

test('review-fix-loop：review 批后 abort → 命中 aggregate 检查点，fix 不启动', async () => {
  writeV2Config();
  resetCalls();
  const controller = new AbortController();
  const result = await runReviewFixLoop({
    task: '聚合后中止演示', workdir: makeWorkdir('rfl-abort-agg'),
    reviewers: ['correctness'], signal: controller.signal,
    // review 批完成回调（done, must-fix=N）里同步 abort：聚合已完成、fix 未启动
    onPhase: (e) => {
      if (e.phase === 'batch1-round1-review' && String(e.status).startsWith('done, must-fix')) {
        controller.abort();
      }
    },
  });
  assert.equal(result.status, 'aborted');
  // §3.4 检查点全集：聚合完成后（fix 不进行）→ 命名 batch<i>-round<j>-aggregate
  assert.equal(result.abortedAtPhase, 'batch1-round1-aggregate');
  assert.equal(result.phases.filter((p) => p.phase === 'fix').length, 0); // fix 未启动
  assert.equal(result.loop.remainingCount, 1); // 聚合出的 must-fix 原样保留
  assert.equal(readCalls().filter((c) => c.prompt.includes('修复者')).length, 0);
});

test('review-fix-loop：signal 存在但未触发 → 行为不变（status=ok）', async () => {
  writeV2Config();
  resetCalls();
  const result = await runReviewFixLoop({
    task: 'signal 未触发的审查', workdir: makeWorkdir('rfl-live-signal'),
    signal: new AbortController().signal,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.loop.status, 'clean');
  assert.equal(result.phases.length, 4); // skip-clean 默认：R2 只重审 R1 非 clean 的 correctness
  assert.equal(result.abortedAtPhase, undefined);
});

test('review-fix-loop：skipCleanAgents=false → clean 审查者不跳过，R2 仍全量双审', async () => {
  writeV2Config();
  resetCalls();
  const result = await runReviewFixLoop({
    task: '关闭跳过的审查', workdir: makeWorkdir('rfl-no-skip'),
    skipCleanAgents: false,
  });
  assert.equal(result.loop.status, 'clean');
  assert.equal(result.loop.rounds, 2);
  assert.equal(result.phases.length, 5); // R1 双审 + fix + R2 双审（skip 关闭）
  // robustness 被派两次（字符串布尔 'false' 同样生效——入口 coerceBool 防御）
  assert.equal(readCalls().filter((c) => c.prompt.includes('审查者「robustness」')).length, 2);
});

test('review-fix-loop：skipCleanAgents 字符串 "false" → 等价布尔 false（coerceBool 防御）', async () => {
  writeV2Config();
  resetCalls();
  const result = await runReviewFixLoop({
    task: '字符串布尔的审查', workdir: makeWorkdir('rfl-str-bool'),
    skipCleanAgents: 'false',
  });
  assert.equal(result.loop.status, 'clean');
  assert.equal(readCalls().filter((c) => c.prompt.includes('审查者「robustness」')).length, 2);
});

test('review-fix-loop：recheckAfterFix=true → fix 后重派全批，clean 审查者走限定复检 prompt', async () => {
  writeV2Config();
  resetCalls();
  const result = await runReviewFixLoop({
    task: '强回归复检的审查', workdir: makeWorkdir('rfl-recheck'),
    recheckAfterFix: true,
  });
  assert.equal(result.loop.status, 'clean');
  assert.equal(result.loop.rounds, 2);
  assert.equal(result.phases.length, 5); // R2 重派全批（双审）
  const robustnessCalls = readCalls().filter((c) => c.prompt.includes('审查者「robustness」'));
  assert.equal(robustnessCalls.length, 2);
  // 第二次（R2 重派）prompt 是限定复检：只查 fix 引入的回归，非全量重审
  assert.ok(robustnessCalls[1].prompt.includes('限定复检'));
  assert.ok(robustnessCalls[1].prompt.includes('只检查'));
  // R1 非 clean 的 correctness 重派走常规 R2 prompt（含上轮修复说明，无限定段）
  const correctnessCalls = readCalls().filter((c) => c.prompt.includes('审查者「correctness」'));
  assert.equal(correctnessCalls.length, 2);
  assert.ok(!correctnessCalls[1].prompt.includes('限定复检'));
  assert.ok(correctnessCalls[1].prompt.includes('上一轮修复说明'));
});

test('review-fix-loop：全部审查者执行失败（ok:false）→ review-failed，不得按 0 问题判 clean', async () => {
  process.env.FAKE_GARBAGE = '1'; // fake CLI 输出非 JSON → runPhase ok:false（执行失败）
  try {
    const out = await runReviewFixLoop({
      task: '审查一个会被全部审查失败的场景',
      workdir: TMP,
      maxRounds: 2,
    });
    assert.equal(out.ok, false);
    assert.equal(out.status, 'failed');
    assert.equal(out.loop.status, 'review-failed');
    assert.match(out.error, /review-failed/);
    assert.match(out.final, /审查阶段失败/);
    assert.match(out.final, /不能按 clean 处理/);
  } finally {
    delete process.env.FAKE_GARBAGE;
  }
});

test('review-fix-loop：部分审查者执行失败 + 其余 clean → 通过但轮次摘要含执行失败告警', async () => {
  process.env.FAKE_FAIL_REVIEWERS = 'correctness'; // 仅 correctness 执行失败，robustness 输出 clean
  try {
    const out = await runReviewFixLoop({
      task: '部分审查失败场景', workdir: TMP, maxRounds: 2,
    });
    // 有至少一个成功且 must-fix=0 → 仍可判 clean（review-failed 只留给全部失败）
    assert.equal(out.ok, true);
    assert.equal(out.loop.status, 'clean');
    // 轮次摘要如实区分：失败审查者显示执行失败 + 告警计数，不得伪装成 0 问题
    const round1 = out.sections.find((s) => s.title === '轮次摘要').body.split('\n')[0];
    assert.match(round1, /correctness: 审查执行失败/);
    assert.match(round1, /robustness: clean/);
    assert.match(round1, /（1 个审查者执行失败）/);
    assert.doesNotMatch(round1, /correctness: 0 个问题/);
  } finally {
    delete process.env.FAKE_FAIL_REVIEWERS;
  }
});

// ------------------------------------------- v2：参数面 / 批次外环 / runDir（U1）

test('review-fix-loop v2：老参数 sugar（--reviewers + --review-target）→ 单批 + text target（S7）', async () => {
  writeV2Config();
  resetCalls();
  const result = await runReviewFixLoop({
    task: '老参数审查', workdir: makeWorkdir('rfl-sugar'),
    reviewers: ['correctness'], reviewTarget: 'README.md 全文',
    runId: 'wf-utest-sugar',
  });
  assert.equal(result.loop.status, 'clean');
  // 老参数映射单批（S7 不变量 ②：state.meta.batches 长度 1）
  assert.equal(result.loop.batches, 1);
  assert.deepEqual(result.loop.batchNames, ['batch-1']);
  assert.equal(result.loop.reviewers.length, 1);
  // --review-target sugar 映射 targetType=text + target=<值>（D5）
  assert.equal(result.loop.targetType, 'text');
  assert.equal(result.loop.target, 'README.md 全文');
  // 审查/修复 prompt 的「审查范围」来自映射后的 target
  const reviewCall = readCalls().find((c) => c.prompt.includes('审查者「correctness」'));
  assert.ok(reviewCall.prompt.includes('README.md 全文'));
  const fixCall = readCalls().find((c) => c.prompt.includes('修复者'));
  assert.ok(fixCall.prompt.includes('README.md 全文'));
  // state.meta.batches 长度 1（S7 数据源）
  const st = JSON.parse(fs.readFileSync(path.join(TMP, 'zsub-root', 'rfl', 'wf-utest-sugar', 'state.json'), 'utf8'));
  assert.equal(st.meta.batches.length, 1);
  assert.equal(st.meta.targetType, 'text');
});

test('review-fix-loop v2：batchN 双批串行 + 批间时序（S1）+ runDir/state 最小骨架（S5）', async () => {
  writeV2Config();
  resetCalls();
  const result = await runReviewFixLoop({
    task: '双批串行演示', workdir: makeWorkdir('rfl-batchseq'), runId: 'wf-utest-batchseq',
    batch1: ['security'], batch2: ['maintainability'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.loop.status, 'clean');
  assert.equal(result.loop.batches, 2);
  assert.deepEqual(result.loop.batchNames, ['batch-1', 'batch-2']);
  assert.equal(result.loop.rounds, 2); // 每批 1 轮 clean

  // runDir 通道：runId → <ZSW_ROOT>/rfl/<runId>/，返回结果带 runDir（D4）
  const runDir = path.join(TMP, 'zsub-root', 'rfl', 'wf-utest-batchseq');
  assert.equal(result.runDir, runDir);
  const st = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  assert.equal(st.meta.runId, 'wf-utest-batchseq');
  assert.equal(st.meta.workdir, result.workdir);
  // 全缺省映射（D5）：target 系一个都不传 → text + v1 缺省文案
  assert.equal(st.meta.targetType, 'text');
  assert.equal(st.meta.target, 'git 未提交改动');
  assert.deepEqual(st.meta.batches, [['security'], ['maintainability']]);
  assert.equal(st.meta.baseHash, null); // 临时目录非 git 仓库（base 锁定基线）
  assert.equal(st.meta.terminated, 'clean');
  assert.equal(st.fixCount, 0);
  // 批内每轮 rounds[] 带 startedAt/finishedAt（S1 批次时序的数据源）
  const b1 = st.batches[0].rounds;
  const b2 = st.batches[1].rounds;
  assert.equal(b1.length, 1);
  assert.equal(b2.length, 1);
  assert.deepEqual(b1[0].agents, ['security']);
  assert.ok(b1[0].startedAt && b1[0].finishedAt && b2[0].startedAt && b2[0].finishedAt);
  // S1 单测级：批 1 全部 round 的 finishedAt 先于批 2 首轮 startedAt
  assert.ok(b1[0].finishedAt <= b2[0].startedAt);

  // 批次顺序（调用日志）：批 2 的调用在批 1 完成之后
  const prompts = readCalls().map((c) => c.prompt);
  const secIdx = prompts.findIndex((p) => p.includes('审查者「security」'));
  const maiIdx = prompts.findIndex((p) => p.includes('审查者「maintainability」'));
  assert.ok(secIdx >= 0 && maiIdx > secIdx);
});

test('review-fix-loop v2：跨批 skip——批 1 clean 无 fix → 批 2 同维度跳过（S4）', async () => {
  writeV2Config();
  resetCalls();
  const result = await runReviewFixLoop({
    task: '跨批跳过演示', workdir: makeWorkdir('rfl-crossskip'), runId: 'wf-utest-crossskip',
    batch1: ['security', 'performance'], batch2: ['security', 'maintainability'],
  });
  assert.equal(result.loop.status, 'clean');
  assert.equal(result.loop.rounds, 2);
  const prompts = readCalls().map((c) => c.prompt);
  // security 在批 1 clean 且批 1 无 fix → 批 2 跳过：全程只派 1 次
  assert.equal(prompts.filter((p) => p.includes('审查者「security」')).length, 1);
  assert.equal(prompts.filter((p) => p.includes('审查者「performance」')).length, 1);
  assert.equal(prompts.filter((p) => p.includes('审查者「maintainability」')).length, 1);
  // 轮次摘要含跨批跳过说明（可观测）
  assert.ok(result.sections[0].body.includes('跨批跳过: security'));
  // S4 数据源：批 2 的 rounds[].agents[] 不含 security
  const st = JSON.parse(fs.readFileSync(path.join(TMP, 'zsub-root', 'rfl', 'wf-utest-crossskip', 'state.json'), 'utf8'));
  assert.deepEqual(st.batches[1].rounds[0].agents, ['maintainability']);
  assert.ok(st.batches[1].rounds[0].skipped.includes('security'));
});

test('review-fix-loop v2：批 1 有 fix → 跨批 skip 失效（fixCount 快照失配），clean 维度批 2 重派', async () => {
  writeV2Config();
  resetCalls();
  const result = await runReviewFixLoop({
    task: 'fix 后跨批重派演示', workdir: makeWorkdir('rfl-crossfix'), runId: 'wf-utest-crossfix',
    batch1: ['correctness', 'security'], batch2: ['security'],
  });
  // 批 1：R1 correctness 报 issue + security clean → fix → R2 correctness 复审 clean → 批 clean
  assert.equal(result.loop.status, 'clean');
  // security：批 1 R1 派 1 次；批 2 因 fixCount 快照失配（0→1）不得跳过，重派 1 次
  assert.equal(readCalls().filter((c) => c.prompt.includes('审查者「security」')).length, 2);
  const st = JSON.parse(fs.readFileSync(path.join(TMP, 'zsub-root', 'rfl', 'wf-utest-crossfix', 'state.json'), 'utf8'));
  assert.equal(st.fixCount, 1);
  // security 批 2 重派后又 clean：快照被更新为批 2（重派判定依据是派发前的旧快照，
  // 由上面的「security 全程派发 2 次」断言证明）
  assert.equal(st.agentStatus.security.lastCleanBatch, 2);
  assert.equal(st.agentStatus.security.lastCleanFixCount, 1);
  assert.equal(st.agentStatus.correctness.lastCleanFixCount, 1);
});

test('review-fix-loop v2：未知参数白名单报错 + batchN 缺号报错（零 spawn）', async () => {
  writeV2Config();
  resetCalls();
  // 未知参数 → 报错且合法清单可见（防 batchN 拼错静默失效）
  await assert.rejects(
    () => runReviewFixLoop({ task: 'x', workdir: makeWorkdir('rfl-badparam'), bogusParam: '1' }),
    (e) => /未知参数: "bogusParam"/.test(e.message)
      && e.message.includes('batch1..batchN')
      && e.message.includes('stuckThreshold')
      && e.message.includes('恢复指引'),
  );
  // batchN 缺号（设计 §3.4：N>=1 连续编号，缺号报错）
  await assert.rejects(
    () => runReviewFixLoop({ task: 'x', workdir: TMP, batch1: ['security'], batch3: ['performance'] }),
    (e) => /缺少 batch2/.test(e.message),
  );
  // batchNames 数量与批次数不一致
  await assert.rejects(
    () => runReviewFixLoop({ task: 'x', workdir: TMP, batch1: ['security'], batchNames: ['a', 'b'] }),
    /batchNames 数量（2）与批次数（1）不一致/,
  );
  // fallowScan 仅 git-diff 合法（D7）
  await assert.rejects(
    () => runReviewFixLoop({ task: 'x', workdir: TMP, fallowScan: true }),
    /fallowScan=true 仅在 targetType=git-diff 时合法/,
  );
  assert.deepEqual(readCalls(), []); // 校验失败零 spawn
});

test('review-fix-loop v2：新参旧参同传 → 新参优先 + WARN 一行（D5）', async () => {
  writeV2Config();
  resetCalls();
  // batchN 与 reviewers 同传：batchN 优先，reviewers 忽略
  const r1 = await runReviewFixLoop({
    task: '新参优先演示', workdir: makeWorkdir('rfl-priority'),
    batch1: ['security'], reviewers: ['correctness'],
  });
  assert.equal(r1.loop.batches, 1);
  assert.deepEqual(r1.loop.reviewers, ['security']);
  assert.ok((r1.loop.warnings || []).some((w) => w.includes('batchN 优先') && w.includes('reviewers')));
  assert.ok(!readCalls().some((c) => c.prompt.includes('审查者「correctness」')));

  // target 系与 review-target 同传：新参优先
  resetCalls();
  const r2 = await runReviewFixLoop({
    task: 'target 优先演示', workdir: makeWorkdir('rfl-target-priority'),
    reviewers: ['security'],
    targetType: 'git-diff', target: 'main..HEAD', reviewTarget: 'README.md',
  });
  assert.equal(r2.loop.targetType, 'git-diff');
  assert.equal(r2.loop.target, 'main..HEAD');
  assert.ok((r2.loop.warnings || []).some((w) => w.includes('review-target 已忽略')));
  assert.ok(readCalls()[0].prompt.includes('main..HEAD'));
});

test('review-fix-loop v2：stuckThreshold 默认 3（D5）——连续 3 轮不降判 stuck', async () => {
  writeV2Config();
  resetCalls();
  fs.rmSync(STATE_FILE, { force: true });
  process.env.FAKE_DECLINE = '1';
  try {
    // 单审查者递减序列 must-fix：5,4,3,2,1,1,1,1 → r6/r7/r8 连续 3 轮不降
    // → 第 8 轮 stuck（r1-r7 各有 fix，r8 停在 review 后）
    const result = await runReviewFixLoop({
      task: '停滞检测默认阈值', reviewers: ['correctness'],
      workdir: makeWorkdir('rfl-stuck-default'),
    });
    assert.equal(result.loop.status, 'stuck');
    assert.equal(result.loop.rounds, 8);
    assert.equal(result.phases.length, 15); // r1..r7 各 review+fix，r8 仅 review
    assert.equal(result.loop.remainingCount, 1);
    assert.ok(result.final.includes('修复停滞'));
  } finally {
    delete process.env.FAKE_DECLINE;
  }
});

test('review-fix-loop v2：stuckThreshold 显式传 1 → 首个不降轮即 stuck（参数化生效）', async () => {
  writeV2Config();
  resetCalls();
  fs.rmSync(STATE_FILE, { force: true });
  process.env.FAKE_DECLINE = '1';
  try {
    // must-fix 5,4,3,2,1,1 → r6 首个不降轮（count 1 >= 1）即 stuck
    const result = await runReviewFixLoop({
      task: '停滞检测阈值一', reviewers: ['correctness'], stuckThreshold: 1,
      workdir: makeWorkdir('rfl-stuck-one'),
    });
    assert.equal(result.loop.status, 'stuck');
    assert.equal(result.loop.rounds, 6);
    assert.equal(result.phases.length, 11); // r1..r5 各 review+fix，r6 仅 review
  } finally {
    delete process.env.FAKE_DECLINE;
  }
});

test('review-fix-loop v2：manager 通道——_invokeEntry 注入 runId、_finalize 落 runDir 进 record', async () => {
  writeV2Config();
  resetCalls();
  const { RecordStore } = require('../lib/record-store');
  const outputs = require('../lib/output-store');
  const { MailboxNotifier } = require('../lib/notifier-mailbox');
  const { WorkflowManager } = require('../lib/workflow-manager');

  let entryRunId = null;
  const manager = new WorkflowManager({
    records: new RecordStore(),
    outputs,
    notifier: new MailboxNotifier(),
    workflows: {
      'review-fix-loop': async (opts) => {
        entryRunId = opts.runId; // 挂住入口实收的 runId（D4 注入通道）
        return runReviewFixLoop(opts);
      },
    },
  });
  const out = await manager.start(
    { workflow: 'review-fix-loop', task: 'manager 通道验证', workdir: makeWorkdir('rfl-mgr-channel'), reviewers: ['security'], wait: true },
    { cwd: TMP },
  );
  assert.equal(out.status, 'closed'); // security R1 clean → 整体 clean
  assert.match(out.runId, /^wf-/);
  // 入口收到的 runId === record id；_finalize 从结果取 runDir 落进 record
  assert.equal(entryRunId, out.runId);
  const rec = manager.records.get(out.runId);
  const expectedRunDir = path.join(TMP, 'zsub-root', 'rfl', out.runId);
  assert.equal(rec.runDir, expectedRunDir);
  assert.ok(fs.existsSync(rec.runDir));
  assert.ok(fs.existsSync(path.join(rec.runDir, 'state.json')));
});
