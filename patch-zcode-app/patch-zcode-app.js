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
const LOOSE_BASE_SUFFIX = '.bak-zcode-patch-base';
const PATCH_ORDER = ['yolo', 'quota-auto-reset', 'provider-sem'];

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
    .sort((a, b) => (PATCH_ORDER.indexOf(a.name) + 1 || 99) - (PATCH_ORDER.indexOf(b.name) + 1 || 99));
  const names = loaded.map((p) => p.name);
  const unknown = (requested || []).filter((n) => !names.includes(n));
  if (unknown.length > 0) {
    throw new Error(`未知补丁名：${unknown.join(', ')}。可用补丁：${names.join(', ')}`);
  }
  return requested && requested.length > 0 ? requested.map((n) => loaded.find((p) => p.name === n)) : loaded;
}

/** asar 内目标（pathRegex）与 asar 外裸文件目标（looseFile）两类补丁的分派辅助 */
function isLoosePatch(patch) {
  return Boolean(patch.target && patch.target.looseFile);
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
  let handle;
  try {
    handle = openAsar(file);
  } catch (err) {
    return patches.map((patch) => ({ patch, error: `asar 打开失败：${err.message}` }));
  }
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
 * 连坐防护：定位失败的补丁不参与痕迹判定，只记日志——升级后个别补丁锚点漂移
 * 只应影响该补丁自身（buildPlan 逐补丁收集 failed），不得阻塞基线重采纳拖垮
 * 其余补丁的升级重打。升级整体覆盖在线文件，锚点消失时该补丁的注入痕迹必也
 * 消失，跳过不会误放行。全部补丁均无法定位时仍上抛：零数据点无法下结论。
 */
function liveIsPristine(resourcesDir, patches, log = () => {}) {
  const asarPath = path.join(resourcesDir, 'app.asar');
  const probes = probePatches(asarPath, patches);
  const failed = probes.filter((p) => p.error);
  for (const f of failed) log(`补丁 ${f.patch.name} 定位失败，不参与痕迹核验（${f.error}）`);
  if (failed.length === probes.length) {
    throw new Error(
      `在线 asar 补丁痕迹核验失败（全部 ${probes.length} 个 asar 补丁均无法定位目标，无法判定是否干净）：${failed[0].error}。` +
        '恢复动作：升级后全部锚点漂移时先重新逆向定位各补丁锚点，再重跑 apply。'
    );
  }
  return probes.filter((p) => !p.error).every((p) => !p.applied);
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
    let sidecar = null;
    try {
      sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    } catch {
      // sidecar 缺失/损坏 = adoptBase 两步写中途崩溃的半采纳态：基线文件本身完整
      // 即可自愈重建（重算哈希、标记 recovered），不再要求人工删除
      log(`基线 sidecar 缺失/损坏，按基线文件自愈重建（${path.basename(sidecarPath)}）`);
      const sha = await sha256File(basePath);
      writeSidecar(sidecarPath, { appVersion, adoptedFrom: 'recovered', adoptedAt: new Date().toISOString(), sha256: sha });
      sidecar = { appVersion, adoptedFrom: 'recovered', sha256: sha };
    }
    if (sidecar.appVersion === appVersion) return { basePath, sidecar };
    // 版本不一致 = ZCode 已升级覆盖 asar（补丁消失），升级后的 asar 即新 pristine
    if (!liveIsPristine(resourcesDir, patches, log)) {
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

  if (!liveIsPristine(resourcesDir, patches, log)) {
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
 * { edits, skipped, failed }。补丁间隔离：单个补丁定位/变换失败收集进 failed
 * 不中断其他补丁（autopatch 语义——升级后个别锚点漂移不该连坐其余补丁）；
 * 全部失败时 edits 为空 → 不写入 → 在线文件原样。
 */
function buildPlan(livePath, patches) {
  const handle = openAsar(livePath);
  try {
    const edits = [];
    const skipped = [];
    const failed = [];
    for (const patch of patches) {
      try {
        const { entry, content } = asar.locateTarget(handle.fd, handle.parsed, patch.target.pathRegex, patch.target.contentAnchor);
        const text = content.toString('utf8');
        if (patch.isApplied(text)) {
          skipped.push({ patch, entry });
          continue;
        }
        const { content: next, note } = patch.transform(text, entry.path);
        edits.push({ patch, entry, newBuffer: Buffer.from(next, 'utf8'), note });
      } catch (err) {
        failed.push({ patch, error: err.message });
      }
    }
    return { edits, skipped, failed };
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
  const asarPatches = patches.filter((p) => !isLoosePatch(p));
  const loosePatches = patches.filter(isLoosePatch);

  let touched = false;
  const failed = [];
  if (asarPatches.length > 0) {
    const { basePath } = await ensureBase(resourcesDir, appPath, appVersion, asarPatches, log);
    void basePath; // 基线只服务 restore；apply 的定位与变换全部以在线 asar 为准
    const plan = buildPlan(livePath, asarPatches);
    if (plan.edits.length > 0) {
      repackAsar(livePath, resourcesDir, plan.edits);
      touched = true;
    }
    failed.push(...plan.failed);
    for (const e of plan.edits) {
      console.log(`apply ${e.patch.name}: 已写入 → ${e.entry.path}（${e.entry.size}B → ${e.newBuffer.length}B）`);
      if (e.note === 'patched-fallback') {
        console.log(`  提示 ${e.patch.name}: 以回退锚点注入（精确结构锚未命中）——准入函数形态已漂移，请对照新版 zcode.cjs 复核并把新形态固化为精确锚点。`);
      }
    }
    for (const s of plan.skipped) console.log(`skip ${s.patch.name}: 已应用，跳过（${s.entry.path}）`);
  }
  if (loosePatches.length > 0) {
    const results = await applyLoosePatches(resourcesDir, appPath, appVersion, loosePatches, log);
    if (results.edits.length > 0) touched = true;
    failed.push(...results.failed);
    for (const e of results.edits) {
      console.log(`apply ${e.patch.name}: 已写入 → ${e.file}（${e.sizeBefore}B → ${e.sizeAfter}B）`);
      if (e.note === 'patched-fallback') {
        console.log(`  提示 ${e.patch.name}: 以回退锚点注入（精确结构锚未命中）——准入函数形态已漂移，请对照新版 zcode.cjs 复核并把新形态固化为精确锚点。`);
      }
    }
    for (const s of results.skipped) console.log(`skip ${s.patch.name}: 已应用，跳过（${s.file}）`);
  }
  for (const f of failed) console.log(`fail ${f.patch.name}: ${f.error}`);
  if (!touched && failed.length === 0) console.log('全部补丁已是目标态，无需写入。');
  console.log(`\napp 版本 ${appVersion}；重启 ZCode 后生效。回滚：node ${__filename} restore`);
  if (failed.length > 0) {
    const detail = failed.map((f) => `${f.patch.name}: ${f.error}`).join('；');
    const err = new Error(
      `${failed.length} 个补丁失败（其余补丁不受影响已处理）——${detail}`,
    );
    err.partial = true;
    throw err;
  }
}

async function cmdRestore(args) {
  const appPath = path.resolve(args.app || DEFAULT_APP);
  const resourcesDir = path.join(appPath, 'Contents', 'Resources');
  const livePath = path.join(resourcesDir, 'app.asar');
  const basePath = path.join(resourcesDir, BASE_NAME);
  const sidecarPath = basePath + SIDECAR_SUFFIX;
  const appVersion = readAppVersion(appPath);

  if (!fs.existsSync(basePath)) {
    // asar 无基线:仅当 asar 补丁也都未应用(干净)时跳过 asar 回滚;否则无从恢复
    const asarPatches = loadPatches().filter((p) => !isLoosePatch(p));
    const dirty = asarPatches.length > 0 && probePatches(livePath, asarPatches).some((p) => p.applied);
    if (dirty) {
      throw new Error(`没有基线备份 ${basePath}，无从恢复。恢复动作：先跑一次 apply 建立基线。`);
    }
    console.log('restore: asar 基线缺失且 asar 补丁未应用，跳过 asar 回滚');
  } else if (!fs.existsSync(sidecarPath)) {
    throw new Error(`基线 sidecar 缺失（${sidecarPath}），无法核验基线出身。恢复动作：删除基线文件后重跑 apply 重建。`);
  } else {
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
  }

  // loose-file 补丁同样回滚基线。先对全部 loose 目标做校验（基线在否/版本一致否），
  // 全过再统一写入——避免「asar 已回滚、loose 因版本不一致中途抛错」的半回滚终态。
  const loosePatches = loadPatches().filter(isLoosePatch);
  const loosePlan = [];
  for (const patch of loosePatches) {
    const live = looseLivePath(resourcesDir, patch);
    const basePathL = live + LOOSE_BASE_SUFFIX;
    const sidecarPathL = basePathL + SIDECAR_SUFFIX;
    if (!fs.existsSync(basePathL)) {
      console.log(`restore: ${patch.name} 无 loose 基线，跳过（${path.basename(live)}）`);
      continue;
    }
    let sidecarL = null;
    try {
      sidecarL = JSON.parse(fs.readFileSync(sidecarPathL, 'utf8'));
    } catch {
      /* 基线存在即可用，sidecar 损坏只警告 */
    }
    if (sidecarL && sidecarL.appVersion !== appVersion && !args.force) {
      throw new Error(
        `${patch.name} 基线版本 ${sidecarL.appVersion} ≠ 在线版本 ${appVersion}（升级后混用旧基线会退回旧文件）。` +
          '确认强制恢复时加 --force。',
      );
    }
    loosePlan.push({ patch, live });
  }
  for (const { live } of loosePlan) {
    const basePathL = live + LOOSE_BASE_SUFFIX;
    const stageL = path.join(path.dirname(live), `.${path.basename(live)}.restore-stage-${process.pid}`);
    try {
      fs.copyFileSync(basePathL, stageL);
      const fdL = fs.openSync(stageL, 'r');
      try {
        fs.fsyncSync(fdL);
      } finally {
        fs.closeSync(fdL);
      }
      fs.renameSync(stageL, live);
    } catch (err) {
      fs.rmSync(stageL, { force: true });
      throw err;
    }
    console.log(`restore: ${path.basename(live)} 已恢复为 loose 基线。`);
  }
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
  const asarPatches = patches.filter((p) => !isLoosePatch(p));
  const loosePatches = patches.filter(isLoosePatch);
  for (const probe of probePatches(livePath, asarPatches)) {
    if (probe.error) {
      console.log(`  [?] ${probe.patch.name}: 目标定位失败 — ${probe.error}`);
      continue;
    }
    const detail = probe.modifiedVsHeader
      ? '文件已被修改（与 pristine header 哈希不一致）'
      : '文件与 pristine 哈希一致';
    console.log(`  [${probe.applied ? 'x' : ' '}] ${probe.patch.name} — ${probe.applied ? '已应用' : '未应用'}，${detail}（${probe.entry.path}）`);
  }
  for (const probe of loosePatches.map((p) => probeLoosePatch(resourcesDir, p))) {
    if (probe.error) {
      console.log(`  [?] ${probe.patch.name}: 目标定位失败 — ${probe.error}`);
      continue;
    }
    console.log(`  [${probe.applied ? 'x' : ' '}] ${probe.patch.name} — ${probe.applied ? '已应用' : '未应用'}（${path.relative(appPath, probe.file)}）`);
  }
  if (!fs.existsSync(basePath)) {
    console.log(`恢复动作：node ${__filename} apply  # 建立基线并应用全部补丁`);
  }
}

// ===== asar 外裸文件补丁（loose-file）=====
// 目标是 Resources/ 下的独立文件（当前唯一：glm/zcode.cjs）。机制与 asar 路径
// 同构：pristine 基线（文件名 + LOOSE_BASE_SUFFIX + sidecar）+ 幂等 apply +
// 版本比对自动重采纳；写入为 stage 全量写 + 回读逐字节比对 + 原子 rename。

function looseLivePath(resourcesDir, patch) {
  return path.join(resourcesDir, patch.target.looseFile);
}

function probeLoosePatch(resourcesDir, patch) {
  const file = looseLivePath(resourcesDir, patch);
  if (!fs.existsSync(file)) {
    return { patch, file, error: `目标文件不存在：${file}` };
  }
  try {
    const content = fs.readFileSync(file, 'utf8');
    return { patch, file, applied: patch.isApplied(content), size: content.length };
  } catch (err) {
    return { patch, file, error: err.message };
  }
}

/** 在线 loose 目标是否无补丁痕迹（有任一已应用即非 pristine；定位失败上抛） */
function looseLiveIsPristine(resourcesDir, loosePatches) {
  const probes = loosePatches.map((p) => probeLoosePatch(resourcesDir, p));
  const failed = probes.find((p) => p.error);
  if (failed) throw new Error(`在线文件核验失败（${failed.patch.name}）：${failed.error}`);
  return probes.every((p) => !p.applied);
}

async function ensureLooseBase(resourcesDir, appVersion, loosePatches, log) {
  const bases = [];
  for (const patch of loosePatches) {
    const live = looseLivePath(resourcesDir, patch);
    // 同一 loose 文件可能承载多个补丁：按文件聚合判定（当前一对一，机制上按文件建基线）
    const basePath = live + LOOSE_BASE_SUFFIX;
    const sidecarPath = basePath + SIDECAR_SUFFIX;
    if (fs.existsSync(basePath)) {
      let sidecar;
      try {
        sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      } catch {
        // sidecar 缺失/损坏 = 半采纳态,按基线文件自愈重建(与 asar 路径同款)
        log(`loose 基线 sidecar 缺失/损坏，按基线文件自愈重建（${path.basename(sidecarPath)}）`);
        const sha = await sha256File(basePath);
        writeSidecar(sidecarPath, { appVersion, adoptedFrom: 'recovered', adoptedAt: new Date().toISOString(), sha256: sha });
        sidecar = { appVersion, adoptedFrom: 'recovered', sha256: sha };
      }
      if (sidecar.appVersion === appVersion) {
        bases.push({ patch, basePath });
        continue;
      }
      if (!looseLiveIsPristine(resourcesDir, loosePatches)) {
        throw new Error(
          `loose 基线版本（${sidecar.appVersion}）与在线版本（${appVersion}）不一致，且在线文件检出补丁痕迹，拒绝自动重置基线。` +
            `恢复动作：人工核认在线文件可作基线后，删除 ${basePath} 与 sidecar 再重跑 apply。`,
        );
      }
      log(`ZCode 已升级（${sidecar.appVersion} → ${appVersion}），${path.basename(live)} 无补丁痕迹，采纳为新基线`);
      await adoptBase(live, basePath, { appVersion, adoptedFrom: `live@${appVersion}` });
    } else {
      if (!looseLiveIsPristine(resourcesDir, loosePatches)) {
        throw new Error(
          `找不到 ${path.basename(live)} 的基线，且在线文件已含补丁痕迹，无法确定 pristine 起点。` +
            `恢复动作：重装/更新 ZCode 得到全新文件后重跑 apply。`,
        );
      }
      log(`无基线，采纳在线 ${path.basename(live)} 为基线（v${appVersion}）`);
      await adoptBase(live, basePath, { appVersion, adoptedFrom: `live@${appVersion}` });
    }
    bases.push({ patch, basePath });
  }
  return bases;
}

/**
 * loose 写入：stage 全量写 + fsync + 回读逐字节比对 + 原子 rename；失败在线文件不动。
 * 并发防护：rename 前复查 live 的 mtime/size 与读取时快照一致——读取后有并发写者
 * （zcode 自动更新 / 另一 apply / 手工编辑）即报错退出，防「旧快照覆盖新版本」
 * 的静默丢失更新。
 */
function writeLooseFile(livePath, newContent, readStat) {
  const dir = path.dirname(livePath);
  const stagePath = path.join(dir, `.${path.basename(livePath)}.patch-stage-${process.pid}`);
  try {
    fs.writeFileSync(stagePath, newContent, 'utf8');
    const fd = fs.openSync(stagePath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const readBack = fs.readFileSync(stagePath, 'utf8');
    if (readBack !== newContent) throw new Error('stage 回读与计划内容不一致');
    if (readStat) {
      const now = fs.statSync(livePath);
      if (now.mtimeMs !== readStat.mtimeMs || now.size !== readStat.size) {
        throw new Error(
          `目标文件在读取后被并发修改（${path.basename(livePath)}:${readStat.size}B → ${now.size}B），拒绝覆盖。` +
            '恢复动作：重跑 apply（以最新文件为准重新定位锚点）。',
        );
      }
    }
    fs.renameSync(stagePath, livePath);
  } catch (err) {
    fs.rmSync(stagePath, { force: true });
    throw err;
  }
}

async function applyLoosePatches(resourcesDir, appPath, appVersion, loosePatches, log) {
  await ensureLooseBase(resourcesDir, appVersion, loosePatches, log);
  const edits = [];
  const skipped = [];
  const failed = [];
  for (const patch of loosePatches) {
    try {
      const file = looseLivePath(resourcesDir, patch);
      const readStat = fs.statSync(file);
      const content = fs.readFileSync(file, 'utf8');
      if (patch.isApplied(content)) {
        skipped.push({ patch, file });
        continue;
      }
      const { content: next, note } = patch.transform(content, file);
      writeLooseFile(file, next, readStat);
      edits.push({ patch, file, sizeBefore: content.length, sizeAfter: next.length, note });
    } catch (err) {
      failed.push({ patch, error: err.message });
    }
  }
  return { edits, skipped, failed };
}

/** 安装 zsem 外部模块 symlink（幂等）：~/.zcode/cli/zsem → 本仓 zsem/ */
function cmdInstall() {
  const fsExtra = require('node:fs');
  const os = require('node:os');
  if (!os.homedir()) {
    throw new Error('HOME 环境为空，无法定位安装目录（会污染当前目录）。恢复动作：设置 HOME 后重跑 install。');
  }
  const linkDir = path.join(os.homedir(), '.zcode', 'cli');
  const link = path.join(linkDir, 'zsem');
  const target = path.join(__dirname, 'zsem');
  if (!fsExtra.existsSync(path.join(target, 'entry.js'))) {
    throw new Error(`zsem 模块不完整（缺 entry.js）：${target}。恢复动作：检查本仓 patch-zcode-app/zsem/ 目录。`);
  }
  fsExtra.mkdirSync(linkDir, { recursive: true });
  let existing = null;
  try {
    existing = fsExtra.readlinkSync(link);
  } catch {
    /* 无链接 */
  }
  if (existing !== null) {
    if (path.resolve(path.dirname(link), existing) === target) {
      console.log(`install: symlink 已存在且指向正确（${link} → ${target}）`);
    } else {
      throw new Error(`symlink 已存在但指向别处（${link} → ${existing}）。恢复动作：确认后手工删除该链接再重跑 install。`);
    }
  } else {
    if (fsExtra.existsSync(link)) {
      throw new Error(`${link} 已存在且不是 symlink。恢复动作：确认该路径用途后手工处理再重跑 install。`);
    }
    fsExtra.symlinkSync(target, link, 'dir');
    console.log(`install: 已创建 ${link} → ${target}`);
  }
  // 链路校验：经 symlink 加载 entry.js
  const entry = require(path.join(link, 'entry.js'));
  if (typeof entry.admit !== 'function') {
    throw new Error(`经 symlink 加载 entry.js 成功但 admit 不是函数。恢复动作：检查 zsem/entry.js 导出。`);
  }
  console.log('install: entry.js 链路校验通过（admit 可用）');
}

// ===== autopatch:升级自动重打(LaunchAgent 统一入口) =====
// 设计约束:①同一入口打全部补丁,单补丁失败不连坐(cmdApply 隔离语义);
// ②任何失败不影响 zcode 启动(写入 stage+rename 原子,失败时在线文件不动,
//   本进程与 zcode 启动零耦合);③升级器写文件中不盲打(稳定探测)。
const AUTOPATCH_LABEL = 'dev.zsw.zcode-autopatch';
const LEGACY_LABEL = 'dev.zsw.zcode-patch-mode-yolo'; // 旧 yolo 专用自愈,退役防双路径互踩

/** 稳定签名:版本 + 两类补丁目标文件的 size;升级器还在写时签名会变 */
function appStableSignature(appPath) {
  try {
    const parts = [
      readAppVersion(appPath),
      fs.statSync(path.join(appPath, 'Contents', 'Resources', 'app.asar')).size,
      fs.statSync(path.join(appPath, 'Contents', 'Resources', 'glm', 'zcode.cjs')).size,
    ];
    return parts.join('|');
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等待 app 稳定:签名连续两次一致才算稳定(升级器替换包体期间签名抖动)。
 * @returns {Promise<string|null>} 稳定签名;null = 超时仍不稳定(下次触发再试)
 */
async function waitStable(appPath, { tries = 15, intervalMs = 2000 } = {}) {
  let last = null;
  let stableCount = 0;
  for (let i = 0; i < tries; i++) {
    const sig = appStableSignature(appPath);
    if (sig !== null && sig === last) {
      stableCount += 1;
      if (stableCount >= 1) return sig; // 第二次采样与上次一致
    } else {
      stableCount = 0;
    }
    last = sig;
    await sleep(intervalMs);
  }
  return null;
}

/**
 * autopatch:LaunchAgent 的触发入口。稳定探测 → apply(隔离)→ 部分失败退避重试。
 * 系统性冲突(如版本不一致且有补丁痕迹拒绝重采纳)不重试——记日志等人工。
 */
async function cmdAutopatch(args) {
  const appPath = path.resolve(args.app || DEFAULT_APP);
  console.log(`[autopatch] 触发(pid ${process.pid})`);
  const sig = await waitStable(appPath);
  if (sig === null) {
    console.error(`[autopatch] app 文件在 ${15 * 2}s 内未稳定,放弃本次(等待下次触发/周期兜底)。`);
    process.exitCode = 1;
    return;
  }
  console.log(`[autopatch] app 稳定(${sig.replace(/\|/g, ' / ')})`);
  const backoffMs = [0, 10000, 60000];
  for (let round = 0; round < backoffMs.length; round++) {
    if (backoffMs[round] > 0) await sleep(backoffMs[round]);
    try {
      await cmdApply({ ...args, app: appPath });
      console.log(`[autopatch] 第 ${round + 1} 轮全部补丁处理完成。`);
      return;
    } catch (err) {
      const partial = err && err.partial === true;
      console.error(`[autopatch] 第 ${round + 1} 轮失败${partial ? '(部分补丁,已隔离处理其余)' : '(系统性,不重试)'}: ${err.message}`);
      if (String(err && err.message).includes('EPERM')) {
        console.error('[autopatch] EPERM = macOS App Management 未授权。恢复动作:重跑 autopatch-install,按其指引把 zcode-autopatch.app 加入 系统设置→隐私与安全性→应用程序管理。');
      }
      if (!partial) {
        process.exitCode = 1;
        return; // 版本冲突/权限等系统性问题:重试无意义,等人工或下次触发
      }
    }
  }
  console.error('[autopatch] 三轮退避后仍有失败补丁,放弃本次(StartInterval 周期会再触发;持续失败需人工看锚点)。');
  process.exitCode = 1;
}

/** LaunchAgent 安装:统一入口接管升级自动重打,同时退役旧 yolo 专用 plist */
function cmdAutopatchInstall() {
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const logPath = path.join(os.homedir(), '.zcode', 'cli', 'patch-autopatch.log');

  // TCC 载体:极简 .app bundle。macOS「App Management」保护拦截 launchd 上下文对
  // /Applications 下 app 的写入,且系统设置只能给 .app 授权(裸 node 二进制加不进
  // 列表)——本 bundle 即 TCC 身份(shell 壳 exec node,子进程按 responsible-process
  // 归属本 bundle),用户在系统设置一次性授权后 launchd 触发即有写权限。
  const bundleDir = path.join(os.homedir(), '.zcode', 'cli', 'zcode-autopatch.app');
  const macosDir = path.join(bundleDir, 'Contents', 'MacOS');
  fs.mkdirSync(macosDir, { recursive: true });
  const launcher = `#!/bin/sh
# ${AUTOPATCH_LABEL} TCC 载体:node 路径探测(nvm 升级换路径时也能找到;彻底找不到时
# 重跑 autopatch-install 刷新本壳)。PATH 由 launchd 提供的极简环境决定,主要靠 nvm 兜底。
NODE_BIN=$(command -v node || true)
[ -x "\$NODE_BIN" ] || NODE_BIN=$(ls -t "\${HOME}"/.nvm/versions/node/*/bin/node 2>/dev/null | head -1)
exec "\$NODE_BIN" '${__filename}' autopatch
`;
  fs.writeFileSync(path.join(macosDir, 'zcode-autopatch'), launcher, { encoding: 'utf8', mode: 0o755 });
  fs.writeFileSync(
    path.join(bundleDir, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>${AUTOPATCH_LABEL}</string>
    <key>CFBundleExecutable</key>
    <string>zcode-autopatch</string>
    <key>CFBundleName</key>
    <string>zcode-autopatch</string>
    <key>LSBackgroundOnly</key>
    <true/>
</dict>
</plist>
`,
    'utf8',
  );

  const plistPath = path.join(agentsDir, `${AUTOPATCH_LABEL}.plist`);
  const watchPaths = [
    '/Applications/ZCode.app/Contents/Resources/app.asar',
    '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
    '/Applications/ZCode.app/Contents/Info.plist',
  ];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${AUTOPATCH_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${path.join(macosDir, 'zcode-autopatch')}</string>
    </array>
    <!-- 升级覆盖面任一路径变化即触发重打(app.asar / asar 外 zcode.cjs / 整包替换必变的 Info.plist) -->
    <key>WatchPaths</key>
    <array>
${watchPaths.map((p) => `        <string>${p}</string>`).join('\n')}
    </array>
    <!-- 兜底:每 6 小时查一次(幂等) + 登录时自检 -->
    <key>StartInterval</key>
    <integer>21600</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logPath}</string>
    <key>StandardErrorPath</key>
    <string>${logPath}</string>
</dict>
</plist>
`;
  // 先退役旧 yolo 专用 LaunchAgent(字节级直改 asar,与本工具的重打包并发会互踩)
  const legacyPath = path.join(agentsDir, `${LEGACY_LABEL}.plist`);
  if (fs.existsSync(legacyPath)) {
    try {
      execFileSync('launchctl', ['unload', legacyPath], { stdio: 'pipe' });
    } catch {
      /* 未加载也算退役 */
    }
    const retired = legacyPath.replace(/\.plist$/, `.retired-${Date.now()}.plist`);
    fs.renameSync(legacyPath, retired);
    console.log(`autopatch-install: 已退役旧 ${LEGACY_LABEL}(改名 ${path.basename(retired)};其 python 脚本文件保留不再被触发)`);
  }
  if (fs.existsSync(plistPath)) {
    try {
      execFileSync('launchctl', ['unload', plistPath], { stdio: 'pipe' });
    } catch {
      /* 未加载 */
    }
  }
  fs.writeFileSync(plistPath, plist, 'utf8');
  try {
    execFileSync('launchctl', ['load', plistPath], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`launchctl load 失败:${err.message}。恢复动作:手工执行 launchctl load ${plistPath} 看报错。`);
  }
  console.log(`autopatch-install: ${AUTOPATCH_LABEL} 已安装并加载`);
  console.log(`  TCC 载体: ${bundleDir}`);
  console.log(`  日志: ${logPath}`);
  console.log('  触发:WatchPaths(app.asar/zcode.cjs/Info.plist 变更)+ 每 6 小时 + 登录时');
  console.log('\n【一次性授权(必做,否则 launchd 触发写入会被 macOS 拦为 EPERM)】');
  console.log('  系统设置 → 隐私与安全性 → 应用程序管理(App Management)');
  console.log(`  点「+」添加:${bundleDir}`);
  console.log('  即将打开该设置面板…');
  try {
    execFileSync('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles'], { stdio: 'pipe' });
  } catch {
    /* 面板打不开时用户手动开 */
  }
  console.log(`\n  授权后验证:launchctl start ${AUTOPATCH_LABEL} && tail ${logPath}`);
}

function cmdAutopatchUninstall() {
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${AUTOPATCH_LABEL}.plist`);
  if (!fs.existsSync(plistPath)) {
    console.log('autopatch-uninstall: 未安装,无需卸载');
    return;
  }
  try {
    execFileSync('launchctl', ['unload', plistPath], { stdio: 'pipe' });
  } catch {
    /* 未加载 */
  }
  fs.rmSync(plistPath, { force: true });
  const bundleDir = path.join(os.homedir(), '.zcode', 'cli', 'zcode-autopatch.app');
  fs.rmSync(bundleDir, { recursive: true, force: true });
  console.log(`autopatch-uninstall: ${AUTOPATCH_LABEL} 已卸载(含 TCC 载体;补丁本体不回滚,回滚用 restore)`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'status';
  const runners = {
    status: cmdStatus,
    apply: cmdApply,
    restore: cmdRestore,
    install: cmdInstall,
    autopatch: cmdAutopatch,
    'autopatch-install': cmdAutopatchInstall,
    'autopatch-uninstall': cmdAutopatchUninstall,
  };
  const run = runners[cmd];
  if (!run) {
    console.error(`未知命令 ${cmd}。用法见文件头注释或 README.md。`);
    process.exit(1);
  }
  Promise.resolve()
    .then(() => run(args))
    .catch((err) => {
      // 回执三段形态兜底:个别底层错误(EACCES/EEXIST 等系统错误)不带恢复动作段,
      // 统一附加通用指引,保持所有失败回执形态一致
      const msg = err && err.message ? err.message : String(err);
      console.error(`错误: ${msg}`);
      if (!msg.includes('恢复动作')) {
        console.error('恢复动作：修复上述问题后重跑；紧急止血可 node ' + __filename + ' restore 回滚为基线。');
      }
      if (process.env.PATCH_DEBUG) console.error(err.stack);
      process.exit(1);
    });
}

main();
