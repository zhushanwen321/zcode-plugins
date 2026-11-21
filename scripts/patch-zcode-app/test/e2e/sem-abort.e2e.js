'use strict';

/**
 * T2c 实机探针:排队中 abort 取消语义。
 * 场景:limit=10,10 个持有者;第 11、12 个排队后被 abort 取消;
 * 断言:①两个等待者以取消语义结束(entry 层 ZsemCancelled:name=AbortError、
 * __zsemCancel 标记);②持有者逐个 release 时名额不被已取消者占用
 * (第 13 个新请求在释放后立即授予,且最终无泄漏:active 归零)。
 * 输出标记:cancelled=2 leak=0
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const entryPath = path.join(__dirname, '..', '..', 'zsem', 'entry.js');
delete require.cache[require.resolve(entryPath)];
const entry = require(entryPath);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsem-t2c-'));
const configPath = path.join(dir, 'config.json');
const logPath = path.join(dir, 'log.jsonl');
const PROVIDER = 'account:abort-test';
fs.writeFileSync(configPath, JSON.stringify({ providers: { [PROVIDER]: { limit: 10 } } }), 'utf8');
entry.__forTest.overrides.configPath = configPath;
entry.__forTest.overrides.logPath = logPath;

function payload(signal) {
  return {
    model: { providerId: PROVIDER, modelId: 'M' },
    signal,
    admission: { tryAcquire: () => undefined, acquire: async () => ({ release() {} }) },
  };
}

async function main() {
  // 10 个持有者
  const holders = [];
  for (let i = 0; i < 10; i++) holders.push(await entry.admit(payload()));

  // 第 11、12 个排队后取消
  const ac1 = new AbortController();
  const ac2 = new AbortController();
  const w11 = entry.admit(payload(ac1.signal)).then(
    () => ({ cancelled: false }),
    (e) => ({ cancelled: e.__zsemCancel === true && e.name === 'AbortError', e }),
  );
  const w12 = entry.admit(payload(ac2.signal)).then(
    () => ({ cancelled: false }),
    (e) => ({ cancelled: e.__zsemCancel === true && e.name === 'AbortError', e }),
  );
  await new Promise((r) => setTimeout(r, 10)); // 确保入队
  ac1.abort(new Error('stop-11'));
  ac2.abort(new Error('stop-12'));
  const r11 = await w11;
  const r12 = await w12;

  // 释放 1 个名额 → 新请求应立即授予(而非被已取消的等待者占位)
  holders[0].release();
  const fresh = await entry.admit(payload());
  let freshGranted = true;
  try {
    fresh.release();
  } catch {
    freshGranted = false;
  }

  // 全部释放 → 无泄漏
  for (const h of holders.slice(1)) h.release();
  const snap = entry.__forTest.sems.snapshot()[PROVIDER];

  const cancelled = (r11.cancelled ? 1 : 0) + (r12.cancelled ? 1 : 0);
  const leak = snap ? snap.active + snap.queued : -1;
  console.log(`cancelled=${cancelled}`);
  console.log(`leak=${leak}`);
  console.log(`fresh-grant=${freshGranted ? 'ok' : 'FAIL'}`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(cancelled === 2 && leak === 0 && freshGranted ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
