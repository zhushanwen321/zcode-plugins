'use strict';
/**
 * worktree 隔离子系统测试（lib/worktree.js + lib/reaper.js，DESIGN-v3 D12/H8）。
 *
 * git 是唯一外部依赖（CI 可跑）：每个用例 mkdtemp 临时目录 `git init` + 真实
 * commit 建仓，不 mock git 行为。ZSW_ROOT 指临时目录，绝不碰真实 ~/.zcode。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-wt-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsub-root');

// env 隔离完成后再 require lib（与既有测试同约定）
const worktree = require('../lib/worktree');
const { reapWorktrees, sweepStaleOutputs } = require('../lib/reaper');
const { outputsDir } = require('../lib/config');

/** worktree gitdir 下的基线锚点文件名（与 lib/worktree.js BASE_MARKER 同源）。 */
const BASE_MARKER = 'zsub-base-commit';

/** 测试侧 git 出口：失败时带 stderr，便于定位。 */
function git(repo, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} 失败: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

let seq = 0;

/** 每用例独立真实仓库：init + 本地身份 + 一次 commit（worktree add 需有 HEAD）。 */
async function setup() {
  seq += 1;
  const repo = path.join(TMP, `repo-${seq}`);
  fs.mkdirSync(repo);
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'test@zsub.local']);
  await git(repo, ['config', 'user.name', 'zsub-test']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  return { repo, id: `sa-t${seq}` };
}

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// ---------------------------------------------------------------- prepare

test('prepare：创建 worktree 目录与 zsub/<id> 分支', async () => {
  const { repo, id } = await setup();
  const { dir, branch } = await worktree.prepare({ mainRepo: repo, slug: 'review', subagentId: id });

  assert.equal(branch, `zsub/${id}`);
  assert.ok(fs.statSync(dir).isDirectory(), 'worktree 目录必须存在');
  assert.equal(path.dirname(dir), process.env.ZSW_ROOT, '目录必须落 <zsubRoot>/wt-<id>');
  // --format 取裸分支名：worktree 检出中的分支在默认输出带 "+" 前缀
  const br = await git(repo, ['branch', '--list', `zsub/${id}`, '--format=%(refname:short)']);
  assert.equal(br.trim(), branch);
  assert.ok((await git(repo, ['worktree', 'list', '--porcelain'])).includes(dir));

  await worktree.cleanup({ mainRepo: repo, worktreeDir: dir, branch });
});

test('prepare：主树 dirty 抛可操作错误（文案含恢复指引）且不留半成品', async () => {
  const { repo, id } = await setup();
  fs.writeFileSync(path.join(repo, 'dirty.txt'), '未提交改动\n');

  await assert.rejects(
    () => worktree.prepare({ mainRepo: repo, slug: 'fix', subagentId: id }),
    (err) => {
      assert.match(err.message, /主树 dirty/);
      assert.match(err.message, /commit\/stash/);
      assert.match(err.message, /worktree:false/);
      assert.match(err.message, /dirty\.txt/, '诊断信息须附 status 输出');
      assert.equal(err.name, 'DirtyTreeError');
      return true;
    },
  );
  // 拒绝必须发生在 worktree add 之前：无目录、无分支
  assert.ok(!fs.existsSync(path.join(process.env.ZSW_ROOT, `wt-${id}`)));
  assert.equal((await git(repo, ['branch', '--list', `zsub/${id}`])).trim(), '');
});

test('prepare：拒绝不安全 subagentId（防路径注入）', async () => {
  const { repo } = await setup();
  await assert.rejects(
    () => worktree.prepare({ mainRepo: repo, slug: 'x', subagentId: '../escape' }),
    (err) => {
      assert.match(err.message, /subagentId/);
      return true;
    },
  );
});

// ---------------------------------------------------------------- collectPatch

