// src/execution/relay-env.ts
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

export {
  RELAY_ENV_SOCKET,
  RELAY_ENV_NODE,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_RECORD_ID,
  RELAY_PROTOCOL_VERSION,
  RELAY_EXIT_CODES,
  isRelayActive
};
