'use strict';
/**
 * RecordStorePort 实现：jsonl event sourcing（D9）。
 *
 * 为什么 append-only 事件流而不是可变 JSON：server 崩溃/重启后要能无损重建
 * 内存索引（rebuildFromLog），且多进程（CLI 与 MCP server 并存）下追加写
 * 是文件系统层面最不容易撕裂的形态。终态照抄、非终态标 lost（D9：死进程
 * 由调用方探活后再纠正）。
 *
 * 状态机：created → running → (idle → running)* → closed | cancelled | error | timeout
 * lost 为崩溃恢复标记：可从任何活跃态进入，也可被纠正回 running/idle 或转终态
 * （否则「探活后发现活着」就永远恢复不了，所以 lost 不设为硬终态）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { recordsPath } = require('./config');

/** 硬终态：无出边，rebuild 时照抄。 */
const TERMINAL_STATUSES = new Set(['closed', 'cancelled', 'error', 'timeout']);

/** 合法转移表。 */
const TRANSITIONS = {
  created: ['running', 'cancelled', 'error', 'timeout', 'lost'], // created 期取消/崩溃同样合法
  running: ['idle', 'closed', 'cancelled', 'error', 'timeout', 'lost'],
  idle: ['running', 'closed', 'cancelled', 'error', 'timeout', 'lost'],
  lost: ['running', 'idle', 'closed', 'cancelled', 'error', 'timeout'],
};

/**
 * MF-4 前置闸窗口：非终态 run 的最后事件落在近窗内 = 可能有对端 CLI 进程正
 * 持有执行体在写台账（2.0 compact 挂 assembleManager 收尾，任意 list/status
 * 都触发），此时 compact 的复查-rename 微窗内新 append 会被覆盖丢弃——跳过
 * 本次。窗口取 10 分钟：subagent 任务只在状态转移时写事件，长任务的最后事件
 * 可能远早于窗口（task 仍活着但静默），此时闸放行——残余风险由 D9② 双向
 * size 复查兜住（read→recheck 间 append 会让 size 变大而放弃）。纯「有 lost
 * 即跳过」不可行：CLI 一次性进程 rebuild 后非终态常态标 lost，会令 compact
 * 永不执行（caution 裁定）。
 */
const COMPACT_ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/** 行分组（由 compact 拆出）：created 按事件 subagentId，transition/update 按 id。 */
function groupLogLineGroups(lines) {
  const groups = new Map(); // key -> { idxs: number[], lastTs: number }
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (text.trim() === '') continue; // 尾部空串/空行：不属任何组，天然保留
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      continue; // 崩溃截断行：无法归属，保守保留
    }
    const key = event.subagentId || event.id;
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { idxs: [], lastTs: 0 };
      groups.set(key, g);
    }
    g.idxs.push(i);
    if (typeof event.ts === 'number') g.lastTs = event.ts;
  }
  return groups;
}

/**
 * 判态 + keep-N 选择（由 compact 拆出）：内存索引里的终态 run 参与 keep-N
 * 截断；活跃（含 lost）与孤儿组保留。records 即 store 的内存索引 this.records。
 * @returns {{dropKeys:Set<string>, keptRuns:number}}
 */
function selectTerminalDropKeys(groups, records, keep) {
  const terminal = [];
  for (const [key] of groups) {
    const rec = records.get(key);
    if (rec === undefined) continue; // 孤儿行组：保守保留
    if (TERMINAL_STATUSES.has(rec.status)) terminal.push(key);
  }
  // 最新在前（ts 降序；tie 用 key 保证确定性——同 ts 的删留不该取决于插入序）
  terminal.sort((a, b) => groups.get(b).lastTs - groups.get(a).lastTs
    || (a < b ? -1 : 1));
  const dropKeys = new Set(terminal.slice(keep)); // 超出 keep 的最旧终态 run
  const keptRuns = groups.size - dropKeys.size;
  return { dropKeys, keptRuns };
}

