/**
 * 指纹提取：从工具参数序列化文本里找出接触过的 dev-flow 任务目录。
 * 任务目录 = 指纹子串之后的第一段路径（如 Stock-df390a8b）。
 */
'use strict';

const { FINGERPRINT_SUBSTR } = require('./config');

// 任务目录名的合法形态：路径安全字符，防止把任意字符串拼进判定根路径
const TASK_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * 在序列化文本中找出全部指纹命中及其任务目录段。
 * 返回去重后的 taskDir 数组；命中指纹但提取不到目录段（如「ls .../dev-flow/」
 * 指到根本身）时返回空数组，调用方仍应视为指纹命中。
 */
function extractTaskDirs(serialized) {
  const dirs = [];
  if (typeof serialized !== 'string') return dirs;
  let idx = serialized.indexOf(FINGERPRINT_SUBSTR);
  while (idx !== -1) {
    const start = idx + FINGERPRINT_SUBSTR.length;
    let end = start;
    while (end < serialized.length && !'/"\'\\ \n\t<>|*?'.includes(serialized[end])) end++;
    const seg = serialized.slice(start, end);
    if (TASK_DIR_RE.test(seg) && seg !== '.' && seg !== '..' && !dirs.includes(seg)) dirs.push(seg);
    idx = serialized.indexOf(FINGERPRINT_SUBSTR, start);
  }
  return dirs;
}

module.exports = { extractTaskDirs, TASK_DIR_RE };
