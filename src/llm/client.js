'use strict';

/**
 * 对话模型（LLM）适配层：OpenAI 兼容 /v1/chat/completions。
 * 用于 add_memory 提炼与 facts/entities 抽取。服务不可用/失败时返回 null，调用方降级（存原文）。
 * 半熔断：连续失败后进入熔断（不请求），但每 CIRCUIT_RETRY_MS 探测一次，服务恢复即自动回来
 * （早期"失败一次永久降级"需重启进程才恢复）。
 * 并发上限：多人同时写入时限制在途 LLM 请求数，避免把 vLLM 打爆。
 */

const config = require('../config');

const CIRCUIT_BREAK_THRESHOLD = 3; // 连续失败 3 次 → 熔断
const CIRCUIT_RETRY_MS = 60_000; // 熔断后每 60s 放行一次探测
const MAX_CONCURRENCY = 8; // 在途请求上限（vLLM 队列保护）

let failures = 0;
let circuitOpen = false;
let circuitUntil = 0;
let inFlight = 0;
const waiters = [];

async function acquire() {
  if (inFlight < MAX_CONCURRENCY) { inFlight++; return; }
  await new Promise((resolve) => waiters.push(resolve));
  inFlight++;
}

function release() {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

/** 请求是否被熔断拦截 */
function blocked() {
  if (!circuitOpen) return false;
  if (Date.now() >= circuitUntil) {
    circuitOpen = false; // 熔断到期：放行探测，成功则复位 failures，失败则重新熔断
    failures = 0;
    return false;
  }
  return true;
}

function recordFailure() {
  failures++;
  if (failures >= CIRCUIT_BREAK_THRESHOLD && !circuitOpen) {
    circuitOpen = true;
    circuitUntil = Date.now() + CIRCUIT_RETRY_MS;
    console.error(`[llm] 连续 ${failures} 次失败，进入熔断 ${CIRCUIT_RETRY_MS / 1000}s（${CIRCUIT_RETRY_MS / 1000}s 后自动探测恢复）`);
  }
}

function recordSuccess() {
  failures = 0;
}

/** LLM 是否启用（受理写入前检查：素材必须能提炼，未启用直接拒绝） */
function enabled() {
  return config.llm.enabled;
}

/** 单次对话补全。返回 content 字符串；失败/熔断返回 null，不抛错。 */
async function complete(messages, { maxTokens = 512, temperature = 0 } = {}) {
  const cfg = config.llm;
  if (!cfg.enabled) return null;
  if (blocked()) return null;

  await acquire();
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    recordFailure();
    console.error(`[llm] 请求失败: ${e.message}`);
    return null;
  } finally {
    release();
  }

  if (!res.ok) {
    recordFailure();
    console.error(`[llm] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }

  const data = await res.json();
  const msg = data?.choices?.[0]?.message || {};
  let content = msg.content;
  // 思考模型（如 qwen 系列）可能把正式输出放在 reasoning 而 content 为空，
  // 或 content 被截断只剩思考。此时回退取 reasoning 的最后一段（最接近正式回答）。
  if (typeof content !== 'string' || !content.trim()) {
    const reasoning = msg.reasoning;
    if (typeof reasoning === 'string' && reasoning.trim()) {
      const lines = reasoning.split('\n').filter((l) => l.trim());
      // 长度门槛过滤截断碎片（如"需要一条"）——过短残句不足以成为可复用记忆，
      // 返回 null 让调用方走原文降级，而不是存垃圾。
      const last = lines.length ? lines[lines.length - 1].trim() : reasoning.trim();
      if (last.length >= 10) content = last;
    }
  }
  if (typeof content !== 'string' || !content.trim()) {
    recordFailure();
    console.error('[llm] 响应缺少 content 与 reasoning');
    return null;
  }
  recordSuccess();
  return content;
}

module.exports = { complete, enabled };
