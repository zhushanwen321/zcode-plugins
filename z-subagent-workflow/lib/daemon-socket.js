'use strict';
/**
 * zsw daemon 传输层（DESIGN-v4.md §6.2 D2 / §6.3 D3；§7 实现机制要点 1/3）：
 * unix socket 控制面——锁文件竞选单例 + 看门狗事件驱动接管 + NDJSON 帧分发。
 *
 * 为什么锁文件而不是纯 bind 竞争（D3 被否①）：bind 成功但未 listen 的窗口内，
 * 他实例 connect 得 ECONNREFUSED 会误判残留而 unlink，产生监听无路径的幽灵
 * daemon 与后续 bind 者并存、任务静默分裂；锁文件 O_EXCL 是单 syscall 原子
 * 裁决，无检查-then-act 窗口。锁内写 pid 供诊断（lsof/ps 排查持有者）。
 *
 * 角色状态机（每实例）：
 *   elect --O_EXCL 拿锁成功--> daemon（listen sockPath + 分发 handler 表）
 *         --EEXIST--------------> standby（挂一条到 daemon 的看门狗长连接，
 *                                  不发包——daemon 侧连接统一走 decoder，
 *                                  看门狗连接无帧，天然安静）
 *   standby 看门狗对端 close（POSIX：对端进程死亡内核关闭连接）== daemon 死亡
 *           --> 清残留（lock+sock）--> 回到 elect（事件驱动，零轮询）。
 *
 * 退避 200ms×3 只用于 standby 首次 connect 失败：覆盖「持有者已拿锁但还没
 * listen 完」的启动窗口（正常是毫秒级），避免误清活锁；3 次退避仍不可达才
 * 判定持有者死亡或从未完成启动，清残留重竞选。
 *
 * 帧协议（D2，NDJSON；MF7 扩展 cwd 字段）：帧语法单源在 lib/frame-codec.js
 * （encodeFrame/createFrameDecoder，NDJSON 契约与 cwd 传导语义见其头注）。
 * 本模块只留传输层职责（listen/accept/锁竞选/看门狗），编解码经 import 消费。
 * 每连接一个 AbortSignal（§7 要点 2）：连接断开即 abort，wait 类
 *   挂起 handler 据此取消等待（不影响任务执行体）；handler throw 统一映射为
 *   ok:false 帧。本层只管传输，zsub/zflow 语义由调用方注入的 handler 表定义。
 *
 * 退出卫生（D3 第 3 段）：SIGTERM/SIGINT/exit → daemon 先 unlink sock+lock
 * 再退出；standby 直接退出（绝不动 daemon 的文件）。stop() 是同款清理的
 * 用户态入口（幂等），供测试与正常关停复用。lock/sock 的 unlink 只发生在
 * 两处——看门狗判定持有者已死（判定含 pid 探活重验，见 probeLockHolder：
 * 防 R1 多 standby 竞态误删新上位者的文件）、自己是持有者的退出卫生；
 * 竞选路径上绝不无凭据清他人文件（§7 要点 1「残留清理边界」）。
 *
 * 进程生命周期：本模块创建的所有 handle（server/连接/看门狗/重试 timer）
 * 一律 unref——生命周期由宿主（MCP stdin / 引擎 kill）决定，传输层不偷偷
 * keep-alive 阻塞宿主退出，也不自行决定退出。
 */

const fs = require('node:fs');
const net = require('node:net');

// 帧语法单源（D1）：encodeFrame/createFrameDecoder 见 lib/frame-codec.js
const { encodeFrame, createFrameDecoder } = require('./frame-codec');

// 探活原语单一源（V5e 收口）：core-ref 模块本身轻量（fs/path），barrel 在
// requireCore() 调用时才加载——probeLockHolder 是看门狗触发路径的低频探测
const coreRef = require('./core-ref');

const WATCHDOG_BACKOFF_MS = 200;
const WATCHDOG_RETRIES = 3;
const SOCKET_MODE = 0o600; // D2 安全边界：仅本用户可 connect

