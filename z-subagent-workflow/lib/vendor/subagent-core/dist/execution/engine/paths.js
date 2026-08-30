// src/execution/engine/paths.ts
import { join } from "path";
var MAX_SEG_CHARS = 80;
function sanitizeSeg(input) {
  const s = input.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return s.length > 0 ? s.slice(0, MAX_SEG_CHARS) : "default";
}
function resolveEnginesRoot(dataDir) {
  return join(dataDir, "engines");
}
function resolveEngineDir(dataDir, engineId) {
  return join(resolveEnginesRoot(dataDir), sanitizeSeg(engineId));
}
function resolvePoolDir(dataDir, engineId, poolKey) {
  return join(resolveEngineDir(dataDir, sanitizeSeg(engineId)), sanitizeSeg(poolKey));
}
function resolveJournalPath(dataDir, engineId, poolKey, taskId) {
  return join(resolvePoolDir(dataDir, engineId, poolKey), `journal-${sanitizeSeg(taskId)}.jsonl`);
}
export {
  resolveEngineDir,
  resolveEnginesRoot,
  resolveJournalPath,
  resolvePoolDir,
  sanitizeSeg
};
