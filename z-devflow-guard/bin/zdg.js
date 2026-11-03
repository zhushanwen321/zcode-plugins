#!/usr/bin/env node
/**
 * z-devflow-guard CLI。
 * 子命令：hook user-prompt-submit | hook mark | hook guard | status | waive
 * hook 子命令由 hooks/hooks.json 调用；status/waive 供人工检查与手工豁免。
 */
'use strict';

const { STATE_DIR, FINGERPRINT_ROOT, FINGERPRINT_SUBSTR, SKILL_TRIGGER_SUBSTR, NESTED_ENV_KEYS } = require('../lib/config');
const state = require('../lib/state');
const { extractTaskDirs } = require('../lib/fingerprint');
const guard = require('../lib/guard');

const USAGE = [
  '用法：zdg <command>',
  '',
  '  hook user-prompt-submit   UserPromptSubmit hook 入口（hooks.json 调用，勿手工使用）',
  '  hook mark                 PreToolUse 内容工具/Skill hook 入口（指纹与技能打标记）',
  '  hook guard                PreToolUse Agent/Task hook 入口（拦截判定，exit 2 = 拒绝）',
  '  status [sessionId]        查看会话标记与当前裁决（默认取 CLAUDE_SESSION_ID）',
  '  waive [sessionId]         写本会话豁免文件（误判救济通道）',
].join('\n');

function isNested() {
  return NESTED_ENV_KEYS.some((k) => process.env[k]);
}

function readStdinJson() {
  try {
    return JSON.parse(require('fs').readFileSync(0, 'utf8'));
  } catch {
    return null; // 无 stdin（手工运行）或非 JSON：按无输入信息处理
  }
}

function sessionIdFromEnvOrArg(arg) {
  return arg || process.env.CLAUDE_SESSION_ID || 'default';
}

// 规则 1 的源①：用户输入命中 dev-flow 字样（matcher 已在 hooks.json 正则层过滤，此处直接打标记）
function cmdUserPromptSubmit() {
  if (isNested()) return 0;
  try {
    state.markStart(STATE_DIR, process.env.CLAUDE_SESSION_ID || 'default', 'user-prompt');
  } catch (err) {
    // 打标记失败不阻断会话（辅助功能降级），错误落 stderr 供日志排查
    process.stderr.write('[z-devflow-guard] mark failed: ' + (err && err.stack ? err.stack : String(err)) + '\n');
  }
  return 0;
}

// 源②③：Skill(dev-flow-wf) 调用 / 内容工具参数含 skill-data/dev-flow/ 指纹
function cmdMark() {
  if (isNested()) return 0;
  try {
    const sessionId = process.env.CLAUDE_SESSION_ID || 'default';
    const input = readStdinJson();
    const toolInput = input && input.tool_input ? input.tool_input : {};
    if (input && input.tool_name === 'Skill') {
      const skillText = String(toolInput.skill || '') + ' ' + String(toolInput.args || '');
      if (skillText.includes(SKILL_TRIGGER_SUBSTR)) state.markStart(STATE_DIR, sessionId, 'skill');
      return 0;
    }
    const serialized = JSON.stringify(toolInput);
    if (serialized.includes(FINGERPRINT_SUBSTR)) {
      state.markStart(STATE_DIR, sessionId, 'fingerprint');
      for (const dir of extractTaskDirs(serialized)) {
        state.addTaskDir(STATE_DIR, sessionId, dir);
      }
    }
  } catch (err) {
    process.stderr.write('[z-devflow-guard] mark failed: ' + (err && err.stack ? err.stack : String(err)) + '\n');
  }
  return 0;
}

// 拦截判定：exit 2 = 拒绝（stderr 内容回给主 agent）；其余一律放行
function cmdGuard() {
  if (isNested()) return 0;
  const sessionId = process.env.CLAUDE_SESSION_ID || 'default';
  let verdict;
  try {
    verdict = guard.decide({ stateDir: STATE_DIR, fingerprintRoot: FINGERPRINT_ROOT, sessionId });
  } catch (err) {
    // 判定异常放行（fail-open）+ stderr 留痕：守卫自身的故障不能拖垮正常派发，日志里可追
    process.stderr.write('[z-devflow-guard] 判定异常已放行，请检查: ' + (err && err.stack ? err.stack : String(err)) + '\n');
    return 0;
  }
  if (!verdict.allow) {
    process.stderr.write(verdict.message + '\n');
    return 2;
  }
  return 0;
}

function cmdStatus(arg) {
  const sessionId = sessionIdFromEnvOrArg(arg);
  const mark = state.readMark(STATE_DIR, sessionId);
  process.stdout.write('session: ' + state.sanitizeSessionId(sessionId) + '\n');
  process.stdout.write('state dir: ' + STATE_DIR + '\n');
  if (!mark) {
    process.stdout.write('guard: 未进入 dev-flow 执行态（无标记）\n');
    return 0;
  }
  process.stdout.write('started at: ' + mark.startedAt + ' sources: ' + mark.sources.join(',') + '\n');
  for (const dir of mark.taskDirs) {
    const terminal = guard.taskDirTerminal(FINGERPRINT_ROOT, dir) ? '终局' : '执行中';
    process.stdout.write('  task dir: ' + dir + ' -> ' + terminal + '\n');
  }
  process.stdout.write('waived: ' + (state.isWaived(STATE_DIR, sessionId) ? '是（本会话已豁免）' : '否') + '\n');
  const verdict = guard.decide({ stateDir: STATE_DIR, fingerprintRoot: FINGERPRINT_ROOT, sessionId });
  process.stdout.write('verdict: ' + (verdict.allow ? 'allow（' + verdict.reason + '）' : 'deny（Agent/Task 派发将被拦截）') + '\n');
  return 0;
}

function cmdWaive(arg) {
  const sessionId = sessionIdFromEnvOrArg(arg);
  state.waive(STATE_DIR, sessionId);
  process.stdout.write('waived: ' + state.waivePath(STATE_DIR, sessionId) + '（仅本会话生效）\n');
  return 0;
}

function main(argv) {
  const [cmd, sub, arg] = argv;
  if (cmd === 'hook' && sub === 'user-prompt-submit') return cmdUserPromptSubmit();
  if (cmd === 'hook' && sub === 'mark') return cmdMark();
  if (cmd === 'hook' && sub === 'guard') return cmdGuard();
  if (cmd === 'status') return cmdStatus(sub);
  if (cmd === 'waive') return cmdWaive(sub);
  process.stderr.write(USAGE + '\n');
  return 1;
}

process.exit(main(process.argv.slice(2)));
