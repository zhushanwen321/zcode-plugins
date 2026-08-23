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
const { execFile } = require('node:child_process');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-wt-'));
process.env.ZSW_ROOT = path.join(TMP, 'zsub-root');

// env 隔离完成后再 require lib（与既有测试同约定）
const worktree = require('../lib/worktree');
const { reapWorktrees, sweepStaleOutputs } = require('../lib/reaper');
const { outputsDir } = require('../lib/config');

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

  const patchFile = await worktree.collectPatch({ worktreeDir: dir, subagentId: id });
  assert.ok(patchFile, '有改动必须返回 patch 路径');
  // [MF#1] patch 在 worktree 之外（outputs/ 下），cleanup 删不到它
  assert.ok(!patchFile.startsWith(dir + path.sep), 'patch 不得落在 worktree 目录内');
  assert.equal(patchFile, path.join(outputsDir(), `${id}.patch`));
  assert.ok(fs.existsSync(patchFile));

  const text = fs.readFileSync(patchFile, 'utf8');
  assert.match(text, /a\.txt/, '已跟踪修改必须进 patch');
  assert.ok(text.includes('+appended'), '修改内容必须进 patch');
  assert.ok(text.includes('+new content'), '未跟踪新文件全文必须进 patch（intent-to-add）');
  assert.ok(text.includes('+committed'), '子 agent 已提交的改动必须进 patch（基线 diff）');
  assert.match(text, /new file mode/);

  // H8 判据：干净主树上 git apply --check 必须过
  await git(repo, ['apply', '--check', patchFile]);

  await worktree.cleanup({ mainRepo: repo, worktreeDir: dir, branch });
});

test('collectPatch：无改动返回 null 且不落 patch 文件', async () => {
  const { repo, id } = await setup();
  const { dir, branch } = await worktree.prepare({ mainRepo: repo, slug: 'noop', subagentId: id });

  assert.equal(await worktree.collectPatch({ worktreeDir: dir, subagentId: id }), null);
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
