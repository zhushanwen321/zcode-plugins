'use strict';

/**
 * daemon/CLI/wait 机制链路 e2e（DESIGN-v4 §8 验收表可自动化部分，M0 = U6）。
 *
 * 为什么独立文件而不是扩展 test/e2e.test.js：
 * - 现有 e2e 是「测试进程内组 manager」形态；本文件全部场景是「真实 daemon
 *   进程（spawn dist/mcp/server.js，走 main 启动序列的锁竞选）+ CLI 子进程
 *   （bin/zsw.jsthin client）」的多进程形态，基建（spawn/就绪探测/
 *   场景级 kill 收尾）完全不同；
 * - 场景级隔离（每场景独立 ZSW_ROOT + ZSW_SOCK 临时目录）：daemon 的
 *   lock/sock 与 records 事件流天然按场景分域，互不污染（现有 e2e 共享一个
 *   ZSW_ROOT 的前提是单 manager 进程内消费，这里不成立）；
 * - 对现有 e2e 零改动 = 预检（验收标准 1）由构造保证。
 *
 * 场景 ↔ DESIGN-v4 §8 验收表映射（「机制版」= daemon 竞选与 CLI 走真实代码
 * 路径；agent 行为选择不在 e2e 范围——A1/A3 的 idle 唤醒段留 GUI 人工）：
 * - A7  嵌套拒绝：ZSW_NESTED=1 下 CLI立即 exit 1 + 可操作文案（零模型）
 * - A1 前半（wait 半程）：start--wait 阻塞到完成退出，stdout JSON
 *   含 subagentId/status/outputFile——这正是未来配 run_in_background 后
 *   task-notification 携带的内容，链路正确性在此验证
 * - A2 机制版：异步 start ×2 立即回句柄 + 聚合 wait 保序回两条终态
 * - A4 机制版：3 槽占满后 start 句柄立即返回且 record 停在 created（排队可见）
 * - A5 机制版 ×2 形态（W6a2 后 core engine 缺省 appserver 常驻，per-task 形态
 *   靠 XYZ_ZCODE_MODE 定向钉死，各自确定性验证）：
 *   - A5（spawn 定向）：SIGKILL daemon → standby 看门狗接管 → status 带
 *     lost/orphan 与重发指引；victim 断言走 exec.pid 整数通路（旧语义回归锚点）
 *   - A5-b（appserver 定向）：同款接管编舞；victim 断言走 W6a2 消费链产物
 *     （exec.kind='appserver' + sessionRef 回填、pid 恒空、保守探活 orphan 分流），
 *     孤儿常驻进程按 core D6③ pidfile 手工收割
 *
 * env 隔离纪律（与现有 e2e 同款，差异点如实声明）：
 * - ZSW_ROOT/ZSW_MAILBOX_ROOT/ZSW_SOCK 全落场景级 mkdtemp 临时目录；
 * - HOME 刻意【不】改：daemon 子进程的 config.V2_CONFIG_PATH 在模块加载期
 *   冻结自真实 HOME，真实模型凭据来自那里；
 * - ZCODE_MESSAGE_ENABLED=1：与真实部署一致（mailbox 档）。socket 面任务无
 *   targetSessionId（D6），完成通知按 notifier 的 target 缺失分支静默跳过——
 *   这是设计预期，场景断言不依赖 mailbox；
 * - ZSW_NESTED 全程不设（daemon 不参与嵌套门禁）；仅 A7 的 CLI 子进程显式注入。
 *
 * 成本纪律（真实模型，GLM-5.3）：任务书极简（「回复：<口令>」级）；A4/A5 的
 * 长任务沿用现有 e2e 的计数任务并在断言后立即 cancel/kill（早杀）；A7 零模型。
 * 配额窗口 gate 惰性触发（首个模型场景才探测）：窗口不开或无凭据 → 模型场景
 *   全部 t.skip（原因写清），A7 照常跑（不依赖凭据）——CI 无凭据环境因此
 *   天然 skip，不会红。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const REPO = path.resolve(__dirname, '..');
const SERVER_JS = path.join(REPO, 'dist', 'mcp', 'server.js');
const BIN = path.join(REPO, 'bin', 'zsw.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-e2e-daemon-'));

// 测试进程数据根隔离（config.zswRoot() 调用时读 env，gate 首次运行前生效即可）：
// modelGate 的 `new CoreRunner()` 配额探测会引导引擎池 HOME 目录——不隔离则落在
// 真实 ~/.zcode/zsw/engines/（凭据源 v2ConfigPath 冻结自真实 HOME，与 ZSW_ROOT
// 无关，隔离无副作用）。daemon 子进程另有场景级 env（newScenario）。
process.env.ZSW_ROOT = path.join(TMP, 'gate-zsw-root');

const MODEL = process.env.ZSW_E2E_MODEL || 'GLM-5.3'; // 真机模型可配置（与现有 e2e 同款约定）
const MODEL_REF = MODEL.includes('/') ? MODEL : `builtin:bigmodel-coding-plan/${MODEL}`;
const GAP_MS = Number(process.env.ZSW_E2E_GAP_MS || 20000);
const RETRY_WAIT_MS = Number(process.env.ZSW_E2E_RETRY_WAIT_MS || 45000);
const RETRY_MAX = Number(process.env.ZSW_E2E_RETRY_MAX || 2);
const CALL_MS = 150_000; // 单任务执行预算（与现有 e2e 一致）

/** 真实模型调用审计：结尾汇总（预算回溯用）。 */
const CALLS = { probes: 0, probeRetries: 0, starts: 0, retries: 0, killedEarly: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 限流等瞬时失败判定（与现有 e2e startWithRetry 同款口径）。 */
const isTransient = (errText, status) => /rate_limit|1302|429|超时|timeout|Turn execution failed/i.test(String(errText || ''))
  || status === 'timeout';

/** 轮询等待：fn 返回真值即返回该值。 */
async function waitFor(fn, timeoutMs, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await sleep(stepMs);
  }
}

