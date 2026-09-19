'use strict';

// L0 原始会话归档域：批次幂等、记录级去重、设备登记与指纹认回、会话清单与对账统计。

const db = require('../index');
const { now, safeParse } = require('./_common');

/** 批次是否已收到过（幂等重传判定） */
function l0BatchExists(batchId) {
  return !!db.prepare('SELECT 1 FROM l0_batches WHERE batch_id = ?').get(batchId);
}

/**
 * 记录级去重：滤掉已收过的 (rid, version)。
 * 批次指纹挡不住"同内容、不同分块"（批大小调整、顺序变化都会改指纹），
 * 这里按记录粒度兜底。允许同一 rid 的不同版本（ZCode 原地更新），只挡完全相同版本。
 * @returns {object[]} 其中真正是新记录的子集
 */
function l0FilterNewRecords({ userId, deviceCode, agent, sessionId, records }) {
  if (!records.length) return records;
  const stmt = db.prepare(
    `SELECT 1 FROM l0_records
      WHERE user_id = ? AND device_code = ? AND agent = ? AND session_id = ? AND rid = ? AND version = ?`
  );
  return records.filter(
    (r) => !stmt.get(userId, deviceCode, agent, sessionId, String(r.rid), Number(r.version) || 0)
  );
}

/** 记录已收（落盘成功后调用）；已存在则忽略 */
function l0MarkRecords({ userId, deviceCode, agent, sessionId, records }) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO l0_records (user_id, device_code, agent, session_id, rid, version)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const r of records) {
      stmt.run(userId, deviceCode, agent, sessionId, String(r.rid), Number(r.version) || 0);
    }
  });
  tx();
}

function insertL0Batch({ batchId, userId, agent, sessionId, deviceCode, collectorId, records, bytes }) {
  db.prepare(
    `INSERT OR IGNORE INTO l0_batches
     (batch_id, user_id, agent, session_id, device_code, collector_id, records, bytes, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(batchId, userId, agent, sessionId, deviceCode || null, collectorId || null, records, bytes, now());
}

/** 按机器指纹查该用户下已登记的设备码（用于重装后认回原设备） */
function findDeviceByFingerprint(userId, fingerprint) {
  if (!fingerprint) return null;
  const row = db
    .prepare('SELECT device_code FROM l0_devices WHERE user_id = ? AND fingerprint = ? ORDER BY last_seen DESC LIMIT 1')
    .get(userId, fingerprint);
  return row ? row.device_code : null;
}

/**
 * 登记/更新设备：首次见到插入，之后更新 label/info/last_seen 与 agent 集合。
 * agents 用集合并集（同一设备可能陆续上报多种 agent）。
 * 指纹只在客户端提供且本地为空时才写入——不覆盖已有指纹，避免把认回关系冲掉。
 */
function upsertL0Device({ userId, deviceCode, label, info, fingerprint, fingerprintSource, agent }) {
  const ts = now();
  const row = db
    .prepare('SELECT agents FROM l0_devices WHERE user_id = ? AND device_code = ?')
    .get(userId, deviceCode);
  if (!row) {
    db.prepare(
      `INSERT INTO l0_devices (user_id, device_code, fingerprint, fingerprint_source, label, info, agents, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      deviceCode,
      fingerprint || null,
      fingerprintSource || null,
      label || null,
      info ? JSON.stringify(info) : null,
      JSON.stringify(agent ? [agent] : []),
      ts,
      ts
    );
    return;
  }
  let agents = [];
  try { agents = JSON.parse(row.agents || '[]'); } catch { agents = []; }
  if (agent && !agents.includes(agent)) agents.push(agent);

  // label 覆盖策略：等于主机名的说明是"默认名"，不该覆盖用户显式设过的自定义名。
  // （否则重装采集器时忘了带 AIMEMORY_DEVICE_LABEL，自定义名就被打回主机名。）
  const hostname = (info && info.hostname) || null;
  const existing = db
    .prepare('SELECT label, info FROM l0_devices WHERE user_id = ? AND device_code = ?')
    .get(userId, deviceCode);
  const existingLabel = existing ? existing.label : null;
  const existingHost = safeParse(existing && existing.info, {}).hostname || null;
  const newLabelIsDefault = !!hostname && label === hostname;
  const existingLabelIsCustom = !!existingLabel && existingLabel !== existingHost;
  const effectiveLabel = newLabelIsDefault && existingLabelIsCustom ? null : (label || null);

  // label/info 用「有值才覆盖」，避免老客户端不带这些字段时把已有信息清掉
  db.prepare(
    `UPDATE l0_devices
        SET fingerprint = COALESCE(fingerprint, ?),
            fingerprint_source = COALESCE(fingerprint_source, ?),
            label = COALESCE(?, label),
            info = COALESCE(?, info),
            agents = ?,
            last_seen = ?
      WHERE user_id = ? AND device_code = ?`
  ).run(
    fingerprint || null,
    fingerprintSource || null,
    effectiveLabel,
    info ? JSON.stringify(info) : null,
    JSON.stringify(agents),
    ts,
    userId,
    deviceCode
  );
}

