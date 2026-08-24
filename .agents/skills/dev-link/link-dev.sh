#!/usr/bin/env bash
# link-dev.sh — 安装本仓库插件的 dev 版（inline）到本地 zcode，并卸载同名正式版（防双装）
#
# 用法：bash .agents/skills/dev-link/link-dev.sh <plugin> [<plugin>...]
#   包名支持 z-subagent-workflow / @zhushanwen/z-subagent-workflow
# 改 ~/.zcode/cli/config.json 后需重启 ZCode 生效（GUI 仅启动时扫描插件配置）。
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/dev-link-lib.sh"

[ $# -ge 1 ] || { red "用法: $0 <plugin> [<plugin>...]"; exit 2; }
dl_git_root || { red "不在 git worktree 内（需在 zcode-plugin-workspace 的 worktree 中运行）"; exit 2; }

FAILED=(); LINKED=(); SKIPPED=(); UNINSTALLED=()

for input in "$@"; do
	name="$(dl_resolve_short_name "$input")"
	bold "== $name =="
	if ! dl_lookup "$name"; then
		red "  ✗ 本 worktree 找不到插件（顶层目录需含 .zcode-plugin/plugin.json，name=${name}）"
		FAILED+=("$name:插件不存在")
		continue
	fi
	echo "  源码: $DL_DIR"

	# ── 冲突检查：inline 已注册到其他目录（跨 worktree 双注册）→ 拒绝 ──
	inline="$(dl_inline_entry_for "$name")"
	if [ -n "$inline" ] && [ "$(cd "${inline%%|*}" 2>/dev/null && pwd)" != "$DL_DIR" ]; then
		red "  ✗ inline 已注册到其他目录: ${inline%%|*}"
		red "    跨 worktree 双注册会互相遮蔽。先执行: bash $SCRIPT_DIR/unlink-dev.sh $name"
		FAILED+=("$name:跨worktree冲突")
		continue
	fi

	# dev/prod 双装防护：正式版在装（含孤儿条目）则先卸载——对所有路径执行，
	# 幂等重跑也能消解 status 报告的双装残留
	installed="$(dl_installed_entry_for "$name")"
	if [ -n "$installed" ]; then
		i_ver="$(printf '%s' "$installed" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(d.version||"?")')"
		dl_uninstall_prod "$name"
		UNINSTALLED+=("$name@$i_ver")
	fi

	# ── 注册 inline（已注册同目录 = 幂等：仅补设 enabledPlugins，修半注册态）──
	if [ -n "$inline" ]; then
		dl_config_register_inline "$name" "$DL_DIR"
		green "  = 已是 inline 注册（本 worktree），幂等跳过"
		SKIPPED+=("$name")
	else
		if dl_config_register_inline "$name" "$DL_DIR"; then
			green "  + 已注册 inline: $name@inline → $DL_DIR"
			LINKED+=("$name")
		else
			red "  ✗ config.json 改写失败（已备份，见 config.json.bak-dev-link-*）"
			FAILED+=("$name:config写失败")
			continue
		fi
	fi
done

# ── 验证（CLI 可达时）：plugins list 应见 <name>@inline 且无正式版残留 ──
if dl_find_zcode_cli && [ ${#LINKED[@]} -gt 0 ]; then
	list_out="$(dl_zcode plugins list 2>/dev/null || true)"
	for n in "${LINKED[@]}"; do
		if printf '%s' "$list_out" | grep -q "^- $n@inline"; then
			green "  ✓ plugins list 确认: $n@inline"
		else
			yellow "  ! plugins list 未见 $n@inline（重启 ZCode 后复查；仍无则看 ~/.zcode/cli/log/）"
		fi
		if printf '%s' "$list_out" | grep -q "$n@$MP_ID"; then
			red "  ✗ 仍检测到正式版 ${n}@${MP_ID}（双装！）"
			FAILED+=("$n:卸载残留")
		fi
	done
fi

echo
bold "汇总"
[ ${#FAILED[@]} -gt 0 ] && { red "失败(${#FAILED[@]}): ${FAILED[*]}"; }
[ ${#UNINSTALLED[@]} -gt 0 ] && echo "卸载正式版(${#UNINSTALLED[@]}): ${UNINSTALLED[*]}"
[ ${#LINKED[@]} -gt 0 ] && green "新 link(${#LINKED[@]}): ${LINKED[*]}"
[ ${#SKIPPED[@]} -gt 0 ] && echo "幂等跳过(${#SKIPPED[@]}): ${SKIPPED[*]}"
[ ${#LINKED[@]} -gt 0 ] && yellow "→ 重启 ZCode 生效（GUI 仅启动时扫描插件配置）"
[ ${#FAILED[@]} -gt 0 ] && exit 1
exit 0
