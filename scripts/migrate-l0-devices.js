'use strict';

/**
 * 一次性迁移：给历史 L0 归档补上设备维度。
 *
 * v1（本迁移前）的归档结构是 data/l0/<user>/<agent>/<session>.jsonl，
 * 行内没有设备标记；l0_batches 也没有 device_code。
 * v2 起改为 <user>/<device>/<agent>/<session>.jsonl 并把设备写进每一行。
 *
 * 历史批次都是通过本机 Token 上传的，其 collector_id 已在库里——用它作为设备码回填
 * （设备码缺省即 collector_id）。若 collector_id 也为空，归入 unknown-device。
 * 这样历史会话在新界面里依然能按设备归类查询。
 *
 * 幂等：已迁移的行（device_code 非空且文件已在 v2 路径）会跳过。
 * 用法：node scripts/migrate-l0-devices.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/db');

const DRY = process.argv.includes('--dry-run');
const sanitize = (s, max = 120) =>
  String(s == null ? '' : s)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, max) || '_';

function main() {
  const rows = db
    .prepare('SELECT DISTINCT user_id, agent, session_id, collector_id FROM l0_batches WHERE device_code IS NULL')
    .all();

  console.log(`待迁移会话：${rows.length}${DRY ? '（dry-run，不写盘）' : ''}`);
  let moved = 0;
  let relabeled = 0;
  let missing = 0;

  for (const r of rows) {
    const device = r.collector_id || 'unknown-device';
    const oldFile = path.join(config.l0Dir, sanitize(r.user_id), sanitize(r.agent), `${sanitize(r.session_id)}.jsonl`);
    const newFile = path.join(config.l0Dir, sanitize(r.user_id), sanitize(device), sanitize(r.agent), `${sanitize(r.session_id)}.jsonl`);

    if (!fs.existsSync(oldFile)) {
      // 老文件不在（可能已手工整理）→ 只回填库中 device_code
      missing += 1;
    } else if (fs.existsSync(newFile)) {
      // 目标已存在（重复迁移）→ 合并：追加老内容后删除老文件
      if (!DRY) {
        const extra = fs.readFileSync(oldFile, 'utf8');
        fs.appendFileSync(newFile, extra);
        fs.rmSync(oldFile);
      }
      moved += 1;
    } else {
      if (!DRY) {
        fs.mkdirSync(path.dirname(newFile), { recursive: true });
        // 给每一行补设备/agent 标记（与 v2 写入格式一致）
        const lines = fs
          .readFileSync(oldFile, 'utf8')
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => {
            try {
              const d = JSON.parse(l);
              if (d._dev) return l;
              return JSON.stringify({ ...d, _dev: device, _agent: r.agent });
            } catch {
              return l; // 坏行原样保留，不丢数据
            }
          });
        fs.writeFileSync(newFile, lines.join('\n') + '\n', 'utf8');
        fs.rmSync(oldFile);
      }
      moved += 1;
    }

    if (!DRY) {
      db.prepare(
        'UPDATE l0_batches SET device_code = ? WHERE user_id = ? AND agent = ? AND session_id = ? AND device_code IS NULL'
      ).run(device, r.user_id, r.agent, r.session_id);
      // 登记设备（历史数据没有 info，留空即可）。agents 需取并集，
      // 否则同一台设备上的第二种 agent 会把先登记的覆盖掉。
      const ts = new Date().toISOString();
      const existing = db
        .prepare('SELECT agents FROM l0_devices WHERE user_id = ? AND device_code = ?')
        .get(r.user_id, device);
      let agents = [];
      try { agents = existing ? JSON.parse(existing.agents || '[]') : []; } catch { agents = []; }
      if (!agents.includes(r.agent)) agents.push(r.agent);
      db.prepare(
        `INSERT INTO l0_devices (user_id, device_code, label, info, agents, first_seen, last_seen)
         VALUES (?, ?, NULL, NULL, ?, ?, ?)
         ON CONFLICT(user_id, device_code) DO UPDATE SET
           agents = excluded.agents,
           last_seen = MAX(l0_devices.last_seen, excluded.last_seen)`
      ).run(r.user_id, device, JSON.stringify(agents), ts, ts);
      relabeled += 1;
    }
  }

  // 清理迁移后残留的空目录（<user>/<agent>/ 已无文件）
  if (!DRY) {
    for (const user of fs.existsSync(config.l0Dir) ? fs.readdirSync(config.l0Dir) : []) {
      const userDir = path.join(config.l0Dir, user);
      if (!fs.statSync(userDir).isDirectory()) continue;
      for (const sub of fs.readdirSync(userDir)) {
        const subDir = path.join(userDir, sub);
        if (!fs.statSync(subDir).isDirectory()) continue;
        // v2 之下应是 <device>/<agent>/，若某目录直接含 .jsonl 说明是旧的 <agent>/
        const hasJsonl = fs.readdirSync(subDir).some((f) => f.endsWith('.jsonl'));
        if (hasJsonl && fs.readdirSync(subDir).length === 0) fs.rmdirSync(subDir);
      }
    }
  }

  console.log(`迁移完成：搬移 ${moved}，文件缺失 ${missing}，库回填 ${relabeled}`);
}

main();
