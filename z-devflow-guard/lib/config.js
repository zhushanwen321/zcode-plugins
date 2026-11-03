/**
 * 守卫常量与路径。所有可变性集中在这一处，测试经环境变量注入隔离目录。
 */
'use strict';

const os = require('os');
const path = require('path');

const PLUGIN_NAME = 'z-devflow-guard';

// 会话状态根：标记文件与豁免文件都在这里，按会话 id 分片
const DATA_DIR = process.env.ZDG_DATA_DIR || path.join(os.homedir(), '.zcode', PLUGIN_NAME);
const STATE_DIR = path.join(DATA_DIR, 'state');

// 指纹根：dev-flow 任务产物目录。守卫只读它做终态判定，绝不写。
const FINGERPRINT_ROOT = process.env.ZDG_FINGERPRINT_ROOT || path.join(os.homedir(), '.agents', 'skill-data', 'dev-flow');

// 指纹子串：内容工具参数中出现即视为接触了 dev-flow 任务产物；含尾斜杠，
// 提取任务目录时直接取其后第一段（不带尾斜杠的裸提及没有路径语义，不算命中）
const FINGERPRINT_SUBSTR = 'skill-data/dev-flow/';

// 状态文件里标记「这轮 run 已终局」的事件名（dev-flow-wf flow/compile.md §4）
const RUN_TERMINAL_EVENT = 'run-terminal';

// 节点 status 词表（compile.md §4）：终值集与非终值集互补
const TERMINAL_NODE_STATUS = new Set(['done', 'blocked', 'failed', 'suspended']);
const ACTIVE_NODE_STATUS = new Set(['pending', 'in-progress']);

// 无头嵌套会话（其他工具 spawn 的 zcode 子进程）不参与守卫，与 z-words-reminder 同一份黑名单
const NESTED_ENV_KEYS = ['ZDG_NESTED', 'ZWR_NESTED', 'ZSW_NESTED', 'ZSUB_NESTED', 'TF_NESTED'];

// 状态文件保留期：超过后惰性清理（mtime 不再刷新 = 会话早已结束）
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Skill 工具的 tool_input 里出现该子串视为调用了 dev-flow-wf 技能
const SKILL_TRIGGER_SUBSTR = 'dev-flow-wf';

module.exports = {
  PLUGIN_NAME,
  DATA_DIR,
  STATE_DIR,
  FINGERPRINT_ROOT,
  FINGERPRINT_SUBSTR,
  RUN_TERMINAL_EVENT,
  TERMINAL_NODE_STATUS,
  ACTIVE_NODE_STATUS,
  NESTED_ENV_KEYS,
  STATE_TTL_MS,
  SKILL_TRIGGER_SUBSTR,
};
