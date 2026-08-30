'use strict';
/**
 * AgentResolverPort 实现：agent .md 四根发现（D6，解决 F5 生态分裂）。
 *
 * 为什么自己扫描而不用引擎的 agent 发现机制：引擎只认 .zcode/agents 双根，
 * 且扫描时跳过 symlink——pi 生态（~/.agents/agents/ 及项目内 symlink 指向
 * 个人技能库）在 zcode 完全不可见。所以这里手工 readdir + realpathSync
 * 递归，显式 follow symlink，这是本模块存在的理由之一。
 *
 * 四根优先级（project > user，同级 .agents > .zcode）：
 *   1. <cwd>/.agents/agents/
 *   2. <cwd>/.zcode/agents/
 *   3. <homeDir>/.agents/agents/     （homeDir 默认 os.homedir()，可注入以便测试）
 *   4. <homeDir>/.zcode/agents/
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 深度上限：realpath 去重已防环，这是防御嵌套链拼接导致的栈深失控的双保险。 */
const MAX_DEPTH = 16;

/** 手写 frontmatter mini 解析的消费字段白名单（其余字段忽略，避免污染 profile）。 */
const CONSUMED_KEYS = new Set([
  'name', 'description', 'when', 'model', 'tools', 'disallowedTools', 'skills', 'maxTurns',
]);

class AgentMdResolver {
  /**
   * @param {object} [opts]
   * @param {string} [opts.homeDir]  user 级根的 HOME 基准（默认 os.homedir()；测试注入临时目录）
   */
  constructor(opts = {}) {
    this.homeDir = opts.homeDir || os.homedir();
  }

  /** 四根路径，优先级降序。 */
  roots(cwd) {
    return [
      path.join(cwd, '.agents', 'agents'),
      path.join(cwd, '.zcode', 'agents'),
      path.join(this.homeDir, '.agents', 'agents'),
      path.join(this.homeDir, '.zcode', 'agents'),
    ];
  }

  /**
   * 四根扫描全部 agent。同名（frontmatter name，缺省文件名）高优先级根胜出。
   * @returns {import('./ports').AgentProfile[]}
   */
  list(cwd) {
    const byName = new Map();
    for (const root of this.roots(cwd)) {
      for (const file of this.scanRoot(root)) {
        const profile = this.parseFile(file);
        if (!profile) continue;
        if (byName.has(profile.name)) continue; // 低优先级根的同名 agent 让位
        byName.set(profile.name, profile);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 按名字或路径解析单个 agent。
   * 路径形态（绝对路径 / ./ ../ 前缀）直接读文件；名字形态走四根 list 精确匹配。
   * @returns {import('./ports').AgentProfile | null}
   */
  resolve(nameOrPath, cwd) {
    if (!nameOrPath || typeof nameOrPath !== 'string') return null;
    const isPath = path.isAbsolute(nameOrPath)
      || nameOrPath.startsWith('./') || nameOrPath.startsWith('../');
    if (isPath) {
      return this.parseFile(path.resolve(cwd, nameOrPath));
    }
    const want = nameOrPath.replace(/\.md$/, '');
    const hit = this.list(cwd).find((p) => p.name === want);
    if (hit) return hit;
    // 兜底：带子目录的相对名（如 agents/reviewer.md）按路径再试一次，不存在则 null
    return this.parseFile(path.resolve(cwd, nameOrPath));
  }

  /** 读单个文件并解析；不可读/不是文件返回 null。 */
  parseFile(absPath) {
    let text;
    try {
      if (!fs.statSync(absPath).isFile()) return null; // symlink 由 stat 跟随，目录不是 agent
      text = fs.readFileSync(absPath, 'utf8');
    } catch {
      return null;
    }
    return parseAgentMd(text, absPath);
  }

  /**
   * 递归收集一个根下的全部 *.md（follow symlink）。
   * 按 realpath 去重：既防 symlink 环（A/link→A 再次进入即跳过），
   * 也防同一真实文件经多个链接路径被重复收集。
   * 返回排序后的路径，保证扫描结果确定性（readdir 顺序平台相关）。
   */
  scanRoot(rootDir) {
    const files = [];
    const seenReal = new Set();
    const walk = (dir, depth) => {
      if (depth > MAX_DEPTH) return;
      let realDir;
      try {
        realDir = fs.realpathSync(dir);
      } catch {
        return; // 根不存在 / broken link = 该分支为空
      }
      if (seenReal.has(realDir)) return; // 环或重复目录：剪枝
      seenReal.add(realDir);
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        // 依赖目录不是 agent 定义的家（真机实测 ~/.zcode/agents 下有 node_modules，
        // 递归扫会把依赖包的 README/changelog 灌进 agents 清单）
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        const full = path.join(dir, ent.name);
        let real;
        try {
          real = fs.realpathSync(full);
        } catch {
          continue; // broken symlink：跳过不报错（用户目录里坏链不该炸掉发现）
        }
        if (seenReal.has(real)) continue;
        let isDir = ent.isDirectory();
        let isFile = ent.isFile();
        if (ent.isSymbolicLink()) {
          // 关键差异点：引擎扫描跳过 symlink，这里显式 follow（stat 经 real 跟随链接）
          try {
            const st = fs.statSync(real);
            isDir = st.isDirectory();
            isFile = st.isFile();
          } catch {
            continue;
          }
        }
        if (isDir) {
          walk(full, depth + 1);
        } else if (isFile && ent.name.endsWith('.md')) {
          seenReal.add(real);
          files.push(full);
        }
      }
    };
    walk(rootDir, 0);
    files.sort();
    return files;
  }
}

/**
 * 解析 agent .md：frontmatter 围栏提取 + 白名单字段规范化。
 * 无 frontmatter / 围栏未闭合：整个文本当 body，name 取文件名（宽容，不抛错）。
 */
function parseAgentMd(text, filePath) {
  let fm = {};
  let body = text;
  const lines = text.split(/\r?\n/);
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { end = i; break; }
    }
    if (end > 0) {
      fm = parseFrontmatter(lines.slice(1, end));
      body = lines.slice(end + 1).join('\n');
    }
  }
  return toProfile(fm, filePath, body);
}

