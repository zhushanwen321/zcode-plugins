'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'zdg.js');
const HOOKS_JSON = path.join(__dirname, '..', 'hooks', 'hooks.json');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 端到端跑 hook 子进程：env 注入隔离目录与会话 id，stdin 喂 hook 输入 JSON
function runHook(env, stdin) {
  return spawnSync(process.execPath, [BIN, ...env.zdgArgs], {
    encoding: 'utf8',
    input: stdin == null ? '' : stdin,
    env: Object.assign({}, process.env, {
      ZDG_DATA_DIR: env.dataDir,
      ZDG_FINGERPRINT_ROOT: env.fingerprintRoot,
      CLAUDE_SESSION_ID: env.sessionId || 'sess-test',
    }, env.extraEnv || {}),
  });
}

function writeStatus(root, taskDir, name, doc) {
  const dir = path.join(root, taskDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(doc) + '\n');
}

test('无标记会话 guard 放行（前置 subagent 不误杀）', () => {
  const dataDir = tmpDir('zdg-h-data-');
  const fpRoot = tmpDir('zdg-h-fp-');
  try {
    const r = runHook({ zdgArgs: ['hook', 'guard'], dataDir, fingerprintRoot: fpRoot }, '');
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(fpRoot, { recursive: true, force: true });
  }
});

test('指纹 mark → 指向在途任务的派发被拦（exit 2 带恢复动作）；无关派发与 waive 后放行', () => {
  const dataDir = tmpDir('zdg-h-data-');
  const fpRoot = tmpDir('zdg-h-fp-');
  try {
    writeStatus(fpRoot, 'Task-a', 'main.status.json', { name: 'main-flow', nodes: { U1: { status: 'in-progress' } }, events: [] });
    const markStdin = JSON.stringify({
      session_id: 'sess-test',
      tool_name: 'Read',
      tool_input: { file_path: '/Users/x/.agents/skill-data/dev-flow/Task-a/main.status.json' },
    });
    const mark = runHook({ zdgArgs: ['hook', 'mark'], dataDir, fingerprintRoot: fpRoot }, markStdin);
    assert.strictEqual(mark.status, 0);

    // 派发内容指向在途任务（prompt 含任务目录名）→ 拦
    const guard1 = runHook(
      { zdgArgs: ['hook', 'guard'], dataDir, fingerprintRoot: fpRoot },
      JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', description: '执行任务书', prompt: '执行 U4 任务书全文，产物在 ~/.agents/skill-data/dev-flow/Task-a/ 下' } })
    );
    assert.strictEqual(guard1.status, 2);
    assert.ok(guard1.stderr.includes('CreateWorkflow'));
    assert.ok(guard1.stderr.includes('Task-a'));
    assert.ok(guard1.stderr.includes('.waive'));

    // 同一会话派发无关任务（subagent 类型名任意）→ 放行
    const guardUnrelated = runHook(
      { zdgArgs: ['hook', 'guard'], dataDir, fingerprintRoot: fpRoot },
      JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', description: '重构日志模块', prompt: '把 plugins 仓的日志调用统一成单一入口' } })
    );
    assert.strictEqual(guardUnrelated.status, 0);

    const waived = runHook({ zdgArgs: ['waive'], dataDir, fingerprintRoot: fpRoot }, '');
    assert.strictEqual(waived.status, 0);
    const guard2 = runHook(
      { zdgArgs: ['hook', 'guard'], dataDir, fingerprintRoot: fpRoot },
      JSON.stringify({ tool_name: 'Agent', tool_input: { prompt: '继续 Task-a 任务书' } })
    );
    assert.strictEqual(guard2.status, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(fpRoot, { recursive: true, force: true });
  }
});

test('任务全终局后 guard 放行', () => {
  const dataDir = tmpDir('zdg-h-data-');
  const fpRoot = tmpDir('zdg-h-fp-');
  try {
    writeStatus(fpRoot, 'Task-a', 'main.status.json', {
      nodes: { U1: { status: 'done' } },
      events: [{ node: '-', event: 'run-terminal', detail: 'terminated=1' }],
    });
    const markStdin = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'cat ~/.agents/skill-data/dev-flow/Task-a/ledger.md' },
    });
    assert.strictEqual(runHook({ zdgArgs: ['hook', 'mark'], dataDir, fingerprintRoot: fpRoot }, markStdin).status, 0);
    const g = runHook({ zdgArgs: ['hook', 'guard'], dataDir, fingerprintRoot: fpRoot }, '');
    assert.strictEqual(g.status, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(fpRoot, { recursive: true, force: true });
  }
});

