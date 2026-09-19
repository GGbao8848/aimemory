'use strict';

/**
 * 全量导出：memories → 单包 JSON + 校验和。
 * 用法: node scripts/export.js [输出目录]（默认 <repo>/exports/export-<时间戳>）
 *
 * 直读 SQLite（只读连接），不经过任何 LLM 路径。导入见 scripts/import.js（配套）。
 * 对应夜间计划 03:30 项。
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.AIMEMORY_DATA_DIR || path.join(ROOT, 'data');
const DB = process.env.AIMEMORY_DB || path.join(DATA_DIR, 'aimemory.db');
const OUT = process.argv[2] || path.join(ROOT, 'exports', `export-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);

if (!fs.existsSync(DB)) {
  console.error(`✗ 未找到数据库：${DB}`);
  process.exit(1);
}

const db = new Database(DB, { readonly: true });
const rows = (sql) => db.prepare(sql).all();

const memories = rows('SELECT * FROM memories ORDER BY created_at');

const payload = {
  meta: {
    exported_at: new Date().toISOString(),
    format: 'aimemory-export/1',
    counts: { memories: memories.length },
  },
  memories,
};

fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, 'export.json');
const body = JSON.stringify(payload, null, 1);
fs.writeFileSync(file, body);

// 校验和（crypto 内联，跨平台）
const crypto = require('crypto');
const hash = crypto.createHash('sha256').update(body).digest('hex');
fs.writeFileSync(path.join(OUT, 'manifest.sha256'), `${hash}  export.json\n`);

console.log(`✓ 导出完成：${OUT}`);
console.log(`  记忆 ${payload.meta.counts.memories} 条`);
console.log(`  校验和：${hash}`);
db.close();
