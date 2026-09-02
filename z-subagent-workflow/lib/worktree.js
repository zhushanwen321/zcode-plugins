'use strict';
/**
 * WorktreePort 实现（DESIGN-v3.md §3.2 D12，契约见 ports.js）：
 * sidecar 持久锚点 + 布局/孤儿策略层。git 执行面全部下沉 vendored core 的
 * worktree-git-ops 函数族（经 lib/core-ref.js requireCore 取用）；本模块只保留
 * core 没有对应概念的 zsw 专属设计：
 *   - sidecar 锚点布局：基线 commit 落 worktree gitdir 下（工作树与 diff 都
 *     看不见它，跨 daemon 重启经磁盘可恢复），collectPatch 以
 *     { kind:'anchor-file', path } 注入 core，由 core 读取并负责降级判定；
 *   - prepare 编排（core 无 worktree add 封装）：干净主树前置校验 + add + 锚点
 *     落盘（写失败不阻断任务启动，维持可用性优先语义）；
 *   - 目录布局与孤儿对账：wt-<id> 目录名 × zswRoot realpath 归账（git 会把
 *     worktree 路径 realpath 化，macOS /var → /private/var）；
 *   - patch 落盘收尾：core 直写 patchFile 非原子，经 tmp+rename 保持读者
 *     「要么旧版要么完整版」的原子替换语义。
 *
 * ── patch 收集三条铁律（执行体已随 core 下沉，此处留语义锚）──
 * [MF#1] patch 必须落在 worktree 之外：固定 <zswRoot>/outputs/<id>.patch，与
 *        worktree 目录是兄弟目录，cleanup 删整个 worktree 不伤及 patch。
 * [MF#2] 新增文件必须进 diff：core 以 `git add -A` + `git diff --cached` 覆盖
 *        （旧自研 intent-to-add 机制的内部等价重构：两机制对同一改动集产出
 *        字节可不同、但应用后的树状态等价，test/worktree.test.js ⛔A 钉住）。
 * [MF#3] 已提交改动必须进 diff：锚点基线 `git diff --cached <base>`；锚点
 *        缺失/空白/被 git 拒绝时 core warn + 降级裸 diff 并置
 *        patchIncomplete:true。宿主 outcome 投影按此口径——不可把
 *        written:false 独立解读为无降级（降级 + 无改动时两者同时为真）。
 *
 * ── 与 pi 蓝本（worktree-manager.ts）的取舍 ──
 * 保留：干净主树前置校验；diff stdout 保真落盘（core finishPatch 不 trim，
 *       尾换行是 patch 的一部分）；cleanup 容错（remove/prune/branch -D 任一步
 *       失败不阻断其余）。不搬：全局注册表 + pid 死活判孤儿（zsub 用跨会话
 *       record store + listOrphans 物理面对账，D9/D12）；node_modules 软链；
 *       per-repo 写命令串行队列（并发上限 3 且 subagentId 全局唯一，git 自身
 *       index 锁兜底）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { zswRoot, outputsDir } = require('./config');
const { requireCore } = require('./core-ref');

/** worktree 目录名前缀（<zswRoot>/wt-<subagentId>），listOrphans 按它认领。 */
const WT_DIR_PREFIX = 'wt-';
/** 分支命名空间（zsub/<subagentId>），统一前缀便于人肉排查。 */
const BRANCH_NS = 'zsub/';
/** 基线 commit 侧车文件名（落 gitdir 下，工作树与 diff 都看不见它）。 */
const BASE_MARKER = 'zsub-base-commit';

/** 主树 dirty：错误文案本身即恢复指引（先 commit/stash，或放弃隔离）。 */
class DirtyTreeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DirtyTreeError';
  }
}

/**
 * worktree 的 gitdir（<mainRepo>/.git/worktrees/<id>）绝对路径。
 * core 未导出 gitdir 解析——锚点布局是 zsw 专属设计，最小本地实现。
 */
async function worktreeGitDir(worktreeDir) {
  const core = requireCore();
  const out = (await core.gitRun(['rev-parse', '--git-dir'], { cwd: worktreeDir })).trim();
  // rev-parse 在部分场景返回相对路径，统一 resolve 成绝对
  return path.isAbsolute(out) ? out : path.resolve(worktreeDir, out);
}

/** worktree 目录绝对路径（<zswRoot>/wt-<subagentId>）。 */
function wtDir(subagentId) {
  return path.join(zswRoot(), WT_DIR_PREFIX + subagentId);
}

/**
 * 判断目录是否直接位于 zswRoot 下。git 会把 worktree 路径 realpath 化
 * （macOS /var → /private/var），porcelain 回显的路径可能与 zswRoot() 字串
 * 不同源，先字串比对、失配再 realpath 对账。realpath 的是父目录而非目录本身：
 * 孤儿 worktree 目录可能已被外部删除（元数据仍在），父目录必然存在。
 */
