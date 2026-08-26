'use strict';

// 无头/subagent 场景的引擎 catalog override 生命周期管理（设计 §3.1 场景二 / §5 W3）。
//
// 机制：向 ~/.zcode/cli/config.json 的 modelCatalog.overrides[modelId].contextWindow
// 写入 thresholdTokens + 34000，把引擎内建 autoCompact 的触发阈值拉到 thresholdTokens
// （P17 探针实证公式：阈值 = contextWindow − 21000 outputReserve − 13000 buffer）。
// 用后还原 + 崩溃自愈由旁路锁文件 override-lock.json 驱动：
//   { _zscManaged: true, owners: [{ownerId, pid, ts}],
//     backup: {modelId, hadEntry, prevContextWindow, hadContextWindowKey}, updatedAt }
//
// 架构裁定（P-G3 门）：_zscManaged 标记放旁路锁文件而非 config 本体——免赌 config 在
// 引擎合并链中的存活性，config 只承载 override 本体。
//
// 三个关键取舍（评审定案，改动前先想清楚）：
// 1. 坏 JSON 拒绝操作：config 解析失败时 apply/revert 一律拒绝执行、原文字节不动，
//    绝不在用户坏配置之上做「聪明的」覆盖或还原——那会把可手工修复的语法错误变成数据丢失。
//    错误信息必须指向恢复动作（编辑器修复后重试）。
// 2. 不做 pid 探活：healResidue 只处理 owners 为空的确定残留。曾考虑过对 owners 里
//    process.kill(pid,0) 探活失败超半数即视为孤儿还原，但跨 boot 后 pid 被无关进程复用
//    时会误杀存活登记、提前还原正在役的 override（无头任务可能小时级），风险大于收益，
//    砍掉；孤儿清理靠主控退出路径的 release 与人工 revert --force。
// 3. 外科手术式写入：JSON.parse 读全量 → 只 mutate overrides[modelId].contextWindow
//    这一个叶子 → 全量原子写回。parse/stringify 保引用结构，因此用户的顶层键、其他模型
//    条目、同模型下其他字段全部保真，无需手写 deep merge（deep merge 才是丢字段的温床）。
//    物理上仍是全量重写：JSON 不保留注释与原始空白，写回按 stringify(,2) 规范化——
//    引擎配置为纯 JSON（P17 探针以此方式写入并实测生效），无注释丢失风险；值的层面
//    往返严格无损（验收口径即 parse-等价）。
//    apply 时若代建了缺失的容器键（modelCatalog/overrides），backup.ownedContainers 会登记，
//    归零还原时原样摘除以达成无痕；用户自己的容器与条目永不清理。
//
// 崩溃安全次序（任何一步崩溃留下的现场都必须能被下一次 heal/revert 安全还原）：
//   apply  = 先写锁（含 backup 快照）再写 config —— 锁先在场，config 写一半崩了仍可凭锁还原；
//            反过来则是「无凭证孤儿 override」，无法自动定位与回滚。
//   revert = 先写 config 再删锁 —— 还原落盘后崩了只留 owners 空残留锁，下次 heal 判定空锁
//            按 backup 复核（此时 config 已等于预期）删锁即可；反向则是孤儿 override。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { log, logError } = require('./log');

// P17 实证：contextWindow 比目标 autoCompact 阈值大出的固定余量（outputReserve+buffer）
const CONTEXT_WINDOW_DELTA = 34000;

function defaultConfigPath() {
  return path.join(os.homedir(), '.zcode', 'cli', 'config.json');
}

function defaultDataDir() {
  return path.join(os.homedir(), '.zcode', 'z-smart-context');
}

function lockPathOf(dataDir) {
  return path.join(dataDir, 'override-lock.json');
}

// ---- 结构化结果工厂：公开函数绝不 throw，一切失败都返回 {ok:false, code, message} ----

function fail(code, message) {
  logError(`[override] ${code}: ${message}`);
  return { ok: false, code, message };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function isFinitePositiveNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

// ---- IO 原子写（tmp + rename，手法与 lib/state.js saveState 一致）----

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// 读 JSON 文件三态：missing / {ok,value} / {corrupt,error}；ENOENT 之外的 IO 异常原样抛出
// （调用方均有 try/catch 兜成结构化 io 失败）
function readJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true };
    throw err;
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { corrupt: true, error: err };
  }
}

