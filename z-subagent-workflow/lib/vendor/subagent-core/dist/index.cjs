"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  CORE_PACKAGE_VERSION: () => CORE_PACKAGE_VERSION,
  DEFAULT_DATA_ROOT: () => DEFAULT_DATA_ROOT,
  abortRun: () => abortRun,
  configureCore: () => configureCore,
  configureNotifyDomain: () => configureNotifyDomain,
  getLogger: () => getLogger,
  routeEngine: () => routeEngine,
  runWorkflow: () => runWorkflow
});
module.exports = __toCommonJS(src_exports);

// src/core/host-services.ts
var import_node_os = require("os");
var import_node_path = require("path");
var DEFAULT_DATA_ROOT = (0, import_node_path.join)((0, import_node_os.homedir)(), ".subagent-core");
var configuredHost;
function configureCore(host) {
  configuredHost = host;
}
var NULL_HOST = {
  dataRoot() {
    throw new Error(
      "[subagent-core] core_host_not_configured: HostServices is not configured \u2014 the host shell must call configureCore(host) during initialization, before any core API that needs host services is consumed. Recovery: pi shell wires HostServices in src/host/pi-host.ts of @zhushanwen/pi-subagent-workflow; zsw shell: see the wiring example in the @zhushanwen/subagent-core package README."
    );
  },
  log(level, component, message, data) {
    const line = `[${component}] ${message}`;
    if (level === "error") {
      if (data === void 0) console.error(line);
      else console.error(line, data);
      return;
    }
    if (level === "warn") {
      if (data === void 0) console.warn(line);
      else console.warn(line, data);
      return;
    }
  }
  // discoveryRoots 刻意不实现：可选端口缺席 = undefined，由调用方走缺省发现语义。
};
function getHostServices() {
  return configuredHost ?? NULL_HOST;
}

// src/core/logger.ts
var facadeCache = /* @__PURE__ */ new Map();
function getLogger(component) {
  const existing = facadeCache.get(component);
  if (existing) return existing;
  const facade = {
    debug(msg, data) {
      getHostServices().log("debug", component, msg, data);
    },
    warn(msg, data) {
      getHostServices().log("warn", component, msg, data);
    },
    error(msg, data) {
      getHostServices().log("error", component, msg, data);
    }
  };
  facadeCache.set(component, facade);
  return facade;
}

// src/core/notify-ports.ts
var configuredPorts;
function configureNotifyDomain(ports) {
  configuredPorts = ports;
}

// src/execution/engine/common/errors.ts
var EngineError = class extends Error {
  code;
  /** 恢复指引：指向具体下一步（命令 / 配置路径 / 替代方案），非安慰性文案。 */
  recovery;
  constructor(code, detail, recovery) {
    super(`${code}: ${detail}`);
    this.name = "EngineError";
    this.code = code;
    this.recovery = recovery;
  }
  /** 结构化投影（InteractResult.code/message 与 GUI 警告条共用形态）。 */
  toStructured() {
    return { code: this.code, message: this.message, recovery: this.recovery };
  }
};

// src/execution/engine/registry.ts
var DEFAULT_ENGINE_ID = "pi";
var EngineNotFoundError = class extends Error {
  /** 结构化错误码（§3.3.3 错误规格表的 code 列，供调用方程序化分流）。 */
  code = "engine_not_found";
  /** 请求的（未注册的）引擎 id。 */
  engineId;
  /** 请求时刻的已注册清单快照（防错误对象跨时间读 Map 的失真）。 */
  registered;
  /** 错误来源定位（agent .md 文件路径 / 配置键等；运行期 getEngine 无来源不传）。 */
  source;
  constructor(engineId, registered, source) {
    super(
      `engine_not_found: engine '${engineId}' is not registered. Registered engines: ${registered.length > 0 ? registered.join(", ") : "(none)"}. Recovery: check the engine id in the agent .md frontmatter (engine: field) or the global default engine setting, fix the typo, or install/register the engine first (registered engines are listed above).` + (source !== void 0 ? ` Source: ${source}.` : "")
    );
    this.name = "EngineNotFoundError";
    this.engineId = engineId;
    this.registered = registered;
    this.source = source;
  }
};
var ENGINE_REGISTRY_SLOT_KEY = /* @__PURE__ */ Symbol.for("@zhushanwen/pi-subagent-workflow.engineRegistry");
function getRegistrySlot() {
  let slot = Reflect.get(globalThis, ENGINE_REGISTRY_SLOT_KEY);
  if (!slot) {
    slot = { factories: /* @__PURE__ */ new Map(), singletons: /* @__PURE__ */ new Map() };
    Reflect.set(globalThis, ENGINE_REGISTRY_SLOT_KEY, slot);
  }
  return slot;
}
function getEngine(id) {
  const slot = getRegistrySlot();
  const cached = slot.singletons.get(id);
  if (cached) return cached;
  const factory = slot.factories.get(id);
  if (!factory) {
    throw new EngineNotFoundError(id, listEngines());
  }
  const engine = factory();
  slot.singletons.set(id, engine);
  return engine;
}
function hasEngine(id) {
  return getRegistrySlot().factories.has(id);
}
function listEngines() {
  return [...getRegistrySlot().factories.keys()];
}

// src/execution/engine/routing.ts
function hasText(v) {
  return v !== void 0 && v !== "";
}
function resolveEngineRouting(input) {
  if (hasText(input.callEngine)) {
    return { engineId: input.callEngine, source: "call" };
  }
  if (hasText(input.agentEngine)) {
    return { engineId: input.agentEngine, source: "frontmatter" };
  }
  if (hasText(input.globalDefaultEngine)) {
    return { engineId: input.globalDefaultEngine, source: "default" };
  }
  return { engineId: DEFAULT_ENGINE_ID, source: "default" };
}
async function routeEngine(opts) {
  const has = opts.hasEngineFn ?? hasEngine;
  const get = opts.getEngineFn ?? getEngine;
  const routing = resolveEngineRouting(opts.routing);
  if (!has(routing.engineId)) {
    throw new EngineNotFoundError(routing.engineId, opts.listEnginesFn?.() ?? listEngines(), describeRoutingSource(opts.routing));
  }
  if (routing.engineId === DEFAULT_ENGINE_ID) {
    return {
      engine: get(routing.engineId),
      engineId: routing.engineId,
      requestedEngineId: routing.engineId,
      source: routing.source
    };
  }
  const report = await opts.probe(routing.engineId);
  if (report.ok) {
    return {
      engine: get(routing.engineId),
      engineId: routing.engineId,
      requestedEngineId: routing.engineId,
      source: routing.source
    };
  }
  if (opts.strict) {
    throw probeFailedError(routing.engineId, report, "engineRouting.strict=true\uFF1Aprobe \u5931\u8D25\u4E00\u5F8B\u62A5\u9519\uFF08\u4E0D fallback\uFF09");
  }
  if (routing.source === "call") {
    throw probeFailedError(routing.engineId, report, "engine \u6765\u81EA\u8C03\u7528\u53C2\u6570\u663E\u5F0F\u6307\u5B9A\uFF08\u80FD\u529B\u4F9D\u8D56\u58F0\u660E\uFF09\u2014\u2014\u4E0D\u515C\u5E95");
  }
  const fallbackId = fallbackTargetId(opts.routing, routing);
  if (hasText(opts.taskModel) && fallbackId !== routing.engineId) {
    throw new EngineError(
      "model_not_available",
      `engine '${routing.engineId}' probe \u5931\u8D25\u4E14\u4EFB\u52A1\u663E\u5F0F\u6307\u5B9A model '${opts.taskModel}'\u2014\u2014model \u4E0E\u5F15\u64CE provider \u4F53\u7CFB\u7ED1\u5B9A\uFF0C\u6362\u5F15\u64CE\uFF08fallback \u5230 '${fallbackId}'\uFF09\u4E0D\u9759\u9ED8\u6267\u884C`,
      `\u4FEE\u590D engine '${routing.engineId}' \u7684\u63A2\u9488\u5931\u8D25\uFF08\u89C1\u4E0A\u65B9\u6062\u590D\u6307\u5F15\uFF09\u540E\u91CD\u8BD5\uFF0C\u6216\u53BB\u6389 model \u6307\u5B9A / \u663E\u5F0F\u4F20 engine: '${fallbackId}' \u786E\u8BA4\u6A21\u578B\u53EF\u7528\u540E\u518D\u6D3E\u53D1`
    );
  }
  return {
    engine: get(fallbackId),
    engineId: fallbackId,
    requestedEngineId: routing.engineId,
    source: "default",
    engineFallback: { from: routing.engineId, reason: "engine_probe_failed" }
  };
}
function fallbackTargetId(routingInput, resolved) {
  if (resolved.source === "default") return DEFAULT_ENGINE_ID;
  const global = routingInput.globalDefaultEngine;
  if (hasText(global) && global !== DEFAULT_ENGINE_ID && global !== resolved.engineId) {
    return global;
  }
  return DEFAULT_ENGINE_ID;
}
function probeFailedError(engineId, report, guard) {
  const checks = report.checks.map((c) => `${c.name}:${c.ok ? "ok" : "FAIL"}`).join(", ");
  return new EngineError(
    "engine_probe_failed",
    `engine '${engineId}' probe \u5931\u8D25\uFF08${guard}\uFF09\u3002checks: [${checks}]`,
    report.error?.recovery ?? `Confirm the engine binary and version, then re-run the probe (probe({force:true}) or re-initialize the engine).`
  );
}
function describeRoutingSource(routing) {
  if (hasText(routing.callEngine)) {
    return `call parameter engine='${routing.callEngine}'`;
  }
  if (hasText(routing.agentEngine)) {
    return `agent frontmatter engine='${routing.agentEngine}'`;
  }
  return void 0;
}

