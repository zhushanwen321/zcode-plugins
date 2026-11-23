'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ZQW_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zqw-detect-'));
const detect = require('../lib/detect');

test('sanitizeSessionId：安全字符保留，异常形态降级', () => {
  assert.strictEqual(detect.sanitizeSessionId('sess_1c0c1986-9f8d-4422'), 'sess_1c0c1986-9f8d-4422');
  assert.strictEqual(detect.sanitizeSessionId('a/b\\c'), 'a_b_c');
  assert.strictEqual(detect.sanitizeSessionId(''), 'default');
  assert.strictEqual(detect.sanitizeSessionId(null), 'default');
});

test('isGlmPlan：GLM 系 + account: 套餐 provider 才放行', () => {
  assert.strictEqual(detect.isGlmPlan({ modelId: 'GLM-5.3', providerId: 'account:bigmodel-individual-coding-plan' }), true);
  assert.strictEqual(detect.isGlmPlan({ modelId: 'GLM-5.3-Flash', providerId: 'account:bigmodel-team-coding-plan' }), true);
  // 自配 API key 形态（builtin:）按 token 计费，无 5h 窗口
  assert.strictEqual(detect.isGlmPlan({ modelId: 'GLM-5.3', providerId: 'builtin:bigmodel-coding-plan' }), false);
  assert.strictEqual(detect.isGlmPlan({ modelId: 'k3.1-pro', providerId: 'kimi-for-coding' }), false);
  assert.strictEqual(detect.isGlmPlan({ modelId: 'GLM-5.3', providerId: null }), false);
  assert.strictEqual(detect.isGlmPlan(null), false);
});

