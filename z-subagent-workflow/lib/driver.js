'use strict';
/**
 * zcode 无头 CLI 驱动器（spawn 机制的最低层，供 runner-spawn.js 消费）。
 *
 * 与 dynamic-workflow 原版 driver.js 的差异（改造，非照抄）：
 * 1. 隔离 HOME 参数化：runHeadless({home,...}) 由调用方传入
 *    （model-router 的 per-model HOME 池 homePoolDir(short)），原版是模块级
 *    固定目录 ~/.zcode/dynamic-workflow/home。
 * 2. 新增 --resume <sessionId>：conversation 续聊轮复用同一隔离 HOME 与会话。
 *    resume 轮不重建 HOME——bootstrap 职责整体移到 prepareRunEnv（model-router），
 *    本模块只导出 bootstrapIsolatedHome 供其调用，运行路径不再每轮重写配置。
 * 3. 防递归标记从 DWF_NESTED 改为 ZSW_NESTED=1（DESIGN-v3 D10）。
 * 4. 超时语义升级：默认 config.DEFAULTS.timeoutMs；SIGTERM → killGraceMs 后
 *    SIGKILL；终态 {status:'timeout', response: stdout 尾部}。同时修复原版
 *    `if (!child.killed)` 守卫导致 SIGKILL 永不触发的 bug（kill() 调用后
 *    killed 恒为 true，改用 close 事件维护的 exited 标志判断）。
 * 5. 结果词汇对齐 RunResult（status: closed/error/timeout/cancelled），并新增
 *    外部 cancel()（终态 cancelled）。原版只有 ok/timedOut 布尔、无取消。
 * 6. stdout/stderr 有界收集（头部 4KB + 尾部 64KB），防超大输出爆内存；
 *    原版无限累加字符串。
 * 7. bootstrapIsolatedHome(home, modelRef) 参数化 + tmp+rename 原子写（并发
 *    场景防 torn write）；删除原版文件中重复定义的 bootstrap 死代码；模型
 *    解析职责移出本模块（lib/model-router.js）。
 *
 * 保留的机制（dynamic-workflow 生产验证，DESIGN-v3 Z9）：
 * - `node <cli> --json --cwd <dir> --mode yolo --prompt <text>` 单轮无头，
 *   stdout 输出单个 JSON：{sessionId, response, usage, ...}。
 * - `--disallowed-tools <a,b>` 是唯一可用的工具限制 flag（B3 实测）——
 *   工具 denylist 的硬约束落点；白名单无对应 flag，只能 prompt 软约束
 *   （见 prompt-builder 工具约束段的分层说明）。
 * - CLI 的 provider 配置固定读 `$HOME/.zcode/cli/config.json`，而 Node 的
 *   os.homedir() 在 POSIX 优先取 $HOME —— 隔离 HOME 即独立 provider。
 * - `--max-turns` / `--allowed-tools` / `--settings` 虽在 help 列出但解析器
 *   拒收（help 漂移），不要使用。
 * - stdin 置 /dev/null（stdio: 'ignore'）：CLI 不读 stdin，防止子进程等待
 *   输入挂起。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

/** spawn 模式唯一支持的 provider（bootstrap 只写它的凭据，见 model-router）。 */
const PROVIDER_ID = 'builtin:bigmodel-coding-plan';

/** 错误信息里保留的 stdout 尾部长度：够诊断、不刷屏。 */
const ERROR_TAIL_CHARS = 2000;

/** 每次 spawn 时重读 env：ZSW_ZCODE_CLI 的测试覆盖与运行时更换 CLI 都能生效。 */
function resolveZcodeCli() {
  return process.env.ZSW_ZCODE_CLI || config.ZCODE_CLI;
}

