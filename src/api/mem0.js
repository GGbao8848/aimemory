'use strict';

/**
 * mem0 形态 REST API（对外接入面，路径与方法对齐 mem0 平台 API 的常用子集）：
 *
 *   POST   /v1/memories/            add（infer=true 异步提炼返回 event_id；infer=false 原文直存）
 *   POST   /v2/memories/search/     语义 + 关键词混合检索
 *   POST   /v2/memories/            get_all（filters + 分页）
 *   GET    /v1/memories/{id}/       单条
 *   PUT    /v1/memories/{id}/       更新 text/metadata
 *   DELETE /v1/memories/{id}/       删除单条
 *   GET    /v1/memories/{id}/history/  变更历史（ADD/UPDATE/DELETE）
 *   DELETE /v1/memories/            按作用域批量删除（异步，返回 event_id）
 *   GET    /v1/event/{event_id}/    异步事件状态轮询
 *
 * 鉴权：Authorization: Token m0-xxx（与 Web 会话 cookie 亦可）。响应的文本字段名是
 * mem0 的 `memory`（内部仍存 text，此处映射）。
 *
 * 作用域模型（mem0 的 user_id/agent_id/run_id 三维度）：
 * - user_id：账号维度。必须省略或等于鉴权主体（个人自托管，Token 即身份）；
 *   省略时默认主体。传入其他用户 → 403（防串账本）。
 * - agent_id / run_id：自由标签维度（哪个 agent、哪次会话写入），可精确过滤。
 * - mem0 语义中批量删除支持 '*'（全选该维度）。
 * - filters 支持 {user_id, agent_id, run_id, metadata, created_at/updated_at 范围}
 *   与 AND 数组（展开合并）；OR/NOT 暂不支持（明确报错，不做静默错误结果）。
 */

const express = require('express');
const repo = require('../db/repo');
const l2store = require('../l2/store');
const { resolveIdentity } = require('../web/routes');

const router = express.Router();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (!res.headersSent) res.status(500).json({ error: e.message });
  else res.end();
});

function requireAuth(req, res, next) {
  const id = resolveIdentity(req);
  if (!id) return res.status(401).json({ error: '未授权：请携带 Authorization: Token m0-xxx' });
  req.identity = id;
  next();
}

const safeMeta = (s) => {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
};

/** mem0 记忆形状（内部 text → memory） */
function toMem0(row, extra = {}) {
  // repo 层返回的 metadata 可能已是对象（toObj 解析过），也可能是原始 JSON 字符串
  const meta = typeof row.metadata === 'string' ? safeMeta(row.metadata) : (row.metadata || {});
  return {
    id: row.id,
    memory: row.text,
    user_id: row.user_id,
    agent_id: row.agent_id || null,
    run_id: row.run_id || null,
    metadata: meta,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...extra,
  };
}

/**
 * 解析 mem0 filters 对象 → 本库 filters 形状，并做作用域校验。
 * 返回 {ok, filters?, error?, status?}；principal 为鉴权主体 userId。
 */
function parseFilters(filters, principal) {
  let f = filters;
  // AND 数组：展开合并（顶层级与每项都按同一规则处理）
  if (Array.isArray(f?.AND)) {
    f = Object.assign({}, ...f.AND, objWithoutKeys(f, ['AND']));
  }
  if (f && (f.OR || f.NOT)) {
    return { ok: false, error: 'filters 暂只支持顶层级条件与 AND 数组，OR/NOT 未支持', status: 400 };
  }
  if (f && typeof f !== 'object') {
    return { ok: false, error: 'filters 必须是对象', status: 400 };
  }
  f = f || {};
  const out = {};
  // 作用域校验：user_id 必须是鉴权主体（或省略）
  if (f.user_id !== undefined && f.user_id !== principal) {
    return { ok: false, error: `user_id "${f.user_id}" 与鉴权主体不符：本服务为个人部署，记忆归属 Token 持有者`, status: 403 };
  }
  for (const key of ['agent_id', 'run_id']) {
    if (f[key] !== undefined && f[key] !== null && f[key] !== '*') out[key] = String(f[key]);
  }
  if (f.metadata && typeof f.metadata === 'object' && !Array.isArray(f.metadata)) out.metadata = f.metadata;
  for (const key of ['created_at', 'updated_at']) {
    const range = f[key];
    if (range && typeof range === 'object') {
      out[key] = {};
      if (range.gte) out[key].gte = String(range.gte);
      if (range.lte) out[key].lte = String(range.lte);
    }
  }
  if (typeof f.keywords === 'string' && f.keywords.trim()) out.keywords = f.keywords.trim();
  return { ok: true, filters: out };
}