test('collectPatch：修改/新增/已提交改动全进 patch，apply --check 过，patch 落 worktree 外', async () => {
  const { repo, id } = await setup();
  const { dir, branch } = await worktree.prepare({ mainRepo: repo, slug: 'impl', subagentId: id });

  // 三类改动：已跟踪修改、未跟踪新文件、子 agent 自行 commit 的改动
  fs.appendFileSync(path.join(dir, 'a.txt'), 'appended\n');
  fs.writeFileSync(path.join(dir, 'brand-new.txt'), 'new content\n');
  fs.writeFileSync(path.join(dir, 'committed.txt'), 'committed\n');
  await git(dir, ['add', 'committed.txt']);
  await git(dir, ['commit', '-q', '-m', 'subagent work']);

  // 机制切换后返回结构化结果：patchFile + 降级留痕 patchIncomplete
  const res = await worktree.collectPatch({ worktreeDir: dir, subagentId: id });
  const patchFile = res.patchFile;
  assert.ok(patchFile, '有改动必须返回 patch 路径');
  assert.equal(res.patchIncomplete, undefined, '锚点健康且 add 成功时不得留降级痕');
  // [MF#1] patch 在 worktree 之外（outputs/ 下），cleanup 删不到它
  assert.ok(!patchFile.startsWith(dir + path.sep), 'patch 不得落在 worktree 目录内');
  assert.equal(patchFile, path.join(outputsDir(), `${id}.patch`));
  assert.ok(fs.existsSync(patchFile));

  const text = fs.readFileSync(patchFile, 'utf8');
  assert.match(text, /a\.txt/, '已跟踪修改必须进 patch');
  assert.ok(text.includes('+appended'), '修改内容必须进 patch');
  // core 机制 add -A + diff --cached：untracked 全文必须进 patch（等值于旧 intent-to-add）
  assert.ok(text.includes('+new content'), '未跟踪新文件全文必须进 patch');
  assert.ok(text.includes('+committed'), '子 agent 已提交的改动必须进 patch（基线 diff）');
  assert.match(text, /new file mode/);

  // H8 判据：干净主树上 git apply --check 必须过
  await git(repo, ['apply', '--check', patchFile]);

  await worktree.cleanup({ mainRepo: repo, worktreeDir: dir, branch });
});

test('collectPatch：无改动返回 null 且不落 patch 文件', async () => {
  const { repo, id } = await setup();
  const { dir, branch } = await worktree.prepare({ mainRepo: repo, slug: 'noop', subagentId: id });

  // 锚点健康 + 无改动：patchFile null 且无降级键（deepEqual 钉结构，防混入意外字段）
  assert.deepEqual(await worktree.collectPatch({ worktreeDir: dir, subagentId: id }), { patchFile: null });
  assert.ok(!fs.existsSync(path.join(outputsDir(), `${id}.patch`)));

  await worktree.cleanup({ mainRepo: repo, worktreeDir: dir, branch });
});

// ---------------------------------------------------------------- cleanup

test('cleanup：worktree 无残留、分支删除、可重复调用（幂等）', async () => {
  const { repo, id } = await setup();
  const { dir, branch } = await worktree.prepare({ mainRepo: repo, slug: 's', subagentId: id });
  fs.writeFileSync(path.join(dir, 'uncommitted.txt'), 'x\n'); // 带未提交改动清理，--force 语义

  await worktree.cleanup({ mainRepo: repo, worktreeDir: dir, branch });

  assert.ok(!fs.existsSync(dir), 'worktree 目录必须删除');
  const list = await git(repo, ['worktree', 'list', '--porcelain']);
  assert.ok(!list.includes(dir), 'worktree list 不得有残留');
  assert.equal((await git(repo, ['branch', '--list', branch])).trim(), '', '分支必须删除');

  // 幂等：重放不抛（reaper 与任务收尾可能各清一次）
  await worktree.cleanup({ mainRepo: repo, worktreeDir: dir, branch });
});

