'use strict';

/**
 * notify 层单测（DESIGN-v3 §3.2 D4；e2e H3/H10 的单元层前置）。
 *
 * 隔离方式：mailbox 根用 ZCODE_MAILBOX_ROOT 指向临时目录（config.js 的
 * mailboxRoot() 每次调用动态读 env，与引擎 drain 同一解析规则）。
 * 注意：任务书写的 ZSW_MAILBOX_ROOT 是笔误——config.js 实际读的是
 * ZCODE_MAILBOX_ROOT（对齐引擎 env 名），本测试按实现现状使用。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MailboxNotifier, PollingNotifier } = require('../lib/notifier-mailbox');

/** 建临时 mailbox 根并接管 env；测试结束恢复 env + 删临时目录 */
function useTempMailbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsub-notify-'));
  const prev = process.env.ZCODE_MAILBOX_ROOT;
  process.env.ZCODE_MAILBOX_ROOT = root;
  t.after(() => {
    if (prev === undefined) delete process.env.ZCODE_MAILBOX_ROOT;
    else process.env.ZCODE_MAILBOX_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** 递归列出 root 下所有文件（相对路径），用于「零文件写入」断言 */
function listAllFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else out.push(path.relative(root, path.join(dir, e.name)));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

const HOST_SESSION = 'sess_host-a1.b2_c3'; // 覆盖正则允许的全部字符类

test('模块导出与方法名对齐 ports.js NotifierPort 契约', () => {
  assert.strictEqual(typeof MailboxNotifier, 'function');
  assert.strictEqual(typeof PollingNotifier, 'function');
  const mb = new MailboxNotifier();
  const pl = new PollingNotifier();
  assert.strictEqual(typeof mb.notifyCompletion, 'function');
  assert.strictEqual(typeof mb.capabilities, 'function');
  assert.strictEqual(typeof pl.notifyCompletion, 'function');
  assert.strictEqual(typeof pl.capabilities, 'function');
  assert.deepStrictEqual(mb.capabilities(), {
    mode: 'mailbox', wakeIdle: false, requiresEnv: 'ZCODE_MESSAGE_ENABLED=1',
  });
  assert.deepStrictEqual(pl.capabilities(), { mode: 'polling', wakeIdle: false });
});

test('成功投递：原子落 unread/、envelope 六字段合法、无 .tmp 残留、内容含 summary', async (t) => {
  const root = useTempMailbox(t);
  const n = new MailboxNotifier();
  const record = { subagentId: 'sa-abc123', targetSessionId: HOST_SESSION };

  const res = await n.notifyCompletion(record, '任务完成：结果见 outputs/sa-abc123.md');

  assert.strictEqual(res.delivered, true);
  assert.strictEqual(res.target, HOST_SESSION);
  const unread = path.join(root, HOST_SESSION, 'unread');
  const files = fs.readdirSync(unread);
  assert.strictEqual(files.length, 1, '只落一个文件');
  assert.ok(files[0].endsWith('.json'), '终名是 .json（drain 只认 .json）');
  assert.strictEqual(path.join(unread, files[0]), res.filePath, '返回路径与落盘一致');

  // Z8 规范 1：tmp+rename，不留 .tmp 残留
  assert.strictEqual(files.filter((f) => f.endsWith('.tmp')).length, 0, '无 .tmp 残留');

  // Z8 规范 2 的引擎侧事实：version 是数字 1 + 五字段全 string
  const env = JSON.parse(fs.readFileSync(res.filePath, 'utf8'));
  assert.strictEqual(env.version, 1);
  assert.strictEqual(typeof env.messageId, 'string');
  assert.strictEqual(typeof env.fromSessionId, 'string');
  assert.strictEqual(typeof env.toSessionId, 'string');
  assert.strictEqual(typeof env.createdAt, 'string');
  assert.strictEqual(env.toSessionId, HOST_SESSION, '投递目标 = targetSessionId');
  assert.strictEqual(env.fromSessionId, HOST_SESSION, 'from 取 target 同值（安全域取舍）');
  assert.ok(env.messageId.startsWith('zsub-sa-abc123-'), 'messageId 含 subagentId 前缀');
  assert.ok(!Number.isNaN(Date.parse(env.createdAt)), 'createdAt 是可解析的 ISO 时间');
  assert.ok(env.content.includes('任务完成'), 'content 透传 summaryText');
});

test('文件名字典序 = 投递序（同实例连投 3 条，含同毫秒场景）', async (t) => {
  const root = useTempMailbox(t);
  const n = new MailboxNotifier();
  const record = { subagentId: 'sa-ord', targetSessionId: HOST_SESSION };

  const delivered = [];
  for (let i = 1; i <= 3; i++) {
    const res = await n.notifyCompletion(record, `msg-${i}`);
    assert.strictEqual(res.delivered, true);
    delivered.push(path.basename(res.filePath));
  }

  const unread = path.join(root, HOST_SESSION, 'unread');
  const onDisk = fs.readdirSync(unread).sort();
  assert.deepStrictEqual(onDisk, delivered, 'drain 侧字典序 = 投递序');

  // 顺序语义落到内容层：按字典序读出的 content 必须是 msg-1..msg-3
  const contents = onDisk.map((f) => JSON.parse(fs.readFileSync(path.join(unread, f), 'utf8')).content);
  assert.deepStrictEqual(contents, ['msg-1', 'msg-2', 'msg-3']);
});

test('target 缺失/非法 → delivered:false 且整个 mailbox 根零文件', async (t) => {
  const root = useTempMailbox(t);
  const n = new MailboxNotifier();

  const noTarget = await n.notifyCompletion({ subagentId: 'sa-x' }, 's');
  assert.deepStrictEqual(noTarget, { delivered: false }, '无 targetSessionId');
  const nullRecord = await n.notifyCompletion(null, 's');
  assert.deepStrictEqual(nullRecord, { delivered: false }, 'record 为 null');
  const badTarget = await n.notifyCompletion({ subagentId: 'sa-x', targetSessionId: 'host-123' }, 's');
  assert.deepStrictEqual(badTarget, { delivered: false }, '不匹配 sess_ 正则');
  const emptyTarget = await n.notifyCompletion({ subagentId: 'sa-x', targetSessionId: 'sess_' }, 's');
  assert.deepStrictEqual(emptyTarget, { delivered: false }, 'sess_ 后无字符不合法');

  assert.deepStrictEqual(listAllFiles(root), [], '零文件写入');
});

test('content 非字符串 → 写前自检抛错，且无任何文件（连 .tmp 都没有）', async (t) => {
  const root = useTempMailbox(t);
  const n = new MailboxNotifier();
  const record = { subagentId: 'sa-bad', targetSessionId: HOST_SESSION };

  await assert.rejects(
    () => n.notifyCompletion(record, 12345),
    /envelope 自检失败.*content 必须/,
    'content 非字符串必须在写盘前抛错',
  );
  assert.deepStrictEqual(listAllFiles(root), [], '零文件写入（含 .tmp）');

  // 抛错不污染计数器语义：修正后可继续正常投递
  const ok = await n.notifyCompletion(record, 'fixed');
  assert.strictEqual(ok.delivered, true);
  assert.strictEqual(fs.readdirSync(path.join(root, HOST_SESSION, 'unread')).length, 1);
});

test('sweepStaleTmp 只删符合己方模式的 .tmp，不动 .json 与无关 .tmp', (t) => {
  const root = useTempMailbox(t);
  const unread = path.join(root, HOST_SESSION, 'unread');
  fs.mkdirSync(unread, { recursive: true });
  const staleOwn = '1700000000000-000001-sa-crashed.json.tmp'; // 己方崩溃残留
  const unrelated = 'unrelated.json.tmp'; // 他人/未知来源
  const normal = '1700000000001-000002-sa-ok.json'; // 正常消息，drain 会消费
  for (const f of [staleOwn, unrelated, normal]) {
    fs.writeFileSync(path.join(unread, f), 'x', 'utf8');
  }

  const n = new MailboxNotifier();
  const removed = n.sweepStaleTmp();

  assert.strictEqual(removed, 1, '只删 1 个');
  assert.deepStrictEqual(fs.readdirSync(unread).sort(), [normal, unrelated].sort());
  // 空根目录不抛错
  const n2 = new MailboxNotifier();
  const root2 = path.join(root, 'sess_not-created');
  fs.mkdirSync(root2, { recursive: true }); // 有会话目录但无 unread/
  assert.strictEqual(n2.sweepStaleTmp(), 0);
});

test('PollingNotifier：不产生任何文件，返回 polling 兜底语义', async (t) => {
  const root = useTempMailbox(t);
  const p = new PollingNotifier();
  const record = { subagentId: 'sa-poll', targetSessionId: HOST_SESSION };

  const res = await p.notifyCompletion(record, 's');
  assert.deepStrictEqual(res, { delivered: false, guidance: 'poll via list' });
  assert.deepStrictEqual(listAllFiles(root), [], '零文件写入');

  const g = p.pollingGuidance('sa-poll');
  // R6：CLI 指引必须是绝对路径形态（ZCODE_PLUGIN_ROOT 或模块相对回退拼接）——
  // 主 agent cwd 是项目目录，裸 node bin/zsw.js 照抄执行会 ENOENT
  assert.ok(/node \S*bin\/zsw\.js status --id sa-poll/.test(g), '含可照抄执行的 CLI status 查询示例（绝对路径）');
  assert.ok(g.includes('closed'), '说明完成后 status 变 closed');
  assert.ok(g.includes('outputs'), '说明 result 落 outputs 路径');
  // 0.2.0 文案修复（DESIGN-v4 §3.1）：指引在 start（wait=false）时刻随 handle
  // 返回，任务刚启动——锁「已启动」口径 + 时间预期 + daemon 等待指引，
  // 防回归到「已完成」误导文案（诱发立刻查 status + sleep 轮询）
  assert.ok(g.includes('已启动'), 'start 时刻口径：已启动');
  assert.ok(!g.includes('已完成'), '不得出现「已完成」（旧文案 bug）');
  assert.ok(g.includes('3-10 分钟'), '给时间预期，防无预期轮询');
  // 1.0.0 文案口径（M1 CLI 默认翻转）：等待姿势 = CLI start --wait（默认连
  // daemon）配 Bash run_in_background，触发引擎原生通知——不再是 --daemon flag
  assert.ok(/node \S*bin\/zsw\.js start --wait/.test(g), '指向 CLI start --wait 等待姿势（1.0.0+，绝对路径）');
});