function isUnderZsubRoot(dir) {
  const root = zswRoot();
  const parent = path.dirname(dir);
  if (parent === root) return true;
  try {
    return fs.realpathSync(parent) === fs.realpathSync(root);
  } catch {
    return false; // root 不存在（realpath 失败）→ 其下不可能有 worktree
  }
}

/**
 * 准备隔离 worktree（ports.js WorktreePort.prepare）。
 *
 * 前置校验主树必须干净：dirty 基线上创建的 worktree，patch 应用回主树时基线
 * 错位，且「子 agent 的改动」与「用户未提交改动」无法区分——一开始就拒绝。
 *
 * @param {object} p
 * @param {string} p.mainRepo     主仓库根（主会话 cwd）
 * @param {string} p.slug         用户可读任务名（仅进错误文案，不进路径/分支名）
 * @param {string} p.subagentId   sa-<rand>（目录与分支名的唯一性来源）
 * @returns {Promise<{dir: string, branch: string}>}
 */
async function prepare({ mainRepo, slug, subagentId } = {}) {
  const core = requireCore();
  if (!mainRepo || typeof mainRepo !== 'string') {
    throw new Error('prepare 需要 mainRepo（主仓库根目录）');
  }
  if (!subagentId || !core.isSafeId(subagentId)) {
    throw new Error(
      `subagentId 不合法："${subagentId}"（须匹配 ^[\\w-]+$），拒绝创建 worktree（防路径注入）`,
    );
  }

  const status = await core.gitRun(['status', '--porcelain'], { cwd: mainRepo });
  if (core.isTreeDirty(status)) {
    // 错误信息即恢复指引：给出两条出路 + 诊断上下文，而不是只报状态
    throw new DirtyTreeError(
      `主树 dirty，worktree 基线不可靠：先 commit/stash，或改 worktree:false`
      + `（任务 ${slug || '?'} #${subagentId}，仓库 ${mainRepo}）\n`
      + `git status --porcelain 输出：\n${status.trim()}`,
    );
  }
  const base = (await core.gitRun(['rev-parse', 'HEAD'], { cwd: mainRepo })).trim();

  fs.mkdirSync(zswRoot(), { recursive: true });
  const dir = wtDir(subagentId);
  const branch = BRANCH_NS + subagentId;
  await core.gitRun(['worktree', 'add', dir, '-b', branch], { cwd: mainRepo });

  // [MF#3] 基线侧车：collectPatch 据此覆盖「子 agent 已提交」的改动。
  // 写失败不阻断任务启动（collectPatch 经 core 降级裸 diff，只损失提交增量）。
  try {
    const gitDir = await worktreeGitDir(dir);
    fs.writeFileSync(path.join(gitDir, BASE_MARKER), base + '\n');
  } catch { /* 见上 */ }

  return { dir, branch };
}

/**
 * 收集 worktree 全部改动为 patch（ports.js WorktreePort.collectPatch）。
 * git 执行与降级判定全在 core.collectWorktreePatch；本函数负责锚点注入、
 * patch 落盘收尾（tmp+rename 原子替换）与降级留痕投影。
 *
 * @param {object} p
 * @param {string} p.worktreeDir  prepare 返回的 dir
 * @param {string} p.subagentId   patch 落 outputs/<subagentId>.patch
 * @returns {Promise<{patchFile: string|null, patchIncomplete?: true}>}
 *   patchFile 为 null = 无改动未落盘（调用方据此不回填 record.patchFile）；
 *   patchIncomplete = core 已降级（锚点缺失/损坏/add 失败），patch 不完整，
 *   宿主 outcome 投影必须保留该留痕。
 */
