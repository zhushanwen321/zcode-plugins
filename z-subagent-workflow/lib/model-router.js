'use strict';
/**
 * ModelRouterPort 实现（DESIGN-v3 D5：model 路由双机制中的 spawn/home-pool 侧）。
 *
 * 职责拆分：
 * - resolve()：解析链 requested > agentDefault > 默认，并对照
 *   ~/.zcode/v2/config.json 的 provider['builtin:bigmodel-coding-plan'].models
 *   校验。未知模型抛可操作错误（列可用清单 + 恢复指引）。
 * - prepareRunEnv('spawn')：per-model 隔离 HOME 池 + 按需 bootstrap；
 *   prepareRunEnv('appserver')：只给 session/create 的 model 参数，HOME 池
 *   逻辑整体不触发（apc 是单一长驻进程，模型 per-session 设置）。
 *
 * 为什么 spawn 侧只支持 builtin:bigmodel-coding-plan 一个 provider：隔离 HOME
 * 的 cli/config.json 只写这一个 provider 的凭据（D5），其他 provider（如
 * 自定义 API key 条目）不在隔离配置里，写了也跑不起来——直接在 resolve
 * 阶段报错比运行时挂掉可诊断。
 *
 * 实测事实（2026-08）：本机 v2 config 顶层无 model 字段，「当前主模型」
 * 读取 model.main，读不到则回退 GLM-5.3。
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const driver = require('./driver');

const PROVIDER_ID = driver.PROVIDER_ID;
const FALLBACK_DEFAULT_MODEL = `${PROVIDER_ID}/GLM-5.3`;

/** 每次调用都重读源文件：apiKey/模型清单会随桌面端操作变化，不能缓存。 */
function readV2Config() {
  try {
    return JSON.parse(fs.readFileSync(config.V2_CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function availableModels(v2) {
  return Object.keys(v2?.provider?.[PROVIDER_ID]?.models || {});
}

function modelShort(ref) {
  const s = String(ref);
  return s.slice(s.lastIndexOf('/') + 1);
}

/** 默认模型：v2 config 的当前主模型，读不到用 fallback。 */
function defaultModelRef(v2) {
  const main = v2?.model?.main;
  return (typeof main === 'string' && main.trim()) ? main.trim() : FALLBACK_DEFAULT_MODEL;
}

function trimToNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/**
 * per-model HOME 池互斥链：同 home 的重入按序执行。
 * 为什么需要：bootstrap 是「读源 → 比对 → 写池」多步操作，若未来实现变
 * 异步（如 fs/promises），无互斥会交错；同时把「并发 start 同一模型只
 * bootstrap 一次」的意图显式化。跨进程竞态由 tmp+rename 原子写兜底。
 */
const poolMutex = new Map(); // home -> Promise（链尾，吞掉前序失败保证后续排队者仍执行）

function ensureHomePool(home, modelRef) {
  const prev = poolMutex.get(home) || Promise.resolve();
  const next = prev.then(() => {
    if (homeNeedsBootstrap(home)) driver.bootstrapIsolatedHome(home, modelRef);
  });
  poolMutex.set(home, next.catch(() => {}));
  return next;
}

/**
 * 仅当以下情况重写池配置（否则跳过，resume 轮零开销）：
 * 1. 池目录或池内 config.json 不存在（首次建池）；
 * 2. 池内 config.json 损坏（torn write 防线：mtime 看似新但内容不完整）；
 * 3. 源 v2 config 的 mtime 比池内 config 新（桌面端刷新了 apiKey/模型清单）。
 * 源文件不可读但池配置完好：保留池现状——没有更好依据时不破坏可用状态。
 */
function homeNeedsBootstrap(home) {
  const poolConfig = path.join(home, '.zcode', 'cli', 'config.json');
  if (!fs.existsSync(home) || !fs.existsSync(poolConfig)) return true;
  let poolMtimeMs = 0;
  try {
    JSON.parse(fs.readFileSync(poolConfig, 'utf8'));
    poolMtimeMs = fs.statSync(poolConfig).mtimeMs;
  } catch {
    return true;
  }
  try {
    return fs.statSync(config.V2_CONFIG_PATH).mtimeMs > poolMtimeMs;
  } catch {
    return false;
  }
}

class ModelRouter {
  /**
   * 解析并校验模型引用。
   * @param {string} [requested]     start 入参的 model
   * @param {string} [agentDefault]  agent .md frontmatter 的 model
   * @returns {string} 规范化全名 `${PROVIDER_ID}/${短名}`
   * @throws 未知模型/不支持的 provider/清单不可读（显式指定时）——均为可操作错误
   */
  resolve(requested, agentDefault) {
    const wanted = trimToNull(requested) || trimToNull(agentDefault);
    const v2 = readV2Config();
    const models = availableModels(v2);
    const target = wanted || defaultModelRef(v2);

    if (!models.length) {
      if (wanted) {
        throw new Error(
          `无法从 ${config.V2_CONFIG_PATH} 读取 ${PROVIDER_ID} 的模型清单，不能校验 model="${wanted}"。` +
          `恢复指引：确认 ZCode 桌面端已登录并配置该 provider（v2 config 内存在含 models 的条目）后重试。`
        );
      }
      // 无显式指定且无清单可校验：放行默认值，bootstrap 阶段会给完整可操作错误
      return target;
    }

    if (target.includes('/')) {
      const providerPart = target.slice(0, target.lastIndexOf('/'));
      if (providerPart !== PROVIDER_ID) {
        throw new Error(
          `不支持的模型引用 "${target}"：spawn 隔离 HOME 只配置 ${PROVIDER_ID} 一个 provider。` +
          `可用模型: ${models.join(', ')}。` +
          `恢复指引：改用上述模型的短名或 ${PROVIDER_ID}/<模型名> 全名后重试。`
        );
      }
    }
    const short = modelShort(target);
    if (!models.includes(short)) {
      throw new Error(
        `未知模型 "${target}"。${PROVIDER_ID} 下可用: ${models.join(', ')}。` +
        `恢复指引：改用上述模型（短名或全名），或先在 ZCode 桌面端为该 provider 启用目标模型后重试。`
      );
    }
    return `${PROVIDER_ID}/${short}`;
  }

  /**
   * 列出当前可用模型（zsub models action 数据源）。
   * 为什么返回结构化条目而非裸名字数组：路由决策要的不只是「有哪些」，
   * 还有档位信息（上下文窗口/推理档位/默认标记）——裸名字会让调用方
   * 再查一次 v2 config。字段全部可选透出：config 里没有的维度不造默认值
   * （如本机实测条目无 label），避免误导路由。
   * @returns {Array<{name: string, label?: string, contextWindow?: number,
   *   reasoning?: {variants: string[], defaultVariant?: string}, default?: true}>}
   * @throws 清单不可读（可操作错误，含恢复指引）
   */
  listModels() {
    const v2 = readV2Config();
    const models = availableModels(v2);
    if (!models.length) {
      throw new Error(
        `无法从 ${config.V2_CONFIG_PATH} 读取 ${PROVIDER_ID} 的模型清单。` +
        `恢复指引：确认 ZCode 桌面端已登录并配置该 provider（v2 config 内存在含 models 的条目）后重试。`
      );
    }
    const defShort = modelShort(defaultModelRef(v2));
    return models.map((name) => {
      const def = v2.provider[PROVIDER_ID].models[name] || {};
      const entry = { name };
      const label = trimToNull(def.label);
      if (label) entry.label = label;
      const ctx = def.limit && def.limit.context;
      if (Number.isFinite(ctx) && ctx > 0) entry.contextWindow = ctx;
      const r = def.reasoning;
      if (r && Array.isArray(r.variants) && r.variants.length > 0) {
        entry.reasoning = { variants: r.variants };
        if (typeof r.defaultVariant === 'string' && r.defaultVariant) {
          entry.reasoning.defaultVariant = r.defaultVariant;
        }
      }
      if (name === defShort) entry.default = true; // 默认标记：重量任务省略 model 即用它
      return entry;
    });
  }

  /**
   * 准备运行环境（runner 启动前必须调用，结果放进 taskCtx.runEnv）。
   * @param {string} modelRef  resolve() 的产物
   * @param {'spawn'|'appserver'} [runnerKind='spawn']
   * @returns {Promise<{env?: {HOME: string, ZSW_NESTED: string}, createParams?: {model: string}}>}
   */
  async prepareRunEnv(modelRef, runnerKind) {
    if (!modelRef || typeof modelRef !== 'string') {
      throw new Error(
        `ModelRouter.prepareRunEnv: modelRef 必填（收到 ${JSON.stringify(modelRef)}）。` +
        '恢复指引：先经 resolve() 得到模型全名再准备运行环境。'
      );
    }
    if (runnerKind === 'appserver') {
      // 模型走 session/create 参数，无 per-model HOME 池（D5「单一隔离 HOME」）；
      // 但 app-server 进程的 provider 凭据同样读 $HOME/.zcode/cli/config.json，
      // 该 HOME 也必须 bootstrap——e2e 实测（2026-08-23）：不 bootstrap 则真实
      // 模型调用全部失败（空配置无凭据）。复用 ensureHomePool 的互斥 + mtime 链。
      const short = modelShort(modelRef);
      const home = config.appserverHomeDir();
      await ensureHomePool(home, `${PROVIDER_ID}/${short}`);
      // session/create 的 model 是 strict 对象（e2e 实测 2026-08-23，zcode.cjs
      // schema C1t/hc）：{providerId, modelId, variant?}——字符串会被 -32602
      // ZodError 拒收（expected object, received string）。
      return { createParams: { model: { providerId: PROVIDER_ID, modelId: short } } };
    }
    const short = modelShort(modelRef);
    const home = config.homePoolDir(short);
    await ensureHomePool(home, modelRef);
    return { env: { HOME: home, ZSW_NESTED: '1' } };
  }
}

module.exports = ModelRouter;
module.exports.PROVIDER_ID = PROVIDER_ID;
module.exports.FALLBACK_DEFAULT_MODEL = FALLBACK_DEFAULT_MODEL;
