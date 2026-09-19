'use strict';

// L1 会话摘要域：源指纹（廉价的 count:max:sum 组合）+ 摘要状态机（pending/running/done/failed）。
// 只做 SQLite 读写；摘要的 LLM 生成见 src/l1/summarize.js，调度见 src/l1/scheduler.js。

const db = require('../index');
const { now, safeParse } = require('./_common');

/**
 * 源指纹表达式：**全项目唯一的一处定义**。
 *
 * count + max + sum 三者组合即可覆盖 L0 的全部变化（L0 是 append-only，无删除）：
 *   - 新增记录 → count 变
 *   - 某条 version 涨到最大 → max 变
 *   - 非最大记录 version 上涨（如 A=100,B=200 时 A→150）→ count/max 不变但 sum 变
 *
 * ⚠️ 必须与写入端（l1/summarize.js 存 content_hash）用同一个表达式。
 * 曾经踩过：写入端用 sha256(rid+version)，扫描端用 count:max:sum——两者永不相等，
 * 导致每个已摘要的会话每次扫描都被判为"内容已变"，反复重摘、白烧 LLM 配额。
 */
const L1_FP_SQL = "COUNT(*) || ':' || COALESCE(MAX(r.version), 0) || ':' || COALESCE(SUM(r.version), 0)";

/** 全部会话的源指纹（廉价：纯 SQL 扫 l0_records，不读归档文件） */
function l1Sources(userId) {
  // 注意：last_received 用关联子查询，**不能** JOIN l0_batches 后取 MAX——
  // LEFT JOIN 会让 COUNT(*) 变成「记录数 × 批次数」（实测某会话 2008 条 × 26 批
  // = 52208），指纹随批次增加而变化，即使没有新记录也会触发重摘。
  // 子查询写法与 l1SourceFp 的结果严格一致。
  return db
    .prepare(
      `SELECT r.device_code, r.agent, r.session_id,
              ${L1_FP_SQL} AS fp,
              (SELECT MAX(b.received_at) FROM l0_batches b
                WHERE b.user_id = r.user_id AND b.device_code = r.device_code
                  AND b.agent = r.agent AND b.session_id = r.session_id) AS last_received
         FROM l0_records r
        WHERE r.user_id = ?
        GROUP BY r.device_code, r.agent, r.session_id`
    )
    .all(userId);
}

/** 单个会话的源指纹（写入端存 content_hash 用，与 l1Sources 同源同式） */
function l1SourceFp(userId, { deviceCode, agent, sessionId }) {
  const row = db
    .prepare(
      `SELECT ${L1_FP_SQL} AS fp FROM l0_records r
        WHERE r.user_id = ? AND r.device_code = ? AND r.agent = ? AND r.session_id = ?`
    )
    .get(userId, deviceCode, agent, sessionId);
  return row && row.fp ? String(row.fp) : null;
}

/** 现有摘要的指纹与状态（用于比对） */
function l1Existing(userId) {
  return db
    .prepare('SELECT device_code, agent, session_id, status, content_hash, attempts, updated_at FROM l1_summaries WHERE user_id = ?')
    .all(userId)
    .reduce((m, r) => {
      m[`${r.device_code}\u0000${r.agent}\u0000${r.session_id}`] = r;
      return m;
    }, {});
}

/** 标记会话进入摘要队列（首次登记；已存在则不动，避免覆盖进行中的状态） */
function ensureL1Pending({ userId, deviceCode, agent, sessionId }) {
  const ts = now();
  db.prepare(
    `INSERT INTO l1_summaries (user_id, device_code, agent, session_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(user_id, device_code, agent, session_id) DO NOTHING`
  ).run(userId, deviceCode, agent, sessionId, ts, ts);
}

/** 取一批待处理的会话（pending，或 failed 但未超重试上限） */
function pickL1Pending({ maxAttempts = 3, limit = 5 } = {}) {
  return db
    .prepare(
      `SELECT user_id, device_code, agent, session_id, attempts, content_hash
         FROM l1_summaries
        WHERE status IN ('pending', 'failed') AND attempts < ?
        ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, updated_at ASC
        LIMIT ?`
    )
    .all(maxAttempts, limit);
}