/**
 * 手写 frontmatter mini 解析（不引依赖）：
 *   key: value           标量（去首尾引号）
 *   key: [a, b]          行内数组
 *   key:                 后跟缩进块
 *   - item               上一个 key 的行数组元素
 * 不支持嵌套对象——消费字段全部是标量/字符串数组，够用。
 */
function parseFrontmatter(lines) {
  const fm = Object.create(null);
  let lastKey = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue; // 空行与 # 注释
    const listItem = line.match(/^-\s+(.*)$/);
    if (listItem && lastKey) {
      if (!Array.isArray(fm[lastKey])) fm[lastKey] = [];
      fm[lastKey].push(scalar(listItem[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue; // 无法识别的行忽略（如嵌套对象，白名单外本就不消费）
    const key = kv[1];
    const val = kv[2].trim();
    lastKey = key;
    fm[key] = val === '' ? [] : scalar(val); // 空值占位空数组，等待后续 - item 行填充
  }
  return fm;
}

/** 标量解析：行内数组 → string[]，其余去引号字符串。 */
function scalar(v) {
  const t = v.trim();
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => stripQuotes(s.trim())).filter((s) => s !== '');
  }
  return stripQuotes(t);
}

function stripQuotes(s) {
  if (s.length >= 2
    && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** frontmatter 原始值 → AgentProfile 消费字段（类型不匹配的字段丢弃，不抛错）。 */
function toProfile(fm, filePath, body) {
  const fileName = path.basename(filePath, '.md');
  const profile = {
    name: pickStr(fm.name) || fileName, // name/description 缺失时 name 取文件名
    description: pickStr(fm.description) || '',
    filePath,
    body,
  };
  const model = pickStr(fm.model);
  if (model) profile.model = model;
  // engine（回接 2c）：core 路由三层优先级的 frontmatter 层——runner-core 经
  // taskCtx.agentEngine 透传给 routeEngine；未注册 id 在路由期报 engine_not_found
  //（含已注册清单与来源定位），解析期不做注册表校验（resolver 不感知引擎表）
  const engine = pickStr(fm.engine);
  if (engine) profile.engine = engine;
  // when（何时用我）：索引提示字段，pi 的 available_subagents 索引含此字段——
  // 主 agent 挑 agent 时比 description 更直接命中场景
  const when = pickStr(fm.when);
  if (when) profile.when = when;
  for (const key of ['tools', 'disallowedTools', 'skills']) {
    const arr = pickStrArr(fm[key]);
    if (arr) profile[key] = arr;
  }
  const maxTurns = pickInt(fm.maxTurns); // 数值化：'25' / 25 → 25，非法丢弃
  if (maxTurns !== null) profile.maxTurns = maxTurns;
  return profile;
}

function pickStr(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function pickStrArr(v) {
  if (!Array.isArray(v)) return null;
  const arr = v.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  return arr.length ? arr : null;
}

function pickInt(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** 顶层函数 = 端口默认实现（真实 HOME）；类导出供测试注入 homeDir。 */
const defaultResolver = new AgentMdResolver();

module.exports = {
  AgentMdResolver,
  list: (cwd) => defaultResolver.list(cwd),
  resolve: (nameOrPath, cwd) => defaultResolver.resolve(nameOrPath, cwd),
  parseAgentMd, // 导出供单测直接验证解析逻辑
};
