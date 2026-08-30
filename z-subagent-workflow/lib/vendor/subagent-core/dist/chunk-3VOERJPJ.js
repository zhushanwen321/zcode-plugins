// src/execution/engine/engines/zcode/constants.ts
var ZCODE_ENGINE_ID = "zcode";
var ZCODE_ADAPTER_VERSION = "1.0.0";
var ZCODE_CLI_DEFAULT_PATH = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
var ZCODE_V2_CONFIG_PATH_SUFFIX = [".zcode", "v2", "config.json"];
var ZCODE_POOL_CONFIG_SUFFIX = [".zcode", "cli", "config.json"];
var ZCODE_POOL_DB_RELATIVE_PATH = ".zcode/cli/db/db.sqlite";
var ZCODE_FALLBACK_DEFAULT_MODEL = "builtin:bigmodel-coding-plan/GLM-5.3";
var ZCODE_KILL_GRACE_MS = 5e3;
var ZCODE_ERROR_TAIL_CHARS = 2e3;

export {
  ZCODE_ENGINE_ID,
  ZCODE_ADAPTER_VERSION,
  ZCODE_CLI_DEFAULT_PATH,
  ZCODE_V2_CONFIG_PATH_SUFFIX,
  ZCODE_POOL_CONFIG_SUFFIX,
  ZCODE_POOL_DB_RELATIVE_PATH,
  ZCODE_FALLBACK_DEFAULT_MODEL,
  ZCODE_KILL_GRACE_MS,
  ZCODE_ERROR_TAIL_CHARS
};
