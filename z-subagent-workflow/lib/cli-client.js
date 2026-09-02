'use strict';
/**
 * zsw CLI thin client 的 daemon 通信层（DESIGN-v4 D2/D5，M0 = 0.2.0）。
 *
 * 职责：CLI（bin/zsw.js 默认形态）与常驻 daemon 之间的单请求单响应
 * NDJSON 帧往返。请求 `{id, tool, params, cwd}\n`，响应 `{id, ok:true, result}
 * | {id, ok:false, error:{code,message}}\n`。
 *
 * 帧协议契约单源在 lib/frame-codec.js 头注（NDJSON 语法与 cwd 传导语义见彼处）。
 *
 * 帧编解码复用 lib/frame-codec.js（encodeFrame 构请求帧 + createFrameDecoder
 * 作解码基座——字节级缓冲、行完整后才 toString 保 UTF-8 跨 chunk、坏行容忍
 * 都由基座保证）；「单请求单响应」的 client 语义留在本层包装——宽容过滤
 * （跳过无布尔 ok 的行、取首个响应帧）与对端 close 后无尾换行尾巴的兜底
 * 解出是 client 侧消费语义，不是帧语法，不进 frame-codec（收敛设计 D1）。
 *
 * sockPath 解析收口在这层：ZSW_SOCK 覆盖 > ~/.zcode/zsw/daemon.sock
 * （与 config.js 的既有 env 覆盖模式同款，测试隔离用）。
 */

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { encodeFrame, createFrameDecoder } = require('./frame-codec');

/** daemon sock 缺省路径（DESIGN-v4 D2）。 */
function defaultSockPath() {
  return process.env.ZSW_SOCK || path.join(os.homedir(), '.zcode', 'zsw', 'daemon.sock');
}

/**
 * decoder 吐出的帧里挑首个响应帧（client 侧宽容过滤，D1）：跳过裸值与无
 * 布尔 ok 字段的 JSON 行——单请求单响应场景只认 {ok:boolean} 形态。返回
 * 响应帧或 null（帧未到齐，等下一段 data / close 兜底）。
 */
function firstResponseFrame(frames) {
  return frames.find((f) => f && typeof f === 'object' && typeof f.ok === 'boolean') || null;
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
async function callDaemon({ sockPath, tool, params, cwd } = {}) {
  const sock = sockPath || defaultSockPath();
  const frameCwd = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
  const request = encodeFrame({ id: 1, tool, params, cwd: frameCwd });

  return new Promise((resolve, reject) => {
    const socket = net.connect(sock);
    const decoder = createFrameDecoder();
    let settled = false;

    // 无 connect 超时（2026-08-29 超时取消决策）：unix socket 的常态失败
    // （ENOENT/ECONNREFUSED/ENOTSOCK）由 error 分支立即接住；wait 类挂起
    // 请求的总时长无上限（--timeout-ms 的 partial 语义在 daemon 侧控制），
    // connect 后的异常断连由 close/error 分支处理（§5.2 第 3 行）
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };

    socket.on('connect', () => { socket.write(request); });
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
      const resp = firstResponseFrame(decoder.push(chunk));
      if (!resp) return; // 半截帧/无 ok 噪音行：等下一段 data
      settle(() => resolve(toResult(resp)));
      socket.end();
    });
    socket.on('close', () => {
      // 对端关闭：给 decoder 补一个换行，把无尾换行的残余尾巴按行 flush
      // （daemon 侧不规范写出的宽容形态；close 后不会再有 data，尾巴一次
      // 成行、无跨 chunk 切分）；仍无响应帧 = 未收到响应即断连（典型：wait
      // 挂起期间 daemon 随宿主会话死亡）
      const resp = firstResponseFrame(decoder.push('\n'));
      if (resp) settle(() => resolve(toResult(resp)));
      else settle(() => reject(new Error(
        `daemon 连接中断，未收到响应帧（sock ${sock}）——任务执行体随 daemon 终止。`
        + '恢复指引：稍候重试（其他实例接管需 1-2s）；任务状态稍后用 status --id 查询'
        + '（record 由接管实例 recover 落盘），必要时重新派发。',
      )));
    });
  });
}

module.exports = { callDaemon, defaultSockPath };
