'use strict';

/**
 * T3 实机探针:patch 后的真实 zcode.cjs 可正常加载启动。
 * 子检查 1(正常环境):node zcode.cjs --help 退出 0(注入后全文语法/顶层执行无破坏);
 * 子检查 2(zsem 缺位环境):HOME 指向空目录再跑 --help——zsem symlink 在该 HOME 下
 * 不存在,若注入行在模块加载期执行会崩;注入在函数体内、且异常被吞,应同样退出 0。
 * 输出标记:smoke=ok / fail-open=ok
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ZCODE = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

function runHelp(extraEnv = {}) {
  return spawnSync(process.execPath, [ZCODE, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    timeout: 30000,
  });
}

function main() {
  if (!fs.readFileSync(ZCODE, 'utf8').includes('globalThis.__ZSEM__')) {
    console.error('zcode.cjs 未含注入标记——先跑 apply。恢复动作:node patch-zcode-app.js apply --patch provider-sem');
    process.exit(1);
  }
  const r1 = runHelp();
  console.log(`smoke=${r1.status === 0 && /zcode/.test(r1.stdout) ? 'ok' : 'FAIL'}`);

  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zsem-smoke-home-'));
  const r2 = runHelp({ HOME: emptyHome });
  console.log(`fail-open=${r2.status === 0 ? 'ok' : 'FAIL'}`);
  if (r2.status !== 0) console.error(r2.stderr);
  fs.rmSync(emptyHome, { recursive: true, force: true });

  process.exit(r1.status === 0 && r2.status === 0 ? 0 : 1);
}

main();
