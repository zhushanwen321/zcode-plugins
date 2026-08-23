#!/usr/bin/env node
'use strict';
/**
 * zsub CLI 薄壳（决策位③入口之二，D13）：与 MCP server 共用 lib/assemble
 * 的同一 manager 组装。定位：
 *   1. 人类调试与脚本化（不需要 LLM，直接驱动七 action + workflow 六面）
 *   2. bash 增强通道留位：本命令可被 Bash run_in_background 包裹——
 *      CLI 进程被引擎跟踪，完成时触发原生 task-notification（独立 turn
 *      唤醒 + goal gate，Z4/Z6 语义）。这是 TaskNotificationNotifier
 *      （NotifierPort 预留第三实现）的天然入口，启用后 mailbox 的
 *      「下次活动才注入」边界在此通道不复存在。
 *
 * 与 MCP 入口的差异（如实声明）：CLI 是一次性进程，start 与 message 一律
 * 阻塞到本轮完成再退出——进程退出即丢失后台执行体（轮死、record 卡
 * running、outputs/通知永不产生），且无常驻组件会接管 CLI 启动的任务
 * （server 的 recover 只在启动时跑，只会把 running 标成孤儿，不会收尾）。
 * 异步启动与完成通知请走 MCP zsub tool；bash run_in_background 场景直接
 * 让 CLI 阻塞到完成即可——阻塞到完成正是该场景想要的语义（完成即通知）。
 *
 * 用法：
 *   node bin/zsub.js start --task "<任务书>" --slug <短名> [--agent <名>]
 *        [--model <短名>] [--schema <json或文件路径>] [--worktree]
 *        [--conversation] [--timeout-ms <n>] [--target-session <sess_id>]
 *   node bin/zsub.js list
 *   node bin/zsub.js status --id <subagentId>
 *   node bin/zsub.js message --id <subagentId> --text "<续聊消息>"（阻塞到本轮完成）
 *   node bin/zsub.js cancel --id <subagentId>
 *   node bin/zsub.js close --id <subagentId>
 *   node bin/zsub.js workflow [--action <run|abort|status|list|scripts|lint>]
 *        --workflow <chain|parallel|map-reduce|scatter-gather|review-fix-loop|script:<名>>
 *        --task "<任务/目标>" --workdir <绝对路径> [options]（--action 缺省 = run）
 *        （N2-b 起经 WorkflowManager：record / outputs / 完成通知与 MCP
 *         run_workflow 同源；run 同步等完成——CLI 一次性进程无后台模式，
 *         异步 runId + 完成通知走 MCP run_workflow tool）
 *
 * 输出：stdout 一律 JSON（人读加 | jq）；workflow run 默认输出 markdown 报告
 * + run 摘要 JSON 两段（--json 只出 JSON）；进度与诊断走 stderr。exit 0 = 成功。
 */

const path = require('node:path');
const { assembleManager } = require('../lib/assemble');

function usage(exitCode = 1) {
  process.stderr.write(
    '用法见文件头注。示例：\n'
    + '  node bin/zsub.js start --task "审查 README" --slug review\n'
    + '  node bin/zsub.js list\n'
    + '  node bin/zsub.js status --id sa-xxxx\n'
    + '  node bin/zsub.js message --id sa-xxxx --text "补充重点"\n'
    + '  node bin/zsub.js workflow 2>&1 | head -40   # workflow 子命令完整用法\n'
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

/** workflow 六 action（与 MCP run_workflow tool 的 action 枚举同源）。 */
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
    'zsub workflow：workflow 编排与管理（经 WorkflowManager，record/outputs/通知与 MCP run_workflow 同源）\n'
    + '\n'
    + '用法:\n'
    + '  node bin/zsub.js workflow [--action <run|abort|status|list|scripts|lint>] [options]\n'
    + '  （--action 缺省 = run；管理面 action 与 MCP run_workflow tool 一一对应）\n'
    + '\n'
    + 'run（默认）—— 同步等待完成并输出报告（CLI 一次性进程无后台模式，\n'
    + '  异步 runId + 完成通知走 MCP run_workflow）:\n'
    + '  --workflow <名>           chain / parallel / map-reduce / scatter-gather /\n'
    + '                            review-fix-loop / script:<自定义脚本名>\n'
    + '  --task <text>             任务描述（必填，自包含）\n'
    + '  --workdir <path>          工作目录（必填，绝对路径）\n'
    + '  --model <name>            模型短名（默认 GLM-5.3；仅限 provider 已启用的模型，传错会列出可用清单）\n'
    + '  --max-concurrent <n>      单 workflow 内阶段并发上限（默认 3）\n'
    + '  --timeout-per-phase <ms>  单阶段超时（默认 600000）\n'
    + '  --timeout-ms <ms>         workflow 整体超时（默认 1800000）\n'
    + '  --json                    只输出 run 摘要 JSON（默认 markdown 报告 + 摘要两段）\n'
    + '\n'
    + '  per-workflow 选项:\n'
    + '  --perspectives "a,b,c"    parallel：分析视角（默认 security,performance,maintainability）\n'
    + '  --items <json数组|a,b,c>  map-reduce：待处理条目，如 \'["a","b"]\' 或 a,b,c\n'
    + '  --operation <text>        map-reduce：对每个 item 做什么\n'
    + '  --subtask-count <n>       scatter-gather：拆分数提示（2-4）\n'
    + '  --review-target <text>    review-fix-loop：审查范围（默认 git 未提交改动）\n'
    + '  --reviewers "a,b"         review-fix-loop：审查焦点（默认 correctness,robustness）\n'
    + '  --max-rounds <n>          review-fix-loop：最大轮数（默认 5）\n'
    + '\n'
    + 'abort / status:\n'
    + '  --id <runId>              wf- 前缀的 run id（list 可查；abort 后状态落 cancelled）\n'
    + 'list:                       全部 workflow run（精简视图）\n'
    + 'scripts:                    内置 5 + 自定义脚本清单（四根发现）\n'
    + 'lint:\n'
    + '  --file <脚本路径>         校验脚本（node --check 语法 + name/description/run 契约形状）\n'
    + '\n'
    + '进度打 stderr；exit 0 = 成功（run 以终态 closed 判定）。zcode CLI 路径可用 ZSUB_ZCODE_CLI 覆盖。\n'
  );
  process.exit(exitCode);
}

