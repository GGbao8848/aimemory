'use strict';

const crypto = require('crypto');
const db = require('./index');
const { embed, embedBatch } = require('../embeddings/client');
const { complete } = require('../llm/client');

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const parseFacts = (s) => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
};
const toObj = (row) => {
  if (!row) return null;
  const { embedding, ...rest } = row; // embedding 为内部向量，不对外暴露
  return { ...rest, metadata: JSON.parse(rest.metadata || '{}'), facts: parseFacts(rest.facts) };
};

function clamp(n, min, max, def) {
  const v = Number.parseInt(n, 10);
  if (Number.isNaN(v)) return def;
  return Math.min(Math.max(v, min), max);
}

// ============ 记忆 CRUD（所有查询强制 user_id 隔离） ============

function getMemoryRow(id, userId) {
  return db
    .prepare('SELECT * FROM memories WHERE id = ? AND user_id = ?')
    .get(id, userId);
}

function getHistory(memoryId, userId) {
  return db
    .prepare(
      `SELECT event_type, prev_text, prev_metadata, prev_updated_at, created_at
       FROM memories_history WHERE memory_id = ? AND user_id = ?
       ORDER BY id ASC`
    )
    .all(memoryId, userId)
    .map((h) => ({
      event_type: h.event_type,
      prev_value: {
        text: h.prev_text,
        metadata: JSON.parse(h.prev_metadata || '{}'),
        updated_at: h.prev_updated_at,
      },
      created_at: h.created_at,
    }));
}

/**
 * 创建记忆。支持两种输入：
 * - text：单条文本（保留原行为）
 * - messages：多轮对话 [{role, content}...]，LLM 提炼成记忆文本入库（mem0 兼容）
 * agentId/runId：作用域隔离，null 表示全局（无 agent/run 归属）
 */
async function createMemory({ userId, text, messages, metadata = {}, infer = true, agentId = null, runId = null }) {
  const id = uuid();
  const ts = now();
  const agent = agentId || null;
  const run = runId || null;

  // messages 模式：拼接对话 → LLM 提炼成单条记忆文本
  let storeText = text;
  let extracted = null;
  if (messages && Array.isArray(messages) && messages.length) {
    const dialogue = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
    storeText = await summarizeDialogue(dialogue); // 提炼失败时回退为原文截断
    extracted = storeText;
  }
  if (!storeText || !String(storeText).trim()) {
    storeText = String(text || messages?.map((m) => m.content).filter(Boolean).join(' ')).slice(0, 8000);
  }

  db.prepare(
    'INSERT INTO memories (id, user_id, text, metadata, facts, agent_id, run_id, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)'
  ).run(id, userId, storeText, JSON.stringify(metadata || {}), agent, run, ts, ts);
  syncEmbedding(id, storeText); // 异步补向量，失败静默
  if (infer) syncFacts(id, storeText); // 异步 LLM 抽取事实，抽取后再补一次向量
  const row = getMemoryRow(id, userId);
  return { ...toObj(row), extracted };
}

/** 多轮对话 → LLM 提炼成简洁记忆文本；失败返回 null（调用方回退原文） */
async function summarizeDialogue(dialogue) {
  const content = await complete([
    {
      role: 'system',
      content: '你是记忆提炼助手。把下面的对话提炼成一条简洁、可复用的记忆陈述，保留关键事实（人名、数字、偏好、决策、命令等）。只输出提炼后的记忆本身，不要解释、不要编号、不要前缀。',
    },
    { role: 'user', content: `对话：\n${dialogue.slice(0, 6000)}` },
  ], { maxTokens: 512, temperature: 0.1 });
  const trimmed = content?.trim();
  return trimmed && trimmed.length >= 3 ? trimmed : null;
}

/**
 * 多轮对话 → LLM 提炼成多条独立记忆并逐条入库（mem0 批量模式）。
 * LLM 返回多行事实，每行一条独立记忆（独立向量 + facts）。失败/无事实时回退单条合并。
 * 返回 [{id, text}]。
 */
