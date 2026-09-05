#!/usr/bin/env node
'use strict';
/**
 * zsw CLI（2.0 起：纯本地一次性执行，无常驻 daemon）。
 *
 * 执行模型：每个子命令是一次性进程——start/workflow run 的执行体就在 CLI
 * 进程内，进程活着任务才活着，命令阻塞到任务终态才退出。长任务的承载方式
 * 是 Bash run_in_background（CLI 阻塞进程成为引擎进程内 background 任务，
 * 完成时触发原生 task-notification 唤醒会话；前台 Bash 有工具超时，禁止
 * 包裹长任务）。历史形态：1.x 的常驻 daemon（unix socket thin client）随
 * 宿主缺位问题移除——MCP server 壳被 z-tool-finder 懒启动代理接管后永不
 * spawn，daemon 无宿主；本版起 socket/daemon/MCP 壳整条链路退役，状态面
 * 全部落盘（records.jsonl + workflow-state/*.jsonl），无常驻物、无收尸问题。
 *
 * 用法：
 *   node bin/zsw.js start --task "<任务书>" --slug <短名> [--agent <.md绝对路径>]
 *        （agent 仅收 .md 绝对路径，支持 ~/ 展开——传名字会被拒并给路径指引
 *         （报错与 core agent-registry 同源）；缺省不传 = 加载 vendored
 *         general-purpose 内置角色（project 级同名可遮蔽），不想要角色请显式
 *         传自定义 .md 路径。路径清单先查 zsw agents 的 location/file 列）
 *        [--model <短名>] [--schema <json或文件路径>] [--worktree]
 *        [--conversation] [--timeout-ms <n>] [--wait]
 *        [--thinking <low|high|max>]
 *        [--allow-tools <逗号分隔工具名>] [--deny-tools <逗号分隔工具名>]
 *        （--wait：接受但无行为差异——start 恒阻塞到本轮完成；--thinking：
 *         请求值未被引擎通道映射，终态 record 落 thinking="null (请求未生
 *         效：引擎通道未映射)" 如实标注；--allow-tools：引擎无白名单 flag
 *         通道不消费，终态 record 落 toolsNote 如实标注；--deny-tools：与
 *         agent .md frontmatter disallowedTools 并集去重后落引擎
 *         --disallowed-tools flag 硬生效）
 *   node bin/zsw.js list
 *   node bin/zsw.js status --id <subagentId>
 *   node bin/zsw.js message --id <subagentId> --text "<续聊消息>"（续聊执行线不可用——调用会收到明确不可用错误）
 *   node bin/zsw.js cancel --id <subagentId>
 *   node bin/zsw.js close --id <subagentId>
 *   node bin/zsw.js agents                        # 可用 agent .md 清单（vendored 内置 + 四根；start 只收路径，先查 location/file 列）
 *   node bin/zsw.js models [--all]                # 可用模型清单（缺省默认 provider；--all 全 provider 视图，模型为全名 <provider>/<model>）
 *   node bin/zsw.js workflow [--action <run|abort|status|list|scripts|lint|script-generate|script-save|script-delete>]
 *        --workflow <内置名|.js绝对路径（~/ 可展开）> --task "<任务/目标>" --workdir <绝对路径>
 *        [options]（--action 缺省 = run；workflow 引用契约（D-4/D-E3）：script:<名>
 *        拒收；内置名 / 已保存脚本名（scripts 清单，D-E3 裸名放行）/ .js 绝对
 *        路径合法——报错自带恢复指引。全部 action 恒本地；run 同步阻塞到终态，
 *        用 Bash run_in_background 包裹即原生完成通知；一次性进程的
 *        abort/status/list 只有本进程创建的 run 视图，历史 run 快照在
 *        <zsw 数据根>/workflow-state/*.jsonl 直读）
 *   node bin/zsw.js hook session-start
 *        （SessionStart hook 入口，stdout 输出资源快照协议 JSON；嵌套环境或
 *         任一异常降级 {} + exit 0，绝不阻断会话启动。引擎注册面用
 *         bin/zsw-hook.js；本子命令仅调试）
 *   node bin/zsw.js doctor [--json]               # 会话残留只读体检（五面量级 +
 *        白名单双口径 + 13 表行数 + 预估回收粗估；--json 出结构化报告）
 *   node bin/zsw.js doctor clean                  # 清理执行器（后续单元接线，
 *        当前仅体检可用；执行属停机窗口手动操作）
 *
 * --local flag：1.x 的 daemon/本地双形态遗产，2.0 起本地是唯一形态——
 * flag 接受但忽略（旧脚本零改动迁移）。
 *
 * start exit code：任务终态 closed/idle（conversation 本轮完成）→ 0；
 * cancelled/error/timeout/lost → 1。
 * workflow run exit 0 = reason=completed。
 *
 * 输出：stdout 一律 JSON（人读加 | jq）；workflow run 默认输出 markdown 报告
 * + run 摘要 JSON 两段（--json 只出 JSON）；进度与诊断走 stderr。exit 0 = 成功。
 */

