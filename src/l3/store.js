'use strict';

/**
 * L3 画像／知识的存储：data/l3/<kind>.md，**人工可直接编辑**（架构文档定的形态）。
 *
 * 文件即事实：每次操作都从磁盘重新解析，不做内存缓存——用户手改文件立刻生效，
 * 后台重写时也以「磁盘现状 + 本轮变更」合并，不会覆盖手改的内容。
 *
 * 条目格式（每条 = 一行注释 + markdown 正文，双时间轴见 docs/L3-画像与知识层.md）：
 *   <!-- l3 id=ab12cd34 valid_from=2026-09-18 created_at=… updated_at=… superseded_by= source=… confidence=0.8 -->
 *   正文一句话到三句话
 *
 * 被取代的条目不删除：superseded_by 指向取代者，「以前的偏好是什么、何时变的」可追溯；
 * 清空 superseded_by 即可复原（复原是人工操作，接口不提供——防自动化误改历史）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

/** 三类条目：一个 kind 一个文件 */
const KINDS = [
  { key: 'profile', file: 'profile.md', label: '用户画像' },
  { key: 'constraints', file: 'constraints.md', label: '项目约束' },
  { key: 'lessons', file: 'lessons.md', label: '经验教训' },
];

/** 序列化字段顺序（固定，diff 友好） */
const ATTRS = ['id', 'valid_from', 'created_at', 'updated_at', 'superseded_by', 'source', 'confidence'];

const MAX_TEXT = 2000;
const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomBytes(4).toString('hex');

const kindMeta = (key) => KINDS.find((k) => k.key === key) || null;
const kindFile = (key) => {
  const meta = kindMeta(key);
  if (!meta) throw new Error(`未知的 L3 条目类型：${key}`);
  return path.join(config.l3Dir, meta.file);
};

// ============ 解析 / 序列化 ============

/** 解析一行元数据注释：`<!-- l3 k=v k=v -->` → 对象。值不含空格（写入端保证）。 */
function parseAttrs(raw) {
  const out = {};
  for (const token of String(raw || '').trim().split(/\s+/)) {
    const i = token.indexOf('=');
    if (i <= 0) continue;
    out[token.slice(0, i)] = token.slice(i + 1);
  }
  return out;
}

function toEntry(attrs, bodyLines) {
  const text = bodyLines.join('\n').replace(/^\s*\n+/, '').replace(/\s+$/, '');
  // 注意 Number('') 是 0 而不是 NaN——空值必须显式判掉，否则往返一次 confidence 就从「无」变 0
  const conf = attrs.confidence ? Number(attrs.confidence) : NaN;
  return {
    id: attrs.id || '',
    valid_from: attrs.valid_from || null,
    created_at: attrs.created_at || null,
    updated_at: attrs.updated_at || null,
    superseded_by: attrs.superseded_by || null,
    source: attrs.source || null,
    confidence: Number.isFinite(conf) ? conf : null,
    text,
  };
}

