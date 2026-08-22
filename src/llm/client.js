'use strict';

/**
 * 对话模型（LLM）适配层：OpenAI 兼容 /v1/chat/completions。
 * 用于 add_memory 的 infer 事实抽取。服务不可用/失败时返回 null，调用方降级（原样入库）。
 */

const config = require('../config');

/** 单次对话补全。返回 content 字符串；失败返回 null，不抛错。 */
async function complete(messages, { maxTokens = 512, temperature = 0 } = {}) {
  const cfg = config.llm;
  if (!cfg.enabled) return null;

  const url = `${cfg.baseUrl}/chat/completions`;
  let res;
  try {
    res = await fetch(url, {
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
    console.error(`[llm] 请求失败: ${e.message}`);
    return null;
  }
  if (!res.ok) {
    console.error(`[llm] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    console.error('[llm] 响应缺少 content');
    return null;
  }
  return content;
}

module.exports = { complete };
