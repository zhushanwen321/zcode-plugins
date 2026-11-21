#!/usr/bin/env node
'use strict';

/**
 * ZCode 桌面版 app.asar 统一补丁工具。
 *
 * 管理对 ZCode.app 内 app.asar 的全部本地补丁（patches/ 目录即补丁清单），
 * 提供 status / apply / restore 三个动作。共用纪律：
 *
 *   - 补丁定义只做「内容变换」，等宽替换与插入式注入皆可。写入走「区段搬移式
 *     重打包」：未改文件的字节原地保留（integrity 哈希随之继续有效），只重排
 *     受影响文件之后的偏移并重写 header，全程 stage 副本 + 原子 rename。
 *     当前 Electron 构建不校验 per-file integrity（实证：3.19.1 带 yolo 补丁正常运行），
 *     header 里的 pristine 哈希被本工具反向利用：与 header 不一致 = 该文件被补丁改过。
 *   - apply 幂等：目标定位与变换都在「在线 asar」上做，已应用补丁自动跳过；
 *     中途任何一步失败都不碰在线文件（先写 stage 再改名替换）。
 *   - pristine 基线备份只承担 restore 与出身追溯，apply 不从基线重建；补丁幂等
 *     由变换函数自身的 already-applied 检测保证。
 *   - ZCode 自动更新会整体覆盖 app.asar（补丁消失、基线版本过期）：apply 时做
 *     版本比对，发现升级且在线 asar 无补丁痕迹 → 自动采纳新 asar 为新基线。
 *
 * 用法：
 *   node patch-zcode-app.js status  [--app <ZCode.app 路径>]
 *   node patch-zcode-app.js apply   [--app <路径>] [--patch <name>[,<name>...]]
 *   node patch-zcode-app.js restore [--app <路径>] [--force]
 *
 * apply / restore 后需重启 ZCode 生效。运行中打补丁是安全的：rename 替换不动旧
 * inode，已启动的 ZCode 继续用旧文件，下次启动加载新 asar。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('./lib/asar');

const DEFAULT_APP = '/Applications/ZCode.app';
const BASE_NAME = 'app.asar.bak-zcode-patch-base';
const SIDECAR_SUFFIX = '.json';
const PATCH_ORDER = ['yolo', 'quota-auto-reset'];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--app') args.app = argv[++i];
    else if (a === '--patch') args.patch = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--force') args.force = true;
    else args._.push(a);
  }
  return args;
}

function loadPatches(requested) {
  const dir = path.join(__dirname, 'patches');
  const loaded = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => require(path.join(dir, f)))
    .sort((a, b) => PATCH_ORDER.indexOf(a.name) - PATCH_ORDER.indexOf(b.name));
  const names = loaded.map((p) => p.name);
  const unknown = (requested || []).filter((n) => !names.includes(n));
  if (unknown.length > 0) {
    throw new Error(`未知补丁名：${unknown.join(', ')}。可用补丁：${names.join(', ')}`);
  }
  return requested && requested.length > 0 ? requested.map((n) => loaded.find((p) => p.name === n)) : loaded;
}

function readAppVersion(appPath) {
  const plist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
  const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
  if (!m) throw new Error(`Info.plist 里没有 CFBundleShortVersionString（${appPath}），无法做版本比对`);
  return m[1];
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function openAsar(file) {
  const fd = fs.openSync(file, 'r');
  return { fd, parsed: asar.readHeader(fd) };
}

function closeAsar(handle) {
  if (handle && handle.fd >= 0) fs.closeSync(handle.fd);
}

/** 对每个补丁做目标定位 + 现场判定。定位失败不抛（status 需要完整视图）。 */
function probePatches(file, patches) {
  const handle = openAsar(file);
  try {
    return patches.map((patch) => {
      try {
        const { entry, content } = asar.locateTarget(handle.fd, handle.parsed, patch.target.pathRegex, patch.target.contentAnchor);
        const text = content.toString('utf8');
        return {
          patch,
          entry,
          applied: patch.isApplied(text),
          modifiedVsHeader: asar.integrityMatch(entry, content) === false,
        };
      } catch (err) {
        return { patch, error: err.message };
      }
    });
  } finally {
    closeAsar(handle);
  }
}

