'use strict';
/**
 * zsub action 表（CLI 单一入口，D3 表单源遗产）：action 名 → 执行。
 *
 * 为什么是表而不是内联 switch：执行语义单一来源——加/改 action 只动这里
 * （业务校验加 manager 层，D4）。CLI 的 argv → params 翻译（组参 switch）
 * 是 bin/zsw.js 的职责；start 的 wait 参数恒 true（CLI 进程活着才有执行体）。
 * 历史形态：1.x 的 daemon socket 面与本表同源消费（dist/mcp/server.js handler），
 * 2.0 随 daemon 退役，CLI 是唯一入口。
 *
 * exec 契约：
 * - 错误一律 throw 可操作消息（CLI main catch 打印 + exit 1）——消息文本
 *   与收口前 dist/mcp/server.js 各分支逐字一致（零行为变化基准）。
 * - 校验分层（D4）：本表只持入口前置校验（subagentId 必填、message text
 *   必填）；业务权威校验在 lib/manager.js（start 入口与 message 四闸）；
 *   CLI usage() 缺参提示在 bin/zsw.js。
 * - deps = { manager, ports }：manager 是主执行依赖；ports 承载非 manager
 *   端口（agents 的 agentResolver、models 的 modelRouter——D3 归属表，装配点
 *   从 manager 公开端口字段取，单一实例防漂移）。
 * - ctx 由入口组装：cwd 必带；targetSessionId 由 CLI 的 --target-session
 *   透传（高级用法）。
 */

const { PROVIDER_ID } = require('./model-router');

/** subagentId 必填校验（表内单源；消息与收口前 server.js 逐字一致）。 */
function requireSubagentId(params) {
  if (typeof params.subagentId !== 'string' || params.subagentId.trim() === '') {
    throw new Error('缺少必填参数 subagentId（start 返回的任务 id）。恢复指引：先用 list 查全部任务 id。');
  }
  return params.subagentId;
}

/**
 * agents action 的来源标签映射：core 发现面（lib/agent-discovery）在 profile
 * 上带 core 槽位标签（profile.source），此处映射为 zsw 面向用户的来源根标签
 * ——四根标签与旧版一致（project-zcode/project-agents/user-zcode/user-agents），
 * 新增 vendored 内置（core-vendored）与 pi 生态透传源（project-pi/npm-dev/
 * user-extension-paths，zsw 用户目录里通常缺席）。
 */
function agentSourceLabel(coreSource) {
  switch (coreSource) {
    case 'user-pi': return 'user-zcode';
    case 'user-agents': return 'user-agents';
    case 'npm': return 'core-vendored';
    case 'project-host': return 'project-zcode';
    case 'project-agents': return 'project-agents';
    default: return coreSource; // project-pi / npm-dev / user-extension-paths 等透传
  }
}

/**
 * agents action 的精简视图：只透出索引字段——name / description（截
 * 200，索引不是正文）/ when（「何时用我」提示，截 200）/ source（来源根
 * 标签）/ location（.md 绝对路径，D-4a 契约下 start 的 agent 参数唯一合法
 * 形态；file 为同值兼容字段，旧消费方与 lint 指引沿用）。body/model/
 * tools 等 profile 字段不透出：索引的价值在省 token，正文按 location
 * 路径按需读。list 是 async（core 发现链），调用侧 await。
 */
async function agentListView(resolver, cwd) {
  const agents = await resolver.list(cwd);
  return agents.map((p) => ({
    name: p.name,
    description: typeof p.description === 'string' ? p.description.slice(0, 200) : '',
    when: typeof p.when === 'string' ? p.when.slice(0, 200) : '',
    source: agentSourceLabel(p.source || ''),
    location: p.filePath,
    file: p.filePath, // 兼容旧字段名（D-4a 前 start 按名/路径双形态时的指引用）
  }));
}

/**
 * action 表。键序即「不支持的 action」报错的名单序（Object.keys 按插入序），
 * 与收口前 server.js 的 switch 分支序一致。
 */
