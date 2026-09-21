'use strict';

/**
 * 身份与鉴权中间件（单用户部署）：
 * - Token（Authorization: Token m0-xxx，机器到机器）
 * - Web 会话 cookie（aim_session，口令登录）
 * 解析出的身份 = { userId, via, username }；所有数据访问强制 user_id 归属。
 * 独立成模块的原因：web/routes（管理台面）与 api/mem0（mem0 兼容面）共用，
 * 放在 routes 里会让 mem0 面反向依赖 web 面，模块边界模糊。
 */

const tokens = require('./tokens');
const repo = require('../db/repo');

/** 从请求解析当前用户：优先 API key，其次 Web 会话 */
function resolveIdentity(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Token\s+(.+)$/i);
  if (m) {
    const userId = tokens.verify(m[1].trim());
    if (userId) return { userId, via: 'token', username: null };
  }
  const sid = req.cookies?.aim_session;
  if (sid) {
    const s = repo.getSession(sid);
    if (s) return { userId: s.user_id, via: 'session', username: s.username || null };
  }
  return null;
}

function requireAuth(req, res, next) {
  const id = resolveIdentity(req);
  if (!id) {
    return res.status(401).json({ error: '未授权：请携带 Authorization: Token m0-xxx，或先在 Web 页登录' });
  }
  req.identity = id;
  next();
}

module.exports = { resolveIdentity, requireAuth };
