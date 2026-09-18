'use strict';

/**
 * 运维链路端到端测试（夜间计划 07:00 项）：
 * 1) 备份 → 破坏 → 恢复：scripts/backup.sh + restore.sh，恢复后数据完整；
 * 2) 导出 → 清空 → 导入：scripts/export.js + import.js，回环一致且幂等（重导入零重复）。
 *
 * 全程子进程跑脚本 + 临时目录，零 LLM、零外部服务。脚本自身的行为在演练中已人工验证，
 * 这里固化为回归：运维脚本坏了必须在测试期就红，而不是在凌晨的恢复现场才红。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const envWith = (extra) => ({ ...process.env, ...extra });

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts });
}

function nodeEval(code, env) {
  return run(NODE, ['-e', code], { env: envWith(env) });
}

function countRows(dbFile, sql) {
  const Database = require('better-sqlite3');
  const db = new Database(dbFile, { readonly: true });
  try {
    return db.prepare(sql).get();
  } finally {
    db.close();
  }
}

test('备份 → 破坏 → 恢复：事实与计数完整，integrity ok', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-backup-'));
  const dataDir = path.join(dir, 'data');
  const outDir = path.join(dir, 'backups');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'aimemory.db');

  // 源库：schema + 一条事实（直写 SQLite，零 LLM）
  nodeEval(
    `const db = require(${JSON.stringify(path.join(ROOT, 'src/db'))});
     require(${JSON.stringify(path.join(ROOT, 'src/l2/store'))}).insertFact({ userId: 'owner', text: '备份演练事实：必须可恢复', metadata: {} });`,
    { AIMEMORY_DB: dbFile }
  );

  // 备份 → 校验产物
  run(path.join(ROOT, 'scripts/backup.sh'), [dataDir, outDir, '3']);
  const stamp = fs.readdirSync(outDir)[0];
  const backupDir = path.join(outDir, stamp);
  assert.ok(fs.existsSync(path.join(backupDir, 'aimemory.db')), '备份应含 db');
  assert.ok(fs.existsSync(path.join(backupDir, 'manifest.sha256')), '备份应含校验和');

  // 破坏：删除原库
  fs.rmSync(dbFile, { force: true });

  // 恢复 + 验证
  run(path.join(ROOT, 'scripts/restore.sh'), [backupDir, dataDir]);
  const row = countRows(dbFile, "SELECT text, COUNT(*) n FROM memories WHERE text LIKE '备份演练事实%'");
  assert.ok(row.n === 1, '恢复后事实应存在');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('导出 → 清空 → 导入：回环一致且幂等（含 L3 取代链）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-export-'));
  const srcDb = path.join(dir, 'src.db');
  const srcL3 = path.join(dir, 'src-l3');
  const packDir = path.join(dir, 'pack');
  const tgtDb = path.join(dir, 'target.db');
  const tgtL3 = path.join(dir, 'target-l3');
  const srcEnv = { AIMEMORY_DB: srcDb, AIMEMORY_L3_DIR: srcL3, LLM_ENABLED: '0' };

  // 源库：事实 + L3 取代链（旧→新）
  nodeEval(
    `const db = require(${JSON.stringify(path.join(ROOT, 'src/db'))});
     const l2 = require(${JSON.stringify(path.join(ROOT, 'src/l2/store'))});
     const l3 = require(${JSON.stringify(path.join(ROOT, 'src/l3/store'))});
     l2.insertFact({ userId: 'owner', text: '导出演练事实 X', metadata: {} });
     const oldId = l3.appendEntry({ kind: 'lessons', text: '旧版条目', confidence: 0.6 });
     const newId = l3.appendEntry({ kind: 'lessons', text: '新版条目', confidence: 0.8 });
     l3.markSuperseded(oldId, newId);`,
    srcEnv
  );

  // 导出 → 目标空库 → 导入（两次，验证幂等）
  nodeEval(
    `require(${JSON.stringify(path.join(ROOT, 'src/db'))});`,
    { AIMEMORY_DB: tgtDb }
  );
  run(NODE, [path.join(ROOT, 'scripts/export.js'), packDir], { env: envWith(srcEnv) });
  run(NODE, [path.join(ROOT, 'scripts/import.js'), packDir], { env: envWith({ AIMEMORY_DB: tgtDb, AIMEMORY_L3_DIR: tgtL3 }) });
  run(NODE, [path.join(ROOT, 'scripts/import.js'), packDir], { env: envWith({ AIMEMORY_DB: tgtDb, AIMEMORY_L3_DIR: tgtL3 }) });

  // 验证：记忆 1 条、L3 全量 2 条（1 active + 1 superseded，链指向新版）
  const mem = countRows(tgtDb, "SELECT COUNT(*) n FROM memories WHERE text = '导出演练事实 X'");
  assert.equal(mem.n, 1, '记忆应恰好一条（幂等）');

  // 用独立连接读目标 L3 目录。
  // 关键：config 与 store 一起清缓存——config 在本进程早前已被以默认 l3Dir 加载，
  // 只清 store 缓存的话，fresh store 仍会拿旧 config 读默认目录（data/l3）而非目标目录，验证全空。
  const savedEnv = process.env.AIMEMORY_L3_DIR;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/l3/store')];
  process.env.AIMEMORY_L3_DIR = tgtL3;
  const freshL3 = require('../src/l3/store');
  const all = freshL3.listEntries({ includeSuperseded: true });
  const active = freshL3.listEntries({});
  process.env.AIMEMORY_L3_DIR = savedEnv;

  assert.equal(all.length, 2, `L3 应两条（旧+新），实际 ${all.length}`);
  assert.equal(active.length, 1, 'active 应只剩新版');
  assert.ok(active[0].text.includes('新版'), 'active 应为新版');
  const oldEntry = all.find((e) => e.superseded_by);
  assert.ok(oldEntry && oldEntry.text.includes('旧版'), '旧版应标记被取代');
  assert.equal(oldEntry.superseded_by, active[0].id, '取代链应指向新版');

  fs.rmSync(dir, { recursive: true, force: true });
});
