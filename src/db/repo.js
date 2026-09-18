'use strict';

/**
 * 数据访问层（素材提炼型记忆库）。
 * 写入语义：一切通过 MCP/REST/Web 提交的都是"素材"（text 单条或 messages 多轮），一律异步受理
 * （返回 event_id）→ 后台 LLM 提炼成多条自包含的结构化记忆 → 入库（仅提炼产物，不存原文）。
 * 提炼失败/无产物 → 事件 failed，素材不落库（调用方可重试）。库内没有"原文直存"路径。
 * 检索：语义（向量）+ 关键词（FTS）混合。已裁剪：agent/run 作用域、批量导入、整库/实体管理、
 * TTL 归档、修改历史。密钥 / Web 会话 / 设备流连接（员工接入）原样保留。
 */

const crypto = require('crypto');
const db = require('./index');
const llm = require('../llm/client'); // 对象引用（便于测试 stub）
const emb = require('../embeddings/client');

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const parseList = (s) => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
};
const toObj = (row) => {
  if (!row) return null;
  const { embedding, ...rest } = row; // embedding 为内部向量，不对外暴露
  return { ...rest, metadata: JSON.parse(rest.metadata || '{}'), facts: parseList(rest.facts), entities: parseList(rest.entities) };
};

function clamp(n, min, max, def) {
  const v = Number.parseInt(n, 10);
  if (Number.isNaN(v)) return def;
  return Math.min(Math.max(v, min), max);
}

// ============ 记忆写入（素材 → 提炼 → 入库） ============

/**
 * 受理记忆素材（text 单条 / messages 多轮对话），一律异步：
 * 创建提炼任务返回 { event_id, status:'pending' }，后台队列（processPendingEvents）LLM 提炼入库。
 * 库内只存提炼产物，不存原文。提炼失败 → 事件 failed（素材不落库）。
 * LLM 未启用（LLM_ENABLED=0）时直接拒绝，避免"收了素材却永远无法提炼"。
 */
function createMemory({ userId, text, messages, metadata = {} }) {
  if (!llm.enabled()) {
    throw new Error('LLM 提炼服务未启用（LLM_ENABLED=0），无法写入记忆');
  }
  let kind = 'text';
  let input = text;
  if (messages && Array.isArray(messages) && messages.length) {
    kind = 'messages';
    input = messages.slice(0, 50);
  }
  if (input === undefined || (typeof input === 'string' && !input.trim())) {
    throw new Error('text 或 messages 至少提供一个');
  }
  const eventId = createEvent({
    userId,
    eventType: 'add_memory',
    payload: { kind, input, metadata: metadata || {} },
  });
  return { event_id: eventId, status: 'pending', user_id: userId };
}

/**
 * 后台执行素材提炼入库（processEvent 调用，不阻塞 MCP 调用）。
 * kind='messages'：input 为 [{role,content}] → 拼成对话文本；kind='text'：input 为原文。
 * 提炼产物逐条入库（每条只补 embedding，不再二次 LLM 抽 facts——产物本身已是结构化记忆）。
 * 提炼无产物/失败 → 抛错（调用方标记事件 failed，素材不落库）。
 */
async function processMemoryMaterial({ userId, kind, input, metadata = {} }) {
  const source = kind === 'messages' && Array.isArray(input)
    ? input.map((m) => `${m.role}: ${m.content}`).join('\n')
    : String(input || '');
  if (!source.trim()) throw new Error('素材为空');
  const extracted = await extractMemories(source);
  if (!extracted.length) throw new Error('LLM 未能从素材提炼出有效记忆（无产物，素材未入库）');
  const created = [];
  for (const item of extracted) {
    created.push(insertMemory({ userId, text: item, metadata }));
  }
  return created;
}

