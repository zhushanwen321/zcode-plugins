#!/usr/bin/env node
'use strict';
/**
 * zsw CLI 薄壳（决策位③入口之二，D13）：与 MCP server 共用 lib/assemble
 * 的同一 manager 组装。定位：
 *   1. 人类调试与脚本化（不需要 LLM，直接驱动九 action + workflow 六面）
 *   2. bash 增强通道留位：本命令可被 Bash run_in_background 包裹——
 *      CLI 进程被引擎跟踪，完成时触发原生 task-notification（独立 turn
 *      唤醒 + goal gate，Z4/Z6 语义）。这是 TaskNotificationNotifier
 *      （NotifierPort 预留第三实现）的天然入口，启用后 mailbox 的
 *      「下次活动才注入」边界在此通道不复存在。
 *
 * 与 --local 模式的差异（如实声明；--local = 本地一次性执行，调试后门）：
 * --local 下 CLI 是一次性进程，start 与 message 一律阻塞到本轮完成再退出——
 * 进程退出即丢失后台执行体（轮死、record 卡 running、outputs/通知永不产生），
 * 且无常驻组件会接管 --local 启动的任务（server 的 recover 只在启动时跑，
 * 只会把 running 标成孤儿，不会收尾）。日常用法（默认，即 daemon 模式）执行体
 * 由 daemon 持有；bash run_in_background 等待场景用 wait/start --wait——
 * CLI 阻塞进程成为引擎进程内 background task，完成即原生通知。
 *
 * 用法（1.0.0 起：默认 = daemon thin client；--local 显式本地执行）：
 *   node bin/zsw.js start --task "<任务书>" --slug <短名> [--agent <.md绝对路径>]
 *        （agent 仅收 .md 绝对路径，支持 ~/ 展开——传名字会被拒并给路径指引
 *         （报错与 core agent-registry 同源）；缺省不传 = 加载 vendored
 *         general-purpose 内置角色（project 级同名可遮蔽），不想要角色请显式
 *         传自定义 .md 路径。路径清单先查 zsw agents 的 location/file 列）
 *        [--model <短名>] [--schema <json或文件路径>] [--worktree]
 *        [--conversation] [--timeout-ms <n>] [--wait]
 *        [--thinking <low|high|max>]
 *        [--allow-tools <逗号分隔工具名>] [--deny-tools <逗号分隔工具名>]
 *        （--thinking：spawn 单轮通道不消费该请求值，终态 record 落
 *         thinking="null (spawn 降级)" 如实标注；--allow-tools：无白名单
 *         flag 通道不消费，终态 record 落 toolsNote 如实标注；--deny-tools：
 *         与 agent .md frontmatter disallowedTools 并集去重后落引擎
 *         --disallowed-tools flag 硬生效）
 *   node bin/zsw.js wait --id <id> [--id <id2> ...] [--timeout-ms <n>]
 *        （等待由 daemon 内存挂起到终态，零轮询；--timeout-ms 到点返回
 *         partial 结果，exit 2）
 *   node bin/zsw.js list
 *   node bin/zsw.js status --id <subagentId>
 *   node bin/zsw.js message --id <subagentId> --text "<续聊消息>"（投递即回，完成经 wait 收）
 *   node bin/zsw.js cancel --id <subagentId>
 *   node bin/zsw.js close --id <subagentId>
 *   node bin/zsw.js workflow [--action <run|abort|status|list|scripts|lint|script-generate|script-save|script-delete>]
 *        --workflow <内置名|.js绝对路径（~/ 可展开）> --task "<任务/目标>" --workdir <绝对路径>
 *        [options]（--action 缺省 = run；workflow 引用契约（D-4）：script:<名> 与
 *        裸名已废弃拒收，自定义脚本只收绝对路径——报错自带恢复指引）
 *        abort/status/list/scripts/script-save/script-delete 管理面默认经 daemon
 *        （zflow 同源，MF1）；run/lint/script-generate 恒本地（run 执行体 = CLI
 *        进程，bg 包裹即原生通知——设计 v5 决策；lint/generate 纯文件操作无
 *        状态）；script-generate/save/delete 为 W8 创作闭环（D-6：core 管线，
 *        落盘目录 = zsw 宿主布局 ~/.zsw/workflows）；
 *        --local = 全 action 本地一次性执行（无 daemon 依赖，调试用）。
 *        （回接 2b：workflow 编排 = vendored subagent-core orchestration，
 *        旧 reviewers sugar / max-concurrent / timeout-per-phase /
 *        subtask-count 已废弃——详见 workflow 子命令 usage）
 *   以上子命令加 --local 走本地一次性执行（无 daemon 依赖，调试用）。
 *   node bin/zsw.js hook session-start
 *        （SessionStart hook 入口，恒本地不经 daemon，不适用 --local：stdout
 *         输出资源快照协议 JSON；嵌套环境或任一异常降级 {} + exit 0，绝不
 *         阻断会话启动。引擎注册面用 bin/zsw-hook.js；本子命令仅调试）
 *
 * wait exit code（MF4）：partial（等待超时未全完成）→ 2；results 任一条为
 * 失败终态（cancelled/error/timeout/lost）→ 1；全完成 → 0（closed，或
 * conversation 任务的 idle——本轮完成即可收，完成集合见 lib/wait-handler.js）。
 *
 * daemon 模式（DESIGN-v4 D5/D7，默认形态）：经 unix socket thin client 连
 * 常驻 daemon（sock 默认 ~/.zcode/zsw/daemon.sock，ZSW_SOCK 可覆盖）：
 * start/list/status/message/cancel/close 组 zsub action params 后单请求单
 * 响应往返；执行体由 daemon 持有（CLI 退出不丢），start 默认异步启动，
 * --wait 为 sugar（start 成功后自动追发 wait 透传终态，D4）。daemon 不在
 * 场时报错给恢复指引（§5.2），不静默降级 --local（防语义漂移）。
 *
 * 输出：stdout 一律 JSON（人读加 | jq）；workflow run 默认输出 markdown 报告
 * + run 摘要 JSON 两段（--json 只出 JSON）；进度与诊断走 stderr。exit 0 = 成功。
 */

const path = require('node:path');
const os = require('node:os');
const { assembleManager } = require('../lib/assemble');
const { callDaemon } = require('../lib/cli-client');
const { TERMINAL_STATUSES } = require('../lib/record-store');
const coreRef = require('../lib/core-ref');
const { BUILTIN_WORKFLOW_NAMES } = require('../lib/orchestration-host');

