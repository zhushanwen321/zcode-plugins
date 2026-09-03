'use strict';
/**
 * zflow workflow 引用契约（D-4/D-E3）+ 创作闭环（W8 / D-6）共享实现（MF-1 收口）。
 *
 * 为什么在 lib/ 而非 bin/zsw.js：这些函数是 CLI（bin/zsw.js；1.x 还有
 * dist/mcp/server.js 的 zflow handler，已随 MCP 壳退役）入口共用的业务实现——入口模块只做
 * argv/帧解析的薄壳，业务实现寄生在 CLI 入口会让 MCP 入口反向 require 另一
 * 入口模块取逻辑（入口职责倒挂）。镜像 lib/zsub-actions.js 的收口模式：
 * 实现落 lib，两入口从这里导入，单一来源防漂移；core 管线调用保持单源
 * （lib/core-ref 单一解析点）。
 */

const path = require('node:path');
const os = require('node:os');
const coreRef = require('./core-ref');
const { BUILTIN_WORKFLOW_NAMES, buildKnownWorkflowNames, ensureConfigured } = require('./orchestration-host');

/** zsw 宿主的 workflow 脚本创作目录布局（D-6 目录参数化注入）：saved = ~/.zsw/workflows（与 orchestration-host 的 discoveryRoots 注入根同目录——save 落盘即进发现面）；tmp = saved/.tmp（core「saved 根下 .tmp」约定同构，单层扫描天然不可见——必须 save 后才可 run）。 */
function workflowScriptDirs() {
  const savedDir = path.join(os.homedir(), '.zsw', 'workflows');
  return { tmpDir: path.join(savedDir, '.tmp'), savedDir };
}

/**
 * 判定原语统一（C17）：ref 合法性全部经 core normalizeWorkflowRef（同步）——
 * 路径分支（~/ 展开 + ".." 拒收 + .js 严格后缀）与裸名分支（knownNames 命中）
 * 都是 core 口径，本函数只做 script: 前缀前置拦截（D-4 既有裁决，错误消息
 * 现契约逐字保留）与 reason → 文案映射。
 *
 * knownNames 参数（可选）：内置 5 名 + 发现面 saved 名，由 lib/orchestration-host
 * 的 buildKnownWorkflowNames 异步构建（CLI 入口 await 后传入，cwd 口径与 host
 * 的 ctx.cwd 同源——⛔D：同一目录集三入口产出同一集）。saved 裸名放行 =
 * D-E3 裁决（known 命中即合法）。run 入口（CLI buildWorkflowRunParams；1.x
 * daemon socket 面亦然，已随 MCP 壳退役）均已 await 全量
 * knownNames 后传入；单参形态（knownNames 缺省回落内置 5 名）保留为防御位
 * （同步签名不变：async 化会让未 await 的调用把非法 ref 变 unhandled
 * rejection 崩 daemon）。
 */
function validateWorkflowRef(workflow, knownNames) {
  const w = typeof workflow === 'string' ? workflow.trim() : '';
  if (w === '') {
    throw new Error('run 需要 workflow（内置名、已保存脚本名或 .js 绝对路径，~/ 前缀可展开）。恢复指引：可用清单先经 scripts action 查询。');
  }
  if (w.startsWith('script:')) {
    throw new Error(invalidWorkflowRefMessage(w, `"${w}" 带已废弃的 script: 前缀`));
  }
  const verdict = coreRef.requireCore().normalizeWorkflowRef(w, { knownNames: knownNames || BUILTIN_WORKFLOW_NAMES });
  if (verdict.kind === 'path') return w;
  if (verdict.kind === 'name') return verdict.name;
  // U2：reason → 文案映射。parent_segment（含 ".." 段）单独点名真实拒绝原因
  // （安全语义拒绝），不再混入「不是 .js 脚本路径」——后者只对应路径形态
  // 问题（bad_ext / not_absolute），对齐 core agent 线 invalidAgentRefMessage
  // 的 without ".." path segments 口径与设计 §3.1。
  const why = verdict.reason === 'parent_segment'
    ? `"${w}" 路径段 ".." 不允许（workflow 引用须为不含 ".." 段的 .js 绝对路径）`
    : verdict.reason === 'bad_ext' || verdict.reason === 'not_absolute'
      ? `"${w}" 不是 .js 脚本路径`
      : `"${w}" 不是内置名或已保存脚本名`;
  throw new Error(invalidWorkflowRefMessage(w, why));
}

/** Invalid workflow ref 报错总文案（why 插值；cli/server 两面用例锁定的 token：Invalid workflow ref / script: 前缀 / 绝对路径 / 恢复指引）。 */
function invalidWorkflowRefMessage(w, why) {
  return `Invalid workflow ref：${why}。workflow 引用仅接受内置名（${BUILTIN_WORKFLOW_NAMES.join(' / ')}）、`
    + '已保存脚本名（scripts 清单）或 .js 绝对路径（支持 ~/ 前缀展开）。恢复指引：自定义脚本路径见 '
    + 'scripts action 清单的 path 字段，或注入段 <available_workflows> 的 <location>。';
}

/** script-* action 的 name 参数校验（core 直接拼 `${name}.js` 落盘——含分隔符会写目录之外，入口拦下）。 */
function requireScriptActionName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (n === '') {
    throw new Error('script-* action 需要 name（脚本名，非空字符串）。');
  }
  if (n.includes('/') || n.includes('\\') || n.startsWith('.')) {
    throw new Error(`非法脚本名 "${n}"：须是单段文件名（不含路径分隔符、不以点开头）——落盘目录由 zsw 布局决定。`);
  }
  return n;
}

