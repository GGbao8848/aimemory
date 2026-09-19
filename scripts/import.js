'use strict';

/**
 * 全量导入：读取 scripts/export.js 产出的 export.json（校验 sha256）→ 写回 SQLite。
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
const stats = { memories: { skip: 0, add: 0, upd: 0 } };

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
});
tx();

const c = data.meta?.counts || {};
console.log('✓ 导入完成：');
console.log(`  记忆：新增 ${stats.memories.add} / 覆盖 ${stats.memories.upd} / 跳过 ${stats.memories.skip}`);
db.close();
