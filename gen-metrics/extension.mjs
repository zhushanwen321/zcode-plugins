// gen-metrics：在输入框状态插槽（composer.status）显示主轮生成指标。
//
// 数据源 = 宿主 models.onDidGenerate 能力（GenerationMetrics 事件）：引擎在每次
// 主轮模型请求完成时推送的准确值——outputTokensPerSecond（服务端 usage 折算）
// 与 timeToFirstTokenMs（首内容延迟）。流式估算相位（phase:"streaming"，字符数
// 估算）不上屏：只显示结束准确值，插槽保持上一次请求的准确值（2026-11-23
// 用户裁决，与上游官方示例插件 context-inspector 的裁决一致）。
//
// 会话作用域：每个会话独立一行，跟随该会话最近一次主轮请求的准确值；会话还
// 没有生成过时不设文字（插槽只在有 text 时显示）。扩展进程重启后内存态清空，
// 由下一次 final 事件重建。
//
// 无 package.json（.mjs 入口天然 ESM）：本插件经 config.json plugins.dirs 本地
// 加载，不入 marketplace/npm 发布链，check-sync 按「无 package.json」自动跳过。

import fs from "node:fs";
import os from "node:os";

const SLOT_ID = "gen-metrics";
let concurrencyTimer = null; // deactivate 清理(activate 闭包内赋值)
const SLOT_CONCURRENCY_ID = "gen-concurrency";
const SLOT_TEXT_MAX = 40;
const SLOT_TOOLTIP_MAX = 200;
const MAX_SESSIONS = 100;

// 并发快照(zsem 引擎侧发布,见 patch-zcode-app/zsem/lib/statusfile.js):
// ~/.zcode/cli/zsem-status.json 按 pid 分片,读侧聚合全部 pid 求和。
const STATUS_FILE_DEFAULT = `${os.homedir()}/.zcode/cli/zsem-status.json`;
const CONCURRENCY_POLL_MS = 1000;

const fmtTps = (v) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1));
const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

/** 聚合全部 pid 分片(与 zsem/lib/statusfile.js aggregate 同构);读不到返回 null */
function readConcurrency(statusFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(statusFile ?? STATUS_FILE_DEFAULT, "utf8"));
    const out = { active: 0, queued: 0, limit: 0, providers: {} };
    for (const shard of Object.values(raw?.pids ?? {})) {
      for (const [id, s] of Object.entries(shard?.providers ?? {})) {
        const agg = (out.providers[id] ??= { active: 0, queued: 0, limit: 0 });
        out.active += s.active;
        out.queued += s.queued;
        agg.active += s.active;
        agg.queued += s.queued;
        out.limit = Math.max(out.limit, s.limit);
        agg.limit = Math.max(agg.limit, s.limit);
      }
    }
    return out;
  } catch {
    return null;
  }
}

