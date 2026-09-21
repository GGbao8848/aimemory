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
const settings = require('../settings');
const vec = require('../l2/vec');
const entityStore = require('../l2/entities');
const { resolveIdentity, requireAuth } = require('../auth/identity');
const l2store = require('../l2/store');
const webhooks = require('../l2/webhooks');

const apiRouter = express.Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (!res.headersSent) res.status(500).json({ error: e.message });
  else res.end();
});

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

// ===== Dashboard（概览聚合）=====

apiRouter.get('/dashboard', requireAuth, wrap(async (req, res) => {
  res.json(repo.dashboard(req.identity.userId));
}));

// ===== 活动日志（Requests：memory_ops 分页）=====

apiRouter.get('/ops', requireAuth, wrap(async (req, res) => {
  const { page = 1, page_size = 20 } = req.query;
  res.json(l2store.listOpsPaged(req.identity.userId, Number(page), Number(page_size)));
}));

// ===== 素材归档与重提（提炼有损时的回溯手段）=====

apiRouter.get('/raw-materials', requireAuth, wrap(async (req, res) => {
  const { page = 1, page_size = 20 } = req.query;
  res.json(repo.listRawMaterials(req.identity.userId, Number(page), Number(page_size)));
}));

// 重提：ids 为空且 all=true → 全库；否则按 ids 批量/单条。
// 语义：删除该素材上次提炼的记忆 → 原文重新入队走完整管线（换模型/不满意时用）。
apiRouter.post('/raw-materials/reextract', requireAuth, wrap(async (req, res) => {
  const { ids, all } = req.body || {};
  if (!Array.isArray(ids) && all !== true) {
    return res.status(400).json({ error: '请提供 ids 数组（单条/批量）或 all: true（全库重提）' });
  }
  if (Array.isArray(ids) && !ids.length) {
    return res.status(400).json({ error: 'ids 不能为空' });
  }
  const r = repo.reextractRawMaterials({ userId: req.identity.userId, ids: Array.isArray(ids) ? ids.map(String) : null });
  res.json(r);
}));

// ===== Webhooks（对齐 mem0 平台：记忆变更实时通知外部系统）=====

apiRouter.get('/webhooks', requireAuth, wrap(async (req, res) => {
  res.json({ results: webhooks.listWebhooks(req.identity.userId) });
}));

apiRouter.post('/webhooks', requireAuth, wrap(async (req, res) => {
  const { url, description, events } = req.body || {};
  if (!url || !/^https?:\/\//.test(String(url))) {
    return res.status(400).json({ error: 'url 必填且以 http:// 或 https:// 开头' });
  }
  const ev = Array.isArray(events) && events.length
    ? events.filter((e) => ['ADD', 'UPDATE', 'DELETE'].includes(e))
    : ['ADD', 'UPDATE', 'DELETE'];
  if (!ev.length) return res.status(400).json({ error: 'events 至少订阅一种操作（ADD/UPDATE/DELETE）' });
  res.status(201).json(webhooks.createWebhook({ userId: req.identity.userId, url: String(url), description: String(description || ''), events: ev }));
}));