test('cleanup：worktree 目录被外部删除后分支仍必须删净（prune 先行等值旧三步）', async () => {
  const { repo, id } = await setup();
  const { dir, branch } = await worktree.prepare({ mainRepo: repo, slug: 'ext-gone', subagentId: id });

  // 模拟外部删除（reaper 文档场景）：元数据还在 → remove 失败、branch -D 被
  // 「used by worktree」拒绝——core cleanupWorktree 无 prune，zsw 侧 prune 先行
  // 清缺失目录元数据后分支才可删；此用例钉住该等值，防未来误删 prune 步。
  fs.rmSync(dir, { recursive: true, force: true });

  await worktree.cleanup({ mainRepo: repo, worktreeDir: dir, branch });

  const list = await git(repo, ['worktree', 'list', '--porcelain']);
  assert.ok(!list.includes(dir), '元数据必须被 prune 清掉');
  assert.equal((await git(repo, ['branch', '--list', branch])).trim(), '',
    '目录外部删除后分支必须删净（资源泄漏回归）');

  // 幂等重放不抛
  await worktree.cleanup({ mainRepo: repo, worktreeDir: dir, branch });
});

// ---------------------------------------------------------------- listOrphans

test('listOrphans：识别未知 wt- 条目；已知 id 与主树本身不报', async () => {
  const { repo, id: knownId } = await setup();
  const ghostId = `${knownId}-ghost`;
  const known = await worktree.prepare({ mainRepo: repo, slug: 'a', subagentId: knownId });
  const ghost = await worktree.prepare({ mainRepo: repo, slug: 'b', subagentId: ghostId });

  const orphans = await worktree.listOrphans({ mainRepo: repo, knownSubagentIds: [knownId] });
  assert.equal(orphans.length, 1, '只报未知 id；主树与已知 worktree 不报');
  assert.equal(orphans[0].subagentId, ghostId);
  // git 会 realpath 化路径（macOS /var → /private/var），目录断言用 realpath 对账
  assert.equal(fs.realpathSync(orphans[0].dir), fs.realpathSync(ghost.dir));
  assert.equal(orphans[0].branch, ghost.branch);

  const none = await worktree.listOrphans({ mainRepo: repo, knownSubagentIds: [knownId, ghostId] });
  assert.equal(none.length, 0, '全 known 时无孤儿');

  await worktree.cleanup({ mainRepo: repo, worktreeDir: known.dir, branch: known.branch });
  await worktree.cleanup({ mainRepo: repo, worktreeDir: ghost.dir, branch: ghost.branch });
});

// ---------------------------------------------------------------- reaper

test('reapWorktrees remove=false：只报告不清理', async () => {
  const { repo, id } = await setup();
  const wt = await worktree.prepare({ mainRepo: repo, slug: 'g', subagentId: id });

  const { orphans } = await reapWorktrees({ mainRepo: repo, knownSubagentIds: [], remove: false });
  // 分支名比对：git 回显的目录路径带 realpath，字串与 prepare 返回值不同源
  const mine = orphans.filter((o) => o.branch === wt.branch);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].removed, false, 'remove=false 时 removed 恒 false');
  assert.ok(fs.existsSync(wt.dir), 'remove=false 绝不删目录');
  assert.ok((await git(repo, ['branch', '--list', wt.branch])).trim(), '分支也必须还在');

  await worktree.cleanup({ mainRepo: repo, worktreeDir: wt.dir, branch: wt.branch });
});

test('reapWorktrees remove=true：清孤儿，不动已知任务的 worktree', async () => {
  const { repo, id: liveId } = await setup();
  const ghostId = `${liveId}-ghost`;
  const live = await worktree.prepare({ mainRepo: repo, slug: 'live', subagentId: liveId });
  const ghost = await worktree.prepare({ mainRepo: repo, slug: 'ghost', subagentId: ghostId });

  const { orphans } = await reapWorktrees({ mainRepo: repo, knownSubagentIds: [liveId], remove: true });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].branch, ghost.branch); // 目录路径经 realpath，用分支名锚定
  assert.equal(orphans[0].removed, true);
  assert.ok(!fs.existsSync(ghost.dir), '孤儿 worktree 目录已删');
  assert.equal((await git(repo, ['branch', '--list', ghost.branch])).trim(), '', '孤儿分支已删');
  assert.ok(fs.existsSync(live.dir), '已知任务的 worktree 不得被误删');
  assert.ok((await git(repo, ['branch', '--list', live.branch])).trim(), '已知任务的分支不得被误删');

  await worktree.cleanup({ mainRepo: repo, worktreeDir: live.dir, branch: live.branch });
});

