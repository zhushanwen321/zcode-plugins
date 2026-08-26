'use strict';
// guardedSaveUserConfig（lib/takeover.js）冲突路径单测——R9 修复的核心防御：
// 外部（zcode 引擎）写 user config 不走 registry 锁，落盘前 mtime 比对 +
// 重读重放 mutations，连续冲突抛错。
// 冲突注入：monkey-patch fs.statSync，在函数内部的「读后校验」时机改写
// config 文件内容并抬升 mtime，确定性模拟引擎并发写（时序竞态无法稳定复现）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { guardedSaveUserConfig } = require('../lib/takeover');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ztf-guarded-'));
}

function configPath(home) {
  return path.join(home, '.zcode', 'cli', 'config.json');
}

function writeConfig(home, cfg) {
  const file = configPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

function readConfig(home) {
  return JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
}

/**
 * patch statSync：对目标文件，第 conflictAt 次（1-based）调用时先执行 externalWrite(file)；
 * persistent=false 时返回固定抬升值（下一次重读一致 → 第二次尝试成功），
 * persistent=true 时每次调用都返回递增 mtime（重试永远冲突 → 耗尽抛错）。
 * guardedSaveUserConfig 单次尝试的 statSync 序列：#1 before → #2 check，
 * 因此 conflictAt=2 恰好模拟「读取后、落盘前」的外部写。
 */
function patchStatWithExternalWrite(file, conflictAt, externalWrite, { persistent = false } = {}) {
  const original = fs.statSync;
  let calls = 0;
  fs.statSync = (p, opts) => {
    const st = original(p, opts);
    if (p !== file) return st;
    calls += 1;
    if (calls === conflictAt) externalWrite(p);
    if (calls >= conflictAt) {
      return { ...st, mtimeMs: st.mtimeMs + (persistent ? calls : 1) * 1000 };
    }
    return st;
  };
  return () => {
    fs.statSync = original;
  };
}

test('外部写冲突：重读重放 mutations，引擎写入不丢', () => {
  const home = tmpHome();
  writeConfig(home, { mcp: { servers: { keep: { type: 'stdio', command: 'a' } } } });
  const file = configPath(home);

  const restore = patchStatWithExternalWrite(file, 2, () => {
    // 模拟引擎在窗口内写入（GUI 改设置等）：追加 enabledPlugins 变更
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.enabledPlugins = { 'demo@mp': true };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  });
  try {
    guardedSaveUserConfig(home, [{ op: 'set', key: 'foo', value: { type: 'stdio', command: 'node' } }], null);
  } finally {
    restore();
  }

  const cfg = readConfig(home);
  assert.deepStrictEqual(cfg.enabledPlugins, { 'demo@mp': true }, '引擎写入须保留（不被整文件覆盖回滚）');
  assert.ok(cfg.mcp.servers.foo, 'mutations 须在重读后的副本上重放');
  assert.ok(cfg.mcp.servers.keep, '无关条目保留');
});

test('持续冲突：重试耗尽后抛错而非覆盖', () => {
  const home = tmpHome();
  writeConfig(home, { mcp: { servers: {} } });
  const file = configPath(home);
  const before = readConfig(home);

  const restore = patchStatWithExternalWrite(
    file,
    2,
    () => {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      cfg.mcp.servers.engineKey = { type: 'stdio', command: 'engine' };
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    },
    { persistent: true }
  );
  try {
    assert.throws(() => guardedSaveUserConfig(home, [{ op: 'set', key: 'foo', value: {} }], null), /持续修改/);
  } finally {
    restore();
  }
  void before;
  // 落盘未发生：config 仍只含引擎写入，不含 mutation
  const cfg = readConfig(home);
  assert.strictEqual(cfg.mcp.servers.foo, undefined);
  assert.deepStrictEqual(cfg.mcp.servers.engineKey, { type: 'stdio', command: 'engine' });
});

test('set / del 两种 mutation 的重放正确性', () => {
  const home = tmpHome();
  writeConfig(home, {
    mcp: { servers: {
      stale: { type: 'stdio', command: 'old' },
      keep: { type: 'stdio', command: 'b' },
    } },
  });
  guardedSaveUserConfig(home, [
    { op: 'set', key: 'foo', value: { type: 'stdio', command: 'node' } },
    { op: 'del', key: 'stale' },
  ], null);
  const cfg = readConfig(home);
  assert.deepStrictEqual(cfg.mcp.servers.foo, { type: 'stdio', command: 'node' });
  assert.strictEqual(cfg.mcp.servers.stale, undefined);
  assert.ok(cfg.mcp.servers.keep);
});