/** script-generate action：core 五道闸校验管线（ESM 拒/meta 必需/agent() 必需/语法/@pi-meta round-trip）+ tmp 落盘。失败报错与 pi 侧 core 管线逐字同源（round-trip 闸含行列），不改动只转 throw。 */
function scriptGenerateAction(name, script) {
  const n = requireScriptActionName(name);
  if (typeof script !== 'string' || script.trim() === '') {
    throw new Error('script-generate 需要 script（完整 JS 源码字符串：@pi-meta 块 + top-level agent()）。');
  }
  const core = coreRef.requireCore();
  const { tmpDir, savedDir } = workflowScriptDirs();
  const result = core.generateWorkflowScript(n, script, { tmpDir });
  if (!result.ok) {
    throw new Error(`script-generate 校验未通过: ${result.error}`);
  }
  return {
    name: n,
    path: result.path,
    message: `五道闸校验通过，tmp 已落盘: ${result.path}`,
    guidance: `下一步：固化 --action script-save --name ${n}（tmp → ${savedDir}/）；可先 --action lint --file ${result.path} 复核`,
  };
}

/** script-save action：core saveWorkflow（tmp → ~/.zsw/workflows/，重名拒绝）+ 发现面 invalidate 联动（save 后 scripts 即列出）。 */
async function scriptSaveAction(name) {
  const n = requireScriptActionName(name);
  const core = coreRef.requireCore();
  const { tmpDir, savedDir } = workflowScriptDirs();
  let message;
  try {
    message = await core.saveWorkflow(n, undefined, { tmpDir, savedDir });
  } catch (e) {
    throw new Error(
      `script-save 失败: ${e && e.message || e}。恢复指引：tmp 缺失先 --action script-generate --name ${n} --script "<源码>"；`
      + '重名换名或先 --action script-delete 清理。',
    );
  }
  core.invalidateCache(); // registry invalidate 联动（core 发现当前无进程缓存，防御未来引入）
  const savedPath = path.join(savedDir, `${n}.js`);
  return {
    name: n,
    savedPath,
    message,
    guidance: `运行：--workflow ${savedPath} --task "<任务书>" --workdir <绝对路径>（scripts 清单已可见）`,
  };
}

/**
 * script-delete action：core deleteWorkflow（运行中拒绝——isRunning 由调用方注入：
 * daemon 面用 runningScriptPredicate(wfHost) 拿真实 runs 状态；CLI --local 一次性
 * 进程无 runs 视图，传 undefined 恒放行）+ 发现面 invalidate 联动。
 */
function scriptDeleteAction(name, isRunning) {
  const n = requireScriptActionName(name);
  const core = coreRef.requireCore();
  const { tmpDir, savedDir } = workflowScriptDirs();
  let message;
  try {
    message = core.deleteWorkflow(n, isRunning || (() => false), { tmpDir, savedDir });
  } catch (e) {
    throw new Error(
      `script-delete 失败: ${e && e.message || e}。恢复指引：运行中先 --action abort --id <runId>（list 可查）；`
      + '文件不在时核对名（scripts 清单的 name 即文件名 stem）。',
    );
  }
  core.invalidateCache();
  return { name: n, message };
}

/**
 * 「某脚本名是否正在运行」谓词工厂（V4o）：判定改调 core isScriptRunning——
 * 吃原始 runs Map（run.spec.scriptName + run.state.status 原始字段），不再经
 * host.list() 的 runSummary 投影（投影字段 workflow/status 与原始 spec/state
 * 等值已由 V4o 核对）。数据源 = host._runs（orchestration-host 公开测试/内部
 * 面，daemon 与 CLI --local 各自进程的真实 runs Map；core 谓词是纯函数，无
 * per-session 隔离口径）。host 无 _runs（测试 fake）或 core 调用异常时防御性
 * 回退 false（对齐旧 list() 容错语义：拿不到 runs 视图 = 不拒绝删除）。
 */
function runningScriptPredicate(wfHost) {
  return (name) => {
    try {
      const runs = wfHost && wfHost._runs;
      if (!(runs instanceof Map)) return false;
      return coreRef.requireCore().isScriptRunning(runs, name);
    } catch { return false; }
  };
}

/** CLI 入口的 knownNames 产出面（C17/D-E3）：内置 5 名 + cwd 发现面 saved 名，
 * 与 orchestration-host registry 的 resolveScriptPath 消费同一构建函数——
 * ⛔D knownNames 一致性断言（orchestration-host.test.js）经此对照两入口。
 * U1：入口显式 ensureConfigured（F02 同款惯例）——本导出面可能被未组装 host
 * 的进程直调（socket 面/测试），discoveryRoots 未注入时发现面扫描会静默
 * 缩水 knownNames。幂等（进程级 flag），已配置时零开销。 */
function knownWorkflowNames(cwd) {
  ensureConfigured();
  return buildKnownWorkflowNames(coreRef.requireCore(), cwd);
}

module.exports = {
  validateWorkflowRef,
  knownWorkflowNames,
  scriptGenerateAction,
  scriptSaveAction,
  scriptDeleteAction,
  runningScriptPredicate,
  // bin/zsw.js 组帧逻辑（workflowDaemonParams 的 script-save/delete 缺参校验）消费
  requireScriptActionName,
};