/**
 * 在线 asar 是否「无补丁痕迹」（只查各补丁 marker，快速判定）。
 * 目标定位失败（升级换名等）按异常上抛：无法核验就不许当 pristine 用。
 */
function liveIsPristine(resourcesDir, patches) {
  const asarPath = path.join(resourcesDir, 'app.asar');
  const probes = probePatches(asarPath, patches);
  const failed = probes.find((p) => p.error);
  if (failed) {
    throw new Error(`在线 asar 补丁痕迹核验失败（${failed.patch.name}）：${failed.error}`);
  }
  return probes.every((p) => !p.applied);
}

function legacyBackupNames(resourcesDir) {
  return fs
    .readdirSync(resourcesDir)
    .filter((f) => f.startsWith('app.asar.bak-') && f !== BASE_NAME && !f.endsWith(SIDECAR_SUFFIX));
}

function writeSidecar(sidecarPath, sidecar) {
  fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
}

/**
 * 采纳 src 为基线 + 异步算哈希 + 落 sidecar。mode='move' 用于旧格式备份改名收编
 * （同目录 rename 原子且不留存双份大文件）；'copy' 用于在线 asar（在线文件必须留下）。
 * 哈希失败则回滚（删除基线残留），保持「无基线」状态。
 */
async function adoptBase(src, basePath, { appVersion, adoptedFrom, mode = 'copy' }) {
  const sidecarPath = basePath + SIDECAR_SUFFIX;
  if (mode === 'move') {
    fs.renameSync(src, basePath);
  } else {
    fs.copyFileSync(src, basePath);
  }
  try {
    const sha = await sha256File(basePath);
    writeSidecar(sidecarPath, {
      appVersion,
      adoptedFrom,
      adoptedAt: new Date().toISOString(),
      sha256: sha,
    });
    return sha;
  } catch (err) {
    fs.rmSync(basePath, { force: true });
    fs.rmSync(sidecarPath, { force: true });
    if (mode === 'move') fs.renameSync(basePath, src); // 归还旧备份，不留半采纳状态
    throw new Error(`基线采纳失败（哈希计算不完整，已回滚）：${err.message}`);
  }
}

/**
 * 确保存在 pristine 基线，返回 { basePath, sha }。
 * 采纳顺序：现有基线（版本一致 / 升级且在线干净则重采纳）→ 旧格式备份改名采纳 → 在线 asar。
 */
async function ensureBase(resourcesDir, appPath, appVersion, patches, log) {
  const asarPath = path.join(resourcesDir, 'app.asar');
  const basePath = path.join(resourcesDir, BASE_NAME);
  const sidecarPath = basePath + SIDECAR_SUFFIX;

  if (fs.existsSync(basePath)) {
    let sidecar;
    try {
      sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    } catch (err) {
      throw new Error(
        `基线 sidecar 损坏（${sidecarPath}）：${err.message}。` +
          `恢复动作：确认在线 asar 状态后删除 ${basePath} 与该 sidecar，重跑 apply 重建基线。`
      );
    }
    if (sidecar.appVersion === appVersion) return { basePath, sidecar };
    // 版本不一致 = ZCode 已升级覆盖 asar（补丁消失），升级后的 asar 即新 pristine
    if (!liveIsPristine(resourcesDir, patches)) {
      throw new Error(
        `基线版本（${sidecar.appVersion}）与在线版本（${appVersion}）不一致，且在线 asar 检出补丁痕迹，拒绝自动重置基线。` +
          `恢复动作：人工核认在线 asar 可作基线后，删除 ${basePath} 与 sidecar 再重跑 apply。`
      );
    }
    log(`ZCode 已从 ${sidecar.appVersion} 升级到 ${appVersion}，在线 asar 无补丁痕迹，采纳为新基线`);
    const sha = await adoptBase(asarPath, basePath, { appVersion, adoptedFrom: `live@${appVersion}` });
    return { basePath, sidecar: { appVersion, adoptedFrom: `live@${appVersion}`, sha256: sha } };
  }

  // 无基线：先试旧格式备份（本工具接管前的手工备份），可核验为 pristine 才采纳
  for (const name of legacyBackupNames(resourcesDir)) {
    const candidate = path.join(resourcesDir, name);
    let reason;
    try {
      const version = readAppVersion(appPath); // 备份与 Info.plist 同属一个 app，版本取自 plist
      if (version !== appVersion) {
        reason = `版本不一致（${version} ≠ ${appVersion}）`;
      } else {
        const probe = probePatches(candidate, patches);
        const failed = probe.find((p) => p.error);
        if (failed) {
          reason = `补丁痕迹核验失败（${failed.error}）`;
        } else if (probe.some((p) => p.applied)) {
          reason = '含补丁痕迹，不作基线';
        } else {
          log(`发现旧格式备份 ${name}，改名收编为统一基线 ${BASE_NAME}`);
          const sha = await adoptBase(candidate, basePath, { appVersion, adoptedFrom: name, mode: 'move' });
          return { basePath, sidecar: { appVersion, adoptedFrom: name, sha256: sha } };
        }
      }
    } catch (err) {
      reason = `无法核验（${err.message}）`;
    }
    log(`跳过 ${name}：${reason}`);
  }

  if (!liveIsPristine(resourcesDir, patches)) {
    throw new Error(
      '找不到未打补丁的基线，且在线 asar 已含补丁痕迹，无法确定 pristine 起点。' +
        '恢复动作：①有旧格式备份（app.asar.bak-*）时确认其内容后重跑；②重装/更新 ZCode 得到全新 app.asar 后重跑 apply。'
    );
  }
  log(`无任何存量备份，采纳在线 asar 为基线（v${appVersion}）`);
  const sha = await adoptBase(asarPath, basePath, { appVersion, adoptedFrom: `live@${appVersion}` });
  return { basePath, sidecar: { appVersion, adoptedFrom: `live@${appVersion}`, sha256: sha } };
}

