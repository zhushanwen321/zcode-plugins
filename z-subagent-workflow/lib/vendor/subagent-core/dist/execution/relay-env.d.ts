/**
 * subagent relay 通道 env 名与协议常量 SSOT（docs/architecture/subagent-realtime-channel.md §5.1/§5.2/§3.1）。
 *
 * 为什么独立成模块：三方消费同一份常量——extension 侧（pi-invocation 激活判定 /
 * buildChildEnv 归属写入）、runtime 侧（env 注入与镜像校验）、代理脚本 relay.mjs
 * （零依赖脚本不能 import workspace 包，只能内嵌镜像，镜像一致性由 conformance
 * relay 变体断言锁定）。禁各处手写字符串。
 *
 * env 语义：SOCKET/NODE/SCRIPT 三者同时非空 = relay 激活（全有或全无，无中间态）；
 * SESSION_ID/RECORD_ID 是 tee 帧归属键（缺失由代理握手前自检拒绝，退出码 13）。
 */
declare const RELAY_ENV_SOCKET = "XYZ_SUBAGENT_RELAY_SOCKET";
declare const RELAY_ENV_NODE = "XYZ_SUBAGENT_RELAY_NODE";
declare const RELAY_ENV_SCRIPT = "XYZ_SUBAGENT_RELAY_SCRIPT";
declare const RELAY_ENV_SESSION_ID = "XYZ_SUBAGENT_RELAY_SESSION_ID";
declare const RELAY_ENV_RECORD_ID = "XYZ_SUBAGENT_RELAY_RECORD_ID";
/** relay 协议版本（握手帧 v 字段；runtime 与代理同包分发，不匹配=安装损坏）。 */
declare const RELAY_PROTOCOL_VERSION = 1;
/** 代理专用退出码（extension 侧表现为「子进程非零退出」→ engine_run_failed 语义）。 */
declare const RELAY_EXIT_CODES: {
    /** 握手被拒：协议版本不匹配（安装损坏，重装应用）。 */
    readonly VERSION_MISMATCH: 10;
    /** relay socket 不可达（runtime 未运行或已重启）。 */
    readonly SOCKET_UNREACHABLE: 11;
    /** socket 中途断开（runtime 崩溃等）——代理生命线断即退。 */
    readonly SOCKET_CLOSED: 12;
    /** 归属 env（SESSION_ID/RECORD_ID）缺失——防无归属帧污染广播。 */
    readonly MISSING_IDENTITY: 13;
};
/** 激活判定：三 env 同时非空才走 relay，任一缺失回落直连 spawn 真实 pi（TUI/独立 pi 零回归）。 */
declare function isRelayActive(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean;

export { RELAY_ENV_NODE, RELAY_ENV_RECORD_ID, RELAY_ENV_SCRIPT, RELAY_ENV_SESSION_ID, RELAY_ENV_SOCKET, RELAY_EXIT_CODES, RELAY_PROTOCOL_VERSION, isRelayActive };
