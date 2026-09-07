'use strict';

/**
 * runner-core 测试（回接计划 2c + W6a2 appserver 适配 + 2026-09 单一形态收口）：
 * zsw RunnerPort 在 core engine 上的实现面。
 *
 * 覆盖（V3-①②③ 的 fake engine 注入形态 + 端口契约）：
 * - start 成功 / 终态映射（closed / error / cancelled / timeout）
 * - AbortSignal 与 timeout 传播（fake engine 监听 ctx.signal 杀链合成）
 * - 路由三层优先级：调用参数 > frontmatter > 缺省 zcode（V3-①②）
 * - probe 失败 fallback 留痕 / 显式指定不兜底 / 显式 model 守卫（V3-③）
 * - resume 显式报错（core 面无 resume 入口） / alive pid 探活（旧 record 兼容） / release no-op
 * - denylist 并集去重（frontmatter disallowedTools + CLI toolDenylist）
 * - W6a2 appserver 适配面：onHandleReady 消费（sessionRef/sessionId/poolKey 回填）、
 *   alive 按 exec 形态分支、shutdown 对持有引擎实例 dispose
 * - 真 ZcodeEngine pre-abort 短路（不建连接不 spawn——单测零真实进程）
 *
 * 隔离原则：禁止真跑 zcode.cjs、禁止碰真实 ~/.zcode。ZSW_ROOT 指临时目录
 * （config.js 模块加载期冻结路径，env 必须先于 require 设置）。core 0.5.0 起
 * 单一 app-server 形态（共享宿主 HOME、poolKey 恒 'shared'）——旧 spawn 通路
 * （onChildSpawned/池 config 落点/XYZ_ZCODE_MODE 定向）测试随引擎删除。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-runner-core-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsw-root');

// env 隔离完成后才 require lib（config.js 模块加载期冻结路径）
const CoreRunner = require('../lib/runner-core');
const coreRef = require('../lib/core-ref');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// ------------------------------------------------------------ fake engine 工厂

/**
 * fake EnginePort（不经真实 spawn / 真实 probe）。模拟 core 0.5.0 单一 app-server
 * 形态：onPoolResolved('shared') + onHandleReady（create 应答时点，绝对 dbPath），
 * 不回调 onChildSpawned（常驻进程不进宿主记账——core D6 边界）。
 * @param {object} opts
 * @param {string} opts.id
 * @param {boolean} [opts.probeOk]        probe 报告成败（false = V3-③ probe 失败模拟）
 * @param {object} [opts.outcomeOverride] run 终态 outcome 覆盖段
 * @param {function(object, object): void} [opts.onRun] run 入参观察钩子（task/ctx 断言用）
 * @param {boolean} [opts.hang]           run 挂起直到 ctx.signal abort（取消/超时用例）
 */
function fakeEngine(opts = {}) {
  const id = opts.id || 'zcode';
  return {
    id,
    capabilities: () => ({}),
    async probe() {
      return opts.probeOk === false
        ? {
          ok: false,
          engineVersion: '',
          checks: [{ name: 'binary', ok: false, detail: 'zcode CLI 不存在（测试模拟）' }],
          error: { code: 'engine_probe_failed', recovery: 'recovery hint (fake)' },
        }
        : { ok: true, engineVersion: '0.16.5-fake', checks: [{ name: 'binary', ok: true }] };
    },
    run(task, ctx) {
      if (typeof opts.onRun === 'function') opts.onRun(task, ctx);
      ctx.onPoolResolved('shared');
      // session id 在 create 应答时点即确定（onHandleReady 与终态 outcome 同源）
      const sid = `sess-${id}`;
      // core §3.4 不变量 3：sessionRef 在 create 应答后回填（早于终态）；
      // dbPath 为宿主 HOME 绝对路径（共享 HOME 形态）
      ctx.onHandleReady({
        sessionRef: { dbPath: path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), sessionId: sid },
        poolKey: 'shared',
      });
      if (opts.hang) {
        return new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            resolve({
              handle: { data: { v: 1, engineId: id, sessionRef: {}, poolKey: 'shared', adapterVersion: 't' } },
              outcome: {
                engineId: id,
                content: '',
                error: 'engine_run_failed: zcode 任务被中止（杀链 SIGTERM→5000ms→SIGKILL，宿主合成终态）。stdout 尾部: …',
                exitCode: null,
              },
            });
          }, { once: true });
        });
      }
      const outcome = {
        engineId: id,
        content: `resp-from-${id}`,
        sessionId: sid,
        usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 18, turns: 2 },
        ...(opts.outcomeOverride || {}),
      };
      return Promise.resolve({ handle: { data: { v: 1, engineId: id, sessionRef: {}, poolKey: 'shared', adapterVersion: 't' } }, outcome });
    },
    async interact() { return { ok: false, code: 'engine_capability_unsupported', message: 'fake' }; },
    async read() { return { engineId: id, turns: [], source: 'outcome-only' }; },
  };
}