class RecordStore {
  /**
   * @param {object} [options]
   * @param {string} [options.filePath] 台账事件流文件显式注入（设计 E4 路径
   *   参数化：测试隔离 / record 归属另立项 zsw-manager-convergence 消费）。
   *   缺省回落 config.recordsPath()（ZSW_ROOT env → ~/.zcode/zsw/records.jsonl），
   *   解析逻辑与参数化前完全一致。
   */
  constructor(options = {}) {
    /**
     * 事件流文件路径（构造期解析一次。参数化前是 write/rebuild 调用时点解析，
     * 二者仅在「构造后运行中改 ZSW_ROOT」才分叉——全部既有调用点 env 均在
     * 构造前定死且生命周期内不变，实际行为等值）。
     * @type {string}
     */
    this.filePath = options.filePath || recordsPath();
    /** @type {Map<string, object>} subagentId -> record（内存索引） */
    this.records = new Map();
  }

  /**
   * 创建 record（初始事件，status 强制 'created'）。
   * @param {object} init  至少含 subagentId；其余字段对齐 ports.js record 注释
   */
  create(init) {
    if (!init || typeof init !== 'object' || !init.subagentId) {
      throw new Error('record-store: create 需要 { subagentId }');
    }
    if (this.records.has(init.subagentId)) {
      throw new Error(`record-store: record 已存在: ${init.subagentId}`);
    }
    const { subagentId, ...rest } = init;
    return this.append({ ts: Date.now(), type: 'created', subagentId, ...rest });
  }

  /**
   * 状态转移（CAS 语义）：当前状态不等于 from 即失败抛错，不写盘。
   * @param {object} [patch]  附加字段（closedReason/error/exec/sessionId/...）
   */
  transition(id, from, to, patch = {}) {
    if (!TRANSITIONS[from] || !TRANSITIONS[from].includes(to)) {
      throw new Error(`record-store: 非法转移 ${from} → ${to}`);
    }
    const { status, ts, type, ...rest } = patch; // patch 不得携带元字段
    return this.append({ ts: Date.now(), type: 'transition', id, from, to, ...rest });
  }

  /**
   * 非状态字段更新（sessionId/exec/patchFile/tokens 补充等）。
   * 改状态必须走 transition（CAS），update 携带 status 直接拒绝。
   */
  update(id, patch = {}) {
    if (patch.status !== undefined) {
      throw new Error('record-store: update 不允许改 status，请用 transition(id, from, to)');
    }
    const { ts, type, ...rest } = patch;
    return this.append({ ts: Date.now(), type: 'update', id, ...rest });
  }

  /**
   * 底层事件写入（ports 契约方法名）。事件形态 `{ts, type, ...}`：
   *   created     {ts, type:'created', subagentId, ...初始字段}
   *   transition  {ts, type:'transition', id, from, to, ...patch}
   *   update      {ts, type:'update', id, ...patch}
   * 校验失败抛错且不落盘；成功落盘并 fold 进内存索引，返回 record 副本。
   */
  append(event) {
    this.applyEvent(event, { strict: true });
    this.writeEvent(event);
    return this.clone(this.records.get(event.subagentId || event.id));
  }

  get(id) {
    const rec = this.records.get(id);
    return rec ? this.clone(rec) : null;
  }

  /**
   * @returns {object[]} 按 startedAt 倒序（最新在前）
   */
  list() {
    const arr = [...this.records.values()];
    arr.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return arr.map((r) => this.clone(r));
  }