/** 人读日志缺省实现（与 assemble.js 同款纪律：走 stderr，不碰协议通道）。 */
function defaultLog(msg) {
  process.stderr.write(`[zsub-daemon] ${new Date().toISOString()} ${msg}\n`);
}

/** 活跃实例的同步清理集：信号/退出钩子遍历执行（模块级一份，多实例共用）。 */
const LIVE_CLEANUPS = new Set();
let hooksInstalled = false;
function installExitHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const cleanupAll = () => { for (const cleanup of LIVE_CLEANUPS) cleanup(); };
  // 信号路径：清理是同步的（unlink），先清后显式退出。接线注意：process.exit
  // 会跳过其后注册的其他同名信号 listener——宿主（dist/mcp/server.js）若有
  // 自己的 SIGTERM 收尾，需在本模块之前注册或把收尾统一收口到这里。
  process.on('SIGTERM', () => { cleanupAll(); process.exit(0); });
  process.on('SIGINT', () => { cleanupAll(); process.exit(0); });
  // 自然退出路径兜底（如 MCP stdin 关闭后宿主 process.exit）：exit 钩子只允许
  // 同步操作，而退出卫生恰好全是同步 unlink。
  process.on('exit', cleanupAll);
}

/**
 * 启动 daemon 传输层：锁文件竞选 → daemon（listen + 分发）或 standby（看门狗）。
 *
 * @param {object} opts
 * @param {string} opts.sockPath unix socket 路径（lock 固定为 sockPath + '.lock'）
 * @param {Record<string, (req: {tool: string, params: object, cwd?: string}, meta: {signal: AbortSignal}) => Promise<any>>} [opts.handlers]
 *        tool 名 → handler 表；本层只管传输，业务语义由调用方注入
 * @param {() => Promise<void>} [opts.onTakeover]
 *        standby 经看门狗接管成为 daemon 后回调（DESIGN-v4 §6.3 D3：接管时
 *        跑 recover——record 重建 + 探活）。仅接管路径触发，首竞选成为
 *        daemon 不触发（调用方启动序列自己跑过 recover）。抛错只记日志，
 *        不回滚 daemon 身份。
 * @param {(msg: string) => void} [opts.log] 人读日志（缺省 stderr）
 * @returns {Promise<{role: 'daemon'|'standby', stop: () => Promise<void>}>}
 *          role 是首竞选快照；standby 事后接管成 daemon 时 role 字段不回填
 *          （进程内真实角色以 stop() 等内部状态为准，外部用「sockPath 可连」观察）
 */
