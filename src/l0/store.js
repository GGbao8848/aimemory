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
function computeBatchId({ collectorId, agent, sessionId, batchSeq, records }) {
  return crypto
    .createHash('sha256')
    .update(`${collectorId || ''}|${agent}|${sessionId}|${batchSeq == null ? '' : batchSeq}|${JSON.stringify(records)}`)
    .digest('hex');
}

function sessionFilePath(userId, agent, sessionId) {
  return path.join(config.l0Dir, sanitizeSeg(userId), sanitizeSeg(agent), `${sanitizeSeg(sessionId)}.jsonl`);
}

/**
 * 落盘一个批次。
 * @returns {{ok:true, batch_id:string, deduped:boolean, stored:number, bytes:number, file:string}}
 */
function ingestBatch({ userId, agent, sessionId, collectorId, batchSeq, batchId, records }) {
  if (!Array.isArray(records) || records.length === 0) {
    const e = new Error('records 不能为空');
    e.status = 400;
    throw e;
  }
  const bid = batchId || computeBatchId({ collectorId, agent, sessionId, batchSeq, records });

  // 幂等：同批次重传直接跳过（网络重试、进程重启后重放）
  if (repo.l0BatchExists(bid)) {
    return { ok: true, batch_id: bid, deduped: true, stored: 0, bytes: 0, file: sessionFilePath(userId, agent, sessionId) };
  }

  const receivedAt = new Date().toISOString();
  const lines = records.map((r) => JSON.stringify({ ...r, _bid: bid, _recv: receivedAt })).join('\n') + '\n';

  const file = sessionFilePath(userId, agent, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines, 'utf8');

  repo.insertL0Batch({
    batchId: bid,
    userId,
    agent,
    sessionId,
    collectorId,
    records: records.length,
    bytes: Buffer.byteLength(lines),
  });

  return { ok: true, batch_id: bid, deduped: false, stored: records.length, bytes: Buffer.byteLength(lines), file };
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

/** 列出某用户的归档会话（供 Web / 采集器 status 展示） */
function listSessions(userId, limit) {
  return repo.l0Sessions(userId, limit);
}

module.exports = { ingestBatch, archiveStats, listSessions, sessionFilePath, sanitizeSeg, computeBatchId };
