#!/usr/bin/env bash
# status.sh — 查看本仓库插件在本机 zcode 的 dev/正式版状态，检测冲突：
#   ⚠ 双装（inline + 正式版并存）、✗ 悬空 inline dirs（worktree 已删）、
#   ✗ 孤儿正式版条目（cache 缺失）。只读，不改任何文件、不联网。
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/dev-link-lib.sh"

dl_git_root || { red "不在 git worktree 内（需在 zcode-plugin-workspace 的 worktree 中运行）"; exit 2; }

cli_note="不可达（link/unlink 将跳过 CLI 验证）"
if dl_find_zcode_cli; then cli_note="$DL_ZCODE_CLI"; fi

node -e '
	const fs = require("fs"), path = require("path"), { execSync } = require("child_process");
	const [root, configPath, installedPath, mpClone, mpId, cliNote] = process.argv.slice(1);
	const R = (s) => `\x1b[31m${s}\x1b[0m`, Y = (s) => `\x1b[33m${s}\x1b[0m`, G = (s) => `\x1b[32m${s}\x1b[0m`, B = (s) => `\x1b[1m${s}\x1b[0m`;
	const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

	// 本 worktree 插件映射（SSOT = manifest name）
	const local = [];
	for (const e of fs.readdirSync(root, { withFileTypes: true })) {
		if (!e.isDirectory() || e.name.startsWith(".")) continue;
		const m = readJson(path.join(root, e.name, ".zcode-plugin", "plugin.json"));
		if (!m || !m.name) continue;
		const pkg = readJson(path.join(root, e.name, "package.json"));
		local.push({ name: m.name, dir: path.join(root, e.name), ver: (pkg && pkg.version) || "?" });
	}

	const cfg = readJson(configPath) || {};
	const dirs = (cfg.plugins && cfg.plugins.dirs) || [];
	const installed = ((readJson(installedPath) || {}).plugins || []).filter(p => p.marketplace === mpId);

	const manifestNameOf = (d) => { const m = readJson(path.join(d, ".zcode-plugin", "plugin.json")); return (m && m.name) || null; };
	const inlineFor = (name) => dirs.find(d => {
		const b = d.replace(/\/+$/, "").split("/").pop();
		if (b === name) return true;
		const mn = manifestNameOf(d);
		return mn === name;
	}) || null;
	const installedFor = (name) => installed.find(p => p.name === name) || null;

	console.log(B(`dev-link 状态`) + `  worktree: ${root}`);
	console.log(B("\n■ 本 worktree 插件"));
	for (const p of local) {
		console.log(`  ${p.name}  (v${p.ver})`);
		const inline = inlineFor(p.name);
		const prod = installedFor(p.name);
		if (inline && fs.existsSync(inline)) console.log(`    inline: ${G("✓")} ${inline} [${path.resolve(inline) === path.resolve(p.dir) ? "本worktree" : Y("其他目录")}]`);
		else if (inline) console.log(`    inline: ${R("✗ 悬空目录")} ${inline}`);
		else console.log(`    inline: 无`);
		if (prod) {
			const ok = prod.installPath && fs.existsSync(prod.installPath);
			if (ok) console.log(`    正式版: v${prod.version} (${G("cache ✓")})`);
			else console.log(`    正式版: v${prod.version} (${R("cache ✗ 缺失，孤儿条目")})`);
		} else console.log(`    正式版: 无`);
		if (inline && prod) console.log(`    ${R("⚠ dev/prod 双装（inline 优先加载；link-dev/unlink-dev 可消解）")}`);
	}

	console.log(B("\n■ config.json inline dirs（全量）"));
	if (dirs.length === 0) console.log("  （空）");
	for (const d of dirs) {
		const exists = fs.existsSync(d);
		const mn = manifestNameOf(d);
		console.log(`  ${exists ? " " : R("✗ 悬空")} ${d}  → ${mn ? `${mn}@inline` : "（无 manifest）"}${exists ? "" : R("  worktree 已删？unlink-dev 清理")}`);
	}

	console.log(B(`\n■ 正式版安装记录（${mpId}）`));
	if (installed.length === 0) console.log("  （无）");
	for (const p of installed) {
		const ok = p.installPath && fs.existsSync(p.installPath);
		const dual = inlineFor(p.name);
		console.log(`  ${ok ? " " : R("✗")} ${p.id}  v${p.version}  cache ${ok ? G("✓") : R("缺失")}${dual ? Y("  ⚠ 与 inline 双装") : ""}`);
	}

	console.log(B("\n■ marketplace 源"));
	try {
		const head = execSync(`git -C "${mpClone}" log -1 --format=%h\\ %cs`, { encoding: "utf8" }).trim();
		const mp = readJson(path.join(mpClone, "marketplace.json"));
		const names = ((mp && mp.plugins) || []).map(p => p.name);
		console.log(`  clone: ${mpClone}`);
		console.log(`  HEAD: ${head}，marketplace.json 插件 ${names.length} 个: ${names.join(", ") || "（空）"}`);
		for (const p of local) {
			if (!names.includes(p.name)) console.log(Y(`  ⚠ ${p.name} 在本 worktree 但未发布（unlink-dev 将跳过恢复）`));
		}
	} catch { console.log(R(`  clone 不可读: ${mpClone}`)); }

	console.log(B("\n■ zcode CLI") + `: ${cliNote}`);
' "$DL_GIT_ROOT" "$ZCODE_CONFIG" "$INSTALLED_JSON" "$MP_CLONE" "$MP_ID" "$cli_note"
