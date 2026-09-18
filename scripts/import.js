'use strict';

/**
 * 全量导入：读取 scripts/export.js 产出的 export.json（校验 sha256）→ 写回 SQLite 与 L3 markdown。
 * 用法: node scripts/import.js <导出目录> [--overwrite]
 *   默认幂等（同 id 跳过）；--overwrite 时用导出内容覆盖同 id 记忆的文本与元数据。
 * 直写 SQLite，不经过任何 LLM 路径。对应夜间计划 03:30 项（与 export.js 配套）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.AIMEMORY_DATA_DIR || path.join(ROOT, 'data');
const DB = process.env.AIMEMORY_DB || path.join(DATA_DIR, 'aimemory.db');
const SRC = process.argv[2];
const OVERWRITE = process.argv.includes('--overwrite');

if (!SRC) { console.error('用法: node scripts/import.js <导出目录> [--overwrite]'); process.exit(1); }
const file = path.join(SRC, 'export.json');
if (!fs.existsSync(file)) { console.error(`✗ 未找到 ${file}`); process.exit(1); }

// 1) 校验和
const body = fs.readFileSync(file, 'utf8');
const expected = (fs.readFileSync(path.join(SRC, 'manifest.sha256'), 'utf8').trim().split(/\s+/)[0] || '').toLowerCase();
const actual = crypto.createHash('sha256').update(body).digest('hex');
if (expected && actual !== expected) {
  console.error(`✗ 校验和不匹配：manifest=${expected} actual=${actual}（文件可能损坏或被篡改）`);
  process.exit(1);
}
const data = JSON.parse(body);
if (data.meta?.format !== 'aimemory-export/1') {
  console.error(`✗ 非本工具的导出格式：${data.meta?.format || '(缺失)'}`);
  process.exit(1);
}

// 2) 写库（目标库需已初始化 schema：先启动过一次服务，或 node -e "require('./src/db')"）
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB);
db.pragma('journal_mode = WAL');
const now = new Date().toISOString();
const stats = { memories: { skip: 0, add: 0, upd: 0 }, l1: { skip: 0, add: 0 }, l0: { skip: 0, add: 0 } };

const tx = db.transaction(() => {
  // memories：按 id 幂等
  const insM = db.prepare('INSERT OR IGNORE INTO memories (id, user_id, text, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  const updM = db.prepare('UPDATE memories SET text = ?, metadata = ?, updated_at = ? WHERE id = ?');
  for (const m of data.memories || []) {
    const has = db.prepare('SELECT 1 FROM memories WHERE id = ?').get(m.id);
    if (has) {
      if (OVERWRITE && (m.text !== undefined || m.metadata !== undefined)) {
        updM.run(m.text, m.metadata, m.updated_at || now, m.id);
        stats.memories.upd += 1;
      } else stats.memories.skip += 1;
    } else {
      insM.run(m.id, m.user_id, m.text, m.metadata, m.created_at || now, m.updated_at || now);
      stats.memories.add += 1;
    }
  }
  // l1_summaries：主键幂等，整行替换（摘要可整体重放）
  const insL1 = db.prepare(`INSERT OR REPLACE INTO l1_summaries
    (user_id, device_code, agent, session_id, status, content_hash, attempts, error, overview, decisions, pending, artifacts,
     records, first_ts, last_ts, model, created_at, updated_at)
    VALUES (@user_id, @device_code, @agent, @session_id, @status, @content_hash, @attempts, @error, @overview, @decisions, @pending, @artifacts,
     @records, @first_ts, @last_ts, @model, @created_at, @updated_at)`);
  for (const r of data.l1_summaries || []) {
    insL1.run({ content_hash: null, attempts: 0, error: null, records: 0, ...r });
    stats.l1.add += 1;
  }
  // l0 索引：主键幂等
  const insR = db.prepare('INSERT OR IGNORE INTO l0_records (user_id, device_code, agent, session_id, rid, version) VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of data.l0?.records || []) { insR.run(r.user_id, r.device_code, r.agent, r.session_id, r.rid, r.version); stats.l0.add += 1; }
  const insD = db.prepare(`INSERT OR IGNORE INTO l0_devices (user_id, device_code, fingerprint, fingerprint_source, label, info, agents, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const d of data.l0?.devices || []) { insD.run(d.user_id, d.device_code, d.fingerprint, d.fingerprint_source, d.label, d.info, d.agents, d.first_seen, d.last_seen); }
  const insB = db.prepare('INSERT OR IGNORE INTO l0_batches (batch_id, user_id, agent, session_id, device_code, collector_id, records, bytes, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const b of data.l0?.batches || []) { insB.run(b.batch_id, b.user_id, b.agent, b.session_id, b.device_code, b.collector_id, b.records, b.bytes, b.received_at); }
});
tx();

// 3) L3 条目：按原 id 合并进 markdown（幂等），supersede 链在全部条目就位后第二遍回放
process.env.AIMEMORY_L3_DIR = process.env.AIMEMORY_L3_DIR || path.join(DATA_DIR, 'l3');
const l3store = require('../src/l3/store');
let l3add = 0;
for (const e of data.l3_entries || []) {
  if (l3store.getEntry(e.id)) continue; // 按原 id 幂等：重导入不再翻倍
  l3store.appendEntry({
    id: e.id, kind: e.kind, text: e.text, source: e.source,
    confidence: e.confidence, validFrom: e.valid_from,
  });
  l3add += 1;
}
// 第二遍：supersede 链回放（被取代者与取代者可能任意顺序出现在包里）
let l3link = 0;
for (const e of data.l3_entries || []) {
  if (e.superseded_by && l3store.markSuperseded(e.id, e.superseded_by)) l3link += 1;
}

const c = data.meta?.counts || {};
console.log('✓ 导入完成：');
console.log(`  记忆：新增 ${stats.memories.add} / 覆盖 ${stats.memories.upd} / 跳过 ${stats.memories.skip}`);
console.log(`  摘要：写入 ${stats.l1.add} | L0 索引：新增 ${stats.l0.add} | L3 条目：新增 ${l3add}（回放取代链 ${l3link}）`);
db.close();