async function collectPatch({ worktreeDir, subagentId } = {}) {
  const core = requireCore();
  if (!worktreeDir || !subagentId) {
    throw new Error('collectPatch 需要 worktreeDir 与 subagentId');
  }

  // [MF#1] outputs/ 与 worktree 是兄弟目录，结构性保证 cleanup 删不到 patch。
  const finalPath = path.join(outputsDir(), `${subagentId}.patch`);
  // tmp 形态与 output-store 原子写一致（.*.tmp 后缀，sweepStaleOutputs 天然排除）
  const tmpPath = path.join(outputsDir(), `.${subagentId}.patch.${process.pid}.${Date.now()}.tmp`);
  fs.mkdirSync(outputsDir(), { recursive: true });

  // 锚点注入：gitdir 解析失败（worktree 元数据损坏）时传空基线 commit——
  // core 判别联合的空串分支即「降级裸 diff + patchIncomplete」入口。
  let anchor;
  try {
    anchor = { kind: 'anchor-file', path: path.join(await worktreeGitDir(worktreeDir), BASE_MARKER) };
  } catch {
    anchor = { kind: 'commit', baseCommit: '' };
  }

  let res;
  try {
    // maxBuffer 32MB：批量重构任务的大 diff 是本通道真实场景（execFile 缺省
    // 1MB 会使 collectWorktreePatch 的 diff 抛 GitRunError，B3/core 8ddd0029
    // 起可透传；恢复旧 GIT_MAX_BUFFER 语义）
    res = await core.collectWorktreePatch({
      worktreePath: worktreeDir, patchFile: tmpPath, anchor,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    // core 抛错（如 diff 超 git 执行缓冲上限）发生在落盘前；tmp 若已存在则清
    try { fs.unlinkSync(tmpPath); } catch { /* 未落盘/已清理 */ }
    throw err;
  }
  if (res.written) fs.renameSync(tmpPath, finalPath);
  return {
    patchFile: res.written ? finalPath : null,
    ...(res.patchIncomplete ? { patchIncomplete: true } : {}),
  };
}

/**
 * 清理 worktree + 分支（ports.js WorktreePort.cleanup）。幂等：worktree 已删/
 * 分支不存在时静默通过（重放安全——reaper 与任务收尾可能各清一次）。
 *
 * @param {object} p
 * @param {string} p.mainRepo
 * @param {string} p.worktreeDir
 * @param {string} [p.branch]  缺省（detached 场景）时跳过分支删除
 */
async function cleanup({ mainRepo, worktreeDir, branch } = {}) {
  const core = requireCore();
  if (!mainRepo || !worktreeDir) {
    throw new Error('cleanup 需要 mainRepo 与 worktreeDir');
  }
  // core cleanupWorktree 无 prune 步：worktree 目录已被外部删除时 remove 会
  // 失败、branch -D 被「used by worktree」拒绝——prune 先行清掉缺失目录的
  // 元数据（在册正常 worktree 不受影响），分支才可删。等值旧三步
  // remove → prune → branch -D 的资源回收语义，任一步失败不阻断其余。
  try {
    await core.gitRun(['worktree', 'prune'], { cwd: mainRepo });
  } catch { /* prune 失败仍继续 */ }
  if (branch) {
    await core.cleanupWorktree({ repo: mainRepo, worktreePath: worktreeDir, branch });
    return;
  }
  // detached 场景（branch 缺省跳过分支删除）：core cleanupWorktree 无条件
  // branch -D，undefined 会碰运气误删同名分支——单步 remove 兜底。
  try {
    await core.gitRun(['worktree', 'remove', '--force', worktreeDir], { cwd: mainRepo });
  } catch { /* 目录已不在/元数据损坏 */ }
}

/**
 * 列孤儿 worktree（reaper 消费）：git worktree list 物理面 × knownSubagentIds
 * 对账（D12）。只认领本 zswRoot 下、wt-<id> 命名的目录——主树与其他工具的
 * worktree 永不触碰；id 在 known 集合（record store 仍认识）的跳过。
 *
 * @param {object} p
 * @param {string} p.mainRepo            只查这个仓库的 worktree（跨仓库互不认领）
 * @param {string[]} [p.knownSubagentIds] 活任务 id 集合（record store 提供）
 * @returns {Promise<Array<{subagentId: string, dir: string, branch: string}>>}
 */
async function listOrphans({ mainRepo, knownSubagentIds = [] } = {}) {
  const core = requireCore();
  if (!mainRepo) throw new Error('listOrphans 需要 mainRepo');

  // core 供原始 porcelain 输出；解析 + realpath 归账是 zsw 布局层职责
  const out = await core.listWorktreePorcelain({ repo: mainRepo });
  // porcelain 格式：空行分块，块首 `worktree <path>`，`branch refs/heads/<name>` 可选
  const entries = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { dir: line.slice('worktree '.length).trim(), branch: null };
    } else if (cur && line.startsWith('branch refs/heads/')) {
      cur.branch = line.slice('branch refs/heads/'.length).trim();
    }
  }
  if (cur) entries.push(cur);

  const known = new Set(knownSubagentIds);
  const orphans = [];
  for (const e of entries) {
    const name = path.basename(e.dir);
    if (!name.startsWith(WT_DIR_PREFIX)) continue;
    if (!isUnderZsubRoot(e.dir)) continue; // 字串失配时 realpath 对账（见函数注释）
    const id = name.slice(WT_DIR_PREFIX.length);
    if (!core.isSafeId(id)) continue; // 非 zsub 命名（wt- 后为空/怪字符）不认领
    if (known.has(id)) continue;
    orphans.push({ subagentId: id, dir: e.dir, branch: e.branch || BRANCH_NS + id });
  }
  return orphans;
}

// DirtyTreeError 不导出（无外部消费者）：调用方以 err.name 字符串识别错误类型
// BRANCH_NS 导出：worktree-adapter 错误文案引用，避免对 'zsub/' 字面量镜像
module.exports = {
  prepare,
  collectPatch,
  cleanup,
  listOrphans,
  BRANCH_NS,
};