/** 宿主 zcode 会话 db 绝对路径断言基准（与 core hostZcodeDbPath 同构推导）。 */
const HOST_DB = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');

/** 最小 taskCtx（runner-core 消费面）。 */
function taskCtx(patch = {}) {
  return {
    subagentId: 'sa-test0001',
    slug: 'runner-core-test',
    prompt: '任务正文（buildPrompt 已拼装）',
    cwd: TMP,
    modelRef: undefined,
    timeoutMs: null,
    conversation: false,
    ...patch,
  };
}

// ------------------------------------------------------------ start / 终态映射

test('start hooks.onExec：字段就绪时回调浅拷贝快照（早期快照不被后续回填串改）', async () => {
  const seen = [];
  const runner = new CoreRunner({ engines: new Map([['zcode', fakeEngine()]]) });
  const handle = runner.start(taskCtx(), { onExec: (snap) => seen.push(snap) });
  await handle.done;
  // 顺序：engineId（路由后）→ poolKey（onPoolResolved）→ sessionRef（onHandleReady）
  // → sessionId（done 前 outcome 回填）
  assert.ok(seen.length >= 4, `onExec 至少 4 次（各字段就绪各一次），实际 ${seen.length}`);
  const first = seen[0];
  assert.equal(first.engineId, 'zcode');
  assert.equal(first.sessionId, undefined, '首个快照在 create 前（running 事件同款形态：无 session）');
  const last = seen[seen.length - 1];
  assert.equal(last.sessionId, 'sess-zcode');
  assert.equal(last.engineId, 'zcode');
  assert.equal(last.poolKey, 'shared');
  assert.deepEqual(last.sessionRef, { dbPath: HOST_DB, sessionId: 'sess-zcode' });
  // 快照拷贝证据：与 exec 非同引用，且后续回填（sessionId）不串入早期快照
  assert.ok(seen.every((s) => s !== handle.exec), '快照必须是拷贝而非 exec 引用');
  assert.equal(first.sessionId, undefined, 'done 后 exec.sessionId 回填不得串改已发出的快照');
  // 钩子抛错不炸穿执行体（终态 exec 重写兜底）
  const runner2 = new CoreRunner({ engines: new Map([['zcode', fakeEngine()]]) });
  const r2 = await runner2.start(taskCtx(), {
    onExec: () => { throw new Error('落盘失败（测试模拟）'); },
  }).done;
  assert.equal(r2.status, 'closed', 'onExec 异常不得影响任务终态');
});

test('start 成功：closed + usage snake_case 映射 + exec 回填（sessionId/engineId/poolKey/sessionRef）', async () => {
  const runner = new CoreRunner({ engines: new Map([['zcode', fakeEngine()]]) });
  const handle = runner.start(taskCtx());
  const result = await handle.done;
  assert.equal(result.status, 'closed');
  assert.equal(result.response, 'resp-from-zcode');
  assert.equal(result.sessionId, 'sess-zcode');
  assert.equal(result.engineId, 'zcode');
  assert.deepEqual(result.usage, {
    input_tokens: 11, output_tokens: 7, cache_read_tokens: 0, cache_write_tokens: 0, turns: 2,
  });
  // exec 可变引用回填（manager 侧随 running 事件持久化、done 后读 sessionId）
  assert.equal(handle.exec.kind, 'appserver', '单一 app-server 形态基线（恒 appserver，无翻转）');
  assert.equal(handle.exec.pid, undefined, '常驻进程不经 onChildSpawned（pid 恒空）');
  assert.equal(handle.exec.sessionId, 'sess-zcode');
  assert.equal(handle.exec.engineId, 'zcode');
  assert.equal(handle.exec.poolKey, 'shared');
  assert.deepEqual(handle.exec.sessionRef, { dbPath: HOST_DB, sessionId: 'sess-zcode' });
});

