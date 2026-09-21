'use strict';

// 记忆域：memories 表的 CRUD + 混合检索（向量语义 + FTS 关键词 + OR 计分兜底）。
// 素材受理与提炼管线在 ./events（本模块只面向"已入库的记忆"）。

const db = require('../index');
const llm = require('../../llm/client'); // 对象引用（便于测试 stub）
const emb = require('../../embeddings/client');
const vec = require('../../l2/vec'); // 向量索引；不可用时其函数返回 null/false，自动退回全扫
const entityStore = require('../../l2/entities'); // 实体聚合表（entities/categories 标注同步）
const store = require('../../l2/store');
const { now, toObj, clamp } = require('./_common');

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
        `SELECT m.id, m.text, m.metadata, m.facts, m.entities, m.categories, m.agent_id, m.run_id, m.created_at, m.updated_at, bm25(memories_fts) AS score
         FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.user_id = ?${fsql} ORDER BY score LIMIT 500`
      )
      .all(match, userId, ...fparams);
  }
  // 3. FTS 无候选（全为 1-2 字符短词）→ 全表兜底
  if (!ftsRows.length) {
    ftsRows = db
      .prepare(
        `SELECT m.id, m.text, m.metadata, m.facts, m.entities, m.categories, m.agent_id, m.run_id, m.created_at, m.updated_at, 0 AS score
         FROM memories m WHERE m.user_id = ?${fsql} ORDER BY m.updated_at DESC LIMIT 500`
      )
      .all(userId, ...fparams);
  }

  // 4a. 严格 AND 过滤（高精度：每个查询词都必须出现）
  let ftsFiltered = ftsRows.filter((m) => {
    const hay = `${m.text}\n${m.facts || ''}\n${m.entities || ''}`;
    return words.every((w) => hay.includes(w));
  });

  // 4b. OR 计分兜底（基线教训：中文自然语言查询「部署在哪台机器」整句不逐字出现时，
  //     严格过滤得 0 结果、命中率 3.8%）。做法：查询切词根（CJK 滑窗 + 拉丁词），
  //     按不同词根命中数排序兜底——宁可宽一点，也不能对用户的自然语言问句交白卷。
  if (!ftsFiltered.length) {
    const tokens = searchTokens(q);
    if (tokens.length) {
      ftsFiltered = ftsRows
        .map((m) => {
          const hay = `${m.text}\n${m.facts || ''}\n${m.entities || ''}`.toLowerCase();
          return { ...m, _score: tokens.filter((t) => hay.includes(t)).length };
        })
        .filter((m) => m._score > 0)
        .sort((a, b) => (b._score - a._score) || String(b.updated_at).localeCompare(String(a.updated_at)));
    }
  }
  // 5. 合并：向量召回优先（语义命中排前），再补关键词字面命中；score 单一来源
  const seen = new Set();
  const merged = [];
  const push = (m, score) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    merged.push({ ...m, score: Number(score.toFixed(4)) });
  };
  for (const m of vecCandidates) push(m, m.similarity);
  for (const m of ftsFiltered) push(m, m.score ?? 0);

  return merged.slice(0, limit).map(toObj);
}

