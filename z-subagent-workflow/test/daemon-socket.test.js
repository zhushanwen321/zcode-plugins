'use strict';

/**
 * daemon-socket 传输层单测（DESIGN-v4 §6.2 D2 / §6.3 D3；U1）。
 *
 * 隔离方式：sockPath 全部落 mkdtemp 临时目录，不碰 ~/.zcode/zsw。
 * 多实例竞选/看门狗接管在同一进程内用多个 startDaemon 实例模拟（socket 与
 * 锁文件语义跨进程一致，同进程足够验证状态机）；SIGTERM 退出卫生用真实子
 * 进程验证——同进程发信号会连测试进程一起杀掉。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib', 'daemon-socket.js');
const { startDaemon, encodeFrame, createFrameDecoder } = require(LIB);

/** 建临时 sock 目录；测试结束整目录删除（残留清理断言失败时也不会泄漏）。 */
function tmpSock(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-ds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, sockPath: path.join(dir, 'daemon.sock'), lockPath: path.join(dir, 'daemon.sock.lock') };
}

/** 轮询等待条件成立（看门狗接管含退避，最坏 ~3×200ms）。 */
async function waitUntil(fn, { timeoutMs = 4000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitUntil 超时（${timeoutMs}ms）。👉 检查被等待的条件是否真的可能达成`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** sockPath 当前是否可连通（接管探测用）。 */
function canConnect(sockPath) {
  return new Promise((resolve) => {
    const s = net.connect(sockPath);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

/** 最小 client：连上后连发 reqs，收满等量响应帧返回（按到达序）。 */
function rpc(sockPath, reqs, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    const decoder = createFrameDecoder();
    const out = [];
    let done = false;
    const timer = setTimeout(
      () => fail(new Error(`rpc 超时（已收 ${out.length}/${reqs.length} 帧）`)),
      timeoutMs,
    );
    const fail = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      reject(e);
    };
    sock.on('connect', () => { for (const r of reqs) sock.write(encodeFrame(r)); });
    sock.on('data', (c) => {
      if (done) return;
      out.push(...decoder.push(c));
      if (out.length >= reqs.length) {
        done = true;
        clearTimeout(timer);
        sock.end();
        resolve(out);
      }
    });
    sock.on('error', fail);
    sock.on('close', () => {
      if (!done) fail(new Error(`连接提前关闭（已收 ${out.length}/${reqs.length} 帧）`));
    });
  });
}

/** spawn 一个真实 daemon 子进程（keep-alive 由脚本自持——传输层 handle 全 unref）。 */
function spawnDaemonProc(sockPath) {
  const script = `
    const { startDaemon } = require(${JSON.stringify(LIB)});
    startDaemon({
      sockPath: ${JSON.stringify(sockPath)},
      handlers: { zsub: async () => ({ pong: true }) },
      log: () => {},
    }).then(
      (d) => process.stderr.write('READY ' + d.role + '\\n'),
      (e) => { process.stderr.write('FAIL ' + e.message + '\\n'); process.exit(1); },
    );
    setInterval(() => {}, 3600000); // 宿主 keep-alive：传输层全 unref，进程去留由宿主决定
  `;
  return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 等子进程 stderr 出 READY 行，返回 role；FAIL 或超时则抛错。 */
function waitProcReady(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(
      () => finish(new Error(`等待子进程 READY 超时；stderr: ${buf.trim() || '(空)'}`)),
      timeoutMs,
    );
    const finish = (v) => {
      clearTimeout(timer);
      child.stderr.off('data', onData);
      if (v instanceof Error) reject(v);
      else resolve(v);
    };
    const onData = (d) => {
      buf += d;
      const m = buf.match(/^(READY|FAIL) (.*)$/m);
      if (!m) return;
      if (m[1] === 'FAIL') finish(new Error(`子进程启动失败: ${m[2]}`));
      else finish(m[2]);
    };
    child.stderr.on('data', onData);
    child.on('exit', (code) => finish(new Error(`子进程提前退出（code=${code}）`)));
  });
}

/** 等子进程退出，返回 {code, signal}；超时 SIGKILL 兜底并抛错。 */
function waitClose(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('等待子进程退出超时'));
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

// ------------------------------------------------------ 帧编解码纯函数

test('encodeFrame：单行 JSON + 换行结尾', () => {
  const line = encodeFrame({ id: 1, tool: 'zsub', params: { a: '中' } });
  assert.ok(line.endsWith('\n'), '帧以 \\n 结尾（NDJSON 行边界）');
  assert.strictEqual(line.indexOf('\n'), line.length - 1, 'JSON 内无裸换行');
  assert.deepStrictEqual(JSON.parse(line), { id: 1, tool: 'zsub', params: { a: '中' } });
});

test('createFrameDecoder：多帧一 chunk / 半包拼接 / 空行容忍 / 坏行丢弃回调', () => {
  const bad = [];
  const dec = createFrameDecoder((l) => bad.push(l));

  // 多帧 + 坏行 + 空行混在一个 chunk：好帧全解出，坏行进回调
  const out = dec.push(Buffer.from(
    '{"id":1,"tool":"a"}\n{oops\n\n{"id":2,"tool":"b"}\n',
  ));
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].id, 1);
  assert.strictEqual(out[1].id, 2);
  assert.deepStrictEqual(bad, ['{oops'], '坏行丢弃且可观测');

  // 半包：前半不产帧，补齐后产完整帧
  const line = encodeFrame({ id: 3, tool: 'c', params: { v: '中文' } });
  const buf = Buffer.from(line);
  assert.deepStrictEqual(dec.push(buf.subarray(0, 5)), [], '半包缓冲不吐帧');
  const rest = dec.push(buf.subarray(5));
  assert.strictEqual(rest.length, 1);
  assert.deepStrictEqual(rest[0], { id: 3, tool: 'c', params: { v: '中文' } });

  // 无换行尾巴持续缓冲，不误吐
  assert.deepStrictEqual(dec.push(Buffer.from('{"id":4,')), []);
});

test('createFrameDecoder：多字节 UTF-8 被字节级切分仍正确解码（按字节找行、行完整后才 decode）', () => {
  const dec = createFrameDecoder();
  const line = encodeFrame({ id: 7, params: { s: '中文字' } });
  const buf = Buffer.from(line);
  const idx = buf.indexOf(Buffer.from('中', 'utf8'));
  assert.ok(idx > 0, '前提：帧里确实含多字节字符');
  const cut = idx + 1; // 切在「中」3 字节的中间
  assert.deepStrictEqual(dec.push(buf.subarray(0, cut)), []);
  const frames = dec.push(buf.subarray(cut));
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].params.s, '中文字', '无替换字符、无丢字节');
});

// ------------------------------------------------------ 竞选与协议往返

test('帧 cwd 传导（MF7）：请求帧含非空 string cwd 时 handler req.cwd 收到；缺失/非 string/空串 → undefined', async (t) => {
  const { sockPath } = tmpSock(t);
  const seen = [];
  const d = await startDaemon({
    sockPath,
    handlers: {
      zsub: async (req) => { seen.push(req.cwd); return { ok: 1 }; },
    },
    log: () => {},
  });
  t.after(() => d.stop());

  // 缺失 / 合法 string / 非 string（数字、对象）/ 空串：类型守卫在传输层
  const frames = await rpc(sockPath, [
    { id: 1, tool: 'zsub', params: {} },
    { id: 2, tool: 'zsub', params: {}, cwd: '/tmp/wt-multi-a' },
    { id: 3, tool: 'zsub', params: {}, cwd: 42 },
    { id: 4, tool: 'zsub', params: {}, cwd: { path: '/tmp/x' } },
    { id: 5, tool: 'zsub', params: {}, cwd: '' },
  ]);
  for (const f of frames) assert.strictEqual(f.ok, true);
  assert.deepStrictEqual(seen, [
    undefined,              // 帧不带 cwd
    '/tmp/wt-multi-a',      // 非 string 之外的合法形态原样到达
    undefined,              // 数字：忽略
    undefined,              // 对象：忽略
    undefined,              // 空串：忽略（daemon 侧仅接受非空 string）
  ], 'req.cwd 仅在非空 string 时透传，其余一律 undefined');
});

test('单实例竞选成 daemon：lock 写 pid、socket 0600、正常帧/throw 帧/unknown tool 往返，stop 后无残留', async (t) => {
  const { sockPath, lockPath } = tmpSock(t);
  const calls = [];
  const d = await startDaemon({
    sockPath,
    handlers: {
      zsub: async (req, meta) => {
        calls.push({ req, signal: meta.signal, abortedAtCall: meta.signal.aborted });
        return { echo: req.params, pong: true };
      },
      boom: async () => { throw new Error('故意失败：模拟 handler 抛错'); },
    },
    log: () => {},
  });
  t.after(() => d.stop());
  assert.strictEqual(d.role, 'daemon');
  assert.strictEqual(typeof d.stop, 'function');

  // D3：锁内容是持有者 pid（诊断锚点）；D2：socket 权限 0600（仅本用户可连）
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), String(process.pid));
  assert.strictEqual(fs.statSync(sockPath).mode & 0o777, 0o600);

  const frames = await rpc(sockPath, [
    { id: 1, tool: 'zsub', params: { action: 'start', x: '中文参数' } },
    { id: 2, tool: 'boom', params: {} },
    { id: 3, tool: 'nope', params: {} },
  ]);
  const byId = Object.fromEntries(frames.map((f) => [f.id, f]));

  // 正常帧：req = {tool, params}，result 原样回
  assert.deepStrictEqual(byId[1], {
    id: 1, ok: true, result: { echo: { action: 'start', x: '中文参数' }, pong: true },
  });
  assert.strictEqual(calls.length, 1, '只分发已注册 tool');
  assert.strictEqual(calls[0].req.tool, 'zsub');
  assert.strictEqual(calls[0].abortedAtCall, false, '连接存活期间 signal 未 abort');
  assert.ok(calls[0].signal instanceof AbortSignal, 'meta.signal 是 AbortSignal');

  // handler throw → ok:false + error.message
  assert.strictEqual(byId[2].ok, false);
  assert.match(byId[2].error.message, /故意失败/);

  // 未注册 tool → ok:false unknown tool
  assert.strictEqual(byId[3].ok, false);
  assert.match(byId[3].error.message, /unknown tool/);

  await d.stop();
  assert.ok(!fs.existsSync(lockPath) && !fs.existsSync(sockPath), 'stop 后无 lock/sock 残留');
  await d.stop(); // 幂等：二次 stop 不抛
});

test('双实例并行启动：锁文件裁决一 daemon 一 standby；standby stop 不动 daemon 的文件与服务', async (t) => {
  const { sockPath, lockPath } = tmpSock(t);
  const [a, b] = await Promise.all([
    startDaemon({ sockPath, handlers: { zsub: async () => ({ who: 'a' }) }, log: () => {} }),
    startDaemon({ sockPath, handlers: { zsub: async () => ({ who: 'b' }) }, log: () => {} }),
  ]);
  t.after(() => a.stop());
  t.after(() => b.stop());
  const daemon = a.role === 'daemon' ? a : b;
  const standby = a.role === 'daemon' ? b : a;
  assert.strictEqual(daemon.role, 'daemon', '有且仅一个 daemon');
  assert.strictEqual(standby.role, 'standby', '落选者 standby');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), String(process.pid), 'lock 由 daemon 持有');

  // standby 关停只断看门狗：daemon 的 lock/sock 原样，服务照常
  await standby.stop();
  assert.ok(fs.existsSync(lockPath) && fs.existsSync(sockPath));
  const frames = await rpc(sockPath, [{ id: 1, tool: 'zsub', params: {} }]);
  assert.strictEqual(frames[0].result.who, 'a', 'daemon 未受 standby 退出影响');

  await daemon.stop();
  assert.ok(!fs.existsSync(lockPath) && !fs.existsSync(sockPath));
});

test('daemon stop 后 standby 看门狗接管：清残留重竞选成新 daemon，可服务', async (t) => {
  const { sockPath, lockPath } = tmpSock(t);
  const daemon = await startDaemon({
    sockPath, handlers: { zsub: async () => ({ who: 'old' }) }, log: () => {},
  });
  t.after(() => daemon.stop());
  const standby = await startDaemon({
    sockPath, handlers: { zsub: async () => ({ who: 'takeover' }) }, log: () => {},
  });
  t.after(() => standby.stop());
  assert.strictEqual(daemon.role, 'daemon');
  assert.strictEqual(standby.role, 'standby');

  await daemon.stop(); // daemon 关停 → 看门狗连接 close → standby 事件驱动接管

  await waitUntil(() => canConnect(sockPath), { timeoutMs: 4000 });
  const frames = await rpc(sockPath, [{ id: 1, tool: 'zsub', params: {} }]);
  assert.deepStrictEqual(frames[0], { id: 1, ok: true, result: { who: 'takeover' } },
    '接管者用自己的 handler 表服务');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), String(process.pid), '接管者持有新 lock');

  await standby.stop();
  assert.ok(!fs.existsSync(lockPath) && !fs.existsSync(sockPath), '接管者 stop 后无残留');
});

// ------------------------------------------------------ 信号退出卫生（真实子进程）

test('SIGTERM：daemon 子进程先 unlink sock+lock 再退出（exit 0，无残留）', async (t) => {
  const { sockPath, lockPath } = tmpSock(t);
  const child = spawnDaemonProc(sockPath);
  assert.strictEqual(await waitProcReady(child), 'daemon');
  assert.ok(fs.existsSync(lockPath) && fs.existsSync(sockPath), '运行期 lock/sock 在位');

  child.kill('SIGTERM');
  const { code, signal } = await waitClose(child);
  assert.strictEqual(signal, null, '信号被 handler 接住（非默认杀）');
  assert.strictEqual(code, 0, '清理后显式 exit(0)');
  assert.ok(!fs.existsSync(lockPath), 'lock 已清（退出卫生）');
  assert.ok(!fs.existsSync(sockPath), 'sock 已清（退出卫生）');
});

test('SIGTERM：standby 子进程直接退出，不动 daemon 的 lock/sock', async (t) => {
  const { sockPath, lockPath } = tmpSock(t);
  // daemon 留在测试进程内，standby 用子进程（同进程发信号会杀掉测试进程）
  const daemon = await startDaemon({
    sockPath, handlers: { zsub: async () => ({ who: 'daemon' }) }, log: () => {},
  });
  t.after(() => daemon.stop());

  const child = spawnDaemonProc(sockPath);
  assert.strictEqual(await waitProcReady(child), 'standby');

  child.kill('SIGTERM');
  const { code, signal } = await waitClose(child);
  assert.strictEqual(signal, null);
  assert.strictEqual(code, 0, 'standby 无文件清理、直接退出');

  // standby 退出误删 daemon 的 lock 会造成双 daemon 分裂——必须原样
  assert.ok(fs.existsSync(lockPath) && fs.existsSync(sockPath));
  const frames = await rpc(sockPath, [{ id: 1, tool: 'zsub', params: {} }]);
  assert.deepStrictEqual(frames[0].result, { who: 'daemon' }, 'daemon 服务照常');
});

// ------------------------------------------------------ 挂起取消与半包

test('客户端断连：连接级 AbortSignal 被 abort，挂起 handler 取消等待，daemon 不受影响', async (t) => {
  const { sockPath } = tmpSock(t);
  let sawAborted = false;
  let handlerSettled = false;
  const daemon = await startDaemon({
    sockPath,
    handlers: {
      slow: async (req, meta) => {
        await new Promise((resolve) => {
          if (meta.signal.aborted) { sawAborted = true; return resolve(); }
          meta.signal.addEventListener('abort', () => { sawAborted = true; resolve(); }, { once: true });
        });
        handlerSettled = true;
        return { slow: true };
      },
    },
    log: () => {},
  });
  t.after(() => daemon.stop());

  const sock = net.connect(sockPath);
  await once(sock, 'connect');
  sock.write(encodeFrame({ id: 1, tool: 'slow', params: {} }));
  await new Promise((r) => setTimeout(r, 50)); // 等 daemon 侧进入挂起
  sock.destroy(); // 模拟 CLI 被 TaskStop 杀掉

  await waitUntil(() => handlerSettled === true, { timeoutMs: 2000 });
  assert.strictEqual(sawAborted, true, '断连触发 signal abort，挂起 handler 被唤醒取消');

  // daemon 未崩、无 unhandled rejection：后续请求仍可服务
  const frames = await rpc(sockPath, [{ id: 2, tool: 'unknown-x', params: {} }]);
  assert.match(frames[0].error.message, /unknown tool/);
});

test('socket 层半包：一帧按字节切两半发送，daemon 仍正确解码并响应', async (t) => {
  const { sockPath } = tmpSock(t);
  const daemon = await startDaemon({
    sockPath, handlers: { zsub: async (req) => req.params }, log: () => {},
  });
  t.after(() => daemon.stop());

  const line = encodeFrame({ id: 1, tool: 'zsub', params: { half: '帧' } });
  const buf = Buffer.from(line); // 故意按字节切（含多字节字符被切开的概率）
  const mid = Math.floor(buf.length / 2);

  const sock = net.connect(sockPath);
  await once(sock, 'connect');
  const decoder = createFrameDecoder();
  const got = await new Promise((resolve, reject) => {
    sock.on('error', reject);
    sock.on('data', (c) => { for (const f of decoder.push(c)) resolve(f); });
    sock.write(buf.subarray(0, mid)); // 前半
    setTimeout(() => sock.write(buf.subarray(mid)), 30); // 后半延迟到下一轮
  });
  sock.destroy();
  assert.strictEqual(got.id, 1);
  assert.strictEqual(got.ok, true);
  assert.deepStrictEqual(got.result, { half: '帧' });
});

// ------------------------------------------------------ 看门狗安静性

test('看门狗连接不发帧：daemon 无错误日志、正常服务不受干扰', async (t) => {
  const { sockPath } = tmpSock(t);
  const logs = [];
  const daemon = await startDaemon({
    sockPath, handlers: { zsub: async () => ({ ok: 1 }) }, log: (m) => logs.push(m),
  });
  const standby = await startDaemon({
    sockPath, handlers: {}, log: (m) => logs.push(m),
  });
  t.after(() => daemon.stop());
  t.after(() => standby.stop());
  assert.strictEqual(daemon.role, 'daemon');
  assert.strictEqual(standby.role, 'standby', 'standby 就绪即看门狗已挂上');

  await new Promise((r) => setTimeout(r, 150)); // 看门狗连接静默挂一段时间
  const frames = await rpc(sockPath, [{ id: 1, tool: 'zsub', params: {} }]);
  assert.deepStrictEqual(frames[0], { id: 1, ok: true, result: { ok: 1 } });

  const errors = logs.filter((m) => /错误|异常|坏帧|终止/.test(m));
  assert.deepStrictEqual(errors, [], `两侧均不应有错误日志: ${errors}`);
});

// ------------------------------------------------- R3：接管回调（onTakeover）

test('看门狗接管成为 daemon 时触发 onTakeover；首竞选不触发', async (t) => {
  const { sockPath } = tmpSock(t);
  const takeovers = [];
  const daemon = await startDaemon({
    sockPath, handlers: { zsub: async () => ({ who: 'old' }) }, log: () => {},
    onTakeover: () => { takeovers.push('old-should-not-fire'); },
  });
  t.after(() => daemon.stop());
  assert.strictEqual(daemon.role, 'daemon');
  assert.deepStrictEqual(takeovers, [], '首竞选成为 daemon 不触发 onTakeover');

  const standby = await startDaemon({
    sockPath, handlers: { zsub: async () => ({ who: 'new' }) }, log: () => {},
    onTakeover: () => { takeovers.push('new'); },
  });
  t.after(() => standby.stop());
  assert.strictEqual(standby.role, 'standby');

  await daemon.stop(); // 看门狗 close → standby 接管
  await waitUntil(() => canConnect(sockPath), { timeoutMs: 4000 });
  await waitUntil(() => takeovers.length === 1, { timeoutMs: 4000 });
  assert.deepStrictEqual(takeovers, ['new'], '仅接管者触发 onTakeover');

  // 接管后仍正常服务
  const frames = await rpc(sockPath, [{ id: 1, tool: 'zsub', params: {} }]);
  assert.strictEqual(frames[0].result.who, 'new');
});

// ------------------------------------------------- R1：接管前持有者探活重验

test('R1：看门狗触发时锁持有者 pid 存活 → 不 sweep 残留（防多 standby 竞态双 daemon）', async (t) => {
  const { sockPath, lockPath } = tmpSock(t);
  // 伪「先到 standby 已上位的新持有者」：活子进程持有 lock，但无 listener
  // （standby 看门狗 connect 不可达 → 退避 3 次 → 探活 pid 在世 → 必须跳过 sweep）
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => holder.kill());
  fs.writeFileSync(lockPath, String(holder.pid));

  const ready = startDaemon({
    sockPath, handlers: { zsub: async () => ({ who: 'takeover' }) }, log: () => {},
  });
  // 退避 3×200ms 后探活：持有者存活 → lock 不被误删（ready 不 resolve——
  // 无 daemon 可连，实例停留在 standby 重试环；handle 全 unref 不阻退出）
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(fs.existsSync(lockPath), '持有者存活时 lock 不被后到 standby 误删');

  // 持有者死亡 → 下一轮探活 dead → sweep + 重竞选 → 接管成 daemon
  holder.kill('SIGKILL');
  await holder;
  const d = await Promise.race([
    ready, new Promise((_, rej) => setTimeout(() => rej(new Error('接管超时')), 6000)),
  ]);
  t.after(() => d.stop());
  assert.strictEqual(d.role, 'daemon');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), String(process.pid), '接管者持新 lock');
  const frames = await rpc(sockPath, [{ id: 1, tool: 'zsub', params: {} }]);
  assert.deepStrictEqual(frames[0].result, { who: 'takeover' });
});
