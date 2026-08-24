'use strict';
/**
 * zsw CLI thin client 的 daemon 通信层（DESIGN-v4 D2/D5，M0 = 0.2.0）。
 *
 * 职责：CLI（bin/zsw.js 默认形态）与常驻 daemon 之间的单请求单响应
 * NDJSON 帧往返。请求 `{id, tool, params, cwd}\n`，响应 `{id, ok:true, result}
 * | {id, ok:false, error:{code,message}}\n`。
 *
 * 帧协议契约（与 lib/daemon-socket.js 头注同源维护）：
 *   cwd  string，可选；调用方进程目录（多 worktree 下 agent 发现 / worktree
 *       定位依赖发起方 cwd，daemon 宿主 cwd 会用错目录）。缺省 CLI 侧
 *       process.cwd()；daemon 侧仅接受非空 string，其余忽略（MF7）。
 *
 * 为什么自带一份最小帧编解码而不复用 lib/daemon-socket.js（S8 收敛定论）：
 * 那是服务端传输层（listen/accept/锁竞选/看门狗），客户端只需「encode 一行
 * JSON + 按行读到首个含布尔 ok 的合法 JSON 帧」——单请求单响应场景两端帧
 * 语法相同但状态机完全不同。集成后两边各留一份最小实现（语义兼容，帧语法
 * 变更须两文件同步改）；帧协议契约以本头注「帧协议契约」段为权威，
 * daemon-socket.js 头注互指于此。
 *
 * sockPath 解析收口在这层：ZSW_SOCK 覆盖 > ~/.zcode/zsw/daemon.sock
 * （与 config.js 的既有 env 覆盖模式同款，测试隔离用）。
 */

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

/** connect 超时兜底：unix socket 的常态失败（ENOENT/ECONNREFUSED）是立即的，
 *  超时只覆盖「sock 存在但对端卡死」的极端场景，5s 足够区分两者。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/** daemon sock 缺省路径（DESIGN-v4 D2）。 */
function defaultSockPath() {
  return process.env.ZSW_SOCK || path.join(os.homedir(), '.zcode', 'zsw', 'daemon.sock');
}

/**
 * 从累积 Buffer 中解出首个响应帧。宽容点（防御 daemon 侧不规范写出，不
 * 改变协议本身）：跳过空行/纯空白行/非 JSON 行/无布尔 ok 字段的 JSON 行。
 * 返回 {resp} 或 null（帧未到齐，等下一段 data / close 兜底）。
 *
 * 累积必须按 Buffer、行完整后才 toString（与 daemon 侧 createFrameDecoder
 * 同款语义）：多字节 UTF-8 序列（中文任务结果/错误消息）被 chunk 边界切开
 * 时，逐 chunk toString 会产生替换字符，整行 JSON.parse 失败、帧被当坏行
 * 跳过——任务成功却报「连接中断」。
 */
function extractResponseFrame(buffer) {
  let start = 0;
  for (;;) {
    const nl = buffer.indexOf(0x0a, start);
    const line = buffer.subarray(start, nl === -1 ? undefined : nl).toString('utf8').trim();
    if (line !== '') {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && typeof obj.ok === 'boolean') return { resp: obj };
      } catch { /* 半截帧或坏行：等下一段 data / 跳过 */ }
    }
    if (nl === -1) return null;
    start = nl + 1;
  }
}

/** 响应帧 → 对外返回形态：剥 id，保留 {ok, result?, error?}。 */
function toResult(resp) {
  return { ok: resp.ok, result: resp.result, error: resp.error };
}