// 读引擎 config（~/.zcode/cli/config.json）。返回 kind: 'ok' | 'missing' | 'corrupt'；
// 其他 IO 异常原样抛出，由各公开函数的外层 catch 兜成 io 失败。
function readEngineConfig(cfgPath) {
  let raw;
  try {
    raw = fs.readFileSync(cfgPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  try {
    const value = JSON.parse(raw);
    if (!isPlainObject(value)) {
      return { kind: 'corrupt', reason: `顶层不是 JSON 对象（${typeof value}）` };
    }
    return { kind: 'ok', value };
  } catch (err) {
    return { kind: 'corrupt', reason: `JSON.parse 失败：${err.message}` };
  }
}

// backup 有效即可据此机械还原；不有效则宁可留人审也不赌
function isValidBackup(backup) {
  if (!isPlainObject(backup)) return false;
  if (!isNonEmptyString(backup.modelId)) return false;
  if (typeof backup.hadEntry !== 'boolean') return false;
  if (!isFinitePositiveNumber(backup.prevContextWindow) && backup.prevContextWindow !== null) {
    return false;
  }
  // hadContextWindowKey 为后补字段；旧格式锁缺省按 true（存在 contextWindow 子键）处理
  if (backup.hadContextWindowKey !== undefined && typeof backup.hadContextWindowKey !== 'boolean') {
    return false;
  }
  // ownedContainers 为后补字段：记录哪些容器键是本工具代建的（归零还原时一并摘除，
  // 否则 G3 无痕验收会出现残留空壳 {modelCatalog:{overrides:{}}}）；缺省按未代建处理
  if (
    backup.ownedContainers !== undefined &&
    (!Array.isArray(backup.ownedContainers) ||
      backup.ownedContainers.some((k) => k !== 'modelCatalog' && k !== 'overrides'))
  ) {
    return false;
  }
  return true;
}

function expectedEntryAfterRelease(backup) {
  // 归零还原后的应有形态：hadEntry=false → 条目整体不存在；否则条目在且 contextWindow 等于原值
  // （hadContextWindowKey=false 说明原条目本就没有该子键，预期形态同样是不存在该子键）
  if (!backup.hadEntry || backup.hadContextWindowKey === false) return undefined;
  return backup.prevContextWindow === null ? undefined : backup.prevContextWindow;
}

// 按 backup 对已 parse 的引擎配置做原地还原（mutate 入参）。仅触碰 backup.modelId 一个键，
// 以及 backup.ownedContainers 登记的本工具代建容器（用户自己的结构绝不在清理范围）
function restoreInPlace(engine, backup) {
  const entry = engine.modelCatalog?.overrides?.[backup.modelId];
  if (!entry) return; // 现场比备份还干净（如上次还原已落盘但删锁前崩溃），无事可做
  const expected = expectedEntryAfterRelease(backup);
  if (expected === undefined) {
    delete engine.modelCatalog.overrides[backup.modelId];
  } else {
    engine.modelCatalog.overrides[backup.modelId] = {
      ...entry,
      contextWindow: expected,
    };
    return;
  }
  // 摘除本工具代建的空壳（仅当此刻确为空，防误删用户并行写入的其他条目）
  const owned = Array.isArray(backup.ownedContainers) ? backup.ownedContainers : [];
  const overridesMap = engine.modelCatalog.overrides;
  if (owned.includes('overrides') && Object.keys(overridesMap).length === 0) {
    delete engine.modelCatalog.overrides;
  }
  if (
    owned.includes('modelCatalog') &&
    engine.modelCatalog.overrides === undefined &&
    Object.keys(engine.modelCatalog).length === 0
  ) {
    delete engine.modelCatalog;
  }
}

// 现场核对：config 中 overrides[backup.modelId] 是否仍是我们写出的 override 值
// （≠ 归零还原后的预期形态 → 在场）。backup 缺失时无从比对，返回 null（未知）。
function detectOverridePresence(configRead, modelId, backup) {
  if (configRead.kind === 'corrupt') return null;
  if (!isValidBackup(backup)) return null;
  const current = configRead.kind === 'ok'
    ? configRead.value.modelCatalog?.overrides?.[modelId]
    : undefined; // config 不存在视为干净
  const expected = expectedEntryAfterRelease(backup);
  if (expected === undefined) return current !== undefined;
  return !(isPlainObject(current) && current.contextWindow === expected);
}

// 代建缺失的容器层级并回报建了哪些（归零还原时要原样摘除，保证无痕）
function ensureOverridesContainer(engine) {
  const ownedContainers = [];
  if (!isPlainObject(engine.modelCatalog)) {
    // catalog 是用户/引擎的地盘，只有缺失时才代建；类型不对说明配置被外部改坏，拒碰
    if (engine.modelCatalog !== undefined) {
      throw new UnsafeConfigError(`modelCatalog 存在但不是对象（${typeof engine.modelCatalog}）`);
    }
    engine.modelCatalog = {};
    ownedContainers.push('modelCatalog');
  }
  if (!isPlainObject(engine.modelCatalog.overrides)) {
    if (engine.modelCatalog.overrides !== undefined) {
      throw new UnsafeConfigError(
        `modelCatalog.overrides 存在但不是对象（${typeof engine.modelCatalog.overrides}）`,
      );
    }
    engine.modelCatalog.overrides = {};
    ownedContainers.push('overrides');
  }
  return ownedContainers;
}

class UnsafeConfigError extends Error {}

function unsafeResult(err, cfgPath) {
  return fail(
    'unsafe-entry',
    `${err.message}，位于 ${cfgPath}。为避免覆盖你的自定义配置已拒绝操作；` +
      `请用编辑器核对该键后重试`,
  );
}

// 申请快照：仅记录本次将要触碰的两个事实（条目是否存在 / 原 contextWindow 值）。
// 用户脏数据（条目非对象等）在此挡下并拒绝操作，绝不静默改造。
function snapshotForApply(engine, modelId) {
  const existing = engine.modelCatalog?.overrides?.[modelId];
  if (existing === undefined) {
    return { hadEntry: false, prevContextWindow: null, hadContextWindowKey: false };
  }
  if (!isPlainObject(existing)) {
    throw new UnsafeConfigError(
      `modelCatalog.overrides["${modelId}"] 已存在且不是对象（${typeof existing}）`,
    );
  }
  const cw = existing.contextWindow;
  if (cw !== undefined && !isFinitePositiveNumber(cw)) {
    throw new UnsafeConfigError(
      `modelCatalog.overrides["${modelId}"].contextWindow 已存在且不是有限正数（${String(cw)}）`,
    );
  }
  return {
    hadEntry: true,
    prevContextWindow: cw === undefined ? null : cw,
    hadContextWindowKey: cw !== undefined,
  };
}

/**
 * 写入引擎 catalog override 并登记 owner（引用计数 +1）。
 * 同 ownerId 重复 apply 幂等：不重复登记、不改任何文件，直接返回 alreadyOwner。
 * @returns {{ok:true,...}|{ok:false,code,message}}
 */
function applyOverride({ modelId, thresholdTokens, ownerId, configPath, dataDir } = {}) {
  try {
    if (!isNonEmptyString(modelId)) {
      return fail('invalid-args', `modelId 须为非空字符串，收到 ${JSON.stringify(modelId ?? null)}`);
    }
    if (!isFinitePositiveNumber(thresholdTokens)) {
      return fail('invalid-args', `thresholdTokens 须为有限正数，收到 ${JSON.stringify(thresholdTokens ?? null)}`);
    }
    if (!isNonEmptyString(ownerId)) {
      return fail('invalid-args', `ownerId 须为非空字符串，收到 ${JSON.stringify(ownerId ?? null)}`);
    }

    const cfgPath = configPath || defaultConfigPath();
    const lockPath = lockPathOf(dataDir || defaultDataDir());
    const targetCtx = thresholdTokens + CONTEXT_WINDOW_DELTA;

    // 1. 先读引擎配置——坏 JSON 拒绝执行（取舍见文件头注释 1）
    let cfgRead;
    try {
      cfgRead = readEngineConfig(cfgPath);
    } catch (err) {
      return fail('io', `读取 ${cfgPath} 失败：${err.message}；检查文件权限后重试`);
    }
    if (cfgRead.kind === 'corrupt') {
      return fail(
        'corrupt-config',
        `${cfgPath} 无法解析（${cfgRead.reason}）。原文件未做任何修改；` +
          `请先用编辑器修复该文件的 JSON 语法再执行 zsc override apply`,
      );
    }
    const engine = cfgRead.kind === 'ok' ? cfgRead.value : {};
    // config 缺失时以空对象为起点创建（引擎首启也会生成此文件，新建不影响其合并行为）

    // 2. 读旁路锁的三态处理
    let lockRead;
    try {
      lockRead = readJsonFile(lockPath);
    } catch (err) {
      return fail('io', `读取锁文件 ${lockPath} 失败：${err.message}`);
    }
    let lock = lockRead.ok ? lockRead.value : null;
    if (lockRead.corrupt) {
      return fail(
        'lock-corrupt',
        `锁文件 ${lockPath} 无法解析。当前没有任何写入发生；` +
          `人工确认现场后可用 zsc override revert --owner manual --force 救援，` +
          `或删除该锁文件重来`,
      );
    }
    if (lock !== null && lock._zscManaged !== true) {
      // 同名外来文件不可动（防御性：这个位置原则上只会是我们写的）
      return fail(
        'foreign-lock',
        `${lockPath} 已存在且缺少 _zscManaged 标记，疑似非本工具创建。未做任何修改；` +
          `请人工核对该文件后再试`,
      );
    }

    if (lock !== null) {
      const owners = Array.isArray(lock.owners) ? lock.owners : [];
      if (owners.length === 0) {
        // 空锁残留 = 上次归零删锁前的崩溃半途态。必须先按旧 backup 还原，
        // 否则下面的新 backup 会把「上次 override 后的低窗口」误记为原值（备份污染）
        if (!isValidBackup(lock.backup)) {
          return fail(
            'residue-needs-review',
            `发现 owners 为空的残留锁（${lockPath}）但其 backup 不可信。本次 apply 未执行；` +
              `请运行 node bin/zsc.js override status 核对现场后人工处理 config`,
          );
        }
        restoreInPlace(engine, lock.backup);
        try {
          writeJsonAtomic(cfgPath, engine);
        } catch (err) {
          return fail('io', `清理残留时写回 ${cfgPath} 失败：${err.message}`);
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // 删不掉旧锁则覆盖写入亦可接受（马上会被本次 apply 重写）
        }
        log(`[override] apply 前 清理 owners 空 残留锁并还原 config（model=${lock.backup.modelId}）`);
        lock = null; // 以干净状态进入首 owner 登记
      } else {
        // 在役锁：单 model 占用限制——backup 只有一份，混叠第二个 model 会导致首个无法还原
        if (isValidBackup(lock.backup) && lock.backup.modelId !== modelId) {
          return fail(
            'model-mismatch',
            `当前已有针对 model "${lock.backup.modelId}" 的 override 登记在役` +
              `（owners: ${owners.map((o) => o.ownerId).join(', ')}）。` +
              `同一窗口期只能服务一个 model；等待它们执行 zsc override revert，` +
              `或用相同 model "<${lock.backup.modelId}>" 登记`,
          );
        }
        if (owners.some((o) => o && o.ownerId === ownerId)) {
          log(`[override] 幂等 apply：owner "${ownerId}" 已在役，跳过`);
          return {
            ok: true,
            alreadyOwner: true,
            ownerId,
            modelId,
            owners,
            contextWindow: engine.modelCatalog?.overrides?.[modelId]?.contextWindow ?? targetCtx,
            configPath: cfgPath,
            lockPath,
          };
        }
      }
    }

    // 3. 快照将要触碰的键的原状态（脏数据在此拒绝，取舍见文件头注释 3）
    let snapshot;
    try {
      const ownedContainers = ensureOverridesContainer(engine);
      snapshot = snapshotForApply(engine, modelId);
      snapshot.ownedContainers = ownedContainers;
    } catch (err) {
      if (err instanceof UnsafeConfigError) return unsafeResult(err, cfgPath);
      throw err;
    }

    // 4. 崩溃安全次序：先锁后 config（取舍见文件头注释）；外科手术式 mutate 后全量写回
    const owners = (lock !== null && Array.isArray(lock.owners) ? lock.owners : [])
      .concat([{ ownerId, pid: process.pid, ts: Date.now() }]);
    const backup = lock !== null && isValidBackup(lock.backup)
      ? lock.backup
      : { modelId, ...snapshot };
    try {
      writeJsonAtomic(lockPath, {
        _zscManaged: true,
        owners,
        backup,
        updatedAt: Date.now(),
      });
    } catch (err) {
      return fail('io', `写入锁文件 ${lockPath} 失败：${err.message}`);
    }

    try {
      // 只改这一个叶子：保留该 model 下用户已有其他字段与其他 model 条目（注释 3）
      engine.modelCatalog.overrides[modelId] = {
        ...engine.modelCatalog.overrides[modelId],
        contextWindow: targetCtx,
      };
      writeJsonAtomic(cfgPath, engine);
    } catch (err) {
      // config 写入失败但锁已登记——如实报告而非吞掉：此刻锁说是我们管但实际没写成，
      // status 会暴露不一致；保守不自动回滚锁（主控可立即 revert 补救）
      return fail('io', `写入 ${cfgPath} 失败：${err.message}；锁已登记，请先执行 ` +
        `zsc override revert --owner ${JSON.stringify(ownerId)} 清理登记后重试`);
    }

    log(`[override] apply ok owner="${ownerId}" model="${modelId}" ` +
      `contextWindow=${targetCtx}(threshold=${thresholdTokens}+${CONTEXT_WINDOW_DELTA})`);
    return {
      ok: true,
      ownerId,
      modelId,
      contextWindow: targetCtx,
      owners,
      backup,
      configPath: cfgPath,
      lockPath,
    };
  } catch (err) {
    // 绝不打断调用方（CLI 由外层决定 exit code）
    return fail('unexpected', `applyOverride 未预期异常：${err.stack || err.message}`);
  }
}

/**
 * 注销 owner（引用计数 −1）。归零时按 backup 还原 config 并删除锁文件。
 * force=true 供手工救援：跳过 owners 匹配，直接走归零还原逻辑。
 */
function releaseOverride(ownerId, { configPath, dataDir, force = false } = {}) {
  try {
    if (!isNonEmptyString(ownerId)) {
      return fail('invalid-args', `ownerId 须为非空字符串，收到 ${JSON.stringify(ownerId ?? null)}`);
    }
    const cfgPath = configPath || defaultConfigPath();
    const lockPath = lockPathOf(dataDir || defaultDataDir());

    // 1. 读引擎配置：revert 同样拒绝在坏 JSON 上动手（防把「语法坏了」升级成「内容丢了」）
    let cfgRead;
    try {
      cfgRead = readEngineConfig(cfgPath);
    } catch (err) {
      return fail('io', `读取 ${cfgPath} 失败：${err.message}；检查文件权限后重试`);
    }
    if (cfgRead.kind === 'corrupt') {
      return fail(
        'corrupt-config',
        `${cfgPath} 无法解析（${cfgRead.reason}），无法安全还原。原文件未做任何修改；` +
          `请先用编辑器修复 JSON 语法后重试 zsc override revert --owner ${JSON.stringify(ownerId)}`,
      );
    }

    // 2. 读锁
    let lockRead;
    try {
      lockRead = readJsonFile(lockPath);
    } catch (err) {
      return fail('io', `读取锁文件 ${lockPath} 失败：${err.message}`);
    }
    if (lockRead.missing) {
      return fail(
        'no-lock',
        `没有生效中的 override 登记（锁文件不存在），owner "${ownerId}" 无事可还原。` +
          `核对现场可运行 node bin/zsc.js override status`,
      );
    }
    if (lockRead.corrupt) {
      return fail(
        'lock-corrupt',
        `锁文件 ${lockPath} 无法解析，无法判定现存 owners。config 未被改动；` +
          `若确认无在役任务可直接 --force 按 backup 还原（backup 可信时），否则人工核对该文件`,
      );
    }
    const lock = lockRead.value;
    if (lock._zscManaged !== true) {
      return fail(
        'foreign-lock',
        `${lockPath} 缺少 _zscManaged 标记，疑似非本工具创建。未做任何修改；请人工核对`,
      );
    }
    const owners = Array.isArray(lock.owners) ? lock.owners : [];

    // 3.a 归零还原因子
    const performRestore = () => {
      let restoredHere = false;
      if (isValidBackup(lock.backup)) {
        if (cfgRead.kind === 'ok') {
          restoreInPlace(cfgRead.value, lock.backup);
          // 崩溃安全次序：config 先落盘再删锁（文件头注释）
          writeJsonAtomic(cfgPath, cfgRead.value);
          restoredHere = true;
        } else if (cfgRead.kind === 'missing' && lock.backup.hadEntry) {
          // config 都没了没法还原出原文；按「无痕保底」仅清登记，差异留警告
          logError(`[override] revert 时发现 ${cfgPath} 不存在而 backup.hadEntry=true，` +
            '无法还原原文件内容，仅清除登记');
        }
      } else if (cfgRead.kind === 'missing') {
        // 无处落地也无凭证 → 纯清登记
      } else {
        return { needsReview: true };
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          return { unlinkFailed: err.message };
        }
      }
      return { restoredHere, needsReview: false };
    };

    if (force) {
      // 手工救援通道：无视 owners 直接归零还原。backup 缺失时不碰 config（无据可依）
      if (!isValidBackup(lock.backup)) {
        if (cfgRead.kind === 'missing') {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // 忽略
          }
          log(`[override] force revert：锁与目标 config 均无可还原内容，已删除残留锁`);
          return { ok: true, forced: true, released: false, restored: false, ownersLeft: [] };
        }
        return fail(
          'residue-needs-review',
          `--force 要求锁内 backup 可信以确定还原值，但 ${lockPath} 中 backup 缺失或损坏。` +
            'config 未被改动；请打开 config 人工核对 modelCatalog.overrides 后手工修复',
        );
      }
      let outcome;
      try {
        outcome = performRestore();
      } catch (err) {
        return fail('io', `写回 ${cfgPath} 失败：${err.message}`);
      }
      if (outcome.needsReview || outcome.unlinkFailed) {
        return fail(outcome.needsReview ? 'residue-needs-review' : 'io',
          outcome.needsReview
            ? `${cfgPath} 不可读，无法安全还原；请人工核对`
            : `还原已写回但删除锁文件失败：${outcome.unlinkFailed}；请手工删除 ${lockPath}`);
      }
      log(`[override] force revert ok（owners 强制清零，剩余 []）`);
      return { ok: true, forced: true, released: false, restored: outcome.restoredHere, ownersLeft: [] };
    }

    // 3.b 正常注销：owners 移除该 id；不存在给可操作错误并列出现存者
    const remaining = owners.filter((o) => !(o && o.ownerId === ownerId));
    if (remaining.length === owners.length) {
      const knownIds = owners.map((o) => (o && o.ownerId) || '(损坏条目)');
      return fail(
        'unknown-owner',
        `owner ${JSON.stringify(ownerId)} 未在登记列表中（现存: ` +
          `${knownIds.length > 0 ? knownIds.join(', ') : '(空)'}）。` +
          `换用正确的 ownerId，或确属救援场景时加 --force`,
      );
    }

    if (remaining.length > 0) {
      // 引用计数未归零：不动 config，只更新登记
      try {
        writeJsonAtomic(lockPath, { ...lock, owners: remaining, updatedAt: Date.now() });
      } catch (err) {
        return fail('io', `更新锁文件 ${lockPath} 失败：${err.message}`);
      }
      log(`[override] release owner="${ownerId}" refcount→${remaining.length}，config 保持 override`);
      return {
        ok: true,
        released: true,
        restored: false,
        ownersLeft: remaining.map((o) => o.ownerId),
        configPath: cfgPath,
        lockPath,
      };
    }

    // 引用计数归零：此刻才动 config
    let outcome;
    try {
      outcome = performRestore();
    } catch (err) {
      return fail('io', `写回 ${cfgPath} 失败：${err.message}`);
    }
    if (outcome.needsReview) {
      return fail(
        'residue-needs-review',
        `锁内 backup 不可信且 ${cfgPath} 存在，不敢据以还原。config 与锁均未改动；` +
          `请运行 node bin/zsc.js override status 核对后人工处理`,
      );
    }
    if (outcome.unlinkFailed) {
      return fail(
        'io',
        `还原已写回 ${cfgPath} 但删除锁文件失败：${outcome.unlinkFailed}。` +
          `请手工删除 ${lockPath}，避免下次 apply 触发重复清理`,
      );
    }
    log(`[override] release owner="${ownerId}" refcount→0，` +
      `config 还原（restored=${outcome.restoredHere}）并删除锁`);
    return {
      ok: true,
      released: true,
      restored: outcome.restoredHere,
      ownersLeft: [],
      configPath: cfgPath,
      lockPath,
    };
  } catch (err) {
    return fail('unexpected', `releaseOverride 未预期异常：${err.stack || err.message}`);
  }
}