/**
 * 在在线 asar 上构建各补丁写入计划。已应用补丁跳过（幂等），返回
 * { edits: [{patch, entry, newBuffer}], skipped: [{patch, entry}] }。
 */
function buildPlan(livePath, patches) {
  const handle = openAsar(livePath);
  try {
    const edits = [];
    const skipped = [];
    for (const patch of patches) {
      const { entry, content } = asar.locateTarget(handle.fd, handle.parsed, patch.target.pathRegex, patch.target.contentAnchor);
      const text = content.toString('utf8');
      if (patch.isApplied(text)) {
        skipped.push({ patch, entry });
        continue;
      }
      const { content: next } = patch.transform(text, entry.path);
      edits.push({ patch, entry, newBuffer: Buffer.from(next, 'utf8') });
    }
    return { edits, skipped };
  } finally {
    closeAsar(handle);
  }
}

/**
 * 区段搬移式重打包：edits 中的文件按新内容写入，其余文件字节原地保留，
 * 之后所有条目的 offset 顺序重排，header 整体重写。stage 写完回读校验
 * （未改条目逐个核 integrity、改写条目逐字节比对）后再原子替换在线文件。
 * 任一步失败：删除 stage、在线文件不动。
 */
function repackAsar(livePath, resourcesDir, edits) {
  const stagePath = path.join(resourcesDir, `.app.asar.patch-stage-${process.pid}`);
  const srcHandle = openAsar(livePath);
  try {
    const parsed = srcHandle.parsed;
    const base = parsed.base; // openAsar 返回 {fd, parsed}；readHeader 的产物是 {header, base, jsonLen}
    const editByPath = new Map(edits.map((e) => [e.entry.path, e]));
    // 内容区条目按旧 offset 排序 = 打包顺序；unpacked/link 条目不在内容区，保持节点原样
    const packed = asar
      .listFiles(parsed.header)
      .filter((f) => !f.unpacked && !f.link)
      .sort((a, b) => a.offset - b.offset);

    // 1) 重排 offset（按打包顺序累计分配新位置）
    let cursor = 0;
    const newHeader = JSON.parse(JSON.stringify(parsed.header));
    const setNodeByPath = (node, parts, value) => {
      let cur = node;
      for (let i = 0; i < parts.length - 1; i++) cur = cur.files[parts[i]];
      cur.files[parts[parts.length - 1]] = value;
    };
    for (const f of packed) {
      const edit = editByPath.get(f.path);
      const size = edit ? edit.newBuffer.length : f.size;
      if (edit) {
        const parts = f.path.replace(/^\//, '').split('/');
        const node = { size, offset: String(cursor), integrity: asar.computeIntegrity(edit.newBuffer) };
        setNodeByPath(newHeader, parts, node);
      } else {
        // 未改文件：offset 字段必须刷新（新布局下位置变了），size/integrity 原样
        const parts = f.path.replace(/^\//, '').split('/');
        const node = findNode(newHeader, parts);
        node.offset = String(cursor);
      }
      cursor += size;
    }

    // 2) 写 stage：新 header + 顺序拷贝内容区（未改区段大块流式拷贝，全程自写不依赖拷贝占位）
    const jsonBuf = Buffer.from(JSON.stringify(newHeader), 'utf8');
    const padLen = (4 - (jsonBuf.length % 4)) % 4;
    const innerSize = 4 + jsonBuf.length + padLen;
    const head = Buffer.alloc(16);
    head.writeUInt32LE(4, 0);
    head.writeUInt32LE(4 + innerSize, 4);
    head.writeUInt32LE(innerSize, 8);
    head.writeUInt32LE(jsonBuf.length, 12);

    const out = fs.openSync(stagePath, 'w');
    try {
      fs.writeSync(out, head);
      fs.writeSync(out, jsonBuf);
      fs.writeSync(out, Buffer.alloc(padLen, 0x20));

      const COPY_CHUNK = 8 * 1024 * 1024;
      let spanStart = null; // 旧文件绝对偏移：连续未改区段起点
      let spanExpectedAbs = null;
      for (const f of packed) {
        const oldAbs = base + f.offset;
        const edit = editByPath.get(f.path);
        if (edit) {
          if (spanStart !== null) copySpan(out, srcHandle.fd, spanStart, spanExpectedAbs, COPY_CHUNK);
          spanStart = null;
          fs.writeSync(out, edit.newBuffer);
        } else {
          if (spanStart === null) spanStart = oldAbs;
          spanExpectedAbs = oldAbs + f.size;
        }
      }
      if (spanStart !== null) copySpan(out, srcHandle.fd, spanStart, spanExpectedAbs, COPY_CHUNK);
      fs.fsyncSync(out);
    } finally {
      fs.closeSync(out);
    }

    // 3) 回读校验：header 可解析、条目数一致；未触碰条目与「源文件旧区段」逐字节
    //    比对（不能拿 pristine header 哈希当判据——在线文件可能带着早于本次 apply
    //    的合法补丁，本来就与 header 不一致）；改写条目与计划逐字节比对。
    const verifyPlan = new Map(); // path → {kind:'kept', oldAbs, size} | {kind:'edited', expect}
    for (const f of packed) {
      const edit = editByPath.get(f.path);
      if (edit) verifyPlan.set(f.path, { kind: 'edited', expect: edit.newBuffer });
      else verifyPlan.set(f.path, { kind: 'kept', oldAbs: base + f.offset, size: f.size });
    }
    const stageFd = fs.openSync(stagePath, 'r');
    try {
      const sparsed = asar.readHeader(stageFd);
      const vfiles = asar.listFiles(sparsed.header);
      if (vfiles.filter((f) => !f.unpacked && !f.link).length !== packed.length) {
        throw new Error('stage 校验失败：重打包后 packed 条目数不一致');
      }
      for (const f of vfiles) {
        if (f.unpacked || f.link) continue;
        const expect = verifyPlan.get(f.path);
        if (!expect) throw new Error(`stage 校验失败：${f.path} 丢失`);
        const stageAbs = sparsed.base + f.offset;
        if (expect.kind === 'edited') {
          const actual = Buffer.alloc(f.size);
          readFull(stageFd, actual, 0, f.size, stageAbs, stagePath);
          if (Buffer.compare(actual, expect.expect) !== 0) {
            throw new Error(`stage 校验失败：${f.path} 写入内容与计划不一致`);
          }
        } else {
          if (f.size !== expect.size) {
            throw new Error(`stage 校验失败：未触碰文件 ${f.path} 大小变化（${expect.size} → ${f.size}）`);
          }
          if (!regionEqual(stageFd, stageAbs, srcHandle.fd, expect.oldAbs, expect.size)) {
            throw new Error(`stage 校验失败：未触碰文件 ${f.path} 字节与源区段不一致（搬运错位）`);
          }
        }
      }
    } finally {
      fs.closeSync(stageFd);
    }
  } catch (err) {
    fs.rmSync(stagePath, { force: true });
    throw err;
  } finally {
    closeAsar(srcHandle);
  }
  fs.renameSync(stagePath, livePath);
}

function findNode(header, parts) {
  let cur = header;
  for (const p of parts) {
    cur = cur.files ? cur.files[p] : undefined;
    if (!cur) throw new Error(`header 里找不到节点 /${parts.join('/')}`);
  }
  return cur;
}

/** 逐块流式拷贝 [from, to) 区段（校验期望终点，防偏移漂移）。 */
function copySpan(out, srcFd, from, to, chunk) {
  if (process.env.PATCH_DEBUG) console.log(`copySpan ${from} → ${to} (${to - from}B)`);
  const buf = Buffer.alloc(Math.min(chunk, to - from));
  let pos = from;
  while (pos < to) {
    const n = Math.min(buf.length, to - pos);
    const read = fs.readSync(srcFd, buf, 0, n, pos);
    if (read !== n) throw new Error(`区段拷贝读取不完整（${read}/${n} @${pos}），在线 asar 可能正被并发修改`);
    fs.writeSync(out, buf, 0, n);
    pos += n;
  }
}

function readFull(fd, buf, bufOffset, length, filePos, label) {
  let pos = filePos;
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, bufOffset + done, length - done, pos);
    if (n <= 0) throw new Error(`读取不完整（${label ?? 'file'} @${pos}）`);
    done += n;
    pos += n;
  }
}