/** sockPath 当前是否可连通（接管探测用，daemon-socket.test 同款）。 */
function canConnect(sockPath) {
  return new Promise((resolve) => {
    const s = net.connect(sockPath);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

// require 无 env 前置要求：config 冻结的 V2_CONFIG_PATH 来自真实 HOME，
// 这正是凭据来源（见文件头 env 纪律）。仅配额 gate 用，场景本体全走子进程。
// 回接 2c：spawn 驱动已删，探测走 core zcode engine（CoreRunner 真实例）。
const CoreRunner = require('../lib/runner-core');

/**
 * 配额/凭据 gate（惰性单例）：首个模型场景触发探测。返回 {ok, reason}。
 * - 无凭据（v2 config 缺 provider）：bootstrapIsolatedHome 抛可操作错误 →
 *   skip 而非 fail（CI 无凭据环境的预期形态）；
 * - 窗口不开：最多 3 次探测（现有 e2e 的 8 次在这里过度——本文件 gate 只做
 *   skip 决策，不值得为它烧长退避）。
 */
let gatePromise = null;
function modelGate() {
  if (gatePromise) return gatePromise;
  gatePromise = (async () => {
    // core 引擎的池引导在 run 内做（preparer）；缺凭据在首探即报可操作错误 → skip。
    // gate 结论即弃 runner：appserver 命中时常驻连接会挂住测试进程的事件循环
    // （子进程退出不波及常驻进程——与 CLI 进程内执行同款风险），shutdown 收割
    const runner = new CoreRunner();
    try {
      for (let i = 1; i <= 3; i++) {
        CALLS.probes += 1;
        const t0 = Date.now();
        let r;
        try {
          r = await runner.start({
            subagentId: `sa-gate-${i}`, slug: 'quota-gate',
            prompt: '回复：ok。不要做任何其他事。',
            cwd: TMP, modelRef: MODEL_REF, timeoutMs: 120_000, conversation: false,
          }).done;
        } catch (e) {
          return { ok: false, reason: `真实模型凭据不可用: ${e && e.message}` };
        }
        console.error(`[e2e-daemon] 配额窗口探测 #${i}: status=${r.status} elapsed=${Date.now() - t0}ms`);
        if (r.status === 'closed') return { ok: true };
        CALLS.probeRetries += 1;
        if (i < 3) await sleep(45_000);
      }
      return { ok: false, reason: `模型配额窗口不可用（${CALLS.probes} 次探测均非 closed，同账户桌面端持续占用或限流）` };
    } finally {
      try { await runner.shutdown(); } catch { /* best-effort 收割 */ }
    }
  })();
  return gatePromise;
}

/** 模型场景统一门：gate 不过即 skip（原因写清），代码路径不动。 */
async function requireModel(t) {
  const gate = await modelGate();
  if (!gate.ok) t.skip(`SKIP（真实模型场景）: ${gate.reason}。机制链路（daemon 竞选/CLI 协议）在 A7 零模型场景覆盖。`);
  return gate.ok;
}

/**
 * 场景脚手架：独立 ZSW_ROOT + ZSW_SOCK + proj 目录，子进程登记表 + t.after 收尾。
 * 每场景一个全新 daemon 域：lock/sock/records 互不可见（场景独立的物理基础）。
 */
function newScenario(t, name) {
  const dir = fs.mkdtempSync(path.join(TMP, `scen-${name}-`));
  const sockPath = path.join(dir, 'daemon.sock');
  const env = {
    ...process.env,
    ZSW_ROOT: path.join(dir, 'zsw-root'),
    ZSW_SOCK: sockPath,
    ZCODE_MAILBOX_ROOT: path.join(dir, 'mailbox'),
    ZCODE_MESSAGE_ENABLED: '1',
  };
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const children = new Set();
  t.after(async () => {
    // SIGKILL 兜底（正常路径各场景已自行优雅收尾；这里只管漏网进程）
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } }
    await sleep(200);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  });
  return {
    name,
    sockPath,
    lockPath: `${sockPath}.lock`,
    env,
    proj,
    track(c) { children.add(c); c.on('close', () => children.delete(c)); return c; },
  };
}

/**
 * 真实 daemon 宿主：spawn dist/mcp/server.js（main 启动序列全量：assemble →
 * recover → startDaemon 锁竞选），stdin 喂 initialize 握手保持与真实引擎一致
 * 的进程形态（stdin 常开是进程存活锚点——传输层 handle 全 unref）。
 * 就绪判据 = stderr 的「daemon 竞选完成：role=...」行（server.js main 原文）。
 */
function spawnMcpServer(sc, label) {
  const child = spawn(process.execPath, [SERVER_JS], {
    env: sc.env,
    cwd: sc.proj, // socket 面任务的 ctx.cwd 来源（daemon 侧 process.cwd()）
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  sc.track(child);
  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', () => {}); // 协议帧排水（防 pipe 背压），本文件不消费 MCP 面
  child.stderr.on('data', (d) => { stderrTail += d; });
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}\n');
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');

  const role = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[${label}] server 45s 内未完成 daemon 竞选。stderr 尾部: ${stderrTail.slice(-800)}`));
    }, 45_000);
    const check = () => {
      const m = stderrTail.match(/daemon 竞选完成：role=(daemon|standby)/);
      if (m) { clearTimeout(timer); resolve(m[1]); return; }
      if (/daemon socket 启动失败/.test(stderrTail)) {
        clearTimeout(timer);
        reject(new Error(`[${label}] daemon socket 启动失败: ${stderrTail.slice(-400)}`));
      }
    };
    child.stderr.on('data', check);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`[${label}] server 提前退出（code=${code} signal=${signal}）。stderr 尾部: ${stderrTail.slice(-800)}`));
    });
    check();
  });
  return { child, role, stderr: () => stderrTail };
}

/** CLI thin client 子进程调用：zsw <args>，超时 SIGKILL 兜底（wait 场景传大 timeoutMs）。 */
function runCli(sc, args, { timeoutMs = 60_000, envExtra } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: envExtra ? { ...sc.env, ...envExtra } : sc.env,
      cwd: sc.proj,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    sc.track(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`CLI 超时（${timeoutMs}ms）: zsw ${args.join(' ')}\nstdout: ${stdout.slice(0, 400)}\nstderr: ${stderr.slice(0, 400)}`));
      } else {
        resolve({ code, signal, stdout, stderr });
      }
    });
  });
}

/** CLI stdout 必须是单个合法 JSON（thin client 的输出契约）。 */
function jsonOf(r, what) {
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`${what}: stdout 非合法 JSON: ${r.stdout.slice(0, 300)}`);
  }
}

/** 等子进程退出，返回 {code, signal}。 */
function waitClose(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待进程 ${child.pid} 退出超时`)), timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

/**
 * appserver 常驻进程 pid（孤儿收割用）：读 core D6③ pidfile——落点
 * <ZSW_ROOT>/engines/zcode/<poolKey>/appserver.pid（core resolvePoolDir 布局；
 * 固定池 key 'home-appserver'，场景级全新 ZSW_ROOT 无锁竞争不派生后缀）。
 * 内容为 JSON {pid, startedAt, lstart?}。SIGKILL daemon 不波及常驻子进程
 * （spawn 形态按 exec.pid 手工收、appserver 形态按本 pidfile 手工收——同款
 * 「孤儿仍烧 token，手工收」语义）。
 */
function readAppServerPid(sc, poolKey = 'home-appserver') {
  const pidFile = path.join(sc.env.ZSW_ROOT, 'engines', 'zcode', poolKey, 'appserver.pid');
  try {
    const parsed = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    return Number.isInteger(parsed && parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

after(() => {
  console.error(`[e2e-daemon] 模型调用审计: probe=${CALLS.probes}（重试 ${CALLS.probeRetries}）`
    + ` start=${CALLS.starts}（重试 ${CALLS.retries}）killed-early=${CALLS.killedEarly}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// ------------------------------------------------------------------ A7（零模型）

test('A7 嵌套拒绝：ZSW_NESTED=1 下 CLI立即 exit 1 + 可操作文案，daemon 不受影响', async (t) => {
  const sc = newScenario(t, 'a7');
  const srv = spawnMcpServer(sc, 'a7');
  assert.equal(await srv.role, 'daemon', `首实例必须竞选成 daemon: ${srv.stderr().slice(-300)}`);

  // 嵌套门禁在 runDaemonCommand 入口第一道闸——先于任何 socket 交互
  const denied = await runCli(sc, ['list'], { envExtra: { ZSW_NESTED: '1' } });
  assert.equal(denied.code, 1, `exit 应为 1，实际 ${denied.code}（stderr: ${denied.stderr}）`);
  assert.match(denied.stderr, /嵌套环境禁止编排（防递归，ZSW_NESTED=1 或 XYZ_AGENT_SUBAGENT=1）/);
  assert.match(denied.stderr, /恢复指引/);
  assert.equal(denied.stdout, '', '拒绝路径不产生业务输出');

  // 同一 daemon 不受影响：非嵌套 CLI 正常服务（空库 list = []）
  const okRun = await runCli(sc, ['list']);
  assert.equal(okRun.code, 0, `stderr: ${okRun.stderr}`);
  assert.deepEqual(jsonOf(okRun, 'list'), []);

  // 退出卫生（机制附验）：SIGTERM daemon → exit 0 且 lock/sock 无残留
  srv.child.kill('SIGTERM');
  const closed = await waitClose(srv.child);
  assert.equal(closed.code, 0, `signal=${closed.signal}`);
  assert.ok(!fs.existsSync(sc.sockPath) && !fs.existsSync(sc.lockPath), '退出卫生后无 lock/sock 残留');
});

// ------------------------------------------------------------------ A1 前半（wait 半程）

test('A1 前半 wait 半程：start--wait 阻塞到完成退出，stdout JSON 含 subagentId/status/outputFile', async (t) => {
  if (!(await requireModel(t))) return;
  const sc = newScenario(t, 'a1w');
  const srv = spawnMcpServer(sc, 'a1w');
  assert.equal(await srv.role, 'daemon');

  const PASS = '芒果黄';
  let final = null;
  for (let attempt = 0; ; attempt++) {
    CALLS.starts += 1;
    const r = await runCli(sc, [
      'start', '--wait',
      '--task', `回复：${PASS}。不要做任何其他事。`,
      '--slug', `a1w-${attempt}`,
      '--model', MODEL,
      '--timeout-ms', String(CALL_MS),
    ], { timeoutMs: CALL_MS + 90_000 });
    // exit 2（partial）理论不可达（无 --timeout-ms 的 wait 无上限），防御性容忍后走重试诊断
    assert.ok(r.code === 0 || r.code === 2, `wait CLI exit=${r.code} stderr=${r.stderr.slice(0, 300)}`);
    const parsed = jsonOf(r, 'start --wait');
    const entry = parsed.results && parsed.results[0];
    assert.ok(entry && typeof entry.subagentId === 'string' && entry.subagentId.startsWith('sa-'),
      `results[0] 缺合法 subagentId: ${JSON.stringify(parsed)}`);
    if (entry.status === 'closed') { final = entry; break; }

    // 未 closed：拉 status 看原因；限流类瞬时失败按既有 e2e 纪律退避重试
    const diag = await runCli(sc, ['status', '--id', entry.subagentId]);
    const rec = jsonOf(diag, 'status');
    if (!isTransient(rec.error, entry.status) || attempt >= RETRY_MAX) {
      assert.fail(`任务未 closed（status=${entry.status}）: ${rec.error || JSON.stringify(rec).slice(0, 300)}`);
    }
    CALLS.retries += 1;
    console.error(`[e2e-daemon] A1w 第 ${attempt + 1} 次失败（${(rec.error || '').slice(0, 120)}），${RETRY_WAIT_MS}ms 后重试`);
    await sleep(RETRY_WAIT_MS);
  }

  // 「notification 携带内容」的链路契约：stdout 单 JSON，results[0] = 终态条目
  assert.equal(final.status, 'closed');
  assert.ok(final.outputFile, 'wait 结果必须带 outputFile');
  assert.ok(fs.existsSync(final.outputFile), `outputs 未落盘: ${final.outputFile}`);
  const text = fs.readFileSync(final.outputFile, 'utf8');
  assert.ok(text.includes(PASS), `subagent 输出应含口令「${PASS}」: ${text.slice(0, 200)}`);
  await sleep(GAP_MS);
});

// ------------------------------------------------------------------ A2 机制版

test('A2 机制版：异步 start ×2 立即回句柄，聚合 wait 保序回两条终态 + 两个 outputs 文件', async (t) => {
  if (!(await requireModel(t))) return;
  const sc = newScenario(t, 'a2');
  const srv = spawnMcpServer(sc, 'a2');
  assert.equal(await srv.role, 'daemon');

  const PASS_A = '柠檬黄';
  const PASS_B = '薄荷绿';
  let ids = null;
  let results = null;
  for (let attempt = 0; ; attempt++) {
    // 异步 start：句柄立即返回（elapsed 上限证明「不等完成」——完成至少要数秒）
    const starts = [];
    for (const [suffix, pass] of [['a', PASS_A], ['b', PASS_B]]) {
      CALLS.starts += 1;
      const t0 = Date.now();
      const r = await runCli(sc, [
        'start',
        '--task', `回复：${pass}。不要做任何其他事。`,
        '--slug', `a2-${attempt}-${suffix}`,
        '--model', MODEL,
        '--timeout-ms', String(CALL_MS),
      ]);
      const elapsed = Date.now() - t0;
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const h = jsonOf(r, `start ${suffix}`);
      assert.equal(h.status, 'running', '异步 start 句柄语义必须是 running');
      assert.ok(h.subagentId.startsWith('sa-'));
      assert.ok(elapsed < 15_000, `start 句柄应立即返回，实际 ${elapsed}ms（异步语义被破坏？）`);
      starts.push(h.subagentId);
    }
    ids = starts;

    // 聚合 wait：单 CLI 进程阻塞到两任务全终态（这正是配 run_in_background 的形态）
    const w = await runCli(sc, ['wait', '--id', ids[0], '--id', ids[1]], { timeoutMs: CALL_MS + 120_000 });
    assert.ok(w.code === 0 || w.code === 2, `wait CLI exit=${w.code} stderr=${w.stderr.slice(0, 300)}`);
    const parsed = jsonOf(w, 'wait');
    if (parsed.results && parsed.results.length === 2 && parsed.results.every((e) => e.status === 'closed')) {
      results = parsed;
      break;
    }
    if (attempt >= RETRY_MAX) {
      assert.fail(`聚合 wait 未拿到双 closed: ${JSON.stringify(parsed).slice(0, 400)}`);
    }
    CALLS.retries += 1;
    console.error(`[e2e-daemon] A2 第 ${attempt + 1} 次未全 closed（${JSON.stringify(parsed.results && parsed.results.map((e) => e.status))}），${RETRY_WAIT_MS}ms 后整场景重试`);
    await sleep(RETRY_WAIT_MS);
  }

  // 断言：两条、顺序保持 --id 入参序、各自 outputs 含口令
  assert.deepEqual(results.results.map((e) => e.subagentId), ids, '聚合结果必须保持 --id 入参顺序');
  assert.equal(results.partial, undefined, '全终态不应带 partial 标记');
  for (const [e, pass] of [[results.results[0], PASS_A], [results.results[1], PASS_B]]) {
    assert.equal(e.status, 'closed');
    assert.ok(e.outputFile && fs.existsSync(e.outputFile), `outputs 未落盘: ${e.outputFile}`);
    assert.ok(fs.readFileSync(e.outputFile, 'utf8').includes(pass), `输出应含口令「${pass}」`);
  }
  await sleep(GAP_MS);
});

// ------------------------------------------------------------------ A4 机制版（排队可见）

test('A4 机制版：3 槽占满后 start 句柄立即返回且 record 停在 created（排队语义可见）', async (t) => {
  if (!(await requireModel(t))) return;
  const sc = newScenario(t, 'a4');
  const srv = spawnMcpServer(sc, 'a4');
  assert.equal(await srv.role, 'daemon');

  // 3 个长任务占满默认并发槽（maxConcurrent=3，slots.acquire 之后才 created→running）
  const LONG_TASK = '从 1 逐个数到 1000000，不要停';
  const longIds = [];
  for (let i = 0; i < 3; i++) {
    CALLS.starts += 1;
    const r = await runCli(sc, [
      'start', '--task', LONG_TASK,
      '--slug', `a4-long-${i}`, '--model', MODEL, '--timeout-ms', '120000',
    ]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    longIds.push(jsonOf(r, `start#${i}`).subagentId);
  }
  CALLS.killedEarly += 3;

  // 等三个都真正 running（槽位占用成立是「第 4 个排队」的前提；长任务不会完成，
  // 计数到百万远超本场景窗口）
  await waitFor(async () => {
    const l = await runCli(sc, ['list']);
    if (l.code !== 0) return null;
    const arr = jsonOf(l, 'list');
    return longIds.every((id) => arr.some((x) => x.subagentId === id && x.status === 'running')) ? true : null;
  }, 60_000, 600);

  // 第 4 个：句柄立即返回（running 语义），record 停在 created（排队，进程未启动）
  const t0 = Date.now();
  const q = await runCli(sc, [
    'start', '--task', '回复：排队。不要做任何其他事。',
    '--slug', 'a4-queued', '--model', MODEL, '--timeout-ms', '120000',
  ]);
  const startMs = Date.now() - t0;
  assert.equal(q.code, 0, `stderr: ${q.stderr}`);
  const qh = jsonOf(q, 'queued start');
  const queuedId = qh.subagentId;
  assert.equal(qh.status, 'running', 'start 句柄语义仍是 running（异步启动，D3/A4 口径）');
  assert.ok(startMs < 15_000, `slots 满时 start 句柄应立即返回，实际 ${startMs}ms`);

  const s = await runCli(sc, ['status', '--id', queuedId]);
  assert.equal(s.code, 0, `stderr: ${s.stderr}`);
  const rec = jsonOf(s, 'queued status');
  assert.equal(rec.status, 'created', `slots 满时 record 应处 created（排队语义），实际 ${rec.status}`);

  // 清场：排队者先 cancel（无进程、零模型成本），再逐个 cancel 运行中长任务
  for (const id of [queuedId, ...longIds]) {
    const c = await runCli(sc, ['cancel', '--id', id], { timeoutMs: 30_000 });
    assert.equal(c.code, 0, `cancel ${id} stderr: ${c.stderr}`);
    const cr = jsonOf(c, `cancel ${id}`);
    assert.equal(cr.cancelled, true);
    assert.equal(cr.status, 'cancelled');
  }
  await sleep(GAP_MS);
});

// ------------------------------------------------------------------ A5 机制版（daemon 死亡 + 接管，spawn 定向）

test('A5 机制版（spawn 定向）：SIGKILL daemon → standby 看门狗接管 → status 带 lost/orphan 与重发指引', async (t) => {
  if (!(await requireModel(t))) return;
  const sc = newScenario(t, 'a5');
  // W6a2 后 core engine 缺省 appserver 常驻——本场景钉 spawn 定向（不探不降）：
  // victim 断言走 exec.pid 整数通路（独立子进程 + pid 探活/orphan 语义，
  // 旧语义的回归锚点）；appserver 形态的接管编舞由 A5-b 覆盖
  sc.env.XYZ_ZCODE_MODE = 'spawn';
  const a = spawnMcpServer(sc, 'a5-daemon');
  assert.equal(await a.role, 'daemon');
  assert.equal(fs.readFileSync(sc.lockPath, 'utf8'), String(a.child.pid), 'lock 内必须是 daemon A 的 pid');

  // daemon A 持一个长任务（victim）
  CALLS.starts += 1;
  const r = await runCli(sc, [
    'start', '--task', '从 1 逐个数到 1000000，不要停',
    '--slug', 'a5-victim', '--model', MODEL, '--timeout-ms', '120000',
  ]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const victimId = jsonOf(r, 'start').subagentId;
  CALLS.killedEarly += 1;

  // 等 victim 真正 running 且 exec.pid 落 record——standby 启动探活依赖 exec
  const victim = await waitFor(async () => {
    const s = await runCli(sc, ['status', '--id', victimId]);
    if (s.code !== 0) return null;
    const rec = jsonOf(s, 'status');
    return rec.status === 'running' && rec.exec && Number.isInteger(rec.exec.pid) ? rec : null;
  }, 30_000, 500);
  const agentPid = victim.exec.pid;

  // 第二实例同 sock 竞选 → standby。其启动 recover 会把 A 的 running 任务探活
  // （此时还活着）标 orphan 并落盘——这正是接管后 status 可见 orphan/重发指引
  // 的机制来源（M0 形态：standby 的 manager 照常初始化，见 DESIGN-v4 D3）。
  const b = spawnMcpServer(sc, 'a5-standby');
  assert.equal(await b.role, 'standby');

  // 异常死亡：SIGKILL（不走退出卫生——lock/sock 残留由看门狗清理，正是验收点）
  a.child.kill('SIGKILL');
  await waitClose(a.child);

  // 看门狗事件驱动接管：sock 重新可连 + lock 换成 B 的 pid
  await waitFor(() => canConnect(sc.sockPath), 10_000, 100);
  await waitFor(() => fs.existsSync(sc.lockPath)
    && fs.readFileSync(sc.lockPath, 'utf8') === String(b.child.pid), 5_000, 100);

  // 接管实例的 status：victim 标 lost + orphan + 重发指引（无静默僵尸）
  const s2 = await runCli(sc, ['status', '--id', victimId]);
  assert.equal(s2.code, 0, `接管后 status 失败: ${s2.stderr}`);
  const rec2 = jsonOf(s2, 'status after takeover');
  assert.equal(rec2.status, 'lost', `接管后应为 lost，实际 ${rec2.status}`);
  assert.equal(rec2.orphan, true, 'orphan 标记必须可见（探活落盘）');
  assert.match(rec2.lostReason || '', /重发/, 'lostReason 必须含重发指引文案');

  // 清场：SIGKILL daemon 不波及 runner 子进程（孤儿仍烧 token），手工收；
  // 接管者 B 正常退出（exit 0 + 无残留 = 退出卫生闭环）
  try { process.kill(agentPid, 'SIGKILL'); } catch { /* 可能已自行退出 */ }
  b.child.kill('SIGTERM');
  const bc = await waitClose(b.child);
  assert.equal(bc.code, 0, `signal=${bc.signal}`);
  assert.ok(!fs.existsSync(sc.sockPath) && !fs.existsSync(sc.lockPath), '接管者退出卫生后无残留');
});

// -------------------------------------------------- A5-b 机制版（appserver 常驻定向，W6a2 消费链）

test('A5-b 机制版（appserver 定向）：exec.kind/sessionRef 落盘 + SIGKILL daemon → 接管 lost/orphan（保守探活）', async (t) => {
  if (!(await requireModel(t))) return;
  const sc = newScenario(t, 'a5b');
  // 钉 appserver 定向（不探不降）：形态确定性优先——appserver 协议若坏，本场景
  // 应大声失败（这正是 Gate A 要验的面，静默降级反而掩盖回归）
  sc.env.XYZ_ZCODE_MODE = 'appserver';
  const a = spawnMcpServer(sc, 'a5b-daemon');
  assert.equal(await a.role, 'daemon');
  assert.equal(fs.readFileSync(sc.lockPath, 'utf8'), String(a.child.pid), 'lock 内必须是 daemon A 的 pid');

  // daemon A 持一个长任务（victim）——appserver 形态：无 per-task 子进程，
  // turn 跑在常驻共享进程上（core D6 边界：常驻进程不进 onChildSpawned）
  CALLS.starts += 1;
  const r = await runCli(sc, [
    'start', '--task', '从 1 逐个数到 1000000，不要停',
    '--slug', 'a5b-victim', '--model', MODEL, '--timeout-ms', '120000',
  ]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const victimId = jsonOf(r, 'start').subagentId;
  CALLS.killedEarly += 1;

  // 等 victim running 且 W6a2 onHandleReady 消费链落盘：exec.kind 翻转 +
  // sessionRef 回填（create 应答即达，早于 turn 终态——无需等模型轮完成）
  const victim = await waitFor(async () => {
    const s = await runCli(sc, ['status', '--id', victimId]);
    if (s.code !== 0) return null;
    const rec = jsonOf(s, 'status');
    if (rec.status === 'running' && rec.exec && rec.exec.kind === 'appserver'
      && rec.exec.sessionRef && typeof rec.exec.sessionRef.sessionId === 'string') return rec;
    // 定向不降：失败即终态——带原因快速失败，不空等 30s 超时
    if (rec.status !== 'running' && rec.status !== 'created') {
      throw new Error(`appserver 定向下 victim 未达 running（status=${rec.status}）: ${rec.error || JSON.stringify(rec).slice(0, 300)}`);
    }
    return null;
  }, 30_000, 500);
  assert.equal(victim.exec.pid, undefined, 'appserver 形态 exec.pid 恒 undefined（core D6 边界钉住）');
  assert.equal(typeof victim.exec.sessionRef.dbPath, 'string', 'sessionRef.dbPath 落盘（read 面定位锚）');
  const residentPid = readAppServerPid(sc, victim.exec.poolKey);
  assert.ok(residentPid, `常驻进程 pidfile 必须可读（${path.join(sc.env.ZSW_ROOT, 'engines', 'zcode', victim.exec.poolKey, 'appserver.pid')}）`);

  // 同款接管编舞：standby 竞选 → A 异常死亡 → 看门狗接管
  const b = spawnMcpServer(sc, 'a5b-standby');
  assert.equal(await b.role, 'standby');
  a.child.kill('SIGKILL');
  await waitClose(a.child);
  await waitFor(() => canConnect(sc.sockPath), 10_000, 100);
  await waitFor(() => fs.existsSync(sc.lockPath)
    && fs.readFileSync(sc.lockPath, 'utf8') === String(b.child.pid), 5_000, 100);

  // 接管断言：W6a2 保守探活——appserver 形态 orphan 分流（不判死）+ 如实文案
  // + 重发指引；sessionRef 接管后仍可读（磁盘 exec 持久化的诊断锚）
  const s2 = await runCli(sc, ['status', '--id', victimId]);
  assert.equal(s2.code, 0, `接管后 status 失败: ${s2.stderr}`);
  const rec2 = jsonOf(s2, 'status after takeover');
  assert.equal(rec2.status, 'lost', `接管后应为 lost，实际 ${rec2.status}`);
  assert.equal(rec2.orphan, true, 'orphan 标记必须可见（appserver 保守存活分支）');
  assert.match(rec2.lostReason || '', /重发/, 'lostReason 必须含重发指引文案');
  assert.match(rec2.lostReason || '', /孤儿会话|进度未知/, 'appserver 形态文案如实区分（孤儿会话/进度未知）');
  assert.ok(rec2.exec && rec2.exec.sessionRef && typeof rec2.exec.sessionRef.sessionId === 'string',
    '接管后 exec.sessionRef 仍可读（onHandleReady 落盘产物）');

  // 清场：宿主死亡后常驻进程经 stdin EOF 自退（有窗口期），孤儿 turn 窗口内
  // 仍可能烧 token，按 pidfile 手工收割兜底；
  // 接管者 B 正常退出（B 自身未跑任务——无引擎实例可 dispose，退出链组合零副作用）
  try { process.kill(residentPid, 'SIGKILL'); } catch { /* 可能已自行退出 */ }
  b.child.kill('SIGTERM');
  const bc = await waitClose(b.child);
  assert.equal(bc.code, 0, `signal=${bc.signal}`);
  assert.ok(!fs.existsSync(sc.sockPath) && !fs.existsSync(sc.lockPath), '接管者退出卫生后无残留');
});
