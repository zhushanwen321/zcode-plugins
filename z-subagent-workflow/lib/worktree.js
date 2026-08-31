'use strict';
/**
 * WorktreePort 实现（DESIGN-v3.md §3.2 D12，契约见 ports.js）：
 * git worktree 文件隔离子系统——纯 git 命令封装，零第三方依赖。
 *
 * ── patch 收集语义（三条铁律，前两条源自 pi worktree-manager 复盘）──
 *
 * [MF#1] patch 必须落在 worktree 目录之外。cleanup 会删整个 worktree 目录，
 *        patch 写在里面 = 随任务结束静默丢失。落盘位置由 output-store.writePatch
 *        固定为 <zswRoot>/outputs/<id>.patch，与 worktree 目录 <zswRoot>/wt-<id>
 *        是兄弟目录，结构性保证互不包含。
 *
 * [MF#2] 新增文件必须进 diff：`git add -A -N`（intent-to-add）给 untracked 文件
 *        写入「空 blob、内容将来补」的 index 条目，git diff 才会吐出其全文；
 *        裸 git diff 完全无视 untracked，子 agent 新建的文件会静默漏出 patch。
 *
 * [MF#3] 已提交改动也必须进 diff：子 agent 受用户全局 AGENTS.md「完成即提交」
 *        约束，在 worktree 分支上 commit 是常态而非边角。prepare 把基线 commit
 *        写进 worktree gitdir 下的侧车文件（不在工作树内、永不进 diff），
 *        collectPatch 据此用 `git diff <base>` 一条命令覆盖：已提交 + 未提交 +
 *        新增文件。侧车缺失/损坏时兜底退回裸 `git diff`（仅未提交改动）。
 *
 * ── 与 pi 蓝本（worktree-manager.ts）的取舍 ──
 * 保留：干净主树前置校验（dirty 基线上的 patch 应用回主树必然错位，一开始就
 *       拒绝）；diff stdout 保真落盘（裁尾换行 = git apply 拒绝的 corrupt
 *       patch）；recordId 白名单防路径注入；cleanup 容错三步（remove → prune
 *       → branch -D，任一步失败不阻断其余，防单步失败导致资源泄漏）。
 * 不搬：全局注册表 + pid 死活判孤儿——zsub 已有跨会话 record store（D9），
 *       孤儿判定改为「git worktree list 物理面 × knownSubagentIds 对账」
 *       （listOrphans）；node_modules 软链（pi 的 monorepo 专属需求）；
 *       per-repo 写命令串行队列（zsub 并发上限 3 且 subagentId 全局唯一，
 *       git 自身 index 锁兜底，写冲突窗口可忽略）。
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { zswRoot } = require('./config');
const { writePatch } = require('./output-store');

/** subagentId 白名单：sa-<rand> 天然满足；防路径注入/分支名注入。 */
const SAFE_ID_RE = /^[\w-]+$/;
/** worktree 目录名前缀（<zswRoot>/wt-<subagentId>），listOrphans 按它认领。 */
const WT_DIR_PREFIX = 'wt-';
/** 分支命名空间（zsub/<subagentId>），统一前缀便于人肉排查。 */
const BRANCH_NS = 'zsub/';
/** 基线 commit 侧车文件名（落 gitdir 下，工作树与 diff 都看不见它）。 */
const BASE_MARKER = 'zsub-base-commit';
/** git 单命令超时：挂死的 git 不能拖住任务完成回调（pi 同款值）。 */
const GIT_TIMEOUT_MS = 30_000;
/** stdout 缓冲上限：大 diff（批量重构任务）可能远超 execFile 默认 1MB。 */
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** git 命令失败包装：message 含 stderr（恢复线索），exitCode/stderr 供诊断。 */
class GitError extends Error {
  constructor(message, props = {}) {
    super(message);
    this.name = 'GitError';
    this.exitCode = props.exitCode;
    this.stderr = props.stderr;
  }
}

/** 主树 dirty：错误文案本身即恢复指引（先 commit/stash，或放弃隔离）。 */
class DirtyTreeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DirtyTreeError';
  }
}

/**
 * git 出口（execFile 不经 shell，参数无注入面）。
 * stdout 原样返回不 trim：diff 落 patch 依赖原始输出（保真）；需要干净文本的
 * 消费点（status / rev-parse）自行 trim。
 */
function git(repoDir, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repoDir, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    }, (err, stdout, stderr) => {
      if (err) {
        const detail = (typeof stderr === 'string' && stderr.trim()) || err.message;
        reject(new GitError(`git -C ${repoDir} ${args.join(' ')} 失败：${detail}`, {
          exitCode: typeof err.code === 'number' ? err.code : undefined,
          stderr: typeof stderr === 'string' ? stderr : undefined,
        }));
        return;
      }
      resolve(stdout);
    });
  });
}

/** worktree 目录绝对路径（<zswRoot>/wt-<subagentId>）。 */
function wtDir(subagentId) {
  return path.join(zswRoot(), WT_DIR_PREFIX + subagentId);
}

