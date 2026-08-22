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
  const msg = data?.choices?.[0]?.message || {};
  let content = msg.content;
  // 思考模型（如 qwen 系列）可能把正式输出放在 reasoning 而 content 为空，
  // 或 content 被截断只剩思考。此时回退取 reasoning 的最后一段（最接近正式回答）。
  if (typeof content !== 'string' || !content.trim()) {
    const reasoning = msg.reasoning;
    if (typeof reasoning === 'string' && reasoning.trim()) {
      const lines = reasoning.split('\n').filter((l) => l.trim());
      // 取最后一段非空内容（通常包含最终答案/序号），截断保护长度
      content = lines.length ? lines[lines.length - 1].trim() : reasoning.trim();
    }
  }
  if (typeof content !== 'string' || !content.trim()) {
    console.error('[llm] 响应缺少 content 与 reasoning');
    return null;
  }
  return content;
}

module.exports = { complete };