const zsubActions = {
  start: {
    // params 原样透传（含入口组好的 wait 分叉值）；ctx 原样透传（两入口
    // 各自组装，见模块头注）
    exec: (params, ctx, deps) => deps.manager.start(params, ctx),
  },
  list: {
    exec: (params, ctx, deps) => deps.manager.list(),
  },
  status: {
    exec: (params, ctx, deps) => deps.manager.status(requireSubagentId(params)),
  },
  cancel: {
    exec: (params, ctx, deps) => deps.manager.cancel(requireSubagentId(params)),
  },
  message: {
    exec: (params, ctx, deps) => {
      const id = requireSubagentId(params);
      if (typeof params.text !== 'string' || params.text.trim() === '') {
        throw new Error('message 需要 text（非空字符串，续聊消息内容）。');
      }
      // 必须 await：manager.message 是 async，不 await 会把 Promise 序列化
      // 成 '{}'——socket/CLI 面拿不到 round/notify 句柄（R4）
      return deps.manager.message(id, params.text);
    },
  },
  close: {
    exec: (params, ctx, deps) => deps.manager.close(requireSubagentId(params)),
  },
  agents: {
    // 按需查询版 agent 索引：pi 的 <available_subagents> 每 turn 常驻
    // 注入在 zcode 平台做不到（进程内 extension API 才有），等价物是
    // 本 action——Z1 结论：MCP tool 常驻注入贵，按需查询零常驻成本。
    // W6a 起数据源 = core 发现面（lib/agent-discovery，async list——
    // vendored 内置 10 角色 + 四根 + 目录 symlink 展开）。
    exec: (params, ctx, deps) => {
      const resolver = deps.ports && deps.ports.agentResolver;
      if (!resolver || typeof resolver.list !== 'function') {
        throw new Error(
          'agents 需要 resolver 端口（agent .md 发现），当前 manager 未注入。'
          + '恢复指引：其他 action 不受影响；agents 排障查 lib/assemble.js 的 resolver 组装。'
        );
      }
      return agentListView(resolver, ctx.cwd);
    },
  },
  models: {
    // 模型清单按需查询（与 agents 同理：常驻注入贵，按需零成本）。
    // 模型集随 v2 config 变化（桌面端启停即变），description/skill 里
    // 硬编码模型名会过时——路由决策前先查本 action。modelRouter 经
    // deps.ports（装配点从 manager 公开端口字段取，单一实例防漂移）。
    exec: (params, ctx, deps) => {
      const router = deps.ports && deps.ports.modelRouter;
      if (!router || typeof router.listModels !== 'function') {
        throw new Error(
          'models 需要 modelRouter 端口（v2 config 模型清单），当前 manager 未注入。'
          + '恢复指引：其他 action 不受影响；models 排障查 lib/assemble.js 的 modelRouter 组装。'
        );
      }
      // --all（跨 provider 兜底链闭合）：默认 provider 不可用时模型路由
      // 仍可走其他带凭据 provider，但查询面此前只有默认 provider 视图，
      // 兜底链在「查」这一环断头。--all 出全 provider 视图；缺省行为
      // （默认 provider 单视图）完全不变，既有消费方零感知。
      // --all 数据源 = router.allProviders()（下沉后的单一实现，本入口
      // 零复制）；清单不可读的可操作错误直接 throw 上抛。
      if (params.all === true) {
        // allProviders 端口守卫（与 listModels 同口径）：换实现缺该方法时给
        // 可操作错误，而非 TypeError 崩溃（契约声明见 lib/ports.js ModelRouterPort）
        if (typeof router.allProviders !== 'function') {
          throw new Error(
            'models --all 需要 modelRouter 端口实现 allProviders()（跨 provider 模型清单），当前实现未提供。'
            + '恢复指引：缺省 models（不带 all）仍可查默认 provider 视图；排障查 lib/model-router.js 的 allProviders 与 lib/assemble.js 的 modelRouter 组装。'
          );
        }
        return {
          all: true,
          providers: router.allProviders(),
          guidance: '跨 provider 引用必须用全名 <provider>/<model> 传 model；default 标记 = 该 provider 的默认模型。',
        };
      }
      // listModels 抛的清单不可读错误是可操作错误（含恢复指引），原样上抛
      return {
        provider: PROVIDER_ID,
        models: router.listModels(),
        guidance: '选择指引：重量任务（设计/架构/深调研/复杂修复）省略 model 用默认（default 标记）；简单任务（探索/计数/格式转换/测试）传轻量模型短名降成本。',
      };
    },
  },
};

/**
 * 「不支持的 action」报错（表键自生成，D3）：文本与收口前 server.js 的
 * default 分支逐字一致——含 MCP 面时代措辞的尾句（socket 面无 inputSchema，
 * 文案修订不属于收口范围，零行为变化基准优先）。
 */
function unsupportedActionMessage(action) {
  return `不支持的 action "${String(action)}"。支持：${Object.keys(zsubActions).join(' | ')}。`
    + '恢复指引：action 必须取 usage 列出的枚举值。';
}

/**
 * 查表执行一个 zsub action（两入口共用入口函数）。
 * hasOwnProperty 守卫：防 action 撞 Object 原型链属性名（如 "constructor"）
 * 被误当表项命中——表键必须精确匹配。
 */
async function execZsubAction(action, params, ctx, deps) {
  const entry = Object.prototype.hasOwnProperty.call(zsubActions, action)
    ? zsubActions[action]
    : null;
  if (!entry) {
    throw new Error(unsupportedActionMessage(action));
  }
  return entry.exec(params, ctx, deps);
}

module.exports = {
  zsubActions,
  execZsubAction,
  unsupportedActionMessage,
};