/**
 * 有界行缓冲：逐行收集，保留头部 headLimit + 尾部 tailLimit 字节，中间丢弃。
 * 为什么逐行：超限丢弃以「行」为单位，头部与尾部各自的文本保持可读；
 * 为什么有界：zcode 输出的 response 可达数十 KB，无上限累加会在长任务下
 * 爆内存（原版 driver 的隐患）。代价：单行 JSON 超过尾部窗口时无法完整
 * 解析——按错误路径处理（错误信息带尾部），内存安全优先。
 */
function createBoundedLineBuffer({ headLimit = 4096, tailLimit = 64 * 1024 } = {}) {
  let pending = '';        // 还没遇到换行的片段
  let head = '';
  let headFull = false;
  const tailLines = [];
  let tailBytes = 0;
  let droppedBytes = 0;

  function addLine(line) {
    if (!headFull) {
      if (head.length + line.length <= headLimit) { head += line; return; }
      headFull = true;
    }
    tailLines.push(line);
    tailBytes += line.length;
    // 超出尾部窗口：从最旧的行开始丢
    while (tailBytes > tailLimit && tailLines.length > 1) {
      const dropped = tailLines.shift();
      tailBytes -= dropped.length;
      droppedBytes += dropped.length;
    }
    // 单行超过整个尾部窗口：只保留该行结尾（JSON 的错误信息通常在末尾）
    if (tailBytes > tailLimit && tailLines.length === 1) {
      const over = tailBytes - tailLimit;
      tailLines[0] = tailLines[0].slice(over);
      tailBytes -= over;
      droppedBytes += over;
    }
  }

  function flushPending() {
    if (pending) { addLine(pending); pending = ''; }
  }

  return {
    push(chunk) {
      pending += chunk;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        addLine(pending.slice(0, nl + 1));
        pending = pending.slice(nl + 1);
      }
    },
    flush: flushPending,
    text() {
      flushPending();
      const mid = droppedBytes > 0
        ? `\n[zsub] 输出过长，头尾之间已丢弃 ${droppedBytes} 字节\n`
        : '';
      return head + mid + tailLines.join('');
    },
    tail(n) {
      const t = this.text();
      return t.length > n ? t.slice(t.length - n) : t;
    },
  };
}

/** 容错解析 stdout：正常是单个 JSON 文档；混入日志行则截取首尾大括号间内容。 */
function parseStdoutJson(stdout) {
  const trimmed = stdout.trim();
  try { return JSON.parse(trimmed); } catch { /* 继续容错 */ }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch { return null; }
  }
  return null;
}

/**
 * 初始化隔离 HOME 的 provider 配置（由 model-router.prepareRunEnv 按需调用）。
 *
 * - 只写 {model, provider}，刻意不含 plugins 块：D10 第二重门禁——subagent
 *   进程在隔离 HOME 下不加载任何插件（包括 zsub 自身），物理隔断递归。
 * - tmp+rename 原子写：多进程/并发 bootstrap 下读者永远看到完整文件。
 * - bootstrap 不在 runHeadless 的运行路径上：apiKey 刷新由 prepareRunEnv 的
 *   mtime 比对触发，resume 轮不重建 HOME。
 *
 * @param {string} home    隔离 HOME 目录（如 homePoolDir('GLM-5.3')）
 * @param {string} modelRef 已校验的模型全名（provider/model）
 * @throws 源 v2 config 缺 provider 配置时给出可操作错误
 */
