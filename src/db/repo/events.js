'use strict';

// 素材管线域：一切提交都是"素材"（text/messages），异步受理返回 event_id，
// 后台队列串行 LLM 提炼 → 冲突消解 → 入库（仅提炼产物，不存原文）。
// 事件表 events 即任务队列（status: pending/processing/done/failed）。

const db = require('../index');
const llm = require('../../llm/client');
const memories = require('./memories');
const { now, uuid } = require('./_common');

/**
 * 受理记忆素材（text 单条 / messages 多轮对话），一律异步：
 * 创建提炼任务返回 { event_id, status:'pending' }，后台队列（processPendingEvents）LLM 提炼入库。
 * 库内只存提炼产物，不存原文。提炼失败 → 事件 failed（素材不落库）。
 * LLM 未启用（LLM_ENABLED=0）时直接拒绝，避免"收了素材却永远无法提炼"。
 */
function createMemory({ userId, text, messages, metadata = {} }) {
  if (!llm.enabled()) {
    throw new Error('LLM 提炼服务未启用（LLM_ENABLED=0），无法写入记忆');
  }
  let kind = 'text';
  let input = text;
  if (messages && Array.isArray(messages) && messages.length) {
    kind = 'messages';
    input = messages.slice(0, 50);
  }
  if (input === undefined || (typeof input === 'string' && !input.trim())) {
    throw new Error('text 或 messages 至少提供一个');
  }
  const eventId = createEvent({
    userId,
    eventType: 'add_memory',
    payload: { kind, input, metadata: metadata || {} },
  });
  return { event_id: eventId, status: 'pending', user_id: userId };
}

/**
 * 后台执行素材提炼入库（processEvent 调用，不阻塞 MCP 调用）。
 * kind='messages'：input 为 [{role,content}] → 拼成对话文本；kind='text'：input 为原文。
 * 流程：LLM 提炼成事实 → **与已有记忆冲突消解**（ADD/UPDATE/DELETE/NOOP，见 src/l2/reconcile.js）→ 入库。
 * 提炼无产物/失败 → 抛错（调用方标记事件 failed，素材不落库）；
 * 消解失败则降级为纯追加，绝不让事实丢失。
 */
async function processMemoryMaterial({ userId, kind, input, metadata = {} }) {
  const source = kind === 'messages' && Array.isArray(input)
    ? input.map((m) => `${m.role}: ${m.content}`).join('\n')
    : String(input || '');
  if (!source.trim()) throw new Error('素材为空');
  const extracted = await extractMemories(source);
  if (!extracted.length) throw new Error('LLM 未能从素材提炼出有效记忆（无产物，素材未入库）');
  // 延迟 require：l2 侧要用到本模块的记忆读取，写在顶部会形成循环依赖
  const { reconcileFacts } = require('../../l2/reconcile');
  const r = await reconcileFacts({ userId, facts: extracted, source: 'add_memory', metadata, mode: 'material' });
  const created = r.memoryIds.map((id) => memories.getMemory(id, userId)).filter(Boolean);
  return { created, ops: r };
}

/**
 * LLM 提炼：把一段素材（对话拼接文本或单条原文）提炼成多条独立、自包含、可复用的记忆陈述。
 * 返回字符串数组；LLM 不可用/无有效产出返回 []（调用方据此判失败，不回退存原文）。
 */
async function extractMemories(source) {
  const content = await llm.complete([
    {
      role: 'system',
      content: '你是记忆提炼助手。把下面的内容提炼成多条独立的、可复用的完整事实陈述。要求：1) 每条必须是完整句子，自包含、带明确主语，不得省略主语（如"10.10.10.214 上运行 X 服务"而不是"上运行 X 服务"）；2) 每条用一行输出，不要编号、不要前缀、不要解释；3) 合并同主题，拆开不同主题，每条都是独立可检索的事实；4) 保留关键信息（IP、端口、地址、人名、数字、决策、偏好、技术细节）；5) 丢弃与事实无关的寒暄/过程性内容，不猜测、不添加原文没有的信息。只输出提炼出的事实本身；无法提炼出任何有价值事实时输出空。',
    },
    { role: 'user', content: `素材：\n${source.slice(0, 6000)}` },
  ], { maxTokens: 2048, temperature: 0.1 });

  if (!content) return [];
  return content
    .split('\n')
    .map((l) => l.replace(/^[-*•\d.\s]+/, '').trim())
    // 质量门槛：过短残句不视为可复用记忆（过滤超时截断的碎片）
    .filter((l) => l.length >= 10)
    .slice(0, 20);
}

