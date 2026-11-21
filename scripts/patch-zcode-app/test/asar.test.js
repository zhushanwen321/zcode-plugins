'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildAsar, fixtureEntries } = require('./helpers');
const asar = require('../lib/asar');

function writeTmpFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'app.asar');
  fs.writeFileSync(file, buildAsar(fixtureEntries()));
  return file;
}

test('readHeader：基址 = 8 + pickleSize，listFiles 收齐全部条目', (t) => {
  const file = writeTmpFixture(t);
  const fd = fs.openSync(file, 'r');
  try {
    const parsed = asar.readHeader(fd);
    const files = asar.listFiles(parsed.header);
    assert.equal(files.length, 3);
    const host = files.find((f) => f.path === '/out/host/index.js');
    assert.ok(host, 'host entry 缺失');
    const content = asar.readEntry(fd, parsed, host).toString('utf8');
    assert.ok(content.includes('Only client callers can choose a mode'));
    assert.ok(content.includes('mode:l.mode??"build"'));
  } finally {
    fs.closeSync(fd);
  }
});

test('integrityMatch：未改内容 true，改动内容 false', (t) => {
  const file = writeTmpFixture(t);
  const fd = fs.openSync(file, 'r');
  try {
    const parsed = asar.readHeader(fd);
    const host = asar.listFiles(parsed.header).find((f) => f.path === '/out/host/index.js');
    const pristine = asar.readEntry(fd, parsed, host);
    assert.equal(asar.integrityMatch(host, pristine), true);
    const tampered = Buffer.from(pristine.toString('utf8').replace('??"build"', ' ??"yolo"'), 'utf8');
    assert.equal(asar.integrityMatch(host, tampered), false);
  } finally {
    fs.closeSync(fd);
  }
});

test('locateTarget：路径+锚点双条件命中唯一文件；命中 0/2 个时报可操作错误', (t) => {
  const file = writeTmpFixture(t);
  const fd = fs.openSync(file, 'r');
  try {
    const parsed = asar.readHeader(fd);
    const hit = asar.locateTarget(fd, parsed, /^\/out\/host\/index\.js$/, 'Only client callers can choose a mode');
    assert.ok(hit.entry.path.endsWith('/out/host/index.js'));

    assert.throws(() => asar.locateTarget(fd, parsed, /^\/out\/host\/index\.js$/, '不存在的锚点'), /未定位到补丁目标文件/);

    // 两个文件都含同一锚点 → 必须报「命中多个」
    const dir = path.dirname(file);
    const entries = [
      { path: '/a/one.js', content: Buffer.from('ANCHOR_HERE;') },
      { path: '/b/two.js', content: Buffer.from('ANCHOR_HERE;') },
    ];
    const file2 = path.join(dir, 'dup.asar');
    fs.writeFileSync(file2, buildAsar(entries));
    const fd2 = fs.openSync(file2, 'r');
    try {
      const parsed2 = asar.readHeader(fd2);
      assert.throws(
        () => asar.locateTarget(fd2, parsed2, /^\/[ab]\/.*\.js$/, 'ANCHOR_HERE'),
        /命中 2 个/
      );
    } finally {
      fs.closeSync(fd2);
    }
  } finally {
    fs.closeSync(fd);
  }
});