function bootstrapIsolatedHome(home, modelRef) {
  if (!home || typeof home !== 'string') {
    throw new Error('driver.bootstrapIsolatedHome: home 必填（隔离 HOME 目录）。');
  }
  if (!modelRef || typeof modelRef !== 'string') {
    throw new Error(`driver.bootstrapIsolatedHome: modelRef 必填（收到 ${JSON.stringify(modelRef)}）。恢复指引：先经 ModelRouter.resolve() 得到模型全名。`);
  }

  let providerEntry = null;
  try {
    const v2 = JSON.parse(fs.readFileSync(config.V2_CONFIG_PATH, 'utf8'));
    providerEntry = v2?.provider?.[PROVIDER_ID] || null;
  } catch { providerEntry = null; }
  if (!providerEntry || !providerEntry?.options?.apiKey) {
    throw new Error(
      `未在 ${config.V2_CONFIG_PATH} 找到 ${PROVIDER_ID} 的 provider 配置（含 apiKey）。` +
      `恢复指引：先在 ZCode 桌面端登录并配置 BigModel Coding Plan，或手动把 provider 条目写入该文件后重试。`
    );
  }

  const cliDir = path.join(home, '.zcode', 'cli');
  const configPath = path.join(cliDir, 'config.json');
  fs.mkdirSync(cliDir, { recursive: true });
  const payload = JSON.stringify(
    { model: { main: modelRef }, provider: { [PROVIDER_ID]: providerEntry } },
    null, 2
  );
  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, configPath);
  } finally {
    // rename 成功后 tmp 已不存在；失败时清残留，避免污染 HOME 目录
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 尽力清理 */ }
  }
  return { configPath, home, model: modelRef };
}

/**
 * 运行一次无头 zcode 单轮（或 --resume 续聊一轮）。
 *
 * @param {object} opts
 * @param {string} opts.home             隔离 HOME（必填：缺省会落真实 ~/.zcode）
 * @param {string} opts.cwd              运行目录
 * @param {string} opts.prompt           完整 prompt（resume 轮即消息文本）
 * @param {string} [opts.resumeSessionId] 续聊目标 session（不重建 HOME）
 * @param {number} [opts.timeoutMs]      缺省 config.DEFAULTS.timeoutMs
 * @param {string[]} [opts.disallowedTools] 工具 denylist（MUST_FIX-3 硬约束）：
 *        逗号连接进 `--disallowed-tools` flag（B3 实测可用）。空数组/非数组
 *        不加 flag。白名单（allowlist）无 flag 通道（--allowed-tools 拒收），
 *        由 prompt-builder 软约束——硬约束只做 denylist。
 * @param {object} [opts.env]            额外 env（HOME 与 ZSW_NESTED 由本函数强制注入）
 * @returns {Promise<RunResult> & {pid: number|null, cancel(): boolean}}
 *          cancel()：SIGTERM → killGraceMs → SIGKILL，终态 {status:'cancelled'}；
 *          已结束时调用返回 false。Promise 永不 reject（失败即 error 终态）。
 */
