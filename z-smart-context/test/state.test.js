'use strict';

// lib/state 纯函数与薄 IO 单测。不 mock db、不发网络请求；
// 涉及落盘的用例（saveState/loadState/孤儿清理）用真实临时目录，测完即清。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  isValidSessionId,
  loadState,
  saveState,
  intersectFired,
  detectDropout,
  pickTier,
  isNestedSession,
  cleanOrphanStates,
} = require('../lib/state');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zsc-state-test-'));
}

// ---- isValidSessionId（D3 定案①）----

test('isValidSessionId: 合法 sess_ 形态', () => {
  assert.equal(isValidSessionId('sess_abc123'), true);
  assert.equal(isValidSessionId('sess_A.B_c-d'), true);
});

test('isValidSessionId: 路径穿越串与脏输入全部拒绝', () => {
  assert.equal(isValidSessionId('../../etc/passwd'), false);
  assert.equal(isValidSessionId('sess_../../evil'), false);
  assert.equal(isValidSessionId('sess_a/b'), false);
  assert.equal(isValidSessionId('sess_'), false);
  assert.equal(isValidSessionId(''), false);
  assert.equal(isValidSessionId('other_abc'), false);
  assert.equal(isValidSessionId('sess abc'), false);
  assert.equal(isValidSessionId(null), false);
  assert.equal(isValidSessionId(123), false);
});

// ---- intersectFired（D3 定案②：配置变更求交）----

test('intersectFired: 保留仍在新配置内的 fired 值', () => {
  assert.deepEqual(intersectFired([200000, 400000], [400000, 600000]), [400000]);
  assert.deepEqual(intersectFired([200000, 600000], [200000, 400000, 600000]), [200000, 600000]);
});

test('intersectFired: 配置变更后旧 fired 全部失效时返回空数组', () => {
  assert.deepEqual(intersectFired([250000], [200000, 400000, 600000]), []);
});

test('intersectFired: 空/非法入参容错', () => {
  assert.deepEqual(intersectFired([], [200000]), []);
  assert.deepEqual(intersectFired(undefined, [200000]), []);
  assert.deepEqual(intersectFired([200000], undefined), []);
});

// ---- detectDropout（D4 两公式分支）----

test('detectDropout: fired 交集非空 → 阈值 = min(交集) × 0.8', () => {
  const state = { firedTiers: [400000], lastTokens: 500000 };
  const tiers = [200000, 400000, 600000];
  // 阈值 = 320000
  assert.equal(detectDropout(state, 300000, tiers), true);
  assert.equal(detectDropout(state, 320000, tiers), false); // 严格小于才算回落
  assert.equal(detectDropout(state, 330001, tiers), false);
});

test('detectDropout: fired 交集为空（配置变更）→ 阈值 = lastTokens × 0.5', () => {
  const state = { firedTiers: [250000], lastTokens: 300000 };
  const tiers = [200000, 400000, 600000];
  // 阈值 = 150000
  assert.equal(detectDropout(state, 140000, tiers), true);
  assert.equal(detectDropout(state, 160000, tiers), false);
});

test('detectDropout: firedTiers 为空但 lastTokens > 0 → 走 0.5 分支', () => {
  const state = { firedTiers: [], lastTokens: 100000 };
  assert.equal(detectDropout(state, 40000, [200000]), true);
  assert.equal(detectDropout(state, 60000, [200000]), false);
});

test('detectDropout: lastTokens <= 0 一律 false', () => {
  assert.equal(detectDropout({ firedTiers: [200000], lastTokens: 0 }, 0, [200000]), false);
  assert.equal(detectDropout({ firedTiers: [], lastTokens: -1 }, 100, [200000]), false);
});

// ---- pickTier ----

test('pickTier: 返回最小的已越档且未 fired 的档位', () => {
  const tiers = [200000, 400000, 600000];
  assert.equal(pickTier(tiers, 450000, []), 200000);
  assert.equal(pickTier(tiers, 450000, [200000]), 400000);
  assert.equal(pickTier(tiers, 650000, [200000, 400000]), 600000);
});

test('pickTier: 无可提醒档位返回 null', () => {
  const tiers = [200000, 400000, 600000];
  assert.equal(pickTier(tiers, 199999, []), null); // 未越任何档
  assert.equal(pickTier(tiers, 650000, [200000, 400000, 600000]), null); // 全部已 fired
});

test('pickTier: 恰好等于档位算已越档', () => {
  assert.equal(pickTier([200000], 200000, []), 200000);
});

// ---- isNestedSession（D3 双判）----

test('isNestedSession: env 存在 _NESTED$ 键名即嵌套', () => {
  assert.equal(isNestedSession({ ZSW_NESTED: '1' }, null), true);
  assert.equal(isNestedSession({ OTHER: 'x', DWF_NESTED: '1' }, null), true);
});

test('isNestedSession: parentDbId 非空即嵌套（内建 Agent 子会话不带 env 标记）', () => {
  assert.equal(isNestedSession({}, 'sess_parent_x'), true);
});

test('isNestedSession: 双条件全否则不嵌套', () => {
  assert.equal(isNestedSession({}, null), false);
  assert.equal(isNestedSession({}, ''), false);
  assert.equal(isNestedSession({ FOO: 'bar' }, null), false);
  assert.equal(isNestedSession({ nested: '1' }, null), false); // 大小写敏感：不以 _NESTED 结尾不算
});

// ---- loadState / saveState 薄 IO 往返 ----

test('loadState/saveState: 往返一致，updatedAt 由 saveState 刷新', () => {
  const dir = makeTmpDir();
  try {
    saveState(dir, 'sess_roundtrip', { firedTiers: [200000], lastTokens: 123456 });
    const loaded = loadState(dir, 'sess_roundtrip');
    assert.deepEqual(loaded.firedTiers, [200000]);
    assert.equal(loaded.lastTokens, 123456);
    assert.equal(typeof loaded.updatedAt, 'number');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadState: 无文件返回空状态', () => {
  const dir = makeTmpDir();
  try {
    assert.deepEqual(loadState(dir, 'sess_missing'), { firedTiers: [], lastTokens: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadState: 坏 JSON 改名 .bak 后按无状态重建（§3.4）', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'sess_broken.json');
    fs.writeFileSync(file, '{broken json');
    assert.deepEqual(loadState(dir, 'sess_broken'), { firedTiers: [], lastTokens: 0 });
    assert.equal(fs.existsSync(`${file}.bak`), true);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveState/loadState: 非法 sessionId 直接拒绝（防路径穿越）', () => {
  const dir = makeTmpDir();
  try {
    assert.throws(() => saveState(dir, '../evil', { firedTiers: [], lastTokens: 0 }), /invalid sessionId/);
    assert.throws(() => loadState(dir, '../../etc/passwd'), /invalid sessionId/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- cleanOrphanStates（D3 孤儿 TTL 清理）----

test('cleanOrphanStates: 只清 mtime 超 TTL 的 .json，其余保留；目录缺失返回 0', () => {
  const dir = makeTmpDir();
  try {
    const oldFile = path.join(dir, 'sess_old.json');
    const freshFile = path.join(dir, 'sess_fresh.json');
    const bakFile = path.join(dir, 'sess_old.json.bak');
    fs.writeFileSync(oldFile, '{}');
    fs.writeFileSync(freshFile, '{}');
    fs.writeFileSync(bakFile, '{}');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

    assert.equal(cleanOrphanStates(dir), 1);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(freshFile), true);
    assert.equal(fs.existsSync(bakFile), true); // 非 .json 不清
    assert.equal(cleanOrphanStates(path.join(dir, 'no-such-dir')), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
