#!/usr/bin/env bash
# dev-link-lib.sh — dev-link skill 共享库（link-dev / unlink-dev / status 统一 source）
#
# 管理本仓库插件在「worktree dev 版（inline）」与「正式版（marketplace 安装）」之间切换。
# 数据面（全部实测 zcode 0.16.5，来源见 local-dev-guide.md 与 zcode-guide:diagnosing-plugins）：
#   inline dev 版  ~/.zcode/cli/config.json → plugins.dirs[] + plugins.enabledPlugins["<name>@inline"]
#   正式版安装记录 ~/.zcode/cli/plugins/installed_plugins.json（条目 id = <name>@zcode-plugin-workspace）
#   正式版文件    ~/.zcode/cli/plugins/cache/zcode-plugin-workspace/<name>/<version>/
#   marketplace 源 ~/.zcode/cli/plugins/marketplaces/zcode-plugin-workspace/（gitee main 分支 shallow clone）
#
# 插件映射 SSOT = 各插件 .zcode-plugin/plugin.json 的 name 字段，扫描 worktree 顶层动态构建。
# 兼容 macOS 自带 bash 3.2（无关联数组）。

ZCODE_HOME="$HOME/.zcode"
ZCODE_CONFIG="$ZCODE_HOME/cli/config.json"
PLUGINS_DIR="$ZCODE_HOME/cli/plugins"
INSTALLED_JSON="$PLUGINS_DIR/installed_plugins.json"
MP_ID="zcode-plugin-workspace"
MP_CLONE="$PLUGINS_DIR/marketplaces/$MP_ID"
MP_CACHE="$PLUGINS_DIR/cache/$MP_ID"
MARKETPLACE_ID_GLOB="/Applications/ZCode.app/Contents/Resources/*/zcode.cjs"

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }

# ── 定位 worktree 根（bare repo + worktree 模式，多 worktree 友好）─────
dl_git_root() {
	DL_GIT_ROOT="${DL_GIT_ROOT:-}"
	if [ -z "$DL_GIT_ROOT" ]; then
		DL_GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
	fi
	[ -n "$DL_GIT_ROOT" ]
}

# ── 探测 zcode CLI（不在 PATH；app 内 zcode.cjs，glob 兼容版本目录名漂移）──
# 结果缓存到 DL_ZCODE_CLI；找不到返回 1（调用方降级处理，不硬失败）。
dl_find_zcode_cli() {
	if [ -n "${DL_ZCODE_CLI+x}" ]; then
		[ -n "$DL_ZCODE_CLI" ] && return 0 || return 1
	fi
	DL_ZCODE_CLI=""
	if command -v zcode >/dev/null 2>&1; then
		DL_ZCODE_CLI="zcode"
	elif compgen -G "$MARKETPLACE_ID_GLOB" >/dev/null; then
		local c
		for c in $MARKETPLACE_ID_GLOB; do
			[ -f "$c" ] && { DL_ZCODE_CLI="$c"; break; }
		done
	fi
	[ -n "$DL_ZCODE_CLI" ]
}

# zcode CLI 执行器（探测失败时跳过并提示降级）
dl_zcode() {
	if dl_find_zcode_cli; then
		if [ "$DL_ZCODE_CLI" = "zcode" ]; then
			zcode "$@"
		else
			node "$DL_ZCODE_CLI" "$@"
		fi
	else
		yellow "  ! zcode CLI 未找到（PATH 无 zcode 且 $MARKETPLACE_ID_GLOB 不存在），跳过: zcode $*"
		return 127
	fi
}

# ── 插件映射：扫描 worktree 顶层有 .zcode-plugin/plugin.json 的目录 ────
# 输出行格式：name|abs_dir|version（version 取插件 package.json，缺失为空）
dl_build_mapping() {
	dl_git_root || return 1
	node -e '
		const fs = require("fs"), path = require("path");
		const root = process.argv[1];
		const out = [];
		for (const e of fs.readdirSync(root, { withFileTypes: true })) {
			if (!e.isDirectory() || e.name.startsWith(".")) continue;
			const manifest = path.join(root, e.name, ".zcode-plugin", "plugin.json");
			if (!fs.existsSync(manifest)) continue;
			let name, version = "";
			try { name = JSON.parse(fs.readFileSync(manifest, "utf8")).name; } catch { continue; }
			try { version = JSON.parse(fs.readFileSync(path.join(root, e.name, "package.json"), "utf8")).version || ""; } catch {}
			if (!name) continue;
			out.push([name, path.join(root, e.name), version].join("|"));
		}
		process.stdout.write(out.join("\n"));
	' "$DL_GIT_ROOT"
}