/** 设备清单（含各设备的会话/记录统计），按最近活跃倒序 */
function listL0Devices(userId) {
  return db
    .prepare(
      `SELECT d.device_code, d.label, d.info, d.agents, d.first_seen, d.last_seen,
              d.fingerprint, d.fingerprint_source,
              COALESCE((SELECT COUNT(DISTINCT r.session_id) FROM l0_records r
                         WHERE r.user_id = d.user_id AND r.device_code = d.device_code), 0) sessions,
              COALESCE((SELECT COUNT(*) FROM l0_records r
                         WHERE r.user_id = d.user_id AND r.device_code = d.device_code), 0) records,
              COALESCE((SELECT SUM(b.bytes) FROM l0_batches b
                         WHERE b.user_id = d.user_id AND b.device_code = d.device_code), 0) bytes
         FROM l0_devices d
        WHERE d.user_id = ?
        ORDER BY d.last_seen DESC`
    )
    .all(userId)
    .map((r) => ({
      device_code: r.device_code,
      label: r.label,
      info: safeParse(r.info, {}),
      agents: safeParse(r.agents, []),
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      fingerprint: r.fingerprint,
      fingerprint_source: r.fingerprint_source,
      sessions: r.sessions,
      records: r.records,
      bytes: r.bytes,
    }));
}

/** 归档会话清单（可按设备/agent 过滤），按最后接收时间倒序 */
function l0Sessions(userId, { deviceCode, agent, limit = 200 } = {}) {
  const where = ['user_id = ?'];
  const args = [userId];
  if (deviceCode) { where.push('device_code = ?'); args.push(deviceCode); }
  if (agent) { where.push('agent = ?'); args.push(agent); }
  args.push(limit);
  // 记录数取自 l0_records（记录级权威索引，已排除重复）；
  // 时间/字节取自 l0_batches（批次维度）。两表用 (设备, agent, 会话) 关联。
  return db
    .prepare(
      `SELECT b.agent, b.session_id, b.device_code, MAX(b.collector_id) collector_id,
              COUNT(DISTINCT b.batch_id) batches,
              COALESCE((SELECT COUNT(*) FROM l0_records r
                         WHERE r.user_id = b.user_id AND r.device_code = b.device_code
                           AND r.agent = b.agent AND r.session_id = b.session_id), 0) records,
              SUM(b.bytes) bytes,
              MIN(b.received_at) first_received, MAX(b.received_at) last_received
       FROM l0_batches b
       WHERE ${where.map((w) => `b.${w}`).join(' AND ')}
       GROUP BY b.device_code, b.agent, b.session_id
       ORDER BY last_received DESC
       LIMIT ?`
    )
    .all(...args);
}

/** 单个会话是否属于该用户（跨用户访问防护，读取归档文件前必须校验） */
function l0SessionOwned(userId, { deviceCode, agent, sessionId }) {
  const row = db
    .prepare(
      `SELECT 1 FROM l0_batches
        WHERE user_id = ? AND agent = ? AND session_id = ?
          AND (? IS NULL OR device_code = ?)
        LIMIT 1`
    )
    .get(userId, agent, sessionId, deviceCode || null, deviceCode || null);
  return !!row;
}

/**
 * 归档概况（采集器对账 / Web 展示）。
 * records 取自 l0_records（真实落盘的唯一记录数），不是 l0_batches.records 的累计值——
 * 后者是"累计接收量"，历史重复批次会让它虚高，不能当作归档规模。
 */
function l0Stats(userId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) records,
              COUNT(DISTINCT session_id) sessions,
              COUNT(DISTINCT agent) agents,
              COUNT(DISTINCT device_code) devices
       FROM l0_records WHERE user_id = ?`
    )
    .get(userId);
  const b = db
    .prepare(
      `SELECT COUNT(*) batches, COALESCE(SUM(bytes),0) bytes, MAX(received_at) last_received
       FROM l0_batches WHERE user_id = ?`
    )
    .get(userId);
  return {
    batches: b.batches,
    sessions: row.sessions,
    agents: row.agents,
    devices: row.devices,
    records: row.records,
    bytes: b.bytes,
    last_received: b.last_received || null,
  };
}

module.exports = {
  l0BatchExists,
  l0FilterNewRecords,
  l0MarkRecords,
  insertL0Batch,
  l0Stats,
  l0Sessions,
  upsertL0Device,
  findDeviceByFingerprint,
  listL0Devices,
  l0SessionOwned,
};