// src/shared/timer-delay.ts
var MAX_TIMER_DELAY_MS = 2147483647;
function assertSafeTimerDelay(ms, source) {
  if (!Number.isFinite(ms)) {
    throw new Error(
      `[subagent-workflow] ${source} = ${ms} is not a finite number (NaN/\xB1Infinity). Non-finite delays collapse to 1ms in Node setTimeout and fire immediately. Recovery: fix the upstream computation that produced this value (e.g. guard division/parse results before passing them in) and retry.`
    );
  }
  if (ms > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `[subagent-workflow] ${source} = ${ms} exceeds the Node setTimeout limit (${MAX_TIMER_DELAY_MS} ms = 2^31-1); larger delays silently collapse to 1ms and fire immediately. Recovery: clamp the value to <= ${MAX_TIMER_DELAY_MS} (e.g. omit the option for "unlimited" semantics, or clamp explicitly) and retry.`
    );
  }
}

// src/orchestration/args-validator.ts
var import_ajv = __toESM(require("ajv"), 1);
var ArgsValidationError = class extends Error {
  workflowName;
  /** ajv 校验错误数组（畸形 schema 时为 undefined）。 */
  errors;
  constructor(workflowName, message, errors) {
    super(message);
    this.name = "ArgsValidationError";
    this.workflowName = workflowName;
    this.errors = errors;
  }
};
var ajv = new import_ajv.default({
  coerceTypes: true,
  strictSchema: false,
  allErrors: true,
  useDefaults: false
});
function formatMessage(name, errors) {
  const lines = errors.map((e) => {
    let path2 = "/";
    let msg = "invalid";
    if (e !== null && typeof e === "object") {
      const err = e;
      if (typeof err.instancePath === "string" && err.instancePath) path2 = err.instancePath;
      if (typeof err.message === "string") msg = err.message;
    }
    return `- ${path2}: ${msg}`;
  });
  return `Invalid args for workflow '${name}': ${errors.length} error(s)
${lines.join("\n")}
Read the workflow script file (location from <available_workflows>) for the parameter schema and usage.`;
}
function validateRunArgs(spec) {
  const { parameters, args, scriptName } = spec;
  if (parameters === void 0) return;
  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new ArgsValidationError(
      scriptName,
      `Workflow '${scriptName}' has an invalid parameter schema (expected object). Read the workflow script file (location from <available_workflows>) to inspect it.`
    );
  }
  const schema = parameters;
  const properties = schema.properties !== null && typeof schema.properties === "object" ? schema.properties : {};
  for (const key of Object.keys(args)) {
    if (args[key] !== null) continue;
    const prop = properties[key];
    let isNullable = false;
    if (prop !== null && typeof prop === "object") {
      const propType = prop.type;
      isNullable = Array.isArray(propType) ? propType.includes("null") : propType === "null";
    }
    if (!isNullable) delete args[key];
  }
  let validate;
  try {
    validate = ajv.compile(parameters);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ArgsValidationError(
      scriptName,
      `Workflow '${scriptName}' has an invalid parameter schema: ${detail}. Read the workflow script file (location from <available_workflows>) to inspect it.`
    );
  }
  if (!validate(args)) {
    throw new ArgsValidationError(
      scriptName,
      formatMessage(scriptName, validate.errors ?? []),
      validate.errors ?? void 0
    );
  }
}

// src/execution/engine/common/kill-chain.ts
var logger = getLogger("subagents");

// src/execution/execute-options-mapper.ts
var SLUG_MAX_LENGTH = 35;

// src/execution/execution-record.ts
function addUsage(prev, next) {
  if (prev === void 0) {
    return {
      input: next.input ?? 0,
      output: next.output ?? 0,
      cacheRead: next.cacheRead ?? 0,
      cacheWrite: next.cacheWrite ?? 0,
      cost: next.cost
    };
  }
  return {
    input: (prev.input ?? 0) + (next.input ?? 0),
    output: (prev.output ?? 0) + (next.output ?? 0),
    cacheRead: (prev.cacheRead ?? 0) + (next.cacheRead ?? 0),
    cacheWrite: (prev.cacheWrite ?? 0) + (next.cacheWrite ?? 0),
    cost: (prev.cost ?? 0) + (next.cost ?? 0)
  };
}
function emptyTurn() {
  return { text: "", thinking: "", toolCalls: [], usageDelta: void 0, closed: false };
}
function createRecord(id, identity) {
  return {
    id,
    agent: identity.agent,
    model: identity.model,
    thinkingLevel: identity.thinkingLevel,
    mode: identity.mode,
    task: identity.task,
    slug: identity.slug,
    startedAt: identity.startedAt,
    rootSessionId: identity.rootSessionId,
    parentRecordId: identity.parentRecordId,
    depth: identity.depth ?? 0,
    chatMode: identity.chatMode,
    idleTimeoutMs: identity.idleTimeoutMs,
    engine: identity.engine,
    engineFallback: identity.engineFallback,
    // 状态（实时更新）
    status: "running",
    // turns[] 初始化为 [空 turn]——第一个 turn 从创建即存在，
    // updateFromEvent 直接往 turns[last] 累积，无需「无 turn」分支判断。
    turns: [emptyTurn()],
    turnCount: 0,
    totalTokens: 0,
    lastError: void 0,
    // 对话轮次计数（首轮 = 0，每完成一轮 finalizeRoundToIdle +1）。非 chatMode 不自增。
    round: 0,
    // 完成（completeRecord 唯一写点）
    endedAt: void 0,
    result: void 0,
    error: void 0,
    agentResult: void 0,
    // 控制（仅 background 持有 controller；sync 为 undefined）
    controller: identity.controller
  };
}
function currentTurn(record) {
  const last = record.turns[record.turns.length - 1];
  if (last !== void 0 && !last.closed) return last;
  const fresh = emptyTurn();
  record.turns.push(fresh);
  return fresh;
}
function findRunningToolCall(record, toolName) {
  for (let t = record.turns.length - 1; t >= 0; t--) {
    const turn = record.turns[t];
    if (turn === void 0) continue;
    for (let i = turn.toolCalls.length - 1; i >= 0; i--) {
      const tc = turn.toolCalls[i];
      if (tc?._status === "running" && tc.toolName === toolName) {
        return [turn, i];
      }
    }
  }
  return void 0;
}
var runningToolIndex = /* @__PURE__ */ new WeakMap();
function indexToolStart(record, turn, toolName) {
  let byName = runningToolIndex.get(record);
  if (byName === void 0) {
    byName = /* @__PURE__ */ new Map();
    runningToolIndex.set(record, byName);
  }
  const arr = byName.get(toolName);
  if (arr === void 0) {
    byName.set(toolName, [{ turn, idx: turn.toolCalls.length - 1 }]);
  } else {
    arr.push({ turn, idx: turn.toolCalls.length - 1 });
  }
}
function updateFromEvent(record, event) {
  switch (event.type) {
    // ── text / thinking：流式累积进当前 turn ──
    case "text_delta": {
      currentTurn(record).text += event.delta;
      return;
    }
    case "thinking_delta": {
      currentTurn(record).thinking += event.delta;
      return;
    }
    // ── tool_start：push 一个 running 的 InternalToolCall（带 startedTs）──
    case "tool_start": {
      const tc = {
        toolName: event.toolName,
        args: event.args,
        result: void 0,
        isError: false,
        _status: "running",
        startedTs: Date.now()
      };
      const turn = currentTurn(record);
      turn.toolCalls.push(tc);
      indexToolStart(record, turn, event.toolName);
      return;
    }
    // ── tool_end：索引弹尾 O(1) 定位 running 同名 toolCall，miss 回退全扫兜底 ──
    case "tool_end": {
      let matched;
      const byName = runningToolIndex.get(record);
      const arr = byName?.get(event.toolName);
      if (arr !== void 0 && arr.length > 0) {
        const item = arr[arr.length - 1];
        arr.pop();
        const tc = item.turn.toolCalls[item.idx];
        if (tc !== void 0 && tc._status === "running") {
          matched = [item.turn, item.idx];
        }
      }
      if (matched === void 0) {
        matched = findRunningToolCall(record, event.toolName);
      }
      if (matched !== void 0) {
        const [turn, i] = matched;
        const tc = turn.toolCalls[i];
        tc.args = event.args ?? tc.args;
        tc.result = event.result;
        tc.isError = event.isError ?? false;
        tc._status = event.isError ? "failed" : "done";
        return;
      }
      currentTurn(record).toolCalls.push({
        toolName: event.toolName,
        args: event.args,
        result: event.result,
        isError: event.isError ?? false,
        _status: event.isError ? "failed" : "done",
        startedTs: Date.now()
      });
      return;
    }
    // ── turn_end：闭合当前 turn，记 closedTs，turnCount++，清 lastError ──
    case "turn_end": {
      const turn = currentTurn(record);
      turn.closed = true;
      turn.closedTs = Date.now();
      record.turnCount += 1;
      record.lastError = void 0;
      return;
    }
    // ── message_end：usage 增量累加进 currentTurn().usageDelta，totalTokens 累加 ──
    //
    // usageDelta 按 message_end **累加**（非覆盖）——同一 turn 内若多次 message_end
    // 到达（或 turn_end 后的滞后 message_end 落到 currentTurn 开的新 turn），
    // 累加保证不丢 usage。getTotalUsage 扁平求和所有 turn，归属 turn 的精确性
    // 不影响最终 total（无消费方读单 turn usage）。
    case "message_end": {
      if (event.usage) {
        const turn = currentTurn(record);
        turn.usageDelta = addUsage(turn.usageDelta, event.usage);
        record.totalTokens += (event.usage.input ?? 0) + (event.usage.output ?? 0) + (event.usage.cacheRead ?? 0) + (event.usage.cacheWrite ?? 0);
      }
      if (event.error) {
        record.lastError = event.error;
      }
      return;
    }
    // ── error：存 record.lastError（getEventLog 派生 error 条目）──
    case "error": {
      record.lastError = event.message;
      return;
    }
    // ── compaction：不产生数据（不变）──
    case "compaction": {
      return;
    }
    default: {
      const _exhaustive = event;
      return _exhaustive;
    }
  }
}

