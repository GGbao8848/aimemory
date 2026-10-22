'use strict';

// 接入与身份域：用户（Keycloak 建档）、API Token（多 Token 并存、单独吊销）与 Web 会话。

const db = require('../index');
const { now, uuid } = require('./_common');

// ============ 用户（多租户：Keycloak 登录时自动建档） ============

/** 登录即建档/刷新：sub 为唯一身份，其余字段以 Keycloak claims 为准覆盖 */
function upsertUser({ id, username, name = null, email = null }) {
  db.prepare(`
    INSERT INTO users (id, username, name, email, created_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      name = excluded.name,
      email = excluded.email,
      last_login_at = excluded.last_login_at
  `).run(id, username, name, email, now(), now());
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

/** 按 id / username / email 定位用户（迁移脚本按名字找目标用户用） */
function findUserByIdentifier(identifier) {
  return (
    db.prepare('SELECT * FROM users WHERE id = ?').get(identifier) ||
    db.prepare('SELECT * FROM users WHERE username = ?').get(identifier) ||
    db.prepare('SELECT * FROM users WHERE email = ?').get(identifier) ||
    null
  );
}

function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
}

// ============ API Token（多 Token 并存：按客户端签发，单独吊销） ============

function createApiKey({ userId, name, tokenHash }) {
  const row = {
    id: uuid(),
    user_id: userId,
    name,
    token_hash: tokenHash,
    created_at: now(),
    revoked_at: null,
  };
  // 多 Token 并存：每条独立签发、单独吊销，签发不影响该用户已有 Token。
  // 不存明文（G3）：明文只在创建响应里返回一次。
  db.prepare(
    'INSERT INTO api_keys (id, user_id, name, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(row.id, row.user_id, row.name, row.token_hash, row.created_at, row.revoked_at);
  return row;
}

function listApiKeys(userId) {
  return db
    .prepare('SELECT id, user_id, name, created_at, revoked_at FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC')
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

function createSession(id, userId, ttlMs, username = null) {
  const ts = now();
  db.prepare(
    'INSERT INTO sessions (id, user_id, username, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, userId, username, ts, new Date(Date.now() + ttlMs).toISOString());
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
  upsertUser,
  getUser,
  findUserByIdentifier,
  listUsers,
  createApiKey,
  listApiKeys,
  findUserIdByTokenHash,
  revokeApiKey,
  createSession,
  getSession,
  deleteSession,
  cleanupSessions,
};