/** 分块比较两个文件区段内容是否逐字节一致。 */
function regionEqual(fdA, posA, fdB, posB, size) {
  const CHUNK = 8 * 1024 * 1024;
  const bufA = Buffer.alloc(Math.min(CHUNK, size));
  const bufB = Buffer.alloc(bufA.length);
  for (let done = 0; done < size; done += bufA.length) {
    const n = Math.min(bufA.length, size - done);
    readFull(fdA, bufA, 0, n, posA + done, 'stage');
    readFull(fdB, bufB, 0, n, posB + done, 'live');
    if (Buffer.compare(bufA.subarray(0, n), bufB.subarray(0, n)) !== 0) return false;
  }
  return true;
}

async function cmdApply(args) {
  const appPath = path.resolve(args.app || DEFAULT_APP);
  const resourcesDir = path.join(appPath, 'Contents', 'Resources');
  const livePath = path.join(resourcesDir, 'app.asar');
  if (!fs.existsSync(livePath)) {
    throw new Error(`找不到 ${livePath}。恢复动作：用 --app 指定 ZCode.app 路径。`);
  }
  const appVersion = readAppVersion(appPath);
  const patches = loadPatches(args.patch);
  const log = (m) => console.log(`patch: ${m}`);

  const { basePath } = await ensureBase(resourcesDir, appPath, appVersion, patches, log);
  void basePath; // 基线只服务 restore；apply 的定位与变换全部以在线 asar 为准
  const { edits, skipped } = buildPlan(livePath, patches);
  if (edits.length === 0) {
    console.log('全部补丁已是目标态，无需写入。');
    for (const s of skipped) console.log(`skip ${s.patch.name}: 已应用（${s.entry.path}）`);
    return;
  }
  repackAsar(livePath, resourcesDir, edits);

  console.log('');
  for (const e of edits) {
    console.log(`apply ${e.patch.name}: 已写入 → ${e.entry.path}（${e.entry.size}B → ${e.newBuffer.length}B）`);
  }
  for (const s of skipped) {
    console.log(`skip ${s.patch.name}: 已应用，跳过（${s.entry.path}）`);
  }
  console.log(`\napp 版本 ${appVersion}；重启 ZCode 后生效。回滚：node ${__filename} restore`);
}

