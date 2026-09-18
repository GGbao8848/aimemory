'use strict';

/**
 * 可插拔向量层（sqlite-vec）。
 *
 * 定位：给 L2 记忆加真正的向量索引，替代 `repo.getVecCandidates` 的
 * 「把该用户所有带向量的记忆全读出来、在 JS 里逐条算余弦」。记忆上万条时，
 * 后者每次查询要扫上百 MB（每条向量 16KB）。
 *
 * **不可用时整体静默降级**：扩展缺失、未装、维度不匹配、L2_VEC=0 ——
 * 所有函数都不抛错，search 返回 null 让调用方退回关键词/全扫路径，功能不受影响。
 *
 * 四个实现要点（都是实测出来的，别再踩）：
 * 1. **rowid 必须用 BigInt 绑定**：better-sqlite3 把 JS number 绑成 REAL，
 *    而 vec0 的主键校验只认整型 → 传 number 报 "Only integers are allows for primary key values"。
 * 2. **距离度量必须声明 distance_metric=cosine**：默认是 L2 距离，与既有余弦阈值语义不一致
 *    （正交向量 L2 距离 1.414，余弦距离 1）。声明后 similarity = 1 - distance。
 * 3. **维度写进 l2_meta**：vec0 表维度固定，换 embedding 模型后必须重建索引；不匹配时降级而非给错结果。
 * 4. **KNN 支持 rowid 预过滤**（`rowid IN (SELECT ...)`），故能按 user 精确过滤而不必超取后剪枝。
 */

const config = require('../config');
const db = require('../db');

const TABLE = 'memories_vec';
const state = { checked: false, ok: false, reason: null, dim: null };

/** 惰性初始化：加载扩展 + 读取已知维度（只做一次） */
function init() {
  if (state.checked) return state;
  state.checked = true;

  if (!config.l2.vec) { state.reason = '已关闭（L2_VEC=0）'; return state; }

  try {
    const sqliteVec = require('sqlite-vec');
    db.loadExtension(sqliteVec.getLoadablePath());
  } catch (e) {
    state.reason = `扩展不可用：${e.message}`;
    return state;
  }

  const row = db.prepare("SELECT value FROM l2_meta WHERE key = 'vec_dim'").get();
  state.dim = row ? Number(row.value) : null;
  if (state.dim) ensureTable(state.dim);
  state.ok = true;
  return state;
}

function ensureTable(dim) {
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING vec0(embedding float[${Number(dim)}] distance_metric=cosine)`
  );
}

/** 首次写入时确定维度并建表（此后不再接受其它维度） */
function setDim(dim) {
  ensureTable(dim);
  db.prepare(
    `INSERT INTO l2_meta (key, value, updated_at) VALUES ('vec_dim', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(String(dim), new Date().toISOString());
  state.dim = dim;
}

/** 向量层是否可用（含原因，便于诊断/接口展示） */
function status() {
  const s = init();
  let indexed = null;
  if (s.ok) {
    try { indexed = db.prepare(`SELECT COUNT(*) n FROM ${TABLE}`).get().n; } catch { indexed = null; }
  }
  return { available: s.ok, reason: s.reason, dim: s.dim, indexed };
}

/** 写入/更新一条记忆的向量（按 memories.rowid 对齐） */
function upsert(memoryId, buf) {
  const s = init();
  if (!s.ok || !buf || !buf.length) return false;
  const dim = buf.length / 4;
  if (!s.dim) setDim(dim);
  if (s.dim !== dim) {
    if (!state.dimWarned) {
      state.dimWarned = true;
      console.error(`[l2] 向量维度不匹配（索引 ${s.dim}，当前 ${dim}）→ 向量检索降级为全扫，换模型后需重建索引`);
    }
    return false;
  }
  const row = db.prepare('SELECT rowid AS rid FROM memories WHERE id = ?').get(memoryId);
  if (!row) return false;
  try {
    db.prepare(`DELETE FROM ${TABLE} WHERE rowid = ?`).run(BigInt(row.rid));
    db.prepare(`INSERT INTO ${TABLE}(rowid, embedding) VALUES (?, ?)`).run(BigInt(row.rid), buf);
    return true;
  } catch (e) {
    console.error(`[l2] 向量写入失败（已降级关键词）：${e.message}`);
    return false;
  }
}

/** 删除一条记忆的向量（接受 memories.rowid） */
function remove(rowid) {
  const s = init();
  if (!s.ok || rowid == null) return false;
  try {
    db.prepare(`DELETE FROM ${TABLE} WHERE rowid = ?`).run(BigInt(rowid));
    return true;
  } catch { return false; }
}

/**
 * KNN 检索。
 * @returns {Array<{id:string, similarity:number}>|null} null=向量层不可用（调用方降级）
 */
function search(userId, queryBuf, k = 50, threshold = 0) {
  const s = init();
  if (!s.ok || !queryBuf || !queryBuf.length) return null;
  if (!s.dim) return null; // 索引还没建立（从没写过向量）
  if (queryBuf.length / 4 !== s.dim) return null;
  try {
    const rows = db.prepare(
      `SELECT m.id AS id, v.distance AS distance
         FROM ${TABLE} v JOIN memories m ON m.rowid = v.rowid
        WHERE v.embedding MATCH ? AND k = ?
          AND v.rowid IN (SELECT rowid FROM memories WHERE user_id = ?)
        ORDER BY v.distance`
    ).all(queryBuf, Math.max(1, k), userId);
    return rows
      .map((r) => ({ id: r.id, similarity: 1 - r.distance }))
      .filter((r) => r.similarity >= threshold);
  } catch (e) {
    console.error(`[l2] 向量检索失败（已降级）：${e.message}`);
    return null;
  }
}

/**
 * 用已存的 embedding BLOB 重建/补齐索引。
 * 用途：刚启用向量层时把历史记忆补进索引；换 embedding 模型后清空重建。
 */
function rebuild({ userId = null, reset = false } = {}) {
  const s = init();
  if (!s.ok) return { ok: false, reason: s.reason };
  if (reset) {
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
    db.prepare("DELETE FROM l2_meta WHERE key = 'vec_dim'").run();
    state.dim = null;
  }
  const rows = userId
    ? db.prepare('SELECT id FROM memories WHERE user_id = ? AND embedding IS NOT NULL').all(userId)
    : db.prepare('SELECT id FROM memories WHERE embedding IS NOT NULL').all();
  let indexed = 0;
  for (const r of rows) {
    const buf = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(r.id).embedding;
    if (upsert(r.id, buf)) indexed += 1;
  }
  return { ok: true, scanned: rows.length, indexed, dim: state.dim };
}

/**
 * 启动时补齐索引：只在「索引条数 < 有向量的记忆条数」时才做（避免每次启动全量重写）。
 * 场景：刚启用向量层、或换 embedding 模型后重建过。
 */
function ensureIndexed({ userId = null } = {}) {
  const s = init();
  if (!s.ok) return { ok: false, reason: s.reason };
  const want = (userId
    ? db.prepare('SELECT COUNT(*) n FROM memories WHERE user_id = ? AND embedding IS NOT NULL').get(userId)
    : db.prepare('SELECT COUNT(*) n FROM memories WHERE embedding IS NOT NULL').get()).n;
  let have = 0;
  try { have = db.prepare(`SELECT COUNT(*) n FROM ${TABLE}`).get().n; } catch { have = 0; }
  if (have >= want) return { ok: true, skipped: true, want, have };
  return { ...rebuild({ userId }), want, have };
}

module.exports = { status, upsert, remove, search, rebuild, ensureIndexed, init };
