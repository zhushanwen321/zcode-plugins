'use strict';

/**
 * 从模型自由文本中提取结构化 JSON（无 --schema 支持，靠 prompt 约定 + 容错解析）。
 * 解析顺序：整个文本 → ```json 围栏块 → 首个平衡大括号段。
 * @returns {object|null} 解析失败返回 null
 */

function extractJsonObject(text) {
  if (!text || typeof text !== 'string') return null;

  // 1) 整体就是 JSON
  try { const v = JSON.parse(text.trim()); if (isObj(v)) return v; } catch { /* next */ }

  // 2) ```json ... ``` 围栏块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { const v = JSON.parse(fence[1].trim()); if (isObj(v)) return v; } catch { /* next */ }
  }

  // 3) 首个平衡的 {...} 段（忽略字符串字面量内的花括号）
  const start = text.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = inStr; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const v = JSON.parse(text.slice(start, i + 1));
            if (isObj(v)) return v;
          } catch { return null; }
        }
      }
    }
  }
  return null;
}

/** 从 JSON 对象里取一个字符串数组字段（如 subtasks 名称列表），失败返回 null。 */
function stringArray(obj, key) {
  const v = obj?.[key];
  if (!Array.isArray(v)) return null;
  const out = v.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
  return out.length ? out : null;
}

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

module.exports = { extractJsonObject, stringArray };
