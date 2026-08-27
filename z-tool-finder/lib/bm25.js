/**
 * lib/bm25.js — 内存 BM25 索引与检索（DESIGN.md §6.6 D6）。
 *
 * 零依赖红线：不引外部检索库，自实现 Okapi BM25（规模 <1k 工具毫秒级）。
 * 分词规则：英文按非字母数字切、中文按单字切、全部小写。
 * 纯内存、无状态：buildIndex 产出快照对象，search 不改索引。
 */
'use strict';

const K1 = 1.5;
const B = 0.75;

/**
 * 分词：连续拉丁字母/数字串为一个 token；CJK 字符逐字成 token；其余为分隔符。
 * \p{L} 覆盖带声调拉丁字母等，CJK 范围单独逐字处理。
 */
function tokenize(text) {
  const tokens = [];
  const s = String(text == null ? '' : text).toLowerCase();
  const re = /(\p{Script=Han}|\p{L}+|\d+)/gu;
  let m;
  while ((m = re.exec(s)) !== null) {
    const tok = m[0];
    if (/^\p{Script=Han}$/u.test(tok)) {
      tokens.push(tok); // 中文单字
    } else {
      tokens.push(tok); // 英文单词 / 数字串
    }
  }
  return tokens;
}

/**
 * 建索引。
 * @param {Array<{ id: string, text: string }>} docs
 * @returns {{ df: Map<string, number>, avgdl: number, docs: Array<{ id: string, tf: Map<string, number>, len: number }> }}
 */
function buildIndex(docs) {
  const df = new Map();
  const indexed = [];
  let totalLen = 0;
  for (const doc of docs || []) {
    const tokens = tokenize(doc.text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    totalLen += tokens.length;
    indexed.push({ id: doc.id, tf, len: tokens.length });
  }
  const avgdl = indexed.length ? totalLen / indexed.length : 0;
  return { df, avgdl, docs: indexed };
}

/**
 * BM25 检索。返回 [{ id, score }] 按 score 降序截 limit；无命中返回 []。
 * @param {object} index buildIndex 的返回值
 * @param {string} query
 * @param {number} [limit=5]
 */
function search(index, query, limit = 5) {
  if (!index || !index.docs.length) return [];
  const N = index.docs.length;
  const terms = tokenize(query);
  if (!terms.length) return [];
  const termSet = [...new Set(terms)];
  const results = [];
  for (const doc of index.docs) {
    let score = 0;
    for (const term of termSet) {
      const f = doc.tf.get(term);
      if (!f) continue;
      const n = index.df.get(term) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score +=
        (idf * (f * (K1 + 1))) /
        (f + K1 * (1 - B + B * (doc.len / (index.avgdl || 1))));
    }
    if (score > 0) results.push({ id: doc.id, score });
  }
  results.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return results.slice(0, limit);
}

module.exports = { buildIndex, search, tokenize };
