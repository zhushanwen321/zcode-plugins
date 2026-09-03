'use strict';
/**
 * record compact 单元锚（socket-record 收口设计 §3.4 探针 + §4 A8 单元版；
 * 2.0 起挂点宿主 = lib/assemble.js（CLI 组装路径），原 daemon 启动/接管挂点
 * 与真实 daemon 场景 A5-A7/P-mount 验收随 daemon 退役）。
 *
 * 锚定的行为面：
 *   - P-compact-equiv：compact 后文件仍是合法事件流，rebuild 与 compact 前
 *     保留子集索引逐字段一致；孤儿行组（created 行损坏 + 同 run 后续行存活）
 *     保守保留。
 *   - P-occ（D9② 双向复查两面）：读后复查前并发 append 变大 / 他者 compact
 *     rename 缩小 → 均放弃 + temp 清理 + stderr 留痕。
 *   - P-keep-env：ZSW_RECORD_KEEP 正整数生效/缺省回落/非法警告回落
 *     （resolveStateKeep 家族语义）。
 *   - A8 单元版：活跃 run 与 lost run 居文件中部不被删、终态超 keep 删最旧。
 *   - 挂点 helper（assemble.compactRecords）：总数 ≤ keep 零成本跳过 / 结果日志 /
 *     失败不外抛。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { RecordStore } = require('../lib/record-store');
const config = require('../lib/config');
// assemble.js require 零副作用（头注声明），compactRecords 是挂点行为的可测面
const { compactRecords } = require('../lib/assemble');

// ------------------------------------------------- fixture 构造

/** 建临时目录 + 台账文件（缺 lines 则不建文件），返回已注入路径的 store。 */
function tmpStore(t, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsw-compact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'records.jsonl');
  if (lines && lines.length > 0) fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return new RecordStore({ filePath });
}

/** 终态 run 两事件（created → cancelled；closed 不在 created 出边，用 cancelled）。 */
function termRun(id, ts) {
  return [
    JSON.stringify({ ts, type: 'created', subagentId: id, task: `task-${id}`, slug: id }),
    JSON.stringify({ ts: ts + 1, type: 'transition', id, from: 'created', to: 'cancelled', closedReason: 'fixture' }),
  ];
}

/** 活跃 run 单事件（rebuild 后内存标 lost，D8 活跃语义）。 */
function activeRun(id, ts) {
  return [JSON.stringify({ ts, type: 'created', subagentId: id, task: `task-${id}`, slug: id })];
}

/** lost 态 run 两事件（created → running，无终态——崩溃遗留形态）。 */
function lostRun(id, ts) {
  return [
    JSON.stringify({ ts, type: 'created', subagentId: id, task: `task-${id}`, slug: id }),
    JSON.stringify({ ts: ts + 1, type: 'transition', id, from: 'created', to: 'running' }),
  ];
}

/** 同步捕获 fn 执行期的 stderr 输出（lib 层警告/放弃留痕断言用）。 */
function captureStderr(fn) {
  const orig = process.stderr.write;
  const chunks = [];
  process.stderr.write = (c) => { chunks.push(String(c)); return true; };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join('');
}

// ------------------------------------------------- P-compact-equiv

test('P-compact-equiv: compact 后 rebuild 与保留子集索引逐字段一致（含孤儿行组）', (t) => {
  const lines = [];
  for (let i = 1; i <= 8; i++) lines.push(...termRun(`term-${i}`, 1000 + i * 10));
  lines.push(...activeRun('act-1', 2000)); // 活跃（rebuild 后 lost）
  lines.push(...lostRun('lost-1', 2100));  // lost（created→running 后崩）
  // 孤儿行组：created 行 JSON 损坏（重放 skipped）+ 同 run 的 update 行存活
  // （引用不存在 record，同样 skipped）——组不进索引，D8 裁决保守保留
  lines.push('{"ts":3000,"type":"created","subagentId":"orph-1"');
  lines.push(JSON.stringify({ ts: 3001, type: 'update', id: 'orph-1', exec: { pid: 4321 } }));
  lines.push(...termRun('term-9', 4000)); // 文件尾部终态（最新）

  const store = tmpStore(t, lines);
  const st = store.rebuildFromLog();
  assert.equal(st.records, 11); // 9 终态 + act-1 + lost-1（orph-1 全 skipped）

  // compact 前保留子集快照：终态 lastTs 降序前 keep=3 = term-9/term-8/term-7
  const expected = new Map();
  for (const rec of store.list()) expected.set(rec.subagentId, rec);

  const r = store.compact({ keep: 3 });
  assert.equal(r.removedRuns, 6);   // term-1..6
  assert.equal(r.removedLines, 12); // 6 run × 2 行
  assert.equal(r.keptRuns, 6);      // term-7/8/9 + act-1 + lost-1 + orph-1
  assert.equal(r.skipped, undefined);
  assert.equal(store.records.size, 5); // 内存索引同步收缩（orph-1 本就不在索引）

  // 重放等价：新 store 重放 compact 后文件，保留 run 索引逐字段一致
  const re = new RecordStore({ filePath: store.filePath });
  const st2 = re.rebuildFromLog();
  assert.equal(st2.records, 5);
  assert.equal(st2.applied, 9); // 3 终态×2 + act 1 + lost 2
  assert.equal(st2.skipped, 2); // 孤儿组的坏 created 行 + update 行
  for (const id of ['term-7', 'term-8', 'term-9', 'act-1', 'lost-1']) {
    assert.deepEqual(re.get(id), expected.get(id), `run ${id} rebuild 后逐字段一致`);
  }
  // 被删 run 从索引消失；孤儿行组仍在文件（坏行 + update 行都保留）
  assert.equal(re.get('term-1'), null);
  const raw = fs.readFileSync(store.filePath, 'utf8');
  assert.ok(raw.includes('{"ts":3000,"type":"created","subagentId":"orph-1"'), '损坏 created 行原样保留');
  assert.ok(raw.includes('"id":"orph-1"'), '孤儿 update 行保留');
  for (let i = 1; i <= 6; i++) assert.ok(!raw.includes(`"subagentId":"term-${i}"`), `term-${i} 行已删`);
});

