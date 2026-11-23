/**
 * 路径与常量。
 * ZQW_DATA_DIR 供测试注入隔离目录；ZQW_QUOTA_WAIT_CLI 覆盖 quota-wait 技能 CLI 位置
 * （默认指向本机技能安装路径，见 README 依赖说明）。
 */
'use strict';

const os = require('os');
const path = require('path');

const PLUGIN_ROOT = path.dirname(__dirname);

const DATA_DIR = process.env.ZQW_DATA_DIR || path.join(os.homedir(), '.zcode', 'z-quota-watch');
const STATE_DIR = path.join(DATA_DIR, 'state');
const COUNT_DIR = path.join(STATE_DIR, 'count');

const DB_PATH = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
const USER_CONFIG_PATH = path.join(os.homedir(), '.zcode', 'cli', 'config.json');

const QUOTA_WAIT_CLI = process.env.ZQW_QUOTA_WAIT_CLI ||
  path.join(os.homedir(), '.agents', 'skills', 'quota-wait', 'scripts', 'quota-wait.mjs');

// ps 扫描标记：守望 wrapper 的文件名 + --session 参数共同定位会话归属
const WATCH_BINARY = 'zqw-watch.js';

const GATE_THRESHOLD = 20; // 门控阈值：工具调用计数超过 20 触发一次完整检测并清零计数
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000; // 守望启动失败后的注入冷却
const COUNT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 计数文件保留期
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 会话状态目录保留期
const DEFAULT_SUPPRESS_MS = 24 * 60 * 60 * 1000; // 叫停守望的默认静默时长

module.exports = {
  PLUGIN_ROOT,
  DATA_DIR,
  STATE_DIR,
  COUNT_DIR,
  DB_PATH,
  USER_CONFIG_PATH,
  QUOTA_WAIT_CLI,
  WATCH_BINARY,
  GATE_THRESHOLD,
  FAILURE_COOLDOWN_MS,
  COUNT_TTL_MS,
  SESSION_TTL_MS,
  DEFAULT_SUPPRESS_MS,
};