// ============ 异步任务队列 ============

/** 创建异步任务，立即返回 event_id（pending）。 */
function createEvent({ userId, eventType = 'add_memory', payload }) {
  const id = uuid();
  const ts = now();
  db.prepare(
    'INSERT INTO events (id, user_id, event_type, status, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, userId, eventType, 'pending', JSON.stringify(payload), ts);
  return id;
}

function getEvent(id, userId) {
  const row = db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return null;
  return {
    id: row.id,
    event_type: row.event_type,
    status: row.status,
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 处理一个 pending 任务：素材 → LLM 提炼 → 逐条入库（仅提炼产物）。失败/无产物 → failed。 */
async function processEvent(event) {
  const userId = event.user_id;
  const id = event.id;
  const p = JSON.parse(event.payload || '{}');
  db.prepare("UPDATE events SET status='processing', updated_at=? WHERE id=?").run(now(), id);
  try {
    const { created, ops } = await processMemoryMaterial({
      userId, kind: p.kind, input: p.input, metadata: p.metadata,
    });
    // ops 记录消解明细：count=0 时也能看出"不是没干活，而是素材里的东西都已记住"，
    // 前端/agent 可据此区分「已存在（NOOP）」与「空产出」。
    const result = {
      count: created.length,
      memories: created,
      ops: { added: ops.added, updated: ops.updated, deleted: ops.deleted, noop: ops.noop, degraded: ops.degraded },
    };
    db.prepare("UPDATE events SET status='done', result=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(result), now(), id);
  } catch (e) {
    db.prepare("UPDATE events SET status='failed', error=?, updated_at=? WHERE id=?")
      .run(String(e.message || e).slice(0, 500), now(), id);
  }
  return getEvent(id, userId);
}

/** 扫描并处理 pending 任务（串行，避免 LLM 并发超限；processing 卡死 5 分钟重置重试）。
 *  由服务启动定时调用（见 index.js 每 2s 轮询）。返回本次处理数。 */
async function processPendingEvents() {
  const stuckCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  db.prepare(
    "UPDATE events SET status='pending', updated_at=? WHERE status='processing' AND updated_at <= ?"
  ).run(now(), stuckCutoff);
  const pendings = db
    .prepare("SELECT * FROM events WHERE status = 'pending' ORDER BY created_at LIMIT 3")
    .all();
  for (const ev of pendings) {
    await processEvent(ev);
  }
  return pendings.length;
}

/** 清理 7 天前的已完成/失败任务（防表膨胀） */
function cleanupEvents() {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  db.prepare("DELETE FROM events WHERE status IN ('done','failed') AND created_at <= ?").run(cutoff);
}

/**
 * 素材提炼队列（events 表）的积压统计。
 * 供星图「通讯状态」用——待处理数量直接决定沉淀链路上数据包的密度与流速。
 */
function eventStats(userId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
              SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) processing,
              SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
              MAX(created_at) last_at
         FROM events WHERE user_id = ?`
    )
    .get(userId);
  return {
    total: row.total || 0,
    pending: row.pending || 0,
    processing: row.processing || 0,
    done: row.done || 0,
    failed: row.failed || 0,
    last_at: row.last_at || null,
  };
}

/**
 * 事件队列积压探测（/healthz 用，全局视角不按用户）：
 * pending+processing 卡住意味着后台提炼链停摆——素材「收了但不处理」，必须让健康检查看见。
 */
function queueBacklog() {
  const row = db
    .prepare(
      `SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
              SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) processing,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
              MIN(CASE WHEN status IN ('pending','processing') THEN created_at END) oldest_at
         FROM events`
    )
    .get();
  return {
    pending: row.pending || 0,
    processing: row.processing || 0,
    failed: row.failed || 0,
    oldest_age_ms: row.oldest_at ? Math.max(0, Date.now() - Date.parse(row.oldest_at)) : 0,
  };
}

module.exports = {
  createMemory,
  createEvent,
  getEvent,
  processPendingEvents,
  cleanupEvents,
  eventStats,
  queueBacklog,
};