// ------------------------------------------------- A8 单元版

test('A8 单元版: 活跃/lost run 居文件中部不被删，终态超 keep 删最旧', (t) => {
  const lines = [];
  for (let i = 1; i <= 4; i++) lines.push(...termRun(`old-${i}`, 1000 + i * 10)); // 最旧终态
  const actLines = activeRun('act-1', 5000);
  const lostLines = lostRun('lost-1', 5100);
  lines.push(...actLines, ...lostLines); // 活跃/lost 居中部：前有旧终态
  for (let i = 5; i <= 7; i++) lines.push(...termRun(`new-${i}`, 6000 + i * 10)); // 最新终态

  const store = tmpStore(t, lines);
  store.rebuildFromLog();
  const r = store.compact({ keep: 3 });
  assert.equal(r.removedRuns, 4); // old-1..4（最旧）

  const raw = fs.readFileSync(store.filePath, 'utf8');
  for (const l of actLines) assert.ok(raw.includes(l), '活跃 run 行未被删');
  for (const l of lostLines) assert.ok(raw.includes(l), 'lost run 行未被删');
  for (let i = 5; i <= 7; i++) assert.ok(raw.includes(`"subagentId":"new-${i}"`), `new-${i} 保留`);
  for (let i = 1; i <= 4; i++) assert.ok(!raw.includes(`"subagentId":"old-${i}"`), `old-${i} 已删`);
  // 状态无损：rebuild 后活跃/lost 标 lost、终态照抄
  const re = new RecordStore({ filePath: store.filePath });
  re.rebuildFromLog();
  assert.equal(re.get('act-1').status, 'lost');
  assert.equal(re.get('lost-1').status, 'lost');
  assert.equal(re.get('new-7').status, 'cancelled');
});

test('compact: 终态未超 keep 但总数超（大量 lost 在册）→ 不动文件', (t) => {
  const lines = [];
  lines.push(...termRun('term-1', 1000));
  for (let i = 1; i <= 12; i++) lines.push(...lostRun(`lost-${i}`, 2000 + i));
  const store = tmpStore(t, lines);
  store.rebuildFromLog();
  const before = fs.statSync(store.filePath);
  const tmp = `${store.filePath}.compact-${process.pid}.tmp`;
  const r = store.compact({ keep: 10 }); // 终态 1 ≤ 10，lost 全保
  assert.deepEqual(r, { removedRuns: 0, removedLines: 0, keptRuns: 13 });
  const after = fs.statSync(store.filePath);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.ok(!fs.existsSync(tmp), '未写 temp');
});

// ------------------------------------------------- P-occ（D9② 双向复查两面）