// ---------------------------------------------------------------- sweepStaleOutputs

test('sweepStaleOutputs：报告孤儿结果文件但绝不删除（用户资产边界）', async () => {
  const outputs = outputsDir();
  fs.mkdirSync(outputs, { recursive: true });
  fs.writeFileSync(path.join(outputs, 'sa-live.md'), 'live result');
  fs.writeFileSync(path.join(outputs, 'sa-live.patch'), 'diff --git');
  fs.writeFileSync(path.join(outputs, 'sa-ghost.md'), 'ghost result');
  fs.writeFileSync(path.join(outputs, 'sa-ghost.patch'), 'diff --git ghost');
  // 原子写残留 tmp：不匹配 <id>.md|.patch 形态，不在本清扫范围
  fs.writeFileSync(path.join(outputs, '.sa-ghost.md.123.999.tmp'), 'half');

  const { stale } = sweepStaleOutputs({ knownSubagentIds: ['sa-live'] });
  // outputs/ 是全局共享目录，前面用例落过的 <id>.patch 对本用例也是合法孤儿——
  // 只断言本用例关心的 sa-ghost / sa-live 边界
  const ghostFiles = stale
    .map((s) => path.basename(s.file))
    .filter((f) => f.startsWith('sa-ghost'))
    .sort();
  assert.deepEqual(ghostFiles, ['sa-ghost.md', 'sa-ghost.patch']);
  assert.ok(stale.every((s) => s.subagentId !== 'sa-live'), '在册结果不得被报告');
  assert.ok(stale.every((s) => !s.file.endsWith('.tmp')), '原子写 tmp 残留不在清扫范围');
  for (const s of stale) assert.ok(fs.existsSync(s.file), '只报告，不删除');

  // 只报告不删：全部文件原样存在
  for (const f of ['sa-live.md', 'sa-live.patch', 'sa-ghost.md', 'sa-ghost.patch', '.sa-ghost.md.123.999.tmp']) {
    assert.ok(fs.existsSync(path.join(outputs, f)), `${f} 不得被删除`);
  }

  // outputs 目录不存在 → 空报告（outputsDir 惰性读 env，临时切换验证）
  const saved = process.env.ZSW_ROOT;
  process.env.ZSW_ROOT = path.join(TMP, 'no-such-root');
  const empty = sweepStaleOutputs({ knownSubagentIds: [] });
  process.env.ZSW_ROOT = saved;
  assert.deepEqual(empty, { stale: [] });
});

// ------------------------------------------------- ⛔A 等值对照与降级分支

/**
 * 改造前机制（HEAD 版 lib/worktree.js）的等价参照实现：intent-to-add
 * （`add -A -N`）+ 基线裸 diff，base 从 gitdir sidecar 读取（RE 校验，失败
 * 则裸 diff）。内联而非 `git show HEAD` 取旧文件：测试不得随分支历史漂移
 * （本分支合入后 HEAD 即新机制，外部依赖对照会静默失效）。
 */
async function legacyCollectPatchDiff(worktreeDir) {
  await git(worktreeDir, ['add', '-A', '-N']);
  const gitDir = (await git(worktreeDir, ['rev-parse', '--git-dir'])).trim();
  let base = null;
  try {
    const raw = fs.readFileSync(path.join(gitDir, BASE_MARKER), 'utf8').trim();
    base = /^[0-9a-f]{7,40}$/.test(raw) ? raw : null;
  } catch { base = null; }
  return git(worktreeDir, base ? ['diff', base] : ['diff']);
}

