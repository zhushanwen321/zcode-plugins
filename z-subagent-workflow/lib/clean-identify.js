'use strict';
/**
 * 会话残留识别基座（u1 交付；u2 将在本文件扩展五类目标分治 / 污染哨兵 /
 * 索引冲突预检 / 目录分布红灯，设计 docs/design/zsw-session-residue-cleanup-design.md
 * §3.3 D1）。
 *
 * u1 范围 = 两块基座，供 lib/doctor.js 体检计数与 u2 分治复用：
 *   1. C6 白名单构造式解析（parseRecordWhiteList）
 *   2. 特征目录表闭集常量与匹配（matchFeatureDirectory）
 *
 * 零依赖 plain Node CJS；本模块无副作用（不触库、不触文件系统——文件读取
 * 由调用方传路径，测试可注入 fixture 路径）。
 */

/**
 * C6 白名单构造式（设计 §2.4 C6）：解析 records.jsonl，深度递归收集每一层
 * JSON 值中键名**恰为** "sessionId" 的字符串值（含嵌套对象/数组内的层，如
 * exec.sessionId / sessionRef.sessionId），仅此一类键。
 *
 * 为什么严禁收 "targetSessionId"（C6-被否，设计 §2.4）：targetSessionId 是
 * zsw 调用方的宿主会话 = 用户真实会话（manager.js 头注「ctx.targetSessionId
 * 取自 _meta」即通知投递目标）。R2 实测并入后白名单∩库虚增，其中 7 个用户
 * 会话会被直接误删——G2「零误删」被系统性击穿。键名精确相等天然排除
 * targetSessionId / 其他 *SessionId 变体；非字符串值（数字/对象）不收。
 *
 * 另一个构造式边界（同样不入式）：records 的 outputs/ 目录名是 sa- run id
 * 不是 session id，不参与收集。
 *
 * 口径纪律（C6）：白名单总数 ≠ 白名单∩引擎库——两个口径必须分离计数
 * （doctor 报双口径；u2 分治消费 ∩ 库子集）。
 *
 * @param {string} recordsPath records.jsonl 绝对路径（lib/config.js recordsPath()）
 * @returns {Set<string>} 去重后的 sessionId 值集合。文件不存在（zsw 从未运行）
 *   返回空集——白名单恒空 = 不识别任何会话 = 不误删，保守正确，不抛错。
 */
function parseRecordWhiteList(recordsPath) {
  const out = new Set();
  let raw;
  try {
    raw = require('node:fs').readFileSync(recordsPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return out;
    throw e;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // 坏行跳过：records 是 append-only 事件流，尾部可能有不完整行
    }
    collectSessionIdValues(obj, out);
  }
  return out;
}

/** 深度递归收集：对象与数组逐层下钻，键名恰为 "sessionId" 且值为非空字符串才收。 */
function collectSessionIdValues(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectSessionIdValues(item, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'sessionId' && typeof value === 'string' && value !== '') out.add(value);
    collectSessionIdValues(value, out);
  }
}

/**
 * 特征目录表（设计 §3.3 D1③，消解 C7 白名单盲区——e2e/探针执行路径不写
 * records，其会话 directory 落在 zsw 自测试/探针目录下）。
 *
 * **闭集清单**：新增条目必须附来源注释（出处文件:行或人工确认记录）；
 * **禁止子串模糊匹配**——路径段/整串语义防止误伤目录名恰好含特征片段的
 * 真实项目（如 /home/u/my-zsub-e2e-notes）。此类目录只会被 zsw 测试代码/
 * 探针创建，真实用户项目不可能位于 OS 临时目录的该前缀下。
 */

/** 路径段匹配前缀：directory 按 `/` 分段后存在以此开头的段即命中。
 *  来源：test/e2e.test.js:39 `fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-e2e-'))`
 *  （mkdtemp 后缀随机，天然覆盖其下 e1-proj / zsw-root / wt-* 子路径）。 */
const FEATURE_DIRECTORY_SEGMENT_PREFIX = 'zsub-e2e-';

/** 整串匹配清单（directory 与条目完全相等才命中）。
 *  来源：设计 §2.4 C7——分析期探针目录，人工确认（2026-09-05 二轮分析）。 */
const FEATURE_DIRECTORY_EXACT = Object.freeze([
  '/tmp/zsw-sidebar-probe',
  '/tmp/pz2-work',
]);

/**
 * 特征目录匹配（D1③）：整串相等，或按 `/` 分段后存在以
 * FEATURE_DIRECTORY_SEGMENT_PREFIX 开头的段。不做子串模糊匹配。
 * @param {string} directory 引擎库 session.directory
 * @returns {boolean}
 */
function matchFeatureDirectory(directory) {
  if (typeof directory !== 'string' || directory === '') return false;
  if (FEATURE_DIRECTORY_EXACT.includes(directory)) return true;
  return directory.split('/').some((seg) => seg.startsWith(FEATURE_DIRECTORY_SEGMENT_PREFIX));
}

module.exports = {
  parseRecordWhiteList,
  FEATURE_DIRECTORY_SEGMENT_PREFIX,
  FEATURE_DIRECTORY_EXACT,
  matchFeatureDirectory,
};