function usage(exitCode = 1) {
  process.stderr.write(
    '用法见文件头注。示例：\n'
    + '  node bin/zsw.js start --task "审查 README" --slug review\n'
    + '  node bin/zsw.js list\n'
    + '  node bin/zsw.js status --id sa-xxxx\n'
    + '  node bin/zsw.js message --id sa-xxxx --text "补充重点"\n'
    + '  node bin/zsw.js workflow 2>&1 | head -40   # workflow 子命令完整用法\n'
    + '  node bin/zsw.js workflow --action list      # 管理面默认走 daemon（--local 本地）\n'
    + '  node bin/zsw.js list                          # 默认走常驻 daemon（socket thin client）\n'
    + '  node bin/zsw.js agents                        # 可用 agent .md 清单（vendored 内置 + 四根；start 只收路径，先查 location/file 列）\n'
    + '  node bin/zsw.js models                        # 可用模型清单（默认 provider，路由决策前查）\n'
    + '  node bin/zsw.js models --all                  # 全 provider 视图（模型为全名 <provider>/<model>）\n'
    + '  node bin/zsw.js hook session-start           # SessionStart hook 快照输出（异常降级 {}）\n'
    + '  node bin/zsw.js start --wait --task "..." --slug x   # start + 挂起等待 sugar\n'
    + '  node bin/zsw.js wait --id sa-xxxx [--id sa-yyyy] [--timeout-ms 60000]\n'
    + '                                                   # daemon 侧挂起等待；部分完成 exit 2\n'
    + '  node bin/zsw.js list --local                  # 本地一次性执行（调试后门）\n'
  );
  process.exit(exitCode);
}

/** 极简 flag 解析：--key value / --bool（无值 flag）。 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

function csv(v) {
  return typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}

/**
 * F4 值必填 flag 的缺值规整：parseArgs 对「--flag 后无值」产 true（布尔形态），
 * 与「显式给了值」不可同路处理——缺值属用户输入错误，stderr warn + 忽略该参数
 * （容错不失败，与 D5 非法档位 warn 跳过同语义），不静默丢弃。
 */
function requireFlagValue(name, hint, v) {
  if (v !== true) return v;
  process.stderr.write(`[zsw] --${name} 需要${hint}。已忽略该参数。\n`);
  return undefined;
}

function thinkingArg(v) {
  const s = requireFlagValue('thinking', '档位值（如 --thinking low）', v);
  if (s === undefined) return undefined;
  const t = String(s).trim();
  return t || undefined;
}

function csvArg(name, v) {
  return csv(requireFlagValue(name, `逗号分隔的工具名清单（如 --${name} "Bash,WebSearch"）`, v));
}

/** start 面新 flag → manager.start params（daemon 与 --local 两形态共用，防漂移）。 */
function startCapabilityArgs(args) {
  return {
    thinking: thinkingArg(args.thinking),
    allowTools: csvArg('allow-tools', args.allowTools),
    denyTools: csvArg('deny-tools', args.denyTools),
  };
}

// ------------------------------------------------------ workflow 子命令

/** workflow 九 action（与 zflow 语义层 action 枚举同源；script-* 三 action 为 W8 创作闭环）。 */
const WORKFLOW_ACTIONS = ['run', 'abort', 'status', 'list', 'scripts', 'lint', 'script-generate', 'script-save', 'script-delete'];

function workflowUsage(exitCode = 1) {
  process.stderr.write(
    'zsw workflow：workflow 编排与管理（vendored subagent-core orchestration，经'
    + ' lib/orchestration-host.js；状态面 = <zsw 数据根>/workflow-state/，不再写 zsw record）\n'
    + '\n'
    + '用法:\n'
    + '  node bin/zsw.js workflow [--action <run|abort|status|list|scripts|lint|script-generate|script-save|script-delete>] [options]\n'
    + '  （--action 缺省 = run；abort/status/list/scripts/script-save/script-delete 管理面\n'
    + '   默认经 daemon thin client（zflow 同源）；run/lint/script-generate 恒本地；\n'
    + '   --local = 全 action 本地一次性执行）\n'
    + '\n'
    + 'run（默认）—— 同步等待完成并输出报告（CLI 一次性进程无后台模式，\n'
    + '  异步 runId 走 socket 面后用 status 查询）:\n'
    + '  --workflow <ref>           内置名（chain / parallel / map-reduce /\n'
    + '                            scatter-gather / review-fix-loop）或 .js 绝对路径\n'
    + '                            （~/ 前缀可展开）。script:<名> 与裸名（非内置）\n'
    + '                            已废弃拒收——路径取 scripts 清单的 path 字段\n'
    + '  --task <text>             任务描述（必填；parallel 场景作为 target 回退，\n'
    + '                            review-fix-loop 场景作为 target 回退）\n'
    + '  --workdir <path>          工作目录（必填，绝对路径——agent() 调用的 cwd）\n'
    + '  --model <name>            RunSpec.model（短名或 provider 全名；\n'
    + '                            传错会列出可用清单）\n'
    + '  --timeout-ms <ms>         workflow 整体墙钟预算（RunSpec.budgetTimeMs；不设则无限制）\n'
    + '  --json                    只输出 run 摘要 JSON（默认 markdown 报告 + 摘要两段）\n'
    + '\n'
    + '  per-workflow 选项:\n'
    + '  --perspectives "a,b,c"    parallel：分析视角（默认 security,performance,maintainability）\n'
    + '  --items <json数组|a,b,c>  map-reduce：待处理条目，如 \'["a","b"]\' 或 a,b,c\n'
    + '  --operation <text>        map-reduce：对每个 item 做什么\n'
    + '  review-fix-loop（批次外环：batch1..batchN 串行，批内 review→聚合→fix→重审到 clean）:\n'
    + '  --batch1 "<refs>"         批次执行者：agent .md 绝对路径（逗号分隔多 agent）。\n'
    + '                            batch2、batch3… 连续编号同形态；至少传一个\n'
    + '                            batchN（无 agent .md 时改用自定义脚本——.js 绝对\n'
    + '                            路径引用，可经 script-generate 创作）\n'
    + '  --batch-names "a,b"       批次命名（数量须与批次数一致，缺省 batch-1..N）\n'
    + '  --target-type <t>         审查目标类型 git-diff|file|dir|text（默认 text）\n'
    + '  --target <text>           审查目标（必填：git-diff 传 base ref 如 main、\n'
    + '                            file/dir 传路径、text 传描述）\n'
    + '  --review-target <text>    老参数 sugar：等价 --target-type text --target <text>\n'
    + '  --max-rounds <n>          每批最大轮数（默认 10，≥1）\n'
    + '  --stuck-threshold <n>     连续 N 轮 must-fix 不降判 stuck（默认 3）\n'
    + '  --skip-clean-agents [b]   clean 审查者跳过不派（默认 true；传 false 关闭）\n'
    + '  --recheck-after-fix [b]   fix 后重派全批，上一轮 clean 的走限定复检\n'
    + '                            （默认 false，clean 持续跳过）\n'
    + '  --converge-new-issues <n> 收敛判定：每轮新发现上限（默认 1）\n'
    + '  --converge-rounds <n>     收敛判定：连续 N 轮达标即收敛（默认 2）\n'
    + '  --max-fix-attempts <n>    同一问题回归 N 次后判 needs-redesign（默认 2）\n'
    + '  --aggregator-model <ref>  聚合阶段模型（缺省跟随 run 模型）\n'
    + '  --review-prompt <text>    追加到每个审查者 prompt 的补充指令\n'
    + '  --fix-prompt <text>       追加到修复者 prompt 的补充指令\n'
    + '  --fallow-scan [b]         先跑 fallow 静态扫描前置批（仅 --target-type git-diff 合法；\n'
    + '                            默认 false）\n'
    + '  --auto-commit [b]         允许修复者提交改动（默认 false，改动留给用户）\n'
    + '\n'
    + '  已废弃 flags（显式报错或 warning，不静默）:\n'
    + '  --reviewers               报错：core 契约批次值 = agent .md 路径（用 --batch1）\n'
    + '  --max-concurrent / --timeout-per-phase / --subtask-count\n'
    + '                            warning：core 编排无对应面，已忽略\n'
    + '\n'
    + 'abort / status / list / scripts / script-save / script-delete（管理面：默认经\n'
    + '  daemon，zflow 同源；--local 本地）:\n'
    + '  --id <runId>              abort/status 必填：wf- 前缀的 run id（list 可查；\n'
    + '                            abort 后状态落 aborted）\n'
    + 'list:                       全部 workflow run（精简视图；done run 内存保留\n'
    + '                            有上限，淘汰后读 stateFile）\n'
    + 'scripts:                    vendored 内置 5 + 用户脚本（core 发现面 + .zsw 根）\n'
    + 'script-save:\n'
    + '  --name <脚本名>           tmp → ~/.zsw/workflows/ 固化（重名拒绝；固化后\n'
    + '                            scripts 清单可见、run 按绝对路径引用）\n'
    + 'script-delete:\n'
    + '  --name <脚本名>           删 tmp 或已固化脚本（运行中拒绝——daemon 侧 runs\n'
    + '                            真实状态裁决；--local 下本地进程无 runs 视图，\n'
    + '                            恒放行，仅调试用）\n'
    + 'lint / script-generate（恒本地：纯文件校验/写盘，无共享进程态）:\n'
    + '  --file <脚本路径>         lint 校验脚本（core lintScript：agent() 入口等契约）\n'
    + '  --name <脚本名>           script-generate 必填（单段文件名，不含路径分隔符）\n'
    + '  --script "<JS 源码>"      script-generate 必填（完整源码：@pi-meta 块 +\n'
    + '                            top-level agent()；core 五道闸校验 = ESM 拒/\n'
    + '                            meta 必需/agent() 必需/语法/@pi-meta round-trip，\n'
    + '                            非法报错与 pi 侧同源、round-trip 含行列）\n'
    + '\n'
    + '进度打 stderr；exit 0 = 成功（run 以 reason=completed 判定）。zcode CLI 路径（core 引擎）可用 XYZ_ZCODE_CLI 覆盖。\n'
  );
  process.exit(exitCode);
}

