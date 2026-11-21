'use strict';

/**
 * T8 实机探针(真实 ZCode.app):restore(回基线,模拟升级覆盖后的干净态)
 * → apply 重打成功 → 二次 apply 幂等全 skip。
 * 终态保证:结束时 provider-sem 处于已应用态。
 * 输出标记:reapply=ok / idempotent=ok
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const CLI = path.join(__dirname, '..', '..', 'patch-zcode-app.js');
const ZCODE = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

function run(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) {
    console.error(`命令失败(${args.join(' ')}):${r.stderr}`);
    process.exit(1);
  }
  return r.stdout;
}

function main() {
  run('restore');
  if (fs.readFileSync(ZCODE, 'utf8').includes('globalThis.__ZSEM__')) {
    console.error('restore 后仍有注入标记');
    process.exit(1);
  }
  const out1 = run('apply', '--patch', 'provider-sem');
  const applied = out1.includes('apply provider-sem: 已写入');
  const marked = fs.readFileSync(ZCODE, 'utf8').includes('globalThis.__ZSEM__');
  const out2 = run('apply', '--patch', 'provider-sem');
  const idempotent = out2.includes('skip provider-sem: 已应用') && !out2.includes('apply provider-sem: 已写入');
  console.log(`reapply=${applied && marked ? 'ok' : 'FAIL'}`);
  console.log(`idempotent=${idempotent ? 'ok' : 'FAIL'}`);
  process.exit(applied && marked && idempotent ? 0 : 1);
}

main();