function objWithoutKeys(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

/** 校验 add 请求的作用域，返回 {agentId, runId} 或已写出的错误响应 */
function resolveScope(req, res) {
  const b = req.body || {};
  if (b.user_id !== undefined && b.user_id !== null && b.user_id !== req.identity.userId) {
    res.status(403).json({ error: `user_id "${b.user_id}" 与鉴权主体不符：本服务为个人部署，记忆归属 Token 持有者` });
    return null;
  }
  return {
    agentId: b.agent_id ? String(b.agent_id) : null,
    runId: b.run_id ? String(b.run_id) : null,
  };
}

/** 从 body 提取素材：messages（[{role,content}]）优先，其次 text */
function extractInput(body) {
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (messages && messages.length) {
    if (messages.some((m) => !m || typeof m.content !== 'string')) {
      return { error: 'messages 数组每项需为 {role, content}' };
    }
    return { kind: 'messages', messages };
  }
  if (typeof body.text === 'string' && body.text.trim()) return { kind: 'text', text: body.text };
  return { error: '缺少内容：请提供 messages（[{role, content}]）或 text' };
}

// ===== POST /v1/memories/ —— add =====

router.post('/v1/memories', requireAuth, wrap(async (req, res) => {
  const scope = resolveScope(req, res);
  if (!scope) return;
  const b = req.body || {};
  const input = extractInput(b);
  if (input.error) return res.status(400).json({ error: input.error });
  const infer = b.infer !== false;

  if (!infer) {
    // 原文直存（同步，不经 LLM）：mem0 的 infer=false 语义
    const text = input.kind === 'messages'
      ? input.messages.map((m) => `${m.role}: ${m.content}`).join('\n')
      : input.text;
    if (text.length > l2store.MAX_TEXT) return res.status(400).json({ error: `text 超长（上限 ${l2store.MAX_TEXT} 字符）` });
    const id = l2store.insertFact({ userId: req.identity.userId, agentId: scope.agentId, runId: scope.runId, text, metadata: b.metadata || {} });
    l2store.recordOp({ userId: req.identity.userId, memoryId: id, op: 'ADD', afterText: text, source: 'manual' });
    return res.status(200).json({ results: [{ id, memory: text, event: 'ADD' }] });
  }

  // 异步提炼：立即返回 event_id（mem0 语义：受理 ≠ 入库，用 /v1/event/{id} 轮询）
  let result;
  try {
    result = repo.createMemory({
      userId: req.identity.userId,
      text: input.kind === 'text' ? input.text : undefined,
      messages: input.kind === 'messages' ? input.messages : undefined,
      metadata: b.metadata || {},
      agentId: scope.agentId,
      runId: scope.runId,
    });
  } catch (e) {
    return res.status(503).json({ error: e.message });
  }
  res.status(200).json({ event_id: result.event_id, status: 'pending' });
}));

// ===== POST /v2/memories/search/ —— 检索 =====

router.post('/v2/memories/search', requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.query || !String(b.query).trim()) {
    return res.status(400).json({ error: 'query 不能为空' });
  }
  const parsed = parseFilters(b.filters, req.identity.userId);
  if (!parsed.ok) return res.status(parsed.status || 400).json({ error: parsed.error });
  const topK = Math.max(1, Math.min(Number(b.top_k) || 10, 1000));
  const threshold = Number(b.threshold) || 0;
  const results = await repo.searchMemories({
    userId: req.identity.userId,
    query: String(b.query),
    limit: topK,
    threshold,
    filters: parsed.filters,
  });
  res.json({ results: results.map((r) => toMem0(r, { score: r.score ?? 0 })) });
}));

// ===== POST /v2/memories/ —— get_all（filters + 分页） =====

