'use strict';

/**
 * L2 冲突消解：mem0 式四操作（ADD / UPDATE / DELETE / NOOP）。
 *
 * 定位：`extractMemories`（把素材变成事实）之后、入库之前的**比对环节**。
 * 没有它时同一事实反复入库、新旧取值并存互相矛盾；有了它，记忆量由"加了什么"变成
 * "记得什么"——这是「自动凝练不失控」的关键机制（调研文档 §3 要点 3）。
 *
 * 三条设计约束（都来自本项目的现实条件）：
 *
 * 1. **候选召回不能依赖 embedding**：生产 embedding 是可选组件、本机没有。
 *    故用 FTS5 trigram（≥3 字符）召回 + 短词兜底扫描（中文双字词 trigram 索引不到）。
 *    召回宁可多带（OR 连接），判定交给 LLM。
 *
 * 2. **省 token 是硬指标**：一次素材/一个会话只发 **1 次** LLM 调用（批量合并），
 *    输入按 maxFacts/maxCandidates/clip 三重裁剪，输出只允许 ops JSON。
 *
 * 3. **模型输出不可全信，尤其 DELETE**：target 必须落在候选集内且属于该用户；
 *    单批删除有上限；UPDATE 缺文本、目标非法、JSON 解析失败一律**降级为 ADD**——
 *    增强功能绝不能让事实丢失。
 */

const config = require('../config');
const db = require('../db');
const llm = require('../llm/client');
const store = require('./store');

const L2 = config.l2;

