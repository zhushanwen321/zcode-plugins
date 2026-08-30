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

// src/execution/engine/engines/zcode/constants.ts
var constants_exports = {};
__export(constants_exports, {
  ZCODE_ADAPTER_VERSION: () => ZCODE_ADAPTER_VERSION,
  ZCODE_CLI_DEFAULT_PATH: () => ZCODE_CLI_DEFAULT_PATH,
  ZCODE_ENGINE_ID: () => ZCODE_ENGINE_ID,
  ZCODE_ERROR_TAIL_CHARS: () => ZCODE_ERROR_TAIL_CHARS,
  ZCODE_FALLBACK_DEFAULT_MODEL: () => ZCODE_FALLBACK_DEFAULT_MODEL,
  ZCODE_KILL_GRACE_MS: () => ZCODE_KILL_GRACE_MS,
  ZCODE_POOL_CONFIG_SUFFIX: () => ZCODE_POOL_CONFIG_SUFFIX,
  ZCODE_POOL_DB_RELATIVE_PATH: () => ZCODE_POOL_DB_RELATIVE_PATH,
  ZCODE_V2_CONFIG_PATH_SUFFIX: () => ZCODE_V2_CONFIG_PATH_SUFFIX
});
module.exports = __toCommonJS(constants_exports);
var ZCODE_ENGINE_ID = "zcode";
var ZCODE_ADAPTER_VERSION = "1.0.0";
var ZCODE_CLI_DEFAULT_PATH = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
var ZCODE_V2_CONFIG_PATH_SUFFIX = [".zcode", "v2", "config.json"];
var ZCODE_POOL_CONFIG_SUFFIX = [".zcode", "cli", "config.json"];
var ZCODE_POOL_DB_RELATIVE_PATH = ".zcode/cli/db/db.sqlite";
var ZCODE_FALLBACK_DEFAULT_MODEL = "builtin:bigmodel-coding-plan/GLM-5.3";
var ZCODE_KILL_GRACE_MS = 5e3;
var ZCODE_ERROR_TAIL_CHARS = 2e3;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ZCODE_ADAPTER_VERSION,
  ZCODE_CLI_DEFAULT_PATH,
  ZCODE_ENGINE_ID,
  ZCODE_ERROR_TAIL_CHARS,
  ZCODE_FALLBACK_DEFAULT_MODEL,
  ZCODE_KILL_GRACE_MS,
  ZCODE_POOL_CONFIG_SUFFIX,
  ZCODE_POOL_DB_RELATIVE_PATH,
  ZCODE_V2_CONFIG_PATH_SUFFIX
});
