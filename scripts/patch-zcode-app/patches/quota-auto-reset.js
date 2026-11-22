'use strict';

/**
 * quota-auto-reset 补丁（触发规则，2026-11-22 用户裁决）：
 *   规则 2：5 小时窗口剩余额度 <5% → 触发重置（不限卡到期时间）
 *   规则 3：重置卡距过期 <5 分钟 → 触发重置
 * 周额度机会默认不动手（WEEK_ENABLED=false）。
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
 * 触发语义（v8 修订，2026-11-22 对抗式审查后加固）：
 *   - 每轮 tick 至多发起一次 use：同轮连发多个只会浪费机会（重置效果彼此覆盖）；
 *     其余机会等下一轮按最新状态再判定。
 *   - attempted 只在 use 成功后落键，且成功即推进 usage 复查节流（防快照滞后时
 *     30 秒一张连环扣卡）；失败不落键但进入 60 秒冷却（防一张持续失败的卡独占
 *     每轮 use 预算、饿死后续卡与规则 2），冷却后同键重试（服务端幂等去重防双扣）。
 *   - 发起前按 expireAt 升序排序选「最快过期卡」：与服务端消耗策略假设对齐，
 *     缓解幂等键与实际消耗卡的错位。
 *   - 形态防御：expireAt 非有限数字的项跳过；诊断日志全链路限频（10 分钟）。
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

const VERSION = 'v8';

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
  '    var attempted = Object.create(null); // key -> 成功时间；失败不落键',
  '    var failedUntil = Object.create(null); // key -> 失败冷却截止（防一张持续失败的卡饿死后续）',
  '    var TICK_MS = 60 * 1000;',
  '    var WINDOW_MS = 5 * 60 * 1000;',
  '    var WEEK_ENABLED = false; // 周额度机会不自动用（用户裁决：只自动用 5 小时卡）',
  '    var USAGE_CHECK_BACKOFF_MS = 5 * 60 * 1000; // use 成功后的用量复查节流（防快照滞后连环扣卡）',
  '    var FAIL_COOLDOWN_MS = 60 * 1000; // use 失败冷却（冷却后同键重试）',
  '    var LOW_RATIO = 0.05; // 规则 2 的用量阈值：5 小时窗口剩余 <5%',
  '    var usageUnavailableLogged = false;',
  '    var lastUsageLogAt = 0;',
  '    var nextUsageCheckAt = 0;',
  '    var hadCtx = false;',
  '    var badSvcLogged = false;',
  '    var logAt = Object.create(null);',
  '    function log(m) { try { console.info("[zsw-quota-auto-reset] " + m); } catch (_) {} }',
  '    function logOnce(tag, m) { try { var n = Date.now(); if (logAt[tag] && n - logAt[tag] < 10 * 60 * 1000) return; logAt[tag] = n; log(m); } catch (_) {} }',
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
  '    // 5h 卡筛选与剩余比例：复刻 UI 面板同款逻辑（VB+pRt 筛选、YP 算法，逆向自',
  '    // styles bundle：quota.limits[] 里 type∈{TOKENS_LIMIT,CREDIT_LIMIT} 且 unit===3、',
  '    // number===5 为 5 小时窗口；剩余比例优先 remaining/number，fallback percentage）',
  '    function pickFiveHourLimit(snap) {',
  '      var limits = snap && snap.quota && snap.quota.limits;',
  '      if (!limits || !limits.length) return null;',
  '      for (var i = 0; i < limits.length; i++) {',
  '        var l = limits[i];',
  '        if (!l) continue;',
  '        var familyOk = l.type === "TOKENS_LIMIT" || l.type === "CREDIT_LIMIT";',
  '        if (familyOk && l.unit === 3 && l.number === 5) return l;',
  '      }',
  '      return null;',
  '    }',
  '    // 口径（逆向实锤，Z7n 函数）：percentage 是【剩余百分比 0-100】（面板显示 = 100-percentage）',
  '    // remaining/number 也是剩余口径。本函数统一返回 0~1 的剩余比例。',
  '    function remainingRatio(limit) {',
  '      if (!limit) return null;',
  '      if (typeof limit.remaining === "number" && isFinite(limit.remaining) && typeof limit.number === "number" && isFinite(limit.number) && limit.number > 0) return limit.remaining / limit.number;',
  '      if (typeof limit.percentage === "number" && isFinite(limit.percentage)) return Math.max(0, Math.min(100, limit.percentage)) / 100;',
  '      return null;',
  '    }',
  '    function checkLowRemaining(ctx, five) {',
  '      if (typeof ctx.service.getCodingPlanUsageSnapshot !== "function") {',
  '        if (!usageUnavailableLogged) { usageUnavailableLogged = true; log("usage snapshot RPC unavailable, rule(remaining<5%) disabled"); }',
  '        return;',
  '      }',
  '      ctx.service.getCodingPlanUsageSnapshot(Object.assign({}, ctx.scope, { range: "7d", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })).then(function (snap) {',
  '        var ratio = remainingRatio(pickFiveHourLimit(snap));',
  '        if (ratio === null) { logOnce("ratioNull", "5h limit not found/unreadable in usage snapshot — rule 2 idle (data shape drift?)"); return; }',
  '        if (ratio < LOW_RATIO) {',
  '          log("low remaining " + (ratio * 100).toFixed(1) + "% (<5%), using reset card");',
  '          useExpiring(five, "FIVE_HOUR", ctx.service, ctx.scope, Date.now(), Infinity);',
  '        } else {',
  '          nextUsageCheckAt = Date.now() + USAGE_CHECK_BACKOFF_MS;',
  '          if (Date.now() - lastUsageLogAt > 10 * 60 * 1000) {',
  '            lastUsageLogAt = Date.now();',
  '            log("remaining " + (ratio * 100).toFixed(1) + "% (>=5%), not using; recheck in 5m");',
  '          }',
  '        }',
  '      }).catch(function () { logOnce("usageFail", "usage snapshot RPC failed (rule 2 deferred to next tick)"); });',
  '    }',
  '    function useExpiring(list, resetType, svc, scope, now, maxRemainMs) {',
  '      if (!list || !list.length) return false;',
  '      var cap = maxRemainMs || WINDOW_MS;',
  '      var cands = [];',
  '      for (var i = 0; i < list.length; i++) {',
  '        var op = list[i];',
  '        if (!op || typeof op.expireAt !== "number" || !isFinite(op.expireAt)) continue; // 形态漂移防御：垃圾 expireAt 不入候选',
  '        var remain = op.expireAt - now;',
  '        if (remain <= 0 || remain > cap) continue;',
  '        var key = deriveUuid(op.expireAt, resetType === "WEEK" ? "c" : "8");',
  '        if (attempted[key]) continue;',
  '        if (failedUntil[key] && now < failedUntil[key]) continue; // 失败冷却中，让位后续卡',
  '        cands.push({ op: op, key: key, remain: remain });',
  '      }',
  '      if (cands.length === 0) return false;',
  '      cands.sort(function (a, b) { return a.op.expireAt - b.op.expireAt; }); // 最快过期优先：与服务端消耗策略假设对齐',
  '      var c = cands[0];',
  '      log("reset opportunity (" + resetType + ") expires in " + Math.round(c.remain / 1000) + "s, using it; idempotencyKey=" + c.key);',
  '      svc.useCodingPlanReset(Object.assign({}, scope, { idempotencyKey: c.key, resetType: resetType }))',
  '        .then(function () { attempted[c.key] = Date.now(); nextUsageCheckAt = Date.now() + USAGE_CHECK_BACKOFF_MS; log("reset used ok (" + resetType + ")"); })',
  '        .catch(function (err) { failedUntil[c.key] = Date.now() + FAIL_COOLDOWN_MS; log("reset use FAILED (" + resetType + ", cooldown " + FAIL_COOLDOWN_MS / 1000 + "s then retry same key): " + (err && err.message ? err.message : String(err))); });',
  '      return true; // 每轮至多发起一次 use；其余机会下一轮按最新状态判定',
  '    }',
  '    setInterval(function () {',
  '      try {',
  '        var ctx = globalThis.__zswQuotaCtx;',
  '        if (!ctx || !ctx.service || !ctx.scope) {',
  '          hadCtx = false;',
  '          logOnce("noCtx", "waiting for quota panel ctx (open the reset panel once to arm rule checks)");',
  '          return; // 额度面板尚未挂载（捕获钩子未运行），静默等待',
  '        }',
  '        if (typeof ctx.service.useCodingPlanReset !== "function" || typeof ctx.service.getCodingPlanResetStatus !== "function") {',
  '          if (!badSvcLogged) { badSvcLogged = true; log("ctx.service missing RPC methods (hasUse=" + typeof ctx.service.useCodingPlanReset + ", hasStatus=" + typeof ctx.service.getCodingPlanResetStatus + ") - capture hook stored wrong object"); }',
  '          return;',
  '        }',
  '        if (!hadCtx) { hadCtx = true; log("ctx captured (quota panel mounted), watching"); }',
  '        ctx.service.getCodingPlanResetStatus(ctx.scope).then(function (st) {',
  '          if (!st) { logOnce("badStatus", "status response empty (shape drift?)"); return; }',
  '          var now = Date.now();',
  '          var five = st.availableFiveHourResets;',
  '          if (!five || !five.length) { logOnce("noFive", "no available five-hour opportunities in status"); return; }',
  '          var soonest = Infinity;',
  '          for (var i = 0; i < five.length; i++) {',
  '            if (five[i] && typeof five[i].expireAt === "number" && isFinite(five[i].expireAt) && five[i].expireAt > now && five[i].expireAt - now < soonest) soonest = five[i].expireAt - now;',
  '          }',
  '          if (soonest !== Infinity && soonest <= WINDOW_MS) {',
  '            log("status: " + five.length + " five-hour opportunities, soonest expires in " + Math.round(soonest / 1000) + "s");',
  '          }',
  '          if (useExpiring(five, "FIVE_HOUR", ctx.service, ctx.scope, now)) return;',
  '          if (WEEK_ENABLED) useExpiring(st.availableWeekResets, "WEEK", ctx.service, ctx.scope, now);',
  '          if (Date.now() >= nextUsageCheckAt) {',
  '            checkLowRemaining(ctx, five);',
  '          }',
  '        }).catch(function () { logOnce("statusFail", "status RPC failed (rules deferred to next tick)"); });',
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
  description: '5 小时窗口剩余 <5% 或重置卡距过期 <5 分钟时自动重置（周额度不自动用）',
  target: TARGET,
  isApplied,
  transform,
  // 供仓库测试在 vm 沙箱里对注入产物原文做触发语义回归（不碰真实 API）
  watcherCode: WATCHER_CODE,
  version: VERSION,
};
