'use strict';

/**
 * REST /api + Web 会话辅助。
 * - 鉴权：Authorization: Token m0-xxx（API key）或 aim_session cookie（Web 口令登录会话）
 * - 所有数据访问强制 user_id 隔离
 */
const express = require('express');
const repo = require('../db/repo');
const tokens = require('../auth/tokens');
const l0Store = require('../l0/store');
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

// 当前用户记忆统计（页面展示：记忆数 / 生效密钥数）
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
  // 导出当前员工全部记忆（JSON 附件下载；数据可携带性 / 备份）
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

// ===== L0 原始会话归档（采集器上传；只落盘，不做提炼） =====

// 采集器上传一个批次（同批次重传按 batch_id 幂等跳过）。
// 注意：本端点的 body 上限单独放宽（见 index.js 的 per-route parser）——原始会话
// 批次远大于普通 API 请求，若沿用全局 1mb 会持续 413。
const l0IngestHandler = wrap(async (req, res) => {
  const b = req.body || {};
  const agent = String(b.agent || '').trim();
  const sessionId = String(b.session_id || '').trim();
  if (!agent) return res.status(400).json({ error: '缺少 agent' });
  if (!sessionId) return res.status(400).json({ error: '缺少 session_id' });
  if (!Array.isArray(b.records) || b.records.length === 0) {
    return res.status(400).json({ error: 'records 不能为空' });
  }
  if (b.records.length > 5000) {
    return res.status(413).json({ error: '单批次记录数超限（≤5000），请拆分上传' });
  }
  // 设备信息：device.code 是归类主键；fingerprint 用于"认出同一台机器"（重装后归回原设备）；
  // label/info 供跨机识别与排查
  const dev = b.device && typeof b.device === 'object' ? b.device : {};
  const r = l0Store.ingestBatch({
    userId: req.identity.userId,
    agent,
    sessionId,
    deviceCode: dev.code || b.device_code || b.collector_id,
    deviceLabel: dev.label || b.device_label,
    deviceInfo: dev.info,
    deviceFingerprint: dev.fingerprint || b.device_fingerprint,
    deviceFingerprintSource: dev.fingerprint_source || b.device_fingerprint_source,
    collectorId: b.collector_id,
    batchSeq: b.batch_seq,
    batchId: b.batch_id,
    records: b.records,
  });
  res.status(r.deduped ? 200 : 201).json(r);
});

// 鉴权 + 处理：index.js 以 [parser, ...l0IngestRoute] 形式挂载，先于全局 1mb parser
const l0IngestRoute = [requireAuth, l0IngestHandler];

// 归档概况 + 设备清单 + 会话清单（Web 展示 / 采集器 status 自检）
// 支持 ?device=<设备码>&agent=<agent> 过滤会话，用于"看某台机器做了什么"
apiRouter.get('/l0/stats', requireAuth, wrap(async (req, res) => {
  const deviceCode = req.query.device ? String(req.query.device) : null;
  const agent = req.query.agent ? String(req.query.agent) : null;
  res.json({
    ...l0Store.archiveStats(req.identity.userId),
    devices_list: l0Store.listDevices(req.identity.userId),
    sessions_list: l0Store.listSessions(req.identity.userId, { deviceCode, agent, limit: 200 }),
  });
}));

// 单会话详情：读取归档内容（跨用户访问在 store 层校验）
apiRouter.get('/l0/session', requireAuth, wrap(async (req, res) => {
  const { device, agent, session_id: sessionId } = req.query;
  if (!agent || !sessionId) return res.status(400).json({ error: '缺少 agent / session_id' });
  const r = l0Store.readSession(req.identity.userId, {
    deviceCode: device ? String(device) : null,
    agent: String(agent),
    sessionId: String(sessionId),
  });
  if (!r) return res.status(404).json({ error: '会话不存在或无权访问' });
  // 顺带带上该会话的 L1 摘要（可能尚未生成 → null）
  const summary = repo.getL1Summary(req.identity.userId, {
    deviceCode: device ? String(device) : '',
    agent: String(agent),
    sessionId: String(sessionId),
  });
  res.json({ agent, device: device || null, session_id: sessionId, ...r, summary: summary || null });
}));