// src/execution/stream-sink.ts
var STREAM_FLUSH_MS = 100;
var MAX_WIDGET_LINES = 200;
var SubagentStream = class {
  widgetKey;
  sink;
  buffer = "";
  timer;
  hasFlushed = false;
  disposed = false;
  constructor(recordId, sink) {
    this.widgetKey = `subagent-stream-${recordId}`;
    this.sink = sink;
  }
  /** 接收一个 text_delta 增量。空串静默丢弃（不消耗 leading edge）。 */
  onDelta(delta) {
    if (this.disposed || delta.length === 0) return;
    this.buffer += delta;
    if (!this.hasFlushed) {
      this.hasFlushed = true;
      this.flush();
    } else if (this.timer === void 0) {
      this.timer = setTimeout(() => this.flush(), STREAM_FLUSH_MS);
    }
  }
  /** 终态清理：清除 widget + 清 timer（幂等）。 */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== void 0) {
      clearTimeout(this.timer);
      this.timer = void 0;
    }
    this.sink.setWidget(this.widgetKey, void 0);
  }
  flush() {
    this.timer = void 0;
    if (this.buffer.length === 0 || this.disposed) return;
    const lines = this.buffer.split("\n");
    if (lines.length <= MAX_WIDGET_LINES) {
      this.sink.setWidget(this.widgetKey, lines);
      return;
    }
    const dropped = lines.length - MAX_WIDGET_LINES;
    this.sink.setWidget(this.widgetKey, [
      `(... ${dropped} earlier lines truncated, full output in /subagents detail)`,
      ...lines.slice(dropped)
    ]);
  }
};

// src/orchestration/skill-discovery.ts
var fs = __toESM(require("fs"), 1);
var path = __toESM(require("path"), 1);
var skillCandidatesCache = /* @__PURE__ */ new Map();
function getNpmSkillCandidates(npmSkillsDir) {
  const cached = skillCandidatesCache.get(npmSkillsDir);
  if (cached) return cached;
  const candidates = [];
  try {
    for (const pkg of fs.readdirSync(npmSkillsDir)) {
      candidates.push(path.join(npmSkillsDir, pkg, "skills"));
    }
  } catch {
  }
  skillCandidatesCache.set(npmSkillsDir, candidates);
  return candidates;
}
var skillMemo = /* @__PURE__ */ new Map();
function resolveWithinRoot(rootDir, skillName) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, skillName);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return void 0;
  }
  return resolved;
}
function resolveSkillPath(skillName) {
  if (skillMemo.has(skillName)) {
    return skillMemo.get(skillName);
  }
  const candidates = [];
  const pushCandidate = (dir) => {
    if (dir !== void 0) candidates.push(dir);
  };
  pushCandidate(resolveWithinRoot(path.resolve(process.cwd(), ".agents/skills"), skillName));
  const injectedSkillRoots = getHostServices().discoveryRoots?.()?.skills ?? [];
  const userSkillsRoot = injectedSkillRoots.find((root) => root.source === "user-pi");
  if (userSkillsRoot !== void 0) {
    pushCandidate(resolveWithinRoot(userSkillsRoot.dir, skillName));
  }
  const npmSkillsRoot = injectedSkillRoots.find((root) => root.source === "npm");
  if (npmSkillsRoot !== void 0) {
    for (const pkgSkillsBase of getNpmSkillCandidates(npmSkillsRoot.dir)) {
      pushCandidate(resolveWithinRoot(pkgSkillsBase, skillName));
    }
  }
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      skillMemo.set(skillName, dir);
      return dir;
    }
  }
  skillMemo.set(skillName, void 0);
  return void 0;
}

// src/shared/schema-jsonify.ts
var cache = /* @__PURE__ */ new WeakMap();
var PRETTY_PRINT_INDENT_SPACES = 2;
function stringifySchemaCached(schema, mode) {
  let entry = cache.get(schema);
  if (!entry) {
    entry = {};
    cache.set(schema, entry);
  }
  const hit = entry[mode];
  if (hit !== void 0) return hit;
  const serialized = mode === "compact" ? JSON.stringify(schema) : JSON.stringify(schema, null, PRETTY_PRINT_INDENT_SPACES);
  if (serialized === void 0) {
    throw new Error(
      `[subagent-workflow] stringifySchemaCached: JSON.stringify returned undefined (mode=${mode}) \u2014 the schema object defines a toJSON hook returning undefined. Recovery: check the schema source (agent definition / workflow script), remove that toJSON or make it return a JSON-serializable value.`
    );
  }
  entry[mode] = serialized;
  return serialized;
}

// src/orchestration/agent-opts-resolver.ts
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isObjectRootSchema(schema) {
  if (!isPlainObject(schema)) return false;
  if (schema.type === "object") return true;
  if (Array.isArray(schema.type) && schema.type.includes("object")) return true;
  const OBJECT_ONLY_KEYS = [
    "properties",
    "required",
    "patternProperties",
    "additionalProperties",
    "minProperties",
    "maxProperties",
    "dependencies",
    "dependentRequired",
    "propertyNames"
  ];
  return OBJECT_ONLY_KEYS.some((k) => k in schema);
}
function formatSchemaInstruction(schema) {
  const schemaJson = stringifySchemaCached(schema, "compact");
  const isObjectRoot = isObjectRootSchema(schema);
  const argsContractLine = isObjectRoot ? "Your call arguments ARE the result data itself \u2014 the tool's parameter schema IS the required shape of your result." : "The tool's single argument must be an object `{value: <data>}` \u2014 put the result itself in `value`, and it must conform to the schema below. Validation errors may reference paths starting with `value.` (e.g. `value.0`, `value.name`): that prefix addresses the wrapper, not your data.";
  const rulesCallLine = isObjectRoot ? "- Call the structured-output tool with your result data as its arguments. The system validates them against the schema above automatically." : "- Call the structured-output tool with `{value: <your result data>}`. The system validates the `value` field against the schema above automatically.";
  const apLine = schema.additionalProperties === void 0 ? "- Fields not defined in this schema are rejected \u2014 do not add extra fields." : "- Extra fields follow this schema's own additionalProperties declaration.";
  return [
    "## MANDATORY: Structured Output Requirement",
    "",
    "This task requires structured output.",
    "Your FINAL action must be calling the `structured-output` tool.",
    "",
    argsContractLine,
    `Your result must conform to this schema:`,
    "```json",
    schemaJson,
    "```",
    "",
    "Rules:",
    rulesCallLine,
    "- Do NOT output JSON in your text response \u2014 use the structured-output tool.",
    "- Do NOT skip this step. The structured-output call IS your result.",
    "- Complete all other work FIRST, then call structured-output as the last action.",
    apLine
  ].join("\n");
}
function resolveAgentOpts(opts) {
  const appendSystemPrompt = [];
  if (opts.skill) {
    const skillPath = resolveSkillPath(opts.skill);
    if (!skillPath) {
      return { opts, error: `Skill not found: ${opts.skill}. Searched .agents/skills/ and ~/.pi/agent/skills/` };
    }
    opts = { ...opts, skillPath };
  }
  if (opts.schema) {
    appendSystemPrompt.push(formatSchemaInstruction(opts.schema));
    opts = { ...opts, schemaEnv: stringifySchemaCached(opts.schema, "compact") };
  }
  return {
    opts: { ...opts, ...appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {} }
  };
}