/** 读一个 kind 的全部条目（含被取代的）。文件不存在 → 空数组。 */
function readKind(kind) {
  let raw = '';
  try {
    raw = fs.readFileSync(kindFile(kind), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    const m = line.match(/^<!--\s*l3\s+(.+?)\s*-->$/);
    if (m) {
      if (cur) out.push(toEntry(cur.attrs, cur.body));
      cur = { attrs: parseAttrs(m[1]), body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) out.push(toEntry(cur.attrs, cur.body));
  return out;
}

function serializeKind(kind, entries) {
  const meta = kindMeta(kind);
  const lines = [
    `<!-- aimemory L3 · ${meta.label} · 本文件可人工编辑；每条条目以「l3」注释行开头，正文跟在其后；删除条目请连同注释行整块删除 -->`,
    '',
  ];
  for (const e of entries) {
    lines.push(`<!-- l3 ${ATTRS.map((a) => `${a}=${e[a] == null ? '' : e[a]}`).join(' ')} -->`);
    lines.push(e.text);
    lines.push('');
  }
  return lines.join('\n');
}

/** 整文件重写（临时文件 + rename，避免写一半崩溃留下半个文件） */
function writeKind(kind, entries) {
  fs.mkdirSync(config.l3Dir, { recursive: true });
  const file = kindFile(kind);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, serializeKind(kind, entries));
  fs.renameSync(tmp, file);
}

/** 读改写三部曲的公共壳：解析最新磁盘状态 → 变更 → 写回 */
function mutateKind(kind, fn) {
  const entries = readKind(kind);
  const result = fn(entries) || {};
  writeKind(kind, entries);
  return result;
}

// ============ 查询 / 变更 ============

/**
 * 置信度时效衰减（指数半衰，只读视图——文件里的原值永远不动）。
 * c_eff = c × 0.5^(ageDays/halfLife)。confidence 非数值、时间戳解析失败、halfLife≤0（关衰减）→ 原样透传。
 */
function effectiveConfidence(confidence, updatedAt, { now = Date.now(), halfLifeDays = config.l3.halfLifeDays } = {}) {
  if (typeof confidence !== 'number') return null;
  if (!(halfLifeDays > 0)) return confidence;
  const base = Date.parse(updatedAt || '');
  if (!Number.isFinite(base)) return confidence;
  const ageDays = Math.max(0, (now - base) / 86400000);
  return confidence * Math.pow(0.5, ageDays / halfLifeDays);
}

/** 全部条目（跨 kind）。includeSuperseded=false 只返回仍成立的。附 effective_confidence 时效衰减视图。 */
function listEntries({ kind = null, includeSuperseded = false } = {}) {
  const kinds = kind ? [kindMeta(kind)].filter(Boolean) : KINDS;
  const out = [];
  for (const meta of kinds) {
    for (const e of readKind(meta.key)) {
      if (!includeSuperseded && e.superseded_by) continue;
      out.push({
        ...e,
        kind: meta.key,
        kind_label: meta.label,
        effective_confidence: effectiveConfidence(e.confidence, e.updated_at),
      });
    }
  }
  return out;
}

function getEntry(id) {
  for (const meta of KINDS) {
    const hit = readKind(meta.key).find((e) => e.id === id);
    if (hit) return { ...hit, kind: meta.key, kind_label: meta.label };
  }
  return null;
}

/** 新增条目（凝练产物或人工添加）。返回 id。 */
function appendEntry({ kind, text, source = null, confidence = null, validFrom = null }) {
  const meta = kindMeta(kind);
  if (!meta) throw new Error(`未知的 L3 条目类型：${kind}`);
  const t = String(text || '').trim();
  if (!t) throw new Error('L3 条目正文不能为空');
  const id = newId();
  const ts = nowIso();
  mutateKind(kind, (entries) => {
    entries.push({
      id,
      valid_from: validFrom || ts.slice(0, 10),
      created_at: ts,
      updated_at: ts,
      superseded_by: null,
      source,
      confidence,
      text: t.slice(0, MAX_TEXT),
    });
  });
  return id;
}

/** 标记被取代（不删除）。返回是否找到旧条目。 */
function markSuperseded(oldId, newId) {
  const old = getEntry(oldId);
  if (!old) return false;
  mutateKind(old.kind, (entries) => {
    const hit = entries.find((e) => e.id === oldId);
    if (hit) hit.superseded_by = newId;
  });
  return true;
}

/** 人工编辑正文（updated_at 刷新；来源与双时间轴不动） */
function updateBody(id, text) {
  const entry = getEntry(id);
  if (!entry) return null;
  const t = String(text || '').trim();
  if (!t) throw new Error('L3 条目正文不能为空');
  mutateKind(entry.kind, (entries) => {
    const hit = entries.find((e) => e.id === id);
    if (hit) {
      hit.text = t.slice(0, MAX_TEXT);
      hit.updated_at = nowIso();
    }
  });
  return getEntry(id);
}

/** 人工删除（整条移除；凝练流程不调用它——凝练只走 supersede） */
function removeEntry(id) {
  const entry = getEntry(id);
  if (!entry) return false;
  mutateKind(entry.kind, (entries) => {
    const i = entries.findIndex((e) => e.id === id);
    if (i >= 0) entries.splice(i, 1);
  });
  return true;
}

// ============ 统计（给 REST / 星图内圈） ============

function l3Stats() {
  const byKind = {};
  let active = 0;
  let superseded = 0;
  let effSum = 0;
  let effN = 0;
  let lastUpdate = null;
  for (const meta of KINDS) {
    const all = readKind(meta.key);
    const live = all.filter((e) => !e.superseded_by);
    byKind[meta.key] = {
      active: live.length,
      superseded: all.length - live.length,
      label: meta.label,
      // active 条目的平均有效置信度（时效衰减后），无条目为 null
      effective_confidence: live.length
        ? +(live.reduce((s, e) => s + (effectiveConfidence(e.confidence, e.updated_at) ?? 0), 0) / live.length).toFixed(4)
        : null,
    };
    active += live.length;
    superseded += all.length - live.length;
    for (const e of live) {
      const eff = effectiveConfidence(e.confidence, e.updated_at);
      if (eff != null) { effSum += eff; effN += 1; }
      if (e.updated_at && (!lastUpdate || e.updated_at > lastUpdate)) lastUpdate = e.updated_at;
    }
  }
  return {
    active,
    superseded,
    byKind,
    last_update: lastUpdate,
    effective_confidence: effN ? +(effSum / effN).toFixed(4) : null,
  };
}

module.exports = {
  KINDS, parseAttrs, readKind, serializeKind, effectiveConfidence,
  listEntries, getEntry, appendEntry, markSuperseded, updateBody, removeEntry, l3Stats,
  MAX_TEXT,
};
