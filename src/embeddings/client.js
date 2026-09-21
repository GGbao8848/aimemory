'use strict';

/**
 * OpenAI 兼容的 Embedding 适配层。
 * 指向任意提供 /v1/embeddings 的服务（vLLM / llama.cpp / OpenAI 兼容网关）。
 * 服务不可用/调用失败时返回 null，由调用方降级为关键词检索，保证不影响现有功能。
 * 半熔断：连续失败后熔断（不请求），每 CIRCUIT_RETRY_MS 探测一次自动恢复
 * （早期"失败一次永久降级"需重启进程才恢复，embedding 服务短暂抖动会造成整进程语义检索失效）。
 */

const config = require('../config');

// 熔断参数走 config（EMBEDDING_BREAK_THRESHOLD / EMBEDDING_RETRY_MS），测试可注入短窗口
const CIRCUIT_BREAK_THRESHOLD = config.embedding.breakThreshold;
const CIRCUIT_RETRY_MS = config.embedding.retryMs;

let failures = 0;
let circuitOpen = false;
let circuitUntil = 0;

function blocked() {
  if (!circuitOpen) return false;
  if (Date.now() >= circuitUntil) {
    circuitOpen = false;
    failures = 0;
    return false;
  }
  return true;
}

function recordFailure(ctx) {
  failures++;
  if (failures >= CIRCUIT_BREAK_THRESHOLD && !circuitOpen) {
    circuitOpen = true;
    circuitUntil = Date.now() + CIRCUIT_RETRY_MS;
    console.error(`[embeddings] 连续失败 ${CIRCUIT_BREAK_THRESHOLD} 次，进入熔断 ${CIRCUIT_RETRY_MS / 1000}s（自动探测恢复），期间降级关键词检索`);
  } else if (ctx) {
    console.error(`[embeddings] ${ctx}，降级为关键词检索`);
  }
}

function recordSuccess() {
  failures = 0;
}

/** 配置变更（设置页保存）后调用：清空熔断与失败计数，立即以新端点放行 */
function resetCircuit() {
  failures = 0;
  circuitOpen = false;
  circuitUntil = 0;
}

/** 单个文本 → float32 向量（Buffer）。失败返回 null，不会抛错。 */
async function embed(text) {
  const cfg = config.embedding;
  if (!cfg.enabled || blocked()) return null;

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
    recordFailure(`请求失败: ${e.message}`);
    return null;
  }
  if (!res.ok) {
    recordFailure(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return null;
  }
  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec) || !vec.length) {
    recordFailure('响应缺少 embedding 向量');
    return null;
  }
  recordSuccess();
  return float32Buffer(vec);
}

/** number[] → float32 Buffer（内存紧凑，SQLite BLOB 存储） */
function float32Buffer(vec) {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

/** 批量文本 → Buffer 数组（对应入参顺序）。供脚本（backfill-embeddings）批量回填历史向量。 */
async function embedBatch(texts) {
  if (!config.embedding.enabled || blocked() || !texts.length) return null;
  const out = [];
  for (const t of texts) {
    const v = await embed(t);
    if (!v) return null; // 任一条失败 → 整体失败（脚本据此停止）
    out.push(v);
  }
  return out;
}

module.exports = { embed, embedBatch, float32Buffer, resetCircuit };
