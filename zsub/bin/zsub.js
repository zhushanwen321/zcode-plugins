#!/usr/bin/env node
'use strict';
/**
 * zsub CLI 薄壳（决策位③入口之二，D13）：与 MCP server 共用 lib/assemble
 * 的同一 manager 组装。定位：
 *   1. 人类调试与脚本化（不需要 LLM，直接驱动五 action）
 *   2. bash 增强通道留位：本命令可被 Bash run_in_background 包裹——
 *      CLI 进程被引擎跟踪，完成时触发原生 task-notification（独立 turn
 *      唤醒 + goal gate，Z4/Z6 语义）。这是 TaskNotificationNotifier
 *      （NotifierPort 预留第三实现）的天然入口，启用后 mailbox 的
 *      「下次活动才注入」边界在此通道不复存在。
 *
 * 与 MCP 入口的差异（如实声明）：CLI 是一次性进程，start 默认 wait=true
 * （进程活着才有后台执行体）；--no-wait 仅供配合 run_in_background 使用
 * （进程不退出会阻塞 bash 任务完成通知——用 --no-wait 让命令立即返回，
 * 后续经 list/status 查询）。
 *
 * 用法：
 *   node bin/zsub.js start --task "<任务书>" --slug <短名> [--agent <名>]
 *        [--model <短名>] [--schema <json或文件路径>] [--worktree]
 *        [--conversation] [--no-wait] [--timeout-ms <n>] [--target-session <sess_id>]
 *   node bin/zsub.js list
 *   node bin/zsub.js status --id <subagentId>
 *   node bin/zsub.js message --id <subagentId> --text "<续聊消息>"
 *   node bin/zsub.js cancel --id <subagentId>
 *   node bin/zsub.js close --id <subagentId>
 *
 * 输出：stdout 一律 JSON（人读加 | jq）；诊断走 stderr。exit 0 = 命令成功。
 */

const { assembleManager } = require('../lib/assemble');

function usage(exitCode = 1) {
  process.stderr.write(
    '用法见文件头注。示例：\n'
    + '  node bin/zsub.js start --task "审查 README" --slug review\n'
    + '  node bin/zsub.js list\n'
    + '  node bin/zsub.js status --id sa-xxxx\n'
    + '  node bin/zsub.js message --id sa-xxxx --text "补充重点"\n'
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

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();
  const args = parseArgs(rest);

  const { manager } = assembleManager();
  // CLI 一次性进程：record 重建 + 探活，让 list/status 看到历史与遗留状态
  try { await manager.recover(); } catch (e) {
    process.stderr.write(`[zsub] recover 失败（继续）: ${e && e.message || e}\n`);
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
        wait: args.noWait !== true, // 默认等待（CLI 进程活着才有后台执行体）
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
    case 'message':
      result = manager.message(args.id, args.text);
      break;
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
