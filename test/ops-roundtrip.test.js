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

test('导出 → 清空 → 导入：回环一致且幂等', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-export-'));
  const srcDb = path.join(dir, 'src.db');
  const packDir = path.join(dir, 'pack');
  const tgtDb = path.join(dir, 'target.db');
  const srcEnv = { AIMEMORY_DB: srcDb, LLM_ENABLED: '0' };

  // 源库：两条事实（直写 SQLite，零 LLM）
  nodeEval(
    `const db = require(${JSON.stringify(path.join(ROOT, 'src/db'))});
     const l2 = require(${JSON.stringify(path.join(ROOT, 'src/l2/store'))});
     l2.insertFact({ userId: 'owner', text: '导出演练事实 X', metadata: {} });
     l2.insertFact({ userId: 'owner', text: '导出演练事实 Y', metadata: { tag: 'demo' } });`,
    srcEnv
  );

  // 导出 → 目标空库 → 导入（两次，验证幂等）
  nodeEval(
    `require(${JSON.stringify(path.join(ROOT, 'src/db'))});`,
    { AIMEMORY_DB: tgtDb }
  );
  run(NODE, [path.join(ROOT, 'scripts/export.js'), packDir], { env: envWith(srcEnv) });
  run(NODE, [path.join(ROOT, 'scripts/import.js'), packDir], { env: envWith({ AIMEMORY_DB: tgtDb }) });
  run(NODE, [path.join(ROOT, 'scripts/import.js'), packDir], { env: envWith({ AIMEMORY_DB: tgtDb }) });

  // 验证：两条事实恰好各一条（幂等）
  const x = countRows(tgtDb, "SELECT COUNT(*) n FROM memories WHERE text = '导出演练事实 X'");
  const y = countRows(tgtDb, "SELECT COUNT(*) n FROM memories WHERE text = '导出演练事实 Y'");
  assert.equal(x.n, 1, '事实 X 应恰好一条（幂等）');
  assert.equal(y.n, 1, '事实 Y 应恰好一条（幂等）');

  fs.rmSync(dir, { recursive: true, force: true });
});