/**
 * 只读观测：当前 override 登记与 config 现场的对账结果。
 * configHasOverride=true 表示 config 中仍有我们写出的 override 值在场（与还原态不符）；
 * null 表示无法判定（锁损坏或 backup 缺失）。residue=true = 有锁/override 迹象但 owners 空。
 */
function statusOverride({ configPath, dataDir } = {}) {
  try {
    const cfgPath = configPath || defaultConfigPath();
    const lockPath = lockPathOf(dataDir || defaultDataDir());

    let cfgRead;
    try {
      cfgRead = readEngineConfig(cfgPath);
    } catch (err) {
      return fail('io', `读取 ${cfgPath} 失败：${err.message}`);
    }
    let lockRead;
    try {
      lockRead = readJsonFile(lockPath);
    } catch (err) {
      return fail('io', `读取锁文件 ${lockPath} 失败：${err.message}`);
    }

    const base = {
      configPath: cfgPath,
      lockPath,
      configReadable: cfgRead.kind !== 'corrupt',
    };

    if (lockRead.corrupt) {
      // 锁损坏也要给出尽可能多的诊断信息而不是整个失败
      logError(`[override] status 发现锁文件损坏：${lockPath}`);
      return {
        ...base,
        ok: true,
        lockExists: true,
        lockReadable: false,
        owners: [],
        backup: null,
        configHasOverride: null,
        residue: true,
      };
    }
    const lock = lockRead.ok ? lockRead.value : null;
    if (lock === null || lock._zscManaged !== true) {
      return {
        ...base,
        ok: true,
        lockExists: false,
        lockReadable: true,
        owners: [],
        backup: null,
        configHasOverride: false,
        residue: false,
        foreignLockFile: lock !== null,
      };
    }

    const owners = Array.isArray(lock.owners) ? lock.owners.filter(isPlainObject) : [];
    const validBackup = isValidBackup(lock.backup);
    const presence = detectOverridePresence(cfgRead, validBackup ? lock.backup.modelId : '', lock.backup);
    return {
      ...base,
      ok: true,
      lockExists: true,
      lockReadable: true,
      owners,
      backup: lock.backup ?? null,
      configHasOverride: presence,
      residue: owners.length === 0,
    };
  } catch (err) {
    return fail('unexpected', `statusOverride 未预期异常：${err.stack || err.message}`);
  }
}

