'use strict';

/**
 * L3 凝练的纯逻辑：组 prompt / 解析模型输出 / 应用到条目文件。
 * 编排（游标、触发频率、重试）在 scheduler.js。
 *
 * 原则「宁缺毋滥」：L3 是最内层，条目量少而价高——模型没有把握沉淀就不输出，
 * 空输出是无副作用且正常的结果（这也是游标仍要推进的原因：这批摘要已消化过了）。
 */

const config = require('../config');
const store = require('./store');

const L3 = config.l3;

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s*\n\s*/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const parseList = (s) => {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};

const SYSTEM_PROMPT = [
  '你是长期记忆的凝练器。从「近期会话摘要」中沉淀值得**长期**记住的条目（画像/约束/教训）。',
  '条目类型：profile=用户画像（身份/偏好/习惯）；constraints=项目约束（环境/部署/资源等硬约束）；lessons=经验教训（踩坑与结论）。',
  '原则：',
  '- 宁缺毋滥：一次性的过程细节、临时状态不输出；没有值得沉淀的就输出空数组 []',
  '- 与「已有长期条目」重复且无新增 → 不输出；有实质更新 → 输出新表述并给 supersedes=<旧条目id>',
  '- 每条必须自包含、是完整陈述句，可脱离会话上下文理解',
  '只输出 JSON 数组，不要解释、不要 markdown 代码块：',
  '[{"kind":"constraints","text":"完整的一句话","supersedes":null,"confidence":0.8}]',
].join('\n');

function buildPrompt({ summaries, entries, facts = [] }) {
  const lines = ['近期会话摘要：'];
  summaries.forEach((s, i) => {
    const decisions = parseList(s.decisions).slice(0, 3).map((d) => clip(d, 100)).join('；');
    const artifacts = parseList(s.artifacts).slice(0, 3).map((a) => clip(a, 80)).join('；');
    let line = `[S${i + 1}] (${s.agent}) ${clip(s.overview, L3.clip)}`;
    if (decisions) line += `；决定：${decisions}`;
    if (artifacts) line += `；产出：${artifacts}`;
    lines.push(line);
  });
  lines.push('');
  if (facts.length) {
    lines.push('近期 L2 事实（仅作背景参考，帮助理解语境；不要直接抄进条目）：');
    facts.forEach((f, i) => lines.push(`[B${i + 1}] ${clip(typeof f === 'string' ? f : f.text, L3.factClip)}`));
    lines.push('');
  }
  if (entries.length) {
    lines.push('已有长期条目：');
    entries.forEach((e) => lines.push(`[E:${e.id}] (${e.kind}) ${clip(e.text, L3.entryClip)}`));
  } else {
    lines.push('已有长期条目：（无）');
  }
  return [
    { role: 'system', content: SYSTEM_PROMPT + (facts.length ? '\n输入里的「近期 L2 事实」只是背景语境：条目仍须来自会话摘要、自包含，不得照抄事实原文。' : '') },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * 解析模型输出 → 合法条目数组。解析失败返回 null（调用方据此跳过本轮、不动游标）。
 * supersedes 只接受「本轮可见的条目 id」，其余置 null（防幻觉 id 误改历史）。
 */
function parseOutput(text, { existingIds = new Set() } = {}) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const l = s.indexOf('[');
  const r = s.lastIndexOf(']');
  if (l >= 0 && r > l) s = s.slice(l, r + 1);

  let arr;
  try { arr = JSON.parse(s); } catch { return null; }
  if (!Array.isArray(arr)) return null;

  const kindKeys = new Set(store.KINDS.map((k) => k.key));
  const items = [];
  for (const raw of arr.slice(0, 10)) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = String(raw.kind || '').trim();
    const text2 = String(raw.text || '').trim();
    if (!kindKeys.has(kind) || !text2) continue;
    const sup = String(raw.supersedes || '').trim();
    const conf = Number(raw.confidence);
    items.push({
      kind,
      text: text2.slice(0, store.MAX_TEXT),
      supersedes: sup && existingIds.has(sup) ? sup : null,
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : null,
    });
  }
  return items;
}

/** 应用凝练产物：supersede 旧条目 + 追加新条目。返回计数与明细。 */
function applyOutput(items, { source }) {
  const detail = [];
  let superseded = 0;
  for (const it of items) {
    const id = store.appendEntry({ kind: it.kind, text: it.text, source, confidence: it.confidence });
    if (it.supersedes && store.markSuperseded(it.supersedes, id)) superseded += 1;
    detail.push({ id, kind: it.kind, supersedes: it.supersedes || null, text: it.text });
  }
  return { added: items.length, superseded, detail };
}

module.exports = { buildPrompt, parseOutput, applyOutput, clip };
