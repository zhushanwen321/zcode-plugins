/** zcode 引擎的 registry key。 */
declare const ZCODE_ENGINE_ID = "zcode";
/** zcode 适配器版本（handle.adapterVersion 数据源——golden 样本对齐排查锚点）。 */
declare const ZCODE_ADAPTER_VERSION = "1.0.0";
/**
 * zcode CLI 缺省路径（12.4MB node bundle，不在 PATH——2026-08-25 实测）。
 * 组合根可用 deps.cliPath 覆盖（测试注入 / 未来安装形态变化）。
 */
declare const ZCODE_CLI_DEFAULT_PATH = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
/**
 * 唯一凭据源 config（桌面端登录态，zsub V2_CONFIG_PATH 同构）。
 * 为什么绝不读 ~/.zcode/cli/config.json：它不在 ZCode GUI 管理面，可能残留历史
 * 验证配置（2026-08-25 事故：8/24 zsub 开发残留把默认模型劫持到失效 router 端点，
 * turn 0 即 401）；桌面端登录凭据落在 v2/config.json，是 zsub 生产验证过的凭据源。
 */
declare const ZCODE_V2_CONFIG_PATH_SUFFIX: readonly [".zcode", "v2", "config.json"];
/** 池内 config.json 相对隔离 HOME 的位置（CLI 只读 $HOME/.zcode/cli/config.json）。 */
declare const ZCODE_POOL_CONFIG_SUFFIX: readonly [".zcode", "cli", "config.json"];
/**
 * 池内 db.sqlite 相对隔离 HOME 的位置（handle.sessionRef.dbPath 的值——相对池目录
 * 自描述，read 时经 resolvePoolDir + 该相对路径重定位，设计 §3.3.6）。
 */
declare const ZCODE_POOL_DB_RELATIVE_PATH = ".zcode/cli/db/db.sqlite";
/** zsub 同构的兜底缺省模型（v2 config 无 model.main 且 task 未指定时）。 */
declare const ZCODE_FALLBACK_DEFAULT_MODEL = "builtin:bigmodel-coding-plan/GLM-5.3";
/** 杀链 grace 窗口：SIGTERM 后等这么久再 SIGKILL（zsub 同构 5s；实测 SIGTERM→exit 仅 103ms）。 */
declare const ZCODE_KILL_GRACE_MS = 5000;
/** 错误信息里保留的 stdout 尾部长度（engine_run_failed 规格：够诊断、不刷屏）。 */
declare const ZCODE_ERROR_TAIL_CHARS = 2000;

export { ZCODE_ADAPTER_VERSION, ZCODE_CLI_DEFAULT_PATH, ZCODE_ENGINE_ID, ZCODE_ERROR_TAIL_CHARS, ZCODE_FALLBACK_DEFAULT_MODEL, ZCODE_KILL_GRACE_MS, ZCODE_POOL_CONFIG_SUFFIX, ZCODE_POOL_DB_RELATIVE_PATH, ZCODE_V2_CONFIG_PATH_SUFFIX };
