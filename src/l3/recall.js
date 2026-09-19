'use strict';

/**
 * L3 上下文召回（recall_context 的实现）：把「长期成立的画像 / 约束 / 教训」
 * 打包成可直接注入 agent 开场上下文的结构，可选附带相关的 L2 事实。
 *
 * 设计约束：
 * - **只读、零 LLM**：条目来自 data/l3/ 的 markdown，事实检索走既有 searchMemories
 *   （无 embedding 时自动退 FTS/关键词）——任何环境下都能用，不烧 token。
 * - 相关度是**极简词根命中**（query 的 CJK 片段/拉丁词在正文里出现即计分），
 *   不做向量：L3 条目总量小（几十条），粗排足够；精排是检索层（L2）的职责。
 * - 单用户部署语义：L3 条目为所有者全局画像，不做 user 维度切分（与 store 一致）；
 *   L2 事实严格按 userId 过滤。
 */

const repo = require('../db/repo');
const store = require('./store');

const KIND_ORDER = ['profile', 'constraints', 'lessons'];

/** 时间推理：valid_from 在未来 = 条目声明"从此刻起才成立"→ 召回不应注入（宁缺勿滥）。
 *  无/坏时间戳视为已生效。 */
function notYetEffective(validFrom, nowMs) {
  const t = Date.parse(String(validFrom || ''));
  return Number.isFinite(t) && t > (nowMs || Date.now());
}

/** 抽召回词根：CJK 串（≤4 字整取；长串按 2 字**滑窗步长 1**——真实词不会对齐固定步长，
 *  这个坑在 L2 候选召回踩过一次）+ 拉丁词（≥2 字） */
function extractTokens(query) {
  const q = String(query || '');
  const out = new Set();
  for (const run of q.match(/[\u3400-\u9fff]{2,}/g) || []) {
    if (run.length <= 4) out.add(run);
    else for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  for (const w of q.match(/[A-Za-z0-9][A-Za-z0-9._:/-]*/g) || []) {
    if (w.length >= 2) out.add(w);
  }
  return [...out].slice(0, 16);
}

function scoreText(text, tokens) {
  let hit = 0;
  for (const t of tokens) if (text.includes(t)) hit += 1;
  return hit;
}

/**
 * 召回上下文。永不抛错（存储读不到就返回空组）。
 * @param {Array<string>} [kinds] 只返回指定类别（profile/constraints/lessons 子集）；
 *   省略/空/全未知 → 三类全量（坏输入在 MCP 层拦截并给自愈文案，这层只做宽容降级）。
 * @returns {Promise<{profile?:Array,constraints?:Array,lessons?:Array,facts:Array}>}
 */
async function recallContext({ userId, query = '', perKind = 6, facts = 5, kinds = null } = {}) {
  const tokens = extractTokens(query);
  const cap = Math.max(1, Math.min(Number(perKind) || 6, 12));
  const want = Array.isArray(kinds) && kinds.length ? KIND_ORDER.filter((k) => kinds.includes(k)) : null;

  const groups = { profile: [], constraints: [], lessons: [] };
  for (const e of store.listEntries({ includeSuperseded: false })) {
    if (!groups[e.kind]) continue;
    // 时间推理（G5）：未生效条目不注入
    if (notYetEffective(e.valid_from)) continue;
    groups[e.kind].push({
      id: e.id,
      text: e.text,
      confidence: e.confidence,
      effective_confidence: e.effective_confidence,
      valid_from: e.valid_from,
      source: e.source,
      _score: tokens.length ? scoreText(e.text, tokens) : 0,
    });
  }
  const out = {};
  for (const kind of want && want.length ? want : KIND_ORDER) {
    out[kind] = groups[kind]
      // 相关度优先；同分时用时效衰减后的有效置信排序——久远条目自然沉底
      .sort((a, b) => b._score - a._score
        || (b.effective_confidence ?? b.confidence ?? 0) - (a.effective_confidence ?? a.confidence ?? 0))
      .slice(0, cap)
      .map(({ _score, ...keep }) => keep);
  }

  // 相关 L2 事实：有 query 才带（没有查询词的"相关"没有意义），严格按 userId 过滤
  let factList = [];
  const factLimit = Math.max(0, Math.min(Number(facts) || 0, 20));
  if (factLimit > 0 && tokens.length) {
    try {
      const hits = await repo.searchMemories({ userId, query: String(query), limit: factLimit });
      factList = hits.map((h) => ({ id: h.id, text: h.text, updated_at: h.updated_at }));
    } catch {
      factList = []; // 检索层不可用 → 静默降级为只回条目
    }
  }

  return { ...out, facts: factList };
}

module.exports = { recallContext, extractTokens, scoreText, KIND_ORDER };
