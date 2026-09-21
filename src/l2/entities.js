'use strict';

/**
 * 实体域（对齐 mem0 平台的 entities 概念，2026-09-20）：
 * - attach：把一批实体名挂到记忆上——归一化（小写去空白）查重入 entities 表，
 *   写 memory_entities 关联，并同步 memories.entities 快照（对外展示用）。
 * - list：实体清单（带关联记忆计数，降序）。
 * - 归一化键 norm 只做查重/过滤；展示保留首见写法（IP/端口/版本号等大小写有意义）。
 */

const crypto = require('crypto');
const db = require('../db');

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

/** 实体名归一化：trim + 折叠空白 + 小写 */
function normalize(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 清洗实体名列表：去空、去重（归一化口径）、限量 */
function cleanNames(names, max = 8) {
  const seen = new Set();
  const out = [];
  for (const n of Array.isArray(names) ? names : []) {
    if (typeof n !== 'string') continue;
    const t = n.trim();
    if (t.length < 1 || t.length > 100) continue;
    const k = normalize(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 把实体挂到记忆上，并把 categories/entities 快照写到记忆行。
 * classification: { entities: string[], categories: string[] }
 */
function applyClassification({ userId, memoryId, entities = [], categories = [] }) {
  const names = cleanNames(entities);
  for (const name of names) {
    const norm = normalize(name);
    let row = db.prepare('SELECT id FROM entities WHERE user_id = ? AND norm = ?').get(userId, norm);
    if (!row) {
      const id = uuid();
      db.prepare('INSERT INTO entities (id, user_id, name, norm, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, userId, name, norm, now());
      row = { id };
    }
    db.prepare('INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)')
      .run(memoryId, row.id);
  }

  const cats = cleanNames(categories, 4).map((c) => c.toLowerCase());
  const snapshot = names.length ? JSON.stringify(names) : null;
  db.prepare('UPDATE memories SET entities = COALESCE(?, entities), categories = ? WHERE id = ?')
    .run(snapshot, cats.length ? JSON.stringify(cats) : null, memoryId);
  return { entities: names, categories: cats };
}

/** 移除记忆与实体的关联（删记忆走 FK CASCADE，此函数用于解挂但保留记忆的场景） */
function detachMemory(memoryId) {
  db.prepare('DELETE FROM memory_entities WHERE memory_id = ?').run(memoryId);
}

/** 抽取专名清单（带关联记忆数，降序；供记忆页"关键词"过滤）。
 *  注意：这是从记忆文本抽取的名词，不是 mem0 平台 Entities 页的作用域语义（见 listScopes）。 */
function listEntities(userId, limit = 200) {
  return db.prepare(`
    SELECT e.id, e.name, COUNT(me.memory_id) AS count
      FROM entities e
      LEFT JOIN memory_entities me ON me.entity_id = e.id
     WHERE e.user_id = ?
     GROUP BY e.id
     ORDER BY count DESC, e.name ASC
     LIMIT ?
  `).all(userId, Math.max(1, Math.min(Number(limit) || 200, 1000)));
}

/**
 * 作用域实体（对齐 mem0 平台的 entities 语义：user/agent/run 记忆归属维度）。
 * 返回 [{type, name, memories, last_updated}]；user 在单用户部署下恒为部署者本人。
 */
function listScopes(userId, userName) {
  const user = db
    .prepare('SELECT COUNT(*) AS memories, MAX(updated_at) AS last_updated FROM memories WHERE user_id = ?')
    .get(userId);
  const agents = db
    .prepare(`SELECT agent_id AS name, COUNT(*) AS memories, MAX(updated_at) AS last_updated
                FROM memories WHERE user_id = ? AND agent_id IS NOT NULL GROUP BY agent_id ORDER BY memories DESC`)
    .all(userId)
    .map((r) => ({ type: 'agent', ...r }));
  const runs = db
    .prepare(`SELECT run_id AS name, COUNT(*) AS memories, MAX(updated_at) AS last_updated
                FROM memories WHERE user_id = ? AND run_id IS NOT NULL GROUP BY run_id ORDER BY memories DESC`)
    .all(userId)
    .map((r) => ({ type: 'run', ...r }));
  return [
    { type: 'user', name: userName || userId, memories: user.memories, last_updated: user.last_updated },
    ...agents,
    ...runs,
  ];
}

/** 分类清单（从 memories.categories JSON 聚合，降序） */
function listCategories(userId, limit = 100) {
  return db.prepare(`
    SELECT je.value AS name, COUNT(*) AS count
      FROM memories, json_each(memories.categories) je
     WHERE memories.user_id = ? AND json_valid(memories.categories)
     GROUP BY je.value
     ORDER BY count DESC, je.value ASC
     LIMIT ?
  `).all(userId, Math.max(1, Math.min(Number(limit) || 100, 500)));
}

module.exports = { applyClassification, detachMemory, listEntities, listScopes, listCategories, cleanNames, normalize };
