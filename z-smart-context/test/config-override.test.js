'use strict';

// lib/config-override.js 单测。隔离纪律（红线）：引擎配置与插件数据目录一律指向本进程
// mkdtemp 出来的 tmp 目录并显式传入 configPath/dataDir，绝不触达用户真实 home 下的同名文件；
// 用例结束后 rmSync 清理全部现场。
// 注意变量命名：凡引用引擎配置文件名的行均伴随 tmp 字样的路径变量（供静态审查脚本核验）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CONTEXT_WINDOW_DELTA,
  applyOverride,
  releaseOverride,
  statusOverride,
  healResidue,
} = require('../lib/config-override');

// lib/config-override.js 内部诊断走 lib/log，落盘路径跟随 ZSC_DATA_DIR（生产不设即真实 home）。
// 本文件纯进程内调用、无 spawn 可注入 env，必须在加载用例前整体重定向到本文件独占 tmp，
// 否则每条 [override] 日志都会漏写进用户真实 hook.log（第一批集成验证实测）。
const TEST_LOG_DIR = makeTmpDir('zsc-ovr-log-');
process.env.ZSC_DATA_DIR = TEST_LOG_DIR;
process.on('exit', () => {
  try {
    fs.rmSync(TEST_LOG_DIR, { recursive: true, force: true });
  } catch {
    // 清理失败只留 tmp 垃圾，不影响测试结论
  }
});

function makeTmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// 场景工厂：tmp 引擎配置目录（内放全新配置文件）+ tmp 插件数据目录（装 override 锁）
function makeFixture(initialEngine) {
  const tmpCfgDir = makeTmpDir('zsc-ovr-cfg-');
  const tmpDataDir = makeTmpDir('zsc-ovr-data-');
  const engineConfigPath = path.join(tmpCfgDir, 'config.json');
  if (initialEngine !== undefined) {
    fs.writeFileSync(
      engineConfigPath,
      typeof initialEngine === 'string' ? initialEngine : `${JSON.stringify(initialEngine, null, 2)}\n`,
    );
  }
  return { tmpCfgDir, tmpDataDir, engineConfigPath, lockPath: path.join(tmpDataDir, 'override-lock.json') };
}

function cleanupFixture(fx) {
  fs.rmSync(fx.tmpCfgDir, { recursive: true, force: true });
  fs.rmSync(fx.tmpDataDir, { recursive: true, force: true });
}

function readEngineJson(fx) {
  return JSON.parse(fs.readFileSync(fx.engineConfigPath, 'utf8'));
}

function readLockJson(fx) {
  return JSON.parse(fs.readFileSync(fx.lockPath, 'utf8'));
}

// ---- apply 基础面 ----

test('apply: 首次写入 contextWindow=threshold+34000，backup.hadEntry=false，顶层无关键保真', () => {
  const fx = makeFixture({ plugins: { dirs: ['/some/dir'] }, otherTopLevel: 42 });
  try {
    const r = applyOverride({
      modelId: 'glm-5.2',
      thresholdTokens: 200000,
      ownerId: 'task-a1',
      configPath: fx.engineConfigPath,
      dataDir: fx.tmpDataDir,
    });
    assert.equal(r.ok, true, r.message || '');
    assert.equal(r.contextWindow, 200000 + CONTEXT_WINDOW_DELTA);
    assert.equal(typeof r.contextWindow, 'number');

    const engine = readEngineJson(fx);
    // 写对的键
    assert.equal(engine.modelCatalog.overrides['glm-5.2'].contextWindow, 234000);
    // 用户的顶层键原封不动
    assert.deepEqual(engine.plugins, { dirs: ['/some/dir'] });
    assert.equal(engine.otherTopLevel, 42);
    assert.equal(engine.plugins.dirs.length, 1);

    const lock = readLockJson(fx);
    assert.equal(lock._zscManaged, true);
    assert.equal(lock.owners.length, 1);
    assert.equal(lock.owners[0].ownerId, 'task-a1');
    assert.equal(lock.owners[0].pid, process.pid);
    assert.equal(typeof lock.owners[0].ts, 'number');
    assert.deepEqual(lock.backup, {
      modelId: 'glm-5.2',
      hadEntry: false,
      prevContextWindow: null,
      hadContextWindowKey: false,
      ownedContainers: ['modelCatalog', 'overrides'], // 两个容器都是本次代建
    });
  } finally {
    cleanupFixture(fx);
  }
});

