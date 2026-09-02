'use strict';
/**
 * zsw socket 帧语法单源（NDJSON 契约见此；zsw-socket-record-convergence-design
 * §3.3 D1）：encodeFrame / createFrameDecoder 从 lib/daemon-socket.js 原样迁出，
 * daemon-socket（daemon 侧）与 cli-client（client 侧）统一 import 本模块——帧
 * 语法演进只改这一处。S8 的职责分离保持：传输层职责（listen/accept/锁竞选/
 * 看门狗）留在 daemon-socket；client 侧「单请求单响应」消费语义（宽容过滤、
 * 取首个响应帧）留在 cli-client——本模块只承载两端共用的帧语法。
 *
 * 帧协议契约（D2，NDJSON；MF7 扩展 cwd 字段）：
 *   请求 {id, tool:"zsub"|"zflow", params:{...}, cwd?}
 *     cwd：string，可选——调用方进程目录。多 worktree 下 agent 发现 / worktree
 *     定位依赖发起方 cwd（daemon 宿主 cwd 会用错目录），故随帧传导。传输层
 *     仅做类型守卫：非 string 忽略（req.cwd = undefined），存在性校验留给
 *     handler 层（workdir/resolver 已有，协议层不重复）。
 *   响应 {id, ok:true, result} | {id, ok:false, error:{message}}
 */

/** NDJSON 编码：对象 → 单行 JSON + '\n'。协议出口统一走这里，client 复用。 */
function encodeFrame(obj) {
  return `${JSON.stringify(obj)}\n`;
}

/**
 * 流式 NDJSON 解码器：按行分割 + JSON.parse，半包缓冲跨 chunk 拼接。
 * 内部按字节（0x0A）找行边界、行完整后才 toString——多字节 UTF-8 被 chunk
 * 边界切开时逐 chunk 解码会产生替换字符，帧含中文（任务书/错误消息）必坏。
 * 坏行（JSON.parse 失败）丢弃并回调 onBadLine（传 log 即可观测），单行损坏
 * 不中断后续解码；解析成功的裸值（数字/字符串）原样吐出，由分发层把关形态。
 *
 * @param {(badLine: string) => void} [onBadLine]
 * @returns {{ push(chunk: string|Buffer): object[] }} 每次吃进一个 chunk，吐出其中的完整帧
 */
function createFrameDecoder(onBadLine) {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = Buffer.concat([
        buf,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'),
      ]);
      const frames = [];
      let nl;
      while ((nl = buf.indexOf(0x0a)) >= 0) {
        const line = buf.subarray(0, nl).toString('utf8').trim();
        buf = buf.subarray(nl + 1);
        if (!line) continue; // 空行不是帧（如结尾 \n 后的尾巴）
        try {
          frames.push(JSON.parse(line));
        } catch {
          if (onBadLine) onBadLine(line);
        }
      }
      return frames;
    },
  };
}

module.exports = { encodeFrame, createFrameDecoder };