test('querySessionModel：最近带 modelId 的消息行胜出，user 行跳过', () => {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(process.env.ZQW_DATA_DIR, 't.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null)");
  const insert = (t, data) => db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
    .run('m' + t, 's1', t, t, JSON.stringify(data));
  insert(1, { modelId: 'GLM-4.7', providerId: 'account:old' });
  insert(2, { role: 'user', text: 'hi' });
  insert(3, { modelId: 'GLM-5.3', providerId: 'account:bigmodel-individual-coding-plan' });
  db.close();
  assert.deepStrictEqual(
    detect.querySessionModel(dbPath, 's1', DatabaseSync),
    { modelId: 'GLM-5.3', providerId: 'account:bigmodel-individual-coding-plan' },
  );
  assert.strictEqual(detect.querySessionModel(dbPath, 'no-such-session', DatabaseSync), null);
  assert.strictEqual(detect.querySessionModel(dbPath + '.missing', 's1', DatabaseSync), null);
});

test('fallbackModelFromConfig：model.main 的 provider/model 拆分', () => {
  const dir = process.env.ZQW_DATA_DIR;
  const p = (obj) => {
    const file = path.join(dir, 'config-' + Math.random().toString(36).slice(2) + '.json');
    fs.writeFileSync(file, JSON.stringify(obj));
    return file;
  };
  assert.deepStrictEqual(
    detect.fallbackModelFromConfig(p({ model: { main: 'account:bigmodel-individual-coding-plan/GLM-5.3' } })),
    { modelId: 'GLM-5.3', providerId: 'account:bigmodel-individual-coding-plan' },
  );
  assert.deepStrictEqual(
    detect.fallbackModelFromConfig(p({ model: { main: 'GLM-5.3-Flash' } })),
    { modelId: 'GLM-5.3-Flash', providerId: null },
  );
  assert.strictEqual(detect.fallbackModelFromConfig(p({})), null);
  assert.strictEqual(detect.fallbackModelFromConfig(path.join(dir, 'no-such.json')), null);
});

test('hasActiveWatch：按 node 本体 + --session 标记精确归属，排除文本撞串', () => {
  const mine = 'node /x/z-quota-watch/bin/zqw-watch.js --session sess_a --agent zcode --provider account:p1';
  const other = 'node /x/z-quota-watch/bin/zqw-watch.js --session sess_b --agent zcode --provider account:p1';
  const bare = 'node /root/.agents/skills/quota-wait/scripts/quota-wait.mjs --agent zcode --provider account:p1';
  // shell 进程命令行文本里恰好含两个标记，但不是 node 本体 → 不算
  const shell = '/bin/zsh -c node /x/zqw-watch.js --session sess_a --provider account:p1; echo done';
  assert.strictEqual(detect.hasActiveWatch([mine], 'sess_a'), true);
  assert.strictEqual(detect.hasActiveWatch([other], 'sess_a'), false);
  assert.strictEqual(detect.hasActiveWatch([shell], 'sess_a'), false);
  // skill 裸起的 quota-wait 进程不属于本会话（无双标记）
  assert.strictEqual(detect.hasActiveWatch([bare], 'sess_a'), false);
  assert.strictEqual(detect.hasActiveWatch([], 'sess_a'), false);
});

test('hasActiveWatch：引擎双 id 形态（中段差一位、尾部一致）跨形态认领', () => {
  // 2026-11-23 实测事故形态：起守望时 argv 落短形 id，hook 检测时 env 是长形 id
  const shortId = 'sess_789381d-8c7f-4327-840d-3975a83681af';
  const longId = 'sess_7893816d-8c7f-4327-840d-3975a83681af';
  const line = `node /cache/z-quota-watch/0.1.0/bin/zqw-watch.js --session ${shortId} --agent zcode --provider account:p`;
  assert.strictEqual(detect.hasActiveWatch([line], longId), true);
  assert.strictEqual(detect.hasActiveWatch([line], shortId), true);
  // 尾段不同（高熵段差异）的其他会话不误认领
  const stranger = 'sess_00000000-1111-2222-3333-3975a83681af';
  assert.strictEqual(detect.hasActiveWatch([line], stranger), false);
  // id 过短（不足尾段长度）只走精确相等，不做尾段比对
  assert.strictEqual(detect.sameSessionTail('short-a', 'short-a'), false);
});

test('isSuppressed / inFailureCooldown：抑制与冷却判定', () => {
  const stateDir = path.join(process.env.ZQW_DATA_DIR, 'state');
  const key = 'sess_c';
  const dir = path.join(stateDir, key);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  assert.strictEqual(detect.isSuppressed(stateDir, key, now), false);
  assert.strictEqual(detect.inFailureCooldown(stateDir, key, now), false);
  fs.writeFileSync(path.join(dir, 'suppress-until.json'), JSON.stringify({ untilMs: now + 3600_000 }));
  assert.strictEqual(detect.isSuppressed(stateDir, key, now), true);
  assert.strictEqual(detect.isSuppressed(stateDir, key, now + 7200_000), false);
  // 失败结果在冷却期内拦截，正常退出不拦截；被信号杀（主动终止）不拦截
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ exitCode: 3, finishedAtMs: now - 60_000 }));
  assert.strictEqual(detect.inFailureCooldown(stateDir, key, now), true);
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ exitCode: 0, finishedAtMs: now - 60_000 }));
  assert.strictEqual(detect.inFailureCooldown(stateDir, key, now), false);
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ exitCode: null, killed: true, finishedAtMs: now - 60_000 }));
  assert.strictEqual(detect.inFailureCooldown(stateDir, key, now), false);
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ exitCode: 3, finishedAtMs: now - 11 * 60_000 }));
  assert.strictEqual(detect.inFailureCooldown(stateDir, key, now), false);
});

test('inFailureCooldown：result 落在双 id 形态的另一目录时按尾段兜底', () => {
  const stateDir = path.join(process.env.ZQW_DATA_DIR, 'state-dual');
  // wrapper 按 argv 短形 id 落 result.json，hook 按 env 长形 id 查
  const argvDir = path.join(stateDir, 'sess_789381d-8c7f-4327-840d-3975a83681af');
  fs.mkdirSync(argvDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(argvDir, 'result.json'), JSON.stringify({ exitCode: 3, finishedAtMs: now - 60_000 }));
  const envKey = 'sess_7893816d-8c7f-4327-840d-3975a83681af';
  assert.strictEqual(detect.inFailureCooldown(stateDir, envKey, now), true);
  // 正常退出的 result 同样能被兜底读到 → 不拦截
  fs.writeFileSync(path.join(argvDir, 'result.json'), JSON.stringify({ exitCode: 0, finishedAtMs: now - 60_000 }));
  assert.strictEqual(detect.inFailureCooldown(stateDir, envKey, now), false);
  // 无任何同会话目录 → 不拦截
  assert.strictEqual(detect.inFailureCooldown(stateDir, 'sess_ffffffff-0000-0000-0000-000000000000', now), false);
});
