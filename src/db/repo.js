'use strict';

/**
 * 数据访问层（素材提炼型记忆库）——域拆分后的纯 facade。
 * 写入语义：一切通过 MCP/REST/Web 提交的都是"素材"（text 单条或 messages 多轮），一律异步受理
 * （返回 event_id）→ 后台 LLM 提炼成多条自包含的结构化记忆 → 入库（仅提炼产物，不存原文）。
 * 提炼失败/无产物 → 事件 failed，素材不落库（调用方可重试）。库内没有"原文直存"路径。
 * 检索：语义（向量）+ 关键词（FTS）混合。已裁剪：agent/run 作用域、批量导入、整库/实体管理、
 * TTL 归档、修改历史。密钥 / Web 会话 / 设备流连接（员工接入）原样保留。
 *
 * 分域模块（实现见各文件，本文件只做转发；导出面与拆分前逐键一致，勿在此新增实现）：
 *   repo/_common.js   域间共享的无状态小工具
 *   repo/memories.js  记忆 CRUD + 混合检索（向量 + FTS + OR 兜底）
 *   repo/events.js    素材受理 + 提炼队列 + 积压统计
 *   repo/l0.js        L0 归档（批次幂等/记录去重/设备/会话）
 *   repo/l1.js        L1 摘要状态机（源指纹全项目唯一定义在此）
 *   repo/keys.js      API Token / Web 会话 / 设备流连接
 * stats() 是跨域聚合（memories+keys 计数），留在本文件。
 */

const db = require('./index');

const memories = require('./repo/memories');
const events = require('./repo/events');
const l0 = require('./repo/l0');
const l1 = require('./repo/l1');
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
  // L0 归档域
  l0BatchExists: l0.l0BatchExists,
  l0FilterNewRecords: l0.l0FilterNewRecords,
  l0MarkRecords: l0.l0MarkRecords,
  insertL0Batch: l0.insertL0Batch,
  l0Stats: l0.l0Stats,
  l0Sessions: l0.l0Sessions,
  upsertL0Device: l0.upsertL0Device,
  findDeviceByFingerprint: l0.findDeviceByFingerprint,
  listL0Devices: l0.listL0Devices,
  l0SessionOwned: l0.l0SessionOwned,
  // L1 摘要域
  l1Sources: l1.l1Sources,
  l1SourceFp: l1.l1SourceFp,
  l1Existing: l1.l1Existing,
  ensureL1Pending: l1.ensureL1Pending,
  pickL1Pending: l1.pickL1Pending,
  markL1Running: l1.markL1Running,
  markL1Failed: l1.markL1Failed,
  saveL1Summary: l1.saveL1Summary,
  requeueL1: l1.requeueL1,
  listL1Summaries: l1.listL1Summaries,
  getL1Summary: l1.getL1Summary,
  l1Stats: l1.l1Stats,
  resetStuckL1: l1.resetStuckL1,
  // keys / sessions / connect 域
  createApiKey: keys.createApiKey,
  listApiKeys: keys.listApiKeys,
  findUserIdByTokenHash: keys.findUserIdByTokenHash,
  revokeApiKey: keys.revokeApiKey,
  createSession: keys.createSession,
  getSession: keys.getSession,
  deleteSession: keys.deleteSession,
  cleanupSessions: keys.cleanupSessions,
  createConnectRequest: keys.createConnectRequest,
  canAutoConfirm: keys.canAutoConfirm,
  confirmConnectRequest: keys.confirmConnectRequest,
  pollConnectRequest: keys.pollConnectRequest,
  cleanupConnectRequests: keys.cleanupConnectRequests,
  // 跨域聚合
  stats,
};
