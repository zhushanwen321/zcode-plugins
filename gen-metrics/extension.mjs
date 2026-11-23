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

const SLOT_ID = "gen-metrics";
const SLOT_TEXT_MAX = 40;
const SLOT_TOOLTIP_MAX = 200;
const MAX_SESSIONS = 100;

const fmtTps = (v) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1));
const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

export async function activate(ctx) {
  let locale = "en";
  // sessionId -> 最近一次 final 指标（悬停重渲染与命令详情用；上限防无界增长）
  const last = new Map();

  const labels = () =>
    locale === "zh-CN"
      ? {
          tok: (n) => `输出 ${n} tok`,
          ttft: (v) => `首 token ${fmtMs(v)}`,
          click: "点击把详情写进日志",
        }
      : {
          tok: (n) => `${n} output tok`,
          ttft: (v) => `TTFT ${fmtMs(v)}`,
          click: "Click to log details",
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
    ctx.log.info(
      m
        ? `gen-metrics: ${m.model.providerId}/${m.model.modelId} tps=${m.outputTokensPerSecond.toFixed(2)} out=${m.outputTokens ?? "?"} ttft=${m.timeToFirstTokenMs ?? "?"} requestId=${m.requestId}`
        : "gen-metrics: 本会话还没有完成过主轮请求（无指标可显示）",
    );
  });
}

export function deactivate() {}
