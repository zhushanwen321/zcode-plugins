/**
 * lib/mcp-client.js — 极简 stdio JSON-RPC MCP 客户端
 *
 * 为什么自实现而不引依赖：仓库红线「零依赖 plain Node CJS」，且只需
 * initialize / tools/list / tools/call 三个方法，SDK 引入成本远超收益。
 *
 * stdout 是 JSON-RPC 通道，因此客户端自身绝不向 stdout 打日志；
 * 底层 server 的 stderr 只收集 ring buffer（最近 4KB）供错误信息引用。
 */
'use strict';

const { spawn } = require('child_process');
const readline = require('readline');

const PROTOCOL_VERSION = '2024-11-05';
const STDERR_RING_BYTES = 4096;

/** 可操作错误信息：原 command + stderr 摘要 + 恢复动作建议 */
function buildErrorMessage(serverDef, action, stderrTail) {
  const cmd = [serverDef.command].concat(serverDef.args || []).join(' ');
  const tail = stderrTail ? `stderr 摘要（最近 ${stderrTail.length} 字符）: ${stderrTail}` : 'stderr 无输出';
  return `${action} 失败: ${cmd}\n${tail}\n建议动作: 先手动启动该 server 验证是否可用，例如运行「${cmd}」观察输出；若不可启动请修正其 command/args/env 配置后重试`;
}

/**
 * 连接一个 stdio MCP server。
 *
 * @param {{ command: string, args?: string[], env?: object }} serverDef
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ serverInfo: object, listTools: () => Promise<Array>, callTool: (name: string, args?: object) => Promise<object>, isDead: () => boolean, close: () => void, stderrTail: () => string }>}
 */
async function connect(serverDef, { timeoutMs = 30000 } = {}) {
  const child = spawn(serverDef.command, serverDef.args || [], {
    env: { ...process.env, ...(serverDef.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(typeof serverDef.cwd === 'string' ? { cwd: serverDef.cwd } : {}),
  });

  let nextId = 1;
  /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
  const pending = new Map();
  let closed = false;
  let dead = false; // 底层进程已退出（无论何种原因）——调用方据此丢弃连接
  let stderrBuf = '';

  // ring buffer：只保留最近 4KB，防止长跑 server 的 stderr 无限增长
  const collectStderr = (chunk) => {
    stderrBuf += chunk;
    if (stderrBuf.length > STDERR_RING_BYTES) stderrBuf = stderrBuf.slice(-STDERR_RING_BYTES);
  };
  child.stderr.on('data', collectStderr);
  // spawn 失败（如 ENOENT）会触发 error 事件；无 listener 会抛未捕获异常，
  // 具体 reject 由下方 close 兜底完成，这里只吞掉事件
  child.on('error', () => {});

  const stderrTail = () => stderrBuf;

  /** 发送请求并挂 pending；超时只 reject 该请求，不杀进程（close 才杀） */
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error(buildErrorMessage(serverDef, `MCP 请求 ${method}`, 'client 已关闭')));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(buildErrorMessage(serverDef, `MCP 请求 ${method} 超时（${timeoutMs}ms）`, stderrTail())));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  /** 进程退出：所有未决请求全部 reject（server 崩溃/被 kill 时调用方不能挂死） */
  const failAllPending = (err) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    pending.clear();
  };

  const lineReader = readline.createInterface({ input: child.stdout });
  lineReader.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 非 JSON 行（server 混入调试输出）直接忽略
    }
    if (msg.id === undefined) return; // notification，client 侧无需处理
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(buildErrorMessage(serverDef, `MCP 请求 id=${msg.id}`, `${msg.error.message || ''} | ${stderrTail()}`)));
    else entry.resolve(msg.result);
  });

  // 用 close 而非 exit：close 在 stdio 流 flush 后触发，能拿到崩溃前最后一段 stderr
  child.on('close', () => {
    dead = true;
    failAllPending(new Error(buildErrorMessage(serverDef, 'MCP server 进程提前退出', stderrTail())));
  });

  /** kill + 清理 pending。幂等。pending 必须显式 reject：
   *  若只清不 reject，in-flight 请求 promise 永不 settle（failAllPending 挂在
   *  'close' 事件上，此刻 pending 已被清空），调用方只能靠自身超时兜底 */
  const close = () => {
    if (closed) return;
    closed = true;
    failAllPending(new Error(buildErrorMessage(serverDef, 'client 主动关闭（空闲回收/退出）', stderrTail())));
    child.kill();
  };

  try {
    const initResult = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'z-tool-finder-mcp-client', version: '0.1.0' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return {
      serverInfo: initResult.serverInfo,
      listTools: () => request('tools/list', {}).then((r) => (r && r.tools) || []),
      callTool: (name, args) => request('tools/call', { name, arguments: args || {} }),
      isDead: () => dead,
      close,
      stderrTail,
    };
  } catch (err) {
    close();
    throw err;
  }
}

module.exports = { connect };
