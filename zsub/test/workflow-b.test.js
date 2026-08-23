'use strict';

/**
 * 第二批 workflow（scatter-gather / review-fix-loop）移植测试。
 *
 * 隔离原则同 workflow-base.test.js：禁止真跑 zcode、禁止碰真实 ~/.zcode。
 * - fake CLI 按 --prompt 关键词分支返回不同响应：scatter 者/处理者/gather 者/
 *   审查者「correctness」/修复者，覆盖两个 workflow 的全部阶段形态。
 * - env 开关：FAKE_GARBAGE（输出非 JSON）、FAKE_SCATTER_BAD（scatter 无 json 块）、
 *   FAKE_DECLINE（review 恒不 clean 且 must-fix 数逐次严格递减 5→1——避开停滞
 *   检测的 stuck 路径，专门走满默认 maxRounds=5 熔断）。
 * - FAKE_CALL_LOG 记录每次调用的完整 prompt 供跨阶段断言（子任务分发/收全/fix 输入）；
 *   FAKE_STATE_FILE 存递减计数（子进程间无共享内存，计数必须落盘）。
 * - workdir 一律临时目录：review-fix-loop 的 fix 阶段会写工作目录，scatter-gather
 *   的 process 阶段同样允许写文件。
 * - ZSUB_ROOT/ZCODE_MAILBOX_ROOT/HOME 必须在 require 任何 lib 前设置（config 冻结路径）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-wfb-'));
process.env.ZSUB_ROOT = path.join(TMP, 'zsub-root');
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
  "  if (process.env.FAKE_DECLINE === '1') {",
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
process.env.ZSUB_ZCODE_CLI = FAKE_CLI;
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
  assert.ok(md.includes('# zsub · scatter-gather 报告'));
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
  assert.equal(result.phases.length, 5); // R1 双审 + fix + R2 双审（fix 后 clean 集清空，全员重审）
  assert.ok(result.phases.every((p) => p.ok));

  // fix 阶段确实被调用，且收到聚合后的 must-fix
  const fix = result.phases.find((p) => p.phase === 'fix');
  assert.ok(fix);
  assert.equal(fix.label, 'R1 修复 (1 项)');
  const fixCall = readCalls().find((c) => c.prompt.includes('修复者'));
  assert.ok(fixCall.prompt.includes('样例逻辑错误'));

  assert.ok(result.final.includes('## 审查通过'));
  assert.ok(result.sections[0].body.includes('must-fix 1 个'));
  assert.equal(result.error, undefined);

  // 报告条目冒烟：轮次摘要段 + 阶段表末行
  const md = report.buildMarkdownReport(result);
  assert.ok(md.includes('## 轮次摘要'));
  assert.ok(md.includes('| 5 | review |'));
});

test('review-fix-loop：恒不 clean 且逐轮递减 → 默认 maxRounds=5 熔断 → fixed-unverified', async () => {
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
    });
    assert.equal(result.model, MODEL_REF);
    assert.equal(result.ok, false);
    // 默认 maxRounds=5 熔断：走满 5 轮、最后一轮 fix 成功且未复核 → 源语义的细分终态
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