/** 检索词根：查询切 CJK 滑窗（步长 1，真实词不对齐固定步长）+ 拉丁词，小写归一 */
function searchTokens(q) {
  const ql = String(q || '').toLowerCase();
  const out = new Set();
  for (const run of ql.match(/[\u3400-\u9fff]{2,}/g) || []) {
    if (run.length <= 4) out.add(run);
    else for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  for (const w of ql.match(/[a-z0-9][a-z0-9._:/-]*/g) || []) {
    if (w.length >= 2) out.add(w);
  }
  return [...out];
}

/** 向量候选：查询向量化后取 topN。优先走 sqlite-vec 索引，不可用时退回全扫 + JS 余弦。 */
function getVecCandidates(userId, query, topN, threshold, fsql, fparams) {
  const cfg = require('../../config').embedding;
  if (!cfg.enabled) return [];
  return emb.embed(query).then((qVec) => {
    if (!qVec) return [];

    // 向量索引：语义与全扫一致（余弦 + 阈值），但不随记忆条数变慢。
    // 有附加过滤（metadata/时间范围）时不走——索引只能按 rowid 预过滤，表达不了这些条件。
    if (!fsql) {
      const hits = vec.search(userId, qVec, Math.max(topN * 2, 50), threshold);
      if (hits) {
        if (!hits.length) return [];
        const ph = hits.map(() => '?').join(',');
        const rows = db
          .prepare(
            `SELECT m.id, m.text, m.metadata, m.facts, m.entities, m.categories, m.agent_id, m.run_id, m.created_at, m.updated_at, m.embedding
               FROM memories m WHERE m.user_id = ? AND m.id IN (${ph})`
          )
          .all(userId, ...hits.map((h) => h.id));
        const simById = new Map(hits.map((h) => [h.id, h.similarity]));
        return rows
          .map((r) => ({ ...r, similarity: simById.get(r.id) }))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, topN);
      }
      // hits === null：向量层不可用 → 落到下面的全扫
    }

    const rows = db
      .prepare(
        `SELECT m.id, m.text, m.metadata, m.facts, m.entities, m.categories, m.agent_id, m.run_id, m.created_at, m.updated_at, m.embedding
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

// ============ 记忆更新 / 删除（人工路径也留 history，mem0 语义） ============

function recordHistory({ userId, memoryId, op, beforeText = null, afterText = null, source = 'manual' }) {
  // 统一走 l2/store 的唯一写入口：webhooks 投递等钩子挂在那里，避免双路径漏发
  store.recordOp({ userId, memoryId, op, beforeText, afterText, source });
}

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
    recordHistory({ userId, memoryId: id, op: 'UPDATE', beforeText: existing.text, afterText: newText });
  }
  return toObj(getMemoryRow(id, userId));
}

function deleteMemory(id, userId) {
  const row = db.prepare('SELECT rowid AS rid, text FROM memories WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return false;
  db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(id, userId);
  vec.remove(row.rid); // 向量索引同步清掉（不可用时静默）
  recordHistory({ userId, memoryId: id, op: 'DELETE', beforeText: row.text });
  return true;
}

// ============ 多维过滤 SQL ============
// metadata：键值对象（如 {source:"claude-code"}）；agent_id/run_id：精确匹配；
// entity：实体名（归一化关联表过滤）；category：分类词（JSON 列过滤）；
// created_at/updated_at：{gte, lte} 时间范围；keywords：全文 LIKE
function filtersClause(alias, filters = {}) {
  const a = alias ? `${alias}.` : '';
  const parts = [];
  const params = [];
  for (const field of ['agent_id', 'run_id']) {
    if (filters[field] !== undefined && filters[field] !== null) {
      parts.push(`${a}${field} = ?`);
      params.push(String(filters[field]));
    }
  }
  if (filters.entity !== undefined && String(filters.entity).trim()) {
    // 实体：走归一化关联表（与 entities 列表的 norm 口径一致）
    parts.push(`${a}id IN (SELECT me.memory_id FROM memory_entities me JOIN entities e ON e.id = me.entity_id WHERE e.norm = ?)`);
    params.push(String(filters.entity).trim().replace(/\s+/g, ' ').toLowerCase());
  }
  if (filters.category !== undefined && String(filters.category).trim()) {
    parts.push(`EXISTS (SELECT 1 FROM json_each(${a}categories) je WHERE je.value = ?)`);
    params.push(String(filters.category).trim().toLowerCase());
  }
  if (filters.keywords !== undefined && String(filters.keywords).trim()) {
    parts.push(`${a}text LIKE ?`);
    params.push(`%${String(filters.keywords).trim()}%`);
  }
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

// ============ 向量 / 事实增强（更新路径的异步补充） ============

/**
 * 异步 LLM 抽取 facts/entities：仅用于 update_memory（用户手动编辑最终文本后重抽，供语义召回增强）。
 * 失败静默。新写入的提炼产物不走此路径（见 src/l2/store.js 的 insertFact）。
 */
function syncFacts(id, text) {
  const prompt = `从下面的文本中提取 JSON（不要其他内容）：
{"facts": ["独立可复用的简短事实，每条一个字符串"], "entities": ["专有名词实体：公司/组织/人名/地名/IP/端口/技术名等，每个一个字符串"], "categories": ["1~2个小写英文类别词，如 tech/devops/network/project/preference"]}
无法提取的字段给空数组。\n\n文本：${String(text).slice(0, 4000)}`;
  llm.complete([
    { role: 'system', content: '你是信息抽取助手，只输出合法 JSON。' },
    { role: 'user', content: prompt },
  ], { maxTokens: 1024, temperature: 0.1 })
    .then((content) => {
      if (!content) return;
      let facts = [], entities = [], categories = [];
      try {
        const parsed = JSON.parse(content);
        facts = Array.isArray(parsed.facts) ? parsed.facts.filter((f) => typeof f === 'string' && f.trim().length >= 3) : [];
        entities = Array.isArray(parsed.entities) ? parsed.entities.filter((e) => typeof e === 'string' && e.trim().length >= 2) : [];
        categories = Array.isArray(parsed.categories) ? parsed.categories.filter((c) => typeof c === 'string' && c.trim().length >= 2) : [];
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
      // 实体聚合表同步（categories 一并写入快照；userId 从行上取，缺失时跳过聚合）
      const row = db.prepare('SELECT user_id FROM memories WHERE id = ?').get(id);
      if (row) {
        try {
          entityStore.applyClassification({ userId: row.user_id, memoryId: id, entities, categories });
        } catch { /* 标注失败不影响 */ }
      }
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

/** 异步为记忆补 embedding 向量（新增/更新后调用）；失败静默，搜索自动回退关键词。
 *  来源标记随之升级：llm → llm+embedding（direct 的原文直存不因补向量改标）。 */
function syncEmbedding(id, text) {
  emb.embed(String(text).slice(0, 8000)).then((vec) => {
    if (!vec) return;
    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(vec, id);
    db.prepare("UPDATE memories SET origin = 'llm+embedding' WHERE id = ? AND origin = 'llm'").run(id);
  }).catch(() => {});
}

module.exports = {
  getMemory,
  listMemories,
  exportMemories,
  searchMemories,
  updateMemory,
  deleteMemory,
};
