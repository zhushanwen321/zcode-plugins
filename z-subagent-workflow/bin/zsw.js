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
 *   node bin/zsw.js start --task "<任务书>" --slug <短名> [--agent <名>]
 *        [--model <短名>] [--schema <json或文件路径>] [--worktree]
 *        [--conversation] [--timeout-ms <n>] [--wait]
 *   node bin/zsw.js wait --id <id> [--id <id2> ...] [--timeout-ms <n>]
 *        （等待由 daemon 内存挂起到终态，零轮询；--timeout-ms 到点返回
 *         partial 结果，exit 2）
 *   node bin/zsw.js list
 *   node bin/zsw.js status --id <subagentId>
 *   node bin/zsw.js message --id <subagentId> --text "<续聊消息>"（投递即回，完成经 wait 收）
 *   node bin/zsw.js cancel --id <subagentId>
 *   node bin/zsw.js close --id <subagentId>
 *   node bin/zsw.js workflow [--action <run|abort|status|list|scripts|lint>]
 *        --workflow <chain|parallel|map-reduce|scatter-gather|review-fix-loop|script:<名>>
 *        --task "<任务/目标>" --workdir <绝对路径> [options]（--action 缺省 = run）
 *        abort/status/list/scripts 管理面默认经 daemon（zflow 同源，MF1）；
 *        run 恒本地同步形态（执行体 = CLI 进程，bg 包裹即原生通知——设计
 *        v5 决策，无 daemon 化形态）、lint 恒本地（纯文件校验无状态）；
 *        --local = 全 action 本地一次性执行（无 daemon 依赖，调试用）。
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
const { assembleManager } = require('../lib/assemble');
const { callDaemon } = require('../lib/cli-client');
const { TERMINAL_STATUSES } = require('../lib/record-store');

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
    + '  node bin/zsw.js agents                        # 可用 agent .md 清单（start 前查名）\n'
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

// ------------------------------------------------------ workflow 子命令

/** workflow 六 action（与 MCP zflow tool 的 action 枚举同源）。 */
const WORKFLOW_ACTIONS = ['run', 'abort', 'status', 'list', 'scripts', 'lint'];

/**
 * scripts action 的内置索引。面向人类 CLI 的中文一句话；LLM 侧权威索引在
 * dist/mcp/server.js 的 BUILTIN_WORKFLOW_INFO（英文，随 tool description）——
 * 两个入口受众不同，文案独立维护，名字集合以 lib/workflow-manager 的
 * defaultWorkflows 为准。
 */
const BUILTIN_WORKFLOW_INFO = [
  { name: 'chain', description: '分析 → 实现 → 总结 三步顺序链' },
  { name: 'parallel', description: '单目标多视角并行审查后聚合' },
  { name: 'map-reduce', description: '对已知 items 数组并行变换再归约' },
  { name: 'scatter-gather', description: '大任务拆 2-4 份并行处理再合并' },
  { name: 'review-fix-loop', description: '并行审查 → 聚合 must-fix → 修复 → 复审到 clean（会写文件）' },
];

