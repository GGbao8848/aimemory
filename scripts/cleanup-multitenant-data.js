'use strict';

/**
 * 一次性清理：把多租户遗留数据收敛到单用户。
 *
 * 背景：服务从「多租户」重构为「单用户」（main 分支，personal 重构）。
 * 数据层保留了 user_id 列并降级为固定常量（见 config.userId），
 * 但库中仍留有历史上其他账号的数据——它们在新模型下都是同一个人的数据，
 * 会造成「打开页面看到不属于自己的记忆」的困惑，故收敛。
 *
 * 处理范围（仅影响非主账号的行）：
 *   - memories      ：删除其他账号的记忆（主账号全量保留）
 *   - api_keys      ：删除其他账号的 Token（含 e2e-export 之类测试残留）
 *   - sessions      ：删除其他账号的 Web 会话（本地登录后会建新的）
 *   - events        ：删除其他账号的提炼任务（多为已完成的残留）
 *   - connect_requests：清空（授权请求本就是一次性的，无长期价值）
 *   - l0_*          ：正常应已全属主账号；若发现其他账号则报告但不删（归档是事实源）
 *
 * 幂等：可重复执行；已清理过则各项为 0。
 * 用法：
 *   node scripts/cleanup-multitenant-data.js --dry-run   # 只看会删什么
 *   node scripts/cleanup-multitenant-data.js             # 实际执行（自动备份 DB）
 *
 * 注意：脚本会先复制一份 DB 到 data/backup-*.db 再动手，出问题可回滚。
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/db');

const DRY = process.argv.includes('--dry-run');
const KEEP = config.userId;

function backupDb() {
  const src = config.dbPath;
  if (!fs.existsSync(src)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(config.dataDir, `backup-aimemory-${stamp}.db`);

  // 用 VACUUM INTO：同步、WAL 安全、产出的是完整一致的快照。
  // 不要用 better-sqlite3 的 backup()——它返回 Promise，若不 await 就 close()
  // 会静默失败并留下不存在的目标文件（曾踩过：脚本谎报"已备份"）。
  // 也不要直接 fs.copyFileSync：WAL 模式下可能丢掉未 checkpoint 的写入。
  try {
    db.prepare('VACUUM INTO ?').run(dest);
  } catch (e) {
    console.error(`备份失败（${e.message}）——为安全起见中止`);
    process.exit(1);
  }
  const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  if (!size) {
    console.error('备份失败：目标文件为空 —— 中止');
    process.exit(1);
  }
  // 备份后立刻自检：能打开且能查到表，才算真的可用
  try {
    const Database = require('better-sqlite3');
    const check = new Database(dest, { readonly: true });
    check.prepare('SELECT COUNT(*) c FROM memories').get();
    check.close();
  } catch (e) {
    console.error(`备份自检失败（${e.message}）——中止`);
    process.exit(1);
  }
  return { path: dest, size };
}

/** 各表待清理行数与分布 */
function survey() {
  const rows = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);

  const out = {};
  out.memories = rows('SELECT user_id, COUNT(*) n FROM memories GROUP BY user_id ORDER BY n DESC');
  out.api_keys = rows(
    'SELECT user_id, COUNT(*) n, SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) active FROM api_keys GROUP BY user_id ORDER BY n DESC'
  );
  out.sessions = rows('SELECT user_id, COUNT(*) n FROM sessions GROUP BY user_id ORDER BY n DESC');
  out.events = rows('SELECT user_id, COUNT(*) n FROM events GROUP BY user_id ORDER BY n DESC');
  out.connect_requests = one('SELECT COUNT(*) n FROM connect_requests').n;
  out.l0_records = rows('SELECT user_id, COUNT(*) n FROM l0_records GROUP BY user_id ORDER BY n DESC');
  out.l0_devices = rows('SELECT user_id, COUNT(*) n FROM l0_devices GROUP BY user_id ORDER BY n DESC');
  out.l0_batches = rows('SELECT user_id, COUNT(*) n FROM l0_batches GROUP BY user_id ORDER BY n DESC');
  return out;
}

function printSurvey(s) {
  const show = (title, list, extra) => {
    console.log(`\n${title}`);
    if (!list.length) { console.log('  （空）'); return; }
    for (const r of list) {
      const mark = r.user_id === KEEP ? '✓ 保留' : '✗ 待清理';
      const tail = extra ? ` · ${extra(r)}` : '';
      console.log(`  ${mark}  ${String(r.user_id || '(NULL)').slice(0, 40)}  ${r.n} 行${tail}`);
    }
  };
  show('memories（记忆）', s.memories);
  show('api_keys（Token）', s.api_keys, (r) => `其中生效 ${r.active}`);
  show('sessions（Web 会话）', s.sessions);
  show('events（提炼任务）', s.events);
  show('l0_records（归档去重索引）', s.l0_records);
  show('l0_devices（设备）', s.l0_devices);
  show('l0_batches（归档批次）', s.l0_batches);
  console.log(`\nconnect_requests（设备流请求）：${s.connect_requests} 行（一次性，全部清空）`);
}

function main() {
  console.log('=== 单用户收敛清理 ===');
  console.log(`主账号（保留）：${KEEP}`);
  console.log(DRY ? '模式：dry-run（不写库）\n' : '模式：执行（会先备份 DB）\n');

  const before = survey();
  printSurvey(before);

  // 归档是事实源：若 l0_* 出现非主账号数据，只报告不删（需人工确认后再处理）
  const l0Foreign = [...before.l0_records, ...before.l0_devices, ...before.l0_batches]
    .filter((r) => r.user_id && r.user_id !== KEEP);
  if (l0Foreign.length) {
    console.log('\n⚠ 注意：归档表（l0_*）中发现非主账号数据。归档是事实源，本脚本不删，请人工确认：');
    for (const r of l0Foreign) console.log(`    ${r.user_id}  ${r.n} 行`);
  }

  if (DRY) {
    console.log('\n（dry-run 结束，未做任何修改。去掉 --dry-run 执行）');
    return;
  }

  const backup = backupDb();
  if (backup) {
    console.log(`\n已备份 DB → ${path.relative(process.cwd(), backup.path)}（${(backup.size / 1048576).toFixed(1)} MB，已自检可读）`);
  }

  const run = db.transaction(() => {
    const res = {};
    res.memories = db.prepare('DELETE FROM memories WHERE user_id != ?').run(KEEP).changes;
    res.api_keys = db.prepare('DELETE FROM api_keys WHERE user_id != ?').run(KEEP).changes;
    res.sessions = db.prepare('DELETE FROM sessions WHERE user_id != ?').run(KEEP).changes;
    res.events = db.prepare('DELETE FROM events WHERE user_id != ?').run(KEEP).changes;
    res.connect_requests = db.prepare('DELETE FROM connect_requests').run().changes;
    return res;
  });
  const res = run();

  console.log('\n=== 清理结果 ===');
  for (const [k, n] of Object.entries(res)) console.log(`  ${k}: 删除 ${n} 行`);

  // 顺带清理 memories_fts 里因 DELETE 触发器已同步，无需额外处理
  const after = survey();
  const kept = after.memories.find((r) => r.user_id === KEEP);
  console.log(`\n保留：memories ${kept ? kept.n : 0} 条（主账号）`);
  console.log(`      l0_records ${(after.l0_records.find((r) => r.user_id === KEEP) || {}).n || 0} 行`);
  console.log('\n完成。回滚方式：用上面的备份文件覆盖 data/aimemory.db（先停服务）。');
}

main();
