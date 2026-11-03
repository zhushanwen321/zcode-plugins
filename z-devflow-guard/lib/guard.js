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
 * 在途任务目录的特征串：目录名 + 各 status.json 的 name 字段。
 * 拦截依据是派发内容是否指向这些任务（任务书必引用产物路径与任务名），
 * 与 subagent 类型名无关；目录已全部终局时返回空数组——已终局任务的产物
 * 路径出现在派发内容里属于复盘/考古类合法派发，不拦。
 */
function taskDirSignatures(root, taskDir) {
  const dir = path.join(root, taskDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files = entries.filter((n) => n.endsWith('.status.json'));
  if (files.length === 0 || taskDirTerminal(root, taskDir)) return [];
  const sigs = [taskDir];
  for (const n of files) {
    try {
      const name = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).name;
      // 下限防超短任务名（如 "run"）在无关派发内容里误命中
      if (typeof name === 'string' && name.length >= 4 && !sigs.includes(name)) sigs.push(name);
    } catch {
      // 解析失败跳过该文件的 name，目录名特征仍在
    }
  }
  return sigs;
}

/**
 * 守卫裁决。
 * dispatchText = 本次 Agent 派发的任务内容（prompt + description）。
 * 拦截条件（三者同时）：会话有 dev-flow 执行态标记 && 存在在途任务目录
 * && 派发内容命中该任务的特征串。其他一切派发（无关任务、终局任务考古）放行。
 * 返回 { allow: boolean, reason: string, message: string }
 */
function decide(opts) {
  const stateDir = opts.stateDir;
  const fingerprintRoot = opts.fingerprintRoot;
  const sessionId = opts.sessionId;
  const dispatchText = typeof opts.dispatchText === 'string' ? opts.dispatchText : '';

  if (state.isWaived(stateDir, sessionId)) {
    return { allow: true, reason: 'waived', message: '' };
  }
  const mark = state.readMark(stateDir, sessionId);
  if (!mark) {
    return { allow: true, reason: 'no-mark', message: '' };
  }
  const signatures = [];
  const activeDirs = [];
  for (const d of mark.taskDirs) {
    const sigs = taskDirSignatures(fingerprintRoot, d);
    if (sigs.length) {
      activeDirs.push(d);
      signatures.push(...sigs);
    }
  }
  if (activeDirs.length === 0) {
    return { allow: true, reason: 'all-terminal', message: '' };
  }
  const matched = signatures.filter((s) => dispatchText.includes(s));
  if (matched.length === 0) {
    return { allow: true, reason: 'unrelated-dispatch', message: '' };
  }
  const waiveFile = state.waivePath(stateDir, sessionId);
  const message = [
    '[z-devflow-guard] 拦截：本次派发内容指向在途 dev-flow 任务（任务目录：' + activeDirs.join('、') + '；命中特征：' + matched.slice(0, 3).join('、') + '），禁止用 Agent 工具在主会话单独派发 subagent。',
    '正确做法：用 CreateWorkflow 发起当前阶段契约的 workflow（各阶段对应的 saved workflow 名见 ~/.agents/skills/dev-flow-wf/flow/ 下文档）；workflow 内部的 agent() 派发由引擎执行，不经本拦截。',
    '确属误判（派发内容只是引用了任务产物，实际工作与该任务无关；或 workflow 发起失败后的合规降级）时，写本会话豁免文件后重试原操作：',
    '  touch ' + waiveFile,
    '豁免按会话隔离，仅对当前会话生效一次。',
  ].join('\n');
  return { allow: false, reason: 'dispatch-to-active-task', message };
}

module.exports = { isStatusFileTerminal, taskDirTerminal, taskDirSignatures, decide };