async function createMemoriesFromDialogue({ userId, messages, metadata = {}, infer = true, agentId = null, runId = null }) {
  const dialogue = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
  const content = await complete([
    {
      role: 'system',
      content: '你是记忆提炼助手。把下面的对话提炼成多条独立的、可复用的简短事实陈述，每条用一行输出，不要编号、不要前缀、不要解释。合并同主题，拆开不同主题，每条都是独立可检索的事实。只输出事实本身，无法提炼时输出空。',
    },
    { role: 'user', content: `对话：\n${dialogue.slice(0, 6000)}` },
  ], { maxTokens: 2048, temperature: 0.1 });

  let facts = [];
  if (content) {
    facts = content
      .split('\n')
      .map((l) => l.replace(/^[-*•\d.\s]+/, '').trim())
      .filter((l) => l.length >= 3);
  }

  // 提炼出多条 → 逐条入库；否则回退为单条合并（原 summarize 行为）
  const items = facts.length ? facts : [await summarizeDialogue(dialogue)].filter(Boolean);
  if (!items.length) {
    const fallback = String(messages.map((m) => m.content).filter(Boolean).join(' ')).slice(0, 8000);
    items.push(fallback);
  }

  const created = [];
  for (const item of items) {
    const mem = await createMemory({ userId, text: item, metadata, infer, agentId, runId });
    created.push({ id: mem.id, text: mem.text });
  }
  return created;
}

/**
 * 异步 LLM 事实抽取：把自由文本提炼成结构化事实（字符串数组）存 facts 列。
 * 抽取成功后重算向量（text + facts），让事实参与语义召回。失败静默，原样保留。
 */
function syncFacts(id, text) {
  const prompt = `请从下面的文本中提炼出独立的、可复用的简短事实陈述，每条用一行输出，不要编号、不要前缀、不要解释。只输出事实本身，无法提炼时输出空。\n\n文本：${String(text).slice(0, 4000)}`;
  complete([
    { role: 'system', content: '你是信息抽取助手，只输出事实条目，每行一条，语言与输入一致。' },
    { role: 'user', content: prompt },
  ], { maxTokens: 1024, temperature: 0.1 })
    .then((content) => {
      if (!content) return;
      const facts = content
        .split('\n')
        .map((l) => l.replace(/^[-*•\d.\s]+/, '').trim())
        .filter((l) => l.length >= 3);
      if (!facts.length) return;
      db.prepare('UPDATE memories SET facts = ? WHERE id = ?').run(JSON.stringify(facts), id);
      // 事实就绪后重算向量（text + facts）
      const vec = embed(semanticText(text, facts));
      vec.then((v) => {
        if (v) db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(v, id);
      }).catch(() => {});
    })
    .catch(() => {});
}

/** 语义向量文本源：原文 + 抽取事实（增强事实命中） */
function semanticText(text, facts = []) {
  return facts.length ? `${text}\n${facts.join('\n')}` : String(text).slice(0, 8000);
}

/** 异步为记忆补 embedding 向量（新增/更新后调用）；失败静默，搜索自动回退关键词 */
function syncEmbedding(id, text) {
  embed(String(text).slice(0, 8000)).then((vec) => {
    if (vec) db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(vec, id);
  }).catch(() => {});
}

function getMemory(id, userId) {
  const row = getMemoryRow(id, userId);
  if (!row) return null;
  return { ...toObj(row), history: getHistory(id, userId) };
}

/** 作用域过滤 SQL：传入 agentId/runId 则精确匹配，未传则不限制（兼容全局/旧数据） */
function scopeClause(alias, { agentId, runId }) {
  const a = alias ? `${alias}.` : '';
  const parts = [];
  const params = [];
  if (agentId) { parts.push(`${a}agent_id = ?`); params.push(agentId); }
  if (runId) { parts.push(`${a}run_id = ?`); params.push(runId); }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}

function listMemories({ userId, page = 1, pageSize = 10, agentId, runId }) {
  page = clamp(page, 1, 100000, 1);
  pageSize = clamp(pageSize, 1, 100, 10);
  const scope = scopeClause('', { agentId, runId });
  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM memories WHERE user_id = ?${scope.sql}`)
    .get(userId, ...scope.params).c;
  const rows = db
    .prepare(
      `SELECT * FROM memories WHERE user_id = ?${scope.sql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    )
    .all(userId, ...scope.params, pageSize, (page - 1) * pageSize);
  return { results: rows.map(toObj), total, page, pageSize };
}

