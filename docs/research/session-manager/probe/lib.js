'use strict';
// session-manager 探针公共库：NDJSON app-server 客户端 + 双库访问
// 只服务 /tmp/zc-probe/ 下探针脚本，不是产品代码。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const origEmitWarning = process.emitWarning;
process.emitWarning = function (w, ...a) {
  if (String(w).includes('SQLite is an experimental feature')) return;
  return origEmitWarning.call(process, w, ...a);
};
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = origEmitWarning;

const TASKS_INDEX = path.join(os.homedir(), '.zcode/v2/tasks-index.sqlite');
const CLI_DB = path.join(os.homedir(), '.zcode/cli/db/db.sqlite');
const ZCODE_CJS = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const WORKSPACE_PATH = process.env.SZM_WORKSPACE || '/Users/zhushanwen/Code/zcode-plugin-workspace/feat-session-manager';
const PROBE_TAG = '[szm-probe]';

function openTasksIndex({ readonly = true } = {}) {
  const db = new DatabaseSync(TASKS_INDEX, { readOnly: readonly });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function openCliDb() {
  const db = new DatabaseSync(CLI_DB);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

// 引擎 app-server NDJSON 客户端（非 JSON-RPC 2.0；envelope {id,method,params}）
class AppServerClient {
  constructor({ cwd = WORKSPACE_PATH, onNotice } = {}) {
    this.notices = [];
    this.log = [];
    // 从 GUI 设置注入 anthropic 兼容 key（引擎 resolveApiKey 的 env 回退通道）
    const env = { ...process.env };
    try {
      const cfg = JSON.parse(fs.readFileSync(require('os').homedir() + '/.zcode/v2/config.json', 'utf8'));
      const p = cfg.provider && cfg.provider['builtin:bigmodel-coding-plan'];
      if (p && p.options && p.options.apiKey) env.ANTHROPIC_API_KEY = p.options.apiKey;
    } catch {}
    this.child = spawn(process.execPath, [ZCODE_CJS, 'app-server', '--stdio', '--surface', 'desktop'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pending = new Map();
    this.nextId = 1;
    this.secrets = [];
    this.wire = fs.createWriteStream(require('os').tmpdir() + `/zc-probe-wire-${Date.now()}.log`);
    this.exited = false;
    this.exitPromise = new Promise((r) => this.child.on('exit', (c) => { this.exited = true; r(c); }));
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (d) => {
      for (const l of d.toString().split('\n')) if (l.trim()) this.log.push('[stderr] ' + l.slice(0, 300));
    });
    if (onNotice) this.userOnNotice = onNotice;
  }

  handleLine(line) {
    if (line.trim()) this.wire.write('IN ' + line.replace(/[A-Za-z0-9+\/=]{24,}/g, '<REDACTED>') + '\n');
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { this.log.push('[unparsed] ' + line.slice(0, 300)); return; }
    let logged = JSON.stringify(msg);
    for (const sec of this.secrets) if (sec) logged = logged.split(sec).join('<REDACTED>');
    this.log.push('<- ' + logged.slice(0, 1200));
    // 响应（有 id 且带 result/error）
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(String(msg.id));
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(String(msg.id));
        if (msg.error) p.reject(new Error(`[${msg.error.code}] ${msg.error.message}`));
        else p.resolve(msg.result);
      }
      return;
    }
    // 服务端→客户端请求：自动应答
    if (msg.method && typeof msg.id === 'string' && msg.id.startsWith('server-')) {
      if (msg.method === 'session/requestRuntimePreferences') {
        this.respond(msg.id, { nativeSearchEnhancementsEnabled: false });
      } else {
        this.respondError(msg.id, -32601, 'probe: not implemented');
      }
      return;
    }
    // 通知
    this.notices.push(msg);
    if (this.userOnNotice) try { this.userOnNotice(msg); } catch {}
  }

  respond(id, result) { this.sendRaw({ id, result }); }
  respondError(id, code, message) { this.sendRaw({ id, error: { code, message } }); }
  sendRaw(obj) {
    let s = JSON.stringify(obj);
    this.wire.write('OUT ' + s + '\n');
    for (const sec of this.secrets) if (sec) s = s.split(sec).join('<REDACTED>');
    this.log.push('-> ' + s.slice(0, 1200));
    this.child.stdin.write(s + '\n');
  }

  setSecrets(list) { this.secrets = list; }

  request(method, params, timeoutMs = 60000) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout ${timeoutMs}ms waiting ${method} (id=${id})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendRaw({ id, method, params });
    });
  }

  async close() {
    try { this.child.stdin.end(); } catch {}
    await Promise.race([this.exitPromise, new Promise((r) => setTimeout(r, 3000))]);
    if (!this.exited) { try { this.child.kill('SIGKILL'); } catch {} }
  }

  dumpTraffic(limit = 60) {
    return this.log.slice(-limit).join('\n');
  }
}

async function waitSessionSettled(client, sessionId, { timeoutMs = 180000, intervalMs = 2000 } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const res = await client.request('session/list', { workspace: { workspaceKey: WORKSPACE_PATH, workspacePath: WORKSPACE_PATH }, includeArchived: true }, 15000);
    const hit = (res.sessions || []).find((s) => s.sessionId === sessionId);
    last = hit ? hit.status : 'not-found';
    if (!hit) return { status: last };
    if (last !== 'running' && last !== 'waiting') return { status: last };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { status: last, timedOut: true };
}

module.exports = {
  TASKS_INDEX, CLI_DB, ZCODE_CJS, WORKSPACE_PATH, PROBE_TAG,
  openTasksIndex, openCliDb, AppServerClient, waitSessionSettled,
};