# ── 包名解析：z-subagent-workflow / @zhushanwen/z-subagent-workflow → 短名 ──
dl_resolve_short_name() {
	local input="$1"
	if [[ "$input" == @zhushanwen/* ]]; then
		echo "${input#@zhushanwen/}"
	else
		echo "$input"
	fi
}

# ── 查表：短名 → 事实（结果存 DL_NAME / DL_DIR / DL_VER）───────────────
dl_lookup() {
	local short="$1"
	if [ -z "${DL_MAPPING:-}" ]; then
		DL_MAPPING="$(dl_build_mapping || true)"
	fi
	local line
	line=$(printf '%s\n' "$DL_MAPPING" | grep "^${short}|" | head -1)
	[ -n "$line" ] || return 1
	DL_NAME="${line%%|*}"
	DL_DIR="$(echo "$line" | cut -d'|' -f2)"
	DL_VER="$(echo "$line" | cut -d'|' -f3)"
	return 0
}

# ── JSON 文件安全编辑基础设施 ─────────────────────────────────────────
# 所有 JSON 写入：改前备份（bak-dev-link-<ts>）→ node parse/mutate/stringify → tmp + rename 原子写。
# mutate 脚本从 stdin 读入，argv 透传；脚本内抛错 = 中止未写（原文不动）。
dl_backup() {
	local file="$1"
	[ -f "$file" ] || return 0
	cp "$file" "$file.bak-dev-link-$(date +%Y%m%d-%H%M%S)"
}

dl_json_edit() {
	local file="$1" script="$2"; shift 2
	node -e '
		const fs = require("fs");
		const [file, script] = process.argv.slice(1, 3);
		const args = process.argv.slice(3);
		let obj;
		try { obj = JSON.parse(fs.readFileSync(file, "utf8")); }
		catch (e) { console.error(`JSON 解析失败，中止不改写: ${file}: ${e.message}`); process.exit(1); }
		eval(script);
		const tmp = file + ".tmp-dev-link";
		fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
		fs.renameSync(tmp, file);
	' "$file" "$script" "$@"
}

# ── inline 注册态读取：输出 dir|enabled（未注册输出空）─────────────────
# 匹配规则：dirs 项的 basename == name，或该项下 manifest name == name（跨自定义路径准确归因）；
# 目录悬空时 fallback basename 匹配，保证悬空也能被 unlink 清理。
dl_inline_entry_for() {
	local name="$1"
	[ -f "$ZCODE_CONFIG" ] || return 0
	node -e '
		const fs = require("fs");
		const [file, name] = process.argv.slice(1);
		const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
		const plugins = cfg.plugins || {};
		const dirs = plugins.dirs || [];
		let dir = dirs.find(d => {
			if (path_basename(d) === name) return true;
			try { return JSON.parse(fs.readFileSync(d + "/.zcode-plugin/plugin.json", "utf8")).name === name; }
			catch { return false; }
		});
		function path_basename(p) { return p.replace(/\/+$/, "").split("/").pop(); }
		if (!dir) { process.stdout.write(""); process.exit(0); }
		const enabled = ((plugins.enabledPlugins || {})[name + "@inline"] === true) ? "true" : "false";
		process.stdout.write(dir + "|" + enabled);
	' "$ZCODE_CONFIG" "$name"
}

# 注册 inline：dirs 追加（去重）+ enabledPlugins["<name>@inline"]=true
dl_config_register_inline() {
	local name="$1" dir="$2"
	dl_backup "$ZCODE_CONFIG"
	[ -f "$ZCODE_CONFIG" ] || echo '{}' > "$ZCODE_CONFIG"
	dl_json_edit "$ZCODE_CONFIG" '
		obj.plugins = obj.plugins || {};
		obj.plugins.dirs = obj.plugins.dirs || [];
		if (!obj.plugins.dirs.includes(args[0])) obj.plugins.dirs.push(args[0]);
		obj.plugins.enabledPlugins = obj.plugins.enabledPlugins || {};
		obj.plugins.enabledPlugins[args[1] + "@inline"] = true;
	' "$dir" "$name"
}

# 移除 inline：dirs 去掉匹配项（basename 或 manifest name 归因）+ enabledPlugins 删 key
dl_config_remove_inline() {
	local name="$1"
	dl_backup "$ZCODE_CONFIG"
	dl_json_edit "$ZCODE_CONFIG" '
		const fs = require("fs");
		const name = args[0];
		if (obj.plugins) {
			if (Array.isArray(obj.plugins.dirs)) {
				obj.plugins.dirs = obj.plugins.dirs.filter(d => {
					const basename = d.replace(/\/+$/, "").split("/").pop();
					if (basename === name) return false;
					try { return JSON.parse(fs.readFileSync(d + "/.zcode-plugin/plugin.json", "utf8")).name !== name; }
					catch { return true; }
				});
			}
			if (obj.plugins.enabledPlugins) delete obj.plugins.enabledPlugins[name + "@inline"];
		}
	' "$name"
}

# ── 正式版安装记录读取：输出条目 JSON（无输出 = 未安装）───────────────
dl_installed_entry_for() {
	local name="$1"
	[ -f "$INSTALLED_JSON" ] || return 0
	node -e '
		const fs = require("fs");
		const [file, name, mpId] = process.argv.slice(1);
		const doc = JSON.parse(fs.readFileSync(file, "utf8"));
		const hit = (doc.plugins || []).find(p => p.name === name && p.marketplace === mpId);
		if (hit) process.stdout.write(JSON.stringify(hit));
	' "$INSTALLED_JSON" "$name" "$MP_ID"
}

# 删除正式版条目（手写降级路径用；CLI uninstall 优先）
dl_installed_remove() {
	local name="$1"
	dl_backup "$INSTALLED_JSON"
	[ -f "$INSTALLED_JSON" ] || return 0
	dl_json_edit "$INSTALLED_JSON" '
		if (Array.isArray(obj.plugins)) obj.plugins = obj.plugins.filter(p => !(p.name === args[0] && p.marketplace === args[1]));
	' "$name" "$MP_ID"
}

# 写入/替换正式版条目（按 id 去重，追加到数组尾）
dl_installed_upsert() {
	local entry_json="$1"
	dl_backup "$INSTALLED_JSON"
	[ -f "$INSTALLED_JSON" ] || echo '{"version":1,"plugins":[]}' > "$INSTALLED_JSON"
	dl_json_edit "$INSTALLED_JSON" '
		obj.version = obj.version || 1;
		obj.plugins = Array.isArray(obj.plugins) ? obj.plugins : [];
		const entry = JSON.parse(args[0]);
		obj.plugins = obj.plugins.filter(p => p.id !== entry.id);
		obj.plugins.push(entry);
	' "$entry_json"
}

# ── 正式版卸载：CLI 优先，不可达时手写等价（删条目 + rm cache + rm data 标记）──
dl_uninstall_prod() {
	local name="$1" id="$1@$MP_ID"
	if dl_find_zcode_cli; then
		if dl_zcode plugins uninstall "$id" --force >/dev/null 2>&1; then
			green "  + 已卸载正式版（zcode CLI）: $id"
		else
			yellow "  ! zcode CLI 卸载失败，回退手写清理"
			dl_uninstall_prod_manual "$name"
		fi
	else
		dl_uninstall_prod_manual "$name"
	fi
	# 闭环验证：条目必须已消失（CLI 行为异常时手写补删）
	if [ -n "$(dl_installed_entry_for "$name")" ]; then
		dl_installed_remove "$name"
		yellow "  ! CLI 卸载后条目仍在，已手写补删"
	fi
}

dl_uninstall_prod_manual() {
	local name="$1"
	dl_installed_remove "$name"
	rm -rf "$MP_CACHE/$name"
	rm -rf "$PLUGINS_DIR/data/$name@$MP_ID"
	green "  + 已卸载正式版（手写清理）: $name@$MP_ID"
}

# ── marketplace clone 更新（gitee 直连；失败降级本地现状）──────────────
dl_marketplace_refresh() {
	[ -d "$MP_CLONE/.git" ] || { yellow "  ! marketplace clone 不存在: ${MP_CLONE}（无法恢复正式版）"; return 1; }
	if git -C "$MP_CLONE" fetch --depth 1 origin main >/dev/null 2>&1 \
		&& git -C "$MP_CLONE" reset --hard FETCH_HEAD >/dev/null 2>&1; then
		return 0
	fi
	yellow "  ! marketplace clone 更新失败（网络？），降级使用本地现状（版本可能落后）"
	return 0
}

# marketplace.json 中插件是否在列（在列 = 已发布）；在列输出 `条目version|源目录名`
dl_marketplace_entry() {
	local name="$1" mp_json="$MP_CLONE/marketplace.json"
	[ -f "$mp_json" ] || return 1
	node -e '
		const fs = require("fs");
		const [file, name] = process.argv.slice(1);
		const mp = JSON.parse(fs.readFileSync(file, "utf8"));
		const hit = (mp.plugins || []).find(p => p.name === name);
		if (!hit) process.exit(1);
		const src = typeof hit.source === "string" ? hit.source.replace(/^\.\//, "") : "";
		process.stdout.write((hit.version || "") + "|" + src);
	' "$mp_json" "$name"
}

# ── 按 files 白名单复制插件目录到 cache（npm 发布面语义，与 check-pack 一致）──
# package.json 恒包含（npm 语义）；白名单项支持 "dir/"（递归）与 "path"（文件）。
dl_copy_plugin_to_cache() {
	local src_dir="$1" dest_dir="$2"
	node -e '
		const fs = require("fs"), path = require("path");
		const [srcDir, destDir] = process.argv.slice(1);
		const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, "package.json"), "utf8"));
		const files = ["package.json", ...(pkg.files || [])];
		fs.rmSync(destDir, { recursive: true, force: true });
		fs.mkdirSync(destDir, { recursive: true });
		for (const f of files) {
			const clean = f.replace(/\/+$/, "");
			const from = path.join(srcDir, clean);
			if (!fs.existsSync(from)) { console.error("files 白名单项缺失: " + f); process.exit(1); }
			const to = path.join(destDir, clean);
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.cpSync(from, to, { recursive: true });
		}
	' "$src_dir" "$dest_dir"
}