async function searchMemories({ userId, query, limit = 10, threshold = 0, agentId, runId }) {
  limit = clamp(limit, 1, 100, 10);
  const q = (query || '').trim();
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const scope = scopeClause('m', { agentId, runId });

  // 1. 向量语义召回：查询向量与所有带向量记忆做余弦相似度，取 topN 候选
  //    （embedding 未启用/失败/无向量数据时返回 []，自动走关键词路径）
  const topN = Math.max(limit * 4, 50);
  const vecCandidates = await getVecCandidates(userId, q, topN, threshold, scope);

  // 2. FTS5 trigram 关键词候选：>=3 字符的词 AND 匹配（trigram 无法索引 1-2 字符片段）
  const ftsWords = words.filter((w) => w.length >= 3);
  let ftsRows = [];
  if (ftsWords.length) {
    const match = ftsWords.map((w) => `"${w.replace(/"/g, '""')}"`).join(' AND ');
    ftsRows = db
      .prepare(
        `SELECT m.id, m.text, m.metadata, m.facts, m.created_at, m.updated_at, bm25(memories_fts) AS score
         FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.user_id = ?${scope.sql} ORDER BY score LIMIT 500`
      )
      .all(match, userId, ...scope.params);
  }

  // 3. 关键词全表兜底（FTS 无候选，全为短词）
  if (!ftsRows.length) {
    ftsRows = db
      .prepare(
        `SELECT m.id, m.text, m.metadata, m.facts, m.created_at, m.updated_at, 0 AS score
         FROM memories m WHERE m.user_id = ?${scope.sql} ORDER BY m.updated_at DESC LIMIT 500`
      )
      .all(userId, ...scope.params);
  }
  // 4. LIKE 二次过滤：每个词都必须出现在 text 或 facts 中（覆盖 2 字符中文词如"端口"，含 infer 事实命中）
  ftsRows = ftsRows.filter((m) => {
    const hay = `${m.text}\n${m.facts || ''}`;
    return words.every((w) => hay.includes(w));
  });

  // 5. 混合去重合并：向量召回优先（语义命中），再补关键词命中（保底字面命中）
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

/**
 * 向量候选：查询文本向量化后与该用户全部带向量记忆做余弦相似度。
 * embedding 未启用/失败/无向量数据时返回 []（调用方走关键词路径）。
 */
function getVecCandidates(userId, query, topN, threshold, scope = { sql: '', params: [] }) {
  const cfg = require('../config').embedding;
  if (!cfg.enabled) return [];
  return embed(query).then((qVec) => {
    if (!qVec) return [];
    const rows = db
      .prepare(
        `SELECT m.id, m.text, m.metadata, m.created_at, m.updated_at, m.embedding FROM memories m WHERE m.user_id = ? AND m.embedding IS NOT NULL${scope.sql}`
      )
      .all(userId, ...scope.params);
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

function updateMemory({ id, userId, text, metadata }) {
  const existing = getMemoryRow(id, userId);
  if (!existing) return null;
  const ts = now();
  const newText = text !== undefined ? String(text) : existing.text;
  const newMeta =
    metadata !== undefined ? JSON.stringify(metadata) : existing.metadata;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO memories_history
       (memory_id, user_id, event_type, prev_text, prev_metadata, prev_updated_at, created_at)
       VALUES (?, ?, 'UPDATE', ?, ?, ?, ?)`
    ).run(id, userId, existing.text, existing.metadata, existing.updated_at, ts);
    db.prepare('UPDATE memories SET text = ?, metadata = ?, updated_at = ? WHERE id = ?').run(
      newText, newMeta, ts, id
    );
  });
  tx();
  if (newText !== existing.text) {
    db.prepare('UPDATE memories SET facts = NULL WHERE id = ?').run(id);
    syncEmbedding(id, newText);
    syncFacts(id, newText); // 文本变化后重抽事实（向量会由 syncFacts 基于 text+facts 重算）
  }
  return toObj(getMemoryRow(id, userId));
}

function deleteMemory(id, userId) {
  const existing = getMemoryRow(id, userId);
  if (!existing) return false;
  const ts = now();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO memories_history
       (memory_id, user_id, event_type, prev_text, prev_metadata, prev_updated_at, created_at)
       VALUES (?, ?, 'DELETE', ?, ?, ?, ?)`
    ).run(id, userId, existing.text, existing.metadata, existing.updated_at, ts);
    db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(id, userId);
  });
  tx();
  return true;
}

// ============ 实体/批量管理（对齐 mem0 工具面） ============

/** 清空指定用户全部记忆（mem0 delete_all_memories 的 user 语义；不删用户本身） */
function deleteAllMemories(userId) {
  const total = db.prepare('SELECT COUNT(*) c FROM memories WHERE user_id = ?').get(userId).c;
  if (!total) return { deleted: 0 };
  const tx = db.transaction(() => {
    const ts = now();
    const rows = db.prepare('SELECT * FROM memories WHERE user_id = ?').all(userId);
    const ins = db.prepare(
      `INSERT INTO memories_history
       (memory_id, user_id, event_type, prev_text, prev_metadata, prev_updated_at, created_at)
       VALUES (?, ?, 'DELETE', ?, ?, ?, ?)`
    );
    const del = db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?');
    for (const r of rows) {
      ins.run(r.id, userId, r.text, r.metadata, r.updated_at, ts);
      del.run(r.id, userId);
    }
  });
  tx();
  return { deleted: total };
}

/** 列出有记忆的实体（mem0 list_entities：当前仅 user 维度，返回各用户记忆数） */
function listEntities() {
  return db
    .prepare(
      `SELECT user_id, COUNT(*) AS memory_count, MAX(updated_at) AS last_active_at
       FROM memories GROUP BY user_id ORDER BY last_active_at DESC`
    )
    .all();
}

/** 删除实体及其全部记忆（mem0 delete_entities；同时清理该用户的密钥与会话） */
function deleteEntities(userId) {
  const memCount = db.prepare('SELECT COUNT(*) c FROM memories WHERE user_id = ?').get(userId).c;
  const tx = db.transaction(() => {
    const ts = now();
    const rows = db.prepare('SELECT * FROM memories WHERE user_id = ?').all(userId);
    const ins = db.prepare(
      `INSERT INTO memories_history
       (memory_id, user_id, event_type, prev_text, prev_metadata, prev_updated_at, created_at)
       VALUES (?, ?, 'DELETE', ?, ?, ?, ?)`
    );
    for (const r of rows) {
      ins.run(r.id, userId, r.text, r.metadata, r.updated_at, ts);
    }
    db.prepare('DELETE FROM memories WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  });
  tx();
  return { deleted: memCount };
}

// ============ API Key ============

function createApiKey({ userId, name = 'default', tokenHash }) {
  const row = {
    id: uuid(),
    user_id: userId,
    name,
    token_hash: tokenHash,
    created_at: now(),
    revoked_at: null,
  };
  db.prepare(
    'INSERT INTO api_keys (id, user_id, name, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(row.id, row.user_id, row.name, row.token_hash, row.created_at, row.revoked_at);
  return row;
}

function listApiKeys(userId) {
  return db
    .prepare(
      'SELECT id, user_id, name, created_at, revoked_at FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC'
    )
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

// ============ 连接码（半自动连接）============

const CODE_TTL_MS = 10 * 60 * 1000; // 10 分钟

/** 生成 XXXX-XXXX 格式短码（去掉易混淆字符 I/O/0/1） */
function generateConnectCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${seg()}-${seg()}`;
}

/**
 * 【旧】连接码模式：创建连接请求（生成密钥+短码）。新逻辑见下方设备流 createConnectRequest。
 */
function createLegacyConnectRequest(userId) {
  const active = db
    .prepare('SELECT * FROM connect_codes WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?')
    .get(userId, now());
  if (active) {
    return { code: active.code, api_key: active.token_plain, user_id: userId };
  }
  const ts = now();
  // 生成一次 token：明文入码表（TTL 窗口），哈希入 api_keys（持久）
  const { token, id: keyId } = require('../auth/tokens').createApiKey(userId, 'connect');
  const code = generateConnectCode();
  db.prepare(
    `INSERT INTO connect_codes (code, user_id, api_key_id, token_plain, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`
  ).run(code, userId, keyId, token, ts, new Date(Date.now() + CODE_TTL_MS).toISOString());
  return { code, api_key: token, user_id: userId };
}

/** 兑换连接码：一次性 + TTL 校验；成功返回 { user_id, api_key, mcp_url }，失败返回 null */
function consumeConnectCode(code) {
  const row = db.prepare('SELECT * FROM connect_codes WHERE code = ?').get(code);
  if (!row) return null;
  if (row.consumed_at) return null;
  if (row.expires_at <= now()) return null;
  db.prepare('UPDATE connect_codes SET consumed_at = ? WHERE code = ?').run(now(), code);
  return { user_id: row.user_id, api_key: row.token_plain, api_key_id: row.api_key_id };
}

/** 清理过期 / 已消费的码（明文随之删除，不留痕） */
function cleanupConnectCodes() {
  db.prepare('DELETE FROM connect_codes WHERE consumed_at IS NOT NULL OR expires_at <= ?').run(now());
}

// ============ 设备流连接（零粘贴）============

const REQ_TTL_MS = 10 * 60 * 1000; // 10 分钟

/** 生成 32 位随机请求 id（agent 轮询凭据） */
function generateRequestId() {
  return crypto.randomBytes(24).toString('hex');
}

/** 创建设备流连接请求（匿名 pending，不建 key）；返回 { request_id } */
function createConnectRequest() {
  const requestId = generateRequestId();
  const ts = now();
  db.prepare(
    `INSERT INTO connect_requests (request_id, user_id, status, created_at, expires_at)
     VALUES (?, NULL, 'pending', ?, ?)`
  ).run(requestId, ts, new Date(Date.now() + REQ_TTL_MS).toISOString());
  return { request_id: requestId };
}

/** 确认授权：绑定当前登录用户 + 生成 API Key（命名自动去重）；返回 { token, key_name } */
function confirmConnectRequest(requestId, userId, name) {
  const row = db.prepare('SELECT * FROM connect_requests WHERE request_id = ?').get(requestId);
  if (!row) return null;
  if (row.status !== 'pending') return null;
  if (row.user_id && row.user_id !== userId) return null; // 已被他人绑定
  if (row.expires_at <= now()) {
    db.prepare("UPDATE connect_requests SET status='expired' WHERE request_id=?").run(requestId);
    return null;
  }
  const safeName = (name || '').trim().slice(0, 50) || 'zcode';
  const keyName = uniqueApiKeyName(userId, safeName);
  const { token, id: keyId } = require('../auth/tokens').createApiKey(userId, keyName);
  db.prepare(
    `UPDATE connect_requests SET status='authorized', user_id=?, key_name=?, api_key_id=?, token_plain=?, confirmed_at=? WHERE request_id=?`
  ).run(userId, keyName, keyId, token, now(), requestId);
  return { token, key_name: keyName, api_key_id: keyId };
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

/** 唯一化 API Key 名称（重名自动加 -2/-3…），解决"token 重名" */
function uniqueApiKeyName(userId, base) {
  const exists = db
    .prepare("SELECT name FROM api_keys WHERE user_id=? AND revoked_at IS NULL AND name=?")
    .get(userId, base);
  if (!exists) return base;
  let i = 2;
  while (db.prepare("SELECT 1 FROM api_keys WHERE user_id=? AND revoked_at IS NULL AND name=?").get(userId, `${base}-${i}`)) i++;
  return `${base}-${i}`;
}

module.exports = {
  createMemory,
  createMemoriesFromDialogue,
  getMemory,
  listMemories,
  searchMemories,
  updateMemory,
  deleteMemory,
  deleteAllMemories,
  listEntities,
  deleteEntities,
  createApiKey,
  listApiKeys,
  findUserIdByTokenHash,
  revokeApiKey,
  createSession,
  getSession,
  deleteSession,
  cleanupSessions,
  createLegacyConnectRequest,
  consumeConnectCode,
  cleanupConnectCodes,
  createConnectRequest,
  confirmConnectRequest,
  pollConnectRequest,
  cleanupConnectRequests,
  uniqueApiKeyName,
};
