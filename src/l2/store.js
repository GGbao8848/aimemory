'use strict';

/**
 * L2 事实记忆的写入原语（记忆增删改 + 冲突消解审计 + 向量同步）。
 *
 * 为什么 L2 自己写、不复用 repo.insertMemory/updateMemory：
 * 1) repo.updateMemory 会触发 syncFacts（一次额外 LLM 调用）。冲突消解应用到 UPDATE 时，
 *    文本本身已是提炼产物，再抽一遍 facts 既冗余又费 token（本项目对成本敏感）；
 * 2) 向量同步要与 L2 的 sqlite-vec 层联动（见 vec.js），边界放在这里更清楚。
 * 因此 L2 拥有自己的写路径；repo 只负责「素材 → 事实」的编排与队列。
 *
 * 所有写操作都补齐 memory_ops 审计：DELETE 记录被删文本，误删可从审计复原。
 */

const crypto = require('crypto');
const db = require('../db');
const emb = require('../embeddings/client');
const vec = require('./vec');

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

/** 与 memories.text 的存储上限保持一致（见 repo.js 的 MAX_TEXT 语义） */
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
function insertFact({ userId, text, metadata = {} }) {
  const id = uuid();
  const ts = now();
  const t = String(text || '').slice(0, MAX_TEXT);
  db.prepare(
    'INSERT INTO memories (id, user_id, text, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, userId, t, JSON.stringify(metadata || {}), ts, ts);
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

/** 删除事实，返回被删文本（供审计与复原） */
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

// ============ 审计（memory_ops） ============

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

/** 最近的冲突消解记录（新→旧） */
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

// ============ 派生状态（l2_sources：L1 摘要 → 事实） ============
// 状态机与 l1_summaries 同构：pending → running → done/failed；
// failed 行只要 attempts 未超上限就会被 pick 捞回重试（见 pickL2Pending）。

/** 已完成的 L1 摘要（派生的输入源，仅状态扫描用） */
function l1DoneSummaries(userId) {
  return db
    .prepare(
      `SELECT device_code, agent, session_id, overview, decisions, pending, artifacts, last_ts, updated_at
         FROM l1_summaries
        WHERE user_id = ? AND status = 'done'
        ORDER BY COALESCE(last_ts, updated_at) ASC`
    )
    .all(userId);
}

/** 取单个已完成摘要的正文（按需读取，避免每轮把全部摘要正文捞进内存） */
function getL1DoneSummary(userId, { deviceCode, agent, sessionId }) {
  return db
    .prepare(
      `SELECT device_code, agent, session_id, overview, decisions, pending, artifacts, last_ts, updated_at
         FROM l1_summaries
        WHERE user_id = ? AND device_code = ? AND agent = ? AND session_id = ? AND status = 'done'`
    )
    .get(userId, deviceCode, agent, sessionId) || null;
}

/** 现有派生状态（用于比对指纹） */
function l2Existing(userId) {
  return db
    .prepare('SELECT device_code, agent, session_id, status, content_hash, attempts FROM l2_sources WHERE user_id = ?')
    .all(userId)
    .reduce((m, r) => {
      m[`${r.device_code}\u0000${r.agent}\u0000${r.session_id}`] = r;
      return m;
    }, {});
}

/** 登记待派生（已存在则不动，避免覆盖进行中的状态） */
function ensureL2Pending({ userId, deviceCode, agent, sessionId, contentHash = null }) {
  const ts = now();
  db.prepare(
    `INSERT INTO l2_sources (user_id, device_code, agent, session_id, status, content_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
     ON CONFLICT(user_id, device_code, agent, session_id) DO NOTHING`
  ).run(userId, deviceCode, agent, sessionId, contentHash, ts, ts);
}

/** 摘要内容变了 → 重新排队（attempts 归零，重试预算重置） */
function requeueL2({ userId, deviceCode, agent, sessionId, contentHash = null }) {
  db.prepare(
    `UPDATE l2_sources SET status='pending', content_hash=?, attempts=0, error=NULL, updated_at=?
      WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
  ).run(contentHash, now(), userId, deviceCode, agent, sessionId);
}

/** 取一批待派生（pending，或 failed 但未超重试上限） */
function pickL2Pending({ maxAttempts = 3, limit = 6 } = {}) {
  return db
    .prepare(
      `SELECT user_id, device_code, agent, session_id, attempts, content_hash
         FROM l2_sources
        WHERE status IN ('pending', 'failed') AND attempts < ?
        ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, updated_at ASC
        LIMIT ?`
    )
    .all(maxAttempts, limit);
}

/** 置为 running（attempts 递增，与 L1 一致：不要在失败时清零，否则永远达不到上限） */
function markL2Running({ userId, deviceCode, agent, sessionId }) {
  db.prepare(
    `UPDATE l2_sources SET status='running', attempts = attempts + 1, updated_at=?
      WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
  ).run(now(), userId, deviceCode, agent, sessionId);
}

/** 失败记账；permanent=true 时顶满 attempts 停止重试（如摘要已被删除） */
function markL2Failed({ userId, deviceCode, agent, sessionId, error, permanent = false }) {
  if (permanent) {
    db.prepare(
      `UPDATE l2_sources SET status='failed', error=?, attempts=999, updated_at=?
        WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
    ).run(String(error || '').slice(0, 500), now(), userId, deviceCode, agent, sessionId);
    return;
  }
  db.prepare(
    `UPDATE l2_sources SET status='failed', error=?, updated_at=?
      WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
  ).run(String(error || '').slice(0, 500), now(), userId, deviceCode, agent, sessionId);
}

/** 派生成功：落内容指纹与操作计数 */
function saveL2Done({ userId, deviceCode, agent, sessionId, contentHash = null, added = 0, updated = 0, deleted = 0, noop = 0, model = null }) {
  db.prepare(
    `UPDATE l2_sources
        SET status='done', content_hash=?, error=NULL, added=?, updated=?, deleted=?, noop=?, model=?, updated_at=?
      WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
  ).run(contentHash, added, updated, deleted, noop, model, now(), userId, deviceCode, agent, sessionId);
}

/** 无内容可派生（摘要为空）也记 done，避免每轮重复扫描 */
function resetStuckL2() {
  return db.prepare("UPDATE l2_sources SET status='pending' WHERE status='running'").run().changes;
}

/** 派生统计（供 REST/前端） */
function l2Stats(userId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
              SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,
              SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed
         FROM l2_sources WHERE user_id = ?`
    )
    .get(userId);
  const sums = db
    .prepare(
      `SELECT SUM(added) added, SUM(updated) updated, SUM(deleted) deleted, SUM(noop) noop
         FROM l2_sources WHERE user_id = ? AND status = 'done'`
    )
    .get(userId);
  return {
    total: row.total || 0,
    pending: row.pending || 0,
    running: row.running || 0,
    done: row.done || 0,
    failed: row.failed || 0,
    backlog: (row.pending || 0) + (row.running || 0),
    facts: {
      added: sums.added || 0,
      updated: sums.updated || 0,
      deleted: sums.deleted || 0,
      noop: sums.noop || 0,
    },
  };
}

/** 派生明细（哪些会话派生过、产生了什么） */
function listL2Sources(userId, limit = 200) {
  return db
    .prepare(
      `SELECT device_code, agent, session_id, status, attempts, error,
              added, updated, deleted, noop, model, updated_at
         FROM l2_sources WHERE user_id = ?
        ORDER BY updated_at DESC LIMIT ?`
    )
    .all(userId, Math.max(1, Math.min(Number(limit) || 200, 1000)));
}

/** 已完成的 L2 派生（供 L3 凝练做游标消费：只取 updated_at 晚于游标的） */
function doneSourcesSince(userId, sinceIso) {
  return db
    .prepare(
      `SELECT device_code, agent, session_id, updated_at
         FROM l2_sources
        WHERE user_id = ? AND status = 'done' AND updated_at > ?
        ORDER BY updated_at ASC`
    )
    .all(userId, sinceIso || '');
}

/** 最近完成的 L2 派生（时间正序；L3 手动触发在无新增时兜底用） */
function recentDoneSources(userId, limit) {
  return db
    .prepare(
      `SELECT device_code, agent, session_id, updated_at
         FROM l2_sources WHERE user_id = ? AND status = 'done'
        ORDER BY updated_at DESC LIMIT ?`
    )
    .all(userId, Math.max(1, Number(limit) || 5))
    .reverse();
}

module.exports = {
  insertFact, updateFact, deleteFact, getFact, recentFacts, factsByIds,
  recordOp, listOps, opStats,
  l1DoneSummaries, getL1DoneSummary, l2Existing, ensureL2Pending, requeueL2, pickL2Pending,
  doneSourcesSince, recentDoneSources,
  markL2Running, markL2Failed, saveL2Done, resetStuckL2, l2Stats, listL2Sources,
  MAX_TEXT,
};
