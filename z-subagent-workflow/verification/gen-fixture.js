'use strict';
// U3 A5-A7/P-mount 验收 fixture 生成器：向 $ZSW_ROOT/records.jsonl 写台账。
// 用法：node gen-fixture.js <终态 run 数> [active|no-active]
// 终态 run = created + transition(created→cancelled) 两事件；ts 单调递增
// （组内最后事件 ts 即 run 新旧序）；active = 追加 1 个活跃 run（created 单事件）。
const fs = require('node:fs');
const path = require('node:path');

const root = process.env.ZSW_ROOT || '/tmp/zsw-u3/root';
const totalTerm = Number(process.argv[2] || 1050);
const withActive = (process.argv[3] || 'active') !== 'no-active';
const lines = [];
for (let i = 1; i <= totalTerm; i++) {
  const ts = i * 10;
  lines.push(JSON.stringify({ ts, type: 'created', subagentId: `run-term-${i}`, task: `t${i}`, slug: `term-${i}` }));
  lines.push(JSON.stringify({ ts: ts + 1, type: 'transition', id: `run-term-${i}`, from: 'created', to: 'cancelled', closedReason: 'fixture' }));
}
if (withActive) {
  lines.push(JSON.stringify({ ts: (totalTerm + 1) * 10, type: 'created', subagentId: 'run-act-1', task: 'active', slug: 'act-1' }));
}
fs.mkdirSync(root, { recursive: true });
const file = path.join(root, 'records.jsonl');
fs.writeFileSync(file, `${lines.join('\n')}\n`);
console.log(`fixture: ${totalTerm} terminal${withActive ? ' + 1 active' : ''} runs -> ${file} (${lines.length} lines)`);