/** 读 worktree gitdir（测试侧，用于锚点文件操作）。 */
async function gitDirOf(worktreeDir) {
  const out = (await git(worktreeDir, ['rev-parse', '--git-dir'])).trim();
  return path.isAbsolute(out) ? out : path.resolve(worktreeDir, out);
}

/** 子进程执行 core 机制 collectPatch：真实 daemon 重启语义（全新模块图 + 磁盘 sidecar）。 */
function collectPatchInSubprocess(worktreeDir, subagentId) {
  const entry = path.resolve(__dirname, '../lib/worktree');
  const script = `
    const worktree = require(${JSON.stringify(entry)});
    worktree.collectPatch({ worktreeDir: ${JSON.stringify(worktreeDir)}, subagentId: ${JSON.stringify(subagentId)} })
      .then((r) => process.stdout.write(JSON.stringify(r)))
      .catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(1); });
  `;
  const sub = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: process.env });
  assert.equal(sub.status, 0, `子进程 collectPatch 失败：${sub.stderr}`);
  return JSON.parse(sub.stdout);
}

test('⛔A 等值主断言：新文件+已提交改动+跨 daemon 重启，旧机制与 core 机制 patch 应用后树状态逐行一致', async () => {
  const { repo, id } = await setup();
  const { dir, branch } = await worktree.prepare({ mainRepo: repo, slug: 'parity', subagentId: id });

  // 三类改动：已跟踪修改、未跟踪新文件、子 agent 自行 commit 的改动
  fs.appendFileSync(path.join(dir, 'a.txt'), 'appended\n');
  fs.writeFileSync(path.join(dir, 'brand-new.txt'), 'new content\n');
  fs.writeFileSync(path.join(dir, 'committed.txt'), 'committed\n');
  await git(dir, ['add', 'committed.txt']);
  await git(dir, ['commit', '-q', '-m', 'subagent work']);

  // 旧机制（改造前等价参照）：intent-to-add + 基线裸 diff，patch 存测试自管文件
  const oldPatch = path.join(TMP, `parity-old-${seq}.patch`);
  fs.writeFileSync(oldPatch, await legacyCollectPatchDiff(dir));

  // 新机制跑在子进程 = 真实 daemon 重启：新进程新模块图，基线从磁盘 sidecar 恢复
  const newRes = collectPatchInSubprocess(dir, id);
  assert.ok(newRes.patchFile, 'core 机制必须产出 patch');
  assert.equal(newRes.patchIncomplete, undefined, '锚点健康不得降级');
  const newPatch = newRes.patchFile;

  // 两份 patch 各自 apply 到同一基线（主仓 HEAD）的两个干净 clone
  const targetOld = path.join(TMP, `parity-old-${seq}`);
  const targetNew = path.join(TMP, `parity-new-${seq}`);
  await git(TMP, ['clone', '-q', repo, targetOld]);
  await git(TMP, ['clone', '-q', repo, targetNew]);
  await git(targetOld, ['apply', oldPatch]);
  await git(targetNew, ['apply', newPatch]);

  // 等值主断言：应用后 porcelain 逐行一致（产物字节可不同——intent-to-add vs
  // add -A + diff --cached——应用结果树状态必须等价）
  const statusOld = (await git(targetOld, ['status', '--porcelain'])).split('\n').filter(Boolean).sort();
  const statusNew = (await git(targetNew, ['status', '--porcelain'])).split('\n').filter(Boolean).sort();
  assert.ok(statusOld.length >= 3, `三类改动必须全部进 patch（实际 ${statusOld.length} 行）`);
  assert.deepEqual(statusNew, statusOld);
  // 内容级复核：porcelain 之外关键文件逐字节相同
  for (const f of ['a.txt', 'brand-new.txt', 'committed.txt']) {
    assert.equal(
      fs.readFileSync(path.join(targetNew, f), 'utf8'),
      fs.readFileSync(path.join(targetOld, f), 'utf8'),
      `${f} 应用后内容必须一致`,
    );
  }

  await worktree.cleanup({ mainRepo: repo, worktreeDir: dir, branch });
});