// ===== L1 会话摘要（情景记忆，后台从 L0 归档生成） =====

// 摘要清单：支持 ?device= / ?agent= / ?q= 过滤
apiRouter.get('/l1/summaries', requireAuth, wrap(async (req, res) => {
  const deviceCode = req.query.device ? String(req.query.device) : null;
  const agent = req.query.agent ? String(req.query.agent) : null;
  const query = req.query.q ? String(req.query.q) : null;
  let list = repo.listL1Summaries(req.identity.userId, { deviceCode, agent, limit: 500 });
  if (query) {
    const q = query.toLowerCase();
    list = list.filter((s) =>
      [s.overview, ...(s.decisions || []), ...(s.artifacts || []), ...(s.pending || [])]
        .filter(Boolean).some((t) => String(t).toLowerCase().includes(q))
    );
  }
  res.json({ results: list, total: list.length, ...repo.l1Stats(req.identity.userId) });
}));

// 摘要进度（运维：还有多少没跑、失败多少）
apiRouter.get('/l1/stats', requireAuth, wrap(async (req, res) => {
  res.json(repo.l1Stats(req.identity.userId));
}));

// 手动触发：立即为「已静默」的会话排队并处理一小批（不等后台轮询）
apiRouter.post('/l1/run', requireAuth, wrap(async (req, res) => {
  const l1Scheduler = require('../l1/scheduler');
  const r = await l1Scheduler.tick();
  res.json(r || { processed: 0 });
}));

// ===== 设备流连接（零粘贴：发起 → 授权页确认 → 轮询拿 key）=====

// agent 端发起连接请求（匿名，不绑定用户）→ 返回 request_id 供浏览器授权页 + 轮询
// body 可带 confirm_token（agent 侧随机，拼进 authorize_url）→ /connect 校验匹配后免按钮自动授权
apiRouter.post('/connect/start', wrap(async (req, res) => {
  const confirmToken = (req.body && typeof req.body.confirm_token === 'string' && req.body.confirm_token) || null;
  const { request_id } = repo.createConnectRequest(confirmToken);
  const base = config.publicBaseUrl || `http://${req.get('host')}`;
  const authorizeUrl = confirmToken
    ? `${base}/connect?request_id=${request_id}&confirm_token=${encodeURIComponent(confirmToken)}`
    : `${base}/connect?request_id=${request_id}`;
  res.status(201).json({
    request_id,
    authorize_url: authorizeUrl,
    expires_in: 600,
  });
}));

// agent 端轮询：authorized → { token, key_name }；pending → null；失效/不存在 → { error }
apiRouter.get('/connect/poll', wrap(async (req, res) => {
  const requestId = String(req.query.request_id || '').trim();
  if (!requestId) return res.status(400).json({ error: '缺少 request_id' });
  const r = repo.pollConnectRequest(requestId);
  if (r === 'expired') return res.status(410).json({ error: '授权请求已过期或不存在，请重新发起' });
  if (r === null) return res.json({ status: 'pending' });
  res.json({ status: 'authorized', token: r.token, key_name: r.key_name, api_key_id: r.api_key_id });
}));

// 授权页「确认授权」：绑定当前登录用户 + 签发 Token（名称必填）
apiRouter.post('/connect/confirm', requireAuth, wrap(async (req, res) => {
  const { request_id, name } = req.body || {};
  if (!request_id) return res.status(400).json({ error: '缺少 request_id' });
  const cleanName = String(name || '').trim();
  if (!cleanName) return res.status(400).json({ error: 'Token 名称不能为空' });
  const r = repo.confirmConnectRequest(String(request_id), req.identity.userId, cleanName);
  if (!r) return res.status(400).json({ error: '授权请求无效、已处理或已过期，请从 agent 端重新发起' });
  res.status(201).json({ token: r.token, key_name: r.key_name, api_key_id: r.api_key_id });
}));

module.exports = { apiRouter, resolveIdentity, l0IngestRoute };
