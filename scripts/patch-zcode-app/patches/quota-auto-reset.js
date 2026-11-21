'use strict';

/**
 * quota-auto-reset 补丁（方案 1 裁决）：5 小时额度重置机会距过期不足 5 分钟时
 * 自动消耗该机会执行重置，不设当前窗口用量阈值；周额度机会默认不动手。
 *
 * 机制（逆向自 ZCode 3.19.1 渲染层 styles bundle，2026-11-21）：
 *   - 状态接口 RPC：usage-stats.getCodingPlanResetStatus(scope)
 *     → { availableFiveHourResets: [{expireAt}], availableWeekResets, ... }
 *   - 执行重置 RPC：usage-stats.useCodingPlanReset({...scope, idempotencyKey, resetType})
 *   - 渲染层每 5 分钟轮询一次 status（coordinator，窗口可见时才轮询），机会过期即作废。
 *     本补丁不依赖面板可见性：独立 setInterval 自查（后台渲染进程定时器被节流到
 *     约 1 分钟粒度，仍远快于 5 分钟窗口）。
 *
 * 注入方式两段：
 *   1. 捕获钩子——在渲染层调用 getCodingPlanResetStatus 的唯一站点外套一层
 *      逗号表达式，把 {service, scope, authSessionSeq} 存到 globalThis；
 *      service 是渲染层 usage-stats RPC 代理，重用即免持凭据（令牌只在宿主内存）。
 *   2. 观察器——文件尾追加自包含 IIFE：每 30s 查一次状态，命中最快过期 <5min
 *      的机会就调 useCodingPlanReset。幂等键由 expireAt 推导（同机会重试同键，
 *      服务端幂等去重防重复消耗）。
 */

const TARGET = {
  pathRegex: /^\/out\/renderer\/assets\/styles-[^/]+\.js$/,
  // 唯一性锚点：quota reset coordinator 的调试串，只在额度状态管理 chunk 中
  contentAnchor: '[coding-plan-reset] coordinator created',
};

const MARKER_OPEN = '/* zcode-patch:quota-auto-reset v1 */';
const MARKER_CLOSE = '/* zcode-patch:quota-auto-reset end */';

// 渲染层查询状态的唯一站点：`<V>.service.getCodingPlanResetStatus(<S>.scope)`
// 3.19.1 实测（V===S==='e'，即 vin 函数参数）恰好 1 处
const CAPTURE_RE = /([A-Za-z_$][\w$]*)\.service\.getCodingPlanResetStatus\(([A-Za-z_$][\w$]*)\.scope\)/;

function isApplied(content) {
  return content.includes(MARKER_OPEN);
}

const WATCHER_CODE = [
  'if (typeof globalThis.__zswQuotaAutoReset === "undefined") {',
  '  globalThis.__zswQuotaAutoReset = (function () {',
  '    var attempted = Object.create(null);',
  '    var TICK_MS = 30 * 1000;',
  '    var WINDOW_MS = 5 * 60 * 1000;',
  '    var WEEK_ENABLED = false; // 周额度机会默认不自动用（方案 1 裁决：只自动用 5 小时机会）',
  '    function log(m) { try { console.info("[zsw-quota-auto-reset] " + m); } catch (_) {} }',
  '    function useExpiring(list, resetType, svc, scope, now) {',
  '      if (!list || !list.length) return;',
  '      for (var i = 0; i < list.length; i++) {',
  '        var op = list[i];',
  '        if (!op || !op.expireAt) continue;',
  '        var remain = op.expireAt - now;',
  '        if (remain <= 0 || remain > WINDOW_MS) continue;',
  '        var key = "zsw-auto-" + resetType.toLowerCase() + "-" + op.expireAt;',
  '        if (attempted[key]) continue;',
  '        attempted[key] = now;',
  '        log("reset opportunity (" + resetType + ") expires in " + Math.round(remain / 1000) + "s, using it; idempotencyKey=" + key);',
  '        svc.useCodingPlanReset(Object.assign({}, scope, { idempotencyKey: key, resetType: resetType }))',
  '          .then(function () { log("reset used ok (" + resetType + ")"); })',
  '          .catch(function (err) { log("reset use FAILED (" + resetType + "): " + (err && err.message ? err.message : String(err))); });',
  '      }',
  '    }',
  '    setInterval(function () {',
  '      try {',
  '        var ctx = globalThis.__zswQuotaCtx;',
  '        if (!ctx || !ctx.service || typeof ctx.service.useCodingPlanReset !== "function" || !ctx.scope) return;',
  '        ctx.service.getCodingPlanResetStatus(ctx.scope).then(function (st) {',
  '          if (!st) return;',
  '          var now = Date.now();',
  '          useExpiring(st.availableFiveHourResets, "FIVE_HOUR", ctx.service, ctx.scope, now);',
  '          if (WEEK_ENABLED) useExpiring(st.availableWeekResets, "WEEK", ctx.service, ctx.scope, now);',
  '        }).catch(function () { /* 状态接口暂时不可用：下一轮重试 */ });',
  '      } catch (_) { /* 任何异常不外溢：下一轮重试 */ }',
  '    }, TICK_MS);',
  '    return { attempted: attempted, startedAt: Date.now() };',
  '  })();',
  '}',
].join('\n');

function transform(content, filePath) {
  if (isApplied(content)) return { content, note: 'already-applied' };

  const captureMatches = content.match(new RegExp(CAPTURE_RE.source, 'g'));
  if (!captureMatches || captureMatches.length !== 1) {
    throw new Error(
      `quota-auto-reset 捕获锚点在 ${filePath} 命中 ${captureMatches ? captureMatches.length : 0} 处（要求恰好 1 处）。` +
        '常见原因：ZCode 升级后渲染层 bundle 结构变化。恢复动作：重新逆向定位 getCodingPlanResetStatus 调用站点并更新 CAPTURE_RE。'
    );
  }

  // 捕获钩子：逗号表达式包裹原调用，语义不变（先存 ctx 再取状态）
  const next = content.replace(CAPTURE_RE, (m, serviceHolder, scopeHolder) => {
    return (
      `(globalThis.__zswQuotaCtx={service:${serviceHolder},scope:${scopeHolder}.scope,` +
      `authSessionSeq:${serviceHolder}.authSessionSeq},${m})`
    );
  });

  return { content: `${next}\n${MARKER_OPEN}\n${WATCHER_CODE}\n${MARKER_CLOSE}\n`, note: 'patched' };
}

module.exports = {
  name: 'quota-auto-reset',
  description: '5 小时重置机会距过期 <5 分钟时自动执行重置（方案 1，无用量阈值；周额度不自动用）',
  target: TARGET,
  isApplied,
  transform,
};
