'use strict';

/**
 * 归一化记录 schema —— 适配器与上传器之间的唯一契约。
 *
 * 三种 agent 的原生格式互不兼容，适配器负责把各自格式转成这里的固定形状；
 * 上传器只认这里，从此不再随 agent 变化而改（"死程序"的落点）。
 *
 * 一条记录 = 会话里的一个事件（一条消息 / 一次工具调用 / 一轮推理）。
 *
 * 字段：
 *   rid      稳定标识（agent:session:native_id[:version]）—— L1 据此 upsert 去重
 *   ts       事件时间（ISO8601）
 *   version  版本号（同一 rid 原地更新时递增；L1 取最大版本，L0 保留全部观察）
 *   seq      会话内顺序号（可选，用于回放排序）
 *   role     角色：user / assistant / system / tool / reasoning / meta
 *   content  文本正文（工具类事件可为空）
 *   meta     agent 特有附加信息（工具名、模型、token 数等）
 *   raw      该事件的原始数据（保留以便 L0 作为事实源可重建；可配置关闭）
 *
 * 注意：本层不做任何语义提炼、不合并、不摘要——那是 L1/L2 的事。
 */

const ROLE = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
  TOOL: 'tool',
  REASONING: 'reasoning',
  META: 'meta',
};

/** 稳定 rid：agent + session + 原生 id（同一记录多次观察共用它） */
function makeRid(agent, sessionId, nativeId) {
  return `${agent}:${sessionId}:${nativeId}`;
}

/** 构造一条归一化记录（过滤 undefined，保持传输紧凑） */
function makeRecord({ rid, ts, version, seq, role, content, meta, raw }) {
  const rec = { rid: String(rid), ts: ts || new Date().toISOString() };
  if (version != null) rec.version = version;
  if (seq != null) rec.seq = seq;
  rec.role = role || ROLE.META;
  if (content != null && content !== '') rec.content = String(content);
  if (meta && Object.keys(meta).length) rec.meta = meta;
  if (raw != null) rec.raw = raw;
  return rec;
}

/** 文本裁剪：单条内容上限，防超大工具输出撑爆批次 */
const MAX_CONTENT = 200_000;
function clip(s) {
  if (s == null) return '';
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > MAX_CONTENT ? `${str.slice(0, MAX_CONTENT)}\n…[truncated ${str.length - MAX_CONTENT} chars]` : str;
}

module.exports = { ROLE, makeRid, makeRecord, clip, MAX_CONTENT };