test('user-prompt-submit 打标记；Skill(dev-flow-wf) 打标记', () => {
  const dataDir = tmpDir('zdg-h-data-');
  const fpRoot = tmpDir('zdg-h-fp-');
  try {
    assert.strictEqual(runHook({ zdgArgs: ['hook', 'user-prompt-submit'], dataDir, fingerprintRoot: fpRoot }, '').status, 0);
    const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'sess-test.json'), 'utf8'));
    assert.deepStrictEqual(st.sources, ['user-prompt']);

    const skillStdin = JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'dev-flow-wf', args: '继续 D2' } });
    assert.strictEqual(runHook({ zdgArgs: ['hook', 'mark'], dataDir, fingerprintRoot: fpRoot }, skillStdin).status, 0);
    const st2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'sess-test.json'), 'utf8'));
    assert.ok(st2.sources.includes('skill'));
    assert.deepStrictEqual(st2.taskDirs, []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(fpRoot, { recursive: true, force: true });
  }
});

test('并行会话隔离：A 会话标记不影响 B 会话派发', () => {
  const dataDir = tmpDir('zdg-h-data-');
  const fpRoot = tmpDir('zdg-h-fp-');
  try {
    writeStatus(fpRoot, 'Task-a', 'main.status.json', { nodes: { U1: { status: 'pending' } }, events: [] });
    const markStdin = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: '/x/skill-data/dev-flow/Task-a/main.status.json' },
    });
    runHook({ zdgArgs: ['hook', 'mark'], dataDir, fingerprintRoot: fpRoot, sessionId: 'sess-A' }, markStdin);
    const guardB = runHook({ zdgArgs: ['hook', 'guard'], dataDir, fingerprintRoot: fpRoot, sessionId: 'sess-B' }, '');
    assert.strictEqual(guardB.status, 0);
    const guardA = runHook(
      { zdgArgs: ['hook', 'guard'], dataDir, fingerprintRoot: fpRoot, sessionId: 'sess-A' },
      JSON.stringify({ tool_name: 'Agent', tool_input: { prompt: '继续 Task-a 的任务书' } })
    );
    assert.strictEqual(guardA.status, 2);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(fpRoot, { recursive: true, force: true });
  }
});

test('无头嵌套会话直接放行', () => {
  const dataDir = tmpDir('zdg-h-data-');
  const fpRoot = tmpDir('zdg-h-fp-');
  try {
    writeStatus(fpRoot, 'Task-a', 'main.status.json', { nodes: { U1: { status: 'pending' } }, events: [] });
    const markStdin = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: '/x/skill-data/dev-flow/Task-a/main.status.json' },
    });
    runHook({ zdgArgs: ['hook', 'mark'], dataDir, fingerprintRoot: fpRoot, sessionId: 'sess-A' }, markStdin);
    const nested = runHook(
      { zdgArgs: ['hook', 'guard'], dataDir, fingerprintRoot: fpRoot, sessionId: 'sess-A', extraEnv: { ZSW_NESTED: '1' } },
      ''
    );
    assert.strictEqual(nested.status, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(fpRoot, { recursive: true, force: true });
  }
});

test('stdin 打开却不写不关时 250ms 内自行退出，不挂死工具调用', () => {
  const dataDir = tmpDir('zdg-h-data-');
  const fpRoot = tmpDir('zdg-h-fp-');
  try {
    for (const args of [['hook', 'mark'], ['hook', 'guard']]) {
      const t0 = Date.now();
      const child = spawnSync(process.execPath, [BIN, ...args], {
        encoding: 'utf8',
        // stdin 是 pipe：spawnSync 不写 input 也不主动关闭子进程 stdin 读端
        env: Object.assign({}, process.env, {
          ZDG_DATA_DIR: dataDir,
          ZDG_FINGERPRINT_ROOT: fpRoot,
          CLAUDE_SESSION_ID: 'sess-nostdin',
        }),
        timeout: 5000,
      });
      const elapsed = Date.now() - t0;
      assert.strictEqual(child.status, 0, `${args.join(' ')} 应以 0 退出`);
      assert.ok(elapsed < 2000, `${args.join(' ')} 应限时退出，实际 ${elapsed}ms`);
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(fpRoot, { recursive: true, force: true });
  }
});

test('hooks.json 的 matcher 正则可编译且命中预期样例（无效正则会静默失配）', () => {
  const hooks = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  const promptMatcher = hooks.hooks.UserPromptSubmit[0].matcher;
  const re = new RegExp(promptMatcher);
  for (const hit of ['执行 dev-flow-wf', 'Dev-Flow 继续', 'dev_flow 任务', '用 devflow 跑']) {
    assert.ok(re.test(hit), '应命中: ' + hit);
  }
  for (const miss of ['继续', '帮我看看 stocks 仓库', 'tech-design 审查']) {
    assert.strictEqual(re.test(miss), false, '不应命中: ' + miss);
  }
  const preMatchers = hooks.hooks.PreToolUse.map((e) => e.matcher);
  assert.ok(preMatchers.some((m) => new RegExp(m).test('Agent')));
  assert.ok(preMatchers.some((m) => new RegExp(m).test('Task')));
  assert.ok(preMatchers.some((m) => new RegExp(m).test('Skill')));
  assert.ok(preMatchers.some((m) => new RegExp(m).test('Read') && new RegExp(m).test('Bash')));
});
