'use strict';
/**
 * 模型清单器（回接计划 2c 瘦身）：ModelRouterPort 的 shell 面。
 *
 * 执行链已切 vendored subagent-core 的 zcode engine（lib/runner-core.js）——
 * 模型解析校验（resolve）/ 隔离 HOME 池准备（prepareRunEnv）整体归引擎
 * preparer（core TS 重写自 zsub 同源机制），本模块不再承担执行期职责。
 * 保留面 = 清单与默认标记（`zsw models` action / SessionStart hook 注入块 /
 * hook 面的实际消费导出）：
 * - ModelRouter#listModels / #allProviders   dist/mcp/server.js models action
 * - ModelRouter#resolveDefault               manager.start 台账落盘的默认模型
 *                                           回退链（record.model 展示值；执行
 *                                           校验归 engine preparer）
 * - defaultModelRef / availableModels / defaultModelFor / qualifiedProviders /
 *   PROVIDER_ID                              hook-source / hook-inject 单源导出
 *
 * 数据源不变：~/.zcode/v2/config.json（桌面登录态，每次调用重读——apiKey/
 * 模型清单随桌面端操作变化，不缓存）。
 */

const fs = require('node:fs');
const config = require('./config');

/** 默认 provider（短名解析与默认清单视图的锚点）。 */
const PROVIDER_ID = 'builtin:bigmodel-coding-plan';
const FALLBACK_DEFAULT_MODEL = `${PROVIDER_ID}/GLM-5.3`;

/**
 * provider 条目凭据判定（原 lib/driver.js 权威谓词随 driver 删除内联至此——
 * 语义源自「清单视图只列真正跑得起来的 provider」，单一实现防各处复刻漂移；
 * 引擎 preparer 的凭据判定是 core 自有实现（更严格：非空 string），两处语义
 * 分立：本谓词只服务清单/展示面）。
 */
function hasProviderCredentials(entry) {
  return Boolean(entry && entry.options && entry.options.apiKey);
}

