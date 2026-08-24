#!/usr/bin/env bash
# unlink-dev.sh — 移除本仓库插件的 inline dev 注册，并恢复 zcode 中的正式版
#   正式版未发布（marketplace.json 不在列）则跳过安装，仅移除 dev 注册。
#
# 用法：bash .agents/skills/dev-link/unlink-dev.sh <plugin> [<plugin>...]
# 恢复 = 模拟 GUI 安装（zcode CLI 无 install 子命令）：更新 marketplace clone →
#   按 files 白名单复制插件到 cache → 写 installed_plugins.json → plugins list 验证，失败回滚。
# 改配置后需重启 ZCode 生效。
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/dev-link-lib.sh"

[ $# -ge 1 ] || { red "用法: $0 <plugin> [<plugin>...]"; exit 2; }
dl_git_root || { red "不在 git worktree 内（需在 zcode-plugin-workspace 的 worktree 中运行）"; exit 2; }

FAILED=(); RESTORED=(); UNLINKED=(); NOT_PUBLISHED=(); SKIPPED=()

for input in "$@"; do
	name="$(dl_resolve_short_name "$input")"
	bold "== $name =="

	# ── 1. 移除 inline 注册（未注册不算错：可能本来就用正式版）──────────
	inline="$(dl_inline_entry_for "$name")"
	if [ -n "$inline" ]; then
		i_dir="${inline%%|*}"
		if dl_config_remove_inline "$name"; then
			green "  - 已移除 inline 注册: $i_dir"
			UNLINKED+=("$name")
		else
			red "  ✗ config.json 改写失败（已备份，见 config.json.bak-dev-link-*）"
			FAILED+=("$name:config写失败")
			continue
		fi
	else
		echo "  = 无 inline 注册"
	fi

	# ── 2. 防重复：正式版已安装且 cache 完整 → 幂等跳过 ────────────────
	installed="$(dl_installed_entry_for "$name")"
	if [ -n "$installed" ]; then
		i_ver="$(printf '%s' "$installed" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(d.version||"?")')"
		i_path="$(printf '%s' "$installed" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(d.installPath||"")')"
		if [ -n "$i_path" ] && [ -d "$i_path" ]; then
			green "  = 正式版已安装（${name}@${MP_ID} ${i_ver}），幂等跳过"
			SKIPPED+=("$name")
			continue
		fi
		yellow "  ! 安装记录存在但 cache 缺失（孤儿条目），重装修复"
	fi

	# ── 3. 更新 marketplace clone（失败降级本地现状）──────────────────
	dl_marketplace_refresh

	# ── 4. 发布判据：clone 的 marketplace.json 在列 = 已发布 ───────────
	mp_entry="$(dl_marketplace_entry "$name" || true)"
	if [ -z "$mp_entry" ]; then
		yellow "  ○ 未发布（marketplace.json 不含 ${name}），不安装正式版"
		NOT_PUBLISHED+=("$name")
		continue
	fi
	mp_src_dir="${mp_entry#*|}"   # marketplace source 相对目录名

	# 版本：clone 内插件 package.json 为权威，fallback marketplace.json 条目 version
	clone_plugin_dir="$MP_CLONE/$mp_src_dir"
	if [ ! -d "$clone_plugin_dir" ]; then
		red "  ✗ marketplace 在列但 clone 缺目录: $clone_plugin_dir"
		FAILED+=("$name:clone缺目录")
		continue
	fi
	version="$(node -e '
		const fs = require("fs");
		try { process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version || ""); }
		catch { process.stdout.write(""); }
	' "$clone_plugin_dir/package.json" 2>/dev/null || true)"
	if [ -z "$version" ]; then version="${mp_entry%%|*}"; fi
	if [ -z "$version" ] || [ "$version" = "?" ]; then
		red "  ✗ 版本未知（clone 内 package.json 与 marketplace.json 均无 version），无法定位 cache 目录"
		FAILED+=("$name:版本未知")
		continue
	fi
	echo "  恢复版本: ${version}（源: marketplace clone）"

	# ── 5. 模拟安装：复制 files 白名单 → cache；写 installed 条目 ───────
	dest="$MP_CACHE/$name/$version"
	if dl_copy_plugin_to_cache "$clone_plugin_dir" "$dest"; then
		green "  + 已复制插件文件 → $dest"
	else
		red "  ✗ 复制失败（files 白名单项缺失？对照插件 package.json files 与 check-pack）"
		FAILED+=("$name:复制失败")
		continue
	fi

	now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
	uuid="$(uuidgen 2>/dev/null || node -e 'console.log(crypto.randomUUID?.() || Math.random().toString(36).slice(2))')"
	entry_json="$(node -e '
		const [name, mpId, ver, dest, now, uuid, src] = process.argv.slice(1);
		process.stdout.write(JSON.stringify({
			id: `${name}@${mpId}`, name, marketplace: mpId, version: ver,
			installPath: dest, installedAt: now, updatedAt: now,
			scope: "user", source: `./${src}`, cacheTransactionId: uuid,
		}));
	' "$name" "$MP_ID" "$version" "$dest" "$now" "$uuid" "$mp_src_dir")"
	if ! dl_installed_upsert "$entry_json"; then
		red "  ✗ installed_plugins.json 写入失败"
		rm -rf "$dest"
		FAILED+=("$name:installed写失败")
		continue
	fi

	# ── 6. 验证闭环：plugins list 必须显示正式版，失败自动回滚 ─────────
	if dl_find_zcode_cli; then
		if dl_zcode plugins list 2>/dev/null | grep -q "^- $name@$MP_ID"; then
			green "  ✓ plugins list 确认: $name@$MP_ID [$version]"
		else
			red "  ✗ plugins list 未见 ${name}@${MP_ID}，自动回滚"
			# upsert 前状态 = dl_installed_upsert 内部刚写的最新备份
			installed_bak="$(ls -t "$INSTALLED_JSON".bak-dev-link-* 2>/dev/null | head -1 || true)"
			if [ -n "$installed_bak" ]; then
				cp "$installed_bak" "$INSTALLED_JSON"
			else
				rm -f "$INSTALLED_JSON"   # 原本无此文件（upsert 创建），回滚到不存在
			fi
			rm -rf "$dest"
			red "    已回滚 installed_plugins.json 与 cache。兜底：ZCode GUI → Discover 搜 $name 手动安装"
			FAILED+=("$name:验证失败已回滚")
			continue
		fi
	else
		yellow "  ! zcode CLI 不可达，无法自动验证；重启 ZCode 后确认，异常时 GUI → Discover 手动安装"
	fi
	RESTORED+=("$name@$version")
done

echo
bold "汇总"
[ ${#FAILED[@]} -gt 0 ] && { red "失败(${#FAILED[@]}): ${FAILED[*]}"; }
[ ${#UNLINKED[@]} -gt 0 ] && echo "移除 inline(${#UNLINKED[@]}): ${UNLINKED[*]}"
[ ${#RESTORED[@]} -gt 0 ] && green "恢复正式版(${#RESTORED[@]}): ${RESTORED[*]}"
[ ${#NOT_PUBLISHED[@]} -gt 0 ] && echo "未发布跳过(${#NOT_PUBLISHED[@]}): ${NOT_PUBLISHED[*]}"
[ ${#SKIPPED[@]} -gt 0 ] && echo "幂等跳过(${#SKIPPED[@]}): ${SKIPPED[*]}"
{ [ ${#UNLINKED[@]} -gt 0 ] || [ ${#RESTORED[@]} -gt 0 ]; } && yellow "→ 重启 ZCode 生效（GUI 仅启动时扫描插件配置）"
[ ${#FAILED[@]} -gt 0 ] && exit 1
exit 0
