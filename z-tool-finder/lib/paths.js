/**
 * 共享路径常量：三个消费方（proxy / 主 server / hook+CLI）统一 require 此模块，
 * 避免数据目录解析逻辑漂移。ZTF_DATA_DIR 供测试注入隔离目录。
 */
'use strict';

const path = require('path');
const os = require('os');

const DATA_DIR = process.env.ZTF_DATA_DIR || path.join(os.homedir(), '.zcode', 'z-tool-finder');
const REGISTRY_PATH = path.join(DATA_DIR, 'registry.json');
const CATALOG_PATH = path.join(DATA_DIR, 'catalog.json');
const LOCK_PATH = path.join(DATA_DIR, 'registry.lock');
const LAUNCHER_DIR = path.join(DATA_DIR, 'launcher');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

module.exports = { DATA_DIR, REGISTRY_PATH, CATALOG_PATH, LOCK_PATH, LAUNCHER_DIR, LOGS_DIR };