const path = require('node:path');
const { isNestedEnv, zswCliPath } = require('../lib/config');
const { assembleManager } = require('../lib/assemble');
const { execZsubAction } = require('../lib/zsub-actions');
const coreRef = require('../lib/core-ref');
const { buildKnownWorkflowNames, ensureConfigured } = require('../lib/orchestration-host');
// MF-1：引用契约 + script-* 创作闭环收口到 lib/workflow-actions.js（镜像
// zsub-actions 模式）——MCP/daemon 入口不再反向 require CLI 入口模块取业务逻辑
const {
  validateWorkflowRef,
  knownWorkflowNames,
  scriptGenerateAction,
  scriptSaveAction,
  scriptDeleteAction,
  runningScriptPredicate,
  requireScriptActionName,
} = require('../lib/workflow-actions');

// MF-4：本进程已组装的 wfHost 引用——main catch 错误出口的引擎收口依据
// （runWorkflowCommand 与 main 各自组装后回填；未组装即失败时为 null，收口 no-op）
let activeWfHost = null;

function usage(exitCode = 1) {
  process.stderr.write(
    '用法见文件头注。示例：\n'
    + '  node bin/zsw.js start --task "审查 README" --slug review\n'
    + '  node bin/zsw.js list\n'
    + '  node bin/zsw.js status --id sa-xxxx\n'
    + '  node bin/zsw.js message --id sa-xxxx --text "补充重点"\n'
    + '  node bin/zsw.js agents                        # 可用 agent .md 清单（vendored 内置 + 四根；start 只收路径，先查 location/file 列）\n'
    + '  node bin/zsw.js models [--all]                # 可用模型清单（模型为全名 <provider>/<model>）\n'
    + '  node bin/zsw.js workflow 2>&1 | head -40   # workflow 子命令完整用法\n'
    + '  node bin/zsw.js workflow --action list      # workflow run 清单（本进程视图）\n'
    + '  node bin/zsw.js hook session-start           # SessionStart hook 快照输出（异常降级 {}）\n'
    + '  node bin/zsw.js doctor [--json]              # 会话残留只读体检（五面量级 + 预估回收粗估）\n'
    + '  node bin/zsw.js doctor clean                 # 清理执行器（后续单元接线，当前仅体检可用）\n'
    + '  node bin/zsw.js start --wait --task "..." --slug x   # start（恒阻塞到完成；--wait 接受但无差异）\n'
    + '                                                   # 长任务用 Bash run_in_background 包裹，完成即原生通知\n'
    + '  node bin/zsw.js list --local                  # --local 已无行为差异（接受但忽略）\n'
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

/**
 * start 的 --schema 解析（daemon 与 --local 两形态共用，防漂移）：非绝对路径
 * 的 .json 文件路径读成内容字符串，其余值（JSON 字面量 / 绝对路径 / 未传）
 * 原样透传给 manager。
 */
function schemaArg(schema) {
  if (typeof schema === 'string' && /^\//.test(schema) === false && /\.json$/.test(schema)) {
    return require('node:fs').readFileSync(schema, 'utf8');
  }
  return schema;
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
    + '  （--action 缺省 = run；全部 action 恒本地一次性执行）\n'
    + '\n'
    + 'run（默认）—— 同步阻塞到终态并输出报告（执行体 = CLI 进程；长任务用\n'
    + '  Bash run_in_background 包裹，完成即引擎原生通知）:\n'
    + '  --workflow <ref>           内置名（chain / parallel / map-reduce /\n'
    + '                            scatter-gather / review-fix-loop）、已保存脚本名\n'
    + '                            （scripts 清单，D-E3 裸名放行）或 .js 绝对路径\n'
    + '                            （~/ 前缀可展开）。script:<名> 已废弃拒收\n'
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
    + 'abort / status / list / scripts / script-save / script-delete（管理面，恒本地）:\n'
    + '  --id <runId>              abort/status 必填：wf- 前缀的 run id。一次性进程\n'
    + '                            只有本进程创建的 run 视图；历史 run 快照在\n'
    + '                            <zsw 数据根>/workflow-state/*.jsonl 直读\n'
    + 'list:                       本进程 run 视图（历史快照见上）\n'
    + 'scripts:                    vendored 内置 5 + 用户脚本（core 发现面 + .zsw 根）\n'
    + 'script-save:\n'
    + '  --name <脚本名>           tmp → ~/.zsw/workflows/ 固化（重名拒绝；固化后\n'
    + '                            scripts 清单可见、run 按绝对路径引用）\n'
    + 'script-delete:\n'
    + '  --name <脚本名>           删 tmp 或已固化脚本（一次性进程无运行中 runs\n'
    + '                            视图，恒放行——并发 run 的删除冲突由进程自身\n'
    + '                            生命周期排除：同一时刻只有一个执行体）\n'
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

// ------- workflow 引用契约（D-4）+ 创作闭环（W8 / D-6）实现已收口 lib/workflow-actions.js（MF-1）

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
 *
 * 异步化（C17/D-E3）：knownNames 构建（发现面扫描）是异步——cwd 口径与
 * runWorkflowCommand 传给 host 的 ctx.cwd 同源（ZCODE_PROJECT_DIR || cwd），
 * 同一目录集两入口产出同一 knownNames 集（⛔D）。
 */
async function buildWorkflowRunParams(args, cwd) {
  // U1（F02 同款惯例）：发现面扫描前显式 ensureConfigured——knownNames 的
  // saved 名依赖 discoveryRoots（~/.zsw/workflows 借 user-pi 槽）注入，未组装
  // host 的进程直调本函数会静默缩水成内置 5 名。幂等（进程级 flag），已配置
  // 时零开销；CLI 正常路径经 runWorkflowCommand → assembleManager 已配置，
  // 此处是对直调导出面的防御收口
  ensureConfigured();
  // D-4/D-E3 引用契约入口（CLI 面）：script: 前缀拒收、saved 裸名放行
  // （knownNames = 内置 + 发现面 saved 名）、非法 ref 在此拦下不进 host
  validateWorkflowRef(args.workflow, await buildKnownWorkflowNames(coreRef.requireCore(), cwd));
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
  const code = process.exitCode || 0;
  // S-1：兜底 timer 在 shutdown 之前武装——dispose 挂起（pipe stdio 永不关）
  // 时 shutdown promise 永不 resolve，事后武装的 250ms timer 无从调度
  const hangGuard = setTimeout(() => process.exit(code), 5000).unref();
  return Promise.resolve()
    .then(() => (wfHost && typeof wfHost.shutdown === 'function' ? wfHost.shutdown() : undefined))
    .catch((e) => {
      process.stderr.write(`[zsw] engine 收口失败（继续退出）: ${e && e.message || e}\n`);
    })
    .then(() => {
      clearTimeout(hangGuard);
      setTimeout(() => process.exit(code), 250).unref();
    });
}

/** run action：组参 → host.runAndWait 同步等终态 → 报告 + 摘要（exit 按终态）。 */
async function runWorkflowRun(wfHost, args, cwd) {
  requireWorkflowRunArgs(args);
  const params = await buildWorkflowRunParams(args, cwd);
  // CLI 一次性进程：同步等完成（后台执行体随进程退出而死）——与 subagent
  // start 的 CLI 语义对齐。异步需求走 Bash run_in_background 包裹本命令（引擎
  // 原生 task-notification 唤醒）。
  const fin = await wfHost.runAndWait(params, { cwd });
  renderWorkflowRunOutput(fin, args);
  // appserver 常驻引擎的 pipe stdio 挂事件循环（见 exitAfterEngineShutdown 头注）
  await exitAfterEngineShutdown(wfHost);
}

/**
 * workflow 子命令（全 action 恒本地）：
 * - run 同步阻塞（执行体 = CLI 进程本身，bash run_in_background 包裹即
 *   原生通知）；lint/script-generate 纯文件校验/写盘；管理面 abort/status/
 *   list/scripts/script-save/script-delete 全部走本地 orchestration host。
 * - 一次性进程只重建内存索引：abort/status/list 只有本进程创建的 run 视图
 *   （历史 run 快照在 <zsw 数据根>/workflow-state/*.jsonl，直读）；并发场
 *   景由「同一时刻只有一个执行体（bash run_in_background 串行派发）」约定
 *   兜住，不再有常驻 daemon 的跨进程 runs 表。
 * - 嵌套拒绝前置（MF2：ensureNotNested——嵌套里本地跑同样递归）。
 */
async function runWorkflowCommand(rest) {
  ensureNotNested();
  const args = parseArgs(rest);
  if (args.help === true) workflowUsage(0);

  const action = typeof args.action === 'string' ? args.action : 'run';
  if (!WORKFLOW_ACTIONS.includes(action)) {
    process.stderr.write(`不支持的 --action: ${action || '(未指定)'}，支持: ${WORKFLOW_ACTIONS.join(' / ')}\n`);
    workflowUsage(1);
  }

  // 本地路径走 orchestration host（vendored subagent-core）。
  // 一次性进程不重水合历史 run（内存 runs 空，list 显示为空；历史快照在
  // <zsw 数据根>/workflow-state/，可直读）
  const { wfHost } = await assembleManager();
  activeWfHost = wfHost; // main catch 错误出口的引擎收口依据（MF-4）
  const cwd = process.env.ZCODE_PROJECT_DIR || process.cwd();

  if (action === 'run') return runWorkflowRun(wfHost, args, cwd);

  return dispatchWorkflowLocalAction(wfHost, action, args, cwd);
}

// workflow 本地 action 分发
async function dispatchWorkflowLocalAction(wfHost, action, args, cwd) {
  switch (action) {
    case 'abort': {
      const id = requireRunIdArg(args);
      // MF-3：一次性进程内存 runs 只有本进程创建的视图——run 不在本进程时
      // core.abortRun 必 throw not found（跨进程执行体本进程无法终止）。如实
      // 返回指引而非让调用方吃无上下文的报错：kill 承载 run 的后台 Bash 任务
      // （引擎 TaskStop），stateFile 快照可直读对端终态
      const runs = wfHost.list();
      const local = Array.isArray(runs) && runs.some((r) => r && r.runId === id);
      if (!local) {
        process.stderr.write(
          `[zsw] run ${id} 不在本进程（一次性 CLI 无跨进程 runs 表，无法代为中止）。`
          + '恢复指引：用引擎 TaskStop kill 承载该 workflow run 的后台 Bash 任务；'
          + '终态快照在 <zsw 数据根>/workflow-state/ 直读。\n',
        );
        process.stdout.write(`${JSON.stringify({ runId: id, aborted: false, reason: 'not-in-process' }, null, 2)}\n`);
        process.exitCode = 1;
        break;
      }
      process.stdout.write(`${JSON.stringify(await wfHost.abort(id), null, 2)}\n`);
      break;
    }
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
      // --local 一次性进程无 runs 视图：runningScriptPredicate 对空 runs Map 恒
      // false（如实声明——「运行中拒绝」的真实裁决只在 daemon 面）。S-2：无法
      // 检测其他进程正在运行该脚本（跨进程无 runs 表），stderr 告警而非静默
      process.stderr.write('[zsw] 提示：本进程无法检测其他 CLI 进程正在运行该脚本（一次性进程无跨进程 runs 视图），删除前请自行确认无并发 run。\n');
      process.stdout.write(`${JSON.stringify(scriptDeleteAction(args.name, runningScriptPredicate(wfHost)), null, 2)}\n`);
      break;
    }
  }
}

// ------------------------------------------------------ hook 子命令（SessionStart）

/**
 * SessionStart hook 入口（恒本地执行——hook 在会话启动内联跑，冷启动须 < 500ms）。
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
 *     本入口顶层依赖全链（assemble/record-store 等），插件文件
 *     不完整时模块加载即 exit 1，此 try 无从生效（惰性 require 降加载面为
 *     后续优化项）。引擎会话启动面必须走 hooks.json 指向的 bin/zsw-hook.js
 *     （自包含薄入口，加载面兜底同语义）。
 * 数据组装/渲染/降级语义（D4/D5/D6 三条硬约束与口径）见 lib/hook-source.js 头注。
 */
function runHookCommand(rest) {
  // 嵌套守卫最前（守卫优先于事件名校验，嵌套下任何 hook 调用零开销退出；
  // F03 双标记判定，谓词权威源 lib/config isNestedEnv）
  if (isNestedEnv()) {
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

// ------------------------------------------------------ doctor 子命令（只读体检）

/**
 * doctor 子命令（u1 = 体检骨架；采集/渲染语义见 lib/doctor.js 头注）。
 * 恒本地只读（不经 assembleManager 引擎组装面——与 workflow/hook 同为纯本地
 * 命令，在 main 组装之前分流）。doctor 依赖 node:sqlite，故本函数内 lazy
 * require（start 等主链路加载面不扩大）。
 *
 * rest[0] === 'clean'：清理执行器属 u3 领地，当前显式拒绝并给指引（exit 1，
 * 不静默；--dry-run 同样走此分支——dry-run 渲染也随 u2/u3 接线）。
 */
function runDoctorCommand(rest) {
  const { collect, renderText, renderJson } = require('../lib/doctor');
  if (rest[0] === 'clean') {
    process.stderr.write(
      '[zsw] doctor clean 执行器在后续单元接线，当前仅体检可用。'
      + `恢复指引：先跑 node "${zswCliPath()}" doctor 看残留量级；`
      + '清理属停机窗口手动操作（退出 ZCode 后执行），随执行器单元交付。\n',
    );
    process.exit(1);
  }
  const args = parseArgs(rest);
  let report;
  try {
    report = collect();
  } catch (e) {
    // node:sqlite 不可用：可操作错误（指向 Node 升级）+ exit 1，不 crash 无堆栈
    if (e && e.code === 'NODE_SQLITE_UNAVAILABLE') {
      process.stderr.write(`[zsw] ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  if (args.json === true) process.stdout.write(renderJson(report));
  else process.stdout.write(renderText(report));
}

// ------------------------------------------- 子命令公共面

/**
 * 嵌套防递归检查：zsub 面与 workflow 子命令共用同一文案与退出码，防两处漂移。
 */
function ensureNotNested() {
  // F03 双标记判定（isNestedEnv）：core 引擎嵌套派发的会话只带
  // XYZ_AGENT_SUBAGENT=1，只查 ZSW_NESTED 会让 CLI 面门禁失效
  if (isNestedEnv()) {
    process.stderr.write(
      '嵌套环境禁止编排（防递归，ZSW_NESTED=1 或 XYZ_AGENT_SUBAGENT=1）。'
      + '恢复指引：subagent 会话内不要编排，由主会话派发。\n'
    );
    process.exit(1);
  }
}

/**
 * zsub 子命令白名单：执行面查 lib/zsub-actions 表（单源）。agents/models 为
 * 纯本地发现面（agent-discovery / model-router），2.0 起与 daemon 解耦直接放行
 * （1.x 它们是 daemon 端口面）；wait 已随 daemon 退役（无跨进程执行体可等）。
 */
const SUBCOMMANDS = new Set(['start', 'list', 'status', 'message', 'cancel', 'close', 'agents', 'models']);

/** parseArgs 对重复 flag 只留末值；wait 的多 --id 形态已随 wait 退役。 */

/**
 * start 子命令 flag → params 翻译。start 恒阻塞（wait: true——CLI 进程活着
 * 才有执行体）；--wait flag 接受但无差异（1.x start --wait 习惯形态的零改动兼容）。
 */
function buildStartParams(args) {
  if (!args.task || !args.slug) usage();
  if (args.noWait === true) {
    // --no-wait 已移除：CLI 一次性进程下它必然丢执行体（轮死、record 卡
    // running），没有任何常驻组件会接管。显式报错优于静默忽略。
    process.stderr.write(
      '[zsw] --no-wait 已移除：CLI 一次性进程退出即丢执行体（轮死、record 卡 running）。'
      + '恢复指引：去掉 --no-wait 让命令阻塞到本轮完成；'
      + '需要异步启动与完成通知，用 Bash run_in_background 包裹本命令'
      + `（node "${zswCliPath()}" start --task "..." --slug x），完成即引擎原生 task-notification。\n`
    );
    process.exit(1);
  }
  return {
    task: args.task,
    slug: args.slug,
    agent: args.agent,
    model: args.model,
    schema: schemaArg(args.schema),
    worktree: args.worktree === true,
    conversation: args.conversation === true,
    wait: true, // CLI 进程活着才有后台执行体（--wait/--no-wait 见上）
    timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
    ...startCapabilityArgs(args), // thinking 与 CLI 工具限制参数面
  };
}

/**
 * zsub 子命令 flag → params 翻译（argv 组参是 CLI 特有职责；SUBCOMMANDS 白名单
 * 已在调用侧过滤，default 不可达）。
 */
function buildZsubParams(cmd, args) {
  switch (cmd) {
    case 'start':
      return buildStartParams(args);
    case 'list':
      return {};
    case 'agents':
      // agent .md 发现（core 发现面：vendored 内置角色 + 四根；D-4a 后 start
      // 只收路径——不确定路径时先查，输出带 location/file 列）
      return {};
    case 'models':
      // 模型路由清单；--all 出全 provider 视图（跨 provider 必须全名
      // <provider>/<model>，兜底链闭合），缺省 = 默认 provider 视图
      return args.all === true ? { all: true } : {};
    case 'status':
      return { subagentId: args.id };
    case 'message':
      // message 的续聊执行线已移除（manager.message 恒 throw）——该入口收敛为
      // 纯错误路径（id 不存在 / 非 conversation / 状态非 idle），由表 exec 直返。
      return { subagentId: args.id, text: args.text };
    case 'cancel':
      return { subagentId: args.id };
    case 'close':
      return { subagentId: args.id };
    default:
      return undefined; // 白名单已过滤，不可达
  }
}

/** MF-5：start 的 exit code 契约（头注声明 closed/idle → 0，其余 → 1）。
 *  终态取顶层 result.status：manager.start(wait=true) 返回扁平对象
 *  {subagentId, slug, status, ...}（无 record 键——record 只在内部
 *  _runFirstRound 返回里；MF-1 修复前读 result.record.status 恒 undefined，
 *  失败终态全部静默 exit 0）。CLI 恒 wait:true，start 出口必经此函数。 */
function applyStartExitCode(cmd, result) {
  if (cmd === 'start' && result && typeof result.status === 'string') {
    process.exitCode = (result.status === 'closed' || result.status === 'idle') ? 0 : 1;
  }
}

/**
 * zsub 面执行流程：parseArgs → 嵌套检查 → 组装（record 重建）→ 查表执行 → 输出。
 * 返回 wfHost 供调用侧引擎收口（MF-4）。
 */
async function runZsubCommand(cmd, rest) {
  const args = parseArgs(rest);
  // MF2：嵌套拒绝（防递归边界：嵌套子会话内编排会递归 spawn 真实引擎进程）
  ensureNotNested();

  const { manager, wfHost } = await assembleManager();
  activeWfHost = wfHost; // main catch 错误出口的引擎收口依据（MF-4）
  // CLI 一次性进程：只重建 record 索引（rebuild 只改内存不落盘），让
  // list/status 看到历史。刻意不走探活——探活会对其他进程正在跑的任务误标
  // orphan 落盘。副作用如实声明：非终态 record 在 CLI 视角显示 lost（CLI 无法
  // 确知其他进程持有执行体的死活），这是内存态，退出即消，不污染事件流。
  try { manager.records.rebuildFromLog(); } catch (e) {
    process.stderr.write(`[zsw] record 重建失败（继续）: ${e && e.message || e}\n`);
  }

  const cwd = process.env.ZCODE_PROJECT_DIR || process.cwd();
  const ctx = {
    cwd,
    // CLI 无 _meta 通道；显式 --target-session 才有 mailbox 定向（高级用法）
    targetSessionId: typeof args.targetSession === 'string' ? args.targetSession : undefined,
  };

  if (!SUBCOMMANDS.has(cmd)) {
    process.stderr.write(`未知子命令: ${cmd}\n`);
    usage();
  }

  const params = buildZsubParams(cmd, args);

  // 查表执行（单一 action 表单源）；错误 throw 由 main catch 打印 [zsw] 错误
  // + exit 1
  const result = await execZsubAction(cmd, params, ctx, {
    manager,
    ports: { agentResolver: manager.resolver, modelRouter: manager.modelRouter },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  applyStartExitCode(cmd, result);
  return wfHost;
}

async function main() {
  // ZSW_RUNNER 校验前置（回接 2c）：立即报退役错误，不依赖组装时机
  // （hook/workflow 子命令不经组装面，但 env 误配同样应尽早在用户可见面出声）
  try {
    require('../lib/assemble').assertRunnerEnv();
  } catch (e) {
    process.stderr.write(`[zsw] 错误: ${e && e.message || e}\n`);
    process.exit(1);
  }
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();
  // workflow 子命令在 manager 组装之前分流
  if (cmd === 'workflow') return runWorkflowCommand(rest);
  // hook 子命令同理在 manager 组装之前分流：恒本地（见 runHookCommand 头注），
  // 不走 parseArgs/assembleManager 任一路径
  if (cmd === 'hook') return runHookCommand(rest);
  // doctor 同为纯本地只读命令（体检不经引擎组装面；node:sqlite 在函数内 lazy
  // require，主链路加载面不扩大）
  if (cmd === 'doctor') return runDoctorCommand(rest);

  // wait 已随 daemon 退役（2.0 无常驻物）：等待 = start 本身阻塞到任务终态，
  // 长任务异步化靠 Bash run_in_background 包裹 start（完成即引擎原生通知）。
  if (cmd === 'wait') {
    process.stderr.write(
      '[zsw] wait 已移除（2.0 起无常驻 daemon，本地一次性进程没有跨进程执行体可等）。'
      + '恢复指引：node "' + zswCliPath() + '" start --wait --task "..." --slug x'
      + '（start 恒阻塞到完成，--wait 接受但无差异）；'
      + '长任务用 Bash run_in_background 包裹该命令，完成即引擎原生 task-notification。\n'
    );
    process.exit(1);
  }

  const wfHost = await runZsubCommand(cmd, rest);
  // 一次性进程的引擎收口（start/message 跑完任务后 appserver 常驻子进程的
  // stdio 挂住事件循环，防 CLI 无法退出）
  await exitAfterEngineShutdown(wfHost);
}

// require.main 守卫：test/cli.test.js 与 test/orchestration-host.test.js 经
// require 复用导出函数（bin 直接执行时行为不变）。模块加载零副作用；副作用只
// 发生在显式调用的 script-* action 函数体内（写 tmp/saved 目录）。
module.exports = {
  parseArgs,
  csv,
  // MF-1：W8 创作闭环（D-6）+ workflow 引用契约（D-4/D-E3）实现已收口
  // lib/workflow-actions.js，此处 re-export 维持既有消费面（测试与旧引用）不变
  validateWorkflowRef,
  knownWorkflowNames,
  scriptGenerateAction,
  scriptSaveAction,
  scriptDeleteAction,
  runningScriptPredicate,
  // MF-7：start exit code 契约导出（测试钉住五终态 → exit code 映射，与 MF-1
  // 修复联动——黑盒 start 须跑真引擎，契约由单测锁定）
  applyStartExitCode,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[zsw] 错误: ${e && e.message || e}\n`);
    // MF-4：错误出口同样收口引擎——runAndWait/execZsubAction 中途 throw 时
    // appserver 常驻子进程不能变孤儿。exitAfterEngineShutdown 内部自吞错误并
    // 以 process.exitCode（此处恒 1）调度兜底退出
    process.exitCode = 1;
    exitAfterEngineShutdown(activeWfHost);
  });
}
