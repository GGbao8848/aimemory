'use strict';

/**
 * 追加型 JSONL 文件的增量读取工具（Codex / Claude Code 共用）。
 *
 * 关键保证：
 *   - 按 offset 只读新增部分，不重复读已处理的字节；
 *   - 半行保护：文件正在被写入时，尾部可能是不完整的 JSON 行。遇到就
 *     把 offset 停在最后一个完整换行处，下次再读（绝不解析半行）；
 *   - 截断/替换检测：文件变小（轮转、被重写）时 offset 归零重读。
 *
 * 这与 ZCode 的 DB 适配器不同（那边是原地更新，必须 upsert）。
 */

const fs = require('fs');

/**
 * 从 offset 读取新增的完整行。
 * @returns {{lines:string[], offset:number, size:number, truncated:boolean, rotated:boolean}}
 */
function readNewLines(file, offset, { rotatedSig = null } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { lines: [], offset, size: 0, truncated: false, rotated: true };
  }

  const size = stat.size;
  let truncated = false;
  let start = offset;

  // 文件变小 → 被截断或替换，从头重读
  if (size < offset) {
    start = 0;
    truncated = true;
  }
  if (size === start) {
    // 尺寸没变也要比对签名（inode:size），Claude 会用改名保留旧文件
    return { lines: [], offset: start, size, truncated, rotated: false };
  }

  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    const len = size - start;
    buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
  } finally {
    fs.closeSync(fd);
  }

  const text = buf.toString('utf8');
  // 尾部是否完整行：若非以换行结尾，说明最后一行可能还在写 → 只取到最后一个换行
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) {
    // 整个新增块都没有换行 = 一个巨型半行，等下次
    return { lines: [], offset: start, size, truncated, rotated: false };
  }
  const complete = text.slice(0, lastNl);
  const consumed = Buffer.byteLength(complete, 'utf8') + 1; // +1 是那个换行符
  const lines = complete.split('\n').filter((l) => l.trim() !== '');
  return { lines, offset: start + consumed, size, truncated, rotated: false };
}

/** 安全 JSON 解析：单行坏掉不拖垮整批 */
function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

module.exports = { readNewLines, parseJsonLine };
