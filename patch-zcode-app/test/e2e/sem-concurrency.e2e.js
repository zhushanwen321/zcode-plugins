'use strict';

/**
 * T2 实机探针:真实 entry.js 模块 + 真实并发驱动,验证 provider 并发上限与 FIFO。
 * 输出标记行供 acceptance gate 判定:peak=<N> / fifo=ok / failopen=ok
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const entryPath = path.join(__dirname, '..', '..', 'zsem', 'entry.js');
delete require.cache[require.resolve(entryPath)];
const entry = require(entryPath);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsem-t2-'));
const configPath = path.join(dir, 'config.json');
const logPath = path.join(dir, 'log.jsonl');
const PROVIDER = 'account:bigmodel-individual-coding-plan';
fs.writeFileSync(configPath, JSON.stringify({ providers: { [PROVIDER]: { limit: 10 } } }), 'utf8');
entry.__forTest.overrides.configPath = configPath;
entry.__forTest.overrides.logPath = logPath;

function payload(id, hold) {
  return {
    model: { providerId: PROVIDER, modelId: 'GLM-5.3' },
    onQueued: undefined,
    onAdmitted: undefined,
    admission: { tryAcquire: () => undefined, acquire: async () => ({ release() {} }) },
    __id: id,
    __hold: hold,
  };
}

async function main() {
  // 12 个并发 admit,每个持有 80ms:峰值应恰为 10,后 2 个排队
  let active = 0;
  let peak = 0;
  const grantOrder = [];
  const tasks = [];
  for (let i = 0; i < 12; i++) {
    tasks.push(
      (async (id) => {
        const r = await entry.admit(payload(id));
        active += 1;
        peak = Math.max(peak, active);
        grantOrder.push(id);
        await new Promise((res) => setTimeout(res, 80));
        r.release();
        active -= 1;
      })(i),
    );
  }
  await Promise.all(tasks);

  const fifoOk = grantOrder.slice(0, 10).every((v) => v < 10) && grantOrder.slice(10).every((v) => v >= 10);

  // failopen:config 指向不存在路径 → undefined(走原生)
  entry.__forTest.overrides.configPath = path.join(dir, 'missing.json');
  entry.__forTest.resetCache();
  const failopen = await entry.admit(payload(99));

  console.log(`peak=${peak}`);
  console.log(`fifo=${fifoOk ? 'ok' : 'FAIL'}`);
  console.log(`failopen=${failopen === undefined ? 'ok' : 'FAIL'}`);
  const events = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
  const grants = events.filter((t) => t === 'grant').length;
  const releases = events.filter((t) => t === 'release').length;
  console.log(`events=grants:${grants} releases:${releases}`);

  fs.rmSync(dir, { recursive: true, force: true });
  const ok = peak === 10 && fifoOk && failopen === undefined && grants === 12 && releases === 12;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
