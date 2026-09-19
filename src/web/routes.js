'use strict';

/**
 * REST /api 管理台自用面。
 * - 鉴权：Authorization: Token m0-xxx（API key）或 aim_session cookie（Web 口令登录会话）
 * - 所有数据访问强制 user_id 隔离
 * - 对外的 mem0 形态 API（/v1 /v2）见 src/api/mem0.js
 */
const express = require('express');
const path = require('path');
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
    return res.status(401).json({ error: '未授权：请携带 Authorization: Token m0-xxx，或先在 Web 页登录' });
  }
  req.identity = id;
  next();
}

apiRouter.get('/me', wrap(async (req, res) => {
  const id = resolveIdentity(req);
  if (!id) return res.status(401).json({ error: '未授权' });
  res.json({ userId: id.userId, username: id.username, via: id.via });
}));

// REST 契约直出（公开）：文档即代码，路径/方法集由 test/api-contract.test.js 守护与实现同步
apiRouter.get('/openapi.json', (_req, res) => {
  res.type('application/json').sendFile(path.join(config.root, 'docs', 'api', 'openapi.json'));
});

apiRouter.get('/stats', requireAuth, wrap(async (req, res) => {
  res.json(repo.stats(req.identity.userId));
}));

// 查询素材提炼事件状态（Web 新增记忆异步受理后轮询用；与 MCP get_event_status 同源）
apiRouter.get('/events/:id', requireAuth, wrap(async (req, res) => {
  const ev = repo.getEvent(req.params.id, req.identity.userId);
  if (!ev) return res.status(404).json({ error: '事件不存在' });
  res.json({ event: ev });
}));

// ===== 记忆 CRUD =====

apiRouter.get('/memories', requireAuth, wrap(async (req, res) => {
  const { page = 1, page_size = 10, q } = req.query;
  if (q) {
    const results = await repo.searchMemories({ userId: req.identity.userId, query: String(q), limit: 100 });
    // 与列表接口保持同构：分页字段由后端补齐（搜索不翻页，返回全部命中）
    res.json({ results, total: results.length, page: 1, page_size: 100 });
  } else {
    res.json(repo.listMemories({ userId: req.identity.userId, page: Number(page), pageSize: Number(page_size) }));
  }
}));

apiRouter.post('/memories', requireAuth, wrap(async (req, res) => {
  // 素材写入：与 MCP 一致的语义——异步受理，后台 LLM 提炼后入库（不存原文）。
  // 返回 202 + event_id，前端轮询 get_event_status / 刷新列表。
  const { text, metadata } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text 不能为空' });
  let result;
  try {
    result = repo.createMemory({ userId: req.identity.userId, text: String(text), metadata });
  } catch (e) {
    // LLM 未启用等原因 → 无法提炼，明确拒绝（不让素材"收了但不处理"）
    return res.status(503).json({ error: e.message });
  }
  res.status(202).json(result);
}));

apiRouter.get('/memories/export', requireAuth, wrap(async (req, res) => {
  // 导出当前用户全部记忆（JSON 附件下载；数据可携带性 / 备份）
  const memories = repo.exportMemories(req.identity.userId);
  const payload = {
    exported_at: new Date().toISOString(),
    user_id: req.identity.userId,
    username: req.identity.username || null,
    count: memories.length,
    memories,
  };
  const filename = `aimemory-memories-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(payload, null, 2));
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
  // 改了文本才值得重消解；后台异步，绝不阻塞响应、失败静默（评估轮 Q5）
  if (text !== undefined) {
    require('../l2/reconcile').reconcileAfterUpdate({ userId: req.identity.userId, memoryId: mem.id }).catch(() => {});
  }
  res.json(mem);
}));

apiRouter.delete('/memories/:id', requireAuth, wrap(async (req, res) => {
  if (!repo.deleteMemory(req.params.id, req.identity.userId)) {
    return res.status(404).json({ error: '记忆不存在' });
  }
  res.json({ success: true });
}));

// ===== API Token（一名用户可持有多条命名 Token：按客户端分别签发、单独吊销） =====

apiRouter.post('/keys', requireAuth, wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 50);
  if (!name) return res.status(400).json({ error: 'Token 名称不能为空' });
  // 同名生效 Token 拒绝签发，避免列表歧义；同名但已吊销的不受影响
  const dup = tokens.listApiKeys(req.identity.userId).some((k) => k.name === name);
  if (dup) return res.status(409).json({ error: `同名 Token 已存在：${name}（请换个名称，或先吊销旧的）` });
  const key = tokens.createApiKey(req.identity.userId, name);
  res.status(201).json(key);
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

module.exports = { apiRouter, resolveIdentity };
