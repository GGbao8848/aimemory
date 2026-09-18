'use strict';

/**
 * L2 派生：把 L1 会话摘要变成长期事实（补上「上层可从 L0 重放」的派生链）。
 *
 * 为什么从 L1 而不是直接从 L0 归档派生：
 * - L0 单会话平均 299K 字符、最多 4.6M，直接派生一次要吃掉大量 token；
 *   L1 已经把会话压成「目标 / 关键决定 / 产出物」，从它派生既省 token 又更准
 *   （系统注入内容等噪音已被 L1 滤过一轮）。
 * - 派生链依然完整：改 L1 摘要算法 → L1 内容指纹变化 → L2 自动跟着重跑。
 *
 * 只取 overview / decisions / artifacts，**不取 pending**：未决事项天然易过期
 * （"等待测试""待建"），进事实库很快会变成假信息；它们仍可由 L1 工具查到。
 *
 * 成本：一个会话 = 1 次 LLM 调用（筛选 + 消解合并成一次，见 reconcile 的 derive 模式）。
 */

const crypto = require('crypto');
const { reconcileFacts } = require('./reconcile');

/** L1 摘要内容指纹：摘要没变就不重复派生（省掉一次 LLM 调用） */
function summaryHash(row) {
  const h = crypto.createHash('sha256');
  for (const f of [row.overview, row.decisions, row.pending, row.artifacts]) {
    h.update(String(f == null ? '' : f));
    h.update('\u0000');
  }
  return h.digest('hex').slice(0, 32);
}

/** 摘要 → 待消解的事实候选（结构化字段；overview 放最前，它是会话的目标与结论） */
function factsFromSummary(row) {
  const parse = (s) => {
    try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  const out = [];
  const push = (v) => {
    const t = String(v == null ? '' : v).trim();
    if (t) out.push(t);
  };
  push(row.overview);
  for (const key of ['decisions', 'artifacts']) for (const item of parse(row[key])) push(item);
  return out;
}

/**
 * 派生单个会话（调用方负责状态流转）。
 * @returns {{ok:boolean, skipped?:string, stats?:object}}
 */
async function deriveOne({ userId, deviceCode, agent, sessionId, summary }) {
  const facts = factsFromSummary(summary);
  if (!facts.length) return { ok: true, skipped: '摘要无可派生内容' };

  const r = await reconcileFacts({
    userId,
    facts,
    source: `l1:${agent}/${sessionId}`,
    mode: 'derive',
    degrade: 'skip', // 派生失败不硬塞：摘要是段落不是事实，留给下一轮重试
    metadata: { source: 'l1', agent, session_id: sessionId, device_code: deviceCode },
  });

  // 判定不可用 → 不写状态为 done，让调度器下轮重试
  if (r.degraded) return { ok: false, error: '判定不可用（LLM 关闭/失败/输出不可解析）', stats: r };
  return { ok: true, stats: r };
}

module.exports = { summaryHash, factsFromSummary, deriveOne };