export async function activate(ctx, opts = {}) {
  const statusFile = opts.statusFile; // 测试注入点;生产读默认路径
  let locale = "en";
  // sessionId -> 最近一次 final 指标（悬停重渲染与命令详情用；上限防无界增长）
  const last = new Map();

  const labels = () =>
    locale === "zh-CN"
      ? {
          tok: (n) => `输出 ${n} tok`,
          ttft: (v) => `首 token ${fmtMs(v)}`,
          conc: (a, l) => `并发 ${a}/${l}`,
          queue: (q) => `排队 ${q}`,
          click: "点击把详情写进日志",
        }
      : {
          tok: (n) => `${n} output tok`,
          ttft: (v) => `TTFT ${fmtMs(v)}`,
          conc: (a, l) => `conc ${a}/${l}`,
          queue: (q) => `queue ${q}`,
          click: "Click to log details",
        };

  // ===== 并发条目:轮询 zsem 状态快照(全局态,非会话作用域) =====
  // 引擎侧每个 grant/queue/cancel/release 刷新 ~/.zcode/cli/zsem-status.json;
  // 1s 轮询 + 内容签名去重(没变化不重渲染)。读不到文件 = zsem 未接管(未打
  // patch 或 provider 未配置),隐藏条目——与限流 fail-open 的可见语义一致。
  let lastSignature = undefined; // 哨兵:首 poll 必发(无数据时也要把条目置隐藏)
  const renderConcurrency = (agg) => {
    const L = labels();
    const text = agg.queued > 0 ? `${L.conc(agg.active, agg.limit)} · ${L.queue(agg.queued)}` : L.conc(agg.active, agg.limit);
    const tooltip = [
      locale === "zh-CN" ? "zsem provider 并发(LLM 请求口径)" : "zsem provider concurrency (LLM requests)",
      ...Object.entries(agg.providers).map(([id, s]) => `${id.length > 28 ? `${id.slice(0, 25)}…` : id}: ${s.active}/${s.limit}`),
      locale === "zh-CN" ? L.click : "Click to log details",
    ].join("\n");
    return {
      text: text.length > SLOT_TEXT_MAX ? text.slice(0, SLOT_TEXT_MAX) : text,
      tooltip: tooltip.length > SLOT_TOOLTIP_MAX ? tooltip.slice(0, SLOT_TOOLTIP_MAX) : tooltip,
    };
  };
  const pollConcurrency = () => {
    try {
      const agg = readConcurrency(statusFile);
      const signature = agg ? JSON.stringify(agg) : null;
      if (signature === lastSignature) return;
      lastSignature = signature;
      if (!agg || (agg.active === 0 && agg.queued === 0 && agg.limit === 0)) {
        ctx.slots.update(SLOT_CONCURRENCY_ID, { text: null });
        return;
      }
      ctx.slots.update(SLOT_CONCURRENCY_ID, renderConcurrency(agg));
    } catch (err) {
      ctx.log.warn(`concurrency slot update failed: ${err?.code ?? err?.message}`);
    }
  };

  const render = (m) => {
    const tps = fmtTps(m.outputTokensPerSecond);
    const text =
      m.timeToFirstTokenMs == null ? `${tps} tok/s` : `${tps} tok/s · TTFT ${fmtMs(m.timeToFirstTokenMs)}`;
    const L = labels();
    const tooltip = [
      m.model.modelId,
      m.outputTokens != null ? L.tok(m.outputTokens) : null,
      m.timeToFirstTokenMs != null ? L.ttft(m.timeToFirstTokenMs) : null,
      L.click,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      text: text.length > SLOT_TEXT_MAX ? text.slice(0, SLOT_TEXT_MAX) : text,
      tooltip: tooltip.length > SLOT_TOOLTIP_MAX ? tooltip.slice(0, SLOT_TOOLTIP_MAX) : tooltip,
    };
  };

  ctx.models.onDidGenerate((m) => {
    try {
      if (m.phase !== "final") return;
      if (last.size >= MAX_SESSIONS && !last.has(m.sessionId)) {
        last.delete(last.keys().next().value);
      }
      last.set(m.sessionId, m);
      ctx.slots.update(SLOT_ID, render(m), { sessionId: m.sessionId });
    } catch (err) {
      ctx.log.warn(`slot update failed: ${err?.code ?? err?.message}`);
    }
  });

  concurrencyTimer = setInterval(pollConcurrency, CONCURRENCY_POLL_MS);
  pollConcurrency();

  // 语言变化时按新语言重渲染已积累的会话（悬停文案本地化）
  ctx.env?.onDidChange?.((env) => {
    if (!env?.locale || env.locale === locale) return;
    locale = env.locale;
    for (const [sessionId, m] of last) {
      try {
        ctx.slots.update(SLOT_ID, render(m), { sessionId });
      } catch {
        /* 单会话重渲染失败不中断其余 */
      }
    }
  });
  ctx.env?.get?.().then(
    (env) => {
      if (env?.locale) locale = env.locale;
    },
    () => {},
  );

  ctx.commands.register("show-details", async (call) => {
    const sessionId = call.scope?.kind === "session" ? call.scope.sessionId : null;
    const m = sessionId ? last.get(sessionId) : null;
    const agg = readConcurrency(statusFile);
    ctx.log.info(
      [
        m
          ? `gen-metrics: ${m.model.providerId}/${m.model.modelId} tps=${m.outputTokensPerSecond.toFixed(2)} out=${m.outputTokens ?? "?"} ttft=${m.timeToFirstTokenMs ?? "?"} requestId=${m.requestId}`
          : "gen-metrics: 本会话还没有完成过主轮请求（无指标可显示）",
        agg
          ? `concurrency: active=${agg.active} queued=${agg.queued} limit=${agg.limit} providers=${JSON.stringify(agg.providers)}`
          : "concurrency: 无 zsem 状态文件（未打 provider-sem patch 或 provider 未配置）",
      ].join("\n"),
    );
  });
}

export function deactivate() {
  if (concurrencyTimer) {
    clearInterval(concurrencyTimer);
    concurrencyTimer = null;
  }
}