/** worktree 的 gitdir（<mainRepo>/.git/worktrees/<id>）绝对路径。 */
async function worktreeGitDir(worktreeDir) {
  const out = (await git(worktreeDir, ['rev-parse', '--git-dir'])).trim();
  // rev-parse 在部分场景返回相对路径，统一 resolve 成绝对
  return path.isAbsolute(out) ? out : path.resolve(worktreeDir, out);
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
  if (!mainRepo || typeof mainRepo !== 'string') {
    throw new GitError('prepare 需要 mainRepo（主仓库根目录）');
  }
  if (!subagentId || !SAFE_ID_RE.test(subagentId)) {
    throw new GitError(
      `subagentId 不合法："${subagentId}"（须匹配 ^[\\w-]+$），拒绝创建 worktree（防路径注入）`,
    );
  }

  const status = (await git(mainRepo, ['status', '--porcelain'])).trim();
  if (status.length > 0) {
    // 错误信息即恢复指引：给出两条出路 + 诊断上下文，而不是只报状态
    throw new DirtyTreeError(
      `主树 dirty，worktree 基线不可靠：先 commit/stash，或改 worktree:false`
      + `（任务 ${slug || '?'} #${subagentId}，仓库 ${mainRepo}）\n`
      + `git status --porcelain 输出：\n${status}`,
    );
  }
  const base = (await git(mainRepo, ['rev-parse', 'HEAD'])).trim();

  fs.mkdirSync(zswRoot(), { recursive: true });
  const dir = wtDir(subagentId);
  const branch = BRANCH_NS + subagentId;
  await git(mainRepo, ['worktree', 'add', dir, '-b', branch]);

  // [MF#3] 基线侧车：collectPatch 据此覆盖「子 agent 已提交」的改动。
  // 写失败不阻断（collectPatch 兜底退回裸 diff，只损失提交增量）。
  try {
    const gitDir = await worktreeGitDir(dir);
    fs.writeFileSync(path.join(gitDir, BASE_MARKER), base + '\n');
  } catch { /* 见上 */ }

  return { dir, branch };
}

/**
 * 收集 worktree 全部改动为 patch（ports.js WorktreePort.collectPatch）。
 *
 * @param {object} p
 * @param {string} p.worktreeDir  prepare 返回的 dir
 * @param {string} p.subagentId   patch 落 outputs/<subagentId>.patch
 * @returns {Promise<string|null>} patch 绝对路径；无改动返回 null
 *   （调用方据此不回填 record.patchFile，避免悬空路径）。
 */
async function collectPatch({ worktreeDir, subagentId } = {}) {
  if (!worktreeDir || !subagentId) {
    throw new GitError('collectPatch 需要 worktreeDir 与 subagentId');
  }

  // [MF#2] intent-to-add 让 untracked 文件以空 blob 进 index，diff 才含其全文。
  // add 失败不致命（pi 同款语义）：继续 diff，最差漏掉新文件，好过整包失败。
  try {
    await git(worktreeDir, ['add', '-A', '-N']);
  } catch { /* 见上 */ }

  // [MF#3] 有基线侧车 → diff <base>（已提交+未提交+新增全覆盖）；
  // 侧车缺失/形态异常 → 裸 diff（仅未提交）。sha 校验防脏侧车打崩 diff。
  let base = null;
  try {
    const gitDir = await worktreeGitDir(worktreeDir);
    const raw = fs.readFileSync(path.join(gitDir, BASE_MARKER), 'utf8').trim();
    base = /^[0-9a-f]{7,40}$/.test(raw) ? raw : null;
  } catch { base = null; }

  // stdout 保真：不 trim，尾换行是 patch 的一部分，裁掉 = git apply 报 corrupt
  const diff = await git(worktreeDir, base ? ['diff', base] : ['diff']);
  if (diff.length === 0) return null;

  // [MF#1] writePatch 固定落 <zswRoot>/outputs/（worktree 的兄弟目录），
  // cleanup 删 worktree 不影响 patch。
  return writePatch(subagentId, diff);
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
  if (!mainRepo || !worktreeDir) {
    throw new GitError('cleanup 需要 mainRepo 与 worktreeDir');
  }
  // 三步各自容错（pi 语义）：任一步失败不阻断其余，防单步失败导致资源泄漏。
  // prune 的必要性：worktree 目录已被外部删除时 remove 会失败，且 branch -D
  // 被「used by worktree」拒绝——prune 清掉缺失目录的元数据后分支才可删。
  try {
    await git(mainRepo, ['worktree', 'remove', '--force', worktreeDir]);
  } catch { /* 目录已不在/元数据损坏：交给 prune 兜底 */ }
  try {
    await git(mainRepo, ['worktree', 'prune']);
  } catch { /* prune 失败仍尝试 branch -D */ }
  if (!branch) return;
  try {
    await git(mainRepo, ['branch', '-D', branch]);
  } catch { /* 分支不存在 = 已清理过 */ }
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
  if (!mainRepo) throw new GitError('listOrphans 需要 mainRepo');

  const out = await git(mainRepo, ['worktree', 'list', '--porcelain']);
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
    if (!SAFE_ID_RE.test(id)) continue; // 非 zsub 命名（wt- 后为空/怪字符）不认领
    if (known.has(id)) continue;
    orphans.push({ subagentId: id, dir: e.dir, branch: e.branch || BRANCH_NS + id });
  }
  return orphans;
}

// GitError/DirtyTreeError 不导出（无外部消费者）：调用方以 err.name 字符串识别错误类型
// BRANCH_NS 导出：worktree-adapter 错误文案引用，避免对 'zsub/' 字面量镜像
module.exports = {
  prepare,
  collectPatch,
  cleanup,
  listOrphans,
  BRANCH_NS,
};
