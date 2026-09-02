'use strict';
/**
 * U3 真实场景验收（设计 §4 A5/A6/A7 + §3.4 P-mount）：真实 daemon 进程 +
 * 真实文件系统，隔离 env（ZSW_ROOT=/tmp/zsw-u3/root，ZSW_SOCK=/tmp/zsw-u3/daemon.sock）。
 *
 * 保活形态（已踩坑修正）：server 不能直接后台 spawn——无人持有其 stdin 会
 * EOF 触发关停序列；用 node -e 中转进程持有 server 的 stdin pipe（写一次空串
 * 且永不关闭）。stderr 经中转 inherit 汇聚到本脚本捕获。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = '/Users/zhushanwen/Code/zcode-plugin-workspace/feat-app-server-refactor/z-subagent-workflow';
const BASE = '/tmp/zsw-u3';
const ROOT = `${BASE}/root`;
const SOCK = `${BASE}/daemon.sock`;
const ENV = { ...process.env, ZSW_ROOT: ROOT, ZSW_SOCK: SOCK, ZSW_RECORD_KEEP: '100' };

const results = [];
function record(scenario, pass, detail) {
  results.push({ scenario, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${scenario}] ${detail}`);
}

function genFixture(totalTerm, withActive) {
  const args = [String(totalTerm), withActive ? 'active' : 'no-active'];
  const out = spawnSyncOut(process.execPath, [`${BASE}/gen-fixture.js`, ...args], { env: ENV });
  if (out.code !== 0) throw new Error(`fixture 生成失败: ${out.stderr}`);
}

function spawnSyncOut(cmd, argv, opts) {
  const r = require('node:child_process').spawnSync(cmd, argv, {
    encoding: 'utf8', env: opts && opts.env ? opts.env : process.env,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function waitFor(fn, label, ms = 20000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error(`waitFor 超时: ${label}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 启动一个保活 server 实例，返回 { keeper, text(), serverPid(), kill() }。 */
function startServer(tag) {
  const serverJs = path.join(PLUGIN, 'dist/mcp/server.js');
  const keeper = spawn(process.execPath, ['-e',
    'const cp=require("child_process");'
    + `const p=cp.spawn(process.execPath,[${JSON.stringify(serverJs)}],`
    + '{stdio:["pipe","inherit","inherit"]});'
    + 'p.stdin.write("");'
    + 'setInterval(()=>{},1<<30);',
  ], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  keeper.stderr.on('data', (d) => chunks.push(String(d)));
  const text = () => chunks.join('');
  const serverPid = () => {
    const m = text().match(/mcp server starting \(pid=(\d+)\)/);
    return m ? Number(m[1]) : null;
  };
  keeper.on('exit', (code) => chunks.push(`\n[keeper ${tag} exit ${code}]`));
  return {
    keeper, tag, text, serverPid,
    kill: () => { try { keeper.kill('SIGTERM'); } catch { /* 已退 */ } },
  };
}

function runUniqueRuns() {
  const file = path.join(ROOT, 'records.jsonl');
  const keys = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const ev = JSON.parse(line);
      if (ev.subagentId || ev.id) keys.add(ev.subagentId || ev.id);
    } catch { /* 坏行不算 run */ }
  }
  return { runs: keys.size, keys };
}

function cleanRuntime() {
  for (const p of [SOCK, `${SOCK}.lock`]) {
    try { fs.unlinkSync(p); } catch { /* 无残留 */ }
  }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 无 */ }
}

async function stopServer(s) {
  s.kill(); // keeper 死 → server stdin EOF → 优雅关停（daemon.stop 清 sock/lock）
  await waitFor(() => s.text().includes(`[keeper ${s.tag} exit`), `keeper ${s.tag} exit`, 15000).catch(() => {});
  await sleep(200);
}

