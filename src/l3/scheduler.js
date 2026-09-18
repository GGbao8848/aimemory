'use strict';

/**
 * L3 后台凝练调度器。与 L1/L2 的差别只有一个字：**低频**。
 *
 * L1/L2 是「会话级」流水线（静默几分钟就跑）；L3 是「长期层」，每次凝练都是一次
 * 全局视角的重排，频繁跑只会产出噪声并烧 token。所以触发条件是
 * 「攒够 L3_BATCH_NEW 个新消化会话才跑一轮」，其余时间轮询只做计数、不发 LLM 调用。
 *
 * 游标：l3_state.last_consumed = 已消化的 l2_sources 最大 updated_at。
 * LLM 失败/输出不可解析 → 游标不动，下轮重试（宁可重来也不跳过）。
 */

const config = require('../config');
const db = require('../db');
const llm = require('../llm/client');
const l2store = require('../l2/store');
const store = require('./store');
const { buildPrompt, parseOutput, applyOutput } = require('./derive');

const L3 = config.l3;

const nowIso = () => new Date().toISOString();

// ============ 游标（l3_state） ============

function getCursor() {
  const row = db.prepare("SELECT value FROM l3_state WHERE key = 'last_consumed'").get();
  return row ? row.value : null;
}

function setCursor(value) {
  db.prepare(
    `INSERT INTO l3_state (key, value, updated_at) VALUES ('last_consumed', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(value, nowIso());
}

/** 距上轮凝练后，新消化完成的会话数 */
function pendingCount() {
  return l2store.doneSourcesSince(config.userId, getCursor()).length;
}

// ============ 输入采集 ============

/**
 * @returns {{summaries:Array, entries:Array, maxSeen:string|null}}
 *   summaries：带正文的会话摘要；maxSeen：本轮实际消费到的最大 updated_at（新游标）
 */
function collectInput({ force = false } = {}) {
  const userId = config.userId;
  let rows = l2store.doneSourcesSince(userId, getCursor());
  if (!rows.length && force) {
    // 手动触发且无新增 → 兜底取最近几条，保证手动触发总能看到效果
    rows = l2store.recentDoneSources(userId, L3.maxSummaries);
  }
  rows = rows.slice(0, L3.maxSummaries);

  const summaries = rows
    .map((r) => {
      const s = l2store.getL1DoneSummary(userId, {
        deviceCode: r.device_code, agent: r.agent, sessionId: r.session_id,
      });
      if (!s) return null;
      return {
        agent: r.agent,
        session_id: r.session_id,
        updated_at: r.updated_at,
        overview: s.overview,
        decisions: s.decisions,
        artifacts: s.artifacts,
      };
    })
    .filter(Boolean);

  const maxSeen = rows.reduce((m, r) => (m && m > r.updated_at ? m : r.updated_at), null);
  const entries = store.listEntries({ includeSuperseded: false }).slice(0, L3.maxEntries);
  return { summaries, entries, maxSeen };
}

// ============ 一轮凝练 ============

/**
 * @param {boolean} force 手动触发：无新增也取最近几条跑
 * @returns {{skipped?:string, pending?:number, consumed?:number, added?:number, superseded?:number}}
 */
async function tick({ force = false } = {}) {
  if (!L3.derive) return { skipped: '已关闭（L3_DERIVE=0）' };
  if (!llm.enabled()) return { skipped: 'LLM 未启用' };

  const pending = pendingCount();
  if (!force && pending < L3.batchNew) return { skipped: `新会话不足（${pending}/${L3.batchNew}）`, pending };

  const { summaries, entries, maxSeen } = collectInput({ force });
  if (!summaries.length) return { skipped: '无可凝练的会话', pending };

  const out = await llm.complete(buildPrompt({ summaries, entries }), {
    maxTokens: L3.maxTokens,
    temperature: 0,
  });
  if (!out) return { skipped: 'LLM 调用失败（游标不动，下轮重试）', pending };

  const items = parseOutput(out, { existingIds: new Set(entries.map((e) => e.id)) });
  if (!items) return { skipped: '输出不可解析（游标不动，下轮重试）', pending };

  // 来源可溯：本轮消费了哪些会话（最多记 3 个，防 source 字段膨胀）
  const source = summaries.slice(0, 3).map((s) => `l1:${s.agent}/${s.session_id}`).join(',');
  const applied = applyOutput(items, { source });
  setCursor(maxSeen || getCursor() || nowIso());

  return { consumed: summaries.length, added: applied.added, superseded: applied.superseded, detail: applied.detail };
}

/** 启动：低频轮询。只做计数比较，不发 LLM 调用。 */
function start() {
  if (!L3.derive) {
    console.log('[l3] 后台凝练已关闭（L3_DERIVE=0）');
    return null;
  }
  return setInterval(() => {
    tick()
      .then((r) => {
        if (r && r.consumed != null) {
          console.log(`[l3] 凝练完成：消化 ${r.consumed} 个会话 → 新增 ${r.added} 条 / 取代 ${r.superseded} 条`);
        }
      })
      .catch((e) => console.error(`[l3] 轮询异常：${e.message}`));
  }, L3.intervalMs).unref();
}

module.exports = { start, tick, pendingCount, collectInput, getCursor, setCursor };