test('start 运行中失败：outcome.error → status=error（无 abortCause 时不冒充超时/取消）', async () => {
  const runner = new CoreRunner({
    engines: new Map([['zcode', fakeEngine({ outcomeOverride: { error: 'engine_run_failed: 非零退出', content: '部分输出' } })]]),
  });
  const result = await runner.start(taskCtx()).done;
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'engine_run_failed: 非零退出');
  assert.equal(result.response, '部分输出');
});

test('cancel：AbortSignal 传播到 core RunContext，杀链终态映射 cancelled', async () => {
  const seen = {};
  const runner = new CoreRunner({
    engines: new Map([['zcode', fakeEngine({ hang: true, onRun: (t, c) => { seen.signal = c.signal; } })]]),
  });
  const handle = runner.start(taskCtx({ timeoutMs: null }));
  await sleep(30); // 等 run 进入挂起段（signal listener 已挂）
  assert.ok(seen.signal && !seen.signal.aborted, 'run 期拿到未中止的 AbortSignal');
  handle.cancel();
  const result = await handle.done;
  assert.equal(result.status, 'cancelled');
  assert.match(result.error, /中止/);
});

test('timeout：taskCtx.timeoutMs 计时 abort → status=timeout + 文案前置超时', async () => {
  const runner = new CoreRunner({ engines: new Map([['zcode', fakeEngine({ hang: true })]]) });
  const result = await runner.start(taskCtx({ timeoutMs: 60 })).done;
  assert.equal(result.status, 'timeout');
  assert.match(result.error, /任务超时/);
});

test('timeoutMs=null 不限时：done 前不挂计时器（挂起任务不因超时中止）', async () => {
  const runner = new CoreRunner({ engines: new Map([['zcode', fakeEngine({ hang: true })]]) });
  const handle = runner.start(taskCtx({ timeoutMs: null }));
  await sleep(80);
  assert.equal(handle.exec.sessionId, 'sess-zcode', '仍在运行（未被超时杀）');
  handle.cancel();
  assert.equal((await handle.done).status, 'cancelled');
});

test('start 参数校验：prompt 缺失同步抛可操作错误', () => {
  const runner = new CoreRunner({ engines: new Map([['zcode', fakeEngine()]]) });
  assert.throws(() => runner.start(taskCtx({ prompt: '' })), /taskCtx\.prompt 必填/);
});

// ------------------------------------------------------------ 路由三层优先级（V3-①②）

test('V3-① frontmatter engine 生效：agentEngine 路由到该引擎（留痕 engineId）', async () => {
  const runner = new CoreRunner({
    engines: new Map([['zcode', fakeEngine()], ['reviewer-eng', fakeEngine({ id: 'reviewer-eng' })]]),
  });
  const result = await runner.start(taskCtx({ agentEngine: 'reviewer-eng' })).done;
  assert.equal(result.status, 'closed');
  assert.equal(result.engineId, 'reviewer-eng', 'frontmatter engine 生效留痕');
  assert.equal(result.response, 'resp-from-reviewer-eng');
});

test('V3-② 调用参数显式覆盖 frontmatter：callEngine 优先', async () => {
  const runner = new CoreRunner({
    engines: new Map([['zcode', fakeEngine()], ['reviewer-eng', fakeEngine({ id: 'reviewer-eng' })]]),
  });
  const result = await runner.start(taskCtx({ engine: 'zcode', agentEngine: 'reviewer-eng' })).done;
  assert.equal(result.engineId, 'zcode', '调用参数覆盖 frontmatter');
});

test('三层皆缺省 → 缺省 zcode（zsw 语境 globalDefaultEngine，非 core 内置 pi）', async () => {
  const runner = new CoreRunner({ engines: new Map([['zcode', fakeEngine()]]) });
  const result = await runner.start(taskCtx()).done;
  assert.equal(result.engineId, 'zcode');
});