test('⛔A 降级①：锚点文件缺失 → core 降级裸 diff + patchIncomplete 留痕（丢已提交增量）', async () => {
  const { repo, id } = await setup();
  const { dir, branch } = await worktree.prepare({ mainRepo: repo, slug: 'no-anchor', subagentId: id });

  fs.writeFileSync(path.join(dir, 'committed.txt'), 'committed\n');
  await git(dir, ['add', 'committed.txt']);
  await git(dir, ['commit', '-q', '-m', 'subagent work']);
  fs.appendFileSync(path.join(dir, 'a.txt'), 'appended\n');

  fs.rmSync(path.join(await gitDirOf(dir), BASE_MARKER));

  const res = await worktree.collectPatch({ worktreeDir: dir, subagentId: id });
  assert.ok(res.patchFile, '降级后仍有未提交改动，patch 必须产出');
  assert.equal(res.patchIncomplete, true, '降级必须以 patchIncomplete 留痕（宿主 outcome 口径）');
  const text = fs.readFileSync(res.patchFile, 'utf8');
  assert.ok(text.includes('+appended'), '未提交改动仍必须进 patch');
  assert.ok(!text.includes('committed.txt'), '已提交增量在降级路径下丢失（裸 diff 只覆盖未提交）');

  await worktree.cleanup({ mainRepo: repo, worktreeDir: dir, branch });
});

test('⛔A 降级①b：锚点内容损坏（非 sha）→ core 基线被 git 拒绝 → 降级 + patchIncomplete 留痕', async () => {
  const { repo, id } = await setup();
  const { dir, branch } = await worktree.prepare({ mainRepo: repo, slug: 'bad-anchor', subagentId: id });

  fs.writeFileSync(path.join(dir, 'committed.txt'), 'committed\n');
  await git(dir, ['add', 'committed.txt']);
  await git(dir, ['commit', '-q', '-m', 'subagent work']);
  fs.appendFileSync(path.join(dir, 'a.txt'), 'appended\n');

  fs.writeFileSync(path.join(await gitDirOf(dir), BASE_MARKER), 'not-a-sha\n');

  const res = await worktree.collectPatch({ worktreeDir: dir, subagentId: id });
  assert.ok(res.patchFile, '降级后仍有未提交改动，patch 必须产出');
  assert.equal(res.patchIncomplete, true, '锚点被 git 拒绝必须留痕');
  const text = fs.readFileSync(res.patchFile, 'utf8');
  assert.ok(text.includes('+appended'), '未提交改动仍必须进 patch');
  assert.ok(!text.includes('committed.txt'), '已提交增量在降级路径下丢失');

  await worktree.cleanup({ mainRepo: repo, worktreeDir: dir, branch });
});

test('⛔A 降级②：git add 失败（index.lock 预置）→ patchIncomplete 留痕，patch 仍产出（仅 tracked 未提交）', async () => {
  const { repo, id } = await setup();
  const { dir, branch } = await worktree.prepare({ mainRepo: repo, slug: 'add-fail', subagentId: id });

  fs.appendFileSync(path.join(dir, 'a.txt'), 'appended\n');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'x\n');
  const lock = path.join(await gitDirOf(dir), 'index.lock');
  fs.writeFileSync(lock, 'stale lock');

  const res = await worktree.collectPatch({ worktreeDir: dir, subagentId: id });
  assert.equal(res.patchIncomplete, true, 'add 失败必须留痕（不致命，pi 同款语义）');
  assert.ok(res.patchFile, 'add 失败不致命：patch 仍须产出');
  const text = fs.readFileSync(res.patchFile, 'utf8');
  assert.ok(text.includes('+appended'), 'tracked 未提交改动必须进 patch');
  assert.ok(!text.includes('untracked.txt'), 'add 失败后 untracked 漏出（降级为仅 tracked 未提交）');

  fs.rmSync(lock);
  await worktree.cleanup({ mainRepo: repo, worktreeDir: dir, branch });
});

