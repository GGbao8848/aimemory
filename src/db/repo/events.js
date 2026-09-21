'use strict';

// 事件队列域：一切提交都是"素材"（text/messages），异步受理返回 event_id，
// 后台队列串行执行 → 入库（仅提炼产物，不存原文）。
// 事件表 events 即任务队列（status: pending/processing/done/failed）。
// 提炼/标注/消解的实现在 src/l2/extract.js（2026-09-20 模块治理拆出）——本模块只管队列。

const db = require('../index');
const config = require('../../config');
const llm = require('../../llm/client');
const extract = require('../../l2/extract');
const { now, uuid } = require('./_common');

/**
 * 受理记忆素材（text 单条 / messages 多轮对话），一律异步：
 * 创建提炼任务返回 { event_id, status:'pending' }，后台队列（processPendingEvents）提炼入库。
 * 库内只存提炼产物，不存原文。提炼失败 → 事件 failed（素材不落库）。
 * LLM 未启用（LLM_ENABLED=0）时直接拒绝，避免"收了素材却永远无法提炼"。
 */
function createMemory({ userId, text, messages, metadata = {}, agentId = null, runId = null }) {
  if (!llm.enabled()) {
    throw new Error('LLM 提炼服务未启用（LLM_ENABLED=0），无法写入记忆');
  }
  let kind = 'text';
  let input = text;
  if (messages && Array.isArray(messages) && messages.length) {
    kind = 'messages';
    input = messages.slice(0, 50);
  }
  if (input === undefined || (typeof input === 'string' && !input.trim())) {
    throw new Error('text 或 messages 至少提供一个');
  }
  const eventId = createEvent({
    userId,
    eventType: 'add_memory',
    payload: { kind, input, metadata: metadata || {}, agent_id: agentId, run_id: runId },
  });
  archiveMaterial({ id: eventId, userId, kind, input, metadata: metadata || {}, agentId, runId });
  return { event_id: eventId, status: 'pending', user_id: userId };
}

// ============ 异步任务队列 ============