/** 写一条提炼产物的记忆：入库 + 异步补向量（提炼产物本身即结构化记忆，无需再抽 facts） */
function insertMemory({ userId, text, metadata }) {
  const id = uuid();
  const ts = now();
  db.prepare(
    'INSERT INTO memories (id, user_id, text, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, userId, String(text).slice(0, 8000), JSON.stringify(metadata || {}), ts, ts);
  syncEmbedding(id, String(text).slice(0, 8000)); // 异步补向量，失败静默（检索降级关键词）
  return toObj(getMemoryRow(id, userId));
}

/**
 * LLM 提炼：把一段素材（对话拼接文本或单条原文）提炼成多条独立、自包含、可复用的记忆陈述。
 * 返回字符串数组；LLM 不可用/无有效产出返回 []（调用方据此判失败，不回退存原文）。
 */
async function extractMemories(source) {
  const content = await llm.complete([
    {
      role: 'system',
      content: '你是记忆提炼助手。把下面的内容提炼成多条独立的、可复用的完整事实陈述。要求：1) 每条必须是完整句子，自包含、带明确主语，不得省略主语（如"10.10.10.214 上运行 X 服务"而不是"上运行 X 服务"）；2) 每条用一行输出，不要编号、不要前缀、不要解释；3) 合并同主题，拆开不同主题，每条都是独立可检索的事实；4) 保留关键信息（IP、端口、地址、人名、数字、决策、偏好、技术细节）；5) 丢弃与事实无关的寒暄/过程性内容，不猜测、不添加原文没有的信息。只输出提炼出的事实本身；无法提炼出任何有价值事实时输出空。',
    },
    { role: 'user', content: `素材：\n${source.slice(0, 6000)}` },
  ], { maxTokens: 2048, temperature: 0.1 });

  if (!content) return [];
  return content
    .split('\n')
    .map((l) => l.replace(/^[-*•\d.\s]+/, '').trim())
    // 质量门槛：过短残句不视为可复用记忆（过滤超时截断的碎片）
    .filter((l) => l.length >= 10)
    .slice(0, 20);
}

/**
 * 异步 LLM 抽取 facts/entities：仅用于 update_memory（用户手动编辑最终文本后重抽，供语义召回增强）。
 * 失败静默。新写入的提炼产物不走此路径（见 insertMemory）。
 */
function syncFacts(id, text) {
  const prompt = `从下面的文本中提取 JSON（不要其他内容）：
{"facts": ["独立可复用的简短事实，每条一个字符串"], "entities": ["专有名词实体：公司/组织/人名/地名/IP/端口/技术名等，每个一个字符串"]}
无法提取的字段给空数组。\n\n文本：${String(text).slice(0, 4000)}`;
  llm.complete([
    { role: 'system', content: '你是信息抽取助手，只输出合法 JSON。' },
    { role: 'user', content: prompt },
  ], { maxTokens: 1024, temperature: 0.1 })
    .then((content) => {
      if (!content) return;
      let facts = [], entities = [];
      try {
        const parsed = JSON.parse(content);
        facts = Array.isArray(parsed.facts) ? parsed.facts.filter((f) => typeof f === 'string' && f.trim().length >= 3) : [];
        entities = Array.isArray(parsed.entities) ? parsed.entities.filter((e) => typeof e === 'string' && e.trim().length >= 2) : [];
      } catch {
        // 非 JSON 回退：按行当 facts
        facts = content
          .split('\n')
          .map((l) => l.replace(/^[-*•\d.\s]+/, '').trim())
          .filter((l) => l.length >= 3);
      }
      if (!facts.length && !entities.length) return;
      db.prepare('UPDATE memories SET facts = ?, entities = ? WHERE id = ?')
        .run(facts.length ? JSON.stringify(facts) : null, entities.length ? JSON.stringify(entities) : null, id);
      // facts/entities 就绪后重算向量（原文 + 事实 + 实体，增强语义与实体命中）
      emb.embed(semanticText(text, facts, entities)).then((v) => {
        if (v) db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(v, id);
      }).catch(() => {});
    })
    .catch(() => {});
}

/** 语义向量文本源：原文 + 抽取事实 + 实体 */
function semanticText(text, facts = [], entities = []) {
  const parts = [String(text).slice(0, 8000), ...facts, ...entities];
  return parts.join('\n');
}

/** 异步为记忆补 embedding 向量（新增/更新后调用）；失败静默，搜索自动回退关键词 */
function syncEmbedding(id, text) {
  emb.embed(String(text).slice(0, 8000)).then((vec) => {
    if (vec) db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(vec, id);
  }).catch(() => {});
}

// ============ 记忆读取 ============

function getMemoryRow(id, userId) {
  return db
    .prepare('SELECT * FROM memories WHERE id = ? AND user_id = ?')
    .get(id, userId);
}

function getMemory(id, userId) {
  return toObj(getMemoryRow(id, userId));
}

function listMemories({ userId, page = 1, pageSize = 10, filters = {} }) {
  page = clamp(page, 1, 100000, 1);
  pageSize = clamp(pageSize, 1, 100, 10);
  const { sql, params } = filtersClause('', filters);
  const where = `WHERE user_id = ?${sql}`;
  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM memories ${where}`)
    .get(userId, ...params).c;
  const rows = db
    .prepare(`SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(userId, ...params, pageSize, (page - 1) * pageSize);
  return { results: rows.map(toObj), total, page, pageSize };
}

/** 导出当前员工全部记忆（含 metadata/facts/entities，不含内部向量）。按更新时间倒序。 */
function exportMemories(userId) {
  return db
    .prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId)
    .map(toObj);
}