function workflowUsage(exitCode = 1) {
  process.stderr.write(
    'zsw workflow：workflow 编排与管理（经 WorkflowManager，record/outputs/通知与 MCP zflow 同源）\n'
    + '\n'
    + '用法:\n'
    + '  node bin/zsw.js workflow [--action <run|abort|status|list|scripts|lint>] [options]\n'
    + '  （--action 缺省 = run；abort/status/list/scripts 管理面默认经 daemon\n'
    + '   thin client（zflow tool 同源）；run/lint 恒本地；--local = 全 action\n'
    + '   本地一次性执行）\n'
    + '\n'
    + 'run（默认）—— 同步等待完成并输出报告（CLI 一次性进程无后台模式，\n'
    + '  异步 runId + 完成通知走 MCP zflow）:\n'
    + '  --workflow <名>           chain / parallel / map-reduce / scatter-gather /\n'
    + '                            review-fix-loop / script:<自定义脚本名>\n'
    + '  --task <text>             任务描述（必填，自包含）\n'
    + '  --workdir <path>          工作目录（必填，绝对路径）\n'
    + '  --model <name>            模型短名或 provider 全名（默认跟随配置的 main 模型；仅限 provider 已启用的模型，传错会列出可用清单）\n'
    + '  --max-concurrent <n>      单 workflow 内阶段并发上限（默认 3）\n'
    + '  --timeout-per-phase <ms>  单阶段超时（不设则无超时）\n'
    + '  --timeout-ms <ms>         workflow 整体超时（不设则无超时）\n'
    + '  --json                    只输出 run 摘要 JSON（默认 markdown 报告 + 摘要两段）\n'
    + '\n'
    + '  per-workflow 选项:\n'
    + '  --perspectives "a,b,c"    parallel：分析视角（默认 security,performance,maintainability）\n'
    + '  --items <json数组|a,b,c>  map-reduce：待处理条目，如 \'["a","b"]\' 或 a,b,c\n'
    + '  --operation <text>        map-reduce：对每个 item 做什么\n'
    + '  --subtask-count <n>       scatter-gather：拆分数提示（2-4）\n'
    + '  review-fix-loop（批次外环：batch1..batchN 串行，批内 review→聚合→fix→重审到 clean）:\n'
    + '  --batch1 "a,b"            批次维度（batch1、batch2、… 连续编号，缺号报错；批间串行，\n'
    + '                            前一批 clean 后一批才启动；跨批 clean 且无 fix 的维度跳过）\n'
    + '  --batch-names "a,b"       批次命名（数量须与批次数一致，缺省 batch-1..N）\n'
    + '  --reviewers "a,b"         老参数 sugar：包装为单批（默认 correctness,robustness；\n'
    + '                            与 batchN 同传时 batchN 优先）\n'
    + '  --target-type <t>         审查目标类型 git-diff|file|dir|text（默认 text）\n'
    + '  --target <text>           审查目标（与 --target-type 配套；全缺省 = "git 未提交改动"）\n'
    + '  --review-target <text>    老参数 sugar：等价 --target-type text --target <text>\n'
    + '  --max-rounds <n>          每批最大轮数（默认 10，≥1）\n'
    + '  --stuck-threshold <n>     连续 N 轮 must-fix 不降判 stuck（默认 3）\n'
    + '  --skip-clean-agents [b]   clean 审查者跳过不派（默认 true；传 false 关闭；\n'
    + '                            同时作用于批内轮间与跨批）\n'
    + '  --recheck-after-fix [b]   fix 后重派全批，上一轮 clean 的走限定复检（只查 fix 引入的\n'
    + '                            回归；默认 false，clean 持续跳过）\n'
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
    + 'abort / status / list / scripts（管理面：默认经 daemon，zflow 同源；--local 本地）:\n'
    + '  --id <runId>              abort/status 必填：wf- 前缀的 run id（list 可查；\n'
    + '                            abort 后状态落 cancelled）\n'
    + 'list:                       全部 workflow run（精简视图）\n'
    + 'scripts:                    内置 5 + 自定义脚本清单（四根发现）\n'
    + 'lint:\n'
    + '  --file <脚本路径>         校验脚本（node --check 语法 + name/description/run 契约形状）\n'
    + '\n'
    + '进度打 stderr；exit 0 = 成功（run 以终态 closed 判定）。zcode CLI 路径可用 ZSW_ZCODE_CLI 覆盖。\n'
  );
  process.exit(exitCode);
}

