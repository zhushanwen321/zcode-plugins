#!/usr/bin/env node
'use strict';
/**
 * zsub CLI 薄壳（决策位③入口之二，D13）：与 MCP server 共用 lib/assemble
 * 的同一 manager 组装。定位：
 *   1. 人类调试与脚本化（不需要 LLM，直接驱动六 action）
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
 *   node bin/zsub.js workflow --workflow <chain|parallel|map-reduce|scatter-gather|review-fix-loop>
 *        --task "<任务/目标>" --workdir <绝对路径> [options]
 *        （参数面照源 dynamic-workflow/bin CLI；--workflow 子命令不经
 *        manager 组装——workflow 是独立编排通道，与 subagent 生命周期无关）
 *
 * 输出：stdout 一律 JSON（人读加 | jq）；workflow 子命令默认输出 markdown
 * 报告 + JSON 两段（--json 只出 JSON）；进度与诊断走 stderr。exit 0 = 命令成功。
 */

const path = require('node:path');
const fs = require('node:fs');
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

const WORKFLOW_NAMES = ['chain', 'parallel', 'map-reduce', 'scatter-gather', 'review-fix-loop'];

function workflowUsage(exitCode = 1) {
  process.stderr.write(
    'zsub workflow：不经 MCP 直接驱动 5 种内置 workflow（测试与脚本化入口，参数面照 dynamic-workflow CLI）\n'
    + '\n'
    + '用法:\n'
    + '  node bin/zsub.js workflow --workflow <chain|parallel|map-reduce|scatter-gather|review-fix-loop>'
    + ' --task "<任务/目标>" --workdir <绝对路径> [options]\n'
    + '\n'
    + '通用选项:\n'
    + '  --task <text>             任务描述（map-reduce 可选，其余必填）\n'
    + '  --workdir <path>          工作目录（必填，绝对路径）\n'
    + '  --model <name>            模型短名（默认 GLM-5.3；可选 GLM-4.7-Flash 等）\n'
    + '  --max-concurrent <n>      并发上限（默认 3）\n'
    + '  --timeout-per-phase <ms>  单阶段超时（默认 600000）\n'
    + '  --json                    只输出结果 JSON（默认 markdown 报告 + JSON 两段）\n'
    + '\n'
    + 'per-workflow 选项:\n'
    + '  --perspectives "a,b,c"    parallel：分析视角（默认 security,performance,maintainability）\n'
    + '  --items <json数组|a,b,c>  map-reduce：待处理条目，如 \'["a","b"]\' 或 a,b,c\n'
    + '  --operation <text>        map-reduce：对每个 item 做什么\n'
    + '  --subtask-count <n>       scatter-gather：拆分数提示（2-4）\n'
    + '  --review-target <text>    review-fix-loop：审查范围（默认 git 未提交改动）\n'
    + '  --reviewers "a,b"         review-fix-loop：审查焦点（默认 correctness,robustness）\n'
    + '  --max-rounds <n>          review-fix-loop：最大轮数（默认 5）\n'
    + '\n'
    + '进度打 stderr；exit 0 = 成功。zcode CLI 路径可用 ZSUB_ZCODE_CLI 覆盖。\n'
  );
  process.exit(exitCode);
}

function csv(v) {
  return typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}

/** --items 双形态：源 CLI 的 JSON 数组（'["a","b"]'）优先，逗号分隔（a,b,c）回退。 */
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

/**
 * workflow 子命令：独立编排通道，不经 assembleManager（不做 record 探活、
 * 不碰 mailbox）——workflow 每阶段自起隔离 session，与 subagent 生命周期无关。
 */
async function runWorkflowCommand(rest) {
  const args = parseArgs(rest);
  if (args.help === true) workflowUsage(0);

  const name = args.workflow;
  if (!WORKFLOW_NAMES.includes(name)) {
    process.stderr.write(`不支持的工作流: ${name || '(未指定)'}，支持: ${WORKFLOW_NAMES.join(' / ')}\n`);
    workflowUsage(1);
  }
  if (name !== 'map-reduce' && !args.task) { process.stderr.write('缺少 --task\n'); workflowUsage(1); }
  if (!args.workdir) { process.stderr.write('缺少 --workdir\n'); workflowUsage(1); }
  if (name === 'map-reduce' && !args.operation) { process.stderr.write('map-reduce 缺少 --operation\n'); workflowUsage(1); }

  const workdir = path.resolve(args.workdir);
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    process.stderr.write(`workdir 不存在或不是目录: ${workdir}\n`);
    process.exit(1);
  }

  // 按需 require：非 workflow 子命令不加载 workflow 模块（CLI 启动保持薄）
  const { runChain } = require('../lib/workflow/chain');
  const { runParallel } = require('../lib/workflow/parallel');
  const { runMapReduce } = require('../lib/workflow/map-reduce');
  const { runScatterGather } = require('../lib/workflow/scatter-gather');
  const { runReviewFixLoop } = require('../lib/workflow/review-fix-loop');
  const { buildMarkdownReport } = require('../lib/workflow/report');

  const common = {
    workdir,
    model: args.model,
    maxConcurrent: args.maxConcurrent ? Number(args.maxConcurrent) : 3,
    timeoutMsPerPhase: args.timeoutPerPhase ? Number(args.timeoutPerPhase) : 600000,
    // 进度走 stderr（照源 CLI）：stdout 留给最终结果，便于管道消费
    onPhase: ({ phase, status }) => process.stderr.write(`[${new Date().toISOString()}] ${phase}: ${status}\n`),
  };

  let result;
  switch (name) {
    case 'chain':
      result = await runChain({ ...common, task: args.task });
      break;
    case 'parallel':
      result = await runParallel({ ...common, task: args.task, perspectives: csv(args.perspectives) });
      break;
    case 'map-reduce':
      result = await runMapReduce({ ...common, task: args.task, items: parseItems(args.items), operation: args.operation });
      break;
    case 'scatter-gather':
      result = await runScatterGather({ ...common, task: args.task, subtaskCount: args.subtaskCount ? Number(args.subtaskCount) : undefined });
      break;
    case 'review-fix-loop':
      result = await runReviewFixLoop({
        ...common, task: args.task,
        reviewTarget: args.reviewTarget, reviewers: csv(args.reviewers),
        maxRounds: args.maxRounds ? Number(args.maxRounds) : undefined,
      });
      break;
  }

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    // 照源 CLI：markdown 报告（人读）+ 分隔线 + JSON（机器）两段
    process.stdout.write(`\n${'='.repeat(60)}\nmarkdown 报告:\n${'='.repeat(60)}\n`);
    process.stdout.write(buildMarkdownReport(result));
    process.stdout.write(`\n${'='.repeat(60)}\nJSON 数据:\n${'='.repeat(60)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();
  // workflow 子命令在 manager 组装之前分流（见 runWorkflowCommand 头注）
  if (cmd === 'workflow') return runWorkflowCommand(rest);
  const args = parseArgs(rest);

  const { manager } = assembleManager();
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
