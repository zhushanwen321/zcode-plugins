'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parseDiffAddedLines, buildLineIndex, unionRanges, rangesIntersect,
  cleanForComplexity, countDecisions, complexityOf, crapScore,
} = require('../scripts/quality-gate.js');

// ── parseDiffAddedLines ──

test('parseDiffAddedLines: 普通 hunk 与 count 省略形态', () => {
  const diff = [
    'diff --git a/lib/a.js b/lib/a.js',
    'index 111..222 100644',
    '--- a/lib/a.js',
    '+++ b/lib/a.js',
    '@@ -1,2 +3,4 @@ ctx',
    ' line',
    '+added1',
    ' line',
    '+added2',
    '@@ -10 +20 @@ ctx',
    '+added3',
  ].join('\n');
  const m = parseDiffAddedLines(diff);
  assert.deepStrictEqual([...m.get('lib/a.js')], [3, 4, 5, 6, 20]);
});

test('parseDiffAddedLines: 新增文件与删除文件', () => {
  const diff = [
    'diff --git a/lib/new.js b/lib/new.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/lib/new.js',
    '@@ -0,0 +1,2 @@',
    '+x',
    '+y',
    'diff --git a/lib/old.js b/lib/old.js',
    'deleted file mode 100644',
    '--- a/lib/old.js',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-x',
  ].join('\n');
  const m = parseDiffAddedLines(diff);
  assert.ok(m.has('lib/new.js'));
  assert.deepStrictEqual([...m.get('lib/new.js')], [1, 2]);
  assert.ok(!m.has('lib/old.js'));
});

// ── buildLineIndex / unionRanges / rangesIntersect ──

test('buildLineIndex: 行边界与 offsetToLine', () => {
  const src = 'ab\ncd\n\nef';
  const li = buildLineIndex(src);
  assert.strictEqual(li.lineStart(1), 0);
  assert.strictEqual(li.lineEnd(1), 3);   // 含 \n
  assert.strictEqual(li.lineStart(2), 3);
  assert.strictEqual(li.lineEnd(4), src.length);
  assert.strictEqual(li.offsetToLine(0), 1);
  assert.strictEqual(li.offsetToLine(2), 1);
  assert.strictEqual(li.offsetToLine(3), 2);
  assert.strictEqual(li.offsetToLine(src.length), 4);
});

test('unionRanges: 重叠/相邻合并与空区间丢弃', () => {
  assert.deepStrictEqual(
    unionRanges([[0, 5], [3, 8], [10, 10], [9, 12]]),
    [[0, 8], [9, 12]],
  );
  assert.deepStrictEqual(rangesIntersect([[0, 5], [10, 20]], 4, 6), true);
  assert.deepStrictEqual(rangesIntersect([[0, 5], [10, 20]], 5, 6), false);
  assert.deepStrictEqual(rangesIntersect([], 0, 1), false);
});

// ── cleanForComplexity / countDecisions ──

test('cleanForComplexity: 注释与字符串替换为空白，插值代码保留', () => {
  const code = 'if (a) { // if in comment\n /* for || while */ b = "x && y"; c = `t ${d ? e} f`;\n}';
  const cleaned = cleanForComplexity(code);
  assert.ok(!cleaned.includes('comment'));
  assert.ok(!cleaned.includes('&& y'));
  assert.ok(cleaned.includes('if (a)'));
  assert.ok(cleaned.includes('? e')); // 插值是代码，分支应保留计数
  assert.strictEqual(countDecisions(cleaned), 2); // if + 插值三元
});

test('cleanForComplexity: 嵌套模板字面量（文本清洗、插值保留）', () => {
  const code = 'a = `x ${`y ${z ? 1 : 2}`} ${w || v}`;';
  const cleaned = cleanForComplexity(code);
  assert.strictEqual(countDecisions(cleaned), 2); // z 三元 + w||v
});

test('cleanForComplexity: 插值内块语句/对象字面量不误关插值', () => {
  const code = 'a = `${obj.map((x) => { if (x) return 1; }).join("")} done`;';
  const cleaned = cleanForComplexity(code);
  assert.ok(cleaned.includes('if (x)'));       // } 关闭块后仍在插值代码层
  assert.ok(!cleaned.includes('done'));        // 插值后的模板文本仍被清洗
  assert.strictEqual(countDecisions(cleaned), 1);
});

test('countDecisions: 分支符号族与 do 语义', () => {
  assert.strictEqual(countDecisions('a ? b : c'), 1);
  assert.strictEqual(countDecisions('a?.b'), 0);
  assert.strictEqual(countDecisions('a ?? b'), 1);
  assert.strictEqual(countDecisions('a ??= b'), 1);
  assert.strictEqual(countDecisions('a && b || c'), 2);
  assert.strictEqual(countDecisions('a &&= b'), 1);
  assert.strictEqual(countDecisions('a ||= b'), 1);
  assert.strictEqual(countDecisions('a | b & c'), 0);
  assert.strictEqual(countDecisions('do { x } while (y)'), 1); // do 不数，while 数 1
  assert.strictEqual(countDecisions('switch (x) { case 1: case 2: break; default: break; }'), 2);
  assert.strictEqual(countDecisions('try { x } catch (e) { y }'), 1);
  assert.strictEqual(countDecisions('p.catch(handler)'), 0); // 属性访问非 catch 子句
  assert.strictEqual(countDecisions('for (const a of b) { if (a) continue; }'), 2);
  assert.strictEqual(countDecisions('interface_for.catch'), 0); // 标识符整词匹配 + 属性访问
});

// ── complexityOf: 嵌套函数剔除 ──

test('complexityOf: 嵌套函数的分支不计入外层', () => {
  const outer = 'function outer(x) {\n  if (x) {\n    const inner = (v) => v ? 1 : 0;\n    return inner(x) && x;\n  }\n  return 0;\n}';
  // outer 自身：1 + if + && = 3；inner 区间整体挖空，其三元不计入
  const li = buildLineIndex(outer);
  const innerStart = outer.indexOf('(v)');
  const innerEnd = outer.indexOf('0;', innerStart) + 2; // v ? 1 : 0 的尾部
  const comp = complexityOf(outer, [0, outer.length], [[innerStart - 14, innerEnd]]);
  assert.strictEqual(comp, 3);
  assert.ok(li);
});

test('complexityOf: 内层函数独立计数', () => {
  const src = 'function outer(x) { const f = (v) => { if (v) return 1; if (!v) return 2; }; return f; }';
  const fStart = src.indexOf('(v)');
  const fEnd = src.indexOf('};', fStart) + 1;
  const comp = complexityOf(src, [fStart - 1, fEnd], []);
  assert.strictEqual(comp, 3); // 1 + 2 个 if
});

// ── crapScore ──

test('crapScore: 全覆盖退化为 comp，零覆盖放大', () => {
  assert.strictEqual(crapScore(5, 1), 5);
  assert.strictEqual(crapScore(5, 0), 25 + 5); // comp² × 1³ + comp
  // comp=3, cov=0.5 → 9*0.125+3 = 4.125
  assert.strictEqual(crapScore(3, 0.5), 4.125);
  assert.ok(crapScore(10, 0) > crapScore(10, 0.5));
});