/** 置为 running（防止多轮重复处理同一个） */
function markL1Running({ userId, deviceCode, agent, sessionId }) {
  db.prepare(
    `UPDATE l1_summaries SET status='running', attempts = attempts + 1, updated_at=?
      WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
  ).run(now(), userId, deviceCode, agent, sessionId);
}

/** 归档文件缺失等不可恢复情况 → 直接标记失败（不再重试） */
function markL1Failed({ userId, deviceCode, agent, sessionId, error, permanent = false }) {
  // 注意：不要把 attempts 重置为 0——markL1Running 已递增过它，清零会让失败任务
  // 永远达不到重试上限、无限重试（曾踩过：pickL1Pending 每轮都把它捞回来）。
  // 只有"永久失败"（归档文件不存在等）才把 attempts 顶到极大值停止重试。
  if (permanent) {
    db.prepare(
      `UPDATE l1_summaries SET status='failed', error=?, attempts=999, updated_at=?
        WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
    ).run(String(error || '').slice(0, 500), now(), userId, deviceCode, agent, sessionId);
    return;
  }
  db.prepare(
    `UPDATE l1_summaries SET status='failed', error=?, updated_at=?
      WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
  ).run(String(error || '').slice(0, 500), now(), userId, deviceCode, agent, sessionId);
}

/** 保存摘要产物（摘要成功） */
function saveL1Summary({ userId, deviceCode, agent, sessionId, contentHash: hash, records, first_ts: firstTs, last_ts: lastTs, overview, decisions, pending: pendingItems, artifacts, model }) {
  db.prepare(
    `UPDATE l1_summaries
        SET status='done', content_hash=?, error=NULL,
            overview=?, decisions=?, pending=?, artifacts=?,
            records=?, first_ts=?, last_ts=?, model=?, updated_at=?
      WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
  ).run(
    hash || null,
    overview || null,
    JSON.stringify(decisions || []),
    JSON.stringify(pendingItems || []),
    JSON.stringify(artifacts || []),
    records || 0,
    firstTs || null,
    lastTs || null,
    model || null,
    now(),
    userId, deviceCode, agent, sessionId
  );
}

/** 会话内容已变化 → 重新排队（保留旧摘要在库，直到新摘要覆盖） */
function requeueL1({ userId, deviceCode, agent, sessionId, contentHash: hash }) {
  db.prepare(
    `UPDATE l1_summaries SET status='pending', content_hash=?, attempts=0, updated_at=?
      WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
  ).run(hash, now(), userId, deviceCode, agent, sessionId);
}

function toL1Obj(r) {
  return {
    ...r,
    decisions: safeParse(r.decisions, []),
    pending: safeParse(r.pending, []),
    artifacts: safeParse(r.artifacts, []),
  };
}

/** 摘要清单（可按设备/agent 过滤），按会话最后时间倒序 */
function listL1Summaries(userId, { deviceCode, agent, limit = 200 } = {}) {
  const where = ['user_id = ?', "status = 'done'"];
  const args = [userId];
  if (deviceCode) { where.push('device_code = ?'); args.push(deviceCode); }
  if (agent) { where.push('agent = ?'); args.push(agent); }
  args.push(limit);
  return db
    .prepare(
      `SELECT device_code, agent, session_id, overview, decisions, pending, artifacts,
              records, first_ts, last_ts, model, updated_at
         FROM l1_summaries
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(last_ts, updated_at) DESC
        LIMIT ?`
    )
    .all(...args)
    .map(toL1Obj);
}

/** 单会话摘要 */
function getL1Summary(userId, { deviceCode, agent, sessionId }) {
  const row = db
    .prepare(
      `SELECT device_code, agent, session_id, status, overview, decisions, pending, artifacts,
              records, first_ts, last_ts, model, error, attempts, content_hash, updated_at
         FROM l1_summaries
        WHERE user_id=? AND device_code=? AND agent=? AND session_id=?`
    )
    .get(userId, deviceCode, agent, sessionId);
  return row ? toL1Obj(row) : null;
}

/** 摘要进度统计（Web / 运维查看） */
function l1Stats(userId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
              SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
              SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
              MAX(updated_at) last_run
         FROM l1_summaries WHERE user_id = ?`
    )
    .get(userId);
  return {
    total: row.total || 0,
    done: row.done || 0,
    pending: row.pending || 0,
    running: row.running || 0,
    failed: row.failed || 0,
    last_run: row.last_run || null,
  };
}

/** 启动自愈：把上次进程中断留下的 running 复位为 pending */
function resetStuckL1() {
  return db.prepare("UPDATE l1_summaries SET status='pending' WHERE status='running'").run().changes;
}

module.exports = {
  l1Sources,
  l1SourceFp,
  l1Existing,
  ensureL1Pending,
  pickL1Pending,
  markL1Running,
  markL1Failed,
  saveL1Summary,
  requeueL1,
  listL1Summaries,
  getL1Summary,
  l1Stats,
  resetStuckL1,
};
