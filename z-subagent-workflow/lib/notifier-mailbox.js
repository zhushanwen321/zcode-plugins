'use strict';

/**
 * NotifierPort 双实现（DESIGN-v3.md §3.2 D4）：mailbox 完成回流 + polling 兜底。
 *
 * 平台事实（Z8，zcode.cjs 逆向实证，锚点 NodeSessionMailboxAdapter / Z9r）：
 *   - 引擎 drain 只认 .json 后缀，按文件名字典序取前 20 条，
 *     逐文件「先 parse 校验再 rename 到 read/」；
 *   - 任一文件非法 → 本轮 drain 中断，坏文件永久阻塞排序在后的消息（无 quarantine）；
 *   - envelope 校验为 version !== 1（数字严格相等）+ messageId/fromSessionId/
 *     toSessionId/content/createdAt 五字段 typeof === 'string'；
 *   - 投递根 = mailboxRoot() 下 <toSessionId>/unread/，toSessionId 须匹配
 *     /^sess_[A-Za-z0-9._-]+$/（drain 侧 sessionDir 以此做目录名校验与路径逃逸防护）。
 *
 * Z8 硬规范四条与各自防的事故：
 *
 * 1. tmp+rename 原子落位 —— 防「半截文件毒化 drain」。drain 是「先 parse 后
 *    rename」，若边写 .json 边被引擎读走，截断 JSON 会 parse 失败成为坏文件，
 *    永久阻塞该会话后续所有消息且无法自愈（无 quarantine）。先写 .json.tmp 再
 *    rename：drain 的 .json 过滤器天然忽略 .tmp，rename 在同一目录内原子完成，
 *    引擎任何时刻看到的 .json 都是完整文件。
 *
 * 2. envelope 写前自检 —— 防「投出毒文件」（不可逆事故在写之前拦截）。坏文件
 *    一旦落盘没有自动清除机制，所以把引擎同款校验复制到写之前：version 必须
 *    是数字 1（引擎判 !== 1，字符串 "1" 同样是毒文件，这是与任务书「六字段全
 *    string」表述的关键差异，以引擎源码为准）；其余五字段必须 string。自检不
 *    过直接抛错，一个字节都不落盘（连 .tmp 都不产生，也不建目录），让调用方
 *    在造成不可逆后果前看到可操作的错误。
 *
 * 3. 文件名单调前缀 <epochMs>-<seq>-<subagentId>.json —— 防「乱序 / 挤窗」。
 *    drain 按文件名字典序取前 20 条注入，同一会话连投多条时若字典序 ≠ 投递
 *    序，早完成的消息可能被 20 条窗口挤掉或乱序回流。epochMs（13 位定宽）+
 *    seq（6 位零填充定宽）双定宽保证字典序 = (时间, 序号) 序——seq 不定宽时
 *    「-9-」字典序在「-10-」之后，第 10 条起顺序即被破坏；seq 用进程内单调
 *    计数器而非随机后缀，同毫秒连投也能保持稳定顺序。
 *
 * 4. sweepStaleTmp 启动清扫 —— 防「崩溃残留无限累积」。进程在 write tmp 与
 *    rename 之间崩溃会留下 .tmp 残留：drain 不读它们（无害），但会持续堆积，
 *    且其中任务结果已丢失投递。启动时按 <digits>-<digits>-<id>.json.tmp 模式
 *    清扫己方残留，让「投递中途崩溃」保持可观测而不是被垃圾掩盖。
 */

const fs = require('node:fs');
const path = require('node:path');
const { mailboxRoot, outputsDir } = require('./config');

/** 引擎同款会话 id 校验（zcode.cjs zti）：drain 侧 sessionDir 对目录名强制此格式 */
const SESSION_ID_RE = /^sess_[A-Za-z0-9._-]+$/;

/** 己方投递残留识别：与本类生成的文件名格式一一对应（见头注规范 3/4） */
const OWN_TMP_RE = /^\d+-\d+-.+\.json\.tmp$/;

/** seq 零填充宽度：定宽是「字典序 = 时间序」的前提（见头注规范 3） */
const SEQ_WIDTH = 6;

/**
 * envelope 写前自检（Z8 规范 2）：逐字段复刻引擎校验，失败抛可操作错误。
 * 必须在任何 mkdir/write 之前调用，保证拒绝落盘时零文件系统副作用。
 */
function assertEnvelopeLike(e) {
  const bad = [];
  if (e.version !== 1) bad.push('version 必须是数字 1（引擎判 !==1，字符串 "1" 是毒文件）');
  for (const k of ['messageId', 'fromSessionId', 'toSessionId', 'content', 'createdAt']) {
    if (typeof e[k] !== 'string') {
      bad.push(`${k} 必须是 string（实际 ${e[k] === null ? 'null' : typeof e[k]}）`);
    }
  }
  if (bad.length > 0) {
    throw new Error(
      `mailbox envelope 自检失败: ${bad.join('; ')}。`
      + '引擎 drain 对坏文件零容忍（会永久阻塞该会话排序在后的消息），已拒绝落盘；'
      + '请检查 notifyCompletion 调用方传入的 summaryText 与 record 字段类型后重试'
    );
  }
}