function csv(v) {
  return typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
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

/** run action 参数面①：必填三参校验（声明顺序即缺参报错的优先级）。 */
function requireWorkflowRunArgs(args) {
  if (!args.workflow) { process.stderr.write('缺少 --workflow\n'); workflowUsage(1); }
  if (!args.task) { process.stderr.write('缺少 --task（必填，自包含任务书）\n'); workflowUsage(1); }
  if (!args.workdir) { process.stderr.write('缺少 --workdir\n'); workflowUsage(1); }
}

/** run action 参数面②：通用 per-workflow 选项（csv→数组、字符串→数字/布尔）。 */
function applyWorkflowCoreOptions(params, args) {
  if (args.perspectives !== undefined) params.perspectives = csv(args.perspectives);
  if (args.items !== undefined) params.items = parseItems(args.items);
  if (args.operation !== undefined) params.operation = args.operation;
  if (args.subtaskCount !== undefined) params.subtaskCount = Number(args.subtaskCount);
  if (args.reviewTarget !== undefined) params.reviewTarget = args.reviewTarget;
  if (args.reviewers !== undefined) params.reviewers = csv(args.reviewers);
  if (args.maxRounds !== undefined) params.maxRounds = Number(args.maxRounds);
  if (args.skipCleanAgents !== undefined) params.skipCleanAgents = parseBoolFlag(args.skipCleanAgents);
  if (args.recheckAfterFix !== undefined) params.recheckAfterFix = parseBoolFlag(args.recheckAfterFix);
}

/** batchN 动态键（--batch1、--batch2、… 连续编号）：csv 归一 + 已消费标记 + 无值报错。 */
function applyBatchArgs(params, args, consumedArgs) {
  for (const [key, value] of Object.entries(args)) {
    if (!/^batch([1-9]\d*)$/.test(key)) continue;
    consumedArgs.add(key); // 已映射为 csv 数组，透传循环不得用原始字符串覆写
    if (value === true) {
      process.stderr.write(`--${key} 需要值（逗号分隔维度，如 --${key} "correctness,robustness"）\n`);
      workflowUsage(1);
    }
    params[key] = csv(value);
  }
}

/** review-fix-loop v2 显式 flag 面：target/batch/聚合收敛/fix 行为 → params。 */
function applyReviewFixLoopOptions(params, args, consumedArgs) {
  if (args.targetType !== undefined) params.targetType = args.targetType;
  if (args.target !== undefined) params.target = args.target;
  applyBatchArgs(params, args, consumedArgs);
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
}

/** 透传面：consumedArgs 之外的未知 flag 原样透传（拼错 flag 不在 CLI 静默丢弃）。 */
function applyPassthroughArgs(params, args, consumedArgs) {
  for (const [key, value] of Object.entries(args)) {
    if (consumedArgs.has(key) || value === undefined) continue;
    params[key] = value;
  }
}

/** run action 参数组装：基础参数 → 通用选项 → review-fix-loop 选项 → 透传。 */
function buildWorkflowRunParams(args) {
  const params = {
    workflow: args.workflow, // 内置名或 script:<脚本名>（合法性由 manager 校验）
    task: args.task,
    workdir: path.resolve(args.workdir),
    model: args.model,
    maxConcurrent: args.maxConcurrent ? Number(args.maxConcurrent) : undefined,
    timeoutMsPerPhase: args.timeoutPerPhase ? Number(args.timeoutPerPhase) : undefined,
    timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
    // CLI 一次性进程：同步等完成（后台执行体随进程退出而死）——与 subagent
    // start 的 CLI 语义对齐；异步启动走 MCP zflow
    wait: true,
    // 进度走 stderr（stdout 留给结果）；回调经 record 的 JSON 序列化自然丢弃，不落盘
    onPhase: ({ phase, status }) => process.stderr.write(`[${new Date().toISOString()}] ${phase}: ${status}\n`),
  };
  applyWorkflowCoreOptions(params, args);

  // review-fix-loop v2 参数面（设计 §3.4 终态全集）。target/review-target/batchN/
  // reviewers 的优先级裁决与缺省映射统一在 workflow 入口 normalizeParams（D5）——
  // CLI 负责形态转换（csv→数组、字符串→数字/布尔）与已映射键的消费标记：
  // batchN 动态键必须 add 进 consumedArgs，否则下方透传循环会用原始逗号字符串
  // 覆写回 params，数组形态永远到不了入口。CLI 不重复实现映射，防两处漂移。
  //
  // 透传面：CLI 自有 / 已映射 flag（consumedArgs）不透传，其余 flags 原样透传
  // ——parseArgs 是通用 --key 解析，拼错的 flag（如 --batchX、--stuck-threshld）
  // 若在此静默丢弃，入口白名单就永远拦不到。透传后 review-fix-loop 入口的参数
  // 白名单会报「未知参数」并列合法清单（单一权威，CLI 不重复维护清单）；其他
  // 内置 workflow 无白名单，多余键被入口解构忽略，与透传前行为一致。
  const consumedArgs = new Set([
    '_', 'action', 'json', 'local', 'help', 'id', 'file', 'wait',
    'workflow', 'task', 'workdir', 'model', 'maxConcurrent', 'timeoutPerPhase', 'timeoutMs',
    'perspectives', 'items', 'operation', 'subtaskCount',
    'reviewTarget', 'reviewers', 'maxRounds', 'skipCleanAgents', 'recheckAfterFix',
    'targetType', 'target', 'batchNames', 'stuckThreshold', 'convergeNewIssues',
    'convergeRounds', 'maxFixAttempts', 'aggregatorModel', 'reviewPrompt', 'fixPrompt',
    'fallowScan', 'autoCommit', 'onPhase',
  ]);
  applyReviewFixLoopOptions(params, args, consumedArgs);
  applyPassthroughArgs(params, args, consumedArgs);
  return params;
}

/** run action 输出面：--json 只出摘要；默认 markdown 报告 + 摘要两段；exit 按终态。 */
function renderWorkflowRunOutput(fin, args) {
  const summary = {
    runId: fin.runId, workflow: fin.workflow, status: fin.status,
    outputFile: fin.outputFile, error: fin.error === undefined ? null : fin.error,
  };
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`\n${'='.repeat(60)}\nmarkdown 报告:\n${'='.repeat(60)}\n`);
    process.stdout.write(`${fin.report || ''}\n`);
    process.stdout.write(`\n${'='.repeat(60)}\nrun 摘要:\n${'='.repeat(60)}\n`);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
  process.exit(fin.status === 'closed' ? 0 : 1);
}

