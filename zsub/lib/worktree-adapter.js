'use strict';
/**
 * worktree 适配层：把 manager 的简化 WorktreePort 形态桥接到 lib/worktree.js
 * 的真实现（对象参数 + mainRepo 显式传递）。
 *
 * 为什么需要这一层：manager 面向的端口契约是「prepare/collectPatch/cleanup
 * 三个方法」；S5 真实现的签名需要 mainRepo（git 根）与 subagentId 上下文，
 * 而这两者分别来自调用时的 cwd 与 record——在 manager 内联 git 根解析会让
 * 编排内核背上 git 细节，收进本适配层保持 manager 只依赖端口语义。
 *
 * 职责拆分（谁写 patch 文件）：S5 的 collectPatch 直接落盘 outputs/<id>.patch
 * 并返回路径（含基线 commit 语义，覆盖已提交+未提交+新增三类改动）；
 * manager 侧因此不再自己 writePatch——patch 的产出方只有一处。
 */

const { execFile } = require('node:child_process');
const worktree = require('./worktree');

/** cwd → git 顶层目录。非 git 目录/无 git 时抛可操作错误。 */
function resolveGitRoot(cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        reject(new Error(
          `worktree 任务需要 cwd 位于 git 仓库内（"${cwd}" 不是 git 工作树）。`
          + '恢复指引：在 git 仓库内使用 worktree:true，或不传 worktree。'
        ));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * 创建适配 manager 端口契约的 worktree 实例。
 * 方法签名（manager 消费）：
 *   prepare({slug, subagentId, cwd}) -> {dir, branch, mainRepo}
 *   collectPatch({dir, subagentId})  -> patchFile 路径 | null（无改动）
 *   cleanup({dir, subagentId, meta}) -> {removed:true}（meta=record.worktreeMeta）
 */
function createWorktreeAdapter() {
  return {
    async prepare({ slug, subagentId, cwd }) {
      const mainRepo = await resolveGitRoot(cwd);
      return worktree.prepare({ mainRepo, slug, subagentId });
    },

    async collectPatch({ dir, subagentId }) {
      return worktree.collectPatch({ worktreeDir: dir, subagentId });
    },

    async cleanup({ dir, subagentId, meta }) {
      if (!meta || !meta.branch || !meta.mainRepo) {
        throw new Error(
          `worktree 清理缺少元数据（${dir}）。`
          + `恢复指引：手动执行 git worktree remove --force ${dir} && git branch -D zsub/${subagentId}`
        );
      }
      return worktree.cleanup({ mainRepo: meta.mainRepo, worktreeDir: dir, branch: meta.branch });
    },
  };
}

module.exports = { createWorktreeAdapter, resolveGitRoot };