// src/orchestration/execute-agent-call.ts
var BACKOFF_BASE_MS = 1e3;
var BACKOFF_EXPONENT_BASE = 2;
var MAX_ATTEMPTS = 3;
var STALE_CONTEXT_PATTERNS = [
  "ctx is stale",
  "stale after session replacement",
  "context canceled",
  "aborted"
];
function isStaleContextErrorMsg(msg) {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return STALE_CONTEXT_PATTERNS.some((p) => lower.includes(p));
}
var DETERMINISTIC_SCHEMA_FAILURE_PREFIX = "Structured output failed deterministically:";
function isDeterministicSchemaFailureMsg(msg) {
  if (!msg) return false;
  return msg.includes(DETERMINISTIC_SCHEMA_FAILURE_PREFIX);
}
function backoffDelay(retryIndex) {
  return BACKOFF_BASE_MS * Math.pow(BACKOFF_EXPONENT_BASE, retryIndex - 1);
}
function finalizeCall(call, result, trace, isOrphaned) {
  call.markDone(result);
  const status = result.error === void 0 ? "completed" : "failed";
  if (result.sessionId !== void 0) call.setSessionId(result.sessionId);
  if (result.sessionFile !== void 0) call.setSessionFile(result.sessionFile);
  if (isOrphaned?.()) return;
  trace.update(call.id, {
    status,
    result,
    completedAt: (/* @__PURE__ */ new Date()).toISOString(),
    sessionId: result.sessionId,
    sessionFile: result.sessionFile
  });
}
function delay(ms) {
  return new Promise((resolve2) => {
    const timer = setTimeout(resolve2, ms);
    timer.unref();
  });
}
async function executeAgentCall(call, runner, budget, signal, trace, onEvent, stream, isOrphaned) {
  call.markRunning();
  const result = await runner.run(call.opts, signal, onEvent, stream);
  if (result.usage) {
    budget.consume(result.usage);
  }
  if (result.error !== void 0 && isStaleContextErrorMsg(result.error)) {
    finalizeCall(call, result, trace, isOrphaned);
    budget.incrementCallCount();
    return;
  }
  if (result.error !== void 0 && isDeterministicSchemaFailureMsg(result.error)) {
    finalizeCall(call, result, trace, isOrphaned);
    budget.incrementCallCount();
    return;
  }
  if (signal.aborted) {
    finalizeCall(call, result, trace, isOrphaned);
    budget.incrementCallCount();
    return;
  }
  if (result.error !== void 0 && budget.isExceeded()) {
    finalizeCall(call, result, trace, isOrphaned);
    budget.incrementCallCount();
    return;
  }
  if (result.error !== void 0 && call.attempts < MAX_ATTEMPTS) {
    await delay(backoffDelay(call.attempts));
    if (signal.aborted) {
      finalizeCall(call, result, trace, isOrphaned);
      budget.incrementCallCount();
      return;
    }
    await executeAgentCall(call, runner, budget, signal, trace, onEvent, stream, isOrphaned);
    return;
  }
  finalizeCall(call, result, trace, isOrphaned);
  budget.incrementCallCount();
}

// src/orchestration/models/agent-call.ts
var AgentCall = class {
  id;
  opts;
  status = "pending";
  attempts = 0;
  result;
  /** Pi subprocess session ID（uuidv7，G-017 归此）。 */
  sessionId;
  /** Session JSONL 绝对路径（finalizeCall 后从 result.sessionFile 填入，对齐 sessionId 模式）。 */
  sessionFile;
  /** 与 Trace 共享的节点引用（D-10 单源）。AgentCall 不直接改其字段。 */
  traceNode;
  constructor(id, opts, traceNode) {
    this.id = id;
    this.opts = opts;
    this.traceNode = traceNode;
  }
  /**
  * 标记进入 running 状态（dispatch 前）。attempts++（含首次）。
  * @throws 若已 done（不可重启）
  */
  markRunning() {
    if (this.status === "done") {
      throw new Error(`AgentCall ${this.id} already done \u2014 cannot mark running`);
    }
    this.status = "running";
    this.attempts += 1;
  }
  /**
  * 标记完成（成功或失败均调用——result.error 区分）。
  * @throws 若当前非 running（pending 不能直接跳 done，必须先 markRunning）
  */
  markDone(result) {
    if (this.status !== "running") {
      throw new Error(`AgentCall ${this.id} must be running to mark done (was ${this.status})`);
    }
    this.result = result;
    this.status = "done";
  }
  /** 记录 pi subprocess session ID（dispatch 成功后）。 */
  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }
  /** 记录 session JSONL 绝对路径（finalizeCall 后，对齐 setSessionId 模式）。 */
  setSessionFile(sessionFile) {
    this.sessionFile = sessionFile;
  }
};

// src/orchestration/models/run-runtime.ts
var RunRuntime = class {
  /** Worker 线程句柄。 */
  worker;
  /** per-running-segment AbortController（一次性，无法复用——G3-001）。 */
  controller;
  /** Run 级墙钟时间预算计时器（spec.budgetTimeMs > 0 时由 lifecycle 调度，
    * 到期 abortRun time_limited）。release 时清理，避免 abort/replaceRuntime
    * 后孤儿计时器仍触发（rebuildRuntime 会重排一个全新的计时器，旧的不应残留）。 */
  timeBudgetTimer;
  /**
  * 本 runtime 代际是否已收到 worker 的终态消息（return / error）。
  *
  * [F1] worker exit(0) 且本标记为 false = worker 静默退出、未交付任何终态——最常见根因
  * 是 execute() 返回值不可克隆，worker 侧 _safePost 吞掉 DataCloneError 后 return 消息
  * 根本没发出。旧实现 handleWorkerExit 对 code===0 no-op → run 永久 running、runAndWait
  * 悬挂。handleWorkerExit 据此判定转 done,failed。
  *
  * 按代际归零：字段挂在 RunRuntime（每代际 new 一个实例）而非 run.meta——script-error
  * 重试退避窗口内（error 消息已收到、run 仍 running、旧 worker exit(0)）必须 no-op 等
  * rebuild；若挂 meta 则 rebuild 后新 worker 再静默退出时会被旧标记误放行，重新悬挂。
  *
  * 写点：① handleWorkerMessage 的 return/error 分支（WorkerHandle.isCurrent 守卫保证
  * 消息必来自当前代际）；② handleWorkerError 进入处理前（[R4-F1] 同代际幂等守卫——
  * worker 崩溃时 error + exit(1) 双事件各派发一次 handleWorkerError，第一个事件标记
  * 本代际已处理，第二个事件命中标志跳过，消除单次崩溃计数 +2 / 双 rebuild 交错）。
  * rebuildRuntime 构造新 RunRuntime 自然重置。
  */
  receivedTerminalMessage = false;
  /** 防止 release 重复执行（幂等）。 */
  released = false;
  constructor(worker, controller, timeBudgetTimer) {
    this.worker = worker;
    this.controller = controller;
    this.timeBudgetTimer = timeBudgetTimer;
  }
  /**
  * 释放所有资源：terminate worker + abort controller。
  *
  * 幂等——重复调用安全（第二次起 no-op，released flag 守卫）。
  * 调用后此 RunRuntime 应被调用方丢弃（WorkflowRun.runtime = undefined），
  * 崩溃重试时由 replaceRuntime 注入新实例（G3-001）。
  *
  * worker.terminate 本身幂等，controller.abort 本身幂等
  * （重复 abort 无副作用），但 released flag 让本方法语义更明确：
  * 「释放过一次的 runtime 不再释放第二次」。
  *
  * @param mode terminal —— 终局释放（唯一值，保留参数为调用方语义显式化）
  */
  release(_mode) {
    if (this.released) return;
    this.released = true;
    if (this.timeBudgetTimer) clearTimeout(this.timeBudgetTimer);
    void this.worker.terminate();
    this.controller.abort();
  }
  /** 是否已 release（测试 + 诊断用）。 */
  get isReleased() {
    return this.released;
  }
};

