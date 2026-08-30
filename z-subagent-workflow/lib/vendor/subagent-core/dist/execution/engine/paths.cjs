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

// src/execution/engine/paths.ts
var paths_exports = {};
__export(paths_exports, {
  resolveEngineDir: () => resolveEngineDir,
  resolveEnginesRoot: () => resolveEnginesRoot,
  resolveJournalPath: () => resolveJournalPath,
  resolvePoolDir: () => resolvePoolDir,
  sanitizeSeg: () => sanitizeSeg
});
module.exports = __toCommonJS(paths_exports);
var import_node_path = require("path");
var MAX_SEG_CHARS = 80;
function sanitizeSeg(input) {
  const s = input.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return s.length > 0 ? s.slice(0, MAX_SEG_CHARS) : "default";
}
function resolveEnginesRoot(dataDir) {
  return (0, import_node_path.join)(dataDir, "engines");
}
function resolveEngineDir(dataDir, engineId) {
  return (0, import_node_path.join)(resolveEnginesRoot(dataDir), sanitizeSeg(engineId));
}
function resolvePoolDir(dataDir, engineId, poolKey) {
  return (0, import_node_path.join)(resolveEngineDir(dataDir, sanitizeSeg(engineId)), sanitizeSeg(poolKey));
}
function resolveJournalPath(dataDir, engineId, poolKey, taskId) {
  return (0, import_node_path.join)(resolvePoolDir(dataDir, engineId, poolKey), `journal-${sanitizeSeg(taskId)}.jsonl`);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  resolveEngineDir,
  resolveEnginesRoot,
  resolveJournalPath,
  resolvePoolDir,
  sanitizeSeg
});
