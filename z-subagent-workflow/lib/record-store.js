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

class RecordStore {
  constructor() {
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
   * @param {object} [filter] { status?, slug? }
   * @returns {object[]} 按 startedAt 倒序（最新在前）
   */
  list(filter = {}) {
    let arr = [...this.records.values()];
    if (filter.status !== undefined && filter.status !== null) {
      arr = arr.filter((r) => r.status === filter.status);
    }
    if (filter.slug !== undefined && filter.slug !== null) {
      arr = arr.filter((r) => r.slug === filter.slug);
    }
    arr.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return arr.map((r) => this.clone(r));
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
      content = fs.readFileSync(recordsPath(), 'utf8');
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
      if (!TERMINAL_STATUSES.has(rec.status) && rec.status !== 'lost') rec.status = 'lost';
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

  /** 事件追加落盘。先建目录再 append：首启时 zsub 根还不存在。 */
  writeEvent(event) {
    const file = recordsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  }

  /** 副本隔离：get/list 返回值被调用方修改不得污染内存索引。 */
  clone(rec) {
    return rec ? { ...rec } : null;
  }
}

module.exports = { RecordStore, TRANSITIONS, TERMINAL_STATUSES };