// src/orchestration/error-recovery.ts
var logger2 = getLogger("subagents");
var MAX_WORKER_RETRIES = 3;
var RETRY_BACKOFF_BASE_MS = 1e3;
var EXPONENTIAL_BACKOFF_BASE = 2;
var MAX_ERROR_LOGS = 500;
var MALFORMED_MSG_LOG_PREVIEW_CHARS = 200;
var WORKER_EXITED_WITHOUT_RESULT_MSG = "worker exited before delivering a result (return value may not be structured-cloneable)";
function isTerminal(run) {
  return run.state.status === "done";
}
function isOrphanedCall(run, callId, call) {
  return run.state.calls.get(callId) !== call;
}
function backoffDelay2(retryIndex) {
  return RETRY_BACKOFF_BASE_MS * Math.pow(EXPONENTIAL_BACKOFF_BASE, retryIndex - 1);
}
async function saveRunBestEffort(run, deps, context) {
  try {
    await deps.store.save(run);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    logger2.error(
      `[workflow] store.save failed (${context}, runId=${run.runId}): ${m}. Continuing state-machine finalization (in-memory state already terminal).`
    );
  }
}
function delay2(ms) {
  return new Promise((resolve2) => {
    const timer = setTimeout(resolve2, ms);
    timer.unref();
  });
}
function discardInFlightCalls(run) {
  const inFlight = [];
  for (const [callId, call] of run.state.calls) {
    if (call.status !== "done") inFlight.push(callId);
  }
  for (const callId of inFlight) {
    run.state.calls.delete(callId);
    run.state.trace.removeByStepIndex(callId);
  }
  return inFlight.sort((a, b) => a - b);
}
function remainingTimeBudgetMs(run) {
  const budget = run.spec.budgetTimeMs;
  if (!budget || budget <= 0) return void 0;
  const startedMs = Date.parse(run.meta.startedAt);
  const elapsed = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0;
  return Math.max(0, budget - elapsed);
}
async function finalizeTimeBudgetExhausted(run, deps) {
  deps.log?.("debug", "workflow:error-recovery", "time budget exhausted on rebuild, transition done", {
    runId: run.runId,
    budgetTimeMs: run.spec.budgetTimeMs
  });
  run.state.error = run.state.error ?? `Time budget exhausted (${run.spec.budgetTimeMs} ms wall clock) before retry rebuild`;
  let transitioned = false;
  try {
    run.transition("done", "time_limited");
    transitioned = true;
  } catch (te) {
    void te;
  }
  if (!transitioned) return;
  await deps.store.save(run).catch((e) => {
    const m = e instanceof Error ? e.message : String(e);
    logger2.error(`[workflow] store.save failed (time budget exhausted): ${m}`);
  });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "time_limited" });
  deps.onRunDone?.(run);
}
function rebuildRuntime(run, deps, handlers) {
  deps.log?.("debug", "workflow:error-recovery", "runtime rebuild start", {
    runId: run.runId,
    budgetTimeMs: run.spec.budgetTimeMs
  });
  const controller = new AbortController();
  const worker = deps.workerHost.start(run.spec, run.spec.args, handlers);
  let timeBudgetTimer;
  const remainingBudgetMs = remainingTimeBudgetMs(run);
  if (remainingBudgetMs !== void 0 && remainingBudgetMs > 0 && deps.scheduleTimeBudget) {
    timeBudgetTimer = deps.scheduleTimeBudget(run.runId, remainingBudgetMs);
    deps.log?.("debug", "workflow:error-recovery", "time budget rescheduled", {
      runId: run.runId,
      budgetTimeMs: remainingBudgetMs
    });
  }
  run.replaceRuntime(new RunRuntime(worker, controller, timeBudgetTimer));
  const discardedCallIds = discardInFlightCalls(run);
  deps.log?.("debug", "workflow:error-recovery", "in-flight calls discarded", {
    runId: run.runId,
    callIds: discardedCallIds,
    count: discardedCallIds.length
  });
  deps.log?.("debug", "workflow:error-recovery", "runtime rebuild complete", {
    runId: run.runId
  });
}
async function handleWorkerMessage(run, raw, deps, handlers) {
  if (isTerminal(run)) return;
  if (typeof raw !== "object" || raw === null) return;
  const msg = raw;
  switch (msg.type) {
    case "agent-call":
      dispatchAgentCall(run, msg, deps);
      return;
    case "workflow-call":
      dispatchWorkflowCall(run, msg, deps);
      return;
    case "return":
      if (run.runtime) run.runtime.receivedTerminalMessage = true;
      await handleReturn(run, msg, deps);
      return;
    case "error":
      if (run.runtime) run.runtime.receivedTerminalMessage = true;
      await handleScriptError(
        run,
        msg.error,
        msg.workerLogs ?? [],
        deps,
        handlers
      );
      return;
  }
}
function dispatchAgentCall(run, msg, deps) {
  if (typeof msg.callId !== "number" || !Number.isFinite(msg.callId) || typeof msg.opts !== "object" || msg.opts === null || typeof msg.opts.prompt !== "string") {
    logger2.error(`[workflow] malformed agent-call message: callId=${JSON.stringify(msg.callId)}, opts=${JSON.stringify(msg.opts)?.slice(0, MALFORMED_MSG_LOG_PREVIEW_CHARS)}`);
    return;
  }
  const cached = run.state.calls.get(msg.callId);
  if (cached && cached.status === "done") {
    postAgentResult(run, msg.callId, cached.result, true);
    return;
  }
  const agentName = msg.opts.description ?? msg.opts.agent ?? "unknown";
  const liveSlug = agentName.length > SLUG_MAX_LENGTH ? agentName.slice(0, SLUG_MAX_LENGTH) : agentName;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const liveRecord = createRecord(String(msg.callId), {
    agent: agentName,
    model: msg.opts.model ?? "default",
    mode: "background",
    task: msg.opts.prompt,
    slug: liveSlug,
    startedAt: Date.now()
  });
  const node = {
    stepIndex: msg.callId,
    agent: agentName,
    task: msg.opts.prompt,
    model: msg.opts.model ?? "default",
    status: "running",
    phase: msg.phase,
    startedAt: now,
    live: liveRecord
  };
  run.state.trace.append(node);
  const rawSchema = msg.opts.schema;
  const opts = {
    ...msg.opts,
    schema: typeof rawSchema === "object" && rawSchema !== null ? rawSchema : void 0
  };
  const resolved = resolveAgentOpts(opts);
  if (resolved.error) {
    const call2 = new AgentCall(msg.callId, opts, node);
    call2.markRunning();
    const errorResult = { content: "", error: resolved.error };
    call2.markDone(errorResult);
    run.state.calls.set(msg.callId, call2);
    node.live = void 0;
    run.state.trace.update(msg.callId, {
      status: "failed",
      result: errorResult,
      completedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    postAgentResult(run, msg.callId, errorResult, false);
    deps.store.save(run).catch((e) => {
      logger2.error(`[workflow] store.save failed (resolveAgentOpts): ${e instanceof Error ? e.message : String(e)}`);
    });
    return;
  }
  const call = new AgentCall(msg.callId, resolved.opts, node);
  run.state.calls.set(msg.callId, call);
  const runtime = run.runtime;
  const signal = runtime.controller.signal;
  const onEvent = (event) => {
    updateFromEvent(liveRecord, event);
  };
  const stream = deps.streamSink ? new SubagentStream(`${run.runId}-${msg.callId}`, deps.streamSink) : void 0;
  const dispatchCall = async () => {
    if (signal.aborted) {
      const abortErr = new Error("Operation aborted before start");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    try {
      await executeAgentCall(call, deps.runner, run.state.budget, signal, run.state.trace, onEvent, stream, () => isOrphanedCall(run, msg.callId, call));
    } finally {
      stream?.dispose();
    }
  };
  void dispatchCall().then(() => {
    node.live = void 0;
    if (run.state.status !== "running") return;
    if (isOrphanedCall(run, msg.callId, call)) {
      deps.log?.("debug", "workflow:error-recovery", "orphan agent call completion dropped", { runId: run.runId, callId: msg.callId });
      return;
    }
    if (call.result) postAgentResult(run, msg.callId, call.result, false);
    postBudgetUpdate(run);
    deps.store.save(run).catch((e) => {
      const m = e instanceof Error ? e.message : String(e);
      logger2.error(`[workflow] store.save failed (agent call ${msg.callId}): ${m}`);
    });
    if (run.state.budget.isExceeded()) {
      run.state.error = run.state.error ?? "Budget exceeded";
      deps.log?.("debug", "workflow:error-recovery", "budget exceeded, transition done", { runId: run.runId });
      let transitioned = false;
      try {
        run.transition("done", "budget_limited");
        transitioned = true;
      } catch (te) {
        void te;
      }
      if (transitioned) {
        deps.store.save(run).catch((e) => {
          const m = e instanceof Error ? e.message : String(e);
          logger2.error(`[workflow] store.save failed (budget done): ${m}`);
        });
        deps.log?.("debug", "workflow:error-recovery", "run saved after budget done", { runId: run.runId, reason: run.state.reason });
        try {
          deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
          deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
          deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
          deps.onRunDone?.(run);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          logger2.error(`[workflow] onRunDone/emit failed (budget done): ${m}`);
        }
      }
    }
  }).catch((err) => {
    if (err instanceof Error && err.name === "AbortError") return;
    const message = err instanceof Error ? err.message : String(err);
    logger2.error(`[workflow] agent call ${msg.callId} failed: ${message}`);
    node.live = void 0;
    if (isOrphanedCall(run, msg.callId, call)) {
      deps.log?.("debug", "workflow:error-recovery", "orphan agent call failure dropped", { runId: run.runId, callId: msg.callId });
      return;
    }
    const errorResult = { content: "", error: message };
    if (call.status !== "done") {
      if (call.status === "pending") call.markRunning();
      call.markDone(errorResult);
    }
    run.state.trace.update(msg.callId, {
      status: "failed",
      result: errorResult,
      completedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    postAgentResult(run, msg.callId, errorResult, false);
    postBudgetUpdate(run);
    deps.store.save(run).catch((e) => {
      logger2.error(`[workflow] store.save failed (catch fallback): ${e instanceof Error ? e.message : String(e)}`);
    });
  });
}
function makeSerializeFailedResult(prefix, errMsg) {
  return { content: "", error: `${prefix}: ${errMsg}` };
}
function dispatchWorkflowCall(run, msg, deps) {
  if (typeof msg.callId !== "number" || !Number.isFinite(msg.callId) || typeof msg.name !== "string" || typeof msg.args !== "object" || msg.args === null) {
    logger2.error(`[workflow] malformed workflow-call message: callId=${JSON.stringify(msg.callId)}, name=${JSON.stringify(msg.name)}`);
    return;
  }
  const postResult = (result) => {
    if (run.state.status !== "running") return;
    try {
      run.runtime?.worker.postMessage({
        type: "workflow-result",
        callId: msg.callId,
        result
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger2.error(`[workflow] postResult (workflow-call callId=${msg.callId}) failed: ${errMsg}. Sending error fallback.`);
      try {
        run.runtime?.worker.postMessage({
          type: "workflow-result",
          callId: msg.callId,
          result: makeSerializeFailedResult("Workflow result serialization failed", errMsg)
        });
      } catch {
        logger2.error(`[workflow] postResult fallback also failed (callId=${msg.callId}): worker pending will hang until timeout`);
      }
    }
  };
  if (!deps.onWorkflowCall) {
    postResult({
      content: "",
      error: `workflow() not supported: onWorkflowCall not injected`
    });
    return;
  }
  void deps.onWorkflowCall(msg.name, msg.args, run).then(postResult).catch((err) => {
    postResult({
      content: "",
      error: err instanceof Error ? err.message : String(err)
    });
  });
}
function postAgentResult(run, callId, result, cached) {
  try {
    run.runtime?.worker.postMessage({ type: "agent-result", callId, result, cached });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger2.error(`[workflow] postAgentResult failed (callId=${callId}): ${msg}. Result likely contains non-cloneable value.`);
    try {
      run.runtime?.worker.postMessage({
        type: "agent-result",
        callId,
        result: makeSerializeFailedResult("Result serialization failed", msg),
        // 原 result 不可克隆时 cached 透传原值含义失真（fallback result 非缓存命中）→ 固定 false
        cached: false
      });
    } catch {
      logger2.error(`[workflow] postAgentResult fallback also failed (callId=${callId}): worker pending will hang until timeout`);
    }
  }
}
function postBudgetUpdate(run) {
  try {
    run.runtime?.worker.postMessage({
      type: "budget-update",
      budget: {
        usedTokens: run.state.budget.usedTokens,
        usedCost: run.state.budget.usedCost
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger2.error(`[workflow] postBudgetUpdate failed: ${msg}. Budget sync to worker skipped (non-critical).`);
  }
}
async function handleReturn(run, msg, deps) {
  deps.log?.("debug", "workflow:error-recovery", "handleReturn", { runId: run.runId, status: run.state.status });
  if (msg.workerLogs && msg.workerLogs.length > 0) {
    run.state.errorLogs.push(...msg.workerLogs);
    if (run.state.errorLogs.length > MAX_ERROR_LOGS) {
      run.state.errorLogs = run.state.errorLogs.slice(-MAX_ERROR_LOGS);
    }
  }
  run.state.scriptResult = msg.result;
  run.transition("done", "completed");
  await saveRunBestEffort(run, deps, "handleReturn (done,completed)");
  deps.log?.("debug", "workflow:error-recovery", "run saved after return", { runId: run.runId, reason: run.state.reason });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
  deps.onRunDone?.(run);
}
async function handleWorkerError(run, err, deps, handlers) {
  if (isTerminal(run)) return;
  if (run.runtime?.receivedTerminalMessage) return;
  if (run.runtime) run.runtime.receivedTerminalMessage = true;
  const count = (run.meta.workerErrorCount ?? 0) + 1;
  run.meta.workerErrorCount = count;
  if (count <= MAX_WORKER_RETRIES) {
    await scheduleRebuild(run, deps, handlers);
    return;
  }
  run.state.error = err.message;
  deps.log?.("debug", "workflow:error-recovery", "handleWorkerError retries exceeded, transition done", { runId: run.runId, count });
  run.transition("done", "failed");
  await saveRunBestEffort(run, deps, "handleWorkerError (done,failed)");
  deps.log?.("debug", "workflow:error-recovery", "run saved after worker error", { runId: run.runId, reason: run.state.reason });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
  deps.onRunDone?.(run);
}
async function handleWorkerExit(run, code, handle, deps, handlers) {
  if (!handle.isCurrent) return;
  if (isTerminal(run)) return;
  if (code === 0) {
    if (run.runtime?.receivedTerminalMessage) return;
    deps.log?.("debug", "workflow:error-recovery", "worker exited without terminal message, transition done", { runId: run.runId });
    run.state.error = WORKER_EXITED_WITHOUT_RESULT_MSG;
    run.transition("done", "failed");
    await saveRunBestEffort(run, deps, "handleWorkerExit (done,failed, no terminal message)");
    deps.log?.("debug", "workflow:error-recovery", "run saved after exit without result", { runId: run.runId, reason: run.state.reason });
    deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
    deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
    deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
    deps.onRunDone?.(run);
    return;
  }
  await handleWorkerError(
    run,
    new Error(`Worker exited with code ${code}`),
    deps,
    handlers
  );
}
async function handleScriptError(run, errorMsg, workerLogs, deps, handlers) {
  if (isTerminal(run)) return;
  if (workerLogs.length > 0) {
    run.state.errorLogs.push(...workerLogs);
    if (run.state.errorLogs.length > MAX_ERROR_LOGS) {
      run.state.errorLogs = run.state.errorLogs.slice(-MAX_ERROR_LOGS);
    }
  }
  const count = (run.meta.scriptErrorCount ?? 0) + 1;
  run.meta.scriptErrorCount = count;
  if (count <= MAX_WORKER_RETRIES) {
    await scheduleRebuild(run, deps, handlers);
    return;
  }
  run.state.error = `Workflow failed after ${MAX_WORKER_RETRIES} retries: ${errorMsg}`;
  deps.log?.("debug", "workflow:error-recovery", "handleScriptError retries exceeded, transition done", { runId: run.runId, count });
  run.transition("done", "failed");
  await saveRunBestEffort(run, deps, "handleScriptError (done,failed)");
  deps.log?.("debug", "workflow:error-recovery", "run saved after script error", { runId: run.runId, reason: run.state.reason });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
  deps.onRunDone?.(run);
}
async function scheduleRebuild(run, deps, handlers) {
  const retryIndex = Math.max(
    run.meta.workerErrorCount ?? 0,
    run.meta.scriptErrorCount ?? 0
  );
  await delay2(backoffDelay2(retryIndex));
  if (isTerminal(run)) return;
  const remainingMs = remainingTimeBudgetMs(run);
  if (remainingMs !== void 0 && remainingMs <= 0) {
    await finalizeTimeBudgetExhausted(run, deps);
    return;
  }
  rebuildRuntime(run, deps, handlers);
}

// src/orchestration/models/budget.ts
var INPUT_WEIGHT = 1;
var CACHE_READ_WEIGHT = 0.02;
var CACHE_WRITE_WEIGHT = 0;
var OUTPUT_WEIGHT = 2;
var Budget = class {
  maxTokens;
  maxCost;
  maxTimeMs;
  usedTokens = 0;
  usedCost = 0;
  /** 总调用计数（持久化/诊断用；execute-agent-call 每次 dispatch 后 increment）。 */
  totalCallCount = 0;
  constructor(opts = {}) {
    this.maxTokens = opts.maxTokens;
    this.maxCost = opts.maxCost;
    this.maxTimeMs = opts.maxTimeMs;
    this.usedTokens = opts.usedTokens ?? 0;
    this.usedCost = opts.usedCost ?? 0;
    this.totalCallCount = opts.totalCallCount ?? 0;
  }
  /**
  * 累加一次 agent 调用的 usage（加权口径）。
  *
  * 四项 token 按各自权重（INPUT/CACHE_READ/CACHE_WRITE/OUTPUT_WEIGHT）折算后求和，
  * 而非原始 token 数直接相加。retry 间的真实消耗如实记录，避免预算被低估。
  * 详见上方权重常量的口径说明。
  */
  consume(usage) {
    const numOrZero = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
    this.usedTokens += numOrZero(usage.input) * INPUT_WEIGHT + numOrZero(usage.output) * OUTPUT_WEIGHT + numOrZero(usage.cacheRead) * CACHE_READ_WEIGHT + numOrZero(usage.cacheWrite) * CACHE_WRITE_WEIGHT;
    this.usedCost += numOrZero(usage.cost);
  }
  /** 累加调用计数（每次 agent dispatch 后调用；持久化快照同步）。 */
  incrementCallCount() {
    this.totalCallCount += 1;
  }
  /**
  * 是否超 token / cost 预算（FR-3）。
  *
  * maxTokens===0 或 undefined 视为不限制（守卫）；
  * maxCost===0 或 undefined 视为不限制。
  * 时间预算（maxTimeMs）不由本方法判断——它是 wall-clock 约束，需参照 startedAt，
  * 由 lifecycle 层的 scheduleTimeBudget（runWorkflow 内 setTimeout）
  * 独立调度，到期 abortRun(doneReason="time_limited")。
  */
  isExceeded() {
    if (this.maxTokens !== void 0 && this.maxTokens > 0 && this.usedTokens >= this.maxTokens) {
      return true;
    }
    return this.maxCost !== void 0 && this.maxCost > 0 && this.usedCost >= this.maxCost;
  }
  /**
  * 剩余 token 预算。maxTokens 未设或 ≤0 时返回 undefined（视为不限制）。
  *
  * 嵌套 workflow() 调用时由 executeNestedWorkflow 消费：子 run 的 budgetTokens
  * 继承父 run 的剩余预算，实现父子预算隔离下的总量约束。
  */
  remaining() {
    if (this.maxTokens === void 0 || this.maxTokens <= 0) return void 0;
    return Math.max(0, this.maxTokens - this.usedTokens);
  }
};

// src/orchestration/models/trace.ts
var TRACE_RESULT_MAX_CHARS = 8e3;
var TRIM_HEAD_CHARS = 4e3;
var TRIM_TAIL_CHARS = 4e3;
function trimTraceResult(result) {
  if (result === void 0) return result;
  const { content } = result;
  if (content.length <= TRACE_RESULT_MAX_CHARS) return result;
  const trimmed = content.slice(0, TRIM_HEAD_CHARS) + `
\u2026[trace result truncated, original ${content.length} chars]\u2026
` + content.slice(-TRIM_TAIL_CHARS);
  return { ...result, content: trimmed };
}
var Trace = class _Trace {
  nodes = [];
  /** stepIndex 倒排索引（查询加速 O(1)；值与 nodes 元素引用共享）。 */
  byIndex = /* @__PURE__ */ new Map();
  /**
  * 从已有节点数组重建 Trace（用于 RunStore 反序列化重水合）。
  *
  * 防御性拷贝——传入数组不被持有，外部 mutation 不影响 Trace。
  * 不验证节点顺序/唯一性（调用方保证快照来源可信）。
  * 不做裁剪——落盘快照已是 write 路径裁剪后形态，旧版本未裁剪长
  * content 重水合保持原样（read 路径无二次信息损失）。
  * 重水合后 call.traceNode（来自快照 calls[].traceNode，
  * jsonl-run-store.ts:156 直接传入）与 Trace.nodes 副本非同引用——
  * D-10 引用共享仅 live append 路径成立。
  */
  static fromArray(nodes) {
    const trace = new _Trace();
    for (const node of nodes) {
      const copy = { ...node };
      trace.nodes.push(copy);
      trace.byIndex.set(copy.stepIndex, copy);
    }
    return trace;
  }
  /**
  * Append a trace node（append-only，不改已有节点）。
  *
  * 入口裁剪：超长 result.content 先 mutate 入参节点的 result 字段，
  * 再 push 原节点引用（禁止 push 副本——保持 AgentCall.traceNode 与
  * Trace.nodes 共享同一引用的 D-10 不变式）。
  */
  append(node) {
    node.result = trimTraceResult(node.result);
    this.nodes.push(node);
    this.byIndex.set(node.stepIndex, node);
  }
  /**
  * Update a trace node by stepIndex (callId) with a partial patch.
  *
  * 只改 patch 中提供的字段（status/result/error/completedAt/sessionId）。
  * stepIndex 不存在时 no-op（防御性——agent 完成/失败回调可能晚于 run 终止到达）。
  */
  update(stepIndex, patch) {
    const node = this.findByStepIndex(stepIndex);
    if (!node) return;
    if (patch.status !== void 0) node.status = patch.status;
    if (patch.result !== void 0) node.result = trimTraceResult(patch.result);
    if (patch.error !== void 0) node.error = patch.error;
    if (patch.completedAt !== void 0) node.completedAt = patch.completedAt;
    if (patch.sessionId !== void 0) node.sessionId = patch.sessionId;
    if (patch.sessionFile !== void 0) node.sessionFile = patch.sessionFile;
  }
  /**
  * 查找指定 stepIndex 的节点（byIndex O(1)，trace 中 stepIndex 应唯一）。
  *
  * 语义差异声明（旧线性扫 first-match → Map last-wins）：仅在破坏
  * stepIndex 唯一性的违规使用下可见，两组场景——
  * 1. 重复 append 同 stepIndex 且未 remove：返回最后一个节点（last-wins；
  *    旧线性扫 first-match 会返回第一个）。
  * 2. 重复 append 后 removeByStepIndex：remove 的 findIndex 命中首个旧节点
  *    splice，而 byIndex.delete 把整个 stepIndex 键删掉——nodes 残留第二个
  *    节点成为孤儿（find/update 不可达，length/toArray 仍可见）。
  * 合法路径无差异：唯一性由 discard 先 remove 再 append 保证（W1TC12 锚定）。
  */
  findByStepIndex(stepIndex) {
    return this.byIndex.get(stepIndex);
  }
  /** 按节点引用删除（仅用于测试或 run 重建场景；正常运行不调用）。 */
  find(stepIndex) {
    return this.findByStepIndex(stepIndex);
  }
  /**
  * 按 stepIndex 移除节点（崩溃重建清理在飞 call 用）。
  *
  * 正常运行不调用（append-only 不变式）。仅 error-recovery 的 discardInFlightCalls
  * （rebuildRuntime 内，F2）清理被旧 runtime abort 的在飞 call 时用——移除其 trace
  * 节点，让重跑重发 agent-call 时 append 全新节点走全新执行路径（避免 stale
  * "running" 节点残留 + trace.update 命中旧节点导致新节点 orphan）。
  * stepIndex 不存在时 no-op（防御性）。
  */
  removeByStepIndex(stepIndex) {
    const idx = this.nodes.findIndex((n) => n.stepIndex === stepIndex);
    if (idx === -1) return;
    this.nodes.splice(idx, 1);
    this.byIndex.delete(stepIndex);
  }
  /**
  * readonly 视图——返回内部 nodes 数组引用（仅类型级 readonly，运行时无
  * 防御）。消费方禁止结构化 mutate（push/splice/重排/覆盖元素）：byIndex
  * 引入后外部结构化 mutate 会使 nodes 与倒排索引 desync。字段级变更走 update()。
  */
  toArray() {
    return this.nodes;
  }
  /** 当前节点数。 */
  get length() {
    return this.nodes.length;
  }
};

// src/orchestration/models/types.ts
var VALID_RUN_TRANSITIONS = {
  running: ["done"],
  done: []
};
function canRunTransition(from, to) {
  return VALID_RUN_TRANSITIONS[from].includes(to);
}

// src/orchestration/models/workflow-run.ts
var WorkflowRun = class _WorkflowRun {
  runId;
  spec;
  state;
  runtime;
  meta;
  /**
  * 创建聚合根。初始状态 "running"（一次性生命周期：run 从创建起即在执行，
  * runtime 由紧随其后的 assignRuntime 注入）。也可传入 done 状态用于重水合
  * 已完成的 run（loadAll 后的只读聚合）。
  *
  * 不变式 I1 构造期跳过——「创建即 running」要求构造瞬间 runtime===undefined
  * 合法（runtime 必须由 assignRuntime 注入，构造函数无从持有）；重水合的
  * running 快照同样无 worker。I1 的运行时校验在 assignRuntime/transition/
  * replaceRuntime 末尾的 validateInvariants 处生效。
  */
  constructor(runId, spec, state, meta) {
    this.runId = runId;
    this.spec = spec;
    this.state = state;
    this.meta = meta;
    this.runtime = void 0;
    this.validateInvariantI2();
  }
  /**
  * 从持久化快照重水合聚合根。与构造函数同语义（构造期跳过 I1——持久化的
  * running 状态没有 worker，进程被杀后 worker 不可能还活着）。保留独立工厂
  * 标注重水合意图；调用方（D-4 kill-9 恢复）负责在 session_start 时把残留
  * running 转 done,failed，恢复 I1。
  *
  * @throws I2 违反（done 快照缺 reason 仍是 bug，不可跳过）
  */
  static reconstruct(runId, spec, state, meta) {
    return new _WorkflowRun(runId, spec, state, meta);
  }
  // ── 不变式校验 ─────────────────────────────────────────────
  /**
  * 校验不变式 I1 + I2。违反抛错（聚合根自我保护，fail-fast）。
  * 在每个 mutation 方法末尾调用（防御式编程 + 测试可断言）。
  */
  validateInvariants() {
    this.validateInvariantI2();
    if (this.state.status === "running" && this.runtime === void 0) {
      throw new Error(
        `WorkflowRun invariant I1 violated: status==="running" but runtime is undefined (runId=${this.runId})`
      );
    }
    if (this.state.status !== "running" && this.runtime !== void 0) {
      throw new Error(
        `WorkflowRun invariant I1 violated: status!=="running" but runtime is defined (runId=${this.runId})`
      );
    }
  }
  /**
  * 仅校验不变式 I2（done ⟹ reason）。构造期用——「创建即 running」与重水合的
  * running 快照都无 runtime（I1 构造期跳过），但 I2 必须保证（done 缺 reason 是真 bug）。
  */
  validateInvariantI2() {
    if (this.state.status === "done" && this.state.reason === void 0) {
      throw new Error(
        `WorkflowRun invariant I2 violated: status==="done" but reason is undefined (runId=${this.runId})`
      );
    }
  }
  // ── 状态机转换 ─────────────────────────────────────────────
  /**
  * 状态机转换。合法转换：running→done。
  *
  * running 的进入不走 transition——构造即 running，replaceRuntime 保持 running。
  * 调用 transition("running") 抛错，防止绕过 runtime 注入直接改状态。
  *
  * 副作用：
  * - →done: releaseRuntime + 设 state.reason + meta.completedAt
  *
  * @param target 目标状态（不允许 "running"——runtime 注入只走 assignRuntime/replaceRuntime）
  * @param reason →done 时必填（done ⟹ reason，不变式 I2）
  * @throws 非法转换 / done 缺 reason / target==="running"
  */
  transition(target, reason) {
    if (target === "running") {
      throw new Error(
        `WorkflowRun.transition: cannot transition to "running" directly \u2014 use assignRuntime() (runId=${this.runId})`
      );
    }
    if (!canRunTransition(this.state.status, target)) {
      throw new Error(
        `WorkflowRun.transition: illegal transition ${this.state.status} \u2192 ${target} (runId=${this.runId})`
      );
    }
    if (target === "done" && reason === void 0) {
      throw new Error(
        `WorkflowRun.transition: transition to "done" requires a reason (runId=${this.runId})`
      );
    }
    this.releaseRuntime();
    this.state.status = target;
    this.state.reason = reason;
    this.meta.completedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.validateInvariants();
  }
  // ── Runtime 生命周期 ───────────────────────────────────────
  /**
  * 绑定 runtime（run 创建后注入执行资源）。
  *
  * 前置：status==="running" && runtime===undefined（runWorkflow 创建路径——
  * 构造即 running 但 runtime 延迟到此处注入）。
  * 原子地：设 runtime 后末尾 validateInvariants，恢复构造期跳过的 I1
  * （running ⟺ runtime!==undefined）。
  *
  * @throws runtime 已定义 / status 不是 "running"（done 僵尸不可复活）
  */
  assignRuntime(rt) {
    if (this.runtime !== void 0) {
      throw new Error(
        `WorkflowRun.assignRuntime: runtime already defined (runId=${this.runId})`
      );
    }
    if (this.state.status !== "running") {
      throw new Error(
        `WorkflowRun.assignRuntime: requires status==="running" (current: ${this.state.status}, runId=${this.runId})`
      );
    }
    this.runtime = rt;
    this.validateInvariants();
  }
  /**
  * 解绑 runtime（done 时由 transition 调用，也可独立调用）。
  *
  * 前置：无（runtime===undefined 时 no-op，幂等）。
  * 副作用：调 runtime.release("terminal") 释放 worker/controller，置 runtime=undefined。
  */
  releaseRuntime() {
    if (this.runtime === void 0) return;
    this.runtime.release("terminal");
    this.runtime = void 0;
  }
  /**
  * 原地替换 runtime（G5-001：worker-error-retry）。
  *
  * 前置：status==="running"（G6-001：终态 run 拒绝重建）。
  * 原子地：释放旧 runtime（worker.terminate + abort）+ 绑定新 runtime，
  * 全程 status 保持 "running"，不变式 I1 不违反（中间无 runtime===undefined 可见态）。
  *
  * 与 release+assign 的区别：replaceRuntime 不改 status，中间同步完成，
  * 外部观察不到违反不变式的瞬间。
  *
  * @throws status!=="running"
  */
  replaceRuntime(rt) {
    if (this.state.status !== "running") {
      throw new Error(
        `WorkflowRun.replaceRuntime: requires status==="running" (current: ${this.state.status}, runId=${this.runId})`
      );
    }
    if (this.runtime !== void 0) {
      this.runtime.release("terminal");
    }
    this.runtime = rt;
    this.validateInvariants();
  }
};

// src/orchestration/lifecycle.ts
var logger3 = getLogger("subagents");
var RUNID_RADIX = 36;
var RUNID_SLICE_START = 2;
var RUNID_SLICE_END = 8;
function generateRunId() {
  return `wf-${Date.now()}-${Math.random().toString(RUNID_RADIX).slice(RUNID_SLICE_START, RUNID_SLICE_END)}`;
}
function makeHandlers(run, deps) {
  const handlers = {
    async onMessage(raw) {
      await handleWorkerMessage(run, raw, deps, handlers);
    },
    async onError(err) {
      await handleWorkerError(run, err, deps, handlers);
    },
    async onExit(code, handle) {
      await handleWorkerExit(run, code, handle, deps, handlers);
    }
  };
  return handlers;
}
function scheduleTimeBudget(runId, deps, budgetTimeMs) {
  assertSafeTimerDelay(budgetTimeMs, "budgetTimeMs");
  const timer = setTimeout(() => {
    void abortRun(runId, deps, "Time budget exceeded", "time_limited").catch(
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger3.error(`[workflow] time budget abort failed: ${msg}`);
      }
    );
  }, budgetTimeMs);
  timer.unref();
  return timer;
}
async function runWorkflow(spec, deps, signal) {
  validateRunArgs(spec);
  const runId = generateRunId();
  if (spec.args && typeof spec.args === "object") {
    spec.args._runId = runId;
  }
  deps.log?.("debug", "workflow:lifecycle", "runWorkflow start", { runId, scriptName: spec.scriptName });
  if (signal?.aborted) {
    throw new Error("Workflow run aborted before start");
  }
  const run = new WorkflowRun(
    runId,
    spec,
    {
      status: "running",
      budget: spec.budgetRef ?? new Budget({
        maxTokens: spec.budgetTokens,
        maxTimeMs: spec.budgetTimeMs
      }),
      calls: /* @__PURE__ */ new Map(),
      trace: new Trace(),
      errorLogs: []
    },
    { startedAt: (/* @__PURE__ */ new Date()).toISOString() }
  );
  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        void abortRun(runId, deps, "External signal aborted").catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger3.error(`[workflow] abortRun on signal failed: ${msg}`);
        });
      },
      { once: true }
    );
  }
  const handlers = makeHandlers(run, deps);
  const controller = new AbortController();
  const worker = deps.workerHost.start(spec, spec.args, handlers);
  const timeBudgetTimer = spec.budgetTimeMs && spec.budgetTimeMs > 0 ? scheduleTimeBudget(runId, deps, spec.budgetTimeMs) : void 0;
  const runtime = new RunRuntime(worker, controller, timeBudgetTimer);
  run.assignRuntime(runtime);
  deps.runs.set(runId, run);
  await deps.store.save(run);
  deps.log?.("debug", "workflow:lifecycle", "run saved", { runId, status: run.state.status });
  deps.log?.("debug", "workflow:lifecycle", "emit pending:register", { runId });
  deps.eventBus?.emit("pending:register", {
    id: runId,
    type: "workflow",
    name: spec.slug || spec.scriptName || runId
  });
  deps.log?.("debug", "workflow:lifecycle", "emit pending:register done", { runId });
  return runId;
}
async function abortRun(runId, deps, reason, doneReason = "aborted") {
  const run = deps.runs.get(runId);
  if (!run) {
    throw new Error(`Workflow '${runId}' not found`);
  }
  deps.log?.("debug", "workflow:lifecycle", "abortRun", { runId, status: run.state.status, reason, doneReason });
  if (run.state.status === "done") {
    deps.log?.("debug", "workflow:lifecycle", "abortRun no-op: already done", { runId });
    return;
  }
  if (reason) {
    run.state.error = reason;
  }
  run.transition("done", doneReason);
  await deps.store.save(run);
  deps.log?.("debug", "workflow:lifecycle", "abortRun transition done", { runId, reason: run.state.reason });
  deps.log?.("debug", "workflow:lifecycle", "emit pending:unregister", { runId, reason: run.state.reason });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
  deps.log?.("debug", "workflow:lifecycle", "emit pending:unregister done", { runId });
  deps.onRunDone?.(run);
}

// src/index.ts
var CORE_PACKAGE_VERSION = "0.2.0";
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CORE_PACKAGE_VERSION,
  DEFAULT_DATA_ROOT,
  abortRun,
  configureCore,
  configureNotifyDomain,
  getLogger,
  routeEngine,
  runWorkflow
});
