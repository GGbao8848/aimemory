#!/usr/bin/env node
/**
 * 存量单用户数据迁移（owner → Keycloak 用户），幂等安全：
 *   1. 先在线备份 aimemory.db 到 backups/pre-migration-<时间戳>/
 *   2. 单事务内把全部 user_id 表的 from 用户改挂到 to 用户
 *   3. 校验：from 名下应清零，to 名下计数 = 迁移前 from+to 之和
 *
 * 用法：
 *   node scripts/migrate-owner-data.mjs --list              # 查看现有数据归属与已登录用户
 *   node scripts/migrate-owner-data.mjs --to <用户名|sub>    # 执行迁移（先备份再改）
 *   可选：--from <user_id>（默认 owner）  --force（目标用户已有数据时仍合并）
 *
 * 典型流程：Keycloak 登录一次（users 表自动建档）→ --list 找到目标用户 → --to 用户名。
 * 向量表（sqlite-vec）按 memories.rowid 关联、不带 user_id，无需迁移。
 */
'use strict';

const fs = require('fs');
const path = require('path');
// 注意：AIMEMORY_DB 读取发生在 config 加载时，命令行不另设库路径（运维在部署机跑，操作的就是生产库）
const config = require('../src/config');
require('../src/db'); // 幂等 schema 迁移（老库补建 users 等新表，与服务端启动同一套逻辑）
const Database = require('better-sqlite3');
const db = new Database(config.dbPath, { timeout: 5000 }); // 服务在跑时等锁而非立刻报 SQLITE_BUSY
db.pragma('foreign_keys = OFF'); // 批量改 user_id 期间不触发外键级联

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};

// 带 user_id 的全部表（与 src/db/index.js 的 schema 对齐；新增表须同步这里）
const USER_TABLES = [
  'memories',
  'api_keys',
  'sessions',
  'events',
  'memory_ops',
  'entities',
  'webhooks',
  'raw_materials',
];