/**
 * 混合检索：向量语义召回 + FTS 关键词召回 合并去重。
 * 支持 filters：metadata 键值 / created_at、updated_at 时间范围（gte/lte）。
 * embedding 不可用时自动回退关键词检索（仅影响语义命中，关键词命中始终兜底）。
 */
async function searchMemories({ userId, query, limit = 10, threshold = 0, filters = {} }) {
  limit = clamp(limit, 1, 100, 10);
  const q = (query || '').trim();
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const { sql: fsql, params: fparams } = filtersClause('m', filters);

  // 1. 向量语义召回（embedding 未启用/失败 → 返回 []，自动走关键词路径）
  const vecCandidates = await getVecCandidates(userId, q, Math.max(limit * 4, 50), threshold, fsql, fparams);

  // 2. FTS5 trigram 关键词召回（>=3 字符词 AND 匹配；trigram 无法索引 1-2 字符片段）
  const ftsWords = words.filter((w) => w.length >= 3);
  let ftsRows = [];
  if (ftsWords.length) {
    const match = ftsWords.map((w) => `"${w.replace(/"/g, '""')}"`).join(' AND ');
    ftsRows = db
      .prepare(
        `SELECT m.id, m.text, m.metadata, m.facts, m.entities, m.created_at, m.updated_at, bm25(memories_fts) AS score
         FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.user_id = ?${fsql} ORDER BY score LIMIT 500`
      )
      .all(match, userId, ...fparams);
  }
  // 3. FTS 无候选（全为 1-2 字符短词）→ 全表兜底
  if (!ftsRows.length) {
    ftsRows = db
      .prepare(
        `SELECT m.id, m.text, m.metadata, m.facts, m.entities, m.created_at, m.updated_at, 0 AS score
         FROM memories m WHERE m.user_id = ?${fsql} ORDER BY m.updated_at DESC LIMIT 500`
      )
      .all(userId, ...fparams);
  }
  // 4. 关键词二次过滤：每个查询词都必须出现在 text / facts / entities 中（覆盖中文短词、事实与实体命中）
  ftsRows = ftsRows.filter((m) => {
    const hay = `${m.text}\n${m.facts || ''}\n${m.entities || ''}`;
    return words.every((w) => hay.includes(w));
  });

  // 5. 合并：向量召回优先（语义命中排前），再补关键词字面命中；score 单一来源
  const seen = new Set();
  const merged = [];
  const push = (m, score) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    merged.push({ ...m, score: Number(score.toFixed(4)) });
  };
  for (const m of vecCandidates) push(m, m.similarity);
  for (const m of ftsRows) push(m, m.score ?? 0);

  return merged.slice(0, limit).map(toObj);
}

/** 向量候选：查询向量化后与全部带向量记忆做余弦相似度，取 topN */
function getVecCandidates(userId, query, topN, threshold, fsql, fparams) {
  const cfg = require('../config').embedding;
  if (!cfg.enabled) return [];
  return emb.embed(query).then((qVec) => {
    if (!qVec) return [];
    const rows = db
      .prepare(
        `SELECT m.id, m.text, m.metadata, m.facts, m.entities, m.created_at, m.updated_at, m.embedding
         FROM memories m WHERE m.user_id = ? AND m.embedding IS NOT NULL${fsql}`
      )
      .all(userId, ...fparams);
    const scored = [];
    for (const r of rows) {
      const sim = cosineSimilarity(qVec, r.embedding);
      if (sim >= threshold) scored.push({ ...r, similarity: sim });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topN);
  }).catch(() => []);
}

