'use strict';

/**
 * T9 真实端到端探针:patched zcode.cjs 以 `-p` 单次 prompt 形态跑一次真实 LLM
 * 请求(完整 runtime、真实 provider 凭据)。zsem 注入行在真实请求路径执行,
 * 判定 zsem-log 新增 grant/release 事件。
 *
 * 前置:provider-sem 已 apply;~/.zcode/cli/zsem symlink 已 install。
 * token 消耗:一次最小请求(任务「Reply with exactly: ok」)。
 * 输出标记:grant=<N> release=<M>
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
    } catch {
      /* 缺失的配置源跳过 */
    }
  }
  return [...ids];
}

function main() {
  if (!fs.readFileSync(ZCODE, 'utf8').includes('globalThis.__ZSEM__')) {
    console.error('zcode.cjs 未含注入标记——先跑 apply。恢复动作:node patch-zcode-app.js apply --patch provider-sem');
    process.exit(1);
  }
  const ids = providerIds();
  if (ids.length === 0) {
    console.error('v2/cli config 均无可用 provider,无法真实请求');
    process.exit(1);
  }
  const backup = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : null;
  process.on('exit', () => {
    if (backup === null) fs.rmSync(CONFIG, { force: true });
    else fs.writeFileSync(CONFIG, backup, 'utf8');
  });
  fs.writeFileSync(CONFIG, JSON.stringify({ providers: Object.fromEntries(ids.map((id) => [id, { limit: 10 }])) }), 'utf8');

  const logLinesBefore = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length : 0;
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsem-t9-'));
  const r = spawnSync(process.execPath, [ZCODE, '-p', 'Reply with exactly: ok', '--cwd', workdir], {
    encoding: 'utf8',
    timeout: 240000,
  });
  fs.rmSync(workdir, { recursive: true, force: true });
  if (r.status !== 0) {
    console.error(`zcode -p 失败:\n${(r.stdout || '').slice(-500)}\n${(r.stderr || '').slice(-500)}`);
    process.exit(1);
  }

  const lines = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : [];
  const fresh = lines.slice(logLinesBefore).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const grants = fresh.filter((e) => e.type === 'grant').length;
  const releases = fresh.filter((e) => e.type === 'release').length;
  console.log(`grant=${grants}`);
  console.log(`release=${releases}`);
  console.log(`prompt-ok=${/ok/i.test(r.stdout) ? 'ok' : 'warn'}`);
  process.exit(grants >= 1 && releases >= 1 ? 0 : 1);
}

main();
