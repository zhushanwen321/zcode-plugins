'use strict';

/**
 * CLI 端到端测试：在临时目录构造假 ZCode.app（微型 asar），全流程跑
 * status / apply / restore，验证基线采纳、幂等重跑、原子恢复与错误路径。
 * 不触碰真实 /Applications/ZCode.app。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const asar = require('../lib/asar');
const { buildAsar, buildFakeApp, fixtureEntries } = require('./helpers');

const CLI = path.join(__dirname, '..', 'patch-zcode-app.js');

function runCli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function tmpApp(t, { asarBytes } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-app-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = buildFakeApp(dir);
  if (asarBytes) fs.writeFileSync(app.asarPath, asarBytes);
  return app;
}

function readEntryText(asarPath, predicate) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const parsed = asar.readHeader(fd);
    const entry = asar.listFiles(parsed.header).find((f) => predicate(f));
    assert.ok(entry, '目标条目不存在');
    return asar.readEntry(fd, parsed, entry).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

test('apply 全流程：建基线 → 双补丁写入 → 未改文件完整性 → 幂等重跑 → restore 还原', (t) => {
  const pristine = buildAsar(fixtureEntries());
  const app = tmpApp(t, { asarBytes: pristine });
  const originalSize = fs.statSync(app.asarPath).size;
  const args = ['--app', app.appRoot];

  // 1. apply：首次无备份 → 采纳在线为基线，双补丁写入（重打包，体积允许增长）
  let r = runCli('apply', ...args);
  assert.equal(r.status, 0, `apply 失败：${r.stderr}`);
  assert.ok(r.stdout.includes('采纳在线 asar 为基线'), `输出缺基线采纳信息：${r.stdout}`);
  const basePath = path.join(app.resourcesDir, 'app.asar.bak-zcode-patch-base');
  assert.ok(fs.existsSync(basePath), '基线未建立');
  const sizeAfterApply = fs.statSync(app.asarPath).size;
  assert.ok(sizeAfterApply > originalSize, '插入式补丁应使 asar 增长（watcher 注入）');

  const hostText = readEntryText(app.asarPath, (f) => f.path === '/out/host/index.js');
  assert.ok(hostText.includes('mode:l.mode ??"yolo"'), 'yolo 补丁未生效');
  const stylesText = readEntryText(app.asarPath, (f) => /styles-/.test(f.path));
  assert.ok(stylesText.includes('zcode-patch:quota-auto-reset v1'), 'quota 补丁未生效');
  assert.ok(stylesText.includes('globalThis.__zswQuotaCtx={service:e,scope:e.scope'), '捕获钩子未注入');

  // 2. 重打包正确性：未触碰的文件字节原样、integrity 与新 header 一致
  const keepText = readEntryText(app.asarPath, (f) => f.path === '/out/renderer/assets/other-KEEP.js');
  assert.ok(keepText.includes('const keep = 1;'), '未触碰文件内容丢失');
  const fdv = fs.openSync(app.asarPath, 'r');
  try {
    const parsed = asar.readHeader(fdv);
    const keep = asar.listFiles(parsed.header).find((f) => f.path === '/out/renderer/assets/other-KEEP.js');
    assert.equal(asar.integrityMatch(keep, asar.readEntry(fdv, parsed, keep)), true, '未触碰文件 integrity 应保持有效');
  } finally {
    fs.closeSync(fdv);
  }

  // 3. status：双补丁已应用
  r = runCli('status', ...args);
  assert.equal(r.status, 0, `status 失败：${r.stderr}`);
  assert.ok(r.stdout.includes('yolo — 已应用'), r.stdout);
  assert.ok(r.stdout.includes('quota-auto-reset — 已应用'), r.stdout);

  // 4. 幂等重跑：全部跳过，字节零改动
  r = runCli('apply', ...args);
  assert.equal(r.status, 0, `幂等 apply 失败：${r.stderr}`);
  assert.ok(r.stdout.includes('全部补丁已是目标态'), r.stdout);
  assert.equal(fs.statSync(app.asarPath).size, sizeAfterApply, '幂等重跑不得改动字节');

  // 5. restore：还原后与基线字节一致，补丁痕迹消失
  r = runCli('restore', ...args);
  assert.equal(r.status, 0, `restore 失败：${r.stderr}`);
  const baseBytes = fs.readFileSync(basePath);
  assert.ok(Buffer.compare(fs.readFileSync(app.asarPath), baseBytes) === 0, 'restore 后与基线不一致');
  assert.ok(!readEntryText(app.asarPath, (f) => /styles-/.test(f.path)).includes('zcode-patch:quota-auto-reset'));
});

test('旧格式备份采纳：legacy 备份被纳入统一基线管理', (t) => {
  // 场景：在线 asar 已含 yolo 补丁（手工时代产物），旁边有手工备份的 pristine
  const pristineEntries = fixtureEntries();
  const pristine = buildAsar(pristineEntries);
  const patchedEntries = pristineEntries.map((e) =>
    e.path === '/out/host/index.js'
      ? { path: e.path, content: Buffer.from(e.content.toString('utf8').replace('??"build"', ' ??"yolo"'), 'utf8') }
      : e
  );
  const patched = buildAsar(patchedEntries);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-app-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = buildFakeApp(dir);
  fs.writeFileSync(app.asarPath, patched);
  const legacyPath = path.join(app.resourcesDir, 'app.asar.bak-zsw-yolo-20261121');
  fs.writeFileSync(legacyPath, pristine);

  const r = runCli('apply', '--app', dir);
  assert.equal(r.status, 0, `apply 失败：${r.stderr}`);
  assert.ok(r.stdout.includes('app.asar.bak-zsw-yolo-20261121'), '应报告采纳来源');
  assert.ok(!fs.existsSync(legacyPath), '旧备份应已改名纳入管理（避免留存双份大文件）');
  const basePath = path.join(app.resourcesDir, 'app.asar.bak-zcode-patch-base');
  assert.ok(fs.existsSync(basePath), '统一基线未建立');
  const sidecar = JSON.parse(fs.readFileSync(basePath + '.json', 'utf8'));
  assert.equal(sidecar.adoptedFrom, 'app.asar.bak-zsw-yolo-20261121');

  const stylesText = readEntryText(app.asarPath, (f) => /styles-/.test(f.path));
  assert.ok(stylesText.includes('zcode-patch:quota-auto-reset v1'), 'quota 补丁未生效');
  const hostText = readEntryText(app.asarPath, (f) => f.path === '/out/host/index.js');
  assert.ok(hostText.includes('mode:l.mode ??"yolo"'));
});

test('错误路径：--patch 未知名报错且不动在线文件', (t) => {
  const pristine = buildAsar(fixtureEntries());
  const app = tmpApp(t, { asarBytes: pristine });

  const r = runCli('apply', '--app', app.appRoot, '--patch', 'no-such');
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('未知补丁名'), r.stderr);
  assert.ok(Buffer.compare(fs.readFileSync(app.asarPath), pristine) === 0, '失败路径不得改动在线 asar');
});

test('错误路径：目标锚点漂移（模拟 app 升级）时 apply 失败且不动在线文件', (t) => {
  // 构造一个不含补丁锚点的 asar（模拟升级后 bundle 变化）
  const entries = [
    { path: '/out/host/index.js', content: Buffer.from('// upgraded bundle, no anchor here\n') },
    { path: '/out/renderer/assets/styles-Other.js', content: Buffer.from('// no coordinator anchor\n') },
  ];
  const app = tmpApp(t, { asarBytes: buildAsar(entries) });

  const r = runCli('apply', '--app', app.appRoot);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('未定位到补丁目标文件'), r.stderr);
  // 基线可能已建立（采纳在线），但在线 asar 必须原样
  assert.ok(!readEntryText(app.asarPath, (f) => /host/.test(f.path)).includes('??"yolo"'));
});
