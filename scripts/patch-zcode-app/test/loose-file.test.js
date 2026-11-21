'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'patch-zcode-app.js');

/** 合成一个最小 loose 目标文件(真实 zcode.cjs 的准入函数形态,见 test/provider-sem.test.js) */
function synthZcodeCjs() {
  return (
    '"use strict";' +
    'async function Kyt(e){if(e.admission===void 0)return nba;let n=e.admission.tryAcquire({model:e.model});if(n===void 0){n=await e.admission.acquire({model:e.model})}return{ticket:n,release(){n.release()}}}' +
    'var nba;r(Kyt,"admitAttempt");function main(){return 0}void main;'
  );
}

/** 合成 mini app 目录(Resources 下含 glm/zcode.cjs 与 Info.plist) */
function buildApp(version = '9.9.9') {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'zsem-app-'));
  const res = path.join(app, 'Contents', 'Resources');
  fs.mkdirSync(path.join(res, 'glm'), { recursive: true });
  fs.writeFileSync(path.join(res, 'glm', 'zcode.cjs'), synthZcodeCjs(), 'utf8');
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.writeFileSync(
    path.join(app, 'Contents', 'Info.plist'),
    `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
    'utf8',
  );
  // asar 不存在也行?cmdApply 要求 app.asar 存在——放一个空文件占位(asar 补丁集为空时不读它)
  fs.writeFileSync(path.join(res, 'app.asar'), '', 'utf8');
  return app;
}

function run(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
}

test('loose apply → 幂等 → restore → 升级重采纳 闭环', () => {
  const app = buildApp('1.0.0');
  const res = path.join(app, 'Contents', 'Resources');
  const zc = path.join(res, 'glm', 'zcode.cjs');

  // apply(只打 provider-sem;asar patches 为空集走不到 asar 分支?空 asar 文件读 header 会炸,跳过)
  const out1 = run(['apply', '--app', app, '--patch', 'provider-sem']);
  assert.match(out1, /apply provider-sem: 已写入/);
  assert.ok(fs.readFileSync(zc, 'utf8').includes('globalThis.__ZSEM__'), '注入标记存在');
  assert.ok(fs.existsSync(zc + '.bak-zcode-patch-base'), 'loose 基线建立');
  assert.ok(fs.existsSync(zc + '.bak-zcode-patch-base.json'), 'sidecar 建立');

  // 幂等
  const out2 = run(['apply', '--app', app, '--patch', 'provider-sem']);
  assert.match(out2, /skip provider-sem: 已应用/);

  // status
  const st = run(['status', '--app', app]);
  assert.match(st, /\[x\] provider-sem — 已应用/);

  // restore → 无注入
  run(['restore', '--app', app]);
  assert.ok(!fs.readFileSync(zc, 'utf8').includes('globalThis.__ZSEM__'), 'restore 后无注入');
  const st2 = run(['status', '--app', app]);
  assert.match(st2, /\[ \] provider-sem — 未应用/);

  // 升级模拟:直接换新版本文件(无痕迹)+ bump Info.plist → apply 自动重采纳新基线再打
  fs.writeFileSync(zc, synthZcodeCjs().replace('return{ticket:n', 'return{ticket:n '), 'utf8');
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>2.0.0</string></dict></plist>', 'utf8');
  const out3 = run(['apply', '--app', app, '--patch', 'provider-sem']);
  assert.match(out3, /采纳为新基线/);
  assert.match(out3, /apply provider-sem: 已写入/);
  const sidecar = JSON.parse(fs.readFileSync(zc + '.bak-zcode-patch-base.json', 'utf8'));
  assert.equal(sidecar.appVersion, '2.0.0', '基线版本重采纳');

  fs.rmSync(app, { recursive: true, force: true });
});

test('loose 基线版本不一致且在线有痕迹 → 拒绝并给恢复动作', () => {
  const app = buildApp('1.0.0');
  run(['apply', '--app', app, '--patch', 'provider-sem']);
  // 模拟:升级了版本号但在线文件仍带注入(非正常态)
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>2.0.0</string></dict></plist>', 'utf8');
  let threw = null;
  try {
    run(['apply', '--app', app, '--patch', 'provider-sem']);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, '应抛错');
  assert.match(String(threw.stderr || threw.message), /拒绝自动重置基线|已含补丁痕迹/);
  fs.rmSync(app, { recursive: true, force: true });
});

test('install 幂等 + 链路校验(HOME 隔离)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zsem-home-'));
  fs.mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
  const env = { ...process.env, HOME: home };
  const out1 = execFileSync('node', [CLI, 'install'], { encoding: 'utf8', env });
  assert.match(out1, /已创建/);
  const link = path.join(home, '.zcode', 'cli', 'zsem');
  assert.ok(fs.readlinkSync(link), 'symlink 存在');
  const out2 = execFileSync('node', [CLI, 'install'], { encoding: 'utf8', env });
  assert.match(out2, /已存在且指向正确/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('apply 并发防护:读取后目标被替换 → 拒绝覆盖(变异验证)', () => {
  const app = buildApp('1.0.0');
  const zc = path.join(app, 'Contents', 'Resources', 'glm', 'zcode.cjs');
  // 用 --require 钩子在 apply 首次写 stage 时替换 live(确定性时点注入)
  const hook = path.join(app, 'hook.js');
  fs.writeFileSync(hook, `
const fs=require('node:fs');
const origOpen=fs.openSync.bind(fs);
fs.openSync=(f,...a)=>{
  if(String(f).includes('patch-stage')){ // stage 已写入、fsync open 时:替换 live 模拟并发写者
    const live=String(f).replace(/\\.patch-stage-\\d+$/, '').replace(/\\/\\.([^/]+)$/, '/$1');
    fs.writeFileSync(live, 'CONCURRENT-NEW-VERSION', 'utf8');
    fs.rmSync(__filename,{force:true});
  }
  return origOpen(f,...a);
};`, 'utf8');
  let threw = null;
  try {
    execFileSync('node', ['--require', hook, CLI, 'apply', '--app', app, '--patch', 'provider-sem'], { encoding: 'utf8' });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, '应报错');
  assert.match(String(threw.stderr), /并发修改|拒绝覆盖/);
  assert.equal(fs.readFileSync(zc, 'utf8'), 'CONCURRENT-NEW-VERSION', '并发新版本未被旧快照覆盖');
  fs.rmSync(app, { recursive: true, force: true });
});

test('restore 先全校验:loose 版本不一致时 asar 不被回滚(变异验证,合成双目标)', () => {
  const app = buildApp('1.0.0');
  // asar 侧放一个合法基线(空流程:直接手工构造基线文件)
  const res = path.join(app, 'Contents', 'Resources');
  const basePath = path.join(res, 'app.asar.bak-zcode-patch-base');
  fs.writeFileSync(basePath, 'asar-baseline', 'utf8');
  fs.writeFileSync(basePath + '.json', JSON.stringify({ appVersion: '1.0.0', sha256: null }), 'utf8');
  // loose 侧:apply 建基线后,模拟升级使 loose 基线版本过期
  run(['apply', '--app', app, '--patch', 'provider-sem']);
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>2.0.0</string></dict></plist>', 'utf8');
  let threw = null;
  try {
    run(['restore', '--app', app]);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'loose 版本不一致应整体拒绝');
  assert.equal(fs.readFileSync(path.join(res, 'app.asar'), 'utf8'), '', 'asar 未被回滚(先校验后写入)');
  fs.rmSync(app, { recursive: true, force: true });
});

test('sidecar 缺失自愈:删 sidecar 后 apply 不再要求人工清理(变异验证)', () => {
  const app = buildApp('1.0.0');
  const zc = path.join(app, 'Contents', 'Resources', 'glm', 'zcode.cjs');
  run(['apply', '--app', app, '--patch', 'provider-sem']);
  fs.rmSync(zc + '.bak-zcode-patch-base.json');
  const out = run(['apply', '--app', app, '--patch', 'provider-sem']);
  assert.match(out, /skip provider-sem: 已应用|自愈重建/);
  assert.ok(fs.existsSync(zc + '.bak-zcode-patch-base.json'), 'sidecar 已重建');
  fs.rmSync(app, { recursive: true, force: true });
});