test('⛔A 降级③：锚点缺失且无改动 → patchFile:null 与 patchIncomplete:true 并存（written:false 不可独立解读为无降级）', async () => {
  const { repo, id } = await setup();
  const { dir, branch } = await worktree.prepare({ mainRepo: repo, slug: 'silent-degrade', subagentId: id });

  fs.rmSync(path.join(await gitDirOf(dir), BASE_MARKER));

  const res = await worktree.collectPatch({ worktreeDir: dir, subagentId: id });
  assert.deepEqual(res, { patchFile: null, patchIncomplete: true },
    '降级 + 无改动时 written:false 与 patchIncomplete 必须同时留痕');
  assert.ok(!fs.existsSync(path.join(outputsDir(), `${id}.patch`)), '未落盘不得留下 patch 文件');

  await worktree.cleanup({ mainRepo: repo, worktreeDir: dir, branch });
});

test('⛔A prepare：锚点写失败不阻断任务启动（收集时经 core 降级留痕）', async () => {
  const { repo, id } = await setup();
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (...args) => {
    if (String(args[0]).endsWith(BASE_MARKER)) throw new Error('injected anchor write failure');
    return realWrite(...args);
  };
  let wt;
  try {
    wt = await worktree.prepare({ mainRepo: repo, slug: 'anchor-fail', subagentId: id });
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.ok(fs.statSync(wt.dir).isDirectory(), '锚点写失败不得阻断 worktree 创建');
  assert.equal((await git(repo, ['worktree', 'list', '--porcelain'])).includes(wt.dir), true);

  // 锚点缺失 → 收集走 core 降级分支，未提交改动仍可收集
  fs.appendFileSync(path.join(wt.dir, 'a.txt'), 'appended\n');
  const res = await worktree.collectPatch({ worktreeDir: wt.dir, subagentId: id });
  assert.equal(res.patchIncomplete, true, '锚点缺失必须降级留痕');
  assert.ok(res.patchFile && fs.readFileSync(res.patchFile, 'utf8').includes('+appended'));

  await worktree.cleanup({ mainRepo: repo, worktreeDir: wt.dir, branch: wt.branch });
});

// ------------------------------------------------------- worktree-adapter 桥接

test('adapter 桥接：prepare 透传 mainRepo，cleanup 可凭 meta 独立完成清理', async () => {
  const { createWorktreeAdapter } = require('../lib/worktree-adapter');
  const { repo, id } = await setup();
  const adapter = createWorktreeAdapter();
  // e2e 实测发现的桥接 bug 回归：prepare 曾丢失 mainRepo，导致 manager.close 的
  // cleanup 报「worktree 清理缺少元数据」——bridge 必须端到端闭环。
  const wt = await adapter.prepare({ slug: 'bridge', subagentId: id, cwd: repo });
  assert.ok(fs.statSync(wt.dir).isDirectory());
  assert.equal(wt.branch, `zsub/${id}`);
  // macOS 上 git 返回 realpath 化路径（/var → /private/var），对比也用 realpath
  assert.equal(wt.mainRepo, fs.realpathSync(repo), 'mainRepo 必须随句柄透传（cleanup 的执行仓库）');
  fs.writeFileSync(path.join(wt.dir, 'new.txt'), 'x\n');
  const patchFile = await adapter.collectPatch({ dir: wt.dir, subagentId: id });
  assert.ok(patchFile && fs.existsSync(patchFile));
  assert.ok(fs.readFileSync(patchFile, 'utf8').includes('new.txt'));
  await adapter.cleanup({ dir: wt.dir, subagentId: id, meta: wt }); // resolve 不抛即清理成功（物理面下方断言）
  const wts = (await git(repo, ['worktree', 'list', '--porcelain'])).split('\n')
    .filter((l) => l.startsWith('worktree '));
  assert.equal(wts.length, 1);
  assert.equal((await git(repo, ['branch', '--list', `zsub/${id}`])).trim(), '');
});
