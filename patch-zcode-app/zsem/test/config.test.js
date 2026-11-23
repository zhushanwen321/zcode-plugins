'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLimits, resetCache } = require('../lib/config');

function tmpConfig(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsem-cfg-'));
  const file = path.join(dir, 'zsem-config.json');
  if (content !== undefined) fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('缺失文件 → null', () => {
  resetCache();
  assert.equal(readLimits(tmpConfig()), null);
});

test('损坏 JSON → null', () => {
  resetCache();
  assert.equal(readLimits(tmpConfig('{broken')), null);
});

test('合法配置 → providerId 到 limit 映射;非法条目忽略', () => {
  resetCache();
  const file = tmpConfig(
    JSON.stringify({
      providers: {
        'account:glm': { limit: 10 },
        'account:kimi': { limit: 0 },
        'account:neg': { limit: -3 },
        'account:frac': { limit: 2.5 },
        'account:noobj': 5,
      },
    }),
  );
    // readLimits 返回 null 原型对象(防原型链键),比较时转普通对象
  assert.deepEqual({ ...readLimits(file) }, { 'account:glm': 10 });
});

test('mtime 缓存:文件变化后重读生效', () => {
  resetCache();
  const file = tmpConfig(JSON.stringify({ providers: { p: { limit: 1 } } }));
  assert.deepEqual({ ...readLimits(file) }, { p: 1 });
  // 同 mtime 内缓存(写回同内容 + utimes 保 mtime 不变不可靠,直接改内容验证重读)
  fs.writeFileSync(file, JSON.stringify({ providers: { p: { limit: 7 } } }), 'utf8');
  assert.deepEqual({ ...readLimits(file) }, { p: 7 });
});