router.post('/v2/memories', requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const parsed = parseFilters(b.filters, req.identity.userId);
  if (!parsed.ok) return res.status(parsed.status || 400).json({ error: parsed.error });
  const page = Math.max(1, Number(b.page) || 1);
  const pageSize = Math.max(1, Math.min(Number(b.page_size) || 100, 200));
  const r = repo.listMemories({ userId: req.identity.userId, page, pageSize, filters: parsed.filters });
  const makeUrl = (p) => new URL(`${req.baseUrl}${req.path}?page=${p}&page_size=${pageSize}`, `${req.protocol}://${req.get('host')}`).toString();
  res.json({
    count: r.total,
    next: page * pageSize < r.total ? makeUrl(page + 1) : null,
    previous: page > 1 ? makeUrl(page - 1) : null,
    results: r.results.map((row) => toMem0(row)),
  });
}));

// ===== GET /v1/memories/{id}/ —— 单条 =====

router.get('/v1/memories/:id', requireAuth, wrap(async (req, res) => {
  const mem = repo.getMemory(req.params.id, req.identity.userId);
  if (!mem) return res.status(404).json({ error: '记忆不存在' });
  res.json(toMem0(mem));
}));

// ===== PUT /v1/memories/{id}/ —— 更新 =====

router.put('/v1/memories/:id', requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  if (b.text !== undefined && (typeof b.text !== 'string' || !b.text.trim())) {
    return res.status(400).json({ error: 'text 不能为空字符串' });
  }
  const mem = repo.updateMemory({ id: req.params.id, userId: req.identity.userId, text: b.text, metadata: b.metadata });
  if (!mem) return res.status(404).json({ error: '记忆不存在' });
  // 改了文本才值得重消解；后台异步，失败静默
  if (b.text !== undefined) {
    require('../l2/reconcile').reconcileAfterUpdate({ userId: req.identity.userId, memoryId: mem.id }).catch(() => {});
  }
  res.json(toMem0(mem));
}));

// ===== DELETE /v1/memories/{id}/ —— 删除单条 =====

router.delete('/v1/memories/:id', requireAuth, wrap(async (req, res) => {
  if (!repo.deleteMemory(req.params.id, req.identity.userId)) {
    return res.status(404).json({ error: '记忆不存在' });
  }
  res.json({ success: true });
}));

// ===== GET /v1/memories/{id}/history/ —— 变更历史 =====

router.get('/v1/memories/:id/history', requireAuth, wrap(async (req, res) => {
  if (!repo.getMemory(req.params.id, req.identity.userId)) {
    return res.status(404).json({ error: '记忆不存在' });
  }
  const ops = l2store.listMemoryOps(req.identity.userId, req.params.id, 200)
    .filter((o) => o.op !== 'NOOP' || o.applied === false);
  res.json(ops.map((o) => ({
    id: String(o.id),
    memory_id: o.memory_id,
    event: o.op,
    old_memory: o.before_text,
    new_memory: o.after_text,
    user_id: o.user_id,
    source: o.source,
    created_at: o.created_at,
    updated_at: o.created_at,
  })));
}));

// ===== DELETE /v1/memories/ —— 按作用域批量删除（异步） =====

router.delete('/v1/memories', requireAuth, wrap(async (req, res) => {
  const q = req.query || {};
  const userId = q.user_id;
  if (userId !== undefined && userId !== '*' && userId !== req.identity.userId) {
    return res.status(403).json({ error: `user_id "${userId}" 与鉴权主体不符：本服务为个人部署，记忆归属 Token 持有者` });
  }
  if (userId === undefined && q.agent_id === undefined && q.run_id === undefined) {
    return res.status(400).json({ error: '至少提供一个过滤条件：user_id / agent_id / run_id（防误删全库）' });
  }
  const eventId = repo.createEvent({
    userId: req.identity.userId,
    eventType: 'delete_memories',
    payload: { agent_id: q.agent_id, run_id: q.run_id },
  });
  res.status(200).json({ message: 'Delete in progress. This may take some time.', event_id: eventId });
}));

// ===== GET /v1/event/{event_id}/ —— 异步事件状态 =====

router.get('/v1/event/:event_id', requireAuth, wrap(async (req, res) => {
  const ev = repo.getEvent(req.params.event_id, req.identity.userId);
  if (!ev) return res.status(404).json({ error: '事件不存在' });
  res.json({
    event_id: ev.id,
    status: ev.status,
    result: ev.result,
    error: ev.error,
    created_at: ev.created_at,
    updated_at: ev.updated_at,
  });
}));

module.exports = { router };