/** run action：组参 → 同步等完成 → 报告 + 摘要（exit code 按终态）。 */
async function runWorkflowRun(wfManager, args, cwd) {
  requireWorkflowRunArgs(args);
  const params = buildWorkflowRunParams(args);
  const fin = await wfManager.start(params, { cwd });
  renderWorkflowRunOutput(fin, args);
}

/**
 * workflow 子命令双模式（MF1）：
 * - abort/status/list/scripts 管理面默认经 daemon thin client（zflow tool
 *   同源）——record/执行体由常驻 daemon 持有，CLI 不再把非终态 run 误标
 *   lost；--local 显式走本地（调试后门）。
 * - run 恒本地同步（执行体 = CLI 进程本身，bash run_in_background 包裹即
 *   原生通知——设计 v5 决策，无 daemon 化形态）；lint 恒本地（纯文件校验
 *   无状态）。两者的 --local flag 无行为差异，但 NESTED 检查仍前置（MF2：
 *   workflow 在 main 顶部提前分流，绕过 runDaemonCommand 的检查，此处补洞；
 *   --local 同拒——嵌套里本地跑同样递归）。
 * 本地路径（--local 或 run/lint）：一次性进程只重建内存索引（同 main 的
 * subagent 路径：不探活、不落盘），非终态 run 在 CLI 视角显示 lost。
 */
/**
 * 管理面 CLI flag → zflow handler 参数映射（契约对齐 dist/mcp/server.js 的
 * zflow handler：abort/status 必填 runId（CLI 侧 flag 是 --id）、list/scripts
 * 无参）。requireRunIdArg 的缺参报错在组帧前发生，daemon/--local 两形态一致。
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
    default:
      return null; // run/lint：恒本地，不走 daemon
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

  const { wfManager } = await assembleManager();
  try { wfManager.records.rebuildFromLog(); } catch (e) {
    process.stderr.write(`[zsw] record 重建失败（继续）: ${e && e.message || e}\n`);
  }
  const cwd = process.env.ZCODE_PROJECT_DIR || process.cwd();

  if (action === 'run') return runWorkflowRun(wfManager, args, cwd);

  switch (action) {
    case 'abort':
      process.stdout.write(`${JSON.stringify(await wfManager.abort(requireRunIdArg(args)), null, 2)}\n`);
      break;
    case 'status':
      process.stdout.write(`${JSON.stringify(wfManager.status(requireRunIdArg(args)), null, 2)}\n`);
      break;
    case 'list':
      process.stdout.write(`${JSON.stringify(wfManager.list(), null, 2)}\n`);
      break;
    case 'scripts':
      process.stdout.write(`${JSON.stringify({
        builtin: BUILTIN_WORKFLOW_INFO,
        scripts: wfManager.listScripts(cwd),
      }, null, 2)}\n`);
      break;
    case 'lint': {
      if (typeof args.file !== 'string' || args.file.trim() === '') {
        process.stderr.write('lint 需要 --file <脚本路径>（scripts 可查已发现脚本的 file 字段）\n');
        workflowUsage(1);
      }
      const { lintScript } = require('../lib/workflow-script');
      process.stdout.write(`${JSON.stringify(await lintScript(path.resolve(args.file)), null, 2)}\n`);
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
  // 嵌套守卫最前（守卫优先于事件名校验，嵌套下任何 hook 调用都零开销退出）
  if (process.env.ZSW_NESTED === '1') {
    process.stdout.write('{}\n');
    return; // 自然退出 = exit 0；不用 process.exit 防 stdout 未 flush
  }
  if (rest[0] !== 'session-start') {
    process.stderr.write(`未知 hook 事件: ${rest[0] || '(未指定)'}，支持: session-start\n`);
    usage(1);
  }
  try {
    require('../lib/hook-source').runSessionStartHook();
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
      };
      break;
    }
    case 'list':
      params = { action: 'list' };
      break;
    case 'agents':
      // 四根 agent .md 发现（start 前不确定 agent 名时先查，M1 起 CLI 唯一入口）
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

  const { manager } = await assembleManager();
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
}

main().catch((e) => {
  process.stderr.write(`[zsw] 错误: ${e && e.message || e}\n`);
  process.exit(1);
});
