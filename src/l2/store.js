'use strict';

/**
 * 记忆写原语（增删改 + 变更历史 + 向量同步）。
 *
 * 为什么这里不复用 repo/memories.js 的写路径：
 * 1) repo.updateMemory 会触发 syncFacts（一次额外 LLM 调用）。冲突消解应用到 UPDATE 时，
 *    文本本身已是提炼产物，再抽一遍 facts 既冗余又费 token（本项目对成本敏感）；
 * 2) 向量同步要与 sqlite-vec 层联动（见 vec.js），边界放在这里更清楚。
 *
 * 所有写操作都补齐 memory_ops 历史：DELETE 记录被删文本，误删可从历史复原。
 */

const crypto = require('crypto');
const db = require('../db');
const emb = require('../embeddings/client');
const vec = require('./vec');

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

/** 与 memories.text 的存储上限保持一致（见 repo/memories.js 的 MAX_TEXT 语义） */
const MAX_TEXT = 8000;

/** 补向量：异步、失败静默（embedding 不可用时检索降级关键词，不影响写入） */
function syncEmbedding(id, text) {
  emb.embed(text).then((buf) => {
    if (!buf) return;
    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(buf, id);
    vec.upsert(id, buf); // 向量层不可用时内部静默返回 false
  }).catch(() => {});
}

/** 新事实入库（返回记忆 id） */
function insertFact({ userId, agentId = null, runId = null, text, metadata = {} }) {
  const id = uuid();
  const ts = now();
  const t = String(text || '').slice(0, MAX_TEXT);
  db.prepare(
    'INSERT INTO memories (id, user_id, agent_id, run_id, text, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, userId, agentId, runId, t, JSON.stringify(metadata || {}), ts, ts);
  syncEmbedding(id, t);
  return id;
}

/** 覆盖事实文本（保留 id）。文本变化时清掉旧的 facts/entities（已与新文本不对应）。 */
function updateFact({ userId, id, text }) {
  const row = db.prepare('SELECT text FROM memories WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return null;
  const t = String(text || '').slice(0, MAX_TEXT);
  const ts = now();
  db.prepare('UPDATE memories SET text = ?, facts = NULL, entities = NULL, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(t, ts, id, userId);
  if (t !== row.text) syncEmbedding(id, t);
  return { before: row.text, after: t };
}

/** 删除事实，返回被删文本（供历史与复原） */
function deleteFact({ userId, id }) {
  const row = db.prepare('SELECT rowid AS rid, text FROM memories WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return null;
  db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(id, userId);
  vec.remove(row.rid); // 向量索引同步清掉（不可用时静默）
  return row.text;
}

/** 读取单条（含归属校验） */
function getFact(id, userId) {
  return db.prepare('SELECT id, text FROM memories WHERE id = ? AND user_id = ?').get(id, userId) || null;
}

/** 近期事实（候选兜底扫描用） */
function recentFacts(userId, limit = 200) {
  return db
    .prepare('SELECT id, text, metadata FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?')
    .all(userId, Math.max(1, Math.min(Number(limit) || 200, 1000)));
}

/** 按 rowid 集合批量取文本（FTS 召回结果 → id/text） */
function factsByIds(userId, ids) {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT id, text FROM memories WHERE user_id = ? AND id IN (${ph})`)
    .all(userId, ...ids);
}

// ============ 变更历史（memory_ops，mem0 语义的 history） ============

function recordOp({ userId, memoryId = null, op, beforeText = null, afterText = null, candidates = [], source = 'add_memory', applied = true }) {
  db.prepare(
    `INSERT INTO memory_ops (user_id, memory_id, op, before_text, after_text, candidates, source, applied, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    memoryId,
    op,
    beforeText == null ? null : String(beforeText).slice(0, MAX_TEXT),
    afterText == null ? null : String(afterText).slice(0, MAX_TEXT),
    JSON.stringify(candidates || []),
    source,
    applied ? 1 : 0,
    now()
  );
}

/** 某条记忆的变更历史（新→旧） */
function listMemoryOps(userId, memoryId, limit = 100) {
  return db
    .prepare(
      `SELECT id, memory_id, op, before_text, after_text, candidates, source, applied, created_at
         FROM memory_ops WHERE user_id = ? AND memory_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(userId, memoryId, Math.max(1, Math.min(Number(limit) || 100, 500)))
    .map((r) => ({
      ...r,
      applied: !!r.applied,
      candidates: (() => { try { return JSON.parse(r.candidates || '[]'); } catch { return []; } })(),
    }));
}

/** 最近的变更记录（新→旧） */
function listOps(userId, limit = 50) {
  return db
    .prepare(
      `SELECT id, memory_id, op, before_text, after_text, candidates, source, applied, created_at
         FROM memory_ops WHERE user_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(userId, Math.max(1, Math.min(Number(limit) || 50, 500)))
    .map((r) => ({
      ...r,
      applied: !!r.applied,
      candidates: (() => { try { return JSON.parse(r.candidates || '[]'); } catch { return []; } })(),
    }));
}

/** 四种操作的计数（供统计接口/前端展示） */
function opStats(userId, sinceDays = 30) {
  const cutoff = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();
  const rows = db
    .prepare('SELECT op, COUNT(*) n FROM memory_ops WHERE user_id = ? AND created_at >= ? GROUP BY op')
    .all(userId, cutoff);
  const out = { ADD: 0, UPDATE: 0, DELETE: 0, NOOP: 0, total: 0 };
  for (const r of rows) {
    out[r.op] = r.n;
    out.total += r.n;
  }
  return out;
}

module.exports = {
  insertFact, updateFact, deleteFact, getFact, recentFacts, factsByIds,
  recordOp, listMemoryOps, listOps, opStats,
  MAX_TEXT,
};
