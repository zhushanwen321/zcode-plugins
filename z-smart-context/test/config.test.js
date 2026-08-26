'use strict';

// lib/config 纯函数单测（normalizeTiers 边界 + readConfig 热加载缓存）。
// 不 mock db、不发网络请求；readConfig 用真实临时目录（os.tmpdir），测完即清。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULTS, normalizeTiers, readConfig } = require('../lib/config');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zsc-config-test-'));
}

test('normalizeTiers: 滤除非正数与非 number 值', () => {
  assert.deepEqual(normalizeTiers([-5, 0, 100]), [100]);
  assert.deepEqual(normalizeTiers([Number.NaN, Infinity, -Infinity, 50]), [50]);
  assert.deepEqual(normalizeTiers(['100', null, undefined, 60]), [60]);
});

test('normalizeTiers: 升序排列', () => {
  assert.deepEqual(normalizeTiers([600000, 200000, 400000]), [200000, 400000, 600000]);
});

test('normalizeTiers: 超过 3 档时截取升序后的前 3 档（最小三档）', () => {
  assert.deepEqual(normalizeTiers([900000, 100000, 800000, 700000]), [100000, 700000, 800000]);
});

test('normalizeTiers: 空数组/全非法/非数组回退默认三档（D2）', () => {
  const expected = [...DEFAULTS.tiers];
  assert.deepEqual(normalizeTiers([]), expected);
  assert.deepEqual(normalizeTiers([-1, 0]), expected);
  assert.deepEqual(normalizeTiers(undefined), expected);
  assert.deepEqual(normalizeTiers('oops'), expected);
  assert.deepEqual(normalizeTiers({}), expected);
});

test('normalizeTiers: 不修改入参数组', () => {
  const input = [300, 100, 200];
  normalizeTiers(input);
  assert.deepEqual(input, [300, 100, 200]);
});

test('readConfig: 无配置文件返回默认配置', () => {
  const dir = makeTmpDir();
  try {
    assert.deepEqual(readConfig(dir), {
      enabled: true,
      tiers: [...DEFAULTS.tiers],
      dbPath: DEFAULTS.dbPath,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfig: 合法配置生效且 tiers 经过 normalize', () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ enabled: false, tiers: [9000, 3000, 6000, -1], dbPath: '/tmp/x.sqlite' }),
    );
    assert.deepEqual(readConfig(dir), {
      enabled: false,
      tiers: [3000, 6000, 9000],
      dbPath: '/tmp/x.sqlite',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfig: 坏 JSON 回退默认（§3.4，会伴随一条 warn 日志属预期）', () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{not valid json');
    assert.deepEqual(readConfig(dir), {
      enabled: true,
      tiers: [...DEFAULTS.tiers],
      dbPath: DEFAULTS.dbPath,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfig: 字段类型异常回退对应默认值', () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ enabled: 'yes', tiers: 'n/a', dbPath: 42 }),
    );
    assert.deepEqual(readConfig(dir), {
      enabled: true,
      tiers: [...DEFAULTS.tiers],
      dbPath: DEFAULTS.dbPath,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfig: mtime+size 均未变时命中缓存（M5 热加载）', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ tiers: [111, 222, 333] }));
    // APFS 的 mtimeMs 带亚毫秒小数，经 utimesSync 写回必丢小数位（探针实证 .0037→.003）——
    // 故预设整毫秒时间戳：整数毫秒经 Date/timespec 换算无损，「拨回」才能在本平台精确成立
    const KNOWN_MTIME = new Date(1700000000000);
    fs.utimesSync(file, KNOWN_MTIME, KNOWN_MTIME);
    assert.equal(fs.statSync(file).mtimeMs, 1700000000000); // 前置自证整毫秒确被保留
    assert.deepEqual(readConfig(dir).tiers, [111, 222, 333]);
    // 等长改写成必解析失败的坏内容 + mtime 拨回：
    // 若走了读盘将回退默认档位；命中缓存则仍返回旧好值——以此区分两条路径
    fs.writeFileSync(file, '#'.repeat(Buffer.byteLength(JSON.stringify({ tiers: [111, 222, 333] }))));
    fs.utimesSync(file, KNOWN_MTIME, KNOWN_MTIME);
    assert.deepEqual(readConfig(dir).tiers, [111, 222, 333]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfig: 内容变化（size 变化）时绕过缓存重新读盘', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ tiers: [111, 222, 333] }));
    assert.deepEqual(readConfig(dir).tiers, [111, 222, 333]);
    fs.writeFileSync(file, JSON.stringify({ tiers: [444, 555, 666] }));
    assert.deepEqual(readConfig(dir).tiers, [444, 555, 666]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
