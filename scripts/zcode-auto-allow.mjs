#!/usr/bin/env node
// zcode-auto-allow.mjs — ZCode hook：自动放行权限审批
//
// 挂接两个事件（ZCode hook 协议，stdin 单行 JSON / stdout 单行 JSON）：
// - PreToolUse：返回 permissionDecision:"allow"，在弹层之前直接短路普通工具审批；
// - PermissionRequest：返回 decision.behavior:"allow"，与 UI 弹层竞速应答，
//   覆盖 PreToolUse 抹不掉的类型（alwaysAsk 类，如 workflow 运行确认）。
//
// 注意边界（源码证实）：静态 deny 规则、plan 门禁、guarded 模式危险命令
// user-once 单次确认不会被本 hook 放行。要彻底无审批用 permission.mode=yolo。
//
// 排除清单：需要「先收集用户输入」才能执行的工具，放行 = 短路答案收集，
// 执行器拿不到用户输入直接报 "requires user answers before execution"。
// 两个事件分支都要排：PermissionRequest 与弹层竞速应答，只排 PreToolUse
// 的话问题仍会被自动放行。
//
// 安装：本文件是权威源（本仓 main/scripts/），经 symlink 挂到
// ~/.agents/scripts/zcode-auto-allow.mjs，由 ~/.zcode/cli/config.json 的
// hooks 字段（PreToolUse + PermissionRequest，matcher *）绝对路径引用。
// hook 每次工具调用重新拉起进程，改本文件即时生效，无需重启 ZCode。

const USER_INTERACTION_TOOLS = new Set(["AskUserQuestion"]);

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input = {};
try {
  input = JSON.parse(raw);
} catch {
  // 解析失败按未知事件处理，不输出放行（fail-closed）
  process.exit(0);
}

const event = input.hook_event_name ?? "";
const isUserInteractionTool = USER_INTERACTION_TOOLS.has(input.tool_name ?? "");

if (isUserInteractionTool) {
  // 交还宿主正常流程（弹问题收集答案），本 hook 不裁决
  process.exit(0);
}

if (event === "PreToolUse") {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "auto-allowed by zcode-auto-allow hook",
    },
  }));
} else if (event === "PermissionRequest") {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  }));
}
// 其他事件不输出，直接退出（退出码 0 = hook 正常完成、无裁决）
