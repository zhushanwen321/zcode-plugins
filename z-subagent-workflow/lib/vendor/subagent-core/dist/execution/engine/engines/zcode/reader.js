import {
  ZCODE_ENGINE_ID
} from "../../../../chunk-3VOERJPJ.js";

// src/execution/engine/engines/zcode/reader.ts
import * as fs from "fs";
var ZcodeReaderError = class extends Error {
  code;
  /** 原始失败细节（缺文件/表漂移/运行时不支持）。 */
  detail;
  constructor(detail, hint) {
    super(
      `[engine_session_read_failed] zcode \u539F\u751F session \u8BFB\u53D6\u5931\u8D25\uFF1A${detail}\u3002` + (hint ?? "\u8C03\u7528\u65B9\u5E94\u964D\u7EA7\u5230\u7B2C\u2461\u7EA7\uFF08\u5BBF\u4E3B event journal\uFF09\u6216\u7B2C\u2462\u7EA7\uFF08outcome-only\uFF09\u3002")
    );
    this.name = "ZcodeReaderError";
    this.code = "engine_session_read_failed";
    this.detail = detail;
  }
};
function parseJsonField(raw, ctx) {
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : void 0;
  } catch (err) {
    throw new ZcodeReaderError(
      `${ctx} \u884C data \u4E0D\u662F\u5408\u6CD5 JSON\uFF08${err instanceof Error ? err.message : String(err)}\uFF09`,
      "db \u5185\u5BB9\u635F\u574F\u6216\u7248\u672C\u4E0D\u517C\u5BB9\u2014\u2014\u8C03\u7528\u65B9\u5E94\u964D\u7EA7\u5230\u7B2C\u2461\u7EA7\uFF08\u5BBF\u4E3B event journal\uFF09\u3002"
    );
  }
}
function finiteOr(v, fallback) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function usageFromStepFinish(part) {
  const tokens = part.tokens;
  if (typeof tokens !== "object" || tokens === null) return void 0;
  const t = tokens;
  const cache = typeof t.cache === "object" && t.cache !== null ? t.cache : {};
  if (t.input === void 0 && t.output === void 0) return void 0;
  return {
    input: finiteOr(t.input, 0),
    output: finiteOr(t.output, 0),
    cacheRead: finiteOr(cache.read, 0),
    cacheWrite: finiteOr(cache.write, 0)
  };
}
function toolFromPart(part) {
  const toolName = typeof part.tool === "string" ? part.tool : "unknown";
  let state;
  if (typeof part.state === "string") {
    try {
      const v = JSON.parse(part.state);
      state = typeof v === "object" && v !== null ? v : void 0;
    } catch {
      state = void 0;
    }
  }
  const status = typeof state?.status === "string" ? state.status : "unknown";
  const output = state?.output;
  return {
    toolName,
    ...state?.input !== void 0 ? { args: state.input } : {},
    // 输出形态（实测）：string（内容）或 object（结构化）——分别映射到 pi ToolCallResult
    // 的 content[] / details，不发明第二形状
    ...typeof output === "string" ? { result: { content: [output] } } : {},
    ...typeof output === "object" && output !== null ? { result: { details: output } } : {},
    ...status !== "completed" ? { isError: true } : {}
  };
}
var TotalsAcc = class {
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  cost = 0;
  has = false;
  add(u) {
    this.has = true;
    this.input += u.input;
    this.output += u.output;
    this.cacheRead += u.cacheRead;
    this.cacheWrite += u.cacheWrite;
    this.cost += u.cost ?? 0;
  }
  toTotal() {
    if (!this.has) return void 0;
    return {
      input: this.input,
      output: this.output,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      cost: this.cost,
      total: this.input + this.output + this.cacheRead + this.cacheWrite
    };
  }
};
function closeTurn(acc, turns, totals) {
  if (acc === null) return;
  turns.push({ text: acc.text, thinking: acc.thinking, toolCalls: acc.toolCalls, closed: true });
  if (acc.usageDelta !== void 0) totals.add(acc.usageDelta);
}
function rowToMessageRow(v) {
  if (typeof v === "object" && v !== null && "id" in v && "data" in v) {
    const r = v;
    if (typeof r.id === "string" && typeof r.data === "string") return { id: r.id, data: r.data };
  }
  throw new ZcodeReaderError("message \u884C\u5F62\u72B6\u5F02\u5E38\uFF08id/data \u5217\u7F3A\u5931\u6216\u7C7B\u578B\u6F02\u79FB\uFF09");
}
function rowToPartRow(v) {
  if (typeof v === "object" && v !== null && "data" in v) {
    const r = v;
    if (typeof r.data === "string") return { data: r.data };
  }
  throw new ZcodeReaderError("part \u884C\u5F62\u72B6\u5F02\u5E38\uFF08data \u5217\u7F3A\u5931\u6216\u7C7B\u578B\u6F02\u79FB\uFF09");
}
function resolveSessionId(db, sessionId) {
  if (sessionId !== void 0) {
    const hit = db.prepare("SELECT id FROM session WHERE id = ?").get(sessionId);
    if (hit === void 0) {
      throw new ZcodeReaderError(
        `session \u4E0D\u5B58\u5728\uFF1A${sessionId}`,
        "sessionId \u53EF\u80FD\u6765\u81EA\u5DF2\u6E05\u7406\u7684\u6C60\u2014\u2014\u964D\u7EA7\u5230 outcome-only\u3002"
      );
    }
    return sessionId;
  }
  const latest = db.prepare("SELECT id FROM session ORDER BY time_created DESC LIMIT 1").get();
  if (latest === void 0 || typeof latest.id !== "string") {
    throw new ZcodeReaderError("db \u5185\u65E0\u4EFB\u4F55 session \u884C");
  }
  return latest.id;
}
function loadGroupedParts(db, sessionId) {
  const grouped = /* @__PURE__ */ new Map();
  for (const raw of db.prepare(
    "SELECT part.message_id AS mid, part.data AS data FROM part JOIN message ON part.message_id = message.id WHERE part.session_id = ? ORDER BY message.sequence, part.sequence"
  ).all(sessionId)) {
    if (typeof raw !== "object" || raw === null || !("mid" in raw)) continue;
    const mid = String(raw.mid);
    const arr = grouped.get(mid) ?? [];
    arr.push(rowToPartRow(raw));
    grouped.set(mid, arr);
  }
  return grouped;
}
function appendPartText(current, part) {
  return current === "" ? String(part.text ?? "") : current + "\n" + String(part.text ?? "");
}
function applyPartToTurn(part, acc, turns, totals) {
  switch (part.type) {
    case "text":
      acc = acc ?? { text: "", thinking: "", toolCalls: [] };
      acc.text = appendPartText(acc.text, part);
      return acc;
    case "reasoning":
      acc = acc ?? { text: "", thinking: "", toolCalls: [] };
      acc.thinking = appendPartText(acc.thinking, part);
      return acc;
    case "tool":
      acc = acc ?? { text: "", thinking: "", toolCalls: [] };
      acc.toolCalls.push(toolFromPart(part));
      return acc;
    case "step-finish": {
      const u = usageFromStepFinish(part);
      const cost = finiteOr(part.cost, 0);
      if (acc === null) acc = { text: "", thinking: "", toolCalls: [] };
      if (u !== void 0) acc.usageDelta = cost > 0 ? { ...u, cost } : u;
      closeTurn(acc, turns, totals);
      return null;
    }
    default:
      return acc;
  }
}
function collectTurns(messages, grouped, totals) {
  const turns = [];
  for (const msg of messages) {
    const parsedMsg = parseJsonField(msg.data, "message");
    if (parsedMsg?.role !== "assistant") continue;
    let acc = null;
    for (const partRow of grouped.get(msg.id) ?? []) {
      const part = parseJsonField(partRow.data, "part");
      if (part === void 0) continue;
      acc = applyPartToTurn(part, acc, turns, totals);
    }
    closeTurn(acc, turns, totals);
  }
  return turns;
}
function buildView(db, sessionId) {
  const messages = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY sequence").all(sessionId).map(rowToMessageRow);
  const totals = new TotalsAcc();
  const turns = collectTurns(messages, loadGroupedParts(db, sessionId), totals);
  const usageTotal = totals.toTotal();
  return {
    engineId: ZCODE_ENGINE_ID,
    sessionId,
    ...usageTotal !== void 0 ? { usage: usageTotal } : {},
    turns,
    source: "native"
  };
}
async function readZcodeSessionView(dbPath, sessionId) {
  if (!fs.existsSync(dbPath)) {
    throw new ZcodeReaderError(`db \u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${dbPath}`);
  }
  const sqliteModuleId = "node:sqlite";
  const sqliteMod = await import(sqliteModuleId).catch(() => void 0);
  const DatabaseSyncCtor = sqliteMod?.DatabaseSync;
  if (typeof DatabaseSyncCtor !== "function") {
    throw new ZcodeReaderError(
      "\u5F53\u524D node \u8FD0\u884C\u65F6\u4E0D\u652F\u6301 node:sqlite\uFF08\u9700 >=22.13\uFF09",
      "\u5347\u7EA7 node \u6216\u6539\u7528\u7B2C\u2461\u7EA7\uFF08\u5BBF\u4E3B event journal\uFF09\u8BFB\u53D6\u3002"
    );
  }
  const open = DatabaseSyncCtor;
  let db;
  try {
    db = new open(dbPath, { readOnly: true });
    return buildView(db, resolveSessionId(db, sessionId));
  } catch (err) {
    if (err instanceof ZcodeReaderError) throw err;
    throw new ZcodeReaderError(
      `sqlite \u67E5\u8BE2\u5931\u8D25\uFF08${err instanceof Error ? err.message : String(err)}\uFF09`,
      "\u7591\u4F3C\u8868\u7ED3\u6784\u6F02\u79FB\uFF08zcode schema_migration \u5347\u7EA7\uFF09\u2014\u2014\u8C03\u7528\u65B9\u5E94\u964D\u7EA7\u5230\u7B2C\u2461\u7EA7\uFF1B\u5E76\u628A\u65B0 schema \u6837\u672C\u8865\u5F55\u8FDB golden \u5E93\u540E\u66F4\u65B0 reader\u3002"
    );
  } finally {
    try {
      db?.close();
    } catch (err) {
      void err;
    }
  }
}
export {
  ZcodeReaderError,
  readZcodeSessionView
};
