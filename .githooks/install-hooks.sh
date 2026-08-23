#!/bin/bash
# 安装项目 githooks 到当前 worktree（由 .bare/hooks/post-checkout 在 worktree add /
# checkout 时自动调用；也可手动执行：bash .githooks/install-hooks.sh）。
#
# 为什么装到 worktree gitdir（.bare/worktrees/<name>/hooks/）而非共享的 .bare/hooks：
# 各 worktree 可在不同分支——hooks 随分支内容走，切分支即刷新为本分支版本，
# 未合入 .githooks/ 的老分支不受影响。

set -euo pipefail

HOOKS=(pre-commit)
GIT_DIR=$(git rev-parse --git-dir)
TARGET="$GIT_DIR/hooks"
mkdir -p "$TARGET"

for hook in "${HOOKS[@]}"; do
    cp ".githooks/$hook" "$TARGET/$hook"
    chmod +x "$TARGET/$hook"
done

echo "githooks installed: ${HOOKS[*]} -> $TARGET"
