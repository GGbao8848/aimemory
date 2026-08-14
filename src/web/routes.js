'use strict';

/**
 * REST /api + Web 会话辅助。
 * - 鉴权：Authorization: Token m0-xxx（API key）或 aim_session cookie（Keycloak 登录会话）
 * - 所有数据访问强制 user_id 隔离
 */
const express = require('express');
const repo = require('../db/repo');
const tokens = require('../auth/tokens');
const config = require('../config');

const apiRouter = express.Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (!res.headersSent) res.status(500).json({ error: e.message });
  else res.end();
});

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
    return res.status(401).json({ error: '未授权：请携带 Authorization: Token m0-xxx 或先登录 Web 平台' });
  }
  req.identity = id;
  next();
}

/** 构造回调地址：PUBLIC_BASE_URL 优先，否则用请求来源 Host */
function buildRedirectUri(req, pathname = '/auth/callback') {
  const base = config.publicBaseUrl || `http://${req.get('host')}`;
  return `${base}${pathname}`;
}

apiRouter.get('/me', wrap(async (req, res) => {
  const id = resolveIdentity(req);
  if (!id) return res.status(401).json({ error: '未授权' });
  res.json({ userId: id.userId, username: id.username, via: id.via });
}));

// ===== 记忆 CRUD =====

apiRouter.get('/memories', requireAuth, wrap(async (req, res) => {
  const { page = 1, page_size = 10, q } = req.query;
  if (q) {
    const results = repo.searchMemories({ userId: req.identity.userId, query: String(q), limit: 100 });
    // 与列表接口保持同构：分页字段由后端补齐（搜索不翻页，返回全部命中）
    res.json({ results, total: results.length, page: 1, page_size: 100 });
  } else {
    res.json(repo.listMemories({ userId: req.identity.userId, page: Number(page), pageSize: Number(page_size) }));
  }
}));

apiRouter.post('/memories', requireAuth, wrap(async (req, res) => {
  const { text, metadata } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text 不能为空' });
  const mem = repo.createMemory({ userId: req.identity.userId, text: String(text), metadata });
  res.status(201).json(mem);
}));

apiRouter.get('/memories/:id', requireAuth, wrap(async (req, res) => {
  const mem = repo.getMemory(req.params.id, req.identity.userId);
  if (!mem) return res.status(404).json({ error: '记忆不存在' });
  res.json(mem);
}));

apiRouter.patch('/memories/:id', requireAuth, wrap(async (req, res) => {
  const { text, metadata } = req.body || {};
  const mem = repo.updateMemory({ id: req.params.id, userId: req.identity.userId, text, metadata });
  if (!mem) return res.status(404).json({ error: '记忆不存在' });
  res.json(mem);
}));

apiRouter.delete('/memories/:id', requireAuth, wrap(async (req, res) => {
  if (!repo.deleteMemory(req.params.id, req.identity.userId)) {
    return res.status(404).json({ error: '记忆不存在' });
  }
  res.json({ success: true });
}));

// ===== API Key =====

apiRouter.post('/keys', requireAuth, wrap(async (req, res) => {
  const { name } = req.body || {};
  res.status(201).json(tokens.createApiKey(req.identity.userId, name || 'default'));
}));

apiRouter.get('/keys', requireAuth, wrap(async (req, res) => {
  res.json({ results: tokens.listApiKeys(req.identity.userId) });
}));

apiRouter.post('/keys/:id/revoke', requireAuth, wrap(async (req, res) => {
  if (!tokens.revokeApiKey(req.params.id, req.identity.userId)) {
    return res.status(404).json({ error: '密钥不存在或已吊销' });
  }
  res.json({ success: true });
}));

// ===== 连接码兑换（半自动连接）=====
// 码即凭据：浏览器授权后页面展示短码 → agent 端带码调用本接口换取密钥。
// 码一次性、10 分钟 TTL，兑换后即失效；明文密钥仅在 TTL 窗口内存在于码表。

apiRouter.post('/connect/claim', wrap(async (req, res) => {
  const code = String((req.body || {}).code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: '缺少连接码' });
  const result = repo.consumeConnectCode(code);
  if (!result) {
    return res.status(400).json({ error: '连接码无效、已使用或已过期，请重新打开授权页获取新码' });
  }
  res.json({
    user_id: result.user_id,
    api_key: result.api_key,
    mcp_url: `${config.publicBaseUrl || `http://${req.get('host')}`}/mcp`,
  });
}));

// ===== 会话审计（企业 agent 全程记录）=====
// 上报：员工本地 agent（opencode）的会话 export 定时 POST 到此，带个人 API Key 鉴权。
// 查询：仅本人可见；审计数据服务端留存，员工本地删了也无所谓。

apiRouter.post('/audit/sessions', requireAuth, wrap(async (req, res) => {
  const body = req.body || {};
  const sessionId = String(body.session_id || body.id || '').trim();
  if (!sessionId) return res.status(400).json({ error: '缺少 session_id' });
  if (!Array.isArray(body.messages)) return res.status(400).json({ error: 'messages 必须是数组' });
  const r = repo.upsertAuditSession({
    sessionId,
    userId: req.identity.userId,
    agent: String(body.agent || 'opencode').slice(0, 32),
    title: body.title ? String(body.title).slice(0, 300) : null,
    messages: body.messages,
    tokenUsage: body.token_usage && typeof body.token_usage === 'object' ? body.token_usage : null,
    startedAt: body.started_at ? String(body.started_at) : null,
    endedAt: body.ended_at ? String(body.ended_at) : null,
  });
  res.status(r.created ? 201 : 200).json(r);
}));

apiRouter.get('/audit/sessions', requireAuth, wrap(async (req, res) => {
  const { q, page = 1, page_size = 20 } = req.query;
  res.json(repo.listAuditSessions({ userId: req.identity.userId, q: q ? String(q) : undefined, page: Number(page), pageSize: Number(page_size) }));
}));

apiRouter.get('/audit/sessions/:id', requireAuth, wrap(async (req, res) => {
  const s = repo.getAuditSession(req.params.id, req.identity.userId);
  if (!s) return res.status(404).json({ error: '审计记录不存在' });
  res.json(s);
}));

module.exports = { apiRouter, resolveIdentity, buildRedirectUri };