async function cmdRestore(args) {
  const appPath = path.resolve(args.app || DEFAULT_APP);
  const resourcesDir = path.join(appPath, 'Contents', 'Resources');
  const livePath = path.join(resourcesDir, 'app.asar');
  const basePath = path.join(resourcesDir, BASE_NAME);
  const sidecarPath = basePath + SIDECAR_SUFFIX;
  if (!fs.existsSync(basePath)) {
    throw new Error(`没有基线备份 ${basePath}，无从恢复。恢复动作：先跑一次 apply 建立基线。`);
  }
  if (!fs.existsSync(sidecarPath)) {
    throw new Error(`基线 sidecar 缺失（${sidecarPath}），无法核验基线出身。恢复动作：删除基线文件后重跑 apply 重建。`);
  }
  const appVersion = readAppVersion(appPath);
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

  const problems = [];
  if (sidecar.appVersion !== appVersion) {
    problems.push(`基线版本 ${sidecar.appVersion} ≠ 在线版本 ${appVersion}（可能是 app 升级后混用旧基线，恢复会退回旧版本 asar）`);
  }
  const sha = await sha256File(basePath);
  if (sidecar.sha256 && sha !== sidecar.sha256) {
    problems.push(`基线 sha256 与 sidecar 记录不一致（sidecar ${String(sidecar.sha256).slice(0, 12)}… ≠ 实际 ${sha.slice(0, 12)}…），基线文件可能被改动过`);
  }
  if (problems.length > 0 && !args.force) {
    throw new Error(`恢复校验未通过：\n  - ${problems.join('\n  - ')}\n确认要强制恢复时加 --force。`);
  }
  const stagePath = path.join(resourcesDir, `.app.asar.restore-stage-${process.pid}`);
  fs.copyFileSync(basePath, stagePath);
  fs.renameSync(stagePath, livePath);
  console.log(`restore: 在线 asar 已恢复为基线（来源 ${sidecar.adoptedFrom}，v${sidecar.appVersion}）。重启 ZCode 后生效。`);
  console.log('基线保留在原处，之后可随时重新 apply。');
}

