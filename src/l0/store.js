'use strict';

/**
 * L0 原始会话归档（append-only）。
 *
 * 定位：只接收、只落盘、不改写、不解析语义。原始会话是 L0 的唯一事实源，
 * 后续 L1（会话摘要）/ L2（事实记忆）都从这些文件重放生成——所以这里绝不能
 * 做提炼、去重合并或改写，只能追加。
 *
 * 磁盘布局：<l0Dir>/<user_id>/<agent>/<session_id>.jsonl
 *   一行一条归一化记录（采集器产出，含 _bid 批次指纹）；
 *   agent 与 session_id 来自客户端，落盘前强制白名单化，防目录穿越。
 *
 * 幂等：同批次重传按 _bid（批次指纹）跳过，避免网络重试导致重复追加。
 * 记录级去重不在此处做——L1 消费时按 rid upsert 才是权威语义（本层允许重复行）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const repo = require('../db/repo');

/** 路径片段白名单化：只留字母数字与 . _ -，防止 '../' 穿越 */
function sanitizeSeg(s, max = 120) {
  const cleaned = String(s == null ? '' : s)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, max);
  return cleaned || '_';
}

/** 批次指纹：采集器可自带；缺失时由服务端按内容计算（保证重传可识别） */
function computeBatchId({ deviceCode, collectorId, agent, sessionId, batchSeq, records }) {
  return crypto
    .createHash('sha256')
    .update(
      `${deviceCode || collectorId || ''}|${agent}|${sessionId}|${batchSeq == null ? '' : batchSeq}|${JSON.stringify(records)}`
    )
    .digest('hex');
}

/**
 * 归档文件路径：<l0Dir>/<user>/<device>/<agent>/<session>.jsonl
 * 设备维度是必需的——同一员工多台机器、每台多个 agent，只有带上设备码才能区分
 * "这一份会话是哪台机器的哪个 agent 产生的"。
 */
function sessionFilePath(userId, deviceCode, agent, sessionId) {
  return path.join(
    config.l0Dir,
    sanitizeSeg(userId),
    sanitizeSeg(deviceCode || 'unknown-device'),
    sanitizeSeg(agent),
    `${sanitizeSeg(sessionId)}.jsonl`
  );
}

/**
 * 落盘一个批次。
 * @returns {{ok:true, batch_id:string, deduped:boolean, stored:number, bytes:number, file:string}}
 */
function ingestBatch({ userId, agent, sessionId, deviceCode, deviceLabel, deviceInfo, collectorId, batchSeq, batchId, records }) {
  if (!Array.isArray(records) || records.length === 0) {
    const e = new Error('records 不能为空');
    e.status = 400;
    throw e;
  }
  // 设备码缺省回退到 collector_id（老客户端只发 collector_id）；都没有则归入 unknown-device
  const devCode = deviceCode || collectorId || 'unknown-device';
  const bid = batchId || computeBatchId({ deviceCode: devCode, collectorId, agent, sessionId, batchSeq, records });

  // 登记设备（即使批次是重传也要更新 last_seen/agent 集合）
  repo.upsertL0Device({ userId, deviceCode: devCode, label: deviceLabel, info: deviceInfo, agent });

  // 幂等：同批次重传直接跳过（网络重试、进程重启后重放）
  if (repo.l0BatchExists(bid)) {
    return { ok: true, batch_id: bid, deduped: true, stored: 0, bytes: 0, skipped: 0, file: sessionFilePath(userId, devCode, agent, sessionId) };
  }

  // 记录级去重：拦掉已收过的 (rid, version)。
  // 批次指纹对分块方式敏感（批大小/顺序一变就换指纹），仅靠它会让同样的记录重复落盘；
  // 这里按记录粒度兜底。同一 rid 的不同版本仍会保留（ZCode 原地更新，靠版本收敛）。
  const fresh = repo.l0FilterNewRecords({
    userId, deviceCode: devCode, agent, sessionId, records,
  });
  const skipped = records.length - fresh.length;
  if (!fresh.length) {
    // 整个批次都是已收记录 → 只登记批次指纹，不再追加
    repo.insertL0Batch({
      batchId: bid, userId, agent, sessionId, deviceCode: devCode, collectorId,
      records: 0, bytes: 0,
    });
    return { ok: true, batch_id: bid, deduped: true, stored: 0, bytes: 0, skipped, file: sessionFilePath(userId, devCode, agent, sessionId) };
  }

  const receivedAt = new Date().toISOString();
  // 每条记录内嵌设备与 agent：即使归档文件被单独取走，也能自述来源（可审计）
  const lines =
    fresh
      .map((r) => JSON.stringify({ ...r, _dev: devCode, _agent: agent, _bid: bid, _recv: receivedAt }))
      .join('\n') + '\n';

  const file = sessionFilePath(userId, devCode, agent, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines, 'utf8');

  repo.l0MarkRecords({ userId, deviceCode: devCode, agent, sessionId, records: fresh });
  repo.insertL0Batch({
    batchId: bid,
    userId,
    agent,
    sessionId,
    deviceCode: devCode,
    collectorId,
    records: fresh.length,
    bytes: Buffer.byteLength(lines),
  });

  return { ok: true, batch_id: bid, deduped: false, stored: fresh.length, bytes: Buffer.byteLength(lines), skipped, file };
}

/** 归档概况：批次表统计 + 磁盘实际占用（口径不同，都返回便于对账） */
function archiveStats(userId) {
  const stat = repo.l0Stats(userId);
  let files = 0;
  let diskBytes = 0;
  const root = path.join(config.l0Dir, sanitizeSeg(userId));
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files += 1;
        try { diskBytes += fs.statSync(p).size; } catch { /* 并发删除，忽略 */ }
      }
    }
  };
  walk(root);
  return { ...stat, files, disk_bytes: diskBytes };
}

/** 列出某用户的归档会话（可按设备/agent 过滤） */
function listSessions(userId, opts) {
  return repo.l0Sessions(userId, opts);
}

/** 设备清单 */
function listDevices(userId) {
  return repo.listL0Devices(userId);
}

/**
 * 读取某个会话的归档内容（供 Web 查看详情）。
 * 安全：先用数据库校验该会话确实属于此用户，再读文件——不能只靠路径拼接，
 * 否则构造 device/agent/session 就能越权读别人的会话。
 * @returns {{records:object[], truncated:boolean}|null} null = 不存在或不属于该用户
 */
function readSession(userId, { deviceCode, agent, sessionId }, { limit = 2000 } = {}) {
  if (!repo.l0SessionOwned(userId, { deviceCode, agent, sessionId })) return null;
  const file = sessionFilePath(userId, deviceCode, agent, sessionId);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { records: [], truncated: false }; // 库里有记录但文件不在（被清理）——如实返回空
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const truncated = lines.length > limit;
  const records = [];
  for (const line of lines.slice(0, limit)) {
    try { records.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
  }
  return { records, truncated, total: lines.length };
}

module.exports = {
  ingestBatch,
  archiveStats,
  listSessions,
  listDevices,
  readSession,
  sessionFilePath,
  sanitizeSeg,
  computeBatchId,
};
