'use strict';

/**
 * Webhooks 投递引擎（对齐 mem0 平台的 Webhooks）：
 * - 记忆变更（ADD/UPDATE/DELETE）经 store.recordOp 唯一入口触发 dispatch；
 * - 对每个启用且订阅了该操作类型的 webhook 发 POST（JSON payload + HMAC-SHA256 签名头），
 *   失败自动重试（3 次尝试，1s/5s 退避），结果落 webhook_deliveries 供控制台查看；
 * - 投递完全异步 fire-and-forget：绝不阻塞、绝不影响记忆写入主链路。
 */

const crypto = require('crypto');
const config = require('../config');
const db = require('../db');

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

const ATTEMPT_DELAYS_MS = [0, 1000, 5000]; // 首次 + 2 次重试的退避
const DELIVER_TIMEOUT_MS = 10_000;
const MAX_DELIVERY_LOGS_PER_HOOK = 50; // 每条 webhook 保留的最近投递记录数

// ============ CRUD ============

function listWebhooks(userId) {
  return db.prepare('SELECT id, url, description, secret, events, enabled, created_at FROM webhooks WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId)
    .map((r) => ({ ...r, events: JSON.parse(r.events || '[]'), enabled: !!r.enabled }));
}

function createWebhook({ userId, url, description = '', events = ['ADD', 'UPDATE', 'DELETE'] }) {
  const id = uuid();
  const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
  db.prepare('INSERT INTO webhooks (id, user_id, url, description, secret, events, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
    .run(id, userId, url, description, secret, JSON.stringify(events), now());
  return getWebhook(id, userId);
}

function getWebhook(id, userId) {
  const r = db.prepare('SELECT id, url, description, secret, events, enabled, created_at FROM webhooks WHERE id = ? AND user_id = ?')
    .get(id, userId);
  if (!r) return null;
  return { ...r, events: JSON.parse(r.events || '[]'), enabled: !!r.enabled };
}

/** 更新（mem0 语义：url/description/events/enabled 可改，secret 不改——吊销=删了重建） */
function updateWebhook(id, userId, patch = {}) {
  const existing = getWebhook(id, userId);
  if (!existing) return null;
  const url = patch.url !== undefined ? String(patch.url) : existing.url;
  if (!/^https?:\/\//.test(url)) throw new Error('url 必须以 http:// 或 https:// 开头');
  const description = patch.description !== undefined ? String(patch.description) : existing.description;
  const events = Array.isArray(patch.events) ? patch.events.filter((e) => ['ADD', 'UPDATE', 'DELETE'].includes(e)) : existing.events;
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (existing.enabled ? 1 : 0);
  db.prepare('UPDATE webhooks SET url = ?, description = ?, events = ?, enabled = ? WHERE id = ? AND user_id = ?')
    .run(url, description, JSON.stringify(events), enabled, id, userId);
  return getWebhook(id, userId);
}

function deleteWebhook(id, userId) {
  const r = db.prepare('DELETE FROM webhooks WHERE id = ? AND user_id = ?').run(id, userId);
  return r.changes > 0;
}

function listDeliveries(webhookId, userId, limit = 20) {
  return db.prepare(`
    SELECT d.id, d.op, d.memory_id, d.status, d.status_code, d.attempts, d.error, d.created_at
      FROM webhook_deliveries d
      JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.webhook_id = ? AND w.user_id = ?
     ORDER BY d.id DESC LIMIT ?
  `).all(webhookId, userId, Math.max(1, Math.min(Number(limit) || 20, 100)));
}

// ============ 投递 ============

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function deliverOnce(hook, body, eventId) {
  const res = await fetch(hook.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Aimemory-Event': eventId,
      'X-Aimemory-Signature': `sha256=${sign(hook.secret, body)}`,
    },
    body,
    signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
  });
  return res;
}

/** 投递单条 webhook（含重试与日志），由 dispatch 后台调用 */
async function deliver(hook, op, memoryId, payloadObj) {
  const body = JSON.stringify({ op, memory_id: memoryId, ...payloadObj, delivered_at: now() });
  let lastCode = null;
  let lastErr = null;
  for (let attempt = 0; attempt < ATTEMPT_DELAYS_MS.length; attempt++) {
    if (ATTEMPT_DELAYS_MS[attempt]) await new Promise((r) => setTimeout(r, ATTEMPT_DELAYS_MS[attempt]));
    try {
      const res = await deliverOnce(hook, body, `${hook.id}:${Date.now()}`);
      lastCode = res.status;
      if (res.ok) {
        logDelivery(hook.id, op, memoryId, body, 'ok', res.status, attempt + 1, null);
        return true;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e.message.slice(0, 200);
    }
  }
  logDelivery(hook.id, op, memoryId, body, 'failed', lastCode, ATTEMPT_DELAYS_MS.length, lastErr);
  return false;
}

const clipBody = (s) => String(s || '').slice(0, 16000);

function logDelivery(webhookId, op, memoryId, payload, status, statusCode, attempts, error) {
  try {
    db.prepare('INSERT INTO webhook_deliveries (webhook_id, op, memory_id, payload, status, status_code, attempts, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(webhookId, op, memoryId, clipBody(payload), status, statusCode, attempts, error, now());
    // 保留策略：每条 webhook 只留最近 N 条投递日志
    db.prepare(`DELETE FROM webhook_deliveries WHERE webhook_id = ? AND id NOT IN (
      SELECT id FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ${MAX_DELIVERY_LOGS_PER_HOOK})`)
      .run(webhookId, webhookId);
  } catch { /* 日志失败不影响主链路 */ }
}

const body = (s) => String(s || '').slice(0, 16000);

/** 记忆变更入口（store.recordOp 调用）：异步扇出到所有订阅方，绝不抛错 */
function dispatch({ userId, op, memoryId, beforeText, afterText }) {
  try {
    const hooks = db.prepare('SELECT * FROM webhooks WHERE user_id = ? AND enabled = 1').all(userId);
    if (!hooks.length) return;
    const targets = hooks.filter((h) => {
      try { return (JSON.parse(h.events || '[]') || []).includes(op); } catch { return false; }
    });
    for (const hook of targets) {
      deliver(hook, op, memoryId, { before_memory: beforeText, memory: afterText })
        .catch((e) => console.error(`[webhooks] 投递异常：${e.message}`));
    }
  } catch (e) {
    console.error(`[webhooks] dispatch 异常：${e.message}`);
  }
}

module.exports = { listWebhooks, createWebhook, getWebhook, updateWebhook, deleteWebhook, listDeliveries, dispatch };