/**
 * 启动残留自愈：只处理 owners 为空的确定残留（release 写回 config 与删锁之间崩溃的半途态）。
 * - owners>0：正常在役，不碰（pid 探活已裁定不做，理由见文件头注释 2）
 * - owners=0 且 backup 可信：按 backup 还原 + 删锁
 * - owners=0 但 backup 缺失/损坏：不动 config 只告警留人审——无据可依的还原就是在赌，
 *   宁可留下现场让人看（这条边界是裁定过的简化，勿改回「按特征猜测清理」）
 * - 锁不存在：clean。锁丢了但 override 可能残留的场景无线索定位（反推哪个 model 是我们写的
 *   特征不可靠），同样交人工，这里不做猜测式扫描。
 */
function healResidue({ configPath, dataDir } = {}) {
  try {
    const cfgPath = configPath || defaultConfigPath();
    const lockPath = lockPathOf(dataDir || defaultDataDir());

    let lockRead;
    try {
      lockRead = readJsonFile(lockPath);
    } catch (err) {
      return fail('io', `读取锁文件 ${lockPath} 失败：${err.message}`);
    }
    if (lockRead.missing) {
      return { ok: true, healed: false, removedLock: false, reason: 'clean' };
    }
    if (lockRead.corrupt) {
      return fail(
        'lock-corrupt',
        `锁文件 ${lockPath} 无法解析，无法判定是否残留。未做任何修改；请人工核对该文件`,
      );
    }
    const lock = lockRead.value;
    if (lock._zscManaged !== true) {
      logError(`[override] heal 跳过非本工具创建的锁文件：${lockPath}`);
      return { ok: true, healed: false, removedLock: false, reason: 'foreign-lock' };
    }
    const owners = Array.isArray(lock.owners) ? lock.owners : [];
    if (owners.length > 0) {
      return {
        ok: true,
        healed: false,
        removedLock: false,
        reason: 'active',
        owners: owners.map((o) => o.ownerId),
      };
    }

    // 到这里 = owners 为空的确定残留
    if (!isValidBackup(lock.backup)) {
      // 取舍（文件头注释 2/边界声明）：backup 缺失时不删 config——没依据的删除是最危险的
      // 「聪明」，日志明确警告留给人工审查；锁也保留，它此刻是唯一的现场线索
      const warn =
        `检测到 owners 为空的残留锁但其 backup 缺失或损坏（${lockPath}）。` +
        `config 未被改动；请人工核对 ${cfgPath} 的 modelCatalog.overrides 后手工处置`;
      logError(`[override] heal: ${warn}`);
      return { ok: true, healed: false, removedLock: false, reason: 'needs-review', warning: warn };
    }

    let cfgRead;
    try {
      cfgRead = readEngineConfig(cfgPath);
    } catch (err) {
      return fail('io', `读取 ${cfgPath} 失败：${err.message}`);
    }
    if (cfgRead.kind === 'corrupt') {
      const msg =
        `残留还原中止：${cfgPath} 无法解析（坏 JSON）。两者均未改动；` +
        `请先修复该文件语法，修复后重新跑 heal 或用 override status 核对`;
      logError(`[override] heal: ${msg}`);
      return { ok: false, code: 'corrupt-config', message: msg };
    }
    if (cfgRead.kind === 'missing' && lock.backup.hadEntry) {
      // 原文都没了谈不上还原；保持缺失态，仅清登记并警告差异
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ENOENT 即目标达成
      }
      const warn = `config（${cfgPath}）已不存在而 backup.hadEntry=true，无法还原原文件内容，已清除登记`;
      logError(`[override] heal: ${warn}`);
      return { ok: true, healed: true, removedLock: true, reason: 'config-missing', warning: warn };
    }

    let wrote = false;
    if (cfgRead.kind === 'ok') {
      restoreInPlace(cfgRead.value, lock.backup);
      // 崩溃安全：config 先落盘再删锁（与 revert 同一纪律）
      writeJsonAtomic(cfgPath, cfgRead.value);
      wrote = true;
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        return fail('io', `残留已还原但删除锁文件失败：${err.message}；请手工删除 ${lockPath}`);
      }
    }
    log(`[override] heal 完成：owners 空残留已还原（configWritten=${wrote}，` +
      `model=${lock.backup.modelId}）`);
    return { ok: true, healed: true, removedLock: true, configWritten: wrote, reason: 'restored' };
  } catch (err) {
    return fail('unexpected', `healResidue 未预期异常：${err.stack || err.message}`);
  }
}

module.exports = {
  CONTEXT_WINDOW_DELTA,
  applyOverride,
  releaseOverride,
  statusOverride,
  healResidue,
};
