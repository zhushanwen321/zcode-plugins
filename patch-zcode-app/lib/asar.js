'use strict';

/**
 * asar 归档最小读取层（只读解析 + 定位 + 内容读取 + 完整性校验）。
 *
 * 不做通用解包/打包：本工具的补丁写入走「同尺寸字节替换」，不改 header，
 * 因此只需要解析 header 定位文件，不需要 asar npm 包。
 *
 * 磁盘布局（实测自 ZCode 3.19.1 app.asar，2026-11-21，基址经 per-file
 * integrity SHA256 反向验证）：
 *   [0..3]   uint32 = 4（pickle 头大小）
 *   [4..7]   uint32 = 4 + innerSize
 *   [8..11]  uint32 = innerSize = 4 + jsonLen + pad
 *   [12..15] uint32 = jsonLen（JSON 字符串长度）
 *   [16..)   JSON 字符串 + pad（pad = (4 - jsonLen%4)%4，内层 pickle 4 字节对齐）
 *   内容区基址 = 8 + [4]。文件绝对偏移 = 基址 + entry.offset。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');

/** 解析 header，返回 { header, base, jsonLen }。 */
function readHeader(fd) {
  const head = Buffer.alloc(16);
  const read = fs.readSync(fd, head, 0, 16, 0);
  if (read !== 16) throw new Error(`asar 头部不足 16 字节（读到 ${read}），文件可能损坏`);
  const pickleSize = head.readUInt32LE(4);
  const jsonLen = head.readUInt32LE(12);
  if (pickleSize < 16 || jsonLen < 2 || pickleSize > 256 * 1024 * 1024) {
    throw new Error(`asar 头部字段异常（pickleSize=${pickleSize}, jsonLen=${jsonLen}），不是合法的 asar 文件`);
  }
  const raw = Buffer.alloc(jsonLen);
  fs.readSync(fd, raw, 0, jsonLen, 16);
  let header;
  try {
    header = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new Error(`asar header JSON 解析失败：${err.message}`);
  }
  const base = 8 + pickleSize;
  return { header, base, jsonLen };
}

/** 深度优先收集全部文件条目：{ path, offset, size, unpacked, integrity }。 */
function listFiles(header) {
  const out = [];
  const walk = (node, prefix) => {
    if (!node || !node.files) return;
    for (const [name, child] of Object.entries(node.files)) {
      const p = `${prefix}/${name}`;
      if (child.files) {
        walk(child, p);
      } else if (child.offset !== undefined) {
        out.push({
          path: p,
          offset: parseInt(child.offset, 10),
          size: child.size,
          unpacked: child.unpacked === true,
          integrity: child.integrity || null,
        });
      }
    }
  };
  walk(header, '');
  return out;
}

/**
 * 按「路径正则 + 内容锚点」定位唯一目标文件。
 * 双条件定位的原因：Vite 产出的文件名带内容哈希后缀（如 styles-BKbqL3QI.js），
 * app 升级后哈希会变；只看路径正则会误定位，加内容锚点才能锁定语义目标。
 * 返回 entry；找不到或命中多个时抛错（报错带恢复动作）。
 */
function locateTarget(fd, parsed, pathRegex, contentAnchor, readLimit = 16 * 1024 * 1024) {
  const candidates = listFiles(parsed.header).filter((f) => !f.unpacked && pathRegex.test(f.path));
  const hits = [];
  for (const entry of candidates) {
    if (entry.size > readLimit) continue;
    const content = readEntry(fd, parsed, entry);
    if (contentAnchor && !content.includes(contentAnchor)) continue;
    hits.push({ entry, content });
  }
  if (hits.length === 0) {
    throw new Error(
      `未定位到补丁目标文件（pathRegex=${pathRegex}, contentAnchor=${JSON.stringify(contentAnchor)}）。` +
        '常见原因：ZCode 升级后打包产物变了。恢复动作：重新逆向定位新 bundle 的目标文件与锚点，更新补丁定义。'
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `补丁目标定位命中 ${hits.length} 个文件（${hits.map((h) => h.entry.path).join(', ')}），` +
        '锚点不唯一。恢复动作：收紧补丁定义里的 pathRegex / contentAnchor。'
    );
  }
  return hits[0];
}

/** 读取文件条目内容。 */
function readEntry(fd, parsed, entry) {
  const buf = Buffer.alloc(entry.size);
  const abs = parsed.base + entry.offset;
  const read = fs.readSync(fd, buf, 0, entry.size, abs);
  if (read !== entry.size) throw new Error(`读取 ${entry.path} 不完整（${read}/${entry.size}）`);
  return buf;
}

/** 条目内容与 header 里记录的 SHA256 是否一致（一致 = 未被改过）。 */
function integrityMatch(entry, content) {
  if (!entry.integrity || !entry.integrity.hash) return null;
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  return sha === entry.integrity.hash;
}

/**
 * 按 asar 规范计算整个条目 integrity 块：整体 hash + 按 4MB 分块的 blocks。
 * 重打包时给被补丁改写的文件重算用（未改文件保留原 integrity 即可，字节没动）。
 */
function computeIntegrity(buffer) {
  const blockSize = 4194304;
  const blocks = [];
  for (let start = 0; start < buffer.length; start += blockSize) {
    blocks.push(crypto.createHash('sha256').update(buffer.subarray(start, start + blockSize)).digest('hex'));
  }
  return {
    algorithm: 'SHA256',
    hash: crypto.createHash('sha256').update(buffer).digest('hex'),
    blockSize,
    blocks,
  };
}

module.exports = { readHeader, listFiles, locateTarget, readEntry, integrityMatch, computeIntegrity };