/** 创建异步任务，立即返回 event_id（pending）。 */
function createEvent({ userId, eventType = 'add_memory', payload }) {
  const id = uuid();
  const ts = now();
  db.prepare(
    'INSERT INTO events (id, user_id, event_type, status, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, userId, eventType, 'pending', JSON.stringify(payload), ts);
  return id;
}

function getEvent(id, userId) {
  const row = db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return null;
  return {
    id: row.id,
    event_type: row.event_type,
    status: row.status,
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 批量删除（DELETE /v1/memories/ 异步执行体）：按作用域删除并逐条留历史 */
function processDeleteAll({ userId, agentId, runId }) {
  const where = ['user_id = ?'];
  const params = [userId];
  // mem0 语义：'*' = 该维度全选；未提供 = 不按该维度过滤
  if (agentId !== undefined && agentId !== '*') { where.push('agent_id = ?'); params.push(agentId); }
  if (agentId === '*') where.push('agent_id IS NOT NULL');
  if (runId !== undefined && runId !== '*') { where.push('run_id = ?'); params.push(runId); }
  if (runId === '*') where.push('run_id IS NOT NULL');
  const rows = db.prepare(`SELECT id, rowid AS rid, text FROM memories WHERE ${where.join(' AND ')}`).all(...params);
  for (const r of rows) {
    db.prepare('DELETE FROM memories WHERE id = ?').run(r.id);
    require('../../l2/vec').remove(r.rid);
    require('../../l2/store').recordOp({
      userId, memoryId: r.id, op: 'DELETE', beforeText: r.text,
      candidates: [], source: 'delete_all',
    });
  }
  return { count: rows.length, memoryIds: [] };
}

/** 处理一个 pending 任务：素材 → LLM 提炼 → 逐条入库（仅提炼产物）。失败/无产物 → failed。 */
async function processEvent(event) {
  const userId = event.user_id;
  const id = event.id;
  const p = JSON.parse(event.payload || '{}');
  db.prepare("UPDATE events SET status='processing', updated_at=? WHERE id=?").run(now(), id);
  try {
    if (event.event_type === 'delete_memories') {
      const r = processDeleteAll({ userId, agentId: p.agent_id, runId: p.run_id });
      db.prepare("UPDATE events SET status='done', result=?, updated_at=? WHERE id=?")
        .run(JSON.stringify({ count: r.count, memories: [] }), now(), id);
      return getEvent(id, userId);
    }
    const { created, ops } = await extract.processMemoryMaterial({
      userId, kind: p.kind, input: p.input, metadata: p.metadata, agentId: p.agent_id, runId: p.run_id,
    });
    // 溯源打标：产物记住来源素材（重提时按此精准删除；直存/无溯源记忆不受重提影响）
    for (const m of created) {
      db.prepare('UPDATE memories SET raw_event_id = ? WHERE id = ?').run(id, m.id);
    }
    // ops 记录消解明细：count=0 时也能看出"不是没干活，而是素材里的东西都已记住"，
    // 前端/agent 可据此区分「已存在（NOOP）」与「空产出」。
    const result = {
      count: created.length,
      memories: created,
      ops: { added: ops.added, updated: ops.updated, deleted: ops.deleted, noop: ops.noop, degraded: ops.degraded },
    };
    db.prepare("UPDATE events SET status='done', result=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(result), now(), id);
  } catch (e) {
    db.prepare("UPDATE events SET status='failed', error=?, updated_at=? WHERE id=?")
      .run(String(e.message || e).slice(0, 500), now(), id);
  }
  return getEvent(id, userId);
}

/** 扫描并处理 pending 任务（串行，避免 LLM 并发超限；processing 卡死 5 分钟重置重试）。
 *  由服务启动定时调用（见 index.js 每 2s 轮询）。返回本次处理数。 */
async function processPendingEvents() {
  const stuckCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  db.prepare(
    "UPDATE events SET status='pending', updated_at=? WHERE status='processing' AND updated_at <= ?"
  ).run(now(), stuckCutoff);
  const pendings = db
    .prepare("SELECT * FROM events WHERE status = 'pending' ORDER BY created_at LIMIT 3")
    .all();
  for (const ev of pendings) {
    await processEvent(ev);
  }
  return pendings.length;
}

/** 清理 7 天前的已完成/失败任务（防表膨胀） */
function cleanupEvents() {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  db.prepare("DELETE FROM events WHERE status IN ('done','failed') AND created_at <= ?").run(cutoff);
}

/** 素材原文落档（受理即写，提炼有损时的回溯依据）。归档失败绝不阻断受理。 */
function archiveMaterial({ id, userId, kind, input, metadata = {}, agentId = null, runId = null }) {
  try {
    db.prepare('INSERT INTO raw_materials (id, user_id, kind, input, metadata, agent_id, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, kind, JSON.stringify(input ?? null), JSON.stringify(metadata || {}), agentId, runId, now());
  } catch (e) {
    console.error(`[events] 素材归档失败（不影响受理）：${e.message}`);
  }
}

/** 素材归档分页（含提炼状态与关联记忆数，供归档管理页） */
function listRawMaterials(userId, page = 1, pageSize = 20) {
  page = Math.max(1, Number(page) || 1);
  pageSize = Math.max(1, Math.min(Number(pageSize) || 20, 100));
  const total = db.prepare('SELECT COUNT(*) c FROM raw_materials WHERE user_id = ?').get(userId).c;
  const results = db
    .prepare(
      `SELECT r.id, r.kind, r.input, r.metadata, r.agent_id, r.run_id, r.created_at,
              COALESCE(e.status, 'none') AS status,
              (SELECT COUNT(*) FROM memories m WHERE m.raw_event_id = r.id) AS memory_count
         FROM raw_materials r
         LEFT JOIN events e ON e.id = r.id
        WHERE r.user_id = ?
        ORDER BY r.created_at DESC LIMIT ? OFFSET ?`
    )
    .all(userId, pageSize, (page - 1) * pageSize);
  return { results, total, page, pageSize };
}

/**
 * 重提：删除该素材上次提炼的记忆（按溯源），再把原文重新入队走完整管线。
 * 场景：觉得提炼得不好、换了模型想重新提炼。直存/无溯源的记忆永不触碰。
 * @returns {{accepted: number, deleted: number}}
 */
function reextractRawMaterials({ userId, ids = null }) {
  const targets = ids
    ? ids
    : db.prepare('SELECT id FROM raw_materials WHERE user_id = ?').all(userId).map((r) => r.id);
  let accepted = 0;
  let deleted = 0;
  for (const id of targets) {
    const raw = db.prepare('SELECT * FROM raw_materials WHERE id = ? AND user_id = ?').get(id, userId);
    if (!raw) continue;
    // 1) 删除上次提炼的产物（留变更历史 + 清向量）
    const derived = db.prepare('SELECT id, text FROM memories WHERE raw_event_id = ? AND user_id = ?').all(id, userId);
    for (const m of derived) {
      const row = db.prepare('SELECT rowid AS rid FROM memories WHERE id = ?').get(m.id);
      db.prepare('DELETE FROM memories WHERE id = ?').run(m.id);
      if (row) require('../../l2/vec').remove(row.rid);
      require('../../l2/store').recordOp({
        userId, memoryId: m.id, op: 'DELETE', beforeText: m.text, candidates: [], source: 'reextract',
      });
      deleted += 1;
    }
    // 2) 事件重置为 pending（复用同 id → 溯源链稳定），payload 从归档还原
    let input;
    try { input = JSON.parse(raw.input); } catch { input = raw.input; }
    let metadata = {};
    try { metadata = JSON.parse(raw.metadata || '{}'); } catch { metadata = {}; }
    db.prepare('DELETE FROM events WHERE id = ?').run(id);
    db.prepare(
      "INSERT INTO events (id, user_id, event_type, status, payload, created_at) VALUES (?, ?, 'add_memory', 'pending', ?, ?)"
    ).run(id, userId, JSON.stringify({ kind: raw.kind, input, metadata, agent_id: raw.agent_id, run_id: raw.run_id }), raw.created_at);
    accepted += 1;
  }
  return { accepted, deleted };
}

/** 按保留天数清理素材归档（RAW_ARCHIVE_DAYS，0 = 永久保留）。与 cleanupEvents 同节奏调用。 */
function cleanupRawMaterials() {
  const days = config.rawArchiveDays;
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  db.prepare('DELETE FROM raw_materials WHERE created_at <= ?').run(cutoff);
}

/**
 * 素材提炼队列（events 表）的积压统计。
 * 供星图「通讯状态」用——待处理数量直接决定沉淀链路上数据包的密度与流速。
 */
function eventStats(userId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
              SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) processing,
              SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
              MAX(created_at) last_at
         FROM events WHERE user_id = ?`
    )
    .get(userId);
  return {
    total: row.total || 0,
    pending: row.pending || 0,
    processing: row.processing || 0,
    done: row.done || 0,
    failed: row.failed || 0,
    last_at: row.last_at || null,
  };
}

/**
 * 事件队列积压探测（/healthz 用，全局视角不按用户）：
 * pending+processing 卡住意味着后台提炼链停摆——素材「收了但不处理」，必须让健康检查看见。
 */
function queueBacklog() {
  const row = db
    .prepare(
      `SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
              SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) processing,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
              MIN(CASE WHEN status IN ('pending','processing') THEN created_at END) oldest_at
         FROM events`
    )
    .get();
  return {
    pending: row.pending || 0,
    processing: row.processing || 0,
    failed: row.failed || 0,
    oldest_age_ms: row.oldest_at ? Math.max(0, Date.now() - Date.parse(row.oldest_at)) : 0,
  };
}

module.exports = {
  createMemory,
  classifyFacts: extract.classifyFacts,
  extractMemories: extract.extractMemories,
  processMemoryMaterial: extract.processMemoryMaterial,
  createEvent,
  getEvent,
  processPendingEvents,
  cleanupEvents,
  cleanupRawMaterials,
  archiveMaterial,
  listRawMaterials,
  reextractRawMaterials,
  eventStats,
  queueBacklog,
};
