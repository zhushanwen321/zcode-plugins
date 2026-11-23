'use strict';

/**
 * yolo 补丁：新建会话的默认权限模式 build → yolo。
 *
 * 来源：app.asar.bak-zsw-yolo-20261121 与当时在线 app.asar 的全量字节 diff
 * （仅 6 字节差异，`??"build"` → ` ??"yolo"` 等宽替换）。写入位置是宿主进程
 * createSession 的模式缺省值（证据：diff 上下文
 * `Only client callers can choose a mode");let S={modelSelection:...,mode:l.mode??"build"`）。
 */

const TARGET = {
  pathRegex: /^\/out\/host\/index\.js$/,
  // 唯一性锚点（3.19.1 实测全 asar 唯一），与模式缺省值同处一个函数
  contentAnchor: 'Only client callers can choose a mode',
};

// mode:<成员链>??"build" —— 只允许紧邻属性链，避免误命中其他 mode: 赋值
const ANCHOR_RE = /mode:([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\?\?"build"/g;

function isApplied(content) {
  return /mode:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)* \?\?"yolo"/.test(content);
}

function transform(content, filePath) {
  if (isApplied(content)) return { content, note: 'already-applied' };
  const matches = content.match(ANCHOR_RE);
  if (!matches || matches.length !== 1) {
    throw new Error(
      `yolo 补丁锚点在 ${filePath} 命中 ${matches ? matches.length : 0} 处（要求恰好 1 处）。` +
        '常见原因：ZCode 升级后该缺省值表达式变了。恢复动作：重新定位 createSession 的 mode 缺省值并更新本补丁的正则。'
    );
  }
  // 等宽替换：`??"build"`（9 字节）→ ` ??"yolo"`（9 字节），补丁前后文件总字节数不变
  const next = content.replace(ANCHOR_RE, (m, v) => `mode:${v} ??"yolo"`);
  return { content: next, note: 'patched' };
}

module.exports = {
  name: 'yolo',
  description: '新建会话默认权限模式 build → yolo（宿主 createSession 缺省值）',
  target: TARGET,
  isApplied,
  transform,
};