test('frontmatter engine 未注册：done reject 可操作错误（含已注册清单）', async () => {
  const runner = new CoreRunner({ engines: new Map([['zcode', fakeEngine()]]) });
  await assert.rejects(
    () => runner.start(taskCtx({ agentEngine: 'no-such-engine' })).done,
    (err) => {
      assert.match(err.message, /no-such-engine/);
      assert.match(err.message, /Registered engines: zcode/);
      return true;
    },
  );
});

// ------------------------------------------------------------ probe 失败 fallback（V3-③）

test('V3-③ frontmatter 来源 probe 失败 → fallback 缺省引擎 + engineFallback 留痕', async () => {
  const runner = new CoreRunner({
    engines: new Map([
      ['zcode', fakeEngine()],
      ['broken-eng', fakeEngine({ id: 'broken-eng', probeOk: false })],
    ]),
  });
  const result = await runner.start(taskCtx({ agentEngine: 'broken-eng' })).done;
  assert.equal(result.status, 'closed', 'fallback 引擎正常完成');
  assert.equal(result.engineId, 'zcode');
  assert.deepEqual(result.engineFallback, { from: 'broken-eng', reason: 'engine_probe_failed' });
});

test('V3-③ 调用参数显式指定 probe 失败 → 不兜底，reject engine_probe_failed', async () => {
  const runner = new CoreRunner({
    engines: new Map([
      ['zcode', fakeEngine()],
      ['broken-eng', fakeEngine({ id: 'broken-eng', probeOk: false })],
    ]),
  });
  await assert.rejects(
    () => runner.start(taskCtx({ engine: 'broken-eng' })).done,
    (err) => {
      assert.match(err.message, /engine_probe_failed/);
      return true;
    },
  );
});

test('V3-③ 显式 model + probe 失败换引擎 → 守卫 c 拒绝（model_not_available）', async () => {
  const runner = new CoreRunner({
    engines: new Map([
      ['zcode', fakeEngine()],
      ['broken-eng', fakeEngine({ id: 'broken-eng', probeOk: false })],
    ]),
  });
  await assert.rejects(
    () => runner.start(taskCtx({ agentEngine: 'broken-eng', modelRef: 'builtin:bigmodel-coding-plan/GLM-5.3' })).done,
    (err) => {
      assert.match(err.message, /model_not_available/);
      return true;
    },
  );
});

// ------------------------------------------------------------ denylist / probe / resume / alive

test('denylist 并集去重：frontmatter disallowedTools + CLI toolDenylist → task.denyTools', async () => {
  let seenTask = null;
  const runner = new CoreRunner({
    engines: new Map([['zcode', fakeEngine({ onRun: (t) => { seenTask = t; } })]]),
  });
  await runner.start(taskCtx({
    disallowedTools: ['Bash', 'WebSearch', ''],
    toolDenylist: ['Bash', 'Read'],
  })).done;
  assert.deepEqual(seenTask.denyTools, ['Bash', 'WebSearch', 'Read']);
  // schema 刻意不透传：zsw 契约面（prompt 段 + jsonout 提取）保持壳层
  assert.equal(seenTask.schema, undefined);
  assert.equal(seenTask.conversation, undefined, 'conversation 不透传（engine prepare 期会拒绝）');
});

test('task 形状 = core AgentCallOpts 契约：prompt 非空、无旧 task 字段（0.6.0 u-3b 收敛回归防护）', async () => {
  // 回归锚：vendored 0.5.1+ 起 core buildPrompt 读 task.prompt（旧 AgentTaskSpec 的
  // task.task 字段已废弃）。若 spec 仍传旧字段名，core 拼出空 prompt → runTurn 空投递
  // 守卫 → 首轮误分类 conn-closed + 重试同败（2026-09-08 真机 smoke 实证；mock 单测
  // 与符号探针盖不住这类运行时字段契约漂移，本断言是唯一静态防线）
  let seenTask = null;
  const runner = new CoreRunner({
    engines: new Map([['zcode', fakeEngine({ onRun: (t) => { seenTask = t; } })]]),
  });
  await runner.start(taskCtx({ prompt: '任务书正文' })).done;
  assert.equal(typeof seenTask.prompt, 'string', 'prompt 必须为字符串（AgentCallOpts.prompt）');
  assert.ok(seenTask.prompt.length > 0, 'prompt 非空——空值会在 core runTurn 空投递守卫炸穿');
  assert.equal(seenTask.prompt, '任务书正文');
  assert.equal(seenTask.task, undefined, '旧 AgentTaskSpec.task 字段不得回潮（core 0.6.0 不再消费）');
  assert.equal(seenTask.description, 'runner-core-test', 'description=slug 锚定——丢键则超时文案回退 slug=unknown');
});

