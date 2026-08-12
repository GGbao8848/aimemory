'use strict';

const crypto = require('crypto');
const db = require('./index');

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const toObj = (row) =>
  row ? { ...row, metadata: JSON.parse(row.metadata || '{}') } : null;

function clamp(n, min, max, def) {
  const v = Number.parseInt(n, 10);
  if (Number.isNaN(v)) return def;
  return Math.min(Math.max(v, min), max);
}

// ============ 记忆 CRUD（所有查询强制 user_id 隔离） ============

function getMemoryRow(id, userId) {
  return db
    .prepare('SELECT * FROM memories WHERE id = ? AND user_id = ?')
    .get(id, userId);
}

function getHistory(memoryId, userId) {
  return db
    .prepare(
      `SELECT event_type, prev_text, prev_metadata, prev_updated_at, created_at
       FROM memories_history WHERE memory_id = ? AND user_id = ?
       ORDER BY id ASC`
    )
    .all(memoryId, userId)
    .map((h) => ({
      event_type: h.event_type,
      prev_value: {
        text: h.prev_text,
        metadata: JSON.parse(h.prev_metadata || '{}'),
        updated_at: h.prev_updated_at,
      },
      created_at: h.created_at,
    }));
}

function createMemory({ userId, text, metadata = {} }) {
  const id = uuid();
  const ts = now();
  db.prepare(
    'INSERT INTO memories (id, user_id, text, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, userId, text, JSON.stringify(metadata || {}), ts, ts);
  return toObj(getMemoryRow(id, userId));
}

function getMemory(id, userId) {
  const row = getMemoryRow(id, userId);
  if (!row) return null;
  return { ...toObj(row), history: getHistory(id, userId) };
}

function listMemories({ userId, page = 1, pageSize = 10 }) {
  page = clamp(page, 1, 100000, 1);
  pageSize = clamp(pageSize, 1, 100, 10);
  const total = db
    .prepare('SELECT COUNT(*) AS c FROM memories WHERE user_id = ?')
    .get(userId).c;
  const rows = db
    .prepare(
      'SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?'
    )
    .all(userId, pageSize, (page - 1) * pageSize);
  return { results: rows.map(toObj), total, page, pageSize };
}

function searchMemories({ userId, query, limit = 10 }) {
  limit = clamp(limit, 1, 100, 10);
  const q = (query || '').trim();
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  // 1. FTS5 trigram 候选：>=3 字符的词 AND 匹配（trigram 无法索引 1-2 字符片段）
  const ftsWords = words.filter((w) => w.length >= 3);
  let rows = [];
  if (ftsWords.length) {
    const match = ftsWords.map((w) => `"${w.replace(/"/g, '""')}"`).join(' AND ');
    rows = db
      .prepare(
        `SELECT m.id, m.text, m.metadata, m.created_at, m.updated_at, bm25(memories_fts) AS score
         FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.user_id = ? ORDER BY score LIMIT 500`
      )
      .all(match, userId);
  }
  // 2. FTS 无候选（全为短词）→ 全表兜底
  if (!rows.length) {
    rows = db
      .prepare(
        `SELECT id, text, metadata, created_at, updated_at, 0 AS score
         FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500`
      )
      .all(userId);
  }
  // 3. LIKE 二次过滤：每个词都必须出现（覆盖 2 字符中文词如"端口"）
  const filtered = rows.filter((m) => words.every((w) => m.text.includes(w)));
  return filtered.slice(0, limit).map(toObj);
}

function updateMemory({ id, userId, text, metadata }) {
  const existing = getMemoryRow(id, userId);
  if (!existing) return null;
  const ts = now();
  const newText = text !== undefined ? String(text) : existing.text;
  const newMeta =
    metadata !== undefined ? JSON.stringify(metadata) : existing.metadata;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO memories_history
       (memory_id, user_id, event_type, prev_text, prev_metadata, prev_updated_at, created_at)
       VALUES (?, ?, 'UPDATE', ?, ?, ?, ?)`
    ).run(id, userId, existing.text, existing.metadata, existing.updated_at, ts);
    db.prepare('UPDATE memories SET text = ?, metadata = ?, updated_at = ? WHERE id = ?').run(
      newText, newMeta, ts, id
    );
  });
  tx();
  return toObj(getMemoryRow(id, userId));
}

function deleteMemory(id, userId) {
  const existing = getMemoryRow(id, userId);
  if (!existing) return false;
  const ts = now();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO memories_history
       (memory_id, user_id, event_type, prev_text, prev_metadata, prev_updated_at, created_at)
       VALUES (?, ?, 'DELETE', ?, ?, ?, ?)`
    ).run(id, userId, existing.text, existing.metadata, existing.updated_at, ts);
    db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(id, userId);
  });
  tx();
  return true;
}

// ============ API Key ============

function createApiKey({ userId, name = 'default', tokenHash }) {
  const row = {
    id: uuid(),
    user_id: userId,
    name,
    token_hash: tokenHash,
    created_at: now(),
    revoked_at: null,
  };
  db.prepare(
    'INSERT INTO api_keys (id, user_id, name, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(row.id, row.user_id, row.name, row.token_hash, row.created_at, row.revoked_at);
  return row;
}

function listApiKeys(userId) {
  return db
    .prepare(
      'SELECT id, user_id, name, created_at, revoked_at FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC'
    )
    .all(userId);
}

function findUserIdByTokenHash(tokenHash) {
  const row = db
    .prepare('SELECT user_id FROM api_keys WHERE token_hash = ? AND revoked_at IS NULL')
    .get(tokenHash);
  return row ? row.user_id : null;
}

function revokeApiKey(id, userId) {
  const res = db
    .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .run(now(), id, userId);
  return res.changes > 0;
}

// ============ Web 会话 ============

function createSession(id, userId, ttlMs) {
  const ts = now();
  db.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(id, userId, ts, new Date(Date.now() + ttlMs).toISOString());
}

function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(id, now());
}

function deleteSession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

function cleanupSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}

module.exports = {
  createMemory,
  getMemory,
  listMemories,
  searchMemories,
  updateMemory,
  deleteMemory,
  createApiKey,
  listApiKeys,
  findUserIdByTokenHash,
  revokeApiKey,
  createSession,
  getSession,
  deleteSession,
  cleanupSessions,
};
