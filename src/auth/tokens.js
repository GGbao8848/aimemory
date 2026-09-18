'use strict';

/**
 * API Token（m0- 前缀，与 mem0 云 key 形态一致）：
 * 生成 / 哈希 / 校验。校验走 sha256（token_hash），明文另存 token_plain 供 Web 端随时回看。
 */
const crypto = require('crypto');
const repo = require('../db/repo');

const PREFIX = 'm0-';

function generateApiKey() {
  return PREFIX + crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** 创建 Token，返回 { token(明文), id, name, created_at }；name 必填（调用方校验非空） */
function createApiKey(userId, name) {
  const token = generateApiKey();
  const row = repo.createApiKey({ userId, name, tokenHash: hashToken(token), tokenPlain: token });
  return {
    token,
    id: row.id,
    name: row.name,
    created_at: row.created_at,
  };
}

/** 列出该用户的生效 Token（含明文，供 Web 端随时回看） */
function listApiKeys(userId) {
  return repo.listApiKeys(userId).map(({ id, name, token_plain, created_at }) => ({
    id,
    name,
    token: token_plain,
    created_at,
  }));
}

/** 生成不与现有生效 Token 重名的名称：base、base-2、base-3…（无人值守授权路径用） */
function uniqueName(userId, base) {
  const taken = new Set(repo.listApiKeys(userId).map((k) => k.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function revokeApiKey(id, userId) {
  return repo.revokeApiKey(id, userId);
}

/** 校验 Token m0-xxx，返回 user_id 或 null */
function verify(token) {
  if (!token || !token.startsWith(PREFIX)) return null;
  return repo.findUserIdByTokenHash(hashToken(token));
}

module.exports = { createApiKey, listApiKeys, uniqueName, revokeApiKey, verify, hashToken };
