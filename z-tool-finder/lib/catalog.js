/**
 * lib/catalog.js — 工具元数据目录（catalog.json 的读写与预扫描）
 *
 * catalog 是被接管 server 的 tools/list 结果缓存，避免每次会话真实拉起
 * server（DESIGN.md §4）。文件布局：
 *   <dataDir>/catalog.json = { servers: { [serverKey]: { fetchedAt, serverInfo, tools: [...] } } }
 *
 * 预扫描为 daemon 化后台执行（hook 同步路径外），通过 require.main 入口
 * 以独立 node 进程跑 prescan 后落盘退出。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { connect } = require('./mcp-client');
const { withLock, LockHeldError } = require('./registry');

const CATALOG_FILENAME = 'catalog.json';
const WHEN_TO_USE_MAX = 120;
const CATALOG_LOCK_RETRIES = 20; // 撞锁重试次数（临界区毫秒级，50ms 退避 ≈ 最长约 1s）
const CATALOG_LOCK_BACKOFF_MS = 50;

function catalogPath(dataDir) {
  return path.join(dataDir, CATALOG_FILENAME);
}

/**
 * 加载 catalog。不存在或损坏（非法 JSON / 结构不对）返回空 catalog，
 * 不抛错——catalog 只是缓存，损坏即视为未命中，可由预扫描重建。
 */
function loadCatalog(dataDir) {
  const file = catalogPath(dataDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { servers: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.servers && typeof parsed.servers === 'object') {
      return { servers: parsed.servers };
    }
    return { servers: {} };
  } catch {
    return { servers: {} };
  }
}

/**
 * catalog 互斥更新：锁内重读 → 记录级合并 → 落盘。
 * catalog 有三类并发写者（多个 wrapper 进程的 miss 回写、后台 prescan、CLI refresh），
 * 原子 rename 只防半截读不防丢失更新（各自基于旧快照整体覆盖写会互抹记录），
 * 因此统一走此入口，与 registry 同一把锁（catalog 写临界区毫秒级，不与 takeover 长临界区冲突）。
 */
function withCatalogLock(dataDir, mutator) {
  // 撞锁（LockHeldError）重试而非放弃：写者放弃会丢失自己的记录——锁只保证
  // 不互抹损坏，不保证记录不丢；临界区毫秒级，短退避重试即可等到
  let lastErr;
  for (let i = 0; i < CATALOG_LOCK_RETRIES; i++) {
    try {
      return withLock(dataDir, () => {
        const cat = loadCatalog(dataDir);
        const result = mutator(cat);
        saveCatalog(dataDir, cat);
        return result;
      });
    } catch (err) {
      if (!(err instanceof LockHeldError)) throw err;
      lastErr = err;
      // withCatalogLock 被 prescan 子进程在顶层同步调用，Atomics.wait 同步退避即可
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CATALOG_LOCK_BACKOFF_MS);
    }
  }
  throw lastErr;
}

/** 原子写：tmp + rename，防写一半进程死导致 catalog 损坏 */
function saveCatalog(dataDir, cat) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = catalogPath(dataDir);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cat, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** 查单个工具元数据；不存在返回 undefined */
function getTool(cat, serverKey, toolName) {
  const server = cat.servers[serverKey];
  if (!server || !Array.isArray(server.tools)) return undefined;
  return server.tools.find((t) => t && t.name === toolName);
}

/** description 首句截 120 字符作为 whenToUse 默认值（DESIGN.md D7） */
function deriveWhenToUse(description) {
  if (!description) return '';
  // 中文句号后无空格，英文句末通常跟空格——两类断句规则分开处理
  const firstSentence =
    String(description).split(/(?<=[.!?])\s|(?<=[。！？])/)[0] || String(description);
  const s = firstSentence.trim();
  return s.length > WHEN_TO_USE_MAX ? s.slice(0, WHEN_TO_USE_MAX) : s;
}

/** 写入/更新一个 server 的元数据（fetchedAt 取当前时间） */
function upsertServer(cat, serverKey, { serverInfo, tools }) {
  cat.servers[serverKey] = {
    fetchedAt: new Date().toISOString(),
    serverInfo,
    tools: (tools || []).map((t) => ({
      name: t.name,
      whenToUse: deriveWhenToUse(t.description),
      description: t.description || '',
      inputSchema: t.inputSchema,
    })),
  };
  return cat;
}

/** 删除一个 server 条目（不存在时无操作） */
function removeServer(cat, serverKey) {
  delete cat.servers[serverKey];
  return cat;
}

/**
 * 顺序预扫描：逐个 connect → listTools → upsertServer → close。
 * 单个 server 失败不中断其余（返回 failed 列表由调用方决定呈现方式）。
 *
 * @param {object} cat 已加载的 catalog（就地更新）
 * @param {Array<{ key: string, config: object }>} entries
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: string[], failed: Array<{ key: string, error: string }> }>}
 */
async function prescan(cat, entries, { timeoutMs = 30000 } = {}) {
  const ok = [];
  const failed = [];
  for (const { key, config } of entries) {
    let client;
    try {
      client = await connect(config, { timeoutMs });
      const tools = await client.listTools();
      upsertServer(cat, key, { serverInfo: client.serverInfo, tools });
      ok.push(key);
    } catch (err) {
      failed.push({ key, error: err.message });
    } finally {
      // 必须 await：close() 内含 SIGTERM→SIGKILL 升级定时器，不 await 会被
      // 调用方随后的 process.exit 清掉，忽略 SIGTERM 的 server 变孤儿进程
      if (client) await client.close();
    }
  }
  return { ok, failed };
}

/**
 * 后台预扫描：detached spawn 自身（`node catalog.js --prescan <dataDir> <entriesFile>`）。
 * entriesFile（JSON: { entries: [{key, config}], timeoutMs? }）由调用方先原子写好。
 * detached + stdio ignore + unref：父进程退出不影响预扫描完成。
 */
function backgroundPrescan(dataDir, entriesFile) {
  const child = spawn(process.execPath, [__filename, '--prescan', dataDir, entriesFile], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

// require.main 入口：独立进程执行 prescan 并落盘
/* eslint-disable no-console */
if (require.main === module) {
  const [, , mode, dataDirArg, entriesFileArg] = process.argv;
  if (mode !== '--prescan' || !dataDirArg || !entriesFileArg) {
    console.error('用法: node catalog.js --prescan <dataDir> <entriesFile>');
    process.exit(2);
  }
  (async () => {
    const spec = JSON.parse(fs.readFileSync(entriesFileArg, 'utf8'));
    // prescan 耗时可达分钟级，不能在锁内跑：先扫进 scratch，再短临界区合并落盘
    const scratch = { servers: {} };
    const result = await prescan(scratch, spec.entries || [], { timeoutMs: spec.timeoutMs });
    withCatalogLock(dataDirArg, (cat) => {
      Object.assign(cat.servers, scratch.servers);
    });
    console.error(`prescan 完成: ok=${result.ok.join(',')} failed=${result.failed.map((f) => f.key).join(',')}`);
  })().catch((err) => {
    console.error('prescan 失败: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
  });
}

module.exports = {
  loadCatalog,
  saveCatalog,
  withCatalogLock,
  getTool,
  upsertServer,
  removeServer,
  prescan,
  backgroundPrescan,
};
