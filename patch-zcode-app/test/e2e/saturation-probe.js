'use strict';

/**
 * 满载排队实证探针:config 全 provider limit=2,spawn patched zcode.cjs -p 让其
 * 单条消息并行派 3 个 subagent(同一进程内共享一个 zsem 信号量实例)。
 * 预期:至少出现 1 次 queue 事件,且至少 1 个 grant 的 queuedMs > 0(真实排队后
 * 授予);结束时 grants == releases(名额全归还)。
 * 结束后恢复原 config。输出标记:queued=<N> delayedGrant=<N> balanced=ok
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const ZCODE = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const CONFIG = path.join(HOME, '.zcode', 'cli', 'zsem-config.json');
const LOG = path.join(HOME, '.zcode', 'cli', 'zsem-log.jsonl');

function providerIds() {
  const ids = new Set();
  for (const file of [path.join(HOME, '.zcode', 'v2', 'config.json'), path.join(HOME, '.zcode', 'cli', 'config.json')]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [id, e] of Object.entries(cfg.provider || {})) {
        if (e && Object.keys(e.models || {}).length > 0) ids.add(id);
      }
    } catch { /* ignore */ }
  }
  return [...ids];
}

function main() {
  const ids = providerIds();
  if (ids.length === 0) {
    console.error('无可用 provider');
    process.exit(1);
  }
  const backup = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : null;
  process.on('exit', () => {
    if (backup === null) fs.rmSync(CONFIG, { force: true });
    else fs.writeFileSync(CONFIG, backup, 'utf8');
  });
  fs.writeFileSync(CONFIG, JSON.stringify({ providers: Object.fromEntries(ids.map((id) => [id, { limit: 2 }])) }), 'utf8');
  const before = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length : 0;

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsem-sat-'));
  const r = spawnSync(
    process.execPath,
    [
      ZCODE,
      '-p',
      'Launch exactly 3 subagents in parallel in a single message using the Agent tool. ' +
        'Each subagent prompt must be exactly: Reply with exactly: ok. ' +
        'Wait for all three, then output done.',
      '--cwd',
      workdir,
      '--mode',
      'yolo',
    ],
    { encoding: 'utf8', timeout: 300000 },
  );
  fs.rmSync(workdir, { recursive: true, force: true });
  if (r.status !== 0) {
    console.error(`zcode -p 失败:\n${(r.stdout || '').slice(-400)}\n${(r.stderr || '').slice(-400)}`);
    process.exit(1);
  }

  const lines = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : [];
  const fresh = lines.slice(before).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const acq = fresh.filter((e) => e.type === 'acquire').length;
  const grants = fresh.filter((e) => e.type === 'grant');
  const releases = fresh.filter((e) => e.type === 'release');
  const queued = fresh.filter((e) => e.type === 'queue').length;
  const delayed = grants.filter((e) => typeof e.queuedMs === 'number' && e.queuedMs > 0);
  console.log(`acquire=${acq} grants=${grants.length} releases=${releases.length}`);
  console.log(`queued=${queued}`);
  console.log(`delayedGrant=${delayed.length}`);
  for (const g of grants) console.log(`  grant ${g.modelId || ''} queuedMs=${g.queuedMs}`);
  console.log(`balanced=${grants.length === releases.length ? 'ok' : 'FAIL'}`);
  console.log(`prompt-tail=${(r.stdout || '').trim().split('\n').slice(-1)[0].slice(0, 60)}`);
  const ok = grants.length >= 3 && queued >= 1 && delayed.length >= 1 && grants.length === releases.length;
  console.log(ok ? 'SATURATION=ok(第 3+ 个请求真实排队后放行)' : 'SATURATION=FAIL');
  process.exit(ok ? 0 : 1);
}

main();