function count(table, userId) {
  return db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE user_id = ?`).get(userId).c;
}

function listMode() {
  const users = db.prepare('SELECT * FROM users ORDER BY last_login_at DESC').all();
  console.log('=== 已建档用户（Keycloak 登录过）===');
  if (!users.length) {
    console.log('  （暂无——先用 Keycloak 登录一次 Web 管理台）');
  }
  for (const u of users) {
    console.log(`  ${u.username}${u.name && u.name !== u.username ? `（${u.name}）` : ''}  sub=${u.id}  最近登录 ${u.last_login_at}`);
  }
  console.log('\n=== 数据归属分布 ===');
  for (const t of USER_TABLES) {
    const dist = db.prepare(`SELECT user_id, COUNT(*) c FROM ${t} GROUP BY user_id ORDER BY c DESC`).all();
    if (!dist.length) continue;
    console.log(`  ${t}:`);
    for (const d of dist) console.log(`    ${d.user_id.padEnd(40)} ${d.c} 条`);
  }
  const legacy = config.legacyUserId;
  const totalLegacy = USER_TABLES.reduce((n, t) => n + count(t, legacy), 0);
  console.log(`\n存量单用户身份：${legacy}${totalLegacy ? `（共 ${totalLegacy} 条待迁移记录）` : '（名下已无数据，无需迁移）'}`);
  if (totalLegacy) {
    console.log('迁移：npm run migrate:owner -- --to <上面列出的用户名>');
  }
}

function backup(destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'aimemory.db');
  // better-sqlite3 在线 backup API：一致性快照（含 WAL），绝不直接 cp
  return new Database(config.dbPath).backup(dest).then(() => dest);
}

async function migrate({ from, to, force }) {
  const target = db.prepare('SELECT * FROM users WHERE id = ? OR username = ? OR email = ?').get(to, to, to);
  if (!target) {
    console.error(`✗ 找不到目标用户「${to}」：先用 Keycloak 登录一次 Web（users 表自动建档），再跑 --list 查看`);
    process.exit(1);
  }
  const toId = target.id;
  if (toId === from) {
    console.log(`✓ 目标就是当前归属（${from}），无需迁移`);
    return;
  }
  console.log(`迁移：${from} → ${target.username}（${toId}）`);

  const plan = USER_TABLES.map((t) => ({ table: t, from: count(t, from), to: count(t, toId) }));
  // 只有「按用户唯一约束」的表合并才可能冲突：api_keys(用户内名称唯一)、entities(用户内 norm 唯一)；
  // 其余表主键全局唯一（uuid/自增），目标名下已有数据也不影响直接改挂
  const CONFLICT_TABLES = new Set(['api_keys', 'entities']);
  const colliding = plan.filter((p) => CONFLICT_TABLES.has(p.table) && p.from > 0 && p.to > 0);
  if (colliding.length && !force) {
    console.error('\n✗ 目标用户名下已有同类数据，直接合并会违反唯一约束：');
    for (const p of colliding) console.error(`    ${p.table}: 目标已有 ${p.to} 条`);
    console.error('  确认要合并请加 --force（同名实体去重、同名 Token 自动改名后迁移）');
    process.exit(1);
  }

  console.log('\n== 1/3 备份 ==');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const destDir = path.join(config.root, 'backups', `pre-migration-${stamp}`);
  const dest = await backup(destDir);
  console.log(`  ✓ ${dest}`);

  console.log('\n== 2/3 迁移（单事务）==');
  const tx = db.transaction(() => {
    for (const p of plan) {
      if (!p.from) continue;
      if (p.table === 'entities') {
        // 实体表 (user_id, norm) 唯一：目标已有同名实体 → 删目标行，保留 owner 行的 id
        // （memory_entities 按实体 id 外键关联，保留 owner 行即保住关联，目标行是派生数据可弃）
        db.prepare(`DELETE FROM entities WHERE user_id = ? AND norm IN (SELECT norm FROM entities WHERE user_id = ?)`).run(toId, from);
      }
      if (p.table === 'api_keys') {
        // 生效 Token (user_id, name) 唯一：撞名时给迁移来的 Token 追加后缀
        db.prepare(`
          UPDATE api_keys SET name = name || '-from-' || substr(:from, 1, 8)
          WHERE user_id = :from AND revoked_at IS NULL
            AND name IN (SELECT name FROM api_keys WHERE user_id = :to AND revoked_at IS NULL)
        `).run({ from, to: toId });
      }
      const r = db.prepare(`UPDATE ${p.table} SET user_id = ? WHERE user_id = ?`).run(toId, from);
      console.log(`  ${p.table.padEnd(14)} ${r.changes} 条`);
    }
  });
  tx();

  console.log('\n== 3/3 校验 ==');
  let ok = true;
  for (const p of plan) {
    const leftFrom = count(p.table, from);
    const nowTo = count(p.table, toId);
    const expect = p.from + p.to;
    if (leftFrom !== 0 || (p.from && nowTo !== expect)) ok = false;
    console.log(`  ${p.table.padEnd(14)} 残留 ${leftFrom}，目标现有 ${nowTo}（预期 ${p.from + p.to}）`);
  }
  if (!ok) {
    console.error('\n✗ 校验未通过：请勿删除备份，反馈以上输出排查');
    process.exitCode = 1;
    return;
  }
  console.log(`\n✓ 迁移完成。备份在 ${destDir}（确认一切正常后可删）`);
  console.log('  建议：重启服务（pm2 restart aimemory）；换过 embedding 模型或向量异常时跑 npm run vec:rebuild -- --all');
}

if (has('--list')) {
  listMode();
} else if (has('--to')) {
  migrate({
    from: val('--from') || config.legacyUserId,
    to: val('--to'),
    force: has('--force'),
  }).catch((e) => {
    console.error(`✗ 迁移失败: ${e.message}`);
    process.exit(1);
  });
} else {
  console.error('用法: node scripts/migrate-owner-data.mjs --list | --to <用户名|sub> [--from <user_id>] [--force]');
  process.exit(1);
}