/**
 * --flag 布尔解析：parseArgs 的无值 flag 形态给 true，--flag true/false 字符串
 * 归一为布尔；其余值（拼错等）原样返回让 workflow 入口的 coerceBool 走默认值。
 */
function parseBoolFlag(v) {
  if (v === true) return true;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

/** --items 双形态：JSON 数组（'["a","b"]'）优先，逗号分隔（a,b,c）回退。 */
function parseItems(v) {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const s = v.trim();
  if (s.startsWith('[')) {
    const arr = JSON.parse(s); // 非法 JSON 直接抛 → main catch 输出致命错误
    if (!Array.isArray(arr)) throw new Error('--items 的 JSON 必须是字符串数组');
    return arr.map(String);
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function requireRunIdArg(args) {
  if (typeof args.id !== 'string' || args.id.trim() === '') {
    process.stderr.write('缺少 --id <runId>（wf- 前缀，list 可查）\n');
    workflowUsage(1);
  }
  return args.id;
}

// ------------------- workflow 引用契约（D-4）+ 创作闭环（W8 / D-6）共享实现
//
// 为什么在 bin/zsw.js 而非 lib/orchestration-host.js：W8 领地 = CLI 与 MCP/daemon
// 两入口面（host 层不在领地）。script-* 三 action 与引用契约校验由 CLI 本地路径
// 与 daemon socket 面（dist/mcp/server.js 的 zflow handler 经 require 消费本导出）
// 共用同一实现，防两入口漂移；core 管线调用保持单源（lib/core-ref 单一解析点）。

/** zsw 宿主的 workflow 脚本创作目录布局（D-6 目录参数化注入）：saved = ~/.zsw/workflows（与 orchestration-host 的 discoveryRoots 注入根同目录——save 落盘即进发现面）；tmp = saved/.tmp（core「saved 根下 .tmp」约定同构，单层扫描天然不可见——必须 save 后才可 run）。 */
function workflowScriptDirs() {
  const savedDir = path.join(os.homedir(), '.zsw', 'workflows');
  return { tmpDir: path.join(savedDir, '.tmp'), savedDir };
}

/**
 * workflow 引用契约（D-4a，与 pi 平台统一）：合法 = 内置 5 名 或 .js 绝对路径
 * （~/ 前缀可展开）。script:<名> 与裸名在入口面拒绝——文案与设计 §3.1 失败
 * 路径同源、带恢复指引。host 层（resolveScriptPath）保留按名宽松解析供脚本内
 * 嵌套 workflow() 调用，收紧只拦 CLI/daemon 两消费面（run 的 ref 来自用户输入）。
 */
function validateWorkflowRef(workflow) {
  const w = typeof workflow === 'string' ? workflow.trim() : '';
  if (w === '') {
    throw new Error('run 需要 workflow（内置名或 .js 绝对路径，~/ 前缀可展开）。恢复指引：可用清单先经 scripts action 查询。');
  }
  if (BUILTIN_WORKFLOW_NAMES.includes(w) || w.startsWith('/') || w.startsWith('~/')) return w;
  const why = w.startsWith('script:')
    ? `"${w}" 带已废弃的 script: 前缀`
    : `"${w}" 不是内置名`;
  throw new Error(
    `Invalid workflow ref：${why}。workflow 引用仅接受内置名（${BUILTIN_WORKFLOW_NAMES.join(' / ')}）`
    + '或 .js 绝对路径（支持 ~/ 前缀展开）。恢复指引：自定义脚本路径见 scripts action 清单的 path 字段，'
    + '或注入段 <available_workflows> 的 <location>。',
  );
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

/** 「某脚本名是否正在运行」谓词工厂：消费 host 公开 list()（runSummary 的 workflow = scriptName）。 */
function runningScriptPredicate(wfHost) {
  return (name) => {
    let runs = [];
    try {
      runs = wfHost && typeof wfHost.list === 'function' ? wfHost.list() : [];
    } catch { runs = []; }
    return runs.some((r) => r && r.status === 'running' && r.workflow === name);
  };
}

/** run action 参数面①：必填三参校验（声明顺序即缺参报错的优先级）。 */
function requireWorkflowRunArgs(args) {
  if (!args.workflow) { process.stderr.write('缺少 --workflow\n'); workflowUsage(1); }
  if (!args.task) { process.stderr.write('缺少 --task（必填，自包含任务书）\n'); workflowUsage(1); }
  if (!args.workdir) { process.stderr.write('缺少 --workdir\n'); workflowUsage(1); }
}

/**
 * run action 参数组装（回接 2b）：CLI flag → zflow params 形态（csv→数组、
 * 字符串→数字/布尔），$ARGS 映射 / sugar 裁决 / 废弃 flag 拦截统一在
 * lib/orchestration-host.js 的 normalizeRunParams（单一权威，CLI 不重复实现
 * 映射，防两处漂移）。CLI 只做形态转换与已消费键标记。
 */
function buildWorkflowRunParams(args) {
  // D-4 引用契约入口收紧（CLI 面）：script:/裸名在此拒收，非法 ref 不进 host
  validateWorkflowRef(args.workflow);
  const params = {
    workflow: args.workflow, // 内置名 / .js 绝对路径（合法性已在入口校验）
    task: args.task,
    workdir: path.resolve(args.workdir),
    model: args.model,
    timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
  };
  // 通用 per-workflow 选项
  if (args.perspectives !== undefined) params.perspectives = csv(args.perspectives);
  if (args.items !== undefined) params.items = parseItems(args.items);
  if (args.operation !== undefined) params.operation = args.operation;
  if (args.subtaskCount !== undefined) params.subtaskCount = Number(args.subtaskCount);
  if (args.reviewTarget !== undefined) params.reviewTarget = args.reviewTarget;
  if (args.reviewers !== undefined) params.reviewers = csv(args.reviewers);
  if (args.maxRounds !== undefined) params.maxRounds = Number(args.maxRounds);
  if (args.skipCleanAgents !== undefined) params.skipCleanAgents = parseBoolFlag(args.skipCleanAgents);
  if (args.recheckAfterFix !== undefined) params.recheckAfterFix = parseBoolFlag(args.recheckAfterFix);
  // review-fix-loop 显式 flag 面
  if (args.targetType !== undefined) params.targetType = args.targetType;
  if (args.target !== undefined) params.target = args.target;
  for (const [key, value] of Object.entries(args)) {
    if (!/^batch([1-9]\d*)$/.test(key)) continue;
    if (value === true) {
      process.stderr.write(`--${key} 需要值（agent .md 绝对路径，逗号分隔多 agent）\n`);
      workflowUsage(1);
    }
    params[key] = csv(value);
  }
  if (args.batchNames !== undefined) params.batchNames = csv(args.batchNames);
  if (args.stuckThreshold !== undefined) params.stuckThreshold = Number(args.stuckThreshold);
  if (args.convergeNewIssues !== undefined) params.convergeNewIssues = Number(args.convergeNewIssues);
  if (args.convergeRounds !== undefined) params.convergeRounds = Number(args.convergeRounds);
  if (args.maxFixAttempts !== undefined) params.maxFixAttempts = Number(args.maxFixAttempts);
  if (args.aggregatorModel !== undefined) params.aggregatorModel = args.aggregatorModel;
  if (args.reviewPrompt !== undefined) params.reviewPrompt = args.reviewPrompt;
  if (args.fixPrompt !== undefined) params.fixPrompt = args.fixPrompt;
  if (args.fallowScan !== undefined) params.fallowScan = parseBoolFlag(args.fallowScan);
  if (args.autoCommit !== undefined) params.autoCommit = parseBoolFlag(args.autoCommit);

  // 透传面（用户脚本的 $ARGS 通道）：CLI 自有/已映射 flag 不透传，其余 flags
  // 原样透传——拼错的 flag（如 --stuck-threshld）不在 CLI 静默丢弃，透传后
  // host 对内置形态出 warning、用户脚本形态进 $ARGS 由脚本自己的
  // parameters schema 裁决
  const consumedArgs = new Set([
    '_', 'action', 'json', 'local', 'help', 'id', 'file', 'wait', 'name', 'script',
    'workflow', 'task', 'workdir', 'model', 'maxConcurrent', 'timeoutPerPhase', 'timeoutMs',
    'perspectives', 'items', 'operation', 'subtaskCount',
    'reviewTarget', 'reviewers', 'maxRounds', 'skipCleanAgents', 'recheckAfterFix',
    'targetType', 'target', 'batchNames', 'stuckThreshold', 'convergeNewIssues',
    'convergeRounds', 'maxFixAttempts', 'aggregatorModel', 'reviewPrompt', 'fixPrompt',
    'fallowScan', 'autoCommit',
  ]);
  for (const [key, value] of Object.entries(args)) {
    if (consumedArgs.has(key) || /^(batch([1-9]\d*))$/.test(key) || value === undefined) continue;
    params[key] = value;
  }
  // maxConcurrent/timeoutPerPhase 拼写保留位：透传给 host 出显式 warning（不再
  // 静默忽略），CLI 不消费
  if (args.maxConcurrent !== undefined) params.maxConcurrent = Number(args.maxConcurrent);
  if (args.timeoutPerPhase !== undefined) params.timeoutMsPerPhase = Number(args.timeoutPerPhase);
  return params;
}

/**
 * run action 输出面：--json 只出摘要；默认 markdown 报告 + 摘要两段；
 * exit 按 reason=completed 判定。报告正文 = core scriptResult（资产返回值），
 * message 字段优先（人读一行结论），其余字段 JSON 序列化补全。
 * 用 process.exitCode 而非 process.exit：大报告的 stdout write 可能仍挂起，
 * process.exit 会截断 pending flush（输出丢失），自然退出让事件循环排空。
 */
function renderWorkflowRunOutput(fin, args) {
  const summary = {
    runId: fin.runId,
    workflow: args.workflow,
    reason: fin.reason,
    error: fin.error === undefined ? null : fin.error,
    stateFile: fin.stateFile === undefined ? null : fin.stateFile,
    warnings: Array.isArray(fin.warnings) && fin.warnings.length > 0 ? fin.warnings : undefined,
  };
  if (Array.isArray(fin.warnings)) {
    for (const w of fin.warnings) process.stderr.write(`[zsw] ${w}\n`);
  }
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    const reportBody = renderScriptResultMarkdown(fin.scriptResult);
    process.stdout.write(`\n${'='.repeat(60)}\nmarkdown 报告:\n${'='.repeat(60)}\n`);
    process.stdout.write(`${reportBody}\n`);
    process.stdout.write(`\n${'='.repeat(60)}\nrun 摘要:\n${'='.repeat(60)}\n`);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
  process.exitCode = fin.reason === 'completed' ? 0 : 1;
}

/** scriptResult（core 资产返回值，对象/字符串/null）→ 人读 markdown 段。 */
function renderScriptResultMarkdown(scriptResult) {
  if (scriptResult === null || scriptResult === undefined) return '(无 scriptResult)';
  if (typeof scriptResult === 'string') return scriptResult;
  // 迁移脚本兼容（D6-⑧ 改写对照的产出等价面）：旧契约脚本返回 {markdown, json}，
  // markdown 字段为非空字符串时直接作报告主体，其余键以 json 块补齐、不重复 dump。
  if (typeof scriptResult.markdown === 'string' && scriptResult.markdown !== '') {
    const rest = { ...scriptResult };
    delete rest.markdown;
    const extra = Object.keys(rest).length > 0
      ? `\n\n\`\`\`json\n${JSON.stringify(rest, null, 2)}\n\`\`\``
      : '';
    return scriptResult.markdown + extra;
  }
  const lines = [];
  if (typeof scriptResult.message === 'string' && scriptResult.message !== '') {
    lines.push(scriptResult.message);
  }
  const rest = { ...scriptResult };
  delete rest.message;
  if (Object.keys(rest).length > 0) {
    lines.push('', '```json', JSON.stringify(rest, null, 2), '```');
  }
  return lines.join('\n');
}
/**
 * CLI 一次性进程的常驻引擎收口（W6a2 移交修复，W6b 落地）：core engine 已
 * 缺省 appserver 常驻模式——任务跑完后常驻子进程的 pipe stdio 仍挂住父进程
 * 事件循环，CLI 无法自然退出。本地执行体完成后统一调 wfHost.shutdown
 * （assemble 已组合 runner.shutdown：宿主惰性引擎实例逐个 dispose（close 帧
 * 先于 SIGTERM）+ killAllSpawnedChildren 兜底）。兜底 exit timer 用 unref：
 * 事件循环已空（dispose 后 stdio 管道关闭）则进程自然退出，stdout flush 走
 * node 退出路径；仍有残留 handle 则 250ms 后强制 exit（延迟给大报告的
 * stdout flush 留时间——与 renderWorkflowRunOutput 不用 process.exit 的理由
 * 一致）。daemon thin-client 路径不经本函数：执行体由 daemon 持有，引擎
 * dispose 是 daemon 自己的退出面（stdin 关闭钩子），CLI 侧 socket 断开即可。
 */
function exitAfterEngineShutdown(wfHost) {
  return Promise.resolve()
    .then(() => (wfHost && typeof wfHost.shutdown === 'function' ? wfHost.shutdown() : undefined))
    .catch((e) => {
      process.stderr.write(`[zsw] engine 收口失败（继续退出）: ${e && e.message || e}\n`);
    })
    .then(() => {
      const code = process.exitCode || 0;
      setTimeout(() => process.exit(code), 250).unref();
    });
}

/** run action：组参 → host.runAndWait 同步等终态 → 报告 + 摘要（exit 按终态）。 */
async function runWorkflowRun(wfHost, args, cwd) {
  requireWorkflowRunArgs(args);
  const params = buildWorkflowRunParams(args);
  // CLI 一次性进程：同步等完成（后台执行体随进程退出而死）——与 subagent
  // start 的 CLI 语义对齐；异步启动走 socket 面（zflow run 不带 wait）
  const fin = await wfHost.runAndWait(params, { cwd });
  renderWorkflowRunOutput(fin, args);
  // appserver 常驻引擎的 pipe stdio 挂事件循环（见 exitAfterEngineShutdown 头注）
  await exitAfterEngineShutdown(wfHost);
}

/**
 * workflow 子命令双模式（MF1）：
 * - abort/status/list/scripts/script-save/script-delete 管理面默认经 daemon thin
 *   client（zflow 同源）——record/执行体/运行中 runs 状态由常驻 daemon 持有：
 *   script-delete 的「运行中拒绝」只有 daemon 的 runs 表能真实裁决，
 *   script-save 后的发现面 invalidate 也落在 daemon 进程内；--local 显式走
 *   本地（调试后门：无 runs 视图，delete 恒放行）。
 * - run 恒本地同步（执行体 = CLI 进程本身，bash run_in_background 包裹即
 *   原生通知——设计 v5 决策，无 daemon 化形态）；lint/script-generate 恒本地
 *   （纯文件校验/写盘，无共享进程态）。两者的 --local flag 无行为差异，但
 *   NESTED 检查仍前置（MF2：workflow 在 main 顶部提前分流，绕过
 *   runDaemonCommand 的检查，此处补洞；--local 同拒——嵌套里本地跑同样递归）。
 * 本地路径（--local 或 run/lint/script-generate）：一次性进程只重建内存索引
 * （同 main 的 subagent 路径：不探活、不落盘），非终态 run 在 CLI 视角显示 lost。
 */
/**
 * 管理面 CLI flag → zflow handler 参数映射（契约对齐 dist/mcp/server.js 的
 * zflow handler：abort/status 必填 runId（CLI 侧 flag 是 --id）、list/scripts
 * 无参、script-save/script-delete 必填 name）。缺参报错在组帧前发生
 * （requireRunIdArg 同理；requireScriptActionName 的 throw 经 main catch 出
 * exit 1），daemon/--local 两形态一致。
 */
function workflowDaemonParams(action, args) {
  switch (action) {
    case 'abort':
      return { action: 'abort', runId: requireRunIdArg(args) };
    case 'status':
      return { action: 'status', runId: requireRunIdArg(args) };
    case 'list':
      return { action: 'list' };
    case 'scripts':
      return { action: 'scripts' };
    case 'script-save':
      return { action: 'script-save', name: requireScriptActionName(args.name) };
    case 'script-delete':
      return { action: 'script-delete', name: requireScriptActionName(args.name) };
    default:
      return null; // run/lint/script-generate：恒本地，不走 daemon
  }
}

async function runWorkflowCommand(rest) {
  // MF2：嵌套拒绝（与 runDaemonCommand 共用 ensureNotNested，防文案漂移）
  ensureNotNested();
  const args = parseArgs(rest);
  if (args.help === true) workflowUsage(0);

  const action = typeof args.action === 'string' ? args.action : 'run';
  if (!WORKFLOW_ACTIONS.includes(action)) {
    process.stderr.write(`不支持的 --action: ${action || '(未指定)'}，支持: ${WORKFLOW_ACTIONS.join(' / ')}\n`);
    workflowUsage(1);
  }

  // MF1：管理面 action 无 --local 时经 daemon（单请求单响应；daemon 不在场的
  // 报错走 callDaemon 既有的可操作文案）。run/lint 落到下方本地路径。
  if (args.local !== true) {
    const daemonParams = workflowDaemonParams(action, args);
    if (daemonParams) {
      exitWithDaemonResponse(await callDaemon({ tool: 'zflow', params: daemonParams }));
    }
  }

  // 回接 2b：本地路径走 orchestration host（vendored subagent-core）。
  // 一次性进程不重水合历史 run（内存 runs 空，list 显示为空；历史快照在
  // <zsw 数据根>/workflow-state/，daemon 启动/接管时由 recoverOrphans 收编）
  const { wfHost } = await assembleManager();
  const cwd = process.env.ZCODE_PROJECT_DIR || process.cwd();

  if (action === 'run') return runWorkflowRun(wfHost, args, cwd);

  switch (action) {
    case 'abort':
      process.stdout.write(`${JSON.stringify(await wfHost.abort(requireRunIdArg(args)), null, 2)}\n`);
      break;
    case 'status':
      process.stdout.write(`${JSON.stringify(wfHost.status(requireRunIdArg(args)), null, 2)}\n`);
      break;
    case 'list':
      process.stdout.write(`${JSON.stringify(wfHost.list(), null, 2)}\n`);
      break;
    case 'scripts': {
      const found = await wfHost.scripts(cwd);
      process.stdout.write(`${JSON.stringify({
        builtin: found.builtin.map((b) => ({ name: b.name, description: b.description, path: b.path })),
        scripts: found.scripts,
      }, null, 2)}\n`);
      break;
    }
    case 'lint': {
      if (typeof args.file !== 'string' || args.file.trim() === '') {
        process.stderr.write('lint 需要 --file <脚本路径>（scripts 可查已发现脚本的 path 字段）\n');
        workflowUsage(1);
      }
      process.stdout.write(`${JSON.stringify(await wfHost.lint(args.file), null, 2)}\n`);
      break;
    }
    case 'script-generate': {
      // 恒本地：core 管线纯校验 + tmp 写盘，无共享进程态（同 lint 语义）
      process.stdout.write(`${JSON.stringify(scriptGenerateAction(args.name, args.script), null, 2)}\n`);
      break;
    }
    case 'script-save': {
      // --local 路径：目录操作无共享态，直接走共享实现（daemon 默认路径在上方
      // workflowDaemonParams 已分流，此处仅调试后门）
      process.stdout.write(`${JSON.stringify(await scriptSaveAction(args.name), null, 2)}\n`);
      break;
    }
    case 'script-delete': {
      // --local 一次性进程无 runs 视图：runningScriptPredicate 对空 list 恒
      // false（如实声明——「运行中拒绝」的真实裁决只在 daemon 面）
      process.stdout.write(`${JSON.stringify(scriptDeleteAction(args.name, runningScriptPredicate(wfHost)), null, 2)}\n`);
      break;
    }
  }
}

// ------------------------------------------------------ hook 子命令（SessionStart）

/**
 * SessionStart hook 入口（恒本地执行，不经 daemon——hook 在会话启动内联跑，
 * daemon 前置会把「daemon 不在」变成「会话无注入」，且冷启动须 < 500ms）。
 * 旧内联组装实现已收敛到 lib/hook-source.js 的 runSessionStartHook（批 A2a：
 * 与 hooks/hooks.json 指向的 bin/zsw-hook.js 极薄入口同源，防双实现漂移），
 * 本函数只剩 CLI 面职责：
 *   - 参数形态兼容既有文档（`hook session-start`；未知事件 usage exit 1——
 *     人类调试入口给可操作报错，不同于引擎 hook 面的恒 0 降级）。
 *   - 嵌套守卫仍在事件名校验之前（嵌套下任何 hook 调用零开销 {} + exit 0；
 *     与 runSessionStartHook 内部守卫同语义，此处提前退出省函数体内 require）。
 *     独立于 ensureNotNested：绝不走其 exit 1 路径——hook 非零退出会在会话
 *     启动时 raise error 阻断会话（设计 D5）。
 *   - CLI 级最外层 try 兜 hook-source 模块级损坏：任何失败 stdout {} + 自然
 *     退出 exit 0。注意这是 CLI 调试面的兜底，不与 bin/zsw-hook.js 等价——
 *     本入口顶层依赖全链（assemble/cli-client/record-store 等），插件文件
 *     不完整时模块加载即 exit 1，此 try 无从生效（惰性 require 降加载面为
 *     后续优化项）。引擎会话启动面必须走 hooks.json 指向的 bin/zsw-hook.js
 *     （自包含薄入口，加载面兜底同语义）。
 * 数据组装/渲染/降级语义（D4/D5/D6 三条硬约束与口径）见 lib/hook-source.js 头注。
 */
function runHookCommand(rest) {
  // 嵌套守卫最前（守卫优先于事件名校验，嵌套下任何 hook 调用零开销退出）
  if (process.env.ZSW_NESTED === '1') {
    process.stdout.write('{}\n');
    return; // 自然退出 = exit 0；不用 process.exit 防 stdout 未 flush
  }
  if (rest[0] !== 'session-start') {
    process.stderr.write(`未知 hook 事件: ${rest[0] || '(未指定)'}，支持: session-start\n`);
    usage(1);
  }
  try {
    // async（core 发现面异步）+ 容错：runSessionStartHook 内部已消化正常
    // 降级，此处 .catch 只兜 promise 链意外拒绝
    require('../lib/hook-source').runSessionStartHook().catch(() => {});
  } catch (e) {
    // hook-source 加载/执行本身的意外抛出（正常降级路径在其内部已消化）：
    // stdout 是协议通道，必须给引擎一个合法帧；诊断尽力写 stderr
    try { process.stdout.write('{}\n'); } catch { /* stdout 不可写则无从协议 */ }
    try { process.stderr.write(`[zsw:hook] entry failure: ${e && e.message || e}\n`); } catch { /* 尽力 */ }
  }
}

// ------------------------------------------- daemon thin client（1.0.0 起默认形态）

/**
 * 嵌套防递归检查（MF2 抽公共）：runDaemonCommand（zsub 面）与
 * runWorkflowCommand（workflow 在 main 顶部提前分流，曾绕过此检查——补洞）
 * 共用同一文案与退出码，防两处漂移。
 */
function ensureNotNested() {
  if (process.env.ZSW_NESTED === '1') {
    // 防递归边界从 MCP 工具面平移到 CLI 面（DESIGN-v4 §7 要点 4）
    process.stderr.write(
      '嵌套环境禁止编排（防递归，ZSW_NESTED=1）。'
      + '恢复指引：subagent 会话内不要编排，由主会话派发。\n'
    );
    process.exit(1);
  }
}

/**
 * daemon 路径（DESIGN-v4 D5/D7）：组 zsub 的 action params 后经
 * lib/cli-client 的 callDaemon 单请求单响应往返（帧协议 D2）。执行体由
 * daemon 持有，CLI 退出不丢——start 默认异步启动（与 --local 模式的强制
 * 阻塞不同，这正是 daemon 模式的价值）。
 */
async function runDaemonCommand(cmd, args, rest) {
  ensureNotNested();

  if (cmd === 'wait') return runDaemonWait(args, rest);

  let params;
  switch (cmd) {
    case 'start': {
      if (!args.task || !args.slug) usage();
      let schema = args.schema;
      if (typeof schema === 'string' && /^\//.test(schema) === false && /\.json$/.test(schema)) {
        schema = require('node:fs').readFileSync(schema, 'utf8'); // schema 文件路径（与本地模式同款解析）
      }
      // wait 刻意不传：执行体由 daemon 持有，CLI 退出不丢——异步启动是安全
      // 默认；--wait 由 runDaemonStartWait 的 sugar 处理（不透传给 daemon）
      params = {
        action: 'start',
        task: args.task,
        slug: args.slug,
        agent: args.agent,
        model: args.model,
        schema,
        worktree: args.worktree === true,
        conversation: args.conversation === true,
        timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
        // F4 能力增量（D5/D6）：thinking 与 CLI 工具限制——thinking/allow
        // 请求值 spawn 单轮通道不消费，manager 终态如实标注（thinking:
        // null (spawn 降级)；allow 侧 toolsNote）；deny 侧并集落引擎
        // --disallowed-tools 硬生效
        ...startCapabilityArgs(args),
      };
      break;
    }
    case 'list':
      params = { action: 'list' };
      break;
    case 'agents':
      // agent .md 发现（W6a 起 core 发现面：vendored 内置 10 角色 + 四根，daemon
      // 侧 handler 数据源 = lib/agent-discovery；D-4a 后 start 只收路径——不确定
      // 路径时先查，输出带 location/file 列）
      params = { action: 'agents' };
      break;
    case 'models':
      // 模型路由清单（provider 已启用的模型 + 上下文窗口/推理档位）；
      // --all 透传给 daemon 侧 handler 出全 provider 视图（跨 provider 必须
      // 全名 <provider>/<model>，兜底链闭合），缺省行为不变
      params = { action: 'models' };
      if (args.all === true) params.all = true;
      break;
    case 'status':
      params = { action: 'status', subagentId: args.id };
      break;
    case 'message':
      params = { action: 'message', subagentId: args.id, text: args.text };
      break;
    case 'cancel':
      params = { action: 'cancel', subagentId: args.id };
      break;
    case 'close':
      params = { action: 'close', subagentId: args.id };
      break;
    default:
      process.stderr.write(`未知子命令: ${cmd}\n`);
      usage();
  }

  if (cmd === 'start' && args.wait === true) return runDaemonStartWait(params);

  exitWithDaemonResponse(await callDaemon({ tool: 'zsub', params }));
}

/** 统一出口：ok:true 打印 result exit 0；ok:false 打印 error 到 stderr exit 1。 */
function exitWithDaemonResponse(resp) {
  if (resp.ok) {
    process.stdout.write(`${JSON.stringify(resp.result, null, 2)}\n`);
    process.exit(0);
  }
  process.stderr.write(`[zsw] daemon 错误: ${daemonErrorMessage(resp.error)}\n`);
  process.exit(1);
}

/** error 帧字段（{code,message} 对象）的可读化；异常形态兜底 JSON 序列化。 */
function daemonErrorMessage(error) {
  if (error && typeof error === 'object') {
    const msg = error.message || JSON.stringify(error);
    return error.code !== undefined ? `${msg}（code: ${error.code}）` : msg;
  }
  return String(error);
}

/** start --wait sugar（DESIGN-v4 D4）：start 成功拿 subagentId 后自动追发 wait，透传打印终态。 */
async function runDaemonStartWait(startParams) {
  const start = await callDaemon({ tool: 'zsub', params: startParams });
  if (!start.ok) exitWithDaemonResponse(start);
  const id = start.result && start.result.subagentId;
  if (typeof id !== 'string' || id === '') {
    // 无 id 的 start 响应（异常形态）：打印响应本身即终态，无从追发
    process.stdout.write(`${JSON.stringify(start.result, null, 2)}\n`);
    process.exit(0);
  }
  // wait 不带 timeoutMs：等待无上限，任务自身的执行超时已由 start 的
  // timeoutMs 控制（两个 timeout 语义不同，见 DESIGN-v4 D4）
  await runDaemonWaitCore([id], undefined);
}

/** wait 子命令：--id 可重复（多 id 聚合等待）；--timeout-ms 到点回 partial，exit 2。 */
async function runDaemonWait(args, rest) {
  const ids = collectIds(rest);
  if (ids.length === 0) {
    process.stderr.write('wait 需要 --id <subagentId>（可重复：--id a --id b）\n');
    usage();
  }
  await runDaemonWaitCore(ids, args.timeoutMs ? Number(args.timeoutMs) : undefined);
}

/**
 * wait 结果的失败终态集合（MF4）：lib/record-store 的 TERMINAL_STATUSES 去
 * closed（cancelled/error/timeout）+ lost（lost 不在 TERMINAL_STATUSES——
 * 正常 daemon wait 只回终态，此处防御异常/未来形态）。cancelled 计失败：
 * 用户主动取消的等待以非零退出更诚实（结果条目 status=cancelled 可辨别来源）。
 */
const WAIT_FAILURE_STATUSES = new Set(
  [...TERMINAL_STATUSES].filter((s) => s !== 'closed').concat(['lost']),
);

async function runDaemonWaitCore(ids, timeoutMs) {
  const params = { action: 'wait', ids };
  if (timeoutMs !== undefined) params.timeoutMs = timeoutMs;
  const resp = await callDaemon({ tool: 'zsub', params });
  if (!resp.ok) exitWithDaemonResponse(resp);
  process.stdout.write(`${JSON.stringify(resp.result, null, 2)}\n`);
  // exit code（MF4）：partial（等待超时未全完成）→ 2 优先；否则 results 任一
  // 条目为失败终态 → 1；全完成 → 0（closed 或 conversation 的 idle）。runDaemonStartWait 复用本核心自动生效。
  const result = resp.result;
  if (result && result.partial === true) process.exit(2);
  const entries = Array.isArray(result && result.results) ? result.results : [];
  process.exit(entries.some((r) => r && WAIT_FAILURE_STATUSES.has(r.status)) ? 1 : 0);
}

/** parseArgs 对重复 flag 只留末值，wait 的多 --id 手工收集原始 argv（其余 flag 解析不受影响）。 */
function collectIds(rest) {
  const ids = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--id' && rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) {
      ids.push(rest[i + 1]);
      i++;
    }
  }
  return ids;
}

async function main() {
  // ZSW_RUNNER 校验前置（回接 2c）：thin client / daemon / --local 三形态一致
  // 立即报退役错误，不依赖 daemon 在场或组装时机（hook/workflow 子命令不经
  // 组装面，但 env 误配同样应尽早在用户可见面出声）
  try {
    require('../lib/assemble').assertRunnerEnv();
  } catch (e) {
    process.stderr.write(`[zsw] 错误: ${e && e.message || e}\n`);
    process.exit(1);
  }
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();
  // workflow 子命令在 manager 组装之前分流（见 runWorkflowCommand 头注）
  if (cmd === 'workflow') return runWorkflowCommand(rest);
  // hook 子命令同理在 manager 组装之前分流：恒本地零 daemon 依赖（见
  // runHookCommand 头注），不走 parseArgs/daemon/assembleManager 任一路径
  if (cmd === 'hook') return runHookCommand(rest);
  const args = parseArgs(rest);

  // 1.0.0（M1，DESIGN-v4 D5/D7）：默认 = daemon thin client；
  // --local = 显式本地一次性执行（人类调试/无引擎环境）。
  // wait 无 --local 形态——本地一次性进程没有可挂起的等待方
  // （start 本身就阻塞到本轮完成）。
  if (cmd === 'wait' && args.local === true) {
    process.stderr.write(
      '[zsw] wait 无本地模式：等待由常驻 daemon 内存挂起实现（零轮询，DESIGN-v4 D4），'
      + '本地一次性进程没有可挂起的等待方。'
      + '恢复指引：zsw wait --id <id> [--id <id2> ...] [--timeout-ms <n>]；'
      + '本地模式 start 本身阻塞到本轮完成，无需 wait。\n'
    );
    process.exit(1);
  }
  if (args.local !== true) return runDaemonCommand(cmd, args, rest);

  // MF2：--local 本地路径同拒嵌套（F-A7 盲区修补：此前仅 runDaemonCommand
  // 与 runWorkflowCommand 有守卫，嵌套子会话内 `start --local` 会绕过防递归
  // 边界 spawn 真实引擎进程——本地跑同样递归）。先例同款（共用 ensureNotNested
  // 防文案漂移）；wait --local 保留其上方的精确报错，不被嵌套文案遮蔽。
  ensureNotNested();

  const { manager, wfHost } = await assembleManager();
  // CLI 一次性进程：只重建 record 索引（rebuild 只改内存不落盘），让
  // list/status 看到历史。刻意不走 manager.recover() 的探活段——探活会对
  // 常驻 server 正在管理的 running 任务误标 orphan 落盘（健康任务被标
  // 「建议 cancel 后重发」，且每次 CLI 调用都追加一条 update 事件）。
  // 副作用如实声明：非终态 record 在 CLI 视角显示 lost（CLI 无法确知其他
  // 进程持有执行体的死活），这是内存态，退出即消，不污染事件流。
  try { manager.records.rebuildFromLog(); } catch (e) {
    process.stderr.write(`[zsw] record 重建失败（继续）: ${e && e.message || e}\n`);
  }

  const cwd = process.env.ZCODE_PROJECT_DIR || process.cwd();
  const ctx = {
    cwd,
    // CLI 无 _meta 通道；显式 --target-session 才有 mailbox 定向（高级用法）
    targetSessionId: typeof args.targetSession === 'string' ? args.targetSession : undefined,
  };

  let result;
  switch (cmd) {
    case 'start': {
      if (!args.task || !args.slug) usage();
      if (args.noWait === true) {
        // --no-wait 已移除：CLI 一次性进程下它必然丢执行体（轮死、record 卡
        // running），且没有任何常驻组件会接管。显式报错优于静默忽略——用户
        // 可能照旧文档/旧脚本使用，静默忽略会制造僵尸任务。
        process.stderr.write(
          '[zsw] --no-wait 已移除：CLI 一次性进程退出即丢执行体（轮死、record 卡 running），'
          + '没有常驻组件会接管 CLI 启动的后台任务。'
          + '恢复指引：去掉 --no-wait 让命令阻塞到本轮完成；'
          + '需要异步启动与完成通知请去掉 --local 用默认 daemon 模式（zsw start 不带 --local 即异步启动，zsw wait 收结果）。\n'
        );
        process.exit(1);
      }
      let schema = args.schema;
      if (typeof schema === 'string' && /^\//.test(schema) === false && /\.json$/.test(schema)) {
        schema = require('node:fs').readFileSync(schema, 'utf8'); // schema 文件路径
      }
      result = await manager.start({
        task: args.task,
        slug: args.slug,
        agent: args.agent,
        model: args.model,
        schema,
        worktree: args.worktree === true,
        conversation: args.conversation === true,
        wait: true, // CLI 进程活着才有后台执行体（无 --no-wait，见文件头注）
        timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
        ...startCapabilityArgs(args), // F4：与 daemon 形态同款参数面（防漂移）
      }, ctx);
      break;
    }
    case 'list':
      result = manager.list();
      break;
    case 'status':
      result = manager.status(args.id);
      break;
    case 'message': {
      result = await manager.message(args.id, args.text);
      if (result && result.busy) break; // busy：本轮未投递，无执行体可等
      // 等本轮完成再退出（与 start 的 wait 语义对齐）：CLI 若在启动 resume
      // 轮后立即退出，执行体变孤儿、record 卡 running、outputs/通知永不产生。
      // manager.pending 是执行体 promise（cancel 的同款等待路径）；失败原因
      // 已落 record（error 终态），这里不再重报。极快完成的轮可能已从
      // pending 清除——此时 status 本就直接是终态，结果同样正确。
      const pending = manager.pending.get(args.id);
      if (pending) await pending.catch(() => {});
      result = { subagentId: args.id, round: result.round, notify: result.notify, final: manager.status(args.id) };
      break;
    }
    case 'cancel':
      result = await manager.cancel(args.id);
      break;
    case 'close':
      result = await manager.close(args.id);
      break;
    default:
      process.stderr.write(`未知子命令: ${cmd}\n`);
      usage();
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // --local 一次性进程的引擎收口（与 zflow run 同根因：start/message 跑完
  // 任务后 appserver 常驻子进程的 stdio 挂住事件循环，防 CLI 无法退出）
  await exitAfterEngineShutdown(wfHost);
}

// require.main 守卫：test/cli.test.js 与 dist/mcp/server.js（daemon socket 面
// script-* action 的同源实现消费方）经 require 复用导出函数（bin 直接执行时
// 行为不变）。模块加载零副作用；副作用只发生在显式调用的 script-* action
// 函数体内（写 tmp/saved 目录）。
module.exports = {
  parseArgs,
  csv,
  // W8 创作闭环（D-6）+ workflow 引用契约（D-4）共享实现：CLI 本地路径与
  // daemon socket 面单一来源，防两入口漂移
  workflowScriptDirs,
  validateWorkflowRef,
  requireScriptActionName,
  scriptGenerateAction,
  scriptSaveAction,
  scriptDeleteAction,
  runningScriptPredicate,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[zsw] 错误: ${e && e.message || e}\n`);
    process.exit(1);
  });
}