class MailboxNotifier {
  constructor() {
    this._seq = 0;
    this._lastMs = 0;
  }

  capabilities() {
    return { mode: 'mailbox', wakeIdle: false, requiresEnv: 'ZCODE_MESSAGE_ENABLED=1' };
  }

  /**
   * 完成通知原子投递到 <mailboxRoot>/<target>/unread/。
   * - target 缺失/非法：不抛错，返回 {delivered:false}，由调用方按 polling 指引兜底
   *   （这与 envelope 自检的「抛错」不同：target 缺失是运行期常态，如非 MCP 入口启动）；
   * - envelope 非法：抛错——这是编程 bug，必须在写盘前暴露（头注规范 2）。
   * @returns {Promise<{delivered:boolean, target?:string, filePath?:string}>}
   */
  async notifyCompletion(record, summaryText) {
    const target = record && record.targetSessionId;
    if (typeof target !== 'string' || !SESSION_ID_RE.test(target)) {
      return { delivered: false };
    }

    const seq = String(++this._seq).padStart(SEQ_WIDTH, '0');
    // 时钟回拨防护：epochMs 只增不减，维持 (epochMs, seq) 字典序单调（头注规范 3）
    const ms = Math.max(Date.now(), this._lastMs);
    this._lastMs = ms;

    const envelope = {
      version: 1,
      messageId: `zsub-${record.subagentId}-${seq}`,
      // from 取 target 同值：drain 只对六字段做类型校验，fromSessionId 语义宽松；
      // 填 'zsub-manager' 这类非 sess_ 值虽能过 drain，但在引擎其他消费路径上属
      // 未验证行为。与 target 同值落在已验证安全域（同会话内投递），语义上即
      // 「该会话派生的 subagent 完成回流」。
      fromSessionId: target,
      toSessionId: target,
      content: summaryText,
      createdAt: new Date().toISOString(),
    };
    assertEnvelopeLike(envelope); // 先于一切 mkdir/write（头注规范 2）

    const dir = path.join(mailboxRoot(), target, 'unread');
    fs.mkdirSync(dir, { recursive: true });
    const finalName = `${ms}-${seq}-${record.subagentId}.json`;
    const tmpPath = path.join(dir, `${finalName}.tmp`);
    const finalPath = path.join(dir, finalName);
    // 同步写+改名：进程内调用序 = 落盘序，不给 async 回调交错留窗口；
    // .tmp 与终名同目录，rename 不跨文件系统，原子性有保证（头注规范 1）
    fs.writeFileSync(tmpPath, JSON.stringify(envelope), 'utf8');
    fs.renameSync(tmpPath, finalPath);
    return { delivered: true, target, filePath: finalPath };
  }

  /**
   * 启动清扫己方 .tmp 残留（Z8 规范 4）。扫描 <mailboxRoot>/<*>/unread/ 下
   * 符合己方文件名模式的 .tmp（write 与 rename 之间崩溃的残留）。
   * 由 server 启动接线调用（本类不在构造时自动删文件，避免构造函数藏副作用）。
   * @returns {number} 删除数（供启动日志观测）
   */
  sweepStaleTmp() {
    const root = mailboxRoot();
    if (!fs.existsSync(root)) return 0;
    let removed = 0;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const unread = path.join(root, entry.name, 'unread');
      // 目录可能尚未创建（该会话从未收到投递）；existsSync 防 statSync 抛错
      if (!fs.existsSync(unread) || !fs.statSync(unread).isDirectory()) continue;
      for (const f of fs.readdirSync(unread)) {
        if (OWN_TMP_RE.test(f)) {
          fs.rmSync(path.join(unread, f), { force: true });
          removed += 1;
        }
      }
    }
    return removed;
  }
}

class PollingNotifier {
  capabilities() {
    return { mode: 'polling', wakeIdle: false };
  }

  /**
   * 兜底档不投递：不写任何文件，只声明「结果需主动查询」。
   * @returns {Promise<{delivered:false, guidance:'poll via list'}>}
   */
  async notifyCompletion() {
    return { delivered: false, guidance: 'poll via list' };
  }

  /**
   * 返回给主 agent 的轮询指引：mailbox 未启用（ZCODE_MESSAGE_ENABLED != 1）时
   * 完成通知不可达（外部进程不能投 task-notification，Z5），必须明确告诉主
   * agent 如何把结果拿回来，否则后台任务的结果会静默丢失。
   */
  pollingGuidance(subagentId) {
    const outputFile = path.join(outputsDir(), `${subagentId}.md`);
    return [
      `zsub 后台任务 ${subagentId} 已完成，但 mailbox 通知通道未启用，结果不会自动回流本会话。`,
      `查询状态：zsub(action="status", subagentId="${subagentId}")——任务完成后 status 会变为 closed。`,
      `读取结果：closed 后 result 全文落在 outputs 文件（默认 ${outputFile}，status 返回中带该路径），用 Read 工具读取即可。`,
    ].join('\n');
  }
}

module.exports = { MailboxNotifier, PollingNotifier };