/**
 * 单请求单响应调用 daemon。
 *
 * - cwd：请求帧的调用方进程目录（MF7 帧协议扩展）。缺省 process.cwd()——
 *   CLI 侧不显式传即天然带上；非 string / 空串视为缺省（daemon 侧仅接受
 *   非空 string，这里提前收口防异常值上帧）。
 * - 成功（含业务失败 ok:false）→ resolve {ok, result?, error?}——ok:false 是
 *   daemon 的正常应答而非传输层异常，exit code 由调用方判定。
 * - connect 失败（ECONNREFUSED/ENOENT）→ throw 可操作错误（DESIGN-v4 §5.2
 *   第 1 行口径；本地执行 = 显式 --local）。
 * - 连接中断未收到响应帧 → throw 可操作错误（§5.2 第 3 行：wait 挂起期间
 *   daemon 随宿主会话死亡的恢复指引）。
 */
async function callDaemon({ sockPath, tool, params, cwd, connectTimeoutMs } = {}) {
  const sock = sockPath || defaultSockPath();
  const timeout = Number.isFinite(connectTimeoutMs) ? connectTimeoutMs : DEFAULT_CONNECT_TIMEOUT_MS;
  const frameCwd = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
  const request = `${JSON.stringify({ id: 1, tool, params, cwd: frameCwd })}\n`;

  return new Promise((resolve, reject) => {
    const socket = net.connect(sock);
    let buffer = Buffer.alloc(0);
    let settled = false;

    const connectTimer = setTimeout(() => {
      settle(() => reject(new Error(
        `daemon 连接超时（connect ${sock}，${timeout}ms 无应答）。`
        + '恢复指引：稍候重试（多会话下其他实例接管需 1-2s）；'
        + '仍失败则在任一 zcode 会话确认插件已启用（改插件配置后需重启 ZCode 才生效）。',
      )));
      socket.destroy();
    }, timeout);

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      fn();
    };

    // connect 超时只覆盖 TCP connect 阶段：连上即清——wait 类挂起请求的总
    // 时长无上限（由 --timeout-ms 的 partial 语义在 daemon 侧控制），connect
    // 后的异常断连由 close/error 分支处理（§5.2 第 3 行）
    socket.on('connect', () => { clearTimeout(connectTimer); socket.write(request); });
    socket.on('error', (err) => {
      // 三种 errno 都是「daemon 不在场/sock 路径形态损坏」：文件不存在
      // （ENOENT）、监听者已死但文件残留（ECONNREFUSED，daemon 异常死亡）、
      // 路径被非 socket 文件占用（ENOTSOCK）——给同款可操作文案
      if (err && (err.code === 'ECONNREFUSED' || err.code === 'ENOENT' || err.code === 'ENOTSOCK')) {
        settle(() => reject(new Error(
          `daemon 未运行（connect ${sock} 失败：${err.code}）。`
          + '恢复指引：稍候重试（多会话下其他实例接管需 1-2s）；'
          + '仍失败则在任一 zcode 会话确认插件已启用；'
          + '或加 --local 走本地一次性执行（调试后门：无续聊/限流，CLI 退出即丢执行体）。',
        )));
        return;
      }
      settle(() => reject(err));
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const frame = extractResponseFrame(buffer);
      if (!frame) return; // 半截帧：等下一段 data
      settle(() => resolve(toResult(frame.resp)));
      socket.end();
    });
    socket.on('close', () => {
      // 对端关闭：残留里还有完整帧（无尾换行的宽容形态）照常解出；否则 =
      // 未收到响应即断连（典型：wait 挂起期间 daemon 随宿主会话死亡）
      const frame = extractResponseFrame(buffer);
      if (frame) settle(() => resolve(toResult(frame.resp)));
      else settle(() => reject(new Error(
        `daemon 连接中断，未收到响应帧（sock ${sock}）——任务执行体随 daemon 终止。`
        + '恢复指引：稍候重试（其他实例接管需 1-2s）；任务状态稍后用 status --id 查询'
        + '（record 由接管实例 recover 落盘），必要时重新派发。',
      )));
    });
  });
}

module.exports = { callDaemon, defaultSockPath, DEFAULT_CONNECT_TIMEOUT_MS };
