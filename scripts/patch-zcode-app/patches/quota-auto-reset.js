'use strict';

/**
 * quota-auto-reset 补丁（方案 1 裁决）：5 小时额度重置机会距过期不足 5 分钟时
 * 自动消耗该机会执行重置，不设当前窗口用量阈值；周额度机会默认不动手。
 *
 * 机制（逆向自 ZCode 3.19.1 渲染层 styles bundle，2026-11-21）：
 *   - 状态接口 RPC：usage-stats.getCodingPlanResetStatus(scope)
 *     → { availableFiveHourResets: [{expireAt}], availableWeekResets, ... }
 *     （camelCase 形态为宿主 RPC 规整后的契约，store 内部同样消费 d.expireAt）
 *   - 执行重置 RPC：usage-stats.useCodingPlanReset({...scope, idempotencyKey, resetType})
 *   - 渲染层每 5 分钟轮询一次 status（coordinator，窗口可见时才轮询），机会过期即作废。
 *     本补丁不依赖面板可见性：独立 setInterval 自查（后台渲染进程定时器被节流到
 *     约 1 分钟粒度，仍远快于 5 分钟窗口）。
 *
 * 触发语义（v2 修订，2026-11-21 离线沙箱实测后收紧）：
 *   - 每轮 tick 至多发起一次 use：同轮连发多个只会浪费机会（重置效果彼此覆盖）；
 *     其余机会等下一轮（30s 后）按最新状态再判定。
 *   - attempted 只在 use 成功后落键；失败不落键，下一轮用同一幂等键重试
 *     （服务端按幂等键去重，重试不会双扣）。过期机会的自然死亡是重试的终止条件。
 *
 * 注入方式两段：
 *   1. 捕获钩子——在渲染层调用 getCodingPlanResetStatus 的唯一站点外套一层
 *      逗号表达式，把 {service, scope, authSessionSeq} 存到 globalThis；
 *      service 是渲染层 usage-stats RPC 代理，重用即免持凭据（令牌只在宿主内存）。
 *   2. 观察器——文件尾追加自包含 IIFE：每 30s 查一次状态，命中最快过期 <5min
 *      的机会就调 useCodingPlanReset。带全链路日志（安装 / ctx 捕获 / 入窗 / 触发），
 *      console 前缀 [zsw-quota-auto-reset]，断链时可直接从 DevTools 定位。
 *
 * 版本升级：marker 带 v2；transform 先剥离旧版本注入（观察器块 + 捕获钩子包裹）
 * 再注入新版本，apply 幂等且支持原地升级。
 */

const VERSION = 'v4';

const TARGET = {
  pathRegex: /^\/out\/renderer\/assets\/styles-[^/]+\.js$/,
  // 唯一性锚点：quota reset coordinator 的调试串，只在额度状态管理 chunk 中
  contentAnchor: '[coding-plan-reset] coordinator created',
};

const MARKER_OPEN = `/* zcode-patch:quota-auto-reset ${VERSION} */`;
const MARKER_CLOSE = '/* zcode-patch:quota-auto-reset end */';
// 任意版本的观察器块（升级时整块剥离）
const ANY_MARKER_BLOCK_RE = /\/\* zcode-patch:quota-auto-reset v\d+ \*\/[\s\S]*?\/\* zcode-patch:quota-auto-reset end \*\//;
// 渲染层查询状态的唯一站点：`<V>.service.getCodingPlanResetStatus(<S>.scope)`
const CAPTURE_RE = /([A-Za-z_$][\w$]*)\.service\.getCodingPlanResetStatus\(([A-Za-z_$][\w$]*)\.scope\)/;
// 旧注入的捕获钩子包裹形态（升级时还原为裸调用）
const CAPTURE_WRAPPED_RE = /\(globalThis\.__zswQuotaCtx=\{service:([A-Za-z_$][\w$]*)(?:\.service)?,scope:([A-Za-z_$][\w$]*)\.scope,authSessionSeq:\1\.authSessionSeq\},\1\.service\.getCodingPlanResetStatus\(\2\.scope\)\)/;

function isApplied(content) {
  return content.includes(MARKER_OPEN);
}