function startDaemon(opts) {
  if (!opts || typeof opts.sockPath !== 'string' || !opts.sockPath) {
    throw new TypeError('startDaemon 缺少 sockPath（unix socket 路径）。👉 从 lib/cli-client.js 的 defaultSockPath() 取值（ZSW_SOCK env 可覆盖），不要手工拼路径');
  }
  const sockPath = opts.sockPath;
  const handlers = opts.handlers || {};
  const onTakeover = typeof opts.onTakeover === 'function' ? opts.onTakeover : null;
  const log = opts.log || defaultLog;
  const lockPath = `${sockPath}.lock`;

  let state = 'electing'; // electing | daemon | standby | stopped
  let lockHeld = false;   // 本实例是否持有 lock（daemon 身份的文件凭据）
  let server = null;
  let watchdog = null;
  let watchdogConnected = false;
  let retryTimer = null;
  let pendingListen = null;
  let wasStandby = false; // 经 standby→看门狗→竞选 的接管路径（区别于首竞选）
  const conns = new Set(); // 活跃连接（stop 时主动断开，加速 server.close 收尾）

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let readySettled = false;
  function finishReady(role) {
    if (readySettled) return;
    readySettled = true;
    resolveReady({ role, stop });
  }
  function failReady(err) {
    if (readySettled) return;
    readySettled = true;
    LIVE_CLEANUPS.delete(syncCleanup);
    rejectReady(err);
  }

  /** 清 lock+sock 残留（ENOENT 静默容错）。合法调用只有两处：看门狗判定持有者
   *  已死、自己是持有者的退出卫生——见头注「残留清理边界」。 */
  function sweepFiles(why) {
    for (const p of [lockPath, sockPath]) {
      try {
        fs.unlinkSync(p);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          log(`清残留 ${p} 失败（${e.message}）。👉 手工删除该文件后重启 daemon`);
        }
      }
    }
  }

  /** 接管前探活锁持有者（R1）：读 lock 内 pid 做信号 0 探测（原语消费 core
   *  isProcessAlive，V5e 收口；EPERM = 进程存在但属他人，core 按存在算）。
   *  返回 'alive'（持有者进程在世，新 daemon 已上位）/ 'dead'（pid 已死，残留可清）
   *  / 'gone'（lock 已不存在，他人已 sweep+重竞选）/ 'unreadable'（按残留处理）。 */
  function probeLockHolder() {
    let pidStr;
    try {
      pidStr = fs.readFileSync(lockPath, 'utf8').trim();
    } catch (e) {
      return e.code === 'ENOENT' ? 'gone' : 'unreadable';
    }
    if (!/^\d+$/.test(pidStr)) return 'unreadable';
    return coreRef.requireCore().isProcessAlive(Number(pidStr)) ? 'alive' : 'dead';
  }

  /** 原子拿锁：成功（已写入 pid）返回 true；他人持有返回 false；其余错误抛出。 */
  function tryAcquireLock() {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx'); // O_EXCL：单 syscall 原子裁决（D3）
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      throw new Error(`锁文件 ${lockPath} 创建失败（${e.code || ''} ${e.message}）。👉 检查父目录存在且可写后重试`);
    }
    try {
      fs.writeFileSync(fd, String(process.pid));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  }

  async function closeServer() {
    if (!server) return;
    const srv = server;
    server = null;
    for (const s of conns) s.destroy();
    conns.clear();
    await new Promise((resolve) => srv.close(() => resolve()));
  }

  function becomeDaemon() {
    // unlink 残留 sock 的安全凭据：lock 已在握，自己是唯一合法持有人（D3）
    try {
      fs.unlinkSync(sockPath);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        log(`清残留 sock ${sockPath} 失败（${e.message}），继续 listen——若随后报地址占用，👉 手工删除该文件后重启`);
      }
    }
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref(); // 生命周期由宿主决定（见头注）
      srv.on('connection', handleConn);
      let listening = false;
      srv.on('error', (err) => {
        if (!listening) {
          reject(new Error(`listen ${sockPath} 失败（${err.code || ''} ${err.message}）。👉 检查路径长度（unix socket 上限约 104 字节）与父目录权限后重试`));
        } else {
          log(`server 运行期错误（${err.message}），记录不退出`);
        }
      });
      srv.listen(sockPath, () => {
        listening = true;
        server = srv;
        // 权限收紧 0600。listen 后 chmod 有极小的默认权限窗口——本机同用户场景
        // 无影响，跨用户防御从简是 D2 既定取舍（macOS 单用户为主）。
        try {
          fs.chmodSync(sockPath, SOCKET_MODE);
        } catch (e) {
          log(`socket chmod 0600 失败（${e.message}）。👉 检查文件系统权限`);
        }
        resolve();
      });
    });
  }

  function becomeStandby(attempt) {
    if (state === 'stopped') return;
    wasStandby = true; // 后续竞选成功即为接管（onTakeover 依据）
    const sock = net.connect(sockPath);
    sock.unref();
    watchdog = sock;
    watchdogConnected = false;
    sock.on('connect', () => {
      watchdogConnected = true;
      // 不发任何帧：daemon 侧连接统一走 decoder，无帧即安静（D3 看门狗形态）
      log(`standby 就绪：看门狗已挂 ${sockPath}，对端 close 即触发接管`);
      finishReady('standby');
    });
    sock.on('error', (err) => {
      // connect 失败（ENOENT/ECONNREFUSED）与挂起期错误都伴随 close 事件，
      // 语义统一在 close 里分流，这里只留观测日志。
      log(`看门狗连接错误（${err.code || ''} ${err.message}）`);
    });
    sock.on('close', () => {
      if (watchdog === sock) watchdog = null; // 防旧连接的 close 清掉重试链上的新连接
      if (state === 'stopped') return;
      if (!watchdogConnected && attempt < WATCHDOG_RETRIES) {
        // 退避理由：持有者可能刚拿锁还在 listen 前的启动窗口（毫秒级），立刻
        // 清锁会误杀活 daemon；200ms 重试给足窗口。
        log(`daemon socket 暂不可达（第 ${attempt + 1}/${WATCHDOG_RETRIES} 次），${WATCHDOG_BACKOFF_MS}ms 后重试`);
        retryTimer = setTimeout(() => becomeStandby(attempt + 1), WATCHDOG_BACKOFF_MS);
        retryTimer.unref();
        return;
      }
      const why = watchdogConnected
        ? '看门狗触发：对端连接关闭，daemon 已死亡'
        : `daemon socket ${WATCHDOG_RETRIES} 次退避后仍不可达，判定持有者死亡或未完成启动`;
      // 接管前重验当前持有者（R1）：多 standby 同时被同一 daemon 死亡唤醒时，
      // 后到者的无凭据 sweep 会删掉先到者刚上位的新 lock+sock，O_EXCL 裁决被
      // 击穿成双 daemon。死锁 pid 探活通过（core isProcessAlive）= 新持有者已就位，
      // 绝不 sweep，直接回 elect（O_EXCL 必 EEXIST → 重新 standby）。
      const holder = probeLockHolder();
      if (holder !== 'alive' && holder !== 'gone') {
        // 二次确认：缩小 probe→unlink 窗口内新持有者上位的残余竞态
        if (probeLockHolder() !== 'alive') {
          log(`${why}，清残留后重竞选`);
          sweepFiles(why);
        } else {
          log('看门狗触发但锁持有者已更换且存活（他实例已接管），不清残留，回 standby');
        }
      } else {
        log('看门狗触发时锁已被他人清理/接管，跳过 sweep，直接重竞选');
      }
      elect();
    });
  }

  function handleConn(socket) {
    const ac = new AbortController();
    socket.unref();
    conns.add(socket);
    const decoder = createFrameDecoder((line) => log(`丢弃坏帧行: ${line.slice(0, 200)}`));
    socket.on('error', (err) => log(`连接异常（${err.code || ''} ${err.message}），按断连处理`));
    socket.on('close', () => {
      conns.delete(socket);
      ac.abort(); // 断连取消本连接挂起的 handler（§7 要点 2）；重复 abort 幂等无害
    });
    (async () => {
      try {
        for await (const chunk of socket) {
          for (const frame of decoder.push(chunk)) {
            dispatch(frame, socket, ac.signal); // 故意不 await：同连接多请求并行
                                               // （挂起的 wait 不堵后续帧），响应靠 id 配对
          }
        }
      } catch (err) {
        log(`连接读取终止（${err.message}）`);
      } finally {
        ac.abort();
      }
    })();
  }

  async function dispatch(frame, socket, signal) {
    const id = frame && typeof frame === 'object' ? frame.id : undefined;
    let resp;
    if (!frame || typeof frame !== 'object') {
      resp = {
        id, ok: false,
        error: { message: '帧必须是 JSON 对象，裸值帧已丢弃。👉 检查 client 是否统一走 encodeFrame 编码' },
      };
    } else if (typeof frame.tool !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, frame.tool)) {
      resp = {
        id, ok: false,
        error: {
          message: `unknown tool: ${JSON.stringify(frame.tool) || 'undefined'}`
            + `（已注册: ${Object.keys(handlers).join(', ') || '无'}）。👉 检查 tool 字段拼写`,
        },
      };
    } else {
      try {
        // req.cwd 类型守卫在本层（MF7 帧协议契约）：仅非空 string 透传，其余
        // undefined——消费方（buildDaemonHandlers → toolHandler env.cwd）无需再防
        const result = await handlers[frame.tool]({
          tool: frame.tool,
          params: frame.params,
          cwd: typeof frame.cwd === 'string' && frame.cwd !== '' ? frame.cwd : undefined,
        }, { signal });
        resp = { id, ok: true, result: result === undefined ? null : result };
      } catch (err) {
        resp = { id, ok: false, error: { message: err && err.message ? String(err.message) : String(err) } };
      }
    }
    // 连接可能在 handler 挂起期间断开：写已销毁 socket 无意义且会触发
    // ERR_STREAM_DESTROYED——destroyed 前置检查 + socket error handler 双保险。
    if (!socket.destroyed) socket.write(encodeFrame(resp));
  }

  function elect() {
    if (state === 'stopped') return;
    state = 'electing';
    let acquired;
    try {
      acquired = tryAcquireLock();
    } catch (e) {
      failReady(e);
      return;
    }
    if (!acquired) {
      becomeStandby(0);
      return;
    }
    lockHeld = true;
    pendingListen = becomeDaemon();
    pendingListen.then(
      async () => {
        pendingListen = null;
        if (state === 'stopped') {
          // stop() 抢在 listen 完成前：立刻拆掉迟到的 server，否则 socket 文件会复活
          closeServer();
          return;
        }
        state = 'daemon';
        log(`daemon 就绪：listen ${sockPath}（pid ${process.pid}）`);
        // 接管路径（D3）：本实例之前是 standby，内存索引缺旧 daemon 后建的
        // record——回调调用方重跑 recover（record 重建 + 探活）。listen 已在
        // 服务但 recover 完成前的请求走旧索引，窄窗口内「不存在」由调用方
        // CLI 重试语义兜底（等价于 daemon 刚启动未就绪）。
        if (wasStandby && onTakeover) {
          try {
            await onTakeover();
          } catch (e) {
            log(`接管 onTakeover 失败（继续服务，record 功能可能受限）: ${e && e.message || e}`);
          }
        }
        finishReady('daemon');
      },
      (err) => {
        pendingListen = null;
        // 带着 lock 死掉会永久堵死后来者的竞选——listen 失败必先回滚自己的 lock
        lockHeld = false;
        sweepFiles('listen 失败回滚');
        failReady(new Error(`daemon 启动失败：${err.message}`));
      },
    );
  }

  /** 同步清理（信号/exit 钩子路径）：幂等，可与 stop() 任意先后。 */
  function syncCleanup() {
    if (state === 'stopped') return;
    state = 'stopped';
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (watchdog) { watchdog.destroy(); watchdog = null; }
    if (lockHeld) {
      lockHeld = false;
      sweepFiles('SIGTERM/SIGINT/exit 退出卫生');
    }
    LIVE_CLEANUPS.delete(syncCleanup);
  }

  /** 用户态关停（幂等）：断看门狗/停 server/清自己的 lock+sock。 */
  async function stop() {
    if (state === 'stopped') return;
    state = 'stopped';
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (watchdog) { watchdog.destroy(); watchdog = null; }
    const listen = pendingListen;
    pendingListen = null;
    if (server) await closeServer();
    if (listen) {
      // stop 抢在 listen 完成前：listen 完成后立刻拆（否则 socket 文件会复活）
      listen.then(() => closeServer(), () => {});
    }
    if (lockHeld) {
      lockHeld = false;
      sweepFiles('stop() 退出卫生');
    }
    LIVE_CLEANUPS.delete(syncCleanup);
  }

  installExitHooks();
  LIVE_CLEANUPS.add(syncCleanup);
  elect();
  return ready;
}

module.exports = { startDaemon };