test('apply: 同 model 已有其他字段、其他 model 条目时只动目标叶子', () => {
  const fx = makeFixture({
    modelCatalog: {
      overrides: {
        'glm-5.2': { contextWindow: 128000, style: 'keep-me' },
        'other-model': { contextWindow: 999999 },
      },
    },
  });
  try {
    const r = applyOverride({
      modelId: 'glm-5.2',
      thresholdTokens: 50000,
      ownerId: 'o1',
      configPath: fx.engineConfigPath,
      dataDir: fx.tmpDataDir,
    });
    assert.equal(r.ok, true, r.message || '');
    const engine = readEngineJson(fx);
    assert.equal(engine.modelCatalog.overrides['glm-5.2'].contextWindow, 84000); // 50000+34000
    assert.equal(engine.modelCatalog.overrides['glm-5.2'].style, 'keep-me'); // 同模型其他字段保真
    assert.equal(engine.modelCatalog.overrides['other-model'].contextWindow, 999999); // 其他条目保真
    assert.deepEqual(readLockJson(fx).backup, { modelId: 'glm-5.2', hadEntry: true, prevContextWindow: 128000, hadContextWindowKey: true, ownedContainers: [] });
  } finally {
    cleanupFixture(fx);
  }
});

test('apply: 幂等——同 owner 重复申请不改 owners 数量也不二次包装数值', () => {
  const fx = makeFixture({});
  try {
    const first = applyOverride({ modelId: 'm1', thresholdTokens: 100000, ownerId: 'dup-o', configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    assert.equal(first.ok, true);
    const second = applyOverride({ modelId: 'm1', thresholdTokens: 100000, ownerId: 'dup-o', configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyOwner, true);
    assert.equal(second.contextWindow, 134000);
    assert.equal(readLockJson(fx).owners.length, 1);
    assert.equal(readEngineJson(fx).modelCatalog.overrides.m1.contextWindow, 134000);
  } finally {
    cleanupFixture(fx);
  }
});

test('apply: 参数校验——非正 threshold、空 ownerId/modelId 一律拒绝且无任何文件副作用', () => {
  for (const bad of [
    { thresholdTokens: 0 },
    { thresholdTokens: -5 },
    { thresholdTokens: Number.NaN },
    { thresholdTokens: Infinity },
  ]) {
    const fx = makeFixture({});
    try {
      const r = applyOverride({
        modelId: 'm1',
        ...bad,
        ownerId: 'o',
        configPath: fx.engineConfigPath,
        dataDir: fx.tmpDataDir,
      });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'invalid-args');
    } finally {
      cleanupFixture(fx);
    }
  }
  const fx = makeFixture({});
  try {
    for (const ownerId of ['', '   ', undefined]) {
      const r = applyOverride({ modelId: 'm1', thresholdTokens: 1000, ownerId, configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'invalid-args');
    }
    const rNoModel = applyOverride({ thresholdTokens: 1000, ownerId: 'o', configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    assert.equal(rNoModel.ok, false);
    // 无任何副作用落盘
    assert.equal(fs.existsSync(fx.lockPath), false);
    assert.deepEqual(readEngineJson(fx), {});
  } finally {
    cleanupFixture(fx);
  }
});

test('apply: 在役锁绑定其他 model 时拒绝混叠（单 backup 无法同时服务两个 model）', () => {
  const fx = makeFixture({});
  try {
    assert.equal(applyOverride({ modelId: 'model-a', thresholdTokens: 100000, ownerId: 'oa', configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir }).ok, true);
    const r = applyOverride({ modelId: 'model-b', thresholdTokens: 120000, ownerId: 'ob', configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'model-mismatch');
    assert.match(r.message, /model-a/);
  } finally {
    cleanupFixture(fx);
  }
});

test('apply: 发现 owners 空残留锁先按旧 backup 还原再登记，杜绝备份污染', () => {
  const fx = makeFixture({
    modelCatalog: { overrides: { m1: { contextWindow: 111111, keep: 1 } } },
  });
  try {
    // 模拟「上次还原写盘成功但删锁前崩溃」的半途态
    fs.mkdirSync(fx.tmpDataDir, { recursive: true });
    fs.writeFileSync(fx.lockPath, JSON.stringify({
      _zscManaged: true,
      owners: [],
      backup: { modelId: 'm1', hadEntry: true, prevContextWindow: 111111, hadContextWindowKey: true },
      updatedAt: 1,
    }));
    const r = applyOverride({ modelId: 'm1', thresholdTokens: 90000, ownerId: 'fresh-owner', configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    assert.equal(r.ok, true, r.message || '');
    // 新 backup 必须记录的是真原值 111111，而不是上次 override 后的值
    assert.deepEqual(readLockJson(fx).backup, {
      modelId: 'm1',
      hadEntry: true,
      prevContextWindow: 111111,
      hadContextWindowKey: true,
      ownedContainers: [],
    });
    assert.equal(readEngineJson(fx).modelCatalog.overrides.m1.contextWindow, 124000); // 90000+34000
    assert.equal(readEngineJson(fx).modelCatalog.overrides.m1.keep, 1);

    // 全程走完：最终还原回 111111
    assert.equal(releaseOverride('fresh-owner', { configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir }).restored, true);
    assert.equal(readEngineJson(fx).modelCatalog.overrides.m1.contextWindow, 111111);
  } finally {
    cleanupFixture(fx);
  }
});

// ---- release 面 ----

test('release: 多 owner 叠加 refcount，归零那一刻才真正还原 config 并删锁', () => {
  const fx = makeFixture({ modelCatalog: { overrides: { m9: { contextWindow: 7777, tag: 'u' } } } });
  try {
    assert.equal(applyOverride({ modelId: 'm9', thresholdTokens: 100000, ownerId: 'A', configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir }).ok, true);
    assert.equal(applyOverride({ modelId: 'm9', thresholdTokens: 150000, ownerId: 'B', configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir }).ok, true);

    // 叠加期间 config 是后写的值；第一个 owner 退出时 refcount 未归零，config 必须保持 override
    let engine = readEngineJson(fx);
    assert.equal(engine.modelCatalog.overrides.m9.contextWindow, 184000); // 150000+34000
    const rA = releaseOverride('A', { configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    assert.equal(rA.ok, true);
    assert.equal(rA.released, true);
    assert.equal(rA.restored, false, 'refcount 未归零不得还原');
    assert.deepEqual(rA.ownersLeft, ['B']);
    assert.equal(fs.existsSync(fx.lockPath), true);
    assert.equal(readEngineJson(fx).modelCatalog.overrides.m9.contextWindow, 184000, '仍有在役 owner，不得还原');

    // 最后一个 owner 退出：此刻才还原到最初值
    const rB = releaseOverride('B', { configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    assert.equal(rB.ok, true);
    assert.equal(rB.restored, true);
    engine = readEngineJson(fx);
    assert.equal(engine.modelCatalog.overrides.m9.contextWindow, 7777, '还原为最初原值而非中间值');
    assert.equal(engine.modelCatalog.overrides.m9.tag, 'u');
    assert.equal(fs.existsSync(fx.lockPath), false, '归零后锁文件删除');
  } finally {
    cleanupFixture(fx);
  }
});

test('release: 无用户条目的往返完全等价于删除该键（hadEntry=false 路径）', () => {
  const fx = makeFixture({ topKey: true });
  try {
    applyOverride({ modelId: 'fresh-m', thresholdTokens: 30000, ownerId: 'ox', configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    const during = readEngineJson(fx);
    assert.equal(during.modelCatalog.overrides['fresh-m'].contextWindow, 64000);
    assert.equal(during.topKey, true);
    assert.equal(releaseOverride('ox', { configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir }).restored, true);
    assert.deepEqual(readEngineJson(fx), { topKey: true }, '往返后等于从未写过');
    assert.equal(fs.existsSync(fx.lockPath), false);
  } finally {
    cleanupFixture(fx);
  }
});

test('release: 未知 owner 报错并列出现存 owners（可操作错误）', () => {
  const fx = makeFixture({});
  try {
    applyOverride({ modelId: 'm', thresholdTokens: 10000, ownerId: 'real-a', configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    applyOverride({ modelId: 'm', thresholdTokens: 20000, ownerId: 'real-b', configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    const r = releaseOverride('ghost', { configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unknown-owner');
    assert.match(r.message, /real-a/);
    assert.match(r.message, /real-b/);
    assert.match(r.message, /--force/, '救援出口必须在错误信息里指路');
  } finally {
    cleanupFixture(fx);
  }
});

test('release: --force 跳过 owners 匹配直接按 backup 归零还原（手工救援通道）', () => {
  const fx = makeFixture({});
  try {
    applyOverride({ modelId: 'mf', thresholdTokens: 60000, ownerId: 'dead-owner', configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    // 正常路径对未登记 id 拒绝
    const denied = releaseOverride('someone-else', { configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    assert.equal(denied.ok, false);
    // force 放行
    const forced = releaseOverride('someone-else', { configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir, force: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.forced, true);
    assert.equal(forced.restored, true);
    assert.equal(fs.existsSync(fx.lockPath), false);
    assert.deepEqual(readEngineJson(fx), {});
  } finally {
    cleanupFixture(fx);
  }
});

// ---- 坏 JSON 双拒绝 ----

test('坏 JSON: apply/revert 双双拒绝且原文一字节不动（取舍：绝不覆盖用户坏配置）', () => {
  const brokenText = '{ "modelCatalog": { "overrides": '; // 截断的坏 JSON
  const fx = makeFixture(brokenText);
  try {
    const before = fs.readFileSync(fx.engineConfigPath, 'utf8');

    const rApply = applyOverride({ modelId: 'm', thresholdTokens: 10000, ownerId: 'o', configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    assert.equal(rApply.ok, false);
    assert.equal(rApply.code, 'corrupt-config');
    assert.match(rApply.message, /修复/);
    assert.equal(fs.existsSync(fx.lockPath), false, '拒绝时不得留下半套登记');

    // 修好 → 正常 apply → 再弄坏 → revert 也拒绝
    fs.writeFileSync(fx.engineConfigPath, '{"modelCatalog":{"overrides":{}}}');
    assert.equal(applyOverride({ modelId: 'm', thresholdTokens: 10000, ownerId: 'o', configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir }).ok, true);
    fs.writeFileSync(fx.engineConfigPath, brokenText);
    const beforeRevert = fs.readFileSync(fx.engineConfigPath, 'utf8');
    const rRevert = releaseOverride('o', { configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    assert.equal(rRevert.ok, false);
    assert.equal(rRevert.code, 'corrupt-config');
    assert.equal(fs.readFileSync(fx.engineConfigPath, 'utf8'), beforeRevert, 'revert 拒绝同样不能碰原文');
    assert.equal(fs.existsSync(fx.lockPath), true, '锁保留等待修复后重试');
  } finally {
    cleanupFixture(fx);
  }
});

// ---- status 对账 ----

test('status: 只读输出在役/残留/还原态三种现场，configHasOverride 与 residue 判定正确', () => {
  // 空场
  const fxClean = makeFixture({});
  try {
    const s0 = statusOverride({ configPath: fxClean.engineConfigPath, dataDir: fxClean.tmpDataDir });
    assert.equal(s0.ok, true);
    assert.equal(s0.lockExists, false);
    assert.equal(s0.configHasOverride, false);
    assert.equal(s0.residue, false);
  } finally {
    cleanupFixture(fxClean);
  }

  // 在役
  const fxActive = makeFixture({});
  try {
    applyOverride({ modelId: 'ms', thresholdTokens: 80000, ownerId: 's1', configPath: fxActive.engineConfigPath, dataDir: fxActive.tmpDataDir });
    const s1 = statusOverride({ configPath: fxActive.engineConfigPath, dataDir: fxActive.tmpDataDir });
    assert.equal(s1.lockExists, true);
    assert.deepEqual(s1.owners.map((o) => o.ownerId), ['s1']);
    assert.equal(s1.configHasOverride, true, 'override 值在场');
    assert.equal(s1.residue, false);

    // 归零还原后：在场判定回落
    releaseOverride('s1', { configPath: fxActive.engineConfigPath, dataDir: fxActive.tmpDataDir });
    const s2 = statusOverride({ configPath: fxActive.engineConfigPath, dataDir: fxActive.tmpDataDir });
    assert.equal(s2.lockExists, false);
    assert.equal(s2.configHasOverride, false);
  } finally {
    cleanupFixture(fxActive);
  }
});

// ---- healResidue 自愈 ----

test('heal: owners 空 + 锁在 + override 在场 → 按 backup 还原并删锁', () => {
  const fx = makeFixture({ modelCatalog: { overrides: { hm: { contextWindow: 555555, style: 's' } }, keepOther: 1 }, untouched: [1] });
  try {
    applyOverride({ modelId: 'hm', thresholdTokens: 222222, ownerId: 'crashed', configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    // 模拟崩溃残留：清空 owners（kill -9 后的确定性现场）
    const lock = readLockJson(fx);
    fs.writeFileSync(fx.lockPath, JSON.stringify({ ...lock, owners: [] }));

    const h = healResidue({ configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    assert.equal(h.ok, true);
    assert.equal(h.healed, true);
    assert.equal(h.removedLock, true);
    const engine = readEngineJson(fx);
    assert.equal(engine.modelCatalog.overrides.hm.contextWindow, 555555);
    assert.equal(engine.modelCatalog.overrides.hm.style, 's');
    assert.equal(engine.modelCatalog.keepOther, 1);
    assert.deepEqual(engine.untouched, [1]);
    assert.equal(fs.existsSync(fx.lockPath), false);
    // 二次 heal 空场无事可做
    const h2 = healResidue({ configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    assert.equal(h2.ok, true);
    assert.equal(h2.healed, false);
    assert.equal(h2.reason, 'clean');
  } finally {
    cleanupFixture(fx);
  }
});

test('heal: owners 为空的 backup 缺失残留 → 只告警留人审，config 与锁都不动', () => {
  const fx = makeFixture({ modelCatalog: { overrides: { ghost: { contextWindow: 123456 } } } });
  try {
    fs.writeFileSync(fx.lockPath, JSON.stringify({ _zscManaged: true, owners: [], updatedAt: 1 })); // 无 backup
    const h = healResidue({ configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    assert.equal(h.ok, true);
    assert.equal(h.healed, false);
    assert.equal(h.reason, 'needs-review');
    assert.match(h.warning, /人工|核对|backup/u);
    assert.equal(fs.existsSync(fx.lockPath), true, '锁是唯一现场线索，保留');
    assert.equal(readEngineJson(fx).modelCatalog.overrides.ghost.contextWindow, 123456, '无据可依不得删改 config');
  } finally {
    cleanupFixture(fx);
  }
});

test('heal: 有存活 owner 登记时不做任何事（不做 pid 探活，裁定砍掉）', () => {
  const fx = makeFixture({});
  try {
    applyOverride({ modelId: 'alive', thresholdTokens: 40000, ownerId: 'running-owner', configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    const before = fs.readFileSync(fx.engineConfigPath, 'utf8');
    const h = healResidue({ configPath: fx.engineConfigPath, dataDir: fx.tmpDataDir });
    assert.equal(h.ok, true);
    assert.equal(h.healed, false);
    assert.equal(h.reason, 'active');
    assert.equal(fs.readFileSync(fx.engineConfigPath, 'utf8'), before);
    assert.equal(fs.existsSync(fx.lockPath), true);
  } finally {
    cleanupFixture(fx);
  }
});