// ------------------------------------------------- A5：封顶验证
async function scenarioA5() {
  cleanRuntime();
  genFixture(1050, true);
  const s = startServer('a5');
  try {
    await waitFor(() => s.text().includes('record compact 完成') && s.text().includes('removedRuns=950'),
      'A5 daemon compact 日志 removedRuns=950');
    const { runs, keys } = runUniqueRuns();
    assert(runs === 101, `文件应收敛 101 run，实际 ${runs}`);
    assert(keys.has('run-act-1') && keys.has('run-term-1050') && !keys.has('run-term-1'),
      '保留集应为最新 100 终态 + 活跃 run');
    // zsw list（daemon，同 env）
    const list = spawnSyncOut(process.execPath, [path.join(PLUGIN, 'bin/zsw.js'), 'list'], { env: ENV });
    const arr = JSON.parse(list.stdout);
    assert(Array.isArray(arr) && arr.length === 101, `zsw list 应 101 条，实际 ${arr.length}`);
    // 活跃 run status 正常；被截断 run 与「从未存在」同消息
    const st1 = spawnSyncOut(process.execPath, [path.join(PLUGIN, 'bin/zsw.js'), 'status', '--id', 'run-act-1'], { env: ENV });
    const st1obj = JSON.parse(st1.stdout);
    assert(st1.code === 0 && st1obj.subagentId === 'run-act-1', '活跃 run status 正常');
    const st2 = spawnSyncOut(process.execPath, [path.join(PLUGIN, 'bin/zsw.js'), 'status', '--id', 'run-term-1'], { env: ENV });
    const st3 = spawnSyncOut(process.execPath, [path.join(PLUGIN, 'bin/zsw.js'), 'status', '--id', 'sa-nonexist'], { env: ENV });
    // 消息模板一致（id 本身必然不同，归一后逐字比对）
    const norm = (s) => s.replace(/"run-term-1"|"sa-nonexist"/g, '"<id>"').trim();
    assert(st2.code === 1 && st3.code === 1 && norm(st2.stderr) === norm(st3.stderr),
      `被截断 run 错误消息应与不存在 run 同类：\n  截断: ${st2.stderr.trim()}\n  不存在: ${st3.stderr.trim()}`);
    const a5Lines = fs.readFileSync(path.join(ROOT, 'records.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim() !== '').length;
    record('A5', true, `文件收敛 101 run（${a5Lines} 行）；日志 removedRuns=950；list 101 条；status 边界一致`);
    return a5Lines;
  } catch (e) {
    record('A5', false, e.message);
    return null;
  } finally {
    await stopServer(s);
  }
}

// ------------------------------------------------- A6：重启恢复等价
async function scenarioA6(a5Lines) {
  const s = startServer('a6');
  try {
    await waitFor(() => s.text().includes('record 恢复：重建 101 条'), 'A6 重建 101 条');
    const m = s.text().match(/record 恢复：重建 (\d+) 条（applied=(\d+) skipped=(\d+)/);
    assert(m, '恢复日志含 applied/skipped 计数');
    const file = path.join(ROOT, 'records.jsonl');
    const lineCount = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').length;
    // A5 收敛后 = 100 终态×2 + act-1 created = 202 行；recover 对 act-1 探活失败
    // 追加 1 条 dead update（log 在 recover 完成后打，故文件 = a5Lines + 1）
    assert(Number(m[1]) === 101, `重建 records=101，实际 ${m[1]}`);
    assert(Number(m[2]) === a5Lines, `applied(${m[2]}) 应 = A5 保留行数(${a5Lines})`);
    assert(lineCount === a5Lines + 1, `文件行数应为保留行数+1 条 dead update（${a5Lines}+1），实际 ${lineCount}`);
    const list = spawnSyncOut(process.execPath, [path.join(PLUGIN, 'bin/zsw.js'), 'list'], { env: ENV });
    const arr = JSON.parse(list.stdout);
    assert(arr.length === 101, `重启后 list 101 条，实际 ${arr.length}`);
    assert(arr[0].subagentId === 'run-act-1', `startedAt 倒序首位应为最新 run，实际 ${arr[0].subagentId}`);
    record('A6', true, `重建 101 条（applied=${m[2]} = A5 保留行数）；list 101 条；顺序不乱`);
  } catch (e) {
    record('A6', false, e.message);
  } finally {
    await stopServer(s);
  }
}

// ------------------------------------------------- A7（负面）：--local 不触发 compact
async function scenarioA7() {
  genFixture(1050, true);
  const file = path.join(ROOT, 'records.jsonl');
  const before = fs.statSync(file);
  const out = spawnSyncOut(process.execPath, [path.join(PLUGIN, 'bin/zsw.js'), 'list', '--local'], { env: ENV });
  const after = fs.statSync(file);
  try {
    assert(out.code === 0, `--local list 应成功: ${out.stderr.slice(0, 300)}`);
    const arr = JSON.parse(out.stdout);
    assert(arr.length === 1051, `--local list 1051 条，实际 ${arr.length}`);
    assert(after.size === before.size && after.mtimeMs === before.mtimeMs,
      `records.jsonl 应不变（size ${before.size}→${after.size}，mtime ${before.mtimeMs}→${after.mtimeMs}）`);
    record('A7', true, '--local 执行后文件 mtime/size 不变，list 输出正常（1051 条）');
  } catch (e) {
    record('A7', false, e.message);
  }
}

// ------------------------------------------------- P-mount：挂点单属主 + 接管触发
async function scenarioPmount() {
  cleanRuntime();
  // 全终态 fixture（无活跃 run）：双进程并发启动时 recover 探活零追加，
  // 消除「standby recover 的 dead update 追加与 daemon compact 读文件交错」
  // 的无关竞态——P-mount 验证挂点归属，与活跃 run 无关
  genFixture(1050, false);
  const a = startServer('pm-a');
  await sleep(300); // 先让 A 完成首竞选占位（时序可控化，双并发仍验 standby 不挂）
  const b = startServer('pm-b');
  try {
    await waitFor(() => a.text().includes('daemon 竞选完成'), 'A 角色确定');
    await waitFor(() => b.text().includes('daemon 竞选完成'), 'B 角色确定');
    const aDaemon = a.text().includes('role=daemon');
    const bDaemon = b.text().includes('role=daemon');
    const daemon = aDaemon ? a : b;
    const standby = aDaemon ? b : a;
    assert(aDaemon !== bDaemon, `应恰一个 daemon（A=${aDaemon} B=${bDaemon}）`);
    await waitFor(() => daemon.text().includes('record compact 完成') && daemon.text().includes('removedRuns=950'),
      'daemon 侧 compact 日志');
    assert(!standby.text().includes('record compact'), 'standby 不得出现任何 compact 日志');
    const phase1 = `首竞选 daemon=${daemon.tag} 出 compact 日志（removedRuns=950）；standby=${standby.tag} 零 compact 日志`;

    // 接管路径：重写超阈值台账（daemon 活着不重读，外部覆盖合法）→ kill daemon →
    // standby 看门狗接管 → onTakeover recover 后 compact（phase=takeover）
    genFixture(1050, false);
    const dpid = daemon.serverPid();
    assert(dpid, 'daemon server pid 可解析');
    process.kill(dpid, 'SIGKILL');
    daemon.kill(); // 收掉 daemon 侧保活中转（server 已死）
    await waitFor(() => standby.text().includes('record compact 完成：phase=takeover')
      && standby.text().includes('removedRuns=950'), '接管路径 compact 日志（phase=takeover, removedRuns=950）');
    const { runs } = runUniqueRuns();
    assert(runs === 100, `接管 compact 后应 100 run（全终态 fixture），实际 ${runs}`);
    record('P-mount', true, `${phase1}；kill daemon 后 standby 接管路径出 phase=takeover compact（removedRuns=950），文件收敛 100 run`);
  } catch (e) {
    record('P-mount', false, e.message);
    a.kill();
    b.kill();
    return;
  }
  // 正常路径：daemon 已 SIGKILL + 其 keeper 已 kill；standby（接管后的新 daemon）
  // 优雅关停
  await stopServer(a.text().includes('role=standby') ? a : b);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  fs.mkdirSync(BASE, { recursive: true });
  const a5Lines = await scenarioA5();
  await scenarioA6(a5Lines);
  await scenarioA7();
  await scenarioPmount();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== U3 真实场景验收：${results.length - failed.length}/${results.length} PASS =====`);
  process.exit(failed.length > 0 ? 1 : 0);
})().catch((e) => {
  console.error(`fatal: ${e.stack}`);
  process.exit(1);
});