function runHeadless(opts = {}) {
  const { home, cwd, prompt, resumeSessionId, env: extraEnv } = opts;
  if (!home || typeof home !== 'string') {
    throw new Error('driver.runHeadless: home 必填（隔离 HOME）。不传会让子进程落到真实 ~/.zcode，破坏用户配置。');
  }
  if (!cwd) throw new Error('driver.runHeadless: cwd 必填（任务运行目录）。');
  if (prompt == null || prompt === '') throw new Error('driver.runHeadless: prompt 必填。');

  const timeoutMs = opts.timeoutMs ?? config.DEFAULTS.timeoutMs;
  const killGraceMs = config.DEFAULTS.killGraceMs;
  const cli = resolveZcodeCli();
  const args = ['--json', '--cwd', cwd, '--mode', 'yolo'];
  // denylist 硬约束：非空数组才落 flag（防御性过滤——CLI 对空值行为未定义，
  // 不赌）。逗号连接是 flag 的既定格式（B3 实测）。
  const disallowed = Array.isArray(opts.disallowedTools)
    ? opts.disallowedTools.filter((t) => typeof t === 'string' && t.trim() !== '')
    : [];
  if (disallowed.length > 0) args.push('--disallowed-tools', disallowed.join(','));
  if (resumeSessionId) args.push('--resume', String(resumeSessionId));
  args.push('--prompt', String(prompt));

  const outBuf = createBoundedLineBuffer();
  const errBuf = createBoundedLineBuffer({ headLimit: 0, tailLimit: 4096 });

  let childRef = null;
  let settled = false;
  let exited = false;
  let killReason = null; // 'timeout' | 'cancel'（谁先触发谁定终态）
  let timeoutTimer = null;
  let graceTimer = null;

  const killChain = () => {
    if (!childRef || exited) return;
    try { childRef.kill('SIGTERM'); } catch { /* 已退出 */ }
    clearTimeout(graceTimer);
    // 宽限后强杀：node CLI 可能在收尾钩子里拖延。不能用 child.killed 判断
    // （SIGTERM 调用后即恒 true，原版在此处有死代码 bug），用 exited 判断。
    graceTimer = setTimeout(() => {
      if (!exited) { try { childRef.kill('SIGKILL'); } catch { /* 已退出 */ } }
    }, killGraceMs);
  };

  const run = new Promise((resolve) => {
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      resolve(result);
    };

    try {
      childRef = spawn('node', [cli, ...args], {
        // HOME 权威值来自 home 参数（extraEnv 里同名键也不许覆盖）；
        // ZSW_NESTED 是防递归硬性注入（D10 第一重门禁）
        env: { ...process.env, ...extraEnv, HOME: home, ZSW_NESTED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({
        status: 'error',
        error: `无法启动 zcode CLI（${cli}）: ${err.message}。恢复指引：用 ZSW_ZCODE_CLI 环境变量指向有效 CLI 路径后重试。`,
      });
      return;
    }

    timeoutTimer = setTimeout(() => {
      killReason = killReason || 'timeout';
      killChain();
    }, timeoutMs);

    childRef.stdout.on('data', (d) => outBuf.push(String(d)));
    childRef.stderr.on('data', (d) => errBuf.push(String(d)));

    childRef.on('error', (err) => {
      finish({
        status: 'error',
        error: `无法运行 zcode CLI（${cli}）: ${err.message}。恢复指引：确认 CLI 存在可执行，或用 ZSW_ZCODE_CLI 指定路径。`,
      });
    });

    childRef.on('close', (code) => {
      exited = true;
      outBuf.flush();
      errBuf.flush();
      if (killReason === 'cancel') {
        return finish({ status: 'cancelled', response: outBuf.tail(ERROR_TAIL_CHARS) });
      }
      if (killReason === 'timeout') {
        return finish({
          status: 'timeout',
          error: `运行超时（${timeoutMs}ms，SIGTERM 后 ${killGraceMs}ms SIGKILL）。恢复指引：调大 timeoutMs 或拆小任务。`,
          response: outBuf.tail(ERROR_TAIL_CHARS),
        });
      }
      if (code !== 0) {
        return finish({
          status: 'error',
          error: `zcode CLI 退出码 ${code}: ${errBuf.tail(800) || outBuf.tail(800)}`,
          response: outBuf.tail(ERROR_TAIL_CHARS),
        });
      }
      const parsed = parseStdoutJson(outBuf.text());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return finish({
          status: 'error',
          error: `无法解析 zcode --json 输出。stdout 尾部: ${outBuf.tail(500)}；stderr 尾部: ${errBuf.tail(500)}`,
        });
      }
      finish({
        status: 'closed',
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
        response: typeof parsed.response === 'string' ? parsed.response : '',
        usage: parsed.usage || null,
      });
    });
  });

  // spawn 在 Promise executor 内同步完成，pid 立即可用；
  // cancel 供 runner 的 RunHandle.cancel 复用同一杀进程链。
  run.pid = childRef ? childRef.pid : null;
  run.cancel = () => {
    if (settled || !childRef) return false;
    killReason = killReason || 'cancel';
    killChain();
    return true;
  };
  return run;
}

module.exports = {
  runHeadless,
  bootstrapIsolatedHome,
  createBoundedLineBuffer,
  resolveZcodeCli,
  PROVIDER_ID,
};