  /**
   * 台账压缩（socket-record 收口 D8：keep-N 整 run 截断 + temp/rename 原子重写）。
   *
   * 删行后文件 = 原事件流的行子集，仍是完全合法的事件流——任何版本代码重放
   * 子集文件得到的就是索引子集（零新语法、零迁移，C1 裁决依据）：
   *   - 活跃态 run（status 非 TERMINAL_STATUSES，含 lost——可被探活纠正回）
   *     的行全部保留；终态 run 按组内最后事件 ts 降序取前 keep 个保留，
   *     其余整 run 删行；
   *   - 不在内存索引的行组（created 行损坏导致重放全 skipped 的孤儿行）
   *     保守保留：无法判态，删错 = 丢可能在跑的 run（占比极小，D8 显式裁决）；
   *   - 无法归属的行（空行/坏行/缺 id）同理保守保留。
   *
   * 调用前提：本方法依赖 this.records 判态（调用前应已 rebuildFromLog——
   * daemon 侧挂点在角色确定后调用，索引已建好）。并发防护（D9②）：读文件前
   * stat 记基准 size，rename 前复查原文件 size 不变——不等（并发 append 变大
   * 或他者 compact rename 缩小）即放弃本次（删 temp、stderr 留痕、返回
   * skipped:true），下次启动再试；残余微窗（复查与 rename 间的新 append）
   * 设计层面接受（D9③ 诚实声明）。
   *
   * @param {object} [opts]
   * @param {number} [opts.keep] 终态 run 保留上限（正整数；解析权威在
   *   config.resolveRecordKeep，本方法只做输入校验不回落——两处回落会漂移）
   * @returns {{removedRuns:number, removedLines:number, keptRuns:number, skipped?:boolean}}
   *   skipped=true 表示并发放弃（文件未动，全部 run 仍在文件与索引中）
   */
  compact({ keep } = {}) {
    const n = Number(keep);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`record-store: compact 需要 { keep: 正整数 }（收到 ${JSON.stringify(keep)}）。👉 keep 由 config.resolveRecordKeep() 解析后传入`);
    }
    let sizeBefore;
    let content;
    try {
      // 先 stat 后 read：stat..read 间的并发 append 会让复查变大而放弃（保守
      // 方向安全），不存在「读到更多却复查相等」的静默丢行窗口
      sizeBefore = fs.statSync(this.filePath).size;
      content = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return { removedRuns: 0, removedLines: 0, keptRuns: 0 }; // 无日志 = 首启空库
    }
    const lines = content.split('\n');
    const groups = groupLogLineGroups(lines);
    const { dropKeys, keptRuns } = selectTerminalDropKeys(groups, this.records, n);
    if (dropKeys.size === 0) {
      // 无可删（终态未超 keep——如大量 lost/孤儿在册）：不写 temp 不动文件
      return { removedRuns: 0, removedLines: 0, keptRuns };
    }
    // MF-4 前置闸：非终态 run（含 lost）近窗内有事件 = 可能有对端进程在写，
    // rename 覆盖丢新 append 的窗口被常态化放大——本次跳过（窗口语义见
    // COMPACT_ACTIVE_WINDOW_MS 头注）
    const now = Date.now();
    for (const [key, g] of groups) {
      const rec = this.records.get(key);
      if (rec === undefined) continue;
      if (!TERMINAL_STATUSES.has(rec.status) && g.lastTs > now - COMPACT_ACTIVE_WINDOW_MS) {
        process.stderr.write(
          `[zsub] record compact 跳过：非终态 run ${key} 近窗内有事件（疑似对端进程持有执行体），本次不动台账\n`,
        );
        return { removedRuns: 0, removedLines: 0, keptRuns: groups.size, skipped: true };
      }
    }
    let removedLines = 0;
    const dropIdx = new Set();
    for (const key of dropKeys) {
      for (const i of groups.get(key).idxs) {
        dropIdx.add(i);
        removedLines++;
      }
    }
    // 剩余行按原文件顺序写 temp（同目录保证同文件系统 rename 原子；pid 后缀
    // 防多进程 temp 互踩）→ size 复查 → 原子替换
    const tmp = `${this.filePath}.compact-${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.filter((_, i) => !dropIdx.has(i)).join('\n'));
    let sizeNow = -1;
    try {
      sizeNow = fs.statSync(this.filePath).size;
    } catch { /* 原文件消失按已变更处理，走放弃路径 */ }
    if (sizeNow !== sizeBefore) {
      try {
        fs.unlinkSync(tmp);
      } catch { /* ENOENT = 已清理 */ }
      process.stderr.write(
        `[zsub] record compact 放弃：台账文件在读取后被并发变更（size ${sizeBefore} → ${sizeNow}），`
        + '已清理临时文件，本次不替换，下次启动再试\n',
      );
      return { removedRuns: 0, removedLines: 0, keptRuns: groups.size, skipped: true };
    }
    fs.renameSync(tmp, this.filePath);
    // 内存索引同步收缩（被删 run 不再可见——与文件一致；重放等价性见 P-compact-equiv）
    for (const key of dropKeys) this.records.delete(key);
    return { removedRuns: dropKeys.size, removedLines, keptRuns };
  }

  /**
   * 从 jsonl 重放重建内存索引（server 重启入口）。
   * 终态照抄；非终态（created/running/idle）标 lost 交由调用方探活纠正。
   * lost 标记只改内存不落盘：日志是权威，下次重启会重新推断，幂等收敛。
   * 脏数据防御：坏行 / 引用不存在 record 的事件 / CAS 不匹配的 transition
   * 一律跳过并计入 skipped（append-only 日志尾部可能因崩溃截断，不能让
   * 一行坏数据炸掉整个恢复）。
   * @returns {{applied:number, skipped:number, records:number}}
   */
  rebuildFromLog() {
    this.records = new Map();
    let applied = 0;
    let skipped = 0;
    let content = '';
    try {
      content = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return { applied: 0, skipped: 0, records: 0 }; // 无日志 = 首启空库
    }
    for (const line of content.split('\n')) {
      if (line.trim() === '') continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        skipped++; // 尾部截断行
        continue;
      }
      if (this.applyEvent(event, { strict: false })) applied++;
      else skipped++;
    }
    for (const rec of this.records.values()) {
      if (!TERMINAL_STATUSES.has(rec.status) && rec.status !== 'lost') {
        // MF-5：误标前的真实态留内存标记（不落盘）——manager 的 cancel/close
        // 守卫据此区分「lost 来自 idle（轮间无进程，可本地终态化）」与
        // 「lost 来自 running/created（执行体可能在别的 CLI 进程，须拒）」
        rec._lostFrom = rec.status;
        rec.status = 'lost';
      }
    }
    return { applied, skipped, records: this.records.size };
  }

  /**
   * 事件 fold。strict=true（运行时）非法即抛错；strict=false（rebuild）
   * 返回 false 由调用方计数跳过。
   */
  applyEvent(event, { strict } = { strict: false }) {
    const bad = (msg) => {
      if (strict) throw new Error(`record-store: ${msg}`);
      return false;
    };
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      return bad('事件缺少 type');
    }
    switch (event.type) {
      case 'created': {
        if (!event.subagentId) return bad('created 事件缺少 subagentId');
        if (this.records.has(event.subagentId)) return bad(`record 已存在: ${event.subagentId}`);
        const { ts, type, ...rest } = event;
        rest.status = 'created';
        rest.startedAt = rest.startedAt ?? ts;
        this.records.set(rest.subagentId, rest);
        return true;
      }
      case 'transition': {
        const rec = this.records.get(event.id);
        if (!rec) return bad(`transition 引用不存在的 record: ${event.id}`);
        if (rec.status !== event.from) return bad(`CAS 失败: 期望 ${event.from} 实际 ${rec.status}`);
        if (!TRANSITIONS[event.from] || !TRANSITIONS[event.from].includes(event.to)) {
          return bad(`非法转移 ${event.from} → ${event.to}`);
        }
        const { ts, type, id, from, to, ...patch } = event;
        Object.assign(rec, patch);
        rec.status = to;
        // 硬终态补结束时间（lost 不算——它可能被探活纠正回来）
        if (TERMINAL_STATUSES.has(to) && !rec.endedAt) rec.endedAt = ts;
        return true;
      }
      case 'update': {
        const rec = this.records.get(event.id);
        if (!rec) return bad(`update 引用不存在的 record: ${event.id}`);
        const { ts, type, id, status, ...patch } = event;
        if (status !== undefined) return bad('update 事件不允许携带 status（请用 transition）');
        Object.assign(rec, patch);
        return true;
      }
      default:
        return bad(`未知事件类型: ${event.type}`);
    }
  }

  /** 事件追加落盘。先建目录再 append：首启时 zsub 根（或注入路径父目录）还不存在。 */
  writeEvent(event) {
    const file = this.filePath;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  }

  /** 副本隔离：get/list 返回值被调用方修改不得污染内存索引。 */
  clone(rec) {
    return rec ? { ...rec } : null;
  }
}

// TRANSITIONS 不导出（无外部消费者）：合法转移校验只在事件 fold 路径内部使用
module.exports = { RecordStore, TERMINAL_STATUSES };