apiRouter.patch('/webhooks/:id', requireAuth, wrap(async (req, res) => {
  try {
    const hook = webhooks.updateWebhook(req.params.id, req.identity.userId, req.body || {});
    if (!hook) return res.status(404).json({ error: 'webhook 不存在' });
    res.json(hook);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

apiRouter.delete('/webhooks/:id', requireAuth, wrap(async (req, res) => {
  if (!webhooks.deleteWebhook(req.params.id, req.identity.userId)) {
    return res.status(404).json({ error: 'webhook 不存在' });
  }
  res.json({ success: true });
}));

apiRouter.get('/webhooks/:id/deliveries', requireAuth, wrap(async (req, res) => {
  res.json({ results: webhooks.listDeliveries(req.params.id, req.identity.userId) });
}));

// 查询素材提炼事件状态（Web 新增记忆异步受理后轮询用；与 MCP get_event_status 同源）
apiRouter.get('/events/:id', requireAuth, wrap(async (req, res) => {
  const ev = repo.getEvent(req.params.id, req.identity.userId);
  if (!ev) return res.status(404).json({ error: '事件不存在' });
  res.json({ event: ev });
}));

// ===== 记忆 CRUD =====

apiRouter.get('/memories', requireAuth, wrap(async (req, res) => {
  const { page = 1, page_size = 10, q, entity, category, agent_id, run_id } = req.query;
  // entity/category 走服务端过滤（关联表/JSON 列，客户端做不了）；agent/run 亦顺带支持
  const filters = {};
  if (entity) filters.entity = String(entity);
  if (category) filters.category = String(category);
  if (agent_id) filters.agent_id = String(agent_id);
  if (run_id) filters.run_id = String(run_id);
  if (q) {
    const results = await repo.searchMemories({ userId: req.identity.userId, query: String(q), limit: 100, filters });
    // 与列表接口保持同构：分页字段由后端补齐（搜索不翻页，返回全部命中）
    res.json({ results, total: results.length, page: 1, page_size: 100 });
  } else {
    res.json(repo.listMemories({ userId: req.identity.userId, page: Number(page), pageSize: Number(page_size), filters }));
  }
}));

// ===== 实体与分类（对齐 mem0 平台语义） =====

// 作用域实体（mem0 Entities 页语义）：user/agent/run 三类记忆归属维度 + 记忆数 + 最近更新
apiRouter.get('/entities', requireAuth, wrap(async (req, res) => {
  res.json({ results: entityStore.listScopes(req.identity.userId, config.userName) });
}));

// 抽取专名清单（从记忆文本抽取的名词，供记忆页"关键词"过滤）
apiRouter.get('/keywords', requireAuth, wrap(async (req, res) => {
  res.json({ results: entityStore.listEntities(req.identity.userId) });
}));

apiRouter.get('/categories', requireAuth, wrap(async (req, res) => {
  res.json({ results: entityStore.listCategories(req.identity.userId) });
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
  // 导出当前用户全部记忆（数据可携带性 / 备份）。format=json（默认，含 metadata/facts/entities）| csv（表格）
  const memories = repo.exportMemories(req.identity.userId);
  const stamp = new Date().toISOString().slice(0, 10);
  const format = req.query.format === 'csv' ? 'csv' : 'json';

  if (format === 'csv') {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['id', 'text', 'origin', 'categories', 'entities', 'agent_id', 'run_id', 'created_at', 'updated_at'];
    const rows = memories.map((m) => [
      m.id, m.text, m.origin || 'direct',
      (m.categories || []).join('|'), (m.entities || []).join('|'),
      m.agent_id || '', m.run_id || '', m.created_at, m.updated_at,
    ].map(esc).join(','));
    const csv = '\ufeff' + [header.join(','), ...rows].join('\r\n'); // BOM：Excel 中文不乱码
    res.setHeader('Content-Disposition', `attachment; filename="aimemory-memories-${stamp}.csv"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send(csv);
  }

  const payload = {
    exported_at: new Date().toISOString(),
    user_id: req.identity.userId,
    username: req.identity.username || null,
    count: memories.length,
    memories,
  };
  const filename = `aimemory-memories-${stamp}.json`;
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

// ===== 设置（LLM/Embedding 接入参数 + 功能开关；仅 Web 登录者可读写） =====

apiRouter.get('/settings', requireAuth, wrap(async (req, res) => {
  res.json(settings.get());
}));

apiRouter.put('/settings', requireAuth, wrap(async (req, res) => {
  try {
    res.json(settings.update(req.body));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
}));

// 连通性测试：直连发一次最小请求（不经客户端熔断），返回耗时与错误详情
apiRouter.post('/settings/test', requireAuth, wrap(async (req, res) => {
  const target = (req.body || {}).target;
  if (target !== 'llm' && target !== 'embedding') {
    return res.status(400).json({ error: "target 必须是 'llm' 或 'embedding'" });
  }
  res.json(await settings.probe(target));
}));

// 明文查看已配置密钥（设置页「小眼睛」按需点击时调用；/settings GET 响应永远只含脱敏预览）
apiRouter.post('/settings/reveal', requireAuth, wrap(async (req, res) => {
  try {
    res.json(settings.reveal((req.body || {}).section));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
}));

// 向量索引重建：换 embedding 模型（维度变化）后必须 reset 重建；增量模式只补缺失的
apiRouter.post('/settings/vec-rebuild', requireAuth, wrap(async (req, res) => {
  if (!config.embedding.enabled) {
    return res.status(400).json({ error: 'embedding 未启用：先在设置页启用并保存后再重建向量索引' });
  }
  const reset = (req.body || {}).reset === true;
  const r = vec.rebuild({ userId: req.identity.userId, reset });
  if (!r.ok) return res.status(500).json({ error: r.reason || '向量索引重建失败' });
  res.json(r);
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