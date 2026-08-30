"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/execution/relay-env.ts
var relay_env_exports = {};
__export(relay_env_exports, {
  RELAY_ENV_NODE: () => RELAY_ENV_NODE,
  RELAY_ENV_RECORD_ID: () => RELAY_ENV_RECORD_ID,
  RELAY_ENV_SCRIPT: () => RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID: () => RELAY_ENV_SESSION_ID,
  RELAY_ENV_SOCKET: () => RELAY_ENV_SOCKET,
  RELAY_EXIT_CODES: () => RELAY_EXIT_CODES,
  RELAY_PROTOCOL_VERSION: () => RELAY_PROTOCOL_VERSION,
  isRelayActive: () => isRelayActive
});
module.exports = __toCommonJS(relay_env_exports);
var RELAY_ENV_SOCKET = "XYZ_SUBAGENT_RELAY_SOCKET";
var RELAY_ENV_NODE = "XYZ_SUBAGENT_RELAY_NODE";
var RELAY_ENV_SCRIPT = "XYZ_SUBAGENT_RELAY_SCRIPT";
var RELAY_ENV_SESSION_ID = "XYZ_SUBAGENT_RELAY_SESSION_ID";
var RELAY_ENV_RECORD_ID = "XYZ_SUBAGENT_RELAY_RECORD_ID";
var RELAY_PROTOCOL_VERSION = 1;
var RELAY_EXIT_CODES = {
  /** 握手被拒：协议版本不匹配（安装损坏，重装应用）。 */
  VERSION_MISMATCH: 10,
  /** relay socket 不可达（runtime 未运行或已重启）。 */
  SOCKET_UNREACHABLE: 11,
  /** socket 中途断开（runtime 崩溃等）——代理生命线断即退。 */
  SOCKET_CLOSED: 12,
  /** 归属 env（SESSION_ID/RECORD_ID）缺失——防无归属帧污染广播。 */
  MISSING_IDENTITY: 13
};
function isRelayActive(env) {
  return Boolean(env[RELAY_ENV_SOCKET] && env[RELAY_ENV_NODE] && env[RELAY_ENV_SCRIPT]);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RELAY_ENV_NODE,
  RELAY_ENV_RECORD_ID,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_SOCKET,
  RELAY_EXIT_CODES,
  RELAY_PROTOCOL_VERSION,
  isRelayActive
});