test('probe()：透传 core ProbeReport（ok + engineVersion → protocolVersion）', async () => {
  const runner = new CoreRunner({ engines: new Map([['zcode', fakeEngine()]]) });
  const report = await runner.probe();
  assert.equal(report.ok, true);
  assert.equal(report.protocolVersion, '0.16.5-fake');
});

test('resume：显式报可操作错误（core EnginePort 面无 resume 入口）', () => {
  const runner = new CoreRunner({ engines: new Map([['zcode', fakeEngine()]]) });
  assert.throws(
    () => runner.resume({ kind: 'appserver', sessionId: 'sess-zcode' }, '续聊'),
    (err) => {
      assert.match(err.message, /无 resume 入口/);
      assert.match(err.message, /重新 start/);
      assert.match(err.message, /P3/);
      return true;
    },
  );
});

test('alive：旧 record 的 spawn 形态 pid 探活兼容（活进程 true / 死 pid false / 非法句柄 false）', () => {
  const runner = new CoreRunner({ engines: new Map([['zcode', fakeEngine()]]) });
  // 旧 records（池化时代 exec.kind='spawn'）的兼容读取面——新引擎不再产生 spawn 形态
  // V5e 收口：spawn 分支调 core isProcessAlive（kill 0 成功→true / EPERM→true /
  // 其余→false）——本用例活/死 pid 两态即改调等值回归锚
  assert.equal(runner.alive({ kind: 'spawn', pid: process.pid }), true);
  // PID 上限内大概率不存在（macOS pid_max 默认 99999；取 99998 避开自身）
  assert.equal(runner.alive({ kind: 'spawn', pid: 99998 }), false);
  assert.equal(runner.alive({ kind: 'spawn', pid: undefined }), false);
  assert.equal(runner.alive(null), false);
});

test('release：no-op 不抛（无 per-record 驻留对应物）', () => {
  const runner = new CoreRunner({ engines: new Map([['zcode', fakeEngine()]]) });
  assert.doesNotThrow(() => runner.release({ kind: 'appserver' }));
});

test('capabilities：单一形态台账基线（kind=appserver / steering=none）', () => {
  const runner = new CoreRunner({ engines: new Map([['zcode', fakeEngine()]]) });
  const caps = runner.capabilities();
  assert.equal(caps.kind, 'appserver');
  assert.equal(caps.steering, 'none');
  assert.ok(Number.isFinite(caps.coldStartMs));
});

// ------------------------------------------------------------ W6a2：appserver 适配面

test('onHandleReady 消费：sessionRef/sessionId/poolKey 回填 + onExec 快照含回填', async () => {
  const seen = [];
  const runner = new CoreRunner({ engines: new Map([['zcode', fakeEngine()]]) });
  const handle = runner.start(taskCtx(), { onExec: (snap) => seen.push(snap) });
  const result = await handle.done;
  assert.equal(result.status, 'closed');
  assert.equal(handle.exec.kind, 'appserver', '单一形态基线（无翻转语义）');
  assert.equal(handle.exec.pid, undefined, 'appserver 常驻进程不经 onChildSpawned（core D6 边界，pid 恒空）');
  assert.equal(handle.exec.sessionId, 'sess-zcode');
  assert.deepEqual(handle.exec.sessionRef, { dbPath: HOST_DB, sessionId: 'sess-zcode' });
  assert.equal(handle.exec.poolKey, 'shared');
  // 回填快照必须进 onExec 流（manager 据此追加 update 事件——重启后 recover
  // 读磁盘 exec 的依据，A5 同款通道）
  const withRef = seen.find((s) => s.sessionRef && s.sessionRef.sessionId === 'sess-zcode');
  assert.ok(withRef, 'onExec 快照流包含 sessionRef 回填后形态');
  assert.deepEqual(withRef.sessionRef, { dbPath: HOST_DB, sessionId: 'sess-zcode' });
  assert.ok(seen.every((s) => s !== handle.exec), '快照必须是拷贝而非 exec 引用');
});

