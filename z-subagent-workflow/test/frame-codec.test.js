'use strict';

/**
 * lib/frame-codec.js 单元锚（收敛设计 D1 / 探针 P-frame 的 push 直驱面）：
 * decoder 经 push 直接驱动，不经 socket 传输层——与 daemon-socket.test.js 的
 * 「帧编解码回归锚」组（socket 字节级写入驱动生产 decoder，可观测面 = 分发
 * 响应 + onBadLine 留痕）互补，共同锚定迁移后的帧语义：行完整后才 toString
 * （多字节 UTF-8 跨 chunk 保真）、坏行丢弃不断流、半包字节缓冲、空行跳过、
 * 粘包逐帧解析。encodeFrame 锚定「对象 → 单行 JSON + '\n'」的出口形态。
 */

const test = require('node:test');
const assert = require('node:assert');

const { encodeFrame, createFrameDecoder } = require('../lib/frame-codec');

test('encodeFrame：对象 → 单行 JSON + 换行（含中文值保真，无多余空白）', () => {
  assert.strictEqual(encodeFrame({ id: 1, ok: true }), '{"id":1,"ok":true}\n');
  const withCjk = encodeFrame({ error: { message: '任务「审查」完成' } });
  assert.strictEqual(withCjk, `${JSON.stringify({ error: { message: '任务「审查」完成' } })}\n`);
  assert.ok(!withCjk.slice(0, -1).includes('\n'), '帧内不得出现换行（单行契约）');
});

test('粘包：多帧拼一个 chunk 一次 push → 逐帧解析恰好吐出', () => {
  const decoder = createFrameDecoder();
  const out = decoder.push(
    encodeFrame({ id: 1, tool: 'zsub', params: { n: 1 } })
    + encodeFrame({ id: 2, tool: 'zsub', params: { n: 2 } })
    + encodeFrame({ id: 3, tool: 'zsub', params: { n: 3 } }),
  );
  assert.deepStrictEqual(out.map((f) => f.id), [1, 2, 3], '粘包不吞帧不重复');
  assert.deepStrictEqual(out[1].params, { n: 2 }, '粘包不损帧语义');
});

test('半包：一帧按字节切 3 段跨 push 拼接 → 恰好吐一帧（不重复不截断）', () => {
  const decoder = createFrameDecoder();
  const buf = Buffer.from(encodeFrame({ id: 7, params: { half: true } }), 'utf8');
  assert.deepStrictEqual(decoder.push(buf.subarray(0, 3)), [], '前 3 字节不成行，零帧');
  assert.deepStrictEqual(decoder.push(buf.subarray(3, buf.length - 4)), [], '中段仍不成行，零帧');
  const out = decoder.push(buf.subarray(buf.length - 4));
  assert.strictEqual(out.length, 1, '尾段到齐恰好一帧');
  assert.deepStrictEqual(out[0], { id: 7, params: { half: true } }, '拼装后帧语义完整');
});

test('跨 chunk UTF-8 切分：多字节字符被 chunk 边界切开不乱码、不误判坏行', () => {
  const badLines = [];
  const decoder = createFrameDecoder((line) => badLines.push(line));
  const text = '多字节帧切片';
  const buf = Buffer.from(encodeFrame({ id: 1, params: { text } }), 'utf8');
  // 在「帧」（3 字节序列）的中间字节切开：逐 chunk 解码会产生替换字符，
  // 只有行完整后才 toString 才能保真
  const cut = buf.indexOf(Buffer.from('帧', 'utf8')) + 2;
  assert.deepStrictEqual(decoder.push(buf.subarray(0, cut)), [], '切开点不成行，零帧');
  const [frame] = decoder.push(buf.subarray(cut));
  assert.strictEqual(frame.params.text, text, '跨 chunk 切开的多字节字符原样还原');
  assert.deepStrictEqual(badLines, [], 'UTF-8 切分不得被误判为坏行');
});

test('坏行容忍：JSON.parse 失败丢弃且 onBadLine 收到原始行，后续帧不受影响', () => {
  const badLines = [];
  const decoder = createFrameDecoder((line) => badLines.push(line));
  const out = decoder.push(
    'not-a-json-line {oops\n'
    + encodeFrame({ id: 1, ok: true })
    + 'another bad [line\n'
    + encodeFrame({ id: 2, ok: false }),
  );
  assert.deepStrictEqual(out.map((f) => f.id), [1, 2], '单行（多处）损坏不中断后续解码');
  assert.deepStrictEqual(badLines, ['not-a-json-line {oops', 'another bad [line'],
    '每条坏行各回调一次，携带原始行内容');
});

test('坏行不传 onBadLine：静默丢弃不抛错（client 侧消费形态）', () => {
  const decoder = createFrameDecoder();
  const out = decoder.push(`{broken\n${encodeFrame({ id: 5, ok: true })}`);
  assert.deepStrictEqual(out, [{ id: 5, ok: true }], '无回调时坏行同样静默跳过');
});

test('空行跳过：空行/纯空白行不是帧，夹在合法帧间不产生输出', () => {
  const decoder = createFrameDecoder();
  const out = decoder.push(
    `\n\n   \n${encodeFrame({ id: 1, ok: true })}\n\t \n${encodeFrame({ id: 2, ok: true })}\n\n`,
  );
  assert.deepStrictEqual(out.map((f) => f.id), [1, 2], '只有非空行成帧');
});

test('裸值原样吐出：解析成功的数字/字符串不加包装，由分发层把关形态', () => {
  const decoder = createFrameDecoder();
  const out = decoder.push(`42\n"bare-string"\nnull\n`);
  assert.deepStrictEqual(out, [42, 'bare-string', null], '裸值不经形态转换');
});

test('行首尾空白 trim 后仍可解析；string chunk 输入与 Buffer 等价', () => {
  const decoder = createFrameDecoder();
  const line = encodeFrame({ id: 3, ok: true }).trimEnd();
  const out = decoder.push(`   ${line}  \n`);
  assert.deepStrictEqual(out, [{ id: 3, ok: true }], '首尾空白不影响解析');

  const viaString = createFrameDecoder();
  assert.deepStrictEqual(
    viaString.push(encodeFrame({ id: 4, ok: true })),
    [{ id: 4, ok: true }],
    'push 接受 string 输入（JSDoc 契约），与 Buffer 同构',
  );
});