test('P-occ 面1: 读后复查前并发 append 变大 → 放弃 + temp 清理 + stderr 留痕', (t) => {
  const lines = [];
  for (let i = 1; i <= 5; i++) lines.push(...termRun(`term-${i}`, 1000 + i * 10));
  const store = tmpStore(t, lines);
  store.rebuildFromLog();
  const linesBefore = fs.readFileSync(store.filePath, 'utf8').split('\n').filter((l) => l.trim()).length;
  const tmp = `${store.filePath}.compact-${process.pid}.tmp`;

  // 注入「compact 写 temp 时他者恰好 append」：patch fs.writeFileSync，命中
  // temp 路径先向原文件追加一行再放行（模拟 D9② 检测面：size 变大）
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function patched(p, data, opts) {
    if (typeof p === 'string' && p === tmp) {
      fs.appendFileSync(store.filePath,
        `${JSON.stringify({ ts: 99999, type: 'update', id: 'term-5', notified: true })}\n`);
    }
    return realWrite.call(fs, p, data, opts);
  };
  let r;
  let stderr;
  try {
    stderr = captureStderr(() => { r = store.compact({ keep: 2 }); });
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(r.skipped, true);
  assert.equal(r.removedRuns, 0);
  assert.ok(!fs.existsSync(tmp), 'temp 已清理');
  assert.ok(stderr.includes('record compact 放弃'), 'stderr 留痕');
  // 他者写入不被动：append 的行仍在（放弃 = 本次不替换，不回滚他人）
  const linesAfter = fs.readFileSync(store.filePath, 'utf8').split('\n').filter((l) => l.trim()).length;
  assert.equal(linesAfter, linesBefore + 1);
});

test('P-occ 面2: 复查前他者 compact 已 rename 缩小 → 放弃', (t) => {
  const lines = [];
  for (let i = 1; i <= 5; i++) lines.push(...termRun(`term-${i}`, 1000 + i * 10));
  const store = tmpStore(t, lines);
  store.rebuildFromLog();
  const tmp = `${store.filePath}.compact-${process.pid}.tmp`;

  // 注入「复查前他者已 rename 缩小」：写 temp 时把原文件替换为更小的合法流
  // （模拟他者 compact 的产物），本实例复查发现 size 缩小即放弃
  const realWrite = fs.writeFileSync;
  const shrunk = `${termRun('term-5', 5000).join('\n')}\n`;
  fs.writeFileSync = function patched(p, data, opts) {
    if (typeof p === 'string' && p === tmp) realWrite.call(fs, store.filePath, shrunk);
    return realWrite.call(fs, p, data, opts);
  };
  let r;
  let stderr;
  try {
    stderr = captureStderr(() => { r = store.compact({ keep: 2 }); });
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(r.skipped, true);
  assert.equal(r.removedRuns, 0);
  assert.ok(!fs.existsSync(tmp), 'temp 已清理');
  assert.ok(stderr.includes('record compact 放弃'), 'stderr 留痕');
  assert.equal(fs.readFileSync(store.filePath, 'utf8'), shrunk, '他者产物不被覆盖');
});

// ------------------------------------------------- P-keep-env

test('P-keep-env: ZSW_RECORD_KEEP 正整数生效 / 缺省与空回落 1000 / 非法警告回落', () => {
  assert.equal(config.resolveRecordKeep({ ZSW_RECORD_KEEP: '150' }), 150);
  assert.equal(config.resolveRecordKeep({ ZSW_RECORD_KEEP: '1' }), 1);
  assert.equal(config.resolveRecordKeep({}), 1000);
  assert.equal(config.resolveRecordKeep({ ZSW_RECORD_KEEP: '' }), 1000);
  const stderr = captureStderr(() => {
    assert.equal(config.resolveRecordKeep({ ZSW_RECORD_KEEP: 'abc' }), 1000);
    assert.equal(config.resolveRecordKeep({ ZSW_RECORD_KEEP: '-3' }), 1000);
    assert.equal(config.resolveRecordKeep({ ZSW_RECORD_KEEP: '2.5' }), 1000);
  });
  assert.ok(stderr.includes('ZSW_RECORD_KEEP="abc" 非法'), '非法值警告含原文');
  assert.ok(stderr.includes('回落缺省 1000'), '警告含回落值');
  assert.ok(stderr.includes('恢复指引'), '警告可操作');
});

// ------------------------------------------------- 挂点 helper + 输入校验

test('server.compactRecords: 总数 ≤ keep 零成本跳过，不触 compact 不出日志', () => {
  const store = { records: new Map(), compact() { throw new Error('不应被调'); } };
  store.records.set('a', {});
  const logs = [];
  compactRecords({ records: store }, 'startup', (m) => logs.push(m));
  assert.deepEqual(logs, []);
});

test('server.compactRecords: 超阈值执行并出结果日志；失败不外抛', () => {
  const fake = {
    records: {
      records: { size: 1500 },
      compact() { return { removedRuns: 500, removedLines: 2500, keptRuns: 1000 }; },
    },
  };
  const logs = [];
  compactRecords(fake, 'startup', (m) => logs.push(m));
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('removedRuns=500'), '日志含 removedRuns');
  assert.ok(logs[0].includes('phase=startup'));

  const boom = {
    records: {
      records: { size: 1500 },
      compact() { throw new Error('disk full'); },
    },
  };
  const logs2 = [];
  compactRecords(boom, 'takeover', (m) => logs2.push(m));
  assert.equal(logs2.length, 1);
  assert.ok(logs2[0].includes('record compact 失败'), '失败留痕');
  assert.ok(logs2[0].includes('disk full'));
});

test('compact 输入校验: keep 非正整数抛可操作错误且不落盘', (t) => {
  const store = tmpStore(t, termRun('term-1', 1000));
  store.rebuildFromLog();
  const before = fs.readFileSync(store.filePath, 'utf8');
  for (const bad of [undefined, 0, -1, 2.5, 'x', null]) {
    assert.throws(() => store.compact({ keep: bad }), /keep: 正整数/, `keep=${JSON.stringify(bad)} 拒绝`);
  }
  assert.equal(fs.readFileSync(store.filePath, 'utf8'), before, '校验失败不落盘');
  assert.ok(!fs.existsSync(`${store.filePath}.compact-${process.pid}.tmp`));
});
