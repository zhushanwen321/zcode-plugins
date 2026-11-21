'use strict';

/**
 * 测试夹具：按真实 asar 磁盘布局构造微型归档（布局实证见 lib/asar.js 头注释，
 * 基址经 ZCode 3.19.1 真 asar 的 per-file SHA256 反向验证）。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function setDeep(tree, filePath, value) {
  const parts = filePath.replace(/^\//, '').split('/');
  let node = tree;
  for (let i = 0; i < parts.length - 1; i++) {
    node = node.files[parts[i]] = node.files[parts[i]] || { files: {} };
  }
  node.files[parts[parts.length - 1]] = value;
}

/**
 * entries: [{ path, content: Buffer }]，按给定顺序连续排布。
 * 返回 asar 字节串。布局与真实文件一致（内层 pickle 4 字节对齐）：
 *   [0]=4, [4]=4+innerSize, [8]=innerSize=4+jsonLen+pad, [12]=jsonLen,
 *   [16..]=json+pad(pad=(4-jsonLen%4)%4)，内容区 = 8 + [4]。
 */
function buildAsar(entries) {
  const tree = { files: {} };
  let offset = 0;
  for (const e of entries) {
    const hash = crypto.createHash('sha256').update(e.content).digest('hex');
    setDeep(tree, e.path, {
      size: e.content.length,
      offset: String(offset),
      integrity: { algorithm: 'SHA256', hash, blockSize: 4194304, blocks: [hash] },
    });
    offset += e.content.length;
  }
  const json = Buffer.from(JSON.stringify(tree), 'utf8');
  const padLen = (4 - (json.length % 4)) % 4;
  const innerSize = 4 + json.length + padLen;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(4 + innerSize, 4);
  head.writeUInt32LE(innerSize, 8);
  head.writeUInt32LE(json.length, 12);
  return Buffer.concat([head, json, Buffer.alloc(padLen, 0x20), ...entries.map((e) => e.content)]);
}

const INFO_PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<plist version="1.0">',
  '<dict>',
  '  <key>CFBundleShortVersionString</key>',
  '  <string>__VERSION__</string>',
  '</dict>',
  '</plist>',
  '',
].join('\n');

// 夹具内容锚点必须与真实补丁定义一致：yolo → host/index.js，quota → styles-*.js
const HOST_INDEX_JS = [
  '// fixture host entry',
  'function createSession(l){',
  '  if(l.caller!=="client")throw err("invalid_input","Only client callers can choose a mode");',
  '  let S={modelSelection:pick(l.models,l.model),mode:l.mode??"build",planEnabled:!1};',
  '  return S;',
  '}',
  // 补足体积，留出同尺寸替换与 padding 余量
  '// ' + 'x'.repeat(512),
].join('\n');

const STYLES_CHUNK_JS = [
  '// fixture renderer chunk',
  'function vin(e){',
  '  let cacheKey=e.authSessionSeq+"::"+keyOf(e.scope);',
  '  let o=e.service.getCodingPlanResetStatus(e.scope).then(function(r){return r;});',
  '  return o;',
  '}',
  'J.debug(`[coding-plan-reset] coordinator created`,{coordinatorKey:e});',
  // 补足体积：真实 styles chunk 7.2MB，观察器注入约 4.6KB，夹具留足同尺寸替换余量
  '// ' + 'y'.repeat(16 * 1024),
].join('\n');

function fixtureEntries() {
  return [
    { path: '/out/host/index.js', content: Buffer.from(HOST_INDEX_JS, 'utf8') },
    { path: '/out/renderer/assets/styles-FaKeHaSh.js', content: Buffer.from(STYLES_CHUNK_JS, 'utf8') },
    // 不被任何补丁触碰的文件：验证重打包后未改文件字节与 integrity 原样保留
    { path: '/out/renderer/assets/other-KEEP.js', content: Buffer.from('// untouched entry\nconst keep = 1;\n', 'utf8') },
  ];
}

function buildFakeApp(tmpDir, { version = '9.9.9' } = {}) {
  const resourcesDir = path.join(tmpDir, 'Contents', 'Resources');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'Contents', 'Info.plist'), INFO_PLIST.replace('__VERSION__', version));
  return { appRoot: tmpDir, resourcesDir, asarPath: path.join(resourcesDir, 'app.asar') };
}

module.exports = { buildAsar, buildFakeApp, fixtureEntries, INFO_PLIST, HOST_INDEX_JS, STYLES_CHUNK_JS };