function csv(v) {
  return typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
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

/** run action：组参 → 同步等完成 → 报告 + 摘要（exit code 按终态）。 */
async function runWorkflowRun(wfManager, args, cwd) {
  if (!args.workflow) { process.stderr.write('缺少 --workflow\n'); workflowUsage(1); }
  if (!args.task) { process.stderr.write('缺少 --task（必填，自包含任务书）\n'); workflowUsage(1); }
  if (!args.workdir) { process.stderr.write('缺少 --workdir\n'); workflowUsage(1); }

  const params = {
    workflow: args.workflow, // 内置名或 script:<脚本名>（合法性由 manager 校验）
    task: args.task,
    workdir: path.resolve(args.workdir),
    model: args.model,
    maxConcurrent: args.maxConcurrent ? Number(args.maxConcurrent) : undefined,
    timeoutMsPerPhase: args.timeoutPerPhase ? Number(args.timeoutPerPhase) : undefined,
    timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
    // CLI 一次性进程：同步等完成（后台执行体随进程退出而死）——与 subagent
    // start 的 CLI 语义对齐；异步启动走 MCP run_workflow
    wait: true,
    // 进度走 stderr（stdout 留给结果）；回调经 record 的 JSON 序列化自然丢弃，不落盘
    onPhase: ({ phase, status }) => process.stderr.write(`[${new Date().toISOString()}] ${phase}: ${status}\n`),
  };
  if (args.perspectives !== undefined) params.perspectives = csv(args.perspectives);
  if (args.items !== undefined) params.items = parseItems(args.items);
  if (args.operation !== undefined) params.operation = args.operation;
  if (args.subtaskCount !== undefined) params.subtaskCount = Number(args.subtaskCount);
  if (args.reviewTarget !== undefined) params.reviewTarget = args.reviewTarget;
  if (args.reviewers !== undefined) params.reviewers = csv(args.reviewers);
  if (args.maxRounds !== undefined) params.maxRounds = Number(args.maxRounds);

  const fin = await wfManager.start(params, { cwd });
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

/**
 * workflow 子命令：六个 action 统一经 WorkflowManager（N2-b 起 record 化，
 * 与 MCP run_workflow 同源）。CLI 一次性进程只重建内存索引（同 main 的
 * subagent 路径：不探活、不落盘），非终态 run 在 CLI 视角显示 lost。
 */
async function runWorkflowCommand(rest) {
  const args = parseArgs(rest);
  if (args.help === true) workflowUsage(0);

  const action = typeof args.action === 'string' ? args.action : 'run';
  if (!WORKFLOW_ACTIONS.includes(action)) {
    process.stderr.write(`不支持的 --action: ${action || '(未指定)'}，支持: ${WORKFLOW_ACTIONS.join(' / ')}\n`);
    workflowUsage(1);
  }

  const { wfManager } = await assembleManager();
  try { wfManager.records.rebuildFromLog(); } catch (e) {
    process.stderr.write(`[zsub] record 重建失败（继续）: ${e && e.message || e}\n`);
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

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();
  // workflow 子命令在 manager 组装之前分流（见 runWorkflowCommand 头注）
  if (cmd === 'workflow') return runWorkflowCommand(rest);
  const args = parseArgs(rest);

  const { manager } = await assembleManager();
  // CLI 一次性进程：只重建 record 索引（rebuild 只改内存不落盘），让
  // list/status 看到历史。刻意不走 manager.recover() 的探活段——探活会对
  // 常驻 server 正在管理的 running 任务误标 orphan 落盘（健康任务被标
  // 「建议 cancel 后重发」，且每次 CLI 调用都追加一条 update 事件）。
  // 副作用如实声明：非终态 record 在 CLI 视角显示 lost（CLI 无法确知其他
  // 进程持有执行体的死活），这是内存态，退出即消，不污染事件流。
  try { manager.records.rebuildFromLog(); } catch (e) {
    process.stderr.write(`[zsub] record 重建失败（继续）: ${e && e.message || e}\n`);
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
          '[zsub] --no-wait 已移除：CLI 一次性进程退出即丢执行体（轮死、record 卡 running），'
          + '没有常驻组件会接管 CLI 启动的后台任务。'
          + '恢复指引：去掉 --no-wait 让命令阻塞到本轮完成；'
          + '需要异步启动与完成通知请走 MCP zsub tool。\n'
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
  process.stderr.write(`[zsub] 错误: ${e && e.message || e}\n`);
  process.exit(1);
});
