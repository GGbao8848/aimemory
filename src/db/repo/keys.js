'use strict';

// 接入与身份域：API Token（多 Token 并存、单独吊销）、Web 会话、设备流连接（零粘贴授权）。

const crypto = require('crypto');
const db = require('../index');
const { now, uuid } = require('./_common');

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

// ============ 设备流连接（零粘贴员工接入） ============

const REQ_TTL_MS = 10 * 60 * 1000; // 10 分钟

/** 生成 32 位随机请求 id（agent 轮询凭据） */
function generateRequestId() {
  return crypto.randomBytes(24).toString('hex');
}

/** 创建设备流连接请求（匿名 pending，不建 key）；返回 { request_id }
 *  confirmToken（可选）：agent 侧随机令牌，拼进 authorize_url；/connect 页校验匹配后免按钮自动授权。
 */
function createConnectRequest(confirmToken = null) {
  const requestId = generateRequestId();
  const ts = now();
  db.prepare(
    `INSERT INTO connect_requests (request_id, user_id, status, created_at, expires_at, confirm_token)
     VALUES (?, NULL, 'pending', ?, ?, ?)`
  ).run(requestId, ts, new Date(Date.now() + REQ_TTL_MS).toISOString(), confirmToken || null);
  return { request_id: requestId };
}

/** 校验某请求是否允许「免按钮自动授权」：request 存在、pending、未过期、confirm_token 匹配 */
function canAutoConfirm(requestId, confirmToken) {
  if (!requestId || !confirmToken) return false;
  const row = db.prepare('SELECT * FROM connect_requests WHERE request_id = ?').get(requestId);
  if (!row) return false;
  if (row.status !== 'pending') return false;
  if (row.expires_at <= now()) return false;
  return !!row.confirm_token && row.confirm_token === confirmToken;
}

/** 确认授权：绑定当前登录用户 + 生成 API Key；返回 { token, key_name } */
function confirmConnectRequest(requestId, userId, name) {
  const row = db.prepare('SELECT * FROM connect_requests WHERE request_id = ?').get(requestId);
  if (!row) return null;
  if (row.status !== 'pending') return null;
  if (row.user_id && row.user_id !== userId) return null; // 已被他人绑定
  if (row.expires_at <= now()) {
    db.prepare("UPDATE connect_requests SET status='expired' WHERE request_id=?").run(requestId);
    return null;
  }
  // 授权即签发新 Token（多 Token 并存，已有 Token 不受影响）；名称必填，由调用方保证非空
  const safeName = String(name || '').trim().slice(0, 50);
  if (!safeName) return null;
  const { token, id: keyId } = require('../../auth/tokens').createApiKey(userId, safeName);
  db.prepare(
    `UPDATE connect_requests SET status='authorized', user_id=?, key_name=?, api_key_id=?, token_plain=?, confirmed_at=? WHERE request_id=?`
  ).run(userId, safeName, keyId, token, now(), requestId);
  return { token, key_name: safeName, api_key_id: keyId };
}

/** 轮询授权状态：authorized 返回 { token, key_name }，pending 返回 null，过期返回 'expired' */
function pollConnectRequest(requestId) {
  const row = db.prepare('SELECT * FROM connect_requests WHERE request_id = ?').get(requestId);
  if (!row) return 'expired';
  if (row.status === 'authorized') {
    return { token: row.token_plain, key_name: row.key_name, api_key_id: row.api_key_id };
  }
  if (row.expires_at <= now()) {
    db.prepare("UPDATE connect_requests SET status='expired' WHERE request_id=?").run(requestId);
    return 'expired';
  }
  return null;
}

/** 清理过期/已确认的请求（明文随之删除） */
function cleanupConnectRequests() {
  db.prepare("DELETE FROM connect_requests WHERE status != 'pending' OR expires_at <= ?").run(now());
}

module.exports = {
  createApiKey,
  listApiKeys,
  findUserIdByTokenHash,
  revokeApiKey,
  createSession,
  getSession,
  deleteSession,
  cleanupSessions,
  createConnectRequest,
  canAutoConfirm,
  confirmConnectRequest,
  pollConnectRequest,
  cleanupConnectRequests,
};
