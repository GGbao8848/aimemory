'use strict';

/**
 * OpenAI 兼容的 Embedding 适配层。
 * 指向任意提供 /v1/embeddings 的服务（vLLM / llama.cpp / OpenAI 兼容网关）。
 * 服务不可用/调用失败时返回 null，由调用方降级为关键词检索，保证不影响现有功能。
 */

const config = require('../config');

let failed = false; // 一旦失败，本次进程内标记不可用，避免每次搜索都撞一次超时

/** 单个文本 → float32 向量（Buffer）。失败返回 null，不会抛错。 */
async function embed(text) {
  const cfg = config.embedding;
  if (!cfg.enabled || failed) return null;

  const url = `${cfg.baseUrl}/embeddings`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, input: text }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    failed = true;
    console.error(`[embeddings] 请求失败，本次进程降级为关键词检索: ${e.message}`);
    return null;
  }
  if (!res.ok) {
    failed = true;
    console.error(`[embeddings] HTTP ${res.status}: ${(await res.text()).slice(0, 300)}，降级为关键词检索`);
    return null;
  }
  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec) || !vec.length) {
    failed = true;
    console.error('[embeddings] 响应缺少 embedding 向量，降级为关键词检索');
    return null;
  }
  return float32Buffer(vec);
}

/** 批量文本 → Buffer 数组（对应入参顺序）。任一条失败则整体返回 null。 */
async function embedBatch(texts) {
  const cfg = config.embedding;
  if (!cfg.enabled || failed || !texts.length) return null;

  const url = `${cfg.baseUrl}/embeddings`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, input: texts }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    failed = true;
    console.error(`[embeddings] 批量请求失败，本次进程降级为关键词检索: ${e.message}`);
    return null;
  }
  if (!res.ok) {
    failed = true;
    console.error(`[embeddings] HTTP ${res.status}: ${(await res.text()).slice(0, 300)}，降级为关键词检索`);
    return null;
  }
  const data = await res.json();
  const byIndex = new Map((data?.data || []).map((d) => [d.index, d.embedding]));
  if (!byIndex.size) {
    failed = true;
    console.error('[embeddings] 批量响应缺少 embedding 向量，降级为关键词检索');
    return null;
  }
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    const vec = byIndex.get(i);
    if (!Array.isArray(vec) || !vec.length) {
      failed = true;
      console.error('[embeddings] 批量响应缺失条目，降级为关键词检索');
      return null;
    }
    out.push(float32Buffer(vec));
  }
  return out;
}

/** number[] → float32 Buffer（内存紧凑，SQLite BLOB 存储） */
function float32Buffer(vec) {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

module.exports = { embed, embedBatch, float32Buffer };
