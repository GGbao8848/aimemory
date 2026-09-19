'use strict';

// repo 域模块（memories/events/keys/stats）共享的无状态小工具。不含 db 依赖。

const crypto = require('crypto');

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

const parseList = (s) => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
};

/** memories 行 → 对外对象（embedding 为内部向量，不对外暴露） */
const toObj = (row) => {
  if (!row) return null;
  const { embedding, ...rest } = row;
  return { ...rest, metadata: JSON.parse(rest.metadata || '{}'), facts: parseList(rest.facts), entities: parseList(rest.entities) };
};

const clamp = (n, min, max, def) => {
  const v = Number.parseInt(n, 10);
  if (Number.isNaN(v)) return def;
  return Math.min(Math.max(v, min), max);
};

const safeParse = (s, fallback) => {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
};

module.exports = { now, uuid, parseList, toObj, clamp, safeParse };