const clip = (s, n) => {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// ============ 候选召回（不依赖 embedding） ============

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;
const WORD_RE = /[A-Za-z0-9][A-Za-z0-9._:/-]*/g;

/**
 * 抽召回词根。FTS5 trigram 只能索引 ≥3 字符片段，故：
 * - ≥3 字符 → fts（可用 MATCH 召回）
 * - 2 字符（中文常见双字词）→ js（只能在兜底扫描里做子串匹配）
 * - 长 CJK 串整串匹配过严（要求整串命中），按窗口切分提高召回
 */
function extractTokens(text) {
  const t = String(text || '');
  const fts = new Set();
  const js = new Set();
  for (const run of t.match(CJK_RE) || []) {
    if (run.length >= 3) {
      if (run.length <= 6) fts.add(run);
      else {
        const win = 4;
        const stride = Math.max(1, Math.floor((run.length - win) / 3));
        for (let i = 0; i < 4; i++) {
          const s = run.slice(i * stride, i * stride + win);
          if (s.length >= 3) fts.add(s);
        }
      }
    } else if (run.length === 2) js.add(run);
  }
  for (const w of t.match(WORD_RE) || []) {
    if (w.length >= 3) fts.add(w);
    else if (w.length === 2) js.add(w);
  }
  return { fts: [...fts].slice(0, 8), js: [...js].slice(0, 6) };
}

/** 为一条事实召回相关已有记忆（FTS 优先，不足则近期事实子串兜底） */
function findCandidates(userId, factText, limit) {
  const { fts, js } = extractTokens(factText);
  const seen = new Map();

  if (fts.length) {
    const match = fts.map((w) => `"${w.replace(/"/g, '""')}"`).join(' OR ');
    try {
      const rows = db.prepare(
        `SELECT m.id, m.text
           FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
          WHERE memories_fts MATCH ? AND m.user_id = ?
          ORDER BY bm25(memories_fts) LIMIT ?`
      ).all(match, userId, limit);
      for (const r of rows) seen.set(r.id, r);
    } catch { /* 极端词根导致 FTS 语法异常 → 走兜底 */ }
  }

  if (seen.size < limit) {
    const needles = [...js, ...fts];
    if (needles.length) {
      for (const r of store.recentFacts(userId, 200)) {
        if (seen.has(r.id)) continue;
        if (needles.some((n) => r.text.includes(n))) seen.set(r.id, r);
        if (seen.size >= limit) break;
      }
    }
  }
  return [...seen.values()].slice(0, limit).map((r) => ({ id: r.id, text: r.text }));
}

/** 全批事实的候选池（去重 + 总量上限，避免 prompt 膨胀） */
function gatherCandidates(userId, facts) {
  const pool = new Map();
  for (const f of facts) {
    for (const c of findCandidates(userId, f, L2.maxCandidates)) {
      if (!pool.has(c.id)) pool.set(c.id, c);
      if (pool.size >= L2.maxCandidatesTotal) break;
    }
    if (pool.size >= L2.maxCandidatesTotal) break;
  }
  return [...pool.values()];
}

// ============ 判定 ============

const BASE_RULES = [
  '你是记忆库的冲突消解器。为每条「新事实」在「已有记忆」中找对应，选择操作：',
  'ADD：全新，已有记忆里没有等价内容；',
  'NOOP：已有记忆已包含该事实（新事实无新增信息）；',
  'UPDATE：同一事实的新版本（在旧信息上补充或修正）→ 给出合并后的完整文本；',
  'DELETE：旧记忆被新事实完全取代（同一件事换了取值，如端口/地址变更）→ 删旧并入新；',
  '只输出 JSON 数组，不要解释、不要 markdown 代码块：',
  '[{"i":0,"op":"ADD"},{"i":1,"op":"NOOP","target":"M2"},{"i":2,"op":"UPDATE","target":"M3","text":"合并后的完整句子"},{"i":3,"op":"DELETE","target":"M4"},{"i":4,"op":"NOOP"}]',
  '规则：target 必须是给定 M 编号之一；UPDATE 的 text 必填且自包含；每条新事实恰好一个操作；拿不准用 ADD（宁可重复，不可丢失）。',
].join('\n');

/** 派生模式的附加规则：摘要里的一次性过程记录不值得长期记住 */
const DERIVE_RULE = '本条输入是会话摘要：其中的过程性、一次性内容（本次做了什么、临时排查）不属于应长期记住的事实 → 也用 NOOP。';

function buildPrompt({ facts, candidates, mode }) {
  const lines = ['新事实：'];
  facts.forEach((f, i) => lines.push(`[F${i}] ${clip(f, L2.clip)}`));
  lines.push('');
  if (candidates.length) {
    lines.push('已有记忆：');
    candidates.forEach((c, i) => lines.push(`[M${i + 1}] ${clip(c.text, L2.clip)}`));
  } else {
    lines.push('已有记忆：（无）');
  }
  return [
    { role: 'system', content: mode === 'derive' ? `${BASE_RULES}\n${DERIVE_RULE}` : BASE_RULES },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * 解析模型输出 → 与事实等长的操作数组。
 * 解析不出来返回 null（调用方降级为全部 ADD，不丢事实）。
 */
function parseOps(text, { factCount, candidates }) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const l = s.indexOf('[');
  const r = s.lastIndexOf(']');
  if (l >= 0 && r > l) s = s.slice(l, r + 1);

  let arr;
  try { arr = JSON.parse(s); } catch { return null; }
  if (!Array.isArray(arr)) return null;

  const idByLabel = new Map();
  candidates.forEach((c, i) => idByLabel.set(`M${i + 1}`, c.id));

  const ops = new Array(factCount).fill(null);
  const consumed = new Set(); // 同一候选不被两条事实同时改/删
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const i = Number(raw.i);
    if (!Number.isInteger(i) || i < 0 || i >= factCount || ops[i]) continue;
    const name = String(raw.op || '').toUpperCase();
    if (!['ADD', 'UPDATE', 'DELETE', 'NOOP'].includes(name)) continue;
    const targetId = idByLabel.get(String(raw.target || '').toUpperCase()) || null;

    if (name === 'ADD') { ops[i] = { op: 'ADD' }; continue; }
    if (name === 'NOOP') { ops[i] = { op: 'NOOP', targetId }; continue; }
    if (!targetId || consumed.has(targetId)) { ops[i] = { op: 'ADD' }; continue; }
    if (name === 'DELETE') { ops[i] = { op: 'DELETE', targetId }; consumed.add(targetId); continue; }

    const merged = String(raw.text || '').trim();
    if (!merged) { ops[i] = { op: 'ADD' }; continue; }
    ops[i] = { op: 'UPDATE', targetId, text: merged };
    consumed.add(targetId);
  }
  // 模型漏掉的、或格式非法的 → 保底 ADD
  for (let i = 0; i < factCount; i++) if (!ops[i]) ops[i] = { op: 'ADD' };
  return ops;
}

async function judge({ facts, candidates, mode }) {
  const out = await llm.complete(buildPrompt({ facts, candidates, mode }), {
    maxTokens: L2.maxTokens,
    temperature: 0,
  });
  if (!out) return null;
  return parseOps(out, { factCount: facts.length, candidates });
}

// ============ 应用 ============

/** 降级路径：不做比对，全部 ADD（等价于改动前的行为，0 token） */
function insertAll({ userId, facts, metadata = {}, source, candidates = [] }) {
  const stats = { added: 0, updated: 0, deleted: 0, noop: 0, skipped: 0, memoryIds: [] };
  const candIds = candidates.map((c) => c.id);
  for (const text of facts) {
    const id = store.insertFact({ userId, text, metadata });
    stats.added += 1;
    stats.memoryIds.push(id);
    store.recordOp({ userId, memoryId: id, op: 'ADD', afterText: text, candidates: candIds, source });
  }
  return stats;
}

function applyOps({ userId, facts, ops, candidates, source, metadata = {} }) {
  const stats = { added: 0, updated: 0, deleted: 0, noop: 0, skipped: 0, memoryIds: [] };
  const candIds = candidates.map((c) => c.id);
  let deletes = 0;

  ops.forEach((o, i) => {
    const text = facts[i];
    try {
      if (o.op === 'NOOP') {
        stats.noop += 1;
        store.recordOp({ userId, memoryId: o.targetId, op: 'NOOP', afterText: text, candidates: candIds, source });
        return;
      }
      if (o.op === 'DELETE') {
        // 语义：删旧 + 存新（"取代"）。
        // 为什么必须存新：实测真实模型面对"端口从 A 改成 B"这类变更时倾向选 DELETE 而非 UPDATE；
        // 若 DELETE 只删不存，新取值就凭空消失了——冲突消解反而变成数据丢失。
        if (deletes >= L2.maxDeletes) {
          // 安全阀：单批删除上限，超出只记审计不执行（新事实仍会入库）
          stats.skipped += 1;
          store.recordOp({ userId, memoryId: o.targetId, op: 'DELETE', candidates: candIds, source, applied: false });
        } else {
          const before = store.deleteFact({ userId, id: o.targetId });
          if (before == null) {
            stats.skipped += 1; // 目标已不存在：删不删得成都无妨，事实照存
          } else {
            deletes += 1;
            stats.deleted += 1;
            store.recordOp({ userId, memoryId: o.targetId, op: 'DELETE', beforeText: before, candidates: candIds, source });
          }
        }
        const id = store.insertFact({ userId, text, metadata });
        stats.added += 1;
        stats.memoryIds.push(id);
        store.recordOp({ userId, memoryId: id, op: 'ADD', afterText: text, candidates: candIds, source });
        return;
      }
      if (o.op === 'UPDATE') {
        const r = store.updateFact({ userId, id: o.targetId, text: o.text });
        if (!r) {
          // 目标在判定后被删掉 → 降级 ADD，不丢事实
          const id = store.insertFact({ userId, text: o.text || text, metadata });
          stats.added += 1;
          stats.memoryIds.push(id);
          store.recordOp({ userId, memoryId: id, op: 'ADD', afterText: o.text || text, candidates: candIds, source });
          return;
        }
        stats.updated += 1;
        stats.memoryIds.push(o.targetId);
        store.recordOp({ userId, memoryId: o.targetId, op: 'UPDATE', beforeText: r.before, afterText: r.after, candidates: candIds, source });
        return;
      }
      const id = store.insertFact({ userId, text, metadata });
      stats.added += 1;
      stats.memoryIds.push(id);
      store.recordOp({ userId, memoryId: id, op: 'ADD', afterText: text, candidates: candIds, source });
    } catch (e) {
      stats.skipped += 1;
      console.error(`[l2] 应用操作失败（${o.op}）：${e.message}`);
    }
  });
  return stats;
}

// ============ 对外入口 ============

/**
 * 把一批新事实与已有记忆消解后入库。
 * 永不抛错、永不丢事实：任何异常路径都降级为「全部 ADD」。
 *
 * @param {'material'|'derive'} mode material=外部素材提炼产物；derive=会话摘要派生
 * @param {'insert'|'skip'} degrade 判定不可用（LLM 关闭/失败/输出不可解析）时的处置：
 *   insert=全部 ADD（素材路径：用户交来的东西不能丢）；skip=什么都不做（派生路径：
 *   摘要是段落而非事实，硬塞进去只会污染记忆，留给下一轮重试更划算）
 * @returns {{added:number,updated:number,deleted:number,noop:number,skipped:number,degraded:boolean,memoryIds:string[]}}
 *   memoryIds：ADD 新建与 UPDATE 命中的记忆 id（供上层回执，形状对齐改动前的 created 数组）
 */
async function reconcileFacts({ userId, facts, source = 'add_memory', metadata = {}, mode = 'material', degrade = 'insert' }) {
  const list = (facts || [])
    .map((s) => String(s == null ? '' : s).trim())
    .filter(Boolean)
    .slice(0, L2.maxFacts);

  const empty = { added: 0, updated: 0, deleted: 0, noop: 0, skipped: 0, memoryIds: [] };
  if (!list.length) return { ...empty, degraded: false };

  const fallback = (why) => {
    if (degrade === 'skip') {
      console.warn(`[l2] ${why} → 本轮跳过（不写入，等下轮重试）`);
      return { ...empty, degraded: true };
    }
    return { ...insertAll({ userId, facts: list, metadata, source }), degraded: true };
  };

  // 关闭消解或 LLM 不可用（素材路径：0 token 纯追加；派生路径：跳过）
  if (!L2.reconcile || !llm.enabled()) return fallback('LLM 不可用或消解已关闭');

  try {
    const candidates = gatherCandidates(userId, list);
    const ops = await judge({ facts: list, candidates, mode });
    if (!ops) return fallback('判定输出无法解析');
    return { ...applyOps({ userId, facts: list, ops, candidates, source, metadata }), degraded: false };
  } catch (e) {
    return fallback(`冲突消解异常：${e.message}`);
  }
}

module.exports = {
  reconcileFacts, extractTokens, findCandidates, gatherCandidates,
  buildPrompt, parseOps, applyOps, insertAll,
};
