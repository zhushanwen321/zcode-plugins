/**
 * 拦截判定：纯确定性。输入 = 会话标记 + 指纹根磁盘事实，输出 = 放行或拒绝。
 *
 * 终态判定锚（dev-flow-wf flow/compile.md §4）：status.json 的 events 数组
 * 含 run-terminal 汇总事件（{node:"-", event:"run-terminal", ...}）即该轮 run
 * 已终局；防御性补充——events 缺失的老格式按「全部节点 status 已到终值集」判定。
 * 两条都不满足 = 非终态 = 执行中 = 拦。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { RUN_TERMINAL_EVENT, TERMINAL_NODE_STATUS } = require('./config');
const state = require('./state');

// 单个 status.json 是否已终局
function isStatusFileTerminal(filePath) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false; // 解析失败按非终态处理：宁可误拦（有豁免通道），不放走执行中任务
  }
  const events = Array.isArray(doc.events) ? doc.events : [];
  if (events.some((e) => e && e.event === RUN_TERMINAL_EVENT)) return true;
  const nodes = doc.nodes && typeof doc.nodes === 'object' ? doc.nodes : {};
  const statuses = Object.values(nodes)
    .filter((v) => v && typeof v === 'object')
    .map((v) => v.status);
  return statuses.length > 0 && statuses.every((s) => TERMINAL_NODE_STATUS.has(s));
}

// 一个任务目录是否全部 status.json 已终局；目录下没有任何 status.json = 任务尚未建档，放行
function taskDirTerminal(root, taskDir) {
  const dir = path.join(root, taskDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return true; // 目录不存在 = 指纹是历史残留路径，无在途任务
  }
  const files = entries.filter((n) => n.endsWith('.status.json'));
  if (files.length === 0) return true;
  return files.every((n) => isStatusFileTerminal(path.join(dir, n)));
}

/**
 * 守卫裁决。
 * 返回 { allow: boolean, reason: string, message: string }
 * message 仅在拒绝时给出，带恢复动作（错误 → 权威源 → 重试）。
 */
function decide(opts) {
  const stateDir = opts.stateDir;
  const fingerprintRoot = opts.fingerprintRoot;
  const sessionId = opts.sessionId;

  if (state.isWaived(stateDir, sessionId)) {
    return { allow: true, reason: 'waived', message: '' };
  }
  const mark = state.readMark(stateDir, sessionId);
  if (!mark) {
    return { allow: true, reason: 'no-mark', message: '' };
  }
  const pending = mark.taskDirs.filter((d) => !taskDirTerminal(fingerprintRoot, d));
  if (pending.length === 0) {
    return { allow: true, reason: 'all-terminal', message: '' };
  }
  const waiveFile = state.waivePath(stateDir, sessionId);
  const message = [
    '[z-devflow-guard] 拦截：本会话已进入 dev-flow 执行态（关联任务目录：' + pending.join('、') + '），禁止用 Agent 工具在主会话单独派发 subagent。',
    '正确做法：用 CreateWorkflow 发起当前阶段契约的 workflow（各阶段对应的 saved workflow 名见 ~/.agents/skills/dev-flow-wf/flow/ 下文档）；workflow 内部的 agent() 派发由引擎执行，不经本拦截。',
    '确属误判（复盘/分析类会话，或 workflow 发起失败后的合规降级）时，写本会话豁免文件后重试原操作：',
    '  touch ' + waiveFile,
    '豁免按会话隔离，仅对当前会话生效一次。',
  ].join('\n');
  return { allow: false, reason: 'active-task', message };
}

module.exports = { isStatusFileTerminal, taskDirTerminal, decide };
