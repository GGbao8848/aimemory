'use strict';

/**
 * 数据访问层（mem0 形态记忆库）——域拆分后的纯 facade。
 * 写入语义：add 提交的都是"素材"（text 单条或 messages 多轮），一律异步受理
 * （返回 event_id）→ 后台 LLM 提炼成多条自包含的结构化记忆 → 入库（仅提炼产物，不存原文）。
 * 提炼失败/无产物 → 事件 failed，素材不落库（调用方可重试）。
 * 检索：语义（向量）+ 关键词（FTS）混合。
 *
 * 分域模块（实现见各文件，本文件只做转发；导出面与拆分前逐键一致，勿在此新增实现）：
 *   repo/memories.js  记忆 CRUD + 混合检索（向量 + FTS + OR 兜底）
 *   repo/events.js    素材受理 + 提炼队列 + 积压统计
 *   repo/keys.js      API Token / Web 会话
 * stats() 是跨域聚合（memories+keys 计数），留在本文件。
 */

const db = require('./index');

const memories = require('./repo/memories');
const events = require('./repo/events');
const keys = require('./repo/keys');

// ============ 统计（跨域聚合） ============

/** 记忆统计（健康检查与页面展示用） */
function stats(userId) {
  return {
    memories: db.prepare('SELECT COUNT(*) c FROM memories WHERE user_id = ?').get(userId).c,
    keys: db.prepare('SELECT COUNT(*) c FROM api_keys WHERE user_id = ? AND revoked_at IS NULL').get(userId).c,
  };
}

module.exports = {
  // memories 域
  getMemory: memories.getMemory,
  listMemories: memories.listMemories,
  exportMemories: memories.exportMemories,
  searchMemories: memories.searchMemories,
  updateMemory: memories.updateMemory,
  deleteMemory: memories.deleteMemory,
  // events 域（素材管线 + 队列）
  createMemory: events.createMemory,
  createEvent: events.createEvent,
  getEvent: events.getEvent,
  processPendingEvents: events.processPendingEvents,
  cleanupEvents: events.cleanupEvents,
  eventStats: events.eventStats,
  queueBacklog: events.queueBacklog,
  // keys / sessions 域
  createApiKey: keys.createApiKey,
  listApiKeys: keys.listApiKeys,
  findUserIdByTokenHash: keys.findUserIdByTokenHash,
  revokeApiKey: keys.revokeApiKey,
  createSession: keys.createSession,
  getSession: keys.getSession,
  deleteSession: keys.deleteSession,
  cleanupSessions: keys.cleanupSessions,
  // 跨域聚合
  stats,
};