function cmdStatus(args) {
  const appPath = path.resolve(args.app || DEFAULT_APP);
  const resourcesDir = path.join(appPath, 'Contents', 'Resources');
  const livePath = path.join(resourcesDir, 'app.asar');
  const basePath = path.join(resourcesDir, BASE_NAME);
  const sidecarPath = basePath + SIDECAR_SUFFIX;
  if (!fs.existsSync(livePath)) {
    throw new Error(`找不到 ${livePath}。恢复动作：用 --app 指定 ZCode.app 路径。`);
  }
  const appVersion = readAppVersion(appPath);
  const patches = loadPatches();

  console.log(`app:      ${appPath}`);
  console.log(`version:  ${appVersion}`);
  const st = fs.statSync(livePath);
  console.log(`app.asar: ${(st.size / 1024 / 1024).toFixed(1)} MB, mtime ${st.mtime.toISOString()}`);

  console.log(`基线:     ${fs.existsSync(basePath) ? '存在' : '缺失（apply 时自动建立）'}`);
  if (fs.existsSync(basePath)) {
    try {
      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      console.log(`  来源 ${sidecar.adoptedFrom}，v${sidecar.appVersion}，采纳于 ${sidecar.adoptedAt}`);
      if (sidecar.appVersion !== appVersion) {
        console.log('  注意：基线版本与在线版本不一致（ZCode 升级过），apply 时会自动处理。');
      }
    } catch (err) {
      console.log(`  sidecar 读取失败：${err.message}`);
    }
  }
  const legacy = legacyBackupNames(resourcesDir);
  if (legacy.length > 0) console.log(`旧格式备份（未纳入管理）: ${legacy.join(', ')}`);

  console.log('补丁:');
  for (const probe of probePatches(livePath, patches)) {
    if (probe.error) {
      console.log(`  [?] ${probe.patch.name}: 目标定位失败 — ${probe.error}`);
      continue;
    }
    const detail = probe.modifiedVsHeader
      ? '文件已被修改（与 pristine header 哈希不一致）'
      : '文件与 pristine 哈希一致';
    console.log(`  [${probe.applied ? 'x' : ' '}] ${probe.patch.name} — ${probe.applied ? '已应用' : '未应用'}，${detail}（${probe.entry.path}）`);
  }
  if (!fs.existsSync(basePath)) {
    console.log(`恢复动作：node ${__filename} apply  # 建立基线并应用全部补丁`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'status';
  const runners = { status: cmdStatus, apply: cmdApply, restore: cmdRestore };
  const run = runners[cmd];
  if (!run) {
    console.error(`未知命令 ${cmd}。用法见文件头注释或 README.md。`);
    process.exit(1);
  }
  Promise.resolve()
    .then(() => run(args))
    .catch((err) => {
      console.error(`错误: ${err.message}`);
      if (process.env.PATCH_DEBUG) console.error(err.stack);
      process.exit(1);
    });
}

main();
