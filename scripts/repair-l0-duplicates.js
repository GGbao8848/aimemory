'use strict';

/**
 * 一次性修复：清理 L0 归档中的精确重复记录，并回填记录级去重索引。
 *
 * 背景：早期只用批次指纹做幂等，而指纹对整个批次内容敏感——同一批记录若分块方式
 * 不同（批大小调整、顺序变化）就算出不同指纹，服务端会重复落盘同样的记录。
 * 现已加记录级去重（l0_records 表，按 rid+version），本脚本负责把既有数据对齐：
 *
 *   1. 扫描每个归档文件，只保留每个 (rid, version) 的**首次**出现，删除其后精确重复；
 *      —— 同一 rid 的不同 version 是合法的（ZCode 原地更新），一律保留。
 *   2. 用去重后的记录回填 l0_records，使既有数据今后也受去重保护。
 *
 * 幂等：可重复执行；已去重的文件再次扫描只会得到 0 删除。
 * 用法：node scripts/repair-l0-duplicates.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/db');

const DRY = process.argv.includes('--dry-run');

function walkFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function main() {
  const files = walkFiles(config.l0Dir);
  console.log(`归档文件 ${files.length} 个${DRY ? '（dry-run，不写盘）' : ''}`);

  let totalLines = 0;
  let removedTotal = 0;
  let badLines = 0;
  const markStmt = db.prepare(
    `INSERT OR IGNORE INTO l0_records (user_id, device_code, agent, session_id, rid, version)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  for (const file of files) {
    // 路径形如 <l0Dir>/<user>/<device>/<agent>/<session>.jsonl
    const rel = path.relative(config.l0Dir, file).split(path.sep);
    if (rel.length < 4) continue; // 不是 v2 结构（迁移脚本负责先搬家）
    const [userId, deviceCode, agent] = rel;
    const sessionId = path.basename(file, '.jsonl');

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    totalLines += lines.length;

    const seen = new Set();
    const kept = [];
    const keptRecords = [];
    for (const line of lines) {
      let d;
      try { d = JSON.parse(line); } catch { badLines += 1; kept.push(line); continue; }
      const key = `${d.rid}\u0000${Number(d.version) || 0}`;
      if (seen.has(key)) continue; // 精确重复 → 丢弃
      seen.add(key);
      kept.push(line);
      keptRecords.push({ rid: d.rid, version: d.version });
    }

    const removed = lines.length - kept.length;
    removedTotal += removed;

    if (!DRY) {
      if (removed > 0) {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, kept.join('\n') + '\n', 'utf8');
        fs.renameSync(tmp, file);
      }
      const tx = db.transaction(() => {
        for (const r of keptRecords) {
          markStmt.run(userId, deviceCode, agent, sessionId, String(r.rid), Number(r.version) || 0);
        }
      });
      tx();
    }
    if (removed > 0) {
      console.log(`  ${rel.join('/')}: 删重复 ${removed}（保留 ${kept.length}/${lines.length}）`);
    }
  }

  console.log(`\n合计：总行 ${totalLines}，删精确重复 ${removedTotal}，坏行 ${badLines}${DRY ? '（未写盘）' : ''}`);
  if (!DRY) {
    const n = db.prepare('SELECT COUNT(*) c FROM l0_records').get().c;
    console.log(`去重索引 l0_records 现有 ${n} 条`);
  }
}

main();