const WATCHER_CODE = [
  'if (typeof globalThis.__zswQuotaAutoReset === "undefined") {',
  '  globalThis.__zswQuotaAutoReset = (function () {',
  '    var VERSION = "' + VERSION + '";',
  '    var attempted = Object.create(null); // key -> 成功时间；失败不落键，下轮同键重试',
  '    var TICK_MS = 30 * 1000;',
  '    var WINDOW_MS = 5 * 60 * 1000;',
  '    var WEEK_ENABLED = false; // 周额度机会默认不自动用（方案 1 裁决：只自动用 5 小时机会）',
  '    var hadCtx = false;',
  '    var badSvcLogged = false;',
  '    function log(m) { try { console.info("[zsw-quota-auto-reset] " + m); } catch (_) {} }',
  '    // 幂等键 = expireAt 派生的 UUID 形态（8-4-4-4-12 hex，版本位 4）：服务端已证明只接受',
  '    // UI 同款 crypto.randomUUID() 形态（v3 的 "zsw-auto-..." 键被业务码 3001 拒绝，',
  '    // 2026-11-21 真机实测）；同一机会重试由 expireAt 决定同键，服务端幂等去重不失效。',
  '    // 变体位 8 = FIVE_HOUR，c = WEEK，防两类机会撞键。',
  '    function deriveUuid(expireAt, variant) {',
  '      var h = Number(expireAt).toString(16);',
  '      while (h.length < 32) h = "0" + h;',
  '      return h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) + "-" + variant + h.slice(17, 20) + "-" + h.slice(20, 32);',
  '    }',
  '    log("watcher installed " + VERSION + " (tick " + TICK_MS + "ms, window " + WINDOW_MS + "ms, week=" + WEEK_ENABLED + ")");',
  '    function useExpiring(list, resetType, svc, scope, now) {',
  '      if (!list || !list.length) return false;',
  '      for (var i = 0; i < list.length; i++) {',
  '        var op = list[i];',
  '        if (!op || !op.expireAt) continue;',
  '        var remain = op.expireAt - now;',
  '        if (remain <= 0 || remain > WINDOW_MS) continue;',
  '        var key = deriveUuid(op.expireAt, resetType === "WEEK" ? "c" : "8");',
  '        if (attempted[key]) continue;',
  '        log("reset opportunity (" + resetType + ") expires in " + Math.round(remain / 1000) + "s, using it; idempotencyKey=" + key);',
  '        svc.useCodingPlanReset(Object.assign({}, scope, { idempotencyKey: key, resetType: resetType }))',
  '          .then(function () { attempted[key] = Date.now(); log("reset used ok (" + resetType + ")"); })',
  '          .catch(function (err) { log("reset use FAILED (" + resetType + ", will retry same key): " + (err && err.message ? err.message : String(err))); });',
  '        return true; // 每轮至多发起一次 use；其余机会下一轮按最新状态判定',
  '      }',
  '      return false;',
  '    }',
  '    setInterval(function () {',
  '      try {',
  '        var ctx = globalThis.__zswQuotaCtx;',
  '        if (!ctx || !ctx.service || !ctx.scope) {',
  '          if (hadCtx) { hadCtx = false; log("ctx lost (page reloaded?)"); }',
  '          return; // 额度面板尚未挂载（捕获钩子未运行），静默等待',
  '        }',
  '        if (typeof ctx.service.useCodingPlanReset !== "function" || typeof ctx.service.getCodingPlanResetStatus !== "function") {',
  '          if (!badSvcLogged) { badSvcLogged = true; log("ctx.service missing RPC methods (hasUse=" + typeof ctx.service.useCodingPlanReset + ", hasStatus=" + typeof ctx.service.getCodingPlanResetStatus + ") - capture hook stored wrong object"); }',
  '          return;',
  '        }',
  '        if (!hadCtx) { hadCtx = true; log("ctx captured (quota panel mounted), watching"); }',
  '        ctx.service.getCodingPlanResetStatus(ctx.scope).then(function (st) {',
  '          if (!st) return;',
  '          var now = Date.now();',
  '          var five = st.availableFiveHourResets;',
  '          var soonest = Infinity;',
  '          for (var i = 0; five && i < five.length; i++) {',
  '            if (five[i] && five[i].expireAt && five[i].expireAt > now && five[i].expireAt - now < soonest) soonest = five[i].expireAt - now;',
  '          }',
  '          if (soonest !== Infinity && soonest <= WINDOW_MS) {',
  '            log("status: " + (five ? five.length : 0) + " five-hour opportunities, soonest expires in " + Math.round(soonest / 1000) + "s");',
  '          }',
  '          if (useExpiring(five, "FIVE_HOUR", ctx.service, ctx.scope, now)) return;',
  '          if (WEEK_ENABLED) useExpiring(st.availableWeekResets, "WEEK", ctx.service, ctx.scope, now);',
  '        }).catch(function () { /* 状态接口暂时不可用：下一轮重试 */ });',
  '      } catch (_) { /* 任何异常不外溢：下一轮重试 */ }',
  '    }, TICK_MS);',
  '    return { attempted: attempted, startedAt: Date.now(), version: VERSION };',
  '  })();',
  '}',
].join('\n');

function transform(content, filePath) {
  // 当前版本在场 → 原样返回（buildPlan 已先按 isApplied 跳过，这里是防御性兜底）
  if (isApplied(content)) return { content, note: 'already-applied' };

  // 升级路径：剥离任意旧版本观察器块 + 还原捕获钩子包裹
  let work = content.replace(ANY_MARKER_BLOCK_RE, '\n');
  work = work.replace(CAPTURE_WRAPPED_RE, (m, serviceHolder, scopeHolder) => {
    return `${serviceHolder}.service.getCodingPlanResetStatus(${scopeHolder}.scope)`;
  });

  const captureMatches = work.match(new RegExp(CAPTURE_RE.source, 'g'));
  if (!captureMatches || captureMatches.length !== 1) {
    throw new Error(
      `quota-auto-reset 捕获锚点在 ${filePath} 命中 ${captureMatches ? captureMatches.length : 0} 处（要求恰好 1 处）。` +
        '常见原因：ZCode 升级后渲染层 bundle 结构变化，或剥离旧注入失败留下重复调用站点。恢复动作：重新逆向定位 getCodingPlanResetStatus 调用站点并更新 CAPTURE_RE。'
    );
  }

  // 2) 捕获钩子：逗号表达式包裹原调用，语义不变（先存 ctx 再取状态）
  const next = work.replace(CAPTURE_RE, (m, serviceHolder, scopeHolder) => {
    return (
      // service 必须取字段 V.service（RPC 代理本体）；V 是 vin 的参数包装对象，其上没有 RPC 方法
      `(globalThis.__zswQuotaCtx={service:${serviceHolder}.service,scope:${scopeHolder}.scope,` +
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
  // 供仓库测试在 vm 沙箱里对注入产物原文做触发语义回归（不碰真实 API）
  watcherCode: WATCHER_CODE,
  version: VERSION,
};