test('alive：exec 形态分支——appserver 保守存活（无 pid 语义），spawn pid 探活兼容不变', () => {
  const runner = new CoreRunner({ engines: new Map([['zcode', fakeEngine()]]) });
  assert.equal(
    runner.alive({ kind: 'appserver', sessionRef: { dbPath: HOST_DB, sessionId: 's' }, poolKey: 'shared' }),
    true,
    'appserver 形态保守存活（core 未暴露任务级探活面，recover 语境=orphan 处置）',
  );
  assert.equal(runner.alive({ kind: 'appserver' }), true, '无 sessionRef 也不影响形态判定');
  // 旧 record spawn 回归锚点（与既有 alive 用例互补：分支重构后旧语义逐项不变）
  assert.equal(runner.alive({ kind: 'spawn', pid: process.pid }), true);
  assert.equal(runner.alive({ kind: 'spawn', pid: 99998 }), false);
  assert.equal(runner.alive({ kind: 'spawn', pid: undefined }), false);
  assert.equal(runner.alive({ kind: 'unknown-kind', pid: process.pid }), false, '未知形态不猜（守卫）');
  assert.equal(runner.alive(null), false);
});

test('shutdown：对本层持有引擎实例逐个 dispose（appserver 常驻收割）+ 无 dispose 成员引擎跳过不炸', async () => {
  const disposed = [];
  const residentEng = fakeEngine();
  residentEng.dispose = async () => { disposed.push('zcode'); };
  const plainEng = fakeEngine({ id: 'plain-eng' }); // 无 dispose 成员（无常驻资源形态）
  const runner = new CoreRunner({ engines: new Map([['zcode', residentEng], ['plain-eng', plainEng]]) });
  await runner.shutdown();
  assert.deepEqual(disposed, ['zcode'], '仅持常驻资源的引擎被 dispose');
  // 二次触发不炸：幂等是 EnginePort.dispose 的契约（重复调用零副作用），
  // zsw 侧每次 shutdown 都触发——fake 的记录器如实计数两次
  await runner.shutdown();
  assert.equal(disposed.length, 2, '二次 shutdown 重复触发但不抛（幂等归引擎契约）');
});

test('shutdown：dispose 抛错不炸穿（best-effort 继续 killAll 兜底）', async () => {
  const eng = fakeEngine();
  eng.dispose = async () => { throw new Error('dispose 失败（测试模拟）'); };
  const runner = new CoreRunner({ engines: new Map([['zcode', eng]]) });
  await assert.doesNotReject(() => runner.shutdown());
});

// ------------------------------------------------------------ 真 ZcodeEngine 短路行为（零真实进程）

test('pre-abort 短路：不建连接、不 spawn、无句柄回填（真 ZcodeEngine，单测零进程）', async () => {
  const core = coreRef.requireCore();
  const engine = core.createZcodeEngine({
    engineDataDir: () => process.env.ZSW_ROOT,
  });
  const ac = new AbortController();
  ac.abort();
  const calls = { child: 0, handleReady: 0, pool: 0 };
  const { outcome } = await engine.run(
    { task: 't', slug: 's', cwd: TMP },
    {
      taskId: 'sa-pin-ap-abort', poolKey: 'shared', signal: ac.signal,
      onChildSpawned: () => { calls.child += 1; },
      onHandleReady: () => { calls.handleReady += 1; },
      onPoolResolved: () => { calls.pool += 1; },
    },
  );
  // pre-abort 短路：合成中止终态，不触发连接/进程——单测环境零真实进程即可
  // 验证。pool:1：pre-abort 分支有意先回调 onPoolResolved 再合成中止终态——
  // 不变量 3 要求 pool 解析先于首个事件 emit，否则中止终态 error 事件落
  // shared 占位池、与 handle.poolKey 漂移（core 侧语义，本断言锚定）
  assert.equal(outcome.exitCode, null);
  assert.match(outcome.error, /中止/);
  assert.deepEqual(calls, { child: 0, handleReady: 0, pool: 1 });
});