/** 每次调用都重读源文件：apiKey/模型清单会随桌面端操作变化，不能缓存。 */
function readV2Config() {
  try {
    return JSON.parse(fs.readFileSync(config.V2_CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/** 指定 provider 下的可用模型（缺省 = 默认 provider，向后兼容旧调用）。 */
function availableModels(v2, provider) {
  return Object.keys(v2?.provider?.[provider || PROVIDER_ID]?.models || {});
}

/** v2 config 中所有带非空模型清单的 provider id（「未知 provider」错误的可用清单数据源）。 */
function providersUsable(v2) {
  return Object.entries(v2?.provider || {})
    .filter(([, e]) => e && Object.keys(e.models || {}).length > 0)
    .map(([id]) => id);
}

/**
 * 「合格 provider」判定与枚举（单一实现，models --all 视图与 SessionStart 注入块
 * 的「其他可运行 provider」段共同消费，禁复刻防多出口径漂移）：带凭据
 * （hasProviderCredentials）且模型清单非空——无凭据的列了也跑不起来，兜底链
 * 视图必须是「真正可运行」的全集。与 providersUsable 的差异：多了凭据维度——
 * 错误提示要列「有清单的」（帮助修正引用），可运行视图只列「真正跑得起来的」。
 * @returns {string[]} 合格 provider id（v2 config 声明顺序）
 */
function qualifiedProviders(v2) {
  return Object.entries((v2 && v2.provider) || {})
    .filter(([, e]) => hasProviderCredentials(e) && Object.keys((e && e.models) || {}).length > 0)
    .map(([id]) => id);
}

/**
 * 引用切分（唯一实现）：含 "/" 按 lastIndexOf 切出 provider（provider id 本身
 * 可含 ":"，如 builtin:*），否则短名归默认 provider。
 * @returns {{provider: string, short: string}}
 */
function splitModelRef(ref) {
  const s = String(ref);
  return s.includes('/')
    ? { provider: s.slice(0, s.lastIndexOf('/')), short: s.slice(s.lastIndexOf('/') + 1) }
    : { provider: PROVIDER_ID, short: s };
}

/** 引用能否被 v2 清单解析：全名查对应 provider、短名查默认 provider，模型须在清单内。 */
function resolvableInV2(v2, ref) {
  const { provider, short } = splitModelRef(ref);
  return availableModels(v2, provider).includes(short);
}

/** 默认模型：cli config 的当前主模型（须可被 v2 清单解析），否则回退 v2 → 内置。 */
function defaultModelRef(v2) {
  // 优先读取 cli config 的 model.main（当前会卷模型）。它是桌面端命名空间
  // （如内部路由 provider "router/…"），与 v2 config 清单不保证交集——只在
  // 真可解析时采用，否则诊断后回退：默认值要稳，显式指定才响。
  try {
    const cliConfig = JSON.parse(fs.readFileSync(config.CLI_CONFIG_PATH, 'utf8'));
    const main = cliConfig?.model?.main;
    if (typeof main === 'string' && main.trim()) {
      const ref = main.trim();
      if (resolvableInV2(v2, ref)) return ref;
      console.error(`[zsub:model-router] cli config 主模型 "${ref}" 无法在 v2 清单解析（非本仓可用 provider/模型），回退 v2/内置默认`);
    }
  } catch {
    // cli config 不存在或不可读，忽略
  }
  // 回退到 v2 config 的 model.main
  const main = v2?.model?.main;
  return (typeof main === 'string' && main.trim()) ? main.trim() : FALLBACK_DEFAULT_MODEL;
}

/**
 * 指定 provider 下的默认模型短名——默认标记的唯一谓词（zsw models 与
 * SessionStart hook 注入共用，禁止调用方复刻比对逻辑防两套口径漂移）。
 *
 * provider 感知（2026-08 修复）：main 指向非目标 provider 时必须返回 null，
 * 而不是按纯短名在目标 provider 清单上错标。
 *
 * @param {object|null} v2         v2 config 对象
 * @param {string} providerId      目标 provider
 * @param {string} [ref]           默认模型引用；缺省 = defaultModelRef(v2) 回退链
 *   产物。显式传入（可为 null/''）供零 IO 的纯函数调用方使用（hook-inject
 *   由调用方预算好传入，本函数不再触 fs）。
 * @returns {string|null} 命中返回短名；provider 不匹配、短名不在该 provider
 *   清单内、或引用为空 → null
 */
function defaultModelFor(v2, providerId, ref) {
  const r = arguments.length >= 3 ? ref : defaultModelRef(v2);
  if (typeof r !== 'string' || !r.trim()) return null;
  const { provider, short } = splitModelRef(r.trim());
  if (provider !== providerId) return null;
  return availableModels(v2, providerId).includes(short) ? short : null;
}

function trimToNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/**
 * v2 条目 → 结构化模型条目（listModels 的映射体，allProviders() 复用同一实现
 * 防两份字段提取漂移）。字段全部可选透出：config 里没有的维度不造默认值，
 * 避免误导路由。默认标记走单一谓词（provider 感知）。前置条件：该 provider
 * 清单已验非空（调用方负责，listModels / allProviders 均如此）。
 */
function modelEntries(v2, provider) {
  const defShort = defaultModelFor(v2, provider);
  return availableModels(v2, provider).map((name) => {
    const def = v2.provider[provider].models[name] || {};
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
    if (name === defShort) entry.default = true; // 默认标记：省略 model 时即用它；档位轻重随环境配置，重任务应显式指定
    return entry;
  });
}

class ModelRouter {
  /**
   * 默认模型引用（manager.start 台账落盘用回退链产物；执行期校验/兜底归
   * engine preparer——core resolveZcodeModelRef 在 task.model 缺省时用引擎
   * 内置兜底，本链保持 record 展示语义与历史一致）。
   * @returns {string} provider/model 全名或原始 main 引用
   */
  resolveDefault() {
    return defaultModelRef(readV2Config());
  }

  /**
   * 列出可用模型（zsub models action 数据源）。
   * 为什么返回结构化条目而非裸名字数组：路由决策要的不只是「有哪些」，
   * 还有档位信息（上下文窗口/推理档位/默认标记）——裸名字会让调用方
   * 再查一次 v2 config。
   * @param {string} [provider] 目标 provider，缺省 = 默认 provider
   * @returns {Array<{name: string, label?: string, contextWindow?: number,
   *   reasoning?: {variants: string[], defaultVariant?: string}, default?: true}>}
   * @throws 清单不可读（可操作错误，含恢复指引）
   */
  listModels(provider = PROVIDER_ID) {
    const v2 = readV2Config();
    const models = availableModels(v2, provider);
    if (!models.length) {
      const known = providersUsable(v2);
      throw new Error(
        `provider "${provider}" 无可用模型清单${known.length ? `（v2 config 中有清单的 provider: ${known.join(', ')}）` : ''}。` +
        `恢复指引：改用上述 provider 之一，或先在 ZCode 桌面端为该 provider 配置模型后重试。`
      );
    }
    return modelEntries(v2, provider);
  }

  /**
   * models --all 的全 provider 结构化视图（zsub models --all 数据源；「合格
   * provider 判定 + 全 provider 模型视图」收拢于本模块单一实现，dist/mcp/server.js
   * 入口薄壳层只消费不复制，SessionStart 注入块经 qualifiedProviders 同口径）。
   * 只列合格 provider（qualifiedProviders：带凭据且清单非空），模型名升格为全名
   * <provider>/<model>——跨 provider 引用必须全名，这是视图存在的理由。
   * 清单不可读抛可操作错误（与 listModels 失败口径一致，不静默回空数组）；读
   * 成功但无合格 provider 返回空数组（合法状态：本机未配置任何可运行 provider）。
   * @returns {Array<{provider: string, models: Array<object>}>}
   */
  allProviders() {
    const v2 = readV2Config();
    if (!v2) {
      throw new Error(
        `无法从 ${config.V2_CONFIG_PATH} 读取模型清单。`
        + '恢复指引：确认 ZCode 桌面端已登录并配置 provider 后重试。',
      );
    }
    return qualifiedProviders(v2).map((id) => ({
      provider: id,
      models: modelEntries(v2, id).map((m) => ({ ...m, name: `${id}/${m.name}` })),
    }));
  }
}

module.exports = ModelRouter;
module.exports.PROVIDER_ID = PROVIDER_ID;
// hook 默认标记复用同一回退链（bin/zsw.js hook 分支），与 zsw models 同口径（D3），
// 禁止调用方复刻回退逻辑防两套口径漂移
module.exports.defaultModelRef = defaultModelRef;
// 纯谓词单一导出（hook-inject / 测试消费，禁复刻）：清单、默认标记判定、
// provider 凭据判定（原 driver.js 权威实现内联至此）
module.exports.availableModels = availableModels;
module.exports.defaultModelFor = defaultModelFor;
module.exports.hasProviderCredentials = hasProviderCredentials;
// 「合格 provider」判定（带凭据且模型清单非空）的单一实现：models --all 视图
// 与 SessionStart 注入块「其他可运行 provider」段共同消费，禁复刻
module.exports.qualifiedProviders = qualifiedProviders;