/** 两个 float32 Buffer 的余弦相似度 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  const n = a.length / 4;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a.readFloatLE(i * 4);
    const y = b.readFloatLE(i * 4);
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ============ 记忆更新 / 删除 ============

function updateMemory({ id, userId, text, metadata }) {
  const existing = getMemoryRow(id, userId);
  if (!existing) return null;
  const ts = now();
  const newText = text !== undefined ? String(text) : existing.text;
  const newMeta = metadata !== undefined ? JSON.stringify(metadata) : existing.metadata;
  db.prepare('UPDATE memories SET text = ?, metadata = ?, updated_at = ? WHERE id = ?')
    .run(newText, newMeta, ts, id);
  if (newText !== existing.text) {
    // 文本变化：清掉旧 facts/entities，重新补向量并重抽事实
    db.prepare('UPDATE memories SET facts = NULL, entities = NULL WHERE id = ?').run(id);
    syncEmbedding(id, newText);
    syncFacts(id, newText);
  }
  return toObj(getMemoryRow(id, userId));
}

function deleteMemory(id, userId) {
  const res = db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(id, userId);
  return res.changes > 0;
}

// ============ 多维过滤 SQL ============
// metadata：键值对象（如 {source:"claude-code"}）；created_at/updated_at：{gte, lte} 时间范围
function filtersClause(alias, filters = {}) {
  const a = alias ? `${alias}.` : '';
  const parts = [];
  const params = [];
  const meta = filters.metadata;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    for (const [k, v] of Object.entries(meta)) {
      if (v === undefined || v === null) continue;
      const val = typeof v === 'string' ? JSON.stringify(v) : String(v);
      parts.push(`${a}metadata LIKE ?`);
      params.push(`%"${k}":${val}%`);
    }
  }
  for (const field of ['created_at', 'updated_at']) {
    const range = filters[field];
    if (range && typeof range === 'object') {
      if (range.gte) { parts.push(`${a}${field} >= ?`); params.push(String(range.gte)); }
      if (range.lte) { parts.push(`${a}${field} <= ?`); params.push(String(range.lte)); }
    }
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}

// ============ 异步任务（素材提炼队列） ============
// 本地 LLM 并发低，所有写入（text/messages 素材）异步受理返回 event_id，后台队列串行提炼入库。
// 事件表 events 即任务队列（status: pending/processing/done/failed）。提炼失败 → failed，素材不落库。

/** 创建异步任务，立即返回 event_id（pending）。 */
function createEvent({ userId, eventType = 'add_memory', payload }) {
  const id = uuid();
  const ts = now();
  db.prepare(
    'INSERT INTO events (id, user_id, event_type, status, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, userId, eventType, 'pending', JSON.stringify(payload), ts);
  return id;
}

function getEvent(id, userId) {
  const row = db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return null;
  return {
    id: row.id,
    event_type: row.event_type,
    status: row.status,
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 处理一个 pending 任务：素材 → LLM 提炼 → 逐条入库（仅提炼产物）。失败/无产物 → failed。 */
async function processEvent(event) {
  const userId = event.user_id;
  const id = event.id;
  const p = JSON.parse(event.payload || '{}');
  db.prepare("UPDATE events SET status='processing', updated_at=? WHERE id=?").run(now(), id);
  try {
    const created = await processMemoryMaterial({
      userId, kind: p.kind, input: p.input, metadata: p.metadata,
    });
    const result = { count: created.length, memories: created };
    db.prepare("UPDATE events SET status='done', result=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(result), now(), id);
  } catch (e) {
    db.prepare("UPDATE events SET status='failed', error=?, updated_at=? WHERE id=?")
      .run(String(e.message || e).slice(0, 500), now(), id);
  }
  return getEvent(id, userId);
}

/** 扫描并处理 pending 任务（串行，避免 LLM 并发超限；processing 卡死 5 分钟重置重试）。
 *  由服务启动定时调用（见 index.js 每 2s 轮询）。返回本次处理数。 */
async function processPendingEvents() {
  const stuckCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  db.prepare(
    "UPDATE events SET status='pending', updated_at=? WHERE status='processing' AND updated_at <= ?"
  ).run(now(), stuckCutoff);
  const pendings = db
    .prepare("SELECT * FROM events WHERE status = 'pending' ORDER BY created_at LIMIT 3")
    .all();
  for (const ev of pendings) {
    await processEvent(ev);
  }
  return pendings.length;
}

/** 清理 7 天前的已完成/失败任务（防表膨胀） */
function cleanupEvents() {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  db.prepare("DELETE FROM events WHERE status IN ('done','failed') AND created_at <= ?").run(cutoff);
}

// ============ API Token（多 Token 并存：按客户端签发，单独吊销） ============

function createApiKey({ userId, name, tokenHash, tokenPlain }) {
  const row = {
    id: uuid(),
    user_id: userId,
    name,
    token_hash: tokenHash,
    token_plain: tokenPlain,
    created_at: now(),
    revoked_at: null,
  };
  // 多 Token 并存：每条独立签发、单独吊销，签发不影响该用户已有 Token
  db.prepare(
    'INSERT INTO api_keys (id, user_id, name, token_hash, token_plain, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(row.id, row.user_id, row.name, row.token_hash, row.token_plain, row.created_at, row.revoked_at);
  return row;
}

function listApiKeys(userId) {
  return db
    .prepare('SELECT id, user_id, name, token_plain, created_at, revoked_at FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC')
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
  const { token, id: keyId } = require('../auth/tokens').createApiKey(userId, safeName);
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

// ============ L0 原始会话归档（批次去重） ============

/** 批次是否已收到过（幂等重传判定） */
function l0BatchExists(batchId) {
  return !!db.prepare('SELECT 1 FROM l0_batches WHERE batch_id = ?').get(batchId);
}

/**
 * 记录级去重：滤掉已收过的 (rid, version)。
 * 批次指纹挡不住"同内容、不同分块"（批大小调整、顺序变化都会改指纹），
 * 这里按记录粒度兜底。允许同一 rid 的不同版本（ZCode 原地更新），只挡完全相同版本。
 * @returns {object[]} 其中真正是新记录的子集
 */
function l0FilterNewRecords({ userId, deviceCode, agent, sessionId, records }) {
  if (!records.length) return records;
  const stmt = db.prepare(
    `SELECT 1 FROM l0_records
      WHERE user_id = ? AND device_code = ? AND agent = ? AND session_id = ? AND rid = ? AND version = ?`
  );
  return records.filter(
    (r) => !stmt.get(userId, deviceCode, agent, sessionId, String(r.rid), Number(r.version) || 0)
  );
}

/** 记录已收（落盘成功后调用）；已存在则忽略 */
function l0MarkRecords({ userId, deviceCode, agent, sessionId, records }) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO l0_records (user_id, device_code, agent, session_id, rid, version)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const r of records) {
      stmt.run(userId, deviceCode, agent, sessionId, String(r.rid), Number(r.version) || 0);
    }
  });
  tx();
}

function insertL0Batch({ batchId, userId, agent, sessionId, deviceCode, collectorId, records, bytes }) {
  db.prepare(
    `INSERT OR IGNORE INTO l0_batches
     (batch_id, user_id, agent, session_id, device_code, collector_id, records, bytes, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(batchId, userId, agent, sessionId, deviceCode || null, collectorId || null, records, bytes, now());
}

/** 按机器指纹查该用户下已登记的设备码（用于重装后认回原设备） */
function findDeviceByFingerprint(userId, fingerprint) {
  if (!fingerprint) return null;
  const row = db
    .prepare('SELECT device_code FROM l0_devices WHERE user_id = ? AND fingerprint = ? ORDER BY last_seen DESC LIMIT 1')
    .get(userId, fingerprint);
  return row ? row.device_code : null;
}

/**
 * 登记/更新设备：首次见到插入，之后更新 label/info/last_seen 与 agent 集合。
 * agents 用集合并集（同一设备可能陆续上报多种 agent）。
 * 指纹只在客户端提供且本地为空时才写入——不覆盖已有指纹，避免把认回关系冲掉。
 */
function upsertL0Device({ userId, deviceCode, label, info, fingerprint, fingerprintSource, agent }) {
  const ts = now();
  const row = db
    .prepare('SELECT agents FROM l0_devices WHERE user_id = ? AND device_code = ?')
    .get(userId, deviceCode);
  if (!row) {
    db.prepare(
      `INSERT INTO l0_devices (user_id, device_code, fingerprint, fingerprint_source, label, info, agents, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      deviceCode,
      fingerprint || null,
      fingerprintSource || null,
      label || null,
      info ? JSON.stringify(info) : null,
      JSON.stringify(agent ? [agent] : []),
      ts,
      ts
    );
    return;
  }
  let agents = [];
  try { agents = JSON.parse(row.agents || '[]'); } catch { agents = []; }
  if (agent && !agents.includes(agent)) agents.push(agent);

  // label 覆盖策略：等于主机名的说明是"默认名"，不该覆盖用户显式设过的自定义名。
  // （否则重装采集器时忘了带 AIMEMORY_DEVICE_LABEL，自定义名就被打回主机名。）
  const hostname = (info && info.hostname) || null;
  const existing = db
    .prepare('SELECT label, info FROM l0_devices WHERE user_id = ? AND device_code = ?')
    .get(userId, deviceCode);
  const existingLabel = existing ? existing.label : null;
  const existingHost = safeParse(existing && existing.info, {}).hostname || null;
  const newLabelIsDefault = !!hostname && label === hostname;
  const existingLabelIsCustom = !!existingLabel && existingLabel !== existingHost;
  const effectiveLabel = newLabelIsDefault && existingLabelIsCustom ? null : (label || null);

  // label/info 用「有值才覆盖」，避免老客户端不带这些字段时把已有信息清掉
  db.prepare(
    `UPDATE l0_devices
        SET fingerprint = COALESCE(fingerprint, ?),
            fingerprint_source = COALESCE(fingerprint_source, ?),
            label = COALESCE(?, label),
            info = COALESCE(?, info),
            agents = ?,
            last_seen = ?
      WHERE user_id = ? AND device_code = ?`
  ).run(
    fingerprint || null,
    fingerprintSource || null,
    effectiveLabel,
    info ? JSON.stringify(info) : null,
    JSON.stringify(agents),
    ts,
    userId,
    deviceCode
  );
}

/** 设备清单（含各设备的会话/记录统计），按最近活跃倒序 */
function listL0Devices(userId) {
  return db
    .prepare(
      `SELECT d.device_code, d.label, d.info, d.agents, d.first_seen, d.last_seen,
              d.fingerprint, d.fingerprint_source,
              COALESCE((SELECT COUNT(DISTINCT r.session_id) FROM l0_records r
                         WHERE r.user_id = d.user_id AND r.device_code = d.device_code), 0) sessions,
              COALESCE((SELECT COUNT(*) FROM l0_records r
                         WHERE r.user_id = d.user_id AND r.device_code = d.device_code), 0) records,
              COALESCE((SELECT SUM(b.bytes) FROM l0_batches b
                         WHERE b.user_id = d.user_id AND b.device_code = d.device_code), 0) bytes
         FROM l0_devices d
        WHERE d.user_id = ?
        ORDER BY d.last_seen DESC`
    )
    .all(userId)
    .map((r) => ({
      device_code: r.device_code,
      label: r.label,
      info: safeParse(r.info, {}),
      agents: safeParse(r.agents, []),
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      fingerprint: r.fingerprint,
      fingerprint_source: r.fingerprint_source,
      sessions: r.sessions,
      records: r.records,
      bytes: r.bytes,
    }));
}

/** 归档会话清单（可按设备/agent 过滤），按最后接收时间倒序 */
function l0Sessions(userId, { deviceCode, agent, limit = 200 } = {}) {
  const where = ['user_id = ?'];
  const args = [userId];
  if (deviceCode) { where.push('device_code = ?'); args.push(deviceCode); }
  if (agent) { where.push('agent = ?'); args.push(agent); }
  args.push(limit);
  // 记录数取自 l0_records（记录级权威索引，已排除重复）；
  // 时间/字节取自 l0_batches（批次维度）。两表用 (设备, agent, 会话) 关联。
  return db
    .prepare(
      `SELECT b.agent, b.session_id, b.device_code, MAX(b.collector_id) collector_id,
              COUNT(DISTINCT b.batch_id) batches,
              COALESCE((SELECT COUNT(*) FROM l0_records r
                         WHERE r.user_id = b.user_id AND r.device_code = b.device_code
                           AND r.agent = b.agent AND r.session_id = b.session_id), 0) records,
              SUM(b.bytes) bytes,
              MIN(b.received_at) first_received, MAX(b.received_at) last_received
       FROM l0_batches b
       WHERE ${where.map((w) => `b.${w}`).join(' AND ')}
       GROUP BY b.device_code, b.agent, b.session_id
       ORDER BY last_received DESC
       LIMIT ?`
    )
    .all(...args);
}

/** 单个会话是否属于该用户（跨用户访问防护，读取归档文件前必须校验） */
function l0SessionOwned(userId, { deviceCode, agent, sessionId }) {
  const row = db
    .prepare(
      `SELECT 1 FROM l0_batches
        WHERE user_id = ? AND agent = ? AND session_id = ?
          AND (? IS NULL OR device_code = ?)
        LIMIT 1`
    )
    .get(userId, agent, sessionId, deviceCode || null, deviceCode || null);
  return !!row;
}

/**
 * 归档概况（采集器对账 / Web 展示）。
 * records 取自 l0_records（真实落盘的唯一记录数），不是 l0_batches.records 的累计值——
 * 后者是"累计接收量"，历史重复批次会让它虚高，不能当作归档规模。
 */
function l0Stats(userId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) records,
              COUNT(DISTINCT session_id) sessions,
              COUNT(DISTINCT agent) agents,
              COUNT(DISTINCT device_code) devices
       FROM l0_records WHERE user_id = ?`
    )
    .get(userId);
  const b = db
    .prepare(
      `SELECT COUNT(*) batches, COALESCE(SUM(bytes),0) bytes, MAX(received_at) last_received
       FROM l0_batches WHERE user_id = ?`
    )
    .get(userId);
  return {
    batches: b.batches,
    sessions: row.sessions,
    agents: row.agents,
    devices: row.devices,
    records: row.records,
    bytes: b.bytes,
    last_received: b.last_received || null,
  };
}

function safeParse(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}

// ============ L1 会话摘要（情景记忆） ============

/**
 * 源指纹（廉价版）：从 l0_records 直接算出，用于判断会话是否需要（重新）摘要。
 * 不读归档文件、不哈希全文——纯 SQL，扫几万条也是毫秒级。
 *
 * 为什么 count+max+sum 足够：L0 是 append-only（记录只增不改），ZCode 的原地更新
 * 会推高 version。故「记录数变多」「某条记录 version 变大」都会改变这三个量的组合；
 * 而记录不会被删除，所以不存在"变化后指纹复原"的情形。
 *
 * @returns {Array<{device_code, agent, session_id, fp, last_received}>}
 */
/**
 * 源指纹表达式：**全项目唯一的一处定义**。
 *
 * count + max + sum 三者组合即可覆盖 L0 的全部变化（L0 是 append-only，无删除）：
 *   - 新增记录 → count 变
 *   - 某条 version 涨到最大 → max 变
 *   - 非最大记录 version 上涨（如 A=100,B=200 时 A→150）→ count/max 不变但 sum 变
 *
 * ⚠️ 必须与写入端（l1/summarize.js 存 content_hash）用同一个表达式。
 * 曾经踩过：写入端用 sha256(rid+version)，扫描端用 count:max:sum——两者永不相等，
 * 导致每个已摘要的会话每次扫描都被判为"内容已变"，反复重摘、白烧 LLM 配额。
 */
const L1_FP_SQL = "COUNT(*) || ':' || COALESCE(MAX(r.version), 0) || ':' || COALESCE(SUM(r.version), 0)";

/** 全部会话的源指纹（廉价：纯 SQL 扫 l0_records，不读归档文件） */
function l1Sources(userId) {
  return db
    .prepare(
      `SELECT r.device_code, r.agent, r.session_id,
              ${L1_FP_SQL} AS fp,
              MAX(b.received_at) AS last_received
         FROM l0_records r
         LEFT JOIN l0_batches b
                ON b.user_id = r.user_id AND b.device_code = r.device_code
               AND b.agent = r.agent AND b.session_id = r.session_id
        WHERE r.user_id = ?
        GROUP BY r.device_code, r.agent, r.session_id`
    )
    .all(userId);
}

/** 单个会话的源指纹（写入端存 content_hash 用，与 l1Sources 同源同式） */
function l1SourceFp(userId, { deviceCode, agent, sessionId }) {
  const row = db
    .prepare(
      `SELECT ${L1_FP_SQL} AS fp FROM l0_records r
        WHERE r.user_id = ? AND r.device_code = ? AND r.agent = ? AND r.session_id = ?`
    )
    .get(userId, deviceCode, agent, sessionId);
  return row && row.fp ? String(row.fp) : null;
}

/** 现有摘要的指纹与状态（用于比对） */
function l1Existing(userId) {
  return db
    .prepare('SELECT device_code, agent, session_id, status, content_hash, attempts, updated_at FROM l1_summaries WHERE user_id = ?')
    .all(userId)
    .reduce((m, r) => {
      m[`${r.device_code}\u0000${r.agent}\u0000${r.session_id}`] = r;
      return m;
    }, {});
}

/** 标记会话进入摘要队列（首次登记；已存在则不动，避免覆盖进行中的状态） */
function ensureL1Pending({ userId, deviceCode, agent, sessionId }) {
  const ts = now();
  db.prepare(
    `INSERT INTO l1_summaries (user_id, device_code, agent, session_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(user_id, device_code, agent, session_id) DO NOTHING`
  ).run(userId, deviceCode, agent, sessionId, ts, ts);
}

/** 取一批待处理的会话（pending，或 failed 但未超重试上限） */
function pickL1Pending({ maxAttempts = 3, limit = 5 } = {}) {
  return db
    .prepare(
      `SELECT user_id, device_code, agent, session_id, attempts, content_hash
         FROM l1_summaries
        WHERE status IN ('pending', 'failed') AND attempts < ?
        ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, updated_at ASC
        LIMIT ?`
    )
    .all(maxAttempts, limit);
}

/** 置为 running（防止多轮重复处理同一个） */
function markL1Running({ userId, deviceCode, agent, sessionId }) {
  db.prepare(
    `UPDATE l1_summaries SET status='running', attempts = attempts + 1, updated_at=?
      WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
  ).run(now(), userId, deviceCode, agent, sessionId);
}

/** 归档文件缺失等不可恢复情况 → 直接标记失败（不再重试） */
function markL1Failed({ userId, deviceCode, agent, sessionId, error, permanent = false }) {
  // 注意：不要把 attempts 重置为 0——markL1Running 已递增过它，清零会让失败任务
  // 永远达不到重试上限、无限重试（曾踩过：pickL1Pending 每轮都把它捞回来）。
  // 只有"永久失败"（归档文件不存在等）才把 attempts 顶到极大值停止重试。
  if (permanent) {
    db.prepare(
      `UPDATE l1_summaries SET status='failed', error=?, attempts=999, updated_at=?
        WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
    ).run(String(error || '').slice(0, 500), now(), userId, deviceCode, agent, sessionId);
    return;
  }
  db.prepare(
    `UPDATE l1_summaries SET status='failed', error=?, updated_at=?
      WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
  ).run(String(error || '').slice(0, 500), now(), userId, deviceCode, agent, sessionId);
}

/** 保存摘要产物（摘要成功） */
function saveL1Summary({ userId, deviceCode, agent, sessionId, contentHash: hash, records, first_ts: firstTs, last_ts: lastTs, overview, decisions, pending: pendingItems, artifacts, model }) {
  db.prepare(
    `UPDATE l1_summaries
        SET status='done', content_hash=?, error=NULL,
            overview=?, decisions=?, pending=?, artifacts=?,
            records=?, first_ts=?, last_ts=?, model=?, updated_at=?
      WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
  ).run(
    hash || null,
    overview || null,
    JSON.stringify(decisions || []),
    JSON.stringify(pendingItems || []),
    JSON.stringify(artifacts || []),
    records || 0,
    firstTs || null,
    lastTs || null,
    model || null,
    now(),
    userId, deviceCode, agent, sessionId
  );
}

/** 会话内容已变化 → 重新排队（保留旧摘要在库，直到新摘要覆盖） */
function requeueL1({ userId, deviceCode, agent, sessionId, contentHash: hash }) {
  db.prepare(
    `UPDATE l1_summaries SET status='pending', content_hash=?, attempts=0, updated_at=?
      WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
  ).run(hash, now(), userId, deviceCode, agent, sessionId);
}

/** 摘要清单（可按设备/agent 过滤），按会话最后时间倒序 */
function listL1Summaries(userId, { deviceCode, agent, limit = 200 } = {}) {
  const where = ['user_id = ?', "status = 'done'"];
  const args = [userId];
  if (deviceCode) { where.push('device_code = ?'); args.push(deviceCode); }
  if (agent) { where.push('agent = ?'); args.push(agent); }
  args.push(limit);
  return db
    .prepare(
      `SELECT device_code, agent, session_id, overview, decisions, pending, artifacts,
              records, first_ts, last_ts, model, updated_at
         FROM l1_summaries
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(last_ts, updated_at) DESC
        LIMIT ?`
    )
    .all(...args)
    .map(toL1Obj);
}

/** 单会话摘要 */
function getL1Summary(userId, { deviceCode, agent, sessionId }) {
  const row = db
    .prepare(
      `SELECT device_code, agent, session_id, status, overview, decisions, pending, artifacts,
              records, first_ts, last_ts, model, error, attempts, content_hash, updated_at
         FROM l1_summaries
        WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
    )
    .get(userId, deviceCode, agent, sessionId);
  return row ? toL1Obj(row) : null;
}

function toL1Obj(r) {
  return {
    ...r,
    decisions: safeParse(r.decisions, []),
    pending: safeParse(r.pending, []),
    artifacts: safeParse(r.artifacts, []),
  };
}

/** 摘要进度统计（Web / 运维查看） */
function l1Stats(userId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
              SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
              SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
              MAX(updated_at) last_run
         FROM l1_summaries WHERE user_id = ?`
    )
    .get(userId);
  return {
    total: row.total || 0,
    done: row.done || 0,
    pending: row.pending || 0,
    running: row.running || 0,
    failed: row.failed || 0,
    last_run: row.last_run || null,
  };
}

/** 启动自愈：把上次进程中断留下的 running 复位为 pending */
function resetStuckL1() {
  return db.prepare("UPDATE l1_summaries SET status='pending' WHERE status='running'").run().changes;
}

// ============ 统计 / 健康 ============

/** 记忆统计（健康检查与页面展示用） */
function stats(userId) {
  return {
    memories: db.prepare('SELECT COUNT(*) c FROM memories WHERE user_id = ?').get(userId).c,
    keys: db.prepare('SELECT COUNT(*) c FROM api_keys WHERE user_id = ? AND revoked_at IS NULL').get(userId).c,
  };
}

module.exports = {
  createMemory,
  getMemory,
  listMemories,
  exportMemories,
  searchMemories,
  updateMemory,
  deleteMemory,
  stats,
  l1Sources,
  l1SourceFp,
  l1Existing,
  ensureL1Pending,
  pickL1Pending,
  markL1Running,
  markL1Failed,
  saveL1Summary,
  requeueL1,
  listL1Summaries,
  getL1Summary,
  l1Stats,
  resetStuckL1,
  l0BatchExists,
  l0FilterNewRecords,
  l0MarkRecords,
  insertL0Batch,
  l0Stats,
  l0Sessions,
  upsertL0Device,
  findDeviceByFingerprint,
  listL0Devices,
  l0SessionOwned,
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
  createEvent,
  getEvent,
  processPendingEvents,
  cleanupEvents,
};
